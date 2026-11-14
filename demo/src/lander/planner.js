// "Choose where to land" (step 1 of the mission): a full-screen map of the south polar region (relief from the
// finest LOLA level in view, permanent shadow, the listed sites, the 80°S edge of the data) and a whole-Moon view;
// a click or a typed latitude/longitude proposes a landing point. The point and its landing ellipse are scored
// (siteplan.js), a grid around it is searched for better spots (navigator suitability, score.js), the top five
// are ranked on the map and in a table, and "Land here" hands the chosen point to the page (onLand).
import { loadData } from '../data-loader.js';
import { createDem, toXY, fromXY, skylineFor, TERRAIN_MAX_LAT } from '../terrain.js';
import { createPsr, paintPsr, PSR_PACK } from '../psr.js';
import { decodePack, G0, sampleG0 } from '../globe-terrain.js';
import { loadSiteTerrain } from './terrain-local.js';
import { pickLandingTime, skyAt } from './landing.js';
import { planMission } from './mission.js';
import { ELLIPSE, ellipsePoints, terrainStats, skyDirections, skyStats, batteryHours, figures, verdict, searchGrid, suitability, bestPoints } from './siteplan.js';

const RAD = Math.PI / 180;
const EDGE_KM = Math.hypot(...toXY(TERRAIN_MAX_LAT, 0));   // 80°S on the polar map
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtLat = (v) => `${Math.abs(v).toFixed(3)}°${v < 0 ? 'S' : 'N'}`;
const fmtLon = (v) => `${(((v % 360) + 360) % 360).toFixed(3)}°E`;
const tick = () => new Promise((r) => setTimeout(r, 0));

// "−85.4, 35.3", "85.4S 35.3E", "85.4 S, 324.7 E" → { latDeg, lonDeg } | null
export function parseLatLon(text) {
  const m = String(text).trim().match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?[\s,;]+(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?$/i);
  if (!m) return null;
  let lat = Number(m[1]), lon = Number(m[3]);
  if (m[2] && m[2].toUpperCase() === 'S') lat = -Math.abs(lat);
  if (m[4] && m[4].toUpperCase() === 'W') lon = -Math.abs(lon);
  if (!(lat >= -90 && lat <= 90)) return null;
  let L = lon % 360;
  if (L < 0) L += 360;   // (no + 360 on positive longitudes: keeps 35.3 exactly 35.3)
  return { latDeg: lat, lonDeg: L };
}

