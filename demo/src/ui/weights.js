// Suitability weights (phase 3 §4.4): four sliders 0–100. The score is Σ(weight × part) / Σ weight,
// so only the ratios matter; each slider also says its share of the total.
//
// createWeights(el, { onChange({ sun, earth, slope, shadow }) }) → { update(params) }
// params: {
//   weights: { sun, earth, slope, shadow },   0–100 each
//   disabled?: boolean,                       e.g. outside the Suitability mode
//   disabledText?: string,
// }
// Tour anchor set here: data-tour="weights" on el.
import { h } from './dom.js';

export const DEFAULT_WEIGHTS = Object.freeze({ sun: 40, earth: 30, slope: 20, shadow: 10 });
const PARTS = [
  ['sun', 'Sunlit', 'Share of the stay in sunlight'],
  ['earth', 'Earth in view', 'Share of the stay with Earth above the horizon'],
  ['slope', 'Gentle slope', 'Full marks at 0°, none at 20° or more'],
  ['shadow', 'Near persistent shadow, not inside it', 'Full marks right next to persistent shadow, none inside it or 50 km or more away'],
];
const DISABLED = 'Weights apply to the Suitability map.';
let uid = 0;

export function createWeights(el, callbacks = {}) {
  const id = `lsn-weights-${++uid}`;
  let cur = { ...DEFAULT_WEIGHTS };
  let last = {};
  // the readouts follow the thumbs at once; the caller's update() confirms them
  const emit = () => { update({ ...last, weights: cur }); callbacks.onChange?.({ ...cur }); };
  const rows = PARTS.map(([key, label, note]) => {
    const input = h('input', { type: 'range', class: 'range', id: `${id}-${key}`, min: 0, max: 100, step: 5, value: cur[key], 'aria-describedby': `${id}-${key}-note` });
    const out = h('output', { class: 'filter-value num', for: `${id}-${key}` });
    input.addEventListener('input', () => { cur = { ...cur, [key]: Number(input.value) }; emit(); });
    const row = h('div', { class: 'filter weight' },
      h('div', { class: 'filter-head' }, h('label', { for: `${id}-${key}` }, label), out),
      input,
      h('p', { class: 'filter-note', id: `${id}-${key}-note` }, note));
    return { key, input, out, el: row };
  });
  const empty = h('p', { class: 'weights-empty', role: 'status' });
  const why = h('p', { class: 'filter-why' });
  const reset = h('button', { type: 'button', class: 'text-btn', onclick: () => { cur = { ...DEFAULT_WEIGHTS }; emit(); } }, 'Reset weights');

  el.classList.add('weights');
  el.setAttribute('data-tour', 'weights');
  el.append(
    h('h3', { class: 'panel-title' }, 'Suitability weights'),
    why,
    ...rows.map((r) => r.el),
    empty,
    h('p', { class: 'filter-note' }, 'Persistent shadow: cells where the Sun never clears the horizon from Nov 2026 to Jan 2029. This is not the same as a permanently shadowed region.'),
    reset);

  function update(p) {
    last = p;
    cur = { ...DEFAULT_WEIGHTS, ...(p.weights ?? {}) };
    const total = PARTS.reduce((a, [k]) => a + cur[k], 0);
    const off = !!p.disabled;
    for (const r of rows) {
      const v = cur[r.key];
      if (Number(r.input.value) !== v) r.input.value = String(v);
      const share = total > 0 ? `${Math.round((v / total) * 100)}% of the score` : 'no weight set';
      r.out.textContent = String(v);
      r.input.setAttribute('aria-valuetext', `${v} of 100, ${share}`);
      r.input.disabled = off;
    }
    empty.hidden = total > 0;
    empty.textContent = total > 0 ? '' : 'Set at least one weight.';
    why.hidden = !off;
    why.textContent = off ? (p.disabledText ?? DISABLED) : '';
    el.classList.toggle('is-disabled', off);
    reset.hidden = PARTS.every(([k]) => cur[k] === DEFAULT_WEIGHTS[k]);
    reset.disabled = off;
  }

  update({});
  return { update };
}
