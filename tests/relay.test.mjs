// Relay satellite link windows (phase 4 §6 K): Kepler propagation, frames, geometry and the window logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MU_MOON, MOON_RADIUS_KM, SIDEREAL_MONTH_S, PRESETS, solveKepler, orbitPeriodS, semiMajorForPeriod, createOrbit,
  inertialToFixed, subPoint, lookAngles, segmentClearsSphere, relaySeesEarth, unionIntervals, scanPredicate,
  validateElements, relaySummary, stepFor,
} from '../demo/src/relay.js';
import { azEl, unitFromLonLat } from '../demo/src/geometry.js';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { syntheticData } from './helpers/synthetic.mjs';

const R = MOON_RADIUS_KM;
const T0 = Date.UTC(2027, 0, 1);
const H = 3600e3;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const norm = (p) => Math.hypot(p[0], p[1], p[2]);
const orbit = (o) => createOrbit({ raanDeg: 0, argpDeg: 0, m0Deg: 0, epochMs: T0, ...o });

test('K: Kepler solver satisfies M = E − e sin E across eccentricities and any M', () => {
  for (const e of [0, 0.01, 0.3, 0.6, 0.9, 0.97, 0.995]) {
    for (let M = -7; M <= 14; M += 0.173) {
      const E = solveKepler(M, e);
      near(E - e * Math.sin(E), M, 1e-11, `e=${e} M=${M}`);
    }
  }
  assert.equal(solveKepler(0, 0.5), 0);
  near(solveKepler(Math.PI, 0.9), Math.PI, 1e-12);
});

test('K: period follows Kepler’s third law (hand value for a 100 km circular orbit)', () => {
  // 2π √(1837.4³ / 4902.800066) = 7,067.6 s ≈ 1.963 h
  near(orbitPeriodS(R + 100), 7067.6, 0.5);
  near(semiMajorForPeriod(orbitPeriodS(5000)), 5000, 1e-6);
  // a ∝ T^(2/3): doubling the period multiplies a by 2^(2/3)
  near(semiMajorForPeriod(2 * 43200) / semiMajorForPeriod(43200), 2 ** (2 / 3), 1e-12);
  // the propagated orbit closes after one period
  const o = orbit({ aKm: 6142.6, e: 0.6, iDeg: 57, raanDeg: 33, argpDeg: 90, m0Deg: 12 });
  assert.ok(dist(o.inertial(T0), o.inertial(T0 + o.periodS * 1000)) < 1e-6);
});

test('K: radius and vis-viva speed at perilune and apolune', () => {
  const a = 6142.6, e = 0.6;
  const o = orbit({ aKm: a, e, iDeg: 90, argpDeg: 90 });
  const T = o.periodS * 1000;
  near(norm(o.inertial(T0)), a * (1 - e), 1e-6, 'perilune radius');
  near(norm(o.inertial(T0 + T / 2)), a * (1 + e), 1e-6, 'apolune radius');
  const speed = (t) => dist(o.inertial(t + 500), o.inertial(t - 500));    // km per 1 s
  for (const [t, r] of [[T0, a * (1 - e)], [T0 + T / 2, a * (1 + e)]]) {
    near(speed(t), Math.sqrt(MU_MOON * (2 / r - 1 / a)), 1e-5, `vis-viva at r=${r}`);
  }
});

test('K: argument of perilune 90° puts perilune over the north and apolune over the south (i = 90°)', () => {
  const o = orbit({ aKm: 6142.6, e: 0.6, iDeg: 90, argpDeg: 90 });
  near(subPoint(o.inertial(T0)).latDeg, 90, 1e-9);
  near(subPoint(o.inertial(T0 + o.periodS * 500)).latDeg, -90, 1e-9);
  // and with i = 60° the apolune sits at 60° S
  const o2 = orbit({ aKm: 9750.7, e: 0.7, iDeg: 60, argpDeg: 90 });
  near(subPoint(o2.inertial(T0 + o2.periodS * 500)).latDeg, -60, 1e-9);
});

test('K: presets are valid examples with the stated periods', () => {
  const hours = { 'elliptical-12h': 12, 'elliptical-24h': 24, 'circular-2h': 2 };
  for (const p of PRESETS) {
    assert.match(p.name, /^Example /);
    const v = validateElements(p.elements);
    assert.ok(v.ok, p.id);
    near(v.derived.periodS / 3600, hours[p.id], 0.01, p.id);
    assert.ok(v.derived.periluneAltKm > 100, p.id);
  }
});

test('K: the ground track of a circular polar orbit passes over both poles', () => {
  const o = orbit({ aKm: R + 100, e: 0, iDeg: 90 });
  const T = o.periodS * 1000;
  let maxLat = -90, minLat = 90;
  for (let t = T0; t <= T0 + T; t += 5e3) {
    const p = subPoint(o.fixed(t));
    maxLat = Math.max(maxLat, p.latDeg); minLat = Math.min(minLat, p.latDeg);
  }
  assert.ok(maxLat > 89.8 && minLat < -89.8, `${minLat} ${maxLat}`);
  // the track crosses the equator northbound at Ω = 0 and, one orbit later, 360° × T / sidereal month further west
  near(subPoint(o.fixed(T0)).lonDeg, 0, 1e-9);
  const drift = 360 * (o.periodS / SIDEREAL_MONTH_S);
  near(subPoint(o.fixed(T0 + T)).lonDeg, 360 - drift, 1e-6);
});

