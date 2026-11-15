// The compute tier of the command layer (task book phase 5 §3 item 11): twelve stateless tools that take
// their place and time in the input and return plain JSON. They never read or change page state, so the
// built-in assistant (and later an MCP server) can compare many site-and-date scenarios without driving
// the page. Every number comes from the product's own functions (windows.js, ribbon.js, energy.js,
// relay.js, route-plan.js, terrain.js, psr.js, nasa-avg.js); nothing is recomputed here.
//
// createCoreTools(ctx) → { list, specs(), toolDefinitions(), run(name, input) → Promise<result | { error }> }
//
// ctx (the page passes what main.js already holds; tools/core-context.mjs builds it in Node):
//   eph          required. ephemeris.js createEphemeris(ephemeris.json)
//   sites        required. sites.json array
//   dem          optional. terrain.js createDem of dem_480m (meta.dem): the site skyline and the point height
//   skylineFor   optional. (site) → mask function of azimuth with .profile (terrain.js skylineFor contract).
//                Default: a cached skylineFor(ctx.dem, site). The page passes main.js sky() so both share one cache.
//   coarse       optional. main.js `coarse`: { grid: createHeatGrid(horizon_grid), slope: staticGrid(slope_2km,
//                0.25), shadow: staticGrid(shadow_2km, 1) }: cell slope, PSR distance, route Sun shares
//   dem240       optional. the dem_240m level, or () → level | Promise<level> (the page loads it on demand:
//                main.js dem240()). Point slope on the planner grid and route_candidates.
//   psr          optional. psr.js createPsr, or () → psr | null (the page loads it lazily)
//   nasa         optional. nasa-avg.js createNasaAvg, or () → nasa | null
// Anything missing makes the tools that need it say "not available" (as data); no value is invented.
import { bodyAzEl } from './ephemeris.js';
import { summarize, summarizePair, visibleIntervals } from './windows.js';
import { skylineFor, toXY, fromXY, TERRAIN_MAX_LAT, OBSERVER_M } from './terrain.js';
import { landingRibbon } from './ribbon.js';
import { planEnergyPair, ATTITUDES } from './energy.js';
import { PRESETS, validateElements, relayForSummary } from './relay.js';
import { planRoutes, sunFromJobs, simplify, slopeAt, corridorPadKm, DEFAULT_MAX_SLOPE } from './route-plan.js';
import { fractionJob } from './heat.js';
import { parseLat, parseLon } from './coords.js';
import { formatCoords } from './sites.js';
import { fmtHours, fmtSpan, fmtDeg } from './format.js';
import { compareRows } from './compare-rows.js';
import { createRefs, REF_FIELDS } from './tools-v2/refs.js';

const DAY_MS = 86400e3;
const HOUR_MS = 3600e3;
export const CORE_MAX_SCENARIOS = 24;
export const CORE_MAX_TIMES = 48;
const SKYLINE_CACHE = 256;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?\s*(Z|UTC)?$/i;
const EVENT_NAMES = { sun: { rise: 'Sunrise', set: 'Sunset' }, earth: { rise: 'Earthrise', set: 'Earthset' } };

