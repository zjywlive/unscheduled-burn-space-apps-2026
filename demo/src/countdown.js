// The inspector's countdown row ("Sunset in 3 d 4 h · Earthset in 10 d 21 h"), from the compute tier's
// next_events (phase 5 item 12), told relative to the moving playhead.
//
// createCountdown({ run, endMs, onUpdate, schedule }) → { text(site, atMs), reset() }
//   run(name, input) → Promise<result>   core.run of tools-core.js
//   onUpdate()                           called (via schedule, never synchronously) when a new result came in
//   schedule(fn)                         defaults to setTimeout(fn, 0)
//
// One request at a time per place. A result is reused while the playhead stays in [fromMs, untilMs): from the
// minute it was asked for until the next set or rise has passed. next_events gives event times to the
// minute (truncated), so an event lies in [m, m + 60 s) and the cache runs to m + 60 s; at the end of the
// ephemeris, with no event left, the cache never expires. Both rules exist because a cache that is already
// stale when it arrives made each answer ask again at once (an endless chain of promise callbacks that
// froze the page: phase-5 review F1, and a playhead inside the minute of a rise or set, e.g. after the time
// dock's "Next rise or set").
import { fmtSpan } from './format.js';

const MIN = 60e3;
const END_TEXT = '1 Jan 2029';
const iso = (ms) => `${new Date(Math.floor(ms / MIN) * MIN).toISOString().slice(0, 16)}Z`;
const siteKey = (s) => `${s.latDeg.toFixed(5)},${s.lonDeg.toFixed(5)}`;

// The row's text for a next_events result at the instant atMs (the same words as its headline at `at`).
export function countdownFrom(res, atMs, endText = END_TEXT) {
  const one = (b, Name, rise, set) => {
    const r = res[b];
    const nextIso = r.upNow ? r.nextSet?.time : r.nextRise?.time;
    if (!nextIso) return r.upNow ? `${Name} stays up past ${endText}` : `No ${b === 'sun' ? 'sunrise' : 'Earthrise'} before ${endText}`;
    return `${r.upNow ? set : rise} in ${fmtSpan(Math.max(0, Date.parse(nextIso) - atMs))}`;
  };
  return `${one('sun', 'Sun', 'Sunrise', 'Sunset')} · ${one('earth', 'Earth', 'Earthrise', 'Earthset')}`;
}

// The instant after which a result no longer describes the playhead.
export function validUntil(res, fromMs, endMs) {
  let until = Infinity;
  for (const b of ['sun', 'earth']) {
    const next = res[b]?.upNow ? res[b]?.nextSet?.time : res[b]?.nextRise?.time;
    const t = next ? Date.parse(next) : NaN;
    if (Number.isFinite(t) && t < endMs) until = Math.min(until, t + MIN);
  }
  return Math.max(until, fromMs + MIN);   // never already stale, whatever the input
}

export function createCountdown({ run, endMs, onUpdate = () => {}, schedule = (fn) => setTimeout(fn, 0) }) {
  let cache = null, asking = null;
  return {
    text(site, atMs) {
      const key = siteKey(site);
      if (cache && cache.key === key && atMs >= cache.fromMs && atMs < cache.untilMs) return countdownFrom(cache.res, atMs);
      if (!asking || asking.key !== key) {
        const ask = { key, fromMs: Math.floor(atMs / MIN) * MIN };
        asking = ask;
        Promise.resolve(run('next_events', { lat_deg: site.latDeg, lon_deg: site.lonDeg, at: iso(ask.fromMs) })).then((res) => {
          if (asking !== ask) return;
          asking = null;
          cache = res && !res.error ? { key, fromMs: ask.fromMs, untilMs: validUntil(res, ask.fromMs, endMs), res } : null;
          schedule(onUpdate);
        }, () => { if (asking === ask) asking = null; });
      }
      return cache && cache.key === key ? countdownFrom(cache.res, Math.max(cache.fromMs, Math.min(atMs, cache.untilMs))) : '';
    },
    reset() { cache = null; asking = null; },
  };
}
