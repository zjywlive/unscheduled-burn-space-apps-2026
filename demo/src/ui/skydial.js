// The sky dial on the map (phase 5, S): an SVG ring centred on the selected point. Azimuth runs round it
// in the map's true directions, the radius is elevation (−10° inner edge, rings at 0° and 10°, +18° outer
// edge), the terrain skyline is a band, the Sun's track is solid over the stay and faint beyond, the
// Earth's track is its libration loop, a dashed ray points from the site to the Sun, and a body behind the
// terrain is drawn hollow. Fixed screen size; the root ignores the pointer, only the two body dots take a
// hover. The caller feeds the data (see docs/phase5/handoff/S.md) and places it with moveTo().
import { s, h } from './dom.js';
import { DIAL, dialPoint, polarPoint, radiusForEl, skylinePath, skyStatus, trackSegments, dialPath, describeBody } from '../skydial.js';

const NAMES = { sun: 'Sun', earth: 'Earth' };
const LETTERS = [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']];
const RING_LABEL_SCREEN_DEG = 248;   // where the 0° and 10° labels sit on screen, lower left

const fx = (v) => v.toFixed(1);
const circlePath = (r) => `M${fx(r)} 0A${r} ${r} 0 1 0 ${fx(-r)} 0A${r} ${r} 0 1 0 ${fx(r)} 0Z`;

function sameRange(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1];
}

