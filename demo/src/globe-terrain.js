// Global lunar terrain model (phase 1, docs/PHASES.md): one height for any latitude and longitude on the
// Moon, from the finest level that is loaded at that point.
//
//   south pole   the existing polar-stereographic pyramid (20 m → 480 m), below about 75°S
//   north pole   globe_n480, LOLA 75°N–90°N averaged to 480 m
//   G2           globe_g2 tiles, LOLA LDEM_64, 474 m (built locally; absent packs fall back)
//   G1           globe_g1 tiles, LOLA LDEM_16, 1.9 km
//   G0           globe_g0, LOLA LDEM_4, 7.6 km, always loaded
//
// All levels are LOLA heights in 0.5 m DN above the 1737.4 km sphere, so they stack without re-levelling.
// Pack layout and encoding: tools/build-global.mjs.
import { toXY, createDem } from './terrain.js';

export const MOON_R_KM = 1737.4;
export const DN_TO_M = 0.5;
const RAD = Math.PI / 180;

export const G0 = Object.freeze({ name: 'globe_g0', label: '7.6 km', ppd: 4, width: 1440, height: 720, kmPerPixel: 7.58084 });
export const G1 = Object.freeze({ name: 'globe_g1', label: '1.9 km', ppd: 16, tileDeg: 15, tilePx: 240, apronPx: 1, rows: 12, cols: 24, kmPerPixel: 1.89521 });
export const G2 = Object.freeze({ name: 'globe_g2', label: '474 m', ppd: 64, tileDeg: 3.75, tilePx: 240, apronPx: 1, rows: 48, cols: 96, kmPerPixel: 0.473802 });
export const TILED = Object.freeze([G1, G2]);
export const NORTH = Object.freeze({ name: 'globe_n480', label: '480 m (north pole)', size: 1906, kmPerPixel: 0.48, minLatDeg: 75 });
export const SOUTH_MAX_LAT = -75;

export const normLon = (lon) => ((lon % 360) + 360) % 360;

// North polar stereographic (PDS LOLA polar products): x = r sin λ, y = −r cos λ, r = 2R tan((90° − φ)/2).
export function toXYNorth(latDeg, lonDeg) {
  const r = 2 * MOON_R_KM * Math.tan(((90 - latDeg) / 2) * RAD);
  return [r * Math.sin(lonDeg * RAD), -r * Math.cos(lonDeg * RAD)];
}

// Undoes the delta coding of tools/build-global.mjs in place (Int16 wrap-around, as the encoder).
export function deltaDecode(d, width) {
  for (let i = 0; i < d.length; i++) {
    const col = i % width;
    if (col > 0) d[i] = d[i] + d[i - 1];
    else if (i >= width) d[i] = d[i] + d[i - width];
  }
  return d;
}

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Pack bytes (gzip of delta-coded Int16 LE) → Int16Array of heights in DN.
export async function decodePack(bytes, width) {
  const raw = await gunzip(bytes);
  const out = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  return deltaDecode(out, width ?? Math.round(Math.sqrt(out.length)));
}

export const tileName = (level, r, c) => `${level.name}_r${String(r).padStart(2, '0')}c${String(c).padStart(2, '0')}`;

export function tileOf(level, latDeg, lonDeg) {
  const r = Math.min(level.rows - 1, Math.max(0, Math.floor((90 - latDeg) / level.tileDeg)));
  const c = Math.min(level.cols - 1, Math.floor(normLon(lonDeg) / level.tileDeg));
  return { r, c };
}

// Tiles of a level touching a lat/lon box (lon may run past 360 or below 0; it wraps).
export function tilesInBox(level, latMin, latMax, lonMin, lonMax) {
  const r0 = Math.max(0, Math.floor((90 - latMax) / level.tileDeg)), r1 = Math.min(level.rows - 1, Math.floor((90 - latMin) / level.tileDeg - 1e-9));
  const span = lonMax - lonMin;
  const c0 = Math.floor(lonMin / level.tileDeg), c1 = span >= 360 ? c0 + level.cols - 1 : Math.floor(lonMax / level.tileDeg - 1e-9);
  const out = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push({ r, c: ((c % level.cols) + level.cols) % level.cols });
  return out;
}

// Bilinear height (DN) in the whole G0 grid; longitude wraps, latitude clamps to the outer pixel centres.
export function sampleG0(data, latDeg, lonDeg) {
  const { width, height, ppd } = G0;
  const y = Math.min(height - 1, Math.max(0, (90 - latDeg) * ppd - 0.5));
  const x = normLon(lonDeg) * ppd - 0.5;
  const y0 = Math.min(height - 2, Math.floor(y)), fy = y - y0;
  const xf = Math.floor(x), fx = x - xf;
  const x0 = ((xf % width) + width) % width, x1 = (x0 + 1) % width;
  const a = data[y0 * width + x0], b = data[y0 * width + x1], c = data[(y0 + 1) * width + x0], d = data[(y0 + 1) * width + x1];
  const top = a + (b - a) * fx, bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}

