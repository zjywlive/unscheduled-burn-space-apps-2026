// Phase 1 global terrain model (docs/PHASES.md): turns the global LOLA grids in data-raw/ into data packs
// for demo/src/globe-terrain.js.
//
//   globe_g0              LDEM_4,  4 px/deg (7.6 km), the whole 1440 × 720 grid in one pack
//   globe_g1_rRRcCC       LDEM_16, 16 px/deg (1.9 km), 15° × 15° tiles (240 px + 1 px apron), 12 × 24 tiles
//   globe_g2_rRRcCC       LDEM_64, 64 px/deg (474 m), 3.75° × 3.75° tiles (240 px + 1 px apron), 48 × 96 tiles
//   globe_n480            LDEM_75N_240M averaged 2 × 2 to 480 m, polar stereographic, 75°N–90°N, 1906²
//
// Tile (r, c) of a cylindrical level covers lat (90 − (r+1)·D, 90 − r·D], lon [c·D, (c+1)·D), D the tile
// size in degrees; row 0 at the north. The apron repeats the neighbours (longitude wraps, latitude clamps).
// Pack encoding (globe-terrain.js decodePack): Int16 LE heights in 0.5 m DN, delta coded (first value of a
// row minus the first value of the row above, every other value minus its left neighbour), then gzip.
// The source grids are simple cylindrical, pixel centres at lat 90 − (row + 0.5)/ppd, lon (col + 0.5)/ppd,
// heights relative to the 1737.4 km sphere (labels in data-raw/global/*.lbl).
//
// G2 is about 340 MB of packs: it is written to demo/data/js/ but ignored by git, so run this script on
// any machine that has data-raw/ (node tools/fetch-global.mjs first). Usage:
//   node tools/build-global.mjs            G0, G1 and the north cap (the committed packs)
//   node tools/build-global.mjs --g2       also the G2 tiles
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { parseLabel } from './fetch-lola.mjs';

const RAW = new URL('../data-raw/', import.meta.url);
const OUT = new URL('../demo/data/js/', import.meta.url);
const MANIFEST = new URL('../demo/data/globe.json', import.meta.url);

export const CYL_LEVELS = [
  { name: 'globe_g0', file: 'global/ldem_4', ppd: 4, tileDeg: null },
  { name: 'globe_g1', file: 'global/ldem_16', ppd: 16, tileDeg: 15 },
  { name: 'globe_g2', file: 'global/ldem_64', ppd: 64, tileDeg: 3.75 },
];
export const APRON = 1;
export const tileId = (r, c) => `r${String(r).padStart(2, '0')}c${String(c).padStart(2, '0')}`;

export function deltaEncode(values, width) {
  const out = new Int16Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const col = i % width;
    const pred = col > 0 ? values[i - 1] : (i >= width ? values[i - width] : 0);
    out[i] = values[i] - pred;   // wraps in Int16 like the decoder, so any difference round-trips
  }
  return out;
}

export function encodePack(values, width) {
  const d = deltaEncode(values, width);
  return gzipSync(Buffer.from(d.buffer, d.byteOffset, d.byteLength), { level: 9 });
}

function writePack(name, values, width) {
  const gz = encodePack(values, width);
  writeFileSync(new URL(`${name}.js`, OUT), `window.__lsnData("${name}","${gz.toString('base64')}")\n`);
  return gz.length;
}

function readGrid(file) {
  const label = parseLabel(readFileSync(new URL(`${file}.lbl`, RAW), 'utf8'));
  const buf = readFileSync(new URL(`${file}.img`, RAW));
  const data = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  if (data.length !== label.lines * label.samples) throw new Error(`${file}: size does not match its label`);
  return { label, data, width: label.samples, height: label.lines };
}

// One cylindrical tile with its apron: (tilePx + 2·APRON)² values.
export function cutTile(grid, width, height, r, c, tilePx) {
  const s = tilePx + 2 * APRON, out = new Int16Array(s * s);
  for (let y = 0; y < s; y++) {
    const gy = Math.min(height - 1, Math.max(0, r * tilePx + y - APRON));
    for (let x = 0; x < s; x++) {
      const gx = (((c * tilePx + x - APRON) % width) + width) % width;
      out[y * s + x] = grid[gy * width + gx];
    }
  }
  return out;
}

function buildCylindrical(level) {
  const { label, data, width, height } = readGrid(level.file);
  if (label.mapResolution !== undefined && label.mapResolution !== level.ppd) throw new Error(`${level.file}: unexpected resolution`);
  if (width !== 360 * level.ppd || height !== 180 * level.ppd) throw new Error(`${level.file}: unexpected grid ${width} × ${height}`);
  if (level.tileDeg === null) {
    const bytes = writePack(level.name, data, width);
    return { name: level.name, ppd: level.ppd, width, height, packBytes: bytes };
  }
  const tilePx = level.tileDeg * level.ppd, rows = height / tilePx, cols = width / tilePx;
  let total = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) total += writePack(`${level.name}_${tileId(r, c)}`, cutTile(data, width, height, r, c, tilePx), tilePx + 2 * APRON);
    process.stdout.write(`\r${level.name}: row ${r + 1}/${rows}`);
  }
  process.stdout.write('\n');
  return { name: level.name, ppd: level.ppd, tileDeg: level.tileDeg, tilePx, apronPx: APRON, rows, cols, packBytes: total };
}

function buildNorthCap() {
  const { label, data, width } = readGrid('lola/ldem_75n_240m');
  if (width !== 3812 || label.mapScaleM !== 240) throw new Error('ldem_75n_240m: unexpected grid');
  const n = width / 2, out = new Int16Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = 2 * y * width + 2 * x;
    out[y * n + x] = Math.round((data[i] + data[i + 1] + data[i + width] + data[i + width + 1]) / 4);
  }
  const bytes = writePack('globe_n480', out, n);
  return { name: 'globe_n480', projection: 'north polar stereographic', size: n, kmPerPixel: 0.48, halfKm: (n * 0.48) / 2, minLatDeg: 75, packBytes: bytes };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const g2 = process.argv.includes('--g2');
  mkdirSync(OUT, { recursive: true });
  const levels = [];
  for (const level of CYL_LEVELS) {
    if (level.name === 'globe_g2' && !g2) continue;
    if (!existsSync(new URL(`${level.file}.img`, RAW))) { console.error(`missing data-raw/${level.file}.img: run node tools/fetch-global.mjs`); process.exit(1); }
    levels.push(buildCylindrical(level));
    console.log(`${level.name}: ${(levels.at(-1).packBytes / 1e6).toFixed(1)} MB gzip`);
  }
  const north = buildNorthCap();
  console.log(`globe_n480: ${(north.packBytes / 1e6).toFixed(1)} MB gzip`);
  const old = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null;
  const keepG2 = !g2 && old?.levels?.find((l) => l.name === 'globe_g2');
  const manifest = {
    about: 'Global lunar terrain packs (tools/build-global.mjs). Heights in 0.5 m DN above the 1737.4 km sphere.',
    encoding: 'Int16 LE, delta coded (row start minus row start above, others minus left), gzip, base64 in a data pack',
    sources: [
      'NASA PDS, LRO LOLA GDR LDEM_4 / LDEM_16 / LDEM_64 (https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/)',
      'NASA PDS, LRO LOLA GDR LDEM_75N_240M (https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/)',
    ],
    generatedAt: new Date().toISOString(),
    levels: [...levels, ...(keepG2 ? [keepG2] : [])],
    north,
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log('wrote demo/data/globe.json');
}
