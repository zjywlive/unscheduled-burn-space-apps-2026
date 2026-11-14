// Choosing where to land (pure computation, no DOM): the landing ellipse around a point, the terrain inside it,
// Sun and Earth above the real skyline over the stay, the longest dark spell against the battery, permanent
// shadow, and a grid search around a pick ranked with the navigator's suitability score (score.js).
// Map coordinates are the polar-stereographic km of terrain.js; heights in metres.
import { azEl } from '../geometry.js';
import { toXY, fromXY } from '../terrain.js';
import { scoreCells, passes, DEFAULT_WEIGHTS } from '../score.js';
import { slopeDeg } from './landing.js';

// Assumed 3σ landing dispersion with terrain-relative navigation: 150 m down-range × 100 m cross-range.
// A polar orbit passes over the pole, so near it the descent runs along the meridian: down-range is radial on
// the polar map.
export const ELLIPSE = Object.freeze({ downrangeM: 150, crossrangeM: 100 });

// Map points (km) inside the ellipse centred on (x, y), on a grid of stepM.
export function ellipsePoints(xKm, yKm, { downrangeM = ELLIPSE.downrangeM, crossrangeM = ELLIPSE.crossrangeM, stepM = 20 } = {}) {
  const r = Math.hypot(xKm, yKm);
  const u = r > 1e-9 ? [xKm / r, yKm / r] : [0, 1];   // down-range (radial)
  const v = [-u[1], u[0]];                              // cross-range
  const a = downrangeM / 1000, b = crossrangeM / 1000, s = stepM / 1000;
  const out = [];
  for (let i = -Math.floor(a / s); i <= Math.floor(a / s); i++) {
    for (let j = -Math.floor(b / s); j <= Math.floor(b / s); j++) {
      const p = i * s, q = j * s;
      if ((p * p) / (a * a) + (q * q) / (b * b) > 1) continue;
      out.push([xKm + p * u[0] + q * v[0], yKm + p * u[1] + q * v[1]]);
    }
  }
  return out;
}

// Terrain inside the ellipse: slopes over baselineKm (share over the lander's limit, mean, 95th percentile) and
// roughness (RMS of heights about the best-fit plane, m) at the DEM's scale. Rocks are below every DEM here.
export function terrainStats(sample, pts, { baselineKm = 0.04, limitDeg = 10 } = {}) {
  const sl = [], hs = [];
  for (const [x, y] of pts) {
    const s = slopeDeg(sample, x, y, baselineKm);
    if (Number.isFinite(s)) sl.push(s);
    const h = sample(x, y);
    if (Number.isFinite(h)) hs.push([x * 1000, y * 1000, h]);
  }
  if (!sl.length) return { n: 0, overLimit: NaN, meanDeg: NaN, p95Deg: NaN, roughM: NaN };
  sl.sort((p, q) => p - q);
  const over = sl.filter((s) => s > limitDeg).length / sl.length;
  return { n: sl.length, overLimit: over, meanDeg: sl.reduce((p, q) => p + q, 0) / sl.length, p95Deg: sl[Math.min(sl.length - 1, Math.floor(0.95 * sl.length))], roughM: planeRms(hs) };
}

// RMS distance of points (x, y, h) from their least-squares plane h = a + b x + c y.
export function planeRms(pts) {
  const n = pts.length;
  if (n < 4) return NaN;
  let mx = 0, my = 0, mh = 0;
  for (const [x, y, h] of pts) { mx += x; my += y; mh += h; }
  mx /= n; my /= n; mh /= n;
  let sxx = 0, syy = 0, sxy = 0, sxh = 0, syh = 0;
  for (const [x0, y0, h0] of pts) {
    const x = x0 - mx, y = y0 - my, h = h0 - mh;
    sxx += x * x; syy += y * y; sxy += x * y; sxh += x * h; syh += y * h;
  }
  const det = sxx * syy - sxy * sxy;
  const b = det ? (sxh * syy - syh * sxy) / det : 0, c = det ? (syh * sxx - sxh * sxy) / det : 0;
  let ss = 0;
  for (const [x0, y0, h0] of pts) { const r = h0 - mh - b * (x0 - mx) - c * (y0 - my); ss += r * r; }
  return Math.sqrt(ss / n);
}

