// MCP v2 A2 contract: real-data recomputation, sampled-slip/window semantics, reference places,
// missing data, replayable relaxations, UTC/range validation, compact detail and cold-tool timings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCoreContext } from '../tools/core-context.mjs';
import { bundle } from '../tools/build.mjs';
import { createCoreTools } from '../demo/src/tools-core.js';
import { slipTools } from '../demo/src/tools-v2/slip.js';
import { pointTimeline, pointMetrics, staticMetrics } from '../demo/src/point-eval.js';
import { evaluate, activeChecks } from '../demo/src/criteria.js';
import { skylineFor } from '../demo/src/terrain.js';

const H = 3600e3, D = 24 * H, L = Date.UTC(2027, 0, 13);
const iso = (t) => new Date(t).toISOString();
const r1 = (v) => Math.round(v * 10) / 10;
const ctx = loadCoreContext();
let kit;
const tools = createCoreTools(ctx, { extensions: [(k) => { kit = k; return slipTools(k); }] });
let defaults, annual;
const site = (id) => ctx.sites.find((s) => s.id === id);
const run = async (name, input, core = tools) => {
  const r = await core.run(name, input);
  assert.ok(!r.error, r.error);
  return r;
};
async function sources() {
  return Object.fromEntries(await Promise.all(['coarse', 'fine', 'psr', 'nasa', 'ice', 'dem240'].map(async (key) => [key, await kit.provided(ctx[key])])));
}
function envelope(r) {
  assert.ok(r.query_echo);
  assert.ok(Array.isArray(r.assumed));
  assert.ok(r.headline);
  assert.ok(r.about.units && r.about.resolution && r.about.conventions);
  assert.match(r.about.limits.join(' '), /first-look screen, not a certified landing analysis/i);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r, 'result must be plain, finite JSON');
}
function synthetic(sunUp = () => true, earthUp = () => true) {
  let calls = 0, skies = 0;
  const c = {
    eph: { startMs: L, endMs: L + 900 * D, stepMs: H, at(t) {
      calls++;
      if (t < L || t > this.endMs) return null;
      const h = (t - L) / H;
      return { sun: [0, 0, sunUp(h) ? -1 : 1], earth: [0, 0, earthUp(h) ? -1 : 1], earthRangeKm: 384400 };
    } },
    sites: [{ id: 'pole', name: 'Test pole', latDeg: -90, lonDeg: 0 }],
    skylineFor: () => { skies++; return () => 0; },
  };
  return { ctx: c, core: createCoreTools(c, { extensions: [slipTools] }), counts: () => ({ calls, skies }) };
}

test('slip: browser bundler and schemas expose both tools without Node dependencies', () => {
  assert.doesNotThrow(() => new Function(bundle(new URL('../demo/src/tools-v2/slip.js', import.meta.url).pathname)));
  for (const name of ['check_slip_robustness', 'landing_windows']) {
    const spec = tools.specs().find((s) => s.name === name);
    assert.ok(spec);
    assert.equal(spec.input_schema.additionalProperties, false);
    assert.deepEqual(spec.input_schema.properties.detail.enum, ['brief', 'standard', 'full']);
  }
});

test('slip: default curated-site scan is complete, consistent and under 5 s (cold lazy packs)', async (t) => {
  const start = performance.now();
  defaults = await run('check_slip_robustness', { landing: '2027-01-13' });
  const ms = performance.now() - start;
  t.diagnostic(`all curated sites, cold lazy packs: ${ms.toFixed(2)} ms`);
  assert.ok(ms < 5000, `${ms} ms`);
  envelope(defaults);
  assert.deepEqual(defaults.rows.map((r) => r.place.id), ctx.sites.filter((s) => s.latDeg <= -80).map((s) => s.id));
  assert.equal(defaults.samples_per_place, 29);
  assert.deepEqual(defaults.survivors, defaults.rows.filter((r) => r.survives_all).map((r) => r.place.id));
  assert.equal(defaults.query_echo.criteria.preset, 'lander_dte');
  assert.ok(defaults.assumed.some((s) => /default preset lander_dte/.test(s)));
  assert.ok(defaults.assumed.some((s) => /24 h.*assumption/.test(s)));
  assert.ok(defaults.rows.every((r) => !('matrix' in r)));
  assert.deepEqual(await run('check_slip_robustness', { landing: '2027-01-13' }), defaults);
});

