// The sky panorama (spec §8.1): azimuth across, elevation up, the stay's Sun and Earth tracks,
// and two markers for the cursor time. Drawn at the container's pixel width so text stays at 12px.
import { s, h, clear } from '../ui/dom.js';
import { linear, niceTicks, splitAtWrap } from './scale.js';
import { fmtDeg } from '../format.js';

const MINUS = '−';
const NAMES = { sun: 'Sun', earth: 'Earth' };
const AZ_LABELS = [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W'], [360, 'N']];
let uid = 0;

const degLabel = (v) => `${v < 0 ? MINUS : ''}${Math.abs(v)}°`;

// A jump of more than 45° between hourly samples (a pass near the zenith) is not drawn as a line.
function tracks(azs, els) {
  const pts = azs.map((az, i) => ({ az, el: els[i] }));
  const broken = [];
  for (const p of pts) {
    const prev = broken[broken.length - 1];
    if (prev && prev.az !== null && p.az !== null) {
      const d = Math.abs(((p.az - prev.az + 540) % 360) - 180);
      if (d > 45) broken.push({ az: null, el: p.el });
    }
    broken.push(p);
  }
  return splitAtWrap(broken);
}

function describe(body, pos) {
  return `${NAMES[body]}, azimuth ${fmtDeg(pos.azDeg)}, elevation ${fmtDeg(pos.elDeg)}`;
}

function ariaLabel(siteName, cursor) {
  const part = (b) => `${NAMES[b]} at azimuth ${fmtDeg(cursor[b].azDeg)}, elevation ${fmtDeg(cursor[b].elDeg)}.`;
  return `Sky at ${siteName}. ${part('sun')} ${part('earth')}`;
}

export function renderPanorama(el, { series, cursor, siteName, skyline = null }) {
  clear(el);
  const width = Math.max(280, Math.round(el.clientWidth || 640));
  const height = 150;
  const m = { l: 34, r: 6, t: 8, b: 22 };
  const profile = skyline?.profile ?? null;
  const maxEl = Math.max(30, ...series.sunEl, ...series.earthEl, ...(profile ?? [0]));
  const top = Math.ceil(maxEl / 10) * 10;
  const x = linear(0, 360, m.l, width - m.r);
  const y = linear(-10, top, height - m.b, m.t);
  const yc = (v) => y(Math.max(-10, Math.min(top, v)));
  const clipId = `pano-clip-${++uid}`;
  const plot = { x0: m.l, x1: width - m.r, y0: m.t, y1: height - m.b };

  const svg = s('svg', { class: 'pano', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', tabindex: '0', 'aria-label': ariaLabel(siteName, cursor) });
  svg.append(s('defs', null, s('clipPath', { id: clipId }, s('rect', { x: plot.x0, y: plot.y0, width: plot.x1 - plot.x0, height: plot.y1 - plot.y0 }))));
  svg.append(s('rect', { class: 'pano-sky', x: plot.x0, y: plot.y0, width: plot.x1 - plot.x0, height: plot.y1 - plot.y0 }));

  for (const t of niceTicks(-10, top, 5).filter((v) => v >= -10 && v <= top)) {
    if (t !== 0) svg.append(s('line', { class: 'grid', x1: plot.x0, x2: plot.x1, y1: y(t), y2: y(t) }));
    svg.append(s('text', { class: 'tick', x: plot.x0 - 6, y: y(t) + 4, 'text-anchor': 'end' }, degLabel(t)));
  }
  for (const [az, label] of AZ_LABELS) {
    const anchor = az === 0 ? 'start' : az === 360 ? 'end' : 'middle';
    svg.append(s('text', { class: 'tick', x: x(az), y: height - 6, 'text-anchor': anchor }, label));
  }

  // The ground: the terrain skyline in every azimuth (spec phase 2 §5), or a flat horizon off the terrain map.
  const groundPts = [];
  if (profile) {
    for (let i = 0; i <= profile.length; i++) {
      const az = (i * 360) / profile.length;
      groundPts.push(`${x(az).toFixed(1)},${yc(profile[i % profile.length]).toFixed(1)}`);
    }
  } else {
    groundPts.push(`${plot.x0},${y(0).toFixed(1)}`, `${plot.x1},${y(0).toFixed(1)}`);
  }
  svg.append(
    s('polygon', { class: 'pano-ground', points: `${plot.x0},${plot.y1} ${groundPts.join(' ')} ${plot.x1},${plot.y1}`, 'clip-path': `url(#${clipId})` }),
    s('polyline', { class: 'horizon', points: groundPts.join(' '), 'clip-path': `url(#${clipId})` }));

  const trackLayer = s('g', { 'clip-path': `url(#${clipId})` });
  for (const body of ['sun', 'earth']) {
    for (const part of tracks(series[`${body}Az`], series[`${body}El`])) {
      if (part.length < 2) continue;
      const d = part.map((p, i) => `${i ? 'L' : 'M'}${x(p.az).toFixed(1)} ${y(p.el).toFixed(1)}`).join('');
      trackLayer.append(s('path', { class: `track track-${body}`, d }));
    }
  }
  svg.append(trackLayer);

  const markers = {};
  for (const body of ['earth', 'sun']) {
    const circle = s('circle', { class: `marker marker-${body}`, r: 6, cx: 0, cy: 0 });
    const label = s('text', { class: 'marker-label', x: 9, y: -7 }, NAMES[body]);
    const hit = s('circle', { class: 'marker-hit', r: 12, cx: 0, cy: 0 });
    const g = s('g', { class: 'marker-group' }, hit, circle, label);
    markers[body] = { g, circle, label };
    svg.append(g);
  }

  const tip = h('div', { class: 'tooltip', role: 'presentation', hidden: true });
  el.append(svg, tip);
  el._pano = { x, yc, top, markers, svg, tip, width, plot, siteName, cursor, skyline };

  const showTip = (lines, px, py) => {
    tip.textContent = '';
    for (const line of lines) tip.append(h('span', null, line));
    tip.hidden = false;
    const left = Math.min(Math.max(px, 70), width - 70);
    tip.style.left = `${left}px`;
    tip.style.top = `${py}px`;
  };
  const hideTip = () => { tip.hidden = true; };
  for (const body of ['sun', 'earth']) {
    const g = markers[body].g;
    g.addEventListener('pointerenter', () => {
      const st = el._pano;
      showTip([describe(body, st.cursor[body])], st.x(st.cursor[body].azDeg ?? 180), st.yc(st.cursor[body].elDeg) - 14);
    });
    g.addEventListener('pointerleave', hideTip);
  }
  svg.addEventListener('focus', () => {
    const st = el._pano;
    showTip([describe('sun', st.cursor.sun), describe('earth', st.cursor.earth)], width / 2, plot.y0 + 6);
  });
  svg.addEventListener('blur', hideTip);

  updatePanoramaCursor(el, cursor);
}

export function updatePanoramaCursor(el, cursor, { quiet = false } = {}) {
  const st = el._pano;
  if (!st) return;
  st.cursor = cursor;
  const placed = {};
  for (const body of ['sun', 'earth']) {
    const pos = cursor[body];
    const mk = st.markers[body];
    if (pos.azDeg === null) { mk.g.setAttribute('visibility', 'hidden'); continue; }
    mk.g.removeAttribute('visibility');
    const px = st.x(pos.azDeg);
    const py = st.yc(pos.elDeg);
    mk.g.setAttribute('transform', `translate(${px.toFixed(1)} ${py.toFixed(1)})`);
    // hollow when the body is behind the terrain skyline in its direction
    mk.circle.classList.toggle('is-below', pos.elDeg <= (st.skyline ? st.skyline(pos.azDeg) : 0));
    const flip = px > st.plot.x1 - 52;
    mk.label.setAttribute('text-anchor', flip ? 'end' : 'start');
    mk.label.setAttribute('x', flip ? -9 : 9);
    placed[body] = { px, py, flip };
  }
  // Keep the two labels apart when the markers sit close together.
  const a = placed.sun, b = placed.earth;
  // Labels sit above and to the side of their marker; a marker near the plot top puts its label below.
  for (const body of ['sun', 'earth']) {
    const p = placed[body];
    if (p) st.markers[body].label.setAttribute('y', p.py - st.plot.y0 < 16 ? 16 : -7);
  }
  if (a && b && Math.abs(a.px - b.px) < 60 && Math.abs(a.py - b.py) < 18) {
    // Close together: the lower marker's label goes below it, the upper one's above.
    const lower = a.py >= b.py ? 'sun' : 'earth';
    const upper = lower === 'sun' ? 'earth' : 'sun';
    st.markers[lower].label.setAttribute('y', 16);
    st.markers[upper].label.setAttribute('y', -7);
  }
  if (!quiet) st.svg.setAttribute('aria-label', ariaLabel(st.siteName, cursor));
  if (!st.tip.hidden && document.activeElement === st.svg) {
    st.tip.textContent = '';
    for (const line of [describe('sun', cursor.sun), describe('earth', cursor.earth)]) st.tip.append(h('span', null, line));
  }
}
