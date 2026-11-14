// Route plan card (phase 4 §6 R): the waypoints as latitude and longitude rows (add, remove, reorder),
// a slope limit, a Plan button with progress and Cancel, the three candidates as selectable rows with
// their figures, and the caveats. The card plans nothing itself: it asks the caller with onPlan and shows
// what update() brings back.
//
// createRoutePlanCard(deps, callbacks) → { el, update(params) }
// deps: { maxPoints?: number (default 8), maxLatDeg?: number (default −80, the terrain grid's edge) }
// callbacks: {
//   onPoints(points)                    the edited waypoints, [[xKm, yKm], …], whenever every row is valid
//   onPlan({ points, maxSlopeDeg })     Plan pressed (or "Plan at N°" after a blocked plan)
//   onCancel()                          Cancel pressed while planning
//   onPick(routeId)                     a candidate chosen: 'short' | 'flat' | 'sunny'
//   onHover(routeId | null)             a candidate under the pointer or keyboard focus
//   onLimit(maxSlopeDeg)                the slope limit slider was let go at a new value (for the URL hash);
//                                       set it back from outside with update({ maxSlopeDeg })
// }
// params (every key optional; a missing key keeps what the card shows):
//   points: [[xKm, yKm], …] | null      e.g. what the Route tool drew; replaces the rows when it is a new array
//   maxSlopeDeg: number                 the slope limit to show
//   running: boolean, progress: 0–1     a plan in progress
//   plan: Plan | null                   the last planRoutes() result
//   selected: routeId | null            the candidate shown as the current route
//   hovered: routeId | null             the candidate highlighted on the map (so map and card agree)
import { h, s, clear } from './dom.js';
import { fromXY, TERRAIN_MAX_LAT } from '../terrain.js';
import { parseLatLon, formatLat, formatLon } from '../coords.js';
import { DEFAULT_MAX_SLOPE, MAX_POINTS, MIN_POINTS } from '../route-plan.js';

const LIMIT = { min: 5, max: 30, step: 1 };
const kmFmt = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const intFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
const DASH = '—';
let uid = 0;

// ---------- pure helpers (tested in Node) ----------

// Text for a coordinate input: latitude 3 decimals, east longitude 0–360 with 3 decimals; − as minus sign.
export const coordText = (v) => formatLat(v);

// Rows → { points, errors }: points [[x, y]] for rows that parse, errors [{ index, field, message }].
export function readRows(rows, maxLatDeg = TERRAIN_MAX_LAT) {
  const points = [], errors = [];
  rows.forEach((r, index) => {
    // fix R8/R9: the shared coords.js parser, so every field accepts −89.45, 89.45S, 222.6E, 137.4W …
    const p = parseLatLon(r.lat, r.lon, { maxLatDeg });
    if (!p.ok) { errors.push({ index, field: p.field, message: p.message }); return; }
    points.push(p.xy);
  });
  return { points, errors };
}

// [[x, y]] → rows of text.
export function rowsFromPoints(points) {
  return (points ?? []).map(([x, y]) => { const { latDeg, lonDeg } = fromXY(x, y); return { lat: formatLat(latDeg), lon: formatLon(lonDeg) }; });
}

export const rowTag = (i, n) => (i === 0 ? 'Start' : i === n - 1 ? 'End' : `Via ${i}`);

// The figures of one candidate as display strings.
export function routeFigures(r) {
  const len = ok(r.lengthKm) ? (r.lengthKm >= 100 ? intFmt.format(r.lengthKm) : kmFmt.format(r.lengthKm)) : DASH;
  const deg = (v) => (ok(v) ? `${(Math.round(v * 10) / 10).toFixed(1)}°` : DASH);
  return {
    length: len,
    max: deg(r.maxSlopeDeg),
    mean: deg(r.meanSlopeDeg),
    sun: ok(r.sunShare) ? `${Math.round(r.sunShare * 100)}%` : DASH,
    psr: ok(r.psrKm) ? (r.psrKm > 0 && r.psrKm < 0.05 ? '<0.1' : kmFmt.format(r.psrKm)) : DASH,
  };
}

