// Route profile card (phase 3 §4.8): elevation along the route, a sunlit band under it, the stretches
// that fail the filters, and a summary. Hovering or arrowing along the profile reports the point so
// the map can mark it.
//
// createRouteCard(el, { onHover(index | null, point | null) }) → { update(params | null) }
// params: null hides the content, or {
//   progress: number,                  0–1; below 1 shows a progress line and no chart
//   points: [{ dKm, xKm, yKm, heightM, slopeDeg, sun, pass }],   region.js routeProfile().points
//   lengthKm, climbM, maxSlopeDeg, meanSun,                       routeProfile() summary
//   planned?: { label, maxSlopeDeg, baselineKm }   phase 4: the route came from the Route plan card
// }
// sun is a share of the stay 0–1 (or NaN while unknown); pass is false for a point that fails the filters.
import { h, s, clear } from './dom.js';
import { fmtHeight } from './hovercard.js';
import { fmtDeg, fmtPct, DASH } from '../format.js';

const kmFmt = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const intFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
const LEFT = 88, RIGHT = 8, TOP = 8, PLOT_H = 120, BAND_H = 10, BAND_GAP = 8, AXIS_H = 22;

export function createRouteCard(el, callbacks = {}) {
  el.classList.add('route-card');
  const body = h('div', { class: 'route-body' });
  el.append(h('div', { class: 'card-head card-head-stack' }, h('h2', null, 'Route profile'),
    h('p', { class: 'card-sub' }, 'Height, sunlight and filters along the route, sampled every 0.5 km')), body);

  let last = null, cursor = null, width = 0;
  let parts = null;   // { svg, cursorG, tip, x(dKm) }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (last && el.clientWidth !== width) render(); }) : null;
  ro?.observe(el);

  function summary(p) {
    const item = (label, value) => h('div', { class: 'route-stat' }, h('dt', null, label), h('dd', { class: 'num' }, value));
    return h('dl', { class: 'route-summary' },
      item('Length', ok(p.lengthKm) ? `${kmFmt.format(p.lengthKm)} km` : DASH),
      item('Total climb', ok(p.climbM) ? `${intFmt.format(p.climbM)} m` : DASH),
      item('Max slope', fmtDeg(p.maxSlopeDeg)),
      item('Mean sunlit', ok(p.meanSun) ? fmtPct(p.meanSun) : DASH));
  }

  // phase 4: the two slope figures have different baselines, so say which is which
  function plannedNote(p) {
    if (!p.planned) return null;
    const m = Math.round(p.planned.baselineKm * 1000);
    return h('p', { class: 'route-planned-note' },
      `${p.planned.label} route from Route plan: max slope ${fmtDeg(p.planned.maxSlopeDeg)} on the ${m} m grid. Max slope above is the mean slope of the map cells along it, so the two can differ.`);
  }

  function setCursor(i, notify = true) {
    if (!parts) return;
    const pts = last.points;
    cursor = i === null ? null : Math.max(0, Math.min(pts.length - 1, i));
    const { cursorG, tip, x, y } = parts;
    if (cursor === null) {
      cursorG.setAttribute('hidden', '');
      tip.hidden = true;
      if (notify) callbacks.onHover?.(null, null);
      return;
    }
    const pt = pts[cursor];
    const cx = x(pt.dKm);
    cursorG.removeAttribute('hidden');
    cursorG.querySelector('line').setAttribute('x1', cx.toFixed(1));
    cursorG.querySelector('line').setAttribute('x2', cx.toFixed(1));
    const dot = cursorG.querySelector('circle');
    if (ok(pt.heightM)) { dot.removeAttribute('hidden'); dot.setAttribute('cx', cx.toFixed(1)); dot.setAttribute('cy', y(pt.heightM).toFixed(1)); } else dot.setAttribute('hidden', '');
    const lines = [`${kmFmt.format(pt.dKm)} km, ${fmtHeight(pt.heightM)}`, `Slope ${fmtDeg(pt.slopeDeg)}, sunlit ${ok(pt.sun) ? fmtPct(pt.sun) : DASH}`];
    if (pt.pass === false) lines.push('Fails the filters');
    clear(tip);
    tip.append(...lines.map((t) => h('span', null, t)));
    tip.hidden = false;
    tip.style.left = `${Math.max(60, Math.min(width - 60, cx))}px`;
    tip.style.top = `${TOP}px`;
    parts.svg.setAttribute('aria-valuetext', lines.join('. '));
    parts.svg.setAttribute('aria-valuenow', String(cursor));
    if (notify) callbacks.onHover?.(cursor, pt);
  }

  function chart(p) {
    const pts = p.points;
    width = Math.max(280, el.clientWidth || 720);
    const W = width, plotW = W - LEFT - RIGHT;
    const H = TOP + PLOT_H + BAND_GAP + BAND_H + BAND_GAP + BAND_H + AXIS_H;
    const L = pts.length ? pts[pts.length - 1].dKm || 1 : 1;
    const hs = pts.map((q) => q.heightM).filter(ok);
    let lo = hs.length ? Math.min(...hs) : 0, hi = hs.length ? Math.max(...hs) : 1;
    if (hi - lo < 20) { lo -= 10; hi += 10; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const x = (d) => LEFT + (d / L) * plotW;
    const y = (m) => TOP + (1 - (m - lo) / (hi - lo)) * PLOT_H;
    const bandSun = TOP + PLOT_H + BAND_GAP, bandPass = bandSun + BAND_H + BAND_GAP;
    // each sample owns the span between the midpoints to its neighbours
    const span = (n) => [n === 0 ? 0 : (pts[n - 1].dKm + pts[n].dKm) / 2, n === pts.length - 1 ? L : (pts[n].dKm + pts[n + 1].dKm) / 2];
    const runs = (valueOf) => {
      const out = [];
      pts.forEach((q, n) => {
        const v = valueOf(q);
        const [a, b] = span(n);
        const prev = out[out.length - 1];
        if (prev && prev.v === v) prev.b = b; else out.push({ v, a, b });
      });
      return out;
    };
    const failRuns = runs((q) => q.pass === false).filter((r) => r.v);
    const sunRuns = runs((q) => (ok(q.sun) ? Math.round(q.sun * 10) / 10 : null));

    const svg = s('svg', {
      class: 'route-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, tabindex: '0', role: 'slider',
      'aria-label': 'Route profile. Left and right arrows move along the route.',
      'aria-valuemin': '0', 'aria-valuemax': String(pts.length - 1), 'aria-valuenow': '0',
    });
    const fails = s('g', { class: 'route-fails', 'aria-hidden': 'true' }, failRuns.map((r) => s('rect', { x: x(r.a).toFixed(1), y: TOP, width: Math.max(1, x(r.b) - x(r.a)).toFixed(1), height: PLOT_H })));
    const ticks = s('g', { 'aria-hidden': 'true' },
      s('line', { class: 'grid', x1: LEFT, x2: W - RIGHT, y1: TOP + PLOT_H, y2: TOP + PLOT_H }),
      s('text', { class: 'tick', x: LEFT - 8, y: y(hi - pad) + 4, 'text-anchor': 'end' }, fmtHeight(hi - pad)),
      s('text', { class: 'tick', x: LEFT - 8, y: y(lo + pad) + 4, 'text-anchor': 'end' }, fmtHeight(lo + pad)));
    let d = '';
    pts.forEach((q, n) => { if (ok(q.heightM)) d += `${d && ok(pts[n - 1]?.heightM) ? 'L' : 'M'}${x(q.dKm).toFixed(1)} ${y(q.heightM).toFixed(1)}`; });
    const line = s('path', { class: 'route-elev', d, 'aria-hidden': 'true' });
    const bands = s('g', { 'aria-hidden': 'true' },
      s('text', { class: 'tick', x: LEFT - 8, y: bandSun + 9, 'text-anchor': 'end' }, 'Sunlit'),
      s('rect', { class: 'route-band-track', x: LEFT, y: bandSun, width: plotW, height: BAND_H }),
      sunRuns.filter((r) => r.v !== null && r.v > 0).map((r) => s('rect', { class: 'route-band-sun', x: x(r.a).toFixed(1), y: bandSun, width: Math.max(0.5, x(r.b) - x(r.a)).toFixed(1), height: BAND_H, 'fill-opacity': r.v })),
      s('text', { class: 'tick', x: LEFT - 8, y: bandPass + 9, 'text-anchor': 'end' }, 'Fails filters'),
      s('rect', { class: 'route-band-track', x: LEFT, y: bandPass, width: plotW, height: BAND_H }),
      failRuns.map((r) => s('rect', { class: 'route-band-fail', x: x(r.a).toFixed(1), y: bandPass, width: Math.max(1, x(r.b) - x(r.a)).toFixed(1), height: BAND_H })));
    const axisY = bandPass + BAND_H + 16;
    const axis = s('g', { 'aria-hidden': 'true' },
      s('text', { class: 'tick', x: LEFT, y: axisY }, '0 km'),
      s('text', { class: 'tick', x: W - RIGHT, y: axisY, 'text-anchor': 'end' }, `${kmFmt.format(L)} km`));
    const cursorG = s('g', { class: 'cursor', hidden: true, 'aria-hidden': 'true' },
      s('line', { x1: 0, x2: 0, y1: TOP, y2: bandPass + BAND_H }), s('circle', { r: 3.5 }));
    const hit = s('rect', { class: 'scrub-area', x: LEFT, y: 0, width: plotW, height: H });
    svg.append(fails, ticks, line, bands, axis, cursorG, hit);

    const tip = h('div', { class: 'tooltip route-tip', hidden: true });
    const nearest = (clientX) => {
      const box = svg.getBoundingClientRect();
      const dk = ((clientX - box.left - LEFT) / plotW) * L;
      let best = 0;
      for (let n = 1; n < pts.length; n++) if (Math.abs(pts[n].dKm - dk) < Math.abs(pts[best].dKm - dk)) best = n;
      return best;
    };
    hit.addEventListener('pointermove', (e) => { setCursor(nearest(e.clientX)); svg.setAttribute('aria-valuenow', String(cursor)); });
    hit.addEventListener('pointerleave', () => { if (document.activeElement !== svg) setCursor(null); });
    svg.addEventListener('focus', () => setCursor(cursor ?? 0));
    svg.addEventListener('blur', () => setCursor(null));
    svg.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 1;
      const to = { ArrowLeft: (cursor ?? 0) - step, ArrowRight: (cursor ?? 0) + step, Home: 0, End: pts.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      setCursor(to);
      svg.setAttribute('aria-valuenow', String(cursor));
    });
    parts = { svg, cursorG, tip, x, y };
    return h('div', { class: 'chart route-chart' }, svg, tip);
  }

  function render() {
    const hadFocus = body.contains(document.activeElement);
    clear(body);
    parts = null;
    const p = last;
    if (!p) return;
    if ((p.progress ?? 1) < 1 || !p.points?.length) {
      const pr = Math.max(0, Math.min(1, p.progress ?? 0));
      body.append(h('p', { class: 'region-progress', role: 'status' },
        h('span', { class: 'region-progress-bar', 'aria-hidden': 'true' }, h('span', { style: `transform:scaleX(${pr.toFixed(3)})` })),
        h('span', { class: 'num' }, `Computing… ${Math.round(pr * 100)}%`)));
      return;
    }
    const keep = cursor;
    body.append(...[summary(p), plannedNote(p), chart(p)].filter(Boolean));
    if (hadFocus) parts.svg.focus({ preventScroll: true });
    if (keep !== null && keep < p.points.length) setCursor(keep, false);
  }

  function update(p) {
    const changed = p !== last;
    last = p;
    if (!p) { if (cursor !== null) callbacks.onHover?.(null, null); cursor = null; }
    if (changed) render();
  }

  return { update };
}
