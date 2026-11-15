// A1 tool contract and real-data acceptance/performance tests. No network or generated fixtures.
// Each test uses a fresh reference store; expensive data packs are shared and loaded only once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCoreContext } from '../tools/core-context.mjs';
import { createCoreTools } from '../demo/src/tools-core.js';
import { findTools } from '../demo/src/tools-v2/find.js';
import { pointTimeline, pointMetrics, staticMetrics } from '../demo/src/point-eval.js';
import { evaluate, resolveCriteria } from '../demo/src/criteria.js';
import { skylineFor, toXY } from '../demo/src/terrain.js';

const H = 3600e3, L = Date.UTC(2027, 9, 7);
const STRICT = { slope_max_deg: 5, psr_distance_km: { min: 1, max: 5 }, inside_psr: false, continuous_from: 'from_landing', both_continuous_h_min: 300 };
let loaded;
const context = () => loaded ??= loadCoreContext();
function coreFor(ctx = context()) {
  let kit;
  const core = createCoreTools(ctx, { extensions: [(k) => { kit = k; return findTools(k); }] });
  return { core, kit };
}
const run = (core, input) => core.run('find_landing_sites', input);
function good(r) { assert.ok(!r.error, r.error); return r; }
// The main path never grows; screen near misses rescued at a point (a side branch) may add final picks.
function monotone(r) {
  const rescued = r.funnel.find((f) => f.stage === 'exact_near_misses')?.cells ?? 0;
  const main = r.funnel.filter((f) => !f.branch);
  for (let i = 1; i < main.length; i++) assert.ok(main[i].cells <= main[i - 1].cells + (main[i].stage === 'spaced_picks' ? rescued : 0), JSON.stringify(r.funnel));
}
function tiny() {
  const start = Date.UTC(2027, 0, 1), coords = [toXY(-89, 0), toXY(-89, 2), toXY(-89, 4), toXY(-79, 0)];
  return {
    eph: { startMs: start, endMs: start + 100 * 24 * H, stepMs: H, at: (t) => ({ hour: (t - start) / H }) }, sites: [],
    coarse: { grid: { count: 4, cellKm: 2,
      cellCenter: (k) => ({ latDeg: k === 3 ? -79 : -89, lonDeg: k * 2, xKm: coords[k][0], yKm: coords[k][1] }),
      cellAt: (x, y) => coords.reduce((best, p, k) => Math.hypot(p[0] - x, p[1] - y) < Math.hypot(coords[best][0] - x, coords[best][1] - y) ? k : best, 0),
      visibility: (k, d) => k === 1 && d.hour % 48 >= 24 ? 0 : 3,
    }, slope: [2, 3, 10, 0], shadow: [2, 4, 0, 1] },
    nasa: { sample: () => ({ sunPct: 80, earthPct: 90 }) },
  };
}

test('find: real 300 h landing returns exact passes, monotone funnel and a usable S1 reference', async (t) => {
  const ctx = context(), { core, kit } = coreFor(), start = performance.now();
  const r = good(await run(core, { landing: '2027-10-07', criteria: STRICT }));
  const ms = performance.now() - start; t.diagnostic(`landing wall=${ms.toFixed(1)} ms; tiers=${JSON.stringify(r.about.timing_ms)}`);
  assert.ok(ms < 8000, 'landing target 5 s, generous CI ceiling 8 s');
  assert.ok(r.candidates.length >= 1); assert.equal(r.partial, false); monotone(r);
  const c = resolveCriteria(STRICT).criteria, held = kit.refs.get('search', r.search_id);
  const fine = await ctx.fine();
  for (const candidate of r.candidates) {
    assert.equal(candidate.eval.pass, true); assert.equal(candidate.cell_km, 1); assert.ok(candidate.screened_vs_exact);
    const raw = held.candidates.find((v) => v.ref === candidate.ref), site = { latDeg: raw.latDeg, lonDeg: raw.lonDeg };
    assert.ok(site.latDeg <= -80);
    const tl = pointTimeline(ctx.eph, site, skylineFor(ctx.dem, site), L, L + c.stay_days * 24 * H);
    const metrics = { ...staticMetrics({ coarse: ctx.coarse, fine, psr: ctx.psr, nasa: ctx.nasa }, site, c), ...pointMetrics(tl, L, c.stay_days * 24 * H) };
    assert.equal(evaluate(c, metrics).pass, true, candidate.ref);
  }
  const summary = good(await core.run('site_summary', { candidate: 'S1', landing: '2027-10-07' }));
  assert.equal(summary.place.latDeg, Math.round(held.candidates[0].latDeg * 1e5) / 1e5);
  const near = good(await run(core, { region: { within_km: 10, of: { candidate: 'S1' } }, landing: '2027-10-07', criteria: STRICT, refine: false }));
  assert.ok(near.funnel.find((f) => f.stage === 'region').cells > 0);
});

