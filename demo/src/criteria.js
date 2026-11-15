// The constraint language shared by the v2 tools (docs/mcp-v2/DESIGN.md §2, §5): find_landing_sites,
// check_slip_robustness, landing_windows and mission_check all take the same `criteria` object and report
// every check the same way. This module only parses, fills defaults, evaluates and finds the limiting
// check; it computes no geometry. The numbers come from search.js (2 km grid) or point-eval.js (one place).
//
//   resolveCriteria(input) → { criteria, assumed[], error? }        input: the tool's `criteria` object
//   evaluate(criteria, metrics) → { pass, checks[], limiting, tightest }
//   activeChecks(criteria) → [{ id, metric, kind, need }]           the checks a criteria object implies
//
// metrics (one place, one landing; null or missing = not available, never guessed):
//   slope_deg, psr_km (0 = inside a PSR), inside_psr, ice_target_km (to the nearest target of criteria.ice),
//   nasa_avg_sun, nasa_avg_earth (0–1), both_continuous_h, sun_continuous_h, earth_continuous_h (counted
//   per criteria.continuous_from), both_total_h, sun_total_h, earth_total_h, sun_at_landing, earth_at_landing,
//   longest_dark_h, sun_peak_deg, earth_peak_deg (highest elevation above the smooth horizon in the stay)

export const CONTINUOUS_FROM = ['from_landing', 'within_stay', 'from_time'];
export const ICE_CLASSES = ['surface', 'shallow', 'any'];
export const SLOPE_SCALES = ['2km', '1km', '240m'];

// Presets (resource lsn://criteria/presets). Explicit fields override a preset field by field.
export const PRESETS = {
  lander_dte: {
    text: 'A generic solar lander talking direct to Earth: Sun and Earth both in view at touchdown and together for at least 72 h from it, no night longer than an assumed 24 h battery, 2 km mean slope ≤ 8°.',
    criteria: { sun_at_landing: true, earth_at_landing: true, continuous_from: 'from_landing', both_continuous_h_min: 72, longest_dark_h_max: 24, slope_max_deg: 8 },
  },
  long_stay_dte: {
    text: 'lander_dte for a long stay: Sun and Earth together for at least 300 h from touchdown.',
    criteria: { sun_at_landing: true, earth_at_landing: true, continuous_from: 'from_landing', both_continuous_h_min: 300, longest_dark_h_max: 24, slope_max_deg: 8 },
  },
  ice_prospector: {
    text: 'lander_dte plus a thermally stable shallow-ice target (ice table ≤ 1 m) within 5 km of the site, and 2 km mean slope ≤ 5°. The site itself stays in sunlight; the ice is a rover target.',
    criteria: { sun_at_landing: true, earth_at_landing: true, continuous_from: 'from_landing', both_continuous_h_min: 72, longest_dark_h_max: 24, slope_max_deg: 5, inside_psr: false, ice: { class: 'shallow', within_km: 5, depth_max_m: 1 } },
  },
  relay_ok: {
    text: 'A lander that talks through a relay (Earth not required): Sun in view at touchdown and for at least 72 h from it, no night longer than an assumed 24 h battery, slope ≤ 8°.',
    criteria: { sun_at_landing: true, continuous_from: 'from_landing', sun_continuous_h_min: 72, longest_dark_h_max: 24, slope_max_deg: 8 },
  },
  sun_never_sets: {
    text: 'The Sun never sets during the stay: in view at touchdown and no darkness at all (longest dark 0 h).',
    criteria: { sun_at_landing: true, longest_dark_h_max: 0 },
  },
};

export const DEFAULT_STAY_DAYS = 14;

