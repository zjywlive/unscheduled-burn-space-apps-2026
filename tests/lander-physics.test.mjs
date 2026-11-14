// Task A: ideal burns, conics, perturbations, numerical propagation and the staged mission budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { G0, MU_MOON, R_MOON, R_MOON_GRAV, J2_MOON, C22_MOON, MU_EARTH, MU_SUN, AU_KM, EARTH_MOON_MEAN_KM, SIDEREAL_MONTH_S, DAY_S, RAD } from '../demo/src/lander/constants.js';
import { VEHICLE_DEFAULTS, cleanVehicle, wetMassKg } from '../demo/src/lander/vehicle.js';
import { massRatio, finalMassKg, propellantForDvKg, dvForPropellantMs, burnTimeS } from '../demo/src/lander/rocket.js';
import { circularSpeed, visViva, periodS, ellipseFromApsides, trueAnomalyAtRadius, timeFromPeriapsisS, hohmann, tliFromLeo, hyperbolicPeriapsisSpeed, captureDvMs, planeChangeDvMs, j2NodeRate, j2ArgpRate, elementsToState, stateToElements } from '../demo/src/lander/orbits.js';
import { fixedToInertial, accelPointMass, accelJ2, accelC22Fixed, accelThirdBody, rk4Step, createForceModel, propagate, meanElementsDrift } from '../demo/src/lander/dynamics.js';
import { PUBLISHED, deltaVBudget } from '../demo/src/lander/budget.js';
import { inertialToFixed } from '../demo/src/relay.js';
import { createEphemeris } from '../demo/src/ephemeris.js';

