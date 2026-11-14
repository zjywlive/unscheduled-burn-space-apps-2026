// Fix R8/R9: the shared coordinate parser (demo/src/coords.js) and the Route plan rows that use it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDegrees, parseLat, parseLon, parseKm, parseLatLon, formatLat, formatLon, formatKm, fieldsFromXY, MAP_EDGE_LAT } from '../demo/src/coords.js';
import { toXY } from '../demo/src/terrain.js';
import { readRows } from '../demo/src/ui/routeplan.js';

test('coords: latitudes as people type them', () => {
  for (const t of ['-89.45', '−89.45', '89.45S', '89.45 S', '89.45°S', '89,45 s', ' 89.45 ° S ', '-89.450']) assert.equal(parseLat(t).value, -89.45, t);
  assert.equal(parseDegrees('89.45N', 'lat'), 89.45);
  assert.ok(Number.isNaN(parseDegrees('89.45E', 'lat')));    // a longitude letter on a latitude
  assert.ok(Number.isNaN(parseDegrees('-89.45S', 'lat')));   // two signs
  assert.equal(parseLat('').code, 'empty');
  assert.equal(parseLat('abc').code, 'nan');
  assert.equal(parseLat('1.2.3').code, 'nan');
  assert.equal(parseLat('-95').code, 'range');
  assert.equal(parseLat('-75').code, 'outside');             // north of the mapped disc (80°S)
  assert.match(parseLat('-75').message, /south of 80°S/);
  assert.equal(parseLat('89.45').code, 'outside');           // a bare positive latitude is north
  assert.match(parseLat('89.45').message, /−89\.45 or 89\.45S/);
  assert.equal(parseLat('-80').value, -80);                  // the edge itself is on the map
  assert.equal(MAP_EDGE_LAT, -80);
  assert.equal(parseLat('-60', { maxLatDeg: 90 }).value, -60);   // e.g. a custom site anywhere
});

test('coords: longitudes east 0–360, negative or W for west', () => {
  assert.equal(parseLon('222.6').value, 222.6);
  assert.equal(parseLon('222.6E').value, 222.6);
  assert.ok(Math.abs(parseLon('137.4W').value - 222.6) < 1e-9);
  assert.ok(Math.abs(parseLon('-137.4').value - 222.6) < 1e-9);
  assert.equal(parseLon('360').value, 0);
  assert.equal(parseLon('0').value, 0);
  assert.equal(parseLon('400').code, 'range');
  assert.equal(parseLon('-190').code, 'range');
  assert.equal(parseLon('12S').code, 'nan');
  assert.equal(parseLon(' ').code, 'empty');
});

test('coords: km, pairs and formatting', () => {
  assert.equal(parseKm('5').value, 5);
  assert.equal(parseKm('5.5 km').value, 5.5);
  assert.equal(parseKm('12,5km').value, 12.5);
  assert.equal(parseKm('0').code, 'range');
  assert.equal(parseKm('-3').code, 'range');
  assert.equal(parseKm('400', { maxKm: 300 }).code, 'range');
  assert.equal(parseKm('five').code, 'nan');
  const p = parseLatLon('89.45S', '137.31W');
  assert.equal(p.ok, true);
  assert.deepEqual(p.xy, toXY(-89.45, p.lonDeg));
  assert.ok(Math.abs(p.lonDeg - 222.69) < 1e-9);
  assert.deepEqual([parseLatLon('-70', '10').field, parseLatLon('-85', 'x').field], ['lat', 'lon']);
  assert.equal(formatLat(-89.45), '−89.450');
  assert.equal(formatLon(-137.31), '222.690');
  assert.equal(formatLon(359.9999), '0.000');
  assert.equal(formatKm(5), '5');
  assert.equal(formatKm(5.4321), '5.43');
  const f = fieldsFromXY(toXY(-89.45, 222.69));
  assert.deepEqual(f, { lat: '−89.450', lon: '222.690' });
});

test('coords: the Route plan rows accept the same formats (R8)', () => {
  const r = readRows([{ lat: '89.45S', lon: '137.31W' }, { lat: '−88.5', lon: '293.3E' }]);
  assert.equal(r.errors.length, 0);
  const want = [toXY(-89.45, 222.69), toXY(-88.5, 293.3)];
  r.points.forEach((p, i) => assert.ok(Math.hypot(p[0] - want[i][0], p[1] - want[i][1]) < 1e-6));
  const bad = readRows([{ lat: '89.45', lon: '10' }, { lat: '-85', lon: '361' }]);
  assert.deepEqual(bad.errors.map((e) => [e.index, e.field]), [[0, 'lat'], [1, 'lon']]);
});
