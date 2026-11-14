// Mission planner: one consistent Earth → landing timeline for a chosen site and landing time.
// Pure computation (browser and Node). Frames (docs/LANDER.md §3):
//   MCI  Moon-centred inertial, lunar-equator base plane, z = spin axis, x = Moon-fixed 0°E at epochMs
//        (epochMs = the requested landing time, so at landing MCI ≈ Moon-fixed). Same convention as relay.js.
//   PD   descent frame of descent.js: Moon-centred, PDI on +z, downrange +x, crossrange +y (metres).
// Method (patched conics, the textbook first cut; docs/LANDER.md §2):
//   1. Geocentric transfer ellipse from a circular parking orbit (perigee) to the Moon's distance, in the plane of the
//      Moon's orbit, timed to meet the Moon at the arrival time tA (Earth and Moon from the JPL ephemeris).
//   2. Inside the Moon's sphere of influence a selenocentric hyperbola with the arrival v∞, aimed at a polar periapsis
//      at the parking-orbit altitude; the two are blended between SOI entry and periapsis for drawing.
//   3. Lunar orbit insertion into a circular polar orbit. A polar orbit's plane is fixed in inertial space (J2 node
//      drift ∝ cos i = 0) while the Moon turns under it, so the loiter lasts until the site lies in the plane:
//      tA is solved for that. The landing time is then moved by under half an orbit so the lander is over the site.
//   4. Descent orbit insertion half a descent-ellipse before PDI (with a tiny plane change, see dvPlaneMs), the
//      powered descent from descent.js, touchdown at the site.
import { MU_EARTH, R_EARTH, MU_MOON, R_MOON, MOON_RATE, MOON_SOI_KM, G0, DAY_S, DEG, RAD } from './constants.js';
import { solveKepler, segmentClearsSphere } from '../relay.js';
import { unitFromLonLat } from '../geometry.js';
import { bodyAzEl } from '../ephemeris.js';
import { add, sub, scale, dot, cross, norm, unit, rotate, rotZ, angleAbout, wrapPi, smoothstep, lerp3 } from './vec.js';
import { deltaVBudget } from './budget.js';
import { simulateDescent } from './descent.js';
import { cleanVehicle, wetMassKg } from './vehicle.js';

export const MISSION_DEFAULTS = Object.freeze({
  leoAltKm: 185,          // circular parking orbit; Apollo used ~185 km (Orloff 2000, NASA SP-2000-4029)
  parkingRevs: 1.5,       // assumed; Apollo coasted 1.5–2.5 revolutions before TLI
  lloAltKm: 100,          // assumed; low circular polar orbit (Apollo ~110 km, Chandrayaan-3 ~150 km before DOI)
  pdiAltKm: 15,           // powered descent initiation altitude; Apollo's DOI perilune was ~15 km (50,000 ft)
  minLoiterDays: 1,       // assumed checkout time in lunar orbit before descent
  apogeeFactor: 1.0,      // transfer apogee ÷ Earth–Moon distance (1 = Hohmann-like, ~5 days; Apollo flew faster)
  tliThrustN: 100000,     // assumed upper-stage thrust (RL10-class, ~100 kN) — only sets the TLI burn length
  tcm1AfterTliS: DAY_S,   // trajectory correction manoeuvres (assumed timing and size)
  tcm1DvMs: 20,
  tcm2BeforeLoiS: DAY_S / 2,
  tcm2DvMs: 10,
  landedTailS: 2 * 3600,  // how long the timeline runs after touchdown
  lloSense: 1,            // +1 or −1: which way round the polar orbit the lander flies
});