test('find: real seven-day slip is infeasible, explains 468 h and gives executable relaxations', async (t) => {
  const { core } = coreFor(), input = { landing: '2027-10-07', criteria: STRICT, slip: { to_days: 7 } };
  const r = good(await run(core, input));
  t.diagnostic(`slip tiers=${JSON.stringify(r.about.timing_ms)}; ${r.feasibility.why}`);
  assert.equal(r.feasibility.status, 'infeasible'); assert.equal(r.feasibility.binding, 'both_continuous_h_min');
  assert.match(r.feasibility.why, /468/); assert.match(r.feasibility.why, /402 h/); monotone(r);
  assert.equal(r.feasibility.max_achievable.available_both_from_landing_h, 402);
  for (const relaxation of r.feasibility.relaxations.filter((v) => v.unlocks > 0)) {
    const change = relaxation.change;
    const relaxed = good(await run(core, { ...input, criteria: { ...STRICT, ...('slip' in change ? {} : change) }, slip: change.slip ?? input.slip, refine: false, min_spacing_km: 0, count: 60 }));
    assert.ok(relaxed.funnel.find((f) => f.stage === 'slip').cells >= relaxation.unlocks);
  }
});

test('find: full-cap any-date default query stays bounded and gives exact best dates', async (t) => {
  const { core } = coreFor(), start = performance.now(), r = good(await run(core, {})), ms = performance.now() - start;
  t.diagnostic(`any-date wall=${ms.toFixed(1)} ms; partial=${r.partial}; tiers=${JSON.stringify(r.about.timing_ms)}`);
  assert.ok(ms < 30000, 'any-date target 20 s, generous CI ceiling 30 s');
  assert.equal(r.query_echo.criteria.preset, 'lander_dte'); assert.equal(r.query_echo.mode, 'any_date');
  assert.ok(r.candidates.length > 0); monotone(r);
  assert.ok(r.partial_reason); assert.equal(r.partial, true);
  for (const c of r.candidates) { assert.ok(c.best_landing); assert.ok(c.passing_landings > 0); assert.equal(c.eval.pass, true); }
});

test('find: synthetic defaults, ice proxy, window, from_time, full detail and brief size', async () => {
  const { core, kit } = coreFor(tiny());
  const input = { landing: '2027-01-01T00:59Z', refine: false, count: 2, min_spacing_km: 0, criteria: { slope_max_deg: 5, ice: { within_km: 3 }, both_continuous_h_min: 24, stay_days: 1 } };
  const r = good(await run(core, input)); monotone(r);
  assert.equal(r.query_echo.landing, '2027-01-01T00:00Z'); assert.equal(r.candidates.length, 1);
  assert.ok(r.assumed.some((v) => /no temperature data/.test(v))); assert.equal(r.candidates[0].metrics.ice_target_km, 2);
  const w = good(await run(core, {
    refine: false, landing_window: { from: '2027-01-01', to: '2027-01-03' }, landing_step_h: 6, count: 2, min_spacing_km: 0, criteria: { slope_max_deg: 5, stay_days: 1, both_continuous_h_min: 24 },
  }));
  assert.equal(w.query_echo.landing_count, 9); assert.equal(w.candidates[0].passing_landings, 9);
  const f = good(await run(core, { ...input, criteria: { ...input.criteria, continuous_from: 'from_time', from_time: '2027-01-01T06:00Z', both_continuous_h_min: 18 }, detail: 'full' }));
  assert.equal(f.candidates[0].metrics.both_continuous_h, 18);
  assert.equal(f.candidates[0].landing_checks.length, 1);
  const b = good(await run(core, { ...input, detail: 'brief' }));
  assert.ok(Buffer.byteLength(JSON.stringify(b)) <= 1024, JSON.stringify(b));
  assert.ok(kit.refs.get('search', b.search_id).assumed.length > 0);
});