// One sentence for screen readers.
export function routeSentence(r, names) {
  if (r.unavailable) return `${r.label}: ${r.unavailable}`;
  const f = routeFigures(r);
  const same = r.sameAs ? ` Same route as ${names[r.sameAs] ?? r.sameAs}.` : '';
  return `${r.label}: ${f.length} km, max slope ${f.max}, mean slope ${f.mean}, sunlit ${f.sun} of the length, ${f.psr} km in permanent shadow.${same}`;
}

// Whether a plan answers these points and this limit.
export function planMatches(plan, points, limitDeg) {
  if (!plan || !points || plan.limitDeg !== limitDeg) return false;
  const w = plan.waypoints ?? [];
  if (w.length !== points.length) return false;
  return w.every((p, i) => Math.abs(p[0] - points[i][0]) < 1e-6 && Math.abs(p[1] - points[i][1]) < 1e-6);
}

// ---------- the card ----------

function swatch(id) {
  return s('svg', { class: 'rp-swatch', width: 16, height: 10, viewBox: '0 0 16 10', 'aria-hidden': 'true' },
    s('path', { class: `rp-line rp-line-${id}`, d: 'M1 5H15' }));
}

export function createRoutePlanCard(deps = {}, callbacks = {}) {
  const maxPoints = deps.maxPoints ?? MAX_POINTS;
  const maxLat = deps.maxLatDeg ?? TERRAIN_MAX_LAT;
  const id = `lsn-rp-${++uid}`;
  let rows = [{ lat: '', lon: '' }, { lat: '', lon: '' }];
  let errs = new Map();          // `${index}:${field}` → message
  let limit = DEFAULT_MAX_SLOPE;
  let lastPoints = null, emitted = null;
  let running = false, progress = 0, plan = null, selected = null, hovered = null;
  let validPoints = null;        // the rows as points when all are valid

  // fix R8: the point rows are the first thing in the card, open by default; one line says both ways in
  const head = h('div', { class: 'card-head card-head-stack' },
    h('h2', { id: `${id}-head` }, 'Route plan'),
    h('p', { class: 'card-sub' }, 'Type coordinates below, or draw with the Route tool on the map.'));

  const list = h('ol', { class: 'rp-points', 'aria-label': 'Route points, in order' });
  const addBtn = h('button', { type: 'button', class: 'btn rp-add', onclick: () => addRow() }, 'Add point');

  const limitInput = h('input', { type: 'range', class: 'range', id: `${id}-limit`, min: LIMIT.min, max: LIMIT.max, step: LIMIT.step, value: limit });
  const limitOut = h('output', { class: 'filter-value num', for: `${id}-limit` });
  limitInput.addEventListener('input', () => { limit = Number(limitInput.value); renderLimit(); renderResults(); });
  limitInput.addEventListener('change', () => callbacks.onLimit?.(limit));   // fix R (for L5): report the limit for the hash

  const planBtn = h('button', { type: 'submit', class: 'btn btn-primary rp-plan' }, 'Plan routes');   // stays enabled: planning again restarts
  const cancelBtn = h('button', { type: 'button', class: 'btn rp-cancel', hidden: true, onclick: () => callbacks.onCancel?.() }, 'Cancel');
  const formError = h('p', { class: 'field-error rp-form-error', id: `${id}-form-error`, hidden: true });

  // fix R8 (replaces G's closed "Points and slope limit" disclosure): points, Add point, slope limit and
  // Plan in plain sight, then the outcome and the candidates; only the notes stay behind a disclosure.
  const form = h('form', { class: 'rp-form', novalidate: true, 'aria-labelledby': `${id}-head`, onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('div', { class: 'rp-cols', 'aria-hidden': 'true' }, h('span', null, 'Point'), h('span', null, 'Latitude'), h('span', null, 'Longitude (east)')),
    list,
    h('div', { class: 'rp-add-row' }, addBtn),
    h('div', { class: 'filter rp-limit' },
      h('div', { class: 'filter-head' }, h('label', { for: `${id}-limit` }, 'Slope limit ', h('span', { class: 'rp-assumed' }, 'assumed')), limitOut),
      limitInput),
    formError,
    h('div', { class: 'rp-actions' }, planBtn, cancelBtn));

  const status = h('div', { class: 'rp-status', role: 'status', 'aria-live': 'polite' });
  const results = h('div', { class: 'rp-results' });
  const notes = h('ul', { class: 'rp-notes fold-more-body' });

  const el = h('section', { class: 'card rp-card', 'aria-labelledby': `${id}-head`, 'data-tour': 'route-plan' }, head, form, status, results,
    h('details', { class: 'fold-more rp-notes-box' }, h('summary', null, 'Notes'), notes));

  // ---------- points ----------
  function validate(showErrors) {
    const r = readRows(rows, maxLat);
    const next = new Map();
    for (const e of r.errors) next.set(`${e.index}:${e.field}`, e.message);
    // empty rows only count as errors when the user asks to plan
    if (!showErrors) for (const [k] of next) { const i = Number(k.split(':')[0]); if (!rows[i].lat.trim() && !rows[i].lon.trim()) next.delete(k); }
    errs = next;
    validPoints = r.errors.length ? null : r.points;
    return r;
  }

  function emitPoints() {
    if (!validPoints) return;
    emitted = validPoints;
    callbacks.onPoints?.(validPoints);
  }

  function commitRow(i, field, value) {
    if (rows[i][field] === value) return;
    rows[i] = { ...rows[i], [field]: value };
    // re-check this row only; a half-filled row waits for its other field
    const r = readRows([rows[i]], maxLat);
    errs.delete(`${i}:lat`); errs.delete(`${i}:lon`);
    const blank = !rows[i].lat.trim() && !rows[i].lon.trim();
    const half = !rows[i].lat.trim() || !rows[i].lon.trim();
    if (r.errors.length && !blank && !(half && r.errors[0].field !== field)) errs.set(`${i}:${r.errors[0].field}`, r.errors[0].message);
    const all = readRows(rows, maxLat);
    validPoints = all.errors.length ? null : all.points;
    showErrors();   // in place: the list is not rebuilt, so Tab carries on where the user was going
    renderResults();
    emitPoints();
  }

  function addRow() {
    if (rows.length >= maxPoints) return;
    const at = rows.length >= 2 ? rows.length - 1 : rows.length;
    rows.splice(at, 0, { lat: '', lon: '' });
    shiftErrors(at, +1);
    validate(false);
    renderPoints(`${at}:lat`);
    renderResults();
  }

  function removeRow(i) {
    if (rows.length <= MIN_POINTS) return;
    rows.splice(i, 1);
    errs.delete(`${i}:lat`); errs.delete(`${i}:lon`);
    shiftErrors(i + 1, -1);
    validate(false);
    renderPoints(`${Math.min(i, rows.length - 1)}:lat`);
    renderResults();
    emitPoints();
  }

  function shiftErrors(from, by) {
    const next = new Map();
    for (const [k, v] of errs) { const [i, f] = k.split(':'); const n = Number(i); next.set(`${n >= from ? n + by : n}:${f}`, v); }
    errs = next;
  }

  let rowEls = [];   // per row: { lat, lon, box } (the inputs and the error container)

  function coordInput(i, field, tag) {
    const input = h('input', {
      type: 'text', class: 'input rp-input num', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false',
      value: rows[i][field], placeholder: field === 'lat' ? '−89.45' : '222.69',
      'aria-label': `${tag} ${field === 'lat' ? 'latitude' : 'longitude, degrees east'}`, 'data-focus': `${i}:${field}`,
    });
    input.addEventListener('change', () => commitRow(i, field, input.value.trim()));
    return input;
  }

  // error messages and aria-invalid of every row, without rebuilding the inputs
  function showErrors() {
    rowEls.forEach((r, i) => {
      clear(r.box);
      for (const field of ['lat', 'lon']) {
        const msg = errs.get(`${i}:${field}`), input = r[field], errId = `${id}-e${i}-${field}`;
        if (msg) {
          input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', errId);
          r.box.append(h('p', { class: 'field-error', id: errId }, msg));
        } else { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
      }
    });
    if (!errs.size) formError.hidden = true;
  }

  function renderPoints(focusKey = null) {
    clear(list);
    rowEls = [];
    rows.forEach((row, i) => {
      const tag = rowTag(i, rows.length);
      const lat = coordInput(i, 'lat', tag), lon = coordInput(i, 'lon', tag), box = h('div', { class: 'rp-errors' });
      rowEls.push({ lat, lon, box });
      // one line per point: tag, latitude, longitude, remove (fix R8; reordering is by editing the rows)
      const label = `Remove ${tag.toLowerCase()}`;
      list.append(h('li', { class: 'rp-point' },
        h('span', { class: 'rp-tag' }, tag),
        lat, lon,
        h('button', { type: 'button', class: 'rp-tool', 'aria-label': label, title: label, disabled: rows.length <= MIN_POINTS, 'data-focus': `${i}:remove`, onclick: () => removeRow(i) }, '×'),
        box));
    });
    showErrors();
    addBtn.disabled = rows.length >= maxPoints;
    addBtn.textContent = rows.length >= maxPoints ? `At most ${maxPoints} points` : 'Add point';
    if (focusKey) {
      const t = list.querySelector(`[data-focus="${focusKey}"]`);
      (t && !t.disabled ? t : list.querySelector(`[data-focus="${focusKey.split(':')[0]}:lat"]`) ?? addBtn).focus({ preventScroll: true });
    }
  }

  function submit() {
    // take what is typed even if no change event has fired yet (Enter in a field)
    rowEls.forEach((r, i) => { rows[i] = { lat: r.lat.value.trim(), lon: r.lon.value.trim() }; });
    const r = validate(true);
    showErrors();
    if (r.errors.length) {
      formError.hidden = false;
      formError.textContent = r.errors.length === 1 ? 'Fix the highlighted point.' : `Fix the ${r.errors.length} highlighted entries.`;
      const first = r.errors[0];
      list.querySelector(`[data-focus="${first.index}:${first.field}"]`)?.focus();
      return;
    }
    formError.hidden = true;
    emitPoints();
    callbacks.onPlan?.({ points: r.points, maxSlopeDeg: limit });
  }

  function renderLimit() {
    if (Number(limitInput.value) !== limit) limitInput.value = String(limit);
    limitOut.textContent = `${limit}°`;
    limitInput.setAttribute('aria-valuetext', `${limit} degrees`);
  }

  // ---------- results ----------
  const names = { short: 'Shortest', flat: 'Flattest', sunny: 'Sunniest' };

  function pick(rid) { if (rid !== selected) callbacks.onPick?.(rid); }
  function hover(rid) { if (rid !== hovered) { hovered = rid; callbacks.onHover?.(rid); } }

  // status line: progress while planning (updated in place, announced in 10 % steps), then the outcome
  let statusKey = '';
  const progText = h('span', { class: 'num' });
  const progFill = h('span');
  const progLine = h('p', { class: 'region-progress' }, h('span', { class: 'region-progress-bar', 'aria-hidden': 'true' }, progFill), progText);

  function renderStatus(stale) {
    cancelBtn.hidden = !running;
    if (running) {
      const pr = Math.max(0, Math.min(1, progress ?? 0));
      if (statusKey !== 'running') { statusKey = 'running'; clear(status); status.append(progLine); }
      progFill.style.transform = `scaleX(${pr.toFixed(3)})`;
      const text = `Planning… ${Math.floor(pr * 10) * 10}%`;
      if (progText.textContent !== text) progText.textContent = text;
      return;
    }
    const key = `${plan ? plan.ms + ':' + plan.nodes + ':' + (plan.error ?? '') + ':' + (plan.blocked?.passesAtDeg ?? '') : 'none'}|${stale}|${limit}`;
    if (key === statusKey && plan !== null) return;
    statusKey = key;
    clear(status);
    if (!plan) return;
    if (plan.blocked && ok(plan.blocked.passesAtDeg)) {
      const at = plan.blocked.passesAtDeg;
      const can = at <= LIMIT.max;
      status.append(h('div', { class: 'rp-blocked' },
        h('p', null, `No route keeps under ${plan.blocked.limitDeg}°${plan.waypoints?.length > 2 ? ` on leg ${plan.blocked.leg + 1}` : ''}.`),
        h('p', { class: 'rp-blocked-sub' }, `The gentlest way through the search area needs ${at}° on the ${baseText()} grid.`),
        can ? h('button', { type: 'button', class: 'btn rp-relax', onclick: () => { limit = at; renderLimit(); submit(); } }, `Plan at ${at}°`)
          : h('p', { class: 'rp-blocked-sub' }, `That is above the ${LIMIT.max}° the limit goes to.`)));
      return;
    }
    if (plan.error) { status.append(h('p', { class: 'rp-error' }, plan.error)); return; }
    if (plan.ok) {
      if (stale) status.append(h('p', { class: 'rp-stale' }, 'Points or limit changed. Plan again to update.'));
      else status.append(h('p', { class: 'rp-done num' }, `Searched ${intFmt.format(plan.nodes)} terrain nodes in ${(plan.ms / 1000).toFixed(1)} s.`));
    }
  }

  const baseText = () => (plan?.baselineKm ? `${Math.round(plan.baselineKm * 1000)} m` : '240 m');

  // the candidate rows are rebuilt only for a new plan; selection and hover change them in place, so
  // focus stays put and a hover from the map does not re-render under the pointer
  let rowsKey = null, buttons = [];

  function syncRows() {
    const usable = buttons.filter((b) => !b.disabled);
    const focusId = usable.some((b) => b.dataset.route === selected) ? selected : usable[0]?.dataset.route;
    for (const b of buttons) {
      const rid = b.dataset.route;
      b.classList.toggle('is-selected', rid === selected);
      b.classList.toggle('is-hovered', rid === hovered);
      b.setAttribute('aria-checked', String(rid === selected));
      b.tabIndex = rid === focusId ? 0 : -1;
    }
  }

  function renderResults() {
    const stale = !!plan?.ok && !planMatches(plan, validPoints ?? lastPoints, limit);
    renderStatus(stale);
    const show = !!plan?.ok && !running;
    const key = show ? plan : null;
    if (key !== rowsKey) {
      rowsKey = key;
      clear(results);
      buttons = [];
      if (show) buildRows();
    }
    results.querySelector('.rp-rows')?.classList.toggle('is-stale', stale);
    syncRows();
  }

  function buildRows() {
    const routes = plan.routes;
    // fix R3: every column says its unit on a second header line; Max and Mean are slopes
    const col = (name, unit, title) => h('span', { title }, h('span', { class: 'rp-head-name' }, name), h('span', { class: 'rp-head-unit' }, unit));
    const header = h('div', { class: 'rp-row rp-row-head', 'aria-hidden': 'true' },
      h('span', null, 'Route'), col('Length', 'km', 'Length along the route, km'), col('Max', 'slope°', 'Steepest slope along the route'),
      col('Mean', 'slope°', 'Mean slope along the route'), col('Sun', 'lit %', 'Share of the length sunlit during the planned stay'),
      col('PSR', 'km', 'km inside permanently shadowed regions'));
    const group = h('div', { class: 'rp-rows', role: 'radiogroup', 'aria-label': 'Candidate routes' });
    for (const r of routes) {
      const f = routeFigures(r);
      const b = h('button', {
        type: 'button', role: 'radio', class: 'rp-row rp-choice', 'aria-checked': 'false', tabindex: '-1',
        disabled: !!r.unavailable, 'data-route': r.id, 'aria-label': routeSentence(r, names),
        onclick: () => pick(r.id),
        onpointerenter: () => hover(r.id), onpointerleave: () => hover(null),
        onfocus: () => hover(r.id), onblur: () => hover(null),
      },
      h('span', { class: 'rp-name' }, swatch(r.id), h('span', null, r.label)),
      r.unavailable
        ? h('span', { class: 'rp-unavailable' }, r.unavailable)
        : [h('span', { class: 'num' }, f.length), h('span', { class: 'num' }, f.max), h('span', { class: 'num' }, f.mean), h('span', { class: 'num' }, f.sun), h('span', { class: 'num' }, f.psr)],
      r.sameAs ? h('span', { class: 'rp-same' }, `Same route as ${names[r.sameAs]}`) : null);
      buttons.push(b);
      group.append(b);
    }
    group.addEventListener('keydown', (e) => {
      const live = buttons.filter((b) => !b.disabled);
      const at = live.indexOf(document.activeElement);
      if (at < 0) return;
      const to = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: live.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      const b = live[(to + live.length) % live.length];
      b.focus();
      pick(b.dataset.route);
    });
    const sunGap = routes.find((r) => !r.unavailable && r.sunShare !== null && r.sunKnown < 0.95);
    results.append(header, group);
    if (sunGap) results.append(h('p', { class: 'rp-note-inline' }, 'Sunlit figures cover only part of the length; the rest is not computed yet.'));
  }

  function renderNotes() {
    clear(notes);
    notes.append(
      h('li', null, `Slopes come from the ${baseText()} terrain grid. Rover-scale slopes are steeper; this cannot tell whether a vehicle can drive the route.`),
      h('li', null, 'Illustrative only. No speed, travel time or energy is modelled.'),
      h('li', null, 'Max and Mean: the steepest and the mean slope along the route. Sun: share of the length lit during the planned stay, from the 2 km map of the stay at any zoom. PSR: km inside the official permanently shadowed regions.'),
      h('li', null, 'Each name shows the best of the searched routes by its own figure; when one route is best on two, both rows show it.'));
  }

  function update(p = {}) {
    if ('points' in p && p.points !== lastPoints) {
      lastPoints = p.points ?? null;
      if (p.points && p.points !== emitted) {
        rows = rowsFromPoints(p.points);
        while (rows.length < MIN_POINTS) rows.push({ lat: '', lon: '' });
        if (rows.length > maxPoints) rows = rows.slice(0, maxPoints);
        errs = new Map();
        validate(false);
        renderPoints(null);
      }
    }
    if (ok(p.maxSlopeDeg) && p.maxSlopeDeg !== limit) { limit = Math.max(LIMIT.min, Math.min(LIMIT.max, Math.round(p.maxSlopeDeg))); renderLimit(); }
    if ('running' in p) running = !!p.running;
    if ('progress' in p) progress = p.progress;
    if ('plan' in p) plan = p.plan ?? null;
    if ('selected' in p) selected = p.selected ?? null;
    if ('hovered' in p) hovered = p.hovered ?? null;
    const baseBefore = notes.dataset.base;
    renderResults();
    if (baseText() !== baseBefore) { notes.dataset.base = baseText(); renderNotes(); }
  }

  validate(false);
  renderPoints(null);
  renderLimit();
  renderResults();
  notes.dataset.base = baseText();
  renderNotes();
  return { el, update };
}