export function createPlanner({ doc = document, root, eph, sites, meta, getDem, hires, getVehicle, getFromMs, getStayDays, getCurrent, onLand }) {
  root.innerHTML = `
    <div class="pl-map">
      <canvas aria-label="Map of the lunar south pole: click to propose a landing point"></canvas>
      <div class="pl-top glass">
        <div class="seg" role="group" aria-label="Map"><button data-view="polar" class="on">South pole</button><button data-view="moon">Whole Moon</button></div>
        <form class="pl-go"><input type="text" placeholder="lat, lon  e.g. 85.4S 35.3E" aria-label="Latitude and longitude"><button class="btn" type="submit">Go</button></form>
        <span class="pl-hint">Click the map to propose a landing point · drag to pan · wheel or pinch to zoom</span>
      </div>
      <div class="pl-zoom"><button class="cam" data-z="1.6" aria-label="Zoom in" title="Zoom in">+</button><button class="cam" data-z="0.625" aria-label="Zoom out" title="Zoom out">−</button></div>
      <div class="pl-key glass"></div>
      <div class="pl-toast" hidden></div>
    </div>
    <aside class="pl-side glass">
      <header><h2>Choose where to land</h2><button class="btn ghost pl-close" aria-label="Close the planner">Close</button></header>
      <p class="pl-assume"></p>
      <div class="pl-body"><p class="note">Click anywhere on the south polar map (80°S to the pole, where this page has terrain, skyline and descent data), or type a latitude and longitude.</p></div>
    </aside>`;
  const canvas = root.querySelector('canvas'), ctx = canvas.getContext('2d');
  const body = root.querySelector('.pl-body'), keyBox = root.querySelector('.pl-key'), toast = root.querySelector('.pl-toast');
  const S = { view: 'polar', cx: 0, cy: 0, kmPerPx: 0.8, w: 0, h: 0, pick: null, sel: 0, grid: null, results: null, token: 0, base: null, baseKey: '', g0: null, moonImg: null };
  const L = { slope: null, shadow: null, psr: null, dem120: null, fine: null };
  let opened = false;

  // ---------- data ----------
  async function loadLayers() {
    const get = (n) => loadData(n, { timeoutMs: 90000 }).catch(() => null);
    const [sl, sh, psr] = await Promise.all([get('slope_1km'), get('shadow_1km'), get(PSR_PACK)]);
    if (sl) L.slope = { bytes: sl, ...meta.slope?.find((x) => x.name === 'slope_1km') };
    if (sh) L.shadow = { bytes: sh, ...meta.shadow?.find((x) => x.name === 'shadow_1km') };
    try { if (psr) L.psr = createPsr(psr, meta.psr); } catch { L.psr = null; }
    const lv = meta.levels?.find((l) => l.name === 'dem_120m');
    if (lv) {
      const b = await get('dem_120m');
      if (b) L.dem120 = createDem({ data: new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1), size: lv.size, kmPerPixel: lv.kmPerPixel, dnToMeters: lv.dnToMeters, halfKm: lv.halfKm });
    }
    S.baseKey = ''; draw();
  }
  // navigator 1 km grids (±320 km): slope bytes × 0.25 = deg (240 m baseline), shadow bytes = km to the nearest PSR (0 inside)
  const cellOf = (g, x, y) => {
    const size = g.size ?? 640, ck = g.cellKm ?? 1, half = (size * ck) / 2;
    const i = Math.floor((x + half) / ck), j = Math.floor((half - y) / ck);
    return i >= 0 && j >= 0 && i < size && j < size ? j * size + i : -1;
  };
  const slopeAt = (x, y) => { if (!L.slope) return NaN; const k = cellOf(L.slope, x, y); return k < 0 ? NaN : L.slope.bytes[k] * (L.slope.scale ?? 0.25); };
  const shadowAt = (x, y) => { if (!L.shadow) return NaN; const k = cellOf(L.shadow, x, y); return k < 0 ? NaN : L.shadow.bytes[k]; };

  // ---------- map ----------
  const toScreen = (x, y) => [S.w / 2 + (x - S.cx) / S.kmPerPx, S.h / 2 - (y - S.cy) / S.kmPerPx];
  const toMap = (px, py) => [S.cx + (px - S.w / 2) * S.kmPerPx, S.cy - (py - S.h / 2) * S.kmPerPx];
  function resize() {
    const r = canvas.getBoundingClientRect();
    S.w = Math.max(1, Math.round(r.width)); S.h = Math.max(1, Math.round(r.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(S.w * dpr); canvas.height = Math.round(S.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    S.baseKey = ''; draw();
  }
  // relief shading of the visible window from the finest level loaded at this scale (light from the upper left)
  function sampler() {
    const dem = getDem();
    const chain = [];
    if (S.kmPerPx < 0.06 && L.fine) chain.push(L.fine);
    if (S.kmPerPx < 0.4 && L.dem120) chain.push(L.dem120.sample);
    if (dem) chain.push(dem.sample);
    return (x, y) => { for (const f of chain) { const v = f(x, y); if (v === v) return v; } return NaN; };
  }
  function renderBase() {
    const key = `${S.view}|${S.cx.toFixed(3)}|${S.cy.toFixed(3)}|${S.kmPerPx.toFixed(5)}|${S.w}x${S.h}|${!!L.dem120}|${!!L.fine}`;
    if (key === S.baseKey && S.base) return S.base;
    const w = S.w, h = S.h, img = new ImageData(w, h);
    if (S.view === 'polar') {
      const f = sampler(), k = S.kmPerPx;
      const H = new Float32Array((w + 1) * (h + 1));
      for (let j = 0; j <= h; j++) for (let i = 0; i <= w; i++) { const [x, y] = toMap(i, j); H[j * (w + 1) + i] = f(x, y); }
      const lx = -0.6, ly = 0.6, lz = 0.53, ex = Math.max(1, 6 * Math.sqrt(k));   // exaggerate gentle relief at small scales
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const a = H[j * (w + 1) + i], b = H[j * (w + 1) + i + 1], c = H[(j + 1) * (w + 1) + i];
        const o = (j * w + i) * 4;
        if (!(a === a && b === b && c === c)) { img.data[o] = 12; img.data[o + 1] = 13; img.data[o + 2] = 15; img.data[o + 3] = 255; continue; }
        const gx = ((b - a) / (k * 1000)) * ex, gy = ((a - c) / (k * 1000)) * ex;   // +x right, +y up
        const nz = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        const sh = Math.max(0, (-gx * lx - gy * ly + lz) * nz);
        const v = 28 + sh * 190;
        img.data[o] = v; img.data[o + 1] = v * 0.99; img.data[o + 2] = v * 0.96; img.data[o + 3] = 255;
      }
    } else if (S.g0) {
      // whole Moon, equirectangular, 7.6 km LOLA (globe_g0): fit the width
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const { lat, lon } = moonLL(i, j);
        const o = (j * w + i) * 4;
        if (lat === null) { img.data[o + 3] = 255; continue; }
        const a = sampleG0(S.g0, lat, lon), b = sampleG0(S.g0, lat, lon + 0.5), c = sampleG0(S.g0, lat - 0.5, lon);
        // heights in DN (0.5 m); 0.5° is about 15 km at the equator: a gentle slope shade
        const sh = Math.max(0, Math.min(1, 0.55 + ((a - b) + (a - c)) * 0.00025));
        const v = 30 + sh * 180;
        img.data[o] = v; img.data[o + 1] = v * 0.99; img.data[o + 2] = v * 0.96; img.data[o + 3] = 255;
      }
    }
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').putImageData(img, 0, 0);
    S.base = c; S.baseKey = key;
    return c;
  }
  const moonLL = (i, j) => {
    const sc = S.w / 360, top = (S.h - 180 * sc) / 2;
    const lat = 90 - (j - top) / sc, lon = i / sc;
    return lat < -90 || lat > 90 ? { lat: null, lon: null } : { lat, lon };
  };
  let drawQueued = false;
  function draw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(() => { drawQueued = false; paint(); }); setTimeout(() => { if (drawQueued) { drawQueued = false; paint(); } }, 60); } }
  function paint() {
    if (!opened || !S.w) return;
    ctx.clearRect(0, 0, S.w, S.h);
    ctx.drawImage(renderBase(), 0, 0, S.w, S.h);
    if (S.view === 'moon') return paintMoon();
    // permanent shadow (LOLA PSR) over the relief
    if (L.psr && S.kmPerPx < 1.2) { try { paintPsr(ctx, L.psr, { width: S.w, height: S.h, kmPerPx: S.kmPerPx, cx: S.cx, cy: S.cy }, { colour: [120, 160, 255], hatchAlpha: 0.18, outlineAlpha: 0.55 }); } catch { /* no OffscreenCanvas */ } }
    // suitability around the pick (1 km cells)
    if (S.grid) {
      const half = 0.5 / S.kmPerPx;
      for (const p of S.grid) {
        if (!p.done) continue;
        const [sx, sy] = toScreen(p.xKm, p.yKm);
        if (sx < -half || sy < -half || sx > S.w + half || sy > S.h + half) continue;
        ctx.fillStyle = p.ok ? rampCss(p.score, 0.42) : 'rgba(229,72,77,0.28)';
        ctx.fillRect(sx - half, sy - half, half * 2 + 0.5, half * 2 + 0.5);
        if (!p.ok && half > 3) { ctx.strokeStyle = 'rgba(229,72,77,0.55)'; ctx.beginPath(); ctx.moveTo(sx - half, sy + half); ctx.lineTo(sx + half, sy - half); ctx.stroke(); }
      }
    }
    // 80°S: the edge of the page's terrain, skyline and descent data
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 1;
    const [ox, oy] = toScreen(0, 0);
    ctx.beginPath(); ctx.arc(ox, oy, EDGE_KM / S.kmPerPx, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    if (EDGE_KM / S.kmPerPx < Math.max(S.w, S.h) * 1.5) label(ox, oy - EDGE_KM / S.kmPerPx - 6, '80°S · edge of the terrain data', 'rgba(255,255,255,0.6)', 'center');
    // listed sites
    for (const s of sites) { const [sx, sy] = toScreen(...toXY(s.latDeg, s.lonDeg)); dot(sx, sy, 3, '#f2b33d'); if (S.kmPerPx < 1.2) label(sx + 6, sy + 4, s.name, 'rgba(242,179,61,0.9)'); }
    // the current mission's site
    const cur = getCurrent?.();
    if (cur) { const [sx, sy] = toScreen(...toXY(cur.latDeg, cur.lonDeg)); ring(sx, sy, 7, '#fff'); label(sx + 9, sy - 8, 'current plan', 'rgba(255,255,255,0.8)'); }
    // candidates and the pick with their ellipses
    const cand = S.results?.list ?? [];
    cand.forEach((c, n) => { if (n === 0) return; const [sx, sy] = toScreen(c.xKm, c.yKm); ellipse(c, n === S.sel ? '#7fd18b' : 'rgba(127,209,139,0.8)'); badge(sx, sy, String(n), n === S.sel); });
    if (S.pick) { const [sx, sy] = toScreen(S.pick.xKm, S.pick.yKm); ellipse(S.pick, S.sel === 0 ? '#fff' : 'rgba(255,255,255,0.75)'); cross(sx, sy); }
    scaleBar();
    renderKey();
  }
  const rampCss = (t, a) => { const v = Math.max(0, Math.min(1, t)); const r = v < 0.5 ? 229 : Math.round(229 - (v - 0.5) * 2 * 102), g = v < 0.5 ? Math.round(72 + v * 2 * 107) : Math.round(179 + (v - 0.5) * 2 * 30); return `rgba(${r},${g},${v < 0.5 ? 77 : 107},${a})`; };
  function dot(x, y, r, c) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
  function ring(x, y, r, c) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); }
  function label(x, y, t, c, align = 'left') { ctx.font = '12px Inter, system-ui, sans-serif'; ctx.textAlign = align; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.strokeText(t, x, y); ctx.fillStyle = c; ctx.fillText(t, x, y); ctx.textAlign = 'left'; }
  function cross(x, y) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 9, y); ctx.lineTo(x - 3, y); ctx.moveTo(x + 3, y); ctx.lineTo(x + 9, y); ctx.moveTo(x, y - 9); ctx.lineTo(x, y - 3); ctx.moveTo(x, y + 3); ctx.lineTo(x, y + 9); ctx.stroke(); }
  function badge(x, y, t, on) { dot(x, y, 9, on ? '#7fd18b' : 'rgba(20,22,26,0.85)'); ring(x, y, 9, '#7fd18b'); ctx.font = '600 11px Inter, system-ui, sans-serif'; ctx.fillStyle = on ? '#000' : '#7fd18b'; ctx.textAlign = 'center'; ctx.fillText(t, x, y + 4); ctx.textAlign = 'left'; }
  // the 3σ ellipse at true scale (down-range radial), with at least a few pixels so it is seen when zoomed out
  function ellipse(p, colour) {
    const [sx, sy] = toScreen(p.xKm, p.yKm);
    const a = Math.max(4, ELLIPSE.downrangeM / 1000 / S.kmPerPx), b = Math.max(3, ELLIPSE.crossrangeM / 1000 / S.kmPerPx);
    const ang = Math.atan2(-p.yKm, p.xKm);   // radial direction on screen (y down)
    ctx.strokeStyle = colour; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(sx, sy, a, b, ang, 0, Math.PI * 2); ctx.stroke();
  }
  function scaleBar() {
    const want = S.kmPerPx * 120, p = Math.pow(10, Math.floor(Math.log10(want)));
    const km = [5, 2, 1].map((m) => m * p).find((v) => v <= want) ?? p;
    const px = km / S.kmPerPx, x = S.w - px - 64, y = S.h - 18;   // bottom right, clear of the key
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5); ctx.stroke();
    label(x + px + 6, y + 1, km >= 1 ? `${km} km` : `${Math.round(km * 1000)} m`, '#fff');
  }
  function paintMoon() {
    const sc = S.w / 360, top = (S.h - 180 * sc) / 2, y80 = top + (90 + 80) * sc;
    ctx.fillStyle = 'rgba(242,179,61,0.18)'; ctx.fillRect(0, y80, S.w, top + 180 * sc - y80);
    ctx.strokeStyle = 'rgba(242,179,61,0.8)'; ctx.beginPath(); ctx.moveTo(0, y80); ctx.lineTo(S.w, y80); ctx.stroke();
    label(10, top + 180 * sc + 18, '↑ 80°S to the pole (shaded band): the lander plans landings there; click it to open the polar map', 'rgba(242,179,61,0.95)');
    for (const s of sites) { const x = (((s.lonDeg % 360) + 360) % 360) * sc, y = top + (90 - s.latDeg) * sc; dot(x, y, 2.5, '#f2b33d'); }
    keyBox.innerHTML = '<b>Whole Moon</b> · LOLA 7.6 km (LDEM_4), equirectangular. The planner works south of 80°S, where the page has the polar terrain, skyline and descent data.';
  }
  function renderKey() {
    const res = S.kmPerPx < 0.06 && L.fine ? 'fine DEM near the pick' : S.kmPerPx < 0.4 && L.dem120 ? 'LOLA 120 m' : 'LOLA 480 m';
    keyBox.innerHTML = `<div class="pl-k-row"><span class="pl-k-bar"></span><span>Landing suitability around the pick (navigator score: Sun 40 · Earth 30 · slope 20 · near shadow 10), 1 km cells</span></div>
      <div class="pl-k-row"><span class="pl-k-sw fail"></span><span>fails a limit: slope over the lander limit, dark spell longer than the battery, or permanent shadow</span></div>
      <div class="pl-k-row"><span class="pl-k-sw psr"></span><span>permanent shadow (LOLA PSR, 120 m)</span><span class="pl-k-sw ell"></span><span>3σ landing ellipse ${ELLIPSE.downrangeM} × ${ELLIPSE.crossrangeM} m (assumed)</span></div>
      <div class="pl-k-src">Relief: ${res}, light from the upper left.</div>
      <div class="pl-k-short"><span class="pl-k-bar"></span> suitability · <span class="pl-k-sw fail"></span> fails a limit · <span class="pl-k-sw psr"></span> permanent shadow · ellipse ${ELLIPSE.downrangeM} × ${ELLIPSE.crossrangeM} m (assumed)</div>`;
  }

  // ---------- interaction ----------
  let drag = null; const pts = new Map(); let pinch = null;
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); drag = { x: e.clientX, y: e.clientY, cx: S.cx, cy: S.cy, moved: false }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); } });
  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) zoomBy(d / pinch); pinch = d; drag.moved = true; return; }
    if (!drag || S.view !== 'polar') return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.moved) { S.cx = drag.cx - dx * S.kmPerPx; S.cy = drag.cy + dy * S.kmPerPx; draw(); }
  });
  const end = (e) => {
    const wasDrag = drag?.moved;
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
    if (e.type === 'pointerup' && !wasDrag && pts.size === 0) {
      const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      if (S.view === 'moon') {
        const { lat, lon } = moonLL(px, py);
        if (lat === null) return;
        if (lat > TERRAIN_MAX_LAT) return say('North of 80°S: the lander has no polar terrain, skyline or descent data there. Pick in the shaded band.');
        setView('polar');
        setPick(lat, lon, { center: true });
      } else {
        // a numbered spot selects it; anywhere else proposes a new point
        const hit = S.results ? S.results.list.findIndex((c, n) => n > 0 && Math.hypot(...toScreen(c.xKm, c.yKm).map((v, i) => v - [px, py][i])) < 11) : -1;
        if (hit > 0) return select(hit);
        const [x, y] = toMap(px, py);
        const { latDeg, lonDeg } = fromXY(x, y);
        if (latDeg > TERRAIN_MAX_LAT) return say('Outside 80°S: no terrain, skyline or descent data there.');
        setPick(latDeg, lonDeg);
      }
    }
    if (pts.size === 0) drag = null;
  };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  function zoomBy(f, px = S.w / 2, py = S.h / 2) {
    if (S.view !== 'polar') return;
    const [x, y] = toMap(px, py);
    S.kmPerPx = Math.min(1.6, Math.max(0.004, S.kmPerPx / f));
    S.cx = x - (px - S.w / 2) * S.kmPerPx; S.cy = y + (py - S.h / 2) * S.kmPerPx;
    draw();
  }
  root.querySelectorAll('[data-z]').forEach((b) => b.addEventListener('click', () => zoomBy(Number(b.dataset.z))));
  root.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  root.querySelector('.pl-go').addEventListener('submit', (e) => {
    e.preventDefault();
    const ll = parseLatLon(root.querySelector('.pl-go input').value);
    if (!ll) return say('Type a latitude and longitude, e.g. 85.4S 35.3E or −85.4, 35.3');
    if (ll.latDeg > TERRAIN_MAX_LAT) return say('North of 80°S: outside the lander\'s polar terrain data.');
    setView('polar'); setPick(ll.latDeg, ll.lonDeg, { center: true });
  });
  root.querySelector('.pl-close').addEventListener('click', () => close());
  function say(t) { toast.textContent = t; toast.hidden = false; clearTimeout(say.t); say.t = setTimeout(() => { toast.hidden = true; }, 4200); }
  async function setView(v) {
    S.view = v;
    root.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    if (v === 'moon' && !S.g0) { try { S.g0 = await decodePack(await loadData(G0.name, { timeoutMs: 60000 }), G0.width); } catch { say('The whole-Moon terrain (globe_g0) did not load.'); } }
    S.baseKey = ''; draw();
  }

  // ---------- evaluation ----------
  async function setPick(latDeg, lonDeg, { center = false } = {}) {
    const [x, y] = toXY(latDeg, lonDeg);
    S.pick = { latDeg, lonDeg, xKm: x, yKm: y };
    S.sel = 0; S.results = null; S.grid = null;
    if (center) { S.cx = x; S.cy = y; S.kmPerPx = Math.min(S.kmPerPx, 0.08); }
    root.querySelector('.pl-go input').value = `${fmtLat(latDeg)} ${fmtLon(lonDeg)}`;
    draw();
    const token = ++S.token;
    const vehicle = getVehicle(), limit = vehicle.touchdown.maxSlopeDeg, battH = batteryHours(vehicle), stayDays = getStayDays();
    const fromMs = getFromMs();
    const dem = getDem();
    setBody(`<p class="note">Searching ${15} km around the point for the best landing spots…</p><div class="pl-prog"><i style="width:0%"></i></div>`);
    // stage 1: suitability on a 1 km grid around the pick (skyline from the 480 m DEM, Sun/Earth every 4 h over the stay)
    const mask0 = skylineFor(dem, S.pick);
    const land0 = pickLandingTime(eph, S.pick, mask0, fromMs) ?? fromMs;
    const dirs4 = skyDirections(eph, land0, stayDays, 4);
    const grid = searchGrid(x, y, { radiusKm: 15, stepKm: 1 }).filter((p) => p.latDeg <= TERRAIN_MAX_LAT);
    S.grid = grid;
    for (let k = 0; k < grid.length; k++) {
      const p = grid[k];
      const sky = skyStats(dirs4, p, skylineFor(dem, p), 4);
      Object.assign(p, { sun: sky.sun, earth: sky.earth, darkH: sky.longestDarkH, slopeDeg: slopeAt(p.xKm, p.yKm), shadowKm: shadowAt(p.xKm, p.yKm) });
      if (k % 24 === 23 || k === grid.length - 1) {
        const done = grid.slice(0, k + 1), s = suitability(done, { limitDeg: limit, battH });
        done.forEach((q, n) => { q.score = s[n].score; q.ok = s[n].ok; q.done = true; });
        const bar = body.querySelector('.pl-prog i'); if (bar) bar.style.width = `${Math.round(((k + 1) / grid.length) * 100)}%`;
        draw();
        await tick();
        if (token !== S.token) return;
      }
    }
    // stage 2: the pick and the eight best points that pass, in detail; the 1 km screen uses a 240 m slope, so the
    // fine ellipse figures re-rank them (fewest fails, then fewest near limits, then suitability) and five are kept
    const best = bestPoints(grid, { count: 8, minKm: 2, avoid: [{ xKm: x, yKm: y }] });
    setBody(`<p class="note">Scoring the point and the ${best.length} best spots in detail (terrain in the ellipse, sky over the stay, Δv)…</p><div class="pl-prog"><i style="width:0%"></i></div>`);
    const pick = { ...S.pick, name: 'Your point' };
    const cands = best.map((p) => ({ latDeg: p.latDeg, lonDeg: p.lonDeg, xKm: p.xKm, yKm: p.yKm, score: p.score }));
    const all = [pick, ...cands];
    for (let n = 0; n < all.length; n++) {
      Object.assign(all[n], await detail(all[n], { vehicle, limit, battH, stayDays, fromMs }));
      if (token !== S.token) return;
      const bar = body.querySelector('.pl-prog i'); if (bar) bar.style.width = `${Math.round(((n + 1) / all.length) * 100)}%`;
      await tick();
    }
    const count = (c, g) => c.figs.filter((f) => f.grade === g).length;
    cands.sort((a, b) => count(a, 'fail') - count(b, 'fail') || count(a, 'near') - count(b, 'near') || b.score - a.score);
    const list = [pick, ...cands.slice(0, 5)];
    list.forEach((c, n) => { if (n) c.name = `Spot ${n}`; });
    S.results = { list, limit, battH, stayDays };
    renderResults();
    draw();
  }

  async function detail(c, { vehicle, limit, battH, stayDays, fromMs }) {
    const dem = getDem();
    const listed = sites.find((s) => Math.hypot(...[0, 1].map((i) => toXY(s.latDeg, s.lonDeg)[i] - [c.xKm, c.yKm][i])) < 0.2);
    const site = { id: listed?.id ?? 'custom', name: listed?.name ?? `${fmtLat(c.latDeg)} ${fmtLon(c.lonDeg)}`, latDeg: c.latDeg, lonDeg: c.lonDeg };
    let terr = null;
    try { terr = await loadSiteTerrain(meta, site, { halfKm: 0.6, hires }); } catch { terr = null; }
    const resKm = terr?.finestKm ?? 0.12;
    if (c === S.results?.list?.[0] || c.name === 'Your point') L.fine = terr?.sample ?? null;
    const sample = terr?.sample ?? ((x, y) => (L.dem120 ?? dem).sample(x, y));
    // sample the ellipse at ≤ 30 m (the slopes still use a two-pixel baseline of the DEM)
    const pts = ellipsePoints(c.xKm, c.yKm, { stepM: Math.min(30, Math.max(5, resKm * 1000)) });
    const t = terrainStats(sample, pts, { baselineKm: Math.max(0.01, 2 * resKm), limitDeg: limit });
    const psrShare = L.psr ? pts.filter(([x, y]) => L.psr.isPsr(x, y)).length / Math.max(1, pts.length) : (shadowAt(c.xKm, c.yKm) === 0 ? 1 : 0);
    const mask = skylineFor(dem, site);
    const landingMs = pickLandingTime(eph, site, mask, fromMs) ?? fromMs;
    const sky = skyStats(skyDirections(eph, landingMs, stayDays, 1), site, mask, 1);
    const at = skyAt(eph, site, landingMs, mask);
    let budget = null;
    try {
      const h = dem.heightAt(site.latDeg, site.lonDeg);
      const plan = planMission({ eph, site, landingMs, vehicle, siteHeightKm: (h ?? 0) / 1000, mask });
      if (plan.ok) budget = plan.budget;
    } catch { budget = null; }
    const figs = figures({ t, sky, psrShare, budget, earthAtLanding: at ? at.earth.clearDeg > 0 : null, battH, limitDeg: limit, resKm, stayDays });
    return { site, landingMs, figs, verdict: verdict(figs), resKm, distKm: S.pick ? Math.hypot(c.xKm - S.pick.xKm, c.yKm - S.pick.yKm) : 0 };
  }

  function setBody(html) { body.innerHTML = html; }
  const G = { pass: 'pass', near: 'near', fail: 'fail' };
  function renderResults() {
    const R = S.results, c = R.list[S.sel];
    const fig = (id, x) => x.figs.find((f) => f.id === id);
    const cell = (f) => (f ? `<td class="r g-${G[f.grade]}">${esc(f.text.split(' (')[0].split(' · ')[0])}</td>` : '<td class="r">—</td>');
    body.innerHTML = `
      <div class="pl-point"><b>${esc(c.name)}</b> · ${fmtLat(c.latDeg)} ${fmtLon(c.lonDeg)}${c.distKm ? ` · ${c.distKm.toFixed(1)} km from your point` : ''}<br><span class="muted">landing ${new Date(c.landingMs).toISOString().slice(0, 16).replace('T', ' ')} UTC (first lit window) · slopes on the ${Math.round(c.resKm * 1000)} m DEM</span></div>
      <p class="pl-verdict g-${c.verdict.grade}">${esc(c.verdict.text)}</p>
      <ul class="pl-figs">${c.figs.map((f) => `<li class="g-${G[f.grade]}"><div class="pl-f-h"><span>${esc(f.label)}</span><span class="pl-g">${f.grade}</span></div><div class="pl-f-v"><b>${esc(f.text)}</b><span class="muted">limit ${esc(f.limit)}</span></div><small>${esc(f.note)}</small></li>`).join('')}</ul>
      <button class="btn primary pl-land">Land here: plan the mission to ${esc(c.site.id === 'custom' ? `${fmtLat(c.latDeg)} ${fmtLon(c.lonDeg)}` : c.site.name)}</button>
      <h3>Better spots nearby <small>the 5 best that pass the hard limits in a 30 × 30 km square around your point, at least 2 km apart, by suitability; same stay and method</small></h3>
      <table class="tbl pl-cmp"><thead><tr><th>#</th><th class="r">km</th><th class="r">Slope</th><th class="r">Sun</th><th class="r">Earth</th><th class="r">Dark</th><th class="r">Δv</th></tr></thead><tbody>
      ${R.list.map((x, n) => `<tr data-n="${n}" class="${n === S.sel ? 'on' : ''}"><td>${n === 0 ? 'You' : n}</td><td class="r">${x.distKm.toFixed(1)}</td>${cell(fig('slope', x))}${cell(fig('sun', x))}${cell(fig('earth', x))}${cell(fig('dark', x))}${cell(fig('dv', x))}</tr>`).join('')}
      </tbody></table>
      <p class="note">Click a row or a numbered spot on the map to see its figures. Rocks smaller than the DEM are not modelled; Sun and Earth use the 480 m skyline; the Δv is from the planned polar orbit with this vehicle (assumed).</p>`;
    body.querySelectorAll('.pl-cmp tr[data-n]').forEach((tr) => tr.addEventListener('click', () => select(Number(tr.dataset.n))));
    body.querySelector('.pl-land').addEventListener('click', () => { onLand({ site: c.site, landingMs: c.landingMs }); close(); });
  }
  function select(n) { S.sel = n; renderResults(); const c = S.results.list[n]; S.cx = c.xKm; S.cy = c.yKm; draw(); }

  // ---------- open / close ----------
  function open() {
    root.hidden = false; opened = true;
    const v = getVehicle();
    root.querySelector('.pl-assume').textContent = `Assumed: 3σ landing ellipse ${ELLIPSE.downrangeM} m down-range × ${ELLIPSE.crossrangeM} m cross-range (terrain-relative navigation); slope limit ${v.touchdown.maxSlopeDeg}°; stay ${getStayDays()} days from the first lit window; battery ${v.batteryWh} Wh with ${Math.round(v.batteryMinSoc * 100)} % reserve on a ${v.loadsW.surface} W surface load = ${batteryHours(v).toFixed(1)} h of darkness.`;
    const cur = getCurrent?.();
    if (cur && !S.pick) { const [x, y] = toXY(cur.latDeg, cur.lonDeg); S.cx = x; S.cy = y; S.kmPerPx = 0.25; }
    requestAnimationFrame(resize);
    setTimeout(resize, 50);
    if (!L.slope) loadLayers();
  }
  function close() { root.hidden = true; opened = false; S.token++; }
  window.addEventListener('resize', () => { if (opened) resize(); });
  return { open, close, get isOpen() { return opened; }, setPick, state: S };
}
