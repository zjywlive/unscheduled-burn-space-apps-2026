// Phase 4 R: route planning (demo/src/route-plan.js), the card's pure helpers (ui/routeplan.js) and the
// map layer's path helpers (map/routes-layer.js). Synthetic terrain for the rules, the real 240 m DEM for
// the behaviour on known places.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { planRoutes, slopeAt, simplify, sunFromJobs, toPoint, corridorPadKm, CANDIDATES, DEFAULT_MAX_SLOPE, MAX_LEG_KM } from '../demo/src/route-plan.js';
import { createDem, toXY, fromXY } from '../demo/src/terrain.js';
import { readRows, rowsFromPoints, routeFigures, routeSentence, planMatches, rowTag, coordText } from '../demo/src/ui/routeplan.js';
import { routePathD, midpoint } from '../demo/src/map/routes-layer.js';

const KPP = 0.24, SIZE = 240, HALF = (SIZE * KPP) / 2;   // ±28.8 km around the pole
const xOf = (c) => -HALF + (c + 0.5) * KPP, yOf = (r) => HALF - (r + 0.5) * KPP;

// a synthetic DEM from height(x, y) in metres (stored as DN = m / 0.5)
function demFrom(height) {
  const data = new Int16Array(SIZE * SIZE);
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) data[r * SIZE + c] = Math.round(height(xOf(c), yOf(r)) / 0.5);
  return createDem({ data, size: SIZE, kmPerPixel: KPP, dnToMeters: 0.5, halfKm: HALF });
}
const flatDem = demFrom(() => 0);
const polyLen = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
const byId = (plan, id) => plan.routes.find((r) => r.id === id);
const fast = { yieldFn: () => Promise.resolve() };

test('route-plan: on flat ground all three are the straight line, figures exact, repeats marked', async () => {
  const plan = await planRoutes({ points: [[-15, -3], [15, 4]], dem: flatDem, sunAt: () => 0.5, isPsr: () => false, maxSlopeDeg: 10 }, fast);
  assert.equal(plan.ok, true);
  assert.equal(plan.blocked, null);
  assert.deepEqual(plan.routes.map((r) => r.id), ['short', 'flat', 'sunny']);
  const straight = Math.hypot(30, 7);
  const s = byId(plan, 'short');
  // ground length = map length / scale factor (≤ 1.0001 this close to the pole)
  assert.ok(Math.abs(s.lengthKm - straight) < 0.01 * straight, `length ${s.lengthKm} vs ${straight}`);
  assert.equal(s.maxSlopeDeg, 0);
  assert.equal(s.meanSlopeDeg, 0);
  assert.ok(Math.abs(s.sunShare - 0.5) < 1e-6);
  assert.equal(s.sunKnown, 1);
  assert.equal(s.psrKm, 0);
  // the any-angle smoothing leaves the straight line: start and end only
  assert.equal(s.points.length, 2);
  assert.deepEqual(s.points[0], [-15, -3]);
  assert.deepEqual(s.points[1], [15, 4]);
  assert.equal(byId(plan, 'flat').sameAs, 'short');
  assert.equal(byId(plan, 'sunny').sameAs, 'short');
  assert.equal(plan.baselineKm, KPP);
  assert.equal(plan.limitDeg, 10);
});

test('route-plan: slope is the scale-corrected central difference (as tools/build-static.mjs)', () => {
  // a plane rising 5 m per 240 m pixel (20.83 m per map km) eastward; far from the pole the map km is longer than a ground km
  const R = 1737.4;
  const dem = createDem({ data: new Int16Array(2700 * 2700).map((_, i) => (i % 2700) * 10), size: 2700, kmPerPixel: 0.24, dnToMeters: 0.5, halfKm: 324 });
  for (const [x, y] of [[0.12, 0.12], [200.04, -100.08]]) {
    const scale = 1 + (x * x + y * y) / (4 * R * R);
    const expected = Math.atan((5 / 240) * scale) * 180 / Math.PI;
    assert.ok(Math.abs(slopeAt(dem, x, y) - expected) < 1e-3, `${slopeAt(dem, x, y)} vs ${expected}`);
  }
  assert.equal(slopeAt(dem, 400, 0), null);
});

