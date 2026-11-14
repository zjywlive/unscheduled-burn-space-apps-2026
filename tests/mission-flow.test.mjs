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
  assert.equal(stageUrl('landing', m), 'lander.html?site=de-gerlache-rim-2&t=2027-01-13T00:00Z');
  assert.match(stageUrl('3d', m), /^globe\.html#lat=-88\.5000&lon=293\.3000&dist=45/);
  assert.equal(stageUrl('3d', m, { route: true }), 'globe.html#route=1');
  assert.equal(stageUrl('landing', null), 'lander.html');
  assert.equal(STAGES.map((s) => `${s.n} ${s.id}`).join(', '), '1 landing, 2 rover, 3 3d');
});

test('a custom site (no id) goes as coordinates', () => {
  assert.match(stageUrl('site', { latDeg: -87.25, lonDeg: 10.5, landingMs: T }), /site=-87\.2500,10\.5000&t=/);
});
