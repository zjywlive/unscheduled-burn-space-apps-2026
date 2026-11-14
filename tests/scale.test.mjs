import test from 'node:test';
import assert from 'node:assert/strict';
import { linear, niceTicks, elevationDomain, splitAtWrap } from '../demo/src/charts/scale.js';

test('scales and ticks', () => {
  assert.equal(linear(0, 360, 0, 720)(90), 180);
  assert.deepEqual(niceTicks(-10, 30, 5), [-10, 0, 10, 20, 30]);
  assert.deepEqual(niceTicks(0, 87, 5), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(elevationDomain(-4.1, 6.7), [-10, 30]);
  assert.deepEqual(elevationDomain(-62, 89.2), [-70, 90]);
});

test('a path that crosses north is split instead of drawn across the plot', () => {
  const parts = splitAtWrap([{ az: 350, el: 1 }, { az: 358, el: 1 }, { az: 4, el: 1 }, { az: 12, el: 1 }]);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => p.length), [2, 2]);
});

test('undefined azimuth breaks the path and is dropped', () => {
  const parts = splitAtWrap([{ az: 10, el: 80 }, { az: null, el: 90 }, { az: 190, el: 80 }]);
  assert.deepEqual(parts.map((p) => p.length), [1, 1]);
});
