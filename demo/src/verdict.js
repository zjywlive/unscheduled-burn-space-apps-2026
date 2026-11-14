// Phase 6 A: the verdict at the top of the point inspector (docs/phase6/brief-opus-stories.md §A, mock
// docs/phase4/mock/personas.html?s=verdict). One sentence that says what the planned-vs-alternative
// comparison means, then, only when the alternative is worse, a "way out": the best landing in the four
// weeks after the alternative's landing, with "Set as alternative".
//
// verdictOf(ctx) → null | { kind, parts: [{ text, tone? }], text }
//   The figures are the inspector table's own (compareRows of the same summaries), so the sentence and the
//   table never disagree. null when there is nothing to say (no mission window).
// fetchWayOut(run, q) → Promise<{ none, reason } | { landingMs, slipDays, bothH, bothText, label, value, title }>
//   run is core.run of tools-core.js (best_landing_dates ranks the days, compare_scenarios gives the figure
//   the table will show once that day is the alternative).
// createWayOutFetcher({ run, onUpdate, schedule }) → { get(key, q), reset() }
//   One request at a time. Every answer for the key in hand is cached, failures included, and the redraw is
//   scheduled after it (never run inside it); an answer for a key no longer asked for is dropped and starts
//   nothing. So a redraw that asks again finds the cache and the chain ends (the phase-5 freeze: an answer
//   that was already stale on arrival asked again at once, for ever; see countdown.js).
import { compareRows } from './compare-rows.js';
import { fmtHours } from './format.js';

const H = 3600e3;
const DAY_MS = 86400e3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WAYOUT_DAYS = 28;
export const SLIP_RANGE = [-60, 60];   // the slip the page accepts (state.js parseHash, the time dock)

