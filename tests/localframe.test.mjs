// Route planning anywhere on the Moon (demo/src/localframe.js): a frame that puts any centre at the south pole.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalFrame, centreOf, localDem, mapPlan } from '../demo/src/localframe.js';
import { planRoutes } from '../demo/src/route-plan.js';
import { toXY } from '../demo/src/terrain.js';

const R = 1737.4, RAD = Math.PI / 180;
const gc = (a, b) => { const s = Math.sin((b.latDeg - a.latDeg) * RAD / 2) ** 2 + Math.cos(a.latDeg * RAD) * Math.cos(b.latDeg * RAD) * Math.sin((b.lonDeg - a.lonDeg) * RAD / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };

test('the centre maps to the origin, and points come back where they were', () => {
  for (const [la, lo] of [[0.674, 23.473], [20, 330], [-45, 177.6], [60, 90], [-89.9, 10], [89, 200]]) {
    const f = createLocalFrame(la, lo);
    const o = f.toLocal(la, lo);
    assert.ok(Math.hypot(...o) < 1e-6, `${la},${lo}`);
    for (const [dla, dlo] of [[0.5, 0], [0, 0.7], [-1, -1]]) {
      const p = { latDeg: Math.max(-89.9, Math.min(89.9, la + dla)), lonDeg: lo + dlo };
      const [x, y] = f.toLocal(p.latDeg, p.lonDeg), q = f.fromLocal(x, y);
      assert.ok(gc(p, q) < 1e-6, `round trip ${la},${lo}`);
    }
  }
});

test('near the centre, plane distances are ground distances (the stereographic scale is 1 there)', () => {
  const f = createLocalFrame(0.674, 23.473);
  const a = { latDeg: 0.674, lonDeg: 23.473 }, b = { latDeg: 0.9, lonDeg: 23.7 };
  const [x, y] = f.toLocal(b.latDeg, b.lonDeg);
  assert.ok(Math.abs(Math.hypot(x, y) - gc(a, b)) / gc(a, b) < 1e-4);
  const p = centreOf([a, b]);
  assert.ok(p.latDeg > 0.67 && p.latDeg < 0.91 && p.lonDeg > 23.4 && p.lonDeg < 23.71);
});

test('the planner runs unchanged on a local DEM, and the plan comes back in the Map polar km', async () => {
  // a tilted plane near Apollo 11 with a ridge across the straight line: 1 m per 100 m rise, a 600 m wall
  const c = { latDeg: 0.674, lonDeg: 23.473 }, f = createLocalFrame(c.latDeg, c.lonDeg);
  const heightAt = (la, lo) => { const [x, y] = f.toLocal(la, lo); return Math.abs(x) < 0.6 && y > -6 ? 600 : 10 * x; };
  const dem = localDem(f, { halfKm: 30, kmPerPixel: 0.24, heightAt });
  const a = f.toLocal(0.674, 23.30), b = f.toLocal(0.674, 23.65);
  const plan = await planRoutes({ points: [a, b], dem, maxSlopeDeg: 15 });
  assert.ok(plan.ok, plan.error);
  const back = mapPlan(plan, ([x, y]) => { const p = f.fromLocal(x, y); return toXY(p.latDeg, p.lonDeg); });
  const end = back.routes[0].points[back.routes[0].points.length - 1], want = toXY(0.674, 23.65);
  assert.ok(Math.hypot(end[0] - want[0], end[1] - want[1]) < 1, 'ends at the end point in polar km');
  assert.ok(back.routes[0].lengthKm > 10.5, 'went round the wall (straight line ~10.5 km)');
});
