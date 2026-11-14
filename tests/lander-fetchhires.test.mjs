// tools/fetch-hires.mjs --at: which official product a patch anywhere on the Moon comes from, the SLDEM2015
// pixel window (centre pixel, size at a latitude, the wrap at lon 0/360) and the km → 0.5 m DN conversion.
// Pure helpers only, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectProduct, productFor, PRODUCTS, SLDEM, equirectWindow, equirectTileOf, equirectRanges, kmToDn, floatKmBytesToDn, despike,
} from '../tools/fetch-hires.mjs';
import { toXY } from '../demo/src/terrain.js';

const KM_PER_DEG = (1737.4 * Math.PI) / 180;

test('south polar points keep the existing products, then the 30 m and 60 m south polar ones', () => {
  for (const [lat, lon] of [[-89.45, 222.69], [-86.7, 336.3], [-84.3, 30.6]]) {
    const s = selectProduct(lat, lon, 5);
    assert.equal(s.projection, 'spolar');
    assert.equal(s.product, productFor(...toXY(lat, lon), 5), `${lat}, ${lon}: same choice as the site list`);
    assert.ok(PRODUCTS.includes(s.product));
  }
  assert.equal(selectProduct(-89.45, -137.31, 5).product.name, 'ldem_875s_5m');   // west longitudes wrap
  assert.equal(selectProduct(-80.13, 1.44, 5).product.name, 'ldem_75s_30m');      // IM-1: past the 20 m product's edge
  assert.equal(selectProduct(-69.37, 32.32, 5).product.name, 'ldem_60s_60m');     // Chandrayaan-3
  assert.equal(productFor(...toXY(-80.13, 1.44), 5), null, 'the site list itself is unchanged');
});

test('the equator and mid latitudes come from SLDEM2015', () => {
  const s = selectProduct(0.67416, 23.47314, 5);
  assert.equal(s.projection, 'equirect');
  assert.equal(s.product.name, 'sldem2015_512');
  assert.deepEqual([...new Set(equirectRanges(SLDEM, s.window).map((r) => r.file))], ['sldem2015_512_00n_30n_000_045_float.img']);
  assert.equal(selectProduct(-45.44, 177.6, 5).product.name, 'sldem2015_512');   // Chang'e-4
  assert.equal(selectProduct(59.7, 300, 5).product.name, 'sldem2015_512');
});

test('north polar points come from the LOLA north polar products, finest first', () => {
  const s = selectProduct(89.5, 30, 5);
  assert.equal(s.projection, 'npolar');
  assert.equal(s.product.name, 'ldem_875n_5m');
  assert.equal(selectProduct(86, 100, 5).product.name, 'ldem_85n_10m');
  assert.equal(selectProduct(82, 200, 5).product.name, 'ldem_80n_20m');
  assert.equal(selectProduct(77, 10, 5).product.name, 'ldem_75n_30m');
  assert.equal(selectProduct(65, 10, 5).product.name, 'ldem_60n_60m');
  const [x, y] = [s.x, s.y], r = Math.hypot(x, y);
  assert.ok(Math.abs(r - 2 * 1737.4 * Math.tan((0.25 * Math.PI) / 180)) < 1e-9 && y < 0, 'north map km: y = −r cos λ');
});

test('a patch across ±60° (in neither SLDEM2015 nor a polar product) is refused, naming the finest global option', () => {
  assert.throws(() => selectProduct(60, 10, 5), /LDEM_1024/);
  assert.throws(() => selectProduct(-59.95, 100, 5), /across ±60°/);
  assert.equal(selectProduct(-59.95, 100, 1).product.name, 'sldem2015_512', 'a smaller patch fits');
  assert.throws(() => selectProduct(91, 0, 5), RangeError);
  assert.throws(() => selectProduct(0, 0, 0), RangeError);
});

test('equirect window: the centre pixel of a known lat/lon, globally and in its tile', () => {
  const w = equirectWindow(SLDEM, 0.67, 23.47, 5);
  assert.equal(w.row, 30376);   // (60 − 0.67) × 512 = 30376.96
  assert.equal(w.col, 12016);   // 23.47 × 512 = 12016.64
  assert.deepEqual(equirectTileOf(SLDEM, w.row, w.col), { file: 'sldem2015_512_00n_30n_000_045_float.img', row: 15016, col: 12016 });
  // pixel centres of that tile at lat 30 − (row + 0.5)/512, lon (col + 0.5)/512 (the label's projection offsets)
  assert.ok(Math.abs(30 - (15016 + 0.5) / 512 - 0.67) < 0.5 / 512 && Math.abs((12016 + 0.5) / 512 - 23.47) < 0.5 / 512);
  assert.ok(w.row >= w.r0 && w.row < w.r0 + w.height && w.col >= w.c0 && w.col < w.c0 + w.width, 'the window holds the point');
  assert.ok(Math.abs((w.latMin + w.latMax) / 2 - 0.67) <= 1 / 512 && Math.abs((w.lonMin + w.lonMax) / 2 - 23.47) <= 1 / 512, 'centred within a pixel');
  assert.deepEqual(equirectTileOf(SLDEM, 30720, 184319), { file: 'sldem2015_512_30s_00s_315_360_float.img', row: 0, col: 23039 });
});

