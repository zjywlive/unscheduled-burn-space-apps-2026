// Per-cell filters and the suitability score (task book phase 3 §4.3, §4.4, §5.4).
// All arrays are one value per heat-grid cell, indexed j × size + i like heat.js.

export const DEFAULT_WEIGHTS = { sun: 40, earth: 30, slope: 20, shadow: 10 };
export const SLOPE_SCALE_DEG = 20;
export const SHADOW_SCALE_KM = 50;

// Decodes a static per-cell byte grid: slope bytes × 0.25 = degrees, shadow bytes × 1 = km.
export function staticGrid(bytes, scale) {
  const out = new Float32Array(bytes.length);
  for (let k = 0; k < bytes.length; k++) out[k] = bytes[k] * scale;
  return out;
}

// null (or undefined) limit means Any. Limits are inclusive. A value that is not a finite number
// cannot be shown to pass, so it fails any active limit.
export function passes(slopeDeg, darkH, { maxSlope = null, maxDark = null } = {}) {
  if (maxSlope != null && !(typeof slopeDeg === 'number' && slopeDeg <= maxSlope)) return false;
  if (maxDark != null && !(typeof darkH === 'number' && darkH <= maxDark)) return false;
  return true;
}

// 1 = filtered out, 0 = passes. An active limit whose array is missing filters every cell out.
export function filterMask({ slope = null, dark = null, maxSlope = null, maxDark = null, count }) {
  const n = count ?? slope?.length ?? dark?.length ?? 0;
  const out = new Uint8Array(n);
  if (maxSlope == null && maxDark == null) return out;
  const limits = { maxSlope, maxDark };
  for (let k = 0; k < n; k++) out[k] = passes(slope ? slope[k] : NaN, dark ? dark[k] : NaN, limits) ? 0 : 1;
  return out;
}

// Accepts { sun, earth, slope, shadow } or [sun, earth, slope, shadow] (the hash order).
// Negative or non-numeric weights count as 0.
function weightsOf(w) {
  const v = Array.isArray(w) ? { sun: w[0], earth: w[1], slope: w[2], shadow: w[3] } : (w ?? DEFAULT_WEIGHTS);
  const f = (x) => Math.max(0, +x || 0);
  return { sun: f(v.sun), earth: f(v.earth), slope: f(v.slope), shadow: f(v.shadow) };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Weighted mean of four 0–1 terms: sun fraction, Earth fraction, clamp(1 − slope/20°),
// clamp(1 − shadowKm/50 km), except that a cell inside persistent shadow (shadowKm 0) scores 0 on the
// shadow term: the term rewards sunlit ground within reach of shadow, not the shadow itself (task book
// revision, wave 2). Terms with weight 0 are ignored (their arrays may be null).
// All NaN when the weights sum to 0; NaN in a cell where a weighted input is missing or not finite.
export function scoreCells({ sun = null, earth = null, slope = null, shadowKm = null, weights = DEFAULT_WEIGHTS, count }) {
  const w = weightsOf(weights);
  const n = count ?? sun?.length ?? earth?.length ?? slope?.length ?? shadowKm?.length ?? 0;
  const out = new Float32Array(n);
  const total = w.sun + w.earth + w.slope + w.shadow;
  if (!(total > 0)) return out.fill(NaN);
  for (let k = 0; k < n; k++) {
    let acc = 0;
    if (w.sun) acc += w.sun * clamp01(sun ? sun[k] : NaN);
    if (w.earth) acc += w.earth * clamp01(earth ? earth[k] : NaN);
    if (w.slope) acc += w.slope * clamp01(1 - (slope ? slope[k] : NaN) / SLOPE_SCALE_DEG);
    if (w.shadow) {
      const d = shadowKm ? shadowKm[k] : NaN;
      acc += w.shadow * (d === 0 ? 0 : clamp01(1 - d / SHADOW_SCALE_KM));
    }
    out[k] = acc / total;
  }
  return out;
}