test('slip: full matrix, first failure, pass share and worst values match direct pointMetrics', async () => {
  const input = { places: [{ site_id: 'shackleton' }, { site_id: 'im2' }], landing: '2027-01-13', detail: 'full' };
  const r = await run('check_slip_robustness', input);
  const c = r.query_echo.criteria, ground = await sources();
  for (const row of r.rows) {
    const s = site(row.place.id);
    const tl = pointTimeline(ctx.eph, s, skylineFor(ctx.dem, s), L, L + 7 * D + c.stay_days * D);
    const stat = staticMetrics(ground, s, c);
    const checks = row.matrix.map((sample) => {
      const e = evaluate(c, { ...stat, ...pointMetrics(tl, Date.parse(sample.landing), c.stay_days * D, { continuous_from: c.continuous_from }) });
      assert.equal(sample.pass, e.pass);
      assert.equal(sample.limiting, e.limiting);
      return e;
    });
    const first = checks.findIndex((e) => !e.pass);
    assert.equal(row.survives_all, first < 0);
    assert.equal(row.passes_at_planned, checks[0].pass);
    assert.equal(row.pass_share, Math.round(checks.filter((e) => e.pass).length / checks.length * 1e4) / 1e4);
    assert.equal(row.first_fail?.slip_h ?? null, first < 0 ? null : row.matrix[first].slip_h);
    const failures = new Map(activeChecks(c).map((ch) => [ch.id, checks.filter((e) => !e.checks.find((x) => x.id === ch.id).pass).length]));
    const maxFailures = Math.max(...failures.values());
    assert.equal(row.limiting, maxFailures === 0 ? null : [...failures].find(([, n]) => n === maxFailures)[0]);
    for (const ch of activeChecks(c)) {
      const values = checks.map((e) => e.checks.find((x) => x.id === ch.id).value);
      const expected = ch.kind === 'max' ? Math.max(...values) : ch.kind === 'min' ? Math.min(...values) : values.every(Boolean);
      assert.equal(row.worst[ch.id].value, typeof expected === 'number' ? r1(expected) : expected);
    }
  }
});

test('slip: 300 h from touchdown explains hour-for-hour loss with measured, replayable relaxations', async () => {
  const input = { landing: '2027-01-13', criteria: { continuous_from: 'from_landing', both_continuous_h_min: 300 } };
  const r = await run('check_slip_robustness', input);
  assert.ok(['infeasible', 'thin'].includes(r.feasibility.status));
  assert.equal(r.feasibility.binding, 'both_continuous_h_min');
  assert.match(r.feasibility.why, /each hour of slip shortens.*by an hour/);
  assert.match(r.feasibility.why, /300 h \+ 168 h.*468 h/);
  assert.ok(r.feasibility.max_achievable.planned_unbroken_h > 0);
  assert.ok(r.feasibility.relaxations.some((x) => x.change.criteria?.continuous_from === 'within_stay'));
  for (const relaxation of r.feasibility.relaxations) {
    const again = await run('check_slip_robustness', { ...input, criteria: { ...input.criteria, ...relaxation.change.criteria }, ...(relaxation.change.slip ? { slip: relaxation.change.slip } : {}) });
    assert.equal(again.survivors.length, relaxation.unlocks);
  }
});

test('slip: a shortened endpoint is the largest sampled passing prefix', async () => {
  const input = { places: [{ site_id: 'shackleton' }], landing: '2027-01-13', criteria: { both_continuous_h_min: 200 }, detail: 'full' };
  const r = await run('check_slip_robustness', input);
  const first = r.rows[0].first_fail.slip_h;
  const relax = r.feasibility.relaxations.find((x) => x.change.slip);
  assert.equal(relax.change.slip.to_days * 24, first - 6);
  const again = await run('check_slip_robustness', { ...input, slip: relax.change.slip });
  assert.equal(again.survivors.length, 1);
});

