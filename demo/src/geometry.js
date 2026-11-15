// Pure spherical geometry in the Moon-fixed frame (spec §6.2).
// Longitude east-positive in [0, 360); azimuth from north, increasing east.

export const MOON_RADIUS_KM = 1737.4;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const ZENITH_EPS_RAD = 1e-6;
const POLE_LIMIT_DEG = 89.9999;

export function normalizeLon(lonDeg) {
  if (lonDeg >= 0 && lonDeg < 360) return lonDeg;   // in range already: as it is (the +360 round trip adds float noise, 172.5649 → 172.56489999999997)
  const v = ((lonDeg % 360) + 360) % 360;
  return v === 360 ? 0 : v;
}

export function unitFromLonLat(lonDeg, latDeg) {
  const lon = lonDeg * RAD;
  const lat = latDeg * RAD;
  const c = Math.cos(lat);
  return [c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)];
}

export function lerpDirection(a, b, f) {
  const x = a[0] + (b[0] - a[0]) * f;
  const y = a[1] + (b[1] - a[1]) * f;
  const z = a[2] + (b[2] - a[2]) * f;
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n];
}

export function azEl(dir, rangeKm, siteLonDeg, siteLatDeg) {
  const n = unitFromLonLat(siteLonDeg, siteLatDeg);
  let v = dir;
  if (Number.isFinite(rangeKm)) {
    v = [dir[0] * rangeKm - MOON_RADIUS_KM * n[0], dir[1] * rangeKm - MOON_RADIUS_KM * n[1], dir[2] * rangeKm - MOON_RADIUS_KM * n[2]];
  }
  const len = Math.hypot(v[0], v[1], v[2]);
  const x = v[0] / len, y = v[1] / len, z = v[2] / len;
  const up = Math.max(-1, Math.min(1, x * n[0] + y * n[1] + z * n[2]));
  const elDeg = Math.asin(up) * DEG;
  const offAxis = Math.acos(Math.abs(up));
  if (offAxis < ZENITH_EPS_RAD || Math.abs(siteLatDeg) > POLE_LIMIT_DEG) return { azDeg: null, elDeg };
  const lam = siteLonDeg * RAD, phi = siteLatDeg * RAD;
  const east = -Math.sin(lam) * x + Math.cos(lam) * y;
  const north = -Math.sin(phi) * Math.cos(lam) * x - Math.sin(phi) * Math.sin(lam) * y + Math.cos(phi) * z;
  const azDeg = normalizeLon(Math.atan2(east, north) * DEG);
  return { azDeg, elDeg };
}