test('K: the Moon-fixed frame turns once per sidereal month', () => {
  const v = [1000, 0, 500];
  const month = SIDEREAL_MONTH_S * 1000;
  assert.ok(dist(inertialToFixed(v, T0 + month, T0), v) < 1e-6);
  // a quarter month later an inertial vector toward 0° E appears at 270° E (90° W): the surface turned east under it
  const q = inertialToFixed(v, T0 + month / 4, T0);
  near(q[0], 0, 1e-6); near(q[1], -1000, 1e-6); near(q[2], 500, 1e-12);
  // 27.321661 days, i.e. 13.1764° per day
  near(360 / (SIDEREAL_MONTH_S / 86400), 13.1764, 1e-4);
});

test('K: the Moon blocks the relay–Earth line only when the line passes through the sphere', () => {
  const far = [384400, 0, 0];
  assert.equal(segmentClearsSphere([0, 0, -3000], far), true);         // under the south pole, Earth sideways
  assert.equal(segmentClearsSphere([-3000, 0, 0], far), false);        // straight behind the Moon
  assert.equal(segmentClearsSphere([-3000, 1800, 0], far), true);      // passes 1,800 km from the centre
  assert.equal(segmentClearsSphere([-3000, 1700, 0], far), false);     // passes 1,700 km from the centre
  assert.equal(segmentClearsSphere([3000, 0, 0], far), true);          // near side
  // through the ephemeris form: Earth direction + range
  assert.equal(relaySeesEarth([-(R + 100), 0, 0], [1, 0, 0], 384400), false);
  assert.equal(relaySeesEarth([0, 0, -(R + 100)], [1, 0, 0], 384400), true);
  // low relays just beyond the terminator plane: the line skims past the south pole (clear) or cuts through the limb
  assert.equal(relaySeesEarth([-10, 0, -(R + 50)], [1, 0, 0], 384400), true);
  assert.equal(relaySeesEarth([-500, 0, -1700], [1, 0, 0], 384400), false);
});

test('K: hand-computed elevation and azimuth', () => {
  const site = { latDeg: 0, lonDeg: 0 };
  // 100 km up and 100 km east of the site: 45° elevation, azimuth 90°
  let r = lookAngles([R + 100, 100, 0], site);
  near(r.elDeg, 45, 1e-9); near(r.azDeg, 90, 1e-9); near(r.rangeKm, Math.SQRT2 * 100, 1e-9);
  // level with the site, 500 km north: 0° elevation, azimuth 0°
  r = lookAngles([R, 0, 500], site);
  near(r.elDeg, 0, 1e-9); near(r.azDeg, 0, 1e-9);
  // at 90° E: 100 km up and 100 km south → 45°, azimuth 180°
  r = lookAngles([0, R + 100, -100], { latDeg: 0, lonDeg: 90 });
  near(r.elDeg, 45, 1e-9); near(r.azDeg, 180, 1e-9);
  // straight overhead: 90°, no azimuth
  r = lookAngles([R + 500, 0, 0], site);
  near(r.elDeg, 90, 1e-9); assert.equal(r.azDeg, null);
  // a raised observer sees the same point lower: 2 km up, a point 100 km east at the mean radius + 2 km
  r = lookAngles([R + 2, 100, 0], site, R + 2);
  near(r.elDeg, 0, 1e-9);
});

test('K: look angles use the same conventions as the Sun/Earth code (geometry.azEl)', () => {
  const sites = [{ latDeg: -84.79, lonDeg: 29.2 }, { latDeg: -89.45, lonDeg: 222.69 }, { latDeg: 12, lonDeg: 300 }];
  for (const site of sites) {
    for (const [lon, lat, range] of [[10, -3, 384400], [200, -60, 8000], [29, -80, 2500], [100, 40, 5000]]) {
      const d = unitFromLonLat(lon, lat);
      const ref = azEl(d, range, site.lonDeg, site.latDeg);
      const got = lookAngles([d[0] * range, d[1] * range, d[2] * range], site);
      near(got.elDeg, ref.elDeg, 1e-9);
      near(got.azDeg, ref.azDeg, 1e-9);
    }
  }
});

test('K: interval union merges overlaps and touching ends', () => {
  assert.deepEqual(unionIntervals([[0, 5], [3, 8], [10, 12]], [[7, 11], [20, 21]]), [[0, 12], [20, 21]]);
  assert.deepEqual(unionIntervals([[0, 1]], [[1, 2]]), [[0, 2]]);
  assert.deepEqual(unionIntervals([], [[5, 5], [6, 9]]), [[6, 9]]);
  assert.deepEqual(unionIntervals([[0, 10]], [[2, 3]]), [[0, 10]]);
});

