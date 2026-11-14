// The compute tier (demo/src/tools-core.js): every tool gives the numbers of the product's own functions
// for the same input, on the real demo/data, including a custom point and a stay clipped by the ephemeris end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadCoreContext } from '../tools/core-context.mjs';
import { createCoreTools, CORE_MAX_SCENARIOS } from '../demo/src/tools-core.js';
import { summarize, summarizePair } from '../demo/src/windows.js';
import { bodyAzEl } from '../demo/src/ephemeris.js';
import { skylineFor, toXY } from '../demo/src/terrain.js';
import { landingRibbon } from '../demo/src/ribbon.js';
import { planEnergyPair } from '../demo/src/energy.js';
import { PRESETS, relayForSummary } from '../demo/src/relay.js';
import { planRoutes, sunFromJobs, slopeAt } from '../demo/src/route-plan.js';
import { fractionJob } from '../demo/src/heat.js';
import { compareRows } from '../demo/src/ui/compare.js';
import { bundle } from '../tools/build.mjs';

const DATA = new URL('../demo/data/', import.meta.url);
const real = ['ephemeris.json', 'sites.json', 'terrain.json', 'dem_480m.bin', 'horizon_grid.bin', 'slope_2km.bin', 'shadow_2km.bin', 'dem_240m.bin', 'psr_120m.bin', 'nasa_sun_480m.bin']
  .every((f) => existsSync(new URL(f, DATA)));
const H = 3600e3, D = 86400e3;
const h1 = (ms) => Math.round((ms / H) * 10) / 10;
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString().slice(0, 16) + 'Z');

let ctx = null, tools = null;
function setup() {
  if (!ctx) { ctx = loadCoreContext(); tools = createCoreTools(ctx); }
  return { ctx, tools };
}
const site = (id) => ctx.sites.find((s) => s.id === id);
// the page's skyline: main.js sky() = terrain.js skylineFor on the 480 m DEM
const pageSky = (s) => skylineFor(ctx.dem, s);
const CUSTOM = { id: 'custom', name: 'Custom point', latDeg: -89.3, lonDeg: 222.7 };
const T0 = Date.UTC(2027, 0, 13);

test('tools-core: the module follows the bundler convention and lists twelve tools in the Claude format', () => {
  assert.doesNotThrow(() => bundle(new URL('../demo/src/tools-core.js', import.meta.url).pathname));
  const t = createCoreTools({ eph: { startMs: 0, endMs: 1, stepMs: 1, at: () => null }, sites: [] });
  assert.deepEqual(t.list, ['list_sites', 'site_summary', 'compare_scenarios', 'rise_set_events', 'next_events', 'sky_at', 'skyline', 'best_landing_dates', 'point_facts', 'energy_summary', 'relay_coverage', 'route_candidates']);
  for (const s of t.specs()) {
    assert.deepEqual(Object.keys(s), ['name', 'description', 'input_schema']);
    assert.equal(s.input_schema.type, 'object');
    assert.ok(s.description.length > 40, s.name);
  }
  assert.deepEqual(t.toolDefinitions(), t.specs());
});

test('tools-core: site_summary equals windows.summarize for sites, dates, a custom point and a clipped stay', { skip: !real }, async () => {
  setup();
  const cases = [
    [site('shackleton'), T0, 14], [site('im2'), T0, 7], [site('haworth'), Date.UTC(2027, 5, 2, 6), 30],
    [site('de-gerlache-rim-2'), Date.UTC(2028, 2, 20), 14], [CUSTOM, Date.UTC(2027, 2, 2, 10), 14],
    [site('shackleton'), Date.UTC(2028, 11, 25), 14],   // runs past 1 Jan 2029: clipped to 7 days
    [site('apollo11'), T0, 14],                          // off the terrain: smooth horizon
  ];
  for (const [s, landing, days] of cases) {
    const where = s.id === 'custom' ? { lat_deg: s.latDeg, lon_deg: s.lonDeg } : { site_id: s.id };
    const r = await tools.run('site_summary', { ...where, landing: new Date(landing).toISOString(), stay_days: days });
    assert.ok(!r.error, r.error);
    const ref = summarize(ctx.eph, s, landing, days, pageSky(s));
    const tag = `${s.name} ${iso(landing)}`;
    assert.equal(r.sunH, h1(ref.sunMs), tag); assert.equal(r.earthH, h1(ref.earthMs), tag); assert.equal(r.bothH, h1(ref.bothMs), tag);
    assert.equal(r.longestDarkH, h1(ref.longestDarkMs), tag);
    assert.equal(r.peakSunElDeg, Math.round(ref.peakSunElDeg * 10) / 10, tag);
    assert.equal(r.firstSunset, iso(ref.firstSunsetMs), tag); assert.equal(r.firstEarthset, iso(ref.firstEarthsetMs), tag);
    assert.equal(r.stay.clipped, ref.clipped, tag); assert.equal(r.stay.coveredH, h1(ref.stayMs), tag);
    assert.equal(r.eventCount, ref.events.length, tag);
    assert.ok(r.about.units && r.about.resolution.skyline && r.about.limits.length >= 2, tag);
  }
  const clipped = await tools.run('site_summary', { site_id: 'shackleton', landing: '2028-12-25', stay_days: 14 });
  assert.equal(clipped.stay.clipped, true);
  assert.equal(clipped.stay.coveredH, 168);
  const smooth = await tools.run('site_summary', { site_id: 'apollo11', landing: '2027-01-13' });
  assert.equal(smooth.horizon, 'smooth');
  assert.match(smooth.note, /smooth horizon/);
});

