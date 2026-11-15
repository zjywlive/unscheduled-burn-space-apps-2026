// Mission exports → one browser-safe, read-only mission model. parseMission / parseLink return { mission }
// or { error }; no storage, clock or network. Missing planning fields and unreached times stay null.
// Canonical point names are stable; aliases are resolved case-insensitively by resolveMissionPoint.
import { parsePayload, timeSpan } from './route3d.js';
import { parseHash, DEFAULTS } from './state.js';
import { toXY } from './terrain.js';

export const MAX_MISSION_BYTES = 5 * 1024 * 1024;
const HOUR_MS = 3600e3;
const KM_EPS = 0.0001;   // payload km are rounded to four decimals (0.1 m)
const LINK_SPAN = { startMs: Date.UTC(2026, 10, 1), endMs: Date.UTC(2029, 0, 1) };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.trim() ? v.trim() : null;
const fail = (message) => { throw new Error(message); };
const num = (v) => Number.isFinite(v) ? v : null;

function optionalNumber(v, label, min = -Infinity, max = Infinity) {
  if (v == null) return null;
  if (!Number.isFinite(v) || v < min || v > max) fail(`${label} must be a finite number from ${min} to ${max}, or null.`);
  return v;
}
const time = (v, label) => optionalNumber(v, label, -8640000000000000, 8640000000000000);

function coords(p, label) {
  if (!object(p) || !Number.isFinite(p.latDeg) || Math.abs(p.latDeg) > 90 || !Number.isFinite(p.lonDeg) || p.lonDeg < -180 || p.lonDeg > 360) {
    fail(`${label} needs latitude −90…90 and east longitude −180…360.`);
  }
  return { latDeg: p.latDeg, lonDeg: p.lonDeg < 0 ? p.lonDeg + 360 : p.lonDeg === 360 ? 0 : p.lonDeg };
}

function siteOf(raw, sites) {
  if (!raw) return null;
  const id = text(raw.siteId ?? raw.id);
  const known = sites.find((s) => s.id === id);
  if (raw.latDeg == null && raw.lonDeg == null && !known) {
    if (id) fail(`Unknown site ${id}; the export has no coordinates.`);
    return null;
  }
  return { id, name: text(raw.siteName ?? raw.name) ?? known?.name ?? 'Planned site', ...coords(raw.latDeg == null && raw.lonDeg == null ? known : raw, 'site') };
}

function point(name, kind, raw, arriveMs = null, departMs = null, km = null) {
  const aliases = [...new Set([raw.name, raw.label, ...(Array.isArray(raw.aliases) ? raw.aliases : [])].map(text).filter((s) => s && s.toLowerCase() !== name.toLowerCase()))];
  const a = time(arriveMs, `${name}.arriveMs`), d = time(departMs, `${name}.departMs`);
  if (a !== null && d !== null && d < a) fail(`${name} departs before it arrives.`);
  return { name, kind, ...coords(raw, name), arriveMs: a, departMs: d, km: optionalNumber(km, `${name}.km`, 0), aliases };
}

function validateRoute(p) {
  if (!parsePayload(p)) fail('Route must be a route3d v1 payload with at least two coordinate/km samples.');
  let lastKm = -Infinity, lastTime = -Infinity;
  for (const [i, q] of p.pts.entries()) {
    coords({ latDeg: q[0], lonDeg: q[1] }, `route.pts[${i}]`);
    if (q[2] < 0 || q[2] < lastKm) fail('Route sample km must be non-negative and non-decreasing.');
    const t = time(q[3], `route.pts[${i}].time`);
    if (t !== null && t < lastTime) fail('Route sample times must be non-decreasing.');
    lastKm = q[2];
    if (t !== null) lastTime = t;
    optionalNumber(q[4], `route.pts[${i}].soc`, 0, 1);
  }
  const a = time(p.departMs, 'route.departMs'), b = time(p.arriveMs, 'route.arriveMs');
  if (a !== null && b !== null && b < a) fail('Route arrives before departure.');
  for (const key of ['wps', 'stops', 'havens']) {
    if (p[key] != null && !Array.isArray(p[key])) fail(`route.${key} must be an array.`);
    for (const [i, q] of (p[key] ?? []).entries()) {
      coords(q, `${key}[${i}]`);
      optionalNumber(q.km, `${key}[${i}].km`, 0);
      for (const k of ['tMs', 'arriveMs', 'departMs', 'fromMs', 'toMs']) time(q[k], `${key}[${i}].${k}`);
      if (q.fromMs != null && q.toMs != null && q.toMs < q.fromMs) fail('Charging stop ends before it starts.');
    }
  }
  if (p.emptyAt) { coords(p.emptyAt, 'empty'); time(p.emptyAt.tMs, 'empty.tMs'); optionalNumber(p.emptyAt.km, 'empty.km', 0); }
}

