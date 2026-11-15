// "Choose where to land" (the Map's region level, planner.html): a full-screen map of the south polar region (relief from the
// finest LOLA level in view, permanent shadow, the listed sites, the 80°S edge of the data) and a whole-Moon view;
// a click or a typed latitude/longitude proposes a landing point. The point and its landing ellipse are scored
// (siteplan.js), a grid around it is searched for better spots (navigator suitability, score.js), the top five
// are ranked on the map and in a table, and "Land here" hands the chosen point to the page (onLand).
import { loadData } from '../data-loader.js';
import { toXY, fromXY, TERRAIN_MAX_LAT } from '../terrain.js';
import { paintPsr } from '../psr.js';
import { decodePack, G0, G2, sampleG0 } from '../globe-terrain.js';
import { mapScale } from './landing.js';
import { distanceBearing, subPoint } from './skyline.js';
import { GAZETTEER, GAZETTEER_SOURCE } from './gazetteer.js';
import { createLandingEvaluator } from './landeval.js';
import { ELLIPSE, batteryHours, landableClass, LANDABLE } from './siteplan.js';
import { createHeatGrid, fractionJob } from '../heat.js';

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

// labels: the two actions' names on the page that hosts it (the Map's region level: "Use this site", "Back to the Map");
// onClose: called when the planner closes (Esc, the close button)
export function createPlanner({ doc = document, root, eph, sites, meta, getDem, hires, siteCtx, getVehicle, getFromMs, getStayDays, getStayStartMs, getCurrent, onLand, onClose = null, labels = {} }) {
  const L0 = { land: 'Land here', close: 'Back to 3D', closeTitle: 'Back to the 3D view (Esc)', ...labels };
  root.innerHTML = `
    <div class="pl-map">
      <canvas aria-label="Map of the lunar south pole: click to propose a landing point"></canvas>
      <div class="pl-top glass">
        <div class="seg" role="group" aria-label="Map"><button data-view="polar" class="on" title="Map around the point (south polar stereographic; polar data south of 80°S, global LOLA elsewhere)">Map</button><button data-view="moon">Whole Moon</button></div>
        <label class="pl-names" title="Major named features from the IAU/USGS Gazetteer" hidden><input type="checkbox" checked> Names</label>
        <form class="pl-go"><input type="text" placeholder="lat, lon  e.g. 85.4S 35.3E" aria-label="Latitude and longitude"><button class="btn" type="submit">Go</button></form>
        <span class="pl-hint">Click the map to propose a landing point · drag to pan · wheel or pinch to zoom</span>
      </div>
      <div class="pl-act ab" role="toolbar" aria-label="Planner actions"></div>
      <div class="pl-zoom"><button class="cam" data-z="1.6" aria-label="Zoom in" title="Zoom in">+</button><button class="cam" data-z="0.625" aria-label="Zoom out" title="Zoom out">−</button></div>
      <div class="pl-key glass"></div>
      <div class="pl-read glass" hidden></div>
      <div class="pl-toast" hidden></div>
    </div>
    <aside class="pl-side glass">
      <header><h2>Choose where to land</h2></header>
      <p class="pl-assume"></p>
      <div class="pl-body"><p class="note">Click anywhere on the south polar map (80°S to the pole, where this page has terrain, skyline and descent data), or type a latitude and longitude.</p></div>
    </aside>`;
  const canvas = root.querySelector('canvas'), ctx = canvas.getContext('2d');
  const body = root.querySelector('.pl-body'), keyBox = root.querySelector('.pl-key'), toast = root.querySelector('.pl-toast');
  const S = { view: 'polar', cx: 0, cy: 0, kmPerPx: 0.8, w: 0, h: 0, pick: null, sel: 0, grid: null, results: null, token: 0, base: null, baseKey: '', g0: null, moonImg: null, mz: 0, mlon0: 0, mlat0: 0, names: true, lib: null };
  const readBox = root.querySelector('.pl-read');
  root.querySelector('.pl-names input').addEventListener('change', (e) => { S.names = e.target.checked; draw(); });
  // the scoring and the search are lander/landeval.js's (shared with the Map's Where to land panel); its layers too
  const ev = createLandingEvaluator({ eph, sites, meta, getDem, hires, siteCtx, getVehicle, getFromMs, getStayDays, getMargin: () => siteMargins().min });
  const L = ev.L;
  // where landing is possible over the whole region (2 km cells): navigator sky grid + its slope and shadow grids
  const R = { grid: null, job: null, cls: null, img: null, startMs: 0, endMs: 0, progress: 0, token: 0 };
  // the listed sites scored like a pick: id → { verdict, figs, landingMs, pending }
  const siteRes = new Map();
  let opened = false;

  // ---------- data ----------
  async function loadLayers() {
    await ev.loadLayers();
    startRegion();
    scoreSites();
    S.baseKey = ''; draw();
  }

  async function startRegion() {
    const hb = await loadData('horizon_grid', { timeoutMs: 120000 }).catch(() => null);
    if (!hb || !meta.horizon) return;
    const grid = createHeatGrid({ horizon: hb, ...meta.horizon });
    const n = grid.size, mask = new Uint8Array(grid.count);
    for (let k = 0; k < grid.count; k++) { const c = grid.cellCenter(k); mask[k] = Math.hypot(c.xKm, c.yKm) <= EDGE_KM ? 1 : 0; }
    R.grid = grid; R.cls = new Uint8Array(grid.count); R.img = new ImageData(n, n);
    R.startMs = getStayStartMs(); R.endMs = R.startMs + getStayDays() * 86400e3;
    R.job = fractionJob(grid, eph, R.startMs, R.endMs, { stepMs: 2 * 3600e3, mask });
    const token = ++R.token;
    let row = 0;
    while (!R.job.done) {
      R.job.run(14);
      if (token !== R.token) return;
      classifyRows(row, R.job.rows, mask); row = R.job.rows;
      R.progress = R.job.progress;
      draw();
      await tick();
    }
  }
  // landable class per region cell, and its pixel in the overlay image (one pixel per 2 km cell)
  function classifyRows(j0, j1, mask) {
    const g = R.grid, n = g.size, v = getVehicle(), battH = batteryHours(v), limit = v.touchdown.maxSlopeDeg;
    const margin = siteMargins().min;
    const d = R.img.data;
    for (let j = j0; j < j1; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (!mask[k]) continue;
      const c = landableClass({ sun: R.job.sun[k], earth: R.job.earth[k], darkH: R.job.dark[k], slopeDeg: L.slope2 ? L.slope2.bytes[k] * (L.slope2.scale ?? 0.25) : NaN, shadowKm: L.shadow2 ? L.shadow2.bytes[k] : NaN, marginMs: Number.isFinite(margin) ? margin : 0 }, { limitDeg: limit, battH });
      R.cls[k] = c;
      const o = k * 4;
      if (c === 2) { d[o] = 127; d[o + 1] = 209; d[o + 2] = 139; d[o + 3] = 120; } else if (c === 1) { d[o] = 229; d[o + 1] = 179; d[o + 2] = 77; d[o + 3] = 105; } else d[o + 3] = 0;
    }
    R.canvas = null;
  }
  async function scoreSites() {
    const v = getVehicle(), opts = { vehicle: v, limit: v.touchdown.maxSlopeDeg, battH: batteryHours(v), stayDays: getStayDays(), fromMs: getFromMs() };
    for (const s of sites) siteRes.set(s.id, { pending: true });
    if (!S.pick) renderSites();
    for (const s of sites) {
      const [x, y] = toXY(s.latDeg, s.lonDeg);
      try { siteRes.set(s.id, await detail({ latDeg: s.latDeg, lonDeg: s.lonDeg, xKm: x, yKm: y, name: s.name }, opts)); } catch { siteRes.set(s.id, { failed: true }); }
      if (!S.pick) renderSites();
      draw();
      await tick();
    }
    // the reachability used by the shading: the Δv margins at the listed sites
    if (R.job) { classifyRows(0, R.job.rows, R.job.mask ?? new Uint8Array(R.grid.count).fill(1)); draw(); }
  }
  function siteMargins() {
    const m = [...siteRes.values()].map((r) => r.figs?.find((f) => f.id === 'dv')?.value).filter(Number.isFinite);
    return m.length ? { min: Math.min(...m), max: Math.max(...m), n: m.length } : { min: NaN, max: NaN, n: 0 };
  }

  // ---------- map ----------
  const toScreen = (x, y) => [S.w / 2 + (x - S.cx) / S.kmPerPx, S.h / 2 - (y - S.cy) / S.kmPerPx];
  const toMap = (px, py) => [S.cx + (px - S.w / 2) * S.kmPerPx, S.cy - (py - S.h / 2) * S.kmPerPx];
  function resize() {
    // the action bar, read-out and zoom sit under the map's top bar, whatever its height
    const tb = root.querySelector('.pl-top').getBoundingClientRect(), mb = root.querySelector('.pl-map').getBoundingClientRect();
    root.style.setProperty('--pl-top', `${Math.round(tb.bottom - mb.top + 8)}px`);
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
    if (siteCtx?.globe.ready) chain.push((x, y) => { const p = fromXY(x, y); return siteCtx.sampleLL(p.latDeg, p.lonDeg); });
    return (x, y) => { for (const f of chain) { const v = f(x, y); if (v === v) return v; } return NaN; };
  }
  function renderBase() {
    const key = `${S.view}|${S.cx.toFixed(3)}|${S.cy.toFixed(3)}|${S.kmPerPx.toFixed(5)}|${S.w}x${S.h}|${!!L.dem120}|${!!L.fine}|${S.mz.toFixed(3)}|${S.mlon0.toFixed(2)}|${S.mlat0.toFixed(2)}|${siteCtx?.globe.version ?? 0}`;
    if (key === S.baseKey && S.base) return S.base;
    const w = S.w, h = S.h, img = new ImageData(w, h);
    if (S.view === 'polar') {
      const f = sampler(), k = S.kmPerPx;
      const H = new Float32Array((w + 1) * (h + 1));
      for (let j = 0; j <= h; j++) for (let i = 0; i <= w; i++) { const [x, y] = toMap(i, j); H[j * (w + 1) + i] = f(x, y); }
      // exaggerate gentle relief at small scales; kc: map scale at the centre (map km per ground km, 2 at the equator)
      const kc = mapScale(fromXY(S.cx, S.cy).latDeg);
      const lx = -0.6, ly = 0.6, lz = 0.53, ex = Math.max(1, 6 * Math.sqrt(k / kc)) * kc;
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
      // whole Moon, equirectangular: LOLA 7.6 km zoomed out, the finest global tiles loaded when zoomed in;
      // the night side at the start of the planned stay is darkened (terminator)
      const fine = S.mz > 6 && siteCtx?.globe.ready;
      const hAt = fine ? (la, lo) => siteCtx.sampleLL(la, lo) : (la, lo) => sampleG0(S.g0, la, lo) * 0.5;
      const sun = eph.at(getStayStartMs())?.sun;
      const dd = Math.max(0.02, 1 / S.mz);   // one pixel in degrees
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const { lat, lon } = moonLL(i, j);
        const o = (j * w + i) * 4;
        if (lat === null) { img.data[o + 3] = 255; continue; }
        const a = hAt(lat, lon), b = hAt(lat, lon + dd), c = hAt(lat - dd, lon);
        const kmE = Math.max(0.05, dd * 30.32 * Math.cos(lat * RAD)), kmN = dd * 30.32;
        const gx = (b - a) / (kmE * 1000), gy = (a - c) / (kmN * 1000), ex = 4 + 2 * Math.sqrt(30.32 / S.mz);
        const nz = 1 / Math.sqrt((gx * ex) ** 2 + (gy * ex) ** 2 + 1);
        let v = 30 + Math.max(0, (-gx * ex * -0.6 - gy * ex * 0.6 + 0.53) * nz) * 190;
        if (sun) { const cp = Math.cos(lat * RAD); if (cp * Math.cos(lon * RAD) * sun[0] + cp * Math.sin(lon * RAD) * sun[1] + Math.sin(lat * RAD) * sun[2] < 0) v *= 0.42; }
        img.data[o] = v; img.data[o + 1] = v * 0.99; img.data[o + 2] = v * 0.96; img.data[o + 3] = 255;
      }
    }
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').putImageData(img, 0, 0);
    S.base = c; S.baseKey = key;
    return c;
  }
  // whole-Moon view: equirectangular, mz pixels per degree, centred on (mlat0, mlon0); longitudes east 0–360
  const fitMz = () => Math.max(S.w / 360, 1e-3);
  const moonLL = (i, j) => {
    const mz = S.mz || fitMz();
    const lat = S.mlat0 - (j - S.h / 2) / mz, lon = S.mlon0 + (i - S.w / 2) / mz;
    return lat < -90 || lat > 90 ? { lat: null, lon: null } : { lat, lon: ((lon % 360) + 360) % 360 };
  };
  const moonXY = (lat, lon) => { const mz = S.mz || fitMz(); let d = (((lon - S.mlon0) % 360) + 540) % 360 - 180; return [S.w / 2 + d * mz, S.h / 2 - (lat - S.mlat0) * mz]; };
  let drawQueued = false;
  function draw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(() => { drawQueued = false; paint(); }); setTimeout(() => { if (drawQueued) { drawQueued = false; paint(); } }, 60); } }
  function paint() {
    if (!opened || !S.w) return;
    ctx.clearRect(0, 0, S.w, S.h);
    ctx.drawImage(renderBase(), 0, 0, S.w, S.h);
    if (S.view === 'moon') return paintMoon();
    // permanent shadow (LOLA PSR) over the relief
    if (L.psr && S.kmPerPx < 1.2) { try { paintPsr(ctx, L.psr, { width: S.w, height: S.h, kmPerPx: S.kmPerPx, cx: S.cx, cy: S.cy }, { colour: [120, 160, 255], hatchAlpha: 0.18, outlineAlpha: 0.55 }); } catch { /* no OffscreenCanvas */ } }
    // where a landing is possible: 2 km cells over the region (green landable, amber possible)
    if (R.img) {
      if (!R.canvas) { R.canvas = new OffscreenCanvas(R.grid.size, R.grid.size); R.canvas.getContext('2d').putImageData(R.img, 0, 0); }
      const half = R.grid.halfKm, [x0, y0] = toScreen(-half, half), [x1, y1] = toScreen(half, -half);
      ctx.imageSmoothingEnabled = false;
      // inside the search square the 1 km cells replace the 2 km ones
      if (S.grid) { ctx.save(); const b = S.grid.box; ctx.beginPath(); ctx.rect(0, 0, S.w, S.h); const [a0, b0] = toScreen(b.x0, b.y1), [a1, b1] = toScreen(b.x1, b.y0); ctx.rect(a1, b0, a0 - a1, b1 - b0); ctx.clip('evenodd'); }
      ctx.drawImage(R.canvas, x0, y0, x1 - x0, y1 - y0);
      if (S.grid) ctx.restore();
      ctx.imageSmoothingEnabled = true;
    }
    // around the pick: the same classes on the 1 km search grid, with its edge
    if (S.grid) {
      const half = 0.5 / S.kmPerPx;
      for (const p of S.grid) {
        if (!p.done || !p.cls) continue;
        const [sx, sy] = toScreen(p.xKm, p.yKm);
        if (sx < -half || sy < -half || sx > S.w + half || sy > S.h + half) continue;
        ctx.fillStyle = p.cls === 2 ? 'rgba(127,209,139,0.5)' : 'rgba(229,179,77,0.45)';
        ctx.fillRect(sx - half, sy - half, half * 2 + 0.5, half * 2 + 0.5);
      }
      const b = S.grid.box, [a0, b0] = toScreen(b.x0, b.y1), [a1, b1] = toScreen(b.x1, b.y0);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.setLineDash([4, 4]); ctx.strokeRect(a0, b0, a1 - a0, b1 - b0); ctx.setLineDash([]);
    }
    // 80°S: the edge of the page's terrain, skyline and descent data
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 1;
    const [ox, oy] = toScreen(0, 0);
    ctx.beginPath(); ctx.arc(ox, oy, EDGE_KM / S.kmPerPx, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    if (EDGE_KM / S.kmPerPx < Math.max(S.w, S.h) * 1.5) label(ox, oy - EDGE_KM / S.kmPerPx - 6, '80°S · edge of the terrain data', 'rgba(255,255,255,0.6)', 'center');
    // listed sites
    for (const s of sites) {
      const [sx, sy] = toScreen(...toXY(s.latDeg, s.lonDeg)), r = siteRes.get(s.id), g = r?.verdict?.grade;
      dot(sx, sy, 5.5, g === 'pass' ? '#7fd18b' : g === 'near' ? '#e5b34d' : g === 'fail' ? '#ff7b7f' : '#8a8a8a');
      ring(sx, sy, 5.5, 'rgba(0,0,0,0.8)');
      if (S.kmPerPx < 1.2) label(sx + 8, sy + 4, `${s.name}${s.verified === false ? ' (approx.)' : ''}`, 'rgba(255,236,200,0.95)');
    }
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
  // great circle 90° from a point (limb or terminator) as screen segments (split at the map edge)
  function circle90(c, colour, dash = []) {
    const n = [Math.cos(c.latDeg * RAD) * Math.cos(c.lonDeg * RAD), Math.cos(c.latDeg * RAD) * Math.sin(c.lonDeg * RAD), Math.sin(c.latDeg * RAD)];
    const u = Math.abs(n[2]) < 0.9 ? [-n[1], n[0], 0] : [0, -n[2], n[1]], ul = Math.hypot(...u); u.forEach((v, i) => { u[i] = v / ul; });
    const w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    ctx.strokeStyle = colour; ctx.setLineDash(dash); ctx.lineWidth = 1.5; ctx.beginPath();
    let prev = null;
    for (let a = 0; a <= 360; a += 2) {
      const t = a * RAD, v = [0, 1, 2].map((i) => Math.cos(t) * u[i] + Math.sin(t) * w[i]);
      const [x, y] = moonXY(Math.asin(v[2]) / RAD, Math.atan2(v[1], v[0]) / RAD);
      if (prev && Math.abs(x - prev[0]) < S.w / 2) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      prev = [x, y];
    }
    ctx.stroke(); ctx.setLineDash([]);
  }
  // the sub-Earth point's range over the ephemeris (libration), once
  function libration() {
    if (S.lib) return S.lib;
    let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
    for (let t = eph.startMs; t <= eph.endMs; t += 86400e3) {
      const d = eph.at(t); if (!d) continue;
      const p = subPoint(d.earth), lo = p.lonDeg > 180 ? p.lonDeg - 360 : p.lonDeg;
      la0 = Math.min(la0, p.latDeg); la1 = Math.max(la1, p.latDeg); lo0 = Math.min(lo0, lo); lo1 = Math.max(lo1, lo);
    }
    return (S.lib = { la0, la1, lo0, lo1 });
  }
  function paintMoon() {
    const mz = S.mz || fitMz(), tMs = getStayStartMs(), d = eph.at(tMs);
    // graticule: every 30° zoomed out, finer zoomed in; 0° and 180° stronger
    const step = [30, 15, 10, 5, 2, 1, 0.5, 0.25].find((v) => v * mz < 140 && v * mz >= 60) ?? (mz * 30 < 60 ? 30 : 0.25);
    ctx.lineWidth = 1; ctx.font = '11px Inter, system-ui, sans-serif';
    const [, yTop] = moonXY(90, 0), [, yBot] = moonXY(-90, 0);
    for (let lon = 0; lon < 360; lon += step) {
      const [x] = moonXY(0, lon); if (x < -2 || x > S.w + 2) continue;
      const main = lon === 0 || lon === 180;
      ctx.strokeStyle = main ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.16)'; ctx.beginPath(); ctx.moveTo(x, Math.max(0, yTop)); ctx.lineTo(x, Math.min(S.h, yBot)); ctx.stroke();
      label(x + 3, Math.max(14, yTop + 14), lon === 0 ? '0° prime' : lon === 180 ? '180°' : `${+lon.toFixed(2)}°E`, main ? '#fff' : 'rgba(255,255,255,0.65)');
    }
    for (let lat = -90 + step; lat < 90; lat += step) {
      const [, y] = moonXY(lat, 0); if (y < 0 || y > S.h) continue;
      ctx.strokeStyle = lat === 0 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.16)'; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S.w, y); ctx.stroke();
      label(4, y - 3, lat === 0 ? '0° equator' : `${Math.abs(+lat.toFixed(2))}°${lat < 0 ? 'S' : 'N'}`, 'rgba(255,255,255,0.65)');
    }
    // near side / far side at the stay start (limb seen from Earth), the libration zone, the terminator
    if (d) {
      const se = subPoint(d.earth), ss = subPoint(d.sun), lib = libration();
      circle90(se, 'rgba(76,179,240,0.9)');
      circle90({ latDeg: 0, lonDeg: lib.lo0 }, 'rgba(76,179,240,0.45)', [5, 5]);
      circle90({ latDeg: 0, lonDeg: lib.lo1 }, 'rgba(76,179,240,0.45)', [5, 5]);
      circle90(ss, 'rgba(242,179,61,0.85)', [8, 4]);
      const [ex, ey] = moonXY(se.latDeg, se.lonDeg), [sx, sy] = moonXY(ss.latDeg, ss.lonDeg);
      const [b0x, b0y] = moonXY(lib.la1, lib.lo0), [b1x, b1y] = moonXY(lib.la0, lib.lo1);
      ctx.strokeStyle = 'rgba(76,179,240,0.8)'; ctx.strokeRect(Math.min(b0x, b1x), Math.min(b0y, b1y), Math.abs(b1x - b0x), Math.abs(b1y - b0y));
      dot(ex, ey, 4, '#4cb3f0'); label(ex + 7, ey - 6, 'sub-Earth point', '#9fd6f7');
      dot(sx, sy, 5, '#f2b33d'); label(sx + 7, sy - 6, 'subsolar point', '#ffd98a');
    }
    // named features (IAU) and the listed landing sites
    if (S.names) {
      for (const f of GAZETTEER) {
        const [x, y] = moonXY(f.latDeg, f.lonDeg); if (x < -40 || y < -10 || x > S.w + 40 || y > S.h + 10) continue;
        const big = f.type === 'mare' || f.type === 'oceanus' || f.type === 'basin';
        if (!big && mz < 2.5) continue;
        if (!big) dot(x, y, 2, 'rgba(255,255,255,0.8)');
        label(x + (big ? 0 : 4), y + 4, f.name, big ? 'rgba(210,225,255,0.9)' : 'rgba(255,255,255,0.85)', big ? 'center' : 'left');
      }
    }
    for (const s of sites) {
      const [x, y] = moonXY(s.latDeg, s.lonDeg), g = siteRes.get(s.id)?.verdict?.grade;
      dot(x, y, 4.5, g === 'pass' ? '#7fd18b' : g === 'near' ? '#e5b34d' : g === 'fail' ? '#ff7b7f' : '#f2b33d'); ring(x, y, 4.5, 'rgba(0,0,0,0.8)');
      if (S.names && mz > 1.2) label(x + 7, y + 4, s.name, 'rgba(255,236,200,0.95)');
    }
    if (S.pick) { const [x, y] = moonXY(S.pick.latDeg, S.pick.lonDeg); cross(x, y); }
    // scale at the centre latitude
    const kmPx = (30.32 * Math.cos(S.mlat0 * RAD)) / mz, want = kmPx * 120, p = Math.pow(10, Math.floor(Math.log10(want)));
    const km = [5, 2, 1].map((m) => m * p).find((v) => v <= want) ?? p, px = km / kmPx, bx = S.w - px - 110, by = S.h - 18;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(bx, by - 5); ctx.lineTo(bx, by); ctx.lineTo(bx + px, by); ctx.lineTo(bx + px, by - 5); ctx.stroke();
    label(bx + px + 6, by + 1, `${km >= 1 ? km : km * 1000} ${km >= 1 ? 'km' : 'm'} at ${Math.abs(S.mlat0).toFixed(0)}°${S.mlat0 < 0 ? 'S' : 'N'}`, '#fff');
    const when = new Date(tMs).toISOString().slice(0, 16).replace('T', ' ');
    keyBox.innerHTML = `<div class="pl-k-row"><b>Whole Moon</b><span>equirectangular, east longitude 0–360°; relief LOLA ${S.mz > 6 && siteCtx?.globe.ready ? '1.9 km / 474 m where loaded' : '7.6 km (LDEM_4)'}; graticule every ${step}°</span></div>
      <div class="pl-k-row"><span class="pl-k-ln earth"></span><span>limb seen from Earth at ${when} UTC: near side inside, far side outside</span><span class="pl-k-ln earth dash"></span><span>libration zone limits (sub-Earth point range 2026–2028, blue box)</span></div>
      <div class="pl-k-row"><span class="pl-k-ln sun"></span><span>terminator and subsolar point at the same time; the dark half is night</span></div>
      <div class="pl-k-row"><span>Click anywhere to score a landing there: south of 80°S on the polar data, elsewhere on the global LOLA terrain with the skyline computed (lander-scale hazards not resolved at 474 m).</span></div>
      <div class="pl-k-src">Names: ${esc(GAZETTEER_SOURCE)}.</div>
      <div class="pl-k-short">limb (blue) · terminator (amber) · ${step}° grid · click to score anywhere</div>`;
  }
  function renderKey() {
    const centreLat = fromXY(S.cx, S.cy).latDeg;
    const res = centreLat > TERRAIN_MAX_LAT ? 'global LOLA (474 m tiles where loaded, else 1.9 / 7.6 km); the landable shading covers the south polar data only' : S.kmPerPx < 0.06 && L.fine ? 'fine DEM near the pick' : S.kmPerPx < 0.4 && L.dem120 ? 'LOLA 120 m' : 'LOLA 480 m';
    const v = getVehicle(), battH = batteryHours(v), m = siteMargins(), pct = (x) => `${Math.round(x * 100)} %`;
    const when = R.startMs ? `${getStayDays()} days from ${new Date(R.startMs).toISOString().slice(0, 10)}` : `${getStayDays()} days`;
    const prog = R.job && !R.job.done ? ` · computing ${Math.round(R.progress * 100)} %` : !R.job ? ' · loading the sky grid…' : '';
    keyBox.innerHTML = `<div class="pl-k-row"><span class="pl-k-sw land"></span><b>Landable</b><span>every check passes</span><span class="pl-k-sw poss"></span><b>Possible</b><span>near a limit</span><span class="muted">${prog}</span></div>
      <div class="pl-k-row"><span>Checks: slope ≤ ${v.touchdown.maxSlopeDeg}° (240 m baseline) · no permanent shadow within 1 km · Sun ≥ ${pct(LANDABLE.sun[0])} (≥ ${pct(LANDABLE.sun[1])}) and Earth ≥ ${pct(LANDABLE.earth[0])} (≥ ${pct(LANDABLE.earth[1])}) over ${when} · longest dark ≤ ${battH.toFixed(1)} h battery (≤ ${(battH * LANDABLE.dark[1]).toFixed(0)} h) · Δv margin ${m.n ? `${Math.round(m.min)}–${Math.round(m.max)} m/s at the listed sites` : 'being checked'}.</span></div>
      <div class="pl-k-row"><span>2 km cells (navigator sky grid) over the region for the current plan's stay, 1 km inside the dashed square around your point. A point you pick is scored at its exact skyline over its own first lit landing window, with ellipse-scale slope and roughness, so it can differ: a narrow ridge (Shackleton's) is smaller than a 2 km cell. Assumed: 3σ ellipse ${ELLIPSE.downrangeM} × ${ELLIPSE.crossrangeM} m, battery and loads.</span></div>
      <div class="pl-k-row"><span class="pl-k-dot pass"></span><span class="pl-k-dot near"></span><span class="pl-k-dot fail"></span><span>listed sites, graded like a pick (click one)</span><span class="pl-k-sw psr"></span><span>permanent shadow (LOLA PSR)</span></div>
      <div class="pl-k-src">Relief: ${res}, light from the upper left.</div>
      <div class="pl-k-short"><span class="pl-k-sw land"></span> landable · <span class="pl-k-sw poss"></span> possible · dots: listed sites graded · ${v.touchdown.maxSlopeDeg}°, ${getStayDays()} d stay, ${battH.toFixed(0)} h battery, ellipse ${ELLIPSE.downrangeM} × ${ELLIPSE.crossrangeM} m (assumed)${prog}</div>`;
  }
  // the side panel before a pick: the listed sites with their grades (click to propose)
  function renderSites() {
    const rows = sites.map((s) => {
      const r = siteRes.get(s.id), g = r?.verdict?.grade;
      const f = (id) => r?.figs?.find((x) => x.id === id);
      const when = r?.landingMs ? ` · stay from ${new Date(r.landingMs).toISOString().slice(5, 10)}` : '';
      return `<tr data-site="${esc(s.id)}"><td>${esc(s.name)}${s.verified === false ? ' <small class="muted">approx.</small>' : ''}<small>${esc(s.subtitle ?? '')}${when}</small></td>
        <td class="r">${f('slope') ? `<span class="g-${f('slope').grade}">${esc(f('slope').text)}</span>` : '…'}</td>
        <td class="r">${f('sun') ? `<span class="g-${f('sun').grade}">${Math.round(f('sun').value * 100)} %</span>` : '…'}</td>
        <td class="r">${g ? `<span class="pl-g g-${g}">${g}</span>` : r?.failed ? '—' : '<span class="muted">scoring</span>'}</td></tr>`;
    }).join('');
    body.innerHTML = `<p class="note">Green ground on the map is where a landing ellipse would pass every check, amber where it would pass near a limit. Click it, a listed site, or type a latitude and longitude to score a point in detail.</p>
      <h3>Known landing sites <small>flown missions and Artemis III candidate regions, scored like a pick: ellipse slope, Sun over a ${getStayDays()}-day stay from each site's first lit window, overall</small></h3>
      <table class="tbl pl-cmp"><thead><tr><th>Site</th><th class="r">Slope</th><th class="r">Sun</th><th class="r">Grade</th></tr></thead><tbody>${rows}</tbody></table>`;
    renderActions();
    body.querySelectorAll('tr[data-site]').forEach((tr) => tr.addEventListener('click', () => { const s = sites.find((q) => q.id === tr.dataset.site); S.cx = toXY(s.latDeg, s.lonDeg)[0]; S.cy = toXY(s.latDeg, s.lonDeg)[1]; S.kmPerPx = Math.min(S.kmPerPx, 0.08); setPick(s.latDeg, s.lonDeg); }));
  }

  // ---------- interaction ----------
  let drag = null; const pts = new Map(); let pinch = null;
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); drag = { x: e.clientX, y: e.clientY, cx: S.cx, cy: S.cy, mlon0: S.mlon0, mlat0: S.mlat0, moved: false }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); } });
  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) zoomBy(d / pinch); pinch = d; drag.moved = true; return; }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    if (S.view === 'polar') { S.cx = drag.cx - dx * S.kmPerPx; S.cy = drag.cy + dy * S.kmPerPx; }
    else { const mz = S.mz || fitMz(); S.mlon0 = drag.mlon0 - dx / mz; S.mlat0 = Math.max(-90, Math.min(90, drag.mlat0 + dy / mz)); }
    draw();
  });
  // cursor read-out: position, height and the terrain level under it, distance and bearing from the current site
  canvas.addEventListener('pointermove', (e) => {
    if (pts.size) return;
    const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    let ll = null;
    if (S.view === 'moon') { const m = moonLL(px, py); if (m.lat !== null) ll = { latDeg: m.lat, lonDeg: m.lon }; } else ll = fromXY(...toMap(px, py));
    if (!ll) { readBox.hidden = true; return; }
    const [x, y] = toXY(ll.latDeg, ll.lonDeg);
    let h = NaN, lvl = '';
    const polar = ll.latDeg <= TERRAIN_MAX_LAT;
    if (polar && L.fine && S.view === 'polar' && S.kmPerPx < 0.06) { h = L.fine(x, y); lvl = 'fine DEM near the pick'; }
    if (!(h === h) && polar && L.dem120) { h = L.dem120.sample(x, y); lvl = 'LOLA 120 m (polar)'; }
    if (!(h === h) && polar && getDem()) { h = getDem().sample(x, y); lvl = 'LOLA 480 m (polar)'; }
    if (!(h === h) && siteCtx?.globe.ready) { const q = siteCtx.sampleInfo(ll.latDeg, ll.lonDeg); h = q[0]; lvl = `LOLA ${q[1]} (global)`; }
    const cur = getCurrent?.(), db = cur ? distanceBearing(cur, ll) : null;
    const lon = ll.lonDeg, lonW = lon > 180 ? ` (${(360 - lon).toFixed(3)}°W)` : '';
    readBox.innerHTML = `<b>${ll.latDeg.toFixed(3)}°, ${lon.toFixed(3)}°E</b> · ${fmtLat(ll.latDeg)} ${fmtLon(lon)}${lonW}<br>${h === h ? `height ${Math.round(h).toLocaleString('en-GB')} m (relative to the 1737.4 km sphere)` : 'height —'} · ${esc(lvl || 'loading terrain')}${db ? `<br>${Math.round(db.km).toLocaleString('en-GB')} km from ${esc(cur.name)}, bearing ${Math.round(db.bearingDeg)}°` : ''}`;
    readBox.hidden = false;
  });
  canvas.addEventListener('pointerleave', () => { readBox.hidden = true; });
  const end = (e) => {
    const wasDrag = drag?.moved;
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
    if (e.type === 'pointerup' && !wasDrag && pts.size === 0) {
      const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      if (S.view === 'moon') {
        const { lat, lon } = moonLL(px, py);
        if (lat === null) return;
        const site = sites.find((q) => Math.hypot(...moonXY(q.latDeg, q.lonDeg).map((v, i) => v - [px, py][i])) < 8);
        setView('polar');
        setPick(site?.latDeg ?? lat, site?.lonDeg ?? lon, { center: true });
      } else {
        // a numbered spot selects it; anywhere else proposes a new point
        const hit = S.results ? S.results.list.findIndex((c, n) => n > 0 && Math.hypot(...toScreen(c.xKm, c.yKm).map((v, i) => v - [px, py][i])) < 11) : -1;
        if (hit > 0) return select(hit);
        const site = sites.find((q) => Math.hypot(...toScreen(...toXY(q.latDeg, q.lonDeg)).map((v, i) => v - [px, py][i])) < 9);
        if (site) return setPick(site.latDeg, site.lonDeg);
        const [x, y] = toMap(px, py);
        const { latDeg, lonDeg } = fromXY(x, y);
        setPick(latDeg, lonDeg);
      }
    }
    if (pts.size === 0) drag = null;
  };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  function zoomBy(f, px = S.w / 2, py = S.h / 2) {
    if (S.view === 'moon') {
      const m = moonLL(px, py); if (m.lat === null) return;
      const mz = S.mz || fitMz();
      S.mz = Math.min(400, Math.max(fitMz(), mz * f));
      let lon = m.lon; const d = (((lon - S.mlon0) % 360) + 540) % 360 - 180; lon = S.mlon0 + d;
      S.mlon0 = lon - (px - S.w / 2) / S.mz; S.mlat0 = Math.max(-90, Math.min(90, m.lat + (py - S.h / 2) / S.mz));
      if (S.mz > 6 && siteCtx?.globe.ready) { const a = moonLL(0, 0), b = moonLL(S.w, S.h); if (a.lat !== null || b.lat !== null) siteCtx.globe.need(G2, Math.max(-90, S.mlat0 - S.h / 2 / S.mz), Math.min(90, S.mlat0 + S.h / 2 / S.mz), S.mlon0 - S.w / 2 / S.mz, S.mlon0 + S.w / 2 / S.mz, { max: 40 }).then((n) => { if (n) { S.baseKey = ''; draw(); } }); }
      draw();
      return;
    }
    const [x, y] = toMap(px, py);
    S.kmPerPx = Math.min(30, Math.max(0.004, S.kmPerPx / f));
    S.cx = x - (px - S.w / 2) * S.kmPerPx; S.cy = y + (py - S.h / 2) * S.kmPerPx;
    draw();
  }
  root.querySelectorAll('[data-z]').forEach((b) => b.addEventListener('click', () => zoomBy(Number(b.dataset.z))));
  root.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  root.querySelector('.pl-go').addEventListener('submit', (e) => {
    e.preventDefault();
    const ll = parseLatLon(root.querySelector('.pl-go input').value);
    if (!ll) return say('Type a latitude and longitude, e.g. 85.4S 35.3E or −85.4, 35.3 or 0.67N 23.47E');
    setView('polar'); setPick(ll.latDeg, ll.lonDeg, { center: true });
  });
  // the planner's actions, one row over the map (the side panel keeps the figures and tables)
  const actBox = root.querySelector('.pl-act');
  function renderActions() {
    const R0 = S.results, c = R0?.list[S.sel];
    const target = c ? (c.site.id === 'custom' ? `${fmtLat(c.latDeg)} ${fmtLon(c.lonDeg)}` : c.site.name) : null;
    const busy = S.pick && !R0;
    actBox.innerHTML = `
      <button class="ab-btn ab-primary" data-a="land" ${c ? '' : 'disabled'} title="${c ? `Plan the whole mission to ${esc(target)} and its first lit landing window` : 'Pick a point first'}">${esc(L0.land)}${c ? `<span class="ab-l">: ${esc(target)}</span>` : ''}</button>
      <button class="ab-btn" data-a="search" ${S.pick && !busy ? '' : 'disabled'} title="Search 15 km around your point again">${busy ? 'Searching…' : 'Find better spots'}</button>
      ${R0 ? `<div class="ab-seg" role="group" aria-label="Candidate">${R0.list.map((x, n) => `<button class="ab-opt" data-n="${n}" aria-pressed="${n === S.sel}" title="${esc(x.name)}: ${esc(x.verdict.text)}">${n === 0 ? 'Yours' : n}<span class="pl-dot g-${x.verdict.grade}"></span></button>`).join('')}</div>` : ''}
      <span class="ab-div" aria-hidden="true"></span>
      <button class="ab-btn" data-a="sites" title="The listed landing sites with their grades">Known sites</button>
      <button class="ab-btn" data-a="close" title="${esc(L0.closeTitle)}">${esc(L0.close)}</button>`;
    actBox.querySelector('[data-a="land"]').addEventListener('click', () => { if (c) { onLand({ site: c.site, landingMs: c.landingMs }); close(); } });
    actBox.querySelector('[data-a="search"]').addEventListener('click', () => { if (S.pick) setPick(S.pick.latDeg, S.pick.lonDeg); });
    actBox.querySelector('[data-a="sites"]').addEventListener('click', () => renderSites());
    actBox.querySelector('[data-a="close"]').addEventListener('click', () => close());
    actBox.querySelectorAll('[data-n]').forEach((b) => b.addEventListener('click', () => select(Number(b.dataset.n))));
  }
  function say(t) { toast.textContent = t; toast.hidden = false; clearTimeout(say.t); say.t = setTimeout(() => { toast.hidden = true; }, 4200); }
  async function setView(v) {
    S.view = v;
    root.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    if (v === 'moon' && !S.g0) { try { S.g0 = await decodePack(await loadData(G0.name, { timeoutMs: 60000 }), G0.width); } catch { say('The whole-Moon terrain (globe_g0) did not load.'); } }
    if (v === 'moon') { siteCtx?.ready().then(() => { S.baseKey = ''; draw(); }); if (!S.mz) { S.mz = fitMz(); const c = getCurrent?.(); S.mlon0 = 0; S.mlat0 = 0; if (c && c.latDeg > -60) { S.mlon0 = c.lonDeg; } } }
    root.querySelector('.pl-names').hidden = v !== 'moon';
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
    renderActions();
    const polar = latDeg <= TERRAIN_MAX_LAT;
    setBody(`<p class="note">${polar ? '' : 'Loading the global LOLA terrain around the point and computing its skyline… '}Searching 15 km around the point for the best landing spots…</p><div class="pl-prog"><i style="width:0%"></i></div>`);
    let stage = 1;
    const res = await ev.evaluate(latDeg, lonDeg, {
      onGrid: (grid) => { if (token === S.token) { S.grid = grid; draw(); } },
      onProgress: (st, f) => {
        if (token !== S.token) return;
        if (st === 2 && stage === 1) { stage = 2; setBody('<p class="note">Scoring the point and the best spots in detail (terrain in the ellipse, sky over the stay, Δv)…</p><div class="pl-prog"><i style="width:0%"></i></div>'); }
        const bar = body.querySelector('.pl-prog i'); if (bar) bar.style.width = `${Math.round(f * 100)}%`;
      },
    });
    if (!res || token !== S.token) return;
    S.results = { list: res.list, limit: res.limit, battH: res.battH, stayDays: res.stayDays };
    renderResults();
    draw();
  }

  // a listed site (or any place) in detail, as the Map's panel scores it (landeval.js)
  const detail = (c, opts) => ev.detail(c, { ...opts, from: S.pick });

  function setBody(html) { body.innerHTML = html; }
  const G = { pass: 'pass', near: 'near', fail: 'fail' };
  function renderResults() {
    const R = S.results, c = R.list[S.sel];
    const fig = (id, x) => x.figs.find((f) => f.id === id);
    const cell = (f) => (f ? `<td class="r g-${G[f.grade]}">${esc(f.text.split(' (')[0].split(' · ')[0])}</td>` : '<td class="r">—</td>');
    body.innerHTML = `
      <div class="pl-point"><b>${esc(c.name)}</b> · ${fmtLat(c.latDeg)} ${fmtLon(c.lonDeg)}${c.distKm ? ` · ${c.distKm.toFixed(1)} km from your point` : ''}<br><span class="muted">landing ${new Date(c.landingMs).toISOString().slice(0, 16).replace('T', ' ')} UTC (first lit window)</span></div>
      <p class="pl-badge ${c.resKm > 0.04 ? 'coarse' : ''}">Terrain ${Math.round(c.resKm * 1000)} m${c.patch ? ' (SLDEM2015 patch)' : ''} · skyline ${c.polar ? 'polar 480 m' : 'computed from the global LOLA terrain'} · ${c.resKm > 0.1 ? 'lander-scale hazards not resolved' : c.resKm > 0.04 ? 'slopes at ~100 m scale, rocks not resolved' : 'lander-scale slopes resolved, rocks not'}</p>
      ${c.polar || c.patch ? '' : `<p class="note pl-fetch">No fine patch here: run <code>node tools/fetch-hires.mjs --at ${c.latDeg.toFixed(3)},${c.lonDeg.toFixed(3)}</code> to fetch one (SLDEM2015 ~59 m between 60°S and 60°N, LOLA polar products near the poles).</p>`}
      <p class="pl-verdict g-${c.verdict.grade}">${esc(c.verdict.text)}</p>
      <ul class="pl-figs">${c.figs.map((f) => `<li class="g-${G[f.grade]}"><div class="pl-f-h"><span>${esc(f.label)}</span><span class="pl-g">${f.grade}</span></div><div class="pl-f-v"><b>${esc(f.text)}</b><span class="muted">limit ${esc(f.limit)}</span></div><small>${esc(f.note)}</small></li>`).join('')}</ul>
      <h3>Better spots nearby <small>the 5 best that pass the hard limits in a 30 × 30 km square around your point, at least 2 km apart, by suitability; same stay and method</small></h3>
      <table class="tbl pl-cmp"><thead><tr><th>#</th><th class="r">km</th><th class="r">Slope</th><th class="r">Sun</th><th class="r">Earth</th><th class="r">Dark</th><th class="r">Δv</th></tr></thead><tbody>
      ${R.list.map((x, n) => `<tr data-n="${n}" class="${n === S.sel ? 'on' : ''}"><td>${n === 0 ? 'You' : n}</td><td class="r">${x.distKm.toFixed(1)}</td>${cell(fig('slope', x))}${cell(fig('sun', x))}${cell(fig('earth', x))}${cell(fig('dark', x))}${cell(fig('dv', x))}</tr>`).join('')}
      </tbody></table>
      <p class="note">Choose a candidate in the bar over the map, a row here or a numbered spot on the map to see its figures; <b>Land here</b> in the bar plans the mission to it. Rocks smaller than the DEM are not modelled; the Δv is from the planned polar orbit with this vehicle (assumed).</p>`;
    body.querySelectorAll('.pl-cmp tr[data-n]').forEach((tr) => tr.addEventListener('click', () => select(Number(tr.dataset.n))));
    renderActions();
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
    if (!S.pick) renderSites();
    renderActions();
    if (!L.slope) loadLayers();
    else if (S.lastFrom !== getFromMs() || R.startMs !== getStayStartMs()) { siteRes.clear(); scoreSites(); startRegion(); }   // the mission moved: redo both
    S.lastFrom = getFromMs();
  }
  function close() { root.hidden = true; opened = false; S.token++; onClose?.(); }
  window.addEventListener('resize', () => { if (opened) resize(); });
  return { open, close, get isOpen() { return opened; }, setPick, state: S, region: R, siteRes };
}
