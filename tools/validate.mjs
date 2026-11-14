// Compares the demo's interpolated geometry with Horizons' lunar-surface observer values.
// Writes demo/data/validation.json; exits non-zero when any difference exceeds the tolerance.
import { readFileSync, writeFileSync } from 'node:fs';
import { createEphemeris, bodyAzEl } from '../demo/src/ephemeris.js';
import { azEl } from '../demo/src/geometry.js';
import { createDem, skylineFor, toXY, TERRAIN_MAX_LAT } from '../demo/src/terrain.js';
import { createHeatGrid, fractionJob } from '../demo/src/heat.js';
import { staticGrid, scoreCells, DEFAULT_WEIGHTS } from '../demo/src/score.js';
import { summarize } from '../demo/src/windows.js';
import { readIllum, psrMask, decode, sunlitShares, bitAt, ILLUM } from './build-nasa.mjs';
import { cellCounts } from './build-static.mjs';
import { blockCorrelation } from './build-tiles.mjs';

const TOLERANCE_DEG = 0.02;
const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const eph = createEphemeris(load('../demo/data/ephemeris.json'));
const sites = load('../demo/data/sites.json');
const reference = load('../demo/data/horizons_reference.json');

const azDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const r6 = (v) => Math.round(v * 1e6) / 1e6;

const rows = reference.cases.map((c) => {
  const site = sites.find((s) => s.id === c.siteId);
  const demo = bodyAzEl(eph, site, c.tMs)[c.body];
  const elDiff = Math.abs(demo.elDeg - c.elDeg);
  const az = demo.azDeg === null || c.azDeg === null ? null : azDiff(demo.azDeg, c.azDeg) * Math.cos((c.elDeg * Math.PI) / 180);
  return { ...c, site, demoElDeg: demo.elDeg, elDiff, azDiff: az };
});

const maxOf = (list, key) => list.reduce((m, r) => (r[key] === null ? m : Math.max(m, r[key])), 0);
const perSite = [...new Set(rows.map((r) => r.siteId))].map((siteId) => {
  const mine = rows.filter((r) => r.siteId === siteId);
  return { siteId, name: mine[0].site.name, maxElDiffDeg: r6(maxOf(mine, 'elDiff')), maxAzDiffDeg: r6(maxOf(mine, 'azDiff')) };
});

// Six samples: the worst elevation difference at each site, then the two worst overall, topped up by rank.
const byErr = [...rows].sort((a, b) => b.elDiff - a.elDiff);
const picked = [];
for (const p of perSite) picked.push(byErr.find((r) => r.siteId === p.siteId));
for (const r of byErr) {
  if (picked.length >= perSite.length + 2) break;
  if (!picked.includes(r)) picked.push(r);
}
const samples = picked.map((r) => ({
  utc: new Date(r.tMs).toISOString().replace(':00.000Z', 'Z'), siteName: r.site.name, body: r.body,
  horizonsElDeg: r6(r.elDeg), demoElDeg: r6(r.demoElDeg), diffDeg: r6(r.demoElDeg - r.elDeg),
}));

// ---------- terrain (spec phase 2 §8) ----------
// Sunlit share over the whole ephemeris at 1-hour steps, seen against the terrain skyline from the
// 480 m grid, with the same geometry and skyline code as the page.
const demBuf = readFileSync(new URL('../demo/data/dem_480m.bin', import.meta.url));
const terrainMeta = load('../demo/data/terrain.json');
const dem = createDem({ data: new Int16Array(demBuf.buffer, demBuf.byteOffset, demBuf.length / 2), size: terrainMeta.dem.size, kmPerPixel: terrainMeta.dem.kmPerPixel, dnToMeters: terrainMeta.dem.dnToMeters });
const features = load('../demo/data/features.json');
const feature = (name) => features.find((f) => f.name === name);
const MAZARICO = 'https://doi.org/10.1016/j.icarus.2010.10.030';
const NOTE = 'Published value is an 18.6-year average; this demo covers Nov 2026 to Jan 2029, uses the disc centre and 480 m terrain.';
const sunlitShare = (latDeg, lonDeg) => {
  const site = { latDeg, lonDeg };
  const sky = skylineFor(dem, site);
  let lit = 0, n = 0;
  for (let t = eph.startMs; t <= eph.endMs; t += 3600e3) {
    const d = eph.at(t);
    const r = azEl(d.sun, Infinity, lonDeg, latDeg);
    if (r.elDeg > sky(r.azDeg)) lit++;
    n++;
  }
  return lit / n;
};
const terrainChecks = [
  ...['Shackleton', 'Shoemaker', 'Haworth', 'Faustini'].map((name) => ({ name: `${name} floor`, latDeg: feature(name).latDeg, lonDeg: feature(name).lonDeg, kind: 'shadow', limit: '< 1%', published: null, source: feature(name).source })),
  { name: 'Shackleton ridge', latDeg: -89.45, lonDeg: 222.69, kind: 'lit', limit: '≥ 50%', published: 0.8901, source: MAZARICO },
  // Further points from the same published table (Mazarico et al. 2011, top five south-pole sites)
  { name: 'Ridge point 2', latDeg: -89.43, lonDeg: 222.73, kind: 'compare', limit: null, published: 0.8860, source: MAZARICO },
  { name: 'Ridge point 3', latDeg: -89.44, lonDeg: 223.28, kind: 'compare', limit: null, published: 0.8713, source: MAZARICO },
  { name: 'Ridge point 4', latDeg: -89.78, lonDeg: 204.27, kind: 'compare', limit: null, published: 0.8671, source: MAZARICO },
].map((c) => {
  const share = sunlitShare(c.latDeg, c.lonDeg);
  const pass = c.kind === 'shadow' ? share < 0.01 : c.kind === 'lit' ? share >= 0.5 : null;
  return { ...c, sunlitShare: Math.round(share * 1e4) / 1e4, pass, note: c.kind === 'shadow' ? null : NOTE };
});
const terrain = { generatedAt: new Date().toISOString(), stepHours: 1, checks: terrainChecks };

