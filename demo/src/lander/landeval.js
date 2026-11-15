// Where to land, the computation (no DOM): score a proposed landing point and search around it for better spots.
// Shared by the Map's Where to land panel (ui/landcard.js) and the standalone planner page (planner.js).
//   stage 1: suitability on a grid around the point (1 km on the polar data, 2 km on the global terrain), the Sun
//            and the Earth every 4 h over the stay above the skyline (480 m polar DEM, or computed from the global
//            terrain), the navigator's slope and shadow grids
//   stage 2: the point and the eight best that pass, in detail (siteplan.js: terrain in the landing ellipse, sky
//            hourly over the stay, permanent shadow, Δv from the planned orbit); the fine figures re-rank the
//            eight (fewest fails, then fewest near limits, then suitability) and five are kept
// createLandingEvaluator(deps) → { L, loadLayers(), slopeAt, shadowAt, detail(c, opts), evaluate(lat, lon, hooks) }
//   deps: { eph, sites, meta, getDem, hires, siteCtx, getVehicle, getFromMs, getStayDays, getMargin? }
//   evaluate → Promise<{ list: [pick, spot 1…5], grid, limit, battH, stayDays } | null (superseded by a newer call)>
//   hooks: { onGrid(grid), onProgress(stage 1 | 2, fraction) }
//   opts (the screening settings, ui/landcard.js): { minSun, minEarth (0–1, shares of the stay a grid point must reach
//     to pass, besides slope, darkness against the battery and permanent shadow), radiusKm (around a point),
//     cells (grid points over a region), ellipse: { downrangeM, crossrangeM } }
//   evaluateRegion(shape, hooks) → the same search inside a drawn region (polar map km, or latitude/longitude,
//     georegion.js) instead of 15 km around a point: about REGION_CELLS grid points over it, then the eight best in
//     detail, five kept → { list: [spot 1…5], grid, limit, battH, stayDays, region: true }
import { loadData } from '../data-loader.js';
import { createDem, toXY, fromXY, skylineFor, TERRAIN_MAX_LAT } from '../terrain.js';
import { contains as polarContains, bbox as polarBbox } from '../map/shapes.js';
import { isGeo, geoContains, geoOutline } from '../georegion.js';
import { createPsr, PSR_PACK } from '../psr.js';
import { loadSiteTerrain } from './terrain-local.js';
import { pickLandingWindow, skyAt, mapScale, slopeDeg } from './landing.js';
import { distanceBearing } from './skyline.js';
import { planMission } from './mission.js';
import { ellipsePoints, terrainStats, skyDirections, skyStats, batteryHours, figures, verdict, searchGrid, suitability, bestPoints, landableClass } from './siteplan.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const fmtLat = (v) => `${Math.abs(v).toFixed(3)}°${v < 0 ? 'S' : 'N'}`;
const fmtLon = (v) => `${(((v % 360) + 360) % 360).toFixed(3)}°E`;
export const SEARCH_RADIUS_KM = 15;
export const REGION_CELLS = 500;   // grid points screened over a drawn region (the step follows its area)

