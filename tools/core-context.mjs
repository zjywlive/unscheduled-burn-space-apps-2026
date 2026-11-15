// Node loader for the compute tier (demo/src/tools-core.js): reads demo/data the way the page does and
// returns the ctx that createCoreTools(ctx) takes. No dependencies; used by tests/tools-core.test.mjs,
// docs/phase5/c-scripts/demo.mjs and, later, an MCP server.
//
//   const ctx = loadCoreContext();                       // default data dir: <repo>/demo/data
//   const ctx = loadCoreContext({ dataDir, extras: false, dem240: 'lazy' });
//
// Files read (all in demo/data):
//   always        ephemeris.json, sites.json
//   terrain       terrain.json, dem_480m.bin (skyline, point height), horizon_grid.bin + slope_2km.bin +
//                 shadow_2km.bin (the 2 km cell grid: cell slope, PSR distance, route Sun shares)
//   extras        psr_120m.bin, nasa_sun_480m.bin, nasa_earth_480m.bin (point_facts, route PSR km)
//   dem240        dem_240m.bin (point slope on the planner grid, route_candidates); 'lazy' (default)
//                 reads it on first use, true reads it now, false leaves it out
//   v2 (MCP v2, docs/mcp-v2/DESIGN.md), all read on first use:
//     fine        () → the 1 km cell grid { grid, slope, shadow } (horizon_1km, slope_1km, shadow_1km)
//     ice         () → ice.js createIce over ice.json and its packs, or null when they are not built
//     readText    (path) → { text } | { error }: a local JSON file the user named (mission_open), ≤ 5 MB
//     siteTerrain (site, { halfKm }) → { sample(xKm, yKm) → m, finestKm }: the terrain around a point, finest first,
//                 as the page's lander/terrain-local.js builds it: the high-resolution patch (hires.json, 5–20 m),
//                 the 20 m and 40 m tiles, dem_120m, dem_240m (find_landing_sites' Monte Carlo touchdowns). Packs
//                 are read from the .bin files, or from the page's data/js packs where there is no .bin
// A missing file leaves its ctx entry out; the tools then say "not available" instead of guessing.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { createDem, createTiledDem, tilesIn, toXY } from '../demo/src/terrain.js';
import { createHiresSet } from '../demo/src/hires.js';
import { hiresPatchFor } from '../demo/src/lander/terrain-local.js';
import { createHeatGrid } from '../demo/src/heat.js';
import { staticGrid } from '../demo/src/score.js';
import { createPsr } from '../demo/src/psr.js';
import { createNasaAvg } from '../demo/src/nasa-avg.js';
import { createIce } from '../demo/src/ice.js';

export const MAX_MISSION_FILE_BYTES = 5 * 1024 * 1024;

export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../demo/data/', import.meta.url));

function reader(dataDir) {
  const dir = dataDir.endsWith('/') ? dataDir : `${dataDir}/`;
  const path = (name) => `${dir}${name}`;
  return {
    has: (name) => existsSync(path(name)),
    json: (name) => JSON.parse(readFileSync(path(name), 'utf8')),
    // a fresh buffer at offset 0, so Int16Array views work (as data-loader.js readData gives the page)
    bytes: (name) => new Uint8Array(readFileSync(path(name))),
    // a data pack by name: <name>.bin, or the page's data/js/<name>.js (one window.__lsnData("name","base64") line)
    pack: (name) => {
      if (existsSync(path(`${name}.bin`))) return new Uint8Array(readFileSync(path(`${name}.bin`)));
      const text = readFileSync(path(`js/${name}.js`), 'utf8'), i = text.indexOf(',"') + 2;
      return new Uint8Array(Buffer.from(text.slice(i, text.indexOf('"', i)), 'base64'));
    },
  };
}

// The terrain around a point, finest first (see the header). Levels and tiles are read once and kept.
function siteTerrainFor(r, meta) {
  const plain = new Map(), tiled = new Map(), triedTiles = new Set();
  const hires = r.has('hires.json') ? createHiresSet(r.json('hires.json'), async (name) => r.pack(name)) : null;
  const plainLevel = (lv) => { if (!plain.has(lv.name)) plain.set(lv.name, r.has(lv.file) ? demLevel(r, lv) : null); return plain.get(lv.name); };
  return async (site, { halfKm = 1 } = {}) => {
    const [x, y] = toXY(site.latDeg, site.lonDeg);
    const box = { x0: x - halfKm, x1: x + halfKm, y0: y - halfKm, y1: y + halfKm };
    const chain = [];
    let patch = null;
    try { patch = await hiresPatchFor(hires, site); } catch { patch = null; }
    if (patch) chain.push(patch);
    for (const lv of (meta.levels ?? []).filter((l) => l.tiled)) {
      if (!tiled.has(lv.name)) tiled.set(lv.name, createTiledDem({ name: lv.name, kmPerPixel: lv.kmPerPixel, dnToMeters: lv.dnToMeters, tilePx: lv.tilePx, apronPx: lv.apronPx, halfKm: lv.halfKm, tiles: lv.tiles }));
      const dem = tiled.get(lv.name), tiles = tilesIn(lv, box);
      for (const t of tiles) {
        if (triedTiles.has(t.pack)) continue;
        triedTiles.add(t.pack);
        try { dem.addTile(t, r.pack(t.pack)); } catch { /* a tile not shipped: the coarser levels answer */ }
      }
      if (tiles.length) chain.push(dem);
    }
    for (const lv of (meta.levels ?? []).filter((l) => !l.tiled && l.kmPerPixel <= 0.24)) { const d = plainLevel(lv); if (d) chain.push(d); }
    chain.sort((a, b) => a.kmPerPixel - b.kmPerPixel);
    const answers = chain.filter((d) => Number.isFinite(d.sample(x, y)));
    const sample = (xKm, yKm) => { for (const d of answers) { const v = d.sample(xKm, yKm); if (v === v) return v; } return NaN; };
    return { sample, finestKm: answers[0]?.kmPerPixel ?? null };
  };
}