test('find: malformed regions, dates, slips and conflicting forms return user errors', async () => {
  const { core } = coreFor(tiny());
  const base = { landing: '2027-01-01', refine: false };
  for (const input of [
    { ...base, region: 'north' }, { ...base, region: {} }, { ...base, region: { within_km: 4 } },
    { ...base, region: { bbox: { lat_min: -80, lat_max: -90, lon_min: 0, lon_max: 90 } } },
    { ...base, region: { within_km: 4, of: { lat_deg: -89 } } },
    { ...base, landing_window: { from: '2027-01-01', to: '2027-01-03' } },
    { ...base, landing: '2027-02-30' }, { ...base, landing: '2027-04-10', criteria: { stay_days: 14 } },
    { ...base, slip: { from_days: 8, to_days: 7 } }, { ...base, slip: { to_days: 0.01 } },
    { ...base, count: 0 }, { ...base, landing_step_h: 0 }, { ...base, criteria: { continuous_from: 'from_time' } },
  ]) assert.ok((await run(core, input)).error, JSON.stringify(input));
  assert.ok((await run(coreFor({ eph: tiny().eph, sites: [] }).core, base)).error);
});

test('find: supplied ice data is used for screening, ranking and the science target', async () => {
  const ctx = tiny(), calls = [];
  ctx.ice = () => ({
    distKm: (cellKm, k, cls) => { calls.push([cellKm, k, cls]); return [7, 1, 0, 0][k]; },
    nearest: (x, y, opts) => ({ latDeg: -89, lonDeg: 2, distKm: 1, cls: opts.cls, depthM: 0.5 }),
  });
  const { core } = coreFor(ctx);
  const r = good(await run(core, { landing: '2027-01-01', refine: false, min_spacing_km: 0, criteria: { slope_max_deg: 5, stay_days: 1, ice: { class: 'shallow', within_km: 3 } } }));
  assert.equal(r.candidates.length, 1); assert.equal(r.candidates[0].lon_deg, 2);
  assert.ok(calls.every(([cellKm, , cls]) => cellKm === 2 && cls === 'shallow'));
  assert.equal(r.candidates[0].metrics.ice_target_km, 1); assert.equal(r.candidates[0].science_target.source, 'diviner');
  assert.ok(!r.assumed.some((v) => /no temperature data/.test(v)));
  const ranked = good(await run(core, { landing: '2027-01-01', refine: false, rank_by: 'ice_distance', criteria: { slope_max_deg: 5, stay_days: 1 }, min_spacing_km: 0 }));
  assert.equal(ranked.candidates[0].lon_deg, 2);
});