export function createLandingEvaluator({ eph, sites, meta, getDem, hires = null, siteCtx, getVehicle, getFromMs, getStayDays, getMargin = () => NaN }) {
  // the layers: navigator 1 km and 2 km slope and shadow grids, the LOLA PSR map, the 120 m polar DEM; fine: the
  // finest terrain loaded around the last point scored as "Your point" (the planner shades its relief with it)
  const L = { slope: null, shadow: null, psr: null, dem120: null, fine: null, slope2: null, shadow2: null };
  let loading = null;
  function loadLayers() {
    if (loading) return loading;
    const get = (n) => loadData(n, { timeoutMs: 90000 }).catch(() => null);
    loading = (async () => {
      const [sl, sh, psr, sl2, sh2] = await Promise.all([get('slope_1km'), get('shadow_1km'), get(PSR_PACK), get('slope_2km'), get('shadow_2km')]);
      if (sl) L.slope = { bytes: sl, ...meta.slope?.find((x) => x.name === 'slope_1km') };
      if (sh) L.shadow = { bytes: sh, ...meta.shadow?.find((x) => x.name === 'shadow_1km') };
      if (sl2) L.slope2 = { bytes: sl2, ...meta.slope?.find((x) => x.name === 'slope_2km') };
      if (sh2) L.shadow2 = { bytes: sh2, ...meta.shadow?.find((x) => x.name === 'shadow_2km') };
      try { if (psr) L.psr = createPsr(psr, meta.psr); } catch { L.psr = null; }
      const lv = meta.levels?.find((l) => l.name === 'dem_120m');
      if (lv) {
        const b = await get('dem_120m');
        if (b) L.dem120 = createDem({ data: new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1), size: lv.size, kmPerPixel: lv.kmPerPixel, dnToMeters: lv.dnToMeters, halfKm: lv.halfKm });
      }
      return L;
    })();
    return loading;
  }
  // navigator 1 km grids (±320 km): slope bytes × 0.25 = deg (240 m baseline), shadow bytes = km to the nearest PSR (0 inside)
  const cellOf = (g, x, y) => {
    const size = g.size ?? 640, ck = g.cellKm ?? 1, half = (size * ck) / 2;
    const i = Math.floor((x + half) / ck), j = Math.floor((half - y) / ck);
    return i >= 0 && j >= 0 && i < size && j < size ? j * size + i : -1;
  };
  const slopeAt = (x, y) => { if (!L.slope) return NaN; const k = cellOf(L.slope, x, y); return k < 0 ? NaN : L.slope.bytes[k] * (L.slope.scale ?? 0.25); };
  const shadowAt = (x, y) => { if (!L.shadow) return NaN; const k = cellOf(L.shadow, x, y); return k < 0 ? NaN : L.shadow.bytes[k]; };

  // one place in detail: { site, landingMs, figs, verdict, resKm, polar, skyline, patch, distKm }
  // from: the proposed point, for distKm; fine: keep this place's terrain as L.fine
  async function detail(c, { vehicle, limit, battH, stayDays, fromMs, from = null, fine = false, ellipse = null }) {
    const dem = getDem();
    const polar = c.latDeg <= TERRAIN_MAX_LAT;
    const listed = sites.find((s) => distanceBearing(s, c).km < 0.2);
    const site = { id: listed?.id ?? 'custom', name: listed?.name ?? `${fmtLat(c.latDeg)} ${fmtLon(c.lonDeg)}`, latDeg: c.latDeg, lonDeg: c.lonDeg };
    const xy = Number.isFinite(c.xKm) ? [c.xKm, c.yKm] : toXY(c.latDeg, c.lonDeg);
    let sample, resKm, mask, heightM, psrShare, psrNote, skyline, patch = null;
    const k = mapScale(c.latDeg);
    if (polar) {
      let terr = null;
      try { terr = await loadSiteTerrain(meta, site, { halfKm: 0.6, hires }); } catch { terr = null; }
      resKm = terr?.finestKm ?? 0.12;
      if (fine) L.fine = terr?.sample ?? null;
      sample = terr?.sample ?? ((x, y) => (L.dem120 ?? dem).sample(x, y));
      mask = skylineFor(dem, site); heightM = dem.heightAt(site.latDeg, site.lonDeg) ?? 0; skyline = 'LOLA 480 m polar DEM';
    } else {
      // north of 80°S: the global LOLA terrain around the point, its skyline computed out to 180 km
      const ctx = await siteCtx.context(site);
      sample = ctx.sampleXY; resKm = ctx.resKm; mask = ctx.mask; heightM = ctx.heightM; skyline = ctx.skyline; patch = ctx.patch;
    }
    // sample the ellipse at ≤ 30 m (the slopes still use a two-pixel baseline of the DEM), in ground metres
    const pts = ellipsePoints(xy[0], xy[1], { stepM: Math.min(30, Math.max(5, resKm * 1000)), k, ...(ellipse ?? {}) });
    const t = terrainStats(sample, pts, { baselineKm: Math.max(0.01, 2 * resKm), limitDeg: limit, k });
    if (polar) psrShare = L.psr ? pts.filter(([x, y]) => L.psr.isPsr(x, y)).length / Math.max(1, pts.length) : (shadowAt(xy[0], xy[1]) === 0 ? 1 : 0);
    else if (Math.abs(c.latDeg) < 58) { psrShare = 0; psrNote = 'none: permanent shadow only occurs within about 30° of the poles'; }
    else { psrShare = NaN; psrNote = 'unknown: no permanent-shadow map here (the page has the south polar one)'; }
    const win = pickLandingWindow(eph, site, mask, fromMs);
    const landingMs = win?.tMs ?? fromMs;
    const sky = skyStats(skyDirections(eph, landingMs, stayDays, 1), site, mask, 1);
    const at = skyAt(eph, site, landingMs, mask);
    let budget = null;
    try {
      const plan = planMission({ eph, site, landingMs, vehicle, siteHeightKm: (heightM ?? 0) / 1000, mask });
      if (plan.ok) budget = plan.budget;
    } catch { budget = null; }
    const figs = figures({ t, sky, psrShare, psrNote, budget, earthAtLanding: at ? at.earth.clearDeg > 0 : null, earthWindow: win?.earth ?? true, battH, limitDeg: limit, resKm, stayDays });
    return { site, landingMs, figs, verdict: verdict(figs, { resKm }), resKm, polar, skyline, patch, distKm: from ? distanceBearing(from, c).km : 0 };
  }

  let token = 0;
  // the hard limits of the screen: the navigator's (slope, longest dark against the battery, not in permanent shadow)
  // and the settings' minimum Sun and Earth shares
  const passOk = (q, ok, o) => ok && q.sun >= (o.minSun ?? 0) && q.earth >= (o.minEarth ?? 0);
  async function evaluate(latDeg, lonDeg, { onGrid = () => {}, onProgress = () => {} } = {}, opts = {}) {
    const my = ++token;
    await loadLayers();
    if (my !== token) return null;
    const [x, y] = toXY(latDeg, lonDeg);
    const pick0 = { latDeg, lonDeg, xKm: x, yKm: y };
    const vehicle = getVehicle(), limit = vehicle.touchdown.maxSlopeDeg, battH = batteryHours(vehicle), stayDays = getStayDays();
    const fromMs = getFromMs();
    const dem = getDem();
    const polar = latDeg <= TERRAIN_MAX_LAT;
    // stage 1
    const ctx0 = polar ? null : await siteCtx.context(pick0);
    if (my !== token) return null;
    const mask0 = polar ? skylineFor(dem, pick0) : ctx0.mask;
    const land0 = pickLandingWindow(eph, pick0, mask0, fromMs)?.tMs ?? fromMs;
    const dirs4 = skyDirections(eph, land0, stayDays, 4);
    const k = mapScale(latDeg), stepKm = polar ? 1 : 2;   // ground km; map offsets × k
    const radiusKm = opts.radiusKm ?? SEARCH_RADIUS_KM;
    const grid = searchGrid(x, y, { radiusKm: radiusKm * k, stepKm: stepKm * k }).filter((p) => (polar ? p.latDeg <= TERRAIN_MAX_LAT : true));
    const hb = (radiusKm + stepKm / 2) * k;
    grid.box = { x0: x - hb, x1: x + hb, y0: y - hb, y1: y + hb };
    grid.cellKm = stepKm * k;
    onGrid(grid);
    const margin = getMargin();
    for (let n = 0; n < grid.length; n++) {
      const p = grid[n];
      const sky = skyStats(dirs4, p, polar ? skylineFor(dem, p) : siteCtx.quickMask(p), 4);
      // off the poles: slope over 1 km on the global terrain; no permanent shadow there
      const slope = polar ? slopeAt(p.xKm, p.yKm) : slopeDeg(ctx0.sampleXY, p.xKm, p.yKm, 1, k);
      Object.assign(p, { sun: sky.sun, earth: sky.earth, darkH: sky.longestDarkH, slopeDeg: slope, shadowKm: polar ? shadowAt(p.xKm, p.yKm) : 99 });
      if (n % 24 === 23 || n === grid.length - 1) {
        const done = grid.slice(0, n + 1), s = suitability(done, { limitDeg: limit, battH });
        done.forEach((q, i) => { q.score = s[i].score; q.ok = passOk(q, s[i].ok, opts); q.done = true; q.cls = landableClass({ ...q, marginMs: Number.isFinite(margin) ? margin : 0 }, { limitDeg: limit, battH }); });
        onProgress(1, (n + 1) / grid.length);
        onGrid(grid);
        await tick();
        if (my !== token) return null;
      }
    }
    // stage 2
    const best = bestPoints(grid, { count: 8, minKm: 2 * k * (polar ? 1 : 1.5), avoid: [{ xKm: x, yKm: y }] });
    const pick = { ...pick0, name: 'Your point' };
    const cands = best.map((p) => ({ latDeg: p.latDeg, lonDeg: p.lonDeg, xKm: p.xKm, yKm: p.yKm, score: p.score }));
    const all = [pick, ...cands];
    onProgress(2, 0);
    for (let n = 0; n < all.length; n++) {
      Object.assign(all[n], await detail(all[n], { vehicle, limit, battH, stayDays, fromMs, from: pick0, fine: n === 0, ellipse: opts.ellipse }));
      if (my !== token) return null;
      onProgress(2, (n + 1) / all.length);
      await tick();
    }
    const count = (c, g) => c.figs.filter((f) => f.grade === g).length;
    cands.sort((a, b) => count(a, 'fail') - count(b, 'fail') || count(a, 'near') - count(b, 'near') || b.score - a.score);
    const list = [pick, ...cands.slice(0, 5)];
    list.forEach((c, n) => { if (n) c.name = `Spot ${n}`; });
    return { list, grid, limit, battH, stayDays, radiusKm, screened: grid.length, passed: grid.filter((p) => p.ok).length };
  }
  // ---- inside a drawn region ----
  async function evaluateRegion(shape, { onGrid = () => {}, onProgress = () => {} } = {}, opts = {}) {
    const my = ++token;
    await loadLayers();
    if (my !== token) return null;
    const vehicle = getVehicle(), limit = vehicle.touchdown.maxSlopeDeg, battH = batteryHours(vehicle), stayDays = getStayDays();
    const fromMs = getFromMs();
    const dem = getDem();
    // candidate points: a lat/lon (geo) region on a cos-latitude grid, a polar one on its map-km box, ~REGION_CELLS
    const pts = [];
    let stepKm;
    if (isGeo(shape)) {
      const inside = geoContains(shape), o = geoOutline(shape);
      let la0 = 90, la1 = -90;
      for (const q of o) { la0 = Math.min(la0, q.latDeg); la1 = Math.max(la1, q.latDeg); }
      const lons = o.map((q) => q.lonDeg), c = o[0].lonDeg;
      const rel = lons.map((l) => ((l - c + 540) % 360) - 180);
      const lo0 = c + Math.min(...rel), lo1 = c + Math.max(...rel);
      const midCos = Math.max(0.05, Math.cos(((la0 + la1) / 2) * Math.PI / 180));
      const areaKm2 = (la1 - la0) * 30.32 * (lo1 - lo0) * 30.32 * midCos;
      stepKm = Math.max(2, Math.sqrt(areaKm2 / (opts.cells ?? REGION_CELLS)));
      const dLat = stepKm / 30.32;
      for (let la = la0 + dLat / 2; la < la1; la += dLat) {
        const dLon = dLat / Math.max(0.05, Math.cos((la * Math.PI) / 180));
        for (let lo = lo0 + dLon / 2; lo < lo1; lo += dLon) {
          const lon = ((lo % 360) + 360) % 360;
          if (inside(la, lon)) { const [x, y] = toXY(la, lon); pts.push({ latDeg: la, lonDeg: lon, xKm: x, yKm: y }); }
        }
      }
    } else {
      const b = polarBbox(shape), area = (b.x1 - b.x0) * (b.y1 - b.y0);
      stepKm = Math.max(1, Math.sqrt(area / (opts.cells ?? REGION_CELLS)));
      for (let y = b.y0 + stepKm / 2; y < b.y1; y += stepKm) for (let x = b.x0 + stepKm / 2; x < b.x1; x += stepKm) {
        if (polarContains(shape, x, y)) { const ll = fromXY(x, y); pts.push({ latDeg: ll.latDeg, lonDeg: ll.lonDeg, xKm: x, yKm: y }); }
      }
    }
    if (!pts.length) return { list: [], grid: pts, limit, battH, stayDays, region: true, stepKm };
    pts.cellKm = stepKm;
    onGrid(pts);
    // the global terrain around the region's middle (its tiles serve the skylines and slopes off the pole)
    const mid = pts[Math.floor(pts.length / 2)];
    const anyGlobal = pts.some((p) => p.latDeg > TERRAIN_MAX_LAT);
    if (anyGlobal) { try { await siteCtx.around(mid, Math.min(400, Math.sqrt(pts.length) * stepKm)); } catch { /* coarse tiles stand in */ } }
    if (my !== token) return null;
    const land0 = pickLandingWindow(eph, mid, mid.latDeg <= TERRAIN_MAX_LAT ? skylineFor(dem, mid) : siteCtx.quickMask(mid), fromMs)?.tMs ?? fromMs;
    const dirs4 = skyDirections(eph, land0, stayDays, 4);
    const margin = getMargin();
    // slope off the pole: over 1 km on the global terrain, from heights 0.5 km either side
    const slopeLL = (p) => {
      const h = (la, lo) => siteCtx.sampleLL(la, lo), d = 0.5 / 30.32, dl = d / Math.max(0.05, Math.cos((p.latDeg * Math.PI) / 180));
      const gx = (h(p.latDeg, p.lonDeg + dl) - h(p.latDeg, p.lonDeg - dl)) / 1000, gy = (h(p.latDeg + d, p.lonDeg) - h(p.latDeg - d, p.lonDeg)) / 1000;
      return Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
    };
    for (let n = 0; n < pts.length; n++) {
      const p = pts[n], polar = p.latDeg <= TERRAIN_MAX_LAT;
      const sky = skyStats(dirs4, p, polar ? skylineFor(dem, p) : siteCtx.quickMask(p), 4);
      Object.assign(p, { sun: sky.sun, earth: sky.earth, darkH: sky.longestDarkH, slopeDeg: polar ? slopeAt(p.xKm, p.yKm) : slopeLL(p), shadowKm: polar ? shadowAt(p.xKm, p.yKm) : 99 });
      if (n % 16 === 15 || n === pts.length - 1) {
        const done = pts.slice(0, n + 1), sc = suitability(done, { limitDeg: limit, battH });
        done.forEach((q, i) => { q.score = sc[i].score; q.ok = passOk(q, sc[i].ok, opts); q.done = true; q.cls = landableClass({ ...q, marginMs: Number.isFinite(margin) ? margin : 0 }, { limitDeg: limit, battH }); });
        onProgress(1, (n + 1) / pts.length);
        await tick();
        if (my !== token) return null;
      }
    }
    // the eight best that pass, apart by two grid steps (in map km at their latitude), in detail; five kept
    const best = bestPoints(pts.map((p) => ({ ...p, xKm: p.xKm / mapScale(p.latDeg), yKm: p.yKm / mapScale(p.latDeg) })), { count: 8, minKm: 2 * stepKm });
    const cands = best.map((p) => ({ latDeg: p.latDeg, lonDeg: p.lonDeg, xKm: toXY(p.latDeg, p.lonDeg)[0], yKm: toXY(p.latDeg, p.lonDeg)[1], score: p.score }));
    onProgress(2, 0);
    for (let n = 0; n < cands.length; n++) {
      Object.assign(cands[n], await detail(cands[n], { vehicle, limit, battH, stayDays, fromMs, ellipse: opts.ellipse }));
      if (my !== token) return null;
      onProgress(2, (n + 1) / cands.length);
      await tick();
    }
    const count = (c, g) => c.figs.filter((f) => f.grade === g).length;
    cands.sort((a, b) => count(a, 'fail') - count(b, 'fail') || count(a, 'near') - count(b, 'near') || b.score - a.score);
    const list = cands.slice(0, 5);
    list.forEach((c, n) => { c.name = `Spot ${n + 1}`; c.distKm = 0; });
    return { list, grid: pts, limit, battH, stayDays, region: true, stepKm, screened: pts.length, passed: pts.filter((p) => p.ok).length };
  }

  const cancel = () => { token++; };

  return { L, loadLayers, slopeAt, shadowAt, detail, evaluate, evaluateRegion, cancel };
}
