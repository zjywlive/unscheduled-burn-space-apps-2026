// Visibility windows, rise/set events and the summary figures for one scenario (spec §7.2).
import { azEl } from './geometry.js';
import { bodyAzEl } from './ephemeris.js';

export const SCAN_STEP_MS = 15 * 60e3;
const BISECT_MS = 60e3;
const DAY_MS = 86400e3;

// Elevation of a body and its clearance above the mask in that body's direction. The mask is a constant
// angle or a function of azimuth (a terrain skyline, spec phase 2 §3).
function sample(eph, site, body, tMs, mask) {
  const d = eph.at(tMs);
  if (!d) return { el: NaN, above: NaN };
  const r = body === 'sun'
    ? azEl(d.sun, Infinity, site.lonDeg, site.latDeg)
    : azEl(d.earth, d.earthRangeKm, site.lonDeg, site.latDeg);
  const m = typeof mask === 'function' ? mask(r.azDeg) : mask;
  return { el: r.elDeg, above: r.elDeg - m };
}

// Scans [startMs, endMs] and returns the intervals where the body clears the mask, plus the peak elevation seen.
function scan(eph, site, body, startMs, endMs, mask) {
  const up = (t) => sample(eph, site, body, t, mask);
  const intervals = [];
  let prevT = startMs;
  let prev = up(startMs);
  let peak = prev.el;
  let openAt = prev.above > 0 ? startMs : null;
  while (prevT < endMs) {
    const t = Math.min(prevT + SCAN_STEP_MS, endMs);
    const cur = up(t);
    peak = Math.max(peak, cur.el);
    const wasUp = prev.above > 0;
    const isUp = cur.above > 0;
    if (wasUp !== isUp) {
      let lo = prevT, hi = t;
      while (hi - lo > BISECT_MS) {
        const mid = (lo + hi) / 2;
        if ((up(mid).above > 0) === wasUp) lo = mid; else hi = mid;
      }
      const cross = Math.round((lo + hi) / 2);
      if (isUp) openAt = cross;
      else { intervals.push([openAt, cross]); openAt = null; }
    }
    prevT = t;
    prev = cur;
  }
  if (openAt !== null) intervals.push([openAt, endMs]);
  return { intervals, peak };
}

export function visibleIntervals(eph, site, body, startMs, endMs, mask) {
  return scan(eph, site, body, startMs, endMs, mask).intervals;
}

export function intersectIntervals(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}

export function totalMs(intervals) {
  return intervals.reduce((sum, [a, b]) => sum + (b - a), 0);
}

export function longestGapMs(intervals, startMs, endMs) {
  let longest = 0;
  let cursor = startMs;
  for (const [a, b] of intervals) {
    longest = Math.max(longest, a - cursor);
    cursor = Math.max(cursor, b);
  }
  return Math.max(longest, endMs - cursor);
}

// With a mask, the series also carries each body's clearance above it (sunAbove, earthAbove).
export function sampleSeries(eph, site, startMs, endMs, stepMs = 3600e3, mask = null) {
  const out = { t: [], sunAz: [], sunEl: [], earthAz: [], earthEl: [] };
  if (mask !== null) { out.sunAbove = []; out.earthAbove = []; }
  const at = (az) => (typeof mask === 'function' ? mask(az) : mask);
  const push = (t) => {
    const r = bodyAzEl(eph, site, t);
    if (!r) return;
    out.t.push(t);
    out.sunAz.push(r.sun.azDeg); out.sunEl.push(r.sun.elDeg);
    out.earthAz.push(r.earth.azDeg); out.earthEl.push(r.earth.elDeg);
    if (mask !== null) { out.sunAbove.push(r.sun.elDeg - at(r.sun.azDeg)); out.earthAbove.push(r.earth.elDeg - at(r.earth.azDeg)); }
  };
  for (let t = startMs; t < endMs; t += stepMs) push(t);
  push(endMs);
  return out;
}

function eventsFor(eph, site, body, intervals, startMs, endMs) {
  const events = [];
  intervals.forEach(([a, b], k) => {
    if (a > startMs) {
      events.push({ tMs: a, body, kind: 'rise', azDeg: bodyAzEl(eph, site, a)[body].azDeg, thenMs: b < endMs ? b - a : null });
    }
    if (b < endMs) {
      const next = intervals[k + 1];
      events.push({ tMs: b, body, kind: 'set', azDeg: bodyAzEl(eph, site, b)[body].azDeg, thenMs: next ? next[0] - b : null });
    }
  });
  return events;
}

export function summarize(eph, site, landingMs, stayDays, mask) {
  // The last ephemeris instant leaves no stay at all, so landing there is out of range too.
  if (!(landingMs >= eph.startMs && landingMs < eph.endMs)) return null;
  const startMs = landingMs;
  const wantedEnd = landingMs + stayDays * DAY_MS;
  const endMs = Math.min(wantedEnd, eph.endMs);
  const sun = scan(eph, site, 'sun', startMs, endMs, mask);
  const earth = scan(eph, site, 'earth', startMs, endMs, mask);
  const sunIntervals = sun.intervals;
  const earthIntervals = earth.intervals;
  const bothIntervals = intersectIntervals(sunIntervals, earthIntervals);
  const firstRise = (iv) => iv.find(([a]) => a > startMs)?.[0] ?? null;
  const firstSet = (iv) => iv.find(([, b]) => b < endMs)?.[1] ?? null;
  const events = [
    ...eventsFor(eph, site, 'sun', sunIntervals, startMs, endMs),
    ...eventsFor(eph, site, 'earth', earthIntervals, startMs, endMs),
  ].sort((x, y) => x.tMs - y.tMs);
  return {
    startMs, endMs, stayMs: endMs - startMs, clipped: wantedEnd > eph.endMs,
    sunIntervals, earthIntervals, bothIntervals,
    sunMs: totalMs(sunIntervals), earthMs: totalMs(earthIntervals), bothMs: totalMs(bothIntervals),
    longestDarkMs: longestGapMs(sunIntervals, startMs, endMs),
    peakSunElDeg: sun.peak,
    peakEarthElDeg: earth.peak,
    sunUpAtLanding: sunIntervals.length > 0 && sunIntervals[0][0] === startMs,
    earthUpAtLanding: earthIntervals.length > 0 && earthIntervals[0][0] === startMs,
    firstSunsetMs: firstSet(sunIntervals), firstSunriseMs: firstRise(sunIntervals),
    firstEarthsetMs: firstSet(earthIntervals), firstEarthriseMs: firstRise(earthIntervals),
    earthEverUp: earthIntervals.length > 0,
    events,
  };
}

// Planned and alternative over the same number of days: when the ephemeris end clips either stay,
// both are cut to the shorter one so the comparison measures the slip, not the clipping.
export function summarizePair(eph, planned, alternative, stayDays, mask) {
  // Each scenario may carry its own mask (its site's skyline); otherwise the shared one applies.
  const pm = planned.mask ?? mask, am = alternative.mask ?? mask;
  let p = summarize(eph, planned.site, planned.landingMs, stayDays, pm);
  let a = summarize(eph, alternative.site, alternative.landingMs, stayDays, am);
  let days = stayDays;
  if (p && a && p.stayMs !== a.stayMs) {
    days = Math.min(p.stayMs, a.stayMs) / DAY_MS;
    p = summarize(eph, planned.site, planned.landingMs, days, pm);
    a = summarize(eph, alternative.site, alternative.landingMs, days, am);
  }
  return { planned: p, alt: a, stayDays: days };
}