test('find: full slip matrices include non-grid endpoints and use the first offset for nominal metrics', async () => {
  const { core } = coreFor(tiny());
  const r = good(await run(core, { landing: '2027-01-01', refine: false, criteria: { stay_days: 1, slope_max_deg: 5, both_continuous_h_min: 24 }, slip: { from_days: 0.5, to_days: 1.5, step_h: 7 }, detail: 'full' }));
  assert.equal(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.deepEqual(c.landing_checks.map((v) => v.offset_h), [12, 19, 26, 33, 36]);
  assert.ok(c.landing_checks.every((v) => v.eval.pass)); assert.equal(c.metrics_landing, '2027-01-01T12:00Z');
  assert.equal(c.slip.worst.both_continuous_h, 24);
});

test('find: requested elevation peaks are computed, including the full hourly matrix', async () => {
  const { core } = coreFor();
  const r = good(await run(core, { landing: '2027-10-07', region: { within_km: 3, of: { site_id: 'shackleton' } }, refine: false,
    criteria: { stay_days: 1, sun_elevation_min_deg: -10, earth_elevation_min_deg: -10 }, detail: 'full' }));
  assert.ok(r.candidates.length > 0);
  for (const c of r.candidates) {
    assert.ok(Number.isFinite(c.metrics.sun_peak_deg)); assert.ok(Number.isFinite(c.metrics.earth_peak_deg));
    assert.equal(c.eval.pass, true); assert.equal(c.landing_checks[0].eval.pass, true);
  }
});

test('find: unavailable NASA data never passes and is labelled unavailable in near misses', async () => {
  const ctx = tiny(); delete ctx.nasa;
  const r = good(await run(coreFor(ctx).core, { landing: '2027-01-01', refine: false, criteria: { stay_days: 1, nasa_avg_sun_min: 0.5 } }));
  assert.equal(r.candidates.length, 0); assert.equal(r.feasibility.binding, 'nasa_avg_sun_min');
  assert.ok(r.near_misses.length); assert.ok(r.near_misses.every((m) => m.value === null && m.unavailable));
});

test('find: refinement applies requested 1 km and 240 m slope scales and reports a PSR science target', async () => {
  const ctx = { ...context(), ice: () => null }, { core, kit } = coreFor(ctx);
  for (const slope_scale of ['1km', '240m']) {
    const r = good(await run(core, { landing: '2027-10-07', count: 2, criteria: { ...STRICT, slope_scale, ice: { class: 'shallow', within_km: 5 } } }));
    assert.ok(r.candidates.length > 0, slope_scale); monotone(r);
    const held = kit.refs.get('search', r.search_id), c = resolveCriteria(r.query_echo.criteria).criteria;
    for (const out of r.candidates) {
      const raw = held.candidates.find((v) => v.ref === out.ref);
      const m = staticMetrics({ coarse: ctx.coarse, fine: await ctx.fine(), dem240: await ctx.dem240(), psr: ctx.psr }, raw, c);
      assert.equal(out.metrics.slope_deg, Math.round(m.slope_deg * 10) / 10);
      assert.equal(out.eval.pass, true); assert.equal(out.science_target.source, 'psr_proxy');
    }
  }
});

test('find: real ice packs, when installed, supply exact thermally stable science targets', async (t) => {
  const ctx = context(), { core } = coreFor();
  if (!ctx.ice || !(await ctx.ice())) { t.skip('ice packs not installed; the fallback is tested separately'); return; }
  const r = good(await run(core, { landing: '2027-10-07', count: 2, criteria: { ...STRICT, ice: { class: 'shallow', within_km: 5 } } }));
  assert.ok(r.candidates.length > 0);
  assert.ok(!r.assumed.some((v) => /no temperature data/.test(v)));
  for (const c of r.candidates) { assert.equal(c.eval.pass, true); assert.equal(c.science_target.source, 'diviner'); assert.ok(c.science_target.dist_km <= 5); }
});

test('find: empty region, reference region, missing refine data and deterministic results', async () => {
  const { core, kit } = coreFor(tiny()), input = { landing: '2027-01-01', criteria: { stay_days: 1, slope_max_deg: 5 }, refine: false };
  const a = good(await run(core, input)), b = good(await run(core, input));
  delete a.search_id; delete b.search_id; delete a.about.timing_ms; delete b.about.timing_ms;
  assert.deepEqual(a, b);
  const none = good(await run(core, { ...input, region: { bbox: { lat_min: -70, lat_max: -60, lon_min: 0, lon_max: 360 } } }));
  assert.equal(none.feasibility.status, 'infeasible'); assert.equal(none.feasibility.binding, 'region'); monotone(none);
  kit.refs.put('mission', { points: [{ name: 'W2', latDeg: -89, lonDeg: 0 }] }, { prefix: 'm' });
  const nearby = good(await run(core, { ...input, region: { within_km: 2, of: { mission_point: 'W2' } } }));
  assert.equal(nearby.funnel.find((f) => f.stage === 'region').cells, 2);
  assert.ok((await run(core, { ...input, refine: true })).error);
});

test('find: exact skyline rejection becomes an exact_check near miss, never a candidate', async () => {
  const mask = () => 90; mask.profile = [90];
  const { core } = coreFor({ ...context(), skylineFor: () => mask });
  const r = good(await run(core, { landing: '2027-10-07', criteria: STRICT }));
  assert.equal(r.candidates.length, 0); assert.equal(r.feasibility.status, 'infeasible'); monotone(r);
  assert.ok(r.near_misses.some((m) => m.fails === 'exact_check' && m.check === 'both_continuous_h_min'));
});

test('find: Monte Carlo touchdowns for every candidate, on the finest terrain there; an optional floor', async () => {
  const { core } = coreFor();
  const base = { landing: '2027-10-07', criteria: STRICT };
  const r = good(await run(core, base));
  assert.ok(r.candidates.length >= 1);
  for (const c of r.candidates) {
    const t = c.touchdown;
    assert.ok(t, `${c.ref} has touchdown`);
    assert.ok(t.p_safe >= 0 && t.p_safe <= 1);
    assert.equal(t.landings, 2000);
    assert.deepEqual(t.ellipse_m, { downrange: 150, crossrange: 100 });
    assert.equal(t.slope_limit_deg, 10);
    assert.ok([5, 10, 20, 40, 120, 240].includes(t.dem_m), `DEM ${t.dem_m} m (240 m beyond dem_120m's ±156 km)`);
  }
  assert.ok(r.assumed.some((a) => /Monte Carlo/.test(a)));
  // the same query gives the same answer
  const again = good(await run(core, base));
  assert.deepEqual(again.candidates.map((c) => c.touchdown.p_safe), r.candidates.map((c) => c.touchdown.p_safe));
  // a floor: only candidates at or above it, and the funnel says how many fell
  const floor = good(await run(core, { ...base, touchdown: { min_p_safe: 0.99, downrange_m: 300, crossrange_m: 200 } }));
  for (const c of floor.candidates) { assert.ok(c.touchdown.p_safe >= 0.99); assert.deepEqual(c.touchdown.ellipse_m, { downrange: 300, crossrange: 200 }); }
  const stage = floor.funnel.find((f) => f.stage === 'touchdown');
  assert.ok(stage && Number.isInteger(stage.cells), JSON.stringify(floor.funnel));
  monotone(floor);
  // bad input is a user error
  assert.ok((await run(core, { ...base, touchdown: { min_p_safe: 2 } })).error);
});

test('find: without point terrain the touchdowns are left out and say so', async () => {
  const { core } = coreFor(tiny());
  const r = good(await run(core, { landing_window: { from: '2027-01-02', to: '2027-01-03' }, criteria: { slope_max_deg: 5 }, refine: false }));
  for (const c of r.candidates) assert.equal(c.touchdown, null);
  assert.ok(r.assumed.some((a) => /touchdown.*not available/i.test(a)));
});

test('core context: terrain around a point, finest first (high-resolution patch, 20 m and 40 m tiles, 120 m)', async () => {
  const ctx = context();
  assert.equal(typeof ctx.siteTerrain, 'function');
  const shack = ctx.sites.find((s) => s.id === 'shackleton');
  const t = await ctx.siteTerrain(shack);
  const [x, y] = toXY(shack.latDeg, shack.lonDeg);
  assert.ok(Number.isFinite(t.sample(x, y)));
  assert.ok(t.finestKm <= 0.02, `finest ${t.finestKm} km at Shackleton`);
  const mid = await ctx.siteTerrain({ latDeg: -86.5, lonDeg: 120 });   // inside dem_120m (±156 km), no tiles there
  assert.equal(mid.finestKm, 0.12);
  const far = await ctx.siteTerrain({ latDeg: -84, lonDeg: 120 });     // beyond it: dem_240m
  assert.equal(far.finestKm, 0.24);
});
