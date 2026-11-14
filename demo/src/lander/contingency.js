// Deterministic screening rules for the UI, not an autonomous flight controller or an abort trajectory solver.
import { G_MOON_SURFACE, MU_MOON, R_MOON } from './constants.js';
import { VEHICLE_DEFAULTS } from './vehicle.js';

const PRE_PDI_PHASES = ['leo', 'tli', 'coast', 'tcm', 'loi', 'llo', 'loiter', 'doi'];
const DESCENT_PHASES = ['braking', 'approach', 'terminal'];
const FLIGHT_PHASES = [...PRE_PDI_PHASES, ...DESCENT_PHASES, 'landed', 'safe', 'hold'];
const LUNAR_WAIT_PHASES = ['llo', 'loiter', 'doi', 'hold'];
const DEFAULT_ALTITUDE_M = 100e3; // Assumed reference circular low lunar orbit when altitude is unavailable.
const DEFAULT_DIVERT_BUDGET_MS = 60; // Assumed lateral-divert allocation, as specified in the task.
const CONJUNCTION_TRIGGER_KM = 1; // Assumed screening threshold, not a collision-probability calculation.
const AVOIDANCE_DV_MS = 0.5; // Approximate, assumed representative impulse in the requested 0.1–1 m/s range.

export const EVENTS = Object.freeze([
  { id: 'spe', name: 'Solar particle event', phases: FLIGHT_PHASES,
    detection: 'NOAA SWPC alert or onboard particle monitor reports a storm at S3 or above.',
    description: 'Elevated energetic proton flux calls for protected electronics and a pre-descent hold.' },
  { id: 'cme-warning', name: 'CME arrival warning', phases: [...PRE_PDI_PHASES, ...DESCENT_PHASES],
    detection: 'A space-weather forecast predicts a coronal mass ejection arrival near the landing window.',
    description: 'Compare forecast arrival with the landing window before committing to descent.' },
  { id: 'comms-loss', name: 'Ground link lost', phases: [...LUNAR_WAIT_PHASES, ...DESCENT_PHASES],
    detection: 'The ground GO is missing or the expected link heartbeat is lost.',
    description: 'Require a ground GO before descent, then rely on autonomous onboard guidance.' },
  { id: 'engine-underperformance', name: 'Engine underperformance', phases: ['tli', 'tcm', 'loi', 'doi', ...DESCENT_PHASES],
    detection: 'Measured acceleration is below the commanded thrust prediction.',
    description: 'Reassess remaining descent delta-v and the protected propellant reserve.' },
  { id: 'site-hazard', name: 'Landing site hazard', phases: [...LUNAR_WAIT_PHASES, 'approach', 'terminal'],
    detection: 'Terrain assessment or onboard lidar finds boulders or a slope above the vehicle touchdown limit.',
    description: 'Retarget before powered descent or choose a reachable safe patch within the lidar view.' },
  { id: 'mmod-strike', name: 'Micrometeoroid strike', phases: FLIGHT_PHASES,
    detection: 'An impact-related power, pressure or attitude anomaly appears in telemetry.',
    description: 'Enter safe mode for diagnosis, then hold before resuming the mission.' },
  { id: 'debris-conjunction', name: 'Predicted conjunction', phases: ['leo', ...LUNAR_WAIT_PHASES],
    detection: 'Catalogue screening or operator coordination predicts a close approach.',
    description: 'Apply a small avoidance manoeuvre when the predicted miss distance is too small.' },
  { id: 'illumination-no-go', name: 'Landing visibility no-go', phases: LUNAR_WAIT_PHASES,
    detection: 'The landing-time geometry puts the Sun or Earth below the local horizon.',
    description: 'Wait for a compatible window or select an illuminated alternate before descent.' },
].map((event) => Object.freeze({ ...event, phases: Object.freeze([...event.phases]) })));

