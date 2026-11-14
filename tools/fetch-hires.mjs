// High-resolution terrain patches for the descent view and the globe.
//
// Site mode (the default, unchanged): for each site in demo/data/sites.json south of 80°S, a square patch
// (default 10 × 10 km) is cut from the finest LOLA polar product that covers it: LDEM_875S_5M (5 m, 87.5°S–90°S),
// LDEM_85S_10M (10 m, 85°S–90°S) or LDEM_80S_20M (20 m, 80°S–90°S).
//
// --at lat,lon: one patch anywhere, from the finest official product that covers the whole patch:
//   south   the three south polar products above, then LDEM_75S_30M (30 m, 75°S–90°S), LDEM_60S_60M (60 m, 60°S–90°S)
//   north   the north polar twins: LDEM_875N_5M, LDEM_85N_10M, LDEM_80N_20M, LDEM_75N_30M, LDEM_60N_60M
//   60°S–60°N  SLDEM2015 (LOLA merged with SELENE/Kaguya Terrain Camera), 512 px/deg (59 m), 30° × 45° tiles
//   A patch that crosses ±60° (neither SLDEM2015 nor a 60 m polar product holds all of it) is refused with
//   the finest global option named (LOLA LDEM_1024, not read here), exit status 1.
// Only the byte ranges of the rows inside the patch are downloaded (HTTP Range), never the 1.4–1.9 GB files.
//
// Polar products are polar stereographic about the pole with the pole at pixel (size/2 − 0.5): col = x/kpp + c,
// row = c − y/kpp (map km), as terrain.js createDem; x, y from terrain.js toXY (south) or globe-terrain.js
// toXYNorth (north: x = r sin λ, y = −r cos λ). Their samples are already Int16 DN × 0.5 m above 1737.4 km.
// SLDEM2015 samples are float32 heights in km above the same 1737.4 km sphere, in the same DE421 mean
// Earth/polar axis frame; they become DN = round(km × 1000 / 0.5) (kmToDn), so every pack stacks with the others.
//
// Sources, checked 14 Nov 2026 on the PDS Geosciences Node (LRO LOLA volume LROLOL_1XXX,
// https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/):
//   lola_gdr/polar/img/ listing: ldem_{875,85,80,75,60}{s,n}_{5,10,20,30,60}m.img (and coarser twins), 1.84–1.93 GB.
//   Labels ldem_875s_5m.lbl, ldem_875n_5m.lbl, ldem_85n_10m.lbl, ldem_80n_20m.lbl, ldem_75{s,n}_30m.lbl,
//   ldem_60{s,n}_60m.lbl: MAP_PROJECTION_TYPE "POLAR STEREOGRAPHIC" (sphere 1737.4 km, true scale at the pole),
//   SAMPLE_TYPE LSB_INTEGER, SAMPLE_BITS 16, SCALING_FACTOR 0.5, OFFSET 1737400 (m), LINES = LINE_SAMPLES = size
//   (5 m and 10 m 30336, 20 m 30400, 30 m 30496, 60 m 31040), LINE_PROJECTION_OFFSET = SAMPLE_PROJECTION_OFFSET =
//   size/2 − 0.5. North and south labels differ only in CENTER_LATITUDE (+90 / −90) and the latitude limits.
//   sldem2015/tiles/float_img/ listing: sldem2015_512_{30n_60n,00n_30n,30s_00s,60s_30s}_{000_045 … 315_360}_float.img,
//   32 tiles of 1 415 577 600 bytes (also 256 px/deg tiles there and a 128 px/deg file in sldem2015/global/float_img/).
//   Labels sldem2015_512_00n_30n_000_045_float.lbl and sldem2015_512_60s_30s_315_360_float.lbl: "SIMPLE CYLINDRICAL",
//   MAP_RESOLUTION 512 <pix/deg>, MAP_SCALE 0.0592252938 <km/pix>, LINES 15360, LINE_SAMPLES 23040, SAMPLE_TYPE PC_REAL
//   (little-endian), SAMPLE_BITS 32, UNIT KILOMETER, SCALING_FACTOR 1, OFFSET 1737.4, pixel registered:
//   LINE_PROJECTION_OFFSET = MAXIMUM_LATITUDE × 512 − 0.5, SAMPLE_PROJECTION_OFFSET = (180 − WESTERNMOST_LONGITUDE) × 512
//   − 0.5 with CENTER_LONGITUDE 180, so tile pixel (row, col) is centred at lat MAXIMUM_LATITUDE − (row + 0.5)/512,
//   lon WESTERNMOST_LONGITUDE + (col + 0.5)/512. No missing-data constant is declared.
//   lola_gdr/cylindrical/img/ listing: ldem_1024_* (15° × 30° tiles, all latitudes) is the finest global LOLA grid.
//
// Single-pixel spikes are smoothed (despike, below; the count is in the manifest).
// Writes data-raw/hires/<id>.bin (the patch as Int16 DN, a cache), demo/data/js/hires_<id>.js (data pack:
// delta-coded Int16 + gzip, as tools/build-global.mjs) and demo/data/hires.json (the manifest):
//   sites[id]    south polar stereographic, exactly as before (demo/src/hires.js createPatch reads these):
//                { pack, product, kmPerPixel, n, xMin, yMax, halfKm, latDeg, lonDeg, despikedPixels, despikeM, packBytes },
//                n × n pixels centred at xMin + (i + 0.5)·kpp, yMax − (j + 0.5)·kpp in toXY map km.
//   patches[id]  every other projection, kept out of `sites` because all readers of `sites` (hires.js,
//                globe-mapped.js, lander/terrain-local.js) take its entries as south polar map km:
//     npolar     { pack, product, projection: 'npolar', kmPerPixel, n, xMin, yMax, dnToMeters, halfKm, latDeg,
//                lonDeg, despikedPixels, despikeM, packBytes }: as sites, in toXYNorth map km.
//     equirect   { pack, product: 'sldem2015_512', projection: 'equirect', files, ppd, width, height, latMin, latMax,
//                lonMin, lonMax, kmPerPixel (along a meridian), dnToMeters, halfKm, latDeg, lonDeg, despikedPixels,
//                despikeM, packBytes }: width × height pixels, row 0 northmost, pixel (i, j) centred at lat
//                latMax − (j + 0.5)/ppd, lon lonMin + (i + 0.5)/ppd; lonMax passes 360 when the patch crosses 0°.
// Usage: node tools/fetch-hires.mjs [--half-km 5] [site ids…]
//        node tools/fetch-hires.mjs --at lat,lon [--id name] [--half-km 5]     (lon east, −180…360)
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { encodePack } from './build-global.mjs';
import { toXY } from '../demo/src/terrain.js';
import { toXYNorth, normLon, MOON_R_KM } from '../demo/src/globe-terrain.js';

