// Browser-safe grid search arithmetic for MCP v2 A1. One hourly, left-endpoint visibility series per
// cell; prefix sums, suffix runs and sliding maxima answer many landings without rescanning the sky.
// Hours are raw internally. All stays must fit in the supplied series. No I/O, clock or shared state.
// buildSeries(bits, startMs, stayH) → reusable time index; sampleSeries samples a grid into that index.
// scanLandings(readMetrics, ground, options) → best passing landing, worst slip checks and diagnostics.
import { activeChecks, evaluate } from './criteria.js';

export const SEARCH_HOUR_MS = 3600e3;
export const STATIC_IDS = ['slope_max_deg', 'inside_psr', 'psr_distance_km', 'ice', 'nasa_avg_sun_min', 'nasa_avg_earth_min'];

// Longest run in every width-hour window, O(n). The first run may cross the left boundary; exclude
// it from the deque of ending-run lengths and account for its clipped suffix separately.
function windowRuns(run, width) {
  const n = run.length - 1, out = new Float64Array(n + 1), queue = new Int32Array(n);
  let head = 0, tail = 0, right = 0, length = 0;
  const ending = new Uint32Array(n);
  for (let i = 0; i < n; i++) ending[i] = run[i] ? ++length : (length = 0);
  for (let left = 0; left < n; left++) {
    const end = Math.min(n, left + width);
    while (right < end) {
      while (tail > head && ending[queue[tail - 1]] <= ending[right]) tail--;
      queue[tail++] = right++;
    }
    const boundary = left + run[left];
    while (head < tail && queue[head] < boundary) head++;
    out[left] = Math.max(Math.min(run[left], end - left), head < tail ? ending[queue[head]] : 0);
  }
  return out;
}

export function buildSeries(bits, startMs, stayH) {
  const n = bits.length;
  const states = {};
  for (const [name, mask, dark] of [['sun', 1, false], ['earth', 2, false], ['both', 3, false], ['dark', 1, true]]) {
    const prefix = new Uint32Array(n + 1), run = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + (dark ? !(bits[i] & mask) : (bits[i] & mask) === mask);
    for (let i = n - 1; i >= 0; i--) run[i] = prefix[i + 1] > prefix[i] ? run[i + 1] + 1 : 0;
    states[name] = { prefix, run, longest: Number.isInteger(stayH) ? windowRuns(run, stayH) : null };
  }
  return { bits, startMs, endMs: startMs + n * SEARCH_HOUR_MS, stayH, states };
}

export function sampleSeries(grid, k, dirs, startMs, stayH) {
  const bits = new Uint8Array(dirs.length);
  for (let i = 0; i < dirs.length; i++) bits[i] = grid.visibility(k, dirs[i]);
  return buildSeries(bits, startMs, stayH);
}

const integral = (s, t) => {
  const i = Math.floor(t), f = t - i;
  return s.prefix[i] + (f ? f * (s.prefix[i + 1] - s.prefix[i]) : 0);
};
const runAt = (s, t, end) => Math.max(0, Math.min(end - t, s.run[Math.floor(t)] - (t % 1)));
function longest(s, a, b, stayH) {
  if (Number.isInteger(a) && b - a === stayH && s.longest) return s.longest[a];
  let best = 0;
  for (let i = Math.floor(a); i < b;) {
    if (s.run[i]) { best = Math.max(best, Math.min(i + s.run[i], b) - Math.max(i, a)); i += s.run[i]; }
    else i++;
  }
  return best;
}

