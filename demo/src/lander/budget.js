// Impulsive planning budget, with an explicitly estimated powered-descent allowance.
import { MU_MOON, R_MOON, RAD } from './constants.js';
import { wetMassKg } from './vehicle.js';
import { massRatio, propellantForDvKg, dvForPropellantMs, burnTimeS } from './rocket.js';
import { tliFromLeo, captureDvMs, circularSpeed, visViva, planeChangeDvMs } from './orbits.js';

export const PUBLISHED = Object.freeze({
  tli: Object.freeze({ lowMs: 3050, highMs: 3200, source: 'Apollo TLI burns from ~185 km parking orbit (Orloff, Apollo by the Numbers, NASA SP-2000-4029); approximate' }), // Source: Orloff, approximate.
  tcm: Object.freeze({ lowMs: 0, highMs: 50, source: 'assumed budget; Apollo TCMs were typically a few m/s' }), // Source: assumed.
  loi: Object.freeze({ lowMs: 800, highMs: 950, source: 'Apollo LOI-1 + LOI-2 into ~110 km orbit (Orloff 2000); approximate' }), // Source: Orloff, approximate.
  doi: Object.freeze({ lowMs: 18, highMs: 30, source: 'Apollo DOI to 110 x 15 km (Orloff 2000); approximate' }), // Source: Orloff, approximate.
  pd: Object.freeze({ lowMs: 1850, highMs: 2100, source: 'Apollo LM powered descent PDI to touchdown incl. hover margin (Bennett 1972, NASA TN D-6846); approximate' }), // Source: Bennett, approximate; comparison supplied by task.
});

// Default altitudes 185/100/15 km, v_inf 0.83 km/s, TCM 30 m/s and plane change 0 deg: assumed scenario.
export function deltaVBudget({ vehicle, leoAltKm = 185, lloAltKm = 100, pdiAltKm = 15, vInfKms = 0.83, tcmMs = 30, pdMs = null, lloPlaneChangeDeg = 0 }) {
  if (!Number.isFinite(lloAltKm) || !Number.isFinite(pdiAltKm) || pdiAltKm < 0 || lloAltKm < pdiAltKm) throw new RangeError('Require 0 <= pdiAltKm <= lloAltKm.');
  const wetKg = wetMassKg(vehicle), stage = vehicle.tliStage;
  const tliMs = tliFromLeo({ leoAltKm }).dvMs;
  const stageFinalKg = stage.dryMassKg + wetKg;
  const stageInitialKg = stageFinalKg * massRatio(tliMs, stage.ispS);
  const tliStagePropellantKg = stageInitialKg - stageFinalKg;
  const phases = [{
    id: 'tli', name: 'Trans-lunar injection', by: 'tli-stage', dvMs: tliMs,
    massBeforeKg: stageInitialKg, massAfterKg: stageFinalKg, propellantKg: tliStagePropellantKg,
    burnS: null, published: PUBLISHED.tli, // No upper-stage thrust is supplied by cleanVehicle; duration is unknown.
  }];
  const lloKm = R_MOON + lloAltKm, pdiKm = R_MOON + pdiAltKm;
  const vCircKms = circularSpeed(MU_MOON, lloKm);
  const loiMs = captureDvMs(MU_MOON, vInfKms, lloKm) + planeChangeDvMs(vCircKms, lloPlaneChangeDeg * RAD);
  const doiMs = (vCircKms - visViva(MU_MOON, lloKm, (lloKm + pdiKm) / 2)) * 1000;
  const descentMs = pdMs ?? 1950; // Assumed placeholder including descent losses/hover, until descent simulation supplies pdMs.
  let massKg = wetKg;
  for (const [id, name, dvMs] of [
    ['tcm', 'Trajectory correction', tcmMs], ['loi', 'Lunar orbit insertion', loiMs],
    ['doi', 'Descent orbit insertion', doiMs], ['pd', 'Powered descent', descentMs],
  ]) {
    const propellantKg = propellantForDvKg(massKg, dvMs, vehicle.ispS);
    const phase = { id, name, by: 'lander', dvMs, massBeforeKg: massKg, massAfterKg: massKg - propellantKg, propellantKg, burnS: burnTimeS(massKg, dvMs, vehicle.ispS, vehicle.mainThrustN), published: PUBLISHED[id] };
    if (id === 'pd') phase.estimated = pdMs == null;
    phases.push(phase);
    massKg = phase.massAfterKg;
  }
  const landerDvMs = phases.slice(1).reduce((sum, phase) => sum + phase.dvMs, 0);
  const landerCapacityMs = dvForPropellantMs(wetKg, vehicle.propellantKg, vehicle.ispS);
  const reserveDvMs = vehicle.reserveDvMs;
  const marginMs = landerCapacityMs - landerDvMs - reserveDvMs;
  // For infeasible plans these are required (hypothetical) masses; negative propellantLeftKg denotes a shortfall.
  return { phases, landerDvMs, landerCapacityMs, reserveDvMs, marginMs, propellantLeftKg: massKg - vehicle.dryMassKg, feasible: marginMs >= 0, tliStagePropellantKg };
}
