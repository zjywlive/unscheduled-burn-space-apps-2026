// Phase 3: energy along a route (demo/src/route-energy.js) with synthetic profiles and skies whose answers
// can be worked out by hand, then a real route under the real ephemeris and skylines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { simulateDrive, cleanPower, drivePowerW, panelW, skyFromGrid, POWER_DEFAULTS, G_MOON } from '../demo/src/route-energy.js';
import { planRoutes } from '../demo/src/route-plan.js';
import { createDem, toXY, fromXY } from '../demo/src/terrain.js';
import { createEphemeris, bodyAzEl } from '../demo/src/ephemeris.js';
import { createHeatGrid } from '../demo/src/heat.js';

const MOB = { climbDeg: 15, descentDeg: 20, crossDeg: 12, speedKmh: 1 };
// a straight profile: n samples of dk ground km at grade pitch (tan)
const line = (n, dk, pitch = 0) => ({ x: Float32Array.from({ length: n }, (_, i) => i * dk), y: new Float32Array(n), km: new Float32Array(n).fill(dk), pitch: new Float32Array(n).fill(pitch) });
const dark = () => ({ sunDeg: -5, earthDeg: 5, azDeg: 0, elDeg: -5 });
const sunAt = (elDeg) => () => ({ sunDeg: 10, earthDeg: 5, azDeg: 90, elDeg });
const T0 = Date.UTC(2027, 0, 13);

test('in the dark on the flat, the battery falls by (load + drive) × hours', () => {
  const p = cleanPower({ batteryWh: 4000, loadW: 100, driveW: 200, reserve: 0 });
  const d = simulateDrive(line(100, 0.1), { mob: MOB, power: p, departMs: T0, sky: dark });   // 10 km at 1 km/h = 10 h
  assert.ok(d.ok);
  assert.ok(Math.abs(d.driveH - 10) < 1e-6);
  assert.ok(Math.abs(d.socEnd - (4000 - 300 * 10) / 4000) < 1e-4, `soc ${d.socEnd}`);
  assert.equal(d.darkKm.toFixed(3), '10.000');
  assert.ok(Math.abs(d.arriveMs - (T0 + 10 * 3600e3)) < 1);
});

test('a battery too small for a dark drive runs out, and says where', () => {
  const d = simulateDrive(line(100, 0.1), { mob: MOB, power: { batteryWh: 1000, loadW: 100, driveW: 200, reserve: 0 }, departMs: T0, sky: dark });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'empty');
  assert.ok(Math.abs(d.emptyAt.km - 1000 / 300) < 0.11, `empty at km ${d.emptyAt.km}`);   // 3.33 h at 1 km/h
});

test('in sunlight the panel tops the battery up and it never exceeds 100 %', () => {
  const d = simulateDrive(line(100, 0.1), { mob: MOB, power: { panelW: 600, loadW: 100, driveW: 200 }, departMs: T0, sky: sunAt(5) });
  assert.ok(d.ok);
  assert.equal(d.socEnd, 1);
  assert.equal(d.darkKm, 0);
  assert.ok(Math.abs(panelW(cleanPower({ panelW: 600 }), sunAt(5)()) - 600 * Math.cos((5 * Math.PI) / 180)) < 1e-9);
});

test('climbing costs m·g·v·sin θ / efficiency on top of the flat drive power', () => {
  const p = cleanPower({ massKg: 500, climbEff: 0.5, loadW: 0, driveW: 0 });
  const tan10 = Math.tan((10 * Math.PI) / 180);
  const want = (500 * G_MOON * (1 / 3.6) * Math.sin((10 * Math.PI) / 180)) / 0.5;
  assert.ok(Math.abs(drivePowerW(p, tan10, 1) - want) < 1e-9);
  assert.equal(drivePowerW(p, -tan10, 1), 0);   // no regeneration downhill
  const up = simulateDrive(line(50, 0.1, tan10), { mob: MOB, power: { batteryWh: 4000, reserve: 0 }, departMs: T0, sky: dark });
  const flat = simulateDrive(line(50, 0.1, 0), { mob: MOB, power: { batteryWh: 4000, reserve: 0 }, departMs: T0, sky: dark });
  assert.ok(up.socEnd < flat.socEnd, 'uphill drains more');
  assert.ok(up.driveH > flat.driveH, 'and is slower');
});

test('below the reserve it parks until the Sun recharges it, then drives on', () => {
  // dark for the first 30 h, lit after. 160 W while driving: the reserve (400 Wh) is reached after 10 h; parked,
  // 10 W for 20 h more of dark leaves 200 Wh (10 %); then the Sun charges it to 45 % and it drives on.
  const sky = (x, y, t) => (t < T0 + 30 * 3600e3 ? dark() : sunAt(5)());
  const d = simulateDrive(line(200, 0.1), { mob: MOB, power: { batteryWh: 2000, loadW: 10, driveW: 150, panelW: 500, reserve: 0.2, resumeMargin: 0.25 }, departMs: T0, sky });
  assert.ok(d.ok, d.reason);
  assert.equal(d.stops.length, 1);
  assert.ok(d.waitH > 20 && d.stops[0].toMs >= T0 + 30 * 3600e3, `waited ${d.waitH} h until ${new Date(d.stops[0].toMs).toISOString()}`);
  assert.ok(Math.abs(d.socMin - 0.1) < 0.01, `lowest ${d.socMin}`);
  assert.ok(Math.abs(d.stops[0].km - 10) < 0.2, `parked at km ${d.stops[0].km}`);
});