const PDS = 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data';
const IMG = `${PDS}/lola_gdr/polar/img`;
export const PRODUCTS = [
  { name: 'ldem_875s_5m', kmPerPixel: 0.005, size: 30336, maxLatDeg: -87.5 },
  { name: 'ldem_85s_10m', kmPerPixel: 0.01, size: 30336, maxLatDeg: -85 },
  { name: 'ldem_80s_20m', kmPerPixel: 0.02, size: 30400, maxLatDeg: -80 },
];
// Coarser south polar products, for --at only (the site list keeps to PRODUCTS).
export const SOUTH_COARSE = [
  { name: 'ldem_75s_30m', kmPerPixel: 0.03, size: 30496, maxLatDeg: -75 },
  { name: 'ldem_60s_60m', kmPerPixel: 0.06, size: 31040, maxLatDeg: -60 },
];
export const NORTH_PRODUCTS = [
  { name: 'ldem_875n_5m', kmPerPixel: 0.005, size: 30336, minLatDeg: 87.5 },
  { name: 'ldem_85n_10m', kmPerPixel: 0.01, size: 30336, minLatDeg: 85 },
  { name: 'ldem_80n_20m', kmPerPixel: 0.02, size: 30400, minLatDeg: 80 },
  { name: 'ldem_75n_30m', kmPerPixel: 0.03, size: 30496, minLatDeg: 75 },
  { name: 'ldem_60n_60m', kmPerPixel: 0.06, size: 31040, minLatDeg: 60 },
];
const SLDEM_BANDS = ['30n_60n', '00n_30n', '30s_00s', '60s_30s'];   // tile rows from the north
const deg3 = (d) => String(d).padStart(3, '0');
export const SLDEM = Object.freeze({
  name: 'sldem2015_512', base: `${PDS}/sldem2015/tiles/float_img`, ppd: 512, latMax: 60, latMin: -60,
  tileRows: 15360, tileCols: 23040, kmPerPixel: 0.0592252938,
  file: (band, tc) => `sldem2015_512_${SLDEM_BANDS[band]}_${deg3(45 * tc)}_${deg3(45 * (tc + 1))}_float.img`,
});
export const GLOBAL_FINEST = `LOLA LDEM_1024 (1024 px/deg, about 30 m; 15° × 30° tiles ldem_1024_*.img in ${PDS}/lola_gdr/cylindrical/img/)`;
export const DN_M = 0.5;
const RAD = Math.PI / 180, KM_PER_DEG = MOON_R_KM * RAD;
const DATA = new URL('../demo/data/', import.meta.url);
const RAW = new URL('../data-raw/hires/', import.meta.url);

