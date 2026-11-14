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
import { ELLIPSE, ellipsePoints, terrainStats, skyDirections, skyStats, batteryHours, figures, verdict, searchGrid, suitability, bestPoints, landableClass, LANDABLE } from './siteplan.js';
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

export function createPlanner({ doc = document, root, eph, sites, meta, getDem, hires, getVehicle, getFromMs, getStayDays, getStayStartMs, getCurrent, onLand }) {
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
  const L = { slope: null, shadow: null, psr: null, dem120: null, fine: null, slope2: null, shadow2: null };
  // where landing is possible over the whole region (2 km cells): navigator sky grid + its slope and shadow grids
  const R = { grid: null, job: null, cls: null, img: null, startMs: 0, endMs: 0, progress: 0, token: 0 };
  // the listed sites scored like a pick: id → { verdict, figs, landingMs, pending }
  const siteRes = new Map();
  let opened = false;

  // ---------- data ----------
  async function loadLayers() {
    const get = (n) => loadData(n, { timeoutMs: 90000 }).catch(() => null);
    const [sl, sh, psr, sl2, sh2] = await Promise.all([get('slope_1km'), get('shadow_1km'), get(PSR_PACK), get('slope_2km'), get('shadow_2km')]);
    if (sl) L.slope = { bytes: sl, ...meta.slope?.find((x) => x.name === 'slope_1km') };
    if (sh) L.shadow = { bytes: sh, ...meta.shadow?.find((x) => x.name === 'shadow_1km') };
    if (sl2) L.slope2 = { bytes: sl2, ...meta.slope?.find((x) => x.name === 'slope_2km') };
    if (sh2) L.shadow2 = { bytes: sh2, ...meta.shadow?.find((x) => x.name === 'shadow_2km') };
    startRegion();
    scoreSites();
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
    body.querySelectorAll('tr[data-site]').forEach((tr) => tr.addEventListener('click', () => { const s = sites.find((q) => q.id === tr.dataset.site); S.cx = toXY(s.latDeg, s.lonDeg)[0]; S.cy = toXY(s.latDeg, s.lonDeg)[1]; S.kmPerPx = Math.min(S.kmPerPx, 0.08); setPick(s.latDeg, s.lonDeg); }));
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
        const site = sites.find((q) => Math.hypot(...toScreen(...toXY(q.latDeg, q.lonDeg)).map((v, i) => v - [px, py][i])) < 9);
        if (site) return setPick(site.latDeg, site.lonDeg);
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
    grid.box = { x0: x - 15.5, x1: x + 15.5, y0: y - 15.5, y1: y + 15.5 };
    S.grid = grid;
    const margin = siteMargins().min;
    for (let k = 0; k < grid.length; k++) {
      const p = grid[k];
      const sky = skyStats(dirs4, p, skylineFor(dem, p), 4);
      Object.assign(p, { sun: sky.sun, earth: sky.earth, darkH: sky.longestDarkH, slopeDeg: slopeAt(p.xKm, p.yKm), shadowKm: shadowAt(p.xKm, p.yKm) });
      if (k % 24 === 23 || k === grid.length - 1) {
        const done = grid.slice(0, k + 1), s = suitability(done, { limitDeg: limit, battH });
        done.forEach((q, n) => { q.score = s[n].score; q.ok = s[n].ok; q.done = true; q.cls = landableClass({ ...q, marginMs: Number.isFinite(margin) ? margin : 0 }, { limitDeg: limit, battH }); });
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
      <p class="note">Click a row or a numbered spot on the map to see its figures. Rocks smaller than the DEM are not modelled; Sun and Earth use the 480 m skyline; the Δv is from the planned polar orbit with this vehicle (assumed).</p>
      <button class="btn ghost pl-sites">Known landing sites…</button>`;
    body.querySelectorAll('.pl-cmp tr[data-n]').forEach((tr) => tr.addEventListener('click', () => select(Number(tr.dataset.n))));
    body.querySelector('.pl-land').addEventListener('click', () => { onLand({ site: c.site, landingMs: c.landingMs }); close(); });
    body.querySelector('.pl-sites').addEventListener('click', () => renderSites());
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
    if (!L.slope) loadLayers();
    else if (S.lastFrom !== getFromMs() || R.startMs !== getStayStartMs()) { siteRes.clear(); scoreSites(); startRegion(); }   // the mission moved: redo both
    S.lastFrom = getFromMs();
  }
  function close() { root.hidden = true; opened = false; S.token++; }
  window.addEventListener('resize', () => { if (opened) resize(); });
  return { open, close, get isOpen() { return opened; }, setPick, state: S, region: R, siteRes };
}
