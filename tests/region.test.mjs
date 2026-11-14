import test from 'node:test';
import assert from 'node:assert/strict';
import { regionStats, routeProfile } from '../demo/src/region.js';
import { createHeatGrid, fractionJob } from '../demo/src/heat.js';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { syntheticData } from './helpers/synthetic.mjs';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
// A 4 × 4 grid of 2 km cells, ±4 km; only size, count, cellKm and cellAt are used.
const SIZE = 4, CELL = 2, HALF = 4;
const grid = {
  size: SIZE, count: SIZE * SIZE, cellKm: CELL, halfKm: HALF,
  cellAt(x, y) { const i = Math.floor((x + HALF) / CELL), j = Math.floor((HALF - y) / CELL); return i >= 0 && j >= 0 && i < SIZE && j < SIZE ? j * SIZE + i : null; },
};
const arr = (f) => Float32Array.from({ length: SIZE * SIZE }, (_, k) => f(k));
const job = { sun: arr((k) => k / 16), earth: arr(() => 0.5), both: arr((k) => k / 32), done: true };
const D = 86400e3;

test('regionStats averages the masked cells and finds the best one', () => {
  const mask = new Uint8Array(16); mask[0] = mask[1] = mask[4] = mask[5] = 1;
  const score = arr((k) => (k === 4 ? 0.9 : 0.1));
  const r = regionStats({ grid, mask, job, score, mode: 'sun', stayMs: 14 * D });
  assert.equal(r.cells, 4); assert.equal(r.areaKm2, 16); assert.equal(r.passCells, 4); assert.equal(r.pending, 0);
  close(r.sun, (0 + 1 + 4 + 5) / 64); close(r.earth, 0.5); close(r.both, (0 + 1 + 4 + 5) / 128);
  close(r.hours.sun, r.sun * 336); close(r.hours.earth, 168);
  assert.equal(r.pass, 1); close(r.score, (0.9 + 0.3) / 4);
  assert.equal(r.best.cell, 5); close(r.best.value, 5 / 16);
  const s = regionStats({ grid, mask, job, score, mode: 'score', stayMs: 14 * D });
  assert.equal(s.best.cell, 4); close(s.best.value, 0.9);
  // Modes without per-cell fractions of their own (now, change) rank by both-in-view.
  assert.equal(regionStats({ grid, mask, job, mode: 'now' }).best.cell, 5);
  // A rect only narrows the scan: same answer.
  assert.deepEqual(regionStats({ grid, mask, rect: { i0: 0, j0: 0, i1: 1, j1: 1 }, job, score, mode: 'sun', stayMs: 14 * D }), r);
});

test('regionStats uses only cells that pass the filters', () => {
  const mask = new Uint8Array(16); mask[0] = mask[1] = mask[4] = mask[5] = 1;
  const filtered = new Uint8Array(16); filtered[5] = 1; filtered[4] = 1;
  const r = regionStats({ grid, mask, job, filtered, mode: 'sun', stayMs: D });
  assert.equal(r.cells, 4); assert.equal(r.passCells, 2); assert.equal(r.pass, 0.5);
  close(r.sun, 1 / 32); assert.equal(r.best.cell, 1);
  const none = regionStats({ grid, mask, job, filtered: new Uint8Array(16).fill(1), mode: 'sun', stayMs: D });
  assert.equal(none.cells, 4); assert.equal(none.pass, 0); assert.equal(none.sun, null); assert.equal(none.best, null);
});

test('regionStats with no cells returns cells 0 and null means without throwing', () => {
  const r = regionStats({ grid, mask: new Uint8Array(16), job, mode: 'both', stayMs: D });
  assert.deepEqual(r, {
    cells: 0, areaKm2: 0, passCells: 0, pending: 0, sun: null, earth: null, both: null, pass: null,
    score: null, slopeDeg: null, best: null, hours: { sun: null, earth: null, both: null },
  });
  const noJob = regionStats({ grid, mask: new Uint8Array(16).fill(1) });
  assert.equal(noJob.cells, 16); assert.equal(noJob.sun, null); assert.equal(noJob.best, null);
});

test('regionStats counts cells the job has not computed as pending', () => {
  const eph = createEphemeris(syntheticData({ sunLat: -1.5, earthLat: -6 }));
  const hg = createHeatGrid({ horizon: new Uint8Array(16 * 72).fill(50), size: 4, cellKm: 2, halfKm: 4, azimuths: 72, offsetDeg: -5, stepDeg: 0.1 });
  const mask = new Uint8Array(16).fill(1);
  const part = fractionJob(hg, eph, eph.startMs, eph.startMs + D, { rect: { i0: 0, j0: 0, i1: 3, j1: 3 } });
  part.run(0);                                                          // one row of four done
  const r = regionStats({ grid: hg, mask, job: part, mode: 'sun', stayMs: D });
  assert.equal(r.cells, 16); assert.equal(r.pending, 12);
  let mean = 0; for (let k = 0; k < 4; k++) mean += part.sun[k] / 4;
  close(r.sun, mean, 1e-6);
  assert.ok(r.best.cell < 4);
});

