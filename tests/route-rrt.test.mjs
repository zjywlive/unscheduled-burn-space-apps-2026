// Self-driving planner (B-RRT*, demo/src/route-rrt.js) on synthetic terrains with known answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planSelfDriving, autonavPayload } from '../demo/src/route-rrt.js';
import { createDem } from '../demo/src/terrain.js';

const KPP = 0.24, SIZE = 200, HALF = (SIZE * KPP) / 2;   // ±24 km around the pole
const xOf = (c) => -HALF + (c + 0.5) * KPP, yOf = (r) => HALF - (r + 0.5) * KPP;
function demFrom(fn) {
  const data = new Int16Array(SIZE * SIZE);
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) data[r * SIZE + c] = Math.round(fn(xOf(c), yOf(r)) / 0.5);
  return createDem({ data, size: SIZE, kmPerPixel: KPP, dnToMeters: 0.5 });
}
const fast = { yieldFn: () => Promise.resolve() };
const TAN = (deg) => Math.tan((deg * Math.PI) / 180);
const MOB = { descentDeg: 20, crossDeg: 12, speedKmh: 0.8 };
const run = (dem, points, extra = {}) => planSelfDriving({ points, dem, maxSlopeDeg: 15, mobility: MOB, seed: 7, maxIter: 1500, ...extra }, fast);
const len = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

// independent directed check: grade along every segment from height differences, every 0.03 km
function gradeOk(dem, pts, climbDeg, descentDeg) {
  const eps = 0.12;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], L = Math.hypot(bx - ax, by - ay);
    if (!(L > 0)) continue;
    const ux = (bx - ax) / L, uy = (by - ay) / L, n = Math.max(1, Math.ceil(L / 0.03));
    for (let k = 0; k <= n; k++) {
      const x = ax + ux * L * (k / n), y = ay + uy * L * (k / n);
      const h1 = dem.heightAtXY(x + ux * eps, y + uy * eps), h0 = dem.heightAtXY(x - ux * eps, y - uy * eps);
      if (h1 === null || h0 === null) return false;
      const grade = (h1 - h0) / (2 * eps * 1000);
      if (grade > TAN(climbDeg) + 0.02 || -grade > TAN(descentDeg) + 0.02) return false;
    }
  }
  return true;
}

test('flat plane: a path close to the straight line, and the route figures of a planned route', async () => {
  const r = await run(demFrom(() => 0), [[-10, -2], [10, 3]]);
  assert.ok(r.ok, r.reason);
  const straight = Math.hypot(20, 5);
  assert.ok(r.lengthKm >= straight * 0.999 && r.lengthKm <= straight * 1.15, `${r.lengthKm} vs ${straight}`);
  assert.ok(Math.abs(len(r.trajectory) - r.lengthKm) < 0.05);
  assert.equal(r.trajectory[0][0], -10);
  assert.deepEqual(r.trajectory.at(-1), [10, 3]);
  assert.ok(r.hours > 0 && Math.abs(r.hours - r.lengthKm / 0.8) < 0.01, `hours ${r.hours}`);
  assert.equal(r.oneWayKm, 0);
  assert.ok(r.profile.x.length > 50 && r.profile.km.length === r.profile.pitch.length);
  assert.ok(r.trees.length > 100 && r.candidates.length >= 1 && r.legs.length === 1 && r.legs[0].adjustedTo === null);
  assert.deepEqual(r.trace.map((t) => t.step).filter((s, i, a) => a.indexOf(s) === i), ['init', 'select', 'brrt', 'found', 'add', 'goal']);
});

test('a wall with one gap is crossed through the gap', async () => {
  const wall = demFrom((x, y) => (Math.abs(x) < 0.5 && !(y > 3 && y < 4.5) ? 1500 : 0));
  const r = await run(wall, [[-8, -3], [8, -3]], { maxIter: 3000 });
  assert.ok(r.ok, r.reason);
  const cross = [];
  for (let i = 0; i + 1 < r.trajectory.length; i++) {
    const [ax, ay] = r.trajectory[i], [bx, by] = r.trajectory[i + 1];
    if (ax < 0 && bx > 0 || ax > 0 && bx < 0) cross.push(ay + ((by - ay) * (0 - ax)) / (bx - ax));
  }
  assert.ok(cross.length >= 1, 'it crosses x = 0');
  for (const y of cross) assert.ok(y > 3 && y < 4.5, `crossed at y = ${y}`);
});

// a one-way ramp: 19° down towards +x between x = -2 and 2; climbing is limited to 15°, descending to 20°
test('one-way ramp: driven down; the way back fails or detours within the limits', async () => {
  const ramp = demFrom((x) => (x < -2 ? 0 : x > 2 ? -4000 * TAN(19) : -(x + 2) * 1000 * TAN(19)));
  const down = await run(ramp, [[-12, 0], [12, 0]]);
  assert.ok(down.ok, down.reason);
  assert.ok(down.descentMaxDeg > 17 && down.descentMaxDeg <= 20.01 && down.climbMaxDeg < 1, `${down.descentMaxDeg} ${down.climbMaxDeg}`);
  assert.ok(down.oneWayKm > 3, `one-way ${down.oneWayKm}`);
  assert.ok(gradeOk(ramp, down.trajectory, 15, 20));
  const up = await run(ramp, [[12, 0], [-12, 0]], { maxTries: 2, maxIter: 800 });
  if (up.ok) assert.ok(up.climbMaxDeg <= 15.01 && up.crossMaxDeg <= 12.01 && gradeOk(ramp, up.trajectory, 15, 20));
  else { assert.ok(up.aborted); assert.match(up.reason, /No path|passable/); }
});

