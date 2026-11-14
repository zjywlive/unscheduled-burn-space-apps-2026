// Pure helpers of the route card's Mission file section (demo/src/ui/mission-records.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsOf, summaryOf, recordInputs, listText } from '../demo/src/ui/mission-records.js';
import { toXY, fromXY } from '../demo/src/terrain.js';
import { buildRecord } from '../demo/src/mission-save.js';
import { slopeRuns } from '../demo/src/map/routes-layer.js';

const T = Date.UTC(2027, 0, 13, 6);
const route = {
  v: 1, label: 'Flattest', routeId: 'flat', lengthKm: 2.5, departMs: T,
  pts: [[-89.4, 222.7, 0, T, 1, 3, 2.5, 1510], [-89.42, 222.8, 2.5, T + 3600e3, 0.9, 7, null, null]],
  wps: [{ latDeg: -89.4, lonDeg: 222.7 }, { latDeg: -89.41, lonDeg: 222.75 }, { latDeg: -89.42, lonDeg: 222.8 }],
};

test('settingsOf keeps what the plan was made with and drops the station when it is off', () => {
  const s = settingsOf({ maxSlopeDeg: 15, mobility: { climbDeg: 15, descentDeg: 20, crossDeg: 12, speedKmh: 0.8 }, power: { batteryWh: 5000 }, station: { mastM: 15 }, stationOff: true, departMs: T });
  assert.equal(s.station, null);
  assert.equal(s.stationOff, true);
  assert.equal(s.mobility.speedKmh, 0.8);
  assert.equal(settingsOf({}).maxSlopeDeg, null);
});

test('summaryOf fills the figures it has and leaves the rest null', () => {
  const sum = summaryOf({
    route: { id: 'flat', label: 'Flattest', lengthKm: 2.5, oneWayKm: 0.2 }, plan: { returnable: true, traps: { km2: 1.5 } },
    drive: { ok: true, driveH: 3, waitH: 1, arriveMs: T + 4 * 3600e3, socMin: 0.4 }, comms: { summary: { stationKm: 1, earthKm: 1.25, totalKm: 2.5 } },
  });
  assert.deepEqual(sum, { routeId: 'flat', label: 'Flattest', lengthKm: 2.5, hours: 4, arriveMs: T + 4 * 3600e3, socMin: 0.4, oneWayKm: 0.2, returnable: true, trapsKm2: 1.5, stationKm: 1, earthShare: 0.5 });
  const bare = summaryOf({ route: { id: 'short' } });
  assert.equal(bare.arriveMs, null); assert.equal(bare.stationKm, null); assert.equal(bare.returnable, null);
});

test('recordInputs turns a record back into the card inputs', () => {
  const rec = buildRecord({ mission: { siteName: 'Shackleton ridge' }, settings: settingsOf({ maxSlopeDeg: 18, mobility: { descentDeg: 22, crossDeg: 10, speedKmh: 1 }, power: null, station: { mastM: 20 }, departMs: T }), summary: { routeId: 'sunny' }, route, savedMs: T });
  const i = recordInputs(rec);
  assert.equal(i.points.length, 3);
  const back = fromXY(...i.points[1]);
  assert.ok(Math.abs(back.latDeg + 89.41) < 1e-6 && Math.abs(back.lonDeg - 222.75) < 1e-6);
  assert.deepEqual(i.points[0], toXY(-89.4, 222.7));
  assert.equal(i.maxSlopeDeg, 18);
  assert.equal(i.mobility.descentDeg, 22);
  assert.equal(i.station.mastM, 20);
  assert.equal(i.stationOff, false);
  assert.equal(i.departMs, T);
  assert.equal(i.routeId, 'sunny');
  assert.equal(i.siteName, 'Shackleton ridge');
});

test('recordInputs falls back to the route ends, the route id and the limits of the payload', () => {
  const { wps, ...bare } = route;
  const i = recordInputs({ route: { ...bare, limits: { climbDeg: 14, descentDeg: 20, crossDeg: 11 } }, settings: {}, summary: {}, mission: null });
  assert.equal(i.points.length, 2);
  assert.equal(i.routeId, 'flat');
  assert.equal(i.maxSlopeDeg, 14);
  assert.equal(i.departMs, T);
  assert.equal(recordInputs({ route, settings: { station: null }, summary: {} }).stationOff, true);
});

test('listText shows the name, the length and the date', () => {
  const t = listText({ name: 'A', lengthKm: 2.54, savedMs: T, recorded: true });
  assert.equal(t.sub, '2.5 km · 2027-01-13 06:00 UTC');
  assert.equal(t.recorded, true);
});

test('slopeRuns groups the profile into one path per grade band', () => {
  const tan = (d) => Math.tan(d * Math.PI / 180);
  const profile = { x: [0, 1, 2, 3, 4], y: [0, 0, 0, 0, 0], km: [1, 1, 1, 1, 1], pitch: [0, tan(1), tan(1), -tan(9), tan(20)] };
  const runs = slopeRuns(profile, (x, y) => [x * 10, y]);
  assert.deepEqual(runs.map((r) => r.colour), ['#22d3ee', '#fb923c', '#d946ef']);
  assert.equal(runs[0].d, 'M0 0L10 0L20 0');
  assert.equal(slopeRuns({ x: [0], y: [0], pitch: [0] }, () => [0, 0]).length, 0);
});
