// Package D: synthetic netCDF files, raster geometry, patch / drill-depth semantics and exact nearest
// queries, then real Diviner packs through loadCoreContext and point-eval. No network or disk fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createIce, icePatches } from '../demo/src/ice.js';
import { toXY } from '../demo/src/terrain.js';
import { staticMetrics } from '../demo/src/point-eval.js';
import { createCoreTools } from '../demo/src/tools-core.js';
import { loadCoreContext } from '../tools/core-context.mjs';
import { readNetcdfClassic, divinerGrid, scoreOrientations, encodeRasters, iceDistanceGrid, ORIENTATIONS } from '../tools/build-ice.mjs';
import { bundle } from '../tools/build.mjs';

const DATA = new URL('../demo/data/', import.meta.url), RAW = new URL('../data-raw/diviner/', import.meta.url);
const read = (name) => readFileSync(new URL(name, DATA));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

// Write a complete tiny CDF-1 file into memory, including variable-length padded headers and data.
// Offsets are computed after serialising the header, so changing title length moves every data variable.
function tinyNetcdf({ size = 3, title = 'odd', stepKm = 0.25, z = [0, 0.123, NaN, 0.73, 0.0001, 0.5, 1.5, 0.99, 0] } = {}) {
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  const text = (s) => { const b = Buffer.from(s); return Buffer.concat([u32(b.length), b, Buffer.alloc((4 - b.length % 4) % 4)]); };
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b; };
  const absent = Buffer.alloc(8);
  const attr = (name, type, count, data) => Buffer.concat([text(name), u32(type), u32(count), data, Buffer.alloc((4 - data.length % 4) % 4)]);
  const axes = Buffer.alloc(size * 8);
  for (let i = 0; i < size; i++) axes.writeDoubleBE((i - (size - 1) / 2) * stepKm / 1737.4, i * 8);
  assert.equal(z.length, size * size);
  const vars = [
    { name: 'x', ids: [0], type: 6, data: axes, attrs: absent },
    { name: 'y', ids: [1], type: 6, data: axes, attrs: absent },
    { name: 'z', ids: [1, 0], type: 5, data: Buffer.concat(z.map(f32)),
      attrs: Buffer.concat([u32(12), u32(2), attr('_FillValue', 5, 1, f32(NaN)), attr('valid_range', 5, 2, Buffer.concat([f32(0), f32(2)]))]) },
  ];
  const parts = [Buffer.from('CDF\x01', 'latin1'), u32(0), u32(10), u32(2), text('x'), u32(size), text('y'), u32(size),
    u32(12), u32(2), attr('title', 2, Buffer.byteLength(title), Buffer.from(title)), attr('node_offset', 4, 1, u32(1)), u32(11), u32(3)];
  for (const v of vars) {
    v.offset = u32(0);
    parts.push(text(v.name), u32(v.ids.length), ...v.ids.map(u32), v.attrs, u32(v.type), u32(v.data.length), v.offset);
  }
  let offset = parts.reduce((n, b) => n + b.length, 0);
  for (const v of vars) { v.offset.writeUInt32BE(offset); offset += v.data.length; }
  return Buffer.concat([...parts, ...vars.map((v) => v.data)]);
}

test('netCDF: padded synthetic file, double axes, float depths, NaN and nonzero buffer offset', () => {
  for (const title of ['odd', 'a much longer header moves the data offsets']) {
    const file = tinyNetcdf({ title }), backing = Buffer.concat([Buffer.alloc(13), file, Buffer.alloc(7)]);
    const nc = readNetcdfClassic(backing.subarray(13, 13 + file.length));
    assert.deepEqual(nc.dimensions, [{ name: 'x', size: 3 }, { name: 'y', size: 3 }]);
    assert.equal(nc.attributes.title, title); assert.equal(nc.attributes.node_offset, 1);
    assert.deepEqual(nc.variables.z.dimensions, ['y', 'x']);
    assert.deepEqual(nc.variables.z.shape, [3, 3]);
    assert.equal(nc.variables.x.type, 6); near(nc.variables.x.data[2] * 1737.4, 0.25);
    assert.equal(nc.variables.z.data[0], 0); near(nc.variables.z.data[1], 0.123, 1e-8);
    assert.ok(Number.isNaN(nc.variables.z.data[2]));
    assert.ok(Number.isNaN(nc.variables.z.attributes._FillValue));
    assert.deepEqual(nc.variables.z.attributes.valid_range, [0, 2]);
    near(divinerGrid(nc).kmPerPixel, 0.25);
  }
});