// ---------- phase 3 (task book §6 wave 2 H, §7 item 4) ----------
// Slope and persistent-shadow grids, the 1 km heat grid against the 2 km one, and the suitability
// score at default weights. Only §7 item 4 (crater floors at shadow distance 0, the Shackleton ridge
// cell not persistent shadow) is a hard check; everything else is shown only.
const P3_LANDING_MS = Date.UTC(2027, 0, 13), P3_STAY_DAYS = 14;
const P3_END_MS = Math.min(P3_LANDING_MS + P3_STAY_DAYS * 86400e3, eph.endMs);
const r4 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const r2 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const quantiles = (values, qs = [0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) => {
  const v = Float64Array.from(values).sort();
  const out = {};
  for (const q of qs) out[`p${Math.round(q * 100)}`] = r4(v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))]);
  out.mean = r4(v.reduce((a, b) => a + b, 0) / v.length);
  out.max = r4(v[v.length - 1]);
  return out;
};
const readBin = (name) => new Uint8Array(readFileSync(new URL(`../demo/data/${name}`, import.meta.url)));
const levels = Object.fromEntries(['2km', '1km'].map((tag) => {
  const hz = terrainMeta.horizons.find((h) => h.name === (tag === '2km' ? 'horizon_grid' : 'horizon_1km'));
  const sl = terrainMeta.slope.find((s) => s.name === `slope_${tag}`);
  const sh = terrainMeta.shadow.find((s) => s.name === `shadow_${tag}`);
  const grid = createHeatGrid({ ...hz, horizon: readBin(hz.file) });
  const inside = new Uint8Array(grid.count);
  for (let k = 0; k < grid.count; k++) inside[k] = grid.cellCenter(k).latDeg <= TERRAIN_MAX_LAT ? 1 : 0;
  const slope = staticGrid(readBin(sl.file), sl.scale);
  const shadowKm = staticGrid(readBin(sh.file), 1);
  const cellOf = (latDeg, lonDeg) => grid.cellAt(...toXY(latDeg, lonDeg));
  const insideValues = (arr) => { const o = []; for (let k = 0; k < grid.count; k++) if (inside[k]) o.push(arr[k]); return o; };
  return [tag, { tag, grid, inside, slope, shadowKm, cellOf, insideValues, cellKm: hz.cellKm }];
}));
const tags = Object.keys(levels);
const shack = feature('Shackleton');
const RIDGE = { latDeg: -89.45, lonDeg: 222.69 };

// Slope: Shackleton floor cell, the wall ring 6–8 km from the crater centre, the whole map.
const slopeChecks = tags.map((tag) => {
  const L = levels[tag];
  const [sx, sy] = toXY(shack.latDeg, shack.lonDeg);
  let wall = 0, n = 0;
  for (let k = 0; k < L.grid.count; k++) {
    const c = L.grid.cellCenter(k);
    const d = Math.hypot(c.xKm - sx, c.yKm - sy);
    if (d >= 6 && d <= 8) { wall += L.slope[k]; n++; }
  }
  return {
    name: `Slope sanity, ${tag} grid`, grid: tag, shackletonFloorDeg: r2(L.slope[L.cellOf(shack.latDeg, shack.lonDeg)]),
    shackletonWallRingDeg: r2(wall / n), wallRingCells: n, wallRingKm: [6, 8],
    mapDeg: quantiles(L.insideValues(L.slope)), pass: null, limit: null,
  };
});