test('routeProfile samples height, slope, sun and filter along the line', () => {
  const dem = { heightAtXY: (x, y) => (Math.abs(x) > 4 ? null : 100 + 10 * x) };
  const slope = arr((k) => k);
  const filtered = new Uint8Array(16); filtered[9] = 1;
  const samples = [
    { xKm: -3, yKm: -1, dKm: 0 }, { xKm: -1, yKm: -1, dKm: 2 }, { xKm: -2.5, yKm: -1, dKm: 3 },
    { xKm: 1, yKm: -1, dKm: 6 }, { xKm: 5, yKm: -1, dKm: 10 },
  ];
  const p = routeProfile({ samples, dem, grid, job, slope, filtered });
  assert.equal(p.points.length, 5);
  assert.deepEqual(p.points.map((q) => q.heightM), [70, 90, 75, 110, null]);
  assert.deepEqual(p.points.map((q) => q.slopeDeg), [8, 9, 8, 10, null]);
  assert.deepEqual(p.points.map((q) => q.pass), [true, false, true, true, null]);
  assert.deepEqual(p.points.map((q) => q.sun), [0.5, 9 / 16, 0.5, 10 / 16, null]);
  assert.deepEqual(p.points[3], { dKm: 6, xKm: 1, yKm: -1, heightM: 110, slopeDeg: 10, sun: 10 / 16, pass: true });
  assert.equal(p.lengthKm, 10); assert.equal(p.climbM, 20 + 35); assert.equal(p.maxSlopeDeg, 10);
  close(p.meanSun, (0.5 + 9 / 16 + 0.5 + 10 / 16) / 4);
});

test('routeProfile with no samples or no data', () => {
  assert.deepEqual(routeProfile({ samples: [], dem: null, grid }), { points: [], lengthKm: 0, climbM: 0, maxSlopeDeg: null, meanSun: null });
  const p = routeProfile({ samples: [{ xKm: 0.5, yKm: 0.5, dKm: 0 }, { xKm: 1, yKm: 0.5, dKm: 0.5 }], dem: { heightAtXY: () => null }, grid });
  assert.deepEqual(p.points[0], { dKm: 0, xKm: 0.5, yKm: 0.5, heightM: null, slopeDeg: null, sun: null, pass: true });
  assert.equal(p.climbM, 0); assert.equal(p.maxSlopeDeg, null); assert.equal(p.meanSun, null); assert.equal(p.lengthKm, 0.5);
});

// ---------- third wave (correctness review I3, M6) ----------
test('while the job runs, pass and the score mean use computed cells only (review I3, M6)', async () => {
  const { filterMask, scoreCells } = await import('../demo/src/score.js');
  const eph = createEphemeris(syntheticData({ sunLat: -1.5, earthLat: -6 }));
  // every cell walled in: no Sun at all, so the longest dark is the whole stay and every cell fails 48 h
  const hg = createHeatGrid({ horizon: new Uint8Array(16 * 72).fill(255), size: 4, cellKm: 2, halfKm: 4, azimuths: 72, offsetDeg: -5, stepDeg: 0.1 });
  const mask = new Uint8Array(16).fill(1);
  const job = fractionJob(hg, eph, eph.startMs, eph.startMs + 14 * D, { rect: { i0: 0, j0: 0, i1: 3, j1: 3 } });
  job.run(0); job.run(0);                                              // two rows of four done
  const filtered = filterMask({ dark: job.dark, maxDark: 48, count: 16 });   // the rows not run yet have dark 0 and "pass"
  const slope = new Float32Array(16).fill(4), shadowKm = new Float32Array(16).fill(10);
  const score = scoreCells({ sun: job.sun, earth: job.earth, slope, shadowKm, count: 16 });
  const mid = regionStats({ grid: hg, mask, job, filtered, score, mode: 'score', stayMs: 14 * D });
  assert.equal(mid.pending, 8);
  assert.equal(mid.pass, 0, 'no computed cell passes, so nothing passes yet');
  job.run(Infinity);
  const end = regionStats({ grid: hg, mask, job, filtered: filterMask({ dark: job.dark, maxDark: 48, count: 16 }), mode: 'both', stayMs: 14 * D });
  assert.equal(end.pending, 0); assert.equal(end.pass, 0);
  // the score mean leaves out uncomputed cells even when the score array has a value there
  const noFilter = regionStats({ grid: hg, mask, job: fractionJob(hg, eph, eph.startMs, eph.startMs + 14 * D, { rect: { i0: 0, j0: 0, i1: 3, j1: 3 } }), score: new Float32Array(16).fill(0.27).fill(0.62, 0, 4), mode: 'score', stayMs: 14 * D });
  assert.equal(noFilter.score, null, 'a job with no row done gives no score yet');
  const half = fractionJob(hg, eph, eph.startMs, eph.startMs + 14 * D, { rect: { i0: 0, j0: 0, i1: 3, j1: 3 } });
  half.run(0);
  const one = regionStats({ grid: hg, mask, job: half, score: new Float32Array(16).fill(0.27).fill(0.62, 0, 4), mode: 'score', stayMs: 14 * D });
  close(one.score, 0.62, 1e-6);
  assert.ok(one.best.cell < 4);
});