const pad2 = (n) => String(n).padStart(2, '0');
export function dayText(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const shortDay = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const isoDay = (ms) => new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
const isoMinute = (ms) => `${new Date(Math.floor(ms / 60e3) * 60e3).toISOString().slice(0, 16)}Z`;
const days = (n) => (n === 1 ? '1 day' : `${n} days`);

// "14-day", "5.5-day", "20-hour" (a stay cut short by the ephemeris end), as finding.js names a stay.
function stayName(stayDays) {
  if (stayDays < 1) return `${Math.max(1, Math.round(stayDays * 24))}-hour`;
  return `${Math.round(stayDays * 10) / 10}-day`;
}
// "6 days", "1 day", "20 hours": the length both stays share when the ephemeris end clips one.
function spanName(stayDays) {
  if (stayDays < 1) { const h = Math.max(1, Math.round(stayDays * 24)); return h === 1 ? '1 hour' : `${h} hours`; }
  const d = Math.round(stayDays * 10) / 10;
  return d === 1 ? '1 day' : `${d} days`;
}

// The subject of the sentence: what the alternative does differently from the plan.
function lead({ sameSite, slipDays, altName }) {
  const n = Math.abs(slipDays);
  if (sameSite) return slipDays > 0 ? `Slipping ${days(n)}` : `Landing ${days(n)} earlier`;
  const at = altName === 'Map point' ? 'the map point' : altName;
  if (slipDays === 0) return `Landing at ${at} instead`;
  return `Landing at ${at} ${days(n)} ${slipDays > 0 ? 'later' : 'earlier'}`;
}

// ctx: { windowOn, planned, alt, cmpPlanned, cmpDays, compared, sameSite, slipDays, altName, stayDays,
//        altLandingMs, ephStartMs, ephEndMs }
export function verdictOf(ctx) {
  const { windowOn, planned, alt, cmpPlanned, cmpDays, compared, sameSite, slipDays, altName, stayDays } = ctx;
  if (!windowOn || !planned) return null;
  const done = (kind, parts) => ({ kind, parts, text: parts.map((p) => p.text).join('') });
  const endText = dayText(ctx.ephEndMs);

  // the alternative lands outside the ephemeris: summarizePair has no alternative stay
  if (alt === null && !(sameSite && slipDays === 0)) {
    const before = Number.isFinite(ctx.altLandingMs) && ctx.altLandingMs < ctx.ephStartMs;
    const where = before ? `before the ephemeris starts (${dayText(ctx.ephStartMs)})` : `after the ephemeris ends (${endText})`;
    return done('outside', [{ text: `${lead({ sameSite, slipDays, altName })} lands ${where}, so there is nothing to compare.` }]);
  }

  // no alternative: say what the planned stay gives
  if (!compared) {
    const both = compareRows(planned, null)[0].planned;
    const cut = planned.clipped;
    const stay = `${cut ? 'the ' : 'this '}${stayName(planned.stayMs / DAY_MS)} stay${cut ? ` left before ${endText}` : ''}`;
    if (planned.bothMs === 0) return done('none', [{ text: `Sun and Earth are never both in view during ${stay}.` }]);
    if (both === fmtHours(planned.stayMs)) return done('none', [{ text: `Sun and Earth are both in view for all of ${stay}.` }]);
    return done('none', [{ text: `Sun and Earth are both in view for ${both} of ${stay}.` }]);
  }

  // compared: the table's lead row, as shown
  const row = compareRows(cmpPlanned, alt)[0];
  const who = lead({ sameSite, slipDays, altName });
  const tail = cmpDays < stayDays - 1e-9 ? `, over the ${spanName(cmpDays)} both stays fit before ${endText}` : '';
  if (row.change === 'no change') return done('same', [{ text: `${who} leaves Sun-and-Earth time unchanged at ${row.planned}${tail}.` }]);
  if (row.worse) {
    return done('worse', [{ text: `${who} cuts Sun-and-Earth time from ${row.planned} to ` }, { text: row.alt, tone: 'worse' }, { text: `${tail}.` }]);
  }
  return done('better', [{ text: `${who} raises Sun-and-Earth time from ${row.planned} to ` }, { text: row.alt, tone: 'better' }, { text: `${tail}.` }]);
}

// What the way-out search needs from the page state, and the cache key that names it.
// q: { site, altSite, landingMs, altLandingMs, stayDays, slipDays, altBothMs }
export function wayOutKey(q) {
  const p = (s) => `${s.latDeg.toFixed(5)},${s.lonDeg.toFixed(5)}`;
  return `${p(q.site)}|${p(q.altSite)}|${q.landingMs}|${q.altLandingMs}|${q.stayDays}|${q.altBothMs}`;
}

export async function fetchWayOut(run, q) {
  const place = (s) => (s.id && s.id !== 'custom' && !String(s.id).startsWith('custom') ? { site_id: s.id } : { lat_deg: s.latDeg, lon_deg: s.lonDeg });
  const fromMs = Math.floor(q.altLandingMs / DAY_MS) * DAY_MS;
  const best = await run('best_landing_dates', {
    ...place(q.altSite), stay_days: q.stayDays, count: 1, from: isoDay(fromMs), to: isoDay(fromMs + WAYOUT_DAYS * DAY_MS),
  });
  if (!best || best.error || !best.candidates?.length) return { none: true, reason: best?.error ?? 'no candidate' };
  // the best day, at the planned landing's time of day: the alternative the button would set
  const dayMs = Date.parse(best.candidates[0].landing);
  const landingMs = dayMs + (q.landingMs - Math.floor(q.landingMs / DAY_MS) * DAY_MS);
  const slipDays = Math.round((landingMs - q.landingMs) / DAY_MS);
  const cmp = await run('compare_scenarios', {
    scenarios: [{ ...place(q.site), landing: isoMinute(q.landingMs) }, { ...place(q.altSite), landing: isoMinute(landingMs) }],
    stay_days: q.stayDays,
  });
  const lead = cmp?.scenarios?.[1]?.vsBaseline?.card?.[0];
  if (!cmp || cmp.error || !lead || lead.label !== 'Both in view') return { none: true, reason: cmp?.error ?? 'no comparison' };
  const bothH = cmp.scenarios[1].bothH;
  // only a day that beats the alternative as shown is a way out
  const altText = fmtHours(q.altBothMs);
  if (!(bothH * H > q.altBothMs) || lead.scenario === altText) return { none: true, reason: 'not better' };
  const time = landingMs % DAY_MS ? ` ${pad2(new Date(landingMs).getUTCHours())}:00` : '';
  const settable = Number.isInteger(slipDays) && slipDays >= SLIP_RANGE[0] && slipDays <= SLIP_RANGE[1] && slipDays !== q.slipDays;
  return {
    none: false, landingMs, slipDays: settable ? slipDays : null, bothH, bothText: lead.scenario,
    label: `Best landing in the 4 weeks after ${shortDay(fromMs)}`,
    value: `${dayText(landingMs)}${time} · ${lead.scenario}`,
    title: `Make ${dayText(landingMs)}${time} the alternative landing (${slipDays > 0 ? '+' : ''}${slipDays} days)`,
  };
}

export function createWayOutFetcher({ run, onUpdate = () => {}, schedule = (fn) => setTimeout(fn, 0), fetch = fetchWayOut }) {
  let cache = null, asking = null;
  return {
    // The way out for q under key: the cached answer, or undefined while it is being asked.
    get(key, q) {
      if (cache && cache.key === key) return cache.value;
      if (!asking || asking.key !== key) {
        const ask = { key };
        asking = ask;
        const settle = (value) => {
          if (asking !== ask) return;   // stale: someone asked for another key since; start nothing
          asking = null;
          cache = { key, value };
          schedule(onUpdate);
        };
        Promise.resolve().then(() => fetch(run, q)).then(settle, (e) => settle({ none: true, reason: String(e?.message ?? e) }));
      }
      return undefined;
    },
    reset() { cache = null; asking = null; },
  };
}
