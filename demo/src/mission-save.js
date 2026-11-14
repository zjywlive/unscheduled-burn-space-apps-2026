// Saved missions: a planned route with everything around it (the route3d.js payload: path, times, battery,
// sunlight, links, grade and height per point, waypoints, havens, traps, the touchdown; the settings it was
// planned with; a summary; and, when recorded on the globe, the rover's motion), kept in localStorage and
// exported as files. Pure apart from downloadText(); no imports.
//
// Record v1 = { kind: 'lsn-mission-record', v: 1, id, name, savedMs, mission, settings, summary, route, recording }
//   mission    mission-flow.js mission (site, landing time, touchdown)
//   settings   { maxSlopeDeg, mobility, power, station, departMs }
//   summary    { routeId, label, lengthKm, hours, arriveMs, socMin, oneWayKm, returnable, trapsKm2, stationKm, earthShare }
//   route      route3d.js payload v1
//   recording  null | { startedMs, fields: [...], samples: [[…], …] }   motion recorded during 3D playback

export const RECORDS_KEY = 'lsn-records';
export const MAX_RECORDS = 20;
export const RECORDING_FIELDS = Object.freeze(['tMs', 'latDeg', 'lonDeg', 'km', 'heightM', 'pitchDeg', 'rollDeg', 'yawDeg', 'soc', 'flags']);
const store = (s) => s ?? (typeof localStorage !== 'undefined' ? localStorage : null);

// The self-driving planner's search trees (route.autonav.trees) can be thousands of edges: a saved record keeps
// at most this many, so twenty records still fit in the browser's storage.
export const SAVED_TREE_EDGES = 600;

export function buildRecord({ name = null, mission = null, settings = {}, summary = {}, route: full, recording = null, savedMs = Date.now() }) {
  const trees = full?.autonav?.trees;
  const route = trees?.length > SAVED_TREE_EDGES ? { ...full, autonav: { ...full.autonav, trees: trees.filter((_, i) => i % Math.ceil(trees.length / SAVED_TREE_EDGES) === 0) } } : full;
  const id = `m${savedMs.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const label = route?.label ? `${route.label} route` : 'Route';
  const where = mission?.siteName ?? (route?.pts?.[0] ? `${route.pts[0][0].toFixed(2)}°, ${route.pts[0][1].toFixed(2)}°` : '');
  return {
    kind: 'lsn-mission-record', v: 1, id, savedMs,
    name: name ?? `${label}${where ? ` from ${where}` : ''} · ${new Date(savedMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    mission, settings, summary, route, recording,
  };
}

export function parseRecord(text) {
  try {
    const r = typeof text === 'string' ? JSON.parse(text) : text;
    return r && r.kind === 'lsn-mission-record' && r.v === 1 && r.route && Array.isArray(r.route.pts) ? r : null;
  } catch { return null; }
}

function readAll(storage) {
  try { const a = JSON.parse(store(storage)?.getItem(RECORDS_KEY) ?? '[]'); return Array.isArray(a) ? a.filter((r) => parseRecord(r)) : []; } catch { return []; }
}
function writeAll(list, storage) {
  store(storage)?.setItem(RECORDS_KEY, JSON.stringify(list));
}

// Newest first: { id, name, savedMs, lengthKm, label, recorded }
export function listRecords(storage) {
  return readAll(storage).sort((a, b) => b.savedMs - a.savedMs).map((r) => ({ id: r.id, name: r.name, savedMs: r.savedMs, lengthKm: r.route.lengthKm, label: r.route.label, recorded: !!r.recording?.samples?.length }));
}

// Saves (or replaces by id) a record, keeping the newest MAX_RECORDS. When the browser's storage is full the
// oldest are dropped until it fits. → { ok, dropped, reason }
export function saveRecord(record, storage) {
  let list = readAll(storage).filter((r) => r.id !== record.id);
  list.unshift(record);
  list.sort((a, b) => b.savedMs - a.savedMs);
  let dropped = Math.max(0, list.length - MAX_RECORDS);
  list = list.slice(0, MAX_RECORDS);
  for (;;) {
    try { writeAll(list, storage); return { ok: true, dropped, reason: null }; } catch (e) {
      if (list.length <= 1) return { ok: false, dropped, reason: 'The browser storage is full; download the file instead.' };
      list.pop(); dropped++;
    }
  }
}

export const loadRecord = (id, storage) => readAll(storage).find((r) => r.id === id) ?? null;
export function deleteRecord(id, storage) { writeAll(readAll(storage).filter((r) => r.id !== id), storage); }

// Adds a motion recording to a stored record (by id), or returns the record with it for a download.
export function withRecording(record, recording) { return { ...record, recording }; }

// ---------- files ----------
const lonE = (lon) => (lon > 180 ? lon - 360 : lon);   // GeoJSON wants −180…180

// GeoJSON (selenographic lat/lon, east longitude −180…180): the route line with per-vertex arrays in its
// properties, the waypoints, havens, stops, the touchdown and the traps.
export function toGeoJSON(r) {
  const p = r.route, f = [];
  f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: p.pts.map((q) => [lonE(q[1]), q[0]]) },
    properties: { kind: 'route', name: r.name, routeId: p.routeId, label: p.label, lengthKm: p.lengthKm, body: 'Moon (IAU 2015, mean radius 1737.4 km)',
      km: p.pts.map((q) => q[2]), tMs: p.pts.map((q) => q[3]), soc: p.pts.map((q) => q[4]), flags: p.pts.map((q) => q[5]), gradeDeg: p.pts.map((q) => q[6] ?? null), heightM: p.pts.map((q) => q[7] ?? null),
      summary: r.summary, settings: r.settings } });
  (p.wps ?? []).forEach((w, i) => f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lonE(w.lonDeg), w.latDeg] }, properties: { kind: 'waypoint', n: i + 1 } }));
  (p.havens ?? []).forEach((h) => f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lonE(h.lonDeg), h.latDeg] }, properties: { kind: 'haven' } }));
  (p.stops ?? []).forEach((s) => f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lonE(s.lonDeg), s.latDeg] }, properties: { kind: 'stop', km: s.km, fromMs: s.fromMs, toMs: s.toMs } }));
  if (r.mission?.landed) f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lonE(r.mission.landed.lonDeg), r.mission.landed.latDeg] }, properties: { kind: 'touchdown', ...r.mission.landed } });
  if (p.traps?.cells?.length) f.push({ type: 'Feature', geometry: { type: 'MultiPoint', coordinates: p.traps.cells.map(([la, lo]) => [lonE(lo), la]) }, properties: { kind: 'traps', cellKm: p.traps.cellKm } });
  if (r.recording?.samples?.length) f.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.recording.samples.map((s) => [lonE(s[2]), s[1]]) }, properties: { kind: 'recorded-track', fields: r.recording.fields } });
  return { type: 'FeatureCollection', features: f };
}

