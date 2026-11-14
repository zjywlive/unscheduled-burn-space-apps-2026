// MCI axes coincide with Moon-fixed axes at epochMs; all accelerations are km/s².
import { MU_MOON, J2_MOON, C22_MOON, R_MOON_GRAV, MOON_RATE, MU_EARTH, MU_SUN, AU_KM } from './constants.js';
import { inertialToFixed } from '../relay.js';
import { stateToElements } from './orbits.js';

export function fixedToInertial(v, tMs, epochMs) {
  const theta = MOON_RATE * (tMs - epochMs) / 1000;
  const c = Math.cos(theta), s = Math.sin(theta);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}

export function accelPointMass(mu, r) {
  const f = -mu / Math.hypot(...r) ** 3;
  return [f * r[0], f * r[1], f * r[2]];
}

// J2 correction only; add the point-mass term separately.
export function accelJ2(mu, j2, rRefKm, r) {
  const radiusKm = Math.hypot(...r), z2 = r[2] ** 2 / radiusKm ** 2;
  const f = -1.5 * j2 * mu * rRefKm ** 2 / radiusKm ** 5;
  return [f * r[0] * (1 - 5 * z2), f * r[1] * (1 - 5 * z2), f * r[2] * (3 - 5 * z2)];
}

// Gradient of positive U = 3 mu R² C22 (x²-y²)/r⁵. For C22 > 0 the +x-axis correction
// is INWARD (-9 mu R² C22 / x⁴); the +y-axis correction is outward.
export function accelC22Fixed(mu, c22, rRefKm, rFixed) {
  const [x, y, z] = rFixed, radiusKm = Math.hypot(x, y, z);
  const f = 3 * mu * rRefKm ** 2 * c22 / radiusKm ** 5;
  const q = 5 * (x * x - y * y) / radiusKm ** 2;
  return [f * x * (2 - q), f * y * (-2 - q), -f * z * q];
}

export function accelThirdBody(muBody, r, rBody) {
  const d = rBody.map((x, k) => x - r[k]);
  const f = muBody / Math.hypot(...d) ** 3, f0 = muBody / Math.hypot(...rBody) ** 3;
  return d.map((x, k) => f * x - f0 * rBody[k]);
}

// Generic RK4: t and h share the derivative's time unit; preserves Array/Float64Array type.
export function rk4Step(deriv, t, y, h) {
  const k1 = deriv(t, y);
  const k2 = deriv(t + h / 2, y.map((x, k) => x + h * k1[k] / 2));
  const k3 = deriv(t + h / 2, y.map((x, k) => x + h * k2[k] / 2));
  const k4 = deriv(t + h, y.map((x, k) => x + h * k3[k]));
  return y.map((x, k) => x + h * (k1[k] + 2 * k2[k] + 2 * k3[k] + k4[k]) / 6);
}

export function createForceModel({ eph = null, epochMs, j2 = true, c22 = true, earth = true, sun = true }) {
  if (!Number.isFinite(epochMs)) throw new RangeError('epochMs must be finite.');
  function accel(tMs, r) {
    const a = accelPointMass(MU_MOON, r);
    const add = (term) => { for (let k = 0; k < 3; k++) a[k] += term[k]; };
    if (j2) add(accelJ2(MU_MOON, J2_MOON, R_MOON_GRAV, r));
    if (c22) {
      const fixed = inertialToFixed(r, tMs, epochMs);
      add(fixedToInertial(accelC22Fixed(MU_MOON, C22_MOON, R_MOON_GRAV, fixed), tMs, epochMs));
    }
    const bodies = eph && (earth || sun) ? eph.at(tMs) : null;
    if (bodies) {
      if (earth) add(accelThirdBody(MU_EARTH, r, fixedToInertial(bodies.earth.map((x) => x * bodies.earthRangeKm), tMs, epochMs)));
      if (sun) add(accelThirdBody(MU_SUN, r, fixedToInertial(bodies.sun.map((x) => x * AU_KM), tMs, epochMs)));
    }
    return a;
  }
  return { accel };
}

// 30 s default integration step: assumed numerical setting, not an accuracy guarantee.
// Includes both endpoints. Off-grid samples use a partial RK4 step without changing the fixed-step trajectory.
export function propagate({ r0, v0, t0Ms, durationS, stepS = 30, model, sampleEveryS = stepS }) {
  if (!Number.isFinite(t0Ms) || !Number.isFinite(durationS) || durationS < 0) throw new RangeError('Invalid propagation time.');
  if (![stepS, sampleEveryS].every((x) => Number.isFinite(x) && x > 0)) throw new RangeError('Steps must be finite and positive.');
  if (r0.length !== 3 || v0.length !== 3 || ![...r0, ...v0].every(Number.isFinite)) throw new RangeError('State must contain six finite components.');
  let y = new Float64Array([...r0, ...v0]), tS = 0, stepIndex = 1, sampleIndex = 1;
  const samples = [];
  const sample = (atS, state) => samples.push({ tMs: t0Ms + atS * 1000, r: Array.from(state.slice(0, 3)), v: Array.from(state.slice(3, 6)) });
  const deriv = (atS, state) => {
    const a = model.accel(t0Ms + atS * 1000, state.subarray(0, 3));
    return [state[3], state[4], state[5], a[0], a[1], a[2]];
  };
  sample(0, y);
  while (tS < durationS) {
    const endS = Math.min(stepIndex++ * stepS, durationS);
    const next = rk4Step(deriv, tS, y, endS - tS);
    while (sampleIndex * sampleEveryS <= endS) {
      const atS = sampleIndex++ * sampleEveryS;
      sample(atS, atS === endS ? next : rk4Step(deriv, tS, y, atS - tS));
    }
    y = next;
    tS = endS;
  }
  if (samples[samples.length - 1].tMs !== t0Ms + durationS * 1000) sample(durationS, y);
  return samples;
}

// Least-squares slopes of unwrapped osculating angles, rad/s. Sample often enough that each
// angular increment is < pi. Argument of periapsis has no physical meaning for a circular orbit.
export function meanElementsDrift(samples, mu) {
  if (samples.length < 2) throw new RangeError('At least two samples are required.');
  const times = samples.map((s) => (s.tMs - samples[0].tMs) / 1000);
  const elements = samples.map((s) => stateToElements(mu, s.r, s.v));
  const meanS = times.reduce((sum, t) => sum + t, 0) / times.length;
  const denominator = times.reduce((sum, t) => sum + (t - meanS) ** 2, 0);
  if (!(denominator > 0)) throw new RangeError('Sample times must span a nonzero interval.');
  function slope(key) {
    const angles = [elements[0][key]];
    for (let k = 1; k < elements.length; k++) {
      const delta = elements[k][key] - elements[k - 1][key];
      angles.push(angles[k - 1] + Math.atan2(Math.sin(delta), Math.cos(delta)));
    }
    const meanRad = angles.reduce((sum, a) => sum + a, 0) / angles.length;
    return times.reduce((sum, t, k) => sum + (t - meanS) * (angles[k] - meanRad), 0) / denominator;
  }
  return { raanRateRadS: slope('raanRad'), argpRateRadS: slope('argpRad') };
}