// a north–south wall 400 m high across x = 0, with a gentle ramp (gap) at y ≈ 18 km
function wallDem({ gapSlopeDeg = 4 } = {}) {
  return demFrom((x, y) => {
    const wall = Math.max(0, 1 - Math.abs(x) / 1.0) * 400;        // ~22° flanks
    const gap = Math.exp(-((y - 18) ** 2) / (2 * 1.5 ** 2));        // a pass 3 km wide
    const pass = Math.min(wall, Math.abs(x) * 1000 * Math.tan(gapSlopeDeg * Math.PI / 180));
    return wall * (1 - gap) + pass * gap;
  });
}

test('route-plan: the slope limit forces the detour through the pass; flat never exceeds short', async () => {
  const dem = wallDem();
  const plan = await planRoutes({ points: [[-10, 0], [10, 0]], dem, maxSlopeDeg: 12 }, fast);
  assert.equal(plan.ok, true, plan.error ?? JSON.stringify(plan.blocked));
  const s = byId(plan, 'short'), f = byId(plan, 'flat');
  assert.ok(s.maxSlopeDeg <= 12 + 1e-6);
  assert.ok(f.maxSlopeDeg <= s.maxSlopeDeg + 1e-6);
  assert.ok(s.lengthKm > 30, `goes round by the pass: ${s.lengthKm}`);
  // every vertex of the short route that crosses x = 0 does so near the pass
  for (let i = 1; i < s.points.length; i++) {
    const [ax, ay] = s.points[i - 1], [bx, by] = s.points[i];
    if (ax * bx < 0) assert.ok(Math.abs((ay + by) / 2 - 18) < 3, `crossing at y ${(ay + by) / 2}`);
  }
  assert.equal(byId(plan, 'sunny').unavailable, 'Needs the sunlight figures of the planned stay.');
  assert.equal(byId(plan, 'sunny').points, null);
});

test('route-plan: blocked limit answers honestly, and the answered limit then plans', async () => {
  const dem = wallDem({ gapSlopeDeg: 9 });
  const blocked = await planRoutes({ points: [[-10, 0], [10, 0]], dem, maxSlopeDeg: 6 }, fast);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.routes.length, 0);
  assert.equal(blocked.error, null);
  assert.equal(blocked.blocked.limitDeg, 6);
  assert.equal(blocked.blocked.leg, 0);
  assert.ok(blocked.blocked.neededDeg > 6);
  assert.equal(blocked.blocked.passesAtDeg, Math.ceil(blocked.blocked.neededDeg - 1e-6));
  assert.ok(blocked.blocked.passesAtDeg >= 9 && blocked.blocked.passesAtDeg <= 12, `passes at ${blocked.blocked.passesAtDeg}`);
  const again = await planRoutes({ points: [[-10, 0], [10, 0]], dem, maxSlopeDeg: blocked.blocked.passesAtDeg }, fast);
  assert.equal(again.ok, true);
  assert.ok(byId(again, 'short').maxSlopeDeg <= blocked.blocked.passesAtDeg + 1e-6);
  // one degree less is still blocked: the answer is the least whole degree
  const less = await planRoutes({ points: [[-10, 0], [10, 0]], dem, maxSlopeDeg: blocked.blocked.passesAtDeg - 1 }, fast);
  assert.equal(less.ok, false);
});

test('route-plan: a hill in the way: flat goes round it with a lower max and mean slope', async () => {
  const dem = demFrom((x, y) => 700 * Math.exp(-(x * x + y * y) / (2 * 4 ** 2)));   // peak ~10° flanks
  const plan = await planRoutes({ points: [[-14, 0.5], [14, -0.5]], dem, maxSlopeDeg: 25 }, fast);
  const s = byId(plan, 'short'), f = byId(plan, 'flat');
  assert.ok(f.maxSlopeDeg < s.maxSlopeDeg - 3, `flat ${f.maxSlopeDeg} vs short ${s.maxSlopeDeg}`);
  assert.ok(f.meanSlopeDeg < s.meanSlopeDeg);
  assert.ok(f.lengthKm > s.lengthKm);
  assert.ok(s.lengthKm < 28 * 1.03);
});