// Sun and Earth directions over the stay, once for all points: [{ tMs, sun, earth, earthRangeKm }].
export function skyDirections(eph, startMs, days, stepH = 1) {
  const out = [];
  const n = Math.max(1, Math.round((days * 24) / stepH));
  for (let i = 0; i < n; i++) {
    const t = startMs + (i + 0.5) * stepH * 3600e3;
    const d = eph.at(t);
    if (d) out.push({ tMs: t, ...d });
  }
  return out;
}

// Over those directions at one place with its skyline mask (az → deg): shares of time with the Sun / the Earth
// above the skyline, and the longest spells without each (hours).
export function skyStats(dirs, site, mask, stepH = 1) {
  const m = typeof mask === 'function' ? mask : () => mask ?? 0;
  let s = 0, e = 0, b = 0, run = 0, longest = 0, runE = 0, longestE = 0;
  for (const d of dirs) {
    const su = azEl(d.sun, Infinity, site.lonDeg, site.latDeg), ea = azEl(d.earth, d.earthRangeKm, site.lonDeg, site.latDeg);
    const sun = su.elDeg > m(su.azDeg), earth = ea.elDeg > m(ea.azDeg);
    if (sun) { s++; run = 0; } else if (++run > longest) longest = run;
    if (earth) { e++; runE = 0; } else if (++runE > longestE) longestE = runE;
    if (sun && earth) b++;
  }
  const n = dirs.length || 1;
  return { sun: s / n, earth: e / n, both: b / n, longestDarkH: longest * stepH, longestNoEarthH: longestE * stepH, hours: dirs.length * stepH };
}

// Hours the battery carries the surface load through darkness (usable share above the minimum state of charge).
export const batteryHours = (vehicle) => (vehicle.batteryWh * (1 - vehicle.batteryMinSoc)) / Math.max(1, vehicle.loadsW.surface);

// One figure graded against its limits: 'pass' | 'near' | 'fail'. higher: true when more is better.
export function grade(value, { pass, near, higher = false }) {
  if (!Number.isFinite(value)) return 'fail';
  if (higher) return value >= pass ? 'pass' : value >= near ? 'near' : 'fail';
  return value <= pass ? 'pass' : value <= near ? 'near' : 'fail';
}

// The figures for one place, each { id, label, value, text, limit, grade, note }.
// t: terrainStats; sky: skyStats; psrShare: share of the ellipse in permanent shadow; budget: plan budget or null;
// earthAtLanding: boolean; battH: batteryHours; res: DEM km per pixel used for the slopes.
export function figures({ t, sky, psrShare, budget = null, earthAtLanding = null, battH, limitDeg, resKm, stayDays }) {
  const pct = (x) => `${Math.round(x * 100)} %`;
  const out = [];
  const add = (id, label, value, text, limit, g, note) => out.push({ id, label, value, text, limit, grade: g, note });
  add('slope', 'Ellipse steeper than the lander limit', t.overLimit, Number.isFinite(t.overLimit) ? pct(t.overLimit) : 'no data', `≤ 5 % (limit ${limitDeg}°)`, grade(t.overLimit, { pass: 0.05, near: 0.15 }),
    `slope over ${Math.round(resKm * 2000)} m on the ${Math.round(resKm * 1000)} m DEM; mean ${Number.isFinite(t.meanDeg) ? t.meanDeg.toFixed(1) : '—'}°, 95 % below ${Number.isFinite(t.p95Deg) ? t.p95Deg.toFixed(1) : '—'}°`);
  // roughness needs several DEM pixels across the ellipse: at 120 m and coarser it is not resolved (graded near)
  const roughOk = resKm <= 0.04 && Number.isFinite(t.roughM);
  add('rough', 'Roughness in the ellipse', roughOk ? t.roughM : NaN, roughOk ? `${t.roughM.toFixed(1)} m RMS` : `not resolved at ${Math.round(resKm * 1000)} m`, '≤ 1 m RMS (assumed)', roughOk ? grade(t.roughM, { pass: 1, near: 2.5 }) : 'near',
    roughOk ? `height scatter about the best-fit plane on the ${Math.round(resKm * 1000)} m DEM; rocks are smaller than the DEM and not modelled` : 'needs 40 m or finer elevation data across the ellipse; rocks are not modelled either way');
  add('psr', 'Ellipse in permanent shadow', psrShare, pct(psrShare), '0 %', grade(psrShare, { pass: 0, near: 0.05 }), 'LOLA PSR map, 120 m (Mazarico et al. 2011)');
  add('sun', `Sun above the skyline over ${stayDays} days`, sky.sun, `${pct(sky.sun)} (${Math.round(sky.sun * sky.hours)} h)`, '≥ 70 %', grade(sky.sun, { pass: 0.7, near: 0.4, higher: true }), 'ephemeris + LOLA skyline, hourly');
  add('dark', 'Longest dark spell vs battery', sky.longestDarkH, `${Math.round(sky.longestDarkH)} h of ${battH.toFixed(1)} h`, `≤ ${battH.toFixed(1)} h on battery`, grade(sky.longestDarkH / Math.max(0.1, battH), { pass: 1, near: 1.5 }),
    'battery and surface load assumed (Vehicle tab)');
  add('earth', `Earth above the skyline over ${stayDays} days`, sky.earth, `${pct(sky.earth)} (${Math.round(sky.earth * sky.hours)} h)`, '≥ 50 %', grade(sky.earth, { pass: 0.5, near: 0.25, higher: true }), 'direct-to-Earth line of sight; no relay modelled here');
  if (earthAtLanding !== null) add('comms', 'Earth in view at touchdown', earthAtLanding ? 1 : 0, earthAtLanding ? 'yes' : 'no', 'yes', earthAtLanding ? 'pass' : 'fail', 'needed for a live landing link');
  if (budget) add('dv', 'Lander Δv margin after the reserve', budget.marginMs, `${Math.round(budget.marginMs)} m/s · ${Math.round(budget.propellantLeftKg)} kg left`, '≥ 50 m/s', grade(budget.marginMs, { pass: 50, near: 0, higher: true }), 'from the planned orbit, rocket equation; vehicle assumed');
  return out;
}