test('K: window scan finds each window with edges to 1 s, including one open at the start and at the end', () => {
  const edges = [[0, 400e3], [1000e3, 1300.5e3], [5000e3, 7000e3]];
  const inside = (t) => edges.some(([a, b]) => t >= a && t < b);
  const got = scanPredicate(inside, 0, 6000e3, 60e3);
  assert.equal(got.length, 3);
  got.forEach(([a, b], k) => { near(a, edges[k][0], 1000); near(b, Math.min(edges[k][1], 6000e3), 1000); });
  assert.equal(got[0][0], 0); assert.equal(got[2][1], 6000e3);
  assert.equal(stepFor(7200), 60e3);
  assert.equal(stepFor(3600), 30e3);
});

test('K: validation rejects impossible or meaningless orbits', () => {
  const base = { aKm: 6142.6, e: 0.6, iDeg: 90, raanDeg: 0, argpDeg: 90, m0Deg: 0, epochMs: null };
  assert.equal(validateElements(base).ok, true);
  assert.match(validateElements({ ...base, e: 0.8 }).errors.e, /below the surface/);       // rp = 1228 km
  assert.match(validateElements({ ...base, e: 1 }).errors.e, /below 1/);
  assert.match(validateElements({ ...base, e: -0.1 }).errors.e, /at least 0/);
  assert.match(validateElements({ ...base, aKm: 1500, e: 0 }).errors.aKm, /radius/);
  assert.match(validateElements({ ...base, iDeg: 200 }).errors.iDeg, /0° to 180°/);
  assert.match(validateElements({ ...base, aKm: 50000, e: 0.5 }).errors.aKm, /sphere of influence/);
  assert.match(validateElements({ ...base, raanDeg: NaN }).errors.raanDeg, /number/);
  assert.match(validateElements({ ...base, epochMs: NaN }).errors.epochMs, /UTC/);
});

test('K: an apolune-south elliptical orbit dwells over the south pole far longer than a low circular polar one', () => {
  const eph = createEphemeris(syntheticData({ days: 4 }));
  const site = { latDeg: -88, lonDeg: 0 };
  const run = (elements, earthIntervals = []) => relaySummary({ elements, eph, site, mask: 0, startMs: T0, endMs: T0 + 2 * 86400e3, earthIntervals });
  const ell = run(PRESETS.find((p) => p.id === 'elliptical-12h').elements);
  const low = run(PRESETS.find((p) => p.id === 'circular-2h').elements);
  assert.ok(ell.relayMs > 3 * low.relayMs, `${ell.relayMs / H} h vs ${low.relayMs / H} h`);
  assert.ok(ell.relayMs > 0.6 * ell.stayMs);
  // a 2 h orbit gives about 12 short passes a day here, each well under half an hour
  assert.ok(low.windowCount >= 20 && low.windowCount <= 26, String(low.windowCount));
  assert.ok(low.windows.every((w) => w.durMs < 30 * 60e3 && w.peakElDeg > 0));
  // relay link ⊆ relay in view
  assert.ok(ell.relayMs <= ell.viewMs + 1);
});

test('K: combined coverage is the union of direct and relay; the blind period is the longest gap in it', () => {
  const eph = createEphemeris(syntheticData({ days: 4 }));
  const site = { latDeg: -88, lonDeg: 0 };
  const elements = PRESETS.find((p) => p.id === 'circular-2h').elements;
  const startMs = T0, endMs = T0 + 86400e3;
  const none = relaySummary({ elements, eph, site, startMs, endMs, earthIntervals: [] });
  assert.equal(none.anyMs, none.relayMs);
  assert.equal(none.longestBlindMs, none.longestRelayGapMs);
  const full = relaySummary({ elements, eph, site, startMs, endMs, earthIntervals: [[startMs - H, endMs + H]] });
  assert.equal(full.directMs, endMs - startMs);           // clipped to the stay
  assert.equal(full.anyMs, endMs - startMs);
  assert.equal(full.longestBlindMs, 0);
  const half = relaySummary({ elements, eph, site, startMs, endMs, earthIntervals: [[startMs, startMs + 12 * H]] });
  assert.ok(half.anyMs >= 12 * H && half.anyMs <= 12 * H + half.relayMs);
  assert.ok(half.longestBlindMs <= half.longestRelayGapMs && half.longestBlindMs < 12 * H);
  // the same orbit epoch for a later stay sees the satellite later in its motion, not restarted
  const later = relaySummary({ elements, eph, site, startMs: startMs + 3e6, endMs: endMs + 3e6, earthIntervals: [], defaultEpochMs: startMs });
  assert.equal(later.epochMs, startMs);
  const restarted = relaySummary({ elements, eph, site, startMs: startMs + 3e6, endMs: endMs + 3e6, earthIntervals: [] });
  assert.equal(restarted.epochMs, startMs + 3e6);
  assert.notDeepEqual(later.linkIntervals[0], restarted.linkIntervals[0]);
});
