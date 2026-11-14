// Builds the tiled fine elevation levels (phase 4 §3 D.2, contract §4.1):
//   demo/data/dem_40m_r<RR>c<CC>.bin  from LDEM_80S_40M  (halfKm 307.2, 60 × 60 tile grid)
//   demo/data/dem_20m_r<RR>c<CC>.bin  from LDEM_875S_20M (halfKm 76.8, 30 × 30 tile grid)
// Each tile is (tilePx + 2·apronPx)² Int16 LE DN values (metres = DN × 0.5): the 256² core plus one
// pixel of apron on every side, taken from the neighbouring source pixels, so a bilinear lookup anywhere
// in the tile core reads only this tile. Pixels outside the source raster are −32768 (no data).
// Tile (row, col) covers x ∈ [−halfKm + col·T, −halfKm + (col+1)·T), y ∈ (halfKm − (row+1)·T, halfKm − row·T],
// T = tilePx × kmPerPixel; row 0 is at the top (+y). Shipped tiles: every tile that meets the pole circle
// or a site circle (see COVERAGE) and holds at least one source pixel. The total stays under BUDGET bytes;
// when it would not, the site radii shrink in 1 km (40 m) / 0.5 km (20 m) steps.
// Merges the two levels into terrain.json `levels` (existing entries kept) and the sources into `sources`.
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { parseLabel, FILES, rawPath } from './fetch-lola.mjs';

export const NO_DATA = -32768;
export const TILE_PX = 256, APRON_PX = 1;
export const BUDGET = 40e6;

export function tileKm(level) { return level.tilePx * level.kmPerPixel; }
export function tileCount(level) { return Math.round((2 * level.halfKm) / tileKm(level)); }
export const tileId = (row, col) => `r${String(row).padStart(2, '0')}c${String(col).padStart(2, '0')}`;
export const tileName = (level, row, col) => `${level.name}_${tileId(row, col)}`;
export function parseTileId(id) {
  const m = /^r(\d{2})c(\d{2})$/.exec(id);
  return m ? { row: Number(m[1]), col: Number(m[2]) } : null;
}

// Tile extent in km: x ∈ [x0, x1), y ∈ (y0, y1].
export function tileBounds(level, row, col) {
  const T = tileKm(level);
  return { x0: -level.halfKm + col * T, x1: -level.halfKm + (col + 1) * T, y0: level.halfKm - (row + 1) * T, y1: level.halfKm - row * T };
}

// The tile that holds a point, or null outside the tile grid (same floor rule as heat.js cellAt).
export function tileAt(level, xKm, yKm) {
  const T = tileKm(level), n = tileCount(level);
  const col = Math.floor((xKm + level.halfKm) / T), row = Math.floor((level.halfKm - yKm) / T);
  return col >= 0 && col < n && row >= 0 && row < n ? { row, col } : null;
}

// Tiles whose rectangle comes within rKm of (cx, cy).
export function tilesInCircle(level, cx, cy, rKm) {
  const n = tileCount(level), out = [];
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
    const b = tileBounds(level, row, col);
    const dx = Math.max(b.x0 - cx, 0, cx - b.x1), dy = Math.max(b.y0 - cy, 0, cy - b.y1);
    if (Math.hypot(dx, dy) <= rKm) out.push({ row, col });
  }
  return out;
}

// Source pixel index of tile core pixel 0 for tile 0: srcCol = col·tilePx + c + shift (likewise rows).
// Throws unless the tile grid's pixel centres fall exactly on source pixel centres.
export function sourceShift(level, projectionOffset) {
  const s = projectionOffset + 0.5 - level.halfKm / level.kmPerPixel;
  if (Math.abs(s - Math.round(s)) > 1e-6) throw new Error(`${level.name}: tile grid is not pixel-aligned with the source (shift ${s})`);
  return Math.round(s);
}

// Cuts one tile with its apron out of a square Int16 source raster.
export function sliceTile(src, srcSize, shift, level, row, col) {
  const a = level.apronPx, n = level.tilePx + 2 * a;
  const out = new Int16Array(n * n).fill(NO_DATA);
  const r0 = row * level.tilePx + shift - a, c0 = col * level.tilePx + shift - a;
  for (let r = 0; r < n; r++) {
    const sr = r0 + r;
    if (sr < 0 || sr >= srcSize) continue;
    const lo = Math.max(0, -c0), hi = Math.min(n, srcSize - c0);
    if (hi > lo) out.set(src.subarray(sr * srcSize + c0 + lo, sr * srcSize + c0 + hi), r * n + lo);
  }
  return out;
}

// True when the tile core holds at least one source pixel.
export function coreHasData(tile, level) {
  const a = level.apronPx, n = level.tilePx + 2 * a;
  for (let r = a; r < n - a; r++) for (let c = a; c < n - a; c++) if (tile[r * n + c] !== NO_DATA) return true;
  return false;
}