test('netCDF: truncated, non-classic, record-variable and malformed headers fail explicitly', () => {
  const good = tinyNetcdf();
  for (const cut of [0, 7, 20, good.length - 1]) assert.throws(() => readNetcdfClassic(good.subarray(0, cut)), /netCDF/);
  const version = Buffer.from(good); version[3] = 2;
  assert.throws(() => readNetcdfClassic(version), /CDF-1/);
  const record = Buffer.from(good); record.writeUInt32BE(1, 4);
  assert.throws(() => readNetcdfClassic(record), /record/);
  const badList = Buffer.from(good); badList.writeUInt32BE(99, 8);
  assert.throws(() => readNetcdfClassic(badList), /list tag/);
  const nc = readNetcdfClassic(good); nc.attributes.node_offset = 0;
  assert.throws(() => divinerGrid(nc), /pixel-registered/);
});

test('orientation: all eight transformations can be recovered from an asymmetric synthetic cold mask', () => {
  const z = Array(25).fill(200); for (const p of [3, 14, 20]) z[p] = 80;
  const nc = readNetcdfClassic(tinyNetcdf({ size: 5, stepKm: 1, z }));
  for (const orientation of ORIENTATIONS) {
    const [a, b, c, d] = orientation.matrix;
    const cold = [3, 14, 20].map((p) => {
      const x = p % 5 - 2, y = Math.floor(p / 5) - 2;
      return [a * x + b * y, c * x + d * y];
    });
    const scores = scoreOrientations(nc, { isPsr: (x, y) => cold.some(([cx, cy]) => Math.abs(x - cx) < 1e-8 && Math.abs(y - cy) < 1e-8) });
    assert.equal(scores[0].name, orientation.name); assert.equal(scores[0].iou, 1);
    assert.ok(scores[1].iou < 1); assert.equal(scores[0].samples, 25);
  }
});

test('encoding: y ascends in the source, packed rows descend; NaN depth differs from no coverage', () => {
  const nc = readNetcdfClassic(tinyNetcdf());
  const tn = readNetcdfClassic(tinyNetcdf({ z: [100, 201, 202, 203, 204, 205, 206, 207, NaN] }));
  const packed = encodeRasters(nc, tn, [1, 0, 0, 1]);
  assert.deepEqual(Array.from(packed.depth), [150, 100, 255, 74, 1, 50, 0, 13, 255]);
  assert.deepEqual(Array.from(packed.tmax), [103, 104, 255, 102, 102, 103, 50, 101, 101]);
  const mirrored = encodeRasters(nc, tn, [-1, 0, 0, 1]);
  assert.deepEqual(Array.from(mirrored.depth).slice(6), [255, 13, 0]);
  nc.variables.x.data[0] -= 0.1;
  assert.throws(() => divinerGrid(nc), /irregular|off-centre/);
});