// ---------- schemas (the commands.js subset of JSON Schema) ----------
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const SITE_ID = { type: 'string', description: 'Site id from list_sites, for example "shackleton".' };
const LAT = { type: ['number', 'string'], description: 'Latitude, south negative: -89.45, "89.45S" or "89.45°S".' };
const LON = { type: ['number', 'string'], description: 'Longitude: east 0–360 (222.69), negative or "137.31W" for west.' };
const PLACE = { site_id: SITE_ID, lat_deg: LAT, lon_deg: LON };
const PLACE_OBJ = { ...obj(PLACE), description: 'A place: { site_id } or { lat_deg, lon_deg }.' };
// v2 (createCoreTools with extensions): every place may also name a held result (tools-v2/refs.js).
const PLACE_REFS = {
  candidate: { type: 'string', description: 'A candidate of the latest find_landing_sites, e.g. "S1" (with search_id: of that search).' },
  search_id: { type: 'string', description: 'With candidate: the find_landing_sites search it belongs to.' },
  mission_point: { type: 'string', description: 'A point of the open mission (mission_open): landing, touchdown, start, end, W1…, stop1…, haven1…, empty, or a name the user gave.' },
  mission_id: { type: 'string', description: 'With mission_point: the mission it belongs to (default: the latest mission_open).' },
};
// Adds PLACE_REFS to every object schema that takes a place (site_id with lat_deg), at any depth.
function withPlaceRefs(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(withPlaceRefs);
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = k === 'enum' ? v : withPlaceRefs(v);
  if (out.properties?.site_id && out.properties?.lat_deg) {
    out.properties = { ...out.properties, ...PLACE_REFS };
    if (typeof out.description === 'string' && out.description.startsWith('A place:')) out.description = 'A place: { site_id }, { lat_deg, lon_deg }, { candidate: "S1" } or { mission_point: "W2" }.';
  }
  return out;
}
const REFS = new WeakMap();
const PLACE_KEYS = ['site_id', 'lat_deg', 'lon_deg', ...REF_FIELDS];
const namesPlace = (o) => PLACE_KEYS.some((k) => o[k] !== undefined);
const placeOf = (o) => Object.fromEntries(PLACE_KEYS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const LANDING = { type: 'string', description: 'Landing time, UTC: 2027-01-13 or 2027-01-13T06:00Z. Snapped down to the whole hour, as the page does.' };
const INSTANT = { type: 'string', description: 'Instant, UTC: 2027-01-20T14:30Z (or a date for 00:00).' };
const STAY = { type: 'number', minimum: 1, maximum: 60, description: 'Stay length in days (the page offers 7, 14 and 30). Default 14.' };
const SCENARIO = obj({ ...PLACE, landing: LANDING, stay_days: STAY }, ['landing']);
const SCENARIO_SET = {
  scenarios: { type: 'array', minItems: 1, maxItems: CORE_MAX_SCENARIOS, items: SCENARIO, description: `Up to ${CORE_MAX_SCENARIOS} scenarios, each a place and a landing.` },
  places: { type: 'array', minItems: 1, maxItems: CORE_MAX_SCENARIOS, items: PLACE_OBJ, description: 'With landings: every place × every landing.' },
  landings: { type: 'array', minItems: 1, maxItems: CORE_MAX_SCENARIOS, items: LANDING, description: 'With places: every place × every landing.' },
};
const ALTERNATIVE = { ...obj({ ...PLACE, landing: LANDING }, ['landing']), description: 'An alternative scenario over the same number of days: a landing, and optionally another place (default: the same place).' };
const ENERGY_INPUTS = {
  attitude: { type: 'string', enum: ATTITUDES, description: 'Panel (assumed): track = vertical, turned to the Sun; fixed = best fixed tilt and facing; flat = horizontal. Default track.' },
  panel_to_load: { type: 'number', minimum: 0.1, maximum: 10, description: 'Rated panel power ÷ average load (assumed). Default 2.' },
  battery_hours: { type: 'number', minimum: 0, maximum: 500, description: 'Battery capacity in hours of average load (assumed). Default 24.' },
  sleep_load_pct: { type: 'number', minimum: 0, maximum: 100, description: 'Load while dark, % of the average load (assumed). Default 10.' },
};
const RELAY_INPUTS = {
  preset: { type: 'string', enum: PRESETS.map((p) => p.id), description: 'Example orbit (not a real mission). Default elliptical-12h, the Relay card\'s default.' },
  a_km: { type: 'number', minimum: 1738, maximum: 60000, description: 'Semi-major axis, km.' },
  e: { type: 'number', minimum: 0, maximum: 0.95, description: 'Eccentricity.' },
  i_deg: { type: 'number', minimum: 0, maximum: 180, description: 'Inclination to the lunar equator, degrees.' },
  raan_deg: { type: 'number', minimum: -360, maximum: 360, description: 'Longitude of the ascending node, degrees.' },
  argp_deg: { type: 'number', minimum: -360, maximum: 360, description: 'Argument of periapsis, degrees.' },
  m0_deg: { type: 'number', minimum: -360, maximum: 360, description: 'Mean anomaly at the epoch (the planned landing), degrees.' },
  min_el_deg: { type: 'number', minimum: 0, maximum: 45, description: 'Minimum relay elevation above the horizon, degrees (assumed). Default 0.' },
};

const SPECS = [
  {
    name: 'list_sites',
    description: 'The curated landing sites: id, name, coordinates, whether they are on the south-pole terrain (80°S to the pole) and whether the coordinates are verified. Use the ids as site_id in the other tools.',
    schema: obj({ terrain_only: { type: 'boolean', description: 'Only sites south of 80°S. Default false.' } }),
  },
  {
    name: 'site_summary',
    description: 'For one or many scenarios (place + landing + stay): hours with the Sun, the Earth and both above the terrain skyline, the longest darkness, peak Sun and Earth elevation, first sunset/sunrise/Earthset/Earthrise. Each stay on its own (clipped at the ephemeris end like the page). Give site_id or lat_deg+lon_deg with landing, or scenarios, or places × landings.',
    schema: obj({ ...PLACE, landing: LANDING, stay_days: STAY, ...SCENARIO_SET }),
  },
  {
    name: 'compare_scenarios',
    description: 'Side-by-side comparison of 2 or more place-and-date scenarios over the same number of days, with differences from a baseline and a ranking. "Five sites × three dates" is one call: places × landings. When the ephemeris end clips a stay, every scenario is cut to the shortest, as the page\'s Compare card does.',
    schema: obj({ ...SCENARIO_SET, stay_days: STAY, baseline: { type: 'integer', minimum: 0, maximum: CORE_MAX_SCENARIOS - 1, description: 'Index of the baseline scenario. Default 0.' } }),
  },
  {
    name: 'rise_set_events',
    description: 'Every sunrise, sunset, Earthrise and Earthset at a place between start and start + days, with azimuth and how long the body then stays up or down — the page\'s "Rises and sets" table for any span.',
    schema: obj({ ...PLACE, start: INSTANT, days: { type: 'number', minimum: 0.1, maximum: 800, description: 'Span in days (clipped at the ephemeris end). Default 14.' }, max_events: { type: 'integer', minimum: 1, maximum: 500, description: 'At most this many events. Default 100.' } }, ['start']),
  },
  {
    name: 'next_events',
    description: 'From an instant, the next sunset, sunrise, Earthset and Earthrise at a place and how long until each, searching forward to the ephemeris end (no mission window needed). Also whether each body is up now and a one-line countdown such as "Sunset in 3 d 4 h · Earthset in 10 d 21 h".',
    schema: obj({ ...PLACE, at: INSTANT }, ['at']),
  },
  {
    name: 'sky_at',
    description: 'Sun and Earth azimuth, elevation, terrain skyline height in that direction and clearance above it at a place and instant (or up to 48 instants), with a sentence on why a body is or is not visible.',
    schema: obj({ ...PLACE, at: INSTANT, times: { type: 'array', minItems: 1, maxItems: CORE_MAX_TIMES, items: INSTANT, description: 'Several instants instead of at.' } }),
  },
  {
    name: 'skyline',
    description: 'The terrain skyline at a place south of 80°S: elevation angle of the horizon in each azimuth, its highest and lowest points and mean.',
    schema: obj({ ...PLACE, step_deg: { type: 'integer', enum: [1, 2, 5, 10, 15, 30, 45], description: 'Azimuth step of the returned profile. Default 5.' } }),
  },
  {
    name: 'best_landing_dates',
    description: 'The best landing days at a place for a stay length, ranked by hours with both Sun and Earth in view (the page\'s landing-date strip), optionally within from/to, spaced apart, and the rank of a planned date.',
    schema: obj({
      ...PLACE, stay_days: STAY,
      count: { type: 'integer', minimum: 1, maximum: 20, description: 'How many dates. Default 5.' },
      from: { type: 'string', description: 'Earliest landing day, UTC date.' }, to: { type: 'string', description: 'Latest landing day, UTC date.' },
      min_gap_days: { type: 'integer', minimum: 1, maximum: 60, description: 'Minimum days between returned dates. Default 7.' },
      compare_to: { type: 'string', description: 'A planned landing day to rank against the others.' },
    }),
  },
  {
    name: 'point_facts',
    description: 'Ground facts at a place south of 80°S: height, slope (the 2 km cell mean the filters use, and the 240 m node slope the route planner limits), inside the official permanently shadowed region or not, distance to it, and NASA\'s 18.6-year average Sun and Earth visibility.',
    schema: obj(PLACE),
  },
  {
    name: 'energy_summary',
    description: 'Energy over a stay in relative units (hours of average load): hours at an empty battery, smallest battery that never runs empty, sunlit, charging and asleep hours, best fixed panel angle. Every input is an assumption, not data. Optional alternative over the same number of days.',
    schema: obj({ ...PLACE, landing: LANDING, stay_days: STAY, ...ENERGY_INPUTS, alternative: ALTERNATIVE }, ['landing']),
  },
  {
    name: 'relay_coverage',
    description: 'Coverage over a stay with an assumed relay orbit (two-body, illustrative): relay link hours, longest relay gap, Earth direct, direct or relay, longest blind, and the first link windows. Optional alternative over the same number of days.',
    schema: obj({ ...PLACE, landing: LANDING, stay_days: STAY, ...RELAY_INPUTS, alternative: ALTERNATIVE }, ['landing']),
  },
  {
    name: 'route_candidates',
    description: 'Three candidate rover routes (shortest, flattest, sunniest) through 2 to 8 points south of 80°S, in order, under a slope limit on the 240 m grid: length, max and mean slope, sunlit share (needs landing) and km inside permanently shadowed regions. A sketch, not a trafficability check. Takes a few seconds.',
    schema: obj({
      points: { type: 'array', minItems: 2, maxItems: 8, items: { type: ['array', 'object'] }, description: 'In order: [lat, lon] pairs, { site_id } or { lat_deg, lon_deg }.' },
      max_slope_deg: { type: 'number', minimum: 5, maximum: 30, description: 'Slope limit in degrees (assumed). Default 15.' },
      landing: { ...LANDING, description: 'Landing for the sunlit share (the stay\'s 2 km Sun map). Without it the Sunniest candidate is unavailable, as on the page before a stay is computed.' },
      stay_days: STAY,
      include_path: { type: 'boolean', description: 'Also return each route as [lat, lon] points (simplified to 0.25 km). Default false.' },
    }, ['points']),
  },
];

// ---------- a small JSON Schema check (same subset and messages as commands.js) ----------
function typeOk(type, v) {
  if (type === 'null') return v === null;
  if (type === 'integer') return Number.isInteger(v);
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (type === 'array') return Array.isArray(v);
  if (type === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  return typeof v === type;
}

function check(schema, v, path) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((t) => typeOk(t, v))) return `${path} must be ${types.join(' or ')}.`;
  if (v === null) return null;
  if (schema.enum && !schema.enum.includes(v)) return `${path} must be one of ${schema.enum.join(', ')}.`;
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) return `${path} must be at least ${schema.minimum}.`;
    if (schema.maximum !== undefined && v > schema.maximum) return `${path} must be at most ${schema.maximum}.`;
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) return `${path} needs at least ${schema.minItems} items.`;
    if (schema.maxItems !== undefined && v.length > schema.maxItems) return `${path} takes at most ${schema.maxItems} items.`;
    for (let i = 0; i < v.length && schema.items; i++) {
      const e = check(schema.items, v[i], `${path}[${i}]`);
      if (e) return e;
    }
  }
  if (types.includes('object') && typeOk('object', v)) {
    for (const key of schema.required ?? []) if (!(key in v)) return `${path === 'input' ? '' : `${path}.`}${key} is required.`;
    for (const [key, value] of Object.entries(v)) {
      const sub = schema.properties?.[key];
      if (!sub) {
        if (schema.additionalProperties === false) return `Unknown field ${path === 'input' ? '' : `${path}.`}${key}.`;
        continue;
      }
      const e = check(sub, value, path === 'input' ? key : `${path}.${key}`);
      if (e) return e;
    }
  }
  return null;
}

export function validateCoreInput(schema, input) {
  return check(schema, input, 'input');
}

// ---------- small helpers ----------
const err = (error, extra) => ({ error, ...(extra ?? {}) });
const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const hours = (ms) => (Number.isFinite(ms) ? round(ms / HOUR_MS, 1) : null);
// Stay lengths are rounded to the hour, as the page does (state.js cleanStay): the same input gives the
// same covered hours on the page and from a tool (review 2 F6).
const stayIn = (d) => (Number.isFinite(d) ? Math.round(d * 24) / 24 : d);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16) + 'Z' : null);
const pct = (part, whole) => (whole > 0 ? round((part / whole) * 100, 1) : null);
const dateText = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const labelOf = (place, ms) => {
  const d = new Date(ms);
  const hm = d.getUTCHours() || d.getUTCMinutes() ? ` ${iso(ms).slice(11, 16)} UTC` : '';
  return `${place.name}, ${dateText(ms)}${hm}`;
};
const span = (ms) => (ms === 0 ? '0 h' : fmtSpan(ms));
async function provided(v) {
  if (typeof v === 'function') return (await v()) ?? null;
  return v ?? null;
}