test('route-plan: sunny takes the lit detour; stats are length-weighted; PSR km counted', async () => {
  // lit only in a band 6–10 km north of the straight line
  const sunAt = (x, y) => (y > 6 && y < 10 ? 1 : 0);
  const isPsr = (x, y) => x > -2 && x < 2 && y < 3;            // a 4 km wide shadowed strip across the direct line
  const plan = await planRoutes({ points: [[-12, 0], [12, 0]], dem: flatDem, sunAt, isPsr, maxSlopeDeg: 15 }, fast);
  const s = byId(plan, 'short'), sun = byId(plan, 'sunny');
  assert.ok(sun.sunShare > s.sunShare + 0.3, `sunny ${sun.sunShare} vs short ${s.sunShare}`);
  assert.equal(s.sunShare, 0);
  assert.ok(Math.abs(s.psrKm - 4) < 0.15, `psr ${s.psrKm}`);
  assert.equal(sun.psrKm, 0);
  // sunShare is the lit length over the length
  assert.ok(sun.sunShare > 0 && sun.sunShare < 1);
});

test('route-plan: statistics come from the unsimplified path', async () => {
  const dem = demFrom((x, y) => 300 * Math.sin(x / 3) * Math.cos(y / 4));
  const plan = await planRoutes({ points: [[-20, -10], [18, 12]], dem, maxSlopeDeg: 20 }, fast);
  assert.equal(plan.ok, true);
  for (const r of plan.routes.filter((q) => q.points)) {
    // the drawn polyline is never longer than the measured route (simplification only cuts corners)
    assert.ok(polyLen(r.points) <= r.lengthKm * 1.001 + 1e-9, `${r.id}: ${polyLen(r.points)} vs ${r.lengthKm}`);
    assert.ok(r.maxSlopeDeg <= 20 + 1e-6);
    assert.ok(r.meanSlopeDeg <= r.maxSlopeDeg);
  }
});

test('route-plan: waypoints in order, legs joined, the route passes each waypoint', async () => {
  const pts = [[-15, -15], [10, -12], [12, 14], [-14, 10]];
  const plan = await planRoutes({ points: pts, dem: flatDem, maxSlopeDeg: 10 }, fast);
  assert.equal(plan.ok, true);
  const s = byId(plan, 'short');
  for (const w of pts) assert.ok(s.points.some((p) => Math.hypot(p[0] - w[0], p[1] - w[1]) < 1e-9), `passes ${w}`);
  const legs = pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
  assert.ok(Math.abs(s.lengthKm - legs) < 0.01 * legs);
  // repeated points are merged, lat/lon objects accepted
  const ll = fromXY(-15, -15);
  const again = await planRoutes({ points: [ll, [-15, -15], [10, -12]], dem: flatDem, maxSlopeDeg: 10 }, fast);
  assert.equal(again.waypoints.length, 2);
});

test('route-plan: input errors are sentences, not exceptions', async () => {
  assert.match((await planRoutes({ points: [[0, 0]], dem: flatDem })).error, /start and an end/);
  assert.match((await planRoutes({ points: [[0, 0], [100, 0]], dem: flatDem })).error, /outside the terrain/);
  assert.match((await planRoutes({ points: [[0, 0], [5, 0]], dem: null })).error, /not loaded/);
  assert.match((await planRoutes({ points: [[0, 0], [5, 0]], dem: flatDem, maxSlopeDeg: 0 })).error, /slope limit/);
  assert.match((await planRoutes({ points: Array.from({ length: 9 }, (_, i) => [i, 0]), dem: flatDem })).error, /at most 8/);
  const big = { ...flatDem, halfKm: 324, size: 2700, heightAtXY: () => 0, grid: undefined };
  assert.match((await planRoutes({ points: [[-100, 0], [100, 0]], dem: big })).error, new RegExp(`at most ${MAX_LEG_KM} km`));
  assert.equal(DEFAULT_MAX_SLOPE, 15);
  assert.deepEqual(CANDIDATES.map((c) => c.label), ['Shortest', 'Flattest', 'Sunniest']);
  assert.equal(corridorPadKm(4), 8);
  assert.equal(corridorPadKm(50), 25);
  assert.equal(corridorPadKm(200), 40);
});

