// Screen state, URL hash parsing and writing, and the alternative scenario (spec §7.1).
import { findSite, parseCustomSite } from './sites.js';
import { ENERGY_DEFAULTS, cleanAssumptions } from './energy.js';
import { PRESETS as RELAY_PRESETS } from './relay.js';
import { DEFAULT_MAX_SLOPE } from './route-plan.js';
import { geoParam, parseGeo } from './georegion.js';

const DAY_MS = 86400e3;
const HOUR_MS = 3600e3;
// phase 5: the Navigator page is the map's detail sheet; an old #view=navigator link opens the map with it
const VIEWS = ['map', 'evidence', 'brief'];
export const SHEET_TABS = ['overview', 'power', 'comms', 'compare'];
const MODES = ['both', 'sun', 'earth', 'now', 'change', 'score'];
// Phase 3. Map viewport, filters and suitability weights live in the hash; the drawing tool and the
// region slot are in-memory only (spec phase 3 §4.1, §4.3, §4.4, §4.6).
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 32;   // phase 4: 20 m terrain, as map/view.js (was 12)
export const VIEW_HALF_KM = 320;
export const SLOPE_RANGE = [3, 30];
export const DARK_RANGE = [0, 336];
export const DARK_STEP_H = 12;
export const WEIGHT_KEYS = ['sun', 'earth', 'slope', 'shadow'];
export const TOOLS = ['select', 'rect', 'circle', 'polygon', 'route'];
export const SLOTS = ['A', 'B'];
// phase 5: the stay is any whole number of hours from 1 to 60 days (the time dock's handles and keys);
// 7, 14 and 30 stay the offered presets. stay= is written in days, up to four decimals.
export const STAYS = [7, 14, 30];
export const STAY_RANGE = [1, 60];
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})Z$/;

export const DEFAULTS = {
  view: 'map', site: 'im2',
  // Picked by tools/pick-default.mjs: both in view 327.6 h as planned, 0.0 h landing 14 days later.
  landingMs: Date.UTC(2027, 0, 13),
  stayDays: 14, slipDays: 14, altSite: 'same', mapMode: 'both', picking: 'site',
  viewport: { cx: 0, cy: 0, zoom: 1 }, maxSlope: null, maxDark: null,
  weights: { sun: 40, earth: 30, slope: 20, shadow: 10 }, tool: 'select', slot: 'A',
  // fix L5 (phase 4): the PSR layer, the Energy and Relay link inputs, the Route plan points, slope limit and
  // picked candidate, and the regions A and B (each in its slot's key). All in the hash, defaults left out;
  // the drawing tool and the active slot stay in memory, as in phase 3.
  psr: false, energy: null, relay: null, routePlan: null, regions: { A: null, B: null },
  // phase 5: the mission window is optional (win=off), the playhead is in the hash (now=, when it is not at
  // landing), and the detail sheet's tab when it is open (sheet=)
  windowOn: true, sheet: null,
};
export const ENERGY_KEYS = ['attitude', 'panelToLoad', 'batteryHours', 'sleepLoad'];
const ROUTE_IDS = ['short', 'flat', 'sunny'];
const RELAY_KEYS = ['aKm', 'e', 'iDeg', 'raanDeg', 'argpDeg', 'm0Deg'];

