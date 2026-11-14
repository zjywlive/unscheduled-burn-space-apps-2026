// Lander track: the descent map. Contour interval and scale bar follow the zoom; the terrain mesh carries the
// DEM height relative to the landing site (for contours and the height colours) and the slope (for the hazard
// colours); playback can run in real time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contourInterval, scaleBar, terrainGeometry } from '../demo/src/lander/view-surface.js';
import { playbackStep } from '../demo/src/lander/ui.js';
import { unitFromLonLat } from '../demo/src/geometry.js';
import { R_MOON } from '../demo/src/lander/constants.js';
import { toXY } from '../demo/src/terrain.js';

test('terrain: contour interval is 1, 2 or 5 × 10ⁿ m, about one line per 14 px on a 20° slope, at least 1 m', () => {
  assert.equal(contourInterval(0.05), 1);
  assert.equal(contourInterval(0.5), 5);      // 0.5 m/px × 14 × 0.36 = 2.5 m → 5 m
  assert.equal(contourInterval(2), 20);       // 2 × 14 × 0.36 = 10.08 → 20
  assert.equal(contourInterval(10), 100);     // 50.4 → 100
  for (const mpp of [0.01, 0.3, 1.7, 9, 44]) {
    const iv = contourInterval(mpp), p = Math.pow(10, Math.floor(Math.log10(iv)));
    assert.ok([1, 2, 5].includes(Math.round(iv / p)), `${iv}`);
    assert.ok(iv >= Math.max(1, mpp * 14 * 0.36) - 1e-9);
  }
});

test('terrain: scale bar is the longest round length that fits', () => {
  assert.deepEqual(scaleBar(1, 110), { m: 100, px: 100, label: '100 m' });
  assert.deepEqual(scaleBar(0.1, 110), { m: 10, px: 100, label: '10 m' });
  const b = scaleBar(30, 110);   // 3.3 km fits → 2 km
  assert.equal(b.label, '2 km');
  assert.ok(b.px <= 110 && b.px > 40);
});

test('terrain: the mesh carries height relative to the site and slope per vertex', () => {
  const prev = globalThis.THREE;
  globalThis.THREE = {
    BufferGeometry: class { constructor() { this.attributes = {}; } setAttribute(k, v) { this.attributes[k] = v; } setIndex(i) { this.index = i; } computeVertexNormals() {} },
    BufferAttribute: class { constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; } },
  };
  try {
    const siteF = unitFromLonLat(-137.31, -89.45);
    // a 5° tilt along map x, 1000 m at the site, shifted so the site sits at the planned height (offset −1000)
    const tan5 = Math.tan(5 * Math.PI / 180);
    const [x0] = toXY(-89.45, -137.31);
    const g = terrainGeometry(siteF, R_MOON, (x) => 1000 + (x - x0) * 1000 * tan5, { halfM: 2000, n: 80, offsetM: -1000 });
    const el = g.geometry.attributes.aElev, sl = g.geometry.attributes.aSlope;
    assert.ok(el && sl && el.array.length === g.N * g.N && sl.array.length === g.N * g.N);
    const mid = (g.N - 1) / 2;
    assert.ok(Math.abs(el.array[mid * g.N + mid]) < 0.01, `site at 0 (${el.array[mid * g.N + mid]})`);
    assert.ok(Math.abs(sl.array[mid * g.N + mid] - 5) < 0.3, 'slope 5°');
    // the range spans the tilt within ±1.5 km (up to ±2.1 km along map x when the square is rotated), 2nd–98th percentile
    assert.ok(g.elevRange.max - g.elevRange.min > 150 && g.elevRange.max - g.elevRange.min < 400, `range ${g.elevRange.min}..${g.elevRange.max}`);
    assert.ok(!g.geometry.attributes.color, 'colours come from the shader now');
  } finally {
    globalThis.THREE = prev;
  }
});

test('terrain: playback at a multiple of the compressed timeline, or in real time', () => {
  const tl = { fToT: (f) => f * 1e6, tToF: (t) => t / 1e6 };   // the whole timeline is 1000 s
  assert.equal(playbackStep(0.5, 1, 2, tl, 150), 0.5 + 2 / 150);
  assert.equal(playbackStep(0.5, 1, 'real', tl), 0.501, 'one simulated second per real second');
  assert.equal(playbackStep(0.9999, 10, 'real', tl), 1, 'stops at the end');
});