function fixture() {
  const grid = { size: 21, kmPerPixel: 0.25, halfKm: 2.625, radiusKm: 2.8 };
  const depth = new Uint8Array(441).fill(255), tmax = new Uint8Array(441).fill(120), islands = [];
  for (const [r0, c0, value] of [[4, 4, 0], [9, 14, 30], [14, 4, 150]]) {
    const pixels = [];
    for (let r = r0; r < r0 + 3; r++) for (let c = c0; c < c0 + 3; c++) { depth[r * 21 + c] = value; pixels.push(r * 21 + c); }
    islands.push({ value, pixels });
  }
  depth[220] = 0; // one surface pixel, too small to be a science target
  tmax[200] = 255;
  const meta = { version: 1, grid, shallowMaxM: 1, patch: { minKm2: 0.5 },
    depth: { file: 'depth' }, tmax: { file: 'tmax' },
    distances: [{ cellKm: 1, size: 2, file: 'dist1' }, { cellKm: 2, size: 2, file: 'dist2' }] };
  const packs = { depth, tmax, dist1: Uint8Array.from([0, 1, 254, 255, 4, 5, 6, 7, 8, 9, 10, 11]), dist2: new Uint8Array(12) };
  const ice = createIce({ meta, read: (name) => packs[name] });
  return { ice, meta, depth, tmax, packs, islands };
}

test('ice.at: point classification, missing depth versus missing coverage, and preserved deep class', () => {
  const { ice, meta } = fixture();
  assert.equal(ice.meta, meta); assert.equal(ice.shallowMaxM, 1);
  assert.deepEqual(ice.at(-1.25, 1.25), { depthM: 0, tmaxK: 240, cls: 'surface' });
  assert.deepEqual(ice.at(1.25, 0), { depthM: 0.3, tmaxK: 240, cls: 'shallow' });
  assert.deepEqual(ice.at(-1.25, -1.25), { depthM: 1.5, tmaxK: 240, cls: 'deep' });
  assert.deepEqual(ice.at(0, 1), { depthM: null, tmaxK: 240, cls: 'none' });
  assert.equal(ice.at(0.25, 0.25), null); // temperature no data
  for (const [x, y] of [[2.5, 2.5], [4, 0], [NaN, 0], [0, Infinity], ['0', 0]]) assert.equal(ice.at(x, y), null);
});

test('patches: diagonal connectivity, actual ground area, and a custom depth can split a qualifying patch', () => {
  const grid = { size: 5, kmPerPixel: 0.25, halfKm: 0.625 };
  const depth = new Uint8Array(25).fill(255);
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) depth[r * 5 + c] = 20;
  depth[12] = 60;
  const all = icePatches(depth, grid, 1), cut = icePatches(depth, grid, 0.5);
  assert.equal(all.kept, 1); assert.equal(cut.kept, 0);
  assert.ok(all.areas[1] < 9 * 0.25 ** 2 && all.areas[1] > 0.56);
  assert.ok(cut.areas[1] < 0.5, 'eight pixels have slightly less than 0.5 km² ground area');
  const diag = new Uint8Array(25).fill(255); diag[6] = 0; diag[12] = 0; diag[18] = 0;
  const p = icePatches(diag, grid, 0, 0.1);
  assert.equal(p.patches, 1); assert.equal(p.kept, 1); assert.equal(p.labels[6], p.labels[18]);
  const meta = { version: 1, grid: { ...grid, radiusKm: 1 }, shallowMaxM: 1, patch: { minKm2: 0.5 }, depth: { file: 'd' }, tmax: { file: 't' }, distances: [] };
  const ice = createIce({ meta, read: (n) => n === 'd' ? depth : new Uint8Array(25).fill(100) });
  assert.ok(ice.nearest(0, 0, { withinKm: 1, depthMaxM: 1 }));
  assert.equal(ice.nearest(0, 0, { withinKm: 1, depthMaxM: 0.5 }), null);
});

