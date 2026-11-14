// Keplerian conics and first-order secular J2 rates. Distances km, time s, angles rad, mu km³/s².
import { MU_EARTH, R_EARTH, EARTH_MOON_MEAN_KM } from './constants.js';

const TAU = 2 * Math.PI;
const EPS = 1e-12; // Numerical tolerance for circular/equatorial singularities, not a physical constant.
const wrap = (angle) => ((angle % TAU) + TAU) % TAU;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => Math.hypot(...v);

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive.`);
}

function ellipse(aKm, e) {
  positive(aKm, 'aKm');
  if (!Number.isFinite(e) || e < 0 || e >= 1) throw new RangeError('An ellipse requires 0 <= e < 1.');
}

export function circularSpeed(mu, rKm) {
  positive(mu, 'mu');
  positive(rKm, 'rKm');
  return Math.sqrt(mu / rKm);
}

export function visViva(mu, rKm, aKm) {
  positive(mu, 'mu');
  positive(rKm, 'rKm');
  return Math.sqrt(mu * (2 / rKm - 1 / aKm));
}

export function periodS(mu, aKm) {
  positive(mu, 'mu');
  positive(aKm, 'aKm');
  return TAU * Math.sqrt(aKm ** 3 / mu);
}

export function ellipseFromApsides(mu, rpKm, raKm) {
  positive(rpKm, 'rpKm');
  if (!Number.isFinite(raKm) || raKm < rpKm) throw new RangeError('raKm must be finite and >= rpKm.');
  const aKm = (rpKm + raKm) / 2;
  return { aKm, e: (raKm - rpKm) / (raKm + rpKm), vpKms: visViva(mu, rpKm, aKm), vaKms: visViva(mu, raKm, aKm), periodS: periodS(mu, aKm) };
}

// Outbound crossing only. A circular orbit has no unique crossing; use nu = 0 at its radius.
export function trueAnomalyAtRadius(aKm, e, rKm) {
  ellipse(aKm, e);
  if (!Number.isFinite(rKm) || rKm <= 0) return NaN;
  const rpKm = aKm * (1 - e), raKm = aKm * (1 + e);
  const tolKm = 16 * Number.EPSILON * raKm;
  if (rKm < rpKm - tolKm || rKm > raKm + tolKm) return NaN;
  if (e === 0 || Math.abs(rKm - rpKm) <= tolKm) return 0;
  if (Math.abs(rKm - raKm) <= tolKm) return Math.PI;
  return Math.acos(Math.max(-1, Math.min(1, (aKm * (1 - e * e) / rKm - 1) / e)));
}

// Time since the preceding periapsis, in [0, period); a full revolution wraps to zero.
export function timeFromPeriapsisS(mu, aKm, e, nuRad) {
  ellipse(aKm, e);
  positive(mu, 'mu');
  const nu = wrap(nuRad);
  const eccentricRad = wrap(Math.atan2(Math.sqrt(1 - e * e) * Math.sin(nu), e + Math.cos(nu)));
  return (eccentricRad - e * Math.sin(eccentricRad)) * Math.sqrt(aKm ** 3 / mu);
}

// Signed tangential impulses: raising orbits is prograde (+), lowering is retrograde (-).
export function hohmann(mu, r1Km, r2Km) {
  const aKm = (r1Km + r2Km) / 2;
  return { dv1Kms: visViva(mu, r1Km, aKm) - circularSpeed(mu, r1Km), dv2Kms: circularSpeed(mu, r2Km) - visViva(mu, r2Km, aKm), tofS: periodS(mu, aKm) / 2 };
}

// 185 km parking altitude: assumed Apollo-like scenario; target defaults to NASA mean Earth–Moon distance.
export function tliFromLeo({ leoAltKm = 185, targetRadiusKm = EARTH_MOON_MEAN_KM, apogeeKm = targetRadiusKm } = {}) {
  const rpKm = R_EARTH + leoAltKm;
  const { aKm, e, vpKms } = ellipseFromApsides(MU_EARTH, rpKm, apogeeKm);
  const vCircKms = circularSpeed(MU_EARTH, rpKm);
  const nuRad = trueAnomalyAtRadius(aKm, e, targetRadiusKm);
  if (!Number.isFinite(nuRad)) throw new RangeError('targetRadiusKm is outside the transfer ellipse.');
  return { dvMs: (vpKms - vCircKms) * 1000, vCircKms, vPerigeeKms: vpKms, tofS: timeFromPeriapsisS(MU_EARTH, aKm, e, nuRad), aKm, e };
}

export function hyperbolicPeriapsisSpeed(mu, vInfKms, rpKm) {
  positive(mu, 'mu');
  positive(rpKm, 'rpKm');
  if (!Number.isFinite(vInfKms) || vInfKms < 0) throw new RangeError('vInfKms must be finite and nonnegative.');
  return Math.sqrt(vInfKms * vInfKms + 2 * mu / rpKm);
}

export function captureDvMs(mu, vInfKms, rpKm, raKm = rpKm) {
  return 1000 * (hyperbolicPeriapsisSpeed(mu, vInfKms, rpKm) - ellipseFromApsides(mu, rpKm, raKm).vpKms);
}

export function planeChangeDvMs(vKms, dIncRad) {
  return 2000 * Math.abs(vKms * Math.sin(dIncRad / 2));
}

export function j2NodeRate(mu, j2, rRefKm, aKm, e, iRad) {
  const pKm = aKm * (1 - e * e);
  return -1.5 * Math.sqrt(mu / aKm ** 3) * j2 * (rRefKm / pKm) ** 2 * Math.cos(iRad);
}

export function j2ArgpRate(mu, j2, rRefKm, aKm, e, iRad) {
  const pKm = aKm * (1 - e * e);
  return 0.75 * Math.sqrt(mu / aKm ** 3) * j2 * (rRefKm / pKm) ** 2 * (5 * Math.cos(iRad) ** 2 - 1);
}

export function elementsToState(mu, { aKm, e = 0, iRad = 0, raanRad = 0, argpRad = 0, nuRad = 0 }) {
  positive(mu, 'mu');
  const pKm = aKm * (1 - e * e);
  positive(pKm, 'semilatus rectum');
  if (![aKm, e, iRad, raanRad, argpRad, nuRad].every(Number.isFinite) || e < 0) throw new RangeError('Invalid orbital elements.');
  const cO = Math.cos(raanRad), sO = Math.sin(raanRad), ci = Math.cos(iRad), si = Math.sin(iRad);
  const cw = Math.cos(argpRad), sw = Math.sin(argpRad), cn = Math.cos(nuRad), sn = Math.sin(nuRad);
  const P = [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si];
  const Q = [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si];
  const radiusKm = pKm / (1 + e * cn), speedKms = Math.sqrt(mu / pKm);
  positive(radiusKm, 'radiusKm');
  return { r: P.map((p, k) => radiusKm * (cn * p + sn * Q[k])), v: P.map((p, k) => speedKms * (-sn * p + (e + cn) * Q[k])) };
}

// Circular: argp = 0 and nu = argument of latitude. Equatorial: RAAN = 0 and argp is
// measured from +x in the direction of motion (also works for retrograde equatorial orbits).
export function stateToElements(mu, r, v) {
  positive(mu, 'mu');
  const rKm = norm(r), v2 = dot(v, v), h = cross(r, v), hNorm = norm(h);
  positive(rKm, '|r|');
  positive(hNorm, '|r x v|');
  const normal = h.map((x) => x / hNorm), n = [-h[1], h[0], 0], nNorm = norm(n);
  const rv = dot(r, v);
  const eVec = r.map((x, k) => ((v2 - mu / rKm) * x - rv * v[k]) / mu);
  const eRaw = norm(eVec), e = eRaw < EPS ? 0 : eRaw;
  const aKm = 1 / (2 / rKm - v2 / mu), pKm = hNorm * hNorm / mu;
  const iRad = Math.atan2(nNorm, h[2]);
  const equatorial = nNorm / hNorm < EPS;
  const reference = equatorial ? [1, 0, 0] : n.map((x) => x / nNorm);
  const angle = (a, b) => wrap(Math.atan2(dot(cross(a, b), normal), dot(a, b)));
  const raanRad = equatorial ? 0 : wrap(Math.atan2(n[1], n[0]));
  const argpRad = e === 0 ? 0 : angle(reference, eVec);
  const nuRad = angle(e === 0 ? reference : eVec, r);
  return { aKm, e, iRad, raanRad, argpRad, nuRad, periKm: pKm / (1 + e), apoKm: e < 1 ? pKm / (1 - e) : Infinity };
}
