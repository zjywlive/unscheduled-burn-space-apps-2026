// Phase 4 (docs/PHASES.md): surface radio links over real terrain. A link between two antennas above the
// ground: free-space loss plus the loss of the dominant knife edge in the terrain profile between them
// (ITU-R P.526 single knife-edge), with the Moon's curvature. Used for a surface station's coverage and for
// the link along a planned route. No DOM; runs in Node.
//
// Defaults follow Jun et al. (JPL), "A Rapid, Low-Cost Path to Lunar Communication and Navigation with a
// Lunar Surface Station", IEEE Aerospace 2025: station on the Connecting Ridge at (−89.51°, 225°), a 15 m
// mast, the rover's antenna at 2 m, an 8 km coverage radius, UHF 442.5 MHz or S-band 2245 MHz, 0 dBi
// antennas. Transmit power and the receiver threshold are this project's assumptions.
//
// Heights come from h(xKm, yKm) → metres above the 1737.4 km sphere | null (map km, polar stereographic).
import { toXY } from './terrain.js';

export const MOON_R_M = 1737400;
const C = 299792458;
export const BANDS = Object.freeze({ uhf: { label: 'UHF 442.5 MHz', mhz: 442.5 }, s: { label: 'S-band 2245 MHz', mhz: 2245 } });
export const STATION_DEFAULTS = Object.freeze({
  latDeg: -89.51, lonDeg: 225,   // the JPL paper's site on the Connecting Ridge
  mastM: 15, roverM: 2, radiusKm: 8, band: 's',
  txDbm: 30,                     // 1 W (assumed)
  gainsDbi: 0,                   // Tx + Rx antenna gains (JPL paper: 0 and 0)
  thresholdDbm: -110,            // receiver threshold for a usable link (assumed)
});

export function cleanStation(st = {}) {
  const d = STATION_DEFAULTS;
  const num = (v, lo, hi, def) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);
  return {
    latDeg: num(st.latDeg, -90, -80, d.latDeg), lonDeg: ((num(st.lonDeg, -360, 720, d.lonDeg) % 360) + 360) % 360,
    mastM: num(st.mastM, 0, 200, d.mastM), roverM: num(st.roverM, 0, 20, d.roverM), radiusKm: num(st.radiusKm, 1, 40, d.radiusKm),
    band: BANDS[st.band] ? st.band : d.band, txDbm: num(st.txDbm, -30, 60, d.txDbm), gainsDbi: num(st.gainsDbi, -20, 60, d.gainsDbi),
    thresholdDbm: num(st.thresholdDbm, -160, -40, d.thresholdDbm),
  };
}

// Free-space path loss, dB (d in km, f in MHz).
export const fsplDb = (dKm, mhz) => 20 * Math.log10(Math.max(1e-6, dKm)) + 20 * Math.log10(mhz) + 32.45;

// ITU-R P.526 single knife-edge loss J(v), dB (0 for v ≤ −0.78).
export const knifeEdgeDb = (v) => (v <= -0.78 ? 0 : 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) * (v - 0.1) + 1) + v - 0.1));