// Project onto the exported polar polyline, retaining route order at self-intersections/return legs.
// Only a point within 1 m of the line is treated as on-route: alternate havens must not acquire fake times.
function pathKm(p, q, afterKm = 0) {
  if (Number.isFinite(q.km)) return q.km;
  const [x, y] = toXY(q.latDeg, q.lonDeg);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let best = null;
  for (let i = 1; i < p.pts.length; i++) {
    const a = p.pts[i - 1], b = p.pts[i];
    if (b[2] < afterKm - 1e-6) continue;
    const [ax, ay] = toXY(a[0], a[1]), [bx, by] = toXY(b[0], b[1]);
    const dx = bx - ax, dy = by - ay, d2 = dx * dx + dy * dy;
    const f = d2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / d2)) : 0;
    const km = a[2] + f * (b[2] - a[2]), distance = Math.hypot(x - ax - f * dx, y - ay - f * dy);
    if (km < afterKm - 1e-6 || distance > 0.001) continue;
    if (!best || distance < best.distance - 1e-6 || (Math.abs(distance - best.distance) <= 1e-6 && km < best.km)) best = { km, distance };
  }
  return best?.km ?? null;
}

// A sample time is an arrival; explicit charging intervals supply dwell. Interpolation never bridges an
// untimed sample. Stops between samples split the drive so a long charge does not become slow motion.
function passAtKm(p, km) {
  if (km === null) return { arriveMs: null, departMs: null };
  const stops = p.stops ?? [];
  const here = stops.filter((s) => Math.abs(s.km - km) < KM_EPS);
  if (here.length) return {
    arriveMs: here.every((s) => Number.isFinite(s.fromMs)) ? Math.min(...here.map((s) => s.fromMs)) : null,
    departMs: here.every((s) => Number.isFinite(s.toMs)) ? Math.max(...here.map((s) => s.toMs)) : null,
  };
  const samples = p.pts.filter((q) => Math.abs(q[2] - km) < KM_EPS);
  if (samples.length) {
    const times = samples.map((q) => q[3]).filter(Number.isFinite);
    return { arriveMs: times.length ? Math.min(...times) : null, departMs: times.length ? Math.max(...times) : null };
  }
  for (let i = 1; i < p.pts.length; i++) {
    const a = p.pts[i - 1], b = p.pts[i];
    if (!(a[2] < km && km < b[2]) || !Number.isFinite(a[3]) || !Number.isFinite(b[3])) continue;
    if (stops.some((s) => s.km >= a[2] && s.km <= b[2] && (!Number.isFinite(s.fromMs) || !Number.isFinite(s.toMs)))) return { arriveMs: null, departMs: null };
    let loKm = a[2], loTime = a[3], hiKm = b[2], hiTime = b[3];
    for (const s of stops) {
      if (!(s.km >= a[2] && s.km <= b[2] && s.fromMs >= a[3] && s.toMs <= b[3])) continue;
      if (s.km < km && s.km >= loKm) { loKm = s.km; loTime = s.toMs; }
      if (s.km > km && s.km <= hiKm) { hiKm = s.km; hiTime = s.fromMs; }
    }
    // to the whole minute: a time interpolated along the polyline carries no sub-minute precision
    const t = Math.round((loTime + (hiTime - loTime) * (km - loKm) / (hiKm - loKm)) / 60e3) * 60e3;
    return { arriveMs: t, departMs: t };
  }
  return { arriveMs: null, departMs: null };
}