test('equirect window: a 10 km square in pixels at the equator and at 45°', () => {
  const eq = equirectWindow(SLDEM, 0.67, 23.47, 5);
  assert.deepEqual([eq.width, eq.height], [169, 169]);   // 10 km / 59.2 m = 168.9
  const mid = equirectWindow(SLDEM, 45, 100, 5);
  assert.equal(mid.height, 169);
  assert.equal(mid.width, 239);                          // 168.9 / cos 45°
  const groundKm = (w, lat) => [w.width / SLDEM.ppd * KM_PER_DEG * Math.cos((lat * Math.PI) / 180), w.height / SLDEM.ppd * KM_PER_DEG];
  for (const [w, lat] of [[eq, 0.67], [mid, 45]]) for (const km of groundKm(w, lat)) assert.ok(Math.abs(km - 10) < SLDEM.kmPerPixel, `${km.toFixed(3)} km`);
  assert.equal(SLDEM.kmPerPixel.toFixed(7), (KM_PER_DEG / 512).toFixed(7), 'MAP_SCALE of the label');
});

test('equirect window: longitude wraps at 0/360 and the reads split across the two tiles', () => {
  const a = equirectWindow(SLDEM, 10, 0.01, 5), b = equirectWindow(SLDEM, 10, 360.01, 5), c = equirectWindow(SLDEM, 10, -359.99, 5);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.ok(a.c0 > 360 * 512 - a.width && a.lonMin > 359 && a.lonMax > 360, 'starts just west of 0° and runs past 360');
  const reads = equirectRanges(SLDEM, a);
  assert.equal(reads.length, 2 * a.height);
  const [west, east] = reads;
  assert.equal(west.file, 'sldem2015_512_00n_30n_315_360_float.img');
  assert.equal(east.file, 'sldem2015_512_00n_30n_000_045_float.img');
  assert.equal(west.col + west.count, SLDEM.tileCols, 'the west part runs to the tile edge');
  assert.deepEqual([east.col, east.outCol, west.count + east.count], [0, west.count, a.width]);
  assert.equal(a.col, Math.floor(0.01 * 512), 'the point is at the start of the 000_045 tile');
  const neg = equirectWindow(SLDEM, 10, -0.01, 5);
  assert.equal(neg.col, 360 * 512 - 6);                  // 359.99 × 512 = 184314.9
  // a row inside one tile is one read
  assert.equal(equirectRanges(SLDEM, equirectWindow(SLDEM, 0.67, 23.47, 2)).length, equirectWindow(SLDEM, 0.67, 23.47, 2).height);
});

test('DN conversion: float32 km above 1737.4 km → Int16 DN of 0.5 m', () => {
  assert.equal(kmToDn(0), 0);
  assert.equal(kmToDn(1.5), 3000);
  assert.equal(kmToDn(-4.899), -9798);
  assert.equal(kmToDn(0.00026), 1);       // 0.26 m rounds to 1 DN (0.5 m)
  assert.equal(kmToDn(0.0002), 0);
  assert.equal(kmToDn(20), 32767);        // clamps (Moon heights stay within ±11 km)
  assert.throws(() => kmToDn(NaN));
  const f = Float32Array.from([-1.2345, 3.466, -2.0001]);   // as read from the file: little-endian PC_REAL
  const bytes = new Uint8Array(f.buffer.slice(0));
  assert.deepEqual([...floatKmBytesToDn(bytes)], [-2469, 6932, -4000]);
  const dv = new DataView(new ArrayBuffer(8)); dv.setFloat32(0, 0.5, true); dv.setFloat32(4, -0.25, true);
  assert.deepEqual([...floatKmBytesToDn(new Uint8Array(dv.buffer, 0, 8))], [1000, -500]);
});

test('despike handles a patch wider than it is tall (equirect)', () => {
  const w = 6, h = 4, ramp = Int16Array.from({ length: w * h }, (_, k) => (k % w) * 20);
  assert.equal(despike(ramp, w, 10).replaced, 0);
  const spiky = Int16Array.from(ramp); spiky[1 * w + 3] += 60;
  const r = despike(spiky, w, 10);
  assert.equal(r.replaced, 1);
  assert.equal(r.data[1 * w + 3], ramp[1 * w + 3]);
});
