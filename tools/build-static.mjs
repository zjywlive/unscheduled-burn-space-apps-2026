// Builds the static per-cell layers for filters and suitability (phase 3 §4.3, §4.4, §5.2; phase 4 §3 D.4):
//   demo/data/slope_2km.bin, slope_1km.bin    Uint8 per cell = round(mean slope° × 4), capped at 255
//   demo/data/shadow_2km.bin, shadow_1km.bin  Uint8 per cell, km, from the official permanently shadowed
//                                             regions (LPSR_75S_120M_201608, Mazarico et al. 2011, 2016 update)
// and merges `slope` and `shadow` into demo/data/terrain.json, keeping every other key. Files are only
// rewritten when their bytes change.
// Slope: per 240 m pixel, central differences across 2 pixels (ground spacing corrected for the
// stereographic scale factor), averaged over the pixels whose centres fall in the cell.
// Shadow (phase 4): a cell is 0 when more than half of the 120 m PSR-raster pixels whose centres fall in it
// are permanent shadow. Otherwise it is the map-plane distance from the cell centre to the nearest PSR pixel
// centre that belongs to a PSR patch (8-connected) of at least 1 km² ground area, in km, rounded, at least 1
// (so 0 always means "mostly PSR") and at most 255. Patches and distances use the whole 7624² source
// (±457 km), so cells near the map edge see PSRs beyond it. The phase 3 rule (Sun centre never above the
// cell skyline in the ephemeris) is no longer used here; validate.mjs compares the two.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readIllum, psrMask, SRC_SIZE, ILLUM, MAZARICO } from './build-nasa.mjs';

const DATA = new URL('../demo/data/', import.meta.url);
const R = 1737.4;
export const PSR_KM = 0.12;
export const MIN_PATCH_KM2 = 1;

// Keeps the pixels of 8-connected patches whose summed `area(index)` is at least minArea.
// Returns { keep: Uint8Array, patches, kept } (patch counts before and after the size cut).
export function largePatches(mask, W, H, area, minArea) {
  const state = Uint8Array.from(mask);         // 1 = unvisited patch pixel, 2 = visited
  const keep = new Uint8Array(W * H);
  let stack = new Int32Array(1 << 16), members = new Int32Array(1 << 16);
  let patches = 0, kept = 0;
  for (let start = 0; start < W * H; start++) {
    if (state[start] !== 1) continue;
    patches++;
    let sp = 0, nm = 0, sum = 0;
    stack[sp++] = start; state[start] = 2;
    while (sp) {
      const p = stack[--sp];
      if (nm === members.length) { const g = new Int32Array(nm * 2); g.set(members); members = g; }
      members[nm++] = p;
      sum += area(p);
      const r = (p / W) | 0, c = p - r * W;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= H) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= W || (dr === 0 && dc === 0)) continue;
          const q = rr * W + cc;
          if (state[q] !== 1) continue;
          state[q] = 2;
          if (sp === stack.length) { const g = new Int32Array(sp * 2); g.set(stack); stack = g; }
          stack[sp++] = q;
        }
      }
    }
    if (sum >= minArea) { kept++; for (let m = 0; m < nm; m++) keep[members[m]] = 1; }
  }
  return { keep, patches, kept };
}

