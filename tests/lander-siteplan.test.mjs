// Lander track: choosing where to land. The landing ellipse, the terrain inside it, Sun and Earth above the
// skyline over the stay, the battery, the grades and the verdict, the search grid ranked with the navigator's
// suitability score, and typed coordinates; plus real ephemeris and LOLA skyline at Shackleton.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ELLIPSE, ellipsePoints, terrainStats, planeRms, skyDirections, skyStats, batteryHours, grade, figures, verdict, searchGrid, suitability, bestPoints, landableClass } from '../demo/src/lander/siteplan.js';
import { parseLatLon } from '../demo/src/lander/planner.js';
import { scoreCells } from '../demo/src/score.js';
import { mapScale } from '../demo/src/lander/landing.js';
import { VEHICLE_DEFAULTS, cleanVehicle } from '../demo/src/lander/vehicle.js';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { createDem, skylineFor, toXY } from '../demo/src/terrain.js';

const demo = new URL('../demo/', import.meta.url).pathname;
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('siteplan: the 3σ ellipse is 150 m down-range (radial on the polar map) by 100 m cross-range', () => {
  const [x, y] = toXY(-85, 30);
  const pts = ellipsePoints(x, y, { stepM: 5 });
  close(pts.length, (Math.PI * ELLIPSE.downrangeM * ELLIPSE.crossrangeM) / 25, 60, 'point count ≈ area / step²');
  const r = Math.hypot(x, y), u = [x / r, y / r], v = [-u[1], u[0]], k = mapScale(-85);   // map km per ground km
  let maxU = 0, maxV = 0;
  for (const [px, py] of pts) {
    const du = (((px - x) * u[0] + (py - y) * u[1]) * 1000) / k, dv = (((px - x) * v[0] + (py - y) * v[1]) * 1000) / k;
    assert.ok((du * du) / 150 ** 2 + (dv * dv) / 100 ** 2 <= 1 + 1e-9);
    maxU = Math.max(maxU, Math.abs(du)); maxV = Math.max(maxV, Math.abs(dv));
  }
  close(maxU, 150, 5, 'down-range half-axis'); close(maxV, 100, 5, 'cross-range half-axis');
});

test('siteplan: terrain in the ellipse — share over the slope limit, mean slope, roughness about the plane', () => {
  const [x, y] = toXY(-85, 30);
  const pts = ellipsePoints(x, y, { stepM: 10 });
  const flat = terrainStats(() => 500, pts, { baselineKm: 0.02, limitDeg: 10 });
  assert.equal(flat.overLimit, 0); close(flat.meanDeg, 0, 1e-9, 'flat'); close(flat.roughM, 0, 1e-9, 'flat rough');
  const t15 = Math.tan(15 * Math.PI / 180);
  const tilt = terrainStats((px) => px * 1000 * t15, pts, { baselineKm: 0.02, limitDeg: 10 });
  assert.equal(tilt.overLimit, 1); close(tilt.meanDeg, 15, 0.01, 'tilted 15°'); close(tilt.roughM, 0, 1e-6, 'a plane is not rough');
  // ±1 m checkerboard on a plane: 1 m RMS about the plane
  close(planeRms([[0, 0, 1], [1, 0, -1], [0, 1, -1], [1, 1, 1], [2, 0, 1], [2, 1, -1], [0, 2, 1], [1, 2, -1], [2, 2, 1]]), 0.94, 0.1, 'checkerboard');
  assert.ok(Number.isNaN(terrainStats(() => NaN, pts).overLimit), 'no data');
});

test('siteplan: Sun and Earth over the stay, longest spells, and the battery', () => {
  // synthetic sky: Sun and Earth straight overhead at the pole for 10 h, then Sun below the horizon for 6 h
  const up = [0, 0, -1], down = [0, 0, 1];
  const dirs = [...Array(10).fill({ sun: up, earth: up, earthRangeKm: 384400 }), ...Array(6).fill({ sun: down, earth: up, earthRangeKm: 384400 })];
  const s = skyStats(dirs, { latDeg: -90, lonDeg: 0 }, 0, 1);
  close(s.sun, 10 / 16, 1e-12, 'sun share'); close(s.earth, 1, 1e-12, 'earth share');
  assert.equal(s.longestDarkH, 6); assert.equal(s.hours, 16);
  const blocked = skyStats(dirs, { latDeg: -90, lonDeg: 0 }, () => 95, 1);
  assert.equal(blocked.sun, 0); assert.equal(blocked.longestDarkH, 16);
  close(batteryHours(cleanVehicle({ ...VEHICLE_DEFAULTS })), (3000 * 0.8) / 220, 1e-9, 'battery hours');
});

