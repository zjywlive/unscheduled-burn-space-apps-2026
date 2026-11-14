import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toXY, fromXY, createDem, horizonProfile, horizonAt, skylineFor } from '../demo/src/terrain.js';

const R = 1737.4;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('projection: pole at the origin, 0E up, 90E right', () => {
  assert.deepEqual(toXY(-90, 0).map((v) => Math.round(v * 1e6) / 1e6 + 0), [0, 0]);
  const r80 = 2 * R * Math.tan((10 / 2) * Math.PI / 180); // 304.006 km
  assert.ok(near(r80, 304.006, 0.001));
  assert.ok(near(toXY(-80, 0)[0], 0, 1e-9) && near(toXY(-80, 0)[1], r80, 1e-9));
  assert.ok(near(toXY(-80, 90)[0], r80, 1e-9) && near(toXY(-80, 90)[1], 0, 1e-9));
  assert.ok(near(toXY(-80, 180)[1], -r80, 1e-9));
  const back = fromXY(...toXY(-84.7906, 29.1957));
  assert.ok(near(back.latDeg, -84.7906, 1e-9) && near(back.lonDeg, 29.1957, 1e-9));
  assert.ok(near(fromXY(...toXY(-89.45, 222.69)).lonDeg, 222.69, 1e-9));
});

// A DEM defined by a function, for analytic cases.
const fakeDem = (fn, halfKm = 460) => ({
  size: 0, kmPerPixel: 0.48,
  heightAtXY: (x, y) => (Math.abs(x) > halfKm || Math.abs(y) > halfKm ? null : fn(x, y)),
  heightAt(lat, lon) { return this.heightAtXY(...toXY(lat, lon)); },
});

test('flat sphere: the skyline is the 2 m dip, about -0.087 deg, in every direction', () => {
  const p = horizonProfile(fakeDem(() => 0), -85, 30, { azimuths: 36 });
  assert.equal(p.length, 36);
  for (const e of p) assert.ok(e <= -0.086 && e >= -0.12, String(e));
});

test('a 2 km wall 50 km to the north shows at azimuth 0 and not at azimuth 180', () => {
  const dem = fakeDem((x, y) => (y >= 50 ? 2000 : 0));
  const [, y0] = toXY(-89.99, 0);
  const d = 50 - y0;                       // km along the 0E meridian to the wall
  const th = d / R, r0 = R + 0.002, r1 = R + 2;
  const expected = Math.atan2(r1 * Math.cos(th) - r0, r1 * Math.sin(th)) * 180 / Math.PI; // about 1.48
  const p = horizonProfile(dem, -89.99, 0, { azimuths: 360 });
  assert.ok(near(p[0], expected, 0.06), `${p[0]} vs ${expected}`);
  assert.ok(p[180] < -0.08);
  assert.ok(near(horizonAt(p, 359.5), (p[359] + p[0]) / 2, 1e-6));
  assert.ok(Number.isFinite(horizonAt(p, null)));
});

test('outside the terrain a skyline is flat zero', () => {
  const dem = fakeDem(() => 500);
  const s = skylineFor(dem, { latDeg: 0.67, lonDeg: 23.47 });
  assert.equal(s.profile, null);
  assert.equal(s(123), 0);
  assert.equal(skylineFor(null, { latDeg: -89, lonDeg: 0 })(0), 0);
  assert.notEqual(skylineFor(dem, { latDeg: -89, lonDeg: 0 }).profile, null);
});

test('real LOLA grid: landmarks sit where the map says they do', () => {
  const buf = readFileSync(new URL('../data-raw/lola/ldem_75s_240m.img', import.meta.url));
  const dem = createDem({ data: new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2), size: 3812, kmPerPixel: 0.24 });
  assert.ok(dem.heightAt(-89.67, 129.78) < -1500);   // Shackleton floor
  assert.ok(dem.heightAt(-89.45, 222.69) > 0);       // ridge by Shackleton
  assert.ok(dem.heightAt(-88.14, 44.9) < -1500);     // Shoemaker floor
  assert.equal(dem.heightAt(-70, 0), null);          // outside 75S
});

import { statSync } from 'node:fs';
test('terrain products have the agreed shapes', () => {
  const meta = JSON.parse(readFileSync(new URL('../demo/data/terrain.json', import.meta.url)));
  assert.equal(statSync(new URL('../demo/data/dem_480m.bin', import.meta.url)).size, 1906 * 1906 * 2);
  assert.equal(statSync(new URL('../demo/data/horizon_grid.bin', import.meta.url)).size, 320 * 320 * 72);
  assert.equal(meta.horizon.azimuths, 72); assert.equal(meta.horizon.offsetDeg, -5); assert.equal(meta.horizon.stepDeg, 0.1);
});

test('the 480 m grid agrees with the 240 m grid at a landmark, and the horizon grid sees the crater wall', () => {
  const b = readFileSync(new URL('../demo/data/dem_480m.bin', import.meta.url));
  const dem = createDem({ data: new Int16Array(b.buffer, b.byteOffset, b.length / 2), size: 1906, kmPerPixel: 0.48 });
  assert.ok(dem.heightAt(-89.67, 129.78) < -1500);
  const g = readFileSync(new URL('../demo/data/horizon_grid.bin', import.meta.url));
  const [x, y] = toXY(-89.67, 129.78);
  const i = Math.floor((x + 320) / 2), j = Math.floor((320 - y) / 2);
  const cell = g.subarray((j * 320 + i) * 72, (j * 320 + i) * 72 + 72);
  // from the floor of Shackleton the rim stands well above 5 deg in every direction
  assert.ok(Math.min(...cell) * 0.1 - 5 > 5);
});

test('createDem: an explicit halfKm equal to the default gives the same heights; a wider one shifts the grid', () => {
  const size = 8, kmPerPixel = 2;
  const data = Int16Array.from({ length: size * size }, (_, i) => (i * 37) % 101);
  const a = createDem({ data, size, kmPerPixel });
  const b = createDem({ data, size, kmPerPixel, halfKm: 8 });
  assert.equal(a.halfKm, 8);
  for (const [x, y] of [[0, 0], [1.3, -2.7], [6.9, 6.9], [-7, 3], [9, 0]]) assert.equal(a.heightAtXY(x, y), b.heightAtXY(x, y));
  // pixel (0, 0) centre sits at (-halfKm + 1, halfKm - 1)
  const c = createDem({ data, size, kmPerPixel, halfKm: 10 });
  assert.equal(c.heightAtXY(-9, 9), data[0] * 0.5);
  assert.equal(c.heightAtXY(-9 + 14, 9 - 14), data[7 * size + 7] * 0.5);
  assert.equal(c.heightAtXY(-9.5, 9), null);
});
