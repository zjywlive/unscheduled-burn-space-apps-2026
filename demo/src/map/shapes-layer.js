// Shapes layer of the map overlay (phase 3 §4.5–§4.8): regions A and B, the shape being drawn, the
// snap ring, the route, each region's best cell and the profile position, drawn into one SVG <g>.
// Coordinates are map km, converted with view.js toPx. The layer ignores the pointer except on the
// best-cell markers, which are buttons.
//
// createShapesLayer(gEl, { onBest(slot) }) → { update(params) }
// params: {
//   view: { cx, cy, zoom }, sizePx,                 map frame side in CSS px
//   regions: { A: shape | null, B: shape | null },  shapes from shapes.js (rect, circle, polygon)
//   activeSlot: 'A' | 'B',                          the slot the next drawing replaces
//   draw: draw-state from draw.js | null,           the unfinished shape and its vertices
//   snap: { px, py } | null,                        ring around the snapped target, frame CSS px
//   route: [[xKm, yKm], …] | null,
//   best: { A: { xKm, yKm, name } | null, B: … },   best cell in each region; name is the accessible label
// Slots are 'A' and 'B' everywhere (commands, state, cards); CSS classes use the lower-case letter.
//   profileAt: { xKm, yKm } | null,                 the route point under the pointer in the route card
// }
import { s, clear } from '../ui/dom.js';
import { toPx, kmPerPx } from './view.js';
import { draftShape } from './draw.js';
import { bbox } from './shapes.js';

const SLOTS = ['A', 'B'];
const f1 = (v) => v.toFixed(1);

function shapeNode(shape, P, k, cls) {
  if (shape.type === 'rect') {
    const [xa, ya] = P(Math.min(shape.x0, shape.x1), Math.max(shape.y0, shape.y1));
    const [xb, yb] = P(Math.max(shape.x0, shape.x1), Math.min(shape.y0, shape.y1));
    return s('rect', { class: cls, x: f1(xa), y: f1(ya), width: f1(xb - xa), height: f1(yb - ya) });
  }
  if (shape.type === 'circle') {
    const [cx, cy] = P(shape.cx, shape.cy);
    return s('circle', { class: cls, cx: f1(cx), cy: f1(cy), r: f1(shape.rKm / k) });
  }
  const d = shape.points.map((p, n) => { const [x, y] = P(p[0], p[1]); return `${n ? 'L' : 'M'}${f1(x)} ${f1(y)}`; }).join('');
  const closed = shape.type === 'polygon' && !shape.open;
  return s('path', { class: cls, d: closed ? `${d}Z` : d });
}

export function createShapesLayer(gEl, callbacks = {}) {
  const clipId = `lsn-shapes-clip-${Math.random().toString(36).slice(2, 8)}`;
  gEl.setAttribute('class', 'shapes-layer');

  function update(params) {
    const { view, sizePx, regions = {}, activeSlot = 'A', draw = null, snap = null, route = null, best = {}, profileAt = null } = params;
    clear(gEl);
    const k = kmPerPx(view, sizePx);
    const P = (x, y) => toPx(view, sizePx, x, y);
    const clipRect = s('rect', { x: 0, y: 0, width: sizePx, height: sizePx });
    gEl.append(s('clipPath', { id: clipId }, clipRect));
    const body = s('g', { 'clip-path': `url(#${clipId})` });
    gEl.append(body);

    const art = s('g', { class: 'shapes-art', 'aria-hidden': 'true' });
    for (const slot of SLOTS) {
      const shape = regions[slot];
      if (!shape) continue;
      const g = s('g', { class: `region region-${slot.toLowerCase()}${slot === activeSlot ? ' is-active' : ''}` });
      g.append(shapeNode(shape, P, k, 'region-shape'));
      const b = bbox(shape);
      const [lx, ly] = P(b.x0, b.y1);
      const x = Math.min(sizePx - 14, Math.max(4, lx + 4)), y = Math.min(sizePx - 4, Math.max(16, ly + 16));
      g.append(s('text', { class: 'region-label', x: f1(x), y: f1(y) }, slot));
      art.append(g);
    }

    if (route && route.length) {
      const g = s('g', { class: 'route' });
      g.append(shapeNode({ type: 'route', points: route }, P, k, 'route-line'));
      route.forEach((p, n) => {
        const [x, y] = P(p[0], p[1]);
        g.append(s('circle', { class: n === 0 || n === route.length - 1 ? 'route-end' : 'route-vertex', cx: f1(x), cy: f1(y), r: n === 0 || n === route.length - 1 ? 4 : 2.5 }));
      });
      art.append(g);
    }

    const draft = draftShape(draw);
    if (draft) {
      const g = s('g', { class: `draft draft-${draw.tool}` });
      g.append(shapeNode(draft, P, k, 'draft-shape'));
      if (draft.type === 'polygon' && draw.points.length >= 2) {
        // the closing edge, so the user sees the region that a close would make
        const [x0, y0] = P(draw.points[0][0], draw.points[0][1]);
        const last = draft.points[draft.points.length - 1];
        const [x1, y1] = P(last[0], last[1]);
        g.append(s('line', { class: 'draft-close', x1: f1(x1), y1: f1(y1), x2: f1(x0), y2: f1(y0) }));
      }
      for (const p of draw.points) { const [x, y] = P(p[0], p[1]); g.append(s('circle', { class: 'draft-vertex', cx: f1(x), cy: f1(y), r: 3 })); }
      if (draw.anchor) { const [x, y] = P(draw.anchor[0], draw.anchor[1]); g.append(s('circle', { class: 'draft-vertex', cx: f1(x), cy: f1(y), r: 3 })); }
      art.append(g);
    }

    if (profileAt) {
      const [x, y] = P(profileAt.xKm, profileAt.yKm);
      art.append(s('circle', { class: 'profile-mark', cx: f1(x), cy: f1(y), r: 5 }));
    }
    if (snap) art.append(s('circle', { class: 'snap-ring', cx: f1(snap.px), cy: f1(snap.py), r: 12 }));
    body.append(art);

    for (const slot of SLOTS) {
      const cell = best[slot];
      if (!cell || !regions[slot]) continue;
      const [x, y] = P(cell.xKm, cell.yKm);
      if (x < 0 || y < 0 || x > sizePx || y > sizePx) continue;
      const pick = () => callbacks.onBest?.(slot);
      body.append(s('g', {
        class: `region-best region-best-${slot.toLowerCase()}`, transform: `translate(${f1(x)} ${f1(y)})`,
        tabindex: '0', role: 'button', 'data-focus-key': `region-best:${slot}`,
        'aria-label': cell.name ?? `Pick the best cell in region ${slot}`,
        onclick: (e) => { e.stopPropagation(); pick(); },
        onpointerdown: (e) => e.stopPropagation(),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); pick(); } },
      },
      s('title', null, cell.name ?? `Best cell in region ${slot}`),
      s('circle', { class: 'mark-hit', r: 12 }),
      s('rect', { class: 'best-diamond', x: -5, y: -5, width: 10, height: 10, transform: 'rotate(45)' }),
      s('text', { class: 'best-slot', x: 9, y: -7 }, slot)));
    }
  }

  return { update };
}
