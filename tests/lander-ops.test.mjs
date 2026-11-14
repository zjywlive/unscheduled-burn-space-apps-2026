// Numeric test inputs are assumed verification scenarios unless a source or derivation is given below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AU_KM, DAY_S, G_MOON_SURFACE, MU_MOON, RAD, R_MOON } from '../demo/src/lander/constants.js';
import { cleanVehicle } from '../demo/src/lander/vehicle.js';
import { ATTITUDE_MODES, attitudeForPhase, arrayFactor, inShadow, betaAngleRad, eclipseFraction, arrayPowerW, simulateBattery, powerAt } from '../demo/src/lander/power.js';
import { gruenFlux, particleMassG, expectedImpacts, poissonAtLeastOne, SPACE_WEATHER, stormLevel, CME_TRANSIT_DAYS, ORBITAL_DEBRIS, EXOSPHERE } from '../demo/src/lander/environment.js';
import { EVENTS, ACTIONS, divertDvMs, retargetDvMs, decide, planBranches } from '../demo/src/lander/contingency.js';

const near = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected} (tol ${tolerance})`);
const vehicle = cleanVehicle();
const lunarRadiusKm = R_MOON + 100; // Assumed 100 km circular reference orbit.
const lunarPeriodS = 2 * Math.PI * Math.sqrt(lunarRadiusKm ** 3 / MU_MOON);
const orbitState = { phase: 'llo', altitudeM: 100e3, orbitPeriodS: lunarPeriodS, nextPlaneWindowS: 3 * lunarPeriodS };

test('ops power: mission phases map to the prescribed attitude and unknown phases fail to safe mode', () => {
  const groups = {
    'sun-point': ['leo', 'coast', 'llo', 'loiter'], burn: ['tli', 'tcm', 'loi', 'doi', 'braking'],
    descent: ['approach', 'terminal'], surface: ['landed'], safe: ['safe', 'hold'],
  };
  for (const [mode, phases] of Object.entries(groups)) {
    assert.equal(typeof ATTITUDE_MODES[mode], 'string');
    for (const phase of phases) assert.equal(attitudeForPhase(phase), mode);
  }
  assert.equal(attitudeForPhase('unknown'), 'safe');
  assert.equal(attitudeForPhase('toString'), 'safe');
});

test('ops power: roll freedom gives zero power along thrust and full power perpendicular to thrust', () => {
  for (const mode of ['burn', 'descent']) {
    for (const tracking of ['fixed', 'one-axis']) {
      assert.equal(arrayFactor(mode, { sunDir: [0, 0, 1], burnDir: [0, 0, 1], tracking }), 0);
      assert.equal(arrayFactor(mode, { sunDir: [0, 0, -1], burnDir: [0, 0, 1], tracking }), 0);
      assert.equal(arrayFactor(mode, { sunDir: [1, 0, 0], burnDir: [0, 0, 1], tracking }), 1);
      near(arrayFactor(mode, { sunDir: [Math.SQRT1_2, 0, Math.SQRT1_2], burnDir: [0, 0, 1], tracking }), Math.SQRT1_2);
    }
  }
  assert.equal(arrayFactor('sun-point'), 1);
  assert.equal(arrayFactor('safe'), 1);
  assert.equal(arrayFactor('burn'), 0);
  assert.throws(() => arrayFactor('unknown'), RangeError);
});

test('ops power: upright fixed and one-axis panels use local azimuth and elevation', () => {
  near(arrayFactor('surface', { panelAzDeg: 45, sunAzDeg: 45, sunElDeg: 2, tracking: 'fixed' }), 0.999390827, 1e-9);
  assert.equal(arrayFactor('surface', { panelAzDeg: 225, sunAzDeg: 45, sunElDeg: 2, tracking: 'fixed' }), 0);
  near(arrayFactor('surface', { panelAzDeg: 225, sunAzDeg: 45, sunElDeg: 2, tracking: 'one-axis' }), Math.cos(2 * RAD));
  near(arrayFactor('surface', { sunElDeg: 90, tracking: 'one-axis' }), 0);
  near(arrayFactor('surface', { sunDir: [Math.SQRT1_2, 0, Math.SQRT1_2], up: [0, 0, 1], tracking: 'one-axis' }), Math.SQRT1_2);
  assert.equal(arrayFactor('surface'), 0);
});

test('ops power: cylindrical lunar shadow is frame-independent and excludes the day side and limb', () => {
  const centre = [100, -200, 300];
  const at = (x, y, z) => [centre[0] + x, centre[1] + y, centre[2] + z];
  assert.equal(inShadow(at(-lunarRadiusKm, 0, 0), [1, 0, 0], centre, R_MOON), true);
  assert.equal(inShadow(at(lunarRadiusKm, 0, 0), [1, 0, 0], centre, R_MOON), false);
  assert.equal(inShadow(at(-lunarRadiusKm, R_MOON + 1, 0), [1, 0, 0], centre, R_MOON), false);
  assert.equal(inShadow(at(-lunarRadiusKm, R_MOON, 0), [1, 0, 0], centre, R_MOON), false);
  assert.equal(inShadow(at(0, 0, -lunarRadiusKm), [0, 0, 1], centre, R_MOON), true);
});

test('ops power: circular eclipse fraction matches the 100 km analytic lunar case and beta cutoff', () => {
  // Wertz & Larson circular cylindrical-shadow geometry: approximately 0.3945 of a 100 km lunar orbit.
  const fraction = eclipseFraction(0, 100, R_MOON);
  assert.ok(fraction >= 0.38 && fraction <= 0.41);
  near(fraction, 0.394, 0.001);
  assert.equal(eclipseFraction(80 * RAD, 100, R_MOON), 0);
  assert.equal(eclipseFraction(-80 * RAD, 100, R_MOON), 0);
  near(eclipseFraction(30 * RAD, 100), eclipseFraction(-30 * RAD, 100));
  assert.equal(eclipseFraction(Math.asin(R_MOON / lunarRadiusKm), 100), 0);
  near(betaAngleRad([0, 0, 1], [0, 0, 1]), Math.PI / 2);
  near(betaAngleRad([0, 0, 1], [Math.cos(30 * RAD), 0, -Math.sin(30 * RAD)]), -30 * RAD);
  assert.throws(() => eclipseFraction(0, -1), RangeError);
});

test('ops power: distance, degradation and shadow modify rated array power independently', () => {
  assert.equal(arrayPowerW(vehicle, 1), vehicle.arrayPowerW);
  near(arrayPowerW(vehicle, 0.5, { sunDistanceKm: 2 * AU_KM, degradation: 0.8 }), vehicle.arrayPowerW * 0.1);
  assert.equal(arrayPowerW(vehicle, 1, { lit: false }), 0);
  assert.equal(arrayPowerW(vehicle, -1), 0);
  assert.throws(() => arrayPowerW(vehicle, 1, { sunDistanceKm: 0 }), RangeError);
});

test('ops power: a 48 minute eclipse consumes about 10% of the assumed 3000 Wh battery and sunlight restores it', () => {
  // Assumed task scenario: 380 W for 48 min gives 304 Wh, or 0.101333 of the shared vehicle battery.
  const steps = [{ dtS: 48 * 60, generationW: 0, loadW: 380 }, { dtS: 48 * 60, generationW: vehicle.arrayPowerW, loadW: 380 }];
  const frozen = JSON.stringify(steps);
  const sim = simulateBattery(steps, vehicle);
  near(sim.soc[1], 1 - 304 / vehicle.batteryWh);
  near(1 - sim.minSoc, 0.10, 0.002);
  assert.equal(sim.endSoc, 1);
  assert.equal(sim.belowMin, false);
  assert.equal(sim.firstBelowIndex, -1);
  assert.equal(sim.soc.length, steps.length + 1);
  assert.equal(JSON.stringify(steps), frozen);
});

test('ops power: battery reserve crossings, saturation, initial state and zero capacity are explicit', () => {
  const sim = simulateBattery([
    { dtS: 3600, generationW: 0, loadW: vehicle.batteryWh },
    { dtS: 3600, generationW: 2 * vehicle.batteryWh, loadW: 0 },
  ], vehicle, { initialSoc: 0.5 });
  assert.deepEqual(sim.soc, [0.5, 0, 1]);
  assert.equal(sim.belowMin, true);
  assert.equal(sim.firstBelowIndex, 1);
  assert.equal(sim.minSoc, 0);
  assert.equal(sim.endSoc, 1);
  assert.deepEqual(simulateBattery([], vehicle, { initialSoc: 0.1 }), { soc: [0.1], minSoc: 0.1, endSoc: 0.1, belowMin: true, firstBelowIndex: 0 });
  assert.equal(simulateBattery([], vehicle, { initialSoc: vehicle.batteryMinSoc }).belowMin, false);
  assert.equal(simulateBattery([], vehicle, { initialSoc: 2 }).endSoc, 1);
  const empty = simulateBattery([{ dtS: 1, generationW: 0, loadW: 380 }], cleanVehicle({ batteryWh: 0 }));
  assert.deepEqual(empty.soc, [0, 0]);
  assert.equal(empty.belowMin, true);
  assert.throws(() => simulateBattery([{ dtS: -1, generationW: 0, loadW: 0 }], vehicle), RangeError);
});

test('ops power: powerAt selects operational loads and vehicle tracking without confusing incidence with lighting', () => {
  const modes = [['sun-point', {}, 'cruise'], ['sun-point', { inLunarOrbit: true }, 'orbit'],
    ['burn', { sunDir: [1, 0, 0], burnDir: [0, 0, 1] }, 'orbit'],
    ['descent', { sunDir: [1, 0, 0], burnDir: [0, 0, 1] }, 'descent'],
    ['surface', { panelAzDeg: 180, sunAzDeg: 0, sunElDeg: 0 }, 'surface'], ['safe', {}, 'safe']];
  for (const [mode, geometry, loadKey] of modes) {
    const power = powerAt(vehicle, mode, geometry);
    assert.equal(power.loadW, vehicle.loadsW[loadKey]);
    assert.equal(power.netW, power.generationW - power.loadW);
    assert.equal(power.factor, 1);
  }
  const fixed = cleanVehicle({ arrayTracking: 'fixed' });
  assert.equal(powerAt(fixed, 'surface', { panelAzDeg: 180, sunAzDeg: 0, sunElDeg: 0 }).factor, 0);
  const eclipse = powerAt(vehicle, 'sun-point', { lit: false, inLunarOrbit: true });
  assert.equal(eclipse.factor, 1);
  assert.equal(eclipse.generationW, 0);
  assert.equal(eclipse.netW, -vehicle.loadsW.orbit);
});

test('ops environment: Gruen cumulative flux agrees with the supplied reference and decreases with mass', () => {
  // Gruen et al. 1985 reference supplied in the task: about 4.7e-8 m^-2 s^-1 at 1e-6 g.
  near(gruenFlux(1e-6), 4.7e-8, 0.2 * 4.7e-8);
  const massesG = [1e-12, 1e-10, 1e-8, 1e-6, 1e-4, 1e-2, 1];
  for (let i = 1; i < massesG.length; i++) assert.ok(gruenFlux(massesG[i]) < gruenFlux(massesG[i - 1]));
  assert.throws(() => gruenFlux(0), RangeError);
  assert.throws(() => gruenFlux(-1), RangeError);
});

test('ops environment: spherical particle mass, plate exposure and lunar shielding have the intended units', () => {
  near(particleMassG(2, 1), 4 * Math.PI / 3);
  near(particleMassG(0.009), 1e-6, 0.05e-6); // Assumed 90 µm grain at 2.5 g/cm³ is about one microgram.
  near(particleMassG(0.02) / particleMassG(0.01), 8);
  const exposure = { areaM2: 2, durationS: DAY_S, minMassG: 1e-6 };
  const free = expectedImpacts({ ...exposure, shielding: 1 });
  near(free, 2 * DAY_S * gruenFlux(1e-6));
  near(expectedImpacts(exposure), free / 2);
  assert.equal(expectedImpacts({ ...exposure, shielding: 0 }), 0);
  assert.equal(expectedImpacts({ ...exposure, durationS: 0 }), 0);
  assert.throws(() => expectedImpacts({ ...exposure, areaM2: -1 }), RangeError);
});

test('ops environment: Poisson probability is accurate even for tiny expected counts', () => {
  assert.equal(poissonAtLeastOne(0), 0);
  near(poissonAtLeastOne(1), 1 - 1 / Math.E);
  near(poissonAtLeastOne(1e-15), 1e-15, 1e-29);
  assert.equal(poissonAtLeastOne(Infinity), 1);
  assert.throws(() => poissonAtLeastOne(-1), RangeError);
});

test('ops environment: NOAA storm thresholds are inclusive and qualitative hazards do not invent probabilities', () => {
  // NOAA SWPC solar radiation scale thresholds (>=10 MeV) and cycle frequencies, as supplied in the task.
  assert.equal(stormLevel(0), 0);
  for (const [i, pfu] of [10, 100, 1000, 10000, 100000].entries()) {
    assert.equal(stormLevel(pfu), i + 1);
    assert.equal(stormLevel(pfu * 0.99), i);
  }
  assert.deepEqual(SPACE_WEATHER.map((level) => level.averagePer11YearCycle), ['50', '25', '10', '3', '<1']);
  assert.deepEqual(CME_TRANSIT_DAYS, { fast: 1, typical: 3, slow: 4 });
  assert.equal(ORBITAL_DEBRIS.leo.impactProbability, 'not computed');
  assert.match(ORBITAL_DEBRIS.leo.model, /ORDEM 3\.1/);
  assert.match(ORBITAL_DEBRIS.lunar.example, /18 Oct 2021/);
  assert.match(EXOSPHERE.note, /no measurable drag/);
});

test('ops contingency: divert and retarget costs obey analytic kinematics and unit conversion', () => {
  assert.equal(divertDvMs(150, 40), 15);
  assert.equal(divertDvMs(150, 40, 0), divertDvMs(150, 40, G_MOON_SURFACE));
  assert.equal(divertDvMs(0, 0), 0);
  assert.equal(divertDvMs(1, 0), Infinity);
  assert.throws(() => divertDvMs(1, -1), RangeError);
  // A 60° plane change costs exactly the circular speed: 2v sin(30°) = v.
  near(retargetDvMs(2, lunarRadiusKm * Math.PI / 3, lunarRadiusKm), 2000);
  assert.equal(retargetDvMs(2, 0, lunarRadiusKm), 0);
  assert.throws(() => retargetDvMs(2, 1, 0), RangeError);
});

test('ops contingency: S3 before PDI holds in safe mode for a revolution and storm holds clear only below S2', () => {
  const decision = decide('spe', { ...orbitState, stormLevel: 3 });
  assert.equal(decision.action, 'hold');
  assert.equal(decision.delayS, lunarPeriodS);
  assert.match(decision.reason, /safe mode.*below S2/);
  assert.equal(decide('spe', { ...orbitState, stormLevel: 2 }).action, 'continue');
  assert.equal(decide('spe', { ...orbitState, phase: 'hold', stormLevel: 2 }).action, 'hold');
  assert.equal(decide('spe', { ...orbitState, phase: 'hold', stormLevel: 1 }).action, 'continue');
});

test('ops contingency: storms do not interrupt committed descent and coast uses safe mode', () => {
  for (const phase of ['braking', 'approach', 'terminal']) {
    const decision = decide('spe', { ...orbitState, phase, stormLevel: 5 });
    assert.equal(decision.action, 'continue');
    assert.equal(decision.delayS, 0);
  }
  assert.equal(decide('spe', { phase: 'coast', stormLevel: 3 }).action, 'safe-mode');
  assert.equal(decide('spe', { phase: 'coast', stormLevel: 3 }).delayS, 0);
  assert.equal(decide('spe', { ...orbitState, tSincePdiS: 1, stormLevel: 3 }).action, 'continue');
});

test('ops contingency: a CME warning blocks only an overlapping or unknown pre-PDI landing window', () => {
  const state = { ...orbitState, landingWindowStartS: 100, landingWindowEndS: 200 };
  for (const cmeArrivalS of [100, 150, 200]) assert.equal(decide('cme-warning', { ...state, cmeArrivalS }).action, 'hold');
  for (const cmeArrivalS of [99, 201]) assert.equal(decide('cme-warning', { ...state, cmeArrivalS }).action, 'continue');
  assert.equal(decide('cme-warning', orbitState).action, 'hold');
  assert.equal(decide('cme-warning', { ...state, phase: 'braking', cmeArrivalS: 150 }).action, 'continue');
});

test('ops contingency: absent ground GO waves off before PDI but leaves autonomous descent running', () => {
  const decision = decide('comms-loss', { ...orbitState, earthVisible: false });
  assert.equal(decision.action, 'wave-off');
  assert.equal(decision.delayS, lunarPeriodS);
  for (const phase of ['braking', 'approach', 'terminal']) {
    assert.equal(decide('comms-loss', { ...orbitState, phase, earthVisible: false }).action, 'continue');
  }
});

test('ops contingency: underperformance aborts during braking only if the remaining margin invades reserve', () => {
  const state = { ...orbitState, phase: 'braking', dvToGoMs: 1550, reserveDvMs: 60, thrustScale: 0.85 };
  assert.equal(decide('engine-underperformance', { ...state, dvRemainingMs: 1600 }).action, 'abort-to-orbit');
  const exactReserve = decide('engine-underperformance', { ...state, dvRemainingMs: 1610 });
  assert.equal(exactReserve.action, 'continue');
  assert.match(exactReserve.reason, /longer burn/);
  for (const phase of ['approach', 'terminal']) {
    assert.equal(decide('engine-underperformance', { ...state, phase, dvRemainingMs: 0 }).action, 'continue');
  }
});

test('ops contingency: approach hazards divert within budget or land within the maximum reachable footprint', () => {
  const state = { ...orbitState, phase: 'approach', hazardDistanceM: 150, approachTimeLeftS: 40 };
  const reachable = decide('site-hazard', state);
  assert.equal(reachable.action, 'divert');
  assert.equal(reachable.dvCostMs, 15);
  assert.equal(reachable.delayS, 0);
  const limited = decide('site-hazard', { ...state, hazardDistanceM: 1500 });
  assert.equal(limited.action, 'divert');
  assert.equal(limited.dvCostMs, 60);
  assert.equal(limited.branch, 'divert-limited');
  assert.match(limited.reason, /600 m/);
  const noTime = decide('site-hazard', { ...state, approachTimeLeftS: 0 });
  assert.equal(noTime.action, 'divert');
  assert.equal(noTime.dvCostMs, 0);
  assert.match(noTime.reason, /within 0 m/);
  assert.equal(decide('site-hazard', { ...state, divertBudgetMs: 0 }).dvCostMs, 0);
});

test('ops contingency: before PDI retarget to the nearest affordable alternate or wait for the next plane window', () => {
  const alternates = [
    { id: 'far', name: 'Far ridge', crossrangeKm: 1000 }, { id: 'near', name: 'Near ridge', crossrangeKm: 20 },
    { id: 'middle', name: 'Middle ridge', crossrangeKm: 40 },
  ];
  const state = { ...orbitState, dvRemainingMs: 1660, dvToGoMs: 1500, reserveDvMs: 60, alternates };
  const original = JSON.stringify(state);
  const decision = decide('site-hazard', state);
  assert.equal(decision.action, 'retarget');
  assert.equal(decision.branch, 'retarget:near');
  assert.ok(decision.dvCostMs > 0 && decision.dvCostMs <= 100);
  assert.equal(JSON.stringify(state), original);
  const insufficient = decide('site-hazard', { ...state, dvRemainingMs: 1570 });
  assert.equal(insufficient.action, 'hold');
  assert.equal(insufficient.delayS, state.nextPlaneWindowS);
  assert.equal(decide('site-hazard', { ...state, alternates: [] }).action, 'hold');
});

test('ops contingency: impact anomalies enter safe mode then hold', () => {
  const decision = decide('mmod-strike', orbitState);
  assert.equal(decision.action, 'safe-mode');
  assert.equal(decision.branch, 'safe-mode-then-hold');
  assert.equal(decision.delayS, lunarPeriodS);
  assert.match(decision.reason, /then hold/);
  assert.equal(decide('mmod-strike', { phase: 'coast' }).delayS, 0);
});

test('ops contingency: conjunctions below one kilometre trigger a small approximate avoidance manoeuvre', () => {
  const decision = decide('debris-conjunction', { ...orbitState, conjunctionMissKm: 0.5 });
  assert.equal(decision.action, 'avoidance-manoeuvre');
  assert.ok(decision.dvCostMs >= 0.1 && decision.dvCostMs <= 1);
  assert.equal(decide('debris-conjunction', { ...orbitState, conjunctionMissKm: 1 }).action, 'continue');
  assert.equal(decide('debris-conjunction', { ...orbitState, conjunctionMissKm: 5 }).action, 'continue');
});

test('ops contingency: visibility no-go selects a lit alternate, otherwise waits for the next plane window', () => {
  const state = { ...orbitState, sunVisible: false, earthVisible: true, alternates: [
    { id: 'dark', name: 'Dark ridge', crossrangeKm: 1, lit: false },
    { id: 'light', name: 'Sunlit ridge', crossrangeKm: 10, lit: true },
  ] };
  const alternate = decide('illumination-no-go', state);
  assert.equal(alternate.action, 'retarget');
  assert.equal(alternate.branch, 'retarget:light');
  assert.ok(alternate.dvCostMs > 0);
  const waiting = decide('illumination-no-go', { ...state, alternates: [] });
  assert.equal(waiting.action, 'hold');
  assert.equal(waiting.delayS, state.nextPlaneWindowS);
  assert.equal(decide('illumination-no-go', { ...state, dvRemainingMs: 0 }).action, 'hold');
  assert.equal(decide('illumination-no-go', { ...state, earthVisible: false }).action, 'hold');
  assert.equal(decide('illumination-no-go', { ...state, earthVisible: false, alternates: [{ id: 'both', crossrangeKm: 10, lit: true, earthVisible: true }] }).action, 'retarget');
  assert.equal(decide('illumination-no-go', { ...state, phase: 'terminal' }).action, 'continue');
});

test('ops contingency: optional state fields produce finite deterministic decisions for every event', () => {
  assert.equal(EVENTS.length, 8);
  for (const event of EVENTS) {
    assert.ok(event.name && event.detection && event.description && event.phases.length);
    const decision = decide(event.id);
    assert.ok(Object.hasOwn(ACTIONS, decision.action));
    assert.ok(Number.isFinite(decision.dvCostMs) && decision.dvCostMs >= 0);
    assert.ok(Number.isFinite(decision.delayS) && decision.delayS >= 0);
    assert.ok(decision.reason.length > 0 && typeof decision.branch === 'string');
    assert.deepEqual(decide(event.id), decision);
  }
  assert.equal(decide('unknown').action, 'continue');
});

test('ops contingency: branch planning chooses the most critical available phase without mutating the mission', () => {
  const phases = ['leo', 'coast', 'llo', 'doi', 'braking', 'approach', 'terminal', 'landed'].map((id) => ({ id }));
  const state = { ...orbitState, tSincePdiS: 200, hazardDistanceM: 150, approachTimeLeftS: 40 };
  const before = JSON.stringify({ phases, state });
  const branches = planBranches({ phases, state });
  assert.equal(branches.length, EVENTS.length);
  assert.equal(branches.find((branch) => branch.eventId === 'spe').phase, 'braking');
  assert.equal(branches.find((branch) => branch.eventId === 'comms-loss').phase, 'doi');
  assert.equal(branches.find((branch) => branch.eventId === 'comms-loss').action, 'wave-off');
  assert.equal(branches.find((branch) => branch.eventId === 'site-hazard').action, 'divert');
  assert.equal(JSON.stringify({ phases, state }), before);
  assert.deepEqual(planBranches({ phases: ['unrecognised'] }), []);
  assert.deepEqual(planBranches(), []);
});
