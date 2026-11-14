// Energy planning for one site (phase 4 §6 E): an hourly Sun series over the stay, relative panel power
// for three attitudes by the cosine law, and a battery state-of-charge simulation in relative units.
// No DOM; runs in Node. No watts anywhere: power is a fraction of the panel's rated output, energy and
// battery capacity are in hours of average load.
//
// Units:
//   p_k     relative panel power in hour bin k, 0–1 (1 = rated output, Sun on the panel normal, unshaded)
//   R       panelToLoad, rated panel power ÷ average load (assumed)
//   C       batteryHours, capacity in hours of average load (assumed)
//   f       sleepLoad, load while unlit as a fraction of the average load (assumed)
//   q       initialCharge, 0–1 of C (assumed)
//
// The Sun series takes its lit spans from windows.js visibleIntervals (the same scan as summarize()), so
// Σ litFrac_k · dt_k equals summarize().sunMs exactly for the same site, landing time, stay and skyline.
import { bodyAzEl } from './ephemeris.js';
import { visibleIntervals, totalMs } from './windows.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
export const HOUR_MS = 3600e3;
const DAY_MS = 86400e3;

export const ATTITUDES = ['track', 'fixed', 'flat'];
// Every default here is an assumption, not data; the card labels each one "assumed".
export const ENERGY_DEFAULTS = Object.freeze({
  attitude: 'track',     // vertical panel turned to the Sun's azimuth
  panelToLoad: 2,        // rated panel power ÷ average load
  batteryHours: 24,      // battery capacity, hours of average load
  sleepLoad: 0.1,        // load while unlit, fraction of the average load
  initialCharge: 1,      // battery full at landing
});

export function cleanAssumptions(a = {}) {
  const d = ENERGY_DEFAULTS;
  const num = (v, lo, hi, def) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
  return {
    attitude: ATTITUDES.includes(a.attitude) ? a.attitude : d.attitude,
    panelToLoad: num(a.panelToLoad, 0, 100, d.panelToLoad),
    batteryHours: num(a.batteryHours, 0, 10000, d.batteryHours),
    sleepLoad: num(a.sleepLoad, 0, 1, d.sleepLoad),
    initialCharge: num(a.initialCharge, 0, 1, d.initialCharge),
  };
}

// ---------- geometry ----------

// Sun unit vector in local east-north-up from azimuth (from north, east-positive) and elevation.
// A null azimuth (zenith, or within 1e-4° of the pole) leaves only the vertical component.
function enu(azDeg, elDeg) {
  const ce = Math.cos(elDeg * RAD);
  if (azDeg === null || azDeg === undefined) return [0, 0, Math.sin(elDeg * RAD)];
  return [ce * Math.sin(azDeg * RAD), ce * Math.cos(azDeg * RAD), Math.sin(elDeg * RAD)];
}

// Panel normal from tilt (0° = facing straight up, 90° = vertical) and the azimuth the face points to.
export function panelNormal(tiltDeg, azDeg) {
  const sb = Math.sin(tiltDeg * RAD);
  return [sb * Math.sin(azDeg * RAD), sb * Math.cos(azDeg * RAD), Math.cos(tiltDeg * RAD)];
}

// Cosine of the angle of incidence, floored at 0 (Sun behind the panel face).
export function incidence(normal, azDeg, elDeg) {
  const s = enu(azDeg, elDeg);
  return Math.max(0, normal[0] * s[0] + normal[1] * s[1] + normal[2] * s[2]);
}

// Relative power (0–1) of an unshaded panel for one Sun direction. attitude: 'track' (vertical, turned
// to the Sun's azimuth: cos el), 'flat' (horizontal: sin el), or 'fixed' with { tiltDeg, azDeg }.
export function panelFactor(attitude, azDeg, elDeg, fixed = null) {
  if (attitude === 'track') return Math.max(0, Math.cos(elDeg * RAD));
  if (attitude === 'flat') return Math.max(0, Math.sin(elDeg * RAD));
  if (attitude === 'fixed') return incidence(panelNormal(fixed.tiltDeg, fixed.azDeg), azDeg, elDeg);
  throw new Error(`unknown attitude ${attitude}`);
}