test('route-plan: runs in slices with progress and stops on abort', async () => {
  let yields = 0;
  const fractions = [];
  const plan = await planRoutes({ points: [[-10, 0], [10, 0]], dem: wallDem(), maxSlopeDeg: 12 },
    { sliceMs: 0, yieldFn: () => { yields++; return Promise.resolve(); }, onProgress: (f) => fractions.push(f) });
  assert.equal(plan.ok, true);
  assert.ok(yields > 3, `yielded ${yields} times`);
  assert.equal(fractions[fractions.length - 1], 1);
  for (let i = 1; i < fractions.length; i++) assert.ok(fractions[i] >= fractions[i - 1]);

  const ac = new AbortController();
  let n = 0;
  await assert.rejects(planRoutes({ points: [[-25, -25], [25, 25]], dem: flatDem, maxSlopeDeg: 10 },
    { sliceMs: 0, signal: ac.signal, yieldFn: () => { if (++n === 2) ac.abort(); return Promise.resolve(); } }), { name: 'AbortError' });
  const pre = new AbortController(); pre.abort();
  await assert.rejects(planRoutes({ points: [[0, 0], [5, 5]], dem: flatDem }, { signal: pre.signal }), { name: 'AbortError' });
});

test('route-plan: default yield keeps the event loop turning', async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  await planRoutes({ points: [[-25, -25], [25, 25]], dem: wallDem(), maxSlopeDeg: 12 }, { sliceMs: 1 });
  clearInterval(timer);
  assert.ok(ticks > 0);
});

test('route-plan: helpers: simplify, toPoint, sunFromJobs', () => {
  const line = [[0, 0], [1, 0.01], [2, 0], [3, 1], [4, 0]];
  assert.deepEqual(simplify(line, 0.05), [[0, 0], [2, 0], [3, 1], [4, 0]]);
  assert.deepEqual(simplify([[0, 0], [1, 1]], 1), [[0, 0], [1, 1]]);
  assert.deepEqual(toPoint([1, 2]), [1, 2]);
  assert.deepEqual(toPoint({ xKm: 3, yKm: 4 }), [3, 4]);
  const [x, y] = toPoint({ latDeg: -89, lonDeg: 90 });
  assert.ok(Math.abs(y) < 1e-9 && x > 30);
  assert.equal(toPoint({}), null);
  // a 4 × 4 grid of 1 km cells, a job that has done rows 0–1 of rect i 1–2, j 0–3
  const grid = { size: 4, cellAt: (x, y) => { const i = Math.floor(x + 2), j = Math.floor(2 - y); return i >= 0 && j >= 0 && i < 4 && j < 4 ? j * 4 + i : null; } };
  const job = { sun: new Float32Array(16).fill(0.7), rect: { i0: 1, j0: 0, i1: 2, j1: 3 }, rows: 2, done: false, mask: null };
  const coarse = { size: 4, cellAt: grid.cellAt };
  const coarseJob = { sun: new Float32Array(16).fill(0.2), done: true };
  const at = sunFromJobs([{ grid, job }, { grid: coarse, job: coarseJob }]);
  assert.ok(Math.abs(at(-0.5, 1.5) - 0.7) < 1e-6);        // i 1, j 0: done in the fine job
  assert.ok(Math.abs(at(-0.5, -1.5) - 0.2) < 1e-6);       // j 3: not done yet → the coarse job
  assert.ok(Math.abs(at(-1.5, 1.5) - 0.2) < 1e-6);        // i 0: outside the fine rect
  assert.ok(Number.isNaN(at(10, 10)));
  assert.ok(Number.isNaN(sunFromJobs([])(0, 0)));
});

