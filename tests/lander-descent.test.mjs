// Task B/B2 acceptance and physics checks. Scenario numbers are assumed task requirements.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DESCENT_DEFAULTS, simulateDescent, descentDvMs } from '../demo/src/lander/descent.js';
import { VEHICLE_DEFAULTS, cleanVehicle, exhaustVelocityMs, wetMassKg } from '../demo/src/lander/vehicle.js';
import { MU_MOON, R_MOON } from '../demo/src/lander/constants.js';

const startedMs = performance.now();
const vehicle = cleanVehicle(VEHICLE_DEFAULTS);
const nominal = simulateDescent(vehicle);
const abort200 = simulateDescent(vehicle, { abortAtS: 200 }); // assumed task abort epoch, s
const near = (actual, expected, tolerance, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected} (±${tolerance})`);
const norm = (v) => Math.hypot(...v);
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const eventTime = (run, name) => run.events.find((event) => event.name === name)?.tS;
const firstPhase = (run, phase) => run.samples.find((sample) => sample.phase === phase);
const successful = (run) => {
  assert.ok(run.touchdown?.ok, JSON.stringify(run.touchdown));
  assert.ok(Math.abs(run.touchdown.vVertMs) <= vehicle.touchdown.maxVerticalMs);
  assert.ok(run.touchdown.vHorizMs <= vehicle.touchdown.maxHorizontalMs);
  assert.ok(run.touchdown.missM < 5, `miss ${run.touchdown.missM} m`); // assumed task acceptance radius, m
  assert.equal(run.propellantExhausted, false);
};

test('nominal descent satisfies touchdown, delta-v, fuel, time, range and event requirements', () => {
  successful(nominal);
  assert.ok(nominal.dvUsedMs >= 1800 && nominal.dvUsedMs <= 2150, String(nominal.dvUsedMs)); // assumed task budget bounds, m/s
  assert.ok(nominal.propellantUsedKg < vehicle.propellantKg);
  assert.ok(nominal.durationS >= 500 && nominal.durationS <= 900, String(nominal.durationS)); // assumed task duration bounds, s
  assert.ok(nominal.groundRangeM >= 250e3 && nominal.groundRangeM <= 600e3, String(nominal.groundRangeM)); // assumed task surface-range bounds, m
  assert.deepEqual(nominal.events.map((event) => event.name), ['pdi', 'high-gate', 'pitch-over', 'low-gate', 'touchdown']);
  assert.equal(nominal.abortOrbit, null);
  assert.equal(nominal.samples.at(-1).altM, 0);
  assert.equal(nominal.samples.at(-1).tS, nominal.touchdown.tS);
  for (const sample of nominal.samples) {
    assert.ok(sample.throttle >= vehicle.throttleMin && sample.throttle <= vehicle.throttleMax);
    if (sample.tS < nominal.touchdown.tS) assert.ok(sample.altM > 0, `underground at ${sample.tS}`);
  }
});

test('samples are finite PD states at every second and both sides of each phase change', () => {
  let previousS = -Infinity;
  const times = new Set();
  for (const sample of nominal.samples) {
    assert.ok(sample.tS >= previousS);
    previousS = sample.tS;
    times.add(sample.tS);
    assert.ok([...sample.r, ...sample.v, ...sample.thrustDir, sample.massKg, sample.pitchDeg].every(Number.isFinite));
    near(norm(sample.thrustDir), 1, 1e-12, 'unit thrust direction');
    near(norm(sample.r) - R_MOON * 1000, sample.altM, 1e-8, 'spherical altitude');
    near(dot(sample.v, sample.r) / norm(sample.r), sample.vSpeedMs, 1e-10, 'radial speed');
    near(norm(sample.v), Math.hypot(sample.hSpeedMs, sample.vSpeedMs), 1e-9, 'local velocity decomposition');
    assert.ok(sample.massKg >= vehicle.dryMassKg);
  }
  for (let tS = 0; tS <= Math.floor(nominal.durationS); tS++) assert.ok(times.has(tS), `missing second ${tS}`);
  for (const name of ['high-gate', 'low-gate']) {
    const at = nominal.samples.filter((sample) => sample.tS === eventTime(nominal, name));
    assert.equal(new Set(at.map((sample) => sample.phase)).size, 2, `${name} transition samples`);
  }
});

test('PDI uses vis-viva and integrated delta-v agrees with the rocket equation', () => {
  const first = nominal.samples[0], last = nominal.samples.at(-1);
  const rp = R_MOON + DESCENT_DEFAULTS.pdiAltKm, ra = R_MOON + DESCENT_DEFAULTS.lloAltKm;
  near(first.v[0], Math.sqrt(MU_MOON * (2 / rp - 2 / (rp + ra))) * 1000, 1e-9);
  assert.deepEqual(first.r, [0, 0, rp * 1000]);
  assert.equal(first.vSpeedMs, 0);
  near(first.massKg, wetMassKg(vehicle) * Math.exp(-880 / exhaustVelocityMs(vehicle)), 1e-10); // assumed pre-PDI expenditure, m/s
  near(nominal.dvUsedMs, exhaustVelocityMs(vehicle) * Math.log(first.massKg / last.massKg), 1e-6);
  near(nominal.propellantUsedKg, first.massKg - last.massKg, 1e-10);
  const peakThrottle = Math.max(...nominal.samples.filter((s) => s.phase === 'braking').map((s) => s.throttle));
  assert.ok(peakThrottle >= 0.90 && peakThrottle <= 0.95, `planned peak ${peakThrottle}`); // assumed 5–10% thrust margin
  near(descentDvMs(vehicle), nominal.dvUsedMs, 1e-9, 'budget helper');
});

test('high and low gates attain the specified altitude and velocity boundaries', () => {
  const high = firstPhase(nominal, 'approach'), low = firstPhase(nominal, 'terminal');
  near(high.altM, 2000, 0.01); // assumed high-gate altitude, m; numerical tolerance, m
  near(high.hSpeedMs, 70, 0.5); // assumed high-gate horizontal speed, m/s; tgo regularisation error
  near(high.vSpeedMs, -45, 0.01); // assumed high-gate vertical speed, m/s
  near(low.altM, 30, 0.01); // assumed low-gate altitude, m
  near(low.hSpeedMs, 0.5, 0.01); // assumed low-gate horizontal speed, m/s
  near(low.vSpeedMs, -1.5, 0.01); // assumed low-gate vertical speed, m/s
  near(eventTime(nominal, 'low-gate') - eventTime(nominal, 'high-gate'), DESCENT_DEFAULTS.approachS, 1e-9);
  near(norm(nominal.site.r), R_MOON * 1000, 1e-8);
  near(nominal.site.downrangeM - high.downrangeM, DESCENT_DEFAULTS.approachRangeM, 1e-7);
});

test('pitch-over is at least 20 degrees more vertical than the last braking minute', () => {
  const approach = firstPhase(nominal, 'approach');
  const recent = nominal.samples.filter((s) => s.phase === 'braking' && s.tS >= approach.tS - 60); // assumed task averaging window, s
  const meanPitch = recent.reduce((sum, s) => sum + s.pitchDeg, 0) / recent.length;
  assert.ok(approach.pitchDeg <= meanPitch - 20, `${approach.pitchDeg}° vs braking mean ${meanPitch}°`); // assumed required pitch change, deg
  assert.ok(approach.pitchDeg >= 0 && approach.pitchDeg <= 25, `initial pitch ${approach.pitchDeg}°`); // assumed near-vertical approach envelope, deg
  for (const sample of nominal.samples.filter((s) => s.phase === 'approach')) {
    assert.ok(sample.throttle > vehicle.throttleMin, `approach hit throttle floor at ${sample.tS} s`);
    assert.ok(sample.throttle <= 0.8, `approach throttle ${sample.throttle}`); // assumed upper approach throttle bound
  }
});

test('150 m crossrange hazard divert lands at the moved site and spends extra delta-v', () => {
  const run = simulateDescent(vehicle, { divert: { atS: 20, crossrangeM: 150, downrangeM: 0 } }); // assumed task scenario, s and m
  successful(run);
  assert.ok(run.dvUsedMs > nominal.dvUsedMs);
  near(run.site.crossrangeM - nominal.site.crossrangeM, 150, 1e-6); // assumed hazard displacement, m
  near(run.site.downrangeM, nominal.site.downrangeM, 1e-6);
  near(eventTime(run, 'hazard-divert') - eventTime(run, 'high-gate'), 20, 1e-9); // assumed hazard detection delay, s
  near(eventTime(run, 'low-gate'), eventTime(nominal, 'low-gate'), 1e-9, 'feasible divert keeps remaining tgo');
  assert.deepEqual(run.events.map((event) => event.name), ['pdi', 'high-gate', 'pitch-over', 'hazard-divert', 'low-gate', 'touchdown']);
});

test('large late divert extends approach by at most 30 s, preserving throttle limits', () => {
  const run = simulateDescent(vehicle, { divert: { atS: 60, crossrangeM: 1000, downrangeM: 100 } }); // assumed stress scenario, s and m
  successful(run);
  const extensionS = eventTime(run, 'low-gate') - eventTime(nominal, 'low-gate');
  assert.ok(extensionS > 0 && extensionS <= 30); // assumed maximum retarget extension, s
  assert.ok(run.samples.every((s) => s.throttle >= vehicle.throttleMin && s.throttle <= vehicle.throttleMax));
  assert.ok(run.site.downrangeM > nominal.site.downrangeM);
});

test('90% and 85% thrust still land with longer braking and higher delta-v', () => {
  for (const thrustScale of [0.9, 0.85]) { // assumed engine-underperformance scenarios
    const run = simulateDescent(vehicle, { thrustScale });
    successful(run);
    assert.ok(run.durationS > nominal.durationS);
    assert.ok(eventTime(run, 'high-gate') > eventTime(nominal, 'high-gate'));
    assert.ok(run.dvUsedMs > nominal.dvUsedMs);
  }
});

test('abort at 200 s achieves a bound orbit with perilune at least 15 km', () => {
  assert.equal(abort200.samples.at(-1).phase, 'abort');
  assert.equal(abort200.touchdown, null);
  assert.ok(abort200.abortOrbit, 'No qualifying abort orbit was reached');
  assert.ok(abort200.abortOrbit.periAltKm >= 15); // assumed abort safety altitude, km
  assert.ok(abort200.abortOrbit.apoAltKm >= 30 && Number.isFinite(abort200.abortOrbit.apoAltKm)); // assumed minimum apolune, km
  assert.equal(abort200.propellantExhausted, false);
  assert.equal(eventTime(abort200, 'abort'), 200); // assumed task abort epoch, s
  assert.deepEqual(abort200.events.map((event) => event.name), ['pdi', 'abort', 'orbit-achieved']);
  const cutoffS = eventTime(abort200, 'orbit-achieved');
  const cutoff = abort200.samples.find((s) => s.tS === cutoffS), last = abort200.samples.at(-1);
  near(abort200.durationS - cutoffS, DESCENT_DEFAULTS.coastAfterAbortS, 1e-9, 'coast duration');
  assert.ok(last.massKg > vehicle.dryMassKg);
  near(abort200.dvUsedMs, exhaustVelocityMs(vehicle) * Math.log(abort200.samples[0].massKg / last.massKg), 1e-6, 'abort rocket equation');
  const energy = (s) => dot(s.v, s.v) / 2 - MU_MOON * 1e9 / norm(s.r);
  assert.ok(energy(last) < 0, 'negative specific energy for a bound orbit');
  near(energy(last), energy(cutoff), 1e-6, 'coast orbital energy');
  // Independently recover apsides from the final coast state, rather than trusting reported elements.
  const h2 = norm(last.r) ** 2 * dot(last.v, last.v) - dot(last.r, last.v) ** 2;
  const mu = MU_MOON * 1e9, a = -mu / (2 * energy(last));
  const eccentricity = Math.sqrt(1 - h2 / (mu * a));
  near(a * (1 - eccentricity) / 1000 - R_MOON, abort200.abortOrbit.periAltKm, 1e-7, 'coast perilune');
  near(a * (1 + eccentricity) / 1000 - R_MOON, abort200.abortOrbit.apoAltKm, 1e-7, 'coast apolune');
  for (const sample of abort200.samples.filter((s) => s.phase === 'abort')) {
    near(norm(sample.thrustDir), 1, 1e-12, 'unit abort thrust direction');
    assert.equal(sample.throttle, sample.tS < cutoffS ? vehicle.throttleMax : 0);
    if (sample.tS >= cutoffS) assert.equal(sample.massKg, cutoff.massKg, 'no propellant spent coasting');
  }
});

test('fuel-limited abort reports exhaustion without claiming an orbit', () => {
  const run = simulateDescent(vehicle, { massKg: vehicle.dryMassKg + 5, abortAtS: 1 }); // assumed nearly-empty tank, kg; early abort, s
  assert.equal(eventTime(run, 'abort'), 1);
  assert.equal(run.touchdown, null);
  assert.equal(run.abortOrbit, null);
  assert.equal(run.propellantExhausted, true);
  assert.equal(run.samples.at(-1).massKg, vehicle.dryMassKg);
  assert.equal(run.events.at(-1).name, 'propellant-exhausted');
  for (const sample of run.samples.filter((s) => s.phase === 'abort')) {
    assert.equal(sample.throttle, sample === run.samples.at(-1) ? 0 : vehicle.throttleMax);
  }
});

test('abort at PDI recognizes the existing safe ellipse, cuts off, and coasts conservatively', () => {
  const run = simulateDescent(vehicle, { abortAtS: 0 }); // assumed immediate abort at the initial safe orbit
  assert.equal(run.touchdown, null);
  assert.equal(run.propellantExhausted, false);
  near(run.abortOrbit.periAltKm, DESCENT_DEFAULTS.pdiAltKm, 1e-8);
  near(run.abortOrbit.apoAltKm, DESCENT_DEFAULTS.lloAltKm, 1e-8);
  assert.equal(run.durationS, DESCENT_DEFAULTS.coastAfterAbortS);
  assert.equal(run.dvUsedMs, 0);
  assert.equal(run.propellantUsedKg, 0);
  assert.deepEqual(run.events.map((event) => event.name), ['pdi', 'abort', 'orbit-achieved']);
  assert.ok(run.samples.filter((s) => s.phase === 'abort').every((s) => s.throttle === 0));
  const specificEnergy = (s) => dot(s.v, s.v) / 2 - MU_MOON * 1e9 / norm(s.r);
  near(specificEnergy(run.samples.at(-1)), specificEnergy(run.samples[0]), 1e-6, 'coast orbital energy');
});

test('hover holds near 10 m, then resumes descent with additional fuel expenditure', () => {
  const run = simulateDescent(vehicle, { hoverS: 10 }); // assumed hold duration, s
  successful(run);
  assert.ok(run.durationS >= nominal.durationS + 10); // assumed commanded hover duration, s
  assert.ok(run.dvUsedMs > nominal.dvUsedMs);
  assert.ok(run.samples.some((s) => s.phase === 'terminal' && Math.abs(s.altM - 10) < 0.1 && Math.abs(s.vSpeedMs) < 0.1)); // assumed hover altitude, m; settling tolerances
});

test('fuel exhaustion stops at dry mass, including an initially empty tank', () => {
  for (const extraKg of [0, 5]) { // assumed empty / nearly-empty propellant scenarios, kg
    const run = simulateDescent(vehicle, { massKg: vehicle.dryMassKg + extraKg });
    assert.equal(run.propellantExhausted, true);
    assert.equal(run.touchdown, null);
    assert.equal(run.samples.at(-1).massKg, vehicle.dryMassKg);
    near(run.propellantUsedKg, extraKg, 1e-10);
    near(run.dvUsedMs, exhaustVelocityMs(vehicle) * Math.log((vehicle.dryMassKg + extraKg) / vehicle.dryMassKg), 1e-6);
    assert.equal(run.events.at(-1).name, 'propellant-exhausted');
  }
});

test('half-size RK4 steps converge and non-default options preserve caller inputs', () => {
  const finer = simulateDescent(vehicle, { dtS: DESCENT_DEFAULTS.dtS / 2 });
  successful(finer);
  near(finer.dvUsedMs, nominal.dvUsedMs, 0.01); // numerical convergence tolerance, m/s
  near(finer.durationS, nominal.durationS, 0.01); // numerical convergence tolerance, s
  const opts = Object.freeze({ massKg: nominal.samples[0].massKg, siteHeightKm: 2, approachS: 80 }); // assumed raised site and slower approach, km and s
  const run = simulateDescent(VEHICLE_DEFAULTS, opts);
  successful(run);
  near(norm(run.site.r), (R_MOON + opts.siteHeightKm) * 1000, 1e-8);
  near(eventTime(run, 'low-gate') - eventTime(run, 'high-gate'), opts.approachS, 1e-9);
  assert.equal(run.samples[0].massKg, opts.massKg);
  assert.ok(Object.isFrozen(DESCENT_DEFAULTS));
});

test('invalid options reject rather than producing NaNs or an infinite stepping loop', () => {
  for (const opts of [{ dtS: 0 }, { dtS: NaN }, { thrustScale: 0 }, { approachS: -1 }, { massKg: vehicle.dryMassKg - 1 }, { massKg: wetMassKg(vehicle) + 1 }, { abortAtS: -1 }, { divert: { atS: NaN } }]) {
    assert.throws(() => simulateDescent(vehicle, opts), RangeError);
  }
});

test('the entire descent test file runs in under five seconds', () => {
  assert.ok(performance.now() - startedMs < 5000); // requested test-file runtime limit, ms
});
