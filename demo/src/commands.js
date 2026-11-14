// The command layer (phase 3 §4.10, §5.5): one set of named commands that both the interface and the
// agent use to drive the page. Each command has a JSON Schema for its input; toolDefinitions() hands the
// same schemas to a model as tool definitions. Invalid input returns { error } and never throws.
//
// createCommands(api) expects (the integrator provides it):
//   api.getState() → state: { view, site, landingMs, stayDays, slipDays, mapMode, maxSlope, maxDark, weights,
//                    zoom, cx, cy, summary? }  (summary: { planned, alt } from windows.js summarizePair)
//   api.update(patch)                      patch keys: site, landingMs, stayDays, slipDays, mapMode,
//                                          maxSlope, maxDark, weights, view
//   api.sites                              the site list (sites.json)
//   api.setView({ cx, cy, zoom })          km, km, factor
//   api.setRegion(slot, shape | null)      slot 'A' | 'B'; shape as in map/shapes.js
//   api.setRoute(points | null)            not used by a command yet
//   api.regionStats(slot) → Promise<stats | null>   region.js regionStats output, null when the slot is empty
//   api.bestCells(count) → Promise<[{ latDeg, lonDeg, value }]>
//   api.startTour()
//   api.planRoute([[xKm, yKm], …], maxSlopeDeg) (optional, phase 4) → Promise<{ selected, routes } | { error, blocked }>
//   api.relayOrbit(elements, presetId | null) (optional, phase 4) → { ok, errors? } or { ok, presetId, elements, planned, alternative }
//   api.relayPresets                       relay.js PRESETS
//   api.energy(assumptions) (optional, phase 4) → { assumptions, planned, alt } from energy.js planEnergyPair, rounded
//   api.landingRange (optional) { startMs, endMs }; defaults to the ephemeris span below
//   api.core (phase 5) createCoreTools(ctx): opts into the unified compute + view table below.
//   api.setPlayhead(ms), api.play(), api.pause(), api.setLayer(name, on), api.openSiteDetail(tab), api.openSettings()
import { findSite, parseCustomSite, formatCoords } from './sites.js';
import { toXY, MAP_HALF_KM, TERRAIN_MAX_LAT } from './terrain.js';
import { clampView } from './map/view.js';
import { selfIntersects } from './map/shapes.js';

const DAY_MS = 86400e3;
const HOUR_MS = 3600e3;
// The ephemeris covers 1 Nov 2026 to 1 Jan 2029 (demo/data/ephemeris.json).
const DEFAULT_RANGE = { startMs: Date.UTC(2026, 10, 1), endMs: Date.UTC(2029, 0, 1) };
const MODES = ['both', 'sun', 'earth', 'now', 'change', 'score'];
const MODE_LABELS = { both: 'Both', sun: 'Sunlit', earth: 'Earth in view', now: 'Now', change: 'Change', score: 'Suitability' };
const RANKED_MODES = ['both', 'sun', 'earth', 'score'];
const DEFAULT_WEIGHTS = { sun: 40, earth: 30, slope: 20, shadow: 10 };
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::00)?Z?)?$/;

