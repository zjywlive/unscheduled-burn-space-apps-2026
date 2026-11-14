// South-pole terrain: polar stereographic projection, LOLA height lookup and the terrain skyline
// (spec phase 2 §2.2–§2.3). Map plane in km: pole at the origin, 0°E up (+y), 90°E right (+x).

export const MAP_HALF_KM = 320;
export const GRID_SIZE = 320;
export const GRID_CELL_KM = 2;
export const TERRAIN_MAX_LAT = -80;
export const OBSERVER_M = 2;

const R = 1737.4;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export function toXY(latDeg, lonDeg) {
  const r = 2 * R * Math.tan(((90 + latDeg) / 2) * RAD);
  const lon = lonDeg * RAD;
  return [r * Math.sin(lon), r * Math.cos(lon)];
}

export function fromXY(xKm, yKm) {
  const r = Math.hypot(xKm, yKm);
  const latDeg = 2 * Math.atan(r / (2 * R)) * DEG - 90;
  let lonDeg = Math.atan2(xKm, yKm) * DEG;
  if (lonDeg < 0) lonDeg += 360;
  if (lonDeg >= 360) lonDeg -= 360;
  return { latDeg, lonDeg };
}

// Heights in metres, bilinear between pixel centres; null outside the grid. The grid spans ±halfKm
// to its pixel edges, centred on the pole; by default halfKm = size × kmPerPixel / 2.
export function createDem({ data, size, kmPerPixel, dnToMeters = 0.5, halfKm }) {
  // the default keeps the phase 2 arithmetic exactly, so outputs stay byte-identical
  const c = halfKm === undefined ? size / 2 - 0.5 : halfKm / kmPerPixel - 0.5;
  function heightAtXY(xKm, yKm) {
    const col = xKm / kmPerPixel + c;
    const row = c - yKm / kmPerPixel;
    if (!(col >= 0 && row >= 0 && col <= size - 1 && row <= size - 1)) return null;
    const c0 = Math.min(Math.floor(col), size - 2), r0 = Math.min(Math.floor(row), size - 2);
    const fc = col - c0, fr = row - r0;
    const i = r0 * size + c0;
    const top = data[i] + (data[i + 1] - data[i]) * fc;
    const bottom = data[i + size] + (data[i + size + 1] - data[i + size]) * fc;
    return (top + (bottom - top) * fr) * dnToMeters;
  }
  // sample(): the same height, NaN instead of null (phase 4)
  function sample(xKm, yKm) {
    const v = heightAtXY(xKm, yKm);
    return v === null ? NaN : v;
  }
  // grid(xs, ys): heights at (xs[i], ys[j]) for many i, j, with the per-column and per-row arithmetic done
  // once (the tiled hillshade, phase 4) → (i, j) => metres | NaN. Same bilinear values as sample().
  function grid(xs, ys) {
    const C0 = new Int32Array(xs.length), FC = new Float64Array(xs.length), R0 = new Int32Array(ys.length), FR = new Float64Array(ys.length);
    for (let i = 0; i < xs.length; i++) {
      const col = xs[i] / kmPerPixel + c;
      if (!(col >= 0 && col <= size - 1)) { C0[i] = -1; continue; }
      C0[i] = Math.min(Math.floor(col), size - 2); FC[i] = col - C0[i];
    }
    for (let j = 0; j < ys.length; j++) {
      const row = c - ys[j] / kmPerPixel;
      if (!(row >= 0 && row <= size - 1)) { R0[j] = -1; continue; }
      R0[j] = Math.min(Math.floor(row), size - 2); FR[j] = row - R0[j];
    }
    return (i, j) => {
      const c0 = C0[i], r0 = R0[j];
      if (c0 < 0 || r0 < 0) return NaN;
      const k = r0 * size + c0, fc = FC[i];
      const top = data[k] + (data[k + 1] - data[k]) * fc;
      const bottom = data[k + size] + (data[k + size + 1] - data[k + size]) * fc;
      return (top + (bottom - top) * FR[j]) * dnToMeters;
    };
  }
  return {
    size, kmPerPixel, halfKm: halfKm ?? (size * kmPerPixel) / 2,
    heightAtXY, sample, grid,
    heightAt: (latDeg, lonDeg) => heightAtXY(...toXY(latDeg, lonDeg)),
  };
}