function fields(hash) {
  const out = {};
  const body = String(hash ?? '').replace(/^#/, '');
  if (!body) return out;
  for (const pair of body.split('&')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    let key, value;
    try { key = decodeURIComponent(pair.slice(0, i)); value = decodeURIComponent(pair.slice(i + 1)); } catch { continue; }
    out[key] = value;
  }
  return out;
}

const isNumber = (s) => typeof s === 'string' && /^[-+]?(\d+\.?\d*|\.\d+)$/.test(s.trim());
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => (typeof v === 'number' ? v : isNumber(v) ? Number(v) : NaN);
const round = (v, places) => { const r = Number(v.toFixed(places)); return r === 0 ? 0 : r; };

// Each clean* takes a value from the hash (string) or from code (number, object, null) and returns
// a valid value; anything unusable falls back to the default. Numbers out of range are clamped.
// The centre is held where the viewport stays inside the ±320 km square at that zoom (the rule of
// map/view.js clampView), so a hash always names the view it shows.
export function cleanViewport(v) {
  const d = DEFAULTS.viewport;
  const z = num(v?.zoom), x = num(v?.cx), y = num(v?.cy);
  const zoom = Number.isFinite(z) ? round(clamp(z, MIN_ZOOM, MAX_ZOOM), 2) : d.zoom;
  const lim = Math.floor((VIEW_HALF_KM - VIEW_HALF_KM / zoom) * 10) / 10;   // rounded inwards, to 0.1 km
  return {
    cx: Number.isFinite(x) ? round(clamp(x, -lim, lim), 1) : d.cx,
    cy: Number.isFinite(y) ? round(clamp(y, -lim, lim), 1) : d.cy,
    zoom,
  };
}

// null means Any. Slope: whole degrees 3–30. Dark: hours 0–336 in 12 h steps.
export function cleanMaxSlope(v) {
  const n = num(v);
  return Number.isFinite(n) ? clamp(Math.round(n), SLOPE_RANGE[0], SLOPE_RANGE[1]) : DEFAULTS.maxSlope;
}

export function cleanMaxDark(v) {
  const n = num(v);
  return Number.isFinite(n) ? clamp(Math.round(n / DARK_STEP_H) * DARK_STEP_H, DARK_RANGE[0], DARK_RANGE[1]) : DEFAULTS.maxDark;
}

// Accepts { sun, earth, slope, shadow } or the hash form "40,30,20,10"; each weight is an integer
// 0–100. A malformed value gives the default weights as a whole.
export function cleanWeights(v) {
  const parts = typeof v === 'string' ? v.split(',') : v && typeof v === 'object' ? WEIGHT_KEYS.map((k) => v[k]) : null;
  if (!parts || parts.length !== WEIGHT_KEYS.length) return { ...DEFAULTS.weights };
  const n = parts.map(num);
  if (!n.every(Number.isFinite)) return { ...DEFAULTS.weights };
  return Object.fromEntries(WEIGHT_KEYS.map((k, i) => [k, clamp(Math.round(n[i]), 0, 100)]));
}

// A UTC time "YYYY-MM-DDTHH:MMZ" whose fields are all in range (review 2 F9: no rolling over into the next
// month, day or hour), else null.
function utcFields(s) {
  const m = TIME.exec(s ?? '');
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const d = new Date(ms);
  if (!Number.isFinite(ms) || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]
    || d.getUTCHours() !== +m[4] || d.getUTCMinutes() !== +m[5]) return null;
  return ms;
}

function parseTime(s, eph) {
  const ms = utcFields(s);
  if (ms === null) return null;
  const hour = Math.floor(ms / HOUR_MS) * HOUR_MS;
  return hour >= eph.startMs && hour < eph.endMs ? hour : null;
}

// stay= in days: 1–60, rounded to the hour; anything else is the default
export function cleanStay(v) {
  const n = num(v);
  if (!Number.isFinite(n) || n < STAY_RANGE[0] - 1e-9 || n > STAY_RANGE[1] + 1e-9) return DEFAULTS.stayDays;
  return Math.round(n * 24) / 24;
}
const stayParam = (d) => String(Number(d.toFixed(4)));

// now= (the playhead): a UTC time to the minute inside the ephemeris, else null (the playhead starts at landing)
function parseNow(s, eph) {
  const ms = utcFields(s);
  if (ms === null) return null;
  return ms >= eph.startMs && ms <= eph.endMs ? ms : null;
}

function parseSite(s, sites) {
  if (typeof s !== 'string') return null;
  if (s.startsWith('c:')) {
    const [lat, lon] = s.slice(2).split(',');
    const r = parseCustomSite(lat ?? '', lon ?? '');
    return r.ok ? r.site : null;
  }
  return findSite(sites, s);
}