test('a goal in an unreachable pit: Adjust Waypoints moves it, and the route succeeds at the moved goal', async () => {
  const dem = demFrom((x, y) => { const r = Math.hypot(x - 5, y); return r < 0.5 ? -400 : r < 1.2 ? -400 + (r - 0.5) * 1000 * TAN(40) : -400 + 0.7 * 1000 * TAN(40); });
  const r = await run(dem, [[-8, 0], [5, 0]], { maxIter: 1200 });
  assert.ok(r.ok, r.reason);
  assert.ok(r.legs[0].tries.length >= 2 && r.legs[0].tries[0].found === false && r.legs[0].tries.at(-1).found);
  const moved = r.legs[0].adjustedTo;
  assert.ok(moved && Math.hypot(moved[0] - 5, moved[1]) > 1.2, `moved to ${moved}`);
  assert.deepEqual(r.trajectory.at(-1), moved);
  assert.ok(r.trace.some((t) => t.step === 'adjust' && /\d+ m/.test(t.text)));
  assert.ok(r.delayMs >= 0);
  const p = autonavPayload(r);
  assert.equal(p.adjusted.length, 1);
});

test('a goal in a pit with no passable ground nearby aborts with the partial trajectory and a reason', async () => {
  const dem = demFrom((x, y) => { const r = Math.hypot(x - 5, y); return r < 0.5 ? -400 : r < 4 ? -400 + (r - 0.5) * 1000 * TAN(40) : 0; });
  const r = await run(dem, [[-8, 0], [-2, 0], [5, 0]], { maxIter: 600, maxTries: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.aborted, true);
  assert.ok(r.reason && r.reason.length > 5);
  assert.deepEqual(r.trajectory.at(-1), [-2, 0], 'the first leg is kept');
  assert.equal(r.legs.length, 2);
  assert.ok(r.trace.some((t) => t.step === 'abort'));
  assert.ok(r.lengthKm > 5);
});

test('the same seed gives the same result, another seed another search', async () => {
  const dem = demFrom((x, y) => 80 * Math.sin(x / 2) * Math.cos(y / 2.5));
  const a = await run(dem, [[-9, -4], [9, 5]]);
  const b = await run(dem, [[-9, -4], [9, 5]]);
  assert.ok(a.ok);
  assert.deepEqual(a.trajectory, b.trajectory);
  assert.deepEqual(a.trees, b.trees);
  const c = await run(dem, [[-9, -4], [9, 5]], { seed: 8 });
  assert.notDeepEqual(a.trees, c.trees);
});

test('every edge of the trajectory passes the directed check', async () => {
  const dem = demFrom((x, y) => -(x + 3) * 1000 * TAN(10) * (x > -3 && x < 3 ? 1 : 0) + (x >= 3 ? -6000 * TAN(10) : 0) + 60 * Math.sin(y));
  const r = await run(dem, [[-12, 3], [12, -3]]);
  assert.ok(r.ok, r.reason);
  assert.ok(gradeOk(dem, r.trajectory, 15, 20));
  assert.ok(r.maxSlopeDeg <= 20.01 && r.climbMaxDeg <= 15.01 && r.descentMaxDeg <= 20.01 && r.crossMaxDeg <= 12.01);
});

test('autonavPayload stays within its caps and uses [lat, lon]', async () => {
  const r = await run(demFrom(() => 0), [[-10, -2], [0, 4], [10, 3]], { maxIter: 2500 });
  assert.ok(r.ok);
  const p = autonavPayload(r);
  assert.ok(p.candidates.length >= 2 && p.candidates.length <= 12);
  for (const c of p.candidates) assert.ok(c.length >= 2 && c.length <= 300);
  assert.ok(p.trees.length > 0 && p.trees.length <= 4000 && p.trees[0].length === 4);
  const [lat, lon] = p.trajectory[0];
  assert.ok(lat < -80 && lat > -90 && lon >= 0 && lon < 360, `${lat} ${lon}`);
  assert.equal(p.aborted, false);
  assert.ok(p.trace.length >= 6 && typeof p.trace[0] === 'string');
  // forced caps
  const big = { ...r, candidates: Array.from({ length: 40 }, () => Array.from({ length: 900 }, (_, i) => [i / 100, 1])), candidateLegs: Array.from({ length: 40 }, (_, i) => i % 5), trees: Array.from({ length: 6000 }, () => [0, 0, 1, 1]) };
  const q = autonavPayload(big);
  assert.equal(q.candidates.length, 12);
  assert.ok(q.candidates.every((c) => c.length === 300));
  assert.equal(q.trees.length, 4000);
});

test('cancelling rejects with an AbortError', async () => {
  const ac = new AbortController();
  const p = planSelfDriving({ points: [[-10, 0], [10, 0]], dem: demFrom(() => 0), maxSlopeDeg: 15 }, { signal: ac.signal, sliceMs: 0, yieldFn: async () => { ac.abort(); } });
  await assert.rejects(p, { name: 'AbortError' });
});