// Whether a polar product's square and latitude limit hold a patch of ±halfKm around (x, y) (map km).
function covers(p, x, y, halfKm) {
  const edge = (p.size * p.kmPerPixel) / 2;
  if (!(Math.abs(x) + halfKm < edge && Math.abs(y) + halfKm < edge)) return false;
  // inside the product's latitude limit too (its square corners reach further than its circle)
  const r = Math.hypot(Math.abs(x) + halfKm, Math.abs(y) + halfKm);
  const rMax = 2 * 1737.4 * Math.tan(((90 - Math.abs(p.maxLatDeg ?? p.minLatDeg)) / 2) * Math.PI / 180);
  return r < rMax;
}

// The finest product of `list` (finest first) whose square covers a patch of ±halfKm around (x, y), or null.
export function productFor(x, y, halfKm, list = PRODUCTS) {
  return list.find((p) => covers(p, x, y, halfKm)) ?? null;
}

// Pixel window of the patch in a product: { c0, r0, n } (n × n pixels), and its outer edges in map km.
export function patchWindow(p, x, y, halfKm) {
  const c = p.size / 2 - 0.5, n = Math.round((2 * halfKm) / p.kmPerPixel);
  const c0 = Math.round((x - halfKm) / p.kmPerPixel + c + 0.5), r0 = Math.round(c - (y + halfKm) / p.kmPerPixel + 0.5);
  const xMin = (c0 - 0.5 - c) * p.kmPerPixel, yMax = (c - (r0 - 0.5)) * p.kmPerPixel;
  return { c0, r0, n, xMin, yMax, xMax: xMin + n * p.kmPerPixel, yMin: yMax - n * p.kmPerPixel };
}

// Pixel window of a ±halfKm patch in an equirectangular product seen as one grid of 360·ppd columns from
// lon 0 and rows from prod.latMax down. width follows the latitude (a column is cos φ narrower). r0, c0: the
// top-left pixel (c0 wrapped into 0…360·ppd); row, col: the pixel holding (lat, lon); outer edges in degrees.
export function equirectWindow(prod, latDeg, lonDeg, halfKm) {
  const ppd = prod.ppd, cols = 360 * ppd;
  const height = Math.max(1, Math.round((2 * halfKm * ppd) / KM_PER_DEG));
  const width = Math.max(1, Math.round((2 * halfKm * ppd) / (KM_PER_DEG * Math.cos(latDeg * RAD))));
  const u = (prod.latMax - latDeg) * ppd, v = normLon(lonDeg) * ppd;
  const r0 = Math.round(u - height / 2), c0 = ((Math.round(v - width / 2) % cols) + cols) % cols;
  const latMax = prod.latMax - r0 / ppd, lonMin = c0 / ppd;
  return { r0, c0, width, height, row: Math.floor(u), col: Math.floor(v) % cols, latMax, latMin: latMax - height / ppd, lonMin, lonMax: lonMin + width / ppd };
}

// The tile file and in-tile pixel of a whole-grid pixel (row, col) of a tiled equirectangular product.
export function equirectTileOf(prod, row, col) {
  const band = Math.floor(row / prod.tileRows), tc = Math.floor(col / prod.tileCols);
  return { file: prod.file(band, tc), row: row - band * prod.tileRows, col: col - tc * prod.tileCols };
}