const LAT_MAP = { type: 'number', minimum: -90, maximum: TERRAIN_MAX_LAT, description: 'Latitude in degrees, south is negative. The map covers 80°S to the pole.' };
const LON = { type: 'number', minimum: -180, maximum: 360, description: 'East longitude in degrees.' };
const SITE_ID = { type: 'string', description: 'Site id from get_state().sites, for example "shackleton".' };
const SLOT = { type: 'string', enum: ['A', 'B'], description: 'Region slot.' };

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const SPECS = [
  {
    name: 'get_state',
    description: 'Read the current page state: selected site, landing time, stay, slip, map mode, filters, weights, map view, the site list and, when available, the planned and slipped stay summaries.',
    schema: obj({}),
  },
  {
    name: 'select_site',
    description: 'Select a landing site by id, or a custom point by latitude and longitude.',
    schema: obj({ site_id: SITE_ID, lat_deg: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude in degrees.' }, lon_deg: LON }),
  },
  {
    name: 'set_landing',
    description: 'Set the planned landing time (UTC). Accepts YYYY-MM-DD or YYYY-MM-DDTHH:MMZ, within 1 Nov 2026 to 1 Jan 2029.',
    schema: obj({ date: { type: 'string', description: 'UTC date or date-time, for example 2027-01-13 or 2027-01-13T06:00Z.' } }, ['date']),
  },
  {
    name: 'set_stay',
    description: 'Set the length of the surface stay in days.',
    schema: obj({ days: { type: 'integer', enum: [7, 14, 30] } }, ['days']),
  },
  {
    name: 'set_slip',
    description: 'Set the slip of the alternative landing, in days relative to the planned landing. Negative is earlier.',
    schema: obj({ days: { type: 'integer', minimum: -60, maximum: 60 } }, ['days']),
  },
  {
    name: 'set_map_mode',
    description: 'Switch the map mode: both (Sun and Earth both in view), sun, earth, now, change (planned against slipped), score (suitability).',
    schema: obj({ mode: { type: 'string', enum: MODES } }, ['mode']),
  },
  {
    name: 'set_filters',
    description: 'Set the ground filters. null means Any. Omitted keys stay as they are.',
    schema: obj({
      max_slope_deg: { type: ['integer', 'null'], minimum: 3, maximum: 30, description: 'Maximum mean slope over a 240 m grid, degrees.' },
      max_dark_h: { type: ['integer', 'null'], minimum: 0, maximum: 336, description: 'Maximum longest continuous darkness during the stay, hours, in steps of 12.' },
    }),
  },
  {
    name: 'set_weights',
    description: 'Set the suitability weights, 0 to 100 each. Omitted weights stay as they are.',
    schema: obj({
      sun: { type: 'integer', minimum: 0, maximum: 100 }, earth: { type: 'integer', minimum: 0, maximum: 100 },
      slope: { type: 'integer', minimum: 0, maximum: 100 }, shadow: { type: 'integer', minimum: 0, maximum: 100 },
    }),
  },
  {
    name: 'zoom_to',
    description: 'Centre the map on a site or a point south of 80°S and set the zoom (1 to 32, default 6; 32 shows 20 m terrain where it is loaded).',
    schema: obj({ site_id: SITE_ID, lat_deg: LAT_MAP, lon_deg: LON, zoom: { type: 'number', minimum: 1, maximum: 32 } }),
  },
  {
    name: 'draw_region',
    description: 'Draw region A or B: a circle or square centred on a site or a point, or a polygon of at least three points. Replaces what the slot held.',
    schema: obj({
      slot: SLOT,
      type: { type: 'string', enum: ['circle', 'rect', 'polygon'] },
      site_id: SITE_ID, lat_deg: LAT_MAP, lon_deg: LON,
      radius_km: { type: 'number', minimum: 0.5, maximum: 200, description: 'Circle radius, or half the side of a square.' },
      points: {
        type: 'array', minItems: 3, maxItems: 50, description: 'Polygon vertices as [lat_deg, lon_deg] pairs.',
        items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
      },
    }, ['slot', 'type']),
  },
  {
    name: 'clear_region',
    description: 'Clear region A or B.',
    schema: obj({ slot: SLOT }, ['slot']),
  },
  {
    name: 'region_stats',
    description: 'Statistics for region A or B over the planned stay: area, cell count, mean sunlit, Earth in view and both-in-view fractions (0 to 1), share passing the filters, mean suitability and the best cell.',
    schema: obj({ slot: SLOT }, ['slot']),
  },
  {
    name: 'best_cells',
    description: 'The highest-ranked map cells in the current mode (Both, Sunlit, Earth in view or Suitability), after the filters. value is a fraction of the stay, or the suitability score.',
    schema: obj({ count: { type: 'integer', minimum: 1, maximum: 10 } }),
  },
  {
    name: 'open_navigator',
    description: 'Legacy alias for open_site_detail on Overview. Keeps the legacy navigator return value; the page opens the map and detail sheet.',
    schema: obj({}),
  },
  {
    name: 'start_tour',
    description: 'Start the guided tour of the interface.',
    schema: obj({}),
  },
  // phase 4 (§6 G): the workflow cards
  {
    name: 'get_energy',
    description: 'Energy over the planned stay (and the alternative when one is compared) in relative units: hours at an empty battery, the smallest battery that never runs empty (hours of load), sunlit, charging and asleep hours, and the best fixed panel angle. Every input is an assumption, not data; omitted inputs keep the Energy card\'s values. The card is in the Power tab of the site detail sheet, which opens unless the Ask panel is open (shownIn says which).',
    schema: obj({
      attitude: { type: 'string', enum: ['track', 'fixed', 'flat'], description: 'Panel: track = vertical, turned to the Sun; fixed = best fixed tilt and facing; flat = horizontal.' },
      panel_to_load: { type: 'number', minimum: 0.1, maximum: 10, description: 'Rated panel power ÷ average load (assumed).' },
      battery_hours: { type: 'number', minimum: 0, maximum: 500, description: 'Battery capacity in hours of average load (assumed).' },
      sleep_load_pct: { type: 'number', minimum: 0, maximum: 100, description: 'Load while dark, % of the average load (assumed).' },
    }),
  },
  {
    name: 'plan_route',
    description: 'Plan three candidate rover routes (shortest, flattest, sunniest) through 2 to 8 points south of 80°S, in order, under a slope limit on the 240 m grid. Returns each candidate\'s length, max and mean slope, sunlit share along it and km inside official permanently shadowed regions, and makes the shortest the current route. A sketch, not a trafficability check; no speed, time or energy. Opens the Route plan card.',
    schema: obj({
      points: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }, description: '[[lat_deg, lon_deg], …] in order: start, waypoints, end.' },
      max_slope_deg: { type: 'number', minimum: 5, maximum: 30, description: 'Slope limit in degrees (assumed, default 15).' },
    }, ['points']),
  },
  {
    name: 'set_relay_orbit',
    description: 'Set the assumed relay orbit in the Relay link card (two-body, illustrative) and return its coverage over the stay in hours: relay link, longest relay gap, Earth direct, direct or relay, longest blind. Give a preset (an example orbit, not a real mission) and/or elements; omitted elements keep the current values. The card is in the Comms tab of the site detail sheet, which opens unless the Ask panel is open (shownIn says which).',
    schema: obj({
      preset: { type: 'string', enum: ['elliptical-12h', 'elliptical-24h', 'circular-2h'], description: 'Example orbits: 12 h elliptical polar, 24 h elliptical at 60°, 2 h circular polar.' },
      a_km: { type: 'number', minimum: 1738, maximum: 60000, description: 'Semi-major axis, km.' },
      e: { type: 'number', minimum: 0, maximum: 0.95, description: 'Eccentricity.' },
      i_deg: { type: 'number', minimum: 0, maximum: 180, description: 'Inclination to the lunar equator, degrees.' },
      raan_deg: { type: 'number', minimum: -360, maximum: 360, description: 'Longitude of the ascending node, degrees.' },
      argp_deg: { type: 'number', minimum: -360, maximum: 360, description: 'Argument of periapsis, degrees.' },
      m0_deg: { type: 'number', minimum: -360, maximum: 360, description: 'Mean anomaly at the epoch, degrees.' },
    }),
  },
];

