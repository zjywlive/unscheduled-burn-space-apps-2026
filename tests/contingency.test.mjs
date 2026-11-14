// Phase 5: safe havens and comms-denied navigation (demo/src/contingency.js), on synthetic terrain and
// skies with known answers, then a real route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { findHavens, isHaven, bearing, relAngle, checkpoints, HAVEN_DEFAULTS } from '../demo/src/contingency.js';
import { reachFrom, cleanMobility, planRoutes } from '../demo/src/route-plan.js';
import { simulateDrive, skyFromGrid } from '../demo/src/route-energy.js';
import { createDem, toXY, fromXY } from '../demo/src/terrain.js';
import { createEphemeris, bodyAzEl } from '../demo/src/ephemeris.js';
import { createHeatGrid } from '../demo/src/heat.js';

const KPP = 0.24, SIZE = 200, HALF = (SIZE * KPP) / 2;
const xOf = (c) => -HALF + (c + 0.5) * KPP, yOf = (r) => HALF - (r + 0.5) * KPP;
function demFrom(fn) {
  const data = new Int16Array(SIZE * SIZE);
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) data[r * SIZE + c] = Math.round(fn(xOf(c), yOf(r)) / 0.5);
  return createDem({ data, size: SIZE, kmPerPixel: KPP, dnToMeters: 0.5 });
}
const flat = demFrom(() => 0);
const MOB = cleanMobility({ speedKmh: 1 }, 15);
const T0 = Date.UTC(2027, 0, 13);
// lit and Earth in view only east of x = 3 km
const eastLit = (x) => ({ sunDeg: x > 3 ? 5 : -5, earthDeg: x > 3 ? 5 : -5, azDeg: 90, elDeg: 2, earthAzDeg: 0, earthElDeg: 5 });

test('reachFrom on flat ground: drive time is distance ÷ speed, energy is power × time', () => {
  const R = reachFrom(flat, [0, 0], { mob: MOB, radiusKm: 5, power: { loadW: 100, driveW: 100, massKg: 500, climbEff: 0.5 } });
  const n = R.cor.nodeAt(3, 0), [x, y] = R.xy(n), [sx, sy] = R.xy(R.start);
  assert.ok(Math.abs(R.hours[n] - Math.hypot(x - sx, y - sy)) < 0.02, `${R.hours[n]} h to ${x} km from ${sx}`);
  assert.ok(Math.abs(R.wh[n] - 200 * R.hours[n]) < 1e-3);
  assert.ok(R.cor.nodeAt(4.2, 4.2) >= 0);
  assert.equal(R.hours[R.cor.nodeAt(4.2, 4.2)], Infinity, 'in the search square but outside the 5 km radius');
});

test('the nearest haven is the closest lit, Earth-visible ground, found by drive time', () => {
  const profile = { x: Float32Array.from([0, -1]), y: new Float32Array(2), km: new Float32Array(2).fill(1), pitch: new Float32Array(2) };
  const drive = simulateDrive(profile, { mob: MOB, power: {}, departMs: T0, sky: eastLit });
  const r = findHavens({ dem: flat, mob: MOB, profile, drive, sky: (x) => eastLit(x), opts: { everyKm: 1, radiusKm: 6 } });
  assert.equal(r.checkpoints.length, 2);
  const h = r.checkpoints[0].haven;
  assert.ok(h && h.x > 3 && h.x < 3.4 && Math.abs(h.y) < 0.3, JSON.stringify(h));
  assert.ok(Math.abs(h.bearingDeg - bearing(0, 0, h.x, h.y)) < 1e-9);
  assert.ok(r.checkpoints[1].haven.hours > h.hours, 'farther from the second checkpoint');
  assert.ok(h.nav.drift95M > 0 && h.nav.drift95M < 0.02 * 4000);
});

test('no haven when the lit ground is past the radius, or past the battery', () => {
  const profile = { x: Float32Array.from([-8]), y: new Float32Array(1), km: new Float32Array(1).fill(0.1), pitch: new Float32Array(1) };
  const drive = simulateDrive(profile, { mob: MOB, power: {}, departMs: T0, sky: eastLit });
  const far = findHavens({ dem: flat, mob: MOB, profile, drive, sky: eastLit, opts: { radiusKm: 6 } });
  assert.equal(far.checkpoints[0].haven, null);
  assert.match(far.checkpoints[0].why, /within 6 km/);
  const low = { ...drive, perSample: { ...drive.perSample, socWh: Float32Array.from([50]) } };   // 50 Wh left: 15 minutes of driving
  const weak = findHavens({ dem: flat, mob: MOB, profile, drive: low, sky: eastLit, opts: { radiusKm: 12 } });
  assert.equal(weak.checkpoints[0].haven, null);
  assert.match(weak.checkpoints[0].why, /within reach of the 50 Wh/);
});