export const PHASES = [
  { id: 'leo', name: 'Parking orbit (LEO)', scene: 'earth' },
  { id: 'tli', name: 'Trans-lunar injection', scene: 'earth', burn: true },
  { id: 'coast', name: 'Trans-lunar coast', scene: 'earth' },
  { id: 'approach-moon', name: 'Lunar approach (inside SOI)', scene: 'moon' },
  { id: 'loi', name: 'Lunar orbit insertion', scene: 'moon', burn: true },
  { id: 'llo', name: 'Low lunar orbit (checkout, wait for plane)', scene: 'moon' },
  { id: 'doi', name: 'Descent orbit insertion', scene: 'moon', burn: true },
  { id: 'descent-coast', name: `Coast to PDI`, scene: 'moon' },
  { id: 'braking', name: 'Powered descent: braking', scene: 'moon', burn: true },
  { id: 'approach', name: 'Powered descent: approach (pitch-over)', scene: 'surface', burn: true },
  { id: 'terminal', name: 'Terminal vertical descent', scene: 'surface', burn: true },
  { id: 'landed', name: 'Landed', scene: 'surface' },
];

const theta = (tMs, epochMs) => (MOON_RATE * (tMs - epochMs)) / 1000;
export const fixedToInertial = (v, tMs, epochMs) => rotZ(v, theta(tMs, epochMs));
export const inertialToFixedAt = (v, tMs, epochMs) => rotZ(v, -theta(tMs, epochMs));

// Earth and Sun in MCI from the ephemeris (Moon-fixed directions turned by the Moon's rotation).
export function makeBodies(eph, epochMs) {
  function earthMci(tMs) {
    const d = eph.at(tMs);
    return d ? fixedToInertial(scale(d.earth, d.earthRangeKm), tMs, epochMs) : null;
  }
  function sunDirMci(tMs) {
    const d = eph.at(tMs);
    return d ? fixedToInertial(d.sun, tMs, epochMs) : null;
  }
  function earthVelMci(tMs) {
    const h = 1800e3;
    const a = earthMci(tMs - h), b = earthMci(tMs + h);
    return a && b ? scale(sub(b, a), 1 / 3600) : null;   // km/s
  }
  return { earthMci, sunDirMci, earthVelMci, startMs: eph.startMs, endMs: eph.endMs };
}

// ---------- conics ----------

function ellipseState(mu, aKm, e, pHat, qHat, tauS) {
  const n = Math.sqrt(mu / (aKm * aKm * aKm));
  const E = solveKepler(n * tauS, e);
  const b = aKm * Math.sqrt(1 - e * e);
  const cE = Math.cos(E), sE = Math.sin(E);
  const r = aKm * (1 - e * cE);
  const x = aKm * (cE - e), y = b * sE;
  const k = Math.sqrt(mu * aKm) / r;
  return { r: add(scale(pHat, x), scale(qHat, y)), v: add(scale(pHat, -k * sE), scale(qHat, k * Math.sqrt(1 - e * e) * cE)) };
}

