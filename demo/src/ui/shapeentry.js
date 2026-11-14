// Coordinates entry for the drawing tools (fix R9): a compact form that follows the active tool and makes
// the same shape objects as drawing on the map (map/shapes.js), from typed latitudes, longitudes and km.
// Every field uses coords.js, so it accepts −89.45 / 89.45S and 222.6 / 137.4W like the Route plan rows.
//
// createShapeEntry(cb) → { el, update(params), setBar(open) }
// cb: {
//   onShape(shape, slot)        Apply on Rectangle, Circle or Polygon: { type: 'rect', x0, y0, x1, y1 } |
//                               { type: 'circle', cx, cy, rKm } | { type: 'polygon', points } in map km, for the
//                               region slot shown ('A' | 'B'), exactly as the drawing tools produce them
//   onPoint([xKm, yKm], { latDeg, lonDeg })   Apply on Point (the Select tool): pick that point
//   actionBar                   the action bar (actionbar.js): Apply and Add vertex show there while setBar(true)
//   onOpenRoutePlan()           the Route tool's "Open Route plan" button (the route rows live in that card)
// }
// params (every key optional; a missing key keeps what the form shows):
//   tool: 'select' | 'point' | 'rect' | 'circle' | 'polygon' | 'route'   the active drawing tool
//   slot: 'A' | 'B'             the region slot a typed shape replaces (default 'A')
//   shapes: { A, B }            the current regions; the form shows the slot's shape when its type matches
//                               the tool, so a drawn shape can be read and fine-tuned
//   point: { latDeg, lonDeg } | [xKm, yKm] | null   the current picked point, shown in the Point form
// A shape or point that arrives as a new object refills its form; the user's unapplied typing in another
// form is kept. Nothing is applied while any field is invalid; errors show beside the field.
// Root element: <section class="shape-entry">; suggested fold title "Coordinates".
import { h, clear } from './dom.js';
import { parseLat, parseLon, parseLatLon, parseKm, fieldsFromXY, formatKm, formatLat, formatLon } from '../coords.js';
import { selfIntersects } from '../map/shapes.js';

export const ENTRY_TOOLS = ['point', 'rect', 'circle', 'polygon', 'route'];
export const MAX_RADIUS_KM = 300;
export const MIN_POLYGON = 3, MAX_POLYGON = 24;
const TITLES = { point: 'Point', rect: 'Rectangle', circle: 'Circle', polygon: 'Polygon', route: 'Route' };
let uid = 0;

const toolOf = (t) => (t === 'select' || !t ? 'point' : ENTRY_TOOLS.includes(t) ? t : 'point');

// ---------- pure helpers (tested in Node) ----------

// Empty fields for a tool: { rows: [{ lat, lon }], r? }.
export function blankFields(tool) {
  const t = toolOf(tool);
  const row = () => ({ lat: '', lon: '' });
  if (t === 'rect') return { rows: [row(), row()] };
  if (t === 'circle') return { rows: [row()], r: '' };
  if (t === 'polygon') return { rows: [row(), row(), row()] };
  return { rows: [row()] };
}