test('route plan card helpers: rows ↔ points, validation, figures', () => {
  const pts = [toXY(-89.45, 222.69), toXY(-88.5, 293.3)];
  const rows = rowsFromPoints(pts);
  assert.deepEqual(rows, [{ lat: '−89.450', lon: '222.690' }, { lat: '−88.500', lon: '293.300' }]);
  const back = readRows(rows);
  assert.equal(back.errors.length, 0);
  back.points.forEach((p, i) => assert.ok(Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]) < 0.02));
  const bad = readRows([{ lat: '-70', lon: '10' }, { lat: 'x', lon: '5' }, { lat: '-85', lon: '400' }, { lat: '-85,5', lon: '-20' }]);
  assert.deepEqual(bad.errors.map((e) => [e.index, e.field]), [[0, 'lat'], [1, 'lat'], [2, 'lon']]);
  assert.match(bad.errors[0].message, /south of 80°S/);
  assert.equal(bad.points.length, 1);                         // −85.5, −20 (comma decimal, west longitude) is fine
  assert.equal(rowTag(0, 3), 'Start'); assert.equal(rowTag(1, 3), 'Via 1'); assert.equal(rowTag(2, 3), 'End');
  assert.equal(coordText(-0.0004), '−0.000');
  assert.equal(coordText(NaN), '');
  const r = { id: 'short', label: 'Shortest', lengthKm: 48.53, maxSlopeDeg: 14.95, meanSlopeDeg: 8.96, sunShare: 0.4, psrKm: 0.48, sameAs: null };
  assert.deepEqual(routeFigures(r), { length: '48.5', max: '15.0°', mean: '9.0°', sun: '40%', psr: '0.5' });
  assert.equal(routeFigures({ ...r, lengthKm: 188.7, psrKm: 0.01, sunShare: null }).length, '189');
  assert.equal(routeFigures({ ...r, psrKm: 0.01 }).psr, '<0.1');
  assert.equal(routeFigures({ ...r, sunShare: null, psrKm: null }).sun, '—');
  assert.match(routeSentence({ ...r, sameAs: 'flat' }, { flat: 'Flattest' }), /^Shortest: 48\.5 km, max slope 15\.0°.*Same route as Flattest\.$/);
  const plan = { limitDeg: 15, waypoints: pts };
  assert.equal(planMatches(plan, pts.map((p) => [...p]), 15), true);
  assert.equal(planMatches(plan, pts, 16), false);
  assert.equal(planMatches(plan, [pts[0]], 15), false);
  assert.equal(planMatches(null, pts, 15), false);
});

test('routes layer helpers: path data and midpoint', () => {
  const P = (x, y) => [x * 10, -y * 10];
  assert.equal(routePathD([[0, 0], [0.01, 0], [1, 1], [2, 0]], P), 'M0 0L10 -10L20 0');
  const m = midpoint([[0, 0], [2, 0], [2, 2]], P);
  assert.deepEqual([m.x, m.y, m.dx, m.dy], [20, 0, 1, 0]);
});

// ---------- the real 240 m terrain ----------
const DATA = new URL('../demo/data/', import.meta.url);
const real = existsSync(new URL('dem_240m.bin', DATA)) && existsSync(new URL('terrain.json', DATA));
let realDem = null, realPsr = null, sites = null;
async function loadReal() {
  if (realDem) return;
  const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA)));
  const l = meta.levels.find((x) => x.name === 'dem_240m');
  const b = readFileSync(new URL(l.file, DATA));
  realDem = createDem({ data: new Int16Array(b.buffer, b.byteOffset, b.length / 2), size: l.size, kmPerPixel: l.kmPerPixel, dnToMeters: l.dnToMeters, halfKm: l.halfKm });
  if (existsSync(new URL('psr_120m.bin', DATA))) {
    const { createPsr } = await import('../demo/src/psr.js');
    realPsr = createPsr(new Uint8Array(readFileSync(new URL('psr_120m.bin', DATA))), meta.psr);
  }
  sites = JSON.parse(readFileSync(new URL('sites.json', DATA)));
}
const site = (id) => { const s = sites.find((x) => x.id === id); return toXY(s.latDeg, s.lonDeg); };
const SHACKLETON = toXY(-89.67, 129.78);   // crater centre, approx.

