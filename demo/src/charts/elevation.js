// Elevation over the stay (spec §8.2): Sun and Earth lines on a time axis, the 0° baseline,
// a cursor that can be dragged, and window strips that share the plot's time axis.
import { s, h, clear } from '../ui/dom.js';
import { linear, niceTicks, elevationDomain } from './scale.js';
import { fmtDay, fmtHours } from '../format.js';

const MINUS = '−';
const DAY_MS = 86400e3;
const HOUR_MS = 3600e3;
// The left margin is the strip label column, so the strips and the plot share one time axis.
export const AXIS_LEFT = 96;
export const AXIS_RIGHT = 48;

const degLabel = (v) => `${v < 0 ? MINUS : ''}${Math.abs(v)}°`;

// Round ticks from niceTicks; when a wide range (up to ±90°) leaves fewer than four inside it,
// fall back to 30° or 45° steps so the top of the range still carries a label.
function elevationTicks(lo, hi) {
  const inside = (list) => list.filter((v) => v >= lo && v <= hi);
  const nice = inside(niceTicks(lo, hi, 5));
  if (nice.length >= 4 && nice.length <= 6) return nice;
  for (const step of [30, 45]) {
    const list = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) list.push(v + 0);
    if (list.length >= 4 && list.length <= 6) return list;
  }
  return nice;
}

function dayTicks(startMs, endMs, narrow) {
  const first = Math.ceil(startMs / DAY_MS) * DAY_MS;
  const days = (endMs - first) / DAY_MS;
  const most = narrow ? 4 : 8;
  const step = [1, 2, 3, 4, 5, 7, 10, 14].find((st) => Math.floor(days / st) + 1 <= most) ?? 14;
  const ticks = [];
  for (let t = first; t <= endMs; t += step * DAY_MS) ticks.push(t);
  return ticks;
}

export function renderStrips(el, { startMs, endMs, rows, axisLeft = AXIS_LEFT }) {
  clear(el);
  el.style.setProperty('--axis-left', `${axisLeft}px`);
  const span = Math.max(1, endMs - startMs);
  for (const row of rows) {
    const track = h('div', { class: 'strip-track' });
    for (const [a, b] of row.intervals) {
      const left = ((Math.max(a, startMs) - startMs) / span) * 100;
      const width = ((Math.min(b, endMs) - Math.max(a, startMs)) / span) * 100;
      if (width <= 0) continue;
      const seg = h('span', { class: 'strip-seg' });
      seg.style.left = `${left}%`;
      seg.style.width = `${width}%`;
      seg.style.background = `var(${row.colorVar})`;
      track.append(seg);
    }
    el.append(h('div', { class: 'strip-row' }, h('span', { class: 'strip-label' }, row.label), track));
  }
}