// Exact squared distance (in pixel units) from query points to the nearest set pixel of a W × H mask.
// Queries form a grid: column coordinates qc (ascending) × row coordinates qr (ascending), both in pixel
// units where pixel (r, c) has its centre at (c, r). Returns Float64Array(qr.length × qc.length),
// Infinity when the mask is empty. Pass 1 finds, per mask column, the nearest set row to each query row;
// pass 2 takes the lower envelope of the parabolas (x − c)² + g(c) (Felzenszwalb–Huttenlocher) and
// evaluates it at the query columns.
export function nearestSq(mask, W, H, qc, qr) {
  const nq = qr.length, nc = qc.length;
  // set rows per column, CSR layout
  const start = new Int32Array(W + 1);
  for (let k = 0; k < W * H; k++) if (mask[k]) start[(k % W) + 1]++;
  for (let c = 0; c < W; c++) start[c + 1] += start[c];
  const rows = new Int32Array(start[W]), fill = start.slice(0, W);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (mask[r * W + c]) rows[fill[c]++] = r;
  // g[q * W + c]: squared row distance from query row q to the nearest set pixel in column c
  const g = new Float64Array(nq * W).fill(Infinity);
  for (let c = 0; c < W; c++) {
    const a = start[c], b = start[c + 1];
    if (a === b) continue;
    let p = a;
    for (let q = 0; q < nq; q++) {
      const y = qr[q];
      while (p + 1 < b && Math.abs(rows[p + 1] - y) <= Math.abs(rows[p] - y)) p++;
      const d = rows[p] - y;
      g[q * W + c] = d * d;
    }
  }
  const out = new Float64Array(nq * nc).fill(Infinity);
  const v = new Int32Array(W), z = new Float64Array(W + 1), f = new Float64Array(W);
  for (let q = 0; q < nq; q++) {
    let k = -1;
    for (let c = 0; c < W; c++) {
      const fc = g[q * W + c];
      if (fc === Infinity) continue;
      if (k < 0) { k = 0; v[0] = c; f[0] = fc; z[0] = -Infinity; z[1] = Infinity; continue; }
      let s = ((fc + c * c) - (f[k] + v[k] * v[k])) / (2 * c - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((fc + c * c) - (f[k] + v[k] * v[k])) / (2 * c - 2 * v[k]); }
      k++; v[k] = c; f[k] = fc; z[k] = s; z[k + 1] = Infinity;
    }
    if (k < 0) continue;
    let e = 0;
    for (let i = 0; i < nc; i++) {
      const x = qc[i];
      while (z[e + 1] < x) e++;
      out[q * nc + i] = (x - v[e]) * (x - v[e]) + f[e];
    }
  }
  return out;
}

// Per cell: number of source-pixel centres inside it and how many of them are set.
// Source pixel (r, c) centre: x = (c − o)·kmpp, y = (o − r)·kmpp with o = srcSize/2 − 0.5.
export function cellCounts(mask, srcSize, kmpp, { size, cellKm, halfKm }) {
  const o = srcSize / 2 - 0.5;
  const n = new Uint32Array(size * size), set = new Uint32Array(size * size);
  for (let r = 0; r < srcSize; r++) {
    const j = Math.floor((halfKm - (o - r) * kmpp) / cellKm);
    if (j < 0 || j >= size) continue;
    for (let c = 0; c < srcSize; c++) {
      const i = Math.floor(((c - o) * kmpp + halfKm) / cellKm);
      if (i < 0 || i >= size) continue;
      n[j * size + i]++;
      set[j * size + i] += mask[r * srcSize + c];
    }
  }
  return { n, set };
}

