import test from 'node:test';
import assert from 'node:assert/strict';
import { azEl, unitFromLonLat, normalizeLon, lerpDirection } from '../demo/src/geometry.js';

const AU = 149597870.7;
// Horizons, 2027-Mar-01 00:00 UT, geocentric observer of the Moon (quantities 14,15,20)
const E = { lon: 4.061365, lat: 6.005468, rangeKm: 0.00268833613586 * AU };
const S = { lon: 265.512484, lat: 0.569252 };
// Horizons, same instant, observer on the lunar surface (quantity 4): [sunAz, sunEl, earthAz, earthEl]
const CASES = [
  ['Apollo 11',        23.47314,   0.67416, 271.002217, -27.950249, 285.805764,  69.821984],
  ['Shackleton ridge', 222.69,   -89.45,     42.819898,  -0.166509, 141.332774,  -6.680387],
  ['IM-2',             29.20,    -84.79,    236.464827,  -3.455341, 335.000941,  -1.532652],
  ["Chang'e-4",        177.5991, -45.4446,   88.113360,   1.057464, 190.060842, -50.320415],
];
const azDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

for (const [name, lon, lat, sAz, sEl, eAz, eEl] of CASES) {
  test(`matches Horizons at ${name}`, () => {
    const sun = azEl(unitFromLonLat(S.lon, S.lat), Infinity, lon, lat);
    const earth = azEl(unitFromLonLat(E.lon, E.lat), E.rangeKm, lon, lat);
    assert.ok(Math.abs(sun.elDeg - sEl) < 0.01);
    assert.ok(Math.abs(earth.elDeg - eEl) < 0.01);
    assert.ok(azDiff(sun.azDeg, sAz) * Math.cos(sEl * Math.PI / 180) < 0.01);
    assert.ok(azDiff(earth.azDeg, eAz) * Math.cos(eEl * Math.PI / 180) < 0.01);
  });
}

test('Earth parallax matters: ignoring range shifts the elevation by more than 0.1 deg', () => {
  const far = azEl(unitFromLonLat(E.lon, E.lat), Infinity, 29.20, -84.79);
  assert.ok(Math.abs(far.elDeg - -1.532652) > 0.1);
});

test('poles and zenith never produce NaN', () => {
  const zenith = azEl(unitFromLonLat(10, 20), Infinity, 10, 20);
  assert.ok(Math.abs(zenith.elDeg - 90) < 1e-6);
  assert.equal(zenith.azDeg, null);
  for (const lat of [90, -90]) {
    const r = azEl(unitFromLonLat(126.6, -1.5), Infinity, 0, lat);
    assert.ok(Number.isFinite(r.elDeg));
    assert.equal(r.azDeg, null);
  }
});

test('normalizeLon wraps into [0, 360)', () => {
  assert.equal(normalizeLon(-137.31), 222.69);
  assert.equal(normalizeLon(360), 0);
  assert.equal(normalizeLon(725), 5);
});

test('lerpDirection returns a unit vector between its inputs', () => {
  const v = lerpDirection(unitFromLonLat(359, 0), unitFromLonLat(1, 0), 0.5);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12);
  assert.ok(Math.abs(v[0] - 1) < 1e-3 && Math.abs(v[1]) < 1e-9);
});
