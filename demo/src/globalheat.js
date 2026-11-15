// Sun and Earth over the whole Moon, for the Map's globe outside the polar data (pure; browser and Node).
// A lat/lon grid of cells; at each time step a cell has the Sun (or the Earth) when its direction is above the
// cell's horizontal plane: a SMOOTH horizon, no terrain (the polar cap uses the real LOLA skyline grids instead,
// heat.js). That is a fair first look away from the poles, where the Sun and Earth stand high and the terrain
// hides them only near sunrise and sunset; it is wrong in deep craters and near the poles, which is why the polar
// cap keeps its own grids. Earth parallax (under 1°) is left out.
//
// Grid: w = 360 / stepDeg columns from 0°E eastward, h = 180 / stepDeg rows from 90°N southward; cell (i, j)
// centre at lon (i + 0.5)·step, lat 90 − (j + 0.5)·step.
const RAD = Math.PI / 180;

export function globalGrid(stepDeg = 1) {
  const w = Math.round(360 / stepDeg), h = Math.round(180 / stepDeg);
  const n = new Float32Array(w * h * 3);
  for (let j = 0; j < h; j++) {
    const lat = (90 - (j + 0.5) * stepDeg) * RAD, cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < w; i++) {
      const lon = (i + 0.5) * stepDeg * RAD, k = (j * w + i) * 3;
      n[k] = cl * Math.cos(lon); n[k + 1] = cl * Math.sin(lon); n[k + 2] = sl;   // geometry.js unitFromLonLat
    }
  }
  return { w, h, stepDeg, n };
}

// Share of [startMs, endMs] with the Sun, the Earth, and both above the smooth horizon, per cell (0–1).
export function globalFractions(grid, eph, startMs, endMs, { stepMs = 2 * 3600e3 } = {}) {
  const { w, h, n } = grid, N = w * h;
  const sun = new Float32Array(N), earth = new Float32Array(N), both = new Float32Array(N);
  let steps = 0;
  for (let t = startMs; t <= endMs; t += stepMs) {
    const d = eph.at(t);
    if (!d) continue;
    steps++;
    const [sx, sy, sz] = d.sun, [ex, ey, ez] = d.earth;
    for (let c = 0, k = 0; c < N; c++, k += 3) {
      const s = n[k] * sx + n[k + 1] * sy + n[k + 2] * sz > 0, e = n[k] * ex + n[k + 1] * ey + n[k + 2] * ez > 0;
      if (s) sun[c]++;
      if (e) earth[c]++;
      if (s && e) both[c]++;
    }
  }
  if (steps) for (let c = 0; c < N; c++) { sun[c] /= steps; earth[c] /= steps; both[c] /= steps; }
  return { sun, earth, both, steps };
}

// Sun (bit 1) and Earth (bit 2) above the smooth horizon at one instant, per cell.
export function globalStates(grid, eph, tMs) {
  const { w, h, n } = grid, out = new Uint8Array(w * h);
  const d = eph.at(tMs);
  if (!d) return out;
  const [sx, sy, sz] = d.sun, [ex, ey, ez] = d.earth;
  for (let c = 0, k = 0; c < out.length; c++, k += 3) {
    out[c] = (n[k] * sx + n[k + 1] * sy + n[k + 2] * sz > 0 ? 1 : 0) | (n[k] * ex + n[k + 1] * ey + n[k + 2] * ez > 0 ? 2 : 0);
  }
  return out;
}
