// Offline Diviner pack builder (package D): parse the local GMT netCDF-classic files, determine their
// orientation against the LOLA PSR bitmap, and write only ice.json plus its four packs in demo/data/.
// Run: node tools/build-ice.mjs. No downloads, dependencies or hard-coded netCDF offsets.
// Exports the reader, orientation scoring and packing functions for focused synthetic / real-data tests.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createPsr } from '../demo/src/psr.js';
import { icePatches } from '../demo/src/ice.js';
import { shadowGrid } from './build-static.mjs';

const DATA = new URL('../demo/data/', import.meta.url);
const RAW = new URL('../data-raw/diviner/', import.meta.url);
const R = 1737.4, RADIUS = 2 * R * Math.tan(5 * Math.PI / 180);
const SOURCE = 'https://luna1.diviner.ucla.edu/~jpierre/diviner/level4_polar/24x6_240m/additional_maps/';
const CITATION = 'Schorghofer, N. & Williams, J.-P. (2020), Mapping of ice storage processes on the Moon with time-dependent temperatures, PSJ 1:54, doi:10.3847/PSJ/abb6ff';

// Fixed-size CDF-1 numeric variables and attributes, with big-endian decoding and four-byte padding.
// Record variables, CDF-2/5 and HDF5 are deliberately rejected rather than misread as classic grids.
export function readNetcdfClassic(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const need = (n) => { if (!Number.isSafeInteger(n) || n < 0 || pos + n > b.length) throw new Error('netCDF: truncated file'); };
  const u32 = () => { need(4); const v = b.readUInt32BE(pos); pos += 4; return v; };
  const text = () => {
    const n = u32(); need(Math.ceil(n / 4) * 4);
    const s = b.toString('utf8', pos, pos + n); pos += Math.ceil(n / 4) * 4; return s;
  };
  const sizes = [0, 1, 1, 2, 4, 4, 8];
  function values(type, n, offset) {
    if (!sizes[type]) throw new Error(`netCDF: unsupported type ${type}`);
    if (!Number.isSafeInteger(n) || n < 0 || offset + sizes[type] * n > b.length) throw new Error('netCDF: truncated variable');
    if (type === 2) return b.toString('utf8', offset, offset + n).replace(/\0+$/, '');
    const out = type === 5 ? new Float32Array(n) : new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = offset + i * sizes[type];
      out[i] = type === 1 ? b.readInt8(p) : type === 3 ? b.readInt16BE(p) : type === 4 ? b.readInt32BE(p)
        : type === 5 ? b.readFloatBE(p) : b.readDoubleBE(p);
    }
    return out;
  }
  function list(tag, item) {
    const actual = u32(), n = u32();
    if (actual === 0 && n === 0) return [];
    if (actual !== tag || n > b.length / 8) throw new Error(`netCDF: invalid list tag ${actual}`);
    return Array.from({ length: n }, item);
  }
  const attrs = () => Object.fromEntries(list(12, () => {
    const name = text(), type = u32(), n = u32(), v = values(type, n, pos);
    const length = Math.ceil(sizes[type] * n / 4) * 4; need(length); pos += length;
    return [name, type === 2 ? v : n === 1 ? v[0] : Array.from(v)];
  }));
  need(8);
  if (b.toString('latin1', 0, 4) !== 'CDF\x01') throw new Error('netCDF: expected CDF-1 classic');
  pos = 4;
  if (u32() !== 0) throw new Error('netCDF: record variables are unsupported');
  const dimensions = list(10, () => ({ name: text(), size: u32() }));
  const attributes = attrs();
  const variables = Object.fromEntries(list(11, () => {
    const name = text(), rank = u32(); need(rank * 4);
    const ids = Array.from({ length: rank }, u32);
    if (ids.some((id) => !dimensions[id] || dimensions[id].size === 0)) throw new Error('netCDF: invalid or unlimited dimension');
    const attributes = attrs(), type = u32(), byteSize = u32(), offset = u32();
    const shape = ids.map((id) => dimensions[id].size), n = shape.reduce((a, v) => a * v, 1);
    if (!sizes[type] || byteSize < n * sizes[type]) throw new Error('netCDF: invalid variable size');
    return [name, { dimensions: ids.map((id) => dimensions[id].name), shape, type, attributes, byteSize, offset,
      data: values(type, n, offset) }];
  }));
  for (const v of Object.values(variables)) if (v.offset < pos || v.offset % 4) throw new Error('netCDF: variable overlaps header or is unaligned');
  return { dimensions, attributes, variables };
}

