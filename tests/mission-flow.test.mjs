// The mission across the pages (demo/src/mission-flow.js): stored state and the stage links.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readMission, writeMission, stageUrl, STAGES, MISSION_KEY } from '../demo/src/mission-flow.js';

const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const T = Date.UTC(2027, 0, 13, 0, 0);

test('the mission round-trips through storage and merges updates', () => {
  const s = memory();
  assert.equal(readMission(s), null);
  writeMission({ siteId: 'shackleton', siteName: 'Shackleton ridge', latDeg: -89.45, lonDeg: 222.69, landingMs: T }, s);
  const m = writeMission({ landingMs: T + 86400e3 }, s);
  assert.equal(m.siteId, 'shackleton');
  assert.equal(readMission(s).landingMs, T + 86400e3);
  s.setItem(MISSION_KEY, '{broken');
  assert.equal(readMission(s), null);
});

test('stage links carry the site and landing time to each page', () => {
  const m = { siteId: 'de-gerlache-rim-2', latDeg: -88.5, lonDeg: 293.3, landingMs: T, stayDays: 14 };
  assert.equal(stageUrl('site', m), 'index.html#view=map&site=de-gerlache-rim-2&t=2027-01-13T00:00Z&stay=14');
  assert.equal(stageUrl('rover', m), 'index.html#view=map&site=de-gerlache-rim-2&t=2027-01-13T00:00Z&stay=14&plan=1');
  assert.equal(stageUrl('map', m), stageUrl('site', m));
  assert.equal(stageUrl('region', m), 'planner.html?at=-88.5000,293.3000&t=2027-01-13T00:00Z');
  assert.equal(stageUrl('finalise', m), 'finalise.html');
  assert.equal(stageUrl('execute', m), 'lander.html');
  assert.match(stageUrl('3d', m), /^globe\.html#lat=-88\.5000&lon=293\.3000&dist=45/);
  assert.equal(stageUrl('3d', m, { route: true }), 'globe.html#route=1');
  assert.equal(stageUrl('region', null), 'planner.html');
  assert.equal(STAGES.map((s) => `${s.group} ${s.n} ${s.id}`).join(', '), 'Plan 1 map, Plan 2 finalise, Fly 3 execute');
});

test('a custom site (no id) goes as coordinates', () => {
  assert.match(stageUrl('site', { latDeg: -87.25, lonDeg: 10.5, landingMs: T }), /site=c:-87\.2500,10\.5000&t=/);
  // the Map stores a picked point with siteId 'custom'; the link must not name a site called "custom"
  assert.match(stageUrl('rover', { siteId: 'custom', latDeg: -73.925, lonDeg: 238.352, landingMs: T }), /site=c:-73\.9250,238\.3520&t=.*&plan=1$/);
});

test('the touchdown point: kept only for its own site, carried to the rover and 3D steps', async () => {
  const { landedFor, landFromHash, moonKm } = await import('../demo/src/mission-flow.js');
  const m = { siteId: 'shackleton', latDeg: -89.45, lonDeg: 222.69, landingMs: T, landed: { latDeg: -89.441, lonDeg: 222.4, siteId: 'shackleton', source: 'hazard-divert' } };
  assert.equal(landedFor(m).source, 'hazard-divert');
  assert.equal(landedFor({ ...m, siteId: 'haworth' }), null, 'another site');
  assert.equal(landedFor({ ...m, siteId: null, landed: { ...m.landed, siteId: null }, latDeg: -85, lonDeg: 0 }), null, 'more than 30 km away');
  assert.match(stageUrl('rover', m), /&plan=1&land=-89\.44100,222\.40000$/);
  assert.match(stageUrl('3d', m), /^globe\.html#lat=-89\.4410&lon=222\.4000&dist=12/);
  assert.deepEqual(landFromHash('#view=map&land=-89.44100,222.40000&plan=1'), { latDeg: -89.441, lonDeg: 222.4 });
  assert.equal(landFromHash('#view=map'), null);
  assert.ok(Math.abs(moonKm(-90, 0, -89, 0) - 30.32) < 0.01, 'one degree of latitude is 30.3 km');
});

test('the execution phases cover every lander phase once, in flight order', async () => {
  const { EXEC_PHASES, execPhaseOf } = await import('../demo/src/mission-flow.js');
  const { PHASES } = await import('../demo/src/lander/mission.js');
  assert.deepEqual(EXEC_PHASES.map((p) => p.label), ['Launch', 'Spaceflight', 'Orbital manoeuvres', 'Lunar orbit insertion', 'Landing', 'Surface operations']);
  const order = PHASES.map((p) => EXEC_PHASES.findIndex((e) => e.id === execPhaseOf(p.id)));
  assert.ok(order.every((k) => k >= 0), 'every lander phase belongs to an execution phase');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'in order');
});
