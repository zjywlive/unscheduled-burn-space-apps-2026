// Choosing where to land (pure computation, no DOM): the landing ellipse around a point, the terrain inside it,
// Sun and Earth above the real skyline over the stay, the longest dark spell against the battery, permanent
// shadow, and a grid search around a pick ranked with the navigator's suitability score (score.js).
// Map coordinates are the polar-stereographic km of terrain.js; heights in metres.
import { azEl } from '../geometry.js';
import { toXY, fromXY } from '../terrain.js';
import { scoreCells, passes, DEFAULT_WEIGHTS } from '../score.js';
import { slopeDeg, mapScale } from './landing.js';

// Assumed 3σ landing dispersion with terrain-relative navigation: 150 m down-range × 100 m cross-range.
// A polar orbit passes over the pole, so near it the descent runs along the meridian: down-range is radial on
// the polar map.
export const ELLIPSE = Object.freeze({ downrangeM: 150, crossrangeM: 100 });

// Map points (km) inside the ellipse centred on (x, y), on a grid of stepM.
export function ellipsePoints(xKm, yKm, { downrangeM = ELLIPSE.downrangeM, crossrangeM = ELLIPSE.crossrangeM, stepM = 20, k = null } = {}) {
  const r = Math.hypot(xKm, yKm);
  const u = r > 1e-9 ? [xKm / r, yKm / r] : [0, 1];   // down-range (radial = along the meridian)
  const v = [-u[1], u[0]];                              // cross-range
  // ground metres → map km with the map scale at the point (1.008 at 80°S, 2 at the equator)
  const kk = k ?? mapScale(2 * Math.atan(r / (2 * 1737.4)) * 180 / Math.PI - 90);
  const a = (downrangeM / 1000) * kk, b = (crossrangeM / 1000) * kk, s = (stepM / 1000) * kk;
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
export function terrainStats(sample, pts, { baselineKm = 0.04, limitDeg = 10, k = 1 } = {}) {
  const sl = [], hs = [];
  for (const [x, y] of pts) {
    const s = slopeDeg(sample, x, y, baselineKm, k);
    if (Number.isFinite(s)) sl.push(s);
    const h = sample(x, y);
    if (Number.isFinite(h)) hs.push([(x * 1000) / k, (y * 1000) / k, h]);   // ground metres
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
  return windowStats(skySeries(dirs, site, mask), 0, dirs.length, stepH);
}

// The Sun and the Earth above the skyline at each of those directions: { sun, earth } Uint8Arrays (1 = above).
export function skySeries(dirs, site, mask) {
  const m = typeof mask === 'function' ? mask : () => mask ?? 0;
  const sun = new Uint8Array(dirs.length), earth = new Uint8Array(dirs.length);
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    const su = azEl(d.sun, Infinity, site.lonDeg, site.latDeg), ea = azEl(d.earth, d.earthRangeKm, site.lonDeg, site.latDeg);
    sun[i] = su.elDeg > m(su.azDeg) ? 1 : 0; earth[i] = ea.elDeg > m(ea.azDeg) ? 1 : 0;
  }
  return { sun, earth };
}

// skyStats over steps [start, start + len) of a series (clipped to it).
export function windowStats({ sun, earth }, start, len, stepH = 1) {
  const end = Math.min(sun.length, start + len);
  let s = 0, e = 0, b = 0, run = 0, longest = 0, runE = 0, longestE = 0;
  for (let i = Math.max(0, start); i < end; i++) {
    if (sun[i]) { s++; run = 0; } else if (++run > longest) longest = run;
    if (earth[i]) { e++; runE = 0; } else if (++runE > longestE) longestE = runE;
    if (sun[i] && earth[i]) b++;
  }
  const count = Math.max(0, end - Math.max(0, start)), n = count || 1;
  return { sun: s / n, earth: e / n, both: b / n, longestDarkH: longest * stepH, longestNoEarthH: longestE * stepH, hours: count * stepH };
}

// Slip robustness: the stay (stayH hours) from the planned landing and from each day up to slipDays later, over one
// series that starts at the planned landing and runs slipDays past the stay. Only stays that fit wholly in the series
// count (the ephemeris may end first). → [windowStats for day 0, 1, …]
export function slipStats(series, { stepH = 1, stayH, slipDays = 0 }) {
  const stayN = Math.round(stayH / stepH), dayN = Math.round(24 / stepH), out = [];
  for (let d = 0; d <= slipDays; d++) {
    if (d * dayN + stayN > series.sun.length) break;
    out.push(windowStats(series, d * dayN, stayN, stepH));
  }
  return out;
}

// Monte Carlo touchdowns: n landings scattered about the aim point (map km) as a 2-D Gaussian whose 3σ is the landing
// ellipse (down-range radial on the polar map, as ellipsePoints), each safe when the ground there is within the slope
// limit (slopeDeg over baselineKm on the sampler) and not in permanent shadow (isPsr, when given). A slope that cannot
// be computed counts as unsafe. Seeded by the aim point, so a place always gets the same answer.
// → { n, pSafe, steep, psr, unknown, outside (share beyond the 3σ ellipse), meanDeg, p95Deg }
export function touchdownMC(xKm, yKm, { sample, k = 1, downrangeM = ELLIPSE.downrangeM, crossrangeM = ELLIPSE.crossrangeM, n = 2000, baselineKm = 0.04, limitDeg = 10, isPsr = null } = {}) {
  const r = Math.hypot(xKm, yKm);
  const u = r > 1e-9 ? [xKm / r, yKm / r] : [0, 1], v = [-u[1], u[0]];
  const sd = (downrangeM / 3000) * k, sc = (crossrangeM / 3000) * k;   // σ in map km
  const rand = mulberry32(hashXY(xKm, yKm));
  let safe = 0, steep = 0, psr = 0, unknown = 0, outside = 0;
  const slopes = [];
  for (let i = 0; i < n; i += 2) {
    // Box–Muller: two independent standard normals per draw
    const u1 = Math.max(1e-12, rand()), u2 = rand(), rr = Math.sqrt(-2 * Math.log(u1));
    for (const [g1, g2] of [[rr * Math.cos(2 * Math.PI * u2), rr * Math.sin(2 * Math.PI * u2)], [rr * Math.sin(2 * Math.PI * u2), -rr * Math.cos(2 * Math.PI * u2)]]) {
      if (slopes.length + unknown >= n) break;
      if (g1 * g1 + g2 * g2 > 9) outside++;
      const x = xKm + g1 * sd * u[0] + g2 * sc * v[0], y = yKm + g1 * sd * u[1] + g2 * sc * v[1];
      const sl = slopeDeg(sample, x, y, baselineKm, k), dark = isPsr ? isPsr(x, y) : false;
      if (!Number.isFinite(sl)) { unknown++; if (dark) psr++; continue; }
      slopes.push(sl);
      const tooSteep = sl > limitDeg;
      if (tooSteep) steep++;
      if (dark) psr++;
      if (!tooSteep && !dark) safe++;
    }
  }
  slopes.sort((a, b) => a - b);
  return {
    n, pSafe: safe / n, steep: steep / n, psr: psr / n, unknown: unknown / n, outside: outside / n,
    meanDeg: slopes.length ? slopes.reduce((a, b) => a + b, 0) / slopes.length : NaN,
    p95Deg: slopes.length ? slopes[Math.min(slopes.length - 1, Math.floor(0.95 * slopes.length))] : NaN,
  };
}
// a small seeded generator (mulberry32) and a seed from a map point
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hashXY = (x, y) => (Math.imul(Math.round(x * 1e4) | 0, 73856093) ^ Math.imul(Math.round(y * 1e4) | 0, 19349663)) >>> 0;

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
// mc: touchdownMC (the safe-touchdown chance replaces the ellipse's steep share); slip: { days, passed, total,
// worstDarkH } from slipStats (the stay from each day up to `days` late, against the battery)
export function figures({ t, sky, psrShare, psrNote = null, budget = null, earthAtLanding = null, earthWindow = true, battH, limitDeg, resKm, stayDays, mc = null, slip = null }) {
  const pct = (x) => `${Math.round(x * 100)} %`;
  const out = [];
  const add = (id, label, value, text, limit, g, note) => out.push({ id, label, value, text, limit, grade: g, note });
  const deg1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
  if (mc) {
    // the same marks as the steep share had (≤ 5 % pass, ≤ 15 % near), as a chance of landing safely
    const p = mc.pSafe, txt = p >= 0.995 && p < 1 ? `${(p * 100).toFixed(1)} %` : pct(p);
    add('safe', 'Safe touchdown (Monte Carlo)', p, `${txt} · ${mc.n} simulated landings`, '≥ 95 %', grade(p, { pass: 0.95, near: 0.85, higher: true }),
      `landings scattered as a Gaussian whose 3σ is the ellipse (${(mc.outside * 100).toFixed(1)} % land outside it); unsafe = steeper than ${limitDeg}° over ${Math.round(resKm * 2000)} m on the ${Math.round(resKm * 1000)} m DEM (${pct(mc.steep)})${mc.psr ? ` or in permanent shadow (${pct(mc.psr)})` : ''}${mc.unknown ? ` or no slope data (${pct(mc.unknown)})` : ''}; mean slope ${deg1(mc.meanDeg)}°, 95 % below ${deg1(mc.p95Deg)}°; rocks not modelled`);
  } else {
    add('slope', 'Ellipse steeper than the lander limit', t.overLimit, Number.isFinite(t.overLimit) ? pct(t.overLimit) : 'no data', `≤ 5 % (limit ${limitDeg}°)`, grade(t.overLimit, { pass: 0.05, near: 0.15 }),
      `slope over ${Math.round(resKm * 2000)} m on the ${Math.round(resKm * 1000)} m DEM; mean ${deg1(t.meanDeg)}°, 95 % below ${deg1(t.p95Deg)}°`);
  }
  // roughness needs several DEM pixels across the ellipse: at 120 m and coarser it is not resolved (graded near)
  const roughOk = resKm <= 0.04 && Number.isFinite(t.roughM);
  add('rough', 'Roughness in the ellipse', roughOk ? t.roughM : NaN, roughOk ? `${t.roughM.toFixed(1)} m RMS` : `not resolved at ${Math.round(resKm * 1000)} m`, '≤ 1 m RMS (assumed)', roughOk ? grade(t.roughM, { pass: 1, near: 2.5 }) : 'near',
    roughOk ? `height scatter about the best-fit plane on the ${Math.round(resKm * 1000)} m DEM; rocks are smaller than the DEM and not modelled` : 'needs 40 m or finer elevation data across the ellipse; rocks are not modelled either way');
  if (Number.isFinite(psrShare)) add('psr', 'Ellipse in permanent shadow', psrShare, pct(psrShare), '0 %', grade(psrShare, { pass: 0, near: 0.05 }), psrNote ?? 'LOLA PSR map, 120 m (Mazarico et al. 2011)');
  else add('psr', 'Ellipse in permanent shadow', NaN, 'unknown', '0 %', 'near', psrNote ?? 'no permanent-shadow map here');
  add('sun', `Sun above the skyline over ${stayDays} days`, sky.sun, `${pct(sky.sun)} (${Math.round(sky.sun * sky.hours)} h)`, '≥ 70 %', grade(sky.sun, { pass: 0.7, near: 0.4, higher: true }), 'ephemeris + LOLA skyline, hourly');
  add('dark', 'Longest dark spell vs battery', sky.longestDarkH, `${Math.round(sky.longestDarkH)} h of ${battH.toFixed(1)} h`, `≤ ${battH.toFixed(1)} h on battery`, grade(sky.longestDarkH / Math.max(0.1, battH), { pass: 1, near: 1.5 }),
    'battery and surface load assumed (Vehicle tab)');
  add('earth', `Earth above the skyline over ${stayDays} days`, sky.earth, `${pct(sky.earth)} (${Math.round(sky.earth * sky.hours)} h)`, '≥ 50 %', grade(sky.earth, { pass: 0.5, near: 0.25, higher: true }), 'direct-to-Earth line of sight; no relay modelled here');
  const slipTotal = slip ? slip.total ?? slip.days + 1 : 0;   // days checked: fewer than days + 1 where the ephemeris ends
  if (slipTotal > 1) {
    const share = slip.passed / slipTotal;
    add('slip', `Landing up to ${slipTotal - 1} days late`, share, `${slip.passed}/${slipTotal} days · worst night ${Math.round(slip.worstDarkH)} h`, 'every day', grade(share, { pass: 1, near: 0.5, higher: true }),
      `the stay from this landing and from each day after it: the battery (${battH.toFixed(1)} h) must carry its longest dark spell (hourly). A slip robustness check, as NASA weighs sensitivity to slips`);
  }
  // a figure that could not be computed is shown and graded near, not left out (left out, the place would have one
  // check fewer to fail and rank higher, and the verdict would say every figure passes: audit L7)
  if (earthAtLanding !== null) add('comms', 'Earth in view at touchdown', earthAtLanding ? 1 : 0, earthAtLanding ? 'yes' : 'no', 'yes', earthAtLanding ? 'pass' : 'fail', earthWindow ? 'needed for a live landing link' : 'the Earth does not stay above the skyline here around this landing (the far side, or a time when it is below the skyline): a relay or another landing time is needed');
  else add('comms', 'Earth in view at touchdown', NaN, 'not computed', 'yes', 'near', 'the Earth\'s direction at touchdown could not be computed for this landing time');
  if (budget) add('dv', 'Lander Δv margin after the reserve', budget.marginMs, `${Math.round(budget.marginMs)} m/s · ${Math.round(budget.propellantLeftKg)} kg left`, '≥ 50 m/s', grade(budget.marginMs, { pass: 50, near: 0, higher: true }), 'from the planned orbit, rocket equation; vehicle assumed');
  else add('dv', 'Lander Δv margin after the reserve', NaN, 'not computed', '≥ 50 m/s', 'near', 'the descent from the planned orbit could not be planned for this landing time; vehicle assumed');
  return out;
}

// One sentence for the figures; resKm adds what the terrain resolution cannot show.
export function verdict(figs, { resKm = null } = {}) {
  const fails = figs.filter((f) => f.grade === 'fail'), nears = figs.filter((f) => f.grade === 'near');
  const names = (l) => l.map((f) => f.label.toLowerCase()).join(', ');
  const res = resKm > 0.1 ? ` Terrain ${Math.round(resKm * 1000)} m: lander-scale hazards (rocks, small craters, slopes under about 1 km) are not resolved.` : '';
  if (fails.length) return { grade: 'fail', text: `Not recommended: ${names(fails)}${nears.length ? `; also close on ${names(nears)}` : ''}.${res}` };
  if (nears.length) return { grade: 'near', text: `Possible with care: ${names(nears)} near the limit; everything else passes.${res}` };
  return { grade: 'pass', text: `Good landing site: every figure passes its limit.${res}` };
}

// Where a landing is possible, cell by cell (for the shading): 2 = landable (every check passes), 1 = possible
// (passes with something near its limit), 0 = not. The same limits as the figures: slope over the DEM baseline
// within the lander limit, no permanent shadow in the cell or nearer than 1 km, Sun ≥ 70 % (≥ 40 %), Earth ≥ 50 %
// (≥ 25 %) over the stay, longest dark spell ≤ battery (≤ 1.5 ×), and reachable (Δv margin ≥ 0) where given.
export const LANDABLE = Object.freeze({ sun: [0.7, 0.4], earth: [0.5, 0.25], dark: [1, 1.5] });
export function landableClass({ sun, earth, darkH, slopeDeg, shadowKm, marginMs = 0 }, { limitDeg, battH }) {
  if (!(slopeDeg <= limitDeg) || !(shadowKm >= 1) || !(marginMs >= 0)) return 0;
  if (!(Number.isFinite(sun) && Number.isFinite(earth) && Number.isFinite(darkH))) return 0;
  if (sun >= LANDABLE.sun[0] && earth >= LANDABLE.earth[0] && darkH <= LANDABLE.dark[0] * battH) return 2;
  if (sun >= LANDABLE.sun[1] && earth >= LANDABLE.earth[1] && darkH <= LANDABLE.dark[1] * battH) return 1;
  return 0;
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
// dist(a, b) → km: map km by default; a region over a wide area passes the great-circle distance (audit L2).
// pass / by: which points qualify and their order (the nearest misses: failing, shortest dark spell first).
const mapKm = (q, p) => Math.hypot(q.xKm - p.xKm, q.yKm - p.yKm);
export function bestPoints(pts, { count = 5, minKm = 2, avoid = [], dist = mapKm, pass = (p) => p.ok, by = (a, b) => b.score - a.score } = {}) {
  if (!(count > 0)) return [];
  const order = pts.filter((p) => pass(p) && Number.isFinite(p.score)).sort(by);
  const taken = [];
  for (const p of order) {
    if ([...avoid, ...taken].every((q) => dist(q, p) >= minKm)) taken.push(p);
    if (taken.length === count) break;
  }
  return taken;
}

export const mapXY = (latDeg, lonDeg) => toXY(latDeg, lonDeg);