export const ORIENTATIONS = [
  { name: 'x,y', matrix: [1, 0, 0, 1] }, { name: 'x,-y', matrix: [1, 0, 0, -1] },
  { name: '-x,y', matrix: [-1, 0, 0, 1] }, { name: '-x,-y', matrix: [-1, 0, 0, -1] },
  { name: 'y,x', matrix: [0, 1, 1, 0] }, { name: 'y,-x', matrix: [0, 1, -1, 0] },
  { name: '-y,x', matrix: [0, -1, 1, 0] }, { name: '-y,-x', matrix: [0, -1, -1, 0] },
];

// Score every finite Tmax pixel within 80°S, not just the cold subset. IoU avoids the large warm/non-PSR
// majority overwhelming alignment evidence; raw agreement and the full confusion matrix are also saved.
export function scoreOrientations(tmax, psr) {
  const { x, y, z } = tmax.variables, scores = [];
  for (const { name, matrix: [a, b, c, d] } of ORIENTATIONS) {
    let tp = 0, tn = 0, fp = 0, fn = 0;
    for (let r = 0; r < y.data.length; r++) {
      const sy = y.data[r] * R;
      for (let col = 0; col < x.data.length; col++) {
        const t = z.data[r * x.data.length + col], sx = x.data[col] * R;
        if (!Number.isFinite(t) || sx * sx + sy * sy > RADIUS * RADIUS) continue;
        const cold = t < 110, shadow = psr.isPsr(a * sx + b * sy, c * sx + d * sy);
        if (cold && shadow) tp++; else if (cold) fp++; else if (shadow) fn++; else tn++;
      }
    }
    const samples = tp + tn + fp + fn;
    scores.push({ name, matrix: [a, b, c, d], samples, tp, tn, fp, fn,
      agreement: (tp + tn) / samples, iou: tp / (tp + fp + fn),
      balancedAgreement: (tp / (tp + fn) + tn / (tn + fp)) / 2 });
  }
  return scores.sort((a, b) => b.iou - a.iou);
}

export function divinerGrid(nc) {
  const { x, y, z } = nc.variables;
  if (nc.attributes.node_offset !== 1 || !x || !y || !z || x.type !== 6 || y.type !== 6 || z.type !== 5 ||
      z.dimensions.join(',') !== 'y,x' || x.dimensions.join(',') !== 'x' || y.dimensions.join(',') !== 'y' ||
      x.data.length !== y.data.length || x.data.length < 2) throw new Error('Diviner: expected square pixel-registered x/y/z grid');
  const size = x.data.length, step = (x.data[size - 1] - x.data[0]) / (size - 1);
  if (!(step > 0)) throw new Error('Diviner: axes must ascend');
  for (let i = 0; i < size; i++) {
    const expected = (i - (size - 1) / 2) * step;
    if (Math.abs(x.data[i] - expected) > 1e-10 || Math.abs(y.data[i] - expected) > 1e-10) throw new Error('Diviner: irregular or off-centre axes');
  }
  return { size, kmPerPixel: step * R, halfKm: size * step * R / 2, radiusKm: RADIUS,
    projection: 'South polar stereographic; R = 1737.4 km; 0°E = +y, 90°E = +x',
    registration: 'pixel centres; row 0 at +y, column 0 at -x', maxLatDeg: -80 };
}

