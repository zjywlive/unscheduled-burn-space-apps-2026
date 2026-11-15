// Map controls inside the map frame (phase 3 §4.1, §4.6; layout revision): a column of drawing-tool icon
// buttons at the top left, with the region slot (A | B) and the clear buttons under it only while they
// matter; zoom + / − and the zoom level (a reset button) at the bottom right; and the drawing hint, a
// one-line text for the top centre while a drawing tool is on. Builds DOM and calls back; holds no state.
//
// createMapTools(callbacks) → { tools, zoom, hint, update(params) }
//   callbacks: { onTool(tool), onZoom('in' | 'out' | 'reset' | 'fullscreen' | 'north'), onSlot('A' | 'B'), onClear('A' | 'B' | 'route'),
//                onDial() }   the view group under the tools: Sky dial on / off, and North up (the globe's heading reset)
//   tools, zoom, hint: elements the caller places in the frame
// params: {
//   tool: 'select' | 'rect' | 'circle' | 'polygon' | 'route',
//   slot: 'A' | 'B',
//   zoom: number, minZoom = 1, maxZoom = 32 (map/view.js MAX_ZOOM),
//   hasA: boolean, hasB: boolean, hasRoute: boolean,
//   drawing: boolean,                                  a shape is half drawn (changes the hint)
//   done: boolean,                                     fix L8: a shape was just finished (hides the hint until the next starts)
//   full: boolean,                                     phase 4: the map is in full screen
//   dialOn: boolean,                                   the sky dial is shown (the Sky dial button's pressed state)
// }
// Tour anchors set here: data-tour="tools" on the tool column, data-tour="zoom" on the zoom group.
import { h, s } from './dom.js';

const SLOTS = ['A', 'B'];
// the Map is the 3D Moon (ui/globemap.js): a drag always turns the globe, so the region tools are clicked out
const HINTS = {
  select: 'Click a point or a site to pick it. Drag to turn the globe.',
  rect: 'Click one corner, then the opposite corner. A drag turns the globe.',
  circle: 'Click the centre, then a point on the edge. A drag turns the globe.',
  polygon: 'Click to add corners. Click the first one or double-click to close.',
  route: 'Click to add points. Double-click or press Enter to finish.',
};
const DRAWING = 'Esc cancels. Backspace removes the last point.';
const zoomFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