export function createSkyDial({ geom = DIAL, showCenter = true } = {}) {
  const half = geom.size / 2;
  const svg = s('svg', {
    class: 'skydial-svg', width: geom.size, height: geom.size,
    viewBox: `${-half} ${-half} ${geom.size} ${geom.size}`, 'aria-hidden': 'true', focusable: 'false',
  });
  const backing = s('path', { class: 'skydial-backing', d: circlePath(geom.rMax) + circlePath(geom.rMin), 'fill-rule': 'evenodd' });
  const band = s('path', { class: 'skydial-ground', 'fill-rule': 'evenodd' });
  const skyEdge = s('path', { class: 'skydial-skyline' });
  const rings = s('g', { class: 'skydial-rings' },
    s('circle', { class: 'skydial-ring skydial-ring-edge', r: geom.rMin }),
    s('circle', { class: 'skydial-ring skydial-ring-edge', r: geom.rMax }),
    ...geom.rings.map((el) => s('circle', { class: `skydial-ring${el === 0 ? ' skydial-ring-zero' : ''}`, r: fx(radiusForEl(el, geom)) })));
  const ringLabels = s('g', { class: 'skydial-ringlabels' },
    ...geom.rings.map((el) => {
      const [x, y] = polarPoint(RING_LABEL_SCREEN_DEG, radiusForEl(el, geom));
      return s('text', { class: 'skydial-text skydial-ringlabel', x: fx(x), y: fx(y + 4), 'text-anchor': 'middle' }, `${el}°`);
    }));
  const ticks = s('path', { class: 'skydial-ticks' });
  const letters = s('g', { class: 'skydial-letters' });
  const letterEls = LETTERS.map(([az, t]) => {
    const el = s('text', { class: `skydial-text skydial-letter${az === 0 ? ' skydial-north' : ''}`, 'text-anchor': 'middle' }, t);
    letters.append(el);
    return [az, el];
  });
  const tracks = { sun: s('g', { class: 'skydial-track skydial-track-sun' }), earth: s('g', { class: 'skydial-track skydial-track-earth' }) };
  const ray = s('line', { class: 'skydial-ray', x1: 0, y1: 0, x2: 0, y2: 0 });
  const center = showCenter ? s('circle', { class: 'skydial-center', r: 3.5 }) : null;

  const tip = h('div', { class: 'skydial-tip', role: 'presentation', hidden: true });
  const bodies = {};
  for (const body of ['earth', 'sun']) {
    const dot = s('circle', { class: `skydial-dot skydial-dot-${body}`, r: 6 });
    const label = s('text', { class: 'skydial-text skydial-dotlabel' }, NAMES[body]);
    const hit = s('circle', { class: 'skydial-hit', r: 13 });
    const g = s('g', { class: `skydial-body skydial-body-${body}` }, hit, dot, label);
    hit.addEventListener('pointerenter', () => showTip(body));
    hit.addEventListener('pointerleave', hideTip);
    bodies[body] = { g, dot, label, hit, x: 0, y: 0 };
  }

  svg.append(backing, band, skyEdge, rings, ticks, ringLabels, letters, tracks.sun, tracks.earth, ray, ...(center ? [center] : []), bodies.earth.g, bodies.sun.g);
  const el = h('div', { class: 'skydial', role: 'img', 'aria-label': 'Sky dial' }, svg, tip);
  el.style.setProperty('--skydial-size', `${geom.size}px`);

  let last = { skyline: undefined, sunTrack: undefined, earthTrack: undefined, stayRange: undefined, northDeg: undefined };
  let current = { now: null, skyline: null };
  let tipBody = null;

  function drawStatic({ skyline, sunTrack, earthTrack, stayRange, northDeg }) {
    const north = Number.isFinite(northDeg) ? northDeg : 0;
    const sky = skylinePath(skyline ?? null, north, geom);
    band.setAttribute('d', sky.band);
    skyEdge.setAttribute('d', sky.edge);
    let td = '';
    for (let az = 0; az < 360; az += 30) {
      const sd = north + az;
      const [x0, y0] = polarPoint(sd, geom.rMax);
      const [x1, y1] = polarPoint(sd, geom.rMax - (az % 90 ? 4 : 8));
      td += `M${fx(x0)} ${fx(y0)}L${fx(x1)} ${fx(y1)}`;
    }
    ticks.setAttribute('d', td);
    for (const [az, t] of letterEls) {
      const [x, y] = polarPoint(north + az, geom.rLabel);
      t.setAttribute('x', fx(x));
      t.setAttribute('y', fx(y + 4));
    }
    for (const [body, track] of [['sun', sunTrack], ['earth', earthTrack]]) {
      const g = tracks[body];
      while (g.firstChild) g.removeChild(g.firstChild);
      for (const seg of trackSegments(track, { stayRange: stayRange ?? null })) {
        g.append(s('path', { class: seg.inStay ? 'skydial-stay' : 'skydial-beyond', d: dialPath(seg.points, north, geom) }));
      }
    }
  }

  function placeBodies(now, skyline, northDeg) {
    const north = Number.isFinite(northDeg) ? northDeg : 0;
    const placed = {};
    for (const body of ['sun', 'earth']) {
      const b = bodies[body];
      const pos = now?.[body];
      if (!pos || pos.azDeg === null || pos.azDeg === undefined || !Number.isFinite(pos.elDeg)) {
        b.g.setAttribute('visibility', 'hidden');
        if (body === 'sun') ray.setAttribute('visibility', 'hidden');
        continue;
      }
      b.g.removeAttribute('visibility');
      const [x, y] = dialPoint(pos.azDeg, pos.elDeg, north, geom);
      b.x = x; b.y = y;
      b.g.setAttribute('transform', `translate(${fx(x)} ${fx(y)})`);
      const st = skyStatus(pos, skyline);
      b.dot.classList.toggle('is-hidden', !st.above);
      b.g.classList.toggle('is-hidden', !st.above);
      placed[body] = { x, y };
      if (body === 'sun') {
        ray.removeAttribute('visibility');
        ray.setAttribute('x2', fx(x));
        ray.setAttribute('y2', fx(y));
        ray.classList.toggle('is-hidden', !st.above);
      }
    }
    // labels outward from the centre; two dots close together push their labels apart round the ring
    for (const body of ['sun', 'earth']) {
      const p = placed[body];
      if (!p) continue;
      const r = Math.hypot(p.x, p.y) || 1;
      let ux = p.x / r, uy = p.y / r;
      const other = placed[body === 'sun' ? 'earth' : 'sun'];
      let tx = 0, ty = 0;
      if (other && Math.hypot(p.x - other.x, p.y - other.y) < 26) {
        const side = ((p.x - other.x) * -uy + (p.y - other.y) * ux) >= 0 ? 1 : -1;
        tx = -uy * side * 10; ty = ux * side * 10;
      }
      const lx = ux * 12 + tx, ly = uy * 12 + ty;
      const lab = bodies[body].label;
      lab.setAttribute('x', fx(lx));
      lab.setAttribute('y', fx(ly + 4 + uy * 2));
      lab.setAttribute('text-anchor', Math.abs(ux) < 0.35 ? 'middle' : ux > 0 ? 'start' : 'end');
    }
  }

  function summary(now, skyline) {
    const part = (body) => (now?.[body] ? `${NAMES[body]} ${describeBody(now[body], skyline)}.` : '');
    return `Sky dial. ${part('sun')} ${part('earth')}`.trim();
  }

  function showTip(body) {
    const pos = current.now?.[body];
    if (!pos) return;
    tipBody = body;
    const st = skyStatus(pos, current.skyline);
    tip.textContent = '';
    tip.append(
      h('b', null, `${NAMES[body]}${st.above ? '' : ', behind terrain'}`),
      h('span', null, describeBody(pos, current.skyline)),
      h('span', { class: 'skydial-src' }, 'JPL Horizons position, NASA LOLA skyline'));
    tip.hidden = false;
    // outside the ring, in the body's direction, so the readout never covers the dial
    const b = bodies[body];
    const r = Math.hypot(b.x, b.y) || 1;
    const ux = b.x / r, uy = b.y / r;
    const [x, y] = [ux * (geom.rLabel + 12), uy * (geom.rLabel + 12)];
    tip.style.left = `${fx(half + x)}px`;
    tip.style.top = `${fx(half + y)}px`;
    tip.style.transform = `translate(${ux > 0.38 ? '0' : ux < -0.38 ? '-100%' : '-50%'}, ${uy > 0.38 ? '0' : uy < -0.38 ? '-100%' : '-50%'})`;
  }
  function hideTip() { tip.hidden = true; tipBody = null; }

  // Everything except `now` and `dimmed` is redrawn only when it changes (same object = unchanged), so a
  // playing clock can call update() every frame.
  function update({ skyline = null, sunTrack = null, earthTrack = null, stayRange = null, now = null, northDeg = 0, dimmed = false } = {}) {
    if (skyline !== last.skyline || sunTrack !== last.sunTrack || earthTrack !== last.earthTrack
      || !sameRange(stayRange, last.stayRange) || northDeg !== last.northDeg) {
      drawStatic({ skyline, sunTrack, earthTrack, stayRange, northDeg });
      last = { skyline, sunTrack, earthTrack, stayRange: stayRange ? [stayRange[0], stayRange[1]] : null, northDeg };
    }
    current = { now, skyline };
    placeBodies(now, skyline, northDeg);
    el.classList.toggle('is-dimmed', !!dimmed);
    el.setAttribute('aria-label', summary(now, skyline));
    if (dimmed) hideTip();
    else if (tipBody) showTip(tipBody);
  }

  // Centre the dial on (x, y), in px of the positioned parent (the map frame).
  function moveTo(x, y) {
    el.style.transform = `translate(${fx(x - half)}px, ${fx(y - half)}px)`;
  }

  function setVisible(on) { el.hidden = !on; if (!on) hideTip(); }

  // phase 6 B: a story step points at one part of the dial ('sun-track', 'sun', 'earth-track', 'earth',
  // 'skyline'); CSS brings it forward and quietens the rest. null clears it.
  function setFocus(name) { if (name) el.dataset.focus = name; else delete el.dataset.focus; }

  return { el, update, moveTo, setVisible, setFocus, geom };
}