test('ice.nearest: small patches excluded; drill-depth thresholds, any, and inclusive radius honoured', () => {
  const { ice } = fixture();
  assert.equal(ice.at(0, 0).cls, 'surface');
  assert.equal(ice.nearest(0, 0, { cls: 'surface', withinKm: 1 }), null);
  const surface = ice.nearest(0, 0, { cls: 'surface', withinKm: 2 });
  near(surface.distKm, Math.sqrt(2)); assert.equal(surface.depthM, 0); assert.ok(surface.patchKm2 >= 0.5);
  assert.deepEqual(ice.nearest(0, 0, { cls: 'surface', withinKm: surface.distKm }), surface);
  assert.equal(ice.nearest(0, 0, { cls: 'surface', withinKm: surface.distKm - 1e-8 }), null);
  assert.equal(ice.nearest(1.25, 0, { cls: 'shallow', withinKm: 0 }).depthM, 0.3);
  assert.equal(ice.nearest(1.25, 0, { cls: 'shallow', withinKm: 0.5, depthMaxM: 0.299 }), null);
  assert.equal(ice.nearest(1.25, 0, { cls: 'shallow', withinKm: 0.5, depthMaxM: 0.3 }).depthM, 0.3);
  assert.equal(ice.nearest(-1.25, -1.25, { cls: 'shallow', withinKm: 0.5 }), null);
  assert.equal(ice.nearest(-1.25, -1.25, { cls: 'any', withinKm: 0.5 }).cls, 'deep');
  assert.equal(ice.nearest(-1.25, -1.25, { cls: 'shallow', withinKm: 0.5, depthMaxM: 1.5 }).cls, 'deep');
  for (const opts of [{ cls: 'bad' }, { withinKm: -1 }, { withinKm: Infinity }, { depthMaxM: NaN }, { depthMaxM: -1 }]) assert.equal(ice.nearest(0, 0, opts), null);
  assert.equal(ice.nearest(400, 0), null);
});

test('ice.nearest: ring stopping gives the brute-force nearest eligible pixel, including off-centre queries', () => {
  const { ice, islands } = fixture();
  for (const cls of ['surface', 'shallow', 'any']) {
    const pixels = islands.filter((v) => cls === 'any' || v.value <= (cls === 'surface' ? 0 : 100)).flatMap((v) => v.pixels);
    for (let i = 0; i < 40; i++) {
      const x = -1.8 + (i % 8) * 0.47, y = -1.7 + Math.floor(i / 8) * 0.79;
      const expected = Math.min(...pixels.map((p) => Math.hypot((p % 21 - 10) * 0.25 - x, (10 - Math.floor(p / 21)) * 0.25 - y)));
      const target = ice.nearest(x, y, { cls, withinKm: 5 });
      assert.ok(target); near(target.distKm, expected);
      assert.deepEqual(ice.nearest(x, y, { cls, withinKm: 5 }), target, 'deterministic repeat');
    }
  }
});

test('distance packs: plane indexing, reserved no-data, cap, invalid indices and malformed packs', () => {
  const { ice, meta, packs } = fixture();
  assert.equal(ice.distKm(1, 0, 'surface'), 0); assert.equal(ice.distKm(1, 2, 'surface'), 254);
  assert.equal(ice.distKm(1, 3, 'surface'), null); assert.equal(ice.distKm(1, 0, 'shallow'), 4);
  assert.equal(ice.distKm(1, 2, 'any'), 10); assert.equal(ice.distKm(2, 0, 'surface'), 0);
  for (const args of [[3, 0, 'any'], [1, -1, 'any'], [1, 4, 'any'], [1, 0.5, 'any'], [1, 0, 'bad']]) assert.equal(ice.distKm(...args), null);
  assert.equal(createIce(), null);
  assert.throws(() => createIce({ meta: { ...meta, version: 99 }, read: (n) => packs[n] }), /version/);
  assert.throws(() => createIce({ meta, read: () => new Uint8Array(1) }), /invalid pack/);
});

test('distance builder: exact pixel-centre distance, majority zeros, empty targets and circular coverage', () => {
  const raster = { size: 9, kmPerPixel: 0.25, halfKm: 1.125, radiusKm: 2.7 };
  const grid = { size: 6, cellKm: 1, halfKm: 3 };
  const keep = new Uint8Array(81); keep[40] = 1;
  const distances = iceDistanceGrid(keep, raster, grid);
  for (let p = 0; p < distances.length; p++) {
    const x = p % 6 - 2.5, y = 2.5 - Math.floor(p / 6), d = Math.hypot(x, y);
    assert.equal(distances[p], d > 2.7 ? 255 : Math.max(1, Math.round(d)));
  }
  assert.ok(iceDistanceGrid(new Uint8Array(81), raster, grid).every((v) => v === 255));
  const covered = iceDistanceGrid(new Uint8Array(81).fill(1), raster, grid);
  assert.equal(covered[2 * 6 + 2], 0);
});

