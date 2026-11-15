// Where to land, the computation (no DOM): score a proposed landing point and search around it for better spots.
// Shared by the Map's Where to land panel (ui/landcard.js) and the standalone planner page (planner.js).
//   stage 1: suitability on a grid around the point (1 km on the polar data, 2 km on the global terrain), the Sun
//            and the Earth every 4 h over the stay above the skyline (480 m polar DEM, or computed from the global
//            terrain), the navigator's slope and shadow grids
//   stage 2: the point and the eight best that pass, in detail (siteplan.js: terrain in the landing ellipse, sky
//            hourly over the stay, permanent shadow, Δv from the planned orbit); the fine figures re-rank the
//            eight (fewest fails, then fewest near limits, then suitability) and five are kept
// createLandingEvaluator(deps) → { L, loadLayers(), slopeAt, shadowAt, detail(c, opts), evaluate(lat, lon, hooks) }
//   deps: { eph, sites, meta, getDem, hires, siteCtx, getVehicle, getFromMs, getStayDays, getMargin?, getLandingMs?,
//     getWeights? }
//   getLandingMs → the mission's planned landing (ms) or NaN: when there is one, the grid is screened over the stay
//     from it and each spot lands in its first lit window within PLAN_SLACK_DAYS of it (or at the planned time when
//     it has none there), so the spots compare the landing the user is planning (audit L1); each spot's own first lit
//     window, however far, is given beside it (ownLandingMs). Without one, each place's first lit window from
//     getFromMs, as before
//   getWeights → the suitability weights (the Map's Suitability mode; score.js DEFAULT_WEIGHTS when undefined; L3)
//   evaluate → Promise<{ list: [pick, spot 1…5], grid, limit, battH, stayDays, funnel, relaxed, planned } | null
//     (superseded by a newer call)>
//   funnel: how the grid fell through the hard limits { screened, slopeOk, notPsr, darkOk, usable, sharesOk, passed,
//     minDarkH }; when fewer than eight pass, the nearest misses on usable ground (slope and permanent shadow pass,
//     shortest dark spell first) fill the detail list, marked relaxed, so an empty screen still says what it would take
//   hooks: { onGrid(grid), onProgress(stage 1 | 2, fraction) }
//   opts (the screening settings, ui/landcard.js): { minSun, minEarth (0–1, shares of the stay a grid point must reach
//     to pass, besides slope, darkness against the battery and permanent shadow), radiusKm (around a point),
//     cells (grid points over a region), ellipse: { downrangeM, crossrangeM }, slipDays (slip robustness: the stay
//     from each day up to this many days after the landing is checked too; 0 = off) }
//   slip robustness: on the screen each grid point gets `robust`, the share of those landing days on which it still
//     passes (the dark limit and the minimum shares), and the detail picks the most robust first, then suitability;
//     the detail adds the figure "Landing up to N days late" (hourly, against the battery)
//   landing safety: the detail scatters MC_LANDINGS touchdowns about each place (2-D Gaussian, 3σ = the ellipse) and
//     counts those on ground within the slope limit and outside permanent shadow (siteplan.js touchdownMC)
//   evaluateRegion(shape, hooks) → the same search inside a drawn region (polar map km, or latitude/longitude,
//     georegion.js) instead of around a point: about REGION_CELLS grid points over it plus the listed sites inside it,
//     then the eight best in detail (spaced by great-circle distance), five kept → { list: [spot 1…5], grid, limit,
//     battH, stayDays, region: true, funnel, relaxed, planned }
import { loadData } from '../data-loader.js';
import { createDem, toXY, fromXY, skylineFor, TERRAIN_MAX_LAT } from '../terrain.js';
import { contains as polarContains, bbox as polarBbox } from '../map/shapes.js';
import { isGeo, geoContains, geoOutline } from '../georegion.js';
import { createPsr, PSR_PACK } from '../psr.js';
import { loadSiteTerrain } from './terrain-local.js';
import { pickLandingWindow, skyAt, mapScale, slopeDeg } from './landing.js';
import { distanceBearing } from './skyline.js';
import { planMission } from './mission.js';
import { ELLIPSE, ellipsePoints, terrainStats, skyDirections, skySeries, windowStats, slipStats, touchdownMC, batteryHours, figures, verdict, searchGrid, suitability, bestPoints, landableClass } from './siteplan.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const fmtLat = (v) => `${Math.abs(v).toFixed(3)}°${v < 0 ? 'S' : 'N'}`;
const fmtLon = (v) => `${(((v % 360) + 360) % 360).toFixed(3)}°E`;
export const SEARCH_RADIUS_KM = 15;
export const REGION_CELLS = 500;   // grid points screened over a drawn region (the step follows its area)
const SKY_STEP_H = 4;               // the screen's sky sampling: its dark spells are whole multiples of this
const DETAIL_COUNT = 8;             // places scored in detail (five kept)
const PLAN_SLACK_DAYS = 2;          // with a planned landing, each place lands in its first lit window this close to it
const MC_LANDINGS = 2000;           // Monte Carlo touchdowns per place in the detail