// Old embedders without api.core keep their phase-4 table; the page supplies core and gets both tiers.
const VIEW_SPECS = [
  { name: 'set_window', description: 'Set or restore the mission window. Landing UTC snaps down to the hour; stay_days (1–60) rounds to whole hours. Coverage past the ephemeris end is clipped, not shifted earlier.',
    schema: obj({ landing: { type: 'string' }, stay_days: { type: 'number', minimum: 1, maximum: 60 } }, ['landing', 'stay_days']) },
  { name: 'clear_window', description: 'Hide the mission window and switch to Live; keep the playhead and remembered landing/stay.', schema: obj({}) },
  { name: 'set_playhead', description: 'Move the shared playhead to a UTC instant (minute precision), without changing the mission window.', schema: obj({ at: { type: 'string' } }, ['at']) },
  { name: 'play', description: 'Start playback with the current rate and loop setting.', schema: obj({}) },
  { name: 'pause', description: 'Pause playback at the current instant.', schema: obj({}) },
  { name: 'set_layer', description: 'Turn a map layer on or off: live light, permanent shadow (psr), skyDial (dial alias), best cells, site labels, or graticule. Uses the same switches as Layers.',
    schema: obj({ name: { type: 'string', enum: ['live', 'psr', 'skyDial', 'dial', 'best', 'labels', 'graticule'] }, on: { type: 'boolean' } }, ['name', 'on']) },
  { name: 'open_site_detail', description: 'Open the selected site detail sheet on Overview (default), Power, Comms or Compare.',
    schema: obj({ tab: { type: 'string', enum: ['overview', 'power', 'comms', 'compare'] } }) },
  { name: 'open_settings', description: 'Open the Settings sheet; close any other large panel.', schema: obj({}) },
];