test('tools-core: places in the formats coords.js parses give the same point', { skip: !real }, async () => {
  setup();
  const forms = [{ lat_deg: -89.3, lon_deg: 222.7 }, { lat_deg: '89.3S', lon_deg: '137.3W' }, { lat_deg: '89.3°S', lon_deg: -137.3 }, { lat_deg: '−89.3', lon_deg: '222.7E' }];
  const out = [];
  for (const f of forms) out.push(await tools.run('site_summary', { ...f, landing: '2027-03-02T10:00Z' }));
  for (const r of out) { assert.ok(!r.error, r.error); assert.equal(r.bothH, out[0].bothH); assert.equal(Math.abs(r.place.lonDeg - 222.7) < 1e-9, true); }
  // the landing snaps down to the hour, as the page does
  assert.equal(out[0].landing, '2027-03-02T10:00Z');
  assert.equal((await tools.run('site_summary', { site_id: 'shackleton', landing: '2027-03-02T10:59Z' })).landing, '2027-03-02T10:00Z');
});

test('tools-core: compare_scenarios is summarizePair for two, the same cut rule for more, and carries the Compare card text', { skip: !real }, async () => {
  setup();
  const a = site('shackleton'), b = site('im2');
  const r2 = await tools.run('compare_scenarios', { scenarios: [{ site_id: 'shackleton', landing: '2027-01-13' }, { site_id: 'im2', landing: '2027-01-27' }], stay_days: 14 });
  const pair = summarizePair(ctx.eph, { site: a, landingMs: T0, mask: pageSky(a) }, { site: b, landingMs: T0 + 14 * D, mask: pageSky(b) }, 14, 0);
  assert.equal(r2.scenarios[1].bothH, h1(pair.alt.bothMs));
  assert.equal(r2.scenarios[1].vsBaseline.bothH, h1(pair.alt.bothMs - pair.planned.bothMs));
  assert.deepEqual(r2.scenarios[1].vsBaseline.card.map((x) => x.change), compareRows(pair.planned, pair.alt).map((x) => x.change));
  // a clipped alternative cuts both (summarizePair), and three scenarios follow the same rule
  const late = Date.UTC(2028, 11, 22);
  const r3 = await tools.run('compare_scenarios', { places: [{ site_id: 'shackleton' }, { lat_deg: -89.3, lon_deg: 222.7 }, { site_id: 'haworth' }], landings: ['2027-01-13', '2028-12-22'], stay_days: 14 });
  assert.equal(r3.count, 6);
  assert.equal(r3.cut, true);
  assert.equal(r3.comparedDays, 10);
  const ref = summarize(ctx.eph, CUSTOM, T0, 10, pageSky(CUSTOM));
  assert.equal(r3.scenarios[2].bothH, h1(ref.bothMs));
  const pair2 = summarizePair(ctx.eph, { site: a, landingMs: T0, mask: pageSky(a) }, { site: a, landingMs: late, mask: pageSky(a) }, 14, 0);
  assert.equal(pair2.stayDays, 10);
  assert.equal(r3.scenarios[1].bothH, h1(pair2.alt.bothMs));
  assert.equal(r3.scenarios[0].bothH, h1(pair2.planned.bothMs));
  assert.equal(r3.ranking.bothH.length, 6);
});