// 20 × 20 line icons, 1.5 px strokes in currentColor.
const svg = (...children) => s('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, ...children);
const ICONS = {
  select: () => svg(s('path', { d: 'M5 3.5 15 9.2l-4.6 1.2L8.3 15z' })),
  rect: () => svg(s('rect', { x: 3.5, y: 5, width: 13, height: 10, rx: 0.5 })),
  circle: () => svg(s('circle', { cx: 10, cy: 10, r: 6.5 })),
  polygon: () => svg(s('path', { d: 'M4 7.5 10 3.5l6 4-2 8.5H6z' })),
  route: () => svg(s('path', { d: 'M3.5 15.5 7.5 9l4.5 3 4.5-7.5' }), s('circle', { cx: 3.5, cy: 15.5, r: 1.2, fill: 'currentColor' }), s('circle', { cx: 16.5, cy: 4.5, r: 1.2, fill: 'currentColor' })),
  clear: () => svg(s('path', { d: 'M6 6l8 8M14 6l-8 8' })),
  dial: () => svg(s('circle', { cx: 10, cy: 10, r: 6.5 }), s('path', { d: 'M3.5 12.5h13' }), s('circle', { cx: 13, cy: 7.5, r: 1.4, fill: 'currentColor' })),
  north: () => svg(s('circle', { cx: 10, cy: 10, r: 7 }), s('path', { d: 'M10 4.5 12 10h-4z', fill: 'currentColor' }), s('path', { d: 'M8 10h4l-2 5.5z' })),
};
const TOOLS = [['select', 'Select'], ['rect', 'Rectangle'], ['circle', 'Circle'], ['polygon', 'Polygon'], ['route', 'Route']];

let uid = 0;

export function createMapTools(callbacks = {}) {
  const id = `lsn-tools-${++uid}`;
  // an icon button with a visible label on hover and focus (CSS reads data-tip)
  const iconBtn = (label, icon, onclick, extra = {}) => h('button', { type: 'button', class: 'map-btn', 'aria-label': label, 'data-tip': label, onclick, ...extra }, icon);

  const toolButtons = TOOLS.map(([v, label]) => iconBtn(label, ICONS[v](), () => callbacks.onTool?.(v), { 'aria-pressed': 'false', 'data-value': v }));
  const slotButtons = SLOTS.map((v) => h('button', { type: 'button', class: 'map-btn map-btn-text', 'aria-pressed': 'false', 'data-value': v, 'aria-label': `Draw into region ${v}`, 'data-tip': `Draw into ${v}`, onclick: () => callbacks.onSlot?.(v) }, v));
  const slotGroup = h('div', { class: 'map-group map-slots', role: 'group', 'aria-label': 'Draw sets' }, slotButtons);
  const clearBtn = (what, label) => h('button', { type: 'button', class: 'map-btn map-btn-text tool-clear', 'aria-label': label, 'data-tip': label, onclick: () => callbacks.onClear?.(what) }, ICONS.clear(), h('span', { class: 'map-btn-tag' }, what === 'route' ? 'R' : what));
  const clearA = clearBtn('A', 'Clear A');
  const clearB = clearBtn('B', 'Clear B');
  const clearRoute = clearBtn('route', 'Clear route');
  const clears = h('div', { class: 'map-group map-clears', role: 'group', 'aria-label': 'Clear' }, clearA, clearB, clearRoute);

  // the view: always under the tools, whatever tool or panel is on
  const dialBtn = iconBtn('Sky dial', ICONS.dial(), () => callbacks.onDial?.(), { 'aria-pressed': 'true', class: 'map-btn dial-toggle dial-btn', 'data-tip': 'Sky dial (K)' });
  const northBtn = iconBtn('North up', ICONS.north(), () => callbacks.onZoom?.('north'), { class: 'map-btn north-btn', 'data-tip': 'North up, looking straight down' });
  const viewGroup = h('div', { class: 'map-group map-viewctl', role: 'group', 'aria-label': 'View' }, dialBtn, northBtn);
  const tools = h('div', { class: 'map-ui-ctl map-toolcol' },
    h('div', { class: 'map-group', role: 'group', 'aria-label': 'Map tool', 'data-tour': 'tools' }, toolButtons),
    slotGroup, clears, viewGroup);

  const zoomOut = iconBtn('Zoom out', '−', () => callbacks.onZoom?.('out'), { class: 'map-btn zoom-out' });
  const zoomIn = iconBtn('Zoom in', '+', () => callbacks.onZoom?.('in'), { class: 'map-btn zoom-in' });
  const zoomLevel = h('button', { type: 'button', class: 'map-btn map-btn-text zoom-level num', 'aria-label': 'Reset zoom', 'data-tip': 'Reset zoom', onclick: () => callbacks.onZoom?.('reset') });
  const zoomLive = h('span', { class: 'sr-only', 'aria-live': 'polite', id: `${id}-zoom` });
  // phase 4: full screen (the big-map layout only; CSS hides it elsewhere)
  const fsIcon = svg(s('path', { d: 'M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4' }));
  const fullBtn = iconBtn('Full screen map', fsIcon, () => callbacks.onZoom?.('fullscreen'), { 'aria-pressed': 'false', class: 'map-btn fs-btn' });
  const zoom = h('div', { class: 'map-ui-ctl map-zoom map-group', role: 'group', 'aria-label': 'Zoom', 'data-tour': 'zoom' }, fullBtn, zoomIn, zoomOut, zoomLevel, zoomLive);

  const hint = h('p', { class: 'map-chip tool-hint', id: `${id}-hint`, hidden: true });

  function update(p) {
    const tool = p.tool ?? 'select';
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.value === tool));
    for (const b of slotButtons) b.setAttribute('aria-pressed', String(b.dataset.value === (p.slot ?? 'A')));
    // the slot only matters for the region tools; clear buttons only for what exists
    slotGroup.hidden = !(tool === 'rect' || tool === 'circle' || tool === 'polygon');
    clearA.hidden = !p.hasA;
    clearB.hidden = !p.hasB;
    clearRoute.hidden = !p.hasRoute;
    clears.hidden = !(p.hasA || p.hasB || p.hasRoute);
    const z = p.zoom ?? 1;
    zoomOut.disabled = z <= (p.minZoom ?? 1);
    zoomIn.disabled = z >= (p.maxZoom ?? 32);
    const text = `${zoomFmt.format(z)}×`;
    if (zoomLevel.textContent !== text) { zoomLevel.textContent = text; zoomLive.textContent = `Zoom ${text}`; }
    zoomLevel.disabled = z <= (p.minZoom ?? 1);
    fullBtn.setAttribute('aria-pressed', String(Boolean(p.full)));
    if (p.dialOn !== undefined) dialBtn.setAttribute('aria-pressed', String(Boolean(p.dialOn)));
    fullBtn.setAttribute('aria-label', p.full ? 'Leave full screen' : 'Full screen map');
    fullBtn.dataset.tip = p.full ? 'Leave full screen' : 'Full screen map';
    hint.hidden = tool === 'select' || (Boolean(p.done) && !p.drawing);
    hint.textContent = tool === 'select' ? '' : p.drawing ? `${HINTS[tool]} ${DRAWING}` : HINTS[tool];
  }

  update({});
  return { tools, zoom, hint, update };
}
