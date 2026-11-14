// Drawing tools as a pure reducer (phase 3 §4.6, §5.5). The map view feeds pointer and key events
// in map coordinates; the reducer returns the next state and, when a shape is finished, the shape.
//
// Tools: 'select' (the reducer ignores every event), 'rect', 'circle', 'polygon', 'route'.
// Event: { type: 'down' | 'move' | 'up' | 'dblclick' | 'key', xKm, yKm, px, py, key, kmPerPx? }
//   xKm, yKm  the point, already snapped to a site by the caller when it snapped
//   px, py    the same point in map-frame CSS pixels
//   kmPerPx   optional; when given, the polygon close test measures the first vertex in current
//             pixels (so it survives a zoom between clicks); otherwise the pixels stored with it
//   key       'Escape' cancels, 'Backspace' drops the last vertex, 'Enter' clicks at (xKm, yKm)
//             (the keyboard crosshair). Enter without xKm, or Enter twice on the same spot, finishes
//             a route or closes a polygon (the keyboard double-click).
// State: { tool, points: [[x, y]…], pxs: [[px, py]…], kpps: [kmPerPx | null…], anchor: [x, y] | null, anchorPx,
//          cursor: [x, y] | null, cursorPx, dragging }. points/pxs/kpps are polygon and route vertices with
//          the pixel position and scale each was placed at; anchor is the first corner of a rectangle or
//          the centre of a circle.
// A finished polygon whose outline crosses itself is not returned: the result carries
// rejected: 'self-intersecting' and the drawing starts again (its area would cancel out while its
// cells still count).
import { selfIntersects } from './shapes.js';

export const CLOSE_RADIUS_PX = 12;
const CLICK_PX = 4;            // a press that moves less than this is a click, not a drag
const MIN_POINTS = { polygon: 3, route: 2 };

export function initialDraw(tool = 'select') {
  return { tool, points: [], pxs: [], kpps: [], anchor: null, anchorPx: null, cursor: null, cursorPx: null, dragging: false };
}

const hasXY = (e) => Number.isFinite(e.xKm) && Number.isFinite(e.yKm);
const pxDist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : Infinity);

function firstVertexPx(state, e) {
  // distance in current pixels from the event to the first vertex
  if (!state.points.length) return Infinity;
  if (Number.isFinite(e.kmPerPx) && e.kmPerPx > 0) {
    const [x, y] = state.points[0];
    return Math.hypot(e.xKm - x, e.yKm - y) / e.kmPerPx;
  }
  return pxDist(state.pxs[0], [e.px, e.py]);
}