test('tools-core: rise_set_events is the summary event list; next_events agrees with it and searches past any window', { skip: !real }, async () => {
  setup();
  for (const [s, start] of [[site('shackleton'), T0], [CUSTOM, Date.UTC(2027, 2, 2, 10)], [site('nobile-rim-2'), Date.UTC(2027, 7, 1, 3, 30)]]) {
    const where = s.id === 'custom' ? { lat_deg: s.latDeg, lon_deg: s.lonDeg } : { site_id: s.id };
    const r = await tools.run('rise_set_events', { ...where, start: new Date(start).toISOString(), days: 40 });
    const ref = summarize(ctx.eph, s, start, 40, pageSky(s));
    assert.equal(r.count, ref.events.length);
    r.events.forEach((e, i) => { assert.equal(e.time, iso(ref.events[i].tMs)); assert.equal(e.azDeg, Math.round(ref.events[i].azDeg * 10) / 10); });
    // next_events from the same instant finds the same first crossings (same 15-minute sample grid)
    const n = await tools.run('next_events', { ...where, at: new Date(start).toISOString() });
    const first = (body, kind) => ref.events.find((e) => e.body === body && e.kind === kind)?.tMs ?? null;
    if (first('sun', 'set') !== null) assert.equal(n.sun.nextSet.time, iso(first('sun', 'set')), s.name);
    if (first('earth', 'set') !== null) assert.equal(n.earth.nextSet.time, iso(first('earth', 'set')), s.name);
    if (first('sun', 'rise') !== null) assert.equal(n.sun.nextRise.time, iso(first('sun', 'rise')), s.name);
    assert.equal(n.sun.upNow, ref.sunUpAtLanding); assert.equal(n.earth.upNow, ref.earthUpAtLanding);
  }
  // Shackleton ridge is lit for all of a 14-day stay from 13 Jan 2027; the next sunset lies beyond it
  const n = await tools.run('next_events', { site_id: 'shackleton', at: '2027-01-13' });
  const long = summarize(ctx.eph, site('shackleton'), T0, 200, pageSky(site('shackleton')));
  assert.ok(Date.parse(n.sun.nextSet.time) > T0 + 14 * D);
  assert.equal(n.sun.nextSet.time, iso(long.firstSunsetMs));
  assert.match(n.headline, /^(Sunset|Sunrise) in .* · (Earthset|Earthrise|No Earthrise|Earth stays)/);
  assert.equal(n.searchedTo, '2029-01-01T00:00Z');
});

test('tools-core: sky_at matches bodyAzEl and the skyline; skyline returns the page skyline profile', { skip: !real }, async () => {
  setup();
  const s = site('de-gerlache-rim-2'), t = Date.UTC(2027, 4, 5, 17, 20);
  const r = await tools.run('sky_at', { site_id: s.id, at: '2027-05-05T17:20Z' });
  const ref = bodyAzEl(ctx.eph, s, t), m = pageSky(s);
  assert.equal(r.sun.elDeg, Math.round(ref.sun.elDeg * 100) / 100);
  assert.equal(r.earth.skylineDeg, Math.round(m(ref.earth.azDeg) * 100) / 100);
  assert.equal(r.sun.visible, ref.sun.elDeg - m(ref.sun.azDeg) > 0);
  assert.equal(typeof r.sun.why, 'string');
  const many = await tools.run('sky_at', { lat_deg: -89.3, lon_deg: 222.7, times: ['2027-03-02T10:00Z', '2027-03-12T10:00Z'] });
  assert.equal(many.count, 2);
  assert.equal(many.samples[1].sun.visible, false);
  const sk = await tools.run('skyline', { site_id: 'shackleton', step_deg: 1 });
  assert.equal(sk.profile.length, 360);
  const shack = pageSky(site('shackleton')).profile;
  for (const az of [0, 37, 144, 300]) assert.equal(sk.profile[az].elDeg, Math.round(shack[az] * 100) / 100);
  assert.match((await tools.run('skyline', { site_id: 'apollo11' })).error, /north of 80°S/);
});

