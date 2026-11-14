// Relay satellite link windows for one surface site (phase 4 §6 K). Pure computation, no DOM.
//
// Frame: Moon-centred inertial frame whose base plane is the lunar equator and whose axes coincide with
// the Moon-fixed frame of the ephemeris (x toward 0° E, z toward the north pole) at the orbit epoch.
// The Moon-fixed frame turns about +z once per sidereal month, so a vector fixed in the inertial frame
// is seen in the Moon-fixed frame rotated by −θ(t), θ = 2π (t − epoch) / sidereal month.
// Two-body Kepler propagation only: no Earth or Sun third-body pull, no lunar gravity field. A real
// lunar orbit drifts away from this within weeks; the figures are illustrative.
import { MOON_RADIUS_KM as GEO_MOON_RADIUS_KM, normalizeLon } from './geometry.js';
import { intersectIntervals, totalMs, longestGapMs } from './windows.js';

// G: tools/build.mjs takes no export lists, so the re-export is a const (same value as geometry.js)
export const MOON_RADIUS_KM = GEO_MOON_RADIUS_KM;
export const MU_MOON = 4902.800066;                 // km³/s², lunar GM (task book value)
export const SIDEREAL_MONTH_S = 27.321661 * 86400;  // the Moon's rotation period relative to the stars
export const MOON_RATE = (2 * Math.PI) / SIDEREAL_MONTH_S;   // rad/s
// Beyond roughly 60,000 km from the Moon the Earth's pull dominates (lunar sphere of influence ≈ 66,000 km),
// so a two-body orbit out there is meaningless.
export const MAX_APOLUNE_KM = 60000;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const TWO_PI = 2 * Math.PI;
export const EDGE_TOL_MS = 1000;   // window edges are bisected to 1 s


// Examples worked out from Kepler's third law (derivations in docs/phase4/handoff/K.md). None of these
// is a real mission's orbit. epochMs null means "at the planned landing time".
export const PRESETS = [
  {
    id: 'elliptical-12h',
    name: 'Example elliptical polar orbit, 12 h, apolune over the south',
    elements: { aKm: 6142.6, e: 0.6, iDeg: 90, raanDeg: 0, argpDeg: 90, m0Deg: 180, epochMs: null },
  },
  {
    id: 'elliptical-24h',
    name: 'Example elliptical orbit, 24 h, i = 60°, apolune toward the south',
    elements: { aKm: 9750.7, e: 0.7, iDeg: 60, raanDeg: 0, argpDeg: 90, m0Deg: 180, epochMs: null },
  },
  {
    id: 'circular-2h',
    name: 'Example circular polar orbit, 2 h',
    elements: { aKm: 1860.3, e: 0, iDeg: 90, raanDeg: 0, argpDeg: 0, m0Deg: 0, epochMs: null },
  },
];

// ---------- orbit ----------

export function orbitPeriodS(aKm, mu = MU_MOON) {
  return TWO_PI * Math.sqrt((aKm * aKm * aKm) / mu);
}

export function semiMajorForPeriod(periodS, mu = MU_MOON) {
  return Math.cbrt(mu * (periodS / TWO_PI) ** 2);
}

// Kepler's equation M = E − e sin E for 0 ≤ e < 1, Newton's method; M in radians, any value.
export function solveKepler(M, e) {
  let m = M % TWO_PI;
  if (m > Math.PI) m -= TWO_PI; else if (m < -Math.PI) m += TWO_PI;
  let E = e < 0.8 ? m + e * Math.sin(m) : (m >= 0 ? Math.PI : -Math.PI);
  for (let k = 0; k < 50; k++) {
    const f = E - e * Math.sin(E) - m;
    const d = f / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-14) break;
  }
  return E + (M - m);
}

