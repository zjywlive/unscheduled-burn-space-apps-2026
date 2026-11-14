// High-resolution terrain patches around the south-pole landing sites, for the descent view and the globe.
// For each site in demo/data/sites.json south of 80°S, a square patch (default 10 × 10 km) is cut from the
// finest LOLA polar product that covers it: LDEM_875S_5M (5 m, 87.5°S–90°S), LDEM_85S_10M (10 m, 85°S–90°S)
// or LDEM_80S_20M (20 m, 80°S–90°S). Only the rows' byte ranges inside the patch are downloaded (HTTP Range),
// so nothing like the 1.8 GB files is fetched.
//
// Products are polar stereographic about the pole with the pole at pixel (size/2 − 0.5): col = x/kpp + c,
// row = c − y/kpp (map km), as terrain.js createDem. Heights are Int16 DN × 0.5 m above 1737.4 km.
//
// Single-pixel spikes are smoothed (despike, below; the count is in the manifest).
// Writes data-raw/hires/<id>.bin (the raw patch, a cache), demo/data/js/hires_<id>.js (data pack: delta-coded
// Int16 + gzip, as tools/build-global.mjs) and demo/data/hires.json (the manifest demo/src/hires.js reads).
// Usage: node tools/fetch-hires.mjs [--half-km 5] [site ids…]
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { encodePack } from './build-global.mjs';
import { toXY } from '../demo/src/terrain.js';

const IMG = 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img';
export const PRODUCTS = [
  { name: 'ldem_875s_5m', kmPerPixel: 0.005, size: 30336, maxLatDeg: -87.5 },
  { name: 'ldem_85s_10m', kmPerPixel: 0.01, size: 30336, maxLatDeg: -85 },
  { name: 'ldem_80s_20m', kmPerPixel: 0.02, size: 30400, maxLatDeg: -80 },
];
const DATA = new URL('../demo/data/', import.meta.url);
const RAW = new URL('../data-raw/hires/', import.meta.url);

// The finest product whose square covers a patch of ±halfKm around (x, y), or null.
export function productFor(x, y, halfKm) {
  for (const p of PRODUCTS) {
    const edge = (p.size * p.kmPerPixel) / 2;
    if (Math.abs(x) + halfKm < edge && Math.abs(y) + halfKm < edge) {
      // inside the product's latitude limit too (its square corners reach further than its circle)
      const r = Math.hypot(Math.abs(x) + halfKm, Math.abs(y) + halfKm);
      const rMax = 2 * 1737.4 * Math.tan(((90 + p.maxLatDeg) / 2) * Math.PI / 180);
      if (r < rMax) return p;
    }
  }
  return null;
}

// Pixel window of the patch in a product: { c0, r0, n } (n × n pixels), and its outer edges in map km.
export function patchWindow(p, x, y, halfKm) {
  const c = p.size / 2 - 0.5, n = Math.round((2 * halfKm) / p.kmPerPixel);
  const c0 = Math.round((x - halfKm) / p.kmPerPixel + c + 0.5), r0 = Math.round(c - (y + halfKm) / p.kmPerPixel + 0.5);
  const xMin = (c0 - 0.5 - c) * p.kmPerPixel, yMax = (c - (r0 - 0.5)) * p.kmPerPixel;
  return { c0, r0, n, xMin, yMax, xMax: xMin + n * p.kmPerPixel, yMin: yMax - n * p.kmPerPixel };
}

// Isolated outliers: a pixel more than thresholdM from the median of its 8 neighbours takes that median.
// LOLA gridded products interpolate between laser tracks, and the few single-pixel spikes this leaves show as
// needles once the relief is exaggerated. → { data (a copy), replaced }
export function despike(data, n, thresholdM, dnToMeters = 0.5) {
  const out = Int16Array.from(data), lim = thresholdM / dnToMeters, nb = new Int16Array(8);
  let replaced = 0;
  for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
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

async function fetchPatch(p, w, { concurrency = 16, onRow = () => {} } = {}) {
  const url = `${IMG}/${p.name}.img`, rowBytes = p.size * 2, out = new Int16Array(w.n * w.n);
  let next = 0, done = 0;
  async function worker() {
    for (;;) {
      const j = next++;
      if (j >= w.n) return;
      const from = (w.r0 + j) * rowBytes + w.c0 * 2;
      const b = await getRange(url, from, from + w.n * 2 - 1);
      out.set(new Int16Array(b.buffer, b.byteOffset, w.n), j * w.n);
      onRow(++done);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = process.argv.slice(2);
  const hi = args.indexOf('--half-km');
  const halfKm = hi >= 0 ? Number(args.splice(hi, 2)[1]) : 5;
  const only = args;
  const sites = JSON.parse(readFileSync(new URL('sites.json', DATA), 'utf8')).filter((s) => s.latDeg <= -80 && (!only.length || only.includes(s.id)));
  mkdirSync(RAW, { recursive: true });
  const manPath = new URL('hires.json', DATA);
  const manifest = existsSync(manPath) ? JSON.parse(readFileSync(manPath, 'utf8')) : { about: '', sites: {} };
  manifest.about = 'High-resolution LOLA patches around the south-pole sites (tools/fetch-hires.mjs). Patch packs: delta-coded Int16 DN (× 0.5 m above 1737.4 km) + gzip.';
  manifest.source = `NASA PDS, LRO LOLA GDR polar products (${IMG}/)`;
  for (const s of sites) {
    const [x, y] = toXY(s.latDeg, s.lonDeg);
    const p = productFor(x, y, halfKm);
    if (!p) { console.log(`skip ${s.id}: no product covers it`); continue; }
    const w = patchWindow(p, x, y, halfKm);
    const raw = new URL(`${s.id}.bin`, RAW);
    let data;
    if (existsSync(raw) && statSync(raw).size === w.n * w.n * 2) {
      const b = readFileSync(raw); data = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
      console.log(`${s.id}: cached ${w.n}² at ${p.kmPerPixel * 1000} m`);
    } else {
      const t0 = Date.now();
      data = await fetchPatch(p, w, { onRow: (k) => { if (k % 100 === 0 || k === w.n) process.stdout.write(`\r${s.id}: ${k}/${w.n} rows from ${p.name}`); } });
      process.stdout.write(` in ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
      writeFileSync(raw, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    }
    const pack = `hires_${s.id.replace(/-/g, '_')}`;
    const thr = despikeM(p.kmPerPixel), clean = despike(data, w.n, thr);
    const gz = encodePack(clean.data, w.n);
    writeFileSync(new URL(`js/${pack}.js`, DATA), `window.__lsnData("${pack}","${gz.toString('base64')}")\n`);
    manifest.sites[s.id] = { pack, product: p.name, kmPerPixel: p.kmPerPixel, n: w.n, xMin: +w.xMin.toFixed(6), yMax: +w.yMax.toFixed(6), halfKm, latDeg: s.latDeg, lonDeg: s.lonDeg, despikedPixels: clean.replaced, despikeM: thr, packBytes: gz.length };
    console.log(`  → ${pack}.js ${(gz.length / 1e6).toFixed(2)} MB, ${clean.replaced} spikes over ${thr} m smoothed`);
  }
  writeFileSync(manPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('wrote demo/data/hires.json');
}