// ---------- a small JSON Schema check for the subset used above ----------
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
        if (schema.additionalProperties === false) return `Unknown field ${key}.`;
        continue;
      }
      const e = check(sub, value, key);
      if (e) return e;
    }
  }
  return null;
}

export function validateInput(schema, input) {
  return check(schema, input, 'input');
}

// ---------- helpers ----------
const err = (error) => ({ error });
const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';
const hours = (ms) => (Number.isFinite(ms) ? round(ms / HOUR_MS, 1) : null);

function siteOut(site) {
  if (!site) return null;
  return { id: site.id, name: site.name, latDeg: site.latDeg, lonDeg: site.lonDeg, coords: formatCoords(site) };
}

function summaryOut(s) {
  if (!s) return null;
  return { stayH: hours(s.stayMs), sunH: hours(s.sunMs), earthH: hours(s.earthMs), bothH: hours(s.bothMs), longestDarkH: hours(s.longestDarkMs) };
}

// A site id or a lat/lon pair → { point, site } or { error }.
function resolvePoint(api, input, { mapOnly }) {
  const hasLat = 'lat_deg' in input, hasLon = 'lon_deg' in input;
  if ('site_id' in input) {
    if (hasLat || hasLon) return err('Give either site_id or lat_deg and lon_deg, not both.');
    const site = findSite(api.sites ?? [], input.site_id);
    if (!site) return err(`Unknown site_id ${input.site_id}. get_state lists the sites.`);
    if (mapOnly && !(site.latDeg <= TERRAIN_MAX_LAT)) return err(`${site.name} is north of 80°S, outside the map.`);
    return { site, point: { latDeg: site.latDeg, lonDeg: site.lonDeg } };
  }
  if (hasLat !== hasLon) return err('lat_deg and lon_deg go together.');
  if (!hasLat) return err('Give site_id, or lat_deg and lon_deg.');
  const r = parseCustomSite(String(input.lat_deg), String(input.lon_deg));
  if (!r.ok) return err(r.message);
  return { site: r.site, point: { latDeg: r.site.latDeg, lonDeg: r.site.lonDeg } };
}

// The stay that the ephemeris actually covers. The landing may be any hour before its end (the phase 1
// rule), so a late landing gets a shorter stay; the figures then cover only that part, and a longest
// dark filter means little. Reported so the reply can say so.
function stayCover(api, landingMs, stayDays) {
  const end = (api.landingRange ?? DEFAULT_RANGE).endMs;
  const wantH = stayDays * 24;
  const availableH = Math.max(0, Math.min(wantH, (end - landingMs) / HOUR_MS));
  return { stayAvailableH: round(availableH, 1), clipped: availableH < wantH };
}

function onMap(x, y) {
  return Math.abs(x) <= MAP_HALF_KM && Math.abs(y) <= MAP_HALF_KM;
}

