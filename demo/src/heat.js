// Heat-map arithmetic over the precomputed terrain-skyline grid (spec phase 2 §2.4, §3.1–§3.2).
// Cells are indexed j × size + i, i to the right (+x), j downwards (−y).
import { fromXY } from './terrain.js';

const R = 1737.4;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const DAY_MS = 86400e3;

export function createHeatGrid({ horizon, size, cellKm, halfKm, azimuths, offsetDeg, stepDeg }) {
  const count = size * size;
  const nx = new Float64Array(count), ny = new Float64Array(count), nz = new Float64Array(count);
  const exs = new Float64Array(count), eys = new Float64Array(count);
  const nnx = new Float64Array(count), nny = new Float64Array(count), nnz = new Float64Array(count);
  const xs = new Float32Array(count), ys = new Float32Array(count);
  const lats = new Float32Array(count), lons = new Float32Array(count);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const x = -halfKm + (i + 0.5) * cellKm, y = halfKm - (j + 0.5) * cellKm;
      const { latDeg, lonDeg } = fromXY(x, y);
      const phi = latDeg * RAD, lam = lonDeg * RAD;
      const cp = Math.cos(phi), sp = Math.sin(phi), cl = Math.cos(lam), sl = Math.sin(lam);
      nx[k] = cp * cl; ny[k] = cp * sl; nz[k] = sp;
      exs[k] = -sl; eys[k] = cl;
      nnx[k] = -sp * cl; nny[k] = -sp * sl; nnz[k] = cp;
      xs[k] = x; ys[k] = y; lats[k] = latDeg; lons[k] = lonDeg;
    }
  }
  // Skyline bytes stay as they are (one row of `azimuths` Uint8 values per cell) and are decoded
  // through a 256-entry table. The table holds the same Float32-rounded degrees the old per-sample
  // copy held, so clearance() is bit-for-bit unchanged while a 640² × 72 grid needs no 118 MB copy.
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) lut[v] = v * stepDeg + offsetDeg;
  const sky = horizon;
  const binsPerRad = azimuths / (2 * Math.PI);

  // Elevation (deg) of direction v minus the skyline in its azimuth, at cell k.
  function clearance(k, vx, vy, vz) {
    const up = vx * nx[k] + vy * ny[k] + vz * nz[k];
    const east = vx * exs[k] + vy * eys[k];
    const north = vx * nnx[k] + vy * nny[k] + vz * nnz[k];
    let a = Math.atan2(east, north);
    if (a < 0) a += 2 * Math.PI;
    const b = a * binsPerRad;
    const b0 = Math.floor(b) % azimuths;
    const f = b - Math.floor(b);
    const base = k * azimuths;
    const h0 = lut[sky[base + b0]];
    const h = h0 + (lut[sky[base + ((b0 + 1) % azimuths)]] - h0) * f;
    return Math.asin(Math.max(-1, Math.min(1, up))) * DEG - h;
  }

  function visibility(k, dirs) {
    const s = dirs.sun;
    let bits = clearance(k, s[0], s[1], s[2]) > 0 ? 1 : 0;
    const e = dirs.earth, rng = dirs.earthRangeKm;
    // Earth with parallax: the direction from the site, not from the Moon's centre.
    const ex = e[0] * rng - R * nx[k], ey = e[1] * rng - R * ny[k], ez = e[2] * rng - R * nz[k];
    const len = Math.hypot(ex, ey, ez);
    if (clearance(k, ex / len, ey / len, ez / len) > 0) bits |= 2;
    return bits;
  }

  // The same two clearances as visibility (deg above the skyline: out[0] the Sun, out[1] the Earth);
  // visibility's bits are exactly (out[0] > 0) | (out[1] > 0) << 1.
  function clearances(k, dirs, out) {
    const s = dirs.sun;
    out[0] = clearance(k, s[0], s[1], s[2]);
    const e = dirs.earth, rng = dirs.earthRangeKm;
    const ex = e[0] * rng - R * nx[k], ey = e[1] * rng - R * ny[k], ez = e[2] * rng - R * nz[k];
    const len = Math.hypot(ex, ey, ez);
    out[1] = clearance(k, ex / len, ey / len, ez / len);
    return out;
  }

  return {
    size, count, cellKm, halfKm,
    cellCenter: (k) => ({ latDeg: lats[k], lonDeg: lons[k], xKm: xs[k], yKm: ys[k] }),
    cellAt(xKm, yKm) {
      const i = Math.floor((xKm + halfKm) / cellKm), j = Math.floor((halfKm - yKm) / cellKm);
      return i >= 0 && j >= 0 && i < size && j < size ? j * size + i : null;
    },
    visibility, clearances,
  };
}

