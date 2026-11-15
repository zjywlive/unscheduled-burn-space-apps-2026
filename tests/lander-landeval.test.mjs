// Where to land, the orchestration (demo/src/lander/landeval.js) on the real data: the landing time screened, the
// listed sites in a region, the nearest misses when nothing passes, great-circle spacing, the user's weights,
// cancelling, and a data layer that fails to load (audit 2026-11-15 L1, L2, L3, L11, L13).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { createDem, toXY } from '../demo/src/terrain.js';
import { createLandingEvaluator } from '../demo/src/lander/landeval.js';
import { VEHICLE_DEFAULTS, cleanVehicle } from '../demo/src/lander/vehicle.js';
import { distanceBearing } from '../demo/src/lander/skyline.js';

const demo = new URL('../demo/', import.meta.url);
const json = (p) => JSON.parse(readFileSync(new URL(p, demo), 'utf8'));
const b64 = (name) => { const t = readFileSync(new URL(`data/js/${name}.js`, demo), 'utf8'); const i = t.indexOf(',"') + 2; return t.slice(i, t.indexOf('"', i)); };
const eph = createEphemeris(json('data/ephemeris.json'));
const meta = json('data/terrain.json');
const sites = json('data/sites.json');
const bytes = Buffer.from(b64('dem_480m'), 'base64');
const dem = createDem({ data: new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1), size: meta.dem.size, kmPerPixel: meta.dem.kmPerPixel, dnToMeters: meta.dem.dnToMeters });
// the page's data packs, as its boot script stores them (data-loader.js reads window.__lsnStore; globalThis here)
const store = (...names) => { globalThis.__lsnStore ??= {}; for (const n of names) globalThis.__lsnStore[n] = b64(n); };

const DAY = 86400e3;
const shack = sites.find((s) => s.id === 'shackleton');
const [sx, sy] = toXY(shack.latDeg, shack.lonDeg);
const region = (half) => ({ type: 'rect', x0: sx - half, x1: sx + half, y0: sy - half, y1: sy + half });
function evaluator({ landingMs, stayDays = 7, weights, vehicle = {} }) {
  return createLandingEvaluator({
    eph, sites, meta, getDem: () => dem, siteCtx: null,
    getVehicle: () => cleanVehicle({ ...VEHICLE_DEFAULTS, ...vehicle }),
    getFromMs: () => landingMs - 2 * DAY, getStayDays: () => stayDays,
    getLandingMs: () => landingMs, getWeights: () => weights,
  });
}

test('landeval: a layer that fails to load is an error, and the next search loads it again', async () => {
  store('shadow_1km');   // no slope grid yet
  const ev = evaluator({ landingMs: Date.parse('2027-01-10T02:00Z') });
  await assert.rejects(ev.evaluateRegion(region(4), {}, { cells: 16 }), /slope/);
  store('slope_1km', 'psr_120m');
  const res = await ev.evaluateRegion(region(4), {}, { cells: 16 });
  assert.ok(res.grid.length >= 16 && res.grid.every((p) => Number.isFinite(p.slopeDeg)));
});

test('landeval: a region is screened at the planned landing, each spot lands within two days of it and keeps its own first window', async () => {
  const plan = Date.parse('2027-01-10T02:00Z');
  const res = await evaluator({ landingMs: plan }).evaluateRegion(region(10), {}, { cells: 100 });
  assert.equal(res.planned, true);
  assert.ok(res.list.length > 0, 'spots found');
  for (const c of res.list) {
    assert.ok(Math.abs(c.landingMs - plan) <= 2 * DAY, `${c.name} lands within two days of the plan`);
    assert.ok(Number.isFinite(c.ownLandingMs), `${c.name} has its own first lit window`);
  }
  // the listed sites inside the region are screened too
  assert.ok(res.grid.some((p) => p.listed === shack.name), 'Shackleton ridge is a grid point');
  // spots at least two grid steps apart, on the ground
  for (let a = 0; a < res.list.length; a++) for (let b = a + 1; b < res.list.length; b++) {
    assert.ok(distanceBearing(res.list[a], res.list[b]).km >= 2 * res.stepKm - 1e-6, 'spaced apart');
  }
  // the funnel the card explains
  const f = res.funnel;
  assert.equal(f.screened, res.grid.length);
  assert.ok(f.passed > 0 && f.passed <= f.usable && f.usable <= f.slopeOk);
});

