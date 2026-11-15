// Diviner thermally stable, possible ice (Schorghofer & Williams 2020; DESIGN §10).
// createIce({ meta, read }) → ice | null; meta = ice.json, read(name) → Uint8Array (synchronous).
// ice.meta; ice.shallowMaxM (the build's default, 1 m).
// ice.at(xKm, yKm) → { depthM, tmaxK, cls } | null outside coverage; cls is surface / shallow / deep / none.
// ice.distKm(cellKm, k, cls) → map-plane km | null, for 2 km / 1 km cells; 0 = mostly qualifying patch.
// ice.nearest(xKm, yKm, { cls, withinKm, depthMaxM }) →
//   { xKm, yKm, latDeg, lonDeg, distKm, depthM, tmaxK, cls, patchKm2 } | null.
// Target classes: surface = depth 0; shallow = depth ≤ depthMaxM (default shallowMaxM, surface included);
// any = any finite depth. Targets belong to 8-connected patches ≥ 0.5 km² ground area of that class.
// Non-default drill depths reclassify AND relabel patches using conservatively rounded-up cm depths.
// at() reports individual pixels, including small patches; nearest() measures to pixel centres, not edges.
// Map km follow terrain.js; raster rows run +y to −y, columns −x to +x. No Node imports or I/O here.
import { fromXY } from './terrain.js';

const MOON_R_KM = 1737.4;
const ICE_CLASSES = ['surface', 'shallow', 'any'];

// Shared with the offline builder: label a depth-threshold mask; sum stereographically corrected ground
// pixel areas. labels[p] = component id (0 for no match); areas[id] includes small components too.
export function icePatches(depth, grid, depthMaxM, minPatchKm2 = 0.5) {
  const { size, kmPerPixel: step, halfKm } = grid;
  const labels = new Uint32Array(depth.length), areas = [0];
  let queue = new Uint32Array(Math.min(depth.length, 65536)), kept = 0;
  for (let start = 0; start < depth.length; start++) {
    if (labels[start] || depth[start] === 255 || depth[start] / 100 > depthMaxM) continue;
    const id = areas.length;
    let head = 0, tail = 1, area = 0;
    queue[0] = start; labels[start] = id;
    while (head < tail) {
      const p = queue[head++], row = Math.floor(p / size), col = p % size;
      const x = -halfKm + (col + 0.5) * step, y = halfKm - (row + 0.5) * step;
      const scale = 1 + (x * x + y * y) / (4 * MOON_R_KM * MOON_R_KM);
      area += step * step / (scale * scale);
      for (let r = Math.max(0, row - 1); r <= Math.min(size - 1, row + 1); r++) {
        for (let c = Math.max(0, col - 1); c <= Math.min(size - 1, col + 1); c++) {
          const q = r * size + c;
          if (labels[q] || depth[q] === 255 || depth[q] / 100 > depthMaxM) continue;
          labels[q] = id;
          if (tail === queue.length) { const more = new Uint32Array(queue.length * 2); more.set(queue); queue = more; }
          queue[tail++] = q;
        }
      }
    }
    areas.push(area);
    if (area >= minPatchKm2) kept++;
  }
  return { labels, areas, patches: areas.length - 1, kept };
}