test('siteplan: grades, figures and the verdict', () => {
  assert.equal(grade(0.03, { pass: 0.05, near: 0.15 }), 'pass');
  assert.equal(grade(0.1, { pass: 0.05, near: 0.15 }), 'near');
  assert.equal(grade(0.5, { pass: 0.05, near: 0.15 }), 'fail');
  assert.equal(grade(0.8, { pass: 0.7, near: 0.4, higher: true }), 'pass');
  assert.equal(grade(NaN, { pass: 1, near: 2 }), 'fail');
  const base = { t: { overLimit: 0.02, meanDeg: 4, p95Deg: 8, roughM: 0.6 }, sky: { sun: 0.9, earth: 0.8, longestDarkH: 3, hours: 168 }, psrShare: 0, budget: { marginMs: 240, propellantLeftKg: 80 }, earthAtLanding: true, battH: 10.9, limitDeg: 10, resKm: 0.005, stayDays: 7 };
  let f = figures(base);
  assert.deepEqual(f.map((x) => x.id), ['slope', 'rough', 'psr', 'sun', 'dark', 'earth', 'comms', 'dv']);
  assert.ok(f.every((x) => x.grade === 'pass'));
  assert.equal(verdict(f).grade, 'pass');
  // at 120 m the ellipse roughness is not resolved: caution, not failure
  f = figures({ ...base, resKm: 0.12 });
  assert.equal(f.find((x) => x.id === 'rough').grade, 'near');
  assert.equal(verdict(f).grade, 'near');
  f = figures({ ...base, sky: { ...base.sky, longestDarkH: 30 }, budget: { marginMs: -20, propellantLeftKg: 0 } });
  const v = verdict(f);
  assert.equal(v.grade, 'fail');
  assert.ok(v.text.includes('longest dark spell') && v.text.includes('δv margin'.replace('δ', 'Δ').toLowerCase()), v.text);
});

test('siteplan: search grid, navigator suitability, and the best spots spaced apart', () => {
  const [x, y] = toXY(-86, 10);
  const g = searchGrid(x, y, { radiusKm: 3, stepKm: 1 });
  assert.equal(g.length, 49);
  const c = g.find((p) => p.i === 0 && p.j === 0);
  close(c.latDeg, -86, 1e-9, 'centre lat'); close(c.lonDeg, 10, 1e-9, 'centre lon');
  // suitability is score.js scoreCells; hard limits fail cells
  const pts = [
    { xKm: 0, yKm: 0, sun: 1, earth: 1, slopeDeg: 2, shadowKm: 5, darkH: 0 },
    { xKm: 1, yKm: 0, sun: 1, earth: 1, slopeDeg: 15, shadowKm: 5, darkH: 0 },     // too steep
    { xKm: 3, yKm: 0, sun: 0.9, earth: 0.7, slopeDeg: 4, shadowKm: 20, darkH: 4 },
    { xKm: 0.5, yKm: 0.5, sun: 0.95, earth: 1, slopeDeg: 3, shadowKm: 5, darkH: 30 }, // dark too long
    { xKm: 6, yKm: 0, sun: 0.5, earth: 0.5, slopeDeg: 1, shadowKm: 0, darkH: 0 },    // permanent shadow
  ];
  const s = suitability(pts, { limitDeg: 10, battH: 10.9 });
  const ref = scoreCells({ sun: Float32Array.from(pts, (p) => p.sun), earth: Float32Array.from(pts, (p) => p.earth), slope: Float32Array.from(pts, (p) => p.slopeDeg), shadowKm: Float32Array.from(pts, (p) => p.shadowKm), count: pts.length });
  s.forEach((q, k) => close(q.score, ref[k], 1e-6, `score ${k}`));
  assert.deepEqual(s.map((q) => q.ok), [true, false, true, false, false]);
  const best = bestPoints(pts.map((p, k) => ({ ...p, ...s[k] })), { count: 5, minKm: 2 });
  assert.deepEqual(best.map((p) => p.xKm), [0, 3], 'only passing points, best first, ≥ 2 km apart');
  assert.deepEqual(bestPoints(pts.map((p, k) => ({ ...p, ...s[k] })), { minKm: 2, avoid: [{ xKm: 0, yKm: 0 }] }).map((p) => p.xKm), [3]);
});

test('siteplan: typed coordinates', () => {
  assert.deepEqual(parseLatLon('85.4S 35.3E'), { latDeg: -85.4, lonDeg: 35.3 });
  assert.deepEqual(parseLatLon('-85.4, 35.3'), { latDeg: -85.4, lonDeg: 35.3 });
  assert.deepEqual(parseLatLon('89.45 S, 137.31 W'), { latDeg: -89.45, lonDeg: 360 - 137.31 });
  assert.deepEqual(parseLatLon('-88.5;-66.7'), { latDeg: -88.5, lonDeg: 360 - 66.7 });
  assert.equal(parseLatLon('somewhere'), null);
  assert.equal(parseLatLon('95, 10'), null);
});