test('tools-core: best_landing_dates ranks the landing-date ribbon and re-checks the picks', { skip: !real }, async () => {
  setup();
  for (const id of ['im2', 'haworth']) {
    const s = site(id);
    const r = await tools.run('best_landing_dates', { site_id: id, stay_days: 14, count: 4, compare_to: '2027-01-13' });
    const rib = landingRibbon(ctx.eph, s, pageSky(s), 14);
    const best = Math.max(...rib.bothMs);
    assert.equal(r.candidates[0].bothH, h1(best));
    assert.equal(r.daysConsidered, rib.dayMs.length);
    for (const c of r.candidates) {
      const i = rib.dayMs.indexOf(Date.parse(c.landing));
      assert.equal(c.bothH, h1(rib.bothMs[i]));
      const ex = summarize(ctx.eph, s, rib.dayMs[i], 14, pageSky(s));
      assert.equal(c.exact.bothH, h1(ex.bothMs));
      assert.ok(Math.abs(c.exact.bothH - c.bothH) <= 1.05, `${id} ${c.landing}: ribbon ${c.bothH} vs scan ${c.exact.bothH}`);
    }
    for (let i = 1; i < r.candidates.length; i++) assert.ok(r.candidates[i].bothH <= r.candidates[i - 1].bothH);
    const pi = rib.dayMs.indexOf(T0);
    assert.equal(r.planned.bothH, h1(rib.bothMs[pi]));
    assert.equal(r.planned.rank, 1 + [...rib.bothMs].filter((v) => v > rib.bothMs[pi]).length);
  }
  const ranged = await tools.run('best_landing_dates', { site_id: 'im2', from: '2027-06-01', to: '2027-06-30', count: 2, min_gap_days: 10 });
  for (const c of ranged.candidates) assert.ok(c.landing >= '2027-06-01' && c.landing <= '2027-06-30T23:59Z');
  if (ranged.candidates.length === 2) assert.ok(Math.abs(Date.parse(ranged.candidates[0].landing) - Date.parse(ranged.candidates[1].landing)) >= 10 * D);
});

test('tools-core: point_facts reads the same grids as the page (height, cell slope, node slope, PSR, NASA averages)', { skip: !real }, async () => {
  setup();
  for (const where of [{ site_id: 'shackleton' }, { lat_deg: -89.9, lon_deg: 0 }, { lat_deg: '87.1S', lon_deg: '45E' }]) {
    const r = await tools.run('point_facts', where);
    assert.ok(!r.error, r.error);
    const lat = r.place.latDeg, lon = r.place.lonDeg, [x, y] = toXY(lat, lon);
    assert.equal(r.heightM, Math.round(ctx.dem.heightAt(lat, lon)));
    const k = ctx.coarse.grid.cellAt(x, y);
    assert.equal(r.slope.cellMeanDeg, Math.round(ctx.coarse.slope[k] * 100) / 100);
    assert.equal(r.psrDistanceKm, ctx.coarse.shadow[k]);
    assert.equal(r.slope.pointDeg, Math.round(slopeAt(ctx.dem240(), x, y) * 100) / 100);
    assert.equal(r.psr.inside, ctx.psr.isPsr(x, y));
    const n = ctx.nasa.sample(x, y);
    assert.equal(r.nasaAverage.sunPct, Math.round(n.sunPct * 10) / 10);
  }
  // without the extras the tool says so instead of guessing
  const bare = createCoreTools({ eph: ctx.eph, sites: ctx.sites, dem: ctx.dem });
  const r = await bare.run('point_facts', { site_id: 'shackleton' });
  assert.equal(r.psr.available, false);
  assert.equal(r.nasaAverage.available, false);
  assert.equal(r.slope.pointDeg, null);
  assert.match(r.slope.pointNote, /not available/);
  assert.match((await tools.run('point_facts', { lat_deg: -75, lon_deg: 10 })).error, /80°S/);
});

