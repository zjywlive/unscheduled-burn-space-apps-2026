// Point-mass powered descent in the Moon-centred, non-rotating PD frame: metres, seconds, kg.
// Moon rotation is ignored over the ~12 min descent: < 0.5 m/s at 85 deg S.
// Guidance structure: Klumpp (1974), "Apollo lunar descent guidance", Automatica 10.
// Gate values, gains and manoeuvre timings below are assumed for this generic vehicle, not Apollo data.
// Approach boundaries respect the throttle floor; abort steering regulates climb while building orbital speed.
import { MU_MOON, R_MOON, DEG } from './constants.js';
import { cleanVehicle, wetMassKg, exhaustVelocityMs } from './vehicle.js';

export const DESCENT_DEFAULTS = Object.freeze({
  massKg: null,               // assumed: null means wet mass after the pre-PDI delta-v below
  lloAltKm: 100,              // assumed lunar parking-orbit altitude
  pdiAltKm: 15,               // assumed descent-orbit perilune altitude above the site sphere
  siteHeightKm: 0,            // assumed site elevation above the shared mean lunar radius
  approachRangeM: 3000,       // assumed (kinematically consistent with the throttle floor; Apollo P64 used a similar high gate near 2 km)
  approachS: 85,              // assumed (kinematically consistent with the throttle floor; Apollo P64 used a similar high gate near 2 km)
  divert: null,               // assumed no hazard; optional { atS, crossrangeM, downrangeM }
  abortAtS: null,             // assumed no abort; optional absolute time since PDI, during braking
  coastAfterAbortS: 1200,     // assumed drawing interval after orbit insertion
  thrustScale: 1,             // assumed nominal engine performance
  hoverS: 0,                  // assumed no hover; positive duration holds at 10 m
  dtS: 0.2,                  // assumed RK4 integration step; output also at each whole second
});

const PD_MU_M3_S2 = MU_MOON * 1e9; // km³ → m³, unit conversion
const PD_PRE_PDI_DV_MS = 880;       // assumed LOI + descent-orbit insertion expenditure
const PD_HIGH_M = 2000;            // assumed (kinematically consistent with the throttle floor; Apollo P64 used a similar high gate near 2 km)
const PD_HIGH_H_MS = 70;           // assumed (kinematically consistent with the throttle floor; Apollo P64 used a similar high gate near 2 km)
const PD_HIGH_V_MS = -45;          // assumed (kinematically consistent with the throttle floor; Apollo P64 used a similar high gate near 2 km)
const PD_LOW_M = 30;               // assumed low-gate altitude
const PD_LOW_H_MS = 0.5;           // assumed low-gate downrange speed
const PD_LOW_V_MS = -1.5;          // assumed low-gate vertical speed
const PD_TERMINAL_V_MS = -1;       // assumed terminal descent speed
const PD_HOVER_M = 10;             // assumed hover altitude
const PD_ABORT_PERI_KM = 15;       // assumed minimum recovered-orbit perilune
const PD_ABORT_APO_KM = 30;        // assumed minimum recovered-orbit apolune
const PD_ABORT_CLIMB_MS = 15;      // assumed desired climb below the minimum recovered-orbit altitude; zero above
const PD_ABORT_VERTICAL_KD_S = 0.05; // assumed abort vertical-speed gain, s^-1
const PD_ABORT_UP_MIN = -0.2;      // assumed minimum radial fraction of abort thrust
const PD_ABORT_UP_MAX = 0.7;       // assumed maximum radial fraction of abort thrust
const PD_BRAKE_MARGIN = 0.925;     // assumed 7.5% peak-thrust planning margin
const PD_MAX_BRAKE_S = 1800;       // assumed planning search horizon for an underpowered vehicle
const PD_MAX_POWERED_S = 7200;     // assumed finite stop for infeasible guidance cases
const PD_DIVERT_EXTENSION_S = 30; // assumed maximum extra approach time after a hazard divert
const PD_TGO_FLOOR_S = 0.5;       // assumed final guidance regularisation interval
const PD_HORIZONTAL_KP_S2 = 0.08; // assumed terminal horizontal position gain, s^-2
const PD_HORIZONTAL_KD_S = 0.6;   // assumed terminal horizontal velocity gain, s^-1
const PD_VERTICAL_KD_S = 0.8;     // assumed terminal vertical velocity gain, s^-1
const PD_HOVER_KP_S2 = 0.4;       // assumed hover altitude gain, s^-2

const pdDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const pdNorm = (a) => Math.hypot(...a);
const pdScale = (a, k) => a.map((x) => x * k);
const pdAdd = (a, b) => a.map((x, i) => x + b[i]);
const pdSub = (a, b) => a.map((x, i) => x - b[i]);
const pdCross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const pdUnit = (a) => pdScale(a, 1 / pdNorm(a));
const pdClamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function pdFrame(state, radiusM) {
  const r = state.slice(0, 3), v = state.slice(3, 6);
  const radius = pdNorm(r), up = pdScale(r, 1 / radius);
  const vUp = pdDot(v, up), horizontal = pdSub(v, pdScale(up, vUp));
  const hSpeed = pdNorm(horizontal);
  const forward = hSpeed > 1e-9 ? pdScale(horizontal, 1 / hSpeed) : pdUnit([up[2], 0, -up[0]]);
  return { r, v, radius, up, forward, right: pdCross(up, forward), hSpeed, vUp, altM: radius - radiusM };
}

function pdGround(r, radiusM) {
  const up = pdUnit(r);
  return {
    downrangeM: radiusM * Math.atan2(up[0], up[2]),
    crossrangeM: radiusM * Math.asin(pdClamp(up[1], -1, 1)),
  };
}

function pdSurfaceOffset(r, forward, right, downrangeM, crossrangeM, radiusM) {
  const offset = pdAdd(pdScale(forward, downrangeM), pdScale(right, crossrangeM));
  const distanceM = pdNorm(offset), up = pdUnit(r);
  if (!distanceM) return pdScale(up, radiusM);
  const angle = distanceM / radiusM;
  return pdScale(pdAdd(pdScale(up, Math.cos(angle)), pdScale(offset, Math.sin(angle) / distanceM)), radiusM);
}

// A cubic altitude / linear horizontal-speed preview supplies the bisection's peak thrust.
// Its spherical gravity and centrifugal compensation match the feedback law; mass follows mdot = -T/ve.
function pdBrakeDuration(initial, radiusM, engineN, vehicle, veMs) {
  const h0 = initial[2] - radiusM, speed0 = initial[3], mass0 = initial[6];
  const limitN = engineN * vehicle.throttleMax * PD_BRAKE_MARGIN;
  function peakN(durationS) {
    const a = 3 * (PD_HIGH_M - h0) / durationS ** 2 - PD_HIGH_V_MS / durationS;
    const b = -2 * (PD_HIGH_M - h0) / durationS ** 3 + PD_HIGH_V_MS / durationS ** 2;
    const ax = (PD_HIGH_H_MS - speed0) / durationS;
    let massKg = mass0, peak = 0;
    const count = 128; // numerical preview quadrature resolution, not a physical parameter
    for (let i = 0; i <= count; i++) {
      const t = durationS * i / count, radius = radiusM + h0 + a * t * t + b * t ** 3;
      const vx = speed0 + ax * t;
      const az = 2 * a + 6 * b * t + PD_MU_M3_S2 / radius ** 2 - vx * vx / radius;
      const accel = Math.hypot(ax, az);
      peak = Math.max(peak, massKg * accel);
      massKg *= Math.exp(-Math.max(accel, engineN * vehicle.throttleMin / massKg) * durationS / count / veMs);
    }
    return peak;
  }
  let lo = PD_TGO_FLOOR_S, hi = PD_MAX_BRAKE_S;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (peakN(mid) > limitN) lo = mid;
    else hi = mid;
  }
  return hi;
}

