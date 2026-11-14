// Phase 1 globe view: the pure geometry and camera helpers (the WebGL part is checked in a browser with
// tools/globe-shots.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { unit, toLatLon, fromXYNorth, cameraFromHash, cameraToHash } from '../demo/src/globe-view.js';
import { toXYNorth } from '../demo/src/globe-terrain.js';

test('lat/lon ↔ unit vector: +Y is the north pole, +X is 0°E, −Z is 90°E, and it round-trips', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  const [x, y, z] = unit(0, 90);
  near(x, 0); near(y, 0); near(z, -1);
  near(unit(90, 0)[1], 1);
  for (const [lat, lon] of [[0, 0], [-89.67, 129.78], [43.3, 348.64], [0.674, 23.473]]) {
    const p = toLatLon(...unit(lat, lon).map((v) => v * 1737.4));
    near(p.latDeg, lat); near(p.lonDeg, lon);
  }
});

test('north polar stereographic: fromXYNorth inverts toXYNorth', () => {
  for (const [lat, lon] of [[80, 0], [76.5, 45], [89.9, 270], [85, 359]]) {
    const p = fromXYNorth(...toXYNorth(lat, lon));
    assert.ok(Math.abs(p.latDeg - lat) < 1e-9 && Math.abs(p.lonDeg - lon) < 1e-9, JSON.stringify(p));
  }
});

test('camera hash round-trips and ignores junk', () => {
  const c = { lat: -89.67, lon: 129.78, dist: 55, tilt: 50, heading: 30 };
  assert.deepEqual(cameraFromHash(cameraToHash(c)), c);
  assert.deepEqual(cameraFromHash('#lat=abc&dist=12'), { dist: 12 });
  assert.deepEqual(cameraFromHash(''), {});
});
