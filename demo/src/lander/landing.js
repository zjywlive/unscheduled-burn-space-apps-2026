// Landing constraints at the chosen site and time: touchdown speeds from the descent simulation, local slope from
// the LOLA DEM, Sun and Earth above the terrain skyline (ephemeris + skyline), and a picker for a landing time
// when both are up. Pure computation.
import { bodyAzEl } from '../ephemeris.js';
import { toXY, fromXY } from '../terrain.js';
import { unitFromLonLat } from '../geometry.js';

const DEG = 180 / Math.PI;
const clearance = (r, mask) => r.elDeg - (typeof mask === 'function' ? mask(r.azDeg) : mask ?? 0);

// Slope (deg) of a height field sample(xKm, yKm) → metres | NaN at map point (x, y), central differences over stepKm.
export function slopeDeg(sample, xKm, yKm, stepKm) {
  const e = sample(xKm + stepKm, yKm), w = sample(xKm - stepKm, yKm);
  const n = sample(xKm, yKm + stepKm), s = sample(xKm, yKm - stepKm);
  if (![e, w, n, s].every(Number.isFinite)) return NaN;
  const gx = (e - w) / (2000 * stepKm), gy = (n - s) / (2000 * stepKm);
  return Math.atan(Math.hypot(gx, gy)) * DEG;
}

// The nearest map point within radiusKm of the site whose DEM slope meets limitDeg (or, if none does, the flattest),
// on a stepKm grid with slopes over baselineKm. Returns { latDeg, lonDeg, slopeDeg, distM, azDeg, heightM, ok } | null.
export function flattestNear(sample, site, { radiusKm = 0.5, stepKm = 0.02, baselineKm = 0.04, limitDeg = 10 } = {}) {
  const [x0, y0] = toXY(site.latDeg, site.lonDeg);
  let best = null;
  const n = Math.round(radiusKm / stepKm);
  for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
    const dx = i * stepKm, dy = j * stepKm, d = Math.hypot(dx, dy);
    if (d > radiusKm) continue;
    const sl = slopeDeg(sample, x0 + dx, y0 + dy, baselineKm);
    if (!Number.isFinite(sl)) continue;
    const score = sl <= limitDeg ? d : 1e3 + sl;
    if (!best || score < best.score) best = { score, x: x0 + dx, y: y0 + dy, sl, d };
  }
  if (!best) return null;
  const { latDeg, lonDeg } = fromXY(best.x, best.y);
  const u = unitFromLonLat(lonDeg, latDeg), s0 = unitFromLonLat(site.lonDeg, site.latDeg);
  const lam = site.lonDeg * Math.PI / 180, phi = site.latDeg * Math.PI / 180;
  const dv = [u[0] - s0[0], u[1] - s0[1], u[2] - s0[2]];
  const east = -Math.sin(lam) * dv[0] + Math.cos(lam) * dv[1];
  const north = -Math.sin(phi) * Math.cos(lam) * dv[0] - Math.sin(phi) * Math.sin(lam) * dv[1] + Math.cos(phi) * dv[2];
  const az = ((Math.atan2(east, north) * DEG) + 360) % 360;
  return { latDeg, lonDeg, slopeDeg: best.sl, distM: best.d * 1000, azDeg: az, heightM: sample(best.x, best.y), ok: best.sl <= limitDeg };
}

// Sun and Earth over the skyline at one instant. null outside the ephemeris.
export function skyAt(eph, site, tMs, mask = 0) {
  const r = bodyAzEl(eph, site, tMs);
  if (!r) return null;
  return {
    sun: { ...r.sun, clearDeg: clearance(r.sun, mask) },
    earth: { ...r.earth, clearDeg: clearance(r.earth, mask) },
  };
}