test('windows: a year at Shackleton takes under 3 s; all sampled landings match direct evaluation', async (t) => {
  const start = performance.now();
  annual = await run('landing_windows', { site_id: 'shackleton', from: '2027-01-01', to: '2028-01-01', planned: '2027-01-13', detail: 'full' });
  const ms = performance.now() - start;
  t.diagnostic(`Shackleton 365 days, step 6 h: ${ms.toFixed(2)} ms; ${annual.window_count} windows`);
  assert.ok(ms < 3000, `${ms} ms`);
  envelope(annual);
  const c = annual.query_echo.criteria, from = Date.parse(annual.query_echo.from), to = Date.parse(annual.query_echo.to);
  const s = site('shackleton'), tl = pointTimeline(ctx.eph, s, skylineFor(ctx.dem, s), from, to + c.stay_days * D);
  const stat = staticMetrics(await sources(), s, c);
  assert.equal(annual.matrix.length, 1461);
  assert.ok(annual.windows.length > 0);
  for (const sample of annual.matrix) {
    const t = Date.parse(sample.landing);
    const e = evaluate(c, { ...stat, ...pointMetrics(tl, t, c.stay_days * D, { continuous_from: c.continuous_from }) });
    const contained = annual.windows.some((w) => t >= Date.parse(w.open) && t <= Date.parse(w.close));
    assert.equal(sample.pass, e.pass);
    assert.equal(contained, e.pass, sample.landing);
  }
  annual.windows.forEach((w, i) => {
    assert.equal(w.window_index, i);
    assert.equal(w.length_h, (Date.parse(w.close) - Date.parse(w.open)) / H);
    assert.equal(w.landings, w.length_h / 6 + 1);
    if (i > 0) assert.ok(Date.parse(w.open) > Date.parse(annual.windows[i - 1].close) + 6 * H);
  });
  assert.deepEqual(annual.robust_windows, annual.windows.filter((w) => w.length_h >= 7 * 24));
  assert.equal(annual.planned.inside, true);
  const w = annual.windows[annual.planned.window_index];
  assert.equal(annual.planned.slip_budget_h, (Date.parse(w.close) - L) / H);
  assert.equal(annual.planned.hours_since_open, (L - Date.parse(w.open)) / H);
  assert.match(annual.about.limits.join(' '), /one step_h \(6 h\)/);
});

test('windows: planned open/close boundaries are inclusive; outside dates locate the next opening', async () => {
  const input = { site_id: 'shackleton', from: '2027-01-01', to: '2027-02-01' };
  const w = annual.windows[0];
  for (const planned of [w.open, w.close]) {
    const r = await run('landing_windows', { ...input, planned });
    assert.equal(r.planned.inside, true);
    assert.equal(r.planned.slip_budget_h, (Date.parse(w.close) - Date.parse(planned)) / H);
  }
  const before = await run('landing_windows', { ...input, planned: '2027-01-01' });
  assert.equal(before.planned.inside, false);
  assert.equal(before.planned.next_open, w.open);
  const after = await run('landing_windows', { ...input, planned: '2027-02-02' });
  assert.equal(after.planned.next_open, null);
  assert.equal(after.planned.slip_budget_h, null);
});

test('windows: explicit battery-only criteria do not inherit the default preset', async () => {
  const r = await run('landing_windows', { site_id: 'shackleton', from: '2027-01-01', to: '2027-03-01', criteria: { longest_dark_h_max: 30 }, detail: 'full' });
  assert.equal(r.query_echo.criteria.preset, undefined);
  assert.deepEqual(activeChecks(r.query_echo.criteria).map((ch) => ch.id), ['longest_dark_h_max']);
  assert.ok(r.assumed.some((s) => /30 h of darkness/.test(s)));
  const c = r.query_echo.criteria, s = site('shackleton');
  const tl = pointTimeline(ctx.eph, s, skylineFor(ctx.dem, s), Date.parse(r.query_echo.from), Date.parse(r.query_echo.to) + 14 * D);
  for (const sample of r.matrix) assert.equal(sample.pass, pointMetrics(tl, Date.parse(sample.landing), 14 * D).longest_dark_h <= 30);
});

