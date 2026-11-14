// Lander operations: +Z is engine thrust, fixed array normal is +X, and array tracking rotates about Z.
// Assumed: free roll during burns, an unconstraining two-axis antenna gimbal, ideal battery efficiency.
import { AU_KM, RAD, R_MOON } from './constants.js';

export const ATTITUDE_MODES = Object.freeze({
  'sun-point': 'Point the array normal at the Sun during unpowered flight.',
  burn: 'Align body Z with thrust and roll to maximise array illumination.',
  descent: 'Follow the descent thrust direction and optimise array illumination with free roll.',
  surface: 'Stand upright with fixed panel azimuth or one-axis tracking about local up.',
  safe: 'Point the array at the Sun while running only survival loads.',
});

const PHASE_ATTITUDES = {
  leo: 'sun-point', coast: 'sun-point', llo: 'sun-point', loiter: 'sun-point',
  tli: 'burn', tcm: 'burn', loi: 'burn', doi: 'burn', braking: 'burn',
  approach: 'descent', terminal: 'descent', landed: 'surface', safe: 'safe', hold: 'safe',
};
const clampUnit = (value) => Math.max(0, Math.min(1, value));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const signedCos = (a, b) => Math.max(-1, Math.min(1, dot(a, b)));

export function attitudeForPhase(phaseId) {
  return Object.hasOwn(PHASE_ATTITUDES, phaseId) ? PHASE_ATTITUDES[phaseId] : 'safe';
}

// Directions are unit vectors in one caller-selected frame; surface azimuths share its local azimuth origin.
// Incidence alone does not include the horizon or eclipses: pass lit=false to arrayPowerW/powerAt for darkness.
// If elevation is omitted, sunDir and up supply it; fixed arrays still require a Sun azimuth.
// Assumed default panel azimuth is 0 degrees in that caller-defined local frame.
export function arrayFactor(mode, { sunDir, burnDir, up, panelAzDeg = 0, sunAzDeg, sunElDeg, tracking = 'fixed' } = {}) {
  if (mode === 'sun-point' || mode === 'safe') return 1;
  if (mode === 'burn' || mode === 'descent') {
    if (!sunDir || !burnDir) return 0;
    return Math.sqrt(Math.max(0, 1 - signedCos(sunDir, burnDir) ** 2));
  }
  if (mode === 'surface') {
    const horizontal = Number.isFinite(sunElDeg) ? Math.max(0, Math.cos(sunElDeg * RAD))
      : sunDir && up ? Math.sqrt(Math.max(0, 1 - signedCos(sunDir, up) ** 2)) : 0;
    if (tracking === 'one-axis') return clampUnit(horizontal);
    return Number.isFinite(sunAzDeg) ? clampUnit(horizontal * Math.cos((sunAzDeg - panelAzDeg) * RAD)) : 0;
  }
  throw new RangeError(`Unknown attitude mode: ${mode}`);
}

// Parallel solar rays, no penumbra; rSc and bodyCentre are positions in km, sunDir points toward the Sun.
export function inShadow(rSc, sunDir, bodyCentre, bodyRadiusKm) {
  const relative = rSc.map((value, i) => value - bodyCentre[i]);
  const along = dot(relative, sunDir);
  const perpendicularKm = Math.hypot(...relative.map((value, i) => value - along * sunDir[i]));
  return along < 0 && perpendicularKm < bodyRadiusKm;
}

export function betaAngleRad(orbitNormal, sunDir) {
  return Math.asin(signedCos(orbitNormal, sunDir));
}

// Circular orbit, cylindrical shadow; Wertz & Larson, Space Mission Analysis and Design (standard geometry).
export function eclipseFraction(betaRad, altKm, bodyRadiusKm = R_MOON) {
  if (!Number.isFinite(betaRad) || !Number.isFinite(altKm) || altKm < 0 || !(bodyRadiusKm > 0) || !Number.isFinite(bodyRadiusKm)) {
    throw new RangeError('Eclipse geometry requires finite beta, nonnegative altitude, and positive radius');
  }
  const radiusKm = bodyRadiusKm + altKm;
  if (Math.abs(betaRad) >= Math.asin(bodyRadiusKm / radiusKm)) return 0;
  const ratio = Math.sqrt(altKm * (altKm + 2 * bodyRadiusKm)) / (radiusKm * Math.cos(betaRad));
  return Math.acos(clampUnit(ratio)) / Math.PI;
}

export function arrayPowerW(vehicle, factor, { sunDistanceKm = AU_KM, lit = true, degradation = 1 } = {}) {
  if (!lit) return 0;
  if (!(sunDistanceKm > 0) || !Number.isFinite(sunDistanceKm) || !Number.isFinite(factor) || !Number.isFinite(degradation)) {
    throw new RangeError('Array power requires finite incidence, degradation, and positive Sun distance');
  }
  return vehicle.arrayPowerW * clampUnit(factor) * (AU_KM / sunDistanceKm) ** 2 * clampUnit(degradation);
}

// soc[0] is initial SOC; soc[k+1] is after steps[k]; firstBelowIndex indexes soc, or -1 if never below minimum.
// Wh = W * seconds / 3600 (unit conversion). A zero-capacity battery has SOC=0 even when loads are solar-powered.
export function simulateBattery(steps, vehicle, { initialSoc = 1 } = {}) {
  if (!Number.isFinite(initialSoc)) throw new RangeError('Initial SOC must be finite');
  const soc = [vehicle.batteryWh > 0 ? clampUnit(initialSoc) : 0];
  let minSoc = soc[0], firstBelowIndex = soc[0] < vehicle.batteryMinSoc ? 0 : -1;
  for (const { dtS, generationW, loadW } of steps) {
    if (![dtS, generationW, loadW].every((value) => Number.isFinite(value) && value >= 0)) {
      throw new RangeError('Battery steps require nonnegative finite dtS, generationW, and loadW');
    }
    const next = vehicle.batteryWh > 0
      ? clampUnit(soc[soc.length - 1] + (generationW - loadW) * dtS / (3600 * vehicle.batteryWh)) : 0;
    soc.push(next);
    minSoc = Math.min(minSoc, next);
    if (firstBelowIndex === -1 && next < vehicle.batteryMinSoc) firstBelowIndex = soc.length - 1;
  }
  return { soc, minSoc, endSoc: soc[soc.length - 1], belowMin: firstBelowIndex !== -1, firstBelowIndex };
}

export function powerAt(vehicle, mode, geometry = {}) {
  const factor = arrayFactor(mode, { tracking: vehicle.arrayTracking, ...geometry });
  const generationW = arrayPowerW(vehicle, factor, geometry);
  const loadMode = mode === 'sun-point' ? (geometry.inLunarOrbit ? 'orbit' : 'cruise') : mode === 'burn' ? 'orbit' : mode;
  const loadW = vehicle.loadsW[loadMode];
  return { factor, generationW, loadW, netW: generationW - loadW };
}
