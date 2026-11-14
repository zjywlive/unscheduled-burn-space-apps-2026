// Wraps the Horizons ephemeris JSON: Sun and Earth directions at any instant (spec §6.1, §6.2).
import { unitFromLonLat, lerpDirection, azEl } from './geometry.js';

export function createEphemeris(data) {
  const startMs = Date.parse(data.meta.start);
  const stepMs = data.meta.stepHours * 3600e3;
  const count = data.subSunLon.length;
  const endMs = startMs + (count - 1) * stepMs;
  const sun = data.subSunLon.map((lon, i) => unitFromLonLat(lon, data.subSunLat[i]));
  const earth = data.subEarthLon.map((lon, i) => unitFromLonLat(lon, data.subEarthLat[i]));
  const range = data.earthRangeKm;

  function at(tMs) {
    if (!(tMs >= startMs && tMs <= endMs)) return null;
    const x = (tMs - startMs) / stepMs;
    const i = Math.min(Math.floor(x), count - 2);
    const f = x - i;
    return {
      sun: lerpDirection(sun[i], sun[i + 1], f),
      earth: lerpDirection(earth[i], earth[i + 1], f),
      earthRangeKm: range[i] + (range[i + 1] - range[i]) * f,
    };
  }

  return { startMs, endMs, stepMs, meta: data.meta, at };
}

export function bodyAzEl(eph, site, tMs) {
  const d = eph.at(tMs);
  if (!d) return null;
  return {
    sun: azEl(d.sun, Infinity, site.lonDeg, site.latDeg),
    earth: azEl(d.earth, d.earthRangeKm, site.lonDeg, site.latDeg),
  };
}
