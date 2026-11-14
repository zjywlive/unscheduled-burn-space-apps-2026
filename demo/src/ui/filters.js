// Filters (phase 3 §4.3): maximum slope and longest dark, each a slider whose last step is "Any",
// plus an "Any" button that resets it. Builds DOM and calls back with both values.
//
// createFilters(el, { onChange({ maxSlope, maxDark }) }) → { update(params) }
// params: {
//   maxSlope: number | null,           degrees 3–30, null = Any
//   maxDark: number | null,            hours 0–336, null = Any
//   disabled: boolean,                 true in the Now and Change modes
//   disabledText?: string,             why; a default sentence is used when left out
//   passShare: number | null,          share 0–1 of the mapped area that passes; null hides the line
//   note?: string | null,              a caveat shown under Longest dark (e.g. the stay is cut short)
// }
// Tour anchor set here: data-tour="filters" on el.
import { h } from './dom.js';

const SLOPE = { min: 3, max: 30, step: 1 };
const DARK = { min: 0, max: 336, step: 12 };
const DISABLED = 'Filters apply to Both in view, Sunlit, Earth in view and Suitability, not to Now or Change.';
let uid = 0;

function slider(id, label, range, show, onInput) {
  const any = range.max + range.step;     // the step past the last value means Any
  const input = h('input', { type: 'range', class: 'range', id, min: range.min, max: any, step: range.step, value: any });
  const out = h('output', { class: 'filter-value num', for: id });
  const anyBtn = h('button', { type: 'button', class: 'seg-btn filter-any', 'aria-pressed': 'true', 'aria-label': `${label}: any`, onclick: () => { set(null, false); onInput(null); } });
  anyBtn.textContent = 'Any';
  // the readout follows the thumb at once; the caller's update() confirms it
  input.addEventListener('input', () => { const v = Number(input.value) >= any ? null : Number(input.value); set(v, false); onInput(v); });
  const el = h('div', { class: 'filter' },
    h('div', { class: 'filter-head' }, h('label', { for: id }, label), out),
    h('div', { class: 'filter-control' }, input, anyBtn));
  function set(value, disabled) {
    const v = value === null || value === undefined ? any : Math.max(range.min, Math.min(range.max, value));
    if (Number(input.value) !== v) input.value = String(v);
    const text = v >= any ? 'Any' : show(v);
    out.textContent = text;
    input.setAttribute('aria-valuetext', text);
    anyBtn.setAttribute('aria-pressed', String(v >= any));
    input.disabled = disabled; anyBtn.disabled = disabled;
  }
  return { el, set };
}

export function createFilters(el, callbacks = {}) {
  const id = `lsn-filters-${++uid}`;
  let cur = { maxSlope: null, maxDark: null };
  const emit = (patch) => { cur = { ...cur, ...patch }; callbacks.onChange?.({ ...cur }); };
  const slope = slider(`${id}-slope`, 'Max slope', SLOPE, (v) => `${v}°`, (v) => emit({ maxSlope: v }));
  const dark = slider(`${id}-dark`, 'Longest dark', DARK, (v) => `${v} h`, (v) => emit({ maxDark: v }));
  const why = h('p', { class: 'filter-why' });
  const share = h('p', { class: 'filter-share num', role: 'status' });
  const caveat = h('p', { class: 'filter-why filter-caveat', hidden: true });

  el.classList.add('filters');
  el.setAttribute('data-tour', 'filters');
  el.append(
    h('h3', { class: 'panel-title' }, 'Filters'),
    why,
    slope.el,
    h('p', { class: 'filter-note' }, 'Mean slope over a 240 m grid. Real lander-scale slopes are steeper.'),
    dark.el,
    h('p', { class: 'filter-note' }, 'Longest time in a row with the Sun behind the horizon during the stay.'),
    caveat,
    share);

  function update(p) {
    cur = { maxSlope: p.maxSlope ?? null, maxDark: p.maxDark ?? null };
    const off = !!p.disabled;
    slope.set(cur.maxSlope, off);
    dark.set(cur.maxDark, off);
    el.classList.toggle('is-disabled', off);
    why.hidden = !off;
    why.textContent = off ? (p.disabledText ?? DISABLED) : '';
    caveat.hidden = off || !p.note;
    caveat.textContent = off ? '' : (p.note ?? '');
    const ok = !off && p.passShare !== null && p.passShare !== undefined && Number.isFinite(p.passShare);
    share.hidden = !ok;
    share.textContent = ok ? `${Math.round(p.passShare * 100)}% of the mapped area passes the filters.` : '';
  }

  update({});
  return { update };
}