// Bilinear height (m) at (x, y) from one tile, reading only that tile; null when a corner is no data.
export function tileHeightAt(tile, level, row, col, xKm, yKm) {
  const a = level.apronPx, n = level.tilePx + 2 * a, k = level.kmPerPixel;
  const b = tileBounds(level, row, col);
  const fc = (xKm - b.x0) / k - 0.5 + a, fr = (b.y1 - yKm) / k - 0.5 + a;
  if (!(fc >= 0 && fr >= 0 && fc <= n - 1 && fr <= n - 1)) return null;
  const c0 = Math.min(Math.floor(fc), n - 2), r0 = Math.min(Math.floor(fr), n - 2);
  const i = r0 * n + c0;
  const v = [tile[i], tile[i + 1], tile[i + n], tile[i + n + 1]];
  if (v.includes(NO_DATA)) return null;
  const tx = fc - c0, ty = fr - r0;
  const top = v[0] + (v[1] - v[0]) * tx, bottom = v[2] + (v[3] - v[2]) * tx;
  return (top + (bottom - top) * ty) * (level.dnToMeters ?? 0.5);
}

// Union of the pole circle and the site circles, as sorted tile ids.
export function coverage(level, { poleKm, siteKm, sites }) {
  const set = new Map();
  const add = (list) => { for (const t of list) set.set(tileId(t.row, t.col), t); };
  add(tilesInCircle(level, 0, 0, poleKm));
  for (const s of sites) add(tilesInCircle(level, s.xKm, s.yKm, siteKm));
  return [...set.keys()].sort();
}

// Georeferencing check: f × f block means of a tiled level (f = coarse kmPerPixel / fine kmPerPixel) against
// a centred coarse DEM ({ data, size, kmPerPixel }), over every `stride`-th coarse pixel fully covered by
// shipped tiles, with the fine grid shifted by (dr, dc) fine pixels. Returns Pearson r, the mean |Δh| (m),
// the mean Δh (fine − coarse, m) and the number of pixels compared.
export function blockCorrelation(level, tiles, coarse, { dr = 0, dc = 0, stride = 2 } = {}) {
  const f = Math.round(coarse.kmPerPixel / level.kmPerPixel);
  const T = level.tilePx, n = T + 2 * level.apronPx, a0 = level.apronPx;
  const coarseHalf = (coarse.size * coarse.kmPerPixel) / 2;
  const off = Math.round((level.halfKm - coarseHalf) / level.kmPerPixel);
  const fine = (R, C) => {
    if (R < 0 || C < 0) return null;
    const tile = tiles.get(tileId(Math.floor(R / T), Math.floor(C / T)));
    if (!tile) return null;
    const v = tile[((R % T) + a0) * n + (C % T) + a0];
    return v === NO_DATA ? null : v;
  };
  const A = [], B = [];
  for (let r = 0; r < coarse.size; r += stride) {
    for (let c = 0; c < coarse.size; c += stride) {
      if (fine(off + r * f + dr, off + c * f + dc) === null) continue;      // quick reject outside the tiles
      let sum = 0, ok = true;
      for (let i = 0; i < f && ok; i++) for (let j = 0; j < f; j++) {
        const v = fine(off + r * f + i + dr, off + c * f + j + dc);
        if (v === null) { ok = false; break; }
        sum += v;
      }
      if (ok) { A.push(sum / (f * f)); B.push(coarse.data[r * coarse.size + c]); }
    }
  }
  const m = A.length, dn = level.dnToMeters ?? 0.5;
  const ma = A.reduce((x, y) => x + y, 0) / m, mb = B.reduce((x, y) => x + y, 0) / m;
  let sab = 0, saa = 0, sbb = 0, sad = 0;
  for (let k = 0; k < m; k++) { sab += (A[k] - ma) * (B[k] - mb); saa += (A[k] - ma) ** 2; sbb += (B[k] - mb) ** 2; sad += Math.abs(A[k] - B[k]); }
  return { r: sab / Math.sqrt(saa * sbb), madM: (sad / m) * dn, biasM: (ma - mb) * dn, n: m };
}

