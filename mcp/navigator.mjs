// The MCP-only pieces that are not computations: the handshake instructions and open_in_navigator, the one
// bridge from a stdio client to the page. Links are written by the page's own state.js toHash and checked
// by its parseHash, so a change to the hash format is followed here without a second list of keys.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULTS, SHEET_TABS, toHash, parseHash } from '../demo/src/state.js';
import { formatCoords } from '../demo/src/sites.js';
import { parseLat, parseLon } from '../demo/src/coords.js';
import { validateCoreInput, CORE_MAX_SCENARIOS } from '../demo/src/tools-core.js';
import { DEFAULT_DATA_DIR } from '../tools/core-context.mjs';

export const DEFAULT_PAGE_URL = pathToFileURL(fileURLToPath(new URL('../demo/index.html', import.meta.url))).href;
// The ephemeris span named in the instructions; tests check it against the loaded ephemeris.json, which the
// handshake does not read (it is large and loaded lazily with the rest of the data).
export const EPHEMERIS_SPAN = { start: '2026-11-01', end: '2029-01-01' };
// The page's map modes (state.js keeps its list private). Every call is checked by parseHash, so a mode the
// page no longer accepts becomes a tool error rather than a wrong link.
export const MAP_MODES = ['both', 'sun', 'earth', 'now', 'change', 'score'];
const MODE_TEXT = { both: 'hours with both Sun and Earth in view', sun: 'sunlit hours', earth: 'hours with Earth in view', now: 'the live light at the playhead', change: 'the change between the plan and the alternative', score: 'the suitability score' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HOUR_MS = 3600e3, MINUTE_MS = 60e3;
const TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?\s*(Z|UTC)?$/i;

export function readSites(dataDir = DEFAULT_DATA_DIR) {
  return JSON.parse(readFileSync(new URL('sites.json', pathToFileURL(dataDir.endsWith('/') ? dataDir : `${dataDir}/`)), 'utf8'));
}

function siteTable(sites) {
  return sites.map((s) => `- ${s.id}: ${s.name}, ${formatCoords(s)}${s.verified === false ? ' (approx.)' : ''}`).join('\n');
}

// The initialize result's instructions. Only sites.json is read; it is small.
export function buildInstructions(dataDir = DEFAULT_DATA_DIR) {
  let table;
  try { table = `Site ids (no need to call list_sites first):\n${siteTable(readSites(dataDir))}`; }
  catch { table = 'Site ids: call list_sites (the site list could not be read at startup).'; }
  return [
    'Lunar Site Navigator: read-only calculations for lunar south-pole landing planning (Sun and Earth visibility above the real terrain skyline, darkness, rise and set times, best landing dates, ground facts, energy, relay coverage, rover route sketches). Same code as the Lunar Site Navigator web page.',
    `Coverage: terrain from 80°S to the pole; ephemeris ${EPHEMERIS_SPAN.start} to ${EPHEMERIS_SPAN.end}. All times are UTC, e.g. 2027-01-13 or 2027-01-13T06:00Z.`,
    'Places: give site_id, or lat_deg plus lon_deg ("89.3S" and "137.3W" are accepted).',
    table,
    `Batches: site_summary and compare_scenarios take at most ${CORE_MAX_SCENARIOS} scenarios per call (places × landings counts every pair). Split bigger sets: 6 sites × 5 landings = 30, so make two calls of 3 sites × the same 5 landings (15 each). To compare everything with one baseline, put the baseline site first in both calls (4 × 5 = 20).`,
    'Battery, panel and load figures, relay orbits and the rover slope limit are assumptions (supplied or defaults), not data. Say so when you report them.',
    'Results are a first-look screen, not a certified landing analysis. Every result has an about block with units, resolution and limitations; carry the relevant ones into your answer.',
    'Search and robustness: find_landing_sites, check_slip_robustness and landing_windows share one criteria object (lsn://criteria/presets). Name the readings in assumed[]. When feasibility is infeasible or thin, lead with the binding constraint and the cheapest relaxation. Later calls take { candidate: "S1" } or, after mission_open, { mission_point: "W2" } as a place.',
    'To show the user the map, call open_in_navigator and give them the link.',
  ].join('\n\n');
}

const PLACE = {
  site_id: { type: 'string', description: 'Site id, for example "shackleton".' },
  lat_deg: { type: ['number', 'string'], description: 'Latitude, south negative: -89.3 or "89.3S".' },
  lon_deg: { type: ['number', 'string'], description: 'Longitude: east 0–360, negative or "137.3W" for west.' },
};
export const OPEN_SPEC = {
  name: 'open_in_navigator',
  description: 'A link that opens the Lunar Site Navigator web page on a place, landing, stay, slip, map mode, playhead time and detail-sheet tab, so the user can see the map and charts behind an answer. Returns { url, opens }. Computes nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      ...PLACE,
      landing: { type: 'string', description: 'Landing time, UTC: 2027-01-13 or 2027-01-13T06:00Z, snapped down to the hour as the page does. Default: the page default.' },
      stay_days: { type: 'number', minimum: 1, maximum: 60, description: 'Stay length in days, rounded to the hour. Default 14.' },
      slip_days: { type: 'integer', minimum: -60, maximum: 60, description: 'Days between the planned landing and the alternative landing the page compares with. Default 14.' },
      mode: { type: 'string', enum: MAP_MODES, description: 'Map mode: both, sun, earth (hours in view over the stay), now (live light at the playhead), change (plan vs alternative), score (suitability). Default both.' },
      at: { type: 'string', description: 'Playhead time, UTC to the minute. Default: the landing.' },
      sheet: { type: 'string', enum: [...SHEET_TABS], description: 'Open the site detail sheet on this tab. Default: closed.' },
    },
    required: [],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
};