function demLevel(r, level) {
  const b = r.bytes(level.file);
  return createDem({ data: new Int16Array(b.buffer, b.byteOffset, b.length >> 1), size: level.size, kmPerPixel: level.kmPerPixel, dnToMeters: level.dnToMeters, halfKm: level.halfKm });
}

export function loadCoreContext({ dataDir = DEFAULT_DATA_DIR, terrain = true, extras = true, dem240 = 'lazy' } = {}) {
  const r = reader(dataDir);
  const ctx = { eph: createEphemeris(r.json('ephemeris.json')), sites: r.json('sites.json'), files: ['ephemeris.json', 'sites.json'], readText: readLocalText };
  if (!terrain || !r.has('terrain.json')) return ctx;
  const meta = r.json('terrain.json');
  ctx.files.push('terrain.json');
  // the skyline DEM, exactly as main.js builds it (meta.dem, no halfKm: the phase 2 arithmetic)
  if (r.has(meta.dem.file)) {
    const b = r.bytes(meta.dem.file);
    ctx.dem = createDem({ data: new Int16Array(b.buffer, b.byteOffset, b.length >> 1), size: meta.dem.size, kmPerPixel: meta.dem.kmPerPixel, dnToMeters: meta.dem.dnToMeters });
    ctx.files.push(meta.dem.file);
  }
  // the 2 km cell grid, as main.js `coarse`
  const slope2 = meta.slope?.find((s) => s.cellKm === 2), shadow2 = meta.shadow?.find((s) => s.cellKm === 2);
  if (r.has(meta.horizon.file) && slope2 && shadow2 && r.has(slope2.file) && r.has(shadow2.file)) {
    const grid = createHeatGrid({ horizon: r.bytes(meta.horizon.file), ...meta.horizon });
    ctx.coarse = { grid, label: '2 km', slope: staticGrid(r.bytes(slope2.file), slope2.scale ?? 0.25), shadow: staticGrid(r.bytes(shadow2.file), 1) };
    ctx.files.push(meta.horizon.file, slope2.file, shadow2.file);
  }
  if (extras) {
    if (meta.psr && r.has(meta.psr.file)) { ctx.psr = createPsr(r.bytes(meta.psr.file), meta.psr); ctx.files.push(meta.psr.file); }
    const ns = meta.nasaAvg?.sun, ne = meta.nasaAvg?.earth;
    const sun = ns && r.has(ns.file) ? r.bytes(ns.file) : null, earth = ne && r.has(ne.file) ? r.bytes(ne.file) : null;
    if (sun || earth) { ctx.nasa = createNasaAvg({ sun, earth }, meta.nasaAvg); ctx.files.push(...[sun && ns.file, earth && ne.file].filter(Boolean)); }
  }
  const l240 = meta.levels?.find((l) => l.name === 'dem_240m');
  if (dem240 && l240 && r.has(l240.file)) {
    if (dem240 === 'lazy') {
      let cached = null;
      ctx.dem240 = () => (cached ??= demLevel(r, l240));
    } else {
      ctx.dem240 = demLevel(r, l240);
    }
    ctx.files.push(l240.file);
  }
  // v2: the 1 km grid for refining search candidates, the ice packs and local mission files
  const h1 = meta.horizons?.find((h) => h.cellKm === 1), slope1 = meta.slope?.find((s) => s.cellKm === 1), shadow1 = meta.shadow?.find((s) => s.cellKm === 1);
  if (h1 && slope1 && shadow1 && r.has(h1.file) && r.has(slope1.file) && r.has(shadow1.file)) {
    let fine = null;
    ctx.fine = () => (fine ??= { grid: createHeatGrid({ horizon: r.bytes(h1.file), ...h1 }), label: '1 km', slope: staticGrid(r.bytes(slope1.file), slope1.scale ?? 0.25), shadow: staticGrid(r.bytes(shadow1.file), 1) });
    ctx.files.push(h1.file, slope1.file, shadow1.file);
  }
  ctx.siteTerrain = siteTerrainFor(r, meta);
  if (r.has('ice.json')) {
    let ice;
    ctx.ice = () => {
      if (ice === undefined) {
        try { ice = createIce({ meta: r.json('ice.json'), read: (name) => r.bytes(name) }) ?? null; }
        catch (e) { ice = null; console.error(`ice packs not loaded: ${e.message}`); }
      }
      return ice;
    };
    ctx.files.push('ice.json');
  }
  return ctx;
}

// Node only: what mission_open may read. A path the user gave, JSON or GeoJSON text, at most 5 MB.
export function readLocalText(path) {
  if (typeof path !== 'string' || !path.trim()) return { error: 'path must be a non-empty string.' };
  const full = resolvePath(path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  let st;
  try { st = statSync(full); } catch { return { error: `No file at ${full}.` }; }
  if (!st.isFile()) return { error: `${full} is not a file.` };
  if (st.size > MAX_MISSION_FILE_BYTES) return { error: `${full} is ${Math.round(st.size / 1048576)} MB; mission files are read up to 5 MB.` };
  try { return { text: readFileSync(full, 'utf8'), path: full }; } catch (e) { return { error: `Cannot read ${full}: ${e.message}` }; }
}
