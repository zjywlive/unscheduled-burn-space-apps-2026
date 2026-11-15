// A1 pure engine contracts: synthetic visibility, interval arithmetic, slips, date choice and spacing.
// Independent brute-force checks deliberately exercise every short binary run, including boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, sampleSeries, seriesMetrics, scanLandings, landingSet, inRegion, spacedPicks } from '../demo/src/search.js';
import { resolveCriteria, evaluate } from '../demo/src/criteria.js';
import { bundle } from '../tools/build.mjs';

const H = 3600e3;
const criteria = (c) => resolveCriteria(c).criteria;
const reader = (bits, stayH, opts = {}) => {
  const s = buildSeries(Uint8Array.from(bits), 0, stayH);
  return (t) => seriesMetrics(s, t, opts);
};

test('search: tiny fake grid samples each hour once and preserves Sun/Earth bits', () => {
  const cells = [[3, 3, 1, 0, 2, 3], [0, 1, 2, 3, 3, 3]], calls = [];
  const grid = { visibility: (k, dir) => { calls.push([k, dir.hour]); return cells[k][dir.hour]; } };
  const s = sampleSeries(grid, 0, cells[0].map((_, hour) => ({ hour })), 0, 6);
  assert.equal(calls.length, 6);
  const m = seriesMetrics(s, 0);
  assert.equal(m.both_from_landing_h, 2); assert.equal(m.longest_both_h, 2);
  assert.equal(m.both_total_h, 3); assert.equal(m.sun_total_h, 4); assert.equal(m.earth_total_h, 4);
  assert.equal(m.longest_dark_h, 2); assert.equal(m.sun_continuous_h, 3); assert.equal(m.earth_continuous_h, 2);
  assert.equal(m.sun_at_landing, true); assert.equal(m.earth_at_landing, true);
});

test('search: sliding longest runs and prefix totals match brute force for every short binary sequence', () => {
  for (let n = 1; n <= 8; n++) for (let mask = 0; mask < 2 ** n; mask++) for (let width = 1; width <= n; width++) {
    const bits = Uint8Array.from({ length: n }, (_, i) => (mask >> i & 1) ? 3 : 0), s = buildSeries(bits, 0, width);
    for (let left = 0; left + width <= n; left++) {
      let run = 0, longest = 0, dark = 0, longestDark = 0, total = 0;
      for (let i = left; i < left + width; i++) {
        run = bits[i] ? run + 1 : 0; dark = bits[i] ? 0 : dark + 1;
        longest = Math.max(longest, run); longestDark = Math.max(longestDark, dark); total += !!bits[i];
      }
      const m = seriesMetrics(s, left * H, { continuous_from: 'within_stay' });
      assert.equal(m.both_continuous_h, longest, `${n}/${mask}/${width}/${left}`);
      assert.equal(m.longest_dark_h, longestDark); assert.equal(m.both_total_h, total);
    }
  }
});

test('search: from_time, within_stay, fractional boundaries and unavailable coverage', () => {
  const s = buildSeries(Uint8Array.from([0, 3, 3, 3, 0, 3]), 0, 4.5);
  assert.equal(seriesMetrics(s, 0).both_continuous_h, 0);
  assert.equal(seriesMetrics(s, 0, { continuous_from: 'within_stay' }).both_continuous_h, 3);
  assert.equal(seriesMetrics(s, 0, { continuous_from: 'from_time', fromMs: 1.5 * H }).both_continuous_h, 2.5);
  assert.equal(seriesMetrics(s, 0, { continuous_from: 'from_time', fromMs: 5 * H }).both_continuous_h, 0);
  const fractional = seriesMetrics(s, 0.5 * H);
  assert.equal(fractional.both_total_h, 3); assert.equal(fractional.longest_dark_h, 1);
  assert.equal(seriesMetrics(s, 2 * H), null); assert.equal(seriesMetrics(s, -H), null);
});

test('search: every slip must pass, worst check values and first failure are retained', () => {
  const read = reader([3, 3, 3, 3, 3, 3, 0, 0, 0, 0], 4);
  const c = criteria({ both_continuous_h_min: 3, longest_dark_h_max: 2 });
  const r = landingSet(read, {}, { criteria: c, offsetsH: [0, 2, 4, 6], full: true }, 0);
  assert.equal(r.pass, false); assert.equal(r.firstFailH, 4); assert.equal(r.failReason, 'both_continuous_h_min');
  assert.equal(r.worst.both_continuous_h, 0); assert.equal(r.worst.longest_dark_h, 4);
  assert.equal(r.robustnessH, 2); assert.deepEqual(r.matrix.map((x) => x.eval.pass), [true, true, false, false]);
  assert.equal(evaluate(c, r.worst).pass, false);
});

test('search: any passing date qualifies; best date, passing count and one-check relaxations are per cell', () => {
  const read = reader([0, 0, 3, 3, 3, 3, 3, 0], 3);
  const c = criteria({ both_continuous_h_min: 2 });
  const scan = scanLandings(read, {}, { criteria: c, landings: [0, H, 2 * H, 3 * H], offsetsH: [0], rankBy: 'both_continuous' });
  assert.equal(scan.passingLandings, 2); assert.equal(scan.best.landingMs, 2 * H);
  assert.equal(scan.relaxable.both_continuous_h_min.value, 0);
  const shifted = scanLandings(reader([0, 3, 3, 3], 4), {}, {
    criteria: c, landings: [0], offsetsH: [0], withinReader: reader([0, 3, 3, 3], 4, { continuous_from: 'within_stay' }),
  });
  assert.equal(shifted.best, null); assert.equal(shifted.withinStay, true);
});

test('search: ranking by both uses the worst slip even without an active continuous check', () => {
  const r = landingSet(reader([3, 3, 3, 0, 0, 0], 3), {}, { criteria: criteria({}), offsetsH: [0, 2], rankBy: 'both_continuous' }, 0);
  assert.equal(r.score, 1); assert.equal(r.pass, true);
});

test('search: robustness breaks equal surviving offsets by the worst relative margin', () => {
  const c = criteria({ both_continuous_h_min: 1 });
  const s = scanLandings(reader([0, 3, 3, 3, 3, 3, 0, 0], 3), {}, { criteria: c, landings: [3 * H, H], offsetsH: [0, 1], rankBy: 'robustness' });
  assert.equal(s.passingLandings, 2); assert.equal(s.best.landingMs, H); assert.equal(s.best.robustnessH, 1);
});

test('search: coverage clipping, seam-crossing longitude boxes and stable greedy spacing', () => {
  const cell = { latDeg: -85, lonDeg: 355, xKm: 5, yKm: 0 };
  assert.equal(inRegion({ ...cell, latDeg: -79 }), false);
  assert.equal(inRegion(cell, { bbox: { lat_min: -90, lat_max: -80, lon_min: 350, lon_max: 10 } }), true);
  assert.equal(inRegion(cell, { bbox: { lat_min: -90, lat_max: -80, lon_min: -10, lon_max: 10 } }), true);
  assert.equal(inRegion(cell, { within_km: 5, center: { xKm: 0, yKm: 0 } }), true);
  const rows = [0, 1, 2, 3].map((k) => ({ k, site: { xKm: k * 5, yKm: 0 }, result: { score: 1 } }));
  assert.deepEqual(spacedPicks(rows.reverse(), 3, 10).map((r) => r.k), [0, 2]);
});

test('search: browser modules follow the repository bundler convention', () => {
  assert.doesNotThrow(() => bundle(new URL('../demo/src/tools-v2/find.js', import.meta.url).pathname));
});
