// Landing constraints at the chosen site and time: touchdown speeds from the descent simulation, local slope from
// the LOLA DEM, Sun and Earth above the terrain skyline (ephemeris + skyline), and a picker for a landing time
// when both are up. Pure computation.
import { bodyAzEl } from '../ephemeris.js';
import { toXY } from '../terrain.js';

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
  }
  const sky = skyAt(eph, site, tMs, mask);
  if (sky) {
    add('sun', 'Sun above the skyline at landing', `${sky.sun.clearDeg >= 0 ? '+' : ''}${sky.sun.clearDeg.toFixed(2)}°`, '> 0°', sky.sun.clearDeg > 0, 'JPL Horizons ephemeris + LOLA skyline');
    add('earth', 'Earth above the skyline (direct link)', `${sky.earth.clearDeg >= 0 ? '+' : ''}${sky.earth.clearDeg.toFixed(2)}°`, '> 0°', sky.earth.clearDeg > 0, 'JPL Horizons ephemeris + LOLA skyline');
  }
  return { checks: out, ok: out.every((c) => c.ok), sky };
}