test('route-plan, real terrain: flat has a lower max slope than short on three trips', { skip: !real }, async () => {
  await loadReal();
  const around = (ang, km) => [SHACKLETON[0] + km * Math.cos(ang), SHACKLETON[1] + km * Math.sin(ang)];
  const trips = {
    'Shackleton ridge → de Gerlache Rim 2': [site('shackleton'), site('de-gerlache-rim-2')],
    'IM-2 Athena → Mons Mouton Plateau': [site('im2'), site('mons-mouton-plateau')],
    'across Shackleton': [around(0.3, 17), around(0.3 + Math.PI, 17)],
  };
  for (const [name, points] of Object.entries(trips)) {
    const plan = await planRoutes({ points, dem: realDem, isPsr: realPsr?.isPsr, maxSlopeDeg: 15 }, fast);
    assert.equal(plan.ok, true, `${name}: ${plan.error ?? JSON.stringify(plan.blocked)}`);
    const s = byId(plan, 'short'), f = byId(plan, 'flat');
    assert.ok(f.maxSlopeDeg < s.maxSlopeDeg - 1, `${name}: flat max ${f.maxSlopeDeg} vs short ${s.maxSlopeDeg}`);
    assert.ok(f.meanSlopeDeg < s.meanSlopeDeg, `${name}: mean`);
    assert.ok(s.maxSlopeDeg <= 15 + 1e-6 && f.maxSlopeDeg <= 15 + 1e-6);
    assert.ok(s.lengthKm <= f.lengthKm);
  }
});

test('route-plan, real terrain: the trip across Shackleton skirts the crater instead of crossing the wall', { skip: !real }, async () => {
  await loadReal();
  const a = [SHACKLETON[0] + 17 * Math.cos(0.3), SHACKLETON[1] + 17 * Math.sin(0.3)];
  const b = [SHACKLETON[0] - 17 * Math.cos(0.3), SHACKLETON[1] - 17 * Math.sin(0.3)];
  const plan = await planRoutes({ points: [a, b], dem: realDem, maxSlopeDeg: 15 }, fast);
  for (const r of plan.routes.filter((q) => q.points)) {
    // densify the drawn line; no point comes within 9 km of the crater centre (floor and walls, radius ~10.5 km)
    let closest = Infinity;
    for (let i = 1; i < r.points.length; i++) {
      const [ax, ay] = r.points[i - 1], [bx, by] = r.points[i];
      for (let t = 0; t <= 1; t += 0.02) closest = Math.min(closest, Math.hypot(ax + (bx - ax) * t - SHACKLETON[0], ay + (by - ay) * t - SHACKLETON[1]));
    }
    assert.ok(closest > 9, `${r.id}: ${closest.toFixed(1)} km from the centre`);
    assert.ok(r.lengthKm > 34 * 1.1, `${r.id} is a detour: ${r.lengthKm}`);
  }
  // with no limit to speak of, the short route dives across the crater
  const steep = await planRoutes({ points: [a, b], dem: realDem, maxSlopeDeg: 45 }, fast);
  assert.ok(byId(steep, 'short').lengthKm < byId(plan, 'short').lengthKm - 3);
});

test('route-plan, real terrain: sunny wins the Sun share when a synthetic Sun grid favours a detour', { skip: !real }, async () => {
  await loadReal();
  const a = site('shackleton'), b = site('de-gerlache-rim-2');
  // lit only on the right of the straight line from a to b, 3–12 km off it (the left band is mostly
  // steeper than 15°, see docs/phase4/handoff/R-shots/sunny-synthetic-left.png)
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  const sunAt = (x, y) => { const side = -(dx * (y - a[1]) - dy * (x - a[0])) / L; return side > 3 && side < 12 ? 1 : 0; };
  const plan = await planRoutes({ points: [a, b], dem: realDem, sunAt, maxSlopeDeg: 15 }, fast);
  const s = byId(plan, 'short'), sun = byId(plan, 'sunny');
  assert.ok(sun.sunShare > s.sunShare + 0.5, `sunny ${sun.sunShare} vs short ${s.sunShare}`);
  assert.ok(sun.maxSlopeDeg <= 15 + 1e-6);
  assert.equal(sun.sunKnown, 1);
});