// Field-by-field check of user-entered elements. errors maps a field name to a sentence.
export function validateElements(el) {
  const errors = {};
  const num = (k) => typeof el?.[k] === 'number' && Number.isFinite(el[k]);
  for (const k of ['aKm', 'e', 'iDeg', 'raanDeg', 'argpDeg', 'm0Deg']) if (!num(k)) errors[k] = 'Enter a number.';
  if (!errors.e && (el.e < 0 || el.e >= 1)) errors.e = 'Eccentricity must be at least 0 and below 1.';
  if (!errors.iDeg && (el.iDeg < 0 || el.iDeg > 180)) errors.iDeg = 'Inclination must be 0° to 180°.';
  for (const k of ['raanDeg', 'argpDeg', 'm0Deg']) if (!errors[k] && Math.abs(el[k]) > 360) errors[k] = 'Use −360° to 360°.';
  if (!errors.aKm && el.aKm <= MOON_RADIUS_KM) errors.aKm = `Semi-major axis must exceed the Moon’s radius, ${MOON_RADIUS_KM} km.`;
  if (el?.epochMs !== null && el?.epochMs !== undefined && !Number.isFinite(el.epochMs)) errors.epochMs = 'Enter a UTC date and time.';
  let derived = null;
  if (!errors.aKm && !errors.e) {
    const rp = el.aKm * (1 - el.e), ra = el.aKm * (1 + el.e);
    derived = { periodS: orbitPeriodS(el.aKm), periluneAltKm: rp - MOON_RADIUS_KM, apoluneAltKm: ra - MOON_RADIUS_KM };
    if (rp <= MOON_RADIUS_KM) errors.aKm = errors.e = `Perilune is ${Math.round(MOON_RADIUS_KM - rp).toLocaleString("en-GB")} km below the surface.`;
    else if (ra > MAX_APOLUNE_KM) errors.aKm = errors.e = `Apolune ${Math.round(ra).toLocaleString('en-GB')} km from the centre is beyond the Moon’s sphere of influence; two-body motion does not hold.`;
  }
  return { ok: Object.keys(errors).length === 0, errors, derived };
}

// Position at time t: inertial(t) and fixed(t) return [x, y, z] in km. epochMs must be a number here.
export function createOrbit({ aKm, e, iDeg, raanDeg, argpDeg, m0Deg, epochMs }) {
  const n = Math.sqrt(MU_MOON / (aKm * aKm * aKm));       // mean motion, rad/s
  const b = aKm * Math.sqrt(1 - e * e);
  const cO = Math.cos(raanDeg * RAD), sO = Math.sin(raanDeg * RAD);
  const ci = Math.cos(iDeg * RAD), si = Math.sin(iDeg * RAD);
  const cw = Math.cos(argpDeg * RAD), sw = Math.sin(argpDeg * RAD);
  // perifocal unit vectors P (toward perilune) and Q (90° ahead in the orbit plane), R3(Ω) R1(i) R3(ω)
  const P = [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si];
  const Q = [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si];
  const m0 = m0Deg * RAD;
  function inertial(tMs) {
    const dt = (tMs - epochMs) / 1000;
    const E = solveKepler(m0 + n * dt, e);
    const x = aKm * (Math.cos(E) - e), y = b * Math.sin(E);
    return [P[0] * x + Q[0] * y, P[1] * x + Q[1] * y, P[2] * x + Q[2] * y];
  }
  function fixed(tMs) {
    return inertialToFixed(inertial(tMs), tMs, epochMs);
  }
  return { periodS: TWO_PI / n, meanMotion: n, P, Q, epochMs, inertial, fixed };
}

export function inertialToFixed(v, tMs, epochMs) {
  const th = MOON_RATE * (tMs - epochMs) / 1000;
  const c = Math.cos(th), s = Math.sin(th);
  return [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]];
}

// Sub-satellite point of a Moon-fixed position.
export function subPoint(v) {
  const r = Math.hypot(v[0], v[1], v[2]);
  return { latDeg: Math.asin(v[2] / r) * DEG, lonDeg: normalizeLon(Math.atan2(v[1], v[0]) * DEG), rKm: r };
}

// ---------- geometry at the site ----------