// ---------- tiled levels (task book phase 4 §4.1) ----------
// A tiled level is a grid of tilePx² tiles over ±halfKm; tile (row, col) covers
// x ∈ [−halfKm + col·T, −halfKm + (col+1)·T), y ∈ (halfKm − (row+1)·T, halfKm − row·T], T = tilePx × kmPerPixel,
// row 0 at the top (+y). Each tile file holds (tilePx + 2·apronPx)² Int16 LE values with one pixel of
// apron from the neighbours, so a bilinear lookup anywhere in the tile reads only that tile. −32768 is
// no data. Only the tiles listed in `tiles` ("rRRcCC") exist; the pack of a tile is "<name>_rRRcCC".

export const NO_DATA = -32768;
// At most this many tile packs for one viewport, whatever the canvas size: the level is chosen so that
// its listed tiles in view stay within the budget (64 tiles of 258² Int16 = 8.5 MB). See pick().
export const TILE_BUDGET = 64;

export const tileKm = (level) => level.tilePx * level.kmPerPixel;
export const tileGridSize = (level) => Math.round((2 * level.halfKm) / tileKm(level));
export const tileId = (row, col) => `r${String(row).padStart(2, '0')}c${String(col).padStart(2, '0')}`;
export const tilePack = (level, row, col) => `${level.name}_${tileId(row, col)}`;

// "<level>_rRRcCC" or "rRRcCC" → { level (name or null), row, col }; null if the name is not a tile.
export function parseTile(name) {
  const m = /^(?:(.+)_)?r(\d{2})c(\d{2})$/.exec(String(name));
  return m ? { level: m[1] ?? null, row: Number(m[2]), col: Number(m[3]) } : null;
}

// Tile extent in km: x ∈ [x0, x1), y ∈ (y0, y1].
export function tileBounds(level, row, col) {
  const T = tileKm(level);
  return { x0: -level.halfKm + col * T, x1: -level.halfKm + (col + 1) * T, y0: level.halfKm - (row + 1) * T, y1: level.halfKm - row * T };
}

// Row and column ranges (inclusive) of the tile grid that meet `bounds`, clipped to the grid; null if none.
function tileRange(level, b) {
  const T = tileKm(level), n = tileGridSize(level);
  if (!b) return { c0: 0, c1: n - 1, r0: 0, r1: n - 1 };
  const c0 = Math.max(0, Math.floor((b.x0 + level.halfKm) / T)), c1 = Math.min(n - 1, Math.floor((b.x1 + level.halfKm) / T));
  const r0 = Math.max(0, Math.floor((level.halfKm - b.y1) / T)), r1 = Math.min(n - 1, Math.floor((level.halfKm - b.y0) / T));
  return c1 < c0 || r1 < r0 ? null : { c0, c1, r0, r1 };
}

function listedSet(level) {
  if (level._listed) return level._listed;
  const set = new Set();
  for (const id of level.tiles ?? []) { const t = parseTile(id); if (t) set.add(t.row * 1000 + t.col); }
  if (Object.isExtensible(level)) Object.defineProperty(level, '_listed', { value: set, enumerable: false });
  return set;
}

// The listed tiles of a tiled level (terrain.json entry or createTiledDem result) that meet `bounds`
// (km; all of them without bounds), nearest the centre of `bounds` first: [{ row, col, id, pack }].
export function tilesIn(level, bounds) {
  const r = tileRange(level, bounds);
  if (!r) return [];
  const set = listedSet(level), out = [];
  for (let row = r.r0; row <= r.r1; row++) for (let col = r.c0; col <= r.c1; col++) {
    if (set.has(row * 1000 + col)) out.push({ row, col, id: tileId(row, col), pack: tilePack(level, row, col) });
  }
  if (bounds) {
    const mx = (bounds.x0 + bounds.x1) / 2, my = (bounds.y0 + bounds.y1) / 2, T = tileKm(level);
    const dist = (t) => Math.hypot(-level.halfKm + (t.col + 0.5) * T - mx, level.halfKm - (t.row + 0.5) * T - my);
    out.sort((a, b) => dist(a) - dist(b) || a.row - b.row || a.col - b.col);
  }
  return out;
}

// Is every part of `b` inside listed tiles of `level`?
function listedCovers(level, b) {
  const r = tileRange(level, b);
  if (!r) return false;
  const T = tileKm(level), n = tileGridSize(level);
  // the clipped range must reach the box edges, or part of the box is off the tile grid
  if (-level.halfKm + r.c0 * T > b.x0 || -level.halfKm + (r.c1 + 1) * T < b.x1 || level.halfKm - r.r0 * T < b.y1 || level.halfKm - (r.r1 + 1) * T > b.y0) return false;
  const set = listedSet(level);
  for (let row = r.r0; row <= r.r1; row++) for (let col = r.c0; col <= r.c1; col++) if (!set.has(row * 1000 + col)) return false;
  return n > 0;
}

