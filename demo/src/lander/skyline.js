// The local skyline anywhere on the Moon: highest terrain elevation angle in each azimuth, seen from 2 m above
// the ground, ray-marched over a height function heightAt(lat, lon) → metres (the global LOLA terrain,
// globe-terrain.js, outside the polar pyramid). The same construction as terrain.js horizonProfile (great-circle
// steps, curvature, 2 m observer) but on latitude/longitude, so it works at the equator and on the far side.
// Steps: one terrain pixel near the site, then max(pixel, 1.5 % of the distance), out to maxKm.
import { horizonAt } from '../terrain.js';

const R = 1737.4, RAD = Math.PI / 180, DEG = 180 / Math.PI;

export function horizonProfileLL(heightAt, latDeg, lonDeg, { azimuths = 360, maxKm = 180, observerM = 2, kmPerPixel = 0.474 } = {}) {
  const hP = heightAt(latDeg, lonDeg);
  if (!Number.isFinite(hP)) return null;
  const phi = latDeg * RAD, lam = lonDeg * RAD;
  const cp = Math.cos(phi), sp = Math.sin(phi), cl = Math.cos(lam), sl = Math.sin(lam);
  const p0x = cp * cl, p0y = cp * sl, p0z = sp;
  const ex = -sl, ey = cl;                       // local east
  const nx = -sp * cl, ny = -sp * sl, nz = cp;   // local north
  const r0 = R + (hP + observerM) / 1000;
  const cos = [], sin = [];
  for (let d = kmPerPixel; d <= maxKm; d += Math.max(kmPerPixel, 0.015 * d)) { cos.push(Math.cos(d / R)); sin.push(Math.sin(d / R)); }
  const out = new Float32Array(azimuths);
  for (let i = 0; i < azimuths; i++) {
    const a = (i * 2 * Math.PI) / azimuths;   // from north, clockwise (east)
    const ca = Math.cos(a), sa = Math.sin(a);
    const tx = ca * nx + sa * ex, ty = ca * ny + sa * ey, tz = ca * nz;
    let best = -Infinity;
    for (let k = 0; k < cos.length; k++) {
      const px = cos[k] * p0x + sin[k] * tx, py = cos[k] * p0y + sin[k] * ty, pz = cos[k] * p0z + sin[k] * tz;
      const h = heightAt(Math.asin(Math.max(-1, Math.min(1, pz))) * DEG, Math.atan2(py, px) * DEG);
      if (!Number.isFinite(h)) continue;
      const r1 = R + h / 1000;
      const e = Math.atan2(r1 * cos[k] - r0, r1 * sin[k]);
      if (e > best) best = e;
    }
    out[i] = best === -Infinity ? 0 : best * DEG;
  }
  return out;
}

// A skyline mask like terrain.js skylineFor: (azDeg) → horizon elevation (deg), with .profile and .source.
export function skylineLL(heightAt, site, opts = {}) {
  const profile = horizonProfileLL(heightAt, site.latDeg, site.lonDeg, opts);
  if (!profile) return Object.assign(() => 0, { profile: null, source: 'none' });
  return Object.assign((azDeg) => horizonAt(profile, azDeg), { profile, source: opts.source ?? 'computed' });
}

// Great-circle distance (km) and initial bearing (deg from north, clockwise) from a to b.
export function distanceBearing(a, b) {
  const p1 = a.latDeg * RAD, p2 = b.latDeg * RAD, dl = (b.lonDeg - a.lonDeg) * RAD;
  const s = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const km = 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  const br = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * DEG;
  return { km, bearingDeg: (br + 360) % 360 };
}

// The point at distance km and bearing (deg) from a: { latDeg, lonDeg (0–360) }.
export function destination(a, km, bearingDeg) {
  const d = km / R, br = bearingDeg * RAD, p1 = a.latDeg * RAD, l1 = a.lonDeg * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br));
  const l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { latDeg: p2 * DEG, lonDeg: ((l2 * DEG) % 360 + 360) % 360 };
}

// Moon-fixed unit vector → { latDeg, lonDeg (0–360) } (sub-solar / sub-Earth points).
export function subPoint(v) {
  const lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) * DEG;
  return { latDeg: lat, lonDeg: ((Math.atan2(v[1], v[0]) * DEG) % 360 + 360) % 360 };
}
