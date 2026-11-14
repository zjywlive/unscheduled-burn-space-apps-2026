// The rover's attitude on the terrain (pure; no DOM): yaw is the heading of travel, pitch the grade along it
// (+ nose up), roll the grade across it (+ right side up), from the terrain gradient under the rover.
// Heights come from heightAt(latDeg, lonDeg) → metres (the real terrain, not the exaggerated view); the
// gradient is taken over baselineKm each side, so it reflects the slope at that scale.
const RAD = Math.PI / 180, DEG = 180 / Math.PI, KM_PER_DEG = (1737.4 * Math.PI) / 180;

// Initial great-circle bearing from one point to another, degrees clockwise from north.
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * DEG + 360) % 360;
}

export const compassName = (deg) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

// Gradient (tan, east and north components) by central differences over ±baselineKm.
export function gradientAt(heightAt, latDeg, lonDeg, baselineKm) {
  const dLat = baselineKm / KM_PER_DEG, dLon = baselineKm / (KM_PER_DEG * Math.max(1e-6, Math.cos(latDeg * RAD)));
  const n = heightAt(latDeg + dLat, lonDeg), s = heightAt(latDeg - dLat, lonDeg), e = heightAt(latDeg, lonDeg + dLon), w = heightAt(latDeg, lonDeg - dLon);
  if (![n, s, e, w].every(Number.isFinite)) return null;
  const span = 2 * baselineKm * 1000;
  return { gE: (e - w) / span, gN: (n - s) / span };
}

// → { pitchDeg, rollDeg, yawDeg, slopeDeg, downhillDeg } | null
export function attitudeAt(heightAt, latDeg, lonDeg, headingDeg, baselineKm) {
  const g = gradientAt(heightAt, latDeg, lonDeg, baselineKm);
  if (!g) return null;
  const h = headingDeg * RAD;
  const along = g.gN * Math.cos(h) + g.gE * Math.sin(h);     // rise per metre ahead
  const across = g.gE * Math.cos(h) - g.gN * Math.sin(h);    // rise per metre to the right
  return {
    pitchDeg: Math.atan(along) * DEG,
    rollDeg: Math.atan(across) * DEG,
    yawDeg: ((headingDeg % 360) + 360) % 360,
    slopeDeg: Math.atan(Math.hypot(g.gE, g.gN)) * DEG,
    downhillDeg: (Math.atan2(-g.gE, -g.gN) * DEG + 360) % 360,
  };
}

// How close a value is to its limit: 'ok' (under 70 %), 'near' (up to the limit), 'over'.
export const limitLevel = (deg, limitDeg) => (!Number.isFinite(limitDeg) ? 'ok' : Math.abs(deg) > limitDeg ? 'over' : Math.abs(deg) > 0.7 * limitDeg ? 'near' : 'ok');