// Reorient without interpolation. NaN depth inside the cap means no stable ice within modelled depth;
// missing temperature or a pixel centre north of 80°S is no data for both packs.
export function encodeRasters(depthNc, tmaxNc, matrix) {
  const grid = divinerGrid(depthNc), tg = divinerGrid(tmaxNc);
  if (grid.size !== tg.size || Math.abs(grid.kmPerPixel - tg.kmPerPixel) > 1e-9) throw new Error('Diviner: depth and temperature grids differ');
  const n = grid.size, o = (n - 1) / 2, s = grid.kmPerPixel, [a, b, c, d] = matrix;
  const depth = new Uint8Array(n * n).fill(255), tmax = new Uint8Array(n * n).fill(255);
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
    const x = col - o, y = r - o, mx = a * x + b * y, my = c * x + d * y;
    if ((mx * mx + my * my) * s * s > RADIUS * RADIUS) continue;
    const p = Math.round(o - my) * n + Math.round(mx + o), src = r * n + col;
    const t = tmaxNc.variables.z.data[src], z = depthNc.variables.z.data[src];
    if (!Number.isFinite(t)) continue;
    if (t < 0 || t > 508 || (Number.isFinite(z) && (z < 0 || z > 2.54))) throw new Error('Diviner: value outside pack encoding');
    tmax[p] = Math.round(t / 2);
    if (Number.isFinite(z)) depth[p] = z === 0 ? 0 : Math.max(1, Math.ceil(z * 100));
  }
  return { grid, depth, tmax };
}

// Use the existing exact Euclidean shadow-grid transform; only qualifying patches may give a zero.
// 254 is the distance cap, reserving 255 exclusively for missing coverage / no qualifying target.
export function iceDistanceGrid(keep, raster, cellGrid) {
  const { out } = shadowGrid(keep, keep, raster.size, raster.kmPerPixel, cellGrid);
  const any = keep.some((v) => v !== 0);
  const { size, cellKm, halfKm } = cellGrid;
  for (let k = 0; k < out.length; k++) {
    const x = -halfKm + (k % size + 0.5) * cellKm, y = halfKm - (Math.floor(k / size) + 0.5) * cellKm;
    if (!any || x * x + y * y > raster.radiusKm * raster.radiusKm) out[k] = 255;
    else out[k] = Math.min(254, out[k]);
  }
  return out;
}