// [id, metric, kind]: kind max (value ≤ need), min (value ≥ need), range ({min,max}), bool (value === need)
const CHECKS = [
  ['slope_max_deg', 'slope_deg', 'max'],
  ['inside_psr', 'inside_psr', 'bool'],
  ['psr_distance_km', 'psr_km', 'range'],
  ['ice', 'ice_target_km', 'ice'],
  ['nasa_avg_sun_min', 'nasa_avg_sun', 'min'],
  ['nasa_avg_earth_min', 'nasa_avg_earth', 'min'],
  ['sun_at_landing', 'sun_at_landing', 'bool'],
  ['earth_at_landing', 'earth_at_landing', 'bool'],
  ['both_continuous_h_min', 'both_continuous_h', 'min'],
  ['sun_continuous_h_min', 'sun_continuous_h', 'min'],
  ['earth_continuous_h_min', 'earth_continuous_h', 'min'],
  ['both_total_h_min', 'both_total_h', 'min'],
  ['sun_total_h_min', 'sun_total_h', 'min'],
  ['earth_total_h_min', 'earth_total_h', 'min'],
  ['longest_dark_h_max', 'longest_dark_h', 'max'],
  ['sun_elevation_min_deg', 'sun_peak_deg', 'min'],
  ['earth_elevation_min_deg', 'earth_peak_deg', 'min'],
];
export const CHECK_IDS = CHECKS.map((c) => c[0]);

const num = (description, extra = {}) => ({ type: ['number', 'null'], description, ...extra });
// JSON Schema (the tools-core.js subset) of the `criteria` input.
export const CRITERIA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [],
  description: 'Constraints every candidate must meet (docs: lsn://criteria/presets). A preset fills defaults; any field given here overrides it. Use null to switch a preset check off.',
  properties: {
    preset: { type: 'string', enum: Object.keys(PRESETS), description: `Start from a preset: ${Object.keys(PRESETS).join(', ')}.` },
    slope_max_deg: num('Flat: 2 km cell mean slope at most this, degrees (an assumption, not data).', { minimum: 0, maximum: 45 }),
    slope_scale: { type: 'string', enum: SLOPE_SCALES, description: 'Slope used for the check: 2km (default, the screen), 1km, 240m (point).' },
    inside_psr: { type: ['boolean', 'null'], description: 'true = the site must be inside a permanently shadowed region, false = outside.' },
    psr_distance_km: { type: ['object', 'null'], additionalProperties: false, required: [], properties: { min: num('km, inclusive', { minimum: 0 }), max: num('km, inclusive', { minimum: 0 }) }, description: 'Distance from the site to the nearest PSR patch of at least 1 km² (0 inside). "Near a PSR" = { max: 5 } with inside_psr false.' },
    ice: { type: ['object', 'null'], additionalProperties: false, required: [], properties: {
      class: { type: 'string', enum: ICE_CLASSES, description: 'surface = ice stable at the surface; shallow = ice table at most depth_max_m deep; any = either.' },
      within_km: num('A target of that class within this distance of the site, km. Default 5.', { minimum: 0, maximum: 100 }),
      depth_max_m: num('Deepest ice table that counts as shallow, m. Default 1 (an assumption: drill reach).', { minimum: 0, maximum: 10 }),
    }, description: 'Possible water ice = thermally stable ice (not detected ice) at a rover target near the site.' },
    nasa_avg_sun_min: num('NASA 18.6-year average Sun share at least this, 0–1 (any part of the disc).', { minimum: 0, maximum: 1 }),
    nasa_avg_earth_min: num('NASA 18.6-year average Earth share at least this, 0–1.', { minimum: 0, maximum: 1 }),
    continuous_from: { type: 'string', enum: CONTINUOUS_FROM, description: 'How continuous hours are counted: from_landing (default: the run that starts at touchdown), within_stay (the longest run anywhere in the stay), from_time (the run that starts at from_time).' },
    from_time: { type: 'string', description: 'With continuous_from = from_time: the instant the run must start at, UTC.' },
    both_continuous_h_min: num('Sun and Earth together in view without a break for at least this many hours.', { minimum: 0, maximum: 1500 }),
    sun_continuous_h_min: num('Sun in view without a break, hours.', { minimum: 0, maximum: 1500 }),
    earth_continuous_h_min: num('Earth in view without a break, hours.', { minimum: 0, maximum: 1500 }),
    both_total_h_min: num('Total hours with both in view during the stay.', { minimum: 0, maximum: 1500 }),
    sun_total_h_min: num('Total sunlit hours during the stay.', { minimum: 0, maximum: 1500 }),
    earth_total_h_min: num('Total hours with Earth in view during the stay.', { minimum: 0, maximum: 1500 }),
    sun_at_landing: { type: ['boolean', 'null'], description: 'true = the Sun must be in view at touchdown.' },
    earth_at_landing: { type: ['boolean', 'null'], description: 'true = Earth must be in view at touchdown.' },
    longest_dark_h_max: num('Longest time without the Sun during the stay at most this, hours (battery hours: an assumption).', { minimum: 0, maximum: 1500 }),
    sun_elevation_min_deg: num('The Sun\'s highest elevation in the stay at least this, degrees.', { minimum: -10, maximum: 30 }),
    earth_elevation_min_deg: num('Earth\'s highest elevation in the stay at least this, degrees.', { minimum: -10, maximum: 30 }),
    stay_days: num('Stay length in days. Default 14; lengthened automatically when a continuous-hours check needs more.', { minimum: 1, maximum: 60 }),
  },
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const r1 = (v) => Math.round(v * 10) / 10;