// First time ≥ fromMs (hour steps) when the Sun and the Earth both clear the skyline by clearDeg and stay up for
// holdMs. Searches up to maxDays. Returns null if there is none.
export function pickLandingTime(eph, site, mask, fromMs, { stepMs = 3600e3, holdMs = 48 * 3600e3, clearDeg = 0.3, maxDays = 150 } = {}) {
  const ok = (t) => {
    const s = skyAt(eph, site, t, mask);
    return !!s && s.sun.clearDeg > clearDeg && s.earth.clearDeg > clearDeg;
  };
  const end = Math.min(eph.endMs - holdMs, fromMs + maxDays * 86400e3);
  let runStart = null;
  for (let t = Math.max(fromMs, eph.startMs); t <= end; t += stepMs) {
    if (ok(t)) {
      if (runStart === null) runStart = t;
      if (t - runStart >= holdMs) return runStart;
    } else runStart = null;
  }
  return null;
}

// The checklist shown next to the descent view. sample: map-plane height sampler (km → m | NaN); stepKm: the DEM
// spacing used for the slope; touchdown: descent.touchdown.
export function landingChecks({ eph, site, tMs, mask = 0, sample = null, stepKm = 0.12, vehicle, touchdown }) {
  const lim = vehicle.touchdown;
  const out = [];
  let spot = null;
  const add = (id, label, value, limit, ok, source) => out.push({ id, label, value, limit, ok, source });
  if (touchdown) {
    add('v-vert', 'Vertical speed at touchdown', `${Math.abs(touchdown.vVertMs).toFixed(2)} m/s`, `≤ ${lim.maxVerticalMs} m/s`, Math.abs(touchdown.vVertMs) <= lim.maxVerticalMs, 'descent simulation; limit assumed');
    add('v-horiz', 'Horizontal speed at touchdown', `${touchdown.vHorizMs.toFixed(2)} m/s`, `≤ ${lim.maxHorizontalMs} m/s`, touchdown.vHorizMs <= lim.maxHorizontalMs, 'descent simulation; limit assumed');
  } else {
    add('v-vert', 'Touchdown', 'not reached', '', false, 'descent simulation');
  }
  if (sample) {
    const [x, y] = toXY(site.latDeg, site.lonDeg);
    const sl = slopeDeg(sample, x, y, stepKm);
    add('slope', `Slope (DEM, ${Math.round(stepKm * 1000)} m baseline)`, Number.isFinite(sl) ? `${sl.toFixed(1)}°` : 'no data', `≤ ${lim.maxSlopeDeg}°`, Number.isFinite(sl) && sl <= lim.maxSlopeDeg, 'LOLA DEM; lander-scale rocks need LROC NAC or lidar');
    spot = flattestNear(sample, site, { baselineKm: stepKm, stepKm: Math.max(0.02, stepKm / 2), limitDeg: lim.maxSlopeDeg });
    if (spot) add('spot', 'Nearest spot meeting the slope limit (within 500 m)', spot.ok ? `${spot.slopeDeg.toFixed(1)}° at ${Math.round(spot.distM)} m, az ${Math.round(spot.azDeg)}°` : `none; flattest ${spot.slopeDeg.toFixed(1)}°`, `≤ ${lim.maxSlopeDeg}°`, spot.ok, 'LOLA DEM search around the target; retarget before PDI');
  }
  const sky = skyAt(eph, site, tMs, mask);
  if (sky) {
    add('sun', 'Sun above the skyline at landing', `${sky.sun.clearDeg >= 0 ? '+' : ''}${sky.sun.clearDeg.toFixed(2)}°`, '> 0°', sky.sun.clearDeg > 0, 'JPL Horizons ephemeris + LOLA skyline');
    add('earth', 'Earth above the skyline (direct link)', `${sky.earth.clearDeg >= 0 ? '+' : ''}${sky.earth.clearDeg.toFixed(2)}°`, '> 0°', sky.earth.clearDeg > 0, 'JPL Horizons ephemeris + LOLA skyline');
  }
  return { checks: out, ok: out.every((c) => c.ok), sky, spot };
}
