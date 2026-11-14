// "Rises and sets during the stay" (spec §9.1, §9.4): every rise and set, what it means and for how long.
import { h, clear } from './dom.js';
import { fmtUtc, fmtDeg, fmtSpan } from '../format.js';

const NAMES = { sun: { rise: 'Sunrise', set: 'Sunset' }, earth: { rise: 'Earthrise', set: 'Earthset' } };
const LIMIT = 6;

export function eventRows(summary) {
  return summary.events.map((e) => {
    const state = e.kind === 'rise' ? 'up' : 'down';
    return {
      body: e.body,
      time: fmtUtc(e.tMs).replace(' UTC', ''),
      event: NAMES[e.body][e.kind],
      azimuth: fmtDeg(e.azDeg),
      after: fmtSpan(e.tMs - summary.startMs),
      then: e.thenMs === null ? `${state} until the stay ends` : `${state} for ${fmtSpan(e.thenMs)}`,
    };
  });
}

export function renderEvents(el, summary, { stayDays }) {
  clear(el);
  const rows = eventRows(summary);
  const expanded = el.dataset.expanded === 'true';
  const shown = expanded ? rows : rows.slice(0, LIMIT);
  const head = h('thead', null, h('tr', null,
    h('th', { scope: 'col' }, 'Time (UTC)'), h('th', { scope: 'col' }, 'Event'),
    h('th', { scope: 'col', class: 'n' }, 'Azimuth'), h('th', { scope: 'col', class: 'n' }, 'After landing'),
    h('th', { scope: 'col' }, 'Then')));
  let body;
  if (!rows.length) {
    const sunAllStay = summary.sunMs === summary.stayMs && summary.stayMs > 0;
    const text = sunAllStay ? `No rises or sets in this stay. The Sun stays up for all ${stayDays} days.` : 'No rises or sets in this stay.';
    body = h('tbody', null, h('tr', { class: 'is-empty' }, h('td', { colspan: 5 }, text)));
  } else {
    body = h('tbody', null, shown.map((r) => h('tr', null,
      h('td', { class: 'ev-time', 'data-label': 'Time (UTC)' }, r.time),
      h('td', { class: 'ev-name' }, h('span', { class: `dot dot-${r.body}`, 'aria-hidden': 'true' }), r.event),
      h('td', { class: 'n', 'data-label': 'Azimuth' }, r.azimuth),
      h('td', { class: 'n', 'data-label': 'After landing' }, r.after),
      h('td', { class: 'ev-then' }, r.then))));
  }
  el.append(h('table', { class: 'events-table' }, head, body));
  if (rows.length > LIMIT) {
    el.append(h('button', {
      type: 'button', class: 'text-btn', 'aria-expanded': String(expanded),
      onclick: () => { el.dataset.expanded = String(!expanded); renderEvents(el, summary, { stayDays }); el.querySelector('.text-btn')?.focus(); },
    }, expanded ? 'Show fewer' : `Show all ${rows.length}`));
  }
}