export function seriesMetrics(series, landingMs, { continuous_from = 'from_landing', fromMs = null } = {}) {
  const a = (landingMs - series.startMs) / SEARCH_HOUR_MS, b = a + series.stayH;
  if (a < 0 || b > series.bits.length || !(b > a)) return null;
  const t = continuous_from === 'from_time' ? (fromMs - series.startMs) / SEARCH_HOUR_MS : a;
  const out = {
    sun_at_landing: !!(series.bits[Math.floor(a)] & 1), earth_at_landing: !!(series.bits[Math.floor(a)] & 2),
    covered_h: series.stayH, clipped: false, sun_peak_deg: null, earth_peak_deg: null,
  };
  for (const name of ['sun', 'earth', 'both']) {
    const s = series.states[name], max = longest(s, a, b, series.stayH);
    out[`${name}_total_h`] = integral(s, b) - integral(s, a);
    out[`longest_${name}_h`] = max;
    out[`${name}_continuous_h`] = continuous_from === 'within_stay' ? max : t >= a && t < b ? runAt(s, t, b) : 0;
  }
  out.both_from_landing_h = runAt(series.states.both, a, b);
  out.longest_dark_h = longest(series.states.dark, a, b, series.stayH);
  // Diagnostic only: unlike the criteria metric this is not cut at the end of this particular stay.
  out.available_both_from_landing_h = runAt(series.states.both, a, series.bits.length);
  return out;
}

// Same sense as criteria.js, without allocating a result/check array for every grid landing.
export function checkMargin(check, value) {
  if (value == null || Number.isNaN(value)) return -Infinity;
  if (check.kind === 'bool') return value === check.need ? Infinity : -Infinity;
  if (check.kind === 'max') return check.need - value;
  if (check.kind === 'min') return value - check.need;
  return Math.min(value - (check.need.min ?? -Infinity), (check.need.max ?? Infinity) - value);
}
const relative = (ch, value) => checkMargin(ch, value) / Math.max(1, Math.abs(typeof ch.need === 'number' ? ch.need : ch.need.max ?? ch.need.min ?? 1));

export function rankValue(rankBy, checks, worst, metrics, robustnessH) {
  if (rankBy === 'both_continuous') return worst.both_continuous_h ?? metrics.both_continuous_h ?? -Infinity;
  if (rankBy === 'ice_distance') return -(metrics.ice_target_km ?? Infinity);
  if (rankBy === 'robustness') return robustnessH;
  let score = Infinity;
  for (const ch of checks) score = Math.min(score, relative(ch, worst[ch.metric]));
  return score;
}

// One landing/slip set. `worst` is per check, so a two-sided distance keeps the value nearest a bound.
// readMetrics is the hourly series or pointMetrics; this is also used to decide exact candidate passes.
export function landingSet(readMetrics, ground, options, landingMs) {
  const { criteria, offsetsH = [0], rankBy = 'margin', checks = activeChecks(criteria), full = false } = options;
  const worst = {}, matrix = [];
  let firstFailH = null, failReason = null, survives = true, robustnessH = null, nominal = null;
  for (const offsetH of offsetsH) {
    const time = readMetrics(landingMs + offsetH * SEARCH_HOUR_MS);
    // Merge objects only where they are returned (the nominal offset, or full matrices); other offsets read
    // the same values (time over ground, as a spread would) without allocating per landing × offset.
    const first = offsetH === offsetsH[0];
    const m = first || full ? { ...ground, ...time } : null;
    const val = (k) => (m ? m[k] : time && k in time ? time[k] : ground[k]);
    if (first) nominal = m;
    let fail = null;
    for (const ch of checks) {
      const value = val(ch.metric) ?? null;
      if (!(ch.metric in worst) || checkMargin(ch, value) < checkMargin(ch, worst[ch.metric])) worst[ch.metric] = value;
      if (checkMargin(ch, value) < 0 && fail === null) fail = ch.id;
    }
    // Ranking by continuous visibility still uses the worst offset when that check is not active.
    if (!checks.some((ch) => ch.metric === 'both_continuous_h')) {
      worst.both_continuous_h = Math.min(worst.both_continuous_h ?? Infinity, val('both_continuous_h') ?? -Infinity);
    }
    if (!time && fail === null) fail = 'time_coverage';
    if (fail) {
      survives = false;
      if (firstFailH === null) { firstFailH = offsetH; failReason = fail; }
    } else if (firstFailH === null) robustnessH = offsetH;
    if (full) matrix.push({ offset_h: offsetH, metrics: m, eval: evaluate(criteria, m) });
  }
  const metrics = nominal ?? ground;
  return {
    landingMs, metrics, worst, pass: survives, firstFailH, failReason, robustnessH,
    score: rankValue(rankBy, checks, worst, metrics, robustnessH ?? -Infinity),
    tieScore: rankBy === 'robustness' ? rankValue('margin', checks, worst, metrics, robustnessH) : 0,
    failures: checks.reduce((n, ch) => n + (checkMargin(ch, worst[ch.metric]) < 0), 0),
    ...(full ? { matrix } : {}),
  };
}