test('slip and windows: coordinate strings and north-of-80°S smooth horizons work', async () => {
  const coord = { lat_deg: '84.82S', lon_deg: '24.44E' };
  const r = await run('check_slip_robustness', { places: [coord, { site_id: 'apollo11' }], landing: '2027-01-13' });
  assert.equal(r.rows[0].place.latDeg, -84.82);
  assert.equal(r.rows[0].place.lonDeg, 24.44);
  assert.equal(r.rows[1].horizon, 'smooth');
  assert.match(r.rows[1].note, /North of 80°S.*smooth horizon/);
  assert.equal(r.rows[1].worst.slope_max_deg.value, null);
  assert.equal(r.rows[1].worst.slope_max_deg.unavailable, true);
  for (const where of [coord, { site_id: 'apollo11' }]) {
    const w = await run('landing_windows', { ...where, from: '2027-01-01', to: '2027-02-01', criteria: { longest_dark_h_max: 30 } });
    envelope(w);
    if (where.site_id) assert.match(w.note, /North of 80°S.*smooth horizon/);
  }
});

test('slip and windows: search candidates and mission points resolve through the shared kit', async () => {
  const s = site('shackleton');
  const search = kit.refs.put('search', { candidates: [{ ref: 'S1', latDeg: s.latDeg, lonDeg: s.lonDeg }] });
  const mission = kit.refs.put('mission', { name: 'Example', points: [{ name: 'W2', latDeg: s.latDeg, lonDeg: s.lonDeg }] });
  const r = await run('check_slip_robustness', { places: [{ candidate: 'S1', search_id: search }, { mission_point: 'W2', mission_id: mission }], landing: '2027-01-13' });
  assert.deepEqual(r.rows.map((x) => x.place.id), ['S1', 'W2']);
  assert.deepEqual(r.rows[0].worst, r.rows[1].worst);
  const w = await run('landing_windows', { candidate: 'S1', from: '2027-01-01', to: '2028-01-01', detail: 'full' });
  assert.deepEqual(w.windows, annual.windows);
});

test('slip: unavailable inputs fail rather than becoming invented numbers; all lazy sources are awaited once', async () => {
  const fixture = synthetic();
  const calls = {};
  for (const name of ['coarse', 'fine', 'psr', 'nasa', 'ice', 'dem240']) fixture.ctx[name] = async () => { calls[name] = (calls[name] ?? 0) + 1; return null; };
  const r = await run('check_slip_robustness', { landing: '2027-01-13', criteria: { slope_max_deg: 8, nasa_avg_sun_min: 0.5, ice: { within_km: 5 } } }, fixture.core);
  assert.ok(Object.values(calls).every((n) => n === 1));
  assert.equal(Object.keys(calls).length, 6);
  assert.equal(r.feasibility.status, 'infeasible');
  for (const worst of Object.values(r.rows[0].worst)) {
    assert.equal(worst.value, null);
    assert.equal(worst.unavailable, true);
  }
  assert.equal(r.feasibility.relaxations.length, 0);
  assert.match(r.assumed.join(' '), /PSR proximity is a proxy/);
});