// The link from antenna a to antenna b ({ x, y } map km, heightM above the ground): the terrain profile
// between them, the dominant knife edge, and the received power. → { distKm, los, clearanceM (the least
// clearance of the straight line over terrain and curvature; < 0 means blocked), v, diffDb, fsplDb, rxDbm }
export function link(h, a, b, { mhz, txDbm, gainsDbi, stepKm = 0.06, maxSteps = 160 }) {
  const ha = h(a.x, a.y), hb = h(b.x, b.y);
  const D = Math.hypot(b.x - a.x, b.y - a.y);   // map km ≈ ground km near the pole (scale factor < 1.008 within 330 km)
  if (ha === null || hb === null || !Number.isFinite(ha) || !Number.isFinite(hb) || !(D > 0)) return null;
  const za = ha + a.heightM, zb = hb + b.heightM, Dm = D * 1000, lambda = C / (mhz * 1e6);
  const n = Math.min(maxSteps, Math.max(2, Math.ceil(D / stepKm)));
  let clear = Infinity, vmax = -Infinity;
  for (let i = 1; i < n; i++) {
    const t = i / n, d1 = t * Dm, d2 = Dm - d1;
    const g = h(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    if (g === null || !Number.isFinite(g)) continue;
    const bulge = (d1 * d2) / (2 * MOON_R_M);           // the sphere rising above the chord
    const obs = g + bulge - (za + (zb - za) * t);         // terrain above the line of sight, m
    if (-obs < clear) clear = -obs;
    const v = obs * Math.sqrt((2 * Dm) / (lambda * d1 * d2));
    if (v > vmax) vmax = v;
  }
  const diff = knifeEdgeDb(vmax), fs = fsplDb(D, mhz);
  return { distKm: D, los: clear > 0, clearanceM: clear, v: vmax, diffDb: diff, fsplDb: fs, rxDbm: txDbm + gainsDbi - fs - diff };
}

// Coverage of a surface station: received power at the rover's antenna height on a square grid of cellKm
// within radiusKm. → { x0, y0, cellKm, n (cells a side), rx: Float32Array (dBm, NaN off the terrain or
// outside the radius), los: Uint8Array, station: { x, y }, losShare, linkShare (≥ threshold) }
export function coverage(h, station, { cellKm = 0.15 } = {}) {
  const st = cleanStation(station), mhz = BANDS[st.band].mhz;
  const [sx, sy] = toXY(st.latDeg, st.lonDeg);
  const n = Math.ceil((2 * st.radiusKm) / cellKm), x0 = sx - (n * cellKm) / 2, y0 = sy + (n * cellKm) / 2;
  const rx = new Float32Array(n * n).fill(NaN), los = new Uint8Array(n * n);
  let inside = 0, seen = 0, linked = 0;
  const a = { x: sx, y: sy, heightM: st.mastM };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = x0 + (i + 0.5) * cellKm, y = y0 - (j + 0.5) * cellKm;
    if (Math.hypot(x - sx, y - sy) > st.radiusKm) continue;
    const L = link(h, a, { x, y, heightM: st.roverM }, { mhz, txDbm: st.txDbm, gainsDbi: st.gainsDbi, maxSteps: 120 });
    if (!L) continue;
    inside++;
    rx[j * n + i] = L.rxDbm;
    if (L.los) { los[j * n + i] = 1; seen++; }
    if (L.rxDbm >= st.thresholdDbm) linked++;
  }
  return { x0, y0, cellKm, n, rx, los, station: { x: sx, y: sy }, losShare: inside ? seen / inside : 0, linkShare: inside ? linked / inside : 0, settings: st };
}

// The station link at every sample of a route profile (route-plan.js route.profile), with no limit on the
// distance (beyond the radius the link is still computed; it just weakens). → { rx: Float32Array, los,
// ok (≥ threshold): Uint8Array }
export function routeLinks(h, profile, station) {
  const st = cleanStation(station), mhz = BANDS[st.band].mhz;
  const [sx, sy] = toXY(st.latDeg, st.lonDeg);
  const n = profile.x.length, rx = new Float32Array(n).fill(NaN), los = new Uint8Array(n), ok = new Uint8Array(n);
  const a = { x: sx, y: sy, heightM: st.mastM };
  for (let i = 0; i < n; i++) {
    const L = link(h, a, { x: profile.x[i], y: profile.y[i], heightM: st.roverM }, { mhz, txDbm: st.txDbm, gainsDbi: st.gainsDbi, stepKm: 0.08, maxSteps: 200 });
    if (!L) continue;
    rx[i] = L.rxDbm; los[i] = L.los ? 1 : 0; ok[i] = L.rxDbm >= st.thresholdDbm ? 1 : 0;
  }
  return { rx, los, ok, settings: st };
}

// Link summary along a route: km with the station link, with Earth in view, with either, and the longest
// stretch with neither (km, and hours when the drive gives times). earth: Uint8Array per sample or null.
export function linkSummary(profile, station, earth = null, tMs = null) {
  const n = profile.km.length;
  let total = 0, stKm = 0, eaKm = 0, anyKm = 0, gap = 0, gapMax = 0, gapStartT = null, gapMaxH = 0;
  for (let i = 0; i < n; i++) {
    const dk = profile.km[i], s = station?.ok[i] === 1, e = earth ? earth[i] === 1 : false;
    total += dk;
    if (s) stKm += dk;
    if (e) eaKm += dk;
    if (s || e) { anyKm += dk; gap = 0; gapStartT = null; continue; }
    gap += dk;
    if (tMs && gapStartT === null) gapStartT = tMs[i];
    if (gap > gapMax) { gapMax = gap; if (tMs) gapMaxH = (tMs[i] - gapStartT) / 3600e3; }
  }
  return { totalKm: total, stationKm: stKm, earthKm: earth ? eaKm : null, anyKm, gapKm: gapMax, gapH: tMs ? gapMaxH : null };
}