// Heights from a tiled level; tiles arrive one by one with addTile(). Same interface as createDem
// (heightAtXY → metres | null, sample → metres | NaN), plus the tile bookkeeping.
export function createTiledDem({ name, kmPerPixel, dnToMeters = 0.5, tilePx, apronPx = 1, halfKm, tiles = [] }) {
  const level = { name, tiled: true, kmPerPixel, dnToMeters, tilePx, apronPx, halfKm, tiles: [...tiles] };
  const n = tileGridSize(level), T = tileKm(level), stride = tilePx + 2 * apronPx;
  const slots = new Array(n * n).fill(null);
  const listed = listedSet(level);
  let loaded = 0;
  function sample(xKm, yKm) {
    const gx = (xKm + halfKm) / kmPerPixel, gy = (halfKm - yKm) / kmPerPixel;   // in level pixels from the top left
    const tc = Math.floor(gx / tilePx), tr = Math.floor(gy / tilePx);
    if (tc < 0 || tr < 0 || tc >= n || tr >= n) return NaN;
    const t = slots[tr * n + tc];
    if (t === null) return NaN;
    const col = gx - tc * tilePx - 0.5 + apronPx, row = gy - tr * tilePx - 0.5 + apronPx;
    const c0 = Math.min(stride - 2, Math.max(0, Math.floor(col))), r0 = Math.min(stride - 2, Math.max(0, Math.floor(row)));
    const i = r0 * stride + c0;
    const a = t[i], b = t[i + 1], c = t[i + stride], d = t[i + stride + 1];
    if (a === NO_DATA || b === NO_DATA || c === NO_DATA || d === NO_DATA) return NaN;
    const fc = col - c0, fr = row - r0;
    const top = a + (b - a) * fc, bottom = c + (d - c) * fc;
    return (top + (bottom - top) * fr) * dnToMeters;
  }
  function heightAtXY(xKm, yKm) {
    const v = sample(xKm, yKm);
    return v === v ? v : null;
  }
  // grid(xs, ys) → (i, j) => metres | NaN at (xs[i], ys[j]): sample() with the per-column and per-row
  // arithmetic done once (the hillshade's inner loop).
  function grid(xs, ys) {
    const TC = new Int32Array(xs.length), C0 = new Int32Array(xs.length), FC = new Float64Array(xs.length);
    const TR = new Int32Array(ys.length), R0 = new Int32Array(ys.length), FR = new Float64Array(ys.length);
    for (let i = 0; i < xs.length; i++) {
      const gx = (xs[i] + halfKm) / kmPerPixel, tc = Math.floor(gx / tilePx);
      if (tc < 0 || tc >= n) { TC[i] = -1; continue; }
      const col = gx - tc * tilePx - 0.5 + apronPx, c0 = Math.min(stride - 2, Math.max(0, Math.floor(col)));
      TC[i] = tc; C0[i] = c0; FC[i] = col - c0;
    }
    for (let j = 0; j < ys.length; j++) {
      const gy = (halfKm - ys[j]) / kmPerPixel, tr = Math.floor(gy / tilePx);
      if (tr < 0 || tr >= n) { TR[j] = -1; continue; }
      const row = gy - tr * tilePx - 0.5 + apronPx, r0 = Math.min(stride - 2, Math.max(0, Math.floor(row)));
      TR[j] = tr * n; R0[j] = r0 * stride; FR[j] = row - r0;
    }
    return (i, j) => {
      const tc = TC[i], tr = TR[j];
      if (tc < 0 || tr < 0) return NaN;
      const t = slots[tr + tc];
      if (t === null) return NaN;
      const k = R0[j] + C0[i];
      const a = t[k], b = t[k + 1], c = t[k + stride], d = t[k + stride + 1];
      if (a === NO_DATA || b === NO_DATA || c === NO_DATA || d === NO_DATA) return NaN;
      const fc = FC[i], top = a + (b - a) * fc, bottom = c + (d - c) * fc;
      return (top + (bottom - top) * FR[j]) * dnToMeters;
    };
  }
  // tile: "rRRcCC", "<name>_rRRcCC" or { row, col }; data: Int16Array, or the pack's bytes (Uint8Array)
  function addTile(tile, data) {
    const t = typeof tile === 'string' ? parseTile(tile) : tile;
    if (!t || !(t.row >= 0 && t.row < n && t.col >= 0 && t.col < n)) throw new Error(`${name}: no tile ${tile}`);
    if (t.level && t.level !== name) throw new Error(`${name}: tile ${tile} belongs to ${t.level}`);
    let v = data;
    if (!(v instanceof Int16Array)) {
      const u = v instanceof Uint8Array ? v : new Uint8Array(v);
      v = u.byteOffset % 2 === 0 ? new Int16Array(u.buffer, u.byteOffset, u.byteLength >> 1) : new Int16Array(u.slice().buffer);
    }
    if (v.length !== stride * stride) throw new Error(`${name}: tile ${tile} has ${v.length} values, expected ${stride * stride}`);
    const k = t.row * n + t.col;
    if (slots[k] === null) loaded++;
    slots[k] = v;
    if (!listed.has(t.row * 1000 + t.col)) { listed.add(t.row * 1000 + t.col); level.tiles.push(tileId(t.row, t.col)); }
    return level;
  }
  const hasTile = (row, col) => row >= 0 && row < n && col >= 0 && col < n && slots[row * n + col] !== null;
  Object.assign(level, {
    tileKm: T, gridSize: n,
    sample, heightAtXY, grid,
    heightAt: (latDeg, lonDeg) => heightAtXY(...toXY(latDeg, lonDeg)),
    addTile, hasTile,
    // listed tiles meeting bounds that are not loaded yet, as pack names
    missing: (bounds) => tilesIn(level, bounds).filter((t) => !hasTile(t.row, t.col)).map((t) => t.pack),
  });
  Object.defineProperty(level, 'loadedCount', { get: () => loaded, enumerable: true });
  return level;
}