// Sun, Earth and both-in-view fractions per cell over [startMs, endMs], sampled at the middle of
// each step, plus `dark`: the longest run of consecutive samples without the Sun, in hours (capped at
// the stay length). run(budgetMs) works one grid row at a time until the budget is spent or all rows
// are done. `opts` is either a number (the old stepMs argument) or { stepMs, rect, mask }:
// rect = { i0, j0, i1, j1 } (inclusive) limits the cells computed, mask (Uint8, one per cell, 0 = skip)
// limits them further. Cells not computed keep 0 in every output.
export function fractionJob(grid, eph, startMs, endMs, opts) {
  const o = typeof opts === 'number' ? { stepMs: opts } : (opts ?? {});
  const stepMs = o.stepMs ?? 2 * 3600e3;
  const mask = o.mask ?? null;
  const last = grid.size - 1;
  const clampIndex = (v, d) => Math.max(0, Math.min(last, Math.floor(v ?? d)));
  const r = o.rect ?? {};
  const rect = { i0: clampIndex(r.i0, 0), j0: clampIndex(r.j0, 0), i1: clampIndex(r.i1, last), j1: clampIndex(r.j1, last) };
  const total = rect.i1 >= rect.i0 && rect.j1 >= rect.j0 ? rect.j1 - rect.j0 + 1 : 0;

  const n = Math.max(1, Math.ceil((endMs - startMs) / stepMs));
  const dirs = [];
  for (let k = 0; k < n; k++) {
    const d = eph.at(Math.min(endMs, startMs + (k + 0.5) * stepMs));
    if (d) dirs.push(d);
  }
  const stepH = stepMs / 3600e3, stayH = Math.max(0, (endMs - startMs) / 3600e3);
  const sun = new Float32Array(grid.count), earth = new Float32Array(grid.count), both = new Float32Array(grid.count);
  const dark = new Float32Array(grid.count);
  const job = { sun, earth, both, dark, rect, mask, total, stepMs, done: total === 0, progress: total === 0 ? 1 : 0, rows: 0 };
  job.run = (budgetMs) => {
    const until = performance.now() + budgetMs;
    do {
      if (job.rows >= total) break;
      const j = rect.j0 + job.rows;
      for (let k = j * grid.size + rect.i0; k <= j * grid.size + rect.i1; k++) {
        if (mask && !mask[k]) continue;
        let s = 0, e = 0, b = 0, run = 0, longest = 0;
        for (const d of dirs) {
          const v = grid.visibility(k, d);
          if (v & 1) { s++; run = 0; } else if (++run > longest) longest = run;
          if (v & 2) e++;
          if (v === 3) b++;
        }
        const m = dirs.length || 1;
        sun[k] = s / m; earth[k] = e / m; both[k] = b / m;
        dark[k] = Math.min(stayH, longest * stepH);
      }
      job.rows++;
    } while (performance.now() < until);
    job.progress = total ? job.rows / total : 1;
    job.done = job.rows >= total;
    return job.done;
  };
  return job;
}

// Visibility bits per cell at tMs (1 Sun, 2 Earth). Fix H: the array also carries sunDeg and earthDeg
// (Float32Array, deg above the skyline) for the smoothed display, and { rect, mask } (as fractionJob)
// limits the cells computed; others stay 0 with margins NaN.
export function nowStates(grid, eph, tMs, { rect = null, mask = null } = {}) {
  const out = new Uint8Array(grid.count);
  const d = eph.at(tMs);
  const keep = !!grid.clearances;
  if (keep) { out.sunDeg = new Float32Array(grid.count).fill(NaN); out.earthDeg = new Float32Array(grid.count).fill(NaN); }
  if (!d) return out;
  const last = grid.size - 1, cl = (v, def) => Math.max(0, Math.min(last, v ?? def));
  const i0 = cl(rect?.i0, 0), i1 = cl(rect?.i1, last), j0 = cl(rect?.j0, 0), j1 = cl(rect?.j1, last);
  const c = [0, 0];
  for (let j = j0; j <= j1; j++) {
    for (let k = j * grid.size + i0; k <= j * grid.size + i1; k++) {
      if (mask && !mask[k]) continue;
      if (!keep) { out[k] = grid.visibility(k, d); continue; }
      grid.clearances(k, d, c);
      out[k] = (c[0] > 0 ? 1 : 0) | (c[1] > 0 ? 2 : 0);
      out.sunDeg[k] = c[0]; out.earthDeg[k] = c[1];
    }
  }
  return out;
}

// Greedy best cells: highest value first (ties by `tiebreak`), each at least minKm from those already taken.
export function topCells(values, tiebreak, grid, { count = 5, minKm = 20 } = {}) {
  const order = [];
  for (let k = 0; k < values.length; k++) if (values[k] > 0) order.push(k);
  order.sort((a, b) => values[b] - values[a] || tiebreak[b] - tiebreak[a] || a - b);
  const picked = [];
  for (const k of order) {
    const c = grid.cellCenter(k);
    if (picked.every((p) => Math.hypot(p.xKm - c.xKm, p.yKm - c.yKm) >= minKm)) picked.push({ k, xKm: c.xKm, yKm: c.yKm });
    if (picked.length === count) break;
  }
  return picked.map((p) => p.k);
}

export function shareAtLeast(values, threshold) {
  let n = 0;
  for (let k = 0; k < values.length; k++) if (values[k] >= threshold) n++;
  return n / values.length;
}

// Cells whose both-in-view time changes by more than a day between the two landing dates.
export function changeShares(planned, alt, stayMs) {
  let loses = 0, gains = 0;
  for (let k = 0; k < planned.length; k++) {
    const d = (alt[k] - planned[k]) * stayMs;
    if (d < -DAY_MS) loses++;
    else if (d > DAY_MS) gains++;
  }
  return { loses: loses / planned.length, gains: gains / planned.length };
}