// Persistent shadow: the four floors and the ridge cell (hard), share of the 80°S disc (shown only).
const FLOOR_NAMES = ['Shackleton', 'Shoemaker', 'Haworth', 'Faustini'];
const shadowPoints = [];
for (const tag of tags) {
  const L = levels[tag];
  for (const name of FLOOR_NAMES) {
    const f = feature(name);
    const km = L.shadowKm[L.cellOf(f.latDeg, f.lonDeg)];
    shadowPoints.push({ name: `${name} floor shadow distance, ${tag} grid`, grid: tag, latDeg: f.latDeg, lonDeg: f.lonDeg, shadowKm: km, limit: '= 0 km', pass: km === 0 });
  }
  const km = L.shadowKm[L.cellOf(RIDGE.latDeg, RIDGE.lonDeg)];
  shadowPoints.push({ name: `Shackleton ridge not persistent shadow, ${tag} grid`, grid: tag, ...RIDGE, shadowKm: km, limit: '> 0 km', pass: km > 0 });
}
const shadowShares = tags.map((tag) => {
  const L = levels[tag];
  const v = L.insideValues(L.shadowKm);
  const zero = v.filter((x) => x === 0).length;
  return { name: `Persistent shadow share south of 80°S, ${tag} grid`, grid: tag, cells: zero, of: v.length, share: r4(zero / v.length), shadowKm: quantiles(v), pass: null, limit: null };
});

// 1 km against 2 km: sunlit share over the default stay, whole map and the named sites south of 80°S.
const t0 = Date.now();
const jobs = {};
for (const tag of tags) {
  const job = fractionJob(levels[tag].grid, eph, P3_LANDING_MS, P3_END_MS);
  while (!job.run(1e9));
  jobs[tag] = job;
}
const jobMs = Date.now() - t0;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sunMean = Object.fromEntries(tags.map((t) => [t, mean(levels[t].insideValues(jobs[t].sun))]));
// Block comparison: each 2 km cell against the mean of the four 1 km cells it covers (both grids span ±320 km).
const L2 = levels['2km'], L1 = levels['1km'];
const blockDiffs = [];
for (let j = 0; j < L2.grid.size; j++) for (let i = 0; i < L2.grid.size; i++) {
  const k = j * L2.grid.size + i;
  if (!L2.inside[k]) continue;
  const s1 = L1.grid.size, a = 2 * j * s1 + 2 * i;
  const m = (jobs['1km'].sun[a] + jobs['1km'].sun[a + 1] + jobs['1km'].sun[a + s1] + jobs['1km'].sun[a + s1 + 1]) / 4;
  blockDiffs.push(Math.abs(m - jobs['2km'].sun[k]));
}
const dem240Buf = readFileSync(new URL('../demo/data/dem_240m.bin', import.meta.url));
const lvl240 = terrainMeta.levels.find((l) => l.name === 'dem_240m');
const dem240 = createDem({ data: new Int16Array(dem240Buf.buffer, dem240Buf.byteOffset, dem240Buf.length / 2), size: lvl240.size, kmPerPixel: lvl240.kmPerPixel, dnToMeters: lvl240.dnToMeters, halfKm: lvl240.halfKm });
const pointSun = (demX, site) => { const s = summarize(eph, site, P3_LANDING_MS, P3_STAY_DAYS, skylineFor(demX, site)); return s.sunMs / s.stayMs; };
const siteRows = sites.filter((s) => s.latDeg <= TERRAIN_MAX_LAT).map((s) => ({
  siteId: s.id, name: s.name, latDeg: s.latDeg, lonDeg: s.lonDeg,
  grid2km: r4(jobs['2km'].sun[L2.cellOf(s.latDeg, s.lonDeg)]), grid1km: r4(jobs['1km'].sun[L1.cellOf(s.latDeg, s.lonDeg)]),
  point480m: r4(pointSun(dem, s)), point240m: r4(pointSun(dem240, s)),
}));
for (const r of siteRows) r.closerToPoint = Math.abs(r.grid1km - r.point480m) < Math.abs(r.grid2km - r.point480m) ? '1km' : Math.abs(r.grid1km - r.point480m) > Math.abs(r.grid2km - r.point480m) ? '2km' : 'tie';
const consistency = {
  name: '1 km and 2 km sunlit share, default stay', landingUtc: new Date(P3_LANDING_MS).toISOString(), stayDays: P3_STAY_DAYS, stepHours: 2,
  mapMeanSun: { '2km': r4(sunMean['2km']), '1km': r4(sunMean['1km']), diff: r4(sunMean['1km'] - sunMean['2km']) },
  blockAbsDiff: quantiles(blockDiffs, [0.5, 0.9, 0.99]),
  sites: siteRows, jobMs, pass: null, limit: null,
  note: 'point480m is what the point card shows (480 m DEM skyline at the exact point, 15-minute scan). point240m uses the 240 m crop, whose rays stop at ±324 km.',
};

