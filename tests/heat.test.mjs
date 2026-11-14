import test from 'node:test';
import assert from 'node:assert/strict';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { summarize } from '../demo/src/windows.js';
import { createHeatGrid, fractionJob, nowStates, topCells, shareAtLeast, changeShares } from '../demo/src/heat.js';
import { syntheticData } from './helpers/synthetic.mjs';

const SIZE = 16, AZ = 72;
const flat = () => new Uint8Array(SIZE * SIZE * AZ).fill(50);          // 0 deg everywhere
const meta = { size: SIZE, cellKm: 40, halfKm: 320, azimuths: AZ, offsetDeg: -5, stepDeg: 0.1 };
const eph = createEphemeris(syntheticData({ sunLat: -1.5, earthLat: -6, earthLon: 0 }));
const D = 86400e3;

test('on a flat grid the fractions match the single-point summary', () => {
  const grid = createHeatGrid({ horizon: flat(), ...meta });
  const job = fractionJob(grid, eph, eph.startMs, eph.startMs + 14 * D);
  while (!job.run(5)) { /* slices */ }
  assert.equal(job.done, true); assert.equal(job.progress, 1);
  for (const index of [0, 37, 120, 255]) {
    const c = grid.cellCenter(index);
    const s = summarize(eph, c, eph.startMs, 14, 0);
    assert.ok(Math.abs(job.sun[index] - s.sunMs / s.stayMs) < 0.03);
    assert.ok(Math.abs(job.both[index] - s.bothMs / s.stayMs) < 0.03);
  }
});

test('slicing does not change the result', () => {
  const grid = createHeatGrid({ horizon: flat(), ...meta });
  const a = fractionJob(grid, eph, eph.startMs, eph.startMs + 7 * D); a.run(Infinity);
  const b = fractionJob(grid, eph, eph.startMs, eph.startMs + 7 * D); while (!b.run(0)) { /* one unit per call */ }
  assert.deepEqual(Array.from(a.both), Array.from(b.both));
});

test('a cell walled in on every side sees nothing', () => {
  const h = flat(); h.fill(255, 5 * AZ, 6 * AZ);                       // cell 5: 20.5 deg all round
  const grid = createHeatGrid({ horizon: h, ...meta });
  const job = fractionJob(grid, eph, eph.startMs, eph.startMs + 14 * D); job.run(Infinity);
  assert.equal(job.sun[5], 0); assert.equal(job.earth[5], 0); assert.equal(job.both[5], 0);
  assert.equal(nowStates(grid, eph, eph.startMs + D)[5], 0);
});

test('cell lookup round-trips, and the top cells keep their distance', () => {
  const grid = createHeatGrid({ horizon: flat(), ...meta });
  const c = grid.cellCenter(37);
  assert.equal(grid.cellAt(c.xKm, c.yKm), 37);
  assert.equal(grid.cellAt(999, 0), null);
  const v = new Float32Array(SIZE * SIZE); v[0] = 0.9; v[1] = 0.8; v[2] = 0.7; v[40] = 0.6;
  // cells are 40 km apart, so neighbours are allowed at minKm 20 and excluded at minKm 50
  assert.deepEqual(topCells(v, v, grid, { count: 3, minKm: 20 }), [0, 1, 2]);
  assert.deepEqual(topCells(v, v, grid, { count: 2, minKm: 50 }), [0, 2]);
  assert.equal(shareAtLeast(v, 0.75), 2 / (SIZE * SIZE));
});

test('change shares count cells that move by more than a day', () => {
  const p = new Float32Array([0.5, 0.5, 0.5, 0.5]), a = new Float32Array([0.5, 0.2, 0.9, 0.52]);
  assert.deepEqual(changeShares(p, a, 14 * D), { loses: 0.25, gains: 0.25 });
});

test('heat opacity uses the legend steps (five steps of 0.15)', async () => {
  const { heatColour } = await import('../demo/src/map/layers.js');
  const colours = { sun: 'S', earth: 'E', both: 'B', negative: 'N' };
  const round = (r) => r && [r[0], Number(r[1].toFixed(6))];
  assert.equal(heatColour('sun', { value: 0 }, colours), null);
  assert.deepEqual(round(heatColour('sun', { value: 0.05 }, colours)), ['S', 0.15]);
  assert.deepEqual(round(heatColour('both', { value: 0.5 }, colours)), ['B', 0.45]);
  assert.deepEqual(round(heatColour('earth', { value: 1 }, colours)), ['E', 0.75]);
});

