// Sun and Earth over the whole Moon with a smooth horizon (demo/src/globalheat.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { globalGrid, globalFractions, globalStates } from '../demo/src/globalheat.js';

const eph = createEphemeris(JSON.parse(readFileSync(new URL('../demo/data/ephemeris.json', import.meta.url), 'utf8')));
const T = Date.parse('2027-01-01T00:00:00Z');
const at = (g, lat, lon) => Math.floor((90 - lat) / g.stepDeg) * g.w + Math.floor((((lon % 360) + 360) % 360) / g.stepDeg);

test('over a lunar day the Sun is up half the time; the near side always sees the Earth, the far side never', () => {
  const g = globalGrid(2);
  assert.deepEqual([g.w, g.h], [180, 90]);
  const f = globalFractions(g, eph, T, T + 29.53 * 86400e3, { stepMs: 3600e3 });
  assert.ok(Math.abs(f.sun[at(g, 1, 20)] - 0.5) < 0.03, `equator sunlit ${f.sun[at(g, 1, 20)]}`);
  assert.ok(f.earth[at(g, 1, 1)] > 0.99, 'sub-Earth region');
  assert.ok(f.earth[at(g, 1, 181)] < 0.01, 'far side');
  assert.ok(Math.abs(f.both[at(g, 1, 1)] - f.sun[at(g, 1, 1)]) < 1e-6, 'both = Sun where the Earth is always up');
});

test('the states at one instant follow the subsolar point', () => {
  const g = globalGrid(2);
  const d = eph.at(T);
  const lon = ((Math.atan2(d.sun[1], d.sun[0]) * 180) / Math.PI + 360) % 360;
  const s = globalStates(g, eph, T);
  assert.equal(s[at(g, 0, lon)] & 1, 1, 'Sun up at the subsolar point');
  assert.equal(s[at(g, 0, lon + 180)] & 1, 0, 'night opposite');
});