function pdOrbit(state) {
  const r = state.slice(0, 3), v = state.slice(3, 6), radius = pdNorm(r);
  const angularMomentum = pdCross(r, v), h2 = pdDot(angularMomentum, angularMomentum);
  const energy = pdDot(v, v) / 2 - PD_MU_M3_S2 / radius;
  const e = Math.sqrt(Math.max(0, 1 + 2 * energy * h2 / PD_MU_M3_S2 ** 2));
  return {
    periAltKm: h2 / PD_MU_M3_S2 / (1 + e) / 1000 - R_MOON,
    apoAltKm: energy < 0 ? -PD_MU_M3_S2 / (2 * energy) * (1 + e) / 1000 - R_MOON : Infinity,
  };
}

// State = [r (m), v (m/s), mass (kg), integrated thrust delta-v (m/s)].
function pdRK4(state, tS, stepS, derivative) {
  const k1 = derivative(state, tS);
  const k2 = derivative(state.map((x, i) => x + stepS * k1[i] / 2), tS + stepS / 2);
  const k3 = derivative(state.map((x, i) => x + stepS * k2[i] / 2), tS + stepS / 2);
  const k4 = derivative(state.map((x, i) => x + stepS * k3[i]), tS + stepS);
  return state.map((x, i) => x + stepS * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) / 6);
}