test('landeval: when no grid point passes, the nearest misses are scored and the funnel says what it would take', async () => {
  // a 14-day stay from 31 Mar 2027: the Sun is low over the south pole and no place there is dark less than about a
  // day, far beyond the default battery (10.9 h)
  const res = await evaluator({ landingMs: Date.parse('2027-03-31T00:00Z'), stayDays: 14 }).evaluateRegion(region(10), {}, { cells: 100 });
  assert.equal(res.funnel.passed, 0);
  assert.ok(res.funnel.minDarkH >= 16, `shortest dark spell ${res.funnel.minDarkH} h`);
  assert.ok(res.list.length > 0, 'the nearest misses are shown, not nothing');
  assert.ok(res.list.every((c) => c.relaxed), 'each marked as a near miss');
  // scored in detail (hourly, landing in the first lit window near the plan, which can shorten the night)
  assert.ok(res.list.every((c) => Number.isFinite(c.figs.find((f) => f.id === 'dark').value)), 'each with its hourly dark spell');
  assert.equal(res.relaxed, res.list.length);
});

test('landeval: the grid is scored with the weights given (the Suitability mode\'s)', async () => {
  const res = await evaluator({ landingMs: Date.parse('2027-01-10T02:00Z'), weights: { sun: 1, earth: 0, slope: 0, shadow: 0 } }).evaluateRegion(region(4), {}, { cells: 16 });
  for (const p of res.grid) assert.ok(Math.abs(p.score - p.sun) < 1e-6, 'score = Sun share');
});

test('landeval: around a point, the planned landing too; a newer search cancels the older one', async () => {
  const plan = Date.parse('2027-01-10T02:00Z');
  const ev = evaluator({ landingMs: plan });
  const first = ev.evaluate(shack.latDeg, shack.lonDeg, {}, { radiusKm: 3 });
  ev.cancel();
  assert.equal(await first, null);
  const res = await ev.evaluate(shack.latDeg, shack.lonDeg, {}, { radiusKm: 3 });
  assert.equal(res.list[0].name, 'Your point');
  assert.ok(res.list.every((c) => Math.abs(c.landingMs - plan) <= 2 * DAY));
  assert.equal(res.funnel.screened, res.grid.length);
});

test('landcard: the card explains a thin screen and what the shortest night would take', async () => {
  const { funnelText } = await import('../demo/src/ui/landcard.js');
  const result = { limit: 10, battH: 4.2, relaxed: 4, funnel: { screened: 1943, slopeOk: 1232, notPsr: 1766, darkOk: 2, usable: 1145, sharesOk: 1943, passed: 0, minDarkH: 24, stepH: 4 } };
  const t = funnelText(result, { loadW: 960, reservePct: 20, batteryWh: 5000 });
  assert.match(t, /^No grid point passes every hard limit\./);
  assert.match(t, /1232 with slope ≤ 10°, 1766 outside permanent shadow, 2 with the longest dark spell ≤ 4\.2 h/);
  assert.match(t, /shortest dark spell is 24 h: .* about 28,800 Wh of battery \(now 5,000 Wh\)/);   // 24 h × 960 W / 0.8
  assert.match(t, /marked ≈ are the nearest misses/);
  assert.equal(funnelText({ ...result, relaxed: 0, funnel: { ...result.funnel, passed: 40 } }, {}), null, 'nothing to explain when enough pass');
});
