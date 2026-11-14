// Pointer snapping (phase 3 §4.5): the nearest target within radiusPx CSS pixels of the pointer.
// targets: [{ id, kind, name, px, py, ... }] in map-frame CSS pixels; extra fields pass through.
export const SNAP_RADIUS_PX = 16;

export function findSnap(targets, px, py, radiusPx = SNAP_RADIUS_PX) {
  let best = null, bestD = radiusPx;
  for (const t of targets ?? []) {
    const d = Math.hypot(t.px - px, t.py - py);
    if (d <= bestD && (best === null || d < bestD)) { best = t; bestD = d; }
  }
  return best;
}
