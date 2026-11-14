import test from 'node:test';
import assert from 'node:assert/strict';
import { createDem, createPyramid } from '../demo/src/terrain.js';

const level = (size, kmPerPixel, halfKm) => createDem({ data: new Int16Array(4), size, kmPerPixel, halfKm });
const d480 = level(1906, 0.48), d240 = level(2700, 0.24), d120 = level(2600, 0.12);
const full = { x0: -320, y0: -320, x1: 320, y1: 320 };
const shack = { x0: -20, y0: -30, x1: 30, y1: 20 };

test('levels carry their extent, coarse to fine', () => {
  assert.ok(Math.abs(d480.halfKm - 457.44) < 1e-9);
  assert.ok(Math.abs(d240.halfKm - 324) < 1e-9);
  assert.ok(Math.abs(d120.halfKm - 156) < 1e-9);
  const p = createPyramid([d120, d480, d240]);
  assert.deepEqual(p.levels.map((d) => d.kmPerPixel), [0.48, 0.24, 0.12]);
});

test('pick: the coarsest loaded level that is fine enough and covers the viewport', () => {
  const p = createPyramid([d480, d240, d120]);
  assert.equal(p.pick(0.64, full), d480);     // zoom 1 on a 1000 px canvas
  assert.equal(p.pick(0.48, full), d480);     // exactly fine enough
  assert.equal(p.pick(0.3, full), d240);      // 120 m does not cover ±320
  assert.equal(p.pick(0.3, shack), d240);
  assert.equal(p.pick(0.2, shack), d120);
  assert.equal(p.pick(0.05, shack), d120);    // none fine enough: the finest
  assert.equal(p.pick(0.05, full), d240);     // the finest that covers
  assert.equal(p.pick(0.2), d120);            // no bounds: every level counts
});

test('pick uses what is loaded so far, and add() replaces a level of the same resolution', () => {
  const p = createPyramid([d480]);
  assert.equal(p.pick(0.1, shack), d480);
  p.add(d120);
  assert.equal(p.pick(0.3, shack), d120);     // 240 m not loaded yet: finest available
  p.add(d240);
  assert.equal(p.pick(0.3, shack), d240);
  const again = level(2700, 0.24);
  p.add(again);
  assert.equal(p.levels.length, 3);
  assert.equal(p.pick(0.3, shack), again);
  assert.equal(createPyramid().pick(1, full), null);
  // nothing covers: the widest level
  assert.equal(createPyramid([d240, d120]).pick(0.1, { x0: -400, y0: 0, x1: -300, y1: 100 }), d240);
});

// third wave (review M1): a level is picked only with 2.5 of its pixels to spare, so the hillshade's
// slope samples never fall off its edge (black columns at ±156 km on the 120 m level)
test('pick leaves room for the hillshade at the edge of a level', () => {
  const p = createPyramid([d480, d240, d120]);
  assert.equal(p.pick(0.1, { x0: 100, y0: -50, x1: 156, y1: 6 }), d240);       // edge at 156: 120 m would run out
  assert.equal(p.pick(0.1, { x0: 100, y0: -50, x1: 155.7, y1: 6 }), d120);     // 156 − 2.5 × 0.12
  // the 480 m and 240 m levels still cover the whole map
  assert.equal(p.pick(0.5, full), d480);
  assert.equal(p.pick(0.3, full), d240);
});