// ---------- phase 4 keys (fix L5) ----------
const r2 = (v) => round(v, 2);
const numList = (str, n) => {
  const parts = String(str ?? '').split(',');
  if (n !== undefined && parts.length !== n) return null;
  const v = parts.map(num);
  return v.every(Number.isFinite) ? v : null;
};
const inMapKm = (x, y) => Math.abs(x) <= VIEW_HALF_KM && Math.abs(y) <= VIEW_HALF_KM;
const pointsParam = (pts) => pts.map(([x, y]) => `${r2(x)},${r2(y)}`).join(';');
// anywhere: route points may lie anywhere on the Moon (the Map plans routes on the global terrain too); the polar
// km of the whole sphere bar the north pole stay under 100,000 km
function parsePoints(str, min, max, { anywhere = false } = {}) {
  if (typeof str !== 'string' || !str) return null;
  const pts = [];
  for (const pair of str.split(';')) {
    const v = numList(pair, 2);
    if (!v || !(anywhere ? Math.abs(v[0]) < 1e5 && Math.abs(v[1]) < 1e5 : inMapKm(v[0], v[1]))) return null;
    pts.push(v);
  }
  return pts.length >= min && pts.length <= max ? pts : null;
}

// Energy: "attitude,panel÷load,battery h,sleep load" (sleep load as a fraction), null = the card's defaults
export function cleanEnergy(v) {
  if (v == null) return null;
  let a = v;
  if (typeof v === 'string') {
    const [att, ...rest] = v.split(',');
    const n = rest.map(num);
    if (rest.length !== 3 || !n.every(Number.isFinite)) return null;
    a = { attitude: att, panelToLoad: n[0], batteryHours: n[1], sleepLoad: n[2] };
  }
  const c = cleanAssumptions(a);
  const out = Object.fromEntries(ENERGY_KEYS.map((k) => [k, typeof c[k] === 'number' ? round(c[k], 3) : c[k]]));
  return ENERGY_KEYS.every((k) => out[k] === ENERGY_DEFAULTS[k]) ? null : out;
}
function energyParam(e) {
  const c = cleanEnergy(e);
  return c ? `en=${c.attitude},${c.panelToLoad},${c.batteryHours},${c.sleepLoad}` : null;
}

// Relay: a preset id, or "c:" and the six elements (km, –, degrees), and the minimum elevation (relaymin,
// 0–45°); null = the first preset at 0° (the card's default)
function relayFromString(str) {
  if (typeof str !== 'string' || !str) return null;
  if (RELAY_PRESETS.some((p) => p.id === str)) return { presetId: str };
  if (!str.startsWith('c:')) return null;
  const n = numList(str.slice(2), RELAY_KEYS.length);
  return n ? { elements: Object.fromEntries(RELAY_KEYS.map((k, i) => [k, n[i]])) } : null;
}
export function cleanRelay(v) {
  if (v == null) return null;
  const o = typeof v === 'string' ? relayFromString(v) : v;
  if (!o) return null;
  const me = num(o.minElDeg);
  const minElDeg = Number.isFinite(me) ? clamp(round(me, 1), 0, 45) : 0;
  let out;
  if (o.presetId && RELAY_PRESETS.some((p) => p.id === o.presetId)) out = { presetId: o.presetId };
  else if (o.elements && RELAY_KEYS.every((k) => Number.isFinite(num(o.elements[k])))) out = { elements: Object.fromEntries(RELAY_KEYS.map((k) => [k, round(num(o.elements[k]), 4)])) };
  else if (minElDeg) out = { presetId: RELAY_PRESETS[0].id };
  else return null;
  if (minElDeg) out.minElDeg = minElDeg;
  return out.presetId === RELAY_PRESETS[0].id && !out.minElDeg ? null : out;
}
function relayParams(v) {
  const c = cleanRelay(v);
  if (!c) return [];
  const out = [];
  if (c.elements) out.push(`relay=c:${RELAY_KEYS.map((k) => c.elements[k]).join(',')}`);
  else if (c.presetId !== RELAY_PRESETS[0].id) out.push(`relay=${c.presetId}`);
  if (c.minElDeg) out.push(`relaymin=${c.minElDeg}`);
  return out;
}

// Route plan: points in map km "x,y;x,y" (2–8), the slope limit when not the default, the picked candidate
export function cleanRoutePlan(v) {
  if (v == null) return null;
  const pts = Array.isArray(v.points) ? parsePoints(pointsParam(v.points), 2, 8, { anywhere: true }) : null;
  if (!pts) return null;
  const s0 = num(v.maxSlopeDeg);
  const maxSlopeDeg = Number.isFinite(s0) ? clamp(Math.round(s0), 5, 30) : null;
  return { points: pts, maxSlopeDeg: maxSlopeDeg === DEFAULT_MAX_SLOPE ? null : maxSlopeDeg, selected: ROUTE_IDS.includes(v.selected) ? v.selected : null };
}