// One sentence for the figures.
export function verdict(figs) {
  const fails = figs.filter((f) => f.grade === 'fail'), nears = figs.filter((f) => f.grade === 'near');
  const names = (l) => l.map((f) => f.label.toLowerCase()).join(', ');
  if (fails.length) return { grade: 'fail', text: `Not recommended: ${names(fails)}${nears.length ? `; also close on ${names(nears)}` : ''}.` };
  if (nears.length) return { grade: 'near', text: `Possible with care: ${names(nears)} near the limit; everything else passes.` };
  return { grade: 'pass', text: 'Good landing site: every figure passes its limit.' };
}

// Search grid around a map point: centres every stepKm within radiusKm (a square), with lat/lon.
export function searchGrid(xKm, yKm, { radiusKm = 15, stepKm = 1 } = {}) {
  const out = [];
  const n = Math.round(radiusKm / stepKm);
  for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
    const x = xKm + i * stepKm, y = yKm + j * stepKm;
    const { latDeg, lonDeg } = fromXY(x, y);
    out.push({ i, j, xKm: x, yKm: y, latDeg, lonDeg });
  }
  return out;
}

// Suitability of grid points (navigator score: Sun 40, Earth 30, slope 20, nearness to shadow 10) and whether
// each passes the hard limits (slope ≤ limit, longest dark ≤ battery, not in permanent shadow).
// pts: [{ sun, earth, slopeDeg, shadowKm, darkH }] → [{ score (0–1), ok }]
export function suitability(pts, { limitDeg, battH, weights = DEFAULT_WEIGHTS }) {
  const arr = (k) => Float32Array.from(pts, (p) => p[k]);
  const s = scoreCells({ sun: arr('sun'), earth: arr('earth'), slope: arr('slopeDeg'), shadowKm: arr('shadowKm'), weights, count: pts.length });
  return pts.map((p, k) => ({ score: s[k], ok: passes(p.slopeDeg, p.darkH, { maxSlope: limitDeg, maxDark: battH }) && p.shadowKm !== 0 }));
}

// The best `count` points that pass, highest score first, each at least minKm from those taken (and from `avoid`).
export function bestPoints(pts, { count = 5, minKm = 2, avoid = [] } = {}) {
  const order = pts.filter((p) => p.ok && Number.isFinite(p.score)).sort((a, b) => b.score - a.score);
  const taken = [];
  for (const p of order) {
    if ([...avoid, ...taken].every((q) => Math.hypot(q.xKm - p.xKm, q.yKm - p.yKm) >= minKm)) taken.push(p);
    if (taken.length === count) break;
  }
  return taken;
}

export const mapXY = (latDeg, lonDeg) => toXY(latDeg, lonDeg);
