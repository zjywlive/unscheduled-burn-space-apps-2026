// Region statistics card (phase 3 §4.7): one region, or regions A and B side by side with the
// difference B − A. A worse difference is drawn in --negative and also marked "▼" with the word
// "worse" for screen readers, so colour is never the only cue. Area and cell count are neutral.
//
// createRegionCard(el, { onBest(slot) }) → { update(params) }
// params: {
//   stayMs: number,                    the stay length, to turn shares into hours
//   modeLabel: string,                 current map mode, for the best-cell row, e.g. 'Both in view'
//   A: Slot | null, B: Slot | null,             slots are 'A' and 'B', as everywhere
// }
// Slot: {
//   progress: number,                  0–1; below 1 the figures show "—" and a progress line
//   stats: { cells, areaKm2, sun, earth, both, pass, score } | null,   region.js regionStats output;
//                                      sun/earth/both/pass are shares 0–1, score 0–1 or NaN
//   best: { coords: string, value: string } | null,   the best cell, formatted by the caller
// }
import { h, clear } from './dom.js';
import { fmtHours, DASH } from '../format.js';

const MINUS = '−';
const SLOT = { A: 'A', B: 'B' };
const EMPTY = 'This region is smaller than one grid cell. Zoom in or draw a larger one.';
const NONE = 'Draw a rectangle, circle or polygon on the map to see its numbers.';
const intFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
const sign = (v) => (v > 0 ? '+' : v < 0 ? MINUS : '');

// Each measure: how to show it, its rounded value for the difference, and whether higher is better.
const MEASURES = [
  { key: 'areaKm2', label: 'Area', show: (v) => `${intFmt.format(v)} km²`, round: (v) => Math.round(v), diff: (d) => `${intFmt.format(Math.abs(d))} km²` },
  { key: 'cells', label: 'Grid cells', show: (v) => intFmt.format(v), round: (v) => v, diff: (d) => intFmt.format(Math.abs(d)) },
  { key: 'sun', label: 'Sunlit', share: true, better: 1 },
  { key: 'earth', label: 'Earth in view', share: true, better: 1 },
  { key: 'both', label: 'Both in view', share: true, better: 1 },
  { key: 'pass', label: 'Passes filters', share: true, better: 1, noHours: true },
  { key: 'score', label: 'Suitability', show: (v) => v.toFixed(2), round: (v) => Math.round(v * 100) / 100, diff: (d) => Math.abs(d).toFixed(2), better: 1 },
];

function cellValue(m, stats, stayMs) {
  const v = stats?.[m.key];
  if (!ok(v)) return { main: DASH, sub: null, n: null };
  if (m.share) {
    const pct = Math.round(v * 100);
    return { main: `${pct}%`, sub: m.noHours || !ok(stayMs) ? null : fmtHours(v * stayMs), n: pct };
  }
  return { main: m.show(v), sub: null, n: m.round(v) };
}

function diffCell(m, a, b) {
  if (a.n === null || b.n === null) return h('td', { class: 'n' }, DASH);
  const d = Math.round((b.n - a.n) * 100) / 100;
  if (d === 0) return h('td', { class: 'n region-diff' }, 'no change');
  const text = m.share ? `${sign(d)}${Math.abs(d)} pts` : `${sign(d)}${m.diff(d)}`;
  const worse = m.better === 1 && d < 0;
  return h('td', { class: `n region-diff${worse ? ' is-worse' : ''}` },
    worse ? h('span', { 'aria-hidden': 'true' }, '▼ ') : null, text, worse ? h('span', { class: 'sr-only' }, ', worse') : null);
}

const ready = (slot) => slot && (slot.progress ?? 1) >= 1 && slot.stats;
const isEmpty = (slot) => ready(slot) && slot.stats.cells === 0;

export function createRegionCard(el, callbacks = {}) {
  el.classList.add('region-card');
  const title = h('h2', null, 'Region');
  const body = h('div', { class: 'region-body' });
  el.append(h('div', { class: 'card-head' }, title), body);

  function progressLine(slots) {
    const busy = slots.filter(([, s]) => s && (s.progress ?? 1) < 1);
    if (!busy.length) return null;
    const p = Math.min(...busy.map(([, s]) => s.progress ?? 0));
    return h('p', { class: 'region-progress', role: 'status' },
      h('span', { class: 'region-progress-bar', 'aria-hidden': 'true' }, h('span', { style: `transform:scaleX(${Math.max(0, Math.min(1, p)).toFixed(3)})` })),
      h('span', { class: 'num' }, `Computing… ${Math.round(p * 100)}%`));
  }

  function bestRow(slots, modeLabel) {
    const cells = slots.map(([key, s]) => {
      const b = ready(s) && !isEmpty(s) ? s.best : null;
      if (!b) return h('td', { class: 'n' }, DASH);
      return h('td', { class: 'n region-best-cell' },
        h('button', { type: 'button', class: 'text-btn region-pick', 'data-focus-key': `region-pick:${key}`, onclick: () => callbacks.onBest?.(key), 'aria-label': `Pick the best cell in region ${SLOT[key]}, ${b.coords}` },
          h('span', { class: 'num' }, b.value)),
        h('span', { class: 'sub num' }, b.coords));
    });
    return h('tr', null, h('th', { scope: 'row' }, 'Best cell', h('span', { class: 'th-sub' }, modeLabel ?? '')), cells, slots.length > 1 ? h('td', null) : null);
  }

  function update(p) {
    clear(body);
    const slots = [['A', p.A], ['B', p.B]].filter(([, s]) => s);
    title.textContent = slots.length === 2 ? 'Regions A and B' : slots.length ? `Region ${SLOT[slots[0][0]]}` : 'Region';
    if (!slots.length) { body.append(h('p', { class: 'region-note' }, NONE)); return; }
    const prog = progressLine(slots);
    if (prog) body.append(prog);

    if (slots.length === 1 && isEmpty(slots[0][1])) { body.append(h('p', { class: 'region-note' }, EMPTY)); return; }

    const both = slots.length === 2;
    const values = slots.map(([, s]) => MEASURES.map((m) => (ready(s) && !isEmpty(s) ? cellValue(m, s.stats, p.stayMs) : { main: DASH, sub: null, n: null })));
    const head = h('thead', null, h('tr', null,
      h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Measure')),
      slots.map(([key]) => h('th', { scope: 'col', class: 'n' }, both ? SLOT[key] : 'Value')),
      both ? h('th', { scope: 'col', class: 'n' }, 'B vs A') : null));
    const rows = MEASURES.map((m, r) => h('tr', null,
      h('th', { scope: 'row' }, m.label),
      values.map((col) => h('td', { class: 'n' }, h('span', { class: 'value num' }, col[r].main), col[r].sub ? h('span', { class: 'sub num' }, col[r].sub) : null)),
      both ? diffCell(m, values[0][r], values[1][r]) : null));
    body.append(h('table', { class: 'region-table' }, head, h('tbody', null, rows, bestRow(slots, p.modeLabel))));
    const empties = slots.filter(([, s]) => isEmpty(s));
    for (const [key] of empties) body.append(h('p', { class: 'region-note' }, `Region ${SLOT[key]}: ${EMPTY}`));
    body.append(h('p', { class: 'region-foot' }, 'Sunlit, Earth in view and Both in view are shares of the stay, averaged over the grid cells inside. Passes filters is the share of those cells. Planar area.'));
  }

  update({});
  return { update };
}
