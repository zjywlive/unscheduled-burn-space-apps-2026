// Which data packs a viewport needs (spec phase 3 §4.1, §4.2, §5.1; phase 4 §4.1). Pack names are those
// of demo/data/js/<name>.js. The start-up packs are always listed first; the caller loads what is missing.
import { viewBounds } from './view.js';
import { planTiles, TILE_BUDGET as TERRAIN_TILE_BUDGET } from '../terrain.js';

export const STARTUP_PACKS = ['dem_480m', 'horizon_grid', 'slope_2km', 'shadow_2km'];
export const FINE_ZOOM = 2;          // 240 m terrain and the 1 km heat grid from here
export const FINEST_ZOOM = 4;        // 120 m terrain from here, inside ±FINEST_HALF_KM
export const FINEST_HALF_KM = 156;
// (G: tools/build.mjs takes no export lists, so the re-export is a const)
export const TILE_BUDGET = TERRAIN_TILE_BUDGET;

const reach = (b) => Math.max(Math.abs(b.x0), Math.abs(b.x1), Math.abs(b.y0), Math.abs(b.y1));
const meets = (b, h) => b.x0 < h && b.x1 > -h && b.y0 < h && b.y1 > -h;

// neededPacks(view): the phase 3 rule, unchanged.
// neededPacks(view, { levels, kmPerPx, bounds, maxTiles }) adds the elevation tiles (phase 4):
// - levels: terrain.json `levels` (plain and tiled entries); kmPerPx: the wanted km per canvas pixel
//   (what the hillshade will get, as for pyramid.pick); bounds: the ground under the canvas, km
//   (frameBounds for a rectangular canvas; default viewBounds(view)).
// - The tiles are planTiles(levels, kmPerPx, bounds).packs: those of one tiled level chosen so that its
//   listed tiles in view number at most maxTiles (default TILE_BUDGET = 64), plus tiles of coarser tiled
//   levels where that level has none, still within maxTiles in all. Nearest the centre first.
// - dem_120m is also listed (zoom ≥ 4) whenever tiles are, and the view reaches into ±156 km, since the
//   tiled terrain falls back to it point by point.
// Without levels or kmPerPx no tiles are listed. Already loaded packs stay in the list; filter with hasData.
export function neededPacks(view, opts) {
  const out = [...STARTUP_PACKS];
  if (!(view?.zoom >= FINE_ZOOM)) return out;
  out.push('dem_240m', 'horizon_1km', 'slope_1km', 'shadow_1km');
  const b = opts?.bounds ?? viewBounds(view);
  const tiles = opts?.levels && opts.kmPerPx > 0
    ? planTiles(opts.levels, opts.kmPerPx, b, { maxTiles: opts.maxTiles ?? TILE_BUDGET }).packs
    : [];
  if (view.zoom >= FINEST_ZOOM && (reach(b) <= FINEST_HALF_KM || (tiles.length && meets(b, FINEST_HALF_KM)))) out.push('dem_120m');
  out.push(...tiles);
  return out;
}