// input (or undefined) → { criteria, assumed[] } | { error }. Unknown presets and keys are errors.
export function resolveCriteria(input = {}) {
  if (input !== undefined && input !== null && !isObj(input)) return { error: 'criteria must be an object.' };
  const given = { ...(input ?? {}) };
  const assumed = [];
  let base = {};
  if (given.preset !== undefined) {
    const p = PRESETS[given.preset];
    if (!p) return { error: `Unknown preset ${given.preset}. Presets: ${Object.keys(PRESETS).join(', ')}.` };
    base = structuredClone(p.criteria);
    assumed.push(`preset ${given.preset}: ${p.text}`);
  }
  for (const k of Object.keys(given)) if (k !== 'preset' && !(k in CRITERIA_SCHEMA.properties)) return { error: `Unknown criteria field ${k}.` };
  const c = { ...base };
  for (const [k, v] of Object.entries(given)) {
    if (k === 'preset') continue;
    if (k === 'ice' && isObj(v) && isObj(base.ice)) c.ice = { ...base.ice, ...v };
    else c[k] = v;
  }
  if (given.preset !== undefined) c.preset = given.preset;
  // defaults and normalisation
  c.continuous_from ??= 'from_landing';
  if (!CONTINUOUS_FROM.includes(c.continuous_from)) return { error: `continuous_from must be one of ${CONTINUOUS_FROM.join(', ')}.` };
  if (c.continuous_from === 'from_time' && typeof c.from_time !== 'string') return { error: 'continuous_from = from_time needs from_time (UTC instant).' };
  c.slope_scale ??= '2km';
  if (isObj(c.ice)) {
    c.ice = { class: c.ice.class ?? 'shallow', within_km: c.ice.within_km ?? 5, depth_max_m: c.ice.depth_max_m ?? 1 };
    if (!ICE_CLASSES.includes(c.ice.class)) return { error: `ice.class must be one of ${ICE_CLASSES.join(', ')}.` };
  }
  if (isObj(c.psr_distance_km)) {
    const { min = null, max = null } = c.psr_distance_km;
    if (min === null && max === null) c.psr_distance_km = null;
    else if (min !== null && max !== null && min > max) return { error: 'psr_distance_km.min is larger than max.' };
    else c.psr_distance_km = { min, max };
  }
  const stayGiven = c.stay_days !== undefined && c.stay_days !== null;
  c.stay_days = stayGiven ? c.stay_days : DEFAULT_STAY_DAYS;
  // a continuous run cannot be longer than the stay it is counted in
  const longest = Math.max(c.both_continuous_h_min ?? 0, c.sun_continuous_h_min ?? 0, c.earth_continuous_h_min ?? 0);
  if (longest > c.stay_days * 24) {
    const need = Math.ceil(longest / 24);
    if (stayGiven) assumed.push(`A ${longest} h continuous run needs a stay of at least ${need} days; the stay given is ${c.stay_days} days, so that check cannot pass.`);
    else { c.stay_days = Math.min(60, need); assumed.push(`stay lengthened to ${c.stay_days} days so that a ${longest} h continuous run fits`); }
  }
  // the readings an answer must name
  if (c.slope_max_deg != null) assumed.push(`flat = ${c.slope_scale === '240m' ? '240 m point' : c.slope_scale === '1km' ? '1 km cell mean' : '2 km cell mean'} slope ≤ ${c.slope_max_deg}° (a chosen limit, not data)`);
  if (['both_continuous_h_min', 'sun_continuous_h_min', 'earth_continuous_h_min'].some((k) => c[k] != null)) {
    assumed.push({
      from_landing: 'continuous hours are counted from touchdown (the lander needs power and a link as soon as it lands)',
      within_stay: 'continuous hours = the longest unbroken run anywhere in the stay',
      from_time: `continuous hours are counted from ${c.from_time}`,
    }[c.continuous_from]);
  }
  if (c.longest_dark_h_max != null && c.longest_dark_h_max > 0) assumed.push(`battery rides through at most ${c.longest_dark_h_max} h of darkness (an assumption)`);
  if (isObj(c.ice)) assumed.push(`possible ice = thermally stable ${c.ice.class === 'surface' ? 'surface ice' : c.ice.class === 'shallow' ? `ice within ${c.ice.depth_max_m} m of the surface` : 'ice (surface or shallow)'} within ${c.ice.within_km} km (stability, not detection)`);
  if (c.psr_distance_km) assumed.push(`near a PSR = ${c.psr_distance_km.min != null ? `${c.psr_distance_km.min}–` : '≤ '}${c.psr_distance_km.max ?? '∞'} km from a PSR patch of at least 1 km²`);
  assumed.push(`stay ${c.stay_days} days`);
  return { criteria: c, assumed };
}