export function createIce({ meta, read } = {}) {
  if (!meta || typeof read !== 'function') return null;
  const { size, kmPerPixel: step, halfKm, radiusKm } = meta.grid ?? {};
  if (meta.version !== 1 || !Number.isInteger(size) || size < 1 || !(step > 0) ||
      !(halfKm > 0) || !(radiusKm > 0) || Math.abs(2 * halfKm - size * step) > 1e-6) {
    throw new Error('ice: invalid grid or unsupported pack version');
  }
  const bytes = (pack, length) => {
    const b = read(pack.file);
    if (!(b instanceof Uint8Array) || b.length !== length) throw new Error(`ice: invalid pack ${pack.file}, expected ${length} bytes`);
    return b;
  };
  const depth = bytes(meta.depth, size * size), tmax = bytes(meta.tmax, size * size);
  const shallowMaxM = meta.shallowMaxM, minPatchKm2 = meta.patch.minKm2;
  const distances = new Map(), patches = new Map();
  let custom = null, maxDepthM = 0;
  for (const d of depth) if (d !== 255) maxDepthM = Math.max(maxDepthM, d / 100);
  const covered = (x, y) => Number.isFinite(x) && Number.isFinite(y) && x * x + y * y <= radiusKm * radiusKm;
  function index(x, y) {
    if (!covered(x, y)) return -1;
    const c = Math.floor((x + halfKm) / step), r = Math.floor((halfKm - y) / step);
    return c >= 0 && r >= 0 && c < size && r < size ? r * size + c : -1;
  }
  function sample(p) {
    const d = depth[p] === 255 ? null : depth[p] / 100;
    return { depthM: d, tmaxK: tmax[p] === 255 ? null : tmax[p] * 2,
      cls: d === null ? 'none' : d === 0 ? 'surface' : d <= shallowMaxM ? 'shallow' : 'deep' };
  }
  function at(x, y) {
    const p = index(x, y);
    return p < 0 || tmax[p] === 255 ? null : sample(p);
  }
  function distKm(cellKm, k, cls = 'shallow') {
    const pack = meta.distances.find((d) => d.cellKm === cellKm), plane = ICE_CLASSES.indexOf(cls);
    if (!pack || plane < 0 || !Number.isInteger(k) || k < 0 || k >= pack.size * pack.size) return null;
    if (!distances.has(cellKm)) distances.set(cellKm, bytes(pack, pack.size * pack.size * 3));
    const value = distances.get(cellKm)[plane * pack.size * pack.size + k];
    return value === 255 ? null : value;
  }
  // Two permanent masks (surface / all finite in this dataset), plus at most one custom drill-depth mask.
  function patchFor(limit) {
    const cut = Math.min(limit, maxDepthM);
    if (cut === 0 || cut === maxDepthM || cut === shallowMaxM) {
      if (!patches.has(cut)) patches.set(cut, icePatches(depth, meta.grid, cut, minPatchKm2));
      return patches.get(cut);
    }
    if (custom?.cut !== cut) custom = { cut, ...icePatches(depth, meta.grid, cut, minPatchKm2) };
    return custom;
  }
  function nearest(x, y, { cls = 'shallow', withinKm = 5, depthMaxM = shallowMaxM } = {}) {
    const p0 = index(x, y);
    if (p0 < 0 || tmax[p0] === 255 || !ICE_CLASSES.includes(cls) ||
        !Number.isFinite(withinKm) || withinKm < 0 ||
        (cls === 'shallow' && (!Number.isFinite(depthMaxM) || depthMaxM < 0))) return null;
    const { labels, areas } = patchFor(cls === 'surface' ? 0 : cls === 'any' ? Infinity : depthMaxM);
    const c0 = p0 % size, r0 = Math.floor(p0 / size);
    const maxRing = Math.min(size - 1, Math.ceil(withinKm / step) + 1);
    let best = -1, bestSq = withinKm * withinKm;
    const visit = (r, c) => {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      const p = r * size + c;
      if (!labels[p] || areas[labels[p]] < minPatchKm2) return;
      const dx = -halfKm + (c + 0.5) * step - x, dy = halfKm - (r + 0.5) * step - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestSq && (best < 0 || d2 < bestSq || p < best)) { best = p; bestSq = d2; }
    };
    for (let ring = 0; ring <= maxRing; ring++) {
      if (best >= 0 && ring > 1 && (ring - 1) * step > Math.sqrt(bestSq)) break;
      if (ring === 0) { visit(r0, c0); continue; }
      for (let c = Math.max(0, c0 - ring); c <= Math.min(size - 1, c0 + ring); c++) {
        visit(r0 - ring, c); visit(r0 + ring, c);
      }
      for (let r = Math.max(0, r0 - ring + 1); r <= Math.min(size - 1, r0 + ring - 1); r++) {
        visit(r, c0 - ring); visit(r, c0 + ring);
      }
    }
    if (best < 0) return null;
    const xKm = -halfKm + (best % size + 0.5) * step, yKm = halfKm - (Math.floor(best / size) + 0.5) * step;
    return { xKm, yKm, ...fromXY(xKm, yKm), distKm: Math.sqrt(bestSq), ...sample(best), patchKm2: areas[labels[best]] };
  }
  return { meta, shallowMaxM, at, distKm, nearest };
}