// Fields → { ok: true, shape | point } or { ok: false, errors: [{ key: 'i:lat' | 'i:lon' | 'r', message }],
// formError: string | null }. Point gives point: { xy, latDeg, lonDeg }.
export function shapeFromFields(tool, fields) {
  const t = toolOf(tool);
  const errors = [], pts = [];
  (fields.rows ?? []).forEach((r, i) => {
    // both fields of a row are checked, so every wrong field shows its own message
    const la = parseLat(r.lat), lo = parseLon(r.lon);
    if (!la.ok) errors.push({ key: `${i}:lat`, message: la.message });
    if (!lo.ok) errors.push({ key: `${i}:lon`, message: lo.message });
    pts.push(la.ok && lo.ok ? parseLatLon(r.lat, r.lon) : null);
  });
  let rKm = null;
  if (t === 'circle') {
    const r = parseKm(fields.r, { maxKm: MAX_RADIUS_KM, what: 'a radius' });
    if (r.ok) rKm = r.value; else errors.push({ key: 'r', message: r.message });
  }
  if (t === 'polygon' && (fields.rows ?? []).length < MIN_POLYGON) return { ok: false, errors, formError: `A polygon needs at least ${MIN_POLYGON} vertices.` };
  if (errors.length) return { ok: false, errors, formError: null };
  if (t === 'point') return { ok: true, point: { xy: pts[0].xy, latDeg: pts[0].latDeg, lonDeg: pts[0].lonDeg } };
  if (t === 'circle') return { ok: true, shape: { type: 'circle', cx: pts[0].xy[0], cy: pts[0].xy[1], rKm } };
  if (t === 'rect') {
    const [a, b] = [pts[0].xy, pts[1].xy];
    const shape = { type: 'rect', x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
    if (!(shape.x1 > shape.x0 && shape.y1 > shape.y0)) return { ok: false, errors: [], formError: 'The two corners must differ in both directions on the map.' };
    return { ok: true, shape };
  }
  if (t === 'polygon') {
    const points = pts.map((p) => [p.xy[0], p.xy[1]]);
    if (selfIntersects(points)) return { ok: false, errors: [], formError: 'The edges cross. Reorder the vertices.' };
    return { ok: true, shape: { type: 'polygon', points } };
  }
  return { ok: false, errors: [], formError: null };
}

// A shape (or a point) → fields, so a drawn shape can be read and fine-tuned. A rect gives its
// south-west-most corner on the map plane first: (x0, y0) and (x1, y1).
export function fieldsFromShape(shape) {
  if (!shape) return null;
  if (Array.isArray(shape)) return { rows: [fieldsFromXY(shape)] };
  // a picked point in degrees: formatted directly, no trip through the plane
  if (Number.isFinite(shape.latDeg) && Number.isFinite(shape.lonDeg) && !shape.type) return { rows: [{ lat: formatLat(shape.latDeg), lon: formatLon(shape.lonDeg) }] };
  if (shape.type === 'circle') return { rows: [fieldsFromXY([shape.cx, shape.cy])], r: formatKm(shape.rKm) };
  if (shape.type === 'rect') return { rows: [fieldsFromXY([shape.x0, shape.y0]), fieldsFromXY([shape.x1, shape.y1])] };
  if (shape.type === 'polygon') return { rows: shape.points.map((p) => fieldsFromXY(p)) };
  return null;
}

// ---------- the form ----------

export function createShapeEntry(cb = {}) {
  const id = `lsn-se-${++uid}`;
  let tool = 'point', slot = 'A';
  const forms = Object.fromEntries(ENTRY_TOOLS.map((t) => [t, blankFields(t)]));
  const seen = {};        // tool → the shape / point object the form was last filled from
  let errs = new Map(), formError = null, applied = null;

  const title = h('h3', { class: 'se-title', id: `${id}-title` });
  const sub = h('p', { class: 'se-sub' });
  const body = h('div', { class: 'se-body' });
  const errorLine = h('p', { class: 'field-error se-form-error', role: 'alert', hidden: true });
  const status = h('p', { class: 'se-status', role: 'status', 'aria-live': 'polite' });
  // Apply and Add vertex are buttons of the action bar (actionbar.js) while this form is open; Enter in a field applies
  const form = h('form', { class: 'se-form', novalidate: true, 'aria-labelledby': `${id}-title`, onsubmit: (e) => { e.preventDefault(); apply(); } },
    body, errorLine, status);
  form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches?.('input')) { e.preventDefault(); apply(); } });
  let barOn = false;
  function renderBar() {
    const bar = cb.actionBar;
    if (!bar) return;
    const open = barOn && tool !== 'route';
    const apply1 = { id: 'apply', label: tool === 'point' ? 'Pick this point' : `Apply to region ${slot}`, short: tool === 'point' ? 'Pick' : 'Apply', icon: 'apply', primary: true, title: 'Make the typed point or shape (Enter in a field does the same)', onClick: () => apply() };
    const add1 = { id: 'add', label: forms.polygon.rows.length >= MAX_POLYGON ? `At most ${MAX_POLYGON} vertices` : 'Add vertex', short: 'Vertex', icon: 'add', disabled: forms.polygon.rows.length >= MAX_POLYGON, hint: 'The polygon is full', onClick: () => add() };
    bar.set('point', 'coords', open && tool === 'point' ? [apply1] : []);
    bar.set('region', 'coords', open && tool !== 'point' ? (tool === 'polygon' ? [apply1, add1] : [apply1]) : []);
  }
  const el = h('section', { class: 'shape-entry', 'aria-labelledby': `${id}-title` }, h('div', { class: 'se-head' }, title, sub), form);

  function readInputs() {
    for (const inp of body.querySelectorAll('input[data-key]')) {
      const [i, f] = inp.dataset.key.split(':');
      if (f === undefined) forms[tool].r = inp.value; else forms[tool].rows[Number(i)][f] = inp.value;
    }
  }

  function input(key, value, label, placeholder, cls = '') {
    const inp = h('input', {
      type: 'text', class: `input se-input num ${cls}`.trim(), inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false',
      value, placeholder, 'aria-label': label, 'data-key': key, id: `${id}-${key.replace(':', '-')}`,
    });
    inp.addEventListener('change', () => { readInputs(); if (errs.has(key)) { errs.delete(key); showErrors(); } });
    return inp;
  }

  function coordRow(i, tag, extra = null) {
    const r = forms[tool].rows[i];
    const box = h('div', { class: 'se-errors', 'data-row': String(i) });
    return h('li', { class: 'se-row' },
      h('span', { class: 'se-tag' }, tag),
      input(`${i}:lat`, r.lat, `${tag} latitude`, '−89.45'),
      input(`${i}:lon`, r.lon, `${tag} longitude, degrees east`, '222.69'),
      extra ?? h('span', { class: 'se-tool-gap', 'aria-hidden': 'true' }),
      box);
  }

  const colsHead = (first) => h('div', { class: 'se-cols', 'aria-hidden': 'true' }, h('span', null, first), h('span', null, 'Latitude'), h('span', null, 'Longitude (east)'));

  function iconBtn(text, label, disabled, onclick) {
    return h('button', { type: 'button', class: 'se-tool', 'aria-label': label, title: label, disabled, onclick }, text);
  }

  function render(focusKey = null) {
    clear(body);
    body.className = `se-body is-${tool}`;
    title.textContent = TITLES[tool];
    const regionLine = `Applies to region ${slot}.`;
    if (tool === 'point') {
      sub.textContent = 'Pick a point by its coordinates.';
      body.append(colsHead(''), h('ol', { class: 'se-rows' }, coordRow(0, 'Point')));
    } else if (tool === 'rect') {
      sub.textContent = `Two opposite corners. The rectangle is square to the map, as drawn. ${regionLine}`;
      body.append(colsHead('Corner'), h('ol', { class: 'se-rows' }, coordRow(0, 'Corner 1'), coordRow(1, 'Corner 2')));
    } else if (tool === 'circle') {
      sub.textContent = `Centre and radius. ${regionLine}`;
      const box = h('div', { class: 'se-errors', 'data-row': 'r' });
      body.append(colsHead(''), h('ol', { class: 'se-rows' }, coordRow(0, 'Centre')),
        h('div', { class: 'se-radius' },
          h('label', { class: 'se-tag', for: `${id}-r` }, 'Radius'),
          input('r', forms.circle.r, 'Radius in km', '5', 'se-input-km'), h('span', { class: 'se-unit' }, 'km'), box));
    } else if (tool === 'polygon') {
      sub.textContent = `Vertices in order, at least ${MIN_POLYGON}. ${regionLine}`;
      const rows = forms.polygon.rows;
      const list = h('ol', { class: 'se-rows' });
      rows.forEach((_, i) => {
        const tag = `${i + 1}`;
        list.append(coordRow(i, tag, h('span', { class: 'se-tools' },
          iconBtn('↑', `Move vertex ${tag} up`, i === 0, () => move(i, -1)),
          iconBtn('↓', `Move vertex ${tag} down`, i === rows.length - 1, () => move(i, 1)),
          iconBtn('×', `Remove vertex ${tag}`, rows.length <= MIN_POLYGON, () => remove(i)))));
      });
      body.append(colsHead('Vertex'), list,
        null);
    } else {
      sub.textContent = 'Route points are typed in the Route plan section, with the slope limit.';
      body.append(h('button', { type: 'button', class: 'btn se-open-route', onclick: () => cb.onOpenRoutePlan?.() }, 'Open Route plan'));
    }
    showErrors();
    renderBar();
    if (focusKey) body.querySelector(`[data-key="${focusKey}"]`)?.focus({ preventScroll: true });
  }

  function showErrors() {
    for (const inp of body.querySelectorAll('input[data-key]')) {
      const msg = errs.get(inp.dataset.key);
      if (msg) { inp.setAttribute('aria-invalid', 'true'); inp.setAttribute('aria-describedby', `${inp.id}-err`); } else { inp.removeAttribute('aria-invalid'); inp.removeAttribute('aria-describedby'); }
    }
    for (const box of body.querySelectorAll('.se-errors')) {
      clear(box);
      const row = box.dataset.row;
      for (const [key, msg] of errs) {
        if ((row === 'r' && key === 'r') || key.startsWith(`${row}:`)) box.append(h('p', { class: 'field-error', id: `${id}-${key.replace(':', '-')}-err` }, msg));
      }
    }
    errorLine.hidden = !formError;
    errorLine.textContent = formError ?? '';
  }

  function add() { readInputs(); forms.polygon.rows.push({ lat: '', lon: '' }); errs = new Map(); formError = null; render(`${forms.polygon.rows.length - 1}:lat`); }
  function remove(i) { readInputs(); forms.polygon.rows.splice(i, 1); errs = new Map(); formError = null; render(`${Math.min(i, forms.polygon.rows.length - 1)}:lat`); }
  function move(i, by) {
    readInputs();
    const rows = forms.polygon.rows, j = i + by;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    errs = new Map(); formError = null;
    render(`${j}:lat`);
  }

  function apply() {
    if (tool === 'route') return;
    readInputs();
    const r = shapeFromFields(tool, forms[tool]);
    status.textContent = '';
    if (!r.ok) {
      errs = new Map(r.errors.map((e) => [e.key, e.message]));
      formError = r.formError ?? (r.errors.length ? (r.errors.length === 1 ? 'Fix the highlighted field.' : `Fix the ${r.errors.length} highlighted fields.`) : null);
      showErrors();
      const first = r.errors[0]?.key;
      if (first) body.querySelector(`[data-key="${first}"]`)?.focus();
      return;
    }
    errs = new Map(); formError = null;
    showErrors();
    if (r.point) {
      applied = r.point.xy;
      seen.point = applied;
      cb.onPoint?.(r.point.xy, { latDeg: r.point.latDeg, lonDeg: r.point.lonDeg });
      status.textContent = 'Point picked.';
    } else {
      applied = r.shape;
      seen[tool] = r.shape;
      cb.onShape?.(r.shape, slot);
      status.textContent = `Region ${slot} set.`;
    }
  }

  // fill a form from a shape or point that arrives from outside (drawn on the map, or restored)
  function fill(t, obj) {
    if (obj === seen[t] || obj === applied) { seen[t] = obj; return false; }
    seen[t] = obj;
    if (!obj) return false;
    const f = fieldsFromShape(obj);
    if (!f) return false;
    forms[t] = f;
    return true;
  }

  function update(p = {}) {
    let changed = false;
    if ('slot' in p && p.slot && p.slot !== slot) { slot = p.slot; changed = true; }
    if ('tool' in p) { const t = toolOf(p.tool); if (t !== tool) { readInputs(); tool = t; errs = new Map(); formError = null; status.textContent = ''; changed = true; } }
    if ('point' in p && fill('point', p.point ?? null) && tool === 'point') changed = true;
    if (p.shapes) {
      const sh = p.shapes[slot] ?? null;
      if (sh && ['rect', 'circle', 'polygon'].includes(sh.type) && fill(sh.type, sh) && sh.type === tool) changed = true;
    }
    if (changed) render();
  }

  render();
  // the form is open (its fold): its actions show in the bar
  function setBar(on) { barOn = !!on; renderBar(); }
  return { el, update, setBar };
}
