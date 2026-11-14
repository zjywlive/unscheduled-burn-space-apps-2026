// Planned route candidates on the map (phase 4 §6 R): the three candidates of route-plan.js and their
// waypoints, drawn into one SVG <g>. The selected candidate is a solid line over a dark casing; the others
// are thin lines told apart by their dash (Shortest solid, Flattest dashed, Sunniest dotted), in the
// neutral ink only. A candidate that repeats an earlier one (sameAs) is drawn once. The layer ignores the
// pointer; picking happens in the Route plan card.
//
// drawRoutes(gEl, params) → void        (clears gEl and draws again; cheap, call on every map redraw)
// params: {
//   routes: Plan.routes | null,          from planRoutes(); routes without points are skipped
//   selected: 'short' | 'flat' | 'sunny' | null,
//   hovered: same | null,                the row under the pointer or focus in the card, drawn a little bolder
//   toPx: (xKm, yKm) => [px, py],        map km to the group's pixel frame (e.g. view.js toPx with the
//                                        shapes layer's square: (x, y) => toPx(sqView(view), S, x, y))
//   waypoints: [[xKm, yKm], …] | null,   numbered markers; Start and End as rings
//   labels: boolean,                     route names next to the lines (default true)
//   width, height: number,               frame size in px, to keep labels inside (optional)
//   traps: { cells: [[x, y], …], cellKm } | null   phase 2: trap ground, drawn as red cells under the routes
//   drive: route-energy.js Drive | null        phase 3: parking stops (P) and where the battery runs out (!)
//   avoid: [{ x, y, w, h }] | 'dom',     boxes in the group's px frame that labels must not cover; 'dom' (the
//                                        default) reads the site names, dots and feature names on the page
// }
// fix R4: each label tries several places along its line, on both sides, and takes the first that covers
// no site name or marker, no other label, and no waypoint; a candidate that finds none is left unlabelled
// (the selected one keeps its first place). Lines are wider and cased (phase4-route.css).
import { s, clear } from '../ui/dom.js';

const f1 = (v) => (Math.round(v * 10) / 10).toString();
export const ROUTE_IDS = ['short', 'flat', 'sunny'];
const NAMES = { short: 'Shortest', flat: 'Flattest', sunny: 'Sunniest' };
const LABEL_AT = { short: 0.5, flat: 0.33, sunny: 0.67 };