// ---------- places and times ----------
function findPlace(sites, id) {
  const exact = sites.find((s) => s.id === id);
  if (exact) return exact;
  const low = String(id).trim().toLowerCase();
  return sites.find((s) => s.id.toLowerCase() === low || s.name.toLowerCase() === low) ?? null;
}

// { site_id } | { lat_deg, lon_deg } → { site, place } or { error }. terrainOnly: south of 80°S only.
function resolvePlace(ctx, input, { terrainOnly = false } = {}) {
  const hasLat = input.lat_deg !== undefined, hasLon = input.lon_deg !== undefined;
  let site;
  const held = REFS.get(ctx)?.place(input) ?? null;
  if (held?.error) return err(held.error);
  if (held) {
    site = held.site;
  } else if (REF_FIELDS.some((k) => input[k] !== undefined)) {
    return err('References (candidate, mission_point) need the v2 tools, which this caller does not have.');
  } else if (input.site_id !== undefined) {
    if (hasLat || hasLon) return err('Give either site_id or lat_deg and lon_deg, not both.');
    const s = findPlace(ctx.sites, input.site_id);
    if (!s) return err(`Unknown site_id ${input.site_id}. list_sites gives the ids.`);
    site = { id: s.id, name: s.name, latDeg: s.latDeg, lonDeg: s.lonDeg, verified: s.verified !== false };
  } else {
    if (hasLat !== hasLon) return err('lat_deg and lon_deg go together.');
    if (!hasLat) return err('Give site_id, or lat_deg and lon_deg.');
    const lat = parseLat(String(input.lat_deg), { maxLatDeg: terrainOnly ? TERRAIN_MAX_LAT : 90 });
    if (!lat.ok) return err(lat.code === 'outside' && terrainOnly ? `Terrain is mapped from 80°S to the pole only. ${lat.message}` : lat.message);
    const lon = parseLon(String(input.lon_deg));
    if (!lon.ok) return err(lon.message);
    site = { id: 'custom', name: 'Custom point', latDeg: lat.value, lonDeg: lon.value, verified: true };
  }
  if (terrainOnly && !(site.latDeg <= TERRAIN_MAX_LAT)) return err(`${site.name} is at ${formatCoords(site)}, north of 80°S. Terrain is mapped from 80°S to the pole only.`);
  return { site, place: placeOut(site) };
}

function placeOut(site) {
  return {
    id: site.id, name: site.name, latDeg: round(site.latDeg, 5), lonDeg: round(site.lonDeg, 5), coords: formatCoords(site),
    onTerrain: site.latDeg <= TERRAIN_MAX_LAT, ...(site.verified === false ? { approximate: true } : {}),
  };
}

function parseUtc(text, field) {
  const m = TIME.exec(String(text).trim());
  if (!m) return err(`${field} must look like 2027-01-13 or 2027-01-13T06:00Z (UTC).`);
  const [y, mo, d, hh = '0', mi = '0', ss = '0'] = m.slice(1);
  const ms = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
  if (!Number.isFinite(ms) || new Date(ms).getUTCDate() !== +d || +mo < 1 || +mo > 12 || +hh > 23 || +mi > 59 || +ss > 59) return err(`${field} ${text} is not a valid date.`);
  return { ms };
}

const rangeText = (eph) => `${dateText(eph.startMs)} to ${dateText(eph.endMs)}`;

// A landing: snapped down to the hour (state.js, commands.js) and before the ephemeris end.
function parseLanding(eph, text, field = 'landing') {
  const r = parseUtc(text, field);
  if (r.error) return r;
  const hour = Math.floor(r.ms / HOUR_MS) * HOUR_MS;
  if (!(hour >= eph.startMs && hour < eph.endMs)) return err(`The ephemeris covers ${rangeText(eph)}. Pick a ${field} in that range.`);
  return { ms: hour };
}

// An instant: anywhere in the ephemeris, to the minute.
function parseInstant(eph, text, field) {
  const r = parseUtc(text, field);
  if (r.error) return r;
  if (!(r.ms >= eph.startMs && r.ms <= eph.endMs)) return err(`The ephemeris covers ${rangeText(eph)}. ${field} ${text} is outside it.`);
  return { ms: r.ms };
}

// ---------- the "about" block every result carries ----------
function aboutBase(ctx, sky) {
  const km = sky.km;
  return {
    limits: [
      `Ephemeris: ${rangeText(ctx.eph)} UTC (JPL Horizons DE441).`,
      'Terrain: 80°S to the pole. North of 80°S the horizon is a smooth sphere at 0°, as on the page.',
    ],
    resolution: {
      ephemeris: `Sun and Earth directions every ${ctx.eph.stepMs / HOUR_MS} h, interpolated linearly; Earth direction with parallax from the site.`,
      skyline: km ? `Terrain skyline ray-cast on the LOLA ${Math.round(km * 1000)} m grid, 360 azimuths (1°), out to 300 km, eye ${OBSERVER_M} m above the ground — the skyline the page uses for a site.` : 'Terrain not loaded: smooth horizon at 0° everywhere.',
    },
  };
}
const SCAN_RES = 'Visibility scanned every 15 minutes, each rise or set refined to 1 minute (windows.js).';
const VISIBLE_CONV = 'In view = the centre of the Sun or Earth above the terrain skyline in its direction (no atmosphere, no disc size).';
const HOURS_CONV = 'Hours rounded to 0.1 h and degrees to 0.1°; display repeats the page\'s formatting (whole hours from 10 h up).';
const CLIP_CONV = 'A stay that runs past the ephemeris end is clipped there (clipped: true) and its figures cover only the part inside, as on the page.';

function withAbout(out, about) {
  out.about = about;
  return out;
}

// ---------- shared pieces ----------
function summaryFigures(s, requestedDays) {
  return {
    stay: { requestedDays, coveredH: hours(s.stayMs), end: iso(s.endMs), clipped: s.clipped },
    sunH: hours(s.sunMs), earthH: hours(s.earthMs), bothH: hours(s.bothMs), longestDarkH: hours(s.longestDarkMs),
    sunPct: pct(s.sunMs, s.stayMs), earthPct: pct(s.earthMs, s.stayMs), bothPct: pct(s.bothMs, s.stayMs),
    peakSunElDeg: round(s.peakSunElDeg, 1), peakEarthElDeg: round(s.peakEarthElDeg, 1),
    atLanding: { sunUp: s.sunUpAtLanding, earthUp: s.earthUpAtLanding },
    firstSunset: iso(s.firstSunsetMs), firstSunrise: iso(s.firstSunriseMs),
    firstEarthset: iso(s.firstEarthsetMs), firstEarthrise: iso(s.firstEarthriseMs),
    earthEverUp: s.earthEverUp, eventCount: s.events.length,
    display: { bothInView: fmtHours(s.bothMs), sunlit: fmtHours(s.sunMs), earthInView: fmtHours(s.earthMs), longestDark: span(s.longestDarkMs), peakSun: fmtDeg(s.peakSunElDeg) },
  };
}

// The scenario set of site_summary / compare_scenarios → [{ index, site, place, landingMs, stayDays } | { index, error }]
function scenarioList(ctx, input, { perStay }) {
  const stayDays = stayIn(input.stay_days ?? 14);
  const flat = namesPlace(input) || input.landing !== undefined;
  const forms = [flat, input.scenarios !== undefined, input.places !== undefined || input.landings !== undefined].filter(Boolean).length;
  if (forms === 0) return err('Give a place and landing, or scenarios, or places and landings.');
  if (forms > 1) return err('Use one form: a single place and landing, scenarios, or places with landings.');
  let raw;
  if (flat) {
    if (input.landing === undefined) return err('landing is required.');
    raw = [{ ...placeOf(input), landing: input.landing }];
  } else if (input.scenarios) {
    raw = input.scenarios;
  } else {
    if (!input.places || !input.landings) return err('places and landings go together.');
    if (input.places.length * input.landings.length > CORE_MAX_SCENARIOS) return err(`places × landings makes ${input.places.length * input.landings.length} scenarios; at most ${CORE_MAX_SCENARIOS}.`);
    raw = input.places.flatMap((p) => input.landings.map((landing) => ({ ...p, landing })));
  }
  return raw.map((r, index) => {
    if (!perStay && r.stay_days !== undefined) return { index, error: 'stay_days goes at the top level here: every scenario is compared over the same days.' };
    const p = resolvePlace(ctx, placeOf(r));
    if (p.error) return { index, error: p.error };
    const l = parseLanding(ctx.eph, r.landing);
    if (l.error) return { index, error: l.error };
    return { index, site: p.site, place: p.place, landingMs: l.ms, stayDays: r.stay_days !== undefined ? stayIn(r.stay_days) : stayDays, label: labelOf(p.site, l.ms) };
  });
}

