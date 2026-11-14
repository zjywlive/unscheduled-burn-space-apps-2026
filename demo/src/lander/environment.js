// Environmental screening estimates, not a penetration model or a live space-weather forecast.

// Gruen et al. 1985, Icarus 62, 244–272: cumulative randomly tumbling plate flux at 1 AU, m^-2 s^-1, m in grams.
// All coefficients and exponents below are the empirical fit from that source, as specified in the task.
export function gruenFlux(mG) {
  if (!(mG > 0) || !Number.isFinite(mG)) throw new RangeError('Particle mass must be positive and finite');
  return (2.2e3 * mG ** 0.306 + 15) ** -4.38
    + 1.3e-9 * (mG + 1e11 * mG ** 2 + 1e27 * mG ** 4) ** -0.36
    + 1.3e-16 * (mG + 1e6 * mG ** 2) ** -0.85;
}

// Assumed spherical grain density: 2.5 g/cm^3; mass is density times sphere volume, not a damage threshold.
export function particleMassG(diameterCm, densityGcm3 = 2.5) {
  if (!Number.isFinite(diameterCm) || diameterCm < 0 || !Number.isFinite(densityGcm3) || densityGcm3 <= 0) {
    throw new RangeError('Particle diameter must be nonnegative and density positive');
  }
  return Math.PI / 6 * diameterCm ** 3 * densityGcm3;
}

// Approximate, assumed lunar occultation: shielding=0.5 blocks half the sky in low orbit; use 1 in free space.
// areaM2 is the tumbling-plate exposure area used by the flux model, not an extra 4π solid-angle multiplier.
export function expectedImpacts({ areaM2, durationS, minMassG, shielding = 0.5 }) {
  if (![areaM2, durationS, shielding].every(Number.isFinite) || areaM2 < 0 || durationS < 0 || shielding < 0 || shielding > 1) {
    throw new RangeError('Exposure area and duration must be nonnegative, and shielding must be in [0, 1]');
  }
  return gruenFlux(minMassG) * areaM2 * durationS * shielding;
}

// Assumed independent arrivals with a constant rate: Poisson P(N >= 1) = 1 - exp(-expected).
export function poissonAtLeastOne(expected) {
  if (!(expected >= 0)) throw new RangeError('Expected impact count must be nonnegative');
  return -Math.expm1(-expected);
}

// NOAA SWPC solar radiation storms, >=10 MeV integral proton flux; pfu = particles/(cm^2 s sr).
// Thresholds and average frequencies per 11-year cycle: https://www.swpc.noaa.gov/noaa-scales-explanation
// Frequencies are text so the S5 upper bound '<1' is preserved rather than replaced by an invented average.
export const SPACE_WEATHER = Object.freeze([
  { level: 1, id: 'S1', name: 'Minor', thresholdPfu: 10, averagePer11YearCycle: '50' },
  { level: 2, id: 'S2', name: 'Moderate', thresholdPfu: 1e2, averagePer11YearCycle: '25' },
  { level: 3, id: 'S3', name: 'Strong', thresholdPfu: 1e3, averagePer11YearCycle: '10' },
  { level: 4, id: 'S4', name: 'Severe', thresholdPfu: 1e4, averagePer11YearCycle: '3' },
  { level: 5, id: 'S5', name: 'Extreme', thresholdPfu: 1e5, averagePer11YearCycle: '<1' },
].map((level) => Object.freeze(level)));

export function stormLevel(pfu) {
  let level = 0;
  for (const scale of SPACE_WEATHER) if (pfu >= scale.thresholdPfu) level = scale.level;
  return level;
}

// Approximate planning values; NOAA SWPC: CMEs can reach Earth in 15 hours to several days, not an event forecast.
export const CME_TRANSIT_DAYS = Object.freeze({ fast: 1, typical: 3, slow: 4 });

export const ORBITAL_DEBRIS = Object.freeze({
  leo: Object.freeze({
    management: 'Launch collision avoidance (COLA) screening checks the trajectory against the tracked catalogue.',
    // Assumed parking profile: about 185 km for 1–3 h; impact probability has not been numerically evaluated.
    assessment: 'At about 185 km atmospheric drag clears small debris quickly, so a 1–3 h parking dwell is expected to have a very low impact probability.',
    impactProbability: 'not computed',
    model: 'NASA ORDEM 3.1 is the orbital-debris engineering model to use for a quantitative assessment.',
  }),
  lunar: Object.freeze({
    // Approximate, unverified and time-dependent inventory, not a live count or an exhaustive catalogue.
    population: 'Of order ten active lunar-region spacecraft, including LRO, Chandrayaan-2 orbiter, Danuri/KPLO, ARTEMIS P1/P2 and Queqiao-2.',
    assessment: 'There is no Earth-like debris cloud; the operational concern is conjunctions with individual spacecraft.',
    // ISRO press release on Chandrayaan-2's collision avoidance manoeuvre to avoid LRO (event supplied in the task).
    example: 'Chandrayaan-2 performed a collision avoidance manoeuvre on 18 Oct 2021 to avoid a conjunction with LRO.',
    // Approximate: mascon perturbations destabilise many low lunar orbits; this is not true of every frozen orbit.
    removal: 'Many low orbits decay into the surface under mascon perturbations, removing defunct objects rather than accumulating a persistent cloud.',
    impactProbability: 'not computed',
  }),
});

export const EXOSPHERE = Object.freeze({
  // Approximate, Apollo 17 Lunar Atmospheric Composition Experiment (LACE), surface at night.
  surfaceNightNumberDensityPerCm3: 1e5,
  source: 'Apollo 17 LACE (approximate nighttime surface density)',
  note: 'The lunar exosphere causes no measurable drag for this mission and has no weather in the atmospheric sense.',
});
