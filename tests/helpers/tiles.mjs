// Synthetic tiled elevation in the exact format of task book phase 4 §4.1: tiles of (tilePx + 2·apronPx)²
// Int16 DN (metres = DN × 0.5), one pixel of apron taken from the neighbouring pixels, −32768 outside the
// source extent. Tile (row, col): x ∈ [−halfKm + col·T, …), row 0 at the top (+y).
import { createDem, tileId } from '../../demo/src/terrain.js';

export const LEVEL_40 = { name: 'dem_40m', tiled: true, kmPerPixel: 0.04, dnToMeters: 0.5, tilePx: 256, apronPx: 1, halfKm: 307.2 };
export const LEVEL_20 = { name: 'dem_20m', tiled: true, kmPerPixel: 0.02, dnToMeters: 0.5, tilePx: 256, apronPx: 1, halfKm: 76.8 };

// Rolling terrain with detail from 0.3 km to 20 km wavelengths and a crater, metres.
export function terrainM(x, y) {
  let h = 900 * Math.sin(x / 3.1) * Math.cos(y / 4.3) + 400 * Math.sin((x + 2 * y) / 1.3) + 150 * Math.cos((3 * x - y) / 0.47)
    + 60 * Math.sin((x - 4 * y) / 0.19) + 8 * x;
  h -= 2500 * Math.exp(-((x - 3) ** 2 + (y + 2) ** 2) / 20);
  return h;
}

// DN of the global pixel (gr, gc) of a level, or −32768 outside `inSource(x, y)`.
export function dnAt(level, gr, gc, f = terrainM, inSource = () => true) {
  const x = -level.halfKm + (gc + 0.5) * level.kmPerPixel, y = level.halfKm - (gr + 0.5) * level.kmPerPixel;
  return inSource(x, y) ? Math.round(f(x, y) / level.dnToMeters) : -32768;
}

export function makeTile(level, row, col, f = terrainM, inSource) {
  const P = level.tilePx, a = level.apronPx, n = P + 2 * a;
  const out = new Int16Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) out[r * n + c] = dnAt(level, row * P + r - a, col * P + c - a, f, inSource);
  return out;
}

// The pack bytes as the loader returns them (Uint8Array over a fresh buffer, little endian).
export const tileBytes = (tile) => new Uint8Array(tile.buffer.slice(0));

// Tiles (row, col) whose rectangle meets the box (km).
export function tilesMeeting(level, b) {
  const T = level.tilePx * level.kmPerPixel, out = [];
  const c0 = Math.floor((b.x0 + level.halfKm) / T), c1 = Math.floor((b.x1 + level.halfKm) / T);
  const r0 = Math.floor((level.halfKm - b.y1) / T), r1 = Math.floor((level.halfKm - b.y0) / T);
  for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) out.push({ row, col, id: tileId(row, col) });
  return out;
}

// A plain (untiled) reference over the same pixel grid as `level`, with bilinear heights computed straight
// from the global pixels: what the tiled level must reproduce, seams or not.
export function referenceDem(level, f = terrainM, inSource) {
  const k = level.kmPerPixel, H = level.halfKm, dn = level.dnToMeters;
  const cache = new Map();
  const px = (gr, gc) => {
    const key = gr * 100000 + gc;
    let v = cache.get(key);
    if (v === undefined) { v = dnAt(level, gr, gc, f, inSource); cache.set(key, v); }
    return v;
  };
  function sample(x, y) {
    const col = (x + H) / k - 0.5, row = (H - y) / k - 0.5;
    const c0 = Math.floor(col), r0 = Math.floor(row);
    const a = px(r0, c0), b = px(r0, c0 + 1), c = px(r0 + 1, c0), d = px(r0 + 1, c0 + 1);
    if (a === -32768 || b === -32768 || c === -32768 || d === -32768) return NaN;
    const fc = col - c0, fr = row - r0;
    const top = a + (b - a) * fc, bottom = c + (d - c) * fc;
    return (top + (bottom - top) * fr) * dn;
  }
  return { kmPerPixel: k, halfKm: H, sample, heightAtXY: (x, y) => { const v = sample(x, y); return v === v ? v : null; } };
}

// A plain createDem level centred on the pole, ±halfKm, sampled from f at its pixel centres.
export function plainDem(kmPerPixel, halfKm, f = terrainM) {
  const size = Math.round((2 * halfKm) / kmPerPixel);
  const data = new Int16Array(size * size);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    data[r * size + c] = Math.round(f(-halfKm + (c + 0.5) * kmPerPixel, halfKm - (r + 0.5) * kmPerPixel) / 0.5);
  }
  return createDem({ data, size, kmPerPixel, dnToMeters: 0.5, halfKm });
}