// Elevation and azimuth of a Moon-fixed point seen from a site, with the conventions of geometry.azEl:
// local vertical = the site's unit radius vector, azimuth from north increasing east, null at a pole.
// siteRadiusKm defaults to the mean radius, as the Sun/Earth code uses.
export function lookAngles(p, site, siteRadiusKm = MOON_RADIUS_KM) {
  const lam = site.lonDeg * RAD, phi = site.latDeg * RAD;
  const cp = Math.cos(phi), sp = Math.sin(phi), cl = Math.cos(lam), sl = Math.sin(lam);
  const nx = cp * cl, ny = cp * sl, nz = sp;
  const vx = p[0] - siteRadiusKm * nx, vy = p[1] - siteRadiusKm * ny, vz = p[2] - siteRadiusKm * nz;
  const range = Math.hypot(vx, vy, vz);
  const up = Math.max(-1, Math.min(1, (vx * nx + vy * ny + vz * nz) / range));
  const elDeg = Math.asin(up) * DEG;
  if (Math.acos(Math.abs(up)) < 1e-6 || Math.abs(site.latDeg) > 89.9999) return { azDeg: null, elDeg, rangeKm: range };
  const east = -sl * vx + cl * vy;
  const north = -sp * cl * vx - sp * sl * vy + cp * vz;
  return { azDeg: normalizeLon(Math.atan2(east, north) * DEG), elDeg, rangeKm: range };
}

// True when the straight segment a→b does not pass through the sphere of radius r about the Moon's centre.
export function segmentClearsSphere(a, b, r = MOON_RADIUS_KM) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len2 = dx * dx + dy * dy + dz * dz;
  let u = len2 > 0 ? -(a[0] * dx + a[1] * dy + a[2] * dz) / len2 : 0;
  u = Math.max(0, Math.min(1, u));
  const cx = a[0] + u * dx, cy = a[1] + u * dy, cz = a[2] + u * dz;
  return cx * cx + cy * cy + cz * cz > r * r;
}

// The relay sees the Earth when the satellite–Earth-centre line misses the lunar sphere. Earth's centre is
// placed at the ephemeris direction times the ephemeris range (≈ 356,000–407,000 km).
export function relaySeesEarth(sat, earthDir, earthRangeKm) {
  return segmentClearsSphere(sat, [earthDir[0] * earthRangeKm, earthDir[1] * earthRangeKm, earthDir[2] * earthRangeKm]);
}

// ---------- intervals ----------

export function unionIntervals(...lists) {
  const all = lists.flat().filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of all) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// Samples a boolean test every stepMs over [startMs, endMs] and bisects each change to tolMs.
export function scanPredicate(test, startMs, endMs, stepMs, tolMs = EDGE_TOL_MS) {
  const out = [];
  let prevT = startMs, prev = test(startMs);
  let openAt = prev ? startMs : null;
  while (prevT < endMs) {
    const t = Math.min(prevT + stepMs, endMs);
    const cur = test(t);
    if (cur !== prev) {
      let lo = prevT, hi = t;
      while (hi - lo > tolMs) { const mid = (lo + hi) / 2; if (test(mid) === prev) lo = mid; else hi = mid; }
      const cross = Math.round((lo + hi) / 2);
      if (cur) openAt = cross; else { out.push([openAt, cross]); openAt = null; }
    }
    prevT = t; prev = cur;
  }
  if (openAt !== null) out.push([openAt, endMs]);
  return out;
}

// Sampling step: 60 s, or a 120th of the period for orbits shorter than 2 h. A low orbit's pass over a
// site lasts about 10 minutes, so 60 s resolves it; passes shorter than one step can be missed.
export function stepFor(periodS) {
  return Math.max(10e3, Math.min(60e3, (periodS * 1000) / 120));
}

// The two tests for one instant: the site sees the relay above its skyline (and above minElDeg), and the
// relay sees the Earth. mask is a function of azimuth (terrain.skylineFor) or a constant angle.
function makeTests(orbit, eph, site, mask, minElDeg, siteRadiusKm) {
  const maskAt = typeof mask === 'function' ? mask : () => (mask ?? 0);
  const look = (t) => lookAngles(orbit.fixed(t), site, siteRadiusKm);
  const inView = (t) => {
    const r = look(t);
    return r.elDeg > maskAt(r.azDeg) && r.elDeg >= minElDeg;
  };
  const seesEarth = (t) => {
    const d = eph.at(t);
    return !!d && relaySeesEarth(orbit.fixed(t), d.earth, d.earthRangeKm);
  };
  const link = (t) => {
    const sat = orbit.fixed(t);
    const r = lookAngles(sat, site, siteRadiusKm);
    if (!(r.elDeg > maskAt(r.azDeg) && r.elDeg >= minElDeg)) return false;
    const d = eph.at(t);
    return !!d && relaySeesEarth(sat, d.earth, d.earthRangeKm);
  };
  return { look, inView, seesEarth, link };
}