// The checks a resolved criteria object implies, in a stable order.
export function activeChecks(c) {
  const out = [];
  for (const [id, metric, kind] of CHECKS) {
    const need = c[id];
    if (need === undefined || need === null) continue;
    if (kind === 'bool' && id !== 'inside_psr' && need === false) continue;   // "sun_at_landing: false" = not required
    if (kind === 'ice') { if (isObj(need)) out.push({ id, metric, kind: 'max', need: need.within_km }); continue; }
    if (kind === 'range') { if (isObj(need)) out.push({ id, metric, kind, need }); continue; }
    out.push({ id, metric, kind, need });
  }
  return out;
}

function one(check, value) {
  const { id, kind, need } = check;
  const base = { id, need, value: value ?? null };
  if (value === undefined || value === null || Number.isNaN(value)) return { ...base, value: null, margin: null, pass: false, unavailable: true };
  // ±Infinity: nothing found within the search radius (e.g. no ice target): a real "beyond", not missing data
  if (value === Infinity || value === -Infinity) return { ...base, value: null, beyond: true, margin: null, pass: kind === 'max' ? value < 0 : value > 0 };
  if (kind === 'bool') return { ...base, margin: null, pass: value === need };
  if (kind === 'max') return { ...base, margin: r1(need - value), pass: value <= need };
  if (kind === 'min') return { ...base, margin: r1(value - need), pass: value >= need };
  // range
  const lo = need.min ?? -Infinity, hi = need.max ?? Infinity;
  const margin = Math.min(value - lo, hi - value);
  return { ...base, margin: Number.isFinite(margin) ? r1(margin) : null, pass: value >= lo && value <= hi };
}

// A margin made comparable across checks: hours, degrees and km over the size of the need (at least 1).
function relative(ch) {
  if (ch.margin === null) return ch.pass ? Infinity : -Infinity;
  const scale = typeof ch.need === 'number' ? Math.max(1, Math.abs(ch.need)) : Math.max(1, Math.abs(ch.need?.max ?? ch.need?.min ?? 1));
  return ch.margin / scale;
}

// One place, one landing. limiting = the worst failing check (null when all pass);
// tightest = the passing check closest to failing (null when none has a margin).
export function evaluate(c, metrics = {}) {
  const checks = activeChecks(c).map((ch) => one(ch, metrics[ch.metric]));
  const failing = checks.filter((ch) => !ch.pass);
  const pick = (list) => list.reduce((best, ch) => (best === null || relative(ch) < relative(best) ? ch : best), null);
  const limiting = pick(failing);
  const tightest = pick(checks.filter((ch) => ch.pass && ch.margin !== null));
  return { pass: failing.length === 0, checks, limiting: limiting?.id ?? null, tightest: tightest?.id ?? null };
}

// The one check a result fails, when it fails exactly one (near misses).
export function onlyFailure(result) {
  const f = result.checks.filter((ch) => !ch.pass);
  return f.length === 1 ? f[0] : null;
}