// SVG path data of a polyline; points closer than 0.5 px to the last kept one are skipped.
export function routePathD(points, toPx) {
  let d = '', lx = NaN, ly = NaN;
  for (let i = 0; i < points.length; i++) {
    const [x, y] = toPx(points[i][0], points[i][1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = i === points.length - 1;
    if (d && !last && Math.abs(x - lx) < 0.5 && Math.abs(y - ly) < 0.5) continue;
    d += `${d ? 'L' : 'M'}${f1(x)} ${f1(y)}`;
    lx = x; ly = y;
  }
  return d;
}

// The pixel point at a fraction (default half) of a polyline's pixel length, and the direction there.
export function midpoint(points, toPx, frac = 0.5) {
  const px = points.map((p) => toPx(p[0], p[1]));
  let total = 0;
  for (let i = 1; i < px.length; i++) total += Math.hypot(px[i][0] - px[i - 1][0], px[i][1] - px[i - 1][1]);
  let run = 0;
  for (let i = 1; i < px.length; i++) {
    const L = Math.hypot(px[i][0] - px[i - 1][0], px[i][1] - px[i - 1][1]);
    if (run + L >= total * frac && L > 0) {
      const t = (total * frac - run) / L;
      return { x: px[i - 1][0] + (px[i][0] - px[i - 1][0]) * t, y: px[i - 1][1] + (px[i][1] - px[i - 1][1]) * t, dx: (px[i][0] - px[i - 1][0]) / L, dy: (px[i][1] - px[i - 1][1]) / L };
    }
    run += L;
  }
  return px.length ? { x: px[0][0], y: px[0][1], dx: 1, dy: 0 } : null;
}

// Label boxes of the map's own text and markers, in gEl's px frame (browser only; [] elsewhere).
export function domAvoidBoxes(gEl) {
  if (typeof document === 'undefined' || !gEl?.getScreenCTM) return [];
  const m = gEl.getScreenCTM?.();
  if (!m) return [];
  const inv = m.inverse(), pt = gEl.ownerSVGElement?.createSVGPoint?.();
  if (!pt) return [];
  const out = [];
  for (const n of document.querySelectorAll('.mark-label, .mark-dot, .feature-name, .top-cells circle, .top-cells text')) {
    const r = n.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    pt.x = r.left; pt.y = r.top; const a = pt.matrixTransform(inv);
    pt.x = r.right; pt.y = r.bottom; const b = pt.matrixTransform(inv);
    out.push({ x: Math.min(a.x, b.x) - 2, y: Math.min(a.y, b.y) - 2, w: Math.abs(b.x - a.x) + 4, h: Math.abs(b.y - a.y) + 4 });
  }
  return out;
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// The box of a label of n characters at (x, y) with an anchor, 11 px type (≈ 6.3 px a character).
export function labelBox(x, y, n, anchor) {
  const w = n * 6.3 + 4, h = 14;
  return { x: anchor === 'end' ? x - w : x, y: y - h / 2, w, h };
}

// Where to put a route's label: the first candidate (fractions along the line × left/right of travel)
// whose box stays in the frame and hits no box in taken. → { x, y, anchor, box } | null
export function placeLabel(points, toPx, name, frac, taken, width = Infinity, height = Infinity) {
  const fracs = [frac, frac - 0.08, frac + 0.08, frac - 0.16, frac + 0.16, frac - 0.24, frac + 0.24].filter((f) => f > 0.03 && f < 0.97);
  for (const f of fracs) {
    const m = midpoint(points, toPx, f);
    if (!m) continue;
    for (const side of [1, -1]) {
      const nx = -m.dy * side, ny = m.dx * side;
      const x = m.x + nx * 11, y = m.y + ny * 11;
      const anchor = nx < 0 ? 'end' : 'start';
      const box = labelBox(x, y, name.length, anchor);
      if (box.x < 2 || box.y < 2 || box.x + box.w > width - 2 || box.y + box.h > height - 2) continue;
      if (taken.some((t) => overlaps(t, box))) continue;
      return { x, y, anchor, box };
    }
  }
  return null;
}

export function drawRoutes(gEl, { routes = null, selected = null, hovered = null, toPx, waypoints = null, labels = true, width = Infinity, height = Infinity, avoid = 'dom', traps = null, drive = null } = {}) {
  clear(gEl);
  gEl.setAttribute('class', 'routes-layer');
  gEl.setAttribute('aria-hidden', 'true');
  // phase 2: trap cells (one path of squares), under everything else
  if (traps?.cells?.length) {
    const h = traps.cellKm / 2;
    let d = '';
    for (const [x, y] of traps.cells) {
      const [ax, ay] = toPx(x - h, y + h), [bx, by] = toPx(x + h, y - h);
      if (![ax, ay, bx, by].every(Number.isFinite)) continue;
      const w = bx - ax, hh = by - ay;
      if (Math.abs(w) < 0.3 && Math.abs(hh) < 0.3) { d += `M${f1(ax)} ${f1(ay)}h0.6v0.6h-0.6z`; continue; }
      d += `M${f1(ax)} ${f1(ay)}h${f1(w)}v${f1(hh)}h${f1(-w)}z`;
    }
    if (d) gEl.append(s('path', { class: 'rp-traps', d }));
  }
  const list = (routes ?? []).filter((r) => r && r.points && r.points.length >= 2 && (!r.sameAs || r.id === selected));
  // unselected first, so the selected line sits on top
  const order = [...list].sort((a, b) => (a.id === selected) - (b.id === selected) || ROUTE_IDS.indexOf(a.id) - ROUTE_IDS.indexOf(b.id));
  for (const r of order) {
    const d = routePathD(r.points, toPx);
    if (!d) continue;
    const sel = r.id === selected, hov = r.id === hovered;
    const g = s('g', { class: `rp-route rp-route-${r.id}${sel ? ' is-selected' : ''}${hov ? ' is-hovered' : ''}` });
    g.append(s('path', { class: 'rp-casing', d }), s('path', { class: `rp-line rp-line-${r.id}`, d }));
    // phase 2: the selected route's one-way stretches over its line
    if (sel && r.oneWay?.length) {
      const od = r.oneWay.map((seg) => routePathD(seg, toPx)).join('');
      if (od) g.append(s('path', { class: 'rp-oneway', d: od }));
    }
    gEl.append(g);
  }
  if (labels && list.length) {
    const taken = [...(avoid === 'dom' ? domAvoidBoxes(gEl) : (avoid ?? []))];
    for (const p of waypoints ?? []) {
      const [x, y] = toPx(p[0], p[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) taken.push({ x: x - 9, y: y - 9, w: 18, h: 18 });
    }
    // the selected route is labelled first, so it keeps its name when labels crowd
    for (const r of [...order].reverse()) {
      const name = r.sameAs ? `${NAMES[r.id] ?? r.label} = ${NAMES[r.sameAs] ?? r.sameAs}` : (NAMES[r.id] ?? r.label);
      // each candidate starts at its own place along the line, so routes that share a stretch do not collide
      let at = placeLabel(r.points, toPx, name, LABEL_AT[r.id] ?? 0.5, taken, width, height);
      if (!at && r.id === selected) at = placeLabel(r.points, toPx, name, LABEL_AT[r.id] ?? 0.5, [], width, height);
      if (!at) continue;
      taken.push(at.box);
      gEl.append(s('text', { class: `rp-label${r.id === selected ? ' is-selected' : ''}`, x: f1(at.x), y: f1(at.y + 4), 'text-anchor': at.anchor }, name));
    }
  }
  if (drive) {
    const g = s('g', { class: 'rp-drive' });
    for (const st of drive.stops ?? []) {
      const [x, y] = toPx(st.x, st.y);
      if (Number.isFinite(x) && Number.isFinite(y)) g.append(s('g', { class: 'rp-stop', transform: `translate(${f1(x)} ${f1(y)})` }, s('circle', { r: 7 }), s('text', { y: 3.5, 'text-anchor': 'middle' }, 'P')));
    }
    if (drive.emptyAt) {
      const [x, y] = toPx(drive.emptyAt.x, drive.emptyAt.y);
      if (Number.isFinite(x) && Number.isFinite(y)) g.append(s('g', { class: 'rp-empty', transform: `translate(${f1(x)} ${f1(y)})` }, s('circle', { r: 8 }), s('text', { y: 4, 'text-anchor': 'middle' }, '!')));
    }
    gEl.append(g);
  }
  if (waypoints && waypoints.length) {
    const g = s('g', { class: 'rp-waypoints' });
    waypoints.forEach((p, n) => {
      const [x, y] = toPx(p[0], p[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const end = n === 0 || n === waypoints.length - 1;
      g.append(s('g', { class: `rp-wp${end ? ' rp-wp-end' : ''}`, transform: `translate(${f1(x)} ${f1(y)})` },
        s('circle', { r: end ? 7 : 6 }),
        s('text', { y: 3.5, 'text-anchor': 'middle' }, String(n + 1))));
    });
    gEl.append(g);
  }
}
