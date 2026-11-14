import test from 'node:test';
import assert from 'node:assert/strict';
import { compactResult } from '../demo/src/agent/compact.js';
import { loadCoreContext } from '../tools/core-context.mjs';
import { createCoreTools } from '../demo/src/tools-core.js';

const core = createCoreTools(loadCoreContext());
const batch = {
  places: ['shackleton', 'im2', 'haworth', 'malapert-massif', 'nobile-rim-2'].map((site_id) => ({ site_id })),
  landings: ['2027-01-13', '2027-01-27', '2027-02-10'], stay_days: 14,
};

// Independent decoder for verifying original paths, not just a bag of equal-looking numbers.
function expand(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(expand);
  if (value.$table) return value.$table.rows.map((row) => {
    const out = {};
    value.$table.columns.forEach((column, i) => {
      if (row[i]?.$absent === true) return;
      const path = column.split('.'); let at = out;
      for (const key of path.slice(0, -1)) at = at[key] ??= {};
      at[path.at(-1)] = expand(row[i]);
    });
    return out;
  });
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== '_compact').map(([k, v]) => [k, expand(v)]));
}

function numericPaths(value, path = '', out = {}) {
  if (typeof value === 'number') out[path] = value;
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) numericPaths(v, `${path}/${k}`, out);
  return out;
}

test('compact: real five-site three-date comparison fits the cap without changing any numeric path or ranking', async () => {
  const raw = await core.run('compare_scenarios', batch), before = structuredClone(raw);
  assert.equal(raw.error, undefined);
  const packed = compactResult('compare_scenarios', raw, { maxChars: 12000 }), restored = expand(packed);
  assert.ok(JSON.stringify(packed).length <= 12000);
  assert.ok(JSON.stringify(packed).length < JSON.stringify(raw).length);
  assert.deepEqual(numericPaths(restored), numericPaths(raw));
  assert.deepEqual(restored.ranking, raw.ranking);
  assert.equal(restored.scenarios.length, raw.scenarios.length);
  assert.deepEqual(restored.about, raw.about);
  assert.deepEqual(raw, before);
  const expected = structuredClone(raw);
  for (const row of expected.scenarios) { delete row.display; if (row.vsBaseline) delete row.vsBaseline.card; }
  assert.deepEqual(restored, expected);
});

test('compact: all real tools retain numeric paths, units, limits, clipping and assumptions', async () => {
  const calls = [
    ['list_sites', {}], ['site_summary', batch],
    ['rise_set_events', { site_id: 'im2', start: '2028-12-25', days: 30, max_events: 1 }],
    ['next_events', { lat_deg: -89.3, lon_deg: 222.7, at: '2027-03-02T10:00Z' }],
    ['sky_at', { site_id: 'haworth', times: Array.from({ length: 48 }, (_, i) => new Date(Date.UTC(2027, 0, 13) + i * 3600e3).toISOString()) }],
    ['skyline', { site_id: 'shackleton', step_deg: 1 }],
    ['best_landing_dates', { site_id: 'im2', count: 3, compare_to: '2028-12-25' }],
    ['point_facts', { site_id: 'shackleton' }],
    ['energy_summary', { site_id: 'im2', landing: '2028-12-25', alternative: { landing: '2028-12-28' } }],
    ['relay_coverage', { site_id: 'im2', landing: '2028-12-25' }],
    ['route_candidates', { points: [{ site_id: 'shackleton' }, { site_id: 'de-gerlache-rim-2' }], landing: '2027-01-13', include_path: true }],
  ];
  for (const [name, args] of calls) {
    const raw = await core.run(name, args);
    assert.equal(raw.error, undefined, name);
    const packed = compactResult(name, raw), restored = expand(packed);
    assert.deepEqual(numericPaths(restored), numericPaths(raw), name);
    assert.deepEqual(restored.about, raw.about, name);
    const expected = JSON.parse(JSON.stringify(raw));
    if (packed._compact?.omitted?.includes('scenario.display')) for (const row of expected.results) delete row.display;
    if (packed._compact?.omitted?.includes('candidates.display')) for (const row of expected.candidates) delete row.display;
    // No useful field is lost, including null events, false flags, unavailable routes or approximate places.
    assert.deepEqual(restored, expected, name);
  }
});

test('compact: batch errors and nested errors survive byte-for-byte at their paths', async () => {
  const calls = [
    ['skyline', { site_id: 'apollo11' }],
    ['compare_scenarios', { scenarios: [{ site_id: 'im2', landing: '2035-01-01' }, { site_id: 'unknown', landing: '2027-01-13' }] }],
    ['site_summary', { scenarios: [{ site_id: 'im2', landing: '2027-01-13' }, { site_id: 'im2', landing: '2035-01-01' }] }],
  ];
  for (const [name, args] of calls) {
    const raw = await core.run(name, args), restored = expand(compactResult(name, raw));
    if (raw.error) assert.deepEqual(restored, raw);
    else assert.deepEqual(restored.results[1], raw.results[1]);
  }
  const raw = { error: 'Detailed failure '.repeat(30), errors: [{ index: 0, error: 'Outside coverage' }], about: { units: { duration: 'h' } } };
  const out = compactResult('compare_scenarios', raw, { maxChars: 10 });
  assert.equal(out.error, raw.error); assert.deepEqual(out.errors, raw.errors); assert.deepEqual(out.about, raw.about);
  assert.equal(out._compact.budgetExceeded, true);
});

test('compact: an impossible budget is reported rather than erasing evidence, including clipped windows', async () => {
  const raw = await core.run('compare_scenarios', { places: [{ site_id: 'shackleton' }], landings: ['2027-01-13', '2028-12-28'], stay_days: 14 });
  assert.equal(raw.cut, true);
  const out = compactResult('compare_scenarios', raw, { maxChars: 50 }), restored = expand(out);
  assert.equal(out._compact.budgetExceeded, true);
  assert.equal(restored.cut, true);
  assert.deepEqual(restored.scenarios.map((r) => r.stay), raw.scenarios.map((r) => r.stay));
  assert.deepEqual(restored.about, raw.about);
  assert.deepEqual(numericPaths(restored), numericPaths(raw));
});

test('compact: null, unknown tools, invalid budgets and future display fields are handled without mutation', () => {
  assert.equal(compactResult('unknown', null), null);
  const raw = { display: { note: 'Clipped', value: 0.123456789 }, cut: true, units: 'h', x: null };
  assert.deepEqual(compactResult('unknown', raw), raw);
  assert.deepEqual(expand(compactResult('site_summary', raw)), raw);
  for (const maxChars of [0, -1, NaN, Infinity, 1.5, '12000']) assert.throws(() => compactResult('sky_at', {}, { maxChars }), RangeError);
});