/** Pure PD-frame descent simulation. r/site.r are metres; v is m/s; throttle is engine command fraction. */
export function simulateDescent(vehicle, opts = {}) {
  const craft = cleanVehicle(vehicle);
  const o = { ...DESCENT_DEFAULTS, ...opts };
  for (const key of ['lloAltKm', 'pdiAltKm', 'siteHeightKm', 'approachRangeM', 'approachS', 'coastAfterAbortS', 'thrustScale', 'hoverS', 'dtS']) {
    if (!Number.isFinite(o[key])) throw new RangeError(`${key} must be finite`);
  }
  if (o.dtS <= 0 || o.approachS <= 0 || o.thrustScale <= 0 || o.pdiAltKm <= 0 || o.lloAltKm < o.pdiAltKm || o.hoverS < 0 || o.coastAfterAbortS < 0) {
    throw new RangeError('Invalid descent duration, orbit, or thrust scale');
  }
  if (o.abortAtS != null && (!Number.isFinite(o.abortAtS) || o.abortAtS < 0)) throw new RangeError('abortAtS must be nonnegative');
  const divert = o.divert && { atS: o.divert.atS, crossrangeM: o.divert.crossrangeM ?? 0, downrangeM: o.divert.downrangeM ?? 0 };
  if (divert && (!Object.values(divert).every(Number.isFinite) || divert.atS < 0)) throw new RangeError('Invalid divert');
  const radiusM = (R_MOON + o.siteHeightKm) * 1000;
  if (radiusM <= 0) throw new RangeError('Site radius must be positive');
  const veMs = exhaustVelocityMs(craft), engineN = craft.mainThrustN * o.thrustScale;
  const mass0 = o.massKg ?? Math.max(craft.dryMassKg, wetMassKg(craft) * Math.exp(-PD_PRE_PDI_DV_MS / veMs));
  if (!Number.isFinite(mass0) || mass0 < craft.dryMassKg || mass0 > wetMassKg(craft)) throw new RangeError('massKg must lie between dry and wet mass');
  const rp = radiusM + o.pdiAltKm * 1000, ra = radiusM + o.lloAltKm * 1000;
  let state = [0, 0, rp, Math.sqrt(PD_MU_M3_S2 * (2 / rp - 2 / (rp + ra))), 0, 0, mass0, 0];
  const brakeEndS = pdBrakeDuration(state, radiusM, engineN, craft, veMs);
  let tS = 0, phase = 'braking', approachStartS = null, approachEndS = null;
  let hoverStartS = null, hoverDone = !o.hoverS, diverted = false, cutoffS = null;
  let touchdown = null, abortOrbit = null, propellantExhausted = mass0 <= craft.dryMassKg;
  // Before high gate (including abort-only runs), the provisional site is the PDI subpoint.
  let siteR = [0, 0, radiusM], siteForward = [1, 0, 0], siteRight = [0, 1, 0];
  const samples = [], events = [{ tS: 0, name: 'pdi' }];
  const event = (name) => events.push({ tS, name });

  function approachAccel(s, timeS, endS = approachEndS) {
    const remainingS = endS - timeS, tgo = Math.max(PD_TGO_FLOOR_S, remainingS);
    const up = pdUnit(siteR);
    const targetV = pdAdd(pdScale(siteForward, PD_LOW_H_MS), pdScale(up, PD_LOW_V_MS));
    // Extend the target at its specified velocity only inside the numerical tgo floor.
    // Otherwise a frozen position with clamped tgo would incorrectly drive the final velocity to zero.
    const targetR = pdAdd(pdScale(up, radiusM + PD_LOW_M), pdScale(targetV, tgo - remainingS));
    const r = s.slice(0, 3), v = s.slice(3, 6);
    const gravity = pdScale(r, -PD_MU_M3_S2 / pdNorm(r) ** 3);
    // Apollo quadratic acceleration law, target acceleration aT = 0 (assumed low-gate boundary).
    return pdSub(pdSub(pdScale(pdSub(targetR, r), 12 / tgo ** 2), pdScale(pdAdd(targetV, v), 6 / tgo)), gravity);
  }

  function control(s, timeS) {
    const f = pdFrame(s, radiusM), gravity = PD_MU_M3_S2 / f.radius ** 2;
    let accel;
    if (phase === 'abort') {
      const desiredVzMs = f.altM < PD_ABORT_PERI_KM * 1000 ? PD_ABORT_CLIMB_MS : 0;
      const aUp = PD_ABORT_VERTICAL_KD_S * (desiredVzMs - f.vUp) + gravity - f.hSpeed ** 2 / f.radius;
      const aThrust = engineN * craft.throttleMax / s[6];
      const g = Math.asin(pdClamp(aUp / aThrust, PD_ABORT_UP_MIN, PD_ABORT_UP_MAX));
      const dir = pdUnit(pdAdd(pdScale(f.forward, Math.cos(g)), pdScale(f.up, Math.sin(g))));
      return { dir, throttle: cutoffS == null && !propellantExhausted ? craft.throttleMax : 0 };
    }
    if (phase === 'braking') {
      const remainingS = brakeEndS - timeS, tgo = Math.max(PD_TGO_FLOOR_S, remainingS);
      const targetM = PD_HIGH_M + PD_HIGH_V_MS * (tgo - remainingS);
      const aUp = 6 * (targetM - f.altM - f.vUp * tgo) / tgo ** 2 - 2 * (PD_HIGH_V_MS - f.vUp) / tgo;
      const crossV = pdDot(f.v, f.right), crossM = s[1];
      const aRight = 6 * (-crossM - crossV * tgo) / tgo ** 2 + 2 * crossV / tgo;
      accel = pdAdd(pdAdd(pdScale(f.up, aUp + gravity - f.hSpeed ** 2 / f.radius), pdScale(f.forward, (PD_HIGH_H_MS - f.hSpeed) / tgo)), pdScale(f.right, aRight));
    } else if (phase === 'approach') {
      accel = approachAccel(s, timeS);
    } else {
      const error = pdSub(siteR, f.r), horizontalError = pdSub(error, pdScale(f.up, pdDot(error, f.up)));
      const horizontalV = pdSub(f.v, pdScale(f.up, f.vUp));
      const hover = hoverStartS != null && !hoverDone;
      const aUp = hover ? PD_HOVER_KP_S2 * (PD_HOVER_M - f.altM) - PD_VERTICAL_KD_S * f.vUp : PD_VERTICAL_KD_S * (PD_TERMINAL_V_MS - f.vUp);
      accel = pdAdd(pdSub(pdScale(horizontalError, PD_HORIZONTAL_KP_S2), pdScale(horizontalV, PD_HORIZONTAL_KD_S)), pdScale(f.up, aUp + gravity - f.hSpeed ** 2 / f.radius));
    }
    const magnitude = pdNorm(accel);
    return {
      dir: magnitude > 1e-12 ? pdScale(accel, 1 / magnitude) : f.up,
      // Saturation preserves the commanded thrust direction, including at the throttle floor.
      throttle: propellantExhausted ? 0 : pdClamp(magnitude * s[6] / engineN, craft.throttleMin, craft.throttleMax),
    };
  }

  function derivative(s, timeS) {
    const c = control(s, timeS), forceN = engineN * c.throttle;
    const gravity = -PD_MU_M3_S2 / Math.hypot(s[0], s[1], s[2]) ** 3;
    return [s[3], s[4], s[5], ...c.dir.map((d, i) => gravity * s[i] + forceN * d / s[6]), -forceN / veMs, forceN / s[6]];
  }

  function sample() {
    const f = pdFrame(state, radiusM), c = control(state, tS);
    const row = {
      tS, phase, r: f.r, v: f.v, massKg: state[6], throttle: c.throttle, thrustDir: c.dir,
      altM: touchdown ? 0 : f.altM, ...pdGround(f.r, radiusM), hSpeedMs: f.hSpeed, vSpeedMs: f.vUp,
      pitchDeg: Math.acos(pdClamp(pdDot(c.dir, f.up), -1, 1)) * DEG,
    };
    const last = samples.at(-1);
    if (last && Math.abs(last.tS - tS) < 1e-8 && last.phase === phase) samples[samples.length - 1] = row;
    else samples.push(row);
  }

  function moveSite(downrangeM, crossrangeM) {
    siteR = pdSurfaceOffset(siteR, siteForward, siteRight, downrangeM, crossrangeM, radiusM);
    const up = pdUnit(siteR);
    siteForward = pdUnit(pdSub(siteForward, pdScale(up, pdDot(siteForward, up))));
    siteRight = pdCross(up, siteForward);
  }

  sample();
  if (propellantExhausted) event('propellant-exhausted');
  while (!touchdown && !propellantExhausted && tS < PD_MAX_POWERED_S + (cutoffS == null ? 0 : o.coastAfterAbortS)) {
    if (phase === 'braking' && o.abortAtS != null && o.abortAtS <= brakeEndS && tS >= o.abortAtS - 1e-8) {
      sample(); phase = 'abort'; event('abort'); sample();
    } else if (phase === 'braking' && tS >= brakeEndS - 1e-8) {
      sample();
      const f = pdFrame(state, radiusM);
      siteR = pdScale(f.up, radiusM); siteForward = f.forward; siteRight = f.right;
      moveSite(o.approachRangeM, 0);
      phase = 'approach'; approachStartS = tS; approachEndS = tS + o.approachS;
      event('high-gate'); event('pitch-over'); sample();
    }
    if (phase === 'approach' && divert && !diverted && tS >= approachStartS + divert.atS - 1e-8 && tS <= approachEndS) {
      moveSite(divert.downrangeM, divert.crossrangeM); diverted = true;
      const maxN = engineN * craft.throttleMax;
      if (pdNorm(approachAccel(state, tS)) * state[6] > maxN) {
        // Search the bounded extension rather than assuming thrust demand is monotone in tgo.
        const originalEndS = approachEndS;
        let bestN = Infinity, bestEndS = originalEndS;
        for (let extraS = 0; extraS <= PD_DIVERT_EXTENSION_S; extraS++) {
          const forceN = pdNorm(approachAccel(state, tS, originalEndS + extraS)) * state[6];
          if (forceN < bestN) { bestN = forceN; bestEndS = originalEndS + extraS; }
          if (forceN <= maxN) break;
        }
        approachEndS = bestEndS;
      }
      event('hazard-divert'); sample();
    }
    if (phase === 'approach' && tS >= approachEndS - 1e-8) {
      sample(); phase = 'terminal'; event('low-gate'); sample();
    }
    if (phase === 'terminal' && !hoverDone) {
      if (hoverStartS == null && pdFrame(state, radiusM).altM <= PD_HOVER_M) { hoverStartS = tS; sample(); }
      if (hoverStartS != null && tS >= hoverStartS + o.hoverS - 1e-8) { hoverDone = true; sample(); }
    }
    if (phase === 'abort' && cutoffS == null) {
      const orbit = pdOrbit(state);
      // Roundoff tolerance is 10 micrometres, not an allowance for an unsafe orbit.
      if (orbit.periAltKm >= PD_ABORT_PERI_KM - 1e-8 && orbit.apoAltKm >= PD_ABORT_APO_KM - 1e-8 && Number.isFinite(orbit.apoAltKm)) {
        abortOrbit = orbit; cutoffS = tS; event('orbit-achieved'); sample();
      }
    }
    if (cutoffS != null && tS >= cutoffS + o.coastAfterAbortS - 1e-8) break;

    const nextSecondS = Math.floor(tS + 1e-8) + 1;
    let boundaryS = nextSecondS;
    if (phase === 'braking') boundaryS = Math.min(boundaryS, brakeEndS, o.abortAtS != null && o.abortAtS > tS ? o.abortAtS : Infinity);
    if (phase === 'approach') boundaryS = Math.min(boundaryS, approachEndS, divert && !diverted && approachStartS + divert.atS > tS ? approachStartS + divert.atS : Infinity);
    if (hoverStartS != null && !hoverDone) boundaryS = Math.min(boundaryS, hoverStartS + o.hoverS);
    if (cutoffS != null) boundaryS = Math.min(boundaryS, cutoffS + o.coastAfterAbortS);
    const fuelStepS = cutoffS == null ? (state[6] - craft.dryMassKg) * veMs / (engineN * craft.throttleMax) : Infinity;
    let stepS = Math.min(o.dtS, boundaryS - tS, fuelStepS);
    let next = pdRK4(state, tS, stepS, derivative);
    const hitsGround = Math.hypot(...next.slice(0, 3)) <= radiusM;
    const runsDry = next[6] <= craft.dryMassKg;
    if (hitsGround || runsDry) {
      // Locate the first contact / empty-tank crossing inside the RK4 step, without below-surface samples.
      let lo = 0, hi = stepS;
      for (let i = 0; i < 32; i++) {
        const mid = (lo + hi) / 2, trial = pdRK4(state, tS, mid, derivative);
        if (Math.hypot(...trial.slice(0, 3)) <= radiusM || trial[6] <= craft.dryMassKg) hi = mid;
        else lo = mid;
      }
      stepS = hi; next = pdRK4(state, tS, stepS, derivative);
    }
    state = next; tS += stepS;
    if (Math.abs(tS - boundaryS) < 1e-8) tS = boundaryS;
    if (state[6] <= craft.dryMassKg + 1e-9) {
      state[6] = craft.dryMassKg; propellantExhausted = true; event('propellant-exhausted');
    }
    if (Math.hypot(...state.slice(0, 3)) <= radiusM) {
      const f = pdFrame(state, radiusM), contact = pdScale(f.up, radiusM);
      state.splice(0, 3, ...contact);
      touchdown = {
        tS, vVertMs: f.vUp, vHorizMs: f.hSpeed,
        missM: radiusM * Math.atan2(pdNorm(pdCross(f.up, pdUnit(siteR))), pdDot(f.up, pdUnit(siteR))),
        ok: Math.abs(f.vUp) <= craft.touchdown.maxVerticalMs && f.hSpeed <= craft.touchdown.maxHorizontalMs,
      };
      event('touchdown');
    }
    if (touchdown || propellantExhausted || Math.abs(tS - nextSecondS) < 1e-8) sample();
  }
  if (!touchdown && !propellantExhausted && cutoffS == null) event('guidance-timeout');
  sample();
  return {
    samples, events, site: { r: [...siteR], ...pdGround(siteR, radiusM) }, touchdown,
    dvUsedMs: state[7], propellantUsedKg: mass0 - state[6], durationS: tS,
    groundRangeM: radiusM * Math.atan2(Math.hypot(state[0], state[1]), state[2]),
    propellantExhausted, abortOrbit,
  };
}

export function descentDvMs(vehicle, opts = {}) {
  return simulateDescent(vehicle, opts).dvUsedMs;
}