// The phase 4 shadow-distance rule for one grid. `patchMask` holds the PSR pixels of large patches.
export function shadowGrid(mask, patchMask, srcSize, kmpp, grid) {
  const { size, cellKm, halfKm } = grid;
  const o = srcSize / 2 - 0.5;
  const { n, set } = cellCounts(mask, srcSize, kmpp, grid);
  const qc = new Float64Array(size), qr = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    qc[i] = (-halfKm + (i + 0.5) * cellKm) / kmpp + o;
    qr[i] = o - (halfKm - (i + 0.5) * cellKm) / kmpp;
  }
  const d2 = nearestSq(patchMask, srcSize, srcSize, qc, qr);
  const out = new Uint8Array(size * size);
  let majority = 0, raisedToOne = 0;
  for (let k = 0; k < out.length; k++) {
    if (n[k] && 2 * set[k] > n[k]) { out[k] = 0; majority++; continue; }
    const km = Math.sqrt(d2[k]) * kmpp;
    const v = Math.round(km);
    if (v < 1) raisedToOne++;
    out[k] = Math.min(255, Math.max(1, v));
  }
  return { out, majority, raisedToOne };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const writeIfChanged = (name, bytes) => {
    const f = new URL(name, DATA);
    if (existsSync(f) && Buffer.compare(readFileSync(f), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)) === 0) { console.log(`${name}: unchanged`); return; }
    writeFileSync(f, bytes);
    console.log(`${name}: written, ${bytes.length} bytes`);
  };
  const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA)));
  const horizons = meta.horizons;
  const cfg = [
    { tag: '2km', h: horizons.find((x) => x.name === 'horizon_grid') },
    { tag: '1km', h: horizons.find((x) => x.name === 'horizon_1km') },
  ];

  // Slope from the full 240 m source grid.
  const t0 = Date.now();
  const buf = readFileSync(new URL('../data-raw/lola/ldem_75s_240m.img', import.meta.url));
  const src = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  const S = 3812, KMPP = 0.24, C = S / 2 - 0.5, DN = 0.5;
  const acc = cfg.map(({ h }) => ({ sum: new Float64Array(h.size * h.size), n: new Uint32Array(h.size * h.size) }));
  for (let r = 1; r < S - 1; r++) {
    const y = (C - r) * KMPP;
    for (let c = 1; c < S - 1; c++) {
      const x = (c - C) * KMPP;
      const m = r * S + c;
      const scale = 1 + (x * x + y * y) / (4 * R * R);      // map distance per ground distance
      const span = (2 * KMPP * 1000) / scale;                 // ground metres across two pixels
      const gx = (src[m + 1] - src[m - 1]) * DN / span;
      const gy = (src[m - S] - src[m + S]) * DN / span;
      const deg = Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
      cfg.forEach(({ h }, g) => {
        const i = Math.floor((x + h.halfKm) / h.cellKm), j = Math.floor((h.halfKm - y) / h.cellKm);
        if (i < 0 || j < 0 || i >= h.size || j >= h.size) return;
        acc[g].sum[j * h.size + i] += deg;
        acc[g].n[j * h.size + i]++;
      });
    }
  }
  cfg.forEach(({ tag }, g) => {
    const { sum, n } = acc[g];
    const out = new Uint8Array(sum.length);
    for (let k = 0; k < sum.length; k++) out[k] = n[k] ? Math.min(255, Math.round((sum[k] / n[k]) * 4)) : 0;
    writeIfChanged(`slope_${tag}.bin`, out);
  });
  console.log(`  slope ${Date.now() - t0} ms`);

  // Shadow distance from the official PSR raster.
  const t1 = Date.now();
  const psr = readIllum('psr');
  const { mask, odd } = psrMask(psr.data, psr.label);
  if (odd) { console.error(`PSR raster has ${odd} DNs other than ±20000`); process.exit(1); }
  const o = SRC_SIZE / 2 - 0.5;
  const pixelKm2 = (p) => {
    const r = (p / SRC_SIZE) | 0, c = p - r * SRC_SIZE;
    const x = (c - o) * PSR_KM, y = (o - r) * PSR_KM;
    const k = 1 + (x * x + y * y) / (4 * R * R);           // map distance per ground distance
    return (PSR_KM * PSR_KM) / (k * k);
  };
  const { keep, patches, kept } = largePatches(mask, SRC_SIZE, SRC_SIZE, pixelKm2, MIN_PATCH_KM2);
  let all = 0, big = 0;
  for (let k = 0; k < mask.length; k++) { all += mask[k]; big += keep[k]; }
  console.log(`  PSR patches (8-connected, whole 7624² raster): ${patches}, of which ${kept} ≥ ${MIN_PATCH_KM2} km²; pixels ${all}, in large patches ${big} (${(100 * big / all).toFixed(1)} %); ${Date.now() - t1} ms`);

  const RULE = `0 when more than half of the 120 m PSR pixels whose centres fall in the cell are permanent shadow; otherwise the map-plane distance in km from the cell centre to the nearest PSR pixel centre in a PSR patch (8-connected) of at least ${MIN_PATCH_KM2} km² ground area, rounded, at least 1, capped at 255. Patches and distances use the whole 120 m raster (±457 km).`;
  meta.slope = cfg.map(({ tag, h }) => ({ name: `slope_${tag}`, file: `slope_${tag}.bin`, size: h.size, cellKm: h.cellKm, scale: 0.25, baselineKm: 0.24 }));
  meta.shadow = [];
  for (const { tag, h } of cfg) {
    const t2 = Date.now();
    const { out, majority, raisedToOne } = shadowGrid(mask, keep, SRC_SIZE, PSR_KM, h);
    writeIfChanged(`shadow_${tag}.bin`, out);
    let capped = 0;
    for (const v of out) if (v === 255) capped++;
    console.log(`  shadow_${tag}: ${majority} cells mostly PSR (${(100 * majority / out.length).toFixed(2)} %), ${raisedToOne} cells raised from 0 to 1 km, ${capped} at 255; ${Date.now() - t2} ms`);
    meta.shadow.push({
      name: `shadow_${tag}`, file: `shadow_${tag}.bin`, size: h.size, cellKm: h.cellKm, halfKm: h.halfKm,
      source: `${ILLUM.psr}.IMG (${MAZARICO})`, rule: RULE, minPatchKm2: MIN_PATCH_KM2, connectivity: 8, majority: 0.5, capKm: 255,
    });
  }
  writeFileSync(new URL('terrain.json', DATA), JSON.stringify(meta, null, 2));
  console.log('terrain.json written');
}
