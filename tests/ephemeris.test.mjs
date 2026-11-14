import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('../demo/data/ephemeris.json', import.meta.url)));

test('ephemeris file covers Nov 2026 to Jan 2029 at 3 h steps', () => {
  assert.equal(data.meta.start, '2026-11-01T00:00:00Z');
  assert.equal(data.meta.stop, '2029-01-01T00:00:00Z');
  assert.equal(data.meta.stepHours, 3);
  assert.equal(data.meta.ephemeris, 'DE441');
  assert.equal(data.subSunLon.length, 6337);
  for (const k of ['subEarthLon', 'subEarthLat', 'subSunLat', 'earthRangeKm']) assert.equal(data[k].length, 6337);
});

test('ephemeris values are in physical ranges', () => {
  assert.ok(data.subSunLon.every((v) => v >= 0 && v < 360));
  assert.ok(data.subSunLat.every((v) => Math.abs(v) < 1.7));      // lunar obliquity ~1.54 deg
  assert.ok(data.subEarthLat.every((v) => Math.abs(v) < 7.0));    // latitude libration
  assert.ok(data.earthRangeKm.every((v) => v > 355000 && v < 407000));
});

test('first row matches the Horizons value recorded on 2026-11-12', () => {
  assert.ok(Math.abs(data.subEarthLon[0] - 3.9559) < 1e-3);
  assert.ok(Math.abs(data.subSunLon[0] - 285.1309) < 1e-3);
});

import { createEphemeris, bodyAzEl } from '../demo/src/ephemeris.js';
import { syntheticData } from './helpers/synthetic.mjs';

test('interpolated ephemeris reproduces Horizons between 3 h samples', () => {
  const eph = createEphemeris(data);
  // Horizons, lunar-surface observer at 0E 89.5S, 2026-Nov-14 00:00 UT
  const r = bodyAzEl(eph, { lonDeg: 0, latDeg: -89.5 }, Date.UTC(2026, 10, 14, 0));
  assert.ok(Math.abs(r.sun.elDeg - 1.258335) < 0.01);
  assert.ok(Math.abs(r.earth.elDeg - -4.148545) < 0.01);
  // 01:00 is between samples; elevation must lie between the 00:00 and 06:00 Horizons values
  const mid = bodyAzEl(eph, { lonDeg: 0, latDeg: -89.5 }, Date.UTC(2026, 10, 14, 1));
  assert.ok(mid.sun.elDeg > 1.258 && mid.sun.elDeg < 1.281);
});

test('outside coverage returns null, at both ends', () => {
  const eph = createEphemeris(data);
  assert.equal(eph.at(eph.startMs - 1), null);
  assert.equal(eph.at(eph.endMs + 1), null);
  assert.notEqual(eph.at(eph.startMs), null);
  assert.notEqual(eph.at(eph.endMs), null);
  assert.equal(bodyAzEl(eph, { lonDeg: 0, latDeg: 0 }, eph.endMs + 1), null);
});

test('synthetic ephemeris rotates the Sun 12 deg per day', () => {
  const eph = createEphemeris(syntheticData());
  const t0 = eph.startMs, day = 86400e3;
  const a = bodyAzEl(eph, { lonDeg: 0, latDeg: 0 }, t0 + (10 / 12) * day);  // Sun on the horizon
  assert.ok(Math.abs(a.sun.elDeg) < 0.01);
  const b = bodyAzEl(eph, { lonDeg: 0, latDeg: 0 }, t0 + (100 / 12) * day); // Sun overhead
  assert.ok(Math.abs(b.sun.elDeg - 90) < 0.01);
});