const err = (error) => ({ error });
const dateText = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const timeText = (ms) => `${dateText(ms)} ${new Date(ms).toISOString().slice(11, 16)} UTC`;

function parseUtc(text, field) {
  const m = TIME.exec(String(text).trim());
  if (!m) return err(`${field} must look like 2027-01-13 or 2027-01-13T06:00Z (UTC).`);
  const [y, mo, d, hh = '0', mi = '0', ss = '0'] = m.slice(1);
  const ms = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
  if (!Number.isFinite(ms) || new Date(ms).getUTCDate() !== +d || +mo < 1 || +mo > 12 || +hh > 23 || +mi > 59 || +ss > 59) return err(`${field} ${text} is not a valid date.`);
  return { ms };
}

function resolveSite(sites, input) {
  const hasLat = input.lat_deg !== undefined, hasLon = input.lon_deg !== undefined;
  if (input.site_id !== undefined) {
    if (hasLat || hasLon) return err('Give either site_id or lat_deg and lon_deg, not both.');
    const low = input.site_id.trim().toLowerCase();
    const s = sites.find((x) => x.id === input.site_id) ?? sites.find((x) => x.id.toLowerCase() === low || x.name.toLowerCase() === low);
    return s ? { site: s } : err(`Unknown site_id ${input.site_id}. list_sites gives the ids.`);
  }
  if (hasLat !== hasLon) return err('lat_deg and lon_deg go together.');
  if (!hasLat) return err('Give site_id, or lat_deg and lon_deg.');
  const lat = parseLat(String(input.lat_deg), { maxLatDeg: 90 });
  if (!lat.ok) return err(lat.message);
  const lon = parseLon(String(input.lon_deg));
  if (!lon.ok) return err(lon.message);
  return { site: { id: 'custom', name: 'Custom site', latDeg: lat.value, lonDeg: lon.value } };
}

