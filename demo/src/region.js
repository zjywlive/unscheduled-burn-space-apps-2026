// Region statistics and route profiles over the heat grid (task book phase 3 §4.7, §4.8, §5.4).
// Cells are indexed j × size + i like heat.js. Fractions are 0–1 of the stay; hours = fraction × stay.

const MODES = ['both', 'sun', 'earth'];

// Whether a fractionJob has a value for cell k yet: inside its rect, rows already done, not masked out.
// Jobs without a rect (older shapes, plain objects) count as covering every cell.
function computedAt(job, size, k) {
  if (!job) return false;
  const r = job.rect;
  if (r) {
    const j = Math.floor(k / size), i = k - j * size;
    if (i < r.i0 || i > r.i1 || j < r.j0 || j >= r.j0 + (job.done ? r.j1 - r.j0 + 1 : job.rows)) return false;
  }
  return !job.mask || job.mask[k] !== 0;
}

// grid: { size, count, cellKm }. mask: Uint8 per cell, non-zero = inside the region. Optional rect
// { i0, j0, i1, j1 } (inclusive, e.g. from shapes.maskFor) only narrows the scan.
// Means cover the cells that pass the filters (filtered[k] === 0) and that the job has computed.
// With a job, cells it has not computed yet are left out of everything except `cells` and are counted
// in `pending`; pass = passing cells / computed cells. Without a job every cell counts (static figures).
export function regionStats({ grid, mask, rect = null, job = null, slope = null, score = null, filtered = null, mode = 'both', stayMs = 0 }) {
  const size = grid.size;
  const i0 = rect ? Math.max(0, rect.i0) : 0, i1 = rect ? Math.min(size - 1, rect.i1) : size - 1;
  const j0 = rect ? Math.max(0, rect.j0) : 0, j1 = rect ? Math.min(size - 1, rect.j1) : size - 1;
  const values = mode === 'score' ? score : job?.[MODES.includes(mode) ? mode : 'both'] ?? null;
  // With a job, only the cells it has computed count: an uncomputed cell has dark = 0, so it would
  // pass a longest-dark filter it may fail, and its score lacks sun and Earth. They are `pending`.
  let cells = 0, known = 0, passCells = 0, pending = 0, n = 0, sun = 0, earth = 0, both = 0;
  let scoreN = 0, scoreSum = 0, slopeN = 0, slopeSum = 0, bestK = -1, bestV = -Infinity;
  for (let j = j0; j <= j1; j++) {
    for (let k = j * size + i0; k <= j * size + i1; k++) {
      if (!mask[k]) continue;
      cells++;
      const ready = computedAt(job, size, k);
      if (job && !ready) { pending++; continue; }
      known++;
      if (filtered && filtered[k]) continue;
      passCells++;
      if (slope && Number.isFinite(slope[k])) { slopeN++; slopeSum += slope[k]; }
      if (score && Number.isFinite(score[k])) { scoreN++; scoreSum += score[k]; }
      if (ready) { n++; sun += job.sun[k]; earth += job.earth[k]; both += job.both[k]; }
      if (values && (mode === 'score' || ready)) {
        const v = values[k];
        if (Number.isFinite(v) && (v > bestV || (v === bestV && job && ready && job.sun[k] > job.sun[bestK]))) { bestV = v; bestK = k; }
      }
    }
  }
  const mean = (sum, count) => (count ? sum / count : null);
  const stayH = stayMs / 3600e3;
  const out = {
    cells,
    areaKm2: cells * grid.cellKm * grid.cellKm,
    passCells,
    pending,
    sun: mean(sun, n), earth: mean(earth, n), both: mean(both, n),
    pass: known ? passCells / known : null,
    score: mean(scoreSum, scoreN),
    slopeDeg: mean(slopeSum, slopeN),
    best: bestK >= 0 ? { cell: bestK, value: bestV } : null,
  };
  out.hours = { sun: out.sun == null ? null : out.sun * stayH, earth: out.earth == null ? null : out.earth * stayH, both: out.both == null ? null : out.both * stayH };
  return out;
}

// samples: [{ xKm, yKm, dKm }] (from shapes.sampleLine). dem: { heightAtXY(xKm, yKm) → metres | null }.
// slopeDeg is the static per-cell slope (degrees, same grid); sun is the job's Sun fraction (0–1).
// Values that are unknown (off the grid, not computed, array missing) are null.
export function routeProfile({ samples, dem, grid, job = null, slope = null, filtered = null }) {
  const points = [];
  let climbM = 0, prevH = null, maxSlope = null, sunN = 0, sunSum = 0;
  for (const s of samples) {
    const h = dem ? dem.heightAtXY(s.xKm, s.yKm) : null;
    const heightM = Number.isFinite(h) ? h : null;
    const k = grid.cellAt(s.xKm, s.yKm);
    const slopeDeg = k != null && slope && Number.isFinite(slope[k]) ? slope[k] : null;
    const sun = k != null && computedAt(job, grid.size, k) ? job.sun[k] : null;
    const pass = k == null ? null : !(filtered && filtered[k]);
    if (heightM != null) { if (prevH != null && heightM > prevH) climbM += heightM - prevH; prevH = heightM; }
    if (slopeDeg != null && (maxSlope == null || slopeDeg > maxSlope)) maxSlope = slopeDeg;
    if (sun != null) { sunN++; sunSum += sun; }
    points.push({ dKm: s.dKm, xKm: s.xKm, yKm: s.yKm, heightM, slopeDeg, sun, pass });
  }
  return {
    points,
    lengthKm: points.length ? points[points.length - 1].dKm : 0,
    climbM,
    maxSlopeDeg: maxSlope,
    meanSun: sunN ? sunSum / sunN : null,
  };
}