test('a dark that lasts longer than the battery: it parks, then runs out while waiting', () => {
  const d = simulateDrive(line(200, 0.1), { mob: MOB, power: { batteryWh: 1000, loadW: 50, driveW: 150, reserve: 0.2 }, departMs: T0, sky: dark });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'empty');
  assert.equal(d.stops.length, 1);
});

test('outside the ephemeris the drive is not simulated', () => {
  const d = simulateDrive(line(10, 0.1), { mob: MOB, power: {}, departMs: T0, sky: () => null });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'ephemeris');
});

test('cleanPower fills defaults and clamps', () => {
  assert.deepEqual(cleanPower({}), { ...POWER_DEFAULTS });
  assert.equal(cleanPower({ reserve: 2 }).reserve, 0.9);
  assert.equal(cleanPower({ panelW: 'x' }).panelW, POWER_DEFAULTS.panelW);
});

// ---------- real route, real Sun ----------
const DATA = new URL('../demo/data/', import.meta.url);
const real = ['dem_240m.bin', 'terrain.json', 'horizon_grid.bin', 'ephemeris.json', 'sites.json'].every((f) => existsSync(new URL(f, DATA)));

test('real route: Shackleton ridge to de Gerlache rim 2, leaving 13 Jan 2027, with the real skylines', { skip: !real && 'data not here' }, async () => {
  const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA)));
  const l = meta.levels.find((x) => x.name === 'dem_240m');
  const b = readFileSync(new URL(l.file, DATA));
  const dem = createDem({ data: new Int16Array(b.buffer, b.byteOffset, b.length / 2), size: l.size, kmPerPixel: l.kmPerPixel, dnToMeters: l.dnToMeters, halfKm: l.halfKm });
  const sites = JSON.parse(readFileSync(new URL('sites.json', DATA)));
  const at = (id) => { const s = sites.find((x) => x.id === id); return toXY(s.latDeg, s.lonDeg); };
  const plan = await planRoutes({ points: [at('shackleton'), at('de-gerlache-rim-2')], dem, maxSlopeDeg: 15, mobility: {} }, { yieldFn: () => Promise.resolve() });
  assert.ok(plan.ok, plan.error);
  const r = plan.routes.find((x) => x.id === 'short');
  const sum = r.profile.km.reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(sum - r.lengthKm) < 1e-3 * r.lengthKm, `profile ${sum} km vs route ${r.lengthKm} km`);
  const grid = createHeatGrid({ horizon: new Uint8Array(readFileSync(new URL('horizon_grid.bin', DATA))), ...meta.horizon });
  const eph = createEphemeris(JSON.parse(readFileSync(new URL('ephemeris.json', DATA))));
  const sky = skyFromGrid(grid, eph, bodyAzEl, fromXY);
  const d = simulateDrive(r.profile, { mob: plan.mobility, power: {}, departMs: Date.UTC(2027, 0, 13), sky });
  assert.ok(['empty', 'stuck', null].includes(d.reason));
  assert.ok(Math.abs(d.km - (d.ok ? r.lengthKm : d.emptyAt?.km ?? d.km)) < 1e-3 * r.lengthKm);
  assert.ok(d.darkKm >= 0 && d.darkKm <= d.km && d.earthKm <= d.km);
  assert.ok(d.series.km.length >= 2 && d.series.km.length <= 241);
  if (d.ok) assert.ok(d.driveH >= r.hours - 1e-6 && d.arriveMs > d.departMs);
});

test('scanDepartures: only departures that reach the end in a lit window work, and the best are a day apart', async () => {
  const { scanDepartures } = await import('../demo/src/route-energy.js');
  // lit only between day 3 and day 5; a 10 h dark drive empties the 1000 Wh battery
  const sky = (x, y, t) => (t >= T0 + 3 * 86400e3 && t < T0 + 5 * 86400e3 ? sunAt(10)() : dark());
  const scan = scanDepartures(line(100, 0.1), { mob: MOB, power: { batteryWh: 1000, loadW: 100, driveW: 200, panelW: 600, reserve: 0 }, sky, fromMs: T0, toMs: T0 + 7 * 86400e3, stepMs: 3 * 3600e3 });
  assert.equal(scan.tried, 57);
  assert.ok(scan.ok > 0 && scan.ok < scan.tried, `${scan.ok} of ${scan.tried}`);
  for (const b of scan.best) assert.ok(b.departMs >= T0 + 2 * 86400e3 && b.departMs < T0 + 5 * 86400e3, new Date(b.departMs).toISOString());
  for (let i = 1; i < scan.best.length; i++) assert.ok(scan.best[i].departMs - scan.best[i - 1].departMs >= 86400e3);
});