function eventOut(e, startMs) {
  const state = e.kind === 'rise' ? 'up' : 'down';
  return {
    time: iso(e.tMs), body: e.body, event: EVENT_NAMES[e.body][e.kind], azDeg: round(e.azDeg, 1),
    afterStartH: hours(e.tMs - startMs),
    thenH: e.thenMs === null ? null : hours(e.thenMs),
    then: e.thenMs === null ? `${state} until the window ends` : `${state} for ${fmtSpan(e.thenMs)}`,
  };
}

// Next rise and set of one body after fromMs, to the ephemeris end. Chunks are whole multiples of the
// 15-minute scan step, so the samples and crossings are the ones a single summarize() scan from fromMs finds.
function nextCrossings(eph, site, body, fromMs, mask) {
  let start = fromMs, len = 32 * DAY_MS, up = null, nextSet = null, nextRise = null;
  while (start < eph.endMs && (nextSet === null || nextRise === null)) {
    const end = Math.min(eph.endMs, start + len);
    const iv = visibleIntervals(eph, site, body, start, end, mask);
    if (up === null) up = iv.length > 0 && iv[0][0] === start;
    for (const [a, b] of iv) {
      if (nextRise === null && a > start) nextRise = a;
      if (nextSet === null && b < end) nextSet = b;
    }
    start = end;
    len *= 2;
  }
  if (up === null) up = false;
  return { up, nextSet, nextRise };
}

function bodyNow(eph, site, tMs, mask) {
  const r = bodyAzEl(eph, site, tMs);
  const d = eph.at(tMs);
  const one = (b) => {
    const skylineDeg = typeof mask === 'function' ? mask(r[b].azDeg) : mask;
    const above = r[b].elDeg - skylineDeg;
    return { azDeg: round(r[b].azDeg, 2), elDeg: round(r[b].elDeg, 2), skylineDeg: round(skylineDeg, 2), aboveSkylineDeg: round(above, 2), visible: above > 0, _el: r[b].elDeg, _sky: skylineDeg };
  };
  return { sun: one('sun'), earth: { ...one('earth'), rangeKm: Math.round(d.earthRangeKm) } };
}

function why(name, b, smooth) {
  const where = b.azDeg === null ? 'overhead the pole' : `azimuth ${b.azDeg.toFixed(1)}°`;
  if (b.visible) return `${name} is ${b.aboveSkylineDeg.toFixed(2)}° above the ${smooth ? 'horizon' : 'skyline'} (elevation ${b.elDeg.toFixed(2)}°, ${smooth ? 'smooth horizon 0°' : `terrain ${b.skylineDeg.toFixed(2)}°`} at ${where}).`;
  if (b._el <= 0 && b._sky <= 0) return `${name} is below the horizon (elevation ${b.elDeg.toFixed(2)}°).`;
  if (b._el > 0) return `${name} is up (elevation ${b.elDeg.toFixed(2)}°) but behind terrain: the skyline is ${b.skylineDeg.toFixed(2)}° at ${where}, ${(-b.aboveSkylineDeg).toFixed(2)}° higher.`;
  return `${name} is below the horizon (elevation ${b.elDeg.toFixed(2)}°) and the terrain at ${where} rises to ${b.skylineDeg.toFixed(2)}°.`;
}
const strip = (b) => { const { _el, _sky, ...rest } = b; return rest; };