test('slip: duplicated coordinates share one timeline and an off-grid last offset is still checked', async () => {
  const fixture = synthetic((h) => h < 10);
  const r = await run('check_slip_robustness', { places: [{ site_id: 'pole' }, { lat_deg: -90, lon_deg: 0 }], landing: '2027-01-13', slip: { to_days: 7 / 24, step_h: 6 }, criteria: { sun_continuous_h_min: 4, stay_days: 1 }, detail: 'full' }, fixture.core);
  assert.equal(fixture.counts().skies, 1);
  assert.ok(fixture.counts().calls < 300, 'one 31-hour scan, not a scan per landing/place');
  assert.deepEqual(r.rows[0].matrix.map((x) => x.slip_h), [0, 6, 7]);
  assert.equal(r.rows[0].matrix.at(-1).pass, false);
  const shifted = await run('check_slip_robustness', { landing: '2027-01-13', slip: { from_days: 1, to_days: 1 }, criteria: { sun_at_landing: true }, detail: 'full' }, fixture.core);
  assert.equal(shifted.rows[0].evaluated_at_slip_h, 24);
  assert.equal(shifted.rows[0].passes_at_planned, false);
});

test('slip and windows: fractional hour steps preserve the requested sample cadence', async () => {
  const fixture = synthetic();
  const slip = await run('check_slip_robustness', { landing: iso(L), slip: { to_days: 0.25, step_h: 1.5 }, criteria: {}, detail: 'full' }, fixture.core);
  assert.deepEqual(slip.rows[0].matrix.map((s) => s.slip_h), [0, 1.5, 3, 4.5, 6]);
  const windows = await run('landing_windows', { site_id: 'pole', from: iso(L), to: iso(L + 6 * H), step_h: 1.5, criteria: {}, detail: 'full' }, fixture.core);
  assert.equal(windows.samples, 5);
  assert.equal(windows.windows[0].length_h, 6);
  assert.equal(windows.matrix[1].landing, '2027-01-13T01:30Z');
});

test('windows: zero-length windows, regular sampling, standard cap and full window indices', async () => {
  const fixture = synthetic((h) => h % 48 < 12);
  const input = { site_id: 'pole', from: iso(L), to: iso(L + 60 * D), criteria: { sun_at_landing: true, stay_days: 1 }, min_window_days: 0.25 };
  const standard = await run('landing_windows', { ...input, planned: iso(L + 50 * D) }, fixture.core);
  const full = await run('landing_windows', { ...input, detail: 'full' }, fixture.core);
  assert.equal(standard.windows.length, 20);
  assert.equal(standard.window_count, 31);
  assert.equal(standard.windows_truncated, true);
  assert.equal(standard.planned.window_index, 25);
  assert.equal(full.windows.length, 31);
  assert.equal(full.robust_windows.length, 30);
  assert.equal(full.windows.at(-1).length_h, 0);
  assert.equal(full.windows.at(-1).landings, 1);
  assert.equal(full.best.window_index, 0);
  const nonGrid = await run('landing_windows', { site_id: 'pole', from: iso(L), to: iso(L + 7 * H), criteria: {}, step_h: 6 }, fixture.core);
  assert.equal(nonGrid.sampled_through, '2027-01-13T06:00Z');
  assert.equal(nonGrid.samples, 2);
});

test('windows: a planned time between passing ticks is independently checked for short failures', async () => {
  const fixture = synthetic((h) => h < 2 || h >= 4);
  const r = await run('landing_windows', { site_id: 'pole', from: iso(L), to: iso(L + 6 * H), planned: iso(L + 3 * H), criteria: { sun_at_landing: true, stay_days: 1 } }, fixture.core);
  assert.equal(r.windows.length, 1);
  assert.equal(r.windows[0].length_h, 6);
  assert.equal(r.planned.inside, false);
  assert.equal(r.planned.slip_budget_h, null);
});

test('windows: no passing samples returns empty windows, null best and no next opening', async () => {
  const fixture = synthetic(() => false);
  const r = await run('landing_windows', { site_id: 'pole', from: iso(L), to: iso(L + D), planned: iso(L), criteria: { sun_at_landing: true } }, fixture.core);
  assert.equal(r.window_count, 0);
  assert.equal(r.robust_window_count, 0);
  assert.deepEqual(r.windows, []);
  assert.equal(r.best, null);
  assert.equal(r.planned.next_open, null);
});

