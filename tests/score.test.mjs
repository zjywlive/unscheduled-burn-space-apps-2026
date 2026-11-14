import test from 'node:test';
import assert from 'node:assert/strict';
import { staticGrid, passes, filterMask, scoreCells, DEFAULT_WEIGHTS } from '../demo/src/score.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('staticGrid decodes bytes with the scale', () => {
  const g = staticGrid(new Uint8Array([0, 1, 40, 255]), 0.25);
  assert.ok(g instanceof Float32Array);
  assert.deepEqual(Array.from(g), [0, 0.25, 10, 63.75]);
  assert.deepEqual(Array.from(staticGrid(new Uint8Array([0, 7, 255]), 1)), [0, 7, 255]);
});

test('passes: null is Any, limits are inclusive, unknown values fail an active limit', () => {
  assert.equal(passes(45, 500, { maxSlope: null, maxDark: null }), true);
  assert.equal(passes(45, 500, {}), true);
  assert.equal(passes(NaN, undefined, {}), true);
  assert.equal(passes(10, 0, { maxSlope: 10 }), true);
  assert.equal(passes(10.25, 0, { maxSlope: 10 }), false);
  assert.equal(passes(3, 48, { maxSlope: 30, maxDark: 48 }), true);
  assert.equal(passes(3, 50, { maxSlope: 30, maxDark: 48 }), false);
  assert.equal(passes(3, 0, { maxDark: 0 }), true);
  assert.equal(passes(NaN, 0, { maxSlope: 30 }), false);
  assert.equal(passes(3, null, { maxDark: 100 }), false);
});

test('filterMask marks failing cells with 1', () => {
  const slope = new Float32Array([2, 8, 12, 5]), dark = new Float32Array([0, 10, 0, 200]);
  assert.deepEqual(Array.from(filterMask({ slope, dark, maxSlope: null, maxDark: null, count: 4 })), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(filterMask({ slope, dark, maxSlope: 10, maxDark: null })), [0, 0, 1, 0]);
  assert.deepEqual(Array.from(filterMask({ slope, dark, maxSlope: 10, maxDark: 12 })), [0, 0, 1, 1]);
  assert.deepEqual(Array.from(filterMask({ dark, maxDark: 0 })), [0, 1, 0, 1]);
  // An active limit without its array filters everything out; an inactive one does not need it.
  assert.deepEqual(Array.from(filterMask({ dark, maxSlope: 30, count: 4 })), [1, 1, 1, 1]);
  assert.deepEqual(Array.from(filterMask({ dark, maxDark: 12, count: 4 })), [0, 0, 0, 1]);
});

test('scoreCells: weighted mean of the four terms, default weights 40/30/20/10', () => {
  assert.deepEqual(DEFAULT_WEIGHTS, { sun: 40, earth: 30, slope: 20, shadow: 10 });
  const sun = new Float32Array([1, 0, 0.5, 0.8]), earth = new Float32Array([1, 0, 0.5, 0.2]);
  const slope = new Float32Array([0, 20, 10, 40]), shadowKm = new Float32Array([0, 50, 25, 255]);
  const s = scoreCells({ sun, earth, slope, shadowKm });
  assert.ok(s instanceof Float32Array);
  // cell 0 sits inside persistent shadow (0 km), so its shadow term is 0 (task book revision, wave 2)
  close(s[0], 0.9); close(s[1], 0); close(s[2], 0.5);
  close(s[3], (40 * 0.8 + 30 * 0.2 + 20 * 0 + 10 * 0) / 100);          // slope and shadow terms clamp at 0
  const arr = scoreCells({ sun, earth, slope, shadowKm, weights: [0, 0, 0, 100] });
  close(arr[2], 0.5); close(arr[3], 0);
  const half = scoreCells({ sun, earth, slope, shadowKm, weights: { sun: 50, earth: 50, slope: 0, shadow: 0 } });
  close(half[3], 0.5);
});

test('scoreCells: a cell inside persistent shadow gets 0 on the shadow term, a cell next to it nearly full marks', () => {
  const shadowKm = new Float32Array([0, 1, 50, NaN]);
  const s = scoreCells({ shadowKm, weights: [0, 0, 0, 100] });
  close(s[0], 0); close(s[1], 0.98); close(s[2], 0);
  assert.ok(Number.isNaN(s[3]));
  // a sunless crater floor no longer scores from the shadow term alone
  const floor = scoreCells({ sun: new Float32Array([0]), earth: new Float32Array([0]), slope: new Float32Array([2]), shadowKm: new Float32Array([0]) });
  close(floor[0], (20 * 0.9) / 100);
});

test('scoreCells: zero weights give all NaN; zero-weight terms may be missing; bad inputs give NaN', () => {
  const sun = new Float32Array([0.5, NaN]);
  assert.ok(Array.from(scoreCells({ sun, weights: [0, 0, 0, 0] })).every(Number.isNaN));
  assert.ok(Array.from(scoreCells({ sun, weights: { sun: -5, earth: 0, slope: 0, shadow: 0 } })).every(Number.isNaN));
  const only = scoreCells({ sun, weights: [10, 0, 0, 0] });
  close(only[0], 0.5); assert.ok(Number.isNaN(only[1]));
  assert.ok(Number.isNaN(scoreCells({ sun, weights: [10, 10, 0, 0] })[0]));   // earth weighted but missing
});