test('siteplan: real sky at Shackleton (ephemeris + LOLA skyline): the ridge is lit, the crater floor is not', () => {
  const eph = createEphemeris(JSON.parse(readFileSync(`${demo}data/ephemeris.json`, 'utf8')));
  const meta = JSON.parse(readFileSync(`${demo}data/terrain.json`, 'utf8')).dem;
  const text = readFileSync(`${demo}data/js/dem_480m.js`, 'utf8');
  const i0 = text.indexOf(',"') + 2, bytes = new Uint8Array(Buffer.from(text.slice(i0, text.indexOf('"', i0)), 'base64'));
  const dem = createDem({ data: new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1), size: meta.size, kmPerPixel: meta.kmPerPixel, dnToMeters: meta.dnToMeters });
  const dirs = skyDirections(eph, Date.parse('2027-01-10T02:00:00Z'), 7, 1);
  assert.equal(dirs.length, 168);
  const ridge = { latDeg: -89.45, lonDeg: 222.69 }, floor = { latDeg: -89.67, lonDeg: 129.78 };
  const r = skyStats(dirs, ridge, skylineFor(dem, ridge), 1), f = skyStats(dirs, floor, skylineFor(dem, floor), 1);
  assert.ok(r.sun > 0.8 && r.longestDarkH < 12, `ridge ${JSON.stringify(r)}`);
  assert.ok(f.sun < 0.05, `crater floor ${JSON.stringify(f)}`);
});

test('siteplan: where landing is possible — landable, possible (near a limit), or not', () => {
  const lim = { limitDeg: 10, battH: 10.9 };
  const good = { sun: 0.9, earth: 0.8, darkH: 4, slopeDeg: 3, shadowKm: 12, marginMs: 240 };
  assert.equal(landableClass(good, lim), 2);
  assert.equal(landableClass({ ...good, sun: 0.5 }, lim), 1, 'Sun 50 %: near');
  assert.equal(landableClass({ ...good, earth: 0.3 }, lim), 1, 'Earth 30 %: near');
  assert.equal(landableClass({ ...good, darkH: 14 }, lim), 1, 'dark 14 h of a 10.9 h battery: near');
  assert.equal(landableClass({ ...good, darkH: 20 }, lim), 0, 'dark 20 h: not');
  assert.equal(landableClass({ ...good, sun: 0.2 }, lim), 0);
  assert.equal(landableClass({ ...good, slopeDeg: 12 }, lim), 0, 'too steep');
  assert.equal(landableClass({ ...good, shadowKm: 0 }, lim), 0, 'permanent shadow in the cell');
  assert.equal(landableClass({ ...good, marginMs: -5 }, lim), 0, 'not reachable');
  assert.equal(landableClass({ ...good, slopeDeg: NaN }, lim), 0, 'no data is not landable');
});

test('siteplan: a figure that could not be computed is shown and graded near, not left out (audit L7)', () => {
  const base = { t: { overLimit: 0.02, meanDeg: 4, p95Deg: 8, roughM: 0.6 }, sky: { sun: 0.9, earth: 0.8, longestDarkH: 3, hours: 168 }, psrShare: 0, battH: 10.9, limitDeg: 10, resKm: 0.005, stayDays: 7 };
  const f = figures({ ...base, budget: null, earthAtLanding: null });
  assert.deepEqual(f.map((x) => x.id), ['slope', 'rough', 'psr', 'sun', 'dark', 'earth', 'comms', 'dv']);
  for (const id of ['comms', 'dv']) { const x = f.find((q) => q.id === id); assert.equal(x.grade, 'near'); assert.equal(x.text, 'not computed'); }
  assert.equal(verdict(f).grade, 'near', 'not "every figure passes"');
});

test('siteplan: best spots by another distance, and the nearest misses by another order', () => {
  const pts = [
    { name: 'a', xKm: 0, yKm: 0, score: 0.9, ok: true, darkH: 0 },
    { name: 'b', xKm: 0, yKm: 1, score: 0.8, ok: true, darkH: 0 },
    { name: 'c', xKm: 5, yKm: 0, score: 0.7, ok: false, darkH: 30 },
    { name: 'd', xKm: 9, yKm: 0, score: 0.6, ok: false, darkH: 20 },
  ];
  // map km: b is 1 km from a; a distance that stretches y tenfold keeps it
  assert.deepEqual(bestPoints(pts, { minKm: 2 }).map((p) => p.name), ['a']);
  assert.deepEqual(bestPoints(pts, { minKm: 2, dist: (q, p) => Math.hypot(q.xKm - p.xKm, 10 * (q.yKm - p.yKm)) }).map((p) => p.name), ['a', 'b']);
  // failing points, shortest dark spell first
  assert.deepEqual(bestPoints(pts, { minKm: 2, pass: (p) => !p.ok, by: (p, q) => p.darkH - q.darkH }).map((p) => p.name), ['d', 'c']);
  assert.deepEqual(bestPoints(pts, { count: 0 }), []);
});
