// The rows of the "Planned vs alternative" comparison (spec §3, §5.1, §7.2, §9.1), as text: pure
// computation, no DOM. Used by the Compare card and the inspector (ui/compare.js, main.js), the verdict
// sentence (verdict.js) and compare_scenarios (tools-core.js), so every place prints the same figures.
import { fmtHours, fmtSpan, fmtDeg, DASH } from './format.js';

const MINUS = '−';
const H = 3600e3;

// Hours as fmtHours shows them, so a change is the difference of the two figures on screen.
const shownHours = (ms) => {
  const v = ms / H;
  return Math.round(v * 10) / 10 >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
};
const sign = (v) => (v > 0 ? '+' : v < 0 ? MINUS : '');

function hoursChange(planned, alt) {
  const a = shownHours(alt), p = shownHours(planned);
  const d = Math.round((a - p) * 10) / 10;
  if (d === 0) return { text: 'no change', diff: 0 };
  // As many decimals as the figures shown: two whole numbers give a whole change, 9.5 and 25 give 15.5.
  const decimals = Number.isInteger(a) && Number.isInteger(p) ? 0 : 1;
  return { text: `${sign(d)}${Math.abs(d).toFixed(decimals)} h`, diff: d };
}

// Spans as fmtSpan rounds them (minutes, 10 minutes, hours), so the change adds up the same way.
const shownSpan = (ms) => {
  if (Math.round(ms / 60e3) < 60) return Math.round(ms / 60e3) * 60e3;
  const tens = Math.round(ms / 600e3) * 600e3;
  return tens < 24 * H ? tens : Math.round(ms / H) * H;
};
const span = (ms) => (ms === 0 ? '0 h' : fmtSpan(ms));

function spanChange(planned, alt) {
  const d = shownSpan(alt) - shownSpan(planned);
  if (d === 0) return { text: 'no change', diff: 0 };
  return { text: `${sign(d)}${span(Math.abs(d))}`, diff: d };
}

function firstSet(s, body) {
  const up = body === 'sun' ? s.sunUpAtLanding : s.earthUpAtLanding;
  const setMs = body === 'sun' ? s.firstSunsetMs : s.firstEarthsetMs;
  const riseMs = body === 'sun' ? s.firstSunriseMs : s.firstEarthriseMs;
  const Name = body === 'sun' ? 'Sun' : 'Earth';
  if (body === 'earth' && !s.earthEverUp && s.peakEarthElDeg < -10) return 'Earth never rises here';
  if (up) return setMs === null ? 'None in stay' : `in ${fmtSpan(setMs - s.startMs)}`;
  if (riseMs === null) return `${Name} is down for the whole stay`;
  return `${Name} is down at landing, rises in ${fmtSpan(riseMs - s.startMs)}`;
}

export function compareRows(planned, alt) {
  const rows = [];
  const add = (label, p, a, change, worse, lead = false) => rows.push({ label, planned: p, alt: alt ? a : DASH, change: alt ? change : '', worse: alt ? worse : false, lead });
  const hoursRow = (label, key, lead) => {
    const c = alt ? hoursChange(planned[key], alt[key]) : { text: '', diff: 0 };
    add(label, fmtHours(planned[key]), alt && fmtHours(alt[key]), c.text, c.diff < 0, lead);
  };
  hoursRow('Both in view', 'bothMs', true);
  hoursRow('Sunlit', 'sunMs');
  hoursRow('Earth in view', 'earthMs');
  const dark = alt ? spanChange(planned.longestDarkMs, alt.longestDarkMs) : { text: '', diff: 0 };
  add('Longest dark', span(planned.longestDarkMs), alt && span(alt.longestDarkMs), dark.text, dark.diff > 0);
  add('First sunset', firstSet(planned, 'sun'), alt && firstSet(alt, 'sun'), '', false);
  add('First Earthset', firstSet(planned, 'earth'), alt && firstSet(alt, 'earth'), '', false);
  let peakChange = '';
  if (alt) {
    const d = Math.round(alt.peakSunElDeg * 10) / 10 - Math.round(planned.peakSunElDeg * 10) / 10;
    peakChange = Math.abs(d) < 0.05 ? 'no change' : `${d > 0 ? '+' : ''}${fmtDeg(d)}`;
  }
  add('Peak Sun elevation', fmtDeg(planned.peakSunElDeg), alt && fmtDeg(alt.peakSunElDeg), peakChange, false);
  return rows;
}