// → { url, opens } or { error }. ctx: { sites, eph } (the loaded core context).
export function openInNavigator(ctx, input = {}, { pageUrl = process.env.LSN_PAGE_URL || DEFAULT_PAGE_URL } = {}) {
  const invalid = validateCoreInput(OPEN_SPEC.inputSchema, input ?? {});
  if (invalid) return err(invalid);
  const { eph, sites } = ctx;
  const place = resolveSite(sites, input);
  if (place.error) return place;
  let landingMs = DEFAULTS.landingMs;
  if (input.landing !== undefined) {
    const r = parseUtc(input.landing, 'landing');
    if (r.error) return r;
    landingMs = Math.floor(r.ms / HOUR_MS) * HOUR_MS;
  }
  if (!(landingMs >= eph.startMs && landingMs < eph.endMs)) return err(`The ephemeris covers ${dateText(eph.startMs)} to ${dateText(eph.endMs)}. Pick a landing in that range.`);
  let cursorMs = landingMs;
  if (input.at !== undefined) {
    const r = parseUtc(input.at, 'at');
    if (r.error) return r;
    cursorMs = Math.floor(r.ms / MINUTE_MS) * MINUTE_MS;
    if (!(cursorMs >= eph.startMs && cursorMs <= eph.endMs)) return err(`The ephemeris covers ${dateText(eph.startMs)} to ${dateText(eph.endMs)}. at ${input.at} is outside it.`);
  }
  const want = {
    ...DEFAULTS, view: 'map', site: place.site, landingMs, cursorMs,
    stayDays: Math.round((input.stay_days ?? DEFAULTS.stayDays) * 24) / 24,
    slipDays: input.slip_days ?? DEFAULTS.slipDays,
    mapMode: input.mode ?? DEFAULTS.mapMode,
    sheet: input.sheet ?? null,
  };
  const hash = toHash(want);
  // The page is the authority: whatever it would read back differently is refused, not silently changed.
  const got = parseHash(hash, sites, eph);
  // Custom points: the page's normalizeLon adds float noise (222.7 → 222.70000000000005); 1e-9° is ~0.03 mm.
  const near = (x, y) => Math.abs(x - y) < 1e-9;
  const same = (a, b) => (a.id === 'custom' ? b.id === 'custom' && near(b.latDeg, a.latDeg) && near(b.lonDeg, a.lonDeg) : b.id === a.id);
  const mismatch = [
    !same(want.site, got.site) && 'place', got.landingMs !== want.landingMs && 'landing', got.stayDays !== want.stayDays && 'stay_days',
    got.slipDays !== want.slipDays && 'slip_days', got.mapMode !== want.mapMode && 'mode', got.cursorMs !== want.cursorMs && 'at', got.sheet !== want.sheet && 'sheet',
  ].filter(Boolean);
  if (mismatch.length) return err(`The page would not open with this ${mismatch.join(', ')}; it reads the link back differently.`);

  const url = `${pageUrl.replace(/#.*$/, '')}${hash}`;
  const where = place.site.id === 'custom' ? `the point ${formatCoords(place.site)}` : `${place.site.name} (${formatCoords(place.site)})`;
  const stay = Number(want.stayDays.toFixed(4));
  const altMs = landingMs + want.slipDays * 86400e3;
  let opens = `The map in ${want.mapMode} mode (${MODE_TEXT[want.mapMode] ?? want.mapMode}) at ${where}, landing ${timeText(landingMs)} for ${stay} day${stay === 1 ? '' : 's'}, compared with landing ${timeText(altMs)}`;
  if (cursorMs !== landingMs) opens += `, playhead at ${timeText(cursorMs)}`;
  if (want.sheet) opens += `, site detail sheet on its ${want.sheet[0].toUpperCase()}${want.sheet.slice(1)} tab`;
  opens += '.';
  if (pageUrl.startsWith('file:') && !existsSync(fileURLToPath(pageUrl.replace(/#.*$/, '')))) opens += ' The page file was not found at that path; set LSN_PAGE_URL to where the page is.';
  return { url, opens };
}