// Plain levels: a level covers a viewport when the hillshade can sample all of it: heights exist to half
// a pixel inside halfKm, and the slope reaches out one more step of up to two pixels, so keep 2.5 pixels
// clear (otherwise the edge columns come out black at ±156 km on the 120 m level).
const covers = (dem, b) => !b || Math.max(Math.abs(b.x0), Math.abs(b.x1), Math.abs(b.y0), Math.abs(b.y1)) + 2.5 * dem.kmPerPixel <= dem.halfKm + 1e-9;
const meets = (dem, b) => !b || (Math.min(b.x0, b.x1) < dem.halfKm && Math.max(b.x0, b.x1) > -dem.halfKm && Math.min(b.y0, b.y1) < dem.halfKm && Math.max(b.y0, b.y1) > -dem.halfKm);
const pad = (b, km) => b && { x0: b.x0 - km, y0: b.y0 - km, x1: b.x1 + km, y1: b.y1 + km };
const EPS = 1 + 1e-9;

// The phase 3 rule over the plain (untiled) levels, coarse to fine.
function pickPlain(plain, kmPerPxWanted, bounds) {
  if (!plain.length) return null;
  const ok = plain.filter((d) => covers(d, bounds));
  if (!ok.length) return plain.reduce((a, b) => (b.halfKm > a.halfKm ? b : a));
  return ok.find((d) => d.kmPerPixel <= kmPerPxWanted * EPS) ?? ok[ok.length - 1];
}

