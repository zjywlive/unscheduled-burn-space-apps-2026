// Landing-date ribbon data (spec phase 2 §3.3): hours with both Sun and Earth in view for a stay
// starting at each UTC midnight of the ephemeris, from one 30-minute timeline and its prefix sums.
import { azEl } from './geometry.js';

const STEP_MS = 30 * 60e3;
const DAY_MS = 86400e3;

export function landingRibbon(eph, site, mask, stayDays) {
  const at = (az) => (typeof mask === 'function' ? mask(az) : mask);
  const n = Math.floor((eph.endMs - eph.startMs) / STEP_MS);
  // prefix[k] = number of half-hours before k with both bodies clear of the skyline (sampled mid-step)
  const prefix = new Uint32Array(n + 1);
  for (let k = 0; k < n; k++) {
    const d = eph.at(eph.startMs + (k + 0.5) * STEP_MS);
    const s = azEl(d.sun, Infinity, site.lonDeg, site.latDeg);
    const e = azEl(d.earth, d.earthRangeKm, site.lonDeg, site.latDeg);
    const both = s.elDeg > at(s.azDeg) && e.elDeg > at(e.azDeg);
    prefix[k + 1] = prefix[k] + (both ? 1 : 0);
  }
  const stayMs = stayDays * DAY_MS;
  const dayMs = [];
  for (let t = Math.ceil(eph.startMs / DAY_MS) * DAY_MS; t + stayMs <= eph.endMs; t += DAY_MS) dayMs.push(t);
  const bothMs = new Float32Array(dayMs.length);
  dayMs.forEach((t, i) => {
    const a = Math.round((t - eph.startMs) / STEP_MS);
    const b = Math.min(n, a + Math.round(stayMs / STEP_MS));
    bothMs[i] = (prefix[b] - prefix[a]) * STEP_MS;
  });
  return { dayMs, bothMs };
}