test('tools-core: energy_summary and relay_coverage give the Energy and Relay cards\' numbers, assumptions labelled', { skip: !real }, async () => {
  setup();
  const s = site('nobile-rim-2'), alt = Date.UTC(2027, 0, 27);
  const e = await tools.run('energy_summary', { site_id: s.id, landing: '2027-01-13', battery_hours: 48, alternative: { landing: '2027-01-27' } });
  const ref = planEnergyPair(ctx.eph, { site: s, landingMs: T0, mask: pageSky(s) }, { site: s, landingMs: alt, mask: pageSky(s) }, 14, { batteryHours: 48 });
  const r1 = (v) => Math.round(v * 10) / 10;
  assert.equal(e.planned.atEmptyH, r1(ref.planned.sim.emptyH));
  assert.equal(e.planned.minBatteryH, r1(ref.planned.sim.minBatteryH));
  assert.equal(e.alternative.sunlitH, r1(ref.alt.litMs / H));
  assert.equal(e.assumptions.assumed, true);
  assert.ok(e.about.assumed.includes('batteryHours'));
  // a clipped stay: the energy figures cover the part inside the ephemeris
  const late = await tools.run('energy_summary', { site_id: s.id, landing: '2028-12-28', stay_days: 14 });
  assert.equal(late.plannedClipped, true);
  assert.equal(late.planned.coveredH, 96);

  const rl = await tools.run('relay_coverage', { lat_deg: -89.3, lon_deg: 222.7, landing: '2027-03-02T10:00Z', preset: 'elliptical-24h', alternative: { site_id: 'shackleton', landing: '2027-03-16T10:00Z' } });
  const p0 = Date.UTC(2027, 2, 2, 10), a0 = p0 + 14 * D, sh = site('shackleton');
  const pair = summarizePair(ctx.eph, { site: CUSTOM, landingMs: p0, mask: pageSky(CUSTOM) }, { site: sh, landingMs: a0, mask: pageSky(sh) }, 14, 0);
  const el = PRESETS.find((p) => p.id === 'elliptical-24h').elements;
  const rp = relayForSummary(pair.planned, { elements: el, eph: ctx.eph, site: CUSTOM, mask: pageSky(CUSTOM), minElDeg: 0, defaultEpochMs: p0 });
  const ra = relayForSummary(pair.alt, { elements: el, eph: ctx.eph, site: sh, mask: pageSky(sh), minElDeg: 0, defaultEpochMs: p0 });
  const h = (ms) => Math.round(ms / 360e3) / 10;
  assert.equal(rl.planned.relayH, h(rp.relayMs)); assert.equal(rl.planned.longestBlindH, h(rp.longestBlindMs));
  assert.equal(rl.alternative.directOrRelayH, h(ra.anyMs)); assert.equal(rl.alternative.earthDirectH, h(ra.directMs));
  assert.equal(rl.orbit.assumed, true);
  assert.match((await tools.run('relay_coverage', { site_id: 'shackleton', landing: '2027-01-13', a_km: 1800, e: 0.5 })).error, /not valid/);
});

test('tools-core: route_candidates equals planRoutes with the page\'s full 2 km Sun job of the stay', { skip: !real, timeout: 120000 }, async () => {
  setup();
  const pts = [site('shackleton'), site('de-gerlache-rim-2')];
  const r = await tools.run('route_candidates', { points: [{ site_id: 'shackleton' }, { site_id: 'de-gerlache-rim-2' }], landing: '2027-01-13', include_path: true });
  assert.ok(!r.error, r.error);
  // the page: the full map job of the planned stay over the whole 2 km grid (heatplan.js), no rect
  const job = fractionJob(ctx.coarse.grid, ctx.eph, T0, T0 + 14 * D);
  while (!job.run(1000));
  const ref = await planRoutes({ points: pts.map((s) => toXY(s.latDeg, s.lonDeg)), dem: ctx.dem240(), sunAt: sunFromJobs([{ grid: ctx.coarse.grid, job }]), isPsr: (x, y) => ctx.psr.isPsr(x, y), maxSlopeDeg: 15 });
  const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  assert.deepEqual(r.routes.map((x) => [x.id, x.lengthKm, x.maxSlopeDeg, x.meanSlopeDeg, x.sunSharePct, x.psrKm, x.sameAs]),
    ref.routes.map((x) => [x.id, r1(x.lengthKm), r1(x.maxSlopeDeg), r1(x.meanSlopeDeg), x.sunShare == null ? null : r1(x.sunShare * 100), r1(x.psrKm), x.sameAs ?? null]));
  assert.ok(r.routes[0].path.length >= 2);
  // without a landing the sunniest candidate is unavailable, as on the page before a stay is computed
  const noSun = await tools.run('route_candidates', { points: [[-89.45, 222.69], ['88.5S', '66.7W']] });
  assert.equal(noSun.routes.find((x) => x.id === 'sunny').unavailable, 'Needs the sunlight figures of the planned stay.');
  const blocked = await tools.run('route_candidates', { points: [[-87.5, 0], [-87.5, 90]], max_slope_deg: 5 });
  assert.ok(blocked.error && blocked.blocked, JSON.stringify(blocked).slice(0, 200));
  const noDem = await createCoreTools({ eph: ctx.eph, sites: ctx.sites }).run('route_candidates', { points: [[-89.45, 222.69], [-88.5, 293.3]] });
  assert.match(noDem.error, /not available/);
});

