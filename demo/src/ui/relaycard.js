// Relay link card (phase 4 §6 K): an assumed relay orbit (example presets, every element editable),
// the relay and direct-to-Earth coverage for the planned and alternative stays, a four-row time strip
// (Sun / Earth direct / Relay / Any link), the first link windows, and what is not modelled.
// The relay is drawn in neutral ink and always labelled in words; no new hue.
//
// createRelayCard(deps, callbacks) → { el, update(params), setOrbit(elements, presetId?), getOrbit() }
// deps: { eph }                        ephemeris.createEphemeris() object (main.js `eph`)
// callbacks: {
//   onOrbit?(elements, presetId | null, { minElDeg }),   after a valid orbit is applied (for the hash or the command layer)
//   onCursor?(ms),                          a window in the list was picked: move the time cursor there
// }
// params: {
//   planned: Scenario | null,
//   alt: Scenario | null,              null or omitted when nothing is compared
//   landingMs: number,                 planned landing; the orbit epoch when the Epoch field is empty
//   cursorMs?: number,                 time cursor, drawn on the strip when inside the stay
// }
// Scenario: {
//   label: string,                     column heading, e.g. '13 Jan' or 'Haworth, 27 Jan'
//   site: { latDeg, lonDeg, heightM? },
//   mask: (azDeg) => deg | number,     the site's terrain skyline (main.js sky(site))
//   summary,                           windows.summarize() output for that stay (startMs, endMs, sunIntervals, earthIntervals)
// }
import { h, s, clear } from './dom.js';
import { PRESETS, validateElements, relayForSummary } from '../relay.js';
import { fmtHours, fmtSpan, fmtDeg, fmtDayOfStay, fmtUtc, DASH } from '../format.js';

const DAY_MS = 86400e3;
const intFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const MINUS = '−';
const signedInt = (v) => `${Math.round(v) < 0 ? MINUS : ''}${intFmt.format(Math.abs(Math.round(v)))}`;
const oneFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
const toInput = (ms) => new Date(ms).toISOString().slice(0, 16);
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
let uid = 0;

const FIELDS = [
  { key: 'aKm', label: 'Semi-major axis', unit: 'km', step: 'any' },
  { key: 'e', label: 'Eccentricity', unit: '', step: 'any' },
  { key: 'iDeg', label: 'Inclination', unit: '°', step: 'any' },
  { key: 'raanDeg', label: 'Ascending node', unit: '° E', step: 'any' },
  { key: 'argpDeg', label: 'Arg. of perilune', unit: '°', step: 'any' },
  { key: 'm0Deg', label: 'Mean anomaly', unit: '°', step: 'any' },
];
const ROWS = [
  { key: 'sun', label: 'Sun', cls: 'relay-bar-sun' },
  { key: 'earth', label: 'Earth direct', cls: 'relay-bar-earth' },
  { key: 'relay', label: 'Relay', cls: 'relay-bar-relay' },
  { key: 'any', label: 'Any link', cls: 'relay-bar-any' },
];
const CAVEATS = [
  'Assumed orbit. The presets are worked examples, not any mission’s orbit.',
  'Two-body motion only: no Earth or Sun pull and no lunar gravity field, so a real orbit drifts from this within weeks. Illustrative.',
  'The relay counts as in view when it is above the 480 m terrain skyline and the minimum elevation; it sees the Earth when the line to the Earth’s centre clears a smooth Moon of radius 1,737.4 km.',
  'No link budget, antenna pointing, ground station or relay availability.',
];