// Bilinear height (DN) inside one tile with its apron.
export function sampleTile(level, tile, r, c, latDeg, lonDeg) {
  const s = level.tilePx + 2 * level.apronPx;
  const y = (90 - latDeg) * level.ppd - r * level.tilePx - 0.5 + level.apronPx;
  let lon = normLon(lonDeg);
  if (c === 0 && lon > 360 - level.tileDeg) lon -= 360;
  const x = lon * level.ppd - c * level.tilePx - 0.5 + level.apronPx;
  const y0 = Math.min(s - 2, Math.max(0, Math.floor(y))), x0 = Math.min(s - 2, Math.max(0, Math.floor(x)));
  const fy = Math.min(1, Math.max(0, y - y0)), fx = Math.min(1, Math.max(0, x - x0));
  const i = y0 * s + x0;
  const top = tile[i] + (tile[i + 1] - tile[i]) * fx, bottom = tile[i + s] + (tile[i + s + 1] - tile[i + s]) * fx;
  return top + (bottom - top) * fy;
}

// load(name) → Promise<Uint8Array> of a data pack (data-loader.js loadData in the page).
// south: optional polar pyramid levels (terrain.js createDem / createTiledDem objects with sample(x, y)),
// passed as a function returning the current list, coarse to fine; see southFrom().
export function createGlobeTerrain({ load, south = null, onChange = () => {} }) {
  let g0 = null, north = null, version = 0;
  const tiles = new Map(TILED.map((l) => [l.name, new Map()]));   // level → "r,c" → Int16Array
  const pending = new Map();   // pack name → Promise
  const failed = new Set();

  async function init() {
    g0 = await decodePack(await load(G0.name), G0.width);
    try {
      const data = await decodePack(await load(NORTH.name), NORTH.size);
      north = createDem({ data, size: NORTH.size, kmPerPixel: NORTH.kmPerPixel, dnToMeters: DN_TO_M });
    } catch { north = null; }
    version++;
    return api;
  }

  function hasTile(level, r, c) { return tiles.get(level.name).has(`${r},${c}`); }

  function loadTile(level, r, c) {
    const name = tileName(level, r, c);
    if (hasTile(level, r, c)) return Promise.resolve(true);
    if (failed.has(name)) return Promise.resolve(false);
    if (pending.has(name)) return pending.get(name);
    const p = load(name)
      .then((bytes) => decodePack(bytes, level.tilePx + 2 * level.apronPx))
      .then((data) => { tiles.get(level.name).set(`${r},${c}`, data); version++; onChange({ level, r, c }); return true; })
      .catch(() => { failed.add(name); return false; })
      .finally(() => pending.delete(name));
    pending.set(name, p);
    return p;
  }

  // Loads (at most max) tiles of a level over a lat/lon box; resolves with the number newly loaded.
  async function need(level, latMin, latMax, lonMin, lonMax, { max = 48 } = {}) {
    const want = tilesInBox(level, latMin, latMax, lonMin, lonMax).filter(({ r, c }) => !hasTile(level, r, c) && !failed.has(tileName(level, r, c))).slice(0, max);
    const done = await Promise.all(want.map(({ r, c }) => loadTile(level, r, c)));
    return done.filter(Boolean).length;
  }

  // [metres, source label, ground km per pixel] from the finest level loaded at the point.
  function sample(latDeg, lonDeg) {
    if (south && latDeg < SOUTH_MAX_LAT) {
      const levels = south();
      if (levels.length) {
        const [x, y] = toXY(latDeg, lonDeg);
        for (let i = levels.length - 1; i >= 0; i--) {
          const v = levels[i].sample(x, y);
          if (v === v) return [v, `${Math.round(levels[i].kmPerPixel * 1000)} m (south pole)`, levels[i].kmPerPixel];
        }
      }
    }
    if (north && latDeg > NORTH.minLatDeg) {
      const v = north.sample(...toXYNorth(latDeg, lonDeg));
      if (v === v) return [v, NORTH.label, NORTH.kmPerPixel];
    }
    for (let i = TILED.length - 1; i >= 0; i--) {
      const level = TILED[i];
      const { r, c } = tileOf(level, latDeg, lonDeg);
      const t = tiles.get(level.name).get(`${r},${c}`);
      if (t) return [sampleTile(level, t, r, c, latDeg, lonDeg) * DN_TO_M, level.label, level.kmPerPixel];
    }
    if (!g0) return [0, 'none', null];
    return [sampleG0(g0, latDeg, lonDeg) * DN_TO_M, G0.label, G0.kmPerPixel];
  }

  const api = {
    init, need, loadTile, hasTile, sample,
    heightAt: (latDeg, lonDeg) => sample(latDeg, lonDeg)[0],
    get version() { return version; },
    get ready() { return g0 !== null; },
    get hasNorth() { return north !== null; },
    isMissing: (level, r, c) => failed.has(tileName(level, r, c)),
  };
  return api;
}

// A south() function for createGlobeTerrain from a terrain.js pyramid: its levels, coarse to fine.
export const southFrom = (pyramid) => () => pyramid.levels;
