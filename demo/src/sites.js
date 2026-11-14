// Landing sites: lookup, custom coordinate parsing and coordinate formatting (spec §6.3, §9.3, §9.4).
import { normalizeLon } from './geometry.js';

const LAT_ERROR = 'Enter a latitude between −90 and 90.';
const LON_ERROR = 'Enter an east longitude between −180 and 360.';
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)$/;

export function findSite(sites, id) {
  return sites.find((s) => s.id === id) ?? null;
}

function parseNumber(str) {
  const s = String(str ?? '').trim().replace(',', '.').replace('−', '-');
  if (!NUMBER.test(s)) return NaN;
  return Number(s) + 0;
}

export function parseCustomSite(latStr, lonStr) {
  const lat = parseNumber(latStr);
  if (!(lat >= -90 && lat <= 90)) return { ok: false, field: 'lat', message: LAT_ERROR };
  const lon = parseNumber(lonStr);
  if (!(lon >= -180 && lon <= 360)) return { ok: false, field: 'lon', message: LON_ERROR };
  return { ok: true, site: { id: 'custom', name: 'Custom site', subtitle: '', latDeg: lat, lonDeg: normalizeLon(lon) + 0, verified: true } };
}

export function formatCoords(site) {
  const lat = `${Math.abs(site.latDeg).toFixed(2)}°${site.latDeg < 0 ? 'S' : 'N'}`;
  const lon = site.lonDeg > 180 ? `${(360 - site.lonDeg).toFixed(2)}°W` : `${site.lonDeg.toFixed(2)}°E`;
  return `${lat} ${lon}`;
}
