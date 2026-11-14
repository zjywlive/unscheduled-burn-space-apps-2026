// The rover's live panels on the left of the 3D globe in route mode: its attitude (pitch, roll, yaw as tilting
// drawings against its limits) and a round minimap of the area around it (shaded terrain, the route, havens, the
// lander, the rover arrow, north). DOM and canvas only; the numbers come from rover-attitude.js.
import { attitudeAt, compassName, limitLevel } from './rover-attitude.js';
import { toXY, fromXY } from './terrain.js';
import { FLAGS } from './route3d.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) e.setAttribute(k, v); e.append(...kids); return e; };
const sv = (tag, attrs = {}, ...kids) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); e.append(...kids); return e; };
const LEVEL_COLOUR = { ok: '#7ee08a', near: '#ffd23d', over: '#ff5252' };
const f1 = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}°`;

// ---------- attitude ----------
export function createAttitudePanel(parent) {
  // a side view (pitch), a rear view (roll) and a compass (yaw), each 96 × 72
  const gauge = (title) => {
    const ground = sv('line', { x1: -60, y1: 14, x2: 60, y2: 14, class: 'att-ground' });
    const body = sv('g', { class: 'att-body' });
    const tilt = sv('g', {}, ground, body);
    const svg = sv('svg', { viewBox: '-48 -36 96 72', class: 'att-svg', role: 'img' }, sv('line', { x1: -46, y1: 14, x2: 46, y2: 14, class: 'att-level' }), tilt);
    const val = el('div', { class: 'att-val' }), sub = el('div', { class: 'att-sub' });
    const box = el('div', { class: 'att-gauge' }, el('div', { class: 'att-title' }, title), svg, val, sub);
    return { box, svg, tilt, body, val, sub };
  };
  const pitch = gauge('Pitch'), roll = gauge('Roll');
  // side view: body, mast, two wheels; travel to the right
  pitch.body.append(sv('rect', { x: -20, y: -6, width: 40, height: 12, rx: 3 }), sv('rect', { x: 8, y: -16, width: 3, height: 10 }), sv('circle', { cx: -13, cy: 8, r: 5 }), sv('circle', { cx: 13, cy: 8, r: 5 }), sv('path', { d: 'M24 -2l6 2-6 2z', class: 'att-dir' }));
  // rear view: body, mast, two wheels
  roll.body.append(sv('rect', { x: -16, y: -8, width: 32, height: 14, rx: 3 }), sv('rect', { x: -1.5, y: -18, width: 3, height: 10 }), sv('rect', { x: -21, y: 2, width: 7, height: 11, rx: 2 }), sv('rect', { x: 14, y: 2, width: 7, height: 11, rx: 2 }));
  // compass
  const needle = sv('path', { d: 'M0 -26L6 6L0 1L-6 6Z', class: 'att-needle' });
  const ring = sv('g', {}, sv('circle', { r: 30, class: 'att-ring' }), ...['N', 'E', 'S', 'W'].map((c, i) => sv('text', { x: [0, 24, 0, -24][i], y: [-21, 4, 28, 4][i], 'text-anchor': 'middle', class: c === 'N' ? 'att-n' : 'att-c' }, c)));
  const yawSvg = sv('svg', { viewBox: '-36 -36 72 72', class: 'att-svg', role: 'img' }, ring, needle);
  const yawVal = el('div', { class: 'att-val' }), yawSub = el('div', { class: 'att-sub' });
  const yaw = el('div', { class: 'att-gauge' }, el('div', { class: 'att-title' }, 'Yaw'), yawSvg, yawVal, yawSub);
  const note = el('div', { class: 'att-note' });
  const box = el('section', { class: 'glass att-panel', 'aria-label': 'Rover attitude' }, el('div', { class: 'att-head' }, el('span', {}, 'Rover attitude'), el('span', { class: 'att-state' })), el('div', { class: 'att-row' }, pitch.box, roll.box, yaw), note);
  parent.append(box);
  const state = box.querySelector('.att-state');

  return {
    update({ att, limits = null, baselineM = null, stateText = '' }) {
      state.textContent = stateText;
      if (!att) { pitch.val.textContent = roll.val.textContent = yawVal.textContent = '—'; note.textContent = 'No terrain under the rover yet.'; return; }
      const climbLim = att.pitchDeg >= 0 ? limits?.climbDeg : limits?.descentDeg;
      const lp = limitLevel(att.pitchDeg, climbLim), lr = limitLevel(att.rollDeg, limits?.crossDeg);
      pitch.tilt.setAttribute('transform', `rotate(${(-att.pitchDeg).toFixed(2)})`);
      roll.tilt.setAttribute('transform', `rotate(${(-att.rollDeg).toFixed(2)})`);
      pitch.box.dataset.level = lp; roll.box.dataset.level = lr;
      pitch.val.textContent = f1(att.pitchDeg); pitch.val.style.color = LEVEL_COLOUR[lp];
      roll.val.textContent = f1(att.rollDeg); roll.val.style.color = LEVEL_COLOUR[lr];
      pitch.sub.textContent = `${Math.abs(att.pitchDeg) < 0.5 ? 'level' : att.pitchDeg > 0 ? 'nose up' : 'nose down'}${climbLim ? ` · limit ${climbLim}°` : ''}`;
      roll.sub.textContent = `${Math.abs(att.rollDeg) < 0.5 ? 'level' : att.rollDeg > 0 ? 'right side up' : 'left side up'}${limits?.crossDeg ? ` · limit ${limits.crossDeg}°` : ''}`;
      needle.setAttribute('transform', `rotate(${att.yawDeg.toFixed(1)})`);
      yawVal.textContent = `${Math.round(att.yawDeg)}°`;
      yawSub.textContent = compassName(att.yawDeg);
      note.textContent = `Ground slope ${att.slopeDeg.toFixed(1)}°, downhill to ${compassName(att.downhillDeg)}${baselineM ? `; measured over ${Math.round(baselineM)} m of LOLA terrain` : ''}.`;
    },
  };
}

// ---------- minimap ----------
const RADII = [0.5, 1, 2, 5, 10, 25];
export function createMinimap(parent, payload, heightAt, { landed = null } = {}) {
  const size = 200, dpr = Math.min(2, window.devicePixelRatio || 1);
  const cv = el('canvas', { width: size * dpr, height: size * dpr, class: 'mm-canvas', 'aria-label': 'Minimap around the rover' });
  cv.style.width = `${size}px`; cv.style.height = `${size}px`;
  const scale = el('div', { class: 'mm-scale' });
  const plus = el('button', { type: 'button', class: 'mm-btn', 'aria-label': 'Zoom the minimap in' }, '+');
  const minus = el('button', { type: 'button', class: 'mm-btn', 'aria-label': 'Zoom the minimap out' }, '−');
  const box = el('section', { class: 'glass mm-panel', 'aria-label': 'Minimap' }, el('div', { class: 'mm-wrap' }, cv, el('div', { class: 'mm-btns' }, plus, minus)), scale);
  parent.append(box);
  const ctx = cv.getContext('2d');
  let ri = 2, last = null, relief = null;
  plus.addEventListener('click', () => { ri = Math.max(0, ri - 1); relief = null; if (last) draw(last); });
  minus.addEventListener('click', () => { ri = Math.min(RADII.length - 1, ri + 1); relief = null; if (last) draw(last); });
  const routeXY = payload.pts.map((q) => toXY(q[0], q[1]));
  const havensXY = (payload.havens ?? []).map((h) => toXY(h.latDeg, h.lonDeg));
  const landedXY = landed ? toXY(landed.latDeg, landed.lonDeg) : null;

  // shaded relief of the square around (cx, cy), 72 × 72 samples, recomputed when the rover has moved a fifth of the radius
  function reliefFor(cx, cy, R) {
    if (relief && relief.R === R && Math.hypot(relief.cx - cx, relief.cy - cy) < R / 5) return relief;
    const n = 72, img = ctx.createImageData(n, n), hs = new Float32Array(n * n), step = (2 * R) / n;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const { latDeg, lonDeg } = fromXY(cx - R + (i + 0.5) * step, cy + R - (j + 0.5) * step);
      const v = heightAt(latDeg, lonDeg); hs[j * n + i] = Number.isFinite(v) ? v : NaN;
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i, l = hs[j * n + Math.max(0, i - 1)], r = hs[j * n + Math.min(n - 1, i + 1)], u = hs[Math.max(0, j - 1) * n + i], d = hs[Math.min(n - 1, j + 1) * n + i];
      const gx = (r - l) / (2 * step * 1000), gy = (u - d) / (2 * step * 1000);
      // light from the north-west, 35° up
      const shade = Number.isFinite(gx + gy) ? Math.max(0, Math.min(1, 0.55 + (-gx * 0.6 + gy * 0.6) * 1.6)) : 0;
      const g = Math.round(40 + shade * 150);
      img.data.set([g, g, g * 0.97, 255], k * 4);
    }
    const off = document.createElement('canvas'); off.width = n; off.height = n; off.getContext('2d').putImageData(img, 0, 0);
    relief = { cx, cy, R, off };
    return relief;
  }

  function draw({ latDeg, lonDeg, headingDeg, headingUp, colourOf }) {
    last = { latDeg, lonDeg, headingDeg, headingUp, colourOf };
    const R = RADII[ri], [cx, cy] = toXY(latDeg, lonDeg), W = size * dpr, half = W / 2, px = half / R;
    // polar stereographic about the south pole: north (rising latitude) points away from the pole, along (cx, cy);
    // on screen (y down) that is (cx, −cy), at this angle clockwise from up
    const northAng = Math.atan2(cx, cy);
    const rot = headingUp ? -(headingDeg * Math.PI / 180) - northAng : -northAng;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.beginPath(); ctx.arc(half, half, half - 2 * dpr, 0, Math.PI * 2); ctx.clip();
    ctx.translate(half, half); ctx.rotate(rot);
    const rf = reliefFor(cx, cy, R);
    const ox = (rf.cx - cx) * px, oy = -(rf.cy - cy) * px;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(rf.off, ox - R * px * 1, oy - R * px * 1, 2 * R * px, 2 * R * px);
    const P = ([x, y]) => [(x - cx) * px, -(y - cy) * px];
    // route, coloured like the 3D ribbon
    ctx.lineWidth = 3 * dpr; ctx.lineCap = 'round';
    for (let k = 1; k < routeXY.length; k++) {
      const [ax, ay] = P(routeXY[k - 1]), [bx, by] = P(routeXY[k]);
      if (Math.hypot(ax, ay) > 1.6 * half && Math.hypot(bx, by) > 1.6 * half) continue;
      ctx.strokeStyle = colourOf(payload.pts[k]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
    ctx.fillStyle = '#7ee08a';
    for (const h of havensXY) { const [x, y] = P(h); ctx.beginPath(); ctx.arc(x, y, 3 * dpr, 0, Math.PI * 2); ctx.fill(); }
    if (landedXY) { const [x, y] = P(landedXY); ctx.fillStyle = '#ffd23d'; ctx.fillRect(x - 4 * dpr, y - 4 * dpr, 8 * dpr, 8 * dpr); }
    // the rover: an arrow along its heading, at the centre
    ctx.rotate(northAng + headingDeg * Math.PI / 180);
    ctx.fillStyle = '#ffd23d'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(0, -11 * dpr); ctx.lineTo(7 * dpr, 8 * dpr); ctx.lineTo(0, 4 * dpr); ctx.lineTo(-7 * dpr, 8 * dpr); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    // rim and north marker
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = 4 * dpr; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.beginPath(); ctx.arc(half, half, half - 2 * dpr, 0, Math.PI * 2); ctx.stroke();
    const na = rot + northAng - Math.PI / 2, nr = half - 13 * dpr;
    const nx = half + Math.cos(na) * nr, ny = half + Math.sin(na) * nr;
    ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(nx, ny, 10 * dpr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `700 ${12 * dpr}px Inter, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + 0.5 * dpr);
    scale.textContent = `${R < 1 ? `${R * 1000} m` : `${R} km`} to the rim${headingUp ? ' · heading up' : ' · north up'}`;
  }
  return { draw };
}