function parseLanding(text, range, instant = false) {
  const m = DATE.exec(String(text).trim());
  if (!m) return err('date must look like 2027-01-13 or 2027-01-13T06:00Z.');
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  if (!Number.isFinite(ms) || new Date(ms).getUTCFullYear() !== +m[1] || new Date(ms).getUTCMonth() !== +m[2] - 1 || new Date(ms).getUTCDate() !== +m[3] || (m[4] && +m[4] > 23) || (m[5] && +m[5] > 59)) return err(`${text} is not a valid date.`);
  const hour = instant ? ms : Math.floor(ms / HOUR_MS) * HOUR_MS;
  if (!(hour >= range.startMs && (instant ? hour <= range.endMs : hour < range.endMs))) return err(`The ephemeris covers 1 Nov 2026 to 1 Jan 2029. Pick ${instant ? 'an instant' : 'a landing time'} in that range.`);
  return { ms: hour };
}

// ---------- handlers ----------
const HANDLERS = {
  get_state(api) {
    const s = api.getState();
    const out = {
      view: s.view, site: siteOut(s.site), landing: iso(s.landingMs), stayDays: s.stayDays, slipDays: s.slipDays,
      mapMode: s.mapMode, mapModeLabel: MODE_LABELS[s.mapMode] ?? s.mapMode,
      filters: { maxSlopeDeg: s.maxSlope ?? null, maxDarkH: s.maxDark ?? null },
      weights: { ...DEFAULT_WEIGHTS, ...(s.weights ?? {}) },
      mapView: { cx: s.cx ?? 0, cy: s.cy ?? 0, zoom: s.zoom ?? 1 },
      // fix L6: with coordinates, so a script can plan a route between named sites
      sites: (api.sites ?? []).map((x) => ({ id: x.id, name: x.name, latDeg: x.latDeg, lonDeg: x.lonDeg })),
      ...stayCover(api, s.landingMs, s.stayDays),
      windowOn: s.windowOn !== false, at: iso(s.cursorMs ?? s.landingMs), playing: Boolean(s.playing), sheet: s.sheet ?? null,
    };
    if (s.summary) {
      out.planned = summaryOut(s.summary.planned);
      out.slipped = s.slipDays !== 0 ? summaryOut(s.summary.alt) : null;
    }
    return out;
  },
  select_site(api, input) {
    const r = resolvePoint(api, input, { mapOnly: false });
    if (r.error) return r;
    api.update({ site: r.site });
    return { site: siteOut(r.site) };
  },
  set_landing(api, input) {
    const r = parseLanding(input.date, api.landingRange ?? DEFAULT_RANGE);
    if (r.error) return r;
    api.update({ landingMs: r.ms });
    return { landing: iso(r.ms), ...stayCover(api, r.ms, api.getState().stayDays) };
  },
  set_stay(api, input) {
    api.update({ stayDays: input.days });
    return { stayDays: input.days, ...stayCover(api, api.getState().landingMs, input.days) };
  },
  set_slip(api, input) {
    api.update({ slipDays: input.days });
    const s = api.getState();
    return { slipDays: input.days, alternativeLanding: iso(s.landingMs + input.days * DAY_MS) };
  },
  set_map_mode(api, input) {
    if (api.getState().windowOn === false && input.mode !== 'now') return err('This mode needs a mission window. Use set_window first, or choose now (Live).');
    api.update({ mapMode: input.mode });
    return { mapMode: input.mode, label: MODE_LABELS[input.mode] };
  },
  set_filters(api, input) {
    if (!('max_slope_deg' in input) && !('max_dark_h' in input)) return err('Give max_slope_deg, max_dark_h or both.');
    if (Number.isInteger(input.max_dark_h) && input.max_dark_h % 12 !== 0) return err('max_dark_h must be a multiple of 12.');
    const s = api.getState();
    const patch = {
      maxSlope: 'max_slope_deg' in input ? input.max_slope_deg : (s.maxSlope ?? null),
      maxDark: 'max_dark_h' in input ? input.max_dark_h : (s.maxDark ?? null),
    };
    api.update(patch);
    const note = ['now', 'change'].includes(s.mapMode) ? 'Filters do not apply in Now and Change modes.' : undefined;
    return { maxSlopeDeg: patch.maxSlope, maxDarkH: patch.maxDark, note };
  },
  set_weights(api, input) {
    if (Object.keys(input).length === 0) return err('Give at least one of sun, earth, slope, shadow.');
    const weights = { ...DEFAULT_WEIGHTS, ...(api.getState().weights ?? {}), ...input };
    api.update({ weights });
    const zero = weights.sun + weights.earth + weights.slope + weights.shadow === 0;
    return { weights, note: zero ? 'All weights are 0, so suitability is undefined. Set at least one weight.' : undefined };
  },
  zoom_to(api, input) {
    const { zoom = 6, ...where } = input;
    const r = resolvePoint(api, where, { mapOnly: true });
    if (r.error) return r;
    const [x, y] = toXY(r.point.latDeg, r.point.lonDeg);
    if (!onMap(x, y)) return err('That point is outside the mapped area.');
    // the viewport cannot leave the map square, so near the edge its centre moves inwards; report that centre
    const v = clampView({ cx: x, cy: y, zoom });
    api.setView(v);
    return { cx: round(v.cx, 2), cy: round(v.cy, 2), zoom: v.zoom, centre: formatCoords(r.point), centredOnPoint: v.cx === x && v.cy === y };
  },
  draw_region(api, input) {
    const { slot, type } = input;
    let shape;
    if (type === 'polygon') {
      if (!input.points) return err('A polygon needs points.');
      if ('site_id' in input || 'lat_deg' in input || 'lon_deg' in input || 'radius_km' in input) return err('A polygon takes points only.');
      const points = [];
      for (const [lat, lon] of input.points) {
        if (!(lat >= -90 && lat <= TERRAIN_MAX_LAT) || !(lon >= -180 && lon <= 360)) return err('Polygon points must be [lat_deg, lon_deg] south of 80°S.');
        points.push(toXY(lat, lon));
      }
      if (selfIntersects(points)) return err('This outline crosses itself. Draw it again without crossing.');
      shape = { type: 'polygon', points };
    } else {
      if ('points' in input) return err(`A ${type} takes a centre and radius_km, not points.`);
      if (!('radius_km' in input)) return err('radius_km is required.');
      const r = resolvePoint(api, input, { mapOnly: true });
      if (r.error) return r;
      const [cx, cy] = toXY(r.point.latDeg, r.point.lonDeg);
      if (!onMap(cx, cy)) return err('That point is outside the mapped area.');
      const k = input.radius_km;
      shape = type === 'circle' ? { type: 'circle', cx, cy, rKm: k } : { type: 'rect', x0: cx - k, y0: cy - k, x1: cx + k, y1: cy + k };
    }
    api.setRegion(slot, shape);
    return { slot, shape };
  },
  clear_region(api, input) {
    api.setRegion(input.slot, null);
    return { slot: input.slot, cleared: true };
  },
  async region_stats(api, input) {
    const stats = await api.regionStats(input.slot);
    if (!stats) return err(`Region ${input.slot} is empty. Draw it first.`);
    return { slot: input.slot, ...stats };
  },
  async best_cells(api, input) {
    const mode = api.getState().mapMode;
    if (!RANKED_MODES.includes(mode)) return err('Best cells are ranked in Both, Sunlit, Earth in view and Suitability modes. Switch the map mode first.');
    const cells = await api.bestCells(input.count ?? 5);
    return {
      mode, label: MODE_LABELS[mode], valueKind: mode === 'score' ? 'score' : 'fraction of stay',
      cells: (cells ?? []).map((c) => ({ ...c, coords: formatCoords(c) })),
    };
  },
  open_navigator(api) {
    api.update({ view: 'navigator' });
    return { view: 'navigator' };
  },
  set_window(api, input) {
    const r = parseLanding(input.landing, api.landingRange ?? DEFAULT_RANGE);
    if (r.error) return r;
    const stayDays = Math.round(input.stay_days * 24) / 24;
    api.update({ windowOn: true, landingMs: r.ms, stayDays });
    return { windowOn: true, landing: iso(r.ms), stayDays, ...stayCover(api, r.ms, stayDays) };
  },
  clear_window(api) {
    api.update({ windowOn: false, mapMode: 'now' });
    return { windowOn: false, mapMode: 'now' };
  },
  set_playhead(api, input) {
    const r = parseLanding(input.at, api.landingRange ?? DEFAULT_RANGE, true);
    if (r.error) return r;
    api.setPlayhead(r.ms);
    return { at: iso(r.ms) };
  },
  play(api) { api.play(); return { playing: true }; },
  pause(api) { api.pause(); return { playing: false }; },
  set_layer(api, input) { return api.setLayer(input.name, input.on); },
  open_site_detail(api, input) {
    const tab = input.tab ?? 'overview';
    api.openSiteDetail(tab);
    return { view: 'map', sheet: tab };
  },
  open_settings(api) { api.openSettings(); return { settingsOpen: true }; },
  start_tour(api) {
    api.startTour();
    return { started: true };
  },
  async plan_route(api, input) {
    if (!api.planRoute) return err('The Route plan card is not in this build.');
    const pts = [];
    for (const [lat, lon] of input.points) {
      if (!(lat >= -90 && lat <= TERRAIN_MAX_LAT) || !(lon >= -180 && lon <= 360)) return err('Route points must be [lat_deg, lon_deg] south of 80°S.');
      pts.push(toXY(lat, lon));
    }
    const r = await api.planRoute(pts, input.max_slope_deg ?? 15);
    if (r?.error || r?.blocked) {
      if (r.blocked) return err(`No route keeps under ${r.blocked.limitDeg}°. It needs ${r.blocked.passesAtDeg ?? Math.ceil(r.blocked.neededDeg)}°.`);
      return err(r.error);
    }
    return r;
  },
  set_relay_orbit(api, input) {
    if (!api.relayOrbit) return err('The Relay link card is not in this build.');
    const preset = input.preset ? (api.relayPresets ?? []).find((p) => p.id === input.preset) : null;
    if (input.preset && !preset) return err(`Unknown preset ${input.preset}.`);
    const el = preset ? { ...preset.elements } : {};
    const keys = { a_km: 'aKm', e: 'e', i_deg: 'iDeg', raan_deg: 'raanDeg', argp_deg: 'argpDeg', m0_deg: 'm0Deg' };
    for (const [k, v] of Object.entries(keys)) if (input[k] !== undefined) el[v] = input[k];
    const custom = Object.keys(keys).some((k) => input[k] !== undefined);
    const r = api.relayOrbit(el, preset && !custom ? preset.id : null);
    if (!r.ok) return err(`That orbit is not valid: ${Object.values(r.errors ?? {}).join(' ')}`);
    return r;
  },
  get_energy(api, input) {
    if (!api.energy) return err('The Energy card is not in this build.');
    const a = {};
    if (input.attitude !== undefined) a.attitude = input.attitude;
    if (input.panel_to_load !== undefined) a.panelToLoad = input.panel_to_load;
    if (input.battery_hours !== undefined) a.batteryHours = input.battery_hours;
    if (input.sleep_load_pct !== undefined) a.sleepLoad = input.sleep_load_pct / 100;
    return api.energy(a);
  },
};

export function createCommands(api) {
  const specs = api.core ? [...SPECS, ...VIEW_SPECS] : SPECS;
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const coreNames = new Set(api.core?.list ?? []);
  return {
    list: [...specs.map((spec) => spec.name), ...coreNames],
    async run(name, input = {}) {
      if (coreNames.has(name)) return api.core.run(name, input);
      const spec = byName.get(name);
      if (!spec) return err(`Unknown command ${name}.`);
      const e = validateInput(spec.schema, input ?? {});
      if (e) return err(e);
      try {
        const out = await HANDLERS[name](api, input ?? {});
        // Drop undefined notes so results serialise cleanly.
        if (out && typeof out === 'object') for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
        return out;
      } catch (e2) {
        return err(`${name} failed: ${e2?.message ?? String(e2)}`);
      }
    },
    toolDefinitions() {
      return [...specs.map((spec) => ({ name: spec.name, description: spec.description, input_schema: structuredClone(spec.schema) })), ...(api.core?.specs() ?? [])];
    },
  };
}