export const LEVELS = [
  { name: 'dem_40m', tiled: true, kmPerPixel: 0.04, dnToMeters: 0.5, tilePx: TILE_PX, apronPx: APRON_PX, halfKm: 307.2, source: 'ldem_80s_40m', metres: 40 },
  { name: 'dem_20m', tiled: true, kmPerPixel: 0.02, dnToMeters: 0.5, tilePx: TILE_PX, apronPx: APRON_PX, halfKm: 76.8, source: 'ldem_875s_20m', metres: 20 },
];

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { toXY } = await import('../demo/src/terrain.js');
  const DATA = new URL('../demo/data/', import.meta.url);
  const t0 = Date.now();
  const allSites = JSON.parse(readFileSync(new URL('sites.json', DATA)))
    .filter((s) => s.latDeg <= -80)
    .map((s) => { const [xKm, yKm] = toXY(s.latDeg, s.lonDeg); return { id: s.id, latDeg: s.latDeg, lonDeg: s.lonDeg, xKm, yKm }; });

  const src = {};
  for (const L of LEVELS) {
    const label = parseLabel(readFileSync(rawPath({ name: `${L.source}.lbl` }), 'utf8'));
    const ok = label.lines === label.samples && label.bits === 16 && label.sampleType === 'LSB_INTEGER' && label.scale === 0.5
      && label.mapScaleM === L.metres && label.lineOffset === label.sampleOffset && label.lineOffset === label.lines / 2 - 0.5
      && label.centerLat === -90 && label.centerLon === 0 && label.rotation === 0 && label.missing === null
      && label.projection === 'POLAR STEREOGRAPHIC' && label.radiusKm === 1737.4;
    if (!ok) { console.error(`${L.source}.lbl does not match the expected layout`, label); process.exit(1); }
    const buf = readFileSync(rawPath({ name: `${L.source}.img` }));
    if (buf.length !== label.lines * label.samples * 2) { console.error(`${L.source}.img: ${buf.length} bytes`); process.exit(1); }
    const data = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
    const shift = sourceShift(L, label.sampleOffset);
    const srcHalfKm = (label.samples * L.kmPerPixel) / 2;
    src[L.name] = { label, data, size: label.samples, shift, srcHalfKm };
    console.log(`${L.source}: ${label.samples}² px, ±${srcHalfKm} km, tile shift ${shift}, DN ${label.derivedMin}…${label.derivedMax}`);
  }

  // The sites in each level's source extent; 40 m keeps every site south of 80°S.
  const inExtent = (L, s) => Math.max(Math.abs(s.xKm), Math.abs(s.yKm)) <= src[L.name].srcHalfKm;
  const plan = (poleKm, siteKm, L) => {
    const sites = allSites.filter((s) => inExtent(L, s));
    const ids = coverage(L, { poleKm, siteKm, sites }).filter((id) => {
      const { row, col } = parseTileId(id);
      return coreHasData(sliceTile(src[L.name].data, src[L.name].size, src[L.name].shift, L, row, col), L);
    });
    return { L, poleKm, siteKm, sites: sites.map((s) => s.id), ids };
  };
  const tileBytes = (L) => (L.tilePx + 2 * L.apronPx) ** 2 * 2;
  let site40 = 12, site20 = 6, plans;
  for (;;) {
    plans = [plan(40, site40, LEVELS[0]), plan(20, site20, LEVELS[1])];
    const total = plans.reduce((s, p) => s + p.ids.length * tileBytes(p.L), 0);
    console.log(`coverage 40 m: pole 40 km + sites ${site40} km → ${plans[0].ids.length} tiles; 20 m: pole 20 km + sites ${site20} km → ${plans[1].ids.length} tiles; ${total} bytes`);
    if (total <= BUDGET) break;
    if (site40 <= 0 && site20 <= 0) { console.error('over budget with no site circles'); process.exit(1); }
    site40 = Math.max(0, site40 - 1); site20 = Math.max(0, site20 - 0.5);
  }

  let written = 0, unchanged = 0, removed = 0, total = 0;
  for (const p of plans) {
    const keep = new Set(p.ids.map((id) => `${p.L.name}_${id}.bin`));
    for (const f of readdirSync(DATA)) if (f.startsWith(`${p.L.name}_r`) && f.endsWith('.bin') && !keep.has(f)) { unlinkSync(new URL(f, DATA)); removed++; }
    for (const id of p.ids) {
      const { row, col } = parseTileId(id);
      const s = src[p.L.name];
      const bytes = Buffer.from(sliceTile(s.data, s.size, s.shift, p.L, row, col).buffer);
      const file = new URL(`${p.L.name}_${id}.bin`, DATA);
      total += bytes.length;
      if (existsSync(file) && Buffer.compare(readFileSync(file), bytes) === 0) { unchanged++; continue; }
      writeFileSync(file, bytes);
      written++;
    }
  }
  console.log(`tiles: ${written} written, ${unchanged} unchanged, ${removed} stale removed; ${total} bytes in all`);

  const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA)));
  const names = new Set(LEVELS.map((L) => L.name));
  meta.levels = [
    ...meta.levels.filter((l) => !names.has(l.name)),
    ...plans.map(({ L, ids, poleKm, siteKm, sites }) => ({
      name: L.name, tiled: true, kmPerPixel: L.kmPerPixel, dnToMeters: L.dnToMeters, tilePx: L.tilePx, apronPx: L.apronPx, halfKm: L.halfKm,
      tiles: ids, noData: NO_DATA, sourceHalfKm: src[L.name].srcHalfKm,
      coverage: { poleKm, siteKm, sites }, source: `${L.source.toUpperCase()}.IMG`,
    })),
  ];
  const srcNames = LEVELS.flatMap((L) => [`${L.source}.img`, `${L.source}.lbl`]);
  meta.sources = [...meta.sources.filter((s) => !srcNames.includes(s.name)), ...srcNames.map((name) => {
    const f = FILES.find((x) => x.name === name);
    return { name, url: f.url, bytes: statSync(rawPath(f)).size };
  })];
  writeFileSync(new URL('terrain.json', DATA), JSON.stringify(meta, null, 2));
  console.log(`terrain.json written; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