export const ACTIONS = Object.freeze({
  continue: 'Continue the current trajectory with onboard guidance and monitoring.',
  hold: 'Wait in orbit for the next acceptable opportunity.',
  divert: 'Move the landing target to a reachable patch within the lidar view.',
  retarget: 'Select an alternate landing site before powered descent initiation.',
  'abort-to-orbit': 'Attempt to regain a viable lunar orbit before the descent becomes irreversible.',
  'wave-off': 'Skip this powered descent initiation and remain in orbit for another revolution.',
  'avoidance-manoeuvre': 'Apply a small trajectory change to increase a predicted conjunction miss distance.',
  'safe-mode': 'Use a Sun-pointing survival attitude while diagnosing the anomaly before holding.',
});

// Rest-to-rest lateral bang-bang: acceleration 4d/t², total |delta-v| = 4d/t.
// Assumed: timeS is already available in approach, so extra hover time is zero and gMs2 * extraTimeS = 0.
export function divertDvMs(distanceM, timeS, gMs2 = G_MOON_SURFACE) {
  if (![distanceM, timeS, gMs2].every(Number.isFinite) || distanceM < 0 || timeS < 0 || gMs2 < 0) {
    throw new RangeError('Divert distance, available time and gravity must be finite and nonnegative');
  }
  if (distanceM === 0) return 0;
  return timeS > 0 ? 4 * distanceM / timeS : Infinity;
}

// Instantaneous circular-orbit plane change, with crossrange approximated as arc length r * psi.
export function retargetDvMs(vOrbitKms, crossrangeKm, rKm) {
  if (![vOrbitKms, crossrangeKm, rKm].every(Number.isFinite) || vOrbitKms < 0 || crossrangeKm < 0 || rKm <= 0 || crossrangeKm / rKm > Math.PI) {
    throw new RangeError('Retargeting requires positive radius, nonnegative speed and a shortest-arc crossrange');
  }
  return 2 * vOrbitKms * Math.sin(crossrangeKm / rKm / 2) * 1000; // km/s to m/s.
}

const nonnegative = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
const result = (action, reason, dvCostMs = 0, delayS = 0, branch = action) => ({ action, reason, dvCostMs, delayS, branch });

function nearestAlternate(state, altitudeM, marginMs, requireLit = false) {
  const rKm = R_MOON + altitudeM / 1000;
  const vOrbitKms = Math.sqrt(MU_MOON / rKm);
  let nearest = null;
  for (const alternate of state.alternates ?? []) {
    if (!alternate || !Number.isFinite(alternate.crossrangeKm) || alternate.crossrangeKm < 0 || alternate.crossrangeKm > Math.PI * rKm) continue;
    if (requireLit && (alternate.lit !== true || alternate.earthVisible === false)) continue;
    // An explicitly failed Earth horizon check needs explicit alternate Earth visibility, not just sunlight.
    if (requireLit && state.earthVisible === false && alternate.earthVisible !== true) continue;
    const dvCostMs = retargetDvMs(vOrbitKms, alternate.crossrangeKm, rKm);
    if (dvCostMs <= marginMs && (!nearest || alternate.crossrangeKm < nearest.alternate.crossrangeKm)) nearest = { alternate, dvCostMs };
  }
  return nearest;
}