// Which tiled level to use for a viewport, and which tile packs it needs (shared by createPyramid and
// map/tiers.js). `levels`: terrain.json entries or pyramid levels, any order. Rule:
// 1. base = the phase 3 choice among the plain levels. If it is fine enough, no tiles.
// 2. Candidates: tiled levels finer than base with listed tiles in view. Take the coarsest that is fine
//    enough (else the finest); while its listed tiles in view exceed maxTiles, go one level coarser;
//    if none fits, no tiles.
// 3. Packs: the chosen level's tiles in view, then tiles of coarser candidates where the chosen level
//    has no listed tile, up to maxTiles in all (nearest the centre first).
// → { level, base, chain: [chosen, coarser candidates…] (fine to coarse), packs: [names] }, level null if none.
export function planTiles(levels, kmPerPxWanted, bounds, { maxTiles = TILE_BUDGET } = {}) {
  const sorted = [...levels].sort((a, b) => b.kmPerPixel - a.kmPerPixel);
  const base = pickPlain(sorted.filter((d) => !d.tiled), kmPerPxWanted, bounds);
  const none = { level: null, base, chain: [], packs: [] };
  if (base && base.kmPerPixel <= kmPerPxWanted * EPS) return none;
  const sel = (l) => pad(bounds, 2.5 * l.kmPerPixel);   // the hillshade samples a little beyond the view
  const cands = sorted.filter((d) => d.tiled && (!base || d.kmPerPixel < base.kmPerPixel) && tilesIn(d, sel(d)).length > 0);
  if (!cands.length) return none;
  let i = cands.findIndex((d) => d.kmPerPixel <= kmPerPxWanted * EPS);
  if (i < 0) i = cands.length - 1;
  while (i >= 0 && bounds && tilesIn(cands[i], sel(cands[i])).length > maxTiles) i--;
  if (i < 0) return none;
  const level = cands[i];
  const chain = cands.slice(0, i + 1).reverse();
  const packs = tilesIn(level, sel(level)).map((t) => t.pack);
  for (const coarser of chain.slice(1)) {
    for (const t of tilesIn(coarser, sel(coarser))) {
      if (packs.length >= maxTiles) break;
      const tb = tileBounds(coarser, t.row, t.col), b = sel(coarser);
      const part = b ? { x0: Math.max(tb.x0, b.x0), x1: Math.min(tb.x1, b.x1), y0: Math.max(tb.y0, b.y0), y1: Math.min(tb.y1, b.y1) } : tb;
      const finer = chain.slice(0, chain.indexOf(coarser));
      if (!finer.some((f) => listedCovers(f, part))) packs.push(t.pack);
    }
  }
  return { level, base, chain, packs };
}

// Several DEMs of the same ground (spec phase 3 §4.1, phase 4 §4.1). `levels` (coarse to fine, live) holds
// plain DEMs (createDem) and tiled ones (createTiledDem). pick(kmPerPxWanted, bounds) returns:
// - over the plain levels, as in phase 3: among the levels that cover `bounds` ({ x0, y0, x1, y1 } km),
//   the coarsest whose pixels are no coarser than kmPerPxWanted; if none is fine enough, the finest
//   covering one; if none covers, the widest one; null for an empty pyramid. With no tiled level this
//   is the whole rule, so phase 3 callers get exactly what they got.
// - when planTiles() chooses a tiled level: a composite DEM whose heights come from the chosen level and
//   fall back, point by point, to coarser levels where a tile is not listed, not loaded yet or has no
//   data: { tiled, composite, name, kmPerPixel (of the chosen level), halfKm, chain (fine to coarse),
//   heightAtXY, sample, heightAt, kmPerPixelAt(x, y), missing (pack names), version }.
export function createPyramid(levels = []) {
  const list = [];
  let version = 0;
  function add(dem) {
    const i = list.findIndex((d) => d.kmPerPixel === dem.kmPerPixel);
    if (i >= 0) list.splice(i, 1);
    list.push(dem);
    list.sort((a, b) => b.kmPerPixel - a.kmPerPixel);   // coarse to fine
    version++;
    return dem;
  }
  for (const dem of levels) add(dem);
  // a tile pack ("dem_40m_r27c30") into its level; returns false if no level of that name is in the pyramid
  function addTile(pack, data) {
    const t = parseTile(pack);
    const level = t && list.find((d) => d.tiled && d.name === t.level);
    if (!level) return false;
    level.addTile(t, data);
    version++;
    return true;
  }
  function pick(kmPerPxWanted, bounds, { maxTiles = TILE_BUDGET } = {}) {
    if (!list.some((d) => d.tiled)) return pickPlain(list, kmPerPxWanted, bounds);
    const plan = planTiles(list, kmPerPxWanted, bounds, { maxTiles });
    if (!plan.level) return plan.base;
    // fine to coarse: the chosen tiled level, coarser tiled candidates, plain levels finer than the base
    // that reach into the view (partial coverage is fine point by point), then the base
    const plainFiner = list.filter((d) => !d.tiled && d !== plan.base && plan.base && d.kmPerPixel < plan.base.kmPerPixel && d.kmPerPixel > plan.level.kmPerPixel && meets(d, bounds));
    const chain = [...plan.chain, ...plainFiner, ...(plan.base ? [plan.base] : [])].sort((a, b) => a.kmPerPixel - b.kmPerPixel);
    return composite(plan.level, chain, plan.base, plan.packs.filter((p) => { const t = parseTile(p); const l = list.find((d) => d.name === t.level); return !l.hasTile(t.row, t.col); }));
  }
  function composite(level, chain, base, missing) {
    function sample(xKm, yKm) {
      for (let i = 0; i < chain.length; i++) { const v = chain[i].sample(xKm, yKm); if (v === v) return v; }
      return NaN;
    }
    function heightAtXY(xKm, yKm) { const v = sample(xKm, yKm); return v === v ? v : null; }
    return {
      tiled: true, composite: true, name: level.name, level, base, chain, missing, version,
      kmPerPixel: level.kmPerPixel, halfKm: base?.halfKm ?? level.halfKm,
      sample, heightAtXY,
      heightAt: (latDeg, lonDeg) => heightAtXY(...toXY(latDeg, lonDeg)),
      // the resolution that serves this point (for "Terrain 120 m" next to the readout); null off all levels
      kmPerPixelAt(xKm, yKm) {
        for (let i = 0; i < chain.length; i++) { const v = chain[i].sample(xKm, yKm); if (v === v) return chain[i].kmPerPixel; }
        return null;
      },
    };
  }
  // tile packs a viewport still needs (listed, not loaded), at most maxTiles; [] when no tiled level is chosen
  function missing(kmPerPxWanted, bounds, opts) {
    const d = pick(kmPerPxWanted, bounds, opts);
    return d?.composite ? d.missing : [];
  }
  return { levels: list, add, addTile, pick, missing, get version() { return version; } };
}