export function buildIce() {
  const started = performance.now();
  const files = ['polar_south_80_zit-1.grd', 'polar_south_80_Tmax.grd'];
  const raw = files.map((name) => readFileSync(new URL(name, RAW)));
  const [depthNc, tmaxNc] = raw.map(readNetcdfClassic);
  divinerGrid(depthNc); divinerGrid(tmaxNc);
  const terrain = JSON.parse(readFileSync(new URL('terrain.json', DATA), 'utf8'));
  const psr = createPsr(readFileSync(new URL(terrain.psr.file, DATA)), terrain.psr);
  const scores = scoreOrientations(tmaxNc, psr), chosen = scores[0];
  console.table(scores.map(({ name, agreement, iou, balancedAgreement }) => ({ name, agreement, iou, balancedAgreement })));
  if (!(chosen.iou - scores[1].iou > 0.05)) throw new Error('Diviner: orientation is ambiguous (IoU margin ≤ 0.05)');
  const { grid, depth, tmax } = encodeRasters(depthNc, tmaxNc, chosen.matrix);
  const grids = [2, 1].map((cellKm) => ({ file: `ice_dist_${cellKm}km.bin`, cellKm, size: 640 / cellKm, halfKm: 320 }));
  const packs = grids.map((g) => new Uint8Array(g.size * g.size * 3));
  const patchStats = {};
  let allKeep = null;
  for (let plane = 0; plane < 3; plane++) {
    const cls = ['surface', 'shallow', 'any'][plane];
    let keep;
    if (cls === 'any' && allKeep) { keep = allKeep; patchStats.any = { ...patchStats.shallow }; }
    else {
      const p = icePatches(depth, grid, cls === 'surface' ? 0 : cls === 'shallow' ? 1 : Infinity);
      keep = Uint8Array.from(p.labels, (id) => id && p.areas[id] >= 0.5 ? 1 : 0);
      patchStats[cls] = { patches: p.patches, kept: p.kept, pixels: keep.reduce((sum, v) => sum + v, 0) };
      if (cls === 'shallow' && !depth.some((d) => d !== 255 && d > 100)) allKeep = keep;
    }
    grids.forEach((g, i) => packs[i].set(iceDistanceGrid(keep, grid, g), plane * g.size * g.size));
  }
  const meta = {
    version: 1, source: 'UCLA Diviner level4_polar/24x6_240m/additional_maps', citation: CITATION,
    doi: 'https://doi.org/10.3847/PSJ/abb6ff', buildDate: '2026-11-15',
    sources: files.map((file, i) => ({ file, url: SOURCE + file, bytes: raw[i].length,
      sha256: createHash('sha256').update(raw[i]).digest('hex') })),
    rule: 'Thermally stable, possible ice: zit-1 is depth in m at which sublimation loss falls to 1 kg/m²/Gyr. Tmax is Fourier-smoothed maximum temperature, used for orientation and display, not classification.',
    classes: { surface: 'depth = 0', shallow: 'depth ≤ depthMaxM (default 1 m), surface included', any: 'any finite depth' },
    shallowMaxM: 1, grid, resolution: '240 m raster; 1 cm conservative depth bins; 2 K temperature bins; 1 km / 2 km distance grids',
    orientation: { chosen: chosen.name, matrix: chosen.matrix, mapping: '[mapX,mapY] = matrix × [sourceX,sourceY] × 1737.4 km',
      method: 'All finite Tmax pixel centres within 80°S; Tmax < 110 K versus LOLA 120 m PSR. Highest intersection-over-union (IoU).',
      reference: terrain.psr.file, scores },
    depth: { file: 'ice_depth_240m.bin', encoding: 'Uint8, row-major: 0 = surface, 1–254 = ceil(depth in cm), 255 = no stable ice within modelled depth / no data', noData: 255 },
    tmax: { file: 'ice_tmax_240m.bin', encoding: 'Uint8, row-major: byte = round(Tmax / 2); decoded kelvin = byte × 2; 255 = no data', noData: 255 },
    distances: grids.map((g) => ({ ...g, encoding: 'Uint8 planes: surface, shallow (≤ 1 m), any; rounded map-plane km', capKm: 254, noData: 255 })),
    patch: { minKm2: 0.5, connectivity: 8, area: 'Sum of pixel ground areas: stepKm² / (1 + (x²+y²)/(4R²))²',
      distanceRule: 'Nearest qualifying pixel centre; 0 only if qualifying pixels cover > half the cell by pixel-centre count; otherwise rounded, at least 1 km. 254 = capped distance; 255 = outside coverage or no qualifying target.', stats: patchStats },
    limits: ['Thermally stable, possible ice; thermal modelling does not establish abundance or composition.',
      'A first-look screen, not a certified landing analysis.',
      'NaN depth inside coverage means no stable ice within modelled depth; it does not rule out deeper ice.',
      'Depth is rounded up to cm, so non-default drill limits can conservatively exclude a sub-cm boundary bin.',
      'Tmax is rounded to 2 K; use raw Tmax for the 110 K orientation threshold.',
      'Distances are straight lines in the map plane, not traversability or driving distance.',
      'Patches are clipped to the 80°S coverage boundary. Shallow (1 m) and any coincide in this source (maximum depth below 0.73 m).'],
  };
  const write = (name, content) => {
    const path = new URL(name, DATA), bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
    if (existsSync(path) && readFileSync(path).equals(bytes)) return;
    writeFileSync(path, bytes);
  };
  write(meta.depth.file, depth); write(meta.tmax.file, tmax);
  grids.forEach((g, i) => write(g.file, packs[i]));
  write('ice.json', JSON.stringify(meta, null, 2) + '\n');
  console.log(`Built thermally stable, possible ice packs in ${(performance.now() - started).toFixed(0)} ms; orientation ${chosen.name}`);
  console.log(JSON.stringify(patchStats));
  return meta;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) buildIce();
