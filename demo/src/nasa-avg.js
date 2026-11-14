// NASA long-term averages (task book phase 4 §3 T.6, contract §4.3): average Sun visibility and Earth
// visibility over 18.6 years in 1 h steps (Mazarico et al. 2011, 2016 update), as 480 m grids.
// Each pack is size × size Uint8, row 0 at the top (+y), pixel (row, col) covering
// x ∈ [−halfKm + col·k, −halfKm + (col+1)·k), y ∈ (halfKm − (row+1)·k, halfKm − row·k]. Value =
// round(fraction × 250); 255 = no data. Values are read as they are (no interpolation between pixels).

export const NASA_PACKS = Object.freeze({ sun: 'nasa_sun_480m', earth: 'nasa_earth_480m' });
export const NASA_DEFAULTS = Object.freeze({ size: 1350, kmPerPixel: 0.48, halfKm: 324 });
export const NASA_NO_DATA = 255;

// { sun, earth }: the two packs' bytes (either may be missing); meta: terrain.json `nasaAvg` (its sun /
// earth entries may carry size, kmPerPixel, halfKm, scale, noData), defaults per §4.3.
export function createNasaAvg({ sun, earth }, meta = {}) {
  const grid = (bytes, m = {}) => {
    if (!bytes) return null;
    const size = m.size ?? NASA_DEFAULTS.size, k = m.kmPerPixel ?? NASA_DEFAULTS.kmPerPixel, halfKm = m.halfKm ?? NASA_DEFAULTS.halfKm;
    const scale = m.scale ?? 250, noData = m.noData ?? NASA_NO_DATA;
    if (bytes.length < size * size) throw new Error(`nasa-avg: ${bytes.length} bytes, expected ${size * size}`);
    return (xKm, yKm) => {
      const col = Math.floor((xKm + halfKm) / k), row = Math.floor((halfKm - yKm) / k);
      if (!(col >= 0 && row >= 0 && col < size && row < size)) return null;
      const v = bytes[row * size + col];
      return v === noData || v > scale ? null : (v / scale) * 100;    // percent
    };
  };
  const s = grid(sun, meta.sun), e = grid(earth, meta.earth);
  // → { sunPct, earthPct } in percent (a field is null where its grid has no data or is not loaded),
  // or null when neither has a value here
  function sample(xKm, yKm) {
    const sunPct = s ? s(xKm, yKm) : null, earthPct = e ? e(xKm, yKm) : null;
    return sunPct === null && earthPct === null ? null : { sunPct, earthPct };
  }
  return { sample, hasSun: !!s, hasEarth: !!e };
}