function addRoute(m, p, summary = {}) {
  if (!p) return;
  validateRoute(p);
  const row = (q) => ({ latDeg: q[0], lonDeg: q[1], km: q[2] });
  for (const [name, q] of [['start', p.pts[0]], ['end', p.pts[p.pts.length - 1]]]) {
    const at = passAtKm(p, q[2]);
    m.points.push(point(name, name, row(q), at.arriveMs, at.departMs, q[2]));
  }
  let afterKm = 0;
  for (const [i, w] of (p.wps ?? []).entries()) {
    const km = pathKm(p, w, afterKm), at = passAtKm(p, km);
    if (km !== null) afterKm = km;
    m.points.push(point(`W${i + 1}`, 'waypoint', w, w.arriveMs ?? w.tMs ?? at.arriveMs, w.departMs ?? at.departMs, km));
  }
  for (const [i, s] of (p.stops ?? []).entries()) m.points.push(point(`stop${i + 1}`, 'stop', s, s.fromMs, s.toMs, s.km));
  for (const [i, h] of (p.havens ?? []).entries()) {
    // A haven is a possible diversion, not a scheduled visit: only explicit times are retained.
    m.points.push(point(`haven${i + 1}`, 'haven', h, h.arriveMs ?? h.tMs, h.departMs, h.km));
  }
  if (p.emptyAt) m.points.push(point('empty', 'empty', p.emptyAt, p.emptyAt.tMs, p.emptyAt.tMs, p.emptyAt.km));
  const span = timeSpan(p), socs = p.pts.map((q) => q[4]).filter(Number.isFinite);
  m.route = {
    label: text(p.label), routeId: text(p.routeId), lengthKm: num(summary.lengthKm) ?? num(p.lengthKm) ?? p.pts[p.pts.length - 1][2],
    hours: num(summary.hours) ?? (span ? (span[1] - span[0]) / HOUR_MS : null),
    departMs: num(p.departMs), arriveMs: num(p.arriveMs), socMin: num(summary.socMin) ?? (socs.length ? Math.min(...socs) : null),
    oneWayKm: num(summary.oneWayKm), returnable: typeof summary.returnable === 'boolean' ? summary.returnable : null,
    trapsKm2: num(summary.trapsKm2), stationKm: num(summary.stationKm), earthShare: num(summary.earthShare),
    samples: p.pts,
  };
  m.notes.push('W1…Wn follow every exported waypoint, including start/end when included by the page.');
  m.notes.push('Waypoint times interpolate along the exported polyline (within 1 m), accounting for charging stops; untimed samples are not bridged.');
  m.notes.push('A timed transit sample is an instantaneous pass unless charging dwell is exported; havens have no scheduled visit unless explicitly timed.');
  if (p.emptyAt) m.notes.push('The exported energy simulation runs out of battery; later route points may be untimed.');
}

function geoRecord(g) {
  if (!Array.isArray(g.features)) fail('GeoJSON needs a features array.');
  const routes = g.features.filter((f) => f?.properties?.kind === 'route' && f.geometry?.type === 'LineString');
  if (routes.length !== 1) fail('Expected exactly one route LineString from the page GeoJSON export.');
  const line = routes[0], props = line.properties, c = line.geometry.coordinates;
  if (!Array.isArray(c)) fail('GeoJSON route coordinates must be an array.');
  for (const key of ['km', 'tMs', 'soc', 'flags', 'gradeDeg', 'heightM']) {
    if ((key === 'km' || props[key] != null) && (!Array.isArray(props[key]) || props[key].length !== c.length)) fail(`GeoJSON route ${key} must align with its coordinates.`);
  }
  const route = { v: 1, label: props.label, routeId: props.routeId, lengthKm: props.lengthKm,
    departMs: props.settings?.departMs ?? null, arriveMs: props.summary?.arriveMs ?? null,
    pts: c.map((q, i) => [q?.[1], q?.[0], props.km[i], props.tMs?.[i] ?? null, props.soc?.[i] ?? null, props.flags?.[i] ?? 0, props.gradeDeg?.[i] ?? null, props.heightM?.[i] ?? null]),
    wps: [], stops: [], havens: [], emptyAt: null };
  let landed = null;
  for (const f of g.features) {
    const kind = f?.properties?.kind;
    if (!['waypoint', 'stop', 'haven', 'touchdown', 'empty'].includes(kind)) continue;
    if (f.geometry?.type !== 'Point') fail(`GeoJSON ${kind} needs a Point geometry.`);
    const q = { ...f.properties, latDeg: f.geometry.coordinates?.[1], lonDeg: f.geometry.coordinates?.[0] };
    if (kind === 'waypoint') route.wps.push(q);
    else if (kind === 'stop') route.stops.push(q);
    else if (kind === 'haven') route.havens.push(q);
    else if (kind === 'empty') route.emptyAt = q;
    else landed = q;
  }
  route.wps.sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity));
  return { name: props.name, route, settings: props.settings, summary: props.summary, mission: { landed } };
}