// The reads for a window: one { file, row, col, count, outRow, outCol } per row and tile it touches (a row
// splits where it crosses a tile edge, including the wrap from lon 360 to 0).
export function equirectRanges(prod, w) {
  const cols = 360 * prod.ppd, out = [];
  for (let j = 0; j < w.height; j++) {
    for (let c = w.c0, i = 0; i < w.width;) {
      const t = equirectTileOf(prod, w.r0 + j, c), count = Math.min(w.width - i, prod.tileCols - t.col);
      out.push({ ...t, count, outRow: j, outCol: i });
      i += count; c = (c + count) % cols;
    }
  }
  return out;
}

// SLDEM2015 height (km above 1737.4 km) → Int16 DN of 0.5 m above 1737.4 km, like the LOLA products.
export function kmToDn(km) {
  if (!Number.isFinite(km)) throw new Error(`not a height: ${km}`);
  return Math.max(-32768, Math.min(32767, Math.round((km * 1000) / DN_M)));
}
// Little-endian float32 km (PC_REAL) bytes → Int16Array DN.
export function floatKmBytesToDn(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = new Int16Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = kmToDn(dv.getFloat32(4 * i, true));
  return out;
}

const fmtLat = (d) => `${Math.abs(d).toFixed(2)}°${d < 0 ? 'S' : 'N'}`;
// The product for a ±halfKm patch at (lat, lon), finest first. → { projection: 'spolar' | 'npolar', product,
// x, y } (map km) or { projection: 'equirect', product: SLDEM, window }. Throws where none covers it.
export function selectProduct(latDeg, lonDeg, halfKm = 5) {
  if (!(Math.abs(latDeg) <= 90) || !Number.isFinite(lonDeg)) throw new RangeError(`not a position: ${latDeg}, ${lonDeg}`);
  if (!(halfKm > 0)) throw new RangeError(`not a patch size: ${halfKm}`);
  const lon = normLon(lonDeg);
  if (latDeg < 0) {
    const [x, y] = toXY(latDeg, lon), p = productFor(x, y, halfKm) ?? productFor(x, y, halfKm, SOUTH_COARSE);
    if (p) return { projection: 'spolar', product: p, x, y };
  } else {
    const [x, y] = toXYNorth(latDeg, lon), p = productFor(x, y, halfKm, NORTH_PRODUCTS);
    if (p) return { projection: 'npolar', product: p, x, y };
  }
  const w = equirectWindow(SLDEM, latDeg, lon, halfKm);
  if (w.r0 >= 0 && w.r0 + w.height <= (SLDEM.latMax - SLDEM.latMin) * SLDEM.ppd) return { projection: 'equirect', product: SLDEM, window: w };
  throw new Error(`no fine product covers a ±${halfKm} km patch at ${fmtLat(latDeg)} ${lon.toFixed(2)}°E: SLDEM2015 (59 m) stops at ±60° `
    + `and the LOLA polar products (60 m at their widest) start there, so a patch across ±60° is in neither. The finest global option is `
    + `${GLOBAL_FINEST}, which this tool does not read; use a smaller --half-km or move the centre off ±60°.`);
}

// Isolated outliers: a pixel more than thresholdM from the median of its 8 neighbours takes that median.
// LOLA gridded products interpolate between laser tracks, and the few single-pixel spikes this leaves show as
// needles once the relief is exaggerated. n is the row width (rows = data.length / n). → { data (a copy), replaced }
export function despike(data, n, thresholdM, dnToMeters = 0.5) {
  const out = Int16Array.from(data), lim = thresholdM / dnToMeters, nb = new Int16Array(8), rows = data.length / n;
  let replaced = 0;
  for (let j = 1; j < rows - 1; j++) for (let i = 1; i < n - 1; i++) {
    const k = j * n + i;
    nb[0] = data[k - 1]; nb[1] = data[k + 1]; nb[2] = data[k - n]; nb[3] = data[k + n];
    nb[4] = data[k - n - 1]; nb[5] = data[k - n + 1]; nb[6] = data[k + n - 1]; nb[7] = data[k + n + 1];
    nb.sort();
    const med = Math.round((nb[3] + nb[4]) / 2);
    if (Math.abs(data[k] - med) > lim) { out[k] = med; replaced++; }
  }
  return { data: out, replaced };
}
// The despike threshold for a product: 10 m at 5 m pixels, scaling with the pixel size.
export const despikeM = (kmPerPixel) => 10 * (kmPerPixel / 0.005);

