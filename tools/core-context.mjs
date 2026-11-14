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
// A missing file leaves its ctx entry out; the tools then say "not available" instead of guessing.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { createDem } from '../demo/src/terrain.js';
import { createHeatGrid } from '../demo/src/heat.js';
import { staticGrid } from '../demo/src/score.js';
import { createPsr } from '../demo/src/psr.js';
import { createNasaAvg } from '../demo/src/nasa-avg.js';

export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../demo/data/', import.meta.url));

function reader(dataDir) {
  const dir = dataDir.endsWith('/') ? dataDir : `${dataDir}/`;
  const path = (name) => `${dir}${name}`;
  return {
    has: (name) => existsSync(path(name)),
    json: (name) => JSON.parse(readFileSync(path(name), 'utf8')),
    // a fresh buffer at offset 0, so Int16Array views work (as data-loader.js readData gives the page)
    bytes: (name) => new Uint8Array(readFileSync(path(name))),
  };
}

function demLevel(r, level) {
  const b = r.bytes(level.file);
  return createDem({ data: new Int16Array(b.buffer, b.byteOffset, b.length >> 1), size: level.size, kmPerPixel: level.kmPerPixel, dnToMeters: level.dnToMeters, halfKm: level.halfKm });
}

export function loadCoreContext({ dataDir = DEFAULT_DATA_DIR, terrain = true, extras = true, dem240 = 'lazy' } = {}) {
  const r = reader(dataDir);
  const ctx = { eph: createEphemeris(r.json('ephemeris.json')), sites: r.json('sites.json'), files: ['ephemeris.json', 'sites.json'] };
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
  return ctx;
}
