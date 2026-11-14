// Phase 3 (docs/PHASES.md): energy along a planned route. The drive is run forward in time from a
// departure: at each profile sample the rover's speed (route-plan.js speedFactor), the power it draws and
// the power its panel makes in sunlight give the battery's charge. Below the reserve it parks to charge and
// drives on once the battery is back above the reserve plus a margin. No DOM; runs in Node.
//
// simulateDrive(profile, { mob, power, departMs, sky }) → Drive
//   profile   route-plan.js route.profile: { x, y, km, pitch } per sample, in driving order
//   mob       plan.mobility (speedKmh, climbDeg, descentDeg)
//   power     cleanPower(…): watts, watt-hours, kg (all assumptions, see POWER_DEFAULTS)
//   departMs  departure time (UTC ms)
//   sky(xKm, yKm, tMs) → { sunDeg, earthDeg, azDeg, elDeg } | null: the Sun's and Earth's height above the
//             local skyline (deg; > 0 means in view) and the Sun's azimuth and elevation; null outside the
//             ephemeris
// Drive = { ok, reason (null | 'empty' | 'stuck' | 'ephemeris'), departMs, arriveMs, driveH, waitH,
//           socStart, socMin, socMinKm, socEnd (0–1 of capacity), darkKm, earthKm, km, stops (parking spells),
//           emptyAt ({ x, y, km, tMs } | null), series: { km, soc, lit, tMs } (Float32/Float64 arrays, ≤ 240
//           points, for the chart), perSample: { earth, lit, tMs } (one per profile sample, phase 4) }
import { panelFactor } from './energy.js';
import { speedFactor } from './route-plan.js';

export const G_MOON = 1.62;   // m/s²
// A VIPER-class solar rover. Every figure is an assumption the user can change, not data.
export const POWER_DEFAULTS = Object.freeze({
  panelW: 450,        // rated panel output, Sun on the panel normal
  batteryWh: 4000,    // usable battery capacity
  loadW: 120,         // avionics, heaters, comms: drawn all the time
  driveW: 180,        // extra for driving on the flat
  massKg: 450,        // for the climbing power m·g·v·sin θ
  climbEff: 0.5,      // drivetrain efficiency when climbing
  reserve: 0.2,       // park below this share of the battery
  resumeMargin: 0.25, // drive on once the battery is back above reserve + this share
  attitude: 'track',  // vertical panel turned to the Sun (energy.js)
});

export function cleanPower(p = {}) {
  const d = POWER_DEFAULTS;
  const num = (v, lo, hi, def) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);
  return {
    panelW: num(p.panelW, 0, 1e5, d.panelW), batteryWh: num(p.batteryWh, 1, 1e6, d.batteryWh),
    loadW: num(p.loadW, 0, 1e5, d.loadW), driveW: num(p.driveW, 0, 1e5, d.driveW), massKg: num(p.massKg, 1, 1e5, d.massKg),
    climbEff: num(p.climbEff, 0.05, 1, d.climbEff), reserve: num(p.reserve, 0, 0.9, d.reserve),
    resumeMargin: num(p.resumeMargin, 0.01, 0.9, d.resumeMargin), attitude: ['track', 'flat'].includes(p.attitude) ? p.attitude : d.attitude,
  };
}

// Power drawn while driving on a grade (tan) at a speed (km/h), W.
export function drivePowerW(power, pitchTan, kmh) {
  const climb = pitchTan > 0 ? (power.massKg * G_MOON * (kmh / 3.6) * Math.sin(Math.atan(pitchTan))) / power.climbEff : 0;
  return power.loadW + power.driveW + climb;
}

// Panel output in W at a point and time (0 behind the terrain or below the horizon).
export function panelW(power, s) {
  if (!s || !(s.sunDeg > 0) || !Number.isFinite(s.elDeg)) return 0;
  return power.panelW * panelFactor(power.attitude, s.azDeg, s.elDeg);
}

const PARK_STEP_MS = 15 * 60e3, MAX_WAIT_MS = 30 * 86400e3;