const csvCell = (v) => (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? '' : typeof v === 'number' ? String(+v.toFixed(6)) : `"${String(v).replace(/"/g, '""')}"`);

// One row per route point: where, when, battery, sunlight / Earth / station / one-way, grade and height.
export function routeCSV(r) {
  const head = ['km', 'lat_deg', 'lon_deg_east', 'utc', 'battery_share', 'sunlit', 'earth_in_view', 'station_link', 'one_way', 'grade_deg', 'height_m'];
  const rows = r.route.pts.map((q) => [q[2], q[0], q[1], Number.isFinite(q[3]) ? new Date(q[3]).toISOString() : null, q[4], q[5] & 1 ? 1 : 0, q[5] & 2 ? 1 : 0, q[5] & 4 ? 1 : 0, q[5] & 8 ? 1 : 0, q[6] ?? null, q[7] ?? null]);
  return [head.join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n') + '\n';
}

// One row per recorded motion sample.
export function recordingCSV(rec) {
  if (!rec?.samples?.length) return '';
  const fields = rec.fields ?? RECORDING_FIELDS;
  return [fields.join(','), ...rec.samples.map((s) => s.map((v, i) => (fields[i] === 'tMs' && Number.isFinite(v) ? new Date(v).toISOString() : csvCell(v))).join(','))].join('\n') + '\n';
}

export const fileName = (r, ext) => `${(r.name ?? 'mission').replace(/[^A-Za-z0-9._ -]+/g, '').replace(/\s+/g, '_').slice(0, 80)}.${ext}`;

// Offers a text file to save (browser only).
export function downloadText(doc, filename, text, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = doc.createElement('a');
  a.href = url; a.download = filename;
  doc.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