// ---------- the Sun series ----------

// The stay as summarize() sees it: [landingMs, min(landing + stay, ephemeris end)], or null when the
// landing is outside the ephemeris.
export function stayWindow(eph, landingMs, stayDays) {
  if (!(landingMs >= eph.startMs && landingMs < eph.endMs)) return null;
  const wantedEnd = landingMs + stayDays * DAY_MS;
  return { startMs: landingMs, endMs: Math.min(wantedEnd, eph.endMs), clipped: wantedEnd > eph.endMs };
}

// Hour bins over [startMs, endMs]. Each bin: t0, dtH (1, or less for the last), Sun azimuth and elevation
// at the bin midpoint, the skyline height in that azimuth, and litFrac, the share of the bin inside the
// lit intervals of windows.js (Sun above the terrain skyline).
export function sunSeries(eph, site, startMs, endMs, mask = 0, stepMs = HOUR_MS) {
  const intervals = visibleIntervals(eph, site, 'sun', startMs, endMs, mask);
  const maskAt = (az) => (typeof mask === 'function' ? mask(az) : mask);
  const bins = [];
  let j = 0;
  for (let t0 = startMs; t0 < endMs; t0 += stepMs) {
    const t1 = Math.min(t0 + stepMs, endMs);
    let litMs = 0;
    while (j < intervals.length && intervals[j][1] <= t0) j++;
    for (let k = j; k < intervals.length && intervals[k][0] < t1; k++) {
      litMs += Math.max(0, Math.min(t1, intervals[k][1]) - Math.max(t0, intervals[k][0]));
    }
    const r = bodyAzEl(eph, site, (t0 + t1) / 2);
    const azDeg = r ? r.sun.azDeg : null, elDeg = r ? r.sun.elDeg : NaN;
    bins.push({ t0, dtH: (t1 - t0) / HOUR_MS, azDeg, elDeg, skylineDeg: maskAt(azDeg), litFrac: litMs / (t1 - t0) });
  }
  return { startMs, endMs, intervals, litMs: totalMs(intervals), bins };
}

export const litHours = (series) => series.bins.reduce((a, b) => a + b.litFrac * b.dtH, 0);

// Relative power per bin: cosine factor at the bin midpoint × the lit share of the bin (0 behind terrain).
export function powerSeries(series, attitude, fixed = null) {
  return series.bins.map((b) => (b.litFrac > 0 && Number.isFinite(b.elDeg) ? b.litFrac * panelFactor(attitude, b.azDeg, b.elDeg, fixed) : 0));
}

// Energy over the stay in hours at rated power (Σ p_k dt_k).
export const energyOf = (series, power) => power.reduce((a, p, k) => a + p * series.bins[k].dtH, 0);

// ---------- best fixed attitude ----------

// Maximises Σ w_k max(0, n·s_k) over tilt 0–90° and azimuth 0–360°, w_k = litFrac_k dt_k: a 2° grid,
// then a 0.1° grid within ±2° of the best cell. Returns null when the Sun is never up.
export function bestFixed(series) {
  const E = [], N = [], U = [], W = [];
  for (const b of series.bins) {
    const w = b.litFrac * b.dtH;
    if (!(w > 0) || !Number.isFinite(b.elDeg)) continue;
    const s = enu(b.azDeg, b.elDeg);
    E.push(s[0]); N.push(s[1]); U.push(s[2]); W.push(w);
  }
  if (!W.length) return null;
  const n = W.length;
  const energy = (tilt, az) => {
    const sb = Math.sin(tilt * RAD), cb = Math.cos(tilt * RAD);
    const ex = sb * Math.sin(az * RAD), ny = sb * Math.cos(az * RAD);
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const c = ex * E[k] + ny * N[k] + cb * U[k];
      if (c > 0) sum += c * W[k];
    }
    return sum;
  };
  let best = { tiltDeg: 0, azDeg: 0, energyH: energy(0, 0) };
  const search = (t0, t1, a0, a1, step) => {
    for (let t = t0; t <= t1 + 1e-9; t += step) {
      if (t < 0 || t > 90) continue;
      for (let a = a0; a <= a1 + 1e-9; a += step) {
        const e = energy(t, a);
        if (e > best.energyH + 1e-12) best = { tiltDeg: t, azDeg: a, energyH: e };
      }
    }
  };
  search(0, 90, 0, 358, 2);
  const c = { ...best };
  search(c.tiltDeg - 2, c.tiltDeg + 2, c.azDeg - 2, c.azDeg + 2, 0.1);
  const az = ((best.azDeg % 360) + 360) % 360;
  return { tiltDeg: Math.round(best.tiltDeg * 10) / 10, azDeg: Math.round(az * 10) / 10 % 360, energyH: best.energyH };
}