// State units follow their suffixes. Missing state assumes pre-PDI lunar orbit and no proven spare delta-v.
// CME extension: cmeArrivalS, landingWindowStartS and landingWindowEndS are seconds from the same "now";
// missing forecast/window data conservatively blocks PDI. Alternate earthVisible may resolve an Earth no-go.
// branch is a stable string key (retarget:<site id> identifies an alternate), not a propagated trajectory.
// dvCostMs is the extra manoeuvre estimate; zero for an abort/longer burn means not computed, not fuel-free.
// delayS is time to reassessment, not a prediction of storm clearance or a guarantee that a hold is safe.
export function decide(eventId, state = {}) {
  const phase = state.phase ?? 'llo';
  const landed = phase === 'landed';
  const descending = !landed && (DESCENT_PHASES.includes(phase) || nonnegative(state.tSincePdiS, 0) > 0);
  const beforePdi = !landed && !descending;
  const altitudeM = nonnegative(state.altitudeM, DEFAULT_ALTITUDE_M);
  const rKm = R_MOON + altitudeM / 1000;
  const periodS = nonnegative(state.orbitPeriodS, 0) || 2 * Math.PI * Math.sqrt(rKm ** 3 / MU_MOON);
  const nextWindowS = nonnegative(state.nextPlaneWindowS, 0) || periodS;
  const reserveDvMs = nonnegative(state.reserveDvMs, VEHICLE_DEFAULTS.reserveDvMs);
  const marginMs = nonnegative(state.dvRemainingMs, 0) - nonnegative(state.dvToGoMs, 0) - reserveDvMs;

  if (eventId === 'spe') {
    // S3 blocks a new PDI; an existing storm hold stays in place at S2 and releases only below S2.
    const threshold = phase === 'hold' || phase === 'safe' ? 2 : 3; // Assumed operational S-scale thresholds from the task.
    if (nonnegative(state.stormLevel, 3) < threshold) return result('continue', 'The reported storm is below the threshold for this flight state.');
    // Assumed descent lasts about 12 min: once committed, stopping is riskier than finishing autonomously.
    if (descending) return result('continue', 'Finish the roughly twelve-minute descent autonomously because interrupting it is riskier than the storm.', 0, 0, 'storm-committed');
    if (phase === 'coast' || landed) return result('safe-mode', 'Protect the electronics in safe mode until the storm falls below S2.');
    // Reassess after one full revolution; repeat whole revolutions until the measured storm is below S2.
    return result('hold', 'Wait in Sun-pointing safe mode and reassess each revolution until the storm falls below S2.', 0, periodS, 'storm-safe-hold');
  }

  if (eventId === 'cme-warning') {
    // Hold before PDI if CME arrival overlaps the landing window; unknown timing cannot clear the warning.
    const { cmeArrivalS, landingWindowStartS = 0, landingWindowEndS } = state;
    const known = [cmeArrivalS, landingWindowStartS, landingWindowEndS].every(Number.isFinite)
      && landingWindowStartS <= landingWindowEndS;
    const overlaps = !known || (cmeArrivalS >= landingWindowStartS && cmeArrivalS <= landingWindowEndS);
    if (beforePdi && overlaps) return result('hold', known
      ? 'Hold for another revolution because the forecast CME arrival overlaps the landing window.'
      : 'Hold until the CME forecast can rule out arrival during the landing window.', 0, periodS, 'cme-hold');
    return result('continue', beforePdi ? 'The forecast CME arrival is outside the landing window.' : 'Keep the committed mission trajectory while monitoring the CME warning.');
  }

  if (eventId === 'comms-loss') {
    // No ground GO before PDI means wave off for one revolution; descent guidance is autonomous after PDI.
    if (descending) return result('continue', 'Continue autonomous descent because a ground link is not required after powered descent begins.');
    if (beforePdi) return result('wave-off', 'Skip this descent without a ground GO and retry after one revolution.', 0, periodS);
    return result('safe-mode', 'Use survival power on the surface while attempting to restore the ground link.');
  }

  if (eventId === 'engine-underperformance') {
    // During braking, protect reserve; after high gate (approach/terminal), continue landing rather than abort.
    if (phase === 'braking' && marginMs < 0) return result('abort-to-orbit', 'The braking fuel margin is below the protected reserve, so attempt an abort back to orbit.');
    if (descending) return result('continue', phase === 'braking'
      ? 'The fuel margin protects the reserve, so continue braking with a longer burn.'
      : 'Continue to the best reachable landing spot because the high gate has already been passed.');
    if (landed) return result('continue', 'Touchdown is complete and no further descent burn is needed.');
    return result('hold', 'Delay descent while reassessing the engine performance and remaining fuel.', 0, periodS);
  }

  if (eventId === 'site-hazard') {
    // During approach, lateral bang-bang may use only the allocated time and divert delta-v, with no extra hover.
    if (descending) {
      const timeS = nonnegative(state.approachTimeLeftS, 0);
      const budgetMs = nonnegative(state.divertBudgetMs, DEFAULT_DIVERT_BUDGET_MS);
      const distanceM = nonnegative(state.hazardDistanceM, 0);
      const requiredMs = divertDvMs(distanceM, timeS);
      if (requiredMs <= budgetMs && timeS > 0) return result('divert', 'Move to the hazard-free target within the lidar view using the remaining approach time.', requiredMs);
      // Wave-off is impossible this low: maximum reachable displacement is d = delta-v * t / 4.
      const maxDistanceM = budgetMs * timeS / 4;
      return result('divert', `Land at the best visible spot within ${Math.floor(maxDistanceM)} m because an orbital wave-off is no longer possible.`, timeS > 0 ? budgetMs : 0, 0, 'divert-limited');
    }
    // Before PDI, pick the nearest alternate whose plane change fits the margin above descent plus reserve.
    if (beforePdi) {
      const choice = nearestAlternate(state, altitudeM, marginMs);
      if (choice) return result('retarget', `Retarget to ${choice.alternate.name ?? choice.alternate.id ?? 'the nearest alternate'} because its plane change preserves the reserve.`, choice.dvCostMs, 0, `retarget:${choice.alternate.id ?? 'alternate'}`);
      return result('hold', 'Wait for the next orbital-plane window because no alternate fits the available fuel margin.', 0, nextWindowS, 'site-hold');
    }
    return result('continue', 'Touchdown is complete, so an airborne site change is no longer available.');
  }

  if (eventId === 'mmod-strike') {
    // Any impact anomaly enters safe mode first, then holds for diagnosis; coast/surface has no orbital retry.
    return result('safe-mode', 'Enter safe mode to diagnose the impact anomaly, then hold until the vehicle is cleared to resume.', 0,
      phase === 'coast' || landed || descending ? 0 : periodS, 'safe-mode-then-hold');
  }

  if (eventId === 'debris-conjunction') {
    // A miss below the assumed threshold prompts an approximate avoidance impulse; larger misses are monitored.
    if (nonnegative(state.conjunctionMissKm, 0) < CONJUNCTION_TRIGGER_KM) return result('avoidance-manoeuvre', 'Apply a small avoidance burn because the predicted miss distance is below one kilometre.', AVOIDANCE_DV_MS);
    return result('continue', 'The predicted miss distance meets the screening threshold, so continue monitoring the conjunction.');
  }

  if (eventId === 'illumination-no-go') {
    // Visibility is a pre-PDI gate: choose a lit alternate or wait for the next plane window.
    if (!beforePdi) return result('continue', 'The landing is already committed, so complete the current autonomous trajectory.');
    // If fuel telemetry is supplied, enforce its reserve margin; otherwise quote the lit alternate's cost only.
    const choice = nearestAlternate(state, altitudeM, Number.isFinite(state.dvRemainingMs) ? marginMs : Infinity, true);
    if (choice) return result('retarget', `Retarget to ${choice.alternate.name ?? choice.alternate.id ?? 'the illuminated alternate'} because it passes the alternate visibility check.`, choice.dvCostMs, 0, `retarget:${choice.alternate.id ?? 'alternate'}`);
    return result('hold', 'Wait for the next orbital-plane window because the landing visibility check has no usable alternate.', 0, nextWindowS, 'visibility-hold');
  }

  return result('continue', 'No recognised contingency requires a change to the current plan.');
}

// Per-event critical-phase preference; callers may supply phase IDs or mission phase objects with an id.
const CRITICAL_PHASES = {
  spe: ['braking', 'coast', 'doi'], 'cme-warning': ['doi', 'loiter'], 'comms-loss': ['doi', 'braking'],
  'engine-underperformance': ['braking', 'approach'], 'site-hazard': ['approach', 'doi'],
  'mmod-strike': ['braking', 'coast'], 'debris-conjunction': ['llo', 'leo'], 'illumination-no-go': ['doi', 'loiter'],
};

export function planBranches({ phases = [], state = {} } = {}) {
  const ids = phases.map((phase) => typeof phase === 'string' ? phase : phase.id);
  return EVENTS.flatMap((event) => {
    const phase = [...CRITICAL_PHASES[event.id], ...event.phases].find((id) => ids.includes(id) && event.phases.includes(id));
    // A current post-PDI timestamp must not turn a hypothetical pre-PDI branch into committed descent.
    const tSincePdiS = DESCENT_PHASES.includes(phase) ? state.tSincePdiS : 0;
    return phase ? [{ eventId: event.id, phase, ...decide(event.id, { ...state, phase, tSincePdiS }) }] : [];
  });
}