// ---------- the tools ----------
// extensions (v2, docs/mcp-v2/DESIGN.md): functions kit → { specs: [{ name, description, schema }], handlers }.
// With any extension, places also accept references (candidate, mission_point) and kit.refs holds results.
export function createCoreTools(ctx, { extensions = [] } = {}) {
  if (!ctx?.eph || !Array.isArray(ctx?.sites)) throw new Error('createCoreTools needs ctx.eph and ctx.sites');
  const eph = ctx.eph;
  const refs = extensions.length ? createRefs() : null;
  if (refs) REFS.set(ctx, refs);
  // the skyline provider: the page's (shared cache) or a small cache over terrain.js skylineFor
  const cache = new Map();
  const sky = typeof ctx.skylineFor === 'function' ? ctx.skylineFor : (site) => {
    const key = `${site.latDeg.toFixed(5)},${site.lonDeg.toFixed(5)}`;
    let m = cache.get(key);
    if (!m) {
      m = skylineFor(ctx.dem ?? null, site);
      if (cache.size >= SKYLINE_CACHE) cache.delete(cache.keys().next().value);
      cache.set(key, m);
    }
    return m;
  };
  const skyInfo = { km: ctx.dem?.kmPerPixel ?? ctx.skylineKm ?? null };
  const horizonOf = (site) => {
    const m = sky(site);
    const terrain = !!m.profile;
    return { mask: m, terrain, note: terrain ? null : site.latDeg <= TERRAIN_MAX_LAT ? 'Terrain not loaded: smooth horizon at 0°.' : 'North of 80°S: no terrain, smooth horizon at 0° (as on the page).' };
  };
  const about = (extra = {}) => {
    const b = aboutBase(ctx, skyInfo);
    return { units: extra.units ?? {}, resolution: { ...b.resolution, ...(extra.resolution ?? {}) }, limits: [...b.limits, ...(extra.limits ?? [])], conventions: extra.conventions ?? [], ...(extra.assumed ? { assumed: extra.assumed } : {}) };
  };
  const SUMMARY_UNITS = { '*H': 'hours', '*Pct': 'percent of the covered stay', '*Deg': 'degrees', times: 'UTC, ISO 8601 to the minute' };

  const handlers = {
    list_sites(input) {
      const all = ctx.sites.map((s) => ({ ...placeOut({ ...s, verified: s.verified !== false }), subtitle: s.subtitle ?? '', group: s.group ?? null }));
      const sites = input.terrain_only ? all.filter((s) => s.onTerrain) : all;
      return withAbout({ count: sites.length, sites }, about({ units: { latDeg: 'degrees, south negative', lonDeg: 'degrees east, 0–360' }, conventions: ['approximate: true marks coordinates the page shows as "approx." (not verified against a published source).'] }));
    },

    site_summary(input) {
      const list = scenarioList(ctx, input, { perStay: true });
      if (list.error) return list;
      const results = list.map((sc) => {
        if (sc.error) return sc;
        const h = horizonOf(sc.site);
        const s = summarize(eph, sc.site, sc.landingMs, sc.stayDays, h.mask);
        if (!s) return { index: sc.index, error: `The ephemeris covers ${rangeText(eph)}.` };
        return { index: sc.index, label: sc.label, place: sc.place, landing: iso(sc.landingMs), horizon: h.terrain ? 'terrain' : 'smooth', ...(h.note ? { note: h.note } : {}), ...summaryFigures(s, sc.stayDays) };
      });
      if (results.every((r) => r.error)) return results.length === 1 ? err(results[0].error) : err('No scenario could be computed.', { results });
      const out = results.length === 1 && !input.scenarios && !input.places ? results[0] : { count: results.length, results };
      return withAbout(out, about({ units: SUMMARY_UNITS, resolution: { scan: SCAN_RES }, conventions: [VISIBLE_CONV, HOURS_CONV, CLIP_CONV, 'Longest dark = longest continuous time without the Sun in view during the stay.'] }));
    },

    compare_scenarios(input) {
      const list = scenarioList(ctx, input, { perStay: false });
      if (list.error) return list;
      const bad = list.filter((x) => x.error);
      if (bad.length) return err(`Scenario ${bad[0].index}: ${bad[0].error}`, { errors: bad });
      if (list.length < 2) return err('Give at least two scenarios to compare.');
      const base = input.baseline ?? 0;
      if (base >= list.length) return err(`baseline ${base} is not a scenario index (0–${list.length - 1}).`);
      const stayDays = stayIn(input.stay_days ?? 14);
      const masks = list.map((sc) => horizonOf(sc.site));
      let sums, days = stayDays;
      if (list.length === 2) {
        // exactly the page's Compare card
        const pair = summarizePair(eph, { site: list[0].site, landingMs: list[0].landingMs, mask: masks[0].mask }, { site: list[1].site, landingMs: list[1].landingMs, mask: masks[1].mask }, stayDays, 0);
        sums = [pair.planned, pair.alt];
        days = Math.min(...sums.map((s) => s.stayMs)) / DAY_MS;
      } else {
        // summarizePair's rule over all of them: every stay cut to the shortest when the ephemeris end clips one
        sums = list.map((sc, i) => summarize(eph, sc.site, sc.landingMs, stayDays, masks[i].mask));
        const shortest = Math.min(...sums.map((s) => s.stayMs));
        days = shortest / DAY_MS;
        if (sums.some((s) => s.stayMs !== shortest)) {
          sums = list.map((sc, i) => summarize(eph, sc.site, sc.landingMs, days, masks[i].mask));
        }
      }
      const b = sums[base];
      const scenarios = list.map((sc, i) => {
        const s = sums[i];
        const row = { index: i, label: sc.label, place: sc.place, landing: iso(sc.landingMs), horizon: masks[i].terrain ? 'terrain' : 'smooth', ...summaryFigures(s, stayDays) };
        delete row.stay.requestedDays;
        if (i !== base) {
          row.vsBaseline = {
            sunH: hours(s.sunMs - b.sunMs), earthH: hours(s.earthMs - b.earthMs), bothH: hours(s.bothMs - b.bothMs),
            longestDarkH: hours(s.longestDarkMs - b.longestDarkMs), peakSunElDeg: round(s.peakSunElDeg - b.peakSunElDeg, 1),
            // the Compare card's rows for this scenario against the baseline, as the page prints them
            card: compareRows(b, s).map((r) => ({ label: r.label, baseline: r.planned, scenario: r.alt, change: r.change })),
          };
        }
        return row;
      });
      const order = (key, asc = false) => scenarios.map((r, i) => [i, sums[i][key]]).sort((x, y) => (asc ? x[1] - y[1] : y[1] - x[1]) || x[0] - y[0]).map(([i]) => i);
      return withAbout({
        requestedDays: stayDays, stayDays: round(days, 3), comparedDays: round(days, 3), cut: days < stayDays - 1e-9, baseline: base, count: scenarios.length, scenarios,
        ranking: { bothH: order('bothMs'), sunH: order('sunMs'), earthH: order('earthMs'), longestDarkH: order('longestDarkMs', true) },
      }, about({
        units: { ...SUMMARY_UNITS, vsBaseline: 'scenario minus baseline, from unrounded values', ranking: 'scenario indices, best first (longestDarkH: shortest first)' },
        resolution: { scan: SCAN_RES },
        conventions: [VISIBLE_CONV, HOURS_CONV, 'cut: true when the ephemeris end clipped a stay, so every scenario covers the same comparedDays (windows.js summarizePair).', 'vsBaseline.card is the Compare card text: its change is the difference of the rounded figures on screen, so it can differ from vsBaseline hours by up to 1 h.'],
      }));
    },

    rise_set_events(input) {
      const p = resolvePlace(ctx, input);
      if (p.error) return p;
      const t = parseInstant(eph, input.start, 'start');
      if (t.error) return t;
      if (!(t.ms < eph.endMs)) return err(`start is the ephemeris end; nothing follows it.`);
      const days = input.days ?? 14;
      const h = horizonOf(p.site);
      const s = summarize(eph, p.site, t.ms, days, h.mask);
      const max = input.max_events ?? 100;
      const events = s.events.slice(0, max).map((e) => eventOut(e, t.ms));
      return withAbout({
        place: p.place, horizon: h.terrain ? 'terrain' : 'smooth', ...(h.note ? { note: h.note } : {}),
        window: { start: iso(t.ms), end: iso(s.endMs), days: round(s.stayMs / DAY_MS, 3), clipped: s.clipped },
        atStart: { sunUp: s.sunUpAtLanding, earthUp: s.earthUpAtLanding },
        count: s.events.length, truncated: s.events.length > max, events,
      }, about({ units: { azDeg: 'degrees from north, east positive', afterStartH: 'hours', thenH: 'hours the body then stays up (after a rise) or down (after a set); null when that lasts past the window end', time: 'UTC' }, resolution: { scan: SCAN_RES }, conventions: [VISIBLE_CONV, 'A body already up (or down) at start has no event there; atStart says which.'] }));
    },

    next_events(input) {
      const p = resolvePlace(ctx, input);
      if (p.error) return p;
      const t = parseInstant(eph, input.at, 'at');
      if (t.error) return t;
      const h = horizonOf(p.site);
      const now = bodyNow(eph, p.site, t.ms, h.mask);
      const end = dateText(eph.endMs);
      const body = (b, Name) => {
        const c = t.ms < eph.endMs ? nextCrossings(eph, p.site, b, t.ms, h.mask) : { up: now[b].visible, nextSet: null, nextRise: null };
        const ev = (ms) => (ms === null ? null : { time: iso(ms), inH: hours(ms - t.ms), in: fmtSpan(ms - t.ms), azDeg: round(bodyAzEl(eph, p.site, ms)[b].azDeg, 1) });
        const next = c.up ? c.nextSet : c.nextRise;
        const word = EVENT_NAMES[b][c.up ? 'set' : 'rise'];
        const line = next !== null ? `${word} in ${fmtSpan(next - t.ms)}` : c.up ? `${Name} stays up past ${end}` : `No ${b === 'sun' ? 'sunrise' : 'Earthrise'} before ${end}`;
        return { upNow: c.up, ...strip(now[b]), nextSet: ev(c.nextSet), nextRise: ev(c.nextRise), countdown: line };
      };
      const sun = body('sun', 'Sun'), earth = body('earth', 'Earth');
      return withAbout({
        place: p.place, at: iso(t.ms), horizon: h.terrain ? 'terrain' : 'smooth', ...(h.note ? { note: h.note } : {}),
        headline: `${sun.countdown} · ${earth.countdown}`, sun, earth, searchedTo: iso(eph.endMs),
      }, about({ units: { inH: 'hours from at', in: 'the page\'s duration text (fmtSpan)', '*Deg': 'degrees (azimuth from north, east positive)', rangeKm: 'km, site to Earth centre' }, resolution: { scan: SCAN_RES }, conventions: [VISIBLE_CONV, 'Searches forward from at to the ephemeris end; no mission window needed. upNow uses the same test as the scan (clearance > 0 at at).'] }));
    },

    sky_at(input) {
      const p = resolvePlace(ctx, input);
      if (p.error) return p;
      if ((input.at === undefined) === (input.times === undefined)) return err('Give at or times (one of them).');
      const texts = input.times ?? [input.at];
      const ms = [];
      for (const [i, x] of texts.entries()) {
        const r = parseInstant(eph, x, input.times ? `times[${i}]` : 'at');
        if (r.error) return r;
        ms.push(r.ms);
      }
      const h = horizonOf(p.site);
      const rows = ms.map((tm) => {
        const b = bodyNow(eph, p.site, tm, h.mask);
        return { at: iso(tm), sun: { ...strip(b.sun), why: why('The Sun', b.sun, !h.terrain) }, earth: { ...strip(b.earth), why: why('Earth', b.earth, !h.terrain) } };
      });
      const out = input.times ? { place: p.place, horizon: h.terrain ? 'terrain' : 'smooth', count: rows.length, samples: rows } : { place: p.place, horizon: h.terrain ? 'terrain' : 'smooth', ...rows[0] };
      if (h.note) out.note = h.note;
      return withAbout(out, about({ units: { azDeg: 'degrees from north, east positive (null exactly at the pole)', elDeg: 'degrees above the smooth horizon', skylineDeg: 'terrain skyline height in that azimuth, degrees', aboveSkylineDeg: 'elevation minus skyline, degrees', rangeKm: 'km' }, conventions: [VISIBLE_CONV] }));
    },

    skyline(input) {
      const p = resolvePlace(ctx, input, { terrainOnly: true });
      if (p.error) return p;
      const h = horizonOf(p.site);
      if (!h.terrain) return err('The terrain grid is not available to this caller, so there is no skyline (the page would show a smooth horizon at 0°).');
      const prof = h.mask.profile, n = prof.length, step = input.step_deg ?? 5;
      const profile = [];
      for (let az = 0; az < 360; az += step) profile.push({ azDeg: az, elDeg: round(prof[Math.round((az / 360) * n) % n], 2) });
      let hi = 0, lo = 0, sum = 0;
      for (let i = 0; i < n; i++) { if (prof[i] > prof[hi]) hi = i; if (prof[i] < prof[lo]) lo = i; sum += prof[i]; }
      const heightM = ctx.dem ? ctx.dem.heightAt(p.site.latDeg, p.site.lonDeg) : null;
      return withAbout({
        place: p.place, groundHeightM: round(heightM, 0), eyeM: OBSERVER_M, stepDeg: step,
        highest: { azDeg: (hi * 360) / n, elDeg: round(prof[hi], 2) }, lowest: { azDeg: (lo * 360) / n, elDeg: round(prof[lo], 2) }, meanDeg: round(sum / n, 2),
        profile,
      }, about({ units: { azDeg: 'degrees from north, east positive', elDeg: 'skyline elevation angle above the smooth horizon, degrees', groundHeightM: 'm, LOLA datum' }, conventions: ['The page draws this skyline as the ground in the sky chart and uses it as the mask for every in-view figure; between the 1° samples it interpolates linearly.'] }));
    },

    best_landing_dates(input) {
      const p = resolvePlace(ctx, input);
      if (p.error) return p;
      const stayDays = stayIn(input.stay_days ?? 14);
      let from = -Infinity, to = Infinity, planned = null;
      if (input.from !== undefined) { const r = parseUtc(input.from, 'from'); if (r.error) return r; from = Math.floor(r.ms / DAY_MS) * DAY_MS; }
      if (input.to !== undefined) { const r = parseUtc(input.to, 'to'); if (r.error) return r; to = Math.floor(r.ms / DAY_MS) * DAY_MS; }
      if (input.compare_to !== undefined) { const r = parseLanding(eph, input.compare_to, 'compare_to'); if (r.error) return r; planned = Math.floor(r.ms / DAY_MS) * DAY_MS; }
      const h = horizonOf(p.site);
      const rib = landingRibbon(eph, p.site, h.mask, stayDays);
      const days = [];
      rib.dayMs.forEach((t, i) => { if (t >= from && t <= to) days.push({ t, ms: rib.bothMs[i] }); });
      if (!days.length) return err(`No landing day in that range leaves a full ${stayDays}-day stay before ${dateText(eph.endMs)}. Landing days run ${dateText(rib.dayMs[0])} to ${dateText(rib.dayMs[rib.dayMs.length - 1])}.`);
      const ranked = [...days].sort((a, b) => b.ms - a.ms || a.t - b.t);
      const gap = (input.min_gap_days ?? 7) * DAY_MS, count = input.count ?? 5;
      const picks = [];
      for (const d of ranked) {
        if (picks.length >= count) break;
        if (picks.every((q) => Math.abs(q.t - d.t) >= gap)) picks.push(d);
      }
      const stayMs = stayDays * DAY_MS;
      const candidates = picks.map((d) => {
        const s = summarize(eph, p.site, d.t, stayDays, h.mask);
        return { landing: iso(d.t), bothH: hours(d.ms), bothPct: pct(d.ms, stayMs), exact: { bothH: hours(s.bothMs), sunH: hours(s.sunMs), earthH: hours(s.earthMs), longestDarkH: hours(s.longestDarkMs) }, display: fmtHours(d.ms) };
      });
      const sorted = days.map((d) => d.ms).sort((a, b) => a - b);
      const out = {
        place: p.place, horizon: h.terrain ? 'terrain' : 'smooth', ...(h.note ? { note: h.note } : {}), stayDays, metric: 'hours with both the Sun and Earth above the skyline during the stay',
        daysConsidered: days.length, firstDay: iso(days[0].t), lastDay: iso(days[days.length - 1].t),
        zeroDays: days.filter((d) => d.ms === 0).length, daysAtBest: days.filter((d) => d.ms === sorted[sorted.length - 1]).length, medianBothH: hours(sorted[Math.floor(sorted.length / 2)]), bestBothH: hours(sorted[sorted.length - 1]),
        candidates,
      };
      if (planned !== null) {
        const i = rib.dayMs.indexOf(planned);
        if (i < 0) out.planned = { landing: iso(planned), error: `A ${stayDays}-day stay from that day runs past ${dateText(eph.endMs)}; the strip has no bar for it.` };
        else {
          const v = rib.bothMs[i];
          out.planned = { landing: iso(planned), bothH: hours(v), rank: 1 + days.filter((d) => d.ms > v).length, of: days.length, ...(days.some((d) => d.t === planned) ? {} : { note: 'Outside from/to; ranked against the days in range.' }) };
        }
      }
      return withAbout(out, about({
        units: { bothH: 'hours', bothPct: 'percent of the stay', landing: 'UTC midnight' },
        resolution: { ribbon: 'Landing-date strip (ribbon.js): one landing per UTC midnight, the stay sampled every 30 minutes at mid-step; only stays that end before the ephemeris end.' },
        conventions: [VISIBLE_CONV, 'bothH is the strip\'s value (what the page\'s date strip shows); exact re-computes each pick with the 15-minute scan of site_summary. The two can differ by up to about 1 h.', 'Ranking: most both-in-view hours first; ties go to the earlier day; picks at least min_gap_days apart.'],
      }));
    },

    async point_facts(input) {
      const p = resolvePlace(ctx, input, { terrainOnly: true });
      if (p.error) return p;
      const [x, y] = toXY(p.site.latDeg, p.site.lonDeg);
      const na = (what) => ({ available: false, note: `${what} is not available to this caller.` });
      const out = { place: p.place, mapKm: { x: round(x, 3), y: round(y, 3) } };
      const res = {};
      // height: the 480 m grid, as the page shows for a selected site
      if (ctx.dem) {
        out.heightM = round(ctx.dem.heightAt(p.site.latDeg, p.site.lonDeg), 0);
        res.height = `LOLA ${Math.round(ctx.dem.kmPerPixel * 1000)} m grid, bilinear (the height the page shows for a selected site; the hover card uses the finest terrain loaded, so it can differ by tens of metres on steep ground).`;
      } else out.heightM = null;
      // slope: the 2 km cell (filters, hover card) and the 240 m node (route planner)
      const coarse = await provided(ctx.coarse);
      const slope = {};
      if (coarse?.grid) {
        const k = coarse.grid.cellAt(x, y);
        const inside = k !== null && k !== undefined && coarse.grid.cellCenter(k).latDeg <= TERRAIN_MAX_LAT;
        slope.cellMeanDeg = inside ? round(coarse.slope[k], 2) : null;
        slope.cellKm = coarse.grid.cellKm;
        out.psrDistanceKm = inside && coarse.shadow ? coarse.shadow[k] : null;
        res.cellSlope = `Mean slope over the 240 m grid inside the ${coarse.grid.cellKm} km cell (slope_${coarse.grid.cellKm}km): what the slope filter and the hover card use (zoomed in, the hover card shows the 1 km cell, which can differ).`;
        res.psrDistance = `${coarse.grid.cellKm} km cell: 0 when most of the cell is permanent shadow, else km to the nearest PSR patch of at least 1 km² (rounded, at least 1, capped at 255). The suitability score uses it.`;
      } else { slope.cellMeanDeg = null; slope.cellNote = 'The 2 km cell grid is not available to this caller.'; out.psrDistanceKm = null; }
      const d240 = await provided(ctx.dem240);
      if (d240) {
        slope.pointDeg = round(slopeAt(d240, x, y), 2);
        slope.pointBaselineKm = d240.kmPerPixel;
        res.pointSlope = `Central differences on the ${Math.round(d240.kmPerPixel * 1000)} m grid at the nearest node (route-plan.js slopeAt): what the route planner limits.`;
      } else { slope.pointDeg = null; slope.pointNote = 'The 240 m grid is not available to this caller.'; }
      out.slope = slope;
      const psr = await provided(ctx.psr);
      out.psr = psr ? { inside: psr.isPsr(x, y) } : na('The PSR map');
      if (psr) res.psr = `Official permanently shadowed region map, ${Math.round(psr.kmPerPixel * 1000)} m pixels (Mazarico et al. 2011, 2016 update): never sees any part of the Sun over 18.6 years.`;
      const nasa = await provided(ctx.nasa);
      if (nasa) {
        const n = nasa.sample(x, y);
        out.nasaAverage = n ? { sunPct: round(n.sunPct, 1), earthPct: round(n.earthPct, 1) } : { sunPct: null, earthPct: null, note: 'No data at this point.' };
        res.nasaAverage = '18.6-year averages in 1 h steps, 480 m pixels (Mazarico et al. 2011, 2016 update): share of time with ANY part of the disc above the local horizon, so higher than this product\'s centre-of-disc figures.';
      } else out.nasaAverage = na('The NASA average map');
      // v2: thermally stable ice (Diviner), only when the ice packs are built and loaded (tools/build-ice.mjs)
      const ice = await provided(ctx.ice);
      if (ice) {
        const here = ice.at(x, y);
        const near = (cls) => { const t = ice.nearest(x, y, { cls, withinKm: 20 }); return t ? { km: round(t.distKm, 1), latDeg: round(t.latDeg, 4), lonDeg: round(t.lonDeg, 4), depthM: round(t.depthM, 2) } : null; };
        out.ice = {
          here: here ? { stability: here.cls, iceTableDepthM: here.depthM === null || here.depthM === undefined ? null : round(here.depthM, 2), tmaxK: round(here.tmaxK, 0) } : null,
          nearestSurfaceStable: near('surface'), nearestShallowStable: near('shallow'),
          note: 'Thermal stability (possible ice), not detected ice. Searched up to 20 km; null = none within 20 km.',
        };
        res.ice = `Diviner thermal model (Schorghofer & Williams 2020), ${ice.meta?.resolution ?? '240 m'}: surface = stable at the surface; shallow = ice table within ${ice.shallowMaxM ?? 1} m (depth to a sublimation loss of 1 kg/m²/Gyr); Tmax = maximum temperature.`;
      }
      return withAbout(out, about({ units: { heightM: 'm, LOLA datum (1737.4 km sphere)', '*Deg': 'degrees', '*Km': 'km', '*Pct': 'percent of time', mapKm: 'polar stereographic map km (pole at 0, 0°E up)', ...(ice ? { tmaxK: 'kelvin', iceTableDepthM: 'm' } : {}) }, resolution: res }));
    },

    energy_summary(input) {
      const p = resolvePlace(ctx, input);
      if (p.error) return p;
      const l = parseLanding(eph, input.landing);
      if (l.error) return l;
      let alt = null;
      if (input.alternative) {
        const a = input.alternative;
        const ap = namesPlace(a) ? resolvePlace(ctx, a) : p;
        if (ap.error) return err(`alternative: ${ap.error}`);
        const al = parseLanding(eph, a.landing, 'alternative.landing');
        if (al.error) return al;
        alt = { site: ap.site, place: ap.place, landingMs: al.ms };
      }
      const stayDays = stayIn(input.stay_days ?? 14);
      const assumptions = {};
      if (input.attitude !== undefined) assumptions.attitude = input.attitude;
      if (input.panel_to_load !== undefined) assumptions.panelToLoad = input.panel_to_load;
      if (input.battery_hours !== undefined) assumptions.batteryHours = input.battery_hours;
      if (input.sleep_load_pct !== undefined) assumptions.sleepLoad = input.sleep_load_pct / 100;
      const r = planEnergyPair(eph, { site: p.site, landingMs: l.ms, mask: sky(p.site) }, alt ? { site: alt.site, landingMs: alt.landingMs, mask: sky(alt.site) } : null, stayDays, assumptions);
      // the rounding of main.js api.energy (get_energy), so the numbers match the Energy card
      const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
      const one = (x, label, place) => (x ? {
        label, place, sunlitH: r1(x.litMs / HOUR_MS), atEmptyH: r1(x.sim.emptyH), minBatteryH: r1(x.sim.minBatteryH),
        chargingH: r1(x.sim.chargingH), asleepH: r1(x.sim.sleepH),
        bestFixed: x.bestFixed ? { tiltDeg: r1(x.bestFixed.tiltDeg), facingDeg: r1(x.bestFixed.azDeg), shareOfTracking: r1(x.bestFixed.vsTrack * 100) } : null,
        horizontalShareOfTracking: r1(x.flatVsTrack * 100), coveredH: r1(x.stayMs / HOUR_MS),
      } : null);
      const a = r.planned.assumptions;
      return withAbout({
        assumptions: { attitude: a.attitude, panelToLoad: a.panelToLoad, batteryHours: a.batteryHours, sleepLoadPct: r1(a.sleepLoad * 100), initialChargePct: r1(a.initialCharge * 100), assumed: true, note: 'Assumed, not data. Relative units: hours of average load.' },
        stayDays: round(r.planned.stayMs / DAY_MS, 3), cut: r.planned.stayMs < stayDays * DAY_MS, plannedClipped: r.plannedClipped,
        planned: one(r.planned, labelOf(p.site, l.ms), p.place),
        alternative: alt ? one(r.alt, labelOf(alt.site, alt.landingMs), alt.place) : undefined,
      }, about({
        units: { '*H': 'hours (sunlit, charging, asleep, at empty: hours of time; minBatteryH: hours of average load)', shareOfTracking: 'percent of the energy a Sun-tracking vertical panel collects', '*Deg': 'degrees; facingDeg from north, east positive' },
        resolution: { energy: 'Hour bins over the stay; each bin\'s lit share from the same Sun scan as site_summary (terrain skyline), cosine law for the panel, battery simulated bin by bin (energy.js).' },
        conventions: [VISIBLE_CONV, 'cut: true when coverage is shorter than the requested stay; with an alternative both stays use the shorter coverage, as the Energy card does.', 'Only the inputs given here are used; the Energy card on the page may hold other values.'],
        assumed: ['attitude', 'panelToLoad', 'batteryHours', 'sleepLoadPct', 'initialChargePct'],
      }));
    },

    relay_coverage(input) {
      const p = resolvePlace(ctx, input);
      if (p.error) return p;
      const l = parseLanding(eph, input.landing);
      if (l.error) return l;
      const preset = PRESETS.find((x) => x.id === (input.preset ?? PRESETS[0].id));
      const el = { ...preset.elements };
      const keys = { a_km: 'aKm', e: 'e', i_deg: 'iDeg', raan_deg: 'raanDeg', argp_deg: 'argpDeg', m0_deg: 'm0Deg' };
      let custom = false;
      for (const [k, v] of Object.entries(keys)) if (input[k] !== undefined) { el[v] = input[k]; custom = true; }
      const v = validateElements(el);
      if (!v.ok) return err(`That orbit is not valid: ${[...new Set(Object.values(v.errors))].join(' ')}`);
      let alt = null;
      if (input.alternative) {
        const a = input.alternative;
        const ap = namesPlace(a) ? resolvePlace(ctx, a) : p;
        if (ap.error) return err(`alternative: ${ap.error}`);
        const al = parseLanding(eph, a.landing, 'alternative.landing');
        if (al.error) return al;
        alt = { site: ap.site, place: ap.place, landingMs: al.ms };
      }
      const stayDays = stayIn(input.stay_days ?? 14), minElDeg = input.min_el_deg ?? 0;
      const pm = sky(p.site);
      let ps, as = null;
      if (alt) {
        const pair = summarizePair(eph, { site: p.site, landingMs: l.ms, mask: pm }, { site: alt.site, landingMs: alt.landingMs, mask: sky(alt.site) }, stayDays, 0);
        ps = pair.planned; as = pair.alt;
      } else ps = summarize(eph, p.site, l.ms, stayDays, pm);
      const days = Math.min(ps.stayMs, as?.stayMs ?? ps.stayMs) / DAY_MS;
      // the Relay card: epoch at the planned landing for both scenarios (relaycard.js)
      const run = (s, site) => relayForSummary(s, { elements: el, eph, site, mask: sky(site), minElDeg, defaultEpochMs: l.ms });
      const h1 = (ms) => (Number.isFinite(ms) ? Math.round(ms / 360e3) / 10 : null);
      const one = (r, label, place, s) => (r ? {
        label, place, relayH: h1(r.relayMs), longestRelayGapH: h1(r.longestRelayGapMs), earthDirectH: h1(r.directMs), directOrRelayH: h1(r.anyMs), longestBlindH: h1(r.longestBlindMs), stayH: h1(r.stayMs), clipped: s.clipped,
        windowCount: r.windowCount, firstWindows: r.windows.map((w) => ({ start: iso(w.startMs), end: iso(w.endMs), durH: h1(w.durMs), peakElDeg: round(w.peakElDeg, 1) })),
      } : null);
      return withAbout({
        orbit: { preset: custom ? null : preset.id, name: custom ? 'Custom orbit (assumed)' : preset.name, elements: { aKm: el.aKm, e: el.e, iDeg: el.iDeg, raanDeg: el.raanDeg, argpDeg: el.argpDeg, m0Deg: el.m0Deg }, epoch: iso(l.ms), periodH: Math.round(v.derived.periodS / 36) / 100, periluneAltKm: Math.round(v.derived.periluneAltKm), apoluneAltKm: Math.round(v.derived.apoluneAltKm), minElDeg, assumed: true },
        stayDays: round(days, 3), cut: days < stayDays - 1e-9,
        planned: one(run(ps, p.site), labelOf(p.site, l.ms), p.place, ps),
        alternative: alt ? one(as && run(as, alt.site), labelOf(alt.site, alt.landingMs), alt.place, as) : undefined,
      }, about({
        units: { '*H': 'hours', '*Km': 'km', '*Deg': 'degrees', times: 'UTC' },
        resolution: { relay: 'Two-body Kepler orbit sampled every 60 s (period/120 under 2 h), window edges refined to 1 s; the site sees the relay above the terrain skyline and min_el_deg; the relay sees Earth when the line to Earth\'s centre misses the lunar sphere (relay.js).' },
        conventions: [VISIBLE_CONV, 'The orbit epoch is the planned landing for both scenarios, so the alternative sees the orbit later in its motion (as the Relay card).', 'Earth direct = the direct-to-Earth hours of site_summary for the same stay.'],
        limits: ['Illustrative: no third-body pull or lunar gravity field, so a real orbit drifts from this within weeks. Presets are examples, not real missions.'],
        assumed: ['orbit elements', 'minElDeg'],
      }));
    },

    async route_candidates(input) {
      const pts = [], places = [];
      for (const [i, q] of input.points.entries()) {
        const where = Array.isArray(q) ? (q.length === 2 ? { lat_deg: q[0], lon_deg: q[1] } : null) : q;
        if (!where) return err(`points[${i}] must be [lat, lon], { site_id } or { lat_deg, lon_deg }.`);
        const extra = Object.keys(where).filter((k) => !['site_id', 'lat_deg', 'lon_deg', ...(REFS.has(ctx) ? REF_FIELDS : [])].includes(k));
        if (extra.length) return err(`points[${i}]: unknown field ${extra[0]}.`);
        const r = resolvePlace(ctx, where, { terrainOnly: true });
        if (r.error) return err(`points[${i}]: ${r.error}`);
        pts.push(toXY(r.site.latDeg, r.site.lonDeg));
        places.push(r.place);
      }
      const dem = await provided(ctx.dem240);
      if (!dem) return err('The 240 m terrain grid is not available to this caller (ctx.dem240), so routes cannot be planned.');
      const limit = input.max_slope_deg ?? DEFAULT_MAX_SLOPE;
      let sunAt = null, sunNote = null, landingMs = null, lenMs = null;
      if (input.landing !== undefined) {
        const l = parseLanding(eph, input.landing);
        if (l.error) return l;
        const coarse = await provided(ctx.coarse);
        if (!coarse?.grid) sunNote = 'The 2 km cell grid is not available to this caller, so there is no sunlit share.';
        else {
          // the page's full 2 km map job of the planned stay (heatplan.js), computed only over the cells the
          // planner can reach: every leg's corridor (bounding box + pad, doubled once when blocked) plus the
          // 9 × 9-node Sun blur. Each cell's value does not depend on the rest of the grid.
          landingMs = l.ms;
          lenMs = Math.min(stayIn(input.stay_days ?? 14) * DAY_MS, eph.endMs - l.ms);
          const g = coarse.grid;
          let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, pad = 0;
          for (let i = 0; i < pts.length; i++) {
            x0 = Math.min(x0, pts[i][0]); x1 = Math.max(x1, pts[i][0]); y0 = Math.min(y0, pts[i][1]); y1 = Math.max(y1, pts[i][1]);
            if (i > 0) pad = Math.max(pad, 2 * corridorPadKm(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])));
          }
          pad += 2 * g.cellKm + 5 * dem.kmPerPixel;
          const rect = {
            i0: Math.floor((x0 - pad + g.halfKm) / g.cellKm), i1: Math.floor((x1 + pad + g.halfKm) / g.cellKm),
            j0: Math.floor((g.halfKm - (y1 + pad)) / g.cellKm), j1: Math.floor((g.halfKm - (y0 - pad)) / g.cellKm),
          };
          const job = fractionJob(g, eph, l.ms, l.ms + lenMs, { rect });
          while (!job.run(50));
          sunAt = sunFromJobs([{ grid: g, job }]);
        }
      }
      const psr = await provided(ctx.psr);
      const plan = await planRoutes({ points: pts, dem, sunAt, isPsr: psr ? (x, y) => psr.isPsr(x, y) : null, maxSlopeDeg: limit });
      if (!plan.ok) {
        if (plan.blocked && Number.isFinite(plan.blocked.neededDeg)) return err(`No route keeps under ${plan.blocked.limitDeg}°. It needs ${plan.blocked.passesAtDeg ?? Math.ceil(plan.blocked.neededDeg)}° (leg ${plan.blocked.leg + 1}).`, { blocked: { limitDeg: plan.blocked.limitDeg, passesAtDeg: plan.blocked.passesAtDeg, leg: plan.blocked.leg + 1 } });
        return err(plan.error ?? 'No route found.');
      }
      // the rounding of main.js api.planRoute (plan_route)
      const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
      const path = (pp) => simplify(pp, 0.25).map(([x, y]) => { const s = fromXY(x, y); return [round(s.latDeg, 5), round(s.lonDeg, 5)]; });
      const routes = plan.routes.map((r) => ({
        id: r.id, label: r.label, lengthKm: r1(r.lengthKm), maxSlopeDeg: r1(r.maxSlopeDeg), meanSlopeDeg: r1(r.meanSlopeDeg),
        sunSharePct: r.sunShare == null ? null : r1(r.sunShare * 100), psrKm: r1(r.psrKm), sameAs: r.sameAs ?? null, unavailable: r.unavailable ?? null,
        ...(input.include_path && r.points ? { path: path(r.points) } : {}),
      }));
      return withAbout({
        points: places, slopeLimitDeg: limit, slopeBaselineKm: plan.baselineKm,
        sunFrom: landingMs !== null ? { landing: iso(landingMs), stayH: hours(lenMs) } : null,
        ...(sunNote ? { sunNote } : {}), ...(psr ? {} : { psrNote: 'The PSR map is not available to this caller, so psrKm is null.' }),
        routes, nodesSearched: plan.nodes, note: 'Slope on the 240 m grid is a sketch, not a trafficability check. No speed, time or energy.',
      }, about({
        units: { lengthKm: 'km along the ground', '*SlopeDeg': 'degrees', sunSharePct: 'percent of the route length on ground sunlit during the stay (length-weighted mean of the cells\' sunlit share)', psrKm: 'km inside the official PSR map' },
        resolution: { route: `Graph nodes at the ${Math.round(dem.kmPerPixel * 1000)} m grid's pixel centres (slope baseline ${Math.round(dem.kmPerPixel * 1000)} m); statistics sampled every quarter node (route-plan.js).`, sun: 'Sunlit share per 2 km cell over the stay, sampled every 2 h at mid-step (heat.js fractionJob on the 2 km skyline grid) — the page\'s full map job.', psr: 'Official PSR map, 120 m pixels.' },
        conventions: ['Labels stay true: Shortest is never longer, Flattest never steeper on average and Sunniest never less sunlit than another candidate (route-plan.js). sameAs names an earlier candidate it repeats.'],
        assumed: ['max_slope_deg'],
      }));
    },
  };

  // ---------- v2 extensions ----------
  let specs = SPECS;
  if (extensions.length) {
    const kit = {
      ctx, eph, refs, sky, horizonOf, about, withAbout, err, round, hours, pct, iso, stayIn, provided, span, dateText, rangeText, labelOf,
      resolvePlace: (input, opts) => resolvePlace(ctx, input, opts),
      parseLanding: (text, field) => parseLanding(eph, text, field),
      parseInstant: (text, field) => parseInstant(eph, text, field),
      parseUtc, summaryFigures, bodyNow, nextCrossings: (site, body, fromMs, mask) => nextCrossings(eph, site, body, fromMs, mask),
      schema: { obj, PLACE: { ...PLACE, ...PLACE_REFS }, PLACE_OBJ: withPlaceRefs(PLACE_OBJ), LANDING, INSTANT, STAY, SITE_ID, LAT, LON },
      conv: { SCAN_RES, VISIBLE_CONV, HOURS_CONV, CLIP_CONV },
      run: (name, input) => api.run(name, input),
      DAY_MS, HOUR_MS,
    };
    specs = SPECS.map((s) => ({ ...s, schema: withPlaceRefs(s.schema) }));
    for (const ext of extensions) {
      const e = ext(kit);
      for (const s of e.specs) {
        if (handlers[s.name]) throw new Error(`Tool ${s.name} is defined twice.`);
        if (typeof e.handlers[s.name] !== 'function') throw new Error(`Tool ${s.name} has no handler.`);
        handlers[s.name] = e.handlers[s.name];
      }
      specs = [...specs, ...e.specs];
    }
  }

  const byName = new Map(specs.map((s) => [s.name, s]));
  const api = {
    refs,   // v2: held results (search, mission, route) for MCP resources; null without extensions
    list: specs.map((s) => s.name),
    specs() {
      return specs.map((s) => ({ name: s.name, description: s.description, input_schema: structuredClone(s.schema) }));
    },
    toolDefinitions() {
      return this.specs();
    },
    async run(name, input = {}) {
      const spec = byName.get(name);
      if (!spec) return err(`Unknown tool ${name}.`);
      const e = validateCoreInput(spec.schema, input ?? {});
      if (e) return err(e);
      try {
        const out = await handlers[name](input ?? {});
        if (out && typeof out === 'object') for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
        return out;
      } catch (e2) {
        return err(`${name} failed: ${e2?.message ?? String(e2)}`);
      }
    },
  };
  return api;
}
