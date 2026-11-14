// Times the heat-map computation on the real grid (plan phase 2 Task 4 Step 3, task book phase 3 §5.4):
// one 14-day fraction job at the default landing time on the 2 km grid (target ≤ 2000 ms), nowStates
// (target ≤ 16 ms), and a 14-day job over a 160 × 160 cell rect of the 1 km grid (target ≤ 2000 ms).
import { readFileSync, existsSync } from 'node:fs';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { createHeatGrid, fractionJob, nowStates } from '../demo/src/heat.js';
import { DEFAULTS } from '../demo/src/state.js';

const load = (p) => readFileSync(new URL(p, import.meta.url));
const eph = createEphemeris(JSON.parse(load('../demo/data/ephemeris.json')));
const meta = JSON.parse(load('../demo/data/terrain.json'));
const horizon = new Uint8Array(load('../demo/data/horizon_grid.bin'));
const grid = createHeatGrid({ horizon, size: meta.horizon.size, cellKm: meta.horizon.cellKm, halfKm: meta.horizon.halfKm,
  azimuths: meta.horizon.azimuths, offsetDeg: meta.horizon.offsetDeg, stepDeg: meta.horizon.stepDeg });

const start = DEFAULTS.landingMs, end = start + 14 * 86400e3;
let t = performance.now();
const job = fractionJob(grid, eph, start, end);
job.run(Infinity);
const fractionMs = performance.now() - t;

nowStates(grid, eph, start); // warm-up
t = performance.now();
for (let k = 0; k < 100; k++) nowStates(grid, eph, start + k * 3600e3);
const nowMs = (performance.now() - t) / 100;

// 1 km grid. Without demo/data/horizon_1km.bin (workflow A), a 640² stand-in repeats each 2 km cell's
// skyline over its four 1 km cells: same bytes per cell, same work per cell, not real 1 km terrain.
// BENCH_STANDIN=1 forces the stand-in. Run with --expose-gc for a meaningful memory figure.
const SIZE_1KM = 640, AZ = meta.horizon.azimuths;
const fineMeta = (meta.horizons ?? []).find((h) => h.size === SIZE_1KM) ?? {
  size: SIZE_1KM, cellKm: 1, halfKm: meta.horizon.halfKm, azimuths: AZ, offsetDeg: meta.horizon.offsetDeg, stepDeg: meta.horizon.stepDeg,
};
const finePath = new URL('../demo/data/horizon_1km.bin', import.meta.url);
let fineHorizon, fineSource;
if (existsSync(finePath) && !process.env.BENCH_STANDIN) {
  fineHorizon = new Uint8Array(readFileSync(finePath));
  fineSource = 'demo/data/horizon_1km.bin';
} else {
  fineHorizon = new Uint8Array(SIZE_1KM * SIZE_1KM * AZ);
  const coarse = meta.horizon.size;
  for (let j = 0; j < SIZE_1KM; j++) {
    for (let i = 0; i < SIZE_1KM; i++) {
      const src = ((j >> 1) * coarse + (i >> 1)) * AZ;
      fineHorizon.set(horizon.subarray(src, src + AZ), (j * SIZE_1KM + i) * AZ);
    }
  }
  fineSource = 'STAND-IN: horizon_1km.bin not found, 2 km skyline repeated to 640² (timing only)';
}
global.gc?.();
const heapBefore = process.memoryUsage().arrayBuffers;
t = performance.now();
const fine = createHeatGrid({ horizon: fineHorizon, ...fineMeta });
const fineGridMs = performance.now() - t;
const gridBytes = process.memoryUsage().arrayBuffers - heapBefore;
// Zoom 4 viewport: ±80 km around the pole = 160 × 160 cells of 1 km.
const c = SIZE_1KM / 2, rect = { i0: c - 80, j0: c - 80, i1: c + 79, j1: c + 79 };
t = performance.now();
const fineJob = fractionJob(fine, eph, start, end, { rect });
fineJob.run(Infinity);
const fineMs = performance.now() - t;
const cells = (rect.i1 - rect.i0 + 1) * (rect.j1 - rect.j0 + 1);

const ok = fractionMs <= 2000 && nowMs <= 16 && fineMs <= 2000;
console.log(`fractionJob 14 d, ${grid.count} cells: ${fractionMs.toFixed(0)} ms (target ≤ 2000)`);
console.log(`nowStates mean of 100: ${nowMs.toFixed(1)} ms (target ≤ 16)`);
console.log(`1 km skyline: ${fineSource}`);
const mem = global.gc ? `typed arrays +${(gridBytes / 1e6).toFixed(1)} MB` : 'memory: run with --expose-gc';
console.log(`createHeatGrid 1 km, ${fine.count} cells: ${fineGridMs.toFixed(0)} ms, ${mem} (skyline bytes ${(fineHorizon.byteLength / 1e6).toFixed(1)} MB not included)`);
console.log(`fractionJob 14 d, 1 km rect ${rect.i1 - rect.i0 + 1}×${rect.j1 - rect.j0 + 1} = ${cells} cells: ${fineMs.toFixed(0)} ms (target ≤ 2000)`);
if (!ok) { console.error('FAIL: over target'); process.exit(1); }