async function getRange(url, from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
      if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
      const b = new Uint8Array(await res.arrayBuffer());
      if (b.length !== to - from + 1) throw new Error(`${b.length} bytes, expected ${to - from + 1}`);
      return b;
    } catch (e) {
      if (attempt >= 6) throw e;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

// Runs fn(k) for k = 0…count−1, `concurrency` at a time.
async function pool(count, concurrency, fn) {
  let next = 0;
  async function worker() { for (let k = next++; k < count; k = next++) await fn(k); }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function fetchPatch(p, w, { concurrency = 16, onRow = () => {} } = {}) {
  const url = `${IMG}/${p.name}.img`, rowBytes = p.size * 2, out = new Int16Array(w.n * w.n);
  let done = 0;
  await pool(w.n, concurrency, async (j) => {
    const from = (w.r0 + j) * rowBytes + w.c0 * 2;
    const b = await getRange(url, from, from + w.n * 2 - 1);
    out.set(new Int16Array(b.buffer, b.byteOffset, w.n), j * w.n);
    onRow(++done);
  });
  return out;
}

async function fetchEquirect(prod, w, { concurrency = 16, onRead = () => {} } = {}) {
  const reads = equirectRanges(prod, w), out = new Int16Array(w.width * w.height);
  let done = 0;
  await pool(reads.length, concurrency, async (k) => {
    const s = reads[k], from = (s.row * prod.tileCols + s.col) * 4;
    const b = await getRange(`${prod.base}/${s.file}`, from, from + s.count * 4 - 1);
    out.set(floatKmBytesToDn(b), s.outRow * w.width + s.outCol);
    onRead(++done, reads.length);
  });
  return out;
}

// The cached raw patch if it has the expected number of pixels, else null.
function cached(id, pixels) {
  const raw = new URL(`${id}.bin`, RAW);
  if (!existsSync(raw) || statSync(raw).size !== pixels * 2) return null;
  const b = readFileSync(raw);
  return new Int16Array(b.buffer, b.byteOffset, b.length / 2);
}

// Despike, pack and write demo/data/js/hires_<id>.js. → { pack, thr, replaced, packBytes }
function writePack(id, data, width, kmPerPixel) {
  const pack = `hires_${id.replace(/-/g, '_')}`;
  const thr = +despikeM(kmPerPixel).toFixed(3), clean = despike(data, width, thr);
  const gz = encodePack(clean.data, width);
  writeFileSync(new URL(`js/${pack}.js`, DATA), `window.__lsnData("${pack}","${gz.toString('base64')}")\n`);
  console.log(`  → ${pack}.js ${(gz.length / 1e6).toFixed(2)} MB, ${clean.replaced} spikes over ${thr} m smoothed`);
  return { pack, thr, replaced: clean.replaced, packBytes: gz.length };
}

const progress = (id, name) => (k, total) => { if (k % 100 === 0 || k === total) process.stdout.write(`\r${id}: ${k}/${total} rows from ${name}`); };

// A polar patch (either pole): fetched or cached, packed. → manifest fields shared by sites and npolar entries
async function polarPatch(id, p, x, y, halfKm) {
  const w = patchWindow(p, x, y, halfKm);
  let data = cached(id, w.n * w.n);
  if (data) console.log(`${id}: cached ${w.n}² at ${p.kmPerPixel * 1000} m`);
  else {
    const t0 = Date.now(), show = progress(id, p.name);
    data = await fetchPatch(p, w, { onRow: (k) => show(k, w.n) });
    process.stdout.write(` in ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
    writeFileSync(new URL(`${id}.bin`, RAW), Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }
  return { w, ...writePack(id, data, w.n, p.kmPerPixel) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = process.argv.slice(2);
  const take = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const halfKm = Number(take('--half-km') ?? 5);
  const at = take('--at'), idArg = take('--id');
  mkdirSync(RAW, { recursive: true });
  const manPath = new URL('hires.json', DATA);
  const manifest = existsSync(manPath) ? JSON.parse(readFileSync(manPath, 'utf8')) : { about: '', sites: {} };
  manifest.about = 'High-resolution LOLA patches around the south-pole sites (tools/fetch-hires.mjs). Patch packs: delta-coded Int16 DN (× 0.5 m above 1737.4 km) + gzip.';
  manifest.source = `NASA PDS, LRO LOLA GDR polar products (${IMG}/)`;
  if (at !== undefined) {
    const [lat, lonIn] = String(at).split(',').map(Number);
    let sel;
    try {
      if (String(at).split(',').length !== 2) throw new RangeError(`--at wants lat,lon (e.g. --at 0.67,23.47), got ${at}`);
      sel = selectProduct(lat, lonIn, halfKm);
    } catch (e) { console.error(`fetch-hires: ${e.message}`); process.exit(1); }
    const lon = normLon(lonIn);
    const tag = (v, pos, neg) => `${String(+Math.abs(v).toFixed(2)).replace('.', 'p')}${v < 0 ? neg : pos}`;
    const id = idArg ?? `at-${tag(lat, 'n', 's')}-${tag(lon, 'e', 'w')}`;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) { console.error(`fetch-hires: --id must be lower-case letters, digits, - or _ (got ${id})`); process.exit(1); }
    manifest.patches ??= {};
    if (sel.projection === 'equirect') {
      const prod = sel.product, w = sel.window;
      let data = cached(id, w.width * w.height);
      if (data) console.log(`${id}: cached ${w.width} × ${w.height} at ${prod.ppd} px/deg`);
      else {
        const t0 = Date.now(), show = progress(id, prod.name);
        data = await fetchEquirect(prod, w, { onRead: show });
        process.stdout.write(` in ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
        writeFileSync(new URL(`${id}.bin`, RAW), Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      }
      const r = writePack(id, data, w.width, prod.kmPerPixel);
      manifest.patches[id] = {
        pack: r.pack, product: prod.name, projection: 'equirect', files: [...new Set(equirectRanges(prod, w).map((s) => s.file))],
        ppd: prod.ppd, width: w.width, height: w.height, latMin: w.latMin, latMax: w.latMax, lonMin: w.lonMin, lonMax: w.lonMax,
        kmPerPixel: prod.kmPerPixel, dnToMeters: DN_M, halfKm, latDeg: lat, lonDeg: lon, despikedPixels: r.replaced, despikeM: r.thr, packBytes: r.packBytes,
      };
      delete manifest.sites[id];
    } else {
      const p = sel.product, r = await polarPatch(id, p, sel.x, sel.y, halfKm), w = r.w;
      const geo = { kmPerPixel: p.kmPerPixel, n: w.n, xMin: +w.xMin.toFixed(6), yMax: +w.yMax.toFixed(6) };
      const tail = { halfKm, latDeg: lat, lonDeg: lon, despikedPixels: r.replaced, despikeM: r.thr, packBytes: r.packBytes };
      if (sel.projection === 'spolar') { manifest.sites[id] = { pack: r.pack, product: p.name, ...geo, ...tail }; delete manifest.patches[id]; }
      else { manifest.patches[id] = { pack: r.pack, product: p.name, projection: 'npolar', ...geo, dnToMeters: DN_M, ...tail }; delete manifest.sites[id]; }
    }
    if (!Object.keys(manifest.patches).length) delete manifest.patches;
    else manifest.patchesSource = `NASA PDS, LRO LOLA north polar GDR (${IMG}/) and SLDEM2015 (${SLDEM.base}/); entries carry their projection (tools/fetch-hires.mjs).`;
    console.log(`${id}: ${sel.projection} patch from ${sel.product.name}`);
  } else {
    const only = args;
    const sites = JSON.parse(readFileSync(new URL('sites.json', DATA), 'utf8')).filter((s) => s.latDeg <= -80 && (!only.length || only.includes(s.id)));
    for (const s of sites) {
      const [x, y] = toXY(s.latDeg, s.lonDeg);
      const p = productFor(x, y, halfKm);
      if (!p) { console.log(`skip ${s.id}: no product covers it`); continue; }
      const r = await polarPatch(s.id, p, x, y, halfKm), w = r.w;
      manifest.sites[s.id] = { pack: r.pack, product: p.name, kmPerPixel: p.kmPerPixel, n: w.n, xMin: +w.xMin.toFixed(6), yMax: +w.yMax.toFixed(6), halfKm, latDeg: s.latDeg, lonDeg: s.lonDeg, despikedPixels: r.replaced, despikeM: r.thr, packBytes: r.packBytes };
    }
  }
  writeFileSync(manPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('wrote demo/data/hires.json');
}
