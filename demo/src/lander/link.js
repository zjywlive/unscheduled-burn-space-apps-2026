// Direct-to-Earth radio link of the lander: range, light time, free-space path loss, received power and margin.
// Pure (no DOM). The geometry is real (positions from the mission state, km, Moon-centred); the radio is ASSUMED:
// a generic small lander's S-band downlink into a 34 m deep-space dish. Change RADIO_DEFAULTS to try another one.
import { R_EARTH } from './constants.js';

export const C_KMS = 299792.458;

/** Assumed radio: S-band downlink, 5 W transmitter on a medium-gain antenna, 34 m ground dish, 256 kbit/s. */
export const RADIO_DEFAULTS = {
  band: 'S-band',
  freqMHz: 2200,
  txPowerW: 5,          // 37 dBm
  txGainDbi: 6,         // medium-gain antenna on the lander
  rxGainDbi: 56,        // 34 m dish at 2.2 GHz, about 55 % efficiency
  lossesDb: 3,          // pointing, polarisation, cables
  systemTempK: 40,      // cooled ground receiver
  dataRateBps: 256e3,
  ebN0Db: 3,            // needed per bit with coding
};

const log10 = Math.log10;

/** Free-space path loss in dB for a range in km and a frequency in MHz. */
export function fsplDb(rangeKm, freqMHz) {
  if (!(rangeKm > 0) || !(freqMHz > 0)) return NaN;
  return 20 * log10(rangeKm) + 20 * log10(freqMHz) + 32.45;
}

export const eirpDbm = (r = RADIO_DEFAULTS) => 10 * log10(r.txPowerW * 1000) + r.txGainDbi;

/** Received power needed for the data rate: k·T·Rb·(Eb/N0), in dBm. */
export function requiredDbm(r = RADIO_DEFAULTS) {
  return -198.6 + 10 * log10(r.systemTempK) + 10 * log10(r.dataRateBps) + r.ebN0Db;   // k = −198.6 dBm/Hz/K
}

/** Does the straight segment a → b stay outside the sphere (centre c, radius)? Points in km. */
export function segmentClear(a, b, c, radius) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], m = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const t = dd > 0 ? Math.max(0, Math.min(1, (m[0] * d[0] + m[1] * d[1] + m[2] * d[2]) / dd)) : 0;
  const x = m[0] - d[0] * t, y = m[1] - d[1] * t, z = m[2] - d[2] * t;
  return x * x + y * y + z * z >= radius * radius;
}

/**
 * The link for one moment. pos and earth are positions in km in the same frame (the mission state's st.pos and
 * st.earth). inView is whether the Earth is in sight (the state's own test: the Moon's sphere in flight, the
 * site's terrain skyline on the surface). The range is to the nearest point of the Earth's surface (a station
 * directly under the craft: the best case), never less than 160 km.
 */
export function linkState({ pos, earth, inView = true }, radio = RADIO_DEFAULTS) {
  const centreKm = Math.hypot(pos[0] - earth[0], pos[1] - earth[1], pos[2] - earth[2]);
  const rangeKm = Math.max(160, centreKm - R_EARTH);
  const lossDb = fsplDb(rangeKm, radio.freqMHz);
  const rxDbm = eirpDbm(radio) + radio.rxGainDbi - lossDb - radio.lossesDb;
  const needDbm = requiredDbm(radio);
  const marginDb = rxDbm - needDbm;
  return {
    inView: !!inView, rangeKm, lightTimeS: rangeKm / C_KMS, fsplDb: lossDb,
    rxDbm: inView ? rxDbm : null, needDbm, marginDb: inView ? marginDb : null,
    quality: !inView ? 'none' : marginDb >= 10 ? 'strong' : marginDb >= 3 ? 'ok' : marginDb >= 0 ? 'weak' : 'none',
  };
}

/** Share of the strength bar filled: 0 at no margin (or no line of sight), 1 at 40 dB of margin or more. */
export function strength(link, fullDb = 40) {
  if (!link || link.marginDb === null || !Number.isFinite(link.marginDb)) return 0;
  return Math.max(0, Math.min(1, link.marginDb / fullDb));
}

/** One-line description of the assumed radio, for the card's caption. */
export function radioNote(r = RADIO_DEFAULTS) {
  return `Assumed radio: ${r.band} ${(r.freqMHz / 1000).toFixed(1)} GHz, ${r.txPowerW} W into a ${r.txGainDbi} dBi antenna (EIRP ${eirpDbm(r).toFixed(0)} dBm), 34 m ground dish (${r.rxGainDbi} dBi), ${Math.round(r.dataRateBps / 1000)} kbit/s, ${r.lossesDb} dB other losses. Needs ${requiredDbm(r).toFixed(0)} dBm.`;
}

/** SVG path (d attribute) for a sparkline of received levels; null entries (no line of sight) break the line. */
export function sparkPath(values, w, h, lo, hi) {
  const n = values.length;
  if (n < 2) return '';
  let d = '', pen = false;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) { pen = false; continue; }
    const x = (i / (n - 1)) * w, y = h - Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * h;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}
