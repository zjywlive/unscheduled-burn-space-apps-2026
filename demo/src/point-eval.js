// Exact metrics at one place (docs/mcp-v2/DESIGN.md §2, §5), in the metric names of criteria.js: the point
// skyline (the 480 m DEM skyline the page uses for a site) and windows.js 15-minute scans with every rise and
// set refined to 1 minute. search.js screens on the 2 km grid; this module is what candidates are checked
// against, and what check_slip_robustness and landing_windows use directly.
//
//   pointTimeline(eph, site, mask, startMs, endMs) → timeline     one scan; many landings are read from it
//   pointMetrics(timeline, landingMs, stayMs, opts) → time metrics for one landing
//   staticMetrics(sources, site, criteria) → ground metrics (slope, PSR, ice, NASA averages)
//   nearestPsrPixel(psr, xKm, yKm, maxKm) → { xKm, yKm, latDeg, lonDeg, distKm } | null
//
// Intervals are [startMs, endMs) pairs. Reading a landing out of a longer timeline gives the same figures as
// a scan that starts at the landing, to within the 1-minute refinement of each crossing.
import { visibleIntervals, intersectIntervals, totalMs, longestGapMs } from './windows.js';
import { bodyAzEl } from './ephemeris.js';
import { toXY, fromXY, TERRAIN_MAX_LAT } from './terrain.js';
import { slopeAt } from './route-plan.js';

const HOUR_MS = 3600e3;

export function pointTimeline(eph, site, mask, startMs, endMs) {
  const s = Math.max(startMs, eph.startMs), e = Math.min(endMs, eph.endMs);
  if (!(e > s)) return { site, mask, startMs: s, endMs: s, sun: [], earth: [], both: [] };
  const sun = visibleIntervals(eph, site, 'sun', s, e, mask);
  const earth = visibleIntervals(eph, site, 'earth', s, e, mask);
  return { site, mask, startMs: s, endMs: e, sun, earth, both: intersectIntervals(sun, earth) };
}

export function clipIntervals(iv, a, b) {
  const out = [];
  for (const [x, y] of iv) {
    if (y <= a || x >= b) continue;
    out.push([Math.max(x, a), Math.min(y, b)]);
  }
  return out;
}

// Length of the run that contains t (a ≤ t < b), cut at end; 0 when the body is not in view at t.
function runFrom(iv, t, end) {
  for (const [a, b] of iv) {
    if (a <= t && t < b) return Math.min(b, end) - t;
    if (a > t) break;
  }
  return 0;
}
const longestRun = (iv) => iv.reduce((m, [a, b]) => Math.max(m, b - a), 0);

// opts: { continuous_from = 'from_landing', fromMs, eph, peaks } — peaks (needs eph) adds sun_peak_deg and
// earth_peak_deg, the highest elevation above the smooth horizon in the stay, sampled every hour.
// Returns raw (unrounded) hours. covered_h < the stay when the timeline (ephemeris) ends first: clipped.
export function pointMetrics(tl, landingMs, stayMs, { continuous_from = 'from_landing', fromMs = null, eph = null, peaks = false } = {}) {
  const L = landingMs, end = Math.min(L + stayMs, tl.endMs);
  if (!(L >= tl.startMs && end > L)) return null;
  const sun = clipIntervals(tl.sun, L, end), earth = clipIntervals(tl.earth, L, end), both = clipIntervals(tl.both, L, end);
  const t0 = continuous_from === 'from_time' ? fromMs : L;
  const run = (iv) => {
    if (continuous_from === 'within_stay') return longestRun(iv) / HOUR_MS;
    if (!(t0 >= L && t0 < end)) return 0;
    return runFrom(iv, t0, end) / HOUR_MS;
  };
  const m = {
    sun_at_landing: sun.length > 0 && sun[0][0] === L,
    earth_at_landing: earth.length > 0 && earth[0][0] === L,
    both_continuous_h: run(both), sun_continuous_h: run(sun), earth_continuous_h: run(earth),
    both_total_h: totalMs(both) / HOUR_MS, sun_total_h: totalMs(sun) / HOUR_MS, earth_total_h: totalMs(earth) / HOUR_MS,
    longest_dark_h: longestGapMs(sun, L, end) / HOUR_MS,
    // both conventions, always, for reporting next to the one the criteria use
    both_from_landing_h: runFrom(both, L, end) / HOUR_MS, longest_both_h: longestRun(both) / HOUR_MS,
    covered_h: (end - L) / HOUR_MS, clipped: L + stayMs > tl.endMs,
    first_sunset_ms: sun.find(([, b]) => b < end)?.[1] ?? null,
    first_earthset_ms: earth.find(([, b]) => b < end)?.[1] ?? null,
  };
  if (peaks && eph) {
    let ps = -Infinity, pe = -Infinity;
    for (let t = L; t <= end; t += HOUR_MS) {
      const r = bodyAzEl(eph, tl.site, t);
      if (!r) continue;
      ps = Math.max(ps, r.sun.elDeg); pe = Math.max(pe, r.earth.elDeg);
    }
    m.sun_peak_deg = Number.isFinite(ps) ? ps : null;
    m.earth_peak_deg = Number.isFinite(pe) ? pe : null;
  }
  return m;
}