export function simulateDrive(profile, { mob, power: p0, departMs, sky }) {
  const power = cleanPower(p0);
  const cap = power.batteryWh, n = profile?.km?.length ?? 0;
  let t = departMs, soc = cap, socMin = cap, socMinKm = 0, km = 0, driveH = 0, waitMs = 0, darkKm = 0, earthKm = 0;
  const stops = [];
  const sKm = [], sSoc = [], sLit = [], sT = [];
  // phase 4: every sample's Earth visibility and time (0 / NaN where the drive did not get to)
  const per = { earth: new Uint8Array(n), lit: new Uint8Array(n), tMs: new Float64Array(n).fill(NaN) };
  const record = (lit) => { sKm.push(km); sSoc.push(soc / cap); sLit.push(lit ? 1 : 0); sT.push(t); };
  const out = (ok, reason, extra = {}) => {
    const keep = Math.max(1, Math.ceil(sKm.length / 240));
    const pick = (arr, Type) => Type.from(arr.filter((_, i) => i % keep === 0 || i === arr.length - 1));
    return {
      ok, reason, departMs, arriveMs: ok ? t : null, driveH, waitH: waitMs / 3600e3, km,
      socStart: 1, socMin: socMin / cap, socMinKm, socEnd: soc / cap, darkKm, earthKm, stops, emptyAt: null,
      series: { km: pick(sKm, Float32Array), soc: pick(sSoc, Float32Array), lit: pick(sLit, Uint8Array), tMs: pick(sT, Float64Array) },
      perSample: per,
      ...extra,
    };
  };
  const first = n ? sky(profile.x[0], profile.y[0], t) : null;
  if (!first) return out(false, 'ephemeris');
  record(first.sunDeg > 0);
  for (let i = 0; i < n; i++) {
    const x = profile.x[i], y = profile.y[i], dk = profile.km[i], pitch = profile.pitch[i];
    const kmh = mob.speedKmh * speedFactor(pitch, mob), dtH = dk / kmh;
    const s = sky(x, y, t + (dtH * 3600e3) / 2);
    if (!s) return out(false, 'ephemeris');
    const lit = s.sunDeg > 0;
    soc = Math.min(cap, soc + (panelW(power, s) - drivePowerW(power, pitch, kmh)) * dtH);
    t += dtH * 3600e3; km += dk; driveH += dtH;
    if (!lit) darkKm += dk;
    if (s.earthDeg > 0) earthKm += dk;
    per.earth[i] = s.earthDeg > 0 ? 1 : 0; per.lit[i] = lit ? 1 : 0; per.tMs[i] = t - (dtH * 3600e3) / 2;
    if (soc <= 0) { soc = 0; record(lit); return out(false, 'empty', { emptyAt: { x, y, km, tMs: t } }); }
    if (soc < socMin) { socMin = soc; socMinKm = km; }
    record(lit);
    if (soc < power.reserve * cap && i < n - 1) {
      // park here: the load only, charging when lit, until reserve + margin
      const stop = { x, y, km, fromMs: t, toMs: t };
      while (soc < (power.reserve + power.resumeMargin) * cap) {
        const q = sky(x, y, t + PARK_STEP_MS / 2);
        if (!q) return out(false, 'ephemeris');
        soc = Math.min(cap, soc + (panelW(power, q) - power.loadW) * (PARK_STEP_MS / 3600e3));
        t += PARK_STEP_MS; waitMs += PARK_STEP_MS;
        if (soc <= 0) { soc = 0; record(false); stop.toMs = t; stops.push(stop); return out(false, 'empty', { emptyAt: { x, y, km, tMs: t } }); }
        if (soc < socMin) { socMin = soc; socMinKm = km; }
        if (t - stop.fromMs > MAX_WAIT_MS) { stop.toMs = t; stops.push(stop); return out(false, 'stuck'); }
      }
      stop.toMs = t;
      stops.push(stop);
      record(true);
    }
  }
  return out(true, null);
}

// Departures that work: simulateDrive every stepMs over [fromMs, toMs]. → { tried, ok, fromMs, toMs, stepMs,
// best: up to `count` working departures with the highest lowest-battery, at least a day apart }
export function scanDepartures(profile, { mob, power, sky, fromMs, toMs, stepMs = 6 * 3600e3, count = 3 }) {
  const good = [];
  let tried = 0;
  for (let t = fromMs; t <= toMs; t += stepMs) {
    const d = simulateDrive(profile, { mob, power, departMs: t, sky });
    if (d.reason === 'ephemeris') break;
    tried++;
    if (d.ok) good.push({ departMs: t, arriveMs: d.arriveMs, socMin: d.socMin, waitH: d.waitH });
  }
  const best = [];
  for (const g of [...good].sort((a, b) => b.socMin - a.socMin || a.departMs - b.departMs)) {
    if (best.length >= count) break;
    if (best.every((b) => Math.abs(b.departMs - g.departMs) >= 86400e3)) best.push(g);
  }
  best.sort((a, b) => a.departMs - b.departMs);
  return { tried, ok: good.length, fromMs, toMs, stepMs, best };
}

// sky() for simulateDrive from the page's heat grid (heat.js createHeatGrid: skylines per cell), the
// ephemeris and fromXY: the Sun's and Earth's clearance above the cell's skyline, the Sun's az/el.
export function skyFromGrid(grid, eph, bodyAzEl, fromXY) {
  const c = [0, 0];
  return (x, y, tMs) => {
    const d = eph.at(tMs);
    if (!d) return null;
    const k = grid.cellAt(x, y);
    const { latDeg, lonDeg } = fromXY(x, y);
    const r = bodyAzEl(eph, { latDeg, lonDeg }, tMs);
    if (k === null || k === undefined || !r) return { sunDeg: NaN, earthDeg: NaN, azDeg: r?.sun.azDeg ?? null, elDeg: r?.sun.elDeg ?? NaN };
    grid.clearances(k, d, c);
    return { sunDeg: c[0], earthDeg: c[1], azDeg: r.sun.azDeg, elDeg: r.sun.elDeg };
  };
}
