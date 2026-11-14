// The landing-date ribbon (spec phase 2 §3.3, §4.1): one bar per landing day across the ephemeris,
// its strength the share of the stay with both Sun and Earth in view; month ticks; the planned and
// alternative landing days marked. A visually hidden range input is the keyboard and reader entry.
import { h, s, clear } from './dom.js';
import { fmtDay, fmtHours } from '../format.js';

const DAY_MS = 86400e3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let uid = 0;

// compact (phase 4 big-map bar): one thin strip, no month labels.
export function renderRibbon(el, { ribbon, stayDays, landingMs, altLandingMs, onPickDay, compact = false }) {
  clear(el);
  const { dayMs, bothMs } = ribbon;
  if (!dayMs.length) return;
  const width = Math.max(280, Math.round(el.clientWidth || 800));
  const narrow = width < 640;
  const barTop = compact ? 5 : 4, barH = compact ? 18 : 44, height = barTop + barH + (compact ? 5 : 22);
  const n = dayMs.length;
  const x = (t) => ((t - dayMs[0]) / (dayMs[n - 1] + DAY_MS - dayMs[0])) * width;
  const stayMs = stayDays * DAY_MS;
  const dayIndex = (t) => Math.max(0, Math.min(n - 1, Math.round((Math.floor(t / DAY_MS) * DAY_MS - dayMs[0]) / DAY_MS)));
  const at = dayIndex(landingMs);

  const svg = s('svg', {
    class: 'ribbon', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img',
    'aria-label': `Hours with both Sun and Earth in view for a ${stayDays}-day stay, by landing day, ${fmtDay(dayMs[0])} to ${fmtDay(dayMs[n - 1])}. Landing on ${fmtDay(dayMs[at])} gives ${fmtHours(bothMs[at])}.`,
  });
  const bars = s('g', { class: 'ribbon-bars' });
  const w = width / n;
  svg.append(s('rect', { class: 'ribbon-track', x: 0, y: barTop, width, height: barH }));
  for (let i = 0; i < n; i++) {
    const share = bothMs[i] / stayMs;
    if (share <= 0) continue;
    bars.append(s('rect', { x: (i * w).toFixed(2), y: barTop, width: (w + 0.6).toFixed(2), height: barH, 'fill-opacity': Math.min(1, share).toFixed(3) }));
  }
  svg.append(bars);

  // Month ticks: every quarter on wide screens, every half year on phones, labelled at January with the year.
  const every = narrow ? 6 : 3;
  const first = new Date(dayMs[0]);
  for (let y = first.getUTCFullYear(), m = first.getUTCMonth() + 1; ; m++) {
    if (m > 11) { m = 0; y++; }
    const t = Date.UTC(y, m, 1);
    if (t > dayMs[n - 1]) break;
    if (compact || m % every !== 0) continue;
    const px = x(t);
    svg.append(s('line', { class: 'ribbon-tick', x1: px, x2: px, y1: barTop + barH, y2: barTop + barH + 5 }));
    const label = m === 0 ? `Jan ${y}` : MONTHS[m];
    const anchor = px < 30 ? 'start' : px > width - 30 ? 'end' : 'middle';
    svg.append(s('text', { class: 'tick', x: px, y: height - 4, 'text-anchor': anchor }, label));
  }
  const mark = (t, cls) => {
    if (t < dayMs[0] || t > dayMs[n - 1] + DAY_MS) return;
    const px = x(Math.floor(t / DAY_MS) * DAY_MS) + w / 2;
    svg.append(s('line', { class: `ribbon-mark ${cls}`, x1: px, x2: px, y1: 0, y2: barTop + barH + 4 }));
  };
  if (altLandingMs !== null && altLandingMs !== undefined) mark(altLandingMs, 'is-alt');
  mark(landingMs, 'is-site');

  svg.addEventListener('click', (e) => {
    const box = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - box.left) / box.width) * n)));
    onPickDay(dayMs[i]);
  });

  const id = `lsn-ribbon-day-${++uid}`;
  const range = h('input', {
    id, type: 'range', class: 'ribbon-range', min: 0, max: n - 1, step: 1, value: at, 'data-focus-key': 'ribbon',
    'aria-valuetext': `${fmtDay(dayMs[at])}, ${fmtHours(bothMs[at])}`,
    // Arrow keys move through the days (announced through aria-valuetext); Enter lands on the day.
    oninput: () => range.setAttribute('aria-valuetext', `${fmtDay(dayMs[Number(range.value)])}, ${fmtHours(bothMs[Number(range.value)])}`),
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); onPickDay(dayMs[Number(range.value)]); } },
  });
  el.append(h('div', { class: 'ribbon-wrap' }, svg, h('label', { for: id, class: 'sr-only' }, 'Landing day'), range));
}