test('ice module remains browser-bundleable', () => {
  assert.doesNotThrow(() => bundle(new URL('../demo/src/ice.js', import.meta.url).pathname));
  assert.doesNotMatch(readFileSync(new URL('../demo/src/ice.js', import.meta.url), 'utf8'), /from ['"]node:/);
});

let ctx, ice;
function setup() {
  if (!ctx) { ctx = loadCoreContext(); ice = ctx.ice?.(); }
  assert.ok(ice, 'tracked ice packs must load');
  return { ctx, ice };
}

test('real data: context loads ice, crater floors are surface-stable and Shackleton ridge is not', (t) => {
  const start = performance.now(); setup();
  t.diagnostic(`context + first ice load ${(performance.now() - start).toFixed(1)} ms`);
  for (const [lat, lon] of [[-89.9, 129], [-87.4, -4.2]]) {
    const xy = toXY(lat, lon), p = ice.at(...xy);
    assert.equal(ctx.psr.isPsr(...xy), true); assert.equal(p.cls, 'surface'); assert.equal(p.depthM, 0);
    assert.ok(p.tmaxK < 110, `${lat},${lon}: ${p.tmaxK} K`);
  }
  const ridge = ctx.sites.find((s) => s.id === 'shackleton'), xy = toXY(ridge.latDeg, ridge.lonDeg);
  assert.notEqual(ice.at(...xy).cls, 'surface');
  const t0 = performance.now(), target = ice.nearest(...xy, { cls: 'shallow', withinKm: 5 });
  t.diagnostic(`first shallow nearest ${(performance.now() - t0).toFixed(1)} ms; ridge target ${target?.distKm.toFixed(3)} km`);
  assert.ok(target && target.distKm > 1 && target.distKm < 5); assert.ok(target.patchKm2 >= 0.5);
  for (const cellKm of [2, 1]) {
    const size = 640 / cellKm, k = Math.floor((320 - xy[1]) / cellKm) * size + Math.floor((xy[0] + 320) / cellKm);
    assert.ok(Math.abs(ice.distKm(cellKm, k, 'shallow') - target.distKm) <= 1);
  }
});

test('real data: all eight measured orientation scores have a clear winning margin', () => {
  setup();
  const { chosen, matrix, scores } = ice.meta.orientation;
  assert.equal(chosen, 'x,y'); assert.deepEqual(matrix, [1, 0, 0, 1]); assert.equal(scores.length, 8);
  for (const other of scores.slice(1)) {
    assert.ok(scores[0].agreement - other.agreement > 0.05);
    assert.ok(scores[0].iou - other.iou > 0.3);
  }
  for (const s of scores) {
    assert.ok(s.samples > 5e6); assert.equal(s.samples, s.tp + s.tn + s.fp + s.fn);
    near(s.agreement, (s.tp + s.tn) / s.samples); near(s.iou, s.tp / (s.tp + s.fp + s.fn));
  }
});

const rawAvailable = ['polar_south_80_zit-1.grd', 'polar_south_80_Tmax.grd'].every((n) => existsSync(new URL(n, RAW)));
test('real raw data: parsed headers, recomputed orientation and all raster bytes match the tracked packs', { skip: !rawAvailable }, () => {
  setup();
  const nc = ice.meta.sources.map((s) => {
    const file = readFileSync(new URL(s.file, RAW));
    assert.equal(createHash('sha256').update(file).digest('hex'), s.sha256);
    const parsed = readNetcdfClassic(file);
    assert.equal(parsed.variables.z.offset, 40796); assert.equal(parsed.variables.z.byteSize, 25664356);
    assert.deepEqual(parsed.variables.z.shape, [2533, 2533]);
    return parsed;
  });
  assert.deepEqual(scoreOrientations(nc[1], ctx.psr), ice.meta.orientation.scores);
  const packed = encodeRasters(nc[0], nc[1], ice.meta.orientation.matrix);
  assert.ok(read(ice.meta.depth.file).equals(packed.depth)); assert.ok(read(ice.meta.tmax.file).equals(packed.tmax));
});

test('real packs: default shallow equals any, distances match exact cell-centre searches and north is no-data', () => {
  setup();
  for (const pack of ice.meta.distances) {
    const b = read(pack.file), n = pack.size ** 2;
    assert.equal(b.length, 3 * n); assert.deepEqual(b.subarray(n, 2 * n), b.subarray(2 * n));
    for (const [x, y] of [[-11, -13], [65, 143], [0, 79], [200, -180], [-200, -180]]) {
      const c = Math.floor((x + 320) / pack.cellKm), r = Math.floor((320 - y) / pack.cellKm), k = r * pack.size + c;
      const cx = -320 + (c + 0.5) * pack.cellKm, cy = 320 - (r + 0.5) * pack.cellKm;
      for (const cls of ['surface', 'shallow', 'any']) {
        const d = ice.distKm(pack.cellKm, k, cls), target = ice.nearest(cx, cy, { cls, withinKm: 100 });
        assert.ok(target); if (d !== 0) assert.equal(d, Math.max(1, Math.round(target.distKm)));
      }
    }
    for (let k = 0; k < n; k++) {
      const x = -320 + (k % pack.size + 0.5) * pack.cellKm, y = 320 - (Math.floor(k / pack.size) + 0.5) * pack.cellKm;
      if (Math.hypot(x, y) > ice.meta.grid.radiusKm) for (let plane = 0; plane < 3; plane++) assert.equal(b[plane * n + k], 255);
    }
  }
  assert.equal(ice.at(...toXY(-79.99, 45)), null);
});

test('point-eval integration: Diviner supplies a finite science target at 84.82°S 24.44°E', (t) => {
  setup();
  const start = performance.now();
  const result = staticMetrics({ coarse: ctx.coarse, psr: ctx.psr, nasa: ctx.nasa, ice },
    { latDeg: -84.82, lonDeg: 24.44 }, { ice: { class: 'shallow', within_km: 5 } });
  assert.equal(result.ice_source, 'diviner'); assert.ok(Number.isFinite(result.ice_target_km));
  assert.ok(result.ice_target_km <= 5); assert.ok(result.ice_target.depthM <= 1);
  assert.ok(result.ice_target.patchKm2 >= 0.5);
  t.diagnostic(`staticMetrics ${(performance.now() - start).toFixed(3)} ms; target ${result.ice_target_km.toFixed(3)} km`);
});

test('point_facts integration: the existing tool exposes Diviner temperatures, classes and nearby targets', async () => {
  setup();
  const core = createCoreTools(ctx);
  const ridge = await core.run('point_facts', { site_id: 'shackleton' });
  assert.ok(!ridge.error); assert.equal(ridge.ice.here.stability, 'none');
  assert.equal(ridge.ice.here.iceTableDepthM, null); assert.equal(ridge.ice.here.tmaxK, 210);
  assert.equal(ridge.ice.nearestShallowStable.km, 2.2);
  assert.match(ridge.about.resolution.ice, /Diviner/);
  const floor = await core.run('point_facts', { lat_deg: -89.9, lon_deg: 129 });
  assert.equal(floor.ice.here.stability, 'surface'); assert.equal(floor.ice.here.iceTableDepthM, 0);
  assert.ok(floor.ice.here.tmaxK < 110);
  assert.deepEqual(await core.run('point_facts', { site_id: 'shackleton' }), ridge);
});