export function createRelayCard(deps = {}, callbacks = {}) {
  const id = `lsn-relay-${++uid}`;
  const ids = (k) => `${id}-${k}`;
  let elements = { ...PRESETS[0].elements };
  let presetId = PRESETS[0].id;
  let minElDeg = 0;
  let last = null;            // last params
  let cache = null;           // { key, planned, alt }
  let show = 'planned';
  let width = 0;

  const el = h('section', { class: 'card relay-card', 'aria-labelledby': ids('head') });

  // ---------- orbit ----------
  const select = h('select', { id: ids('preset'), class: 'input select relay-preset', title: 'Assumed relay orbit' },
    PRESETS.map((p) => h('option', { value: p.id }, p.name)), h('option', { value: 'custom' }, 'Custom orbit'));
  select.addEventListener('change', () => {
    const p = PRESETS.find((q) => q.id === select.value);
    if (!p) { presetId = null; setOpen(true); return; }
    apply({ ...p.elements }, p.id, true);
  });

  const inputs = {}, errors = {};
  const field = (key, label, unit, control) => {
    errors[key] = h('p', { id: ids(`${key}-error`), class: 'field-error relay-error', hidden: true });
    return h('div', { class: 'field relay-field' },
      h('label', { for: control.id }, label, unit ? h('span', { class: 'relay-unit' }, ` ${unit}`) : null), control, errors[key]);
  };
  const commit = () => readAndApply();
  const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
  const grid = h('div', { class: 'relay-grid' },
    FIELDS.map((f) => {
      inputs[f.key] = h('input', { id: ids(f.key), type: 'number', step: f.step, inputmode: 'decimal', class: 'input relay-input num', autocomplete: 'off', onchange: commit, onkeydown: onKey });
      return field(f.key, f.label, f.unit, inputs[f.key]);
    }));
  inputs.epochMs = h('input', { id: ids('epochMs'), type: 'datetime-local', step: 60, class: 'input relay-input relay-epoch num', autocomplete: 'off', onchange: commit, onkeydown: onKey });
  inputs.minEl = h('input', { id: ids('minEl'), type: 'number', step: 'any', min: 0, max: 45, inputmode: 'decimal', class: 'input relay-input num', autocomplete: 'off', onchange: commit, onkeydown: onKey });
  const useLanding = h('button', { type: 'button', class: 'text-btn relay-use-landing', onclick: () => { inputs.epochMs.value = ''; commit(); } }, 'Use landing');
  const epochField = field('epochMs', 'Epoch', 'UTC', inputs.epochMs);
  epochField.append(h('p', { class: 'relay-hint' }, 'The mean anomaly holds at this time. Empty: the planned landing time.'), useLanding);
  const minElField = field('minEl', 'Min elevation', '°', inputs.minEl);
  const derived = h('p', { class: 'relay-derived num', 'aria-live': 'polite' });

  const toggle = h('button', { type: 'button', class: 'filters-toggle relay-toggle', 'aria-expanded': 'false', 'aria-controls': ids('elements'), onclick: () => setOpen(!open) },
    h('span', { class: 'filters-label' }, 'Elements'), h('span', { class: 'filters-summary relay-assumed' }, 'assumed'), h('span', { class: 'filters-chevron', 'aria-hidden': 'true' }));
  const elementsBody = h('div', { class: 'relay-elements', id: ids('elements'), hidden: true }, grid, h('div', { class: 'relay-grid' }, epochField, minElField));
  let open = false;
  const orbitBox = h('details', { class: 'fold-more relay-orbit' }, h('summary', null, 'Orbit ', h('span', { class: 'relay-unit' }, 'assumed')),
    h('div', { class: 'fold-more-body' },
      h('div', { class: 'field relay-field' }, h('label', { for: select.id }, 'Orbit ', h('span', { class: 'relay-unit' }, 'assumed')), select),
      derived,
      h('div', { class: 'relay-fold' }, toggle, elementsBody)));
  function setOpen(v) { open = v; toggle.setAttribute('aria-expanded', String(v)); elementsBody.hidden = !v; if (v) orbitBox.open = true; }

  // ---------- results ----------
  const status = h('p', { class: 'relay-status', role: 'status' });
  const results = h('div', { class: 'relay-results' });
  const stripSeg = h('div', { class: 'seg relay-seg', role: 'group', 'aria-label': 'Strip and windows for' });
  const stripWrap = h('div', { class: 'relay-strip' });
  const listHead = h('h3', { class: 'relay-subhead' }, 'Relay windows');
  const list = h('ol', { class: 'relay-windows' });
  const listWrap = h('div', null, listHead, list);

  el.append(
    h('div', { class: 'card-head card-head-stack' }, h('h2', { id: ids('head') }, 'Relay link'),
      h('p', { class: 'card-sub' }, 'Assumed relay orbit, two-body, illustrative')),
    // G (phase 4 step 2, coordinator's layout rule): figures first; the orbit inputs and the notes are one
    // click away in disclosures closed by default, so the card fits the floating panel.
    status, results, stripSeg, stripWrap, listWrap,
    orbitBox,
    h('details', { class: 'fold-more relay-notes' }, h('summary', null, 'Notes'),
      h('ul', { class: 'relay-foot fold-more-body' }, CAVEATS.map((t) => h('li', null, t)))));

  function fillInputs() {
    for (const f of FIELDS) inputs[f.key].value = String(elements[f.key]);
    inputs.epochMs.value = ok(elements.epochMs) ? toInput(elements.epochMs) : '';
    inputs.minEl.value = String(minElDeg);
    select.value = presetId ?? 'custom';
  }

  function showErrors(errs) {
    for (const [key, input] of Object.entries(inputs)) {
      const msg = errs[key];
      const box = errors[key];
      // a perilune or apolune error belongs to both a and e; say it once, under e
      const text = key === 'aKm' && msg && msg === errs.e ? 'See eccentricity.' : msg;
      box.hidden = !text; box.textContent = text ?? '';
      if (msg) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', box.id); }
      else { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
    }
  }

  function describeDerived(d, invalid) {
    if (!d) { derived.textContent = DASH; return; }
    const lead = invalid ? 'Not applied; the results are for the last valid orbit. ' : '';
    derived.textContent = `${lead}Period ${oneFmt.format(d.periodS / 3600)} h, perilune ${signedInt(d.periluneAltKm)} km, apolune ${signedInt(d.apoluneAltKm)} km above 1,737.4 km`;
  }

  function readAndApply() {
    const next = {};
    for (const f of FIELDS) { const raw = inputs[f.key].value.trim(); next[f.key] = raw === '' ? NaN : Number(raw); }
    const ep = inputs.epochMs.value.trim();
    next.epochMs = ep === '' ? null : Date.parse(`${ep}Z`);
    const minRaw = inputs.minEl.value.trim();
    const minEl = minRaw === '' ? 0 : Number(minRaw);
    const v = validateElements(next);
    const errs = { ...v.errors };
    if (!Number.isFinite(minEl) || minEl < 0 || minEl > 45) errs.minEl = 'Use 0° to 45°.';
    showErrors(errs);
    if (Object.keys(errs).length) {
      setOpen(true);
      describeDerived(v.derived, true);
      return false;
    }
    const same = PRESETS.find((p) => FIELDS.every((f) => p.elements[f.key] === next[f.key]) && (p.elements.epochMs ?? null) === (next.epochMs ?? null));
    minElDeg = minEl;
    apply(next, same ? same.id : null, false);
    return true;
  }

  function apply(next, pid, refill) {
    elements = next; presetId = pid;
    if (refill) { fillInputs(); showErrors({}); }
    select.value = presetId ?? 'custom';
    describeDerived(validateElements(elements).derived, false);
    callbacks.onOrbit?.({ ...elements }, presetId, { minElDeg });
    render();
  }

  // ---------- computation ----------
  function compute() {
    const p = last;
    if (!p?.planned?.summary || !deps.eph) return null;
    const key = JSON.stringify([elements, minElDeg, p.landingMs]);
    if (cache && cache.key === key && cache.pSum === p.planned.summary && cache.aSum === (p.alt?.summary ?? null)
      && cache.pMask === p.planned.mask && cache.aMask === (p.alt?.mask ?? null)) return cache;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const run = (sc) => (sc?.summary ? relayForSummary(sc.summary, { elements, eph: deps.eph, site: sc.site, mask: sc.mask ?? 0, minElDeg, defaultEpochMs: p.landingMs }) : null);
    const planned = run(p.planned);
    const alt = run(p.alt);
    const ms = typeof performance !== 'undefined' ? performance.now() - t0 : NaN;
    cache = { key, pSum: p.planned.summary, aSum: p.alt?.summary ?? null, pMask: p.planned.mask, aMask: p.alt?.mask ?? null, planned, alt, ms };
    return cache;
  }

  // ---------- rendering ----------
  function table(r, p) {
    const cols = [[p.planned.label ?? 'Planned', r.planned], ...(p.alt ? [[p.alt.label ?? 'Alternative', r.alt]] : [])];
    const two = cols.length === 2;
    const cell = (main, sub) => h('td', { class: 'n' }, h('span', { class: 'value num' }, main), sub ? h('span', { class: 'sub num' }, sub) : null);
    // (fix R7) the share says what it is a share of
    const hoursCell = (x, k) => (x ? cell(fmtHours(x[k]), x.stayMs > 0 ? `${Math.round((x[k] / x.stayMs) * 100)}% of stay` : null) : cell(DASH));
    const spanCell = (x, k) => (x ? cell(x[k] > 0 ? fmtSpan(x[k]) : 'none') : cell(DASH));
    const rows = [
      ['Relay link', (x) => hoursCell(x, 'relayMs'), 'Relay above the skyline and in view of the Earth'],
      ['Longest relay gap', (x) => spanCell(x, 'longestRelayGapMs')],
      ['Earth direct', (x) => hoursCell(x, 'directMs'), 'Earth above the skyline'],
      ['Direct or relay', (x) => hoursCell(x, 'anyMs'), 'At least one link'],
      ['Longest blind', (x) => spanCell(x, 'longestBlindMs'), 'No direct and no relay link'],
    ];
    return h('table', { class: 'relay-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Measure')),
        cols.map(([label]) => h('th', { scope: 'col', class: 'n' }, two ? label : 'Value')))),
      h('tbody', null, rows.map(([label, fn, sub]) => h('tr', null,
        h('th', { scope: 'row' }, label, sub ? h('span', { class: 'th-sub' }, sub) : null),
        cols.map(([, x]) => fn(x))))));
  }

  function strip(sc, r, cursorMs) {
    const sum = sc.summary;
    const W = Math.max(240, Math.round(width || 272));
    const LABEL = 78, RIGHT = 2, ROW = 10, GAP = 6, TOP = 2;
    const plotW = W - LABEL - RIGHT;
    const H = TOP + ROWS.length * (ROW + GAP) + 16;
    const span = sum.endMs - sum.startMs;
    const x = (t) => LABEL + ((t - sum.startMs) / span) * plotW;
    const sets = { sun: sum.sunIntervals ?? [], earth: r.directIntervals, relay: r.linkIntervals, any: r.anyIntervals };
    const hours = { sun: sum.sunMs ?? 0, earth: r.directMs, relay: r.relayMs, any: r.anyMs };
    const svg = s('svg', {
      class: 'relay-strip-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img',
      'aria-label': `${sc.label ?? 'Stay'}, ${fmtSpan(span)}: ` + ROWS.map((row) => `${row.label} ${fmtHours(hours[row.key])}`).join(', ') + '.',
    });
    ROWS.forEach((row, k) => {
      const y = TOP + k * (ROW + GAP);
      svg.append(s('text', { class: 'tick relay-row-label', x: 0, y: y + ROW - 1 }, row.label));
      svg.append(s('rect', { class: 'relay-track', x: LABEL, y, width: plotW, height: ROW }));
      const g = s('g', { class: row.cls, 'aria-hidden': 'true' });
      for (const [a, b] of sets[row.key]) {
        const x0 = x(Math.max(a, sum.startMs)), x1 = x(Math.min(b, sum.endMs));
        g.append(s('rect', { x: x0.toFixed(2), y, width: Math.max(0.75, x1 - x0).toFixed(2), height: ROW }));
      }
      svg.append(g);
    });
    // day ticks under the rows; first and last labelled
    const yb = TOP + ROWS.length * (ROW + GAP) - GAP + 3;
    const days = Math.floor(span / DAY_MS);
    const ticks = s('g', { 'aria-hidden': 'true' });
    for (let d = 0; d <= days; d++) {
      const px = x(sum.startMs + d * DAY_MS);
      ticks.append(s('line', { class: 'relay-tick', x1: px.toFixed(1), x2: px.toFixed(1), y1: yb, y2: yb + 3 }));
    }
    ticks.append(s('text', { class: 'tick', x: LABEL, y: H - 1 }, 'Day 1'));
    ticks.append(s('text', { class: 'tick', x: W - RIGHT, y: H - 1, 'text-anchor': 'end' }, fmtSpan(span)));
    svg.append(ticks);
    if (ok(cursorMs) && cursorMs >= sum.startMs && cursorMs <= sum.endMs) {
      const px = x(cursorMs).toFixed(1);
      svg.append(s('line', { class: 'relay-cursor', x1: px, x2: px, y1: 0, y2: yb, 'aria-hidden': 'true' }));
    }
    return svg;
  }

  function windowItems(sc, r) {
    clear(list);
    if (!r.windows.length) { list.append(h('li', { class: 'relay-empty' }, 'No relay link during this stay.')); return; }
    for (const w of r.windows) {
      const text = `${fmtDayOfStay(w.startMs, sc.summary.startMs)}`;
      const detail = `${fmtSpan(w.durMs)}, up to ${fmtDeg(w.peakElDeg)} high`;
      const label = `${fmtUtc(w.startMs)}, relay link for ${fmtSpan(w.durMs)}, peak elevation ${fmtDeg(w.peakElDeg)}`;
      const inner = [h('span', { class: 'relay-win-time num' }, text), h('span', { class: 'relay-win-detail num' }, detail)];
      list.append(h('li', null, callbacks.onCursor
        ? h('button', { type: 'button', class: 'relay-win', 'aria-label': `Move the time cursor to ${label}`, onclick: () => callbacks.onCursor(w.startMs) }, inner)
        : h('div', { class: 'relay-win', 'aria-label': label }, inner)));
    }
    if (r.windowCount > r.windows.length) list.append(h('li', { class: 'relay-more num' }, `${intFmt.format(r.windowCount - r.windows.length)} more in this stay`));
  }

  function render() {
    const p = last;
    clear(results); clear(stripWrap); clear(stripSeg);
    if (!p?.planned) { status.textContent = 'Pick a site and a landing time to see relay windows.'; listWrap.hidden = true; stripSeg.hidden = true; return; }
    if (!p.planned.summary) { status.textContent = 'The planned landing is outside the ephemeris.'; listWrap.hidden = true; stripSeg.hidden = true; return; }
    const r = compute();
    if (!r?.planned) { status.textContent = 'The stay has no length to compute.'; listWrap.hidden = true; stripSeg.hidden = true; return; }
    status.textContent = '';
    width = Math.max(0, (el.clientWidth || 300) - parseFloat(getComputedStyle(el).paddingLeft || 0) * 2) || 272;
    results.append(table(r, p));
    if (p.alt && !p.alt.summary) results.append(h('p', { class: 'relay-note' }, 'The alternative lands outside the ephemeris.'));
    const canAlt = !!(p.alt?.summary && r.alt);
    if (!canAlt) show = 'planned';
    stripSeg.hidden = !canAlt;
    if (canAlt) {
      for (const [v, label] of [['planned', 'Planned'], ['alt', 'Alternative']]) {
        stripSeg.append(h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(show === v), onclick: () => { show = v; render(); } }, label));
      }
    }
    const sc = show === 'alt' ? p.alt : p.planned;
    const rr = show === 'alt' ? r.alt : r.planned;
    stripWrap.append(strip(sc, rr, show === 'planned' ? p.cursorMs : null),
      h('p', { class: 'relay-step num' }, `Relay sampled every ${intFmt.format(rr.stepMs / 1000)} s, edges to 1 s. Orbit epoch ${fmtUtc(rr.epochMs)}.`));
    listWrap.hidden = false;
    listHead.textContent = canAlt ? `Relay windows, ${show === 'alt' ? 'alternative' : 'planned'}` : 'Relay windows';
    windowItems(sc, rr);
  }

  function update(params) {
    last = params ?? null;
    render();
  }

  fillInputs();
  describeDerived(validateElements(elements).derived, false);
  render();

  return {
    el,
    update,
    // for the command layer (set_relay_orbit): returns { ok, errors }; invalid elements are not applied
    // fix R (for L5): opts.minElDeg (0–45) sets the minimum elevation too, e.g. restored from the hash
    setOrbit(next, pid = null, opts = {}) {
      const merged = { ...elements, ...next };
      const v = validateElements(merged);
      if (!v.ok) return { ok: false, errors: v.errors };
      if (opts.minElDeg !== undefined) {
        if (!(Number.isFinite(opts.minElDeg) && opts.minElDeg >= 0 && opts.minElDeg <= 45)) return { ok: false, errors: { minEl: 'Use 0° to 45°.' } };
        minElDeg = opts.minElDeg;
      }
      apply(merged, pid, true);
      return { ok: true, errors: {} };
    },
    getOrbit: () => ({ elements: { ...elements }, presetId, minElDeg, results: cache ? { planned: cache.planned, alt: cache.alt, ms: cache.ms } : null }),
  };
}