function solveHyperbolic(M, e) {
  let H = Math.asinh(M / e);
  for (let k = 0; k < 60; k++) {
    const d = (e * Math.sinh(H) - H - M) / (e * Math.cosh(H) - 1);
    H -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return H;
}

// hyperbola with |a| = aKm, periapsis direction pHat, motion toward qHat at periapsis; tauS from periapsis
function hyperbolaState(mu, aKm, e, pHat, qHat, tauS) {
  const n = Math.sqrt(mu / (aKm * aKm * aKm));
  const H = solveHyperbolic(n * tauS, e);
  const ch = Math.cosh(H), sh = Math.sinh(H), s = Math.sqrt(e * e - 1);
  const x = aKm * (e - ch), y = aKm * s * sh;
  const r = aKm * (e * ch - 1);
  const k = Math.sqrt(mu * aKm) / r;
  return { r: add(scale(pHat, x), scale(qHat, y)), v: add(scale(pHat, -k * sh), scale(qHat, k * s * ch)) };
}

// Geocentric transfer meeting the Moon at tA, and the selenocentric hyperbola it hands over to.
export function transferAt(bodies, tA, o, lloRadiusKm) {
  const e = bodies.earthMci(tA), ev = bodies.earthVelMci(tA);
  if (!e || !ev) return null;
  const rM = scale(e, -1), vM = scale(ev, -1);          // Moon relative to Earth
  const hT = unit(cross(rM, vM));
  const rA = norm(rM), rp = R_EARTH + o.leoAltKm, ra = Math.max(rA, rA * o.apogeeFactor);
  const a = (rp + ra) / 2, ecc = (ra - rp) / (ra + rp);
  const p = a * (1 - ecc * ecc);
  const nuA = Math.acos(Math.max(-1, Math.min(1, (p / rA - 1) / ecc)));
  const EA = 2 * Math.atan2(Math.sqrt(1 - ecc) * Math.sin(nuA / 2), Math.sqrt(1 + ecc) * Math.cos(nuA / 2));
  const n = Math.sqrt(MU_EARTH / (a * a * a));
  const tofS = (EA - ecc * Math.sin(EA)) / n;
  const pT = rotate(unit(rM), hT, -nuA), qT = cross(hT, pT);
  const tTli = tA - tofS * 1000;
  const geo = (tMs) => ellipseState(MU_EARTH, a, ecc, pT, qT, (tMs - tTli) / 1000);
  const arrive = geo(tA);
  const vInfVec = sub(arrive.v, vM);
  const vInf = norm(vInfVec);
  const s = unit(vInfVec);
  // polar plane through the incoming asymptote: normal ⟂ s and ⟂ z
  const hP = scale(unit(cross(s, [0, 0, 1])), o.lloSense >= 0 ? 1 : -1);
  const eh = 1 + (lloRadiusKm * vInf * vInf) / MU_MOON;
  const beta = Math.acos(1 / eh);
  const pH = add(scale(s, Math.cos(beta)), scale(cross(hP, s), -Math.sin(beta)));
  const qH = cross(hP, pH);
  const aH = MU_MOON / (vInf * vInf);
  const hyp = (tMs) => hyperbolaState(MU_MOON, aH, eh, pH, qH, (tMs - tA) / 1000);
  // time from SOI entry to periapsis: r = aH (e cosh H − 1) = SOI
  const Hs = Math.acosh((MOON_SOI_KM / aH + 1) / eh);
  const soiS = (eh * Math.sinh(Hs) - Hs) / Math.sqrt(MU_MOON / (aH * aH * aH));
  return {
    tA, tTli, tofS, aKm: a, e: ecc, rpKm: rp, raKm: ra, nuA, pT, qT, hT, geo, vM, rM,
    vInfKms: vInf, vInfVec, s, hP, pH, qH, aH, eh, hyp, soiS, tSoi: tA - soiS * 1000,
  };
}

// ---------- the plan ----------

// site: { id, name, latDeg, lonDeg }; landingMs: requested landing time; eph: createEphemeris(); siteHeightKm from the DEM;
// mask: the site's terrain skyline (terrain.skylineFor) or a constant angle, used for Sun and Earth near the surface.
export function planMission({ eph, site, landingMs, vehicle: vIn = {}, siteHeightKm = 0, mask = 0, options = {} }) {
  const o = { ...MISSION_DEFAULTS, ...options };
  const vehicle = cleanVehicle(vIn);
  const warnings = [];
  const epochMs = landingMs;
  const bodies = makeBodies(eph, epochMs);
  const r1 = R_MOON + o.lloAltKm;
  const n1 = Math.sqrt(MU_MOON / (r1 * r1 * r1));
  const T1 = (2 * Math.PI) / n1;
  const siteF = unitFromLonLat(site.lonDeg, site.latDeg);
  const siteMci = (tMs) => fixedToInertial(siteF, tMs, epochMs);
  const lat = site.latDeg * RAD, lam = site.lonDeg * RAD;
  const halfPlaneMs = (Math.PI / MOON_RATE) * 1000;   // the plane passes over a site twice per sidereal month

  // 1. arrival time: the site must lie in the polar orbit plane at landing (iterate: the arrival geometry turns with
  //    the Moon, so moving tA by Δ turns the plane normal by ≈ +ω Δ in MCI)
  let tA = landingMs - o.minLoiterDays * DAY_S * 1000;
  let tr = null;
  for (let k = 0; k < 12; k++) {
    tr = transferAt(bodies, tA, o, r1);
    if (!tr) break;
    const psi = Math.atan2(tr.hP[1], tr.hP[0]);
    const d = wrapPi(2 * (psi - lam - Math.PI / 2)) / 2;   // −π/2..π/2: plane error, either sense of the normal
    let dT = (-d / MOON_RATE) * 1000;
    while (landingMs - (tA + dT) < o.minLoiterDays * DAY_S * 1000) dT -= halfPlaneMs;
    while (landingMs - (tA + dT) - halfPlaneMs >= o.minLoiterDays * DAY_S * 1000) dT += halfPlaneMs;
    tA += dT;
    if (Math.abs(d) < 1e-7) break;
  }
  if (!tr) return { ok: false, error: 'The transfer needs ephemeris data from about three weeks before the landing (data start 2026-11-01).' };
  tr = transferAt(bodies, tA, o, r1);
  const h1 = tr.hP;
  const planeErrDeg = Math.asin(Math.max(-1, Math.min(1, dot(h1, siteMci(landingMs))))) * DEG;

  // 2. budget (pd placeholder) → mass at PDI → descent simulation → budget with the simulated descent Δv
  const budget0 = deltaVBudget({ vehicle, leoAltKm: o.leoAltKm, lloAltKm: o.lloAltKm, pdiAltKm: o.pdiAltKm, vInfKms: tr.vInfKms, tcmMs: o.tcm1DvMs + o.tcm2DvMs });
  const pdPhase0 = budget0.phases.find((p) => p.id === 'pd');
  const massAtPdi = pdPhase0.massBeforeKg;
  const descent = simulateDescent(vehicle, { massKg: massAtPdi, lloAltKm: o.lloAltKm, pdiAltKm: o.pdiAltKm, siteHeightKm });
  if (!descent.touchdown) warnings.push('The nominal descent did not reach touchdown.');
  else if (!descent.touchdown.ok) warnings.push('The nominal touchdown is outside the vehicle limits.');
  const last = descent.samples[descent.samples.length - 1];
  const td = descent.touchdown ? descent.site.r : last.r;
  const phiTd = Math.atan2(td[0], td[2]);              // ground angle PDI → touchdown in the PD frame
  const rSite = R_MOON + siteHeightKm;
  const rPdi = rSite + o.pdiAltKm;
  const aD = (r1 + rPdi) / 2, eD = (r1 - rPdi) / (r1 + rPdi);
  const halfD = Math.PI * Math.sqrt((aD * aD * aD) / MU_MOON);

  // 3. landing time: within ±T/2 of the request so the lander is at the DOI point on time
  let tL = landingMs, geom = null;
  for (let k = 0; k < 30; k++) {
    const sL = siteMci(tL);
    const h2 = unit(sub(h1, scale(sL, dot(h1, sL))));
    const rPdiHat = rotate(sL, h2, -phiTd);
    const tPdi = tL - descent.durationS * 1000;
    const tDoi = tPdi - halfD * 1000;
    const uReq = angleAbout(tr.pH, scale(rPdiHat, -1), h1);
    const f = wrapPi(n1 * ((tDoi - tA) / 1000) - uReq);
    geom = { sL, h2, rPdiHat, tPdi, tDoi };
    if (Math.abs(f) < 1e-9) break;
    tL -= (f / n1) * 1000;
  }
  const { h2, rPdiHat, tPdi, tDoi } = geom;
  const tPdiHat = cross(h2, rPdiHat);
  const planeChangeRad = Math.acos(Math.max(-1, Math.min(1, dot(h1, h2))));
  const dvPlaneMs = 2 * Math.sqrt(MU_MOON / r1) * 1000 * Math.sin(planeChangeRad / 2);
  // final budget: the simulated descent Δv, and the plane trim charged to DOI (mass at PDI moves by < 1 kg; the
  // descent is not re-run for that)
  const budget = deltaVBudget({ vehicle, leoAltKm: o.leoAltKm, lloAltKm: o.lloAltKm, pdiAltKm: o.pdiAltKm, vInfKms: tr.vInfKms, tcmMs: o.tcm1DvMs + o.tcm2DvMs, pdMs: descent.dvUsedMs, doiExtraMs: dvPlaneMs });
  if (!budget.feasible) warnings.push(`Propellant short by ${Math.round(-budget.marginMs)} m/s of Δv (after the reserve).`);

  // 4. times and phases
  const leoPeriodS = 2 * Math.PI * Math.sqrt(tr.rpKm ** 3 / MU_EARTH);
  const tli = budget.phases.find((p) => p.id === 'tli');
  const tliBurnS = (tli.propellantKg * vehicle.tliStage.ispS * G0) / o.tliThrustN;
  const burnOf = (id) => budget.phases.find((p) => p.id === id)?.burnS ?? 0;
  const t = {
    launchMs: tr.tTli - o.parkingRevs * leoPeriodS * 1000,
    tliMs: tr.tTli, tliBurnS,
    tcm1Ms: tr.tTli + o.tcm1AfterTliS * 1000, tcm2Ms: tA - o.tcm2BeforeLoiS * 1000,
    soiMs: tr.tSoi, loiMs: tA, loiBurnS: burnOf('loi'),
    doiMs: tDoi, doiBurnS: burnOf('doi'), pdiMs: tPdi, landingMs: tL,
    endMs: tL + o.landedTailS * 1000,
  };
  const dEv = (name) => descent.events.find((e) => e.name === name)?.tS;
  const tHighGate = tPdi + (dEv('high-gate') ?? descent.durationS * 0.8) * 1000;
  const tLowGate = tPdi + (dEv('low-gate') ?? descent.durationS * 0.97) * 1000;
  const bounds = {
    leo: [t.launchMs, t.tliMs - (tliBurnS / 2) * 1000],
    tli: [t.tliMs - (tliBurnS / 2) * 1000, t.tliMs + (tliBurnS / 2) * 1000],
    coast: [t.tliMs + (tliBurnS / 2) * 1000, t.soiMs],
    'approach-moon': [t.soiMs, tA - (t.loiBurnS / 2) * 1000],
    loi: [tA - (t.loiBurnS / 2) * 1000, tA + (t.loiBurnS / 2) * 1000],
    llo: [tA + (t.loiBurnS / 2) * 1000, tDoi - (t.doiBurnS / 2) * 1000],
    doi: [tDoi - (t.doiBurnS / 2) * 1000, tDoi + (t.doiBurnS / 2) * 1000],
    'descent-coast': [tDoi + (t.doiBurnS / 2) * 1000, tPdi],
    braking: [tPdi, tHighGate],
    approach: [tHighGate, tLowGate],
    terminal: [tLowGate, tL],
    landed: [tL, t.endMs],
  };
  const phases = PHASES.map((p) => ({ ...p, startMs: bounds[p.id][0], endMs: bounds[p.id][1] }));
  if (t.launchMs < eph.startMs) warnings.push('Launch is before the ephemeris starts; choose a later landing.');
  if (t.endMs > eph.endMs) warnings.push('The timeline runs past the end of the ephemeris.');
  const events = [
    { tMs: t.launchMs, id: 'leo-insertion', name: 'Parking orbit insertion' },
    { tMs: t.tliMs, id: 'tli', name: `TLI ${Math.round(tli.dvMs)} m/s (upper stage)` },
    { tMs: t.tliMs + (tliBurnS / 2) * 1000 + 600e3, id: 'separation', name: 'Upper stage separation' },
    { tMs: t.tcm1Ms, id: 'tcm1', name: `TCM-1 ${o.tcm1DvMs} m/s` },
    { tMs: t.soiMs, id: 'soi', name: 'Enter lunar sphere of influence' },
    { tMs: t.tcm2Ms, id: 'tcm2', name: `TCM-2 ${o.tcm2DvMs} m/s` },
    { tMs: tA, id: 'loi', name: `LOI ${Math.round(burnDv(budget, 'loi'))} m/s` },
    { tMs: tDoi, id: 'doi', name: `DOI ${Math.round(burnDv(budget, 'doi'))} m/s` },
    ...descent.events.map((e) => ({ tMs: tPdi + e.tS * 1000, id: e.name, name: e.name.replace(/-/g, ' ') })),
  ].sort((a, b) => a.tMs - b.tMs);

  // ---------- mass and propellant along the timeline ----------
  const wet = wetMassKg(vehicle);
  const massSteps = [];   // [tStartMs, tEndMs, massBefore, massAfter] for lander burns before PDI
  let m = wet;
  const step = (t0, t1, dmKg) => { massSteps.push([t0, t1, m, m - dmKg]); m -= dmKg; };
  const prop = (id) => budget.phases.find((p) => p.id === id)?.propellantKg ?? 0;
  const tcmProp = prop('tcm');
  const tcmSplit = o.tcm1DvMs / Math.max(1e-9, o.tcm1DvMs + o.tcm2DvMs);
  step(t.tcm1Ms, t.tcm1Ms + 30e3, tcmProp * tcmSplit);
  step(t.tcm2Ms, t.tcm2Ms + 15e3, tcmProp * (1 - tcmSplit));
  step(bounds.loi[0], bounds.loi[1], prop('loi'));
  step(bounds.doi[0], bounds.doi[1], prop('doi'));
  const massAtPdiPlan = m;
  const dSamples = descent.samples;
  const descentAt = (tMs) => {
    const ts = (tMs - tPdi) / 1000;
    if (ts <= 0) return dSamples[0];
    if (ts >= dSamples[dSamples.length - 1].tS) return dSamples[dSamples.length - 1];
    let lo = 0, hi = dSamples.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (dSamples[mid].tS <= ts) lo = mid; else hi = mid; }
    const a = dSamples[lo], b = dSamples[hi], f = (ts - a.tS) / Math.max(1e-9, b.tS - a.tS);
    return { ...a, r: lerp3(a.r, b.r, f), v: lerp3(a.v, b.v, f), massKg: a.massKg + (b.massKg - a.massKg) * f, altM: a.altM + (b.altM - a.altM) * f, thrustDir: a.thrustDir, phase: a.phase };
  };
  function landerMassAt(tMs) {
    if (tMs >= tPdi) return descentAt(tMs).massKg - (dSamples[0].massKg - massAtPdiPlan);
    let mm = wet;
    for (const [t0, t1, mb, ma] of massSteps) {
      if (tMs >= t1) mm = ma;
      else if (tMs > t0) { mm = mb + (ma - mb) * ((tMs - t0) / (t1 - t0)); break; }
      else break;
    }
    return mm;
  }

  // PD frame (metres) → MCI km
  const pdToMci = (p) => scale(add(add(scale(tPdiHat, p[0]), scale(h2, p[1])), scale(rPdiHat, p[2])), 1 / 1000);
  const pdDirToMci = (d) => add(add(scale(tPdiHat, d[0]), scale(h2, d[1])), scale(rPdiHat, d[2]));

  const q1 = cross(h1, tr.pH);
  const lloAt = (tMs) => {
    const u = n1 * ((tMs - tA) / 1000);
    const c = Math.cos(u), s = Math.sin(u);
    return { r: scale(add(scale(tr.pH, c), scale(q1, s)), r1), v: scale(add(scale(tr.pH, -s), scale(q1, c)), r1 * n1) };
  };
  const descentOrbitAt = (tMs) => ellipseState(MU_MOON, aD, eD, rPdiHat, tPdiHat, (tMs - tPdi) / 1000);
  const leoAt = (tMs) => {
    const u = ((2 * Math.PI) / leoPeriodS) * ((tMs - t.tliMs) / 1000);
    const geo = scale(add(scale(tr.pT, Math.cos(u)), scale(tr.qT, Math.sin(u))), tr.rpKm);
    const vel = scale(add(scale(tr.pT, -Math.sin(u)), scale(tr.qT, Math.cos(u))), (2 * Math.PI * tr.rpKm) / leoPeriodS);
    return { geo, vel };
  };
  const blendEnd = tA - (tr.soiS * 1000) * 0.35;

  function phaseAt(tMs) {
    for (const p of phases) if (tMs < p.endMs) return p;
    return phases[phases.length - 1];
  }

  // Full state at any time. pos/vel: MCI km, km/s. body: the body the altitude and speed refer to.
  function stateAt(tMs) {
    const ph = phaseAt(tMs);
    const earth = bodies.earthMci(tMs) ?? bodies.earthMci(Math.min(Math.max(tMs, eph.startMs), eph.endMs));
    const sunDir = bodies.sunDirMci(tMs) ?? bodies.sunDirMci(Math.min(Math.max(tMs, eph.startMs), eph.endMs));
    const ev = bodies.earthVelMci(Math.min(Math.max(tMs, eph.startMs + 2e6), eph.endMs - 2e6));
    let pos, vel, thrustDir = null, throttle = 0, altKm, body = 'moon', descentSample = null;
    if (tMs < t.tliMs) {
      const s = leoAt(tMs);
      pos = add(earth, s.geo); vel = add(ev, s.vel); body = 'earth';
    } else if (tMs < tA) {
      const g = tr.geo(tMs);
      const posG = add(earth, g.r), velG = add(ev, g.v);
      if (tMs <= tr.tSoi) { pos = posG; vel = velG; } else {
        const h = tr.hyp(tMs);
        const w = smoothstep(tr.tSoi, blendEnd, tMs);
        pos = lerp3(posG, h.r, w); vel = lerp3(velG, h.v, w);
      }
      body = norm(pos) < MOON_SOI_KM ? 'moon' : 'earth';
    } else if (tMs < tDoi) {
      const s = lloAt(tMs); pos = s.r; vel = s.v;
    } else if (tMs < tPdi) {
      const s = descentOrbitAt(tMs); pos = s.r; vel = s.v;
    } else if (tMs <= tL) {
      descentSample = descentAt(tMs);
      pos = pdToMci(descentSample.r); vel = scale(pdDirToMci(descentSample.v), 1 / 1000);
      thrustDir = descentSample.throttle > 0 ? pdDirToMci(descentSample.thrustDir) : null;
      throttle = descentSample.throttle;
      altKm = descentSample.altM / 1000;
    } else {
      descentSample = dSamples[dSamples.length - 1];
      pos = pdToMci(descentSample.r); vel = [0, 0, 0];
      altKm = 0;
    }
    if (ph.burn && ph.id !== 'braking' && ph.id !== 'approach' && ph.id !== 'terminal') {
      throttle = 1;
      const vRel = body === 'earth' ? sub(vel, ev) : vel;
      thrustDir = ph.id === 'tli' ? unit(vRel) : scale(unit(vRel), -1);   // LOI and DOI are retrograde
    }
    if (altKm === undefined) altKm = body === 'earth' ? norm(sub(pos, earth)) - R_EARTH : norm(pos) - R_MOON;
    const speedKms = body === 'earth' ? norm(sub(vel, ev)) : norm(vel);
    const massKg = landerMassAt(tMs);
    const propellantKg = Math.max(0, massKg - vehicle.dryMassKg);
    const dvLeftMs = vehicle.ispS * G0 * Math.log(massKg / vehicle.dryMassKg);
    // visibility: is the Sun blocked (cylindrical shadow of the Moon or Earth)? can the lander see the Earth?
    const shadowOf = (centre, radius) => {
      const rel = sub(pos, centre);
      const along = dot(rel, sunDir);
      if (along > 0) return false;
      return norm(sub(rel, scale(sunDir, along))) < radius;
    };
    let sunlit = !(shadowOf([0, 0, 0], R_MOON) || shadowOf(earth, R_EARTH));
    let earthInView = body === 'earth' || segmentClearsSphere(pos, earth, R_MOON - 0.5);
    let local = null;
    if (ph.scene === 'surface') {
      // near the ground the sphere test is meaningless: use the site's own Sun and Earth elevation over the skyline
      local = bodyAzEl(eph, site, Math.min(Math.max(tMs, eph.startMs), eph.endMs));
      if (local) {
        const m = (az) => (typeof mask === 'function' ? mask(az) : mask);
        sunlit = local.sun.elDeg > m(local.sun.azDeg);
        earthInView = local.earth.elDeg > m(local.earth.azDeg);
      }
    }
    return {
      tMs, phase: ph.id, phaseName: ph.name, scene: ph.scene, body, pos, vel, earth, sunDir, altKm, speedKms,
      massKg, propellantKg, dvLeftMs, throttle, thrustDir, sunlit, earthInView, local, tliStageAttached: tMs < t.tliMs + (tliBurnS / 2) * 1000 + 600e3,
      descent: descentSample,
    };
  }

  // Polylines for drawing (MCI km); each sampled densely enough for its scale.
  function track(t0, t1, n) {
    const out = [];
    for (let i = 0; i <= n; i++) out.push(stateAt(t0 + ((t1 - t0) * i) / n).pos);
    return out;
  }
  const tracks = {
    leo: track(t.launchMs, t.tliMs, 120),
    transfer: track(t.tliMs, tA, 600),
    llo: (() => { const out = []; for (let i = 0; i <= 180; i++) out.push(lloAt(tA + (T1 * 1000 * i) / 180).r); return out; })(),
    descentOrbit: track(tDoi, tPdi, 200),
    poweredDescent: dSamples.map((s) => pdToMci(s.r)),
  };

  return {
    ok: true, warnings, vehicle, options: o, site, siteHeightKm, epochMs, requestedLandingMs: landingMs,
    landingShiftS: (tL - landingMs) / 1000, siteFixed: siteF, siteMci,
    times: t, phases, events, budget, descent, transfer: {
      tofS: tr.tofS, vInfKms: tr.vInfKms, perigeeAltKm: o.leoAltKm, apogeeKm: tr.raKm, soiS: tr.soiS, hyperbolaE: tr.eh,
    },
    llo: { radiusKm: r1, periodS: T1, normal: h1, loiterDays: (tDoi - tA) / 86400e3, planeErrDeg, dvPlaneMs },
    descentFrame: { rPdiHat, tPdiHat, h2, pdToMci, pdDirToMci },
    bodies, tracks, stateAt, phaseAt, lloAt,
  };
}

function burnDv(budget, id) {
  return budget.phases.find((p) => p.id === id)?.dvMs ?? 0;
}

// Local east-north-up (metres) at the site, from a Moon-fixed position in km: used by the descent scene.
export function enuAt(siteF, siteRadiusKm, pFixedKm) {
  const up = siteF;
  let east = cross([0, 0, 1], up);
  if (norm(east) < 1e-9) east = [0, 1, 0];
  east = unit(east);
  const north = cross(up, east);
  const d = sub(pFixedKm, scale(up, siteRadiusKm));
  return [dot(d, east) * 1000, dot(d, north) * 1000, dot(d, up) * 1000];
}