// The panel angle that faces the Sun at one instant (tilt limited to 0–90°: below the horizon the best a
// panel can do is stand vertical), and whether the Sun is above the skyline there.
export function bestAngleAt(eph, site, tMs, mask = 0) {
  const r = bodyAzEl(eph, site, tMs);
  if (!r) return null;
  const { azDeg, elDeg } = r.sun;
  const skylineDeg = typeof mask === 'function' ? mask(azDeg) : mask;
  const lit = elDeg - skylineDeg > 0;
  const tiltDeg = Math.min(90, Math.max(0, 90 - elDeg));
  return {
    tMs, azDeg, elDeg, skylineDeg, lit, tiltDeg,
    track: lit ? panelFactor('track', azDeg, elDeg) : 0,
    flat: lit ? panelFactor('flat', azDeg, elDeg) : 0,
    best: lit ? incidence(panelNormal(tiltDeg, azDeg ?? 0), azDeg, elDeg) : 0,
  };
}

// ---------- battery ----------

// State of charge, hour bin by hour bin, in hours of average load. Per bin:
//   gen  = R p_k dt
//   load = (litFrac + (1 − litFrac) f) dt        (full load while lit, sleep load while unlit)
//   x    = soc + gen − load;  soc' = clamp(x, 0, C);  spilled = max(0, x − C);  unmet = max(0, −x)
// so Σgen − Σload = soc_end − soc_0 + Σspilled − Σunmet. The net rate is constant inside a bin, so the
// time at empty in a bin with unmet > 0 is dt · unmet / (load − gen). Charging hours: the lit part of
// each bin where the panel output R·p_k/litFrac exceeds the full load (surplus, stored or spilled).
export function simulate(series, power, assumptions) {
  const a = cleanAssumptions(assumptions);
  const C = a.batteryHours, R = a.panelToLoad, f = a.sleepLoad;
  const soc = [a.initialCharge * C];
  let gen = 0, load = 0, spilled = 0, unmet = 0, emptyH = 0, chargingH = 0, sleepH = 0, litH = 0;
  const net = [];
  series.bins.forEach((b, k) => {
    const g = R * power[k] * b.dtH;
    const l = (b.litFrac + (1 - b.litFrac) * f) * b.dtH;
    const x = soc[k] + g - l;
    const s = Math.min(C, Math.max(0, x));
    const sp = Math.max(0, x - C), un = Math.max(0, -x);
    soc.push(s);
    gen += g; load += l; spilled += sp; unmet += un;
    if (un > 0) emptyH += (b.dtH * un) / (l - g);
    // charging: the lit part of the bin, when the panel alone covers the full load there
    if (b.litFrac > 0 && R * power[k] > b.litFrac) chargingH += b.litFrac * b.dtH;
    sleepH += (1 - b.litFrac) * b.dtH;
    litH += b.litFrac * b.dtH;
    net.push(g - l);
  });
  return {
    assumptions: a, soc, net,
    generatedH: gen, consumedH: load, spilledH: spilled, unmetH: unmet,
    chargingH, sleepH, litH, emptyH,
    minSocH: Math.min(...soc), endSocH: soc[soc.length - 1],
    minBatteryH: minBattery(net, a.initialCharge),
  };
}