// Suitability at default weights over the same stay.
const scores = tags.map((tag) => {
  const L = levels[tag], J = jobs[tag];
  const sc = scoreCells({ sun: J.sun, earth: J.earth, slope: L.slope, shadowKm: L.shadowKm, weights: DEFAULT_WEIGHTS, count: L.grid.count });
  const at = (latDeg, lonDeg) => { const k = L.cellOf(latDeg, lonDeg); return { score: r4(sc[k]), sun: r4(J.sun[k]), earth: r4(J.earth[k]), slopeDeg: r2(L.slope[k]), shadowKm: L.shadowKm[k] }; };
  return {
    name: `Suitability at default weights, ${tag} grid`, grid: tag, weights: DEFAULT_WEIGHTS, map: quantiles(L.insideValues(sc)),
    floors: FLOOR_NAMES.map((n) => ({ name: `${n} floor`, ...at(feature(n).latDeg, feature(n).lonDeg) })),
    ridge: { name: 'Shackleton ridge', ...at(RIDGE.latDeg, RIDGE.lonDeg) }, pass: null, limit: null,
  };
});

const phase3 = {
  generatedAt: new Date().toISOString(), hardChecks: '§7 item 4: crater floors at shadow distance 0, Shackleton ridge cell not persistent shadow',
  slope: slopeChecks, shadow: { points: shadowPoints, shares: shadowShares }, consistency, suitability: scores,
};

