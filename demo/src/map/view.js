// Map viewport (spec phase 3 §4.1, §5.3): view = { cx, cy, zoom } with the centre in map km and the
// zoom as a factor. At zoom 1 the map frame shows ±MAP_HALF_KM, as in phase 2. Pure functions only.
// `sizePx` is the side of the square map frame in CSS pixels (any unit works if used consistently).
import { MAP_HALF_KM } from '../terrain.js';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 32;   // phase 4: 20 m terrain (was 12)
export const FULL_VIEW = Object.freeze({ cx: 0, cy: 0, zoom: 1 });

// Half the width of the viewport, in km.
export function viewHalfKm(view) {
  return MAP_HALF_KM / view.zoom;
}

// Zoom limited to MIN_ZOOM–MAX_ZOOM and the centre moved so the viewport stays inside the ±MAP_HALF_KM square.
export function clampView(view) {
  const z = Number.isFinite(view?.zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom)) : MIN_ZOOM;
  const lim = MAP_HALF_KM - MAP_HALF_KM / z;
  const c = (v) => (Number.isFinite(v) ? Math.min(lim, Math.max(-lim, v)) + 0 : 0);   // + 0: no -0
  return { cx: c(view?.cx), cy: c(view?.cy), zoom: z };
}

export function kmPerPx(view, sizePx) {
  return (2 * viewHalfKm(view)) / sizePx;
}

export function toPx(view, sizePx, xKm, yKm) {
  const k = kmPerPx(view, sizePx);
  return [sizePx / 2 + (xKm - view.cx) / k, sizePx / 2 - (yKm - view.cy) / k];
}

export function toKm(view, sizePx, px, py) {
  const k = kmPerPx(view, sizePx);
  return [view.cx + (px - sizePx / 2) * k, view.cy - (py - sizePx / 2) * k];
}

// Zoom by `factor` keeping the ground point under (px, py) where it is (unless the clamp moves it).
export function zoomAt(view, sizePx, px, py, factor) {
  const [gx, gy] = toKm(view, sizePx, px, py);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  const k = (2 * MAP_HALF_KM) / zoom / sizePx;
  return clampView({ cx: gx - (px - sizePx / 2) * k, cy: gy + (py - sizePx / 2) * k, zoom });
}

// Drag by (dxPx, dyPx): the ground follows the pointer.
export function panBy(view, sizePx, dxPx, dyPx) {
  const k = kmPerPx(view, sizePx);
  return clampView({ cx: view.cx - dxPx * k, cy: view.cy + dyPx * k, zoom: view.zoom });
}

export function viewBounds(view) {
  const h = viewHalfKm(view);
  return { x0: view.cx - h, y0: view.cy - h, x1: view.cx + h, y1: view.cy + h };
}

// ---------- rectangular frames (phase 4) ----------
// frame = { width, height, unitPx }: a width × height canvas (CSS or device pixels, used consistently)
// on which the ±MAP_HALF_KM square spans unitPx pixels at zoom 1, centred. With width = height = unitPx
// these are exactly the square functions above. The centre limit stays clampView's (zoom only), so a
// frame wider than unitPx shows ground beyond ±MAP_HALF_KM at the sides (black, outside the 80°S disc).
// A frame point is the square point shifted by ((width − unitPx) / 2, (height − unitPx) / 2): square
// layers drawn for sizePx = unitPx line up after that translation.

// unitPx for a frame on which the 80°S disc (radius discKm) spans discPx pixels at zoom 1.
export function unitPxForDisc(discPx, discKm) {
  return (discPx * MAP_HALF_KM) / discKm;
}

export function frameKmPerPx(view, frame) {
  return kmPerPx(view, frame.unitPx);
}

export function frameToPx(view, frame, xKm, yKm) {
  const k = kmPerPx(view, frame.unitPx);
  return [frame.width / 2 + (xKm - view.cx) / k, frame.height / 2 - (yKm - view.cy) / k];
}

export function frameToKm(view, frame, px, py) {
  const k = kmPerPx(view, frame.unitPx);
  return [view.cx + (px - frame.width / 2) * k, view.cy - (py - frame.height / 2) * k];
}

export function frameZoomAt(view, frame, px, py, factor) {
  const [gx, gy] = frameToKm(view, frame, px, py);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  const k = (2 * MAP_HALF_KM) / zoom / frame.unitPx;
  return clampView({ cx: gx - (px - frame.width / 2) * k, cy: gy + (py - frame.height / 2) * k, zoom });
}

export function framePanBy(view, frame, dxPx, dyPx) {
  const k = kmPerPx(view, frame.unitPx);
  return clampView({ cx: view.cx - dxPx * k, cy: view.cy + dyPx * k, zoom: view.zoom });
}

// The ground under the whole frame, km (x0 < x1, y0 < y1).
export function frameBounds(view, frame) {
  const k = kmPerPx(view, frame.unitPx), hw = (frame.width * k) / 2, hh = (frame.height * k) / 2;
  return { x0: view.cx - hw, y0: view.cy - hh, x1: view.cx + hw, y1: view.cy + hh };
}

// The rectangle form shared by hillshade, paintHeat (frame), paintPsr: { width, height, kmPerPx, cx, cy }.
// Pass the frame in device pixels (unitPx too) for canvas work.
export function frameGeometry(view, frame) {
  return { width: frame.width, height: frame.height, kmPerPx: kmPerPx(view, frame.unitPx), cx: view.cx, cy: view.cy };
}

// The same frame in device pixels.
export function scaleFrame(frame, dpr) {
  return { width: Math.round(frame.width * dpr), height: Math.round(frame.height * dpr), unitPx: frame.unitPx * dpr };
}
