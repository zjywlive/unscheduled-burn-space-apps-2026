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
// A round map centred on the rover: the terrain shaded and tinted by height with contour lines (sampled
// about 160 × 160 over the area, finer than the 3D view's tiles at this scale), the route (driven part solid,
// the rest faded; coloured like the ribbon or by slope), traps, havens, parking stops, numbered waypoints, the
// landing site (on the rim with its distance when it is off the map), the rover with its field of view, north
// and a scale bar below. The terrain image is redrawn when the rover has moved a quarter of the radius.
const RADII = [0.25, 0.5, 1, 2, 5, 10, 25];
const TINT = [[0, [46, 58, 82]], [0.3, [86, 98, 112]], [0.6, [150, 146, 136]], [1, [222, 205, 165]]];
function tintAt(t) {
  let i = 0; while (i < TINT.length - 2 && t > TINT[i + 1][0]) i++;
  const [t0, a] = TINT[i], [t1, b] = TINT[i + 1], f = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
const niceStep = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v))); return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= v); };
const kmText = (km) => (km >= 1 ? `${+km.toFixed(km >= 10 ? 0 : 1)} km` : `${Math.round(km * 1000)} m`);

export function createMinimap(parent, payload, heightAt, { landed = null, site = null, slopeColour = null } = {}) {
  const size = 240, dpr = Math.min(2, window.devicePixelRatio || 1);
  const cv = el('canvas', { width: size * dpr, height: size * dpr, class: 'mm-canvas', 'aria-label': 'Minimap around the rover' });
  cv.style.width = `${size}px`; cv.style.height = `${size}px`;
  const scale = el('div', { class: 'mm-scale' }), bar = el('span', { class: 'mm-bar' }), barText = el('span', {});
  const scaleRow = el('div', { class: 'mm-scalebar' }, bar, barText);
  const plus = el('button', { type: 'button', class: 'mm-btn', 'aria-label': 'Zoom the minimap in', title: 'Zoom in' }, '+');
  const minus = el('button', { type: 'button', class: 'mm-btn', 'aria-label': 'Zoom the minimap out', title: 'Zoom out' }, '−');
  const fit = el('button', { type: 'button', class: 'mm-btn mm-fit', 'aria-label': 'Fit the whole route', title: 'Fit the whole route' }, '⤢');
  const key = el('div', { class: 'mm-key' });
  const box = el('section', { class: 'glass mm-panel', 'aria-label': 'Minimap' }, el('div', { class: 'mm-wrap' }, cv, el('div', { class: 'mm-btns' }, plus, minus, fit)), scaleRow, scale, key);
  parent.append(box);
  const ctx = cv.getContext('2d');
  const routeXY = payload.pts.map((q) => toXY(q[0], q[1]));
  const havensXY = (payload.havens ?? []).map((h) => toXY(h.latDeg, h.lonDeg));
  const stopsXY = (payload.stops ?? []).map((h) => toXY(h.latDeg, h.lonDeg));
  const wpsXY = (payload.wps ?? []).map((w) => toXY(w.latDeg, w.lonDeg));
  const trapXY = (payload.traps?.cells ?? []).map(([la, lo]) => toXY(la, lo));
  const landing = landed ?? site;
  const landXY = landing ? toXY(landing.latDeg, landing.lonDeg) : null;
  const landLabel = landed ? 'Lander' : 'Landing site';
  key.innerHTML = `<span><i class="k-land"></i>${landLabel}</span>${wpsXY.length ? '<span><i class="k-wp">1</i>waypoint</span>' : ''}${havensXY.length ? '<span><i class="k-haven"></i>haven</span>' : ''}${trapXY.length ? '<span><i class="k-trap"></i>trap</span>' : ''}<span><i class="k-cont"></i><b class="mm-cint"></b></span>`;
  const cint = key.querySelector('.mm-cint');

  // the smallest radius that shows the whole route from its middle
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of routeXY) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  // start at most 5 km out: close enough to read the ground around the rover (zoom out for the whole route)
  const fitIndex = () => { const need = Math.min(5, 0.5 * Math.hypot(x1 - x0, y1 - y0) + 0.1); const i = RADII.findIndex((r) => r >= need); return i < 0 ? RADII.length - 1 : i; };
  let ri = fitIndex(), last = null, relief = null;
  const redraw = () => { relief = relief && relief.R === RADII[ri] ? relief : null; if (last) draw(last); };
  plus.addEventListener('click', () => { ri = Math.max(0, ri - 1); redraw(); });
  minus.addEventListener('click', () => { ri = Math.min(RADII.length - 1, ri + 1); redraw(); });
  fit.addEventListener('click', () => { ri = fitIndex(); redraw(); });

  // the terrain image of the square ±1.35 R around (cx, cy): shading × height tint, contour lines on top
  function reliefFor(cx, cy, R) {
    if (relief && relief.R === R && Math.hypot(relief.cx - cx, relief.cy - cy) < R * 0.25) return relief;
    const n = 160, H = 1.35 * R, step = (2 * H) / n, hs = new Float32Array(n * n);
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const { latDeg, lonDeg } = fromXY(cx - H + (i + 0.5) * step, cy + H - (j + 0.5) * step);
      const v = heightAt(latDeg, lonDeg), k = j * n + i;
      hs[k] = Number.isFinite(v) ? v : NaN;
      if (hs[k] < lo) lo = hs[k];
      if (hs[k] > hi) hi = hs[k];
    }
    const img = new ImageData(n, n), span = Math.max(1, hi - lo), m = step * 1000;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i, h = hs[k];
      const l = hs[j * n + Math.max(0, i - 1)], r = hs[j * n + Math.min(n - 1, i + 1)], u = hs[Math.max(0, j - 1) * n + i], d = hs[Math.min(n - 1, j + 1) * n + i];
      const gx = (r - l) / (2 * m), gy = (u - d) / (2 * m);   // rise per metre to the east of the image and to its top
      if (!Number.isFinite(gx + gy + h)) { img.data.set([18, 18, 20, 255], k * 4); continue; }
      // light from the image's upper left, 40° up, plus a little from above; steep ground darkens
      const len = Math.hypot(gx, gy, 1), nx = -gx / len, ny = -gy / len, nz = 1 / len;
      const lam = Math.max(0, nx * -0.54 + ny * 0.54 + nz * 0.64), sh = 0.25 + 0.95 * lam;
      const [tr, tg, tb] = tintAt((h - lo) / span);
      img.data.set([Math.min(255, tr * sh), Math.min(255, tg * sh), Math.min(255, tb * sh), 255], k * 4);
    }
    const small = document.createElement('canvas'); small.width = n; small.height = n; small.getContext('2d').putImageData(img, 0, 0);
    const M = 512, off = document.createElement('canvas'); off.width = M; off.height = M;
    const o = off.getContext('2d');
    o.imageSmoothingEnabled = true; o.imageSmoothingQuality = 'high';
    o.drawImage(small, 0, 0, M, M);
    // contours by marching squares on the sample grid, about a dozen lines over the local relief
    const ci = niceStep(span / 12), sc = M / n;
    const seg = (lev, major) => {
      o.beginPath();
      for (let j = 0; j + 1 < n; j++) for (let i = 0; i + 1 < n; i++) {
        const a = hs[j * n + i], b = hs[j * n + i + 1], c = hs[(j + 1) * n + i + 1], d = hs[(j + 1) * n + i];
        if (!Number.isFinite(a + b + c + d)) continue;
        const pts = [];
        const cross = (p, q, x0, y0, x1, y1) => { if ((p < lev) !== (q < lev)) { const t = (lev - p) / (q - p); pts.push([(x0 + (x1 - x0) * t + 0.5) * sc, (y0 + (y1 - y0) * t + 0.5) * sc]); } };
        cross(a, b, i, j, i + 1, j); cross(b, c, i + 1, j, i + 1, j + 1); cross(d, c, i, j + 1, i + 1, j + 1); cross(a, d, i, j, i, j + 1);
        for (let k = 0; k + 1 < pts.length; k += 2) { o.moveTo(pts[k][0], pts[k][1]); o.lineTo(pts[k + 1][0], pts[k + 1][1]); }
      }
      o.lineWidth = major ? 1.5 : 0.8; o.strokeStyle = major ? 'rgba(255,236,190,0.55)' : 'rgba(255,255,255,0.2)';
      o.stroke();
    };
    for (let lev = Math.ceil(lo / ci) * ci; lev <= hi; lev += ci) seg(lev, Math.round(lev / ci) % 5 === 0);
    relief = { cx, cy, R, H, off, ci };
    return relief;
  }

  function draw({ latDeg, lonDeg, headingDeg, headingUp, colourOf, km = null, colourBy = 'state' }) {
    last = { latDeg, lonDeg, headingDeg, headingUp, colourOf, km, colourBy };
    const R = RADII[ri], [cx, cy] = toXY(latDeg, lonDeg), W = size * dpr, half = W / 2, px = (half - 3 * dpr) / R;
    // polar stereographic about the south pole: north (rising latitude) points away from the pole, along (cx, cy);
    // on screen (y down) that is (cx, −cy), at this angle clockwise from up
    const northAng = Math.atan2(cx, cy);
    const rot = headingUp ? -(headingDeg * Math.PI / 180) - northAng : -northAng;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const P = ([x, y]) => [(x - cx) * px, -(y - cy) * px];
    const S = (q) => { const [x, y] = P(q); return [half + x * cr - y * sr, half + x * sr + y * cr]; };   // upright screen position
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.beginPath(); ctx.arc(half, half, half - 2 * dpr, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#121214'; ctx.fillRect(0, 0, W, W);
    ctx.translate(half, half); ctx.rotate(rot);
    const rf = reliefFor(cx, cy, R);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(rf.off, (rf.cx - cx) * px - rf.H * px, -(rf.cy - cy) * px - rf.H * px, 2 * rf.H * px, 2 * rf.H * px);
    // traps: translucent red cells
    if (trapXY.length) {
      const c = Math.max(1.5 * dpr, (payload.traps.cellKm ?? 0.24) * px);
      ctx.fillStyle = 'rgba(255,72,72,0.38)';
      for (const t of trapXY) { const [x, y] = P(t); if (Math.abs(x) < half * 1.5 && Math.abs(y) < half * 1.5) ctx.fillRect(x - c / 2, y - c / 2, c, c); }
    }
    // route: a dark casing, then the colour; the part already driven solid, the rest faded
    const colour = (k) => (colourBy === 'slope' && slopeColour ? slopeColour(payload.pts[k][6]) : colourOf(payload.pts[k]));
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const near = (a, b) => Math.hypot(a[0], a[1]) < 1.6 * half || Math.hypot(b[0], b[1]) < 1.6 * half;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineWidth = 6 * dpr;
    ctx.beginPath();
    for (let k = 1; k < routeXY.length; k++) { const a = P(routeXY[k - 1]), b = P(routeXY[k]); if (near(a, b)) { ctx.moveTo(...a); ctx.lineTo(...b); } }
    ctx.stroke();
    ctx.lineWidth = 3.4 * dpr;
    for (let k = 1; k < routeXY.length; k++) {
      const a = P(routeXY[k - 1]), b = P(routeXY[k]);
      if (!near(a, b)) continue;
      ctx.globalAlpha = km !== null && payload.pts[k][2] > km + 1e-6 ? 0.55 : 1;
      ctx.strokeStyle = colour(k);
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const dot = (q, r, fill, stroke = '#0b0b0c') => { const [x, y] = P(q); ctx.beginPath(); ctx.arc(x, y, r * dpr, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = stroke; ctx.stroke(); };
    for (const h of havensXY) dot(h, 4, '#7ee08a');
    for (const h of stopsXY) dot(h, 4, '#8ab4f8');
    // the rover's field of view (60°, a fifth of the radius) and the rover
    ctx.save();
    ctx.rotate(northAng + headingDeg * Math.PI / 180);
    const fov = Math.min(half * 0.45, Math.max(30 * dpr, 0.2 * R * px));
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, fov);
    g.addColorStop(0, 'rgba(255,210,61,0.35)'); g.addColorStop(1, 'rgba(255,210,61,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, fov, -Math.PI / 2 - Math.PI / 6, -Math.PI / 2 + Math.PI / 6); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffd23d'; ctx.strokeStyle = '#111'; ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(0, -13 * dpr); ctx.lineTo(8 * dpr, 9 * dpr); ctx.lineTo(0, 4.5 * dpr); ctx.lineTo(-8 * dpr, 9 * dpr); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.restore();

    // upright marks: waypoints, start / end, the landing site
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `700 ${10 * dpr}px Inter, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const inside = ([x, y], m = 6) => Math.hypot(x - half, y - half) < half - m * dpr;
    wpsXY.forEach((w, i) => {
      const q = S(w); if (!inside(q)) return;
      ctx.beginPath(); ctx.arc(q[0], q[1], 7.5 * dpr, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = '#111'; ctx.stroke();
      ctx.fillStyle = '#111'; ctx.fillText(String(i + 1), q[0], q[1] + 0.5 * dpr);
    });
    if (landXY) {
      const q = S(landXY), dKm = Math.hypot(landXY[0] - cx, landXY[1] - cy);
      if (inside(q, 10)) {
        ctx.beginPath(); ctx.arc(q[0], q[1], 10 * dpr, 0, Math.PI * 2); ctx.lineWidth = 2 * dpr; ctx.strokeStyle = 'rgba(255,210,61,0.9)'; ctx.stroke();
        ctx.save(); ctx.translate(q[0], q[1]); ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#ffd23d'; ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5 * dpr; ctx.fillRect(-4.5 * dpr, -4.5 * dpr, 9 * dpr, 9 * dpr); ctx.strokeRect(-4.5 * dpr, -4.5 * dpr, 9 * dpr, 9 * dpr);
        ctx.restore();
        label(landLabel, q[0], q[1] - 18 * dpr, '#ffd23d');
      } else {
        // off the map: a pointer on the rim towards it, with its distance
        const a = Math.atan2(q[1] - half, q[0] - half), rr = half - 16 * dpr, px2 = half + Math.cos(a) * rr, py2 = half + Math.sin(a) * rr;
        ctx.save(); ctx.translate(px2, py2); ctx.rotate(a);
        ctx.fillStyle = '#ffd23d'; ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath(); ctx.moveTo(9 * dpr, 0); ctx.lineTo(-5 * dpr, -6 * dpr); ctx.lineTo(-5 * dpr, 6 * dpr); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.restore();
        label(`${landLabel} ${kmText(dKm)}`, half + Math.cos(a) * (rr - 26 * dpr), half + Math.sin(a) * (rr - 14 * dpr), '#ffd23d');
      }
    }
    function label(text, x, y, colour) {
      ctx.font = `600 ${10.5 * dpr}px Inter, system-ui, sans-serif`;
      const w = ctx.measureText(text).width + 10 * dpr;
      const lx = Math.max(w / 2 + 4 * dpr, Math.min(W - w / 2 - 4 * dpr, x));
      ctx.fillStyle = 'rgba(0,0,0,0.72)'; ctx.beginPath(); ctx.roundRect(lx - w / 2, y - 8 * dpr, w, 16 * dpr, 8 * dpr); ctx.fill();
      ctx.fillStyle = colour; ctx.fillText(text, lx, y + 0.5 * dpr);
    }
    // rim, north and a scale bar
    ctx.lineWidth = 4 * dpr; ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.beginPath(); ctx.arc(half, half, half - 2 * dpr, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1 * dpr; ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.arc(half, half, half - 4.5 * dpr, 0, Math.PI * 2); ctx.stroke();
    const na = rot - Math.PI / 2 + northAng, nr = half - 13 * dpr;
    const nx = half + Math.cos(na) * nr, ny = half + Math.sin(na) * nr;
    ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(nx, ny, 10 * dpr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `700 ${12 * dpr}px Inter, system-ui, sans-serif`;
    ctx.fillText('N', nx, ny + 0.5 * dpr);
    // the scale bar under the map (css px)
    const barKm = niceStep(R * 0.45) / (niceStep(R * 0.45) > R * 0.6 ? 2 : 1);
    bar.style.width = `${Math.round((barKm * px) / dpr)}px`; barText.textContent = kmText(barKm);
    scale.textContent = `${kmText(R)} to the rim${headingUp ? ' · heading up' : ' · north up'}`;
    cint.textContent = `contours ${rf.ci >= 1 ? Math.round(rf.ci) : rf.ci.toFixed(1)} m`;
  }
  return { draw, get radiusKm() { return RADII[ri]; } };
}
