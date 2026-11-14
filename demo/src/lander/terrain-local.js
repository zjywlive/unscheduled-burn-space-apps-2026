// Terrain around one site for the descent scene, finest first: the site's high-resolution LOLA patch (5, 10 or
// 20 m, 10 × 10 km; demo/src/hires.js), then the 20 m and 40 m tiles listed in the box, then the finest plain
// LOLA level that covers it. Data packs come from demo/data/js and load on demand (works from file://).
import { createDem, createTiledDem, tilesIn, toXY } from '../terrain.js';
import { loadData } from '../data-loader.js';

// The high-resolution patch for a site from a hires set (createHiresSet): the site's own entry if it has one,
// otherwise any patch that covers the ground within 1 km (a custom point near a listed site). → patch | null
export async function hiresPatchFor(hires, site) {
  if (!hires) return null;
  if (site.id && hires.entries.some((e) => e.id === site.id)) return hires.ensureSite(site.id);
  const [x, y] = toXY(site.latDeg, site.lonDeg);
  const got = (await hires.ensure({ x0: x - 1, x1: x + 1, y0: y - 1, y1: y + 1 })).filter(Boolean);
  return got.filter((p) => !Number.isNaN(p.sample(x, y))).sort((a, b) => a.kmPerPixel - b.kmPerPixel)[0] ?? null;
}

// The square around the site (half-size in metres) that lies inside the patch: where the descent mesh can use
// the patch's full resolution. Capped at maxCells cells across (vertex budget). → { stepM, halfM } | null
export function fineCore(patch, site, { maxCells = 400 } = {}) {
  if (!patch) return null;
  const [x, y] = toXY(site.latDeg, site.lonDeg);
  const b = patch.bounds;
  const insideKm = Math.min(x - b.x0, b.x1 - x, y - b.y0, b.y1 - y) - 2 * patch.kmPerPixel;
  if (!(insideKm > 0)) return null;
  const stepM = patch.kmPerPixel * 1000;
  // the fine square sits in the map plane, the mesh in local east/north (rotated): keep it within the inscribed circle
  const halfM = Math.min((maxCells / 2) * stepM, insideKm * 1000 * Math.SQRT1_2);
  return { stepM, halfM: Math.floor(halfM / stepM) * stepM };
}

// meta: demo/data/terrain.json; halfKm: half-size of the box around the site; maxTiles per tiled level;
// hires: a createHiresSet (or null for none).
export async function loadSiteTerrain(meta, site, { halfKm = 9, maxTiles = 25, hires = null, onProgress = () => {} } = {}) {
  const [x, y] = toXY(site.latDeg, site.lonDeg);
  const bounds = { x0: x - halfKm, x1: x + halfKm, y0: y - halfKm, y1: y + halfKm };
  const reach = Math.max(Math.abs(bounds.x0), Math.abs(bounds.x1), Math.abs(bounds.y0), Math.abs(bounds.y1));
  const chain = [];
  let patch = null;
  if (hires) {
    const e = hires.entries.find((q) => q.id === site.id);
    onProgress(`Loading ${e ? `${Math.round(e.kmPerPixel * 1000)} m ` : ''}high-resolution LOLA terrain`);
    patch = await hiresPatchFor(hires, site);
    if (patch) chain.push(patch);
  }
  const plain = (meta.levels ?? []).filter((l) => !l.tiled && l.kmPerPixel < 0.48 && reach < l.halfKm).sort((a, b) => a.kmPerPixel - b.kmPerPixel);
  if (plain[0]) {
    const lv = plain[0];
    onProgress(`Loading LOLA ${Math.round(lv.kmPerPixel * 1000)} m terrain`);
    const bytes = await loadData(lv.name);
    chain.push(createDem({ data: new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1), size: lv.size, kmPerPixel: lv.kmPerPixel, dnToMeters: lv.dnToMeters, halfKm: lv.halfKm }));
  }
  for (const lv of (meta.levels ?? []).filter((l) => l.tiled)) {
    const tiles = tilesIn(lv, bounds).slice(0, maxTiles);
    if (!tiles.length) continue;
    const dem = createTiledDem({ name: lv.name, kmPerPixel: lv.kmPerPixel, dnToMeters: lv.dnToMeters, tilePx: lv.tilePx, apronPx: lv.apronPx, halfKm: lv.halfKm, tiles: lv.tiles });
    onProgress(`Loading ${tiles.length} LOLA ${Math.round(lv.kmPerPixel * 1000)} m tiles`);
    const loaded = await Promise.all(tiles.map((t) => loadData(t.pack).then((b) => [t, b], () => null)));
    for (const it of loaded) if (it) dem.addTile(it[0], it[1]);
    chain.push(dem);
  }
  chain.sort((a, b) => a.kmPerPixel - b.kmPerPixel);
  const sample = (xKm, yKm) => {
    for (const d of chain) { const v = d.sample(xKm, yKm); if (v === v) return v; }
    return NaN;
  };
  // resolution (km per pixel) of the level that answers at a map point, or null
  const resAt = (xKm, yKm) => { for (const d of chain) { if (d.sample(xKm, yKm) === d.sample(xKm, yKm)) return d.kmPerPixel; } return null; };
  const hiresInfo = patch ? { id: patch.id, kmPerPixel: patch.kmPerPixel, bounds: patch.bounds, sizeKm: patch.n * patch.kmPerPixel } : null;
  return { sample, resAt, levelsKm: chain.map((d) => d.kmPerPixel), finestKm: chain[0]?.kmPerPixel ?? null, bounds, hires: hiresInfo, fine: fineCore(patch, site) };
}