test('tools-core: errors come back as data', { skip: !real }, async () => {
  setup();
  const cases = [
    ['site_summary', { site_id: 'shackleton', landing: '2030-01-01' }, /ephemeris covers 1 Nov 2026 to 1 Jan 2029/],
    ['site_summary', { site_id: 'shackleton', landing: '2029-01-01T00:00Z' }, /ephemeris covers/],
    ['site_summary', { site_id: 'nowhere', landing: '2027-01-13' }, /Unknown site_id/],
    ['site_summary', { lat_deg: -95, lon_deg: 0, landing: '2027-01-13' }, /latitude/i],
    ['site_summary', { lat_deg: -89, landing: '2027-01-13' }, /go together/],
    ['site_summary', { site_id: 'shackleton', landing: '13/01/2027' }, /must look like/],
    ['site_summary', { site_id: 'shackleton', landing: '2027-02-30' }, /not a valid date/],
    ['next_events', { site_id: 'shackleton', at: '2026-10-31T23:00Z' }, /outside/],
    ['compare_scenarios', { scenarios: [{ site_id: 'shackleton', landing: '2027-01-13' }] }, /at least two/],
    ['compare_scenarios', { places: Array.from({ length: 5 }, () => ({ site_id: 'im2' })), landings: ['2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01', '2027-05-01'] }, /at most 24/],
    ['site_summary', { scenarios: Array.from({ length: CORE_MAX_SCENARIOS + 1 }, () => ({ site_id: 'im2', landing: '2027-01-13' })) }, /at most 24/],
    ['route_candidates', { points: [[-70, 0], [-89, 0]] }, /80°S/],
    ['sky_at', { site_id: 'shackleton' }, /at or times/],
    ['nope', {}, /Unknown tool/],
    ['site_summary', { site_id: 'shackleton', landing: '2027-01-13', colour: 'red' }, /Unknown field colour/],
  ];
  for (const [name, input, re] of cases) {
    const r = await tools.run(name, input);
    assert.ok(r && typeof r.error === 'string', `${name} ${JSON.stringify(input).slice(0, 80)} → ${JSON.stringify(r).slice(0, 120)}`);
    assert.match(r.error, re, `${name}: ${r.error}`);
  }
  // one bad row in a batch summary stays in its row
  const mixed = await tools.run('site_summary', { scenarios: [{ site_id: 'im2', landing: '2027-01-13' }, { site_id: 'im2', landing: '2031-01-01' }] });
  assert.equal(mixed.count, 2);
  assert.ok(!mixed.results[0].error);
  assert.match(mixed.results[1].error, /ephemeris/);
});

test('tools-core: stateless — the same call twice gives the same answer, and ctx is not changed', { skip: !real }, async () => {
  setup();
  const keys = Object.keys(ctx).sort();
  const a = await tools.run('compare_scenarios', { places: [{ site_id: 'shackleton' }, { site_id: 'im2' }], landings: ['2027-01-13', '2027-01-27'] });
  const b = await tools.run('compare_scenarios', { places: [{ site_id: 'shackleton' }, { site_id: 'im2' }], landings: ['2027-01-13', '2027-01-27'] });
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(ctx).sort(), keys);
  // a page-supplied skyline provider is used as given (shared cache, not wrapped)
  let calls = 0;
  const t = createCoreTools({ eph: ctx.eph, sites: ctx.sites, dem: ctx.dem, skylineFor: (s) => { calls++; return pageSky(s); } });
  const r = await t.run('site_summary', { site_id: 'haworth', landing: '2027-01-13' });
  assert.ok(calls >= 1);
  assert.equal(r.bothH, h1(summarize(ctx.eph, site('haworth'), T0, 14, pageSky(site('haworth'))).bothMs));
});