// ---------- phase 4 (task book §3 D.6) ----------
// Our sunlit share (2 km skyline grid, whole ephemeris, 1 h steps) against the official 18.6-year
// average, the phase 3 persistent-shadow cells against the official PSR map, and georeferencing checks of
// the new products. These are comparisons, not pass/fail gates.
const P4_T0 = Date.now();
const illum = { psr: readIllum('psr'), sun: readIllum('sun'), earth: readIllum('earth') };
const { mask: psrFull } = psrMask(illum.psr.data, illum.psr.label);
const SRC = 7624, SO = SRC / 2 - 0.5, PKM = 0.12;
const srcIndex = (x, y) => Math.round(SO - y / PKM) * SRC + Math.round(x / PKM + SO);   // pixel holding (x, y)
// Per-cell means of the official values over the 120 m pixels whose centres fall in each cell.
function officialCellMeans(L, src, label) {
  const { size, cellKm, halfKm } = L.grid;
  const sum = new Float64Array(size * size), n = new Uint32Array(size * size);
  for (let r = 0; r < SRC; r++) {
    const j = Math.floor((halfKm - (SO - r) * PKM) / cellKm);
    if (j < 0 || j >= size) continue;
    for (let c = 0; c < SRC; c++) {
      const i = Math.floor(((c - SO) * PKM + halfKm) / cellKm);
      if (i < 0 || i >= size) continue;
      sum[j * size + i] += decode(label, src[r * SRC + c]);
      n[j * size + i]++;
    }
  }
  return Float64Array.from(sum, (s, k) => s / n[k]);
}
const pearson = (a, b) => {
  const m = a.length, ma = a.reduce((x, y) => x + y, 0) / m, mb = b.reduce((x, y) => x + y, 0) / m;
  let sab = 0, saa = 0, sbb = 0;
  for (let k = 0; k < m; k++) { sab += (a[k] - ma) * (b[k] - mb); saa += (a[k] - ma) ** 2; sbb += (b[k] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
};

// Whole-ephemeris shares on the 2 km grid (worker threads), plus the phase 3 test on its 6 h sub-grid.
const hz2 = terrainMeta.horizons.find((h) => h.name === 'horizon_grid');
const hz1 = terrainMeta.horizons.find((h) => h.name === 'horizon_1km');
const share2 = await sunlitShares({ h: hz2, cells: L2.inside, stepH: 1, coarseH: 6 });
const old1 = await sunlitShares({ h: hz1, cells: L1.inside, stepH: 1, coarseH: 6, coarseOnly: true });
const p4SamplesPerCell = Math.floor((eph.endMs - eph.startMs) / 3600e3) + 1;
const shareMs = Date.now() - P4_T0;

function compareShares(kind, ours) {
  const off = officialCellMeans(L2, illum[kind].data, illum[kind].label);
  const a = [], b = [], bc = [], cells = [];
  for (let k = 0; k < L2.grid.count; k++) {
    if (!L2.inside[k]) continue;
    const c = L2.grid.cellCenter(k);
    a.push(ours[k]); b.push(off[k]); bc.push(decode(illum[kind].label, illum[kind].data[srcIndex(c.xKm, c.yKm)])); cells.push(k);
  }
  let sad = 0, sd = 0, sadc = 0;
  for (let m = 0; m < a.length; m++) { sad += Math.abs(a[m] - b[m]); sd += a[m] - b[m]; sadc += Math.abs(a[m] - bc[m]); }
  const order = cells.map((k, m) => m).sort((p, q) => Math.abs(a[q] - b[q]) - Math.abs(a[p] - b[p])).slice(0, 5);
  // shift test: correlation with the official cell means moved by one cell each way
  const shifted = {};
  for (const [name, di, dj] of [['east', 1, 0], ['west', -1, 0], ['north', 0, -1], ['south', 0, 1]]) {
    const x = [], y = [];
    for (let m = 0; m < cells.length; m++) {
      const k = cells[m], i = k % L2.grid.size + di, j = Math.floor(k / L2.grid.size) + dj;
      if (i < 0 || j < 0 || i >= L2.grid.size || j >= L2.grid.size) continue;
      x.push(a[m]); y.push(off[j * L2.grid.size + i]);
    }
    shifted[name] = r4(pearson(x, y));
  }
  return {
    name: `Our ${kind === 'sun' ? 'sunlit' : 'Earth-in-view'} share vs the official 18.6-year average, 2 km grid`, grid: '2km', cells: a.length,
    ours: `${kind === 'sun' ? 'Sun' : 'Earth'} disc centre above the cell skyline (72 azimuths from the 240 m DEM), every hour from ${new Date(eph.startMs).toISOString().slice(0, 10)} to ${new Date(eph.endMs).toISOString().slice(0, 10)} (${p4SamplesPerCell} samples)`,
    official: `${ILLUM[kind]}.IMG: any part of the ${kind === 'sun' ? 'solar' : 'Earth'} disc visible, 18.6 years at 1 h steps, 120 m; per cell, the mean of the 120 m pixels whose centres fall in it`,
    correlation: r4(pearson(a, b)), meanAbsDiff: r4(sad / a.length), meanDiff: r4(sd / a.length),
    correlationAtCellCentre: r4(pearson(a, bc)), meanAbsDiffAtCellCentre: r4(sadc / a.length),
    correlationShiftedOneCell: shifted,
    oursMean: r4(a.reduce((x, y) => x + y, 0) / a.length), officialMean: r4(b.reduce((x, y) => x + y, 0) / b.length),
    worst: order.map((m) => {
      const c = L2.grid.cellCenter(cells[m]);
      return { cell: cells[m], latDeg: r4(c.latDeg), lonDeg: r4(c.lonDeg), xKm: c.xKm, yKm: c.yKm, ours: r4(a[m]), official: r4(b[m]), officialAtCentre: r4(bc[m]), diff: r4(a[m] - b[m]) };
    }),
    pass: null, limit: null,
  };
}
const sunVsOfficial = compareShares('sun', share2.sun);
const earthVsOfficial = compareShares('earth', share2.earth);

// Phase 3 persistent shadow (Sun centre never above the skyline at any 6 h sample) against the official
// PSR map with the phase 4 cell rule (more than half of the 120 m pixels PSR).
function oldVsPsr(L, lit) {
  const { set, n } = cellCounts(psrFull, SRC, PKM, L.grid);
  let both = 0, oldOnly = 0, psrOnly = 0, neither = 0;
  for (let k = 0; k < L.grid.count; k++) {
    if (!L.inside[k]) continue;
    const old = !lit[k], psr = 2 * set[k] > n[k];
    if (old && psr) both++; else if (old) oldOnly++; else if (psr) psrOnly++; else neither++;
  }
  const cells = both + oldOnly + psrOnly + neither;
  return {
    name: `Phase 3 persistent shadow vs official PSR, ${L.tag} grid`, grid: L.tag, cells,
    oldShadowCells: both + oldOnly, officialPsrCells: both + psrOnly, both, oldOnly, psrOnly, neither,
    agreement: r4((both + neither) / cells),
    missedShareOfPsr: r4(psrOnly / (both + psrOnly)),          // official PSR cells the old rule called lit
    falseShareOfOld: r4(oldOnly / (both + oldOnly)),           // old shadow cells the official map does not call PSR
    rule: 'old: the Sun centre never clears the cell skyline at any 6 h sample, Nov 2026 to Jan 2029; official: more than half of the cell’s 120 m pixels are PSR',
    pass: null, limit: null,
  };
}
const oldPsr = [oldVsPsr(L2, share2.lit), oldVsPsr(L1, old1.lit)];

// New shadow grids: share of cells at 0 south of 80°S (compare with phase3.shadow.shares).
const newShadowShares = tags.map((tag) => {
  const v = levels[tag].insideValues(levels[tag].shadowKm);
  return { grid: tag, zeroCells: v.filter((x) => x === 0).length, of: v.length, share: r4(v.filter((x) => x === 0).length / v.length), shadowKm: quantiles(v) };
});

// Georeferencing.
const geoT0 = Date.now();
const tilesOf = (l) => new Map(l.tiles.map((id) => [id, (() => { const b = readFileSync(new URL(`../demo/data/${l.name}_${id}.bin`, import.meta.url)); return new Int16Array(b.buffer, b.byteOffset, b.length / 2); })()]));
const d120 = (() => { const b = readFileSync(new URL('../demo/data/dem_120m.bin', import.meta.url)); return { data: new Int16Array(b.buffer, b.byteOffset, b.length / 2), size: 2600, kmPerPixel: 0.12 }; })();
const tileGeo = terrainMeta.levels.filter((l) => l.tiled).map((l) => {
  const tiles = tilesOf(l), f = Math.round(0.12 / l.kmPerPixel);
  const at = (dr, dc) => { const s = blockCorrelation(l, tiles, d120, { dr, dc }); return { r: r6(s.r), meanAbsDiffM: r2(s.madM), biasM: r2(s.biasM), pixels: s.n }; };
  return {
    name: `${l.name} ${f} × ${f} block means vs dem_120m`, level: l.name, tiles: l.tiles.length, stride: 2,
    zeroShift: at(0, 0),
    shiftedOneFinePixel: { east: at(0, 1), north: at(-1, 0) },
    shiftedOne120mPixel: { east: at(0, f), west: at(0, -f), north: at(-f, 0), south: at(f, 0) },
    pass: null, limit: null,
  };
});
// PSR: floor points, PSR share near each floor point, the Shackleton rim ring and the ridge.
const PSR_BITS = readFileSync(new URL('../demo/data/psr_120m.bin', import.meta.url));
const psrAtXY = (x, y) => bitAt(PSR_BITS, 5400, Math.floor((324 - y) / 0.12), Math.floor((x + 324) / 0.12));
const ringShare = (cx, cy, r0, r1) => {
  let n = 0, s = 0;
  for (let r = r0; r <= r1 + 1e-9; r += 0.12) for (let a = 0; a < 360; a += 0.5) { s += psrAtXY(cx + r * Math.sin(a * Math.PI / 180), cy + r * Math.cos(a * Math.PI / 180)); n++; }
  return s / n;
};
const psrGeo = FLOOR_NAMES.map((name) => {
  const f = feature(name), [x, y] = toXY(f.latDeg, f.lonDeg);
  return { name: `${name} floor`, latDeg: f.latDeg, lonDeg: f.lonDeg, psrAtPoint: psrAtXY(x, y), psrShareWithin1Km: r4(ringShare(x, y, 0, 1)), psrShareWithin3Km: r4(ringShare(x, y, 0, 3)) };
});
const [shx, shy] = toXY(shack.latDeg, shack.lonDeg);
const shackletonRim = { name: 'Shackleton rim ring, 10–11.5 km from the centre (diameter 20.92 km)', psrShare: r4(ringShare(shx, shy, 10, 11.5)), floorPsrShareWithin2Km: r4(ringShare(shx, shy, 0, 2)) };
// PSR mask against dem_120m: mean height of PSR pixels (±150 km) relative to a 25 × 25 pixel (3 km)
// window mean, with the mask shifted by whole pixels. Crater floors are local lows, so a misplaced mask
// lands partly on walls and reads higher.
const psrShift = (() => {
  const S = 2600, o = (SRC - S) / 2, W = 12;
  const h = d120.data;
  // integral image of dem_120m for window means
  const I = new Float64Array((S + 1) * (S + 1));
  for (let r = 0; r < S; r++) { let row = 0; for (let c = 0; c < S; c++) { row += h[r * S + c]; I[(r + 1) * (S + 1) + c + 1] = I[r * (S + 1) + c + 1] + row; } }
  const win = (r, c) => { const r0 = r - W, r1 = r + W + 1, c0 = c - W, c1 = c + W + 1; return (I[r1 * (S + 1) + c1] - I[r0 * (S + 1) + c1] - I[r1 * (S + 1) + c0] + I[r0 * (S + 1) + c0]) / ((2 * W + 1) ** 2); };
  const out = {};
  for (const [name, dr, dc] of [['0,0', 0, 0], ['+1 row', 1, 0], ['-1 row', -1, 0], ['+1 col', 0, 1], ['-1 col', 0, -1], ['+2 rows', 2, 0], ['+2 cols', 0, 2]]) {
    let s = 0, n = 0;
    for (let r = W + 3; r < S - W - 3; r++) for (let c = W + 3; c < S - W - 3; c++) {
      if (!psrFull[(r + o + dr) * SRC + c + o + dc]) continue;
      s += h[r * S + c] - win(r, c); n++;
    }
    out[name] = r2((s / n) * 0.5);
  }
  return { name: 'Mean height of PSR pixels minus the 3 km window mean on dem_120m (m), mask shifted by whole 120 m pixels', within: '±150 km', metres: out };
})();
// Official Sun visibility at the published top-illumination points (Mazarico et al. 2011): the value at
// the point and the largest value within 300 m (the published coordinates are rounded to 0.01°).
const topPoints = terrainChecks.filter((c) => c.published !== null).map((c) => {
  const [x, y] = toXY(c.latDeg, c.lonDeg);
  const k0 = srcIndex(x, y), r0 = Math.floor(k0 / SRC), c0 = k0 % SRC;
  let best = -1, bestKm = null;
  for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
    const d = Math.hypot(dr, dc) * PKM;
    if (d > 0.3 + 1e-9) continue;
    const v = decode(illum.sun.label, illum.sun.data[(r0 + dr) * SRC + c0 + dc]);
    if (v > best) { best = v; bestKm = d; }
  }
  return { name: c.name, latDeg: c.latDeg, lonDeg: c.lonDeg, published: c.published, officialAtPoint: r4(decode(illum.sun.label, illum.sun.data[k0])), officialMaxWithin300m: r4(best), maxAtKm: r2(bestKm), psrAtPoint: psrAtXY(x, y) };
});
const nasaGeo = (() => {
  const sun = readFileSync(new URL('../demo/data/nasa_sun_480m.bin', import.meta.url));
  const cell = (x, y) => sun[Math.floor((324 - y) / 0.48) * 1350 + Math.floor((x + 324) / 0.48)];
  return FLOOR_NAMES.map((name) => ({ name: `${name} floor`, nasaSun480m: cell(...toXY(feature(name).latDeg, feature(name).lonDeg)) / 250 }))
    .concat([{ name: 'Shackleton ridge', nasaSun480m: cell(...toXY(RIDGE.latDeg, RIDGE.lonDeg)) / 250 }]);
})();

const phase4 = {
  generatedAt: new Date().toISOString(),
  note: 'Comparisons only, no pass/fail gates. The official products cover 18.6 years and count any part of the disc; ours cover Nov 2026 to Jan 2029 and use the disc centre.',
  sunVsOfficial, earthVsOfficial, oldShadowVsPsr: oldPsr, newShadowShares,
  georef: { tiles: tileGeo, psr: { floors: psrGeo, shackletonRim, ridgePsr: psrAtXY(...toXY(RIDGE.latDeg, RIDGE.lonDeg)), shiftTest: psrShift }, topIlluminationPoints: topPoints, nasaSun480m: nasaGeo },
  timing: { sharesMs: shareMs, georefMs: Date.now() - geoT0 },
};

const out = {
  generatedAt: new Date().toISOString(), comparisons: rows.length, toleranceDeg: TOLERANCE_DEG,
  maxElDiffDeg: r6(maxOf(rows, 'elDiff')), maxAzDiffDeg: r6(maxOf(rows, 'azDiff')), perSite, samples, terrain, phase3, phase4,
};
writeFileSync(new URL('../demo/data/validation.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`${out.comparisons} comparisons; max elevation diff ${out.maxElDiffDeg}°, max azimuth diff ${out.maxAzDiffDeg}° (tolerance ${TOLERANCE_DEG}°)`);
for (const p of perSite) console.log(`  ${p.name}: el ${p.maxElDiffDeg}°, az ${p.maxAzDiffDeg}°`);
console.log('Terrain (sunlit share, 1 h steps, whole ephemeris):');
for (const c of terrainChecks) {
  const verdict = c.pass === null ? 'shown only' : c.pass ? 'pass' : 'FAIL';
  console.log(`  ${c.name.padEnd(18)} ${(c.sunlitShare * 100).toFixed(2).padStart(6)}%  ${c.limit ?? ''}${c.published !== null ? ` published ${(c.published * 100).toFixed(2)}%` : ''}  ${verdict}`);
}
const pc = (v) => (v === null ? '—' : `${(v * 100).toFixed(2)}%`);
console.log(`Phase 3 (default stay from ${consistency.landingUtc.slice(0, 10)}, ${P3_STAY_DAYS} d):`);
for (const c of slopeChecks) console.log(`  ${c.name}: Shackleton floor ${c.shackletonFloorDeg}°, wall ring 6–8 km ${c.shackletonWallRingDeg}° (${c.wallRingCells} cells); map p10 ${c.mapDeg.p10}° p50 ${c.mapDeg.p50}° p90 ${c.mapDeg.p90}° p99 ${c.mapDeg.p99}° max ${c.mapDeg.max}°  shown only`);
for (const c of shadowPoints) console.log(`  ${c.name.padEnd(52)} ${String(c.shadowKm).padStart(3)} km  ${c.limit}  ${c.pass ? 'pass' : 'FAIL'}`);
for (const c of shadowShares) console.log(`  ${c.name}: ${c.cells} of ${c.of} cells, ${pc(c.share)}  shown only`);
console.log(`  ${consistency.name}: map mean 2 km ${pc(consistency.mapMeanSun['2km'])}, 1 km ${pc(consistency.mapMeanSun['1km'])}, diff ${pc(consistency.mapMeanSun.diff)}; |2 km − mean of 4 × 1 km| p50 ${pc(consistency.blockAbsDiff.p50)} p90 ${pc(consistency.blockAbsDiff.p90)} p99 ${pc(consistency.blockAbsDiff.p99)}  shown only`);
for (const r of siteRows) console.log(`    ${r.name.padEnd(20)} 2 km ${pc(r.grid2km).padStart(7)}  1 km ${pc(r.grid1km).padStart(7)}  point 480 m ${pc(r.point480m).padStart(7)}  point 240 m ${pc(r.point240m).padStart(7)}  closer: ${r.closerToPoint}`);
for (const c of scores) console.log(`  ${c.name}: map p10 ${c.map.p10} p50 ${c.map.p50} p90 ${c.map.p90} p99 ${c.map.p99} max ${c.map.max}; floors ${c.floors.map((f) => `${f.name.split(' ')[0]} ${f.score}`).join(', ')}; ridge ${c.ridge.score}  shown only`);
console.log('Phase 4 (comparisons, shown only):');
for (const c of [sunVsOfficial, earthVsOfficial]) {
  console.log(`  ${c.name}: ${c.cells} cells, r ${c.correlation} (cell centre ${c.correlationAtCellCentre}), mean |Δ| ${pc(c.meanAbsDiff)} (cell centre ${pc(c.meanAbsDiffAtCellCentre)}), mean Δ ${pc(c.meanDiff)}; ours ${pc(c.oursMean)}, official ${pc(c.officialMean)}; r shifted one cell ${Object.entries(c.correlationShiftedOneCell).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const w of c.worst) console.log(`    ${w.latDeg.toFixed(2)}°, ${w.lonDeg.toFixed(2)}°E (${w.xKm}, ${w.yKm} km): ours ${pc(w.ours)}, official ${pc(w.official)} (centre ${pc(w.officialAtCentre)})`);
}
for (const c of oldPsr) console.log(`  ${c.name}: ${c.cells} cells; old ${c.oldShadowCells}, official ${c.officialPsrCells}, both ${c.both}; agreement ${pc(c.agreement)}, PSR missed by old ${pc(c.missedShareOfPsr)}, old not PSR ${pc(c.falseShareOfOld)}`);
for (const c of newShadowShares) console.log(`  New shadow grid ${c.grid}: ${c.zeroCells} of ${c.of} cells at 0 (${pc(c.share)}), median ${c.shadowKm.p50} km, max ${c.shadowKm.max} km`);
for (const t of tileGeo) console.log(`  ${t.name}: r ${t.zeroShift.r}, mean |Δh| ${t.zeroShift.meanAbsDiffM} m over ${t.zeroShift.pixels} px; one fine pixel off ${t.shiftedOneFinePixel.east.meanAbsDiffM}/${t.shiftedOneFinePixel.north.meanAbsDiffM} m; one 120 m pixel off ${Object.values(t.shiftedOne120mPixel).map((s) => s.meanAbsDiffM).join('/')} m`);
for (const f of psrGeo) console.log(`  PSR ${f.name}: at point ${f.psrAtPoint}, within 1 km ${pc(f.psrShareWithin1Km)}, within 3 km ${pc(f.psrShareWithin3Km)}`);
console.log(`  ${shackletonRim.name}: PSR ${pc(shackletonRim.psrShare)}; floor within 2 km ${pc(shackletonRim.floorPsrShareWithin2Km)}; ridge point PSR bit ${phase4.georef.psr.ridgePsr}`);
console.log(`  ${psrShift.name}: ${Object.entries(psrShift.metres).map(([k, v]) => `${k} ${v}`).join(', ')}`);
for (const p of topPoints) console.log(`  ${p.name}: published ${pc(p.published)}, official at point ${pc(p.officialAtPoint)}, max within 300 m ${pc(p.officialMaxWithin300m)} at ${p.maxAtKm} km, PSR ${p.psrAtPoint}`);
console.log(`  NASA Sun 480 m: ${nasaGeo.map((g) => `${g.name} ${pc(g.nasaSun480m)}`).join(', ')}`);
console.log(`  timing: shares ${shareMs} ms, georef ${phase4.timing.georefMs} ms`);
if (shadowPoints.some((c) => c.pass === false)) {
  console.error('FAIL: phase 3 hard check');
  process.exit(1);
}
if (terrainChecks.some((c) => c.pass === false)) {
  console.error('FAIL: terrain hard check');
  process.exit(1);
}
if (out.maxElDiffDeg > TOLERANCE_DEG || out.maxAzDiffDeg > TOLERANCE_DEG) {
  console.error('FAIL: difference exceeds tolerance');
  process.exit(1);
}
