// The "Planned vs alternative" card (spec §3, §5.1, §7.2, §9.1): one row per measure, the change
// under the alternative's value, and mini strips of "both in view" on a shared day-of-stay axis.
import { h, clear } from './dom.js';
import { DASH } from '../format.js';
import { compareRows as rowsOf } from '../compare-rows.js';
import { renderStrips } from '../charts/elevation.js';

// The rows live in ../compare-rows.js (pure, no DOM); kept here for the callers and tests that import them
// from this file.
export const compareRows = rowsOf;

// The lead figure prints its unit as a smaller suffix; a two-part sentence prints its second part as a subline.
function valueCell(text, lead) {
  if (lead) {
    const m = /^(.*\d)\s(h|min)$/.exec(text);
    if (m) return h('span', { class: 'value' }, m[1], h('span', { class: 'unit' }, ` ${m[2]}`));
  }
  const i = text.indexOf(', ');
  if (i > 0) return [h('span', { class: 'value value-text' }, text.slice(0, i)), h('span', { class: 'sub' }, text.slice(i + 2))];
  const figure = text === DASH || /\d\s?(h|min|°)$/.test(text);
  return h('span', { class: figure ? 'value' : 'value value-text' }, text);
}

export function renderCompare(el, { planned, alt, plannedLabel, altLabel, altNote }) {
  clear(el);
  const rows = rowsOf(planned, alt);
  const table = h('table', { class: 'compare-table' },
    h('thead', null, h('tr', null,
      h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Measure')),
      h('th', { scope: 'col', class: 'n' }, 'Planned', h('span', { class: 'th-sub' }, plannedLabel)),
      h('th', { scope: 'col', class: 'n' }, 'Alternative', h('span', { class: 'th-sub' }, altLabel)))),
    h('tbody', null, rows.map((r) => h('tr', { class: r.lead ? 'is-lead' : null },
      h('th', { scope: 'row' }, r.label),
      h('td', { class: 'n' }, valueCell(r.planned, r.lead)),
      h('td', { class: 'n' }, valueCell(r.alt, r.lead),
        r.change ? h('span', { class: `change${r.worse ? ' is-worse' : ''}` }, r.change) : null)))));
  el.append(table);
  if (altNote) el.append(h('p', { class: 'compare-note' }, altNote));

  const stayMs = planned.stayMs;
  const shift = (s) => s.bothIntervals.map(([a, b]) => [a - s.startMs, b - s.startMs]);
  const strips = h('div', { class: 'strips compare-strips' });
  const days = Math.round(stayMs / 86400e3);
  el.append(strips,
    h('div', { class: 'strip-axis' }, h('span', null, 'Day 1'), h('span', { class: 'strip-axis-title' }, 'Both in view, by day of stay'), h('span', null, `Day ${days}`)));
  renderStrips(strips, {
    startMs: 0, endMs: stayMs,
    rows: [
      { label: 'Planned', intervals: shift(planned), colorVar: '--both' },
      ...(alt ? [{ label: 'Alternative', intervals: shift(alt), colorVar: '--both' }] : []),
    ],
  });
}