test('a haven must stay lit for the next day', () => {
  const sunsetSoon = (x, y, t) => ({ ...eastLit(x), sunDeg: x > 3 && t < T0 + 10 * 3600e3 ? 5 : -5 });
  assert.equal(isHaven(eastLit, 4, 0, T0, HAVEN_DEFAULTS), true);
  assert.equal(isHaven(sunsetSoon, 4, 0, T0, HAVEN_DEFAULTS), false);
});

test('bearing and relative angles: north is 0°, the Sun to the right is positive', () => {
  // near the pole on the 0° meridian, moving towards +y heads away from the pole (north)
  assert.ok(Math.abs(bearing(0, -20, 0, -10) - 180) < 0.5 || Math.abs(bearing(0, -20, 0, -10)) < 0.5);
  assert.equal(relAngle(100, 90), 10);
  assert.equal(relAngle(80, 90), -10);
  assert.equal(relAngle(10, 350), 20);
});

test('checkpoints follow the drive and stop where the battery ran out', () => {
  const profile = { x: Float32Array.from({ length: 50 }, (_, i) => i * 0.1), y: new Float32Array(50), km: new Float32Array(50).fill(0.1), pitch: new Float32Array(50) };
  const t = new Float64Array(50).fill(NaN); for (let i = 0; i < 30; i++) t[i] = T0 + i * 360e3;
  const cps = checkpoints(profile, { perSample: { tMs: t, socWh: new Float32Array(50).fill(1000) } }, 1);
  assert.equal(cps[0].km, 0);
  assert.ok(cps.at(-1).i === 29, 'the last reached sample is a checkpoint');
  assert.ok(cps.every((c) => c.i < 30));
});

const DATA = new URL('../demo/data/', import.meta.url);
const real = ['dem_240m.bin', 'terrain.json', 'horizon_1km.bin', 'ephemeris.json', 'sites.json'].every((f) => existsSync(new URL(f, DATA)));

test('real route: havens along the Flattest route to de Gerlache rim 2, leaving 18 Jan 2027 18:00 UTC', { skip: !real && 'data not here' }, async () => {
  const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA)));
  const l = meta.levels.find((x) => x.name === 'dem_240m');
  const b = readFileSync(new URL(l.file, DATA));
  const dem = createDem({ data: new Int16Array(b.buffer, b.byteOffset, b.length / 2), size: l.size, kmPerPixel: l.kmPerPixel, dnToMeters: l.dnToMeters, halfKm: l.halfKm });
  const sites = JSON.parse(readFileSync(new URL('sites.json', DATA)));
  const at = (id) => { const s = sites.find((x) => x.id === id); return toXY(s.latDeg, s.lonDeg); };
  const plan = await planRoutes({ points: [at('shackleton'), at('de-gerlache-rim-2')], dem, maxSlopeDeg: 15, mobility: {} }, { yieldFn: () => Promise.resolve() });
  const r = plan.routes.find((x) => x.id === 'flat');
  // the 1 km skyline grid, as the page uses once it is loaded (on the 2 km grid this drive runs out at km 7.8:
  // with the Sun 1–2° up, shadows depend on the skyline resolution)
  const grid = createHeatGrid({ horizon: new Uint8Array(readFileSync(new URL('horizon_1km.bin', DATA))), ...meta.horizons[1] });
  const eph = createEphemeris(JSON.parse(readFileSync(new URL('ephemeris.json', DATA))));
  const sky = skyFromGrid(grid, eph, bodyAzEl, fromXY);
  const drive = simulateDrive(r.profile, { mob: plan.mobility, power: {}, departMs: Date.UTC(2027, 0, 18, 18), sky });
  assert.ok(drive.ok, drive.reason);
  const t0 = performance.now();
  const h = findHavens({ dem, mob: plan.mobility, profile: r.profile, drive, sky });
  const ms = performance.now() - t0;
  assert.ok(h.checkpoints.length >= 20, `${h.checkpoints.length} checkpoints`);
  assert.ok(h.found > 0, 'at least one checkpoint has a haven');
  for (const c of h.checkpoints.filter((q) => q.haven)) assert.ok(c.haven.wh <= c.socWh + 1e-6 && c.haven.hours > 0 || c.haven.hours === 0);
  assert.ok(ms < 8000, `${ms.toFixed(0)} ms`);
});