test('route-plan, real terrain: a 100 km trip plans in a few seconds; a blocked limit says where it passes', { skip: !real }, async () => {
  await loadReal();
  const points = [toXY(-87.5, 0), toXY(-87.5, 90)];
  const t0 = performance.now();
  const plan = await planRoutes({ points, dem: realDem, isPsr: realPsr?.isPsr, sunAt: () => 0.5, maxSlopeDeg: 20 });
  const ms = performance.now() - t0;
  assert.equal(plan.ok, true);
  assert.ok(Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]) > 100);
  assert.ok(ms < 4000, `${ms.toFixed(0)} ms`);
  const blocked = await planRoutes({ points, dem: realDem, maxSlopeDeg: 15 }, fast);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blocked.passesAtDeg > 15);
  const at = await planRoutes({ points, dem: realDem, maxSlopeDeg: blocked.blocked.passesAtDeg }, fast);
  assert.equal(at.ok, true);
});

// ---------- fix R1: the labels stay true; fix R2: the Sun figures do not depend on the zoom ----------
import { pickByMetric, planSunLayers, SUNNY_WEIGHTS } from '../demo/src/route-plan.js';

test('route-plan fix R1: pickByMetric takes the best by each label\'s figure, its own on a tie', () => {
  const a = { lengthKm: 50, meanSlopeDeg: 9, sunShare: 0.2 }, b = { lengthKm: 60, meanSlopeDeg: 5, sunShare: 0.4 }, c = { lengthKm: 52, meanSlopeDeg: 9.5, sunShare: 0.3 };
  assert.equal(pickByMetric([a, b, c], 'short', 0), a);
  assert.equal(pickByMetric([a, b, c], 'flat', 1), b);
  assert.equal(pickByMetric([a, b, c], 'sunny', 2), b);                 // the flat route is sunnier than the sunny search's
  assert.equal(pickByMetric([a, { ...a }, c], 'short', 1).lengthKm, 50);
  const tie = { ...c, sunShare: 0.4 };
  assert.equal(pickByMetric([a, b, tie], 'sunny', 2), tie);              // a tie keeps its own
  assert.equal(pickByMetric([{ ...a, sunShare: null }, c], 'sunny', 0), c);
  assert.deepEqual([...SUNNY_WEIGHTS], [3, 10, 30]);
});

// the real Sun share of the walkthrough stay (landing 13 Jan 2027, 14 days) on the 2 km grid
const realSunReady = real && existsSync(new URL('horizon_grid.bin', DATA)) && existsSync(new URL('ephemeris.json', DATA));
let realSunAt = null;
async function loadRealSun() {
  if (realSunAt) return realSunAt;
  const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA)));
  const { createEphemeris } = await import('../demo/src/ephemeris.js');
  const { createHeatGrid, fractionJob } = await import('../demo/src/heat.js');
  const eph = createEphemeris(JSON.parse(readFileSync(new URL('ephemeris.json', DATA))));
  const grid = createHeatGrid({ horizon: new Uint8Array(readFileSync(new URL('horizon_grid.bin', DATA))), ...meta.horizon });
  const t0 = Date.UTC(2027, 0, 13);
  const job = fractionJob(grid, eph, t0, t0 + 14 * 86400e3);
  while (!job.run(1000));
  realSunAt = sunFromJobs([{ grid, job }]);
  return realSunAt;
}