export function createLandingEvaluator({ eph, sites, meta, getDem, hires = null, siteCtx, getVehicle, getFromMs, getStayDays, getMargin = () => NaN, getLandingMs = () => NaN, getWeights = () => undefined }) {
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
      // without the slope and shadow grids every polar point would fail the hard limits: say so, and load again on
      // the next search instead of keeping the failure for the session (audit L11)
      if (!L.slope || !L.shadow) {
        loading = null;
        throw new Error(`the ${!L.slope ? 'slope' : 'shadow'} grid did not load (check the connection, then Start screening again)`);
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
  async function detail(c, { vehicle, limit, battH, stayDays, fromMs, from = null, fine = false, ellipse = null, slipDays = 0 }) {
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
    // sample the ellipse at ≤ 30 m (each slope from heights one DEM pixel either side: over two pixels, as the
    // figure says; audit L4), in ground metres
    const pts = ellipsePoints(xy[0], xy[1], { stepM: Math.min(30, Math.max(5, resKm * 1000)), k, ...(ellipse ?? {}) });
    const t = terrainStats(sample, pts, { baselineKm: Math.max(0.005, resKm), limitDeg: limit, k });
    if (polar) psrShare = L.psr ? pts.filter(([x, y]) => L.psr.isPsr(x, y)).length / Math.max(1, pts.length) : (shadowAt(xy[0], xy[1]) === 0 ? 1 : 0);
    else if (Math.abs(c.latDeg) < 58) { psrShare = 0; psrNote = 'none: permanent shadow only occurs within about 30° of the poles'; }
    else { psrShare = NaN; psrNote = 'unknown: no permanent-shadow map here (the page has the south polar one)'; }
    const win = pickLandingWindow(eph, site, mask, fromMs);
    const plan = planMs();
    // (the search runs on past the slack by the window's 48 h hold, so a window may start up to the slack's end)
    const near = Number.isFinite(plan) ? pickLandingWindow(eph, site, mask, plan - PLAN_SLACK_DAYS * 86400e3, { maxDays: 2 * PLAN_SLACK_DAYS + 2 }) : null;
    const landingMs = Number.isFinite(plan) ? near?.tMs ?? plan : win?.tMs ?? fromMs;
    const lit = Number.isFinite(plan) ? near : win;
    // hourly over the stay, and on past it by the slip window: the stay from each later landing day too
    const ser = skySeries(skyDirections(eph, landingMs, stayDays + slipDays, 1), site, mask);
    const sky = windowStats(ser, 0, Math.round(stayDays * 24), 1);
    let slip = null;
    if (slipDays > 0) {
      const wins = slipStats(ser, { stepH: 1, stayH: stayDays * 24, slipDays });
      slip = { days: slipDays, total: wins.length, passed: wins.filter((w) => w.longestDarkH <= battH).length, worstDarkH: Math.max(0, ...wins.map((w) => w.longestDarkH)) };
    }
    // Monte Carlo touchdowns in the ellipse: slope (over the same two-pixel baseline) and permanent shadow
    const mc = touchdownMC(xy[0], xy[1], {
      sample, k, n: MC_LANDINGS, baselineKm: Math.max(0.005, resKm), limitDeg: limit,
      downrangeM: ellipse?.downrangeM ?? ELLIPSE.downrangeM, crossrangeM: ellipse?.crossrangeM ?? ELLIPSE.crossrangeM,
      isPsr: polar && L.psr ? (x, y) => L.psr.isPsr(x, y) : null,
    });
    const at = skyAt(eph, site, landingMs, mask);
    let budget = null;
    try {
      const plan = planMission({ eph, site, landingMs, vehicle, siteHeightKm: (heightM ?? 0) / 1000, mask });
      if (plan.ok) budget = plan.budget;
    } catch { budget = null; }
    const figs = figures({ t, sky, psrShare, psrNote, budget, earthAtLanding: at ? at.earth.clearDeg > 0 : null, earthWindow: lit?.earth ?? true, battH, limitDeg: limit, resKm, stayDays, mc, slip });
    return { site, landingMs, ownLandingMs: win?.tMs ?? null, figs, verdict: verdict(figs, { resKm }), resKm, polar, skyline, patch, distKm: from ? distanceBearing(from, c).km : 0 };
  }

  // the landing time screened: the planned one when the mission has it, else NaN (each place's first lit window)
  const planMs = () => { const t = getLandingMs(); return Number.isFinite(t) ? t : NaN; };
  // the stage-1 pass marks with the user's weights; the dark limit gets one sky step of slack, since the screen's
  // dark spells are whole multiples of it (a 9.5 h night reads 8 or 12 h): the hourly detail decides (audit L6)
  const screenMarks = (pts, limit, battH) => suitability(pts, { limitDeg: limit, battH: battH + SKY_STEP_H, weights: getWeights() });
  // how the grid fell through the hard limits (the card explains an empty or thin screen with it)
  function funnel(pts, { limit, battH, opts, slipDays = 0 }) {
    const slopeOk = (p) => p.slopeDeg <= limit, notPsr = (p) => p.shadowKm !== 0;
    const usable = pts.filter((p) => slopeOk(p) && notPsr(p));
    const darks = usable.map((p) => p.darkH).filter(Number.isFinite);
    return {
      screened: pts.length, slopeOk: pts.filter(slopeOk).length, notPsr: pts.filter(notPsr).length,
      darkOk: pts.filter((p) => p.darkH <= battH + SKY_STEP_H).length, usable: usable.length,
      sharesOk: pts.filter((p) => p.sun >= (opts.minSun ?? 0) && p.earth >= (opts.minEarth ?? 0)).length,
      passed: pts.filter((p) => p.ok).length, minDarkH: darks.length ? Math.min(...darks) : NaN, stepH: SKY_STEP_H,
      // passing on the planned day and on every day of the slip window
      robustAll: pts.filter((p) => p.ok && (slipDays > 0 ? p.robust === 1 : true)).length, slipDays,
    };
  }
  // the places for the detail: the best that pass; when fewer than DETAIL_COUNT do, the nearest misses on usable ground
  // (slope and permanent shadow pass, the dark spell or a minimum share does not), shortest dark spell first, marked
  // relaxed: an empty list told the user nothing about what it would take
  function detailPicks(pts, { limit, minKm, avoid = [], dist, slipDays = 0 }) {
    // with a slip window, the most robust first (the share of landing days that still pass), then suitability
    const by = slipDays > 0 ? (a, b) => (b.robust ?? 0) - (a.robust ?? 0) || b.score - a.score : undefined;
    const best = bestPoints(pts, { count: DETAIL_COUNT, minKm, avoid, dist, by });
    const more = bestPoints(pts, {
      count: DETAIL_COUNT - best.length, minKm, avoid: [...avoid, ...best], dist,
      pass: (p) => !p.ok && p.slopeDeg <= limit && p.shadowKm !== 0 && Number.isFinite(p.darkH),
      by: (a, b) => a.darkH - b.darkH || b.score - a.score,
    });
    return [...best, ...more.map((p) => ({ ...p, relaxed: true }))];
  }

  // stage 1's sky at one grid point: the stay from the landing (4-hourly), and with a slip window the share of landing
  // days, from the landing to slipDays later, on which the point still passes the dark limit and the minimum shares
  function screenSky(dirs, p, mask, { stayDays, slipDays, battH, opts }) {
    const ser = skySeries(dirs, p, mask);
    const w = windowStats(ser, 0, Math.round((stayDays * 24) / SKY_STEP_H), SKY_STEP_H);
    const out = { sun: w.sun, earth: w.earth, darkH: w.longestDarkH };
    if (slipDays > 0) {
      const wins = slipStats(ser, { stepH: SKY_STEP_H, stayH: stayDays * 24, slipDays });
      const ok = (x) => x.longestDarkH <= battH + SKY_STEP_H && x.sun >= (opts.minSun ?? 0) && x.earth >= (opts.minEarth ?? 0);
      out.robust = wins.length ? wins.filter(ok).length / wins.length : 0;
    }
    return out;
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
    const plan = planMs();
    const land0 = Number.isFinite(plan) ? plan : pickLandingWindow(eph, pick0, mask0, fromMs)?.tMs ?? fromMs;
    const slipDays = Math.max(0, Math.round(opts.slipDays ?? 0));
    const dirs4 = skyDirections(eph, land0, stayDays + slipDays, SKY_STEP_H);
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
      const sky = screenSky(dirs4, p, polar ? skylineFor(dem, p) : siteCtx.quickMask(p), { stayDays, slipDays, battH, opts });
      // off the poles: slope over 1 km on the global terrain; no permanent shadow there
      const slope = polar ? slopeAt(p.xKm, p.yKm) : slopeDeg(ctx0.sampleXY, p.xKm, p.yKm, 1, k);
      Object.assign(p, sky, { slopeDeg: slope, shadowKm: polar ? shadowAt(p.xKm, p.yKm) : 99 });
      if (n % 24 === 23 || n === grid.length - 1) {
        const done = grid.slice(0, n + 1), s = screenMarks(done, limit, battH);
        done.forEach((q, i) => { q.score = s[i].score; q.ok = passOk(q, s[i].ok, opts); q.done = true; q.cls = landableClass({ ...q, marginMs: Number.isFinite(margin) ? margin : 0 }, { limitDeg: limit, battH }); });
        onProgress(1, (n + 1) / grid.length);
        onGrid(grid);
        await tick();
        if (my !== token) return null;
      }
    }
    // stage 2
    const best = detailPicks(grid, { limit, minKm: 2 * k * (polar ? 1 : 1.5), avoid: [{ xKm: x, yKm: y }], slipDays });
    const pick = { ...pick0, name: 'Your point' };
    const cands = best.map((p) => ({ latDeg: p.latDeg, lonDeg: p.lonDeg, xKm: p.xKm, yKm: p.yKm, score: p.score, relaxed: !!p.relaxed }));
    const all = [pick, ...cands];
    onProgress(2, 0);
    for (let n = 0; n < all.length; n++) {
      Object.assign(all[n], await detail(all[n], { vehicle, limit, battH, stayDays, fromMs, from: pick0, fine: n === 0, ellipse: opts.ellipse, slipDays }));
      if (my !== token) return null;
      onProgress(2, (n + 1) / all.length);
      await tick();
    }
    const count = (c, g) => c.figs.filter((f) => f.grade === g).length;
    cands.sort((a, b) => count(a, 'fail') - count(b, 'fail') || count(a, 'near') - count(b, 'near') || b.score - a.score);
    const list = [pick, ...cands.slice(0, 5)];
    list.forEach((c, n) => { if (n) c.name = `Spot ${n}`; });
    const fun = funnel(grid, { limit, battH, opts, slipDays });
    return { list, grid, limit, battH, stayDays, radiusKm, screened: grid.length, passed: fun.passed, funnel: fun, relaxed: list.filter((c) => c.relaxed).length, planned: Number.isFinite(plan), slipDays };
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
    const geo = isGeo(shape), inGeo = geo ? geoContains(shape) : null;
    if (geo) {
      const inside = inGeo, o = geoOutline(shape);
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
    // the listed sites inside the region are screened as well (a grid step of kilometres can miss a narrow lit ridge)
    for (const s of sites) {
      if (!Number.isFinite(s.latDeg) || !Number.isFinite(s.lonDeg)) continue;
      const lon = ((s.lonDeg % 360) + 360) % 360, [x, y] = toXY(s.latDeg, lon);
      if (geo ? inGeo(s.latDeg, lon) : polarContains(shape, x, y)) pts.push({ latDeg: s.latDeg, lonDeg: lon, xKm: x, yKm: y, listed: s.name });
    }
    const plan = planMs();
    if (!pts.length) return { list: [], grid: pts, limit, battH, stayDays, region: true, stepKm, planned: Number.isFinite(plan) };
    pts.cellKm = stepKm;
    onGrid(pts);
    // the global terrain around the region's middle (its tiles serve the skylines and slopes off the pole)
    const mid = pts[Math.floor(pts.length / 2)];
    const anyGlobal = pts.some((p) => p.latDeg > TERRAIN_MAX_LAT);
    if (anyGlobal) { try { await siteCtx.around(mid, Math.min(400, Math.sqrt(pts.length) * stepKm)); } catch { /* coarse tiles stand in */ } }
    if (my !== token) return null;
    // the planned landing; without one, the first lit window of the region's middle point
    const land0 = Number.isFinite(plan) ? plan : pickLandingWindow(eph, mid, mid.latDeg <= TERRAIN_MAX_LAT ? skylineFor(dem, mid) : siteCtx.quickMask(mid), fromMs)?.tMs ?? fromMs;
    const slipDays = Math.max(0, Math.round(opts.slipDays ?? 0));
    const dirs4 = skyDirections(eph, land0, stayDays + slipDays, SKY_STEP_H);
    const margin = getMargin();
    // slope off the pole: over 1 km on the global terrain, from heights 0.5 km either side
    const slopeLL = (p) => {
      const h = (la, lo) => siteCtx.sampleLL(la, lo), d = 0.5 / 30.32, dl = d / Math.max(0.05, Math.cos((p.latDeg * Math.PI) / 180));
      const gx = (h(p.latDeg, p.lonDeg + dl) - h(p.latDeg, p.lonDeg - dl)) / 1000, gy = (h(p.latDeg + d, p.lonDeg) - h(p.latDeg - d, p.lonDeg)) / 1000;
      return Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
    };
    for (let n = 0; n < pts.length; n++) {
      const p = pts[n], polar = p.latDeg <= TERRAIN_MAX_LAT;
      const sky = screenSky(dirs4, p, polar ? skylineFor(dem, p) : siteCtx.quickMask(p), { stayDays, slipDays, battH, opts });
      Object.assign(p, sky, { slopeDeg: polar ? slopeAt(p.xKm, p.yKm) : slopeLL(p), shadowKm: polar ? shadowAt(p.xKm, p.yKm) : 99 });
      if (n % 16 === 15 || n === pts.length - 1) {
        const done = pts.slice(0, n + 1), sc = screenMarks(done, limit, battH);
        done.forEach((q, i) => { q.score = sc[i].score; q.ok = passOk(q, sc[i].ok, opts); q.done = true; q.cls = landableClass({ ...q, marginMs: Number.isFinite(margin) ? margin : 0 }, { limitDeg: limit, battH }); });
        onProgress(1, (n + 1) / pts.length);
        await tick();
        if (my !== token) return null;
      }
    }
    // the eight best that pass (or the nearest misses), two grid steps apart on the ground (great circle: map km over
    // the map scale squeezed north–south distances by |sin latitude|, audit L2), in detail; five kept
    const best = detailPicks(pts, { limit, minKm: 2 * stepKm, dist: (a, b) => distanceBearing(a, b).km, slipDays });
    const cands = best.map((p) => ({ latDeg: p.latDeg, lonDeg: p.lonDeg, xKm: p.xKm, yKm: p.yKm, score: p.score, relaxed: !!p.relaxed }));
    onProgress(2, 0);
    for (let n = 0; n < cands.length; n++) {
      Object.assign(cands[n], await detail(cands[n], { vehicle, limit, battH, stayDays, fromMs, ellipse: opts.ellipse, slipDays }));
      if (my !== token) return null;
      onProgress(2, (n + 1) / cands.length);
      await tick();
    }
    const count = (c, g) => c.figs.filter((f) => f.grade === g).length;
    cands.sort((a, b) => count(a, 'fail') - count(b, 'fail') || count(a, 'near') - count(b, 'near') || b.score - a.score);
    const list = cands.slice(0, 5);
    list.forEach((c, n) => { c.name = `Spot ${n + 1}`; c.distKm = 0; });
    const fun = funnel(pts, { limit, battH, opts, slipDays });
    return { list, grid: pts, limit, battH, stayDays, region: true, stepKm, screened: pts.length, passed: fun.passed, funnel: fun, relaxed: list.filter((c) => c.relaxed).length, planned: Number.isFinite(plan), slipDays };
  }

  const cancel = () => { token++; };

  return { L, loadLayers, slopeAt, shadowAt, detail, evaluate, evaluateRegion, cancel };
}