// Nearest permanently shadowed 120 m pixel within maxKm (map plane), or null. Ring by ring outwards.
export function nearestPsrPixel(psr, xKm, yKm, maxKm = 10) {
  if (!psr?.bitAt) return null;
  const k = psr.kmPerPixel, half = psr.halfKm, n = psr.size;
  const c0 = Math.floor((xKm + half) / k), r0 = Math.floor((half - yKm) / k);
  const maxR = Math.ceil(maxKm / k);
  let best = null;
  for (let ring = 0; ring <= maxR; ring++) {
    if (best && (ring - 1) * k > best.distKm) break;
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || c < 0 || r >= n || c >= n || !psr.bitAt(r, c)) continue;
        const x = -half + (c + 0.5) * k, y = half - (r + 0.5) * k;
        const d = Math.hypot(x - xKm, y - yKm);
        if (d <= maxKm && (!best || d < best.distKm)) best = { xKm: x, yKm: y, distKm: d };
      }
    }
  }
  if (!best) return null;
  const g = fromXY(best.xKm, best.yKm);
  return { ...best, latDeg: g.latDeg, lonDeg: g.lonDeg };
}

// sources: { coarse, fine, psr, nasa, ice, dem240 } already resolved (any may be null). criteria: resolved.
// slope_deg follows criteria.slope_scale; psr_km is the finest cell grid loaded (1 km, else 2 km);
// ice_target_km uses the ice packs when loaded, else the PSR distance as a proxy (ice_source says which).
export function staticMetrics(sources, site, criteria = {}) {
  const { coarse = null, fine = null, psr = null, nasa = null, ice = null, dem240 = null } = sources ?? {};
  const out = { slope_deg: null, psr_km: null, inside_psr: null, ice_target_km: null, ice_source: null, ice_target: null, nasa_avg_sun: null, nasa_avg_earth: null };
  if (!(site.latDeg <= TERRAIN_MAX_LAT)) return out;
  const [x, y] = toXY(site.latDeg, site.lonDeg);
  const cellValue = (g, arr) => {
    if (!g?.grid || !arr) return null;
    const k = g.grid.cellAt(x, y);
    return k === null || k === undefined ? null : arr[k];
  };
  const scale = criteria.slope_scale ?? '2km';
  out.slope_deg = scale === '240m' ? (dem240 ? slopeAt(dem240, x, y) : null)
    : scale === '1km' ? cellValue(fine, fine?.slope)
      : cellValue(coarse, coarse?.slope);
  out.psr_km = cellValue(fine, fine?.shadow) ?? cellValue(coarse, coarse?.shadow);
  out.inside_psr = psr ? psr.isPsr(x, y) : out.psr_km === null ? null : out.psr_km === 0;
  if (nasa) {
    const n = nasa.sample(x, y);
    if (n) { out.nasa_avg_sun = Number.isFinite(n.sunPct) ? n.sunPct / 100 : null; out.nasa_avg_earth = Number.isFinite(n.earthPct) ? n.earthPct / 100 : null; }
  }
  if (criteria.ice) {
    const within = criteria.ice.within_km ?? 5;
    if (ice) {
      const t = ice.nearest(x, y, { cls: criteria.ice.class, withinKm: Math.max(20, within * 3), depthMaxM: criteria.ice.depth_max_m });
      out.ice_source = 'diviner';
      out.ice_target = t;
      out.ice_target_km = t ? t.distKm : Infinity;
    } else {
      out.ice_source = 'psr_proxy';
      out.ice_target_km = out.inside_psr ? 0 : out.psr_km;
      const t = psr ? nearestPsrPixel(psr, x, y, Math.max(10, within * 2)) : null;
      out.ice_target = t ? { ...t, cls: 'psr_proxy' } : null;
    }
  }
  return out;
}