// ---------- phase 3 (§5.4): Uint8 skyline decode, opts, rect, mask, dark ----------
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BACKUP = new URL('../backups/phase2-final-2026-11-12.tar.gz', import.meta.url);
const H = 3600e3;

// Deterministic pseudo-random skyline bytes, so the regression covers interpolation between bins.
function randomHorizon(seed, n) {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let k = 0; k < n; k++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[k] = (x >>> 24) % 120; }
  return out;
}

// Phase 2 heat.js (and the terrain.js it imports) from the backup, unpacked outside the project.
async function oldHeat(t) {
  if (!existsSync(BACKUP)) { t.skip('phase 2 backup not found'); return null; }
  const dir = mkdtempSync(join(tmpdir(), 'lsn-heat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('tar', ['-xzf', BACKUP.pathname, '-C', dir, 'demo/src/heat.js', 'demo/src/terrain.js']);
  return import(pathToFileURL(join(dir, 'demo/src/heat.js')).href);
}

test('regression: visibility and default fractions equal the phase 2 implementation element for element', async (t) => {
  const old = await oldHeat(t); if (!old) return;
  const ephT = createEphemeris(syntheticData({ sunLat: -1.5, earthLat: -6, earthLon: 0 }));
  const horizon = randomHorizon(7, SIZE * SIZE * AZ);
  const a = old.createHeatGrid({ horizon, ...meta }), b = createHeatGrid({ horizon, ...meta });
  for (let h = 0; h < 14 * 24; h += 5) {
    const d = ephT.at(ephT.startMs + h * H);
    for (let k = 0; k < SIZE * SIZE; k++) assert.equal(b.visibility(k, d), a.visibility(k, d));
  }
  const end = ephT.startMs + 14 * D;
  for (const opts of [[], [3 * H]]) {
    const ja = old.fractionJob(a, ephT, ephT.startMs, end, ...opts); ja.run(Infinity);
    const jb = fractionJob(b, ephT, ephT.startMs, end, ...opts); jb.run(Infinity);
    for (const key of ['sun', 'earth', 'both']) assert.deepEqual(Array.from(jb[key]), Array.from(ja[key]), key);
    assert.equal(jb.rows, ja.rows); assert.equal(jb.progress, 1); assert.equal(jb.done, true);
  }
  // { stepMs } as an object gives the same as the number form.
  const jn = fractionJob(b, ephT, ephT.startMs, end, 3 * H); jn.run(Infinity);
  const jo = fractionJob(b, ephT, ephT.startMs, end, { stepMs: 3 * H }); jo.run(Infinity);
  for (const key of ['sun', 'earth', 'both', 'dark']) assert.deepEqual(Array.from(jo[key]), Array.from(jn[key]), key);
});

test('regression: real 2 km skyline and ephemeris give the same visibility as phase 2', async (t) => {
  const old = await oldHeat(t); if (!old) return;
  const root = new URL('../demo/data/', import.meta.url);
  const tm = JSON.parse(readFileSync(new URL('terrain.json', root)));
  const horizon = new Uint8Array(readFileSync(new URL(tm.horizon.file, root)));
  const realEph = createEphemeris(JSON.parse(readFileSync(new URL('ephemeris.json', root))));
  const a = old.createHeatGrid({ horizon, ...tm.horizon }), b = createHeatGrid({ horizon, ...tm.horizon });
  let checked = 0;
  for (let h = 0; h < 30 * 24; h += 7) {
    const d = realEph.at(Date.UTC(2027, 0, 13) + h * H);
    for (let k = 0; k < b.count; k += 97) { assert.equal(b.visibility(k, d), a.visibility(k, d)); checked++; }
  }
  assert.ok(checked > 100000);
});

test('rect limits the computed cells; values inside equal the full run, outside stay 0', () => {
  const grid = createHeatGrid({ horizon: randomHorizon(3, SIZE * SIZE * AZ), ...meta });
  const end = eph.startMs + 7 * D;
  const full = fractionJob(grid, eph, eph.startMs, end); full.run(Infinity);
  const rect = { i0: 3, j0: 5, i1: 9, j1: 7 };
  const job = fractionJob(grid, eph, eph.startMs, end, { rect });
  assert.deepEqual(job.rect, rect); assert.equal(job.total, 3); assert.equal(job.rows, 0); assert.equal(job.progress, 0);
  assert.equal(job.run(0), false); assert.equal(job.rows, 1); assert.equal(job.progress, 1 / 3);
  while (!job.run(0)) { /* one row per call */ }
  assert.equal(job.rows, 3); assert.equal(job.progress, 1); assert.equal(job.done, true);
  for (let k = 0; k < grid.count; k++) {
    const i = k % SIZE, j = Math.floor(k / SIZE);
    const inside = i >= 3 && i <= 9 && j >= 5 && j <= 7;
    for (const key of ['sun', 'earth', 'both', 'dark']) assert.equal(job[key][k], inside ? full[key][k] : 0, `${key} ${k}`);
  }
  // Out-of-range rects are clamped to the grid; an inverted rect is empty and done at once.
  assert.deepEqual(fractionJob(grid, eph, eph.startMs, end, { rect: { i0: -4, j0: 14, i1: 99, j1: 99 } }).rect, { i0: 0, j0: 14, i1: 15, j1: 15 });
  const empty = fractionJob(grid, eph, eph.startMs, end, { rect: { i0: 5, j0: 5, i1: 4, j1: 9 } });
  assert.equal(empty.total, 0); assert.equal(empty.done, true); assert.equal(empty.progress, 1); assert.equal(empty.run(5), true);
});

test('mask limits the cells further', () => {
  const grid = createHeatGrid({ horizon: randomHorizon(5, SIZE * SIZE * AZ), ...meta });
  const end = eph.startMs + 7 * D;
  const full = fractionJob(grid, eph, eph.startMs, end); full.run(Infinity);
  const mask = new Uint8Array(grid.count); mask[2 * SIZE + 4] = 1; mask[2 * SIZE + 5] = 1; mask[10 * SIZE + 4] = 1;
  const job = fractionJob(grid, eph, eph.startMs, end, { rect: { i0: 0, j0: 0, i1: 15, j1: 5 }, mask }); job.run(Infinity);
  for (let k = 0; k < grid.count; k++) {
    const on = k === 2 * SIZE + 4 || k === 2 * SIZE + 5;                // cell (4, 10) is masked in but outside the rect
    for (const key of ['sun', 'both', 'dark']) assert.equal(job[key][k], on ? full[key][k] : 0);
  }
  assert.equal(job.mask, mask);
});

test('dark: longest run without the Sun, in hours, at the sampling step', () => {
  // Brute force from visibility() at the same sample instants.
  const h = randomHorizon(11, SIZE * SIZE * AZ);
  h.fill(255, 5 * AZ, 6 * AZ);                                           // cell 5: never sunlit
  h.fill(0, 6 * AZ, 7 * AZ);                                             // cell 6: skyline at -5 deg, always sunlit
  const grid = createHeatGrid({ horizon: h, ...meta });
  const start = eph.startMs, end = start + 14 * D, step = 2 * H;
  const job = fractionJob(grid, eph, start, end); job.run(Infinity);
  assert.equal(job.dark[5], 336, 'never sunlit: the whole stay');
  assert.equal(job.sun[6], 1); assert.equal(job.dark[6], 0, 'always sunlit: 0');
  let mixed = 0;
  for (let k = 0; k < grid.count; k++) {
    let run = 0, longest = 0;
    for (let n = 0; n < 168; n++) {
      const sunUp = grid.visibility(k, eph.at(start + (n + 0.5) * step)) & 1;
      run = sunUp ? 0 : run + 1; longest = Math.max(longest, run);
    }
    assert.equal(job.dark[k], longest * 2, `cell ${k}`);
    if (longest > 0 && longest < 168) mixed++;
  }
  assert.ok(mixed > 20, `the random skyline should give many partly lit cells (got ${mixed})`);
});

test('dark is capped at the stay when the stay is not a whole number of steps', () => {
  const h = flat(); h.fill(255, 5 * AZ, 6 * AZ); h.fill(0, 6 * AZ, 7 * AZ);   // cell 5 never lit, cell 6 always lit
  const grid = createHeatGrid({ horizon: h, ...meta });
  const job = fractionJob(grid, eph, eph.startMs, eph.startMs + 5 * H); job.run(Infinity);   // 3 samples of 2 h
  assert.equal(job.dark[5], 5);
  const one = fractionJob(grid, eph, eph.startMs, eph.startMs + 3 * H, { stepMs: 6 * H }); one.run(Infinity);
  assert.equal(one.dark[5], 3);                                          // a single sample longer than the stay
  assert.equal(one.dark[6], 0);
});

test('dark stays 0 when the ephemeris has no samples in the stay', () => {
  const grid = createHeatGrid({ horizon: flat(), ...meta });
  const job = fractionJob(grid, eph, eph.endMs + D, eph.endMs + 2 * D); job.run(Infinity);
  assert.equal(job.done, true); assert.equal(job.sun[0], 0); assert.equal(job.dark[0], 0);
});
