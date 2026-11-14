// Ideal Tsiolkovsky rocket equation; constant vacuum Isp and thrust, no gravity/steering losses.
import { G0 } from './constants.js';

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive.`);
}

function exponent(dvMs, ispS) {
  positive(ispS, 'ispS');
  if (!Number.isFinite(dvMs) || dvMs < 0) throw new RangeError('dvMs must be finite and nonnegative.');
  return dvMs / (ispS * G0);
}

export function massRatio(dvMs, ispS) {
  return Math.exp(exponent(dvMs, ispS));
}

export function finalMassKg(m0Kg, dvMs, ispS) {
  positive(m0Kg, 'm0Kg');
  return m0Kg * Math.exp(-exponent(dvMs, ispS));
}

export function propellantForDvKg(m0Kg, dvMs, ispS) {
  positive(m0Kg, 'm0Kg');
  return -m0Kg * Math.expm1(-exponent(dvMs, ispS));
}

export function dvForPropellantMs(m0Kg, mpKg, ispS) {
  positive(m0Kg, 'm0Kg');
  positive(ispS, 'ispS');
  if (!Number.isFinite(mpKg) || mpKg < 0 || mpKg >= m0Kg) throw new RangeError('mpKg must be in [0, m0Kg).');
  return -ispS * G0 * Math.log1p(-mpKg / m0Kg);
}

export function burnTimeS(m0Kg, dvMs, ispS, thrustN) {
  positive(thrustN, 'thrustN');
  return propellantForDvKg(m0Kg, dvMs, ispS) * ispS * G0 / thrustN;
}
