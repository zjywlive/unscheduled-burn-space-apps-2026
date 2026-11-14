import test from 'node:test';
import assert from 'node:assert/strict';
import { neededPacks, STARTUP_PACKS } from '../demo/src/map/tiers.js';

test('zoom under 2 needs the start-up packs only', () => {
  assert.deepEqual(STARTUP_PACKS, ['dem_480m', 'horizon_grid', 'slope_2km', 'shadow_2km']);
  assert.deepEqual(neededPacks({ cx: 0, cy: 0, zoom: 1 }), STARTUP_PACKS);
  assert.deepEqual(neededPacks({ cx: 50, cy: 50, zoom: 1.99 }), STARTUP_PACKS);
  assert.deepEqual(neededPacks(undefined), STARTUP_PACKS);
});

test('zoom 2 and up adds 240 m terrain and the 1 km grids', () => {
  const p = neededPacks({ cx: 0, cy: 0, zoom: 2 });
  assert.deepEqual(p, [...STARTUP_PACKS, 'dem_240m', 'horizon_1km', 'slope_1km', 'shadow_1km']);
  assert.ok(!neededPacks({ cx: 0, cy: 0, zoom: 3.9 }).includes('dem_120m'));
});

test('120 m only from zoom 4 with the viewport inside ±156 km', () => {
  assert.ok(neededPacks({ cx: 0, cy: 0, zoom: 4 }).includes('dem_120m'));            // ±80 km
  assert.ok(neededPacks({ cx: 76, cy: -76, zoom: 4 }).includes('dem_120m'));         // edge at 156
  assert.ok(!neededPacks({ cx: 77, cy: 0, zoom: 4 }).includes('dem_120m'));          // edge at 157
  assert.ok(!neededPacks({ cx: 0, cy: 200, zoom: 8 }).includes('dem_120m'));
  assert.ok(neededPacks({ cx: -120, cy: 100, zoom: 12 }).includes('dem_120m'));
  const all = neededPacks({ cx: 0, cy: 0, zoom: 12 });
  assert.equal(new Set(all).size, all.length);
  assert.equal(all.at(-1), 'dem_120m');
});
