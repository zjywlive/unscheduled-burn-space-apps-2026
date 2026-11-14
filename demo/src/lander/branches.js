// Contingency branches for one plan: each event is injected at a definite time, contingency.decide() picks the
// action from the numbers, and the branch carries the alternative trajectory for the view (MCI km for the lunar
// orbit scene, PD-frame samples for the descent scene). Pure computation.
import { simulateDescent } from './descent.js';
import { decide, divertDvMs, retargetDvMs } from './contingency.js';
import { expectedImpacts, poissonAtLeastOne, particleMassG } from './environment.js';
import { G0, R_MOON, MU_MOON, MOON_RATE, RAD, DEG } from './constants.js';
import { unitFromLonLat } from '../geometry.js';
import { dot, cross, unit, rotate, scale, norm } from './vec.js';

const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const hrs = (s) => (s >= 86400 ? `${fmt(s / 86400, 1)} d` : s >= 3600 ? `${fmt(s / 3600, 1)} h` : `${fmt(s / 60, 0)} min`);

// sites: candidate list (sites.json entries); skyOk(site, tMs) → true when Sun and Earth clear the skyline there.
export function buildBranches(plan, { sites = [], skyOk = null } = {}) {
  const v = plan.vehicle, out = [];
  const ve = v.ispS * G0;
  const nom = plan.descent;
  const m0 = nom.samples[0].massKg;
  const t = plan.times;
  const T1 = plan.llo.periodS;
  const vLlo = Math.sqrt(MU_MOON / plan.llo.radiusKm);
  const toMci = (samples) => samples.map((s) => plan.descentFrame.pdToMci(s.r));
  const sampleAt = (tS) => nom.samples.find((s) => s.tS >= tS) ?? nom.samples[nom.samples.length - 1];
  const tHigh = nom.events.find((e) => e.name === 'high-gate')?.tS ?? 0;
  const tLow = nom.events.find((e) => e.name === 'low-gate')?.tS ?? nom.durationS;

  // 1–2. engine underperformance detected 240 s into braking (thrust low since PDI)
  const tDet = 240;
  const sDet = sampleAt(tDet);
  const usedMs = ve * Math.log(m0 / sDet.massKg), remMs = ve * Math.log(sDet.massKg / v.dryMassKg);
  for (const [id, k] of [['engine-low', 0.8], ['engine-abort', 0.55]]) {
    const low = simulateDescent(v, { massKg: m0, lloAltKm: plan.options.lloAltKm, pdiAltKm: plan.options.pdiAltKm, siteHeightKm: plan.siteHeightKm, thrustScale: k });
    const toGo = (low.touchdown?.ok ? low.dvUsedMs : Infinity) - usedMs;
    const d = decide('engine-underperformance', { phase: 'braking', dvRemainingMs: remMs, dvToGoMs: toGo, reserveDvMs: v.reserveDvMs });
    let track = toMci(low.samples), extra = low.dvUsedMs - nom.dvUsedMs, result = `lands after ${fmt(low.durationS)} s instead of ${fmt(nom.durationS)} s`;
    let surface = low.touchdown ? low.samples : null;
    if (d.action === 'abort-to-orbit') {
      const ab = simulateDescent(v, { massKg: m0, lloAltKm: plan.options.lloAltKm, pdiAltKm: plan.options.pdiAltKm, siteHeightKm: plan.siteHeightKm, thrustScale: k, abortAtS: tDet });
      track = toMci(ab.samples);
      surface = null;
      extra = ab.dvUsedMs;
      result = ab.abortOrbit ? `safe orbit ${fmt(ab.abortOrbit.periAltKm)} × ${fmt(ab.abortOrbit.apoAltKm)} km, ${fmt(ab.dvUsedMs)} m/s spent; landing lost unless the engine recovers` : 'no safe orbit reached';
    }
    out.push({
      id, eventId: 'engine-underperformance', title: `Engine thrust ${Math.round((1 - k) * 100)} % low`, phase: 'braking', tMs: t.pdiMs + tDet * 1000,
      decision: d, moonTrack: track, surfaceSamples: surface, touchdown: surface ? low.touchdown : null,
      numbers: [`Δv left ${fmt(remMs)} m/s, Δv still needed ${Number.isFinite(toGo) ? fmt(toGo) : 'more than available'} m/s, reserve ${fmt(v.reserveDvMs)} m/s`, result, d.action === 'abort-to-orbit' ? '' : `costs ${fmt(extra)} m/s more than nominal (gravity losses of a longer burn)`].filter(Boolean),
    });
  }

  // 3. hazard found by the lidar 20 s into the approach: boulders at the target
  const approachS = tLow - tHigh;
  const atS = 20, cross_ = 140, down = 60;
  const dist = Math.hypot(cross_, down);
  const dHaz = decide('site-hazard', { phase: 'approach', hazardDistanceM: dist, approachTimeLeftS: approachS - atS, divertBudgetMs: 60 });
  const div = simulateDescent(v, { massKg: m0, lloAltKm: plan.options.lloAltKm, pdiAltKm: plan.options.pdiAltKm, siteHeightKm: plan.siteHeightKm, divert: { atS, crossrangeM: cross_, downrangeM: down } });
  out.push({
    id: 'hazard-divert', eventId: 'site-hazard', title: 'Boulders at the target (lidar)', phase: 'approach', tMs: t.pdiMs + (tHigh + atS) * 1000,
    decision: dHaz, surfaceSamples: div.samples, surfaceTarget: div.site.r, moonTrack: null, touchdown: div.touchdown,
    numbers: [`new target ${fmt(dist)} m away, ${fmt(approachS - atS)} s of approach left`, `divert estimate ${fmt(divertDvMs(dist, approachS - atS))} m/s (budget 60 m/s); simulated ${fmt(div.dvUsedMs - nom.dvUsedMs, 1)} m/s more than nominal`, div.touchdown ? `touchdown ${fmt(Math.abs(div.touchdown.vVertMs), 2)} m/s vertical, ${fmt(div.touchdown.vHorizMs, 2)} m/s horizontal` : 'no touchdown'],
  });

  // 4. ground link lost before PDI: no GO → wave-off, one more revolution
  const dCom = decide('comms-loss', { phase: 'llo', orbitPeriodS: T1 });
  const lat = plan.site.latDeg * RAD;
  const drift = (s) => Math.asin(Math.cos(lat) * Math.sin(MOON_RATE * s));   // out-of-plane angle after s seconds
  const ring = [];
  for (let i = 0; i <= 180; i++) ring.push(plan.lloAt(t.doiMs + (T1 * 1000 * i) / 180).r);
  const dvWave = retargetDvMs(vLlo, plan.llo.radiusKm * drift(T1), plan.llo.radiusKm);
  const skyWave = skyOk ? skyOk(plan.site, t.landingMs + T1 * 1000) : null;
  out.push({
    id: 'wave-off', eventId: 'comms-loss', title: 'No ground GO before PDI', phase: 'llo', tMs: t.doiMs - 600e3,
    decision: dCom, moonTrack: ring,
    numbers: [`landing slips one orbit (${hrs(T1)})`, `the site drifts ${fmt(drift(T1) * DEG, 2)}° out of the plane: plane change ${fmt(dvWave, 1)} m/s`, skyWave === null ? '' : skyWave ? 'Sun and Earth still up at the new time' : 'Sun or Earth below the skyline at the new time: hold longer'].filter(Boolean),
  });

  // 5. solar particle event (≥ S3) in lunar orbit: hold in safe mode until it falls below S2
  const stormS = 36 * 3600;   // assumed storm duration above S2 (SPEs last hours to a few days)
  const dSpe = decide('spe', { phase: 'llo', stormLevel: 3, orbitPeriodS: T1 });
  const revs = Math.ceil(stormS / T1);
  const psi = drift(revs * T1);
  const dvSpe = retargetDvMs(vLlo, plan.llo.radiusKm * psi, plan.llo.radiusKm);
  const nextPlane = (Math.PI / MOON_RATE);
  out.push({
    id: 'spe-hold', eventId: 'spe', title: 'Solar particle event (S3)', phase: 'llo', tMs: t.doiMs - 6 * 3600e3,
    decision: dSpe, moonTrack: ring,
    numbers: [`hold ${revs} orbits (${hrs(revs * T1)}, storm duration assumed)`, `then either a plane change of ${fmt(dvSpe)} m/s (site ${fmt(psi * DEG, 1)}° out of plane) or wait ${hrs(nextPlane - revs * T1)} more for the plane to come round`, 'during the 12-minute powered descent the rule is to continue'],
  });

  // 6. Sun or Earth below the skyline at the landing time → retarget to a lit alternate (nearest candidate)
  const sF = plan.siteFixed;
  const h2Fixed = (() => { const th = (MOON_RATE * (t.landingMs - plan.epochMs)) / 1000; const c = Math.cos(-th), s = Math.sin(-th); const h = plan.descentFrame.h2; return [c * h[0] - s * h[1], s * h[0] + c * h[1], h[2]]; })();
  const alts = sites.filter((s) => s.id !== plan.site.id && s.latDeg <= -80).map((s) => {
    const u = unitFromLonLat(s.lonDeg, s.latDeg);
    const sep = Math.acos(Math.max(-1, Math.min(1, dot(u, sF)))) * R_MOON;
    const crossKm = Math.asin(Math.max(-1, Math.min(1, dot(u, h2Fixed)))) * R_MOON;
    return { ...s, u, sepKm: sep, crossrangeKm: Math.abs(crossKm), lit: skyOk ? skyOk(s, t.landingMs) : true };
  }).filter((s) => s.sepKm > 1).sort((a, b) => a.crossrangeKm - b.crossrangeKm);
  const lit = alts.find((s) => s.lit);
  const dIll = decide('illumination-no-go', { phase: 'llo', nextPlaneWindowS: nextPlane, alternates: alts.slice(0, 5).map((s) => ({ id: s.id, name: s.name, crossrangeKm: s.crossrangeKm, lit: s.lit })) });
  let retTrack = null;
  if (lit) {
    const axis = unit(cross(sF, lit.u));
    const ang = Math.acos(Math.max(-1, Math.min(1, dot(sF, lit.u))));
    const th = (MOON_RATE * (t.landingMs - plan.epochMs)) / 1000;
    const toFixed = (p) => { const c = Math.cos(-th), s = Math.sin(-th); return [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]]; };
    const toMciAt = (p) => { const c = Math.cos(th), s = Math.sin(th); return [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]]; };
    retTrack = toMci(nom.samples).map((p) => toMciAt(rotate(toFixed(p), axis, ang)));
  }
  out.push({
    id: 'retarget', eventId: 'illumination-no-go', title: 'Site dark or Earth hidden at landing', phase: 'llo', tMs: t.doiMs - 12 * 3600e3,
    decision: dIll, moonTrack: retTrack, alternate: lit ? { id: lit.id, name: lit.name, latDeg: lit.latDeg, lonDeg: lit.lonDeg } : null,
    numbers: lit ? [`alternate: ${lit.name}, ${fmt(lit.sepKm)} km away, ${fmt(lit.crossrangeKm)} km cross-range`, `retarget before DOI ${fmt(retargetDvMs(vLlo, lit.crossrangeKm, plan.llo.radiusKm))} m/s`] : ['no lit alternate among the candidates: hold for the next plane window'],
  });

  // 7. micrometeoroids over the lunar-orbit loiter (no trajectory change; numbers only)
  const loiterS = plan.llo.loiterDays * 86400;
  const area = 10;   // m², assumed exposed area
  const e100 = expectedImpacts({ areaM2: area, durationS: loiterS, minMassG: particleMassG(0.01) });
  const e1mm = expectedImpacts({ areaM2: area, durationS: loiterS, minMassG: particleMassG(0.1) });
  out.push({
    id: 'mmod', eventId: 'mmod-strike', title: 'Micrometeoroid strike', phase: 'llo', tMs: t.loiMs + loiterS * 500,
    decision: decide('mmod-strike', { phase: 'llo' }), moonTrack: null,
    numbers: [`expected hits over the ${fmt(plan.llo.loiterDays, 1)}-day loiter on ${area} m²: ${e100.toFixed(2)} of ≥ 0.1 mm, ${e1mm.toExponential(1)} of ≥ 1 mm (P ≥ 1: ${(poissonAtLeastOne(e1mm) * 100).toFixed(2)} %)`, 'Grün et al. 1985 flux at 1 AU, half the sky blocked by the Moon (approximate)'],
  });

  // 8. conjunction in the parking orbit (screened against the catalogue; numbers not computed)
  out.push({
    id: 'leo-conjunction', eventId: 'debris-conjunction', title: 'Debris conjunction in LEO', phase: 'leo', tMs: t.launchMs + (t.tliMs - t.launchMs) * 0.4,
    decision: decide('debris-conjunction', { phase: 'leo', conjunctionMissKm: 0.5 }), moonTrack: null,
    numbers: ['predicted miss 0.5 km (example) → small avoidance burn, or shift TLI by a revolution', 'impact probability not computed here; NASA ORDEM 3.1 is the model to use'],
  });
  return out.sort((a, b) => a.tMs - b.tMs);
}