// Distances along the ground (km): one pixel, then steps of max(pixel, 1.5 % of the distance).
const stepCache = new Map();
function steps(kmPerPixel, maxKm) {
  const key = `${kmPerPixel}:${maxKm}`;
  if (stepCache.has(key)) return stepCache.get(key);
  const cos = [], sin = [];
  for (let d = kmPerPixel; d <= maxKm; d += Math.max(kmPerPixel, 0.015 * d)) {
    cos.push(Math.cos(d / R));
    sin.push(Math.sin(d / R));
  }
  const out = { cos: Float64Array.from(cos), sin: Float64Array.from(sin) };
  stepCache.set(key, out);
  return out;
}

// Highest terrain elevation angle (deg) in each azimuth seen from a point 2 m above the ground.
export function horizonProfile(dem, latDeg, lonDeg, { azimuths = 360, maxKm = 300, observerM = OBSERVER_M } = {}) {
  const hP = dem.heightAt(latDeg, lonDeg);
  if (hP === null) return null;
  const phi = latDeg * RAD, lam = lonDeg * RAD;
  const cp = Math.cos(phi), sp = Math.sin(phi), cl = Math.cos(lam), sl = Math.sin(lam);
  const p0x = cp * cl, p0y = cp * sl, p0z = sp;
  const ex = -sl, ey = cl;                       // local east (ez = 0)
  const nx = -sp * cl, ny = -sp * sl, nz = cp;   // local north
  const r0 = R + (hP + observerM) / 1000;
  const { cos, sin } = steps(dem.kmPerPixel, maxKm);
  const out = new Float32Array(azimuths);
  for (let i = 0; i < azimuths; i++) {
    const a = (i * 2 * Math.PI) / azimuths;
    const ca = Math.cos(a), sa = Math.sin(a);
    const tx = ca * nx + sa * ex, ty = ca * ny + sa * ey, tz = ca * nz;
    let best = -Infinity;
    for (let k = 0; k < cos.length; k++) {
      const px = cos[k] * p0x + sin[k] * tx;
      const py = cos[k] * p0y + sin[k] * ty;
      const pz = cos[k] * p0z + sin[k] * tz;
      const q = 2 * R / (1 - pz);
      const h = dem.heightAtXY(q * py, q * px);
      if (h === null) break;
      const r1 = R + h / 1000;
      const e = Math.atan2(r1 * cos[k] - r0, r1 * sin[k]);
      if (e > best) best = e;
    }
    out[i] = best === -Infinity ? 0 : best * DEG;
  }
  return out;
}

export function horizonAt(profile, azDeg) {
  const n = profile.length;
  if (azDeg === null || azDeg === undefined) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += profile[i];
    return sum / n;
  }
  const x = ((((azDeg % 360) + 360) % 360) / 360) * n;
  const i0 = Math.floor(x) % n;
  const f = x - Math.floor(x);
  return profile[i0] + (profile[(i0 + 1) % n] - profile[i0]) * f;
}

const ZERO = Object.assign(() => 0, { profile: null });

export function skylineFor(dem, site) {
  if (!dem || !(site.latDeg <= TERRAIN_MAX_LAT)) return ZERO;
  const profile = horizonProfile(dem, site.latDeg, site.lonDeg);
  if (!profile) return ZERO;
  return Object.assign((azDeg) => horizonAt(profile, azDeg), { profile });
}