export function parseMission(textOrObject, { sites = [] } = {}) {
  try {
    const json = typeof textOrObject === 'string' ? textOrObject : JSON.stringify(textOrObject);
    if (typeof json !== 'string') fail('Give a mission JSON object or JSON text.');
    if (json.length > MAX_MISSION_BYTES || new TextEncoder().encode(json).length > MAX_MISSION_BYTES) fail('Mission JSON is limited to 5 MB.');
    let raw;
    try { raw = JSON.parse(json); } catch { fail('Invalid mission JSON.'); }
    if (!object(raw)) fail('Mission JSON must be an object.');
    let kind, source = raw, planning, route, settings, summary;
    if (raw.kind === 'lsn-mission-record') {
      if (raw.v !== 1) fail('Unsupported mission record version; expected v1.');
      kind = raw.kind; planning = raw.mission; route = raw.route; settings = raw.settings; summary = raw.summary;
    } else if (raw.kind === 'lsn-config' || (!raw.kind && raw.site && raw.landing)) {
      if (raw.v !== 1) fail('Unsupported configuration version; expected v1.');
      kind = 'lsn-config';
      planning = { ...raw.site, siteId: raw.site?.id, siteName: raw.site?.name, landingMs: raw.landing?.requestedMs, stayDays: raw.stayDays, slipDays: raw.slipDays };
      route = raw.route; settings = { vehicle: raw.vehicle ?? null, departMs: raw.departMs ?? null, landing: raw.landing, checks: raw.checks ?? [] };
    } else if (!raw.kind && raw.type === 'FeatureCollection') {
      kind = 'geojson'; source = geoRecord(raw); planning = source.mission; route = source.route; settings = source.settings; summary = source.summary;
    } else if (!raw.kind && raw.v === 1 && Array.isArray(raw.pts)) {
      kind = 'route3d'; route = raw; settings = { limits: raw.limits ?? null, reserve: raw.reserve ?? null };
    } else fail(`Unsupported mission kind or version: ${raw.kind ?? raw.type ?? raw.v ?? 'unknown'}.`);
    const site = siteOf(planning, sites);
    const m = { kind, name: text(source.name) ?? site?.name ?? text(route?.label) ?? 'Imported mission', site,
      landingMs: time(planning?.landingMs, 'landingMs'), stayDays: optionalNumber(planning?.stayDays, 'stayDays', 1 / 24, 60),
      slipDays: optionalNumber(planning?.slipDays, 'slipDays', -60, 60), points: [], route: null, settings: object(settings) ? settings : {}, notes: [] };
    if (site) m.points.push(point('landing', 'landing', site, m.landingMs));
    if (planning?.landed) m.points.push(point('touchdown', 'touchdown', planning.landed, planning.landed.tMs));
    addRoute(m, route, object(summary) ? summary : {});
    if (!m.points.length) fail('The export contains no usable site or route points.');
    if (!site) m.notes.push('No planned landing site in the export; route start and actual touchdown are not substituted for landing.');
    if (m.landingMs === null || m.stayDays === null) m.notes.push('No complete landing/stay window in the export; stay conditions are unavailable.');
    if (m.slipDays === null) m.notes.push('No slip duration in the export; it remains null.');
    return { mission: m };
  } catch (e) { return { error: e.message ?? 'Invalid mission export.' }; }
}

export function parseLink(url, { sites = [] } = {}) {
  try {
    if (typeof url !== 'string' || !url.trim() || url.length > MAX_MISSION_BYTES) fail('Give a page share link with a # state.');
    const u = new URL(url, 'https://navigator.invalid/index.html');
    if (!['https:', 'http:', 'file:'].includes(u.protocol) || !u.hash) fail('Give a page share link with a # state (http, https or file).');
    const s = parseHash(u.hash, sites, LINK_SPAN);
    if (!s.site) fail(`The share link site cannot be resolved; the page default is ${DEFAULTS.site}.`);
    const site = siteOf(s.site, sites);
    return { mission: { kind: 'link', name: site.name, site, landingMs: s.landingMs, stayDays: s.stayDays, slipDays: s.slipDays,
      points: [point('landing', 'landing', site, s.landingMs)], route: null,
      settings: { energy: s.energy, relay: s.relay, mapMode: s.mapMode },
      notes: ['A share link imports only landing; no timed waypoints or route are imported, including any rp drawing.',
        `Share-link fields use state.js parseHash: missing/invalid values use page defaults (${DEFAULTS.site}, 2027-01-13T00:00Z, stay 14 d, slip 14 d); landing snaps down to the hour.`] } };
  } catch (e) { return { error: e.message ?? 'Invalid page share link.' }; }
}

export function resolveMissionPoint(mission, name) {
  const key = String(name).trim().toLowerCase();
  const canonical = mission.points.find((p) => p.name.toLowerCase() === key);
  if (canonical) return { point: canonical };
  const matches = mission.points.filter((p) => p.aliases.some((a) => a.toLowerCase() === key));
  if (matches.length > 1) return { error: `Ambiguous point alias ${name}; use ${matches.map((p) => p.name).join(', ')}.` };
  return matches.length ? { point: matches[0] } : { error: `No point ${name}; available: ${mission.points.map((p) => p.name).join(', ')}.` };
}
