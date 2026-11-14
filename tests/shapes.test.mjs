import test from 'node:test';
import assert from 'node:assert/strict';
import { contains, bbox, areaKm2, lengthKm, maskFor, sampleLine, selfIntersects } from '../demo/src/map/shapes.js';

const rect = { type: 'rect', x0: 10, y0: -4, x1: -2, y1: 6 };
const circle = { type: 'circle', cx: 3, cy: 4, rKm: 5 };
const tri = { type: 'polygon', points: [[0, 0], [10, 0], [0, 10]] };
const ell = { type: 'polygon', points: [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]] };   // L shape, concave

test('contains: rect with corners in any order, circle, polygon (concave), route', () => {
  assert.equal(contains(rect, 0, 0), true);
  assert.equal(contains(rect, 10, 6), true);           // edges count
  assert.equal(contains(rect, 11, 0), false);
  assert.equal(contains(circle, 3, 9), true);
  assert.equal(contains(circle, 7, 8), false);
  assert.equal(contains(tri, 2, 2), true);
  assert.equal(contains(tri, 6, 6), false);
  assert.equal(contains(ell, 0.5, 3), true);
  assert.equal(contains(ell, 3, 3), false);             // the notch of the L
  assert.equal(contains({ type: 'route', points: [[0, 0], [5, 5]] }, 1, 1), false);
  assert.equal(contains(null, 0, 0), false);
});

test('bbox and planar area', () => {
  assert.deepEqual(bbox(rect), { x0: -2, y0: -4, x1: 10, y1: 6 });
  assert.deepEqual(bbox(circle), { x0: -2, y0: -1, x1: 8, y1: 9 });
  assert.deepEqual(bbox(tri), { x0: 0, y0: 0, x1: 10, y1: 10 });
  assert.equal(areaKm2(rect), 120);
  assert.ok(Math.abs(areaKm2(circle) - Math.PI * 25) < 1e-9);
  assert.equal(areaKm2(tri), 50);
  assert.equal(areaKm2({ type: 'polygon', points: [...tri.points].reverse() }), 50);   // winding does not matter
  assert.equal(areaKm2(ell), 7);
  assert.equal(areaKm2({ type: 'route', points: [[0, 0], [3, 4]] }), 0);
});

test('lengthKm sums the segments', () => {
  assert.equal(lengthKm([[0, 0], [3, 4], [3, 10]]), 11);
  assert.equal(lengthKm([[1, 1]]), 0);
  assert.equal(lengthKm([]), 0);
});

test('maskFor marks cells whose centre is inside, with a tight rect', () => {
  const grid = { size: 10, cellKm: 2, halfKm: 10 };    // centres at −9, −7, …, 9
  const m = maskFor({ type: 'rect', x0: -8, y0: -8, x1: -4, y1: -4 }, grid);
  // x centres −7, −5 → i 1, 2; y centres −7, −5 → j = (10 − y)/2 − 0.5 → 8, 7
  assert.equal(m.count, 4);
  assert.deepEqual(m.rect, { i0: 1, j0: 7, i1: 2, j1: 8 });
  for (const [i, j] of [[1, 7], [2, 7], [1, 8], [2, 8]]) assert.equal(m.mask[j * 10 + i], 1);
  assert.equal(m.mask.reduce((a, b) => a + b, 0), 4);

  const whole = maskFor({ type: 'circle', cx: 0, cy: 0, rKm: 100 }, grid);
  assert.equal(whole.count, 100);
  assert.deepEqual(whole.rect, { i0: 0, j0: 0, i1: 9, j1: 9 });

  const tiny = maskFor({ type: 'rect', x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.5 }, grid);
  assert.equal(tiny.count, 0);
  assert.equal(tiny.rect, null);
  assert.equal(tiny.mask.length, 100);

  const off = maskFor({ type: 'rect', x0: 50, y0: 50, x1: 60, y1: 60 }, grid);
  assert.equal(off.count, 0);

  // circle: count matches a brute-force test over all centres
  const c = { type: 'circle', cx: 1, cy: -2, rKm: 5.5 };
  const mc = maskFor(c, grid);
  let brute = 0;
  for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) if (Math.hypot(-9 + 2 * i - 1, 9 - 2 * j + 2) <= 5.5) brute++;
  assert.equal(mc.count, brute);
});

test('sampleLine: every step plus the end point, at least 2, at most maxPoints', () => {
  const s = sampleLine([[0, 0], [1.2, 0]], 0.5, 2000);
  assert.deepEqual(s.map((p) => p.dKm), [0, 0.5, 1, 1.2]);
  assert.ok(Math.abs(s[3].xKm - 1.2) < 1e-12);

  const exact = sampleLine([[0, 0], [1, 0]], 0.5, 2000);
  assert.deepEqual(exact.map((p) => p.dKm), [0, 0.5, 1]);

  const bend = sampleLine([[0, 0], [3, 0], [3, 4]], 0.5, 2000);
  assert.equal(bend.length, 15);                     // 7 km / 0.5 + 1
  const at4 = bend.find((p) => p.dKm === 4);
  assert.ok(Math.abs(at4.xKm - 3) < 1e-12 && Math.abs(at4.yKm - 1) < 1e-12);
  assert.deepEqual([bend.at(-1).xKm, bend.at(-1).yKm], [3, 4]);

  const short = sampleLine([[0, 0], [0.1, 0]], 0.5, 2000);
  assert.deepEqual(short.map((p) => p.dKm), [0, 0.1]);

  const one = sampleLine([[2, 3]], 0.5, 2000);
  assert.equal(one.length, 2);
  assert.deepEqual([one[1].xKm, one[1].yKm, one[1].dKm], [2, 3, 0]);

  const long = sampleLine([[0, 0], [5000, 0]], 0.5, 2000);
  assert.equal(long.length, 2000);
  assert.equal(long[0].dKm, 0);
  assert.equal(long.at(-1).dKm, 5000);
  assert.ok(Math.abs(long[1].dKm - 5000 / 1999) < 1e-9);
  assert.deepEqual(sampleLine([], 0.5, 2000), []);
});

// ---------- third wave (correctness review I2) ----------
test('selfIntersects finds crossing and touching edges, not neighbours', () => {
  assert.equal(selfIntersects([[0, 0], [10, 0], [10, 10], [0, 10]]), false);
  assert.equal(selfIntersects([[0, 0], [10, 10], [10, 0], [0, 10]]), true);         // figure eight: area 0, 50 cells
  assert.equal(selfIntersects([[0, 0], [10, 0], [5, 5]]), false);                     // a triangle never crosses
  assert.equal(selfIntersects([[0, 0], [10, 0], [10, 10], [5, 0], [0, 10]]), true);  // a vertex on another edge
  assert.equal(selfIntersects([[0, 0], [4, 0], [4, 4], [2, 1], [0, 4]]), false);      // concave is fine
});
