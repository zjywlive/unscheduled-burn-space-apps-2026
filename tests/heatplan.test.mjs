// The integration's heat plan (workflow G): which jobs exist for a viewport, mode, filters and regions,
// and that what it derives (filters, scores, region figures, value at a point) matches the modules it wires.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { createHeatGrid, fractionJob } from '../demo/src/heat.js';
import { filterMask, scoreCells } from '../demo/src/score.js';
import { regionStats } from '../demo/src/region.js';
import { maskFor } from '../demo/src/map/shapes.js';
import { createHeatPlan, viewRect, computed } from '../demo/src/heatplan.js';
import { syntheticData } from './helpers/synthetic.mjs';

const AZ = 72, D = 86400e3;
const eph = createEphemeris(syntheticData({ sunLat: -1.5, earthLat: -6, earthLon: 0 }));

// A walled-in band of cells so the values differ from cell to cell.
function tier(size, label) {
  const horizon = new Uint8Array(size * size * AZ).fill(50);
  for (let k = 0; k < size * size; k += 3) horizon.fill(120, k * AZ, k * AZ + AZ / 2);
  const grid = createHeatGrid({ horizon, size, cellKm: 640 / size, halfKm: 320, azimuths: AZ, offsetDeg: -5, stepDeg: 0.1 });
  const inside = new Uint8Array(grid.count).fill(1);
  const slope = new Float32Array(grid.count).map((_, k) => (k % 7) * 3);
  const shadow = new Float32Array(grid.count).map((_, k) => (k % 5) * 12);
  return { grid, inside, slope, shadow, label };
}

const base = (extra = {}) => ({ p0: eph.startMs, a0: eph.startMs + 7 * D, len: 7 * D, mode: 'both', viewport: { cx: 0, cy: 0, zoom: 1 },
  maxSlope: null, maxDark: null, weights: { sun: 40, earth: 30, slope: 20, shadow: 10 }, regions: {}, route: null, ...extra });
const finish = (plan) => { for (let i = 0; i < 10000 && plan.step(50); i++) { /* run */ } };

test('viewRect covers the viewport plus two cells, clamped to the grid', () => {
  const g = tier(64, '10 km').grid;
  assert.deepEqual(viewRect(g, { cx: 0, cy: 0, zoom: 1 }), { i0: 0, j0: 0, i1: 63, j1: 63 });
  // zoom 4 at the centre: ±80 km = cells 24..39, plus 2
  assert.deepEqual(viewRect(g, { cx: 0, cy: 0, zoom: 4 }), { i0: 22, j0: 22, i1: 41, j1: 41 });
});

test('zoom 1 draws the full coarse job; zoom 2 adds a fine viewport job, kept while the viewport stays inside it', () => {
  const plan = createHeatPlan({ eph, coarse: tier(16, '2 km') });
  plan.configure(base());
  assert.equal(plan.layers().length, 1);
  finish(plan);
  assert.ok(plan.fullDone() && plan.visibleDone());
  plan.setFine(tier(32, '1 km'));
  plan.configure(base({ viewport: { cx: 0, cy: 0, zoom: 2 } }));
  const job = plan.viewJob;
  assert.ok(job && !job.done && job.rect.i0 > 0);
  plan.configure(base({ viewport: { cx: 0, cy: 0, zoom: 3 } }));
  assert.equal(plan.viewJob, job, 'zooming further in reuses the job');
  plan.configure(base({ viewport: { cx: 150, cy: 150, zoom: 3 } }));
  assert.notEqual(plan.viewJob, job, 'panning away drops it');
  finish(plan);
  // the fine values equal a plain fractionJob over the same rect
  const ref = fractionJob(plan.fine.grid, eph, eph.startMs, eph.startMs + 7 * D, { rect: plan.viewJob.rect });
  ref.run(Infinity);
  const r = plan.viewJob.rect, k = r.j0 * 32 + r.i0 + 1;
  assert.equal(plan.viewJob.both[k], ref.both[k]);
  const info = plan.infoAt(...[plan.fine.grid.cellCenter(k)].map((c) => [c.xKm, c.yKm])[0]);
  assert.equal(info.tier.label, '1 km'); assert.equal(info.both, ref.both[k]);
});

test('filters and scores come from score.js on the job arrays; the pass share counts mapped cells', () => {
  const coarse = tier(16, '2 km');
  const plan = createHeatPlan({ eph, coarse });
  plan.configure(base({ mode: 'score', maxSlope: 9, maxDark: 96 }));
  finish(plan);
  const [layer] = plan.layers();
  const job = plan.full.planned;
  assert.deepEqual(Array.from(layer.filtered), Array.from(filterMask({ slope: coarse.slope, dark: job.dark, maxSlope: 9, maxDark: 96 })));
  const ref = scoreCells({ sun: job.sun, earth: job.earth, slope: coarse.slope, shadowKm: coarse.shadow, weights: [40, 30, 20, 10] });
  assert.deepEqual(Array.from(layer.score), Array.from(ref));
  const pass = layer.filtered.reduce((a, v) => a + (v ? 0 : 1), 0) / coarse.grid.count;
  assert.equal(plan.passShare(), pass);
  // the best cells pass the filters
  for (const b of plan.best('score', 3)) assert.equal(layer.filtered[b.cell], 0);
});

test('a region uses the finest loaded grid and matches regionStats over its mask', () => {
  const plan = createHeatPlan({ eph, coarse: tier(16, '2 km') });
  const shape = { type: 'circle', cx: 30, cy: -40, rKm: 90 };
  plan.configure(base({ regions: { A: shape } }));
  finish(plan);
  let r = plan.region('A');
  assert.equal(r.tier.label, '2 km'); assert.equal(r.progress, 1);
  const fine = tier(32, '1 km');
  plan.setFine(fine);
  plan.configure(base({ regions: { A: shape } }));
  r = plan.region('A');
  assert.equal(r.tier.label, '1 km'); assert.ok(r.progress < 1);
  finish(plan);
  r = plan.region('A');
  const m = maskFor(shape, fine.grid);
  const job = fractionJob(fine.grid, eph, eph.startMs, eph.startMs + 7 * D, { rect: m.rect, mask: m.mask }); job.run(Infinity);
  const ref = regionStats({ grid: fine.grid, mask: m.mask, rect: m.rect, job, slope: fine.slope, mode: 'both', stayMs: 7 * D });
  assert.equal(r.stats.cells, ref.cells); assert.equal(r.stats.both, ref.both); assert.equal(r.stats.best.cell, ref.best.cell);
  assert.ok(computed(job, 32, ref.best.cell));
});

test('a route samples the finest grid along its line', () => {
  const plan = createHeatPlan({ eph, coarse: tier(16, '2 km') });
  plan.setFine(tier(32, '1 km'));
  plan.configure(base({ route: [[-100, -100], [100, 60]] }));
  finish(plan);
  const r = plan.routeResult({ heightAtXY: () => 100 });
  assert.equal(r.tier.label, '1 km'); assert.equal(r.progress, 1);
  assert.ok(r.points.length > 400 && r.points.every((p) => p.sun !== null));
  assert.ok(Math.abs(r.lengthKm - Math.hypot(200, 160)) < 1e-9);
});