// Deterministic ties: first landing wins. Diagnostics count distinct cells in the caller, not landings.
export function scanLandings(readMetrics, ground, options) {
  const checks = options.checks ?? activeChecks(options.criteria), opts = { ...options, checks };
  const timeChecks = checks.filter((c) => !STATIC_IDS.includes(c.id));
  const stages = timeChecks.map(() => false), relaxable = {}, achievable = {};
  let best = null, near = null, passingLandings = 0, withinStay = false, slipToH = null, maxRun = null;
  for (const landingMs of options.landings) {
    const r = landingSet(readMetrics, ground, opts, landingMs);
    if (r.pass) { passingLandings++; if (!best || r.score > best.score || (r.score === best.score && r.tieScore > best.tieScore)) best = r; }
    if (!near || r.failures < near.failures || (r.failures === near.failures && (r.score > near.score || (r.score === near.score && r.tieScore > near.tieScore)))) near = r;
    if (r.robustnessH !== null && (slipToH === null || r.robustnessH > slipToH)) slipToH = r.robustnessH;
    const run = r.metrics.available_both_from_landing_h ?? r.metrics.both_from_landing_h;
    if (run != null && (!maxRun || run > maxRun.value)) maxRun = { value: run, landingMs };
    // Funnel time checks apply at the first requested offset; slip is the final all-offset filter.
    let prefixPass = true;
    for (let i = 0; i < timeChecks.length; i++) {
      prefixPass &&= checkMargin(timeChecks[i], r.metrics[timeChecks[i].metric]) >= 0;
      stages[i] ||= prefixPass;
    }
    if (r.failures === 1) {
      const ch = checks.find((c) => checkMargin(c, r.worst[c.metric]) < 0), value = r.worst[ch.metric];
      if (typeof value === 'number' && Number.isFinite(value) && (!relaxable[ch.id] || checkMargin(ch, value) > checkMargin(ch, relaxable[ch.id].value))) {
        relaxable[ch.id] = { value, landingMs };
      }
    }
    if (r.failures <= 1) for (const ch of checks) {
      if (!r.pass && checkMargin(ch, r.worst[ch.metric]) >= 0) continue;
      const value = r.worst[ch.metric];
      if (typeof value === 'number' && Number.isFinite(value) && (!achievable[ch.id] || checkMargin(ch, value) > checkMargin(ch, achievable[ch.id].value))) achievable[ch.id] = { value, landingMs };
    }
    if (options.withinReader && !withinStay) {
      withinStay = landingSet(options.withinReader, ground, opts, landingMs).pass;
    }
  }
  return { best, near, passingLandings, stages, relaxable, achievable, withinStay, slipToH, maxRun };
}

export function inRegion(cell, region = 'cap') {
  if (!(cell.latDeg <= -80)) return false;
  if (region === 'cap') return true;
  if (region.center) return Math.hypot(cell.xKm - region.center.xKm, cell.yKm - region.center.yKm) <= region.within_km;
  const b = region.bbox, lon = ((cell.lonDeg % 360) + 360) % 360;
  const lo = ((b.lon_min % 360) + 360) % 360, hi = ((b.lon_max % 360) + 360) % 360;
  const allLon = Math.abs(b.lon_max - b.lon_min) >= 360;
  return cell.latDeg >= b.lat_min && cell.latDeg <= b.lat_max && (allLon || (lo <= hi ? lon >= lo && lon <= hi : lon >= lo || lon <= hi));
}

export function spacedPicks(rows, count, minKm) {
  const sorted = [...rows].sort((a, b) => b.result.score - a.result.score || (b.result.tieScore ?? 0) - (a.result.tieScore ?? 0) || a.k - b.k);
  const picked = [];
  for (const row of sorted) {
    if (picked.every((p) => Math.hypot(p.site.xKm - row.site.xKm, p.site.yKm - row.site.yKm) >= minKm)) picked.push(row);
    if (picked.length >= count) break;
  }
  return picked;
}