function shapeFromAnchor(tool, a, b) {
  if (tool === 'rect') {
    const s = { type: 'rect', x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
    return s.x1 > s.x0 && s.y1 > s.y0 ? s : null;
  }
  const rKm = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return rKm > 0 ? { type: 'circle', cx: a[0], cy: a[1], rKm } : null;
}

// Drop vertices that repeat the one before (a double-click lands two clicks on one spot). Two vertices
// are the same spot when their ground distance is under CLICK_PX at the finer of the two scales they
// were placed at; pixels alone would merge far-apart points placed at different zooms.
function sameSpot(state, a, b) {
  const p = state.points[a], q = state.points[b];
  if (p[0] === q[0] && p[1] === q[1]) return true;
  const ka = state.kpps?.[a], kb = state.kpps?.[b];
  if (Number.isFinite(ka) && Number.isFinite(kb)) return Math.hypot(p[0] - q[0], p[1] - q[1]) < CLICK_PX * Math.min(ka, kb);
  return pxDist(state.pxs[a], state.pxs[b]) < CLICK_PX;
}

function dedupe(state) {
  const keep = [];
  state.points.forEach((p, n) => { if (!keep.length || !sameSpot(state, keep[keep.length - 1], n)) keep.push(n); });
  return { ...state, points: keep.map((n) => state.points[n]), pxs: keep.map((n) => state.pxs[n]), kpps: keep.map((n) => state.kpps?.[n] ?? null) };
}

function finish(state) {
  const s = dedupe(state);
  if (s.points.length < MIN_POINTS[state.tool]) return { state: s };
  if (state.tool === 'polygon' && selfIntersects(s.points)) return { state: initialDraw(state.tool), rejected: 'self-intersecting' };
  return { state: initialDraw(state.tool), completed: { type: state.tool, points: s.points.map((p) => [p[0], p[1]]) } };
}

function addVertex(state, e) {
  const p = [e.xKm, e.yKm], q = [e.px, e.py];
  if (state.tool === 'polygon' && state.points.length >= MIN_POINTS.polygon && firstVertexPx(state, e) <= CLOSE_RADIUS_PX) return finish(state);
  const kpp = Number.isFinite(e.kmPerPx) && e.kmPerPx > 0 ? e.kmPerPx : null;
  return { state: { ...state, points: [...state.points, p], pxs: [...state.pxs, q], kpps: [...(state.kpps ?? []), kpp], cursor: p, cursorPx: q } };
}

// A click (pointer down, or Enter at the crosshair) at the event point.
function click(state, e) {
  if (state.tool === 'polygon' || state.tool === 'route') return addVertex(state, e);
  const p = [e.xKm, e.yKm], q = [e.px, e.py];
  if (!state.anchor) return { state: { ...state, anchor: p, anchorPx: q, cursor: p, cursorPx: q, dragging: e.type === 'down' } };
  const shape = shapeFromAnchor(state.tool, state.anchor, p);
  return shape ? { state: initialDraw(state.tool), completed: shape } : { state: { ...state, cursor: p, cursorPx: q } };
}

function onKey(state, e) {
  if (e.key === 'Escape') return { state: initialDraw(state.tool) };
  if (e.key === 'Backspace') {
    if (state.tool === 'rect' || state.tool === 'circle') return { state: initialDraw(state.tool) };
    return { state: { ...state, points: state.points.slice(0, -1), pxs: state.pxs.slice(0, -1), kpps: (state.kpps ?? []).slice(0, -1) } };
  }
  if (e.key !== 'Enter') return { state };
  const multi = state.tool === 'polygon' || state.tool === 'route';
  if (!hasXY(e)) return multi ? finish(state) : { state };
  if (multi && state.points.length) {
    const last = state.points[state.points.length - 1];
    if (last[0] === e.xKm && last[1] === e.yKm) return finish(state);
  }
  return click(state, e);
}

export function drawReduce(state, event) {
  if (!state || state.tool === 'select' || !event) return { state };
  const e = event;
  switch (e.type) {
    case 'key': return onKey(state, e);
    case 'down': return hasXY(e) ? click(state, e) : { state };
    case 'move':
      return hasXY(e) ? { state: { ...state, cursor: [e.xKm, e.yKm], cursorPx: [e.px, e.py] } } : { state };
    case 'up': {
      if (!state.dragging || !state.anchor || !hasXY(e)) return { state };
      // a short press leaves the anchor for a second click; a drag finishes the shape
      if (pxDist(state.anchorPx, [e.px, e.py]) < CLICK_PX) return { state: { ...state, dragging: false } };
      const shape = shapeFromAnchor(state.tool, state.anchor, [e.xKm, e.yKm]);
      return shape ? { state: initialDraw(state.tool), completed: shape } : { state: { ...state, dragging: false } };
    }
    case 'dblclick': return state.tool === 'polygon' || state.tool === 'route' ? finish(state) : { state };
    default: return { state };
  }
}

// The unfinished shape to draw as a preview, following the cursor; null when there is nothing yet.
export function draftShape(state) {
  if (!state || state.tool === 'select') return null;
  if (state.tool === 'rect' || state.tool === 'circle') {
    if (!state.anchor) return null;
    const b = state.cursor ?? state.anchor;
    if (state.tool === 'rect') return { type: 'rect', x0: state.anchor[0], y0: state.anchor[1], x1: b[0], y1: b[1] };
    return { type: 'circle', cx: state.anchor[0], cy: state.anchor[1], rKm: Math.hypot(b[0] - state.anchor[0], b[1] - state.anchor[1]) };
  }
  if (!state.points.length) return null;
  const pts = state.points.map((p) => [p[0], p[1]]);
  const c = state.cursor;
  const last = pts[pts.length - 1];
  if (c && (c[0] !== last[0] || c[1] !== last[1])) pts.push([c[0], c[1]]);
  return { type: state.tool === 'polygon' ? 'polygon' : 'route', points: pts, open: true };
}

// The snap target the polygon tool adds while drawing: its first vertex, once a close is possible.
export function closeTarget(state) {
  if (!state || state.tool !== 'polygon' || state.points.length < MIN_POINTS.polygon) return null;
  const [xKm, yKm] = state.points[0];
  return { id: 'first-vertex', kind: 'vertex', name: 'First point', xKm, yKm };
}