test('route-plan fix R1, real terrain and Sun: Sunniest is the most sunlit, Flattest the least steep, Shortest the shortest', { skip: !realSunReady }, async () => {
  await loadReal();
  const sunAt = await loadRealSun();
  // the walkthrough route, and routes where the v4 Sunniest was less sunlit than Flattest or Shortest
  // (docs/phase4/handoff/fix-R.md: found by a random sweep of 105 plans, 28 of them broke the Sun rule)
  const trips = [
    { name: 'walkthrough 88.3°S → de Gerlache Rim 2 → Shackleton', points: [toXY(-88.3, 336.3), site('de-gerlache-rim-2'), site('shackleton')], lim: 20 },
    { name: 'sweep 1/30', points: [[65.05, -71.2], [29.42, -103.38], [-15.12, -80.76]], lim: 20 },
    { name: 'sweep 1/0', points: [[41.16, 27.88], [61.93, 55.09], [80.37, 46.29]], lim: 25 },
    { name: 'sweep 1/18', points: [[93.19, -55.06], [142.23, -82.02]], lim: 15 },
    { name: 'sweep 1/53', points: [[70.13, -43.32], [91.68, -27.77]], lim: 15 },
  ];
  for (const t of trips) {
    const plan = await planRoutes({ points: t.points, dem: realDem, sunAt, isPsr: realPsr?.isPsr, maxSlopeDeg: t.lim }, fast);
    assert.equal(plan.ok, true, `${t.name}: ${plan.error ?? JSON.stringify(plan.blocked)}`);
    const [s, f, u] = ['short', 'flat', 'sunny'].map((id) => byId(plan, id));
    const fig = plan.routes.map((r) => `${r.id} ${r.lengthKm.toFixed(1)} km ${r.meanSlopeDeg.toFixed(2)}° ${(r.sunShare * 100).toFixed(1)}%`).join(' | ');
    assert.ok(u.sunShare >= s.sunShare && u.sunShare >= f.sunShare, `${t.name} sun: ${fig}`);
    assert.ok(f.meanSlopeDeg <= s.meanSlopeDeg && f.meanSlopeDeg <= u.meanSlopeDeg, `${t.name} slope: ${fig}`);
    assert.ok(s.lengthKm <= f.lengthKm && s.lengthKm <= u.lengthKm, `${t.name} length: ${fig}`);
    for (const r of plan.routes) assert.ok(r.maxSlopeDeg <= t.lim + 1e-6, `${t.name} ${r.id} keeps the limit`);
    // a row that shows another search's route says so
    for (const r of plan.routes) if (r.takenFrom) assert.ok(r.sameAs, `${t.name} ${r.id} took ${r.takenFrom}'s route and says "Same route as"`);
  }
});

test('route-plan fix R2: a heat plan is sampled from its 2 km map job only, so the zoom does not change the figures', async () => {
  // the 2 km map job: lit 0.6 east of x = 0, 0.2 west; a 1 km viewport job that says 0.9 everywhere
  const coarse = { size: 8, cellAt: (x, y) => { const i = Math.floor((x + 16) / 4), j = Math.floor((16 - y) / 4); return i >= 0 && j >= 0 && i < 8 && j < 8 ? j * 8 + i : null; } };
  const full = { sun: Float32Array.from({ length: 64 }, (_, k) => (k % 8 >= 4 ? 0.6 : 0.2)), rect: { i0: 0, j0: 0, i1: 7, j1: 7 }, rows: 8, done: true, mask: null };
  const fine = { grid: { size: 32, cellAt: (x, y) => { const i = Math.floor(x + 16), j = Math.floor(16 - y); return i >= 0 && j >= 0 && i < 32 && j < 32 ? j * 32 + i : null; } } };
  const viewJob = { sun: new Float32Array(1024).fill(0.9), rect: { i0: 0, j0: 0, i1: 31, j1: 31 }, rows: 32, done: true, mask: null };
  const atZoom1 = { coarse: { grid: coarse }, full: { planned: full }, fine: null, viewJob: null };
  const atZoom9 = { ...atZoom1, fine, viewJob };
  const s1 = sunFromJobs(atZoom1), s9 = sunFromJobs(atZoom9);
  for (const [x, y] of [[-10, 3], [5, -7], [0.5, 0.5], [15, 15]]) assert.equal(s1(x, y), s9(x, y));
  assert.ok(Math.abs(s9(5, 5) - 0.6) < 1e-6);
  assert.equal(planSunLayers(atZoom9).length, 1);
  assert.deepEqual(planSunLayers({ coarse: { grid: coarse }, full: { planned: null } }), []);   // Now mode: no stay job
  const pts = [[-12, -6], [12, 7]];
  const p1 = await planRoutes({ points: pts, dem: flatDem, sunAt: s1, maxSlopeDeg: 10 }, fast);
  const p9 = await planRoutes({ points: pts, dem: flatDem, sunAt: s9, maxSlopeDeg: 10 }, fast);
  assert.deepEqual(p1.routes.map((r) => r.sunShare), p9.routes.map((r) => r.sunShare));
  assert.deepEqual(p1.routes.map((r) => r.lengthKm), p9.routes.map((r) => r.lengthKm));
});
