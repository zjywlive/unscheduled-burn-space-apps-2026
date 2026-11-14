// The slope colour scale shared by the 2D map and the 3D globe: a route coloured by the grade along the way
// (its absolute value, uphill or downhill), in the bands a rover driver reads at a glance. Pure; no DOM.
export const SLOPE_BANDS = Object.freeze([
  { maxDeg: 2, colour: '#22d3ee', label: '0–2°' },
  { maxDeg: 5, colour: '#4ade80', label: '2–5°' },
  { maxDeg: 8, colour: '#facc15', label: '5–8°' },
  { maxDeg: 12, colour: '#fb923c', label: '8–12°' },
  { maxDeg: 15, colour: '#ef4444', label: '12–15°' },
  { maxDeg: Infinity, colour: '#d946ef', label: 'over 15°' },
]);
export const SLOPE_UNKNOWN = '#9aa0a6';

// The band of a grade in degrees (sign ignored); null or NaN → the unknown colour.
export function slopeBand(deg) {
  if (!Number.isFinite(deg)) return null;
  const a = Math.abs(deg);
  return SLOPE_BANDS.find((b) => a < b.maxDeg) ?? SLOPE_BANDS[SLOPE_BANDS.length - 1];
}
export const slopeColour = (deg) => slopeBand(deg)?.colour ?? SLOPE_UNKNOWN;

// '#rrggbb' → [r, g, b] in 0–1 (for three.js vertex colours).
export const rgb01 = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