// Relay figures for one scenario.
// params: {
//   elements,                 orbit elements; epochMs null → defaultEpochMs (pass the planned landing time
//                             for both scenarios, so the alternative sees the orbit later in its motion)
//   eph,                      ephemeris.createEphemeris() object
//   site: { latDeg, lonDeg, heightM? },  heightM (optional) raises the observer above the mean radius
//   mask,                     skyline function of azimuth, or a constant angle in degrees
//   startMs, endMs,           the stay (clip to the ephemeris beforehand, as windows.summarize does)
//   earthIntervals,           direct-to-Earth visibility [[a, b], …] for the same stay (summarize().earthIntervals)
//   minElDeg = 0,             minimum relay elevation, an absolute floor on top of the skyline
//   maxWindows = 5,           how many link windows to describe
//   defaultEpochMs,           epoch used when elements.epochMs is null (falls back to startMs)
//   stepMs,                   sampling step override (default stepFor(period))
// }
export function relaySummary({ elements, eph, site, mask = 0, startMs, endMs, earthIntervals = [], minElDeg = 0, maxWindows = 5, stepMs, defaultEpochMs }) {
  const epochMs = Number.isFinite(elements.epochMs) ? elements.epochMs : Number.isFinite(defaultEpochMs) ? defaultEpochMs : startMs;
  const orbit = createOrbit({ ...elements, epochMs });
  const step = stepMs ?? stepFor(orbit.periodS);
  const siteRadiusKm = MOON_RADIUS_KM + (Number.isFinite(site.heightM) ? site.heightM / 1000 : 0);
  const t = makeTests(orbit, eph, site, mask, minElDeg, siteRadiusKm);
  const viewIntervals = scanPredicate(t.inView, startMs, endMs, step);
  // the link can only be up while the relay is in view, so scan inside those intervals only
  const linkIntervals = [];
  for (const [a, b] of viewIntervals) {
    for (const iv of scanPredicate(t.seesEarth, a, b, step)) linkIntervals.push(iv);
  }
  const direct = intersectIntervals(earthIntervals, [[startMs, endMs]]);
  const anyIntervals = unionIntervals(direct, linkIntervals);
  const windows = linkIntervals.slice(0, maxWindows).map(([a, b]) => {
    let peak = -90;
    for (let x = a; x <= b; x += Math.max(10e3, (b - a) / 40)) peak = Math.max(peak, t.look(x).elDeg);
    peak = Math.max(peak, t.look(b).elDeg);
    return { startMs: a, endMs: b, durMs: b - a, peakElDeg: peak };
  });
  return {
    startMs, endMs, stayMs: endMs - startMs, stepMs: step, epochMs, periodS: orbit.periodS,
    viewIntervals, viewMs: totalMs(viewIntervals),
    linkIntervals, relayMs: totalMs(linkIntervals), longestRelayGapMs: longestGapMs(linkIntervals, startMs, endMs),
    windowCount: linkIntervals.length, windows,
    directIntervals: direct, directMs: totalMs(direct), longestDirectGapMs: longestGapMs(direct, startMs, endMs),
    anyIntervals, anyMs: totalMs(anyIntervals), longestBlindMs: longestGapMs(anyIntervals, startMs, endMs),
  };
}

// Convenience for a scenario described by windows.summarize() output.
export function relayForSummary(summary, { elements, eph, site, mask, minElDeg = 0, maxWindows = 5, defaultEpochMs }) {
  if (!summary || !(summary.endMs > summary.startMs)) return null;
  return relaySummary({
    elements, eph, site, mask, minElDeg, maxWindows, defaultEpochMs,
    startMs: summary.startMs, endMs: summary.endMs, earthIntervals: summary.earthIntervals ?? [],
  });
}

