// A synthetic ephemeris with a known analytic answer, in the same shape as demo/data/ephemeris.json.
import { normalizeLon } from '../../demo/src/geometry.js';

export function syntheticData({ days = 40, sunLon0 = 100, sunLonRatePerDay = -12, sunLat = 0, earthLon = 0, earthLat = 0, rangeKm = 384400 } = {}) {
  const n = days * 8 + 1;
  const start = Date.UTC(2027, 0, 1);
  const stop = new Date(start + days * 86400e3).toISOString().replace('.000Z', 'Z');
  const fill = (v) => Array.from({ length: n }, () => v);
  return {
    meta: { source: 'synthetic', ephemeris: 'synthetic', start: '2027-01-01T00:00:00Z', stop, stepHours: 3 },
    subSunLon: Array.from({ length: n }, (_, i) => normalizeLon(sunLon0 + (sunLonRatePerDay * i) / 8)),
    subSunLat: fill(sunLat),
    subEarthLon: fill(earthLon),
    subEarthLat: fill(earthLat),
    earthRangeKm: fill(rangeKm),
  };
}