test('slip: from_time uses the fixed UTC instant; elevation constraints request real hourly peaks', async () => {
  const fixture = synthetic((h) => h < 20);
  const r = await run('check_slip_robustness', { landing: iso(L), slip: { to_days: 0.5 }, criteria: { stay_days: 1, continuous_from: 'from_time', from_time: iso(L + 6 * H), sun_continuous_h_min: 10, sun_elevation_min_deg: 5, earth_elevation_min_deg: 5 }, detail: 'full' }, fixture.core);
  assert.deepEqual(r.rows[0].matrix.map((s) => s.pass), [true, true, false]);
  assert.equal(r.rows[0].worst.sun_continuous_h_min.at_slip_h, 12);
  assert.equal(r.rows[0].worst.sun_elevation_min_deg.value, 90);
  assert.equal(r.rows[0].worst.earth_elevation_min_deg.value, 90);
});

test('slip: measured bounds outside the criteria schema are not advertised as replayable thresholds', async () => {
  const fixture = synthetic(() => false);
  const r = await run('check_slip_robustness', { landing: iso(L), criteria: { sun_elevation_min_deg: 5, stay_days: 1 }, slip: { to_days: 0 } }, fixture.core);
  assert.equal(r.feasibility.max_achievable.value, -90);
  assert.deepEqual(r.feasibility.relaxations, []);
});

test('slip: bool, range and numeric margins sort deterministically and threshold changes really unlock', async () => {
  const fixture = synthetic();
  fixture.ctx.coarse = { grid: { cellAt: (x, y) => y > 1 ? 1 : 0 }, slope: [1, 6], shadow: [3, 7] };
  const input = { places: [{ site_id: 'pole' }, { lat_deg: -89, lon_deg: 0 }], landing: iso(L), criteria: { slope_max_deg: 8, psr_distance_km: { min: 1, max: 2 } } };
  const r = await run('check_slip_robustness', input, fixture.core);
  assert.equal(r.ranking[0].row_index, 0);
  assert.equal(r.ranking[0].worst_relative_margin, -0.5);
  assert.equal(r.feasibility.binding, 'psr_distance_km');
  const relax = r.feasibility.relaxations[0];
  assert.deepEqual(relax.change.criteria.psr_distance_km, { min: 1, max: 3 });
  const replay = await run('check_slip_robustness', { ...input, criteria: { ...input.criteria, ...relax.change.criteria } }, fixture.core);
  assert.equal(replay.survivors.length, relax.unlocks);
});

test('brief: <= 1 KB, stable repeated output, complete envelope retrievable via shared refs', async (t) => {
  const cases = [
    ['check_slip_robustness', { landing: '2027-01-13', detail: 'brief' }],
    ['landing_windows', { site_id: 'shackleton', from: '2027-01-01', to: '2028-01-01', planned: '2027-01-13', detail: 'brief' }],
  ];
  for (const [name, input] of cases) {
    const r = await run(name, input);
    const bytes = Buffer.byteLength(JSON.stringify(r));
    t.diagnostic(`${name} brief: ${bytes} bytes`);
    assert.ok(bytes <= 1024, `${bytes} bytes`);
    envelope(r);
    const full = kit.refs.get(r.refs.kind, r.refs.id);
    assert.equal(full.query_echo.criteria.preset, 'lander_dte');
    assert.ok(full.assumed.some((s) => /battery.*24 h/.test(s)));
    assert.deepEqual(await run(name, input), r);
  }
});

test('brief: the 1 KB limit counts UTF-8 bytes for long Unicode place names', async () => {
  const fixture = synthetic();
  fixture.ctx.sites[0].name = '月球基地'.repeat(100);
  const r = await run('landing_windows', { site_id: 'pole', from: iso(L), to: iso(L + D), criteria: {}, detail: 'brief' }, fixture.core);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 1024);
});

