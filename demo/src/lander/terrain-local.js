// Terrain around one site for the descent scene: the finest plain LOLA level that covers the box, plus the 40 m
// and 20 m tiles listed there (data packs from demo/data/js, loaded on demand; works from file://).
import { createDem, createTiledDem, tilesIn, toXY } from '../terrain.js';
import { loadData } from '../data-loader.js';

// meta: demo/data/terrain.json; halfKm: half-size of the box around the site; maxTiles per tiled level.
export async function loadSiteTerrain(meta, site, { halfKm = 9, maxTiles = 25, onProgress = () => {} } = {}) {
  const [x, y] = toXY(site.latDeg, site.lonDeg);
  const bounds = { x0: x - halfKm, x1: x + halfKm, y0: y - halfKm, y1: y + halfKm };
  const reach = Math.max(Math.abs(bounds.x0), Math.abs(bounds.x1), Math.abs(bounds.y0), Math.abs(bounds.y1));
  const chain = [];
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
  return { sample, levelsKm: chain.map((d) => d.kmPerPixel), finestKm: chain[0]?.kmPerPixel ?? null, bounds };
}