// Regions: "rect:x0,y0,x1,y1", "circle:cx,cy,r" or "poly:x,y;x,y;…", map km; north of 80°S in latitude and
// longitude, "grect:…", "gcircle:…", "gpoly:…" (georegion.js)
export function shapeParam(sh) {
  if (!sh) return null;
  if (sh.geo) return geoParam(sh);
  if (sh.type === 'rect') return `rect:${[sh.x0, sh.y0, sh.x1, sh.y1].map(r2).join(',')}`;
  if (sh.type === 'circle') return `circle:${[sh.cx, sh.cy, sh.rKm].map(r2).join(',')}`;
  if (sh.type === 'polygon') return `poly:${pointsParam(sh.points)}`;
  return null;
}
export function parseShape(str) {
  if (typeof str !== 'string') return null;
  const i = str.indexOf(':');
  const kind = str.slice(0, i), body = str.slice(i + 1);
  if (kind[0] === 'g') return parseGeo(kind, body);
  if (kind === 'rect') {
    const v = numList(body, 4);
    return v && inMapKm(v[0], v[1]) && inMapKm(v[2], v[3]) && v[0] !== v[2] && v[1] !== v[3] ? { type: 'rect', x0: v[0], y0: v[1], x1: v[2], y1: v[3] } : null;
  }
  if (kind === 'circle') {
    const v = numList(body, 3);
    return v && inMapKm(v[0], v[1]) && v[2] > 0 && v[2] <= 2 * VIEW_HALF_KM ? { type: 'circle', cx: v[0], cy: v[1], rKm: v[2] } : null;
  }
  if (kind === 'poly') {
    const pts = parsePoints(body, 3, 64);
    return pts ? { type: 'polygon', points: pts } : null;
  }
  return null;
}

export function parseHash(hash, sites, eph) {
  const f = fields(hash);
  const view = VIEWS.includes(f.view) ? f.view : DEFAULTS.view;
  const sheet = f.view === 'navigator' ? 'overview' : SHEET_TABS.includes(f.sheet) ? f.sheet : null;
  const site = parseSite(f.site, sites) ?? findSite(sites, DEFAULTS.site);
  const landingMs = parseTime(f.t, eph) ?? DEFAULTS.landingMs;
  const stayDays = isNumber(f.stay) ? cleanStay(f.stay) : DEFAULTS.stayDays;
  const slipDays = isNumber(f.slip) ? clamp(Math.round(Number(f.slip)), -60, 60) : DEFAULTS.slipDays;
  const mapMode = MODES.includes(f.mode) ? f.mode : DEFAULTS.mapMode;
  let altSite = DEFAULTS.altSite;
  if (f.alt === 'same' || (f.alt && findSite(sites, f.alt))) altSite = f.alt;
  else if (typeof f.alt === 'string' && f.alt.startsWith('c:')) {
    const p = parseSite(f.alt, sites);
    if (p) altSite = `c:${p.latDeg},${p.lonDeg}`;
  }
  const viewport = cleanViewport({ zoom: f.z, cx: f.cx, cy: f.cy });
  const windowOn = f.win !== 'off';
  const nowMs = parseNow(f.now, eph);
  return {
    view, site, landingMs, stayDays, slipDays: slipDays + 0, altSite, mapMode, picking: DEFAULTS.picking, cursorMs: nowMs ?? landingMs,
    windowOn, sheet,
    viewport, maxSlope: cleanMaxSlope(f.slope), maxDark: cleanMaxDark(f.dark), weights: cleanWeights(f.w),
    tool: DEFAULTS.tool, slot: DEFAULTS.slot,
    psr: f.psr === '1', energy: cleanEnergy(f.en ?? null),
    relay: f.relay || f.relaymin ? cleanRelay({ ...(relayFromString(f.relay) ?? {}), minElDeg: f.relaymin }) : null,
    routePlan: (() => { const pts = parsePoints(f.rp, 2, 8, { anywhere: true }); return pts ? cleanRoutePlan({ points: pts, maxSlopeDeg: f.rpslope, selected: f.rpsel }) : null; })(),
    regions: { A: parseShape(f.ra), B: parseShape(f.rb) },
  };
}