const near = (actual, expected, tol, label = '') => assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected} (tol ${tol})`);
const norm = (v) => Math.hypot(...v);
const distance = (a, b) => Math.hypot(...a.map((x, k) => x - b[k]));
const angleError = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const T0 = Date.UTC(2027, 0, 1); // Assumed test epoch inside the supplied Horizons ephemeris.
const LLO_KM = R_MOON + 100; // Assumed 100 km circular lunar orbit from the task.
const elements = (overrides = {}) => ({ aKm: LLO_KM, e: 0, iRad: 60 * RAD, raanRad: 0.7, argpRad: 0.4, nuRad: 1.1, ...overrides }); // Assumed test geometry, angles in radians.
const pointModel = () => createForceModel({ epochMs: T0, j2: false, c22: false, earth: false, sun: false });

test('A: rocket equation round trips, zero burns, stable tiny burns and constant-thrust duration', () => {
  const m0Kg = wetMassKg(VEHICLE_DEFAULTS), ispS = VEHICLE_DEFAULTS.ispS;
  // Derived with shared G0: exp(3000/(320*9.80665)) = 2.6012288023; task's 2.5998 ± .001 is inconsistent.
  near(massRatio(3000, ispS), 2.601228802346909, 1e-12);
  // Assumed test burns, m/s; the tiny burn exercises log1p/expm1 precision.
  for (const dvMs of [0, 1e-8, 30, 800, 1950, 3000]) {
    const mpKg = propellantForDvKg(m0Kg, dvMs, ispS);
    near(dvForPropellantMs(m0Kg, mpKg, ispS), dvMs, Math.max(1e-15, dvMs * 1e-12));
    near(finalMassKg(m0Kg, dvMs, ispS) + mpKg, m0Kg, 1e-12);
    const thrustN = VEHICLE_DEFAULTS.mainThrustN;
    near(burnTimeS(m0Kg, dvMs, ispS, thrustN) * thrustN / (ispS * G0), mpKg, 1e-12);
  }
  near(massRatio(0, ispS), 1, 0);
  assert.throws(() => massRatio(-1, ispS), RangeError);
  assert.throws(() => massRatio(1, 0), RangeError);
  assert.throws(() => finalMassKg(0, 1, ispS), RangeError);
  assert.throws(() => dvForPropellantMs(m0Kg, m0Kg, ispS), RangeError);
  assert.throws(() => burnTimeS(m0Kg, 1, ispS, 0), RangeError);
});

test('A: circular lunar period and ellipse apsides agree with Kepler and vis-viva', () => {
  near(periodS(MU_MOON, LLO_KM) / 60, 117.7, 0.5); // Task's approximate 100 km orbit period, minutes.
  const rpKm = R_MOON + 15; // Assumed 15 km descent-orbit perilune.
  const ell = ellipseFromApsides(MU_MOON, rpKm, LLO_KM);
  near(ell.aKm * (1 - ell.e), rpKm, 1e-12);
  near(ell.aKm * (1 + ell.e), LLO_KM, 1e-12);
  near(rpKm * ell.vpKms, LLO_KM * ell.vaKms, 1e-12);
  near(ell.periodS, periodS(MU_MOON, ell.aKm), 0);
  near(visViva(MU_MOON, LLO_KM, LLO_KM), circularSpeed(MU_MOON, LLO_KM), 1e-15);
  near(trueAnomalyAtRadius(ell.aKm, ell.e, rpKm), 0, 0);
  near(trueAnomalyAtRadius(ell.aKm, ell.e, LLO_KM), Math.PI, 0);
  near(timeFromPeriapsisS(MU_MOON, ell.aKm, ell.e, Math.PI), ell.periodS / 2, 1e-10);
  assert.ok(Number.isNaN(trueAnomalyAtRadius(ell.aKm, ell.e, rpKm / 2)));
  assert.ok(Number.isNaN(trueAnomalyAtRadius(ell.aKm, ell.e, 2 * LLO_KM)));
  assert.equal(trueAnomalyAtRadius(LLO_KM, 0, LLO_KM), 0);
  assert.ok(Number.isNaN(trueAnomalyAtRadius(LLO_KM, 0, 2 * LLO_KM)));
  // Assumed test eccentricity and anomalies; compare radius and inbound/outbound symmetry.
  const e = 0.3, nuRad = 1.2, aKm = 2 * LLO_KM;
  const radiusKm = aKm * (1 - e * e) / (1 + e * Math.cos(nuRad));
  near(trueAnomalyAtRadius(aKm, e, radiusKm), nuRad, 1e-14);
  near(timeFromPeriapsisS(MU_MOON, aKm, e, nuRad) + timeFromPeriapsisS(MU_MOON, aKm, e, -nuRad), periodS(MU_MOON, aKm), 1e-9);
});

test('A: Hohmann signs, TLI time to lunar radius, LOI and plane-change magnitudes', () => {
  const up = hohmann(MU_MOON, LLO_KM, 2 * LLO_KM), down = hohmann(MU_MOON, 2 * LLO_KM, LLO_KM);
  assert.ok(up.dv1Kms > 0 && up.dv2Kms > 0);
  near(down.dv1Kms, -up.dv2Kms, 1e-15);
  near(down.dv2Kms, -up.dv1Kms, 1e-15);
  near(down.tofS, up.tofS, 0);
  const tli = tliFromLeo();
  near(tli.dvMs / 1000, 3.13, 0.03); // Task's approximate Apollo-like injection from 185 km LEO, km/s.
  near(tli.tofS, periodS(MU_EARTH, tli.aKm) / 2, 1e-8);
  const fast = tliFromLeo({ apogeeKm: EARTH_MOON_MEAN_KM * 1.2 }); // Assumed overshooting transfer ellipse.
  assert.ok(fast.dvMs > tli.dvMs && fast.tofS < tli.tofS);
  assert.ok(fast.tofS < periodS(MU_EARTH, fast.aKm) / 2);
  assert.throws(() => tliFromLeo({ apogeeKm: EARTH_MOON_MEAN_KM / 2 }), RangeError);
  const vInfKms = 0.83; // Assumed lunar approach speed specified by the task.
  near(captureDvMs(MU_MOON, vInfKms, LLO_KM) / 1000, 0.82, 0.02); // Task's approximate circular LOI, km/s.
  near(hyperbolicPeriapsisSpeed(MU_MOON, vInfKms, LLO_KM) ** 2, vInfKms ** 2 + 2 * MU_MOON / LLO_KM, 1e-14);
  assert.ok(captureDvMs(MU_MOON, vInfKms, LLO_KM, 2 * LLO_KM) < captureDvMs(MU_MOON, vInfKms, LLO_KM));
  const vKms = circularSpeed(MU_MOON, LLO_KM);
  near(planeChangeDvMs(vKms, 0), 0, 0);
  near(planeChangeDvMs(vKms, Math.PI), 2000 * vKms, 1e-12);
  near(planeChangeDvMs(vKms, -Math.PI / 3), 1000 * vKms, 1e-12);
});

test('A: elements/state round trips cover circular, near-circular, polar and equatorial cases', () => {
  // Assumed conic test geometries; include both equatorial directions and nearly singular elements.
  for (const e of [0, 1e-13, 1e-8, 0.2, 0.8]) {
    for (const iRad of [0, 1e-13, 60 * RAD, Math.PI / 2, Math.PI - 1e-13, Math.PI]) {
      const input = elements({ e, iRad });
      const state = elementsToState(MU_MOON, input);
      const recovered = stateToElements(MU_MOON, state.r, state.v);
      assert.ok(Object.values(recovered).every(Number.isFinite), JSON.stringify(recovered));
      near(recovered.aKm, input.aKm, 1e-8);
      near(recovered.e, e, 1e-12);
      near(recovered.iRad, iRad, 1e-12);
      near(recovered.periKm, input.aKm * (1 - e), 1e-8);
      near(recovered.apoKm, input.aKm * (1 + e), 1e-8);
      const rebuilt = elementsToState(MU_MOON, recovered);
      assert.ok(distance(rebuilt.r, state.r) < 1e-7, `position e=${e} i=${iRad}`);
      assert.ok(distance(rebuilt.v, state.v) < 1e-10, `velocity e=${e} i=${iRad}`);
      if (e > 1e-6 && Math.abs(Math.sin(iRad)) > 1e-6) {
        for (const key of ['raanRad', 'argpRad', 'nuRad']) near(angleError(recovered[key], input[key]), 0, 1e-12, key);
      }
    }
  }
  const hyper = elementsToState(MU_MOON, elements({ aKm: -2 * LLO_KM, e: 1.5 })); // Assumed hyperbolic test conic.
  const recovered = stateToElements(MU_MOON, hyper.r, hyper.v);
  assert.equal(recovered.apoKm, Infinity);
  assert.ok(distance(elementsToState(MU_MOON, recovered).r, hyper.r) < 1e-8);
});

test('A: MCI rotation is the inverse of relay.inertialToFixed, including C22 force rotation', () => {
  const r = elementsToState(MU_MOON, elements()).r;
  const tMs = T0 + SIDEREAL_MONTH_S * 1000 / 4;
  const rotated = fixedToInertial([LLO_KM, 0, 0], tMs, T0);
  near(rotated[0], 0, 1e-9);
  near(rotated[1], LLO_KM, 1e-9);
  assert.ok(distance(inertialToFixed(fixedToInertial(r, tMs, T0), tMs, T0), r) < 1e-9);
  const fixedR = inertialToFixed(r, tMs, T0);
  const c22 = fixedToInertial(accelC22Fixed(MU_MOON, C22_MOON, R_MOON_GRAV, fixedR), tMs, T0);
  const point = accelPointMass(MU_MOON, r), j2 = accelJ2(MU_MOON, J2_MOON, R_MOON_GRAV, r);
  const expected = point.map((x, k) => x + j2[k] + c22[k]);
  const model = createForceModel({ epochMs: T0, earth: false, sun: false });
  assert.ok(distance(model.accel(tMs, r), expected) < 1e-17);
});

test('A: generic RK4 supports arrays and Float64Array without mutating the input', () => {
  for (const y of [[1, 0], new Float64Array([1, 0])]) {
    const next = rk4Step((t, state) => [state[0], t], 0, y, 0.01); // Dimensionless numerical test.
    assert.equal(next.constructor, y.constructor);
    near(next[0], Math.exp(0.01), 1e-12);
    near(next[1], 0.01 ** 2 / 2, 1e-16);
    assert.deepEqual(Array.from(y), [1, 0]);
  }
});

test('A: propagation samples exact times, includes final partial step and preserves inputs', () => {
  const initial = elementsToState(MU_MOON, elements());
  const r0 = [...initial.r], v0 = [...initial.v];
  const model = pointModel();
  const params = { r0, v0, t0Ms: T0, durationS: 105, stepS: 20, model }; // Assumed numerical time grid, s.
  const sparse = propagate({ ...params, sampleEveryS: 35 }); // Assumed off-grid cadence, s.
  const dense = propagate({ ...params, sampleEveryS: 7 }); // Assumed denser off-grid cadence, s.
  assert.deepEqual(sparse.map((s) => (s.tMs - T0) / 1000), [0, 35, 70, 105]);
  assert.deepEqual(sparse.at(-1), dense.at(-1));
  assert.deepEqual(propagate({ ...params, sampleEveryS: 1000 }).map((s) => (s.tMs - T0) / 1000), [0, 105]); // Assumed cadence longer than arc, s.
  assert.equal(propagate({ ...params, durationS: 0 }).length, 1);
  assert.deepEqual(r0, initial.r);
  assert.deepEqual(v0, initial.v);
  assert.throws(() => propagate({ ...params, stepS: 0 }), RangeError);
  assert.throws(() => propagate({ ...params, sampleEveryS: 0 }), RangeError);
  assert.throws(() => propagate({ ...params, durationS: -1 }), RangeError);
});

test('A: J2 node drift over two days matches secular theory within 5%; polar node stays fixed', () => {
  const model = createForceModel({ epochMs: T0, c22: false, earth: false, sun: false });
  for (const iRad of [60 * RAD, Math.PI / 2]) { // Assumed test inclinations specified by the task.
    const initial = elementsToState(MU_MOON, elements({ iRad, argpRad: 0, nuRad: 0 }));
    const samples = propagate({ r0: initial.r, v0: initial.v, t0Ms: T0, durationS: 2 * DAY_S, stepS: 20, sampleEveryS: 120, model }); // Task's two-day arc, 20 s integration; assumed 120 s sampling.
    const measured = meanElementsDrift(samples, MU_MOON).raanRateRadS;
    const expected = j2NodeRate(MU_MOON, J2_MOON, R_MOON_GRAV, LLO_KM, 0, iRad);
    if (iRad === Math.PI / 2) near(measured, 0, 1e-14);
    else near(measured, expected, Math.abs(expected) * 0.05);
  }
});

test('A: drift fitting unwraps RAAN and periapsis across 0 and 2pi with irregular samples', () => {
  const raanRateRadS = -2e-4, argpRateRadS = 3e-4; // Assumed synthetic rates, rad/s (deliberately large to cross angle wraps).
  const timesS = [0, 100, 270, 550, 1200, 3000]; // Assumed irregular sampling times, s.
  const samples = timesS.map((tS) => ({
    tMs: T0 + tS * 1000,
    ...elementsToState(MU_MOON, elements({ e: 0.1, raanRad: 0.1 + tS * raanRateRadS, argpRad: 6.2 + tS * argpRateRadS })), // Assumed synthetic ellipse and starting angles.
  }));
  const drift = meanElementsDrift(samples, MU_MOON);
  near(drift.raanRateRadS, raanRateRadS, 1e-16);
  near(drift.argpRateRadS, argpRateRadS, 1e-16);
  const n = Math.sqrt(MU_MOON / LLO_KM ** 3), f = n * J2_MOON * (R_MOON_GRAV / LLO_KM) ** 2;
  near(j2ArgpRate(MU_MOON, J2_MOON, R_MOON_GRAV, LLO_KM, 0, 0), 3 * f, 1e-20);
  near(j2ArgpRate(MU_MOON, J2_MOON, R_MOON_GRAV, LLO_KM, 0, Math.PI / 2), -0.75 * f, 1e-20);
  assert.throws(() => meanElementsDrift([], MU_MOON), RangeError);
});

test('A: point-mass energy is conserved to <1e-8 over ten orbits', () => {
  const initial = elementsToState(MU_MOON, elements());
  const samples = propagate({ r0: initial.r, v0: initial.v, t0Ms: T0, durationS: 10 * periodS(MU_MOON, LLO_KM), stepS: 10, sampleEveryS: 60, model: pointModel() }); // Task's ten orbits; assumed 10 s integration, 60 s sampling.
  const energy = ({ r, v }) => norm(v) ** 2 / 2 - MU_MOON / norm(r);
  const e0 = energy(samples[0]);
  const drift = Math.max(...samples.map((s) => Math.abs((energy(s) - e0) / e0)));
  assert.ok(drift < 1e-8, `relative energy drift ${drift}`);
  assert.ok(distance(samples.at(-1).r, initial.r) < LLO_KM * 1e-6);
});

test('A: C22 gradient matches finite differences, inward on +x and outward on +y', () => {
  const potential = ([x, y, z]) => 3 * MU_MOON * R_MOON_GRAV ** 2 * C22_MOON * (x * x - y * y) / Math.hypot(x, y, z) ** 5;
  const hKm = 0.01; // Assumed numerical finite-difference step, km.
  for (const r of [[LLO_KM, 0, 0], [0, LLO_KM, 0], elementsToState(MU_MOON, elements()).r]) {
    const a = accelC22Fixed(MU_MOON, C22_MOON, R_MOON_GRAV, r);
    for (let k = 0; k < 3; k++) {
      const plus = [...r], minus = [...r];
      plus[k] += hKm;
      minus[k] -= hKm;
      const numeric = (potential(plus) - potential(minus)) / (2 * hKm);
      near(a[k], numeric, Math.max(1e-18, Math.abs(numeric) * 1e-6));
    }
  }
  assert.ok(accelC22Fixed(MU_MOON, C22_MOON, R_MOON_GRAV, [LLO_KM, 0, 0])[0] < 0);
  assert.ok(accelC22Fixed(MU_MOON, C22_MOON, R_MOON_GRAV, [0, LLO_KM, 0])[1] > 0);
});

test('A: real ephemeris gives the expected Earth tide and both force terms rotate into MCI', () => {
  const eph = createEphemeris(JSON.parse(readFileSync(new URL('../demo/data/ephemeris.json', import.meta.url), 'utf8'))); // Source: repository's supplied Horizons ephemeris.
  const tMs = T0 + SIDEREAL_MONTH_S * 1000 / 4;
  const bodies = eph.at(tMs);
  assert.ok(bodies);
  const earthPos = fixedToInertial(bodies.earth.map((x) => x * bodies.earthRangeKm), tMs, T0);
  const sunPos = fixedToInertial(bodies.sun.map((x) => x * AU_KM), tMs, T0);
  const r = earthPos.map((x) => x * LLO_KM / norm(earthPos));
  const earthTide = accelThirdBody(MU_EARTH, r, earthPos);
  assert.ok(norm(earthTide) > 1e-8 && norm(earthTide) < 1e-7, `Earth tide ${norm(earthTide)} km/s²`); // Task's approximate expected tidal range.
  near(norm(earthTide), 2 * MU_EARTH * LLO_KM / bodies.earthRangeKm ** 3, norm(earthTide) * 0.02);
  near(norm(accelThirdBody(MU_EARTH, [0, 0, 0], earthPos)), 0, 0);
  const point = accelPointMass(MU_MOON, r), sunTide = accelThirdBody(MU_SUN, r, sunPos);
  for (const [earth, sun] of [[true, true], [true, false], [false, true], [false, false]]) {
    const model = createForceModel({ epochMs: T0, eph, j2: false, c22: false, earth, sun });
    const expected = point.map((x, k) => x + (earth ? earthTide[k] : 0) + (sun ? sunTide[k] : 0));
    assert.ok(distance(model.accel(tMs, r), expected) < 1e-17);
    assert.deepEqual(model.accel(eph.endMs + 1, r), point);
  }
  assert.deepEqual(createForceModel({ epochMs: T0, j2: false, c22: false }).accel(tMs, r), point);
});

test('A: default staged budget is feasible and inside published comparison ranges', () => {
  const vehicle = cleanVehicle(VEHICLE_DEFAULTS), result = deltaVBudget({ vehicle });
  assert.deepEqual(result.phases.map((p) => p.id), ['tli', 'tcm', 'loi', 'doi', 'pd']);
  assert.equal(result.feasible, true);
  assert.ok(result.marginMs > 0 && result.propellantLeftKg > 0);
  let previousAfterKg = Infinity;
  for (const p of result.phases) {
    assert.equal(p.published, PUBLISHED[p.id]);
    assert.ok(p.dvMs >= p.published.lowMs && p.dvMs <= p.published.highMs, `${p.id}: ${p.dvMs}`);
    assert.ok(p.massBeforeKg <= previousAfterKg && p.massAfterKg < p.massBeforeKg);
    near(p.massBeforeKg - p.massAfterKg, p.propellantKg, 1e-10);
    near(dvForPropellantMs(p.massBeforeKg, p.propellantKg, p.by === 'lander' ? vehicle.ispS : vehicle.tliStage.ispS), p.dvMs, 1e-9);
    if (p.by === 'lander') assert.ok(p.burnS > 0);
    previousAfterKg = p.massAfterKg;
  }
  assert.equal(result.phases[0].burnS, null);
  near(result.phases[0].massAfterKg, vehicle.tliStage.dryMassKg + wetMassKg(vehicle), 0);
  near(result.phases[1].massBeforeKg, wetMassKg(vehicle), 0);
  near(result.tliStagePropellantKg, result.phases[0].propellantKg, 0);
  near(result.landerCapacityMs, dvForPropellantMs(wetMassKg(vehicle), vehicle.propellantKg, vehicle.ispS), 0);
  near(result.marginMs, result.landerCapacityMs - result.landerDvMs - vehicle.reserveDvMs, 1e-12);
  near(result.propellantLeftKg, result.phases.at(-1).massAfterKg - vehicle.dryMassKg, 0);
  near(result.propellantLeftKg, vehicle.propellantKg - result.phases.slice(1).reduce((sum, p) => sum + p.propellantKg, 0), 1e-10);
  assert.equal(result.phases.at(-1).estimated, true);
});

test('A: budget honors supplied descent, plane change, reserve and infeasible propellant load', () => {
  const vehicle = cleanVehicle();
  const base = deltaVBudget({ vehicle });
  const changed = deltaVBudget({ vehicle, pdMs: 1900, lloPlaneChangeDeg: 5, tcmMs: 0 }); // Assumed alternative descent (m/s), plane change (deg), and no TCM.
  assert.equal(changed.phases.at(-1).estimated, false);
  assert.equal(changed.phases.at(-1).dvMs, 1900);
  assert.equal(changed.phases[1].propellantKg, 0);
  assert.equal(changed.phases[1].burnS, 0);
  near(changed.phases[2].dvMs - base.phases[2].dvMs, planeChangeDvMs(circularSpeed(MU_MOON, LLO_KM), 5 * RAD), 1e-12);
  const extraReserveMs = 100; // Assumed extra reserve requirement, m/s.
  const reserve = deltaVBudget({ vehicle: { ...vehicle, reserveDvMs: vehicle.reserveDvMs + extraReserveMs } });
  near(reserve.marginMs, base.marginMs - extraReserveMs, 1e-12);
  near(reserve.propellantLeftKg, base.propellantLeftKg, 0);
  const insufficient = deltaVBudget({ vehicle: cleanVehicle({ propellantKg: 0 }) }); // Assumed empty-tank infeasibility case.
  assert.equal(insufficient.feasible, false);
  assert.ok(insufficient.marginMs < 0 && insufficient.propellantLeftKg < 0);
  assert.throws(() => deltaVBudget({ vehicle, pdiAltKm: -1 }), RangeError);
});
