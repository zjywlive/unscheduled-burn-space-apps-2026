// Typed coordinates (fix R8/R9): the one parser and formatter for every latitude, longitude and distance
// field in the product (route points, shape entry, custom site). Pure functions, no DOM.
//
// Latitude:  "−89.45", "-89.45", "89.45S", "89.45 S", "89.45°S", "89,45 s". North is positive, so a bare
//            "89.45" is 89.45°N, which is outside this south-pole map and refused with a hint.
// Longitude: east 0–360 ("222.6", "222.6E"), negative for west ("-137.4"), or "137.4W". Stored as 0–360 east.
// Distance:  km, "5", "5 km", "5.5km".
//
// Every parse returns { ok: true, value } or { ok: false, code, message } with code one of
//   'empty'    nothing typed
//   'nan'      not a number in an accepted form
//   'range'    a number outside what the quantity can be (latitude beyond ±90, longitude beyond −180–360,
//              a distance not above zero or above the limit)
//   'outside'  a valid coordinate outside the mapped disc (north of maxLatDeg, the terrain grid's edge)
import { TERRAIN_MAX_LAT, toXY, fromXY } from './terrain.js';

export const MAP_EDGE_LAT = TERRAIN_MAX_LAT;   // the mapped disc reaches 80°S, as the map and terrain do
const MINUS = '−';

// "−89.45 °S" → { sign, num, hemi } after normalising; null when the text is not one number.
function tokens(text) {
  const t = String(text ?? '').trim().replace(/[−–]/g, '-').replace(',', '.').replace(/\s+/g, '').replace(/[°º]/g, '').toUpperCase();
  const m = /^([-+]?)(\d+\.?\d*|\.\d+)([NSEW]?)$/.exec(t);
  return m ? { sign: m[1], num: Number(m[2]), hemi: m[3] } : null;
}

const fail = (code, message) => ({ ok: false, code, message });
const blank = (text) => !String(text ?? '').trim();

// Degrees from a coordinate text; axis 'lat' takes N/S, 'lon' takes E/W. A letter of the other axis, or
// a sign together with a letter, is NaN. South and west are negative.
export function parseDegrees(text, axis) {
  const k = tokens(text);
  if (!k) return NaN;
  if (k.hemi && (axis === 'lat' ? !'NS'.includes(k.hemi) : !'EW'.includes(k.hemi))) return NaN;
  if (k.hemi && k.sign) return NaN;
  return (k.sign === '-' || k.hemi === 'S' || k.hemi === 'W' ? -k.num : k.num) + 0;
}

export function parseLat(text, { maxLatDeg = MAP_EDGE_LAT } = {}) {
  if (blank(text)) return fail('empty', 'Enter a latitude, e.g. −89.45 or 89.45S.');
  const v = parseDegrees(text, 'lat');
  if (!Number.isFinite(v)) return fail('nan', 'Enter a latitude, e.g. −89.45 or 89.45S.');
  if (!(v >= -90 && v <= 90)) return fail('range', 'A latitude is between 90°S and 90°N.');
  if (v > maxLatDeg) {
    const n = String(v);
    return fail('outside', v > 0 ? `South latitudes only: write −${n} or ${n}S.` : `Outside the map: use a latitude south of ${Math.abs(maxLatDeg)}°S.`);
  }
  return { ok: true, value: v };
}

export function parseLon(text) {
  if (blank(text)) return fail('empty', 'Enter a longitude, e.g. 222.6 (east) or 137.4W.');
  const v = parseDegrees(text, 'lon');
  if (!Number.isFinite(v)) return fail('nan', 'Enter a longitude, e.g. 222.6 (east) or 137.4W.');
  if (!(v >= -180 && v <= 360)) return fail('range', 'Use 0–360°E, or up to 180 with W for west.');
  return { ok: true, value: (v < 0 ? v + 360 : v >= 360 ? v - 360 : v) + 0 };
}

// A distance in km, above 0 and at most maxKm.
export function parseKm(text, { maxKm = Infinity, what = 'a distance' } = {}) {
  if (blank(text)) return fail('empty', `Enter ${what} in km.`);
  const t = String(text).trim().replace(/km$/i, '').trim().replace(',', '.').replace(/[−–]/g, '-');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return fail('nan', `Enter ${what} in km, e.g. 5 or 12.5.`);
  const v = Number(t) + 0;
  if (!(v > 0)) return fail('range', `Use more than 0 km.`);
  if (v > maxKm) return fail('range', `Use at most ${maxKm} km.`);
  return { ok: true, value: v };
}

// A latitude and longitude pair → { ok: true, latDeg, lonDeg, xy: [xKm, yKm] } or
// { ok: false, field: 'lat' | 'lon', code, message } (the latitude is checked first).
export function parseLatLon(latText, lonText, opts = {}) {
  const lat = parseLat(latText, opts);
  if (!lat.ok) return { ...lat, field: 'lat' };
  const lon = parseLon(lonText);
  if (!lon.ok) return { ...lon, field: 'lon' };
  return { ok: true, latDeg: lat.value, lonDeg: lon.value, xy: toXY(lat.value, lon.value) };
}

// Field texts: latitude and longitude to 3 decimals (≈ 30 m), − as the minus sign; east longitude 0–360.
export const formatLat = (v, digits = 3) => (Number.isFinite(v) ? v.toFixed(digits).replace('-', MINUS) : '');
export const formatLon = (v, digits = 3) => (Number.isFinite(v) ? ((((v % 360) + 360) % 360) + 0).toFixed(digits).replace(/^360\.0+$/, (0).toFixed(digits)) : '');
export const formatKm = (v, digits = 2) => (Number.isFinite(v) ? String(Number(v.toFixed(digits))) : '');

// A map point [xKm, yKm] → { lat, lon } field texts.
export function fieldsFromXY(p) {
  const { latDeg, lonDeg } = fromXY(p[0], p[1]);
  return { lat: formatLat(latDeg), lon: formatLon(lonDeg) };
}
