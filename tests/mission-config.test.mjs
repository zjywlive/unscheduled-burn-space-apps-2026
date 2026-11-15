// The frozen mission configuration (demo/src/mission-config.js): built from the planning state, named by its
// content, stored, compared with later planning changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, readConfig, writeConfig, clearConfig, changesSince, windowAround, verdictOf, configId, CONFIG_KEY } from '../demo/src/mission-config.js';

const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const T = Date.UTC(2027, 0, 10, 2, 0);
const mission = { siteId: 'shackleton', siteName: 'Shackleton ridge', latDeg: -89.45, lonDeg: 222.69, landingMs: T, stayDays: 14 };
const route = { v: 1, label: 'Flattest', lengthKm: 12.3, departMs: T + 86400e3, pts: [[-89.45, 222.69, 0], [-89.3, 230, 12.3]] };

test('a configuration carries every decision and is named by them', () => {
  const c = buildConfig({ mission, vehicle: { dryMassKg: 800 }, route, window: { startMs: T - 3600e3, endMs: T + 7200e3, earth: true }, nowMs: 1 });
  assert.equal(c.site.name, 'Shackleton ridge');
  assert.equal(c.landing.windowEndMs, T + 7200e3);
  assert.equal(c.departMs, T + 86400e3);
  assert.match(c.id, /^[0-9a-f]{6}$/);
  const again = buildConfig({ mission, vehicle: { dryMassKg: 800 }, route, nowMs: 999 });
  assert.equal(again.id, c.id, 'the freeze time and the window do not change the name');
  assert.notEqual(buildConfig({ mission: { ...mission, landingMs: T + 3600e3 }, vehicle: { dryMassKg: 800 }, route }).id, c.id);
  assert.notEqual(buildConfig({ mission, vehicle: { dryMassKg: 900 }, route }).id, c.id);
  assert.notEqual(configId({ route: { ...route, departMs: T } }), configId({ route }));
});

test('finalising needs a site and a landing time', () => {
  assert.throws(() => buildConfig({ mission: null }), /No site/);
  assert.throws(() => buildConfig({ mission: { ...mission, landingMs: null } }), /No landing time/);
});

test('it round-trips through storage; a broken or old record reads as none', () => {
  const s = memory();
  assert.equal(readConfig(s), null);
  const c = writeConfig(buildConfig({ mission, vehicle: null }), s);
  assert.deepEqual(readConfig(s), c);
  s.setItem(CONFIG_KEY, JSON.stringify({ ...c, v: 0 }));
  assert.equal(readConfig(s), null);
  s.setItem(CONFIG_KEY, '{nope');
  assert.equal(readConfig(s), null);
  writeConfig(c, s); clearConfig(s);
  assert.equal(readConfig(s), null);
});

test('changes on the Map after freezing are reported', () => {
  const c = buildConfig({ mission, vehicle: { dryMassKg: 800 }, route });
  assert.deepEqual(changesSince(c, { ...mission, updatedMs: 5 }, { route, vehicle: { dryMassKg: 800 } }), []);
  assert.deepEqual(changesSince(c, { ...mission, siteId: 'haworth', latDeg: -86.7 }), ['site']);
  assert.deepEqual(changesSince(c, { ...mission, landingMs: T + 86400e3, stayDays: 7 }), ['landing time', 'stay']);
  assert.deepEqual(changesSince(c, mission, { route: null }), ['rover route']);
  assert.deepEqual(changesSince(c, mission, { vehicle: { dryMassKg: 801 } }), ['vehicle']);
  assert.deepEqual(changesSince(null, mission), []);
});

test('the landing window: the span around the landing with the bodies up', () => {
  const up = (t) => t >= T - 5 * 3600e3 && t <= T + 10 * 3600e3;
  assert.deepEqual(windowAround(T, up), { startMs: T - 5 * 3600e3, endMs: T + 10 * 3600e3 });
  assert.equal(windowAround(T - 6 * 3600e3, up), null);
  const w = windowAround(T, () => true, { maxMs: 48 * 3600e3 });
  assert.equal(w.endMs - w.startMs, 96 * 3600e3, 'capped each way');
});

test('the verdict follows the worst row', () => {
  assert.equal(verdictOf([{ level: 'go' }, { level: 'warn' }]), 'warn');
  assert.equal(verdictOf([{ level: 'go' }, { level: 'no-go' }, { level: 'warn' }]), 'no-go');
  assert.equal(verdictOf([]), 'go');
});

test('the route summary: length, times, battery, links, and whether it starts at the site', async () => {
  const { routeSummary } = await import('../demo/src/mission-config.js');
  const p = { v: 1, label: 'Flattest', lengthKm: 10, departMs: T, arriveMs: T + 3600e3, reserve: 0.2, havens: [{}, {}],
    pts: [[-89.45, 222.69, 0, T, 1, 1 | 2], [-89.4, 223, 5, T + 1800e3, 0.6, 1], [-89.35, 224, 10, T + 3600e3, 0.5, 2 | 4]] };
  const r = routeSummary(p, { latDeg: -89.45, lonDeg: 222.69 });
  assert.deepEqual([r.lengthKm, r.minSoc, r.havens, r.belongs], [10, 0.5, 2, true]);
  assert.ok(Math.abs(r.earthShare - 2 / 3) < 1e-9 && Math.abs(r.stationShare - 1 / 3) < 1e-9);
  assert.equal(routeSummary(p, { latDeg: -85, lonDeg: 0 }).belongs, false, 'planned for another site');
  assert.equal(routeSummary(null), null);
});

test('go / no-go rows: levels follow the findings', async () => {
  const { goNoGoRows } = await import('../demo/src/mission-config.js');
  const plan = { budget: { marginMs: 120, reserveDvMs: 60 } };
  const route = { label: 'Flattest', lengthKm: 10, departMs: T, minSoc: 0.5, reserve: 0.2, earthShare: 0.9, stationShare: 0, emptyAt: null, belongs: true };
  const base = { site: { latDeg: -89.45, polar: true, resKm: 0.24 }, sky: { sun: 2, earth: 4 }, window: { startMs: T, endMs: T + 30 * 3600e3 }, plan, checks: [{ ok: true }], route };
  const lv = (rows) => Object.fromEntries(rows.map((r) => [r.id, r.level]));
  assert.deepEqual(lv(goNoGoRows(base)), { terrain: 'go', sky: 'go', window: 'go', dv: 'go', landing: 'go', route: 'go', battery: 'go', comms: 'go' });
  const bad = lv(goNoGoRows({ ...base, site: { latDeg: 0.7, polar: false, resKm: 0.474 }, sky: { sun: 3, earth: -1 }, plan: { budget: { marginMs: -5, reserveDvMs: 60 } }, route: { ...route, emptyAt: { km: 7 } } }));
  assert.deepEqual([bad.terrain, bad.sky, bad.dv, bad.battery], ['warn', 'warn', 'no-go', 'no-go']);
  assert.equal(lv(goNoGoRows({ ...base, sky: { sun: -2, earth: 3 } })).sky, 'no-go', 'touchdown in the dark');
  assert.equal(lv(goNoGoRows({ ...base, plan: null, planError: 'x' })).dv, 'no-go');
  assert.equal(lv(goNoGoRows({ ...base, route: null })).route, 'warn');
});
