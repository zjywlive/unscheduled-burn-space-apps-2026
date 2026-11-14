// The one-line finding under the title (spec §9.2).
import { fmtHours, fmtUtc } from './format.js';

const H = 3600e3;

function shift(slipDays) {
  const n = Math.abs(slipDays);
  return `${n === 1 ? '1 day' : `${n} days`} ${slipDays > 0 ? 'later' : 'earlier'}`;
}

// "14-day", "5.5-day"; a stay cut to under a day by the ephemeris end is named in hours.
function stayName(stayDays) {
  if (stayDays < 1) return `${Math.max(1, Math.round(stayDays * 24))}-hour`;
  return `${Math.round(stayDays * 10) / 10}-day`;
}

export function findingSentence({ siteName, altSiteName, sameSite, slipDays, stayDays, plannedBothMs, altBothMs }) {
  const A = fmtHours(plannedBothMs);
  const stay = stayName(stayDays);
  const B = fmtHours(altBothMs);
  if (sameSite && slipDays === 0) return `${siteName} has both Sun and Earth in view for ${A} of the ${stay} stay.`;
  if (sameSite) {
    const diff = altBothMs - plannedBothMs;
    if (Math.abs(diff) < H) return `Landing ${shift(slipDays)} leaves time with both Sun and Earth in view at ${siteName} unchanged at ${A}.`;
    const verb = diff < 0 ? 'cuts' : 'raises';
    return `Landing ${shift(slipDays)} ${verb} time with both Sun and Earth in view at ${siteName} from ${A} to ${B} of the ${stay} stay.`;
  }
  if (slipDays === 0) return `${altSiteName} has both Sun and Earth in view for ${B} over the same ${stay.replace('-day', ' days').replace('-hour', ' hours')}, against ${A} at ${siteName}.`;
  return `${altSiteName}, landing ${shift(slipDays)}, has both Sun and Earth in view for ${B}, against ${A} at ${siteName} as planned.`;
}

// The finding line of the Map view (spec phase 2 §7.2). Shares are fractions of the mapped cells.
export function mapFinding({ mode, stayDays, landingMs, cursorMs, slipDays, share, loses, gains }) {
  const pct = (v) => `${Math.round(v * 100)}%`;
  const stay = stayName(stayDays);
  const date = fmtUtc(landingMs).split(',')[0];
  if (mode === 'sun') return `${pct(share)} of the mapped area is sunlit for at least half of the ${stay} stay from ${date}.`;
  if (mode === 'earth') return `${pct(share)} of the mapped area has Earth in view for at least half of the ${stay} stay from ${date}.`;
  if (mode === 'now') return `At ${fmtUtc(cursorMs)}, ${pct(share)} of the mapped area has both Sun and Earth in view.`;
  if (mode === 'change') {
    if (slipDays === 0) return 'Set a slip to see what changes.';
    return `Landing ${shift(slipDays)}, ${pct(loses)} of the mapped area loses more than a day with both in view, and ${pct(gains)} gains more than a day.`; // taste-skill-ignore: spec §7.2 wording, a measured threshold (24 h), not marketing copy
  }
  return `${pct(share)} of the mapped area has both Sun and Earth in view for at least half of the ${stay} stay from ${date}.`;
}