// The smallest capacity C with no outage, for net energy per bin net_k (gen − load) and a battery that
// starts at q·C. With S_t = Σ_{k<t} net_k (S_0 = 0) and the deficit below full D_t, D_0 = (1 − q)C and
// D_t = max(0, D_{t−1} − net_t); an outage happens when D_t > C. That gives
//   C_min = max( max_t(−S_t) / q,  max_{1≤i≤t}(S_i − S_t) ),
// which for a full start (q = 1) is the worst deficit: the largest drop of S from any earlier level.
export function minBattery(net, initialCharge = 1) {
  let S = 0, worstFromStart = 0, peak = -Infinity, worstDrop = 0;
  for (const x of net) {
    S += x;
    worstFromStart = Math.max(worstFromStart, -S);
    if (peak > -Infinity) worstDrop = Math.max(worstDrop, peak - S);
    peak = Math.max(peak, S);
  }
  // with i = 0 included the drop from the start is −S_t, already in worstFromStart
  const fromStart = worstFromStart === 0 ? 0 : initialCharge > 0 ? worstFromStart / initialCharge : Infinity;
  return Math.max(fromStart, worstDrop);
}

// ---------- one scenario, and the pair ----------

// Everything the card shows for one scenario over [startMs, endMs].
// scenario: { site, landingMs, mask }   mask: a skyline function (terrain.js skylineFor) or a constant
export function planEnergy(eph, scenario, endMs, assumptions = {}, { atMs = null } = {}) {
  const a = cleanAssumptions(assumptions);
  const { site, landingMs, mask = 0 } = scenario;
  const series = sunSeries(eph, site, landingMs, endMs, mask);
  const track = powerSeries(series, 'track');
  const flat = powerSeries(series, 'flat');
  const fixedBest = bestFixed(series);
  const fixed = fixedBest ? powerSeries(series, 'fixed', fixedBest) : series.bins.map(() => 0);
  const energy = { track: energyOf(series, track), fixed: fixedBest ? fixedBest.energyH : 0, flat: energyOf(series, flat) };
  const power = { track, fixed, flat }[a.attitude];
  const sim = simulate(series, power, a);
  const lit = series.bins.filter((b) => b.litFrac > 0 && Number.isFinite(b.elDeg));
  return {
    startMs: series.startMs, endMs: series.endMs, stayMs: series.endMs - series.startMs,
    series, litMs: series.litMs, power, energy, sim, assumptions: a,
    bestFixed: fixedBest ? { ...fixedBest, vsTrack: energy.track > 0 ? fixedBest.energyH / energy.track : NaN } : null,
    flatVsTrack: energy.track > 0 ? energy.flat / energy.track : NaN,
    peakLitElDeg: lit.length ? Math.max(...lit.map((b) => b.elDeg)) : NaN,
    now: atMs !== null && atMs >= series.startMs && atMs <= series.endMs ? bestAngleAt(eph, site, atMs, mask) : null,
  };
}

// Planned and alternative over the same number of days, as windows.js summarizePair does: when the
// ephemeris end clips either stay, both are cut to the shorter one. The alternative may be null.
// atMs: an instant in the planned stay; the alternative is read at the same time into its stay.
export function planEnergyPair(eph, planned, alternative, stayDays, assumptions = {}, { atMs = null } = {}) {
  const pw = stayWindow(eph, planned.landingMs, stayDays);
  const aw = alternative ? stayWindow(eph, alternative.landingMs, stayDays) : null;
  let len = stayDays * DAY_MS;
  if (pw) len = Math.min(len, pw.endMs - pw.startMs);
  const lenAlone = len;
  if (pw && aw) len = Math.min(len, aw.endMs - aw.startMs);
  const offset = atMs !== null ? atMs - planned.landingMs : null;
  const p = pw ? planEnergy(eph, planned, planned.landingMs + len, assumptions, { atMs }) : null;
  const a = aw ? planEnergy(eph, alternative, alternative.landingMs + len, assumptions, { atMs: offset !== null ? alternative.landingMs + offset : null }) : null;
  return { planned: p, alt: a, stayDays: len / DAY_MS, cut: !!(pw && aw && len < lenAlone), plannedClipped: !!pw?.clipped };
}
