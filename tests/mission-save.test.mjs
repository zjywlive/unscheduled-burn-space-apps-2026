// Saved missions (demo/src/mission-save.js): records in storage, newest first, and the exported files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord, parseRecord, listRecords, saveRecord, loadRecord, deleteRecord, withRecording, toGeoJSON, routeCSV, recordingCSV, fileName, MAX_RECORDS, RECORDS_KEY, RECORDING_FIELDS } from '../demo/src/mission-save.js';

function memStore(limitChars = Infinity) {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (v.length > limitChars) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); },
    removeItem: (k) => m.delete(k),
  };
}
const T = Date.UTC(2027, 0, 13, 6);
const route = {
  v: 1, label: 'Flattest', routeId: 'flat', lengthKm: 2.5, departMs: T, arriveMs: T + 3 * 3600e3, reserve: 0.2,
  pts: [[-89.4, 222.7, 0, T, 1, 3, 2.5, 1510.2], [-89.41, 222.75, 1.2, T + 3600e3, 0.95, 1 | 8, -12, 1490], [-89.42, 222.8, 2.5, T + 3 * 3600e3, 0.9, 7, null, null]],
  stops: [{ latDeg: -89.41, lonDeg: 222.75, km: 1.2, fromMs: T + 3600e3, toMs: T + 2 * 3600e3 }],
  havens: [{ latDeg: -89.415, lonDeg: 222.6 }], emptyAt: null,
  wps: [{ latDeg: -89.4, lonDeg: 222.7 }, { latDeg: -89.42, lonDeg: 222.8 }],
  traps: { cellKm: 0.24, cells: [[-89.43, 222.9], [-89.431, 222.91]] },
};
const mission = { siteName: 'Shackleton ridge', landed: { latDeg: -89.4, lonDeg: 222.7, tMs: T - 86400e3 } };

test('a record holds the route, the settings and a readable name; parse rejects other JSON', () => {
  const r = buildRecord({ mission, settings: { maxSlopeDeg: 15 }, summary: { lengthKm: 2.5 }, route, savedMs: T });
  assert.equal(r.kind, 'lsn-mission-record');
  assert.match(r.name, /^Flattest route from Shackleton ridge · 2027-01-13 06:00 UTC$/);
  assert.deepEqual(parseRecord(JSON.stringify(r)), r);
  assert.equal(parseRecord('{"kind":"other"}'), null);
  assert.equal(parseRecord('nope'), null);
});

test('storage keeps the newest records, replaces by id, loads and deletes', () => {
  const s = memStore();
  for (let i = 0; i < MAX_RECORDS + 3; i++) assert.equal(saveRecord(buildRecord({ route, savedMs: T + i * 1000 }), s).ok, true);
  const list = listRecords(s);
  assert.equal(list.length, MAX_RECORDS);
  assert.equal(list[0].savedMs, T + (MAX_RECORDS + 2) * 1000, 'newest first');
  const top = loadRecord(list[0].id, s);
  assert.equal(top.route.label, 'Flattest');
  saveRecord(withRecording(top, { startedMs: T, fields: [...RECORDING_FIELDS], samples: [[T, -89.4, 222.7, 0, 1510, 1, -2, 90, 1, 3]] }), s);
  assert.equal(listRecords(s).length, MAX_RECORDS, 'replaced, not added');
  assert.equal(listRecords(s)[0].recorded, true);
  deleteRecord(list[0].id, s);
  assert.equal(loadRecord(list[0].id, s), null);
  s.setItem(RECORDS_KEY, 'garbage');
  assert.deepEqual(listRecords(s), []);
});

test('a full browser storage drops the oldest records until the new one fits', () => {
  const one = JSON.stringify([buildRecord({ route, savedMs: T })]).length;
  const s = memStore(one * 3.5);
  for (let i = 0; i < 3; i++) saveRecord(buildRecord({ route, savedMs: T + i }), s);
  const res = saveRecord(buildRecord({ route, savedMs: T + 10 }), s);
  assert.equal(res.ok, true);
  assert.ok(res.dropped >= 1);
  assert.equal(listRecords(s)[0].savedMs, T + 10);
  const tiny = memStore(10);
  assert.equal(saveRecord(buildRecord({ route, savedMs: T }), tiny).ok, false);
});

test('GeoJSON: the route line in −180…180 longitude with per-point data, and every other feature', () => {
  const r = withRecording(buildRecord({ mission, route, savedMs: T }), { startedMs: T, fields: [...RECORDING_FIELDS], samples: [[T, -89.4, 222.7, 0, 1510, 1, -2, 90, 1, 3], [T + 1, -89.41, 222.75, 1.2, 1490, 3, 1, 95, 0.95, 9]] });
  const g = toGeoJSON(r);
  const kinds = g.features.map((f) => f.properties.kind);
  assert.deepEqual(kinds, ['route', 'waypoint', 'waypoint', 'haven', 'stop', 'touchdown', 'traps', 'recorded-track']);
  const line = g.features[0];
  assert.ok(Math.abs(line.geometry.coordinates[0][0] - (222.7 - 360)) < 1e-9);
  assert.deepEqual(line.properties.gradeDeg, [2.5, -12, null]);
  assert.deepEqual(line.properties.heightM, [1510.2, 1490, null]);
  assert.equal(g.features[6].geometry.coordinates.length, 2);
});

test('CSV: one row per route point and per recorded sample', () => {
  const r = buildRecord({ route, savedMs: T });
  const rows = routeCSV(r).trim().split('\n');
  assert.equal(rows.length, 4);
  assert.equal(rows[0], 'km,lat_deg,lon_deg_east,utc,battery_share,sunlit,earth_in_view,station_link,one_way,grade_deg,height_m');
  assert.equal(rows[2], '1.2,-89.41,222.75,"2027-01-13T07:00:00.000Z",0.95,1,0,0,1,-12,1490');
  assert.ok(rows[3].endsWith(',,'), 'missing grade and height are empty cells');
  const rec = recordingCSV({ fields: [...RECORDING_FIELDS], samples: [[T, -89.4, 222.7, 0, 1510, 1.5, -2, 90, 1, 3]] }).trim().split('\n');
  assert.equal(rec[0], RECORDING_FIELDS.join(','));
  assert.ok(rec[1].startsWith('2027-01-13T06:00:00.000Z,-89.4,'));
  assert.equal(recordingCSV(null), '');
  assert.equal(fileName({ name: 'Flattest route · 2027/01' }, 'csv'), 'Flattest_route_202701.csv');
});

test('a saved record keeps a thinned sample of the self-driving search trees', async () => {
  const { SAVED_TREE_EDGES } = await import('../demo/src/mission-save.js');
  const trees = Array.from({ length: 5000 }, (_, i) => [-89.4, 222.7, -89.4 - i * 1e-5, 222.7]);
  const r = buildRecord({ route: { ...route, autonav: { trajectory: [[-89.4, 222.7], [-89.42, 222.8]], candidates: [], trees } }, savedMs: T });
  assert.ok(r.route.autonav.trees.length <= SAVED_TREE_EDGES && r.route.autonav.trees.length > SAVED_TREE_EDGES / 2);
  assert.equal(r.route.autonav.trajectory.length, 2);
  assert.equal(route.autonav, undefined, 'the input is not changed');
});