export function renderElevation(el, { series, summary, cursorMs, onScrub, stayDays }) {
  clear(el);
  const width = Math.max(280, Math.round(el.clientWidth || 640));
  const narrow = width < 560;
  const height = narrow ? 150 : 124;
  // On a phone the strip labels go above their strips, so the plot can start at the tick labels.
  const left = narrow ? 40 : AXIS_LEFT;
  const m = { l: left, r: AXIS_RIGHT, t: 8, b: 24 };
  // Heights above the terrain skyline in each body's direction (spec phase 2 §5); 0° is the skyline.
  const sunUp = series.sunAbove ?? series.sunEl, earthUp = series.earthAbove ?? series.earthEl;
  const all = [...sunUp, ...earthUp];
  const [lo, hi] = elevationDomain(Math.min(...all), Math.max(...all));
  const { startMs, endMs } = summary;
  const x = linear(startMs, endMs, m.l, width - m.r);
  const y = linear(lo, hi, height - m.b, m.t);
  const plot = { x0: m.l, x1: width - m.r, y0: m.t, y1: height - m.b };
  const label = `Elevation of the Sun and Earth over the ${stayDays}-day stay. Sunlit ${fmtHours(summary.sunMs)}, Earth in view ${fmtHours(summary.earthMs)}, both ${fmtHours(summary.bothMs)}.`;
  const svg = s('svg', { class: 'elev', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label });

  const ticks = elevationTicks(lo, hi);
  for (const t of ticks) {
    if (t !== 0) svg.append(s('line', { class: 'grid', x1: plot.x0, x2: plot.x1, y1: y(t), y2: y(t) }));
    svg.append(s('text', { class: 'tick', x: plot.x0 - 8, y: y(t) + 4, 'text-anchor': 'end' }, degLabel(t)));
  }
  const days = dayTicks(startMs, endMs, narrow);
  days.forEach((t, i) => {
    const px = x(t);
    const anchor = px - plot.x0 < 24 ? 'start' : plot.x1 - px < 24 ? 'end' : 'middle';
    svg.append(s('text', { class: 'tick', x: px, y: height - 6, 'text-anchor': anchor, 'data-i': i }, fmtDay(t)));
  });
  svg.append(s('line', { class: 'baseline', x1: plot.x0, x2: plot.x1, y1: y(0), y2: y(0) }));

  const ends = {};
  for (const body of ['earth', 'sun']) {
    const els = body === 'sun' ? sunUp : earthUp;
    const d = series.t.map((t, i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(els[i]).toFixed(1)}`).join('');
    svg.append(s('path', { class: `line line-${body}`, d }));
    ends[body] = y(els[els.length - 1]);
  }
  // Name each line at its end; push the lower label down when the two would touch.
  let sunY = ends.sun + 4, earthY = ends.earth + 4;
  if (Math.abs(sunY - earthY) < 14) {
    if (sunY >= earthY) sunY = earthY + 14; else earthY = sunY + 14;
  }
  svg.append(
    s('text', { class: 'line-label', x: plot.x1 + 6, y: sunY }, 'Sun'),
    s('text', { class: 'line-label', x: plot.x1 + 6, y: earthY }, 'Earth'));

  const cursor = s('g', { class: 'cursor' },
    s('line', { x1: 0, x2: 0, y1: plot.y0, y2: plot.y1 }),
    s('circle', { cx: 0, cy: plot.y0, r: 3 }));
  const hit = s('rect', { class: 'scrub-area', x: plot.x0, y: plot.y0, width: plot.x1 - plot.x0, height: plot.y1 - plot.y0 });
  svg.append(cursor, hit);

  const toTime = (evt) => {
    const box = svg.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * width;
    const t = startMs + ((px - plot.x0) / (plot.x1 - plot.x0)) * (endMs - startMs);
    return Math.min(endMs, Math.max(startMs, Math.round(t / HOUR_MS) * HOUR_MS));
  };
  hit.addEventListener('pointerdown', (evt) => {
    hit.setPointerCapture(evt.pointerId);
    onScrub(toTime(evt));
  });
  hit.addEventListener('pointermove', (evt) => {
    if (hit.hasPointerCapture(evt.pointerId)) onScrub(toTime(evt));
  });

  const strips = h('div', { class: narrow ? 'strips is-stacked' : 'strips' });
  strips.style.paddingRight = `${AXIS_RIGHT}px`;
  el.append(svg, strips);
  renderStrips(strips, {
    startMs, endMs, axisLeft: left,
    rows: [
      { label: 'Sunlit', intervals: summary.sunIntervals, colorVar: '--sun' },
      { label: 'Earth in view', intervals: summary.earthIntervals, colorVar: '--earth' },
      { label: 'Both', intervals: summary.bothIntervals, colorVar: '--both' },
    ],
  });
  el._elev = { x, cursor, startMs, endMs };
  updateElevationCursor(el, cursorMs);
}

export function updateElevationCursor(el, cursorMs) {
  const st = el._elev;
  if (!st) return;
  const px = st.x(Math.min(st.endMs, Math.max(st.startMs, cursorMs))).toFixed(1);
  st.cursor.setAttribute('transform', `translate(${px} 0)`);
}