test('slip and windows: invalid inputs are user errors, never handler failures', async () => {
  const cases = [
    ['check_slip_robustness', {}, /landing is required/],
    ['check_slip_robustness', { landing: '2027-01-13', places: [] }, /at least 1/],
    ['check_slip_robustness', { landing: '2027-01-13', places: Array(25).fill({ site_id: 'shackleton' }) }, /at most 24/],
    ['check_slip_robustness', { landing: '2027-01-13', slip: { from_days: 8 } }, /from_days.*to_days/],
    ['check_slip_robustness', { landing: '2027-01-13', slip: { to_days: 31 } }, /at most 30/],
    ['check_slip_robustness', { landing: '2027-01-13', slip: { step_h: 0 } }, /at least 1/],
    ['check_slip_robustness', { landing: '2027-02-30' }, /not a valid date/],
    ['check_slip_robustness', { landing: '2028-12-20' }, /complete stay/],
    ['check_slip_robustness', { landing: '2027-01-13', places: [{ site_id: 'absent' }] }, /Unknown site_id/],
    ['check_slip_robustness', { landing: '2027-01-13', criteria: { continuous_from: 'from_time' } }, /needs from_time/],
    ['check_slip_robustness', { landing: '2027-01-13', criteria: { continuous_from: 'from_time', from_time: '2027-13-01' } }, /not a valid date/],
    ['check_slip_robustness', { landing: '2027-01-13', criteria: { psr_distance_km: { min: 5, max: 1 } } }, /larger than max/],
    ['landing_windows', { site_id: 'shackleton', step_h: 49 }, /at most 48/],
    ['landing_windows', { site_id: 'shackleton', from: '2027-02-01', to: '2027-01-01' }, /from must not be after to/],
    ['landing_windows', { site_id: 'shackleton', to: '2028-12-30' }, /complete stay/],
    ['landing_windows', { lat_deg: -84.82 }, /go together/],
    ['landing_windows', { site_id: 'shackleton', planned: '2030-01-01' }, /ephemeris covers/],
    ['landing_windows', { site_id: 'shackleton', detail: 'verbose' }, /one of/],
    ['landing_windows', { site_id: 'shackleton', criteria: { unknown: 1 } }, /Unknown field/],
  ];
  for (const [name, input, pattern] of cases) {
    const r = await tools.run(name, input);
    assert.match(r.error ?? '', pattern, JSON.stringify(input));
    assert.doesNotMatch(r.error, /failed:/);
  }
  const fixture = synthetic();
  assert.match((await fixture.core.run('landing_windows', { site_id: 'pole', from: iso(L), to: iso(L + 801 * D) })).error, /800 days/);
});

test('windows: default range includes only full stays; a landing ending exactly at ephemeris end works', async () => {
  const r = await run('landing_windows', { site_id: 'shackleton' });
  assert.equal(Date.parse(r.query_echo.from), ctx.eph.startMs);
  assert.equal(Date.parse(r.query_echo.to) + r.query_echo.criteria.stay_days * D, ctx.eph.endMs);
  const last = ctx.eph.endMs - D;
  const end = await run('landing_windows', { site_id: 'shackleton', from: iso(last), to: iso(last), criteria: { stay_days: 1 }, detail: 'full' });
  assert.equal(end.samples, 1);
  assert.equal(end.windows[0].length_h, 0);
  const slip = await run('check_slip_robustness', { places: [{ site_id: 'shackleton' }], landing: iso(last), slip: { to_days: 0 }, criteria: { stay_days: 1 } });
  assert.equal(slip.rows[0].survives_all, true);
});

test('slip: landing hours are snapped and an empty curated catalog gives a useful error', async () => {
  const r = await run('check_slip_robustness', { places: [{ site_id: 'shackleton' }], landing: '2027-01-13T06:59Z', slip: { to_days: 0 } });
  assert.equal(r.query_echo.landing, '2027-01-13T06:00Z');
  const empty = createCoreTools({ eph: ctx.eph, sites: [] }, { extensions: [slipTools] });
  assert.match((await empty.run('check_slip_robustness', { landing: '2027-01-13' })).error, /No curated terrain sites/);
});