test('M4: clipped comparisons report actual days for two, three and four scenarios without changing hours', async () => {
  assert.ok(real, 'real data required for this regression');
  setup();
  for (const count of [2, 3, 4]) {
    for (const landing of ['2028-12-25', '2028-12-31T12:00Z', '2027-01-13']) {
      const ids = ['shackleton', 'im2', 'haworth', 'nobile-rim-2'].slice(0, count);
      const r = await tools.run('compare_scenarios', { stay_days: 14, scenarios: ids.map((site_id) => ({ site_id, landing })) });
      const sums = ids.map((id) => summarize(ctx.eph, site(id), Date.parse(landing), 14, pageSky(site(id))));
      const days = sums[0].stayMs / D;
      assert.equal(r.comparedDays, days, `${count}: ${landing}`);
      assert.equal(r.stayDays, days);
      assert.equal(r.cut, days < 14);
      assert.equal(r.requestedDays, 14);
      r.scenarios.forEach((s, i) => {
        assert.deepEqual([s.sunH, s.earthH, s.bothH, s.longestDarkH, s.stay.coveredH],
          [sums[i].sunMs, sums[i].earthMs, sums[i].bothMs, sums[i].longestDarkMs, sums[i].stayMs].map(h1));
      });
    }
  }
  const single = await tools.run('site_summary', { site_id: 'shackleton', landing: '2028-12-25', stay_days: 14 });
  const ref = summarize(ctx.eph, site('shackleton'), Date.parse('2028-12-25'), 14, pageSky(site('shackleton')));
  assert.deepEqual([single.stay.requestedDays, single.stay.coveredH, single.stay.clipped], [14, h1(ref.stayMs), true]);
});

test('M4: relay single/equal-clipped/unequal-clipped stays use actual days and preserve all hour figures', async () => {
  assert.ok(real, 'real data required for this regression');
  setup();
  const p = site('shackleton'), a = site('im2');
  for (const [landing, altLanding] of [['2028-12-25', null], ['2028-12-25', '2028-12-25'], ['2028-12-25', '2028-12-28'], ['2028-12-31T12:00Z', null], ['2027-01-13', null]]) {
    const r = await tools.run('relay_coverage', { site_id: p.id, landing, stay_days: 14, ...(altLanding ? { alternative: { site_id: a.id, landing: altLanding } } : {}) });
    const planned = { site: p, landingMs: Date.parse(landing), mask: pageSky(p) };
    const pair = altLanding ? summarizePair(ctx.eph, planned, { site: a, landingMs: Date.parse(altLanding), mask: pageSky(a) }, 14, 0)
      : { planned: summarize(ctx.eph, p, planned.landingMs, 14, pageSky(p)) };
    const days = pair.planned.stayMs / D;
    assert.equal(r.stayDays, days, `${landing}/${altLanding}`);
    assert.equal(r.cut, days < 14);
    for (const [out, sum, s] of [[r.planned, pair.planned, p], [r.alternative, pair.alt, a]]) {
      if (!sum) continue;
      const ref = relayForSummary(sum, { elements: PRESETS[0].elements, eph: ctx.eph, site: s, mask: pageSky(s), minElDeg: 0, defaultEpochMs: planned.landingMs });
      assert.deepEqual([out.relayH, out.longestRelayGapH, out.earthDirectH, out.directOrRelayH, out.longestBlindH, out.stayH],
        [ref.relayMs, ref.longestRelayGapMs, ref.directMs, ref.anyMs, ref.longestBlindMs, ref.stayMs].map(h1));
    }
  }
});

test('M4: energy cut describes ephemeris clipping even for a single or equally clipped pair', async () => {
  assert.ok(real, 'real data required for this regression');
  setup();
  const s = site('shackleton'), landingMs = Date.parse('2028-12-25');
  for (const alternative of [undefined, { landing: '2028-12-25' }]) {
    const r = await tools.run('energy_summary', { site_id: s.id, landing: '2028-12-25', stay_days: 14, ...(alternative ? { alternative } : {}) });
    const scenario = { site: s, landingMs, mask: pageSky(s) };
    const ref = planEnergyPair(ctx.eph, scenario, alternative ? scenario : null, 14);
    assert.equal(r.stayDays, ref.planned.stayMs / D);
    assert.equal(r.cut, true);
    assert.equal(r.planned.coveredH, h1(ref.planned.stayMs));
    assert.equal(r.planned.sunlitH, h1(ref.planned.litMs));
    if (alternative) assert.equal(r.alternative.coveredH, h1(ref.alt.stayMs));
  }
});