// Phase 3 keys are written only when they differ from the defaults, so a default state hashes
// exactly as in phase 2. Missing fields count as defaults.
function phase3Params(state) {
  const out = [];
  const v = cleanViewport(state.viewport ?? DEFAULTS.viewport);
  if (v.zoom !== DEFAULTS.viewport.zoom) out.push(`z=${v.zoom}`);
  if (v.cx !== DEFAULTS.viewport.cx) out.push(`cx=${v.cx}`);
  if (v.cy !== DEFAULTS.viewport.cy) out.push(`cy=${v.cy}`);
  const slope = state.maxSlope == null ? null : cleanMaxSlope(state.maxSlope);
  if (slope !== null) out.push(`slope=${slope}`);
  const dark = state.maxDark == null ? null : cleanMaxDark(state.maxDark);
  if (dark !== null) out.push(`dark=${dark}`);
  const w = cleanWeights(state.weights ?? DEFAULTS.weights);
  if (WEIGHT_KEYS.some((k) => w[k] !== DEFAULTS.weights[k])) out.push(`w=${WEIGHT_KEYS.map((k) => w[k]).join(',')}`);
  // phase 4 (fix L5)
  if (state.psr) out.push('psr=1');
  const en = energyParam(state.energy); if (en) out.push(en);
  out.push(...relayParams(state.relay));
  const rp = cleanRoutePlan(state.routePlan);
  if (rp) {
    out.push(`rp=${pointsParam(rp.points)}`);
    if (rp.maxSlopeDeg !== null) out.push(`rpslope=${rp.maxSlopeDeg}`);
    if (rp.selected) out.push(`rpsel=${rp.selected}`);
  }
  const ra = shapeParam(state.regions?.A), rb = shapeParam(state.regions?.B);
  if (ra) out.push(`ra=${ra}`);
  if (rb) out.push(`rb=${rb}`);
  // phase 5
  if (state.windowOn === false) out.push('win=off');
  if (Number.isFinite(state.cursorMs) && state.cursorMs !== state.landingMs) out.push(`now=${new Date(Math.floor(state.cursorMs / 60e3) * 60e3).toISOString().slice(0, 16)}Z`);
  if (SHEET_TABS.includes(state.sheet)) out.push(`sheet=${state.sheet}`);
  return out.length ? `&${out.join('&')}` : '';
}

function siteParam(site) {
  return site.id === 'custom' ? `c:${site.latDeg},${site.lonDeg}` : site.id;
}

export function toHash(state) {
  const t = new Date(state.landingMs).toISOString().slice(0, 16) + 'Z';
  return `#view=${state.view}&site=${siteParam(state.site)}&t=${t}&stay=${stayParam(state.stayDays)}&slip=${state.slipDays}&alt=${state.altSite}&mode=${state.mapMode}${phase3Params(state)}`;
}

// A point picked on the map as the alternative is written c:lat,lon and named "Map point".
export function customAlternative(altSite) {
  if (typeof altSite !== 'string' || !altSite.startsWith('c:')) return null;
  const [lat, lon] = altSite.slice(2).split(',');
  const r = parseCustomSite(lat ?? '', lon ?? '');
  return r.ok ? { ...r.site, id: 'custom-alt', name: 'Map point' } : null;
}

export function alternativeOf(state, sites) {
  const site = state.altSite === 'same' ? state.site : customAlternative(state.altSite) ?? findSite(sites, state.altSite) ?? state.site;
  return { site, landingMs: state.landingMs + state.slipDays * DAY_MS };
}

// phase 5: the top bar's link to a view (shell.js)
// It never carries the detail sheet (Evidence or Brief replace an open sheet; Map is the bare map) nor the
// playhead: the href is written at the last sync, and an old now= in it would move the clock back when the
// link is followed (review 2 F3); without now= the page keeps the playhead where it is.
export function viewHref(state, view) {
  return toHash({ ...state, view, sheet: null, cursorMs: state.landingMs });
}
