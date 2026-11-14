import test from 'node:test';
import assert from 'node:assert/strict';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { summarize } from '../demo/src/windows.js';
import { landingRibbon } from '../demo/src/ribbon.js';
import { syntheticData } from './helpers/synthetic.mjs';

test('each ribbon day equals the summary for landing on that day', () => {
  const eph = createEphemeris(syntheticData({ days: 80 }));
  const site = { lonDeg: 0, latDeg: 0 };
  const r = landingRibbon(eph, site, 0, 14);
  assert.equal(r.dayMs.length, r.bothMs.length);
  assert.equal(r.dayMs[0], eph.startMs);
  assert.ok(r.dayMs[r.dayMs.length - 1] + 14 * 86400e3 <= eph.endMs);
  for (const k of [0, 9, 30, r.dayMs.length - 1]) {
    const s = summarize(eph, site, r.dayMs[k], 14, 0);
    assert.ok(Math.abs(r.bothMs[k] - s.bothMs) <= 3600e3, `${k}`);
  }
});
