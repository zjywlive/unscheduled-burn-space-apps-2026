// Mission import contract: page-built exports, explicit missing values, route-time interpolation and stable
// point names. Fixtures are synthetic plans, not measured missions; no tests write files or touch storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMission, parseLink, resolveMissionPoint, MAX_MISSION_BYTES } from '../demo/src/mission-io.js';
import { buildRecord, toGeoJSON } from '../demo/src/mission-save.js';
import { buildPayload } from '../demo/src/route3d.js';
import { buildConfig } from '../demo/src/mission-config.js';
import { DEFAULTS, toHash, parseHash } from '../demo/src/state.js';
import { fromXY, toXY } from '../demo/src/terrain.js';
import { bundle } from '../tools/build.mjs';

const record = JSON.parse(readFileSync(new URL('./fixtures/mission-record.json', import.meta.url), 'utf8'));
const sites = JSON.parse(readFileSync(new URL('../demo/data/sites.json', import.meta.url), 'utf8'));
const T = record.route.departMs, H = 3600e3;
const parse = (v) => { const r = parseMission(v, { sites }); assert.ok(!r.error, r.error); return r.mission; };
const at = (m, name) => { const r = resolveMissionPoint(m, name); assert.ok(!r.error, r.error); return r.point; };

test('fixture is the page buildPayload/buildRecord output (stable id, explicit user waypoint name)', () => {
  const xy = [[-89.45, 222.69], [-89.43, 222.69], [-89.41, 222.69]].map((p) => toXY(...p));
  const mid = xy[0].map((v, i) => (v + xy[1][i]) / 2);
  const route = buildPayload({ route: { id: 'flat', label: 'Flattest', lengthKm: 1.2, profile: { x: xy.map((p) => p[0]), y: xy.map((p) => p[1]), km: [0.6, 0.6, 0], pitch: [0, 0, 0] } },
    drive: { ok: true, departMs: T, arriveMs: T + 10 * H, perSample: { tMs: [T, T + 4 * H, T + 10 * H], socWh: [100, 60, 90], lit: [1, 1, 0], earth: [1, 0, 1] }, stops: [{ x: xy[1][0], y: xy[1][1], km: 0.6, fromMs: T + 4 * H, toMs: T + 6 * H }] },
    power: { batteryWh: 100, reserve: 0.2 }, waypoints: [xy[0], mid, xy[1], xy[2]], havens: { checkpoints: [{ haven: { x: xy[1][0] + 1, y: xy[1][1] } }] } });
  route.wps[1].name = 'Cold trap entry';
  assert.deepEqual(route, record.route);
  const built = buildRecord({ name: record.name, mission: record.mission, settings: record.settings, summary: record.summary, route, savedMs: record.savedMs });
  assert.deepEqual({ ...built, id: record.id }, record);
});

test('record JSON/object parses without mutation; canonical names and aliases are case-insensitive', () => {
  const before = structuredClone(record), m = parse(record);
  assert.deepEqual(m, parse(JSON.stringify(record)));
  assert.deepEqual(record, before);
  assert.equal(m.kind, 'lsn-mission-record');
  assert.deepEqual(m.site, { id: 'shackleton', name: 'Shackleton ridge', latDeg: -89.45, lonDeg: 222.69 });
  for (const name of ['landing', 'touchdown', 'start', 'end', 'w1', 'W2', 'stop1', 'haven1']) assert.ok(at(m, name));
  assert.equal(at(m, ' COLD TRAP ENTRY '), at(m, 'W2'));
  assert.equal(at(m, 'landing').arriveMs, record.mission.landingMs);
  assert.equal(at(m, 'landing').departMs, null, 'landing departure is not invented');
  assert.equal(at(m, 'touchdown').arriveMs, record.mission.landed.tMs);
  assert.equal(at(m, 'haven1').arriveMs, null, 'a possible refuge is not a scheduled visit');
  assert.equal(m.route.returnable, true);
  assert.equal(m.route.socMin, 0.6);
});

test('page buildConfig output (untagged and tagged) preserves its landing and engineering settings', () => {
  const c = buildConfig({ mission: record.mission, route: record.route, vehicle: { dryKg: 100 }, nowMs: T });
  for (const config of [c, { kind: 'lsn-config', ...c }]) {
    const m = parse(config);
    assert.equal(m.kind, 'lsn-config');
    assert.equal(m.landingMs, record.mission.landingMs);
    assert.equal(m.stayDays, 14);
    assert.equal(m.slipDays, null, 'config does not export slip');
    assert.equal(at(m, 'W2').aliases[0], 'Cold trap entry');
    assert.deepEqual(m.settings.vehicle, { dryKg: 100 });
    assert.equal(m.route.returnable, null, 'no exported returnability is not a claim of success');
  }
  const noRoute = parse(buildConfig({ mission: record.mission, vehicle: null, nowMs: T }));
  assert.deepEqual(noRoute.points.map((p) => p.name), ['landing']);
});

test('toGeoJSON output restores negative longitude and point times without fabricating a landing/stay', () => {
  const g = toGeoJSON(record), m = parse(g), original = parse(record);
  assert.equal(m.kind, 'geojson');
  assert.equal(m.site, null); assert.equal(m.landingMs, null); assert.equal(m.stayDays, null);
  assert.match(m.notes.join(' '), /not substituted for landing/);
  for (const name of ['start', 'end', 'W1', 'W2', 'W3', 'W4', 'stop1', 'haven1', 'touchdown']) {
    const p = at(m, name), q = at(original, name);
    assert.ok(Math.abs(p.lonDeg - q.lonDeg) < 1e-10);
    assert.equal(p.arriveMs, q.arriveMs);
    assert.equal(p.departMs, q.departMs);
  }
  assert.deepEqual(at(m, 'W2').aliases, [], 'page GeoJSON currently omits waypoint names');
  const withName = structuredClone(g);
  withName.features.find((f) => f.properties.n === 2).properties.name = 'Named GeoJSON point';
  assert.equal(at(parse(withName), 'named geojson point').name, 'W2');
});

test('bare route payload has no landing/stay; incomplete simulations keep unreached times null', () => {
  const p = structuredClone(record.route);
  p.arriveMs = null;
  p.emptyAt = { ...p.wps[2], km: 0.6, tMs: T + 6 * H };
  p.pts[2][3] = null; p.pts[2][4] = null;
  const m = parse(p);
  assert.equal(m.kind, 'route3d');
  assert.equal(m.site, null); assert.equal(m.landingMs, null); assert.equal(m.stayDays, null);
  assert.equal(at(m, 'empty').arriveMs, T + 6 * H);
  assert.equal(at(m, 'end').arriveMs, null);
  assert.equal(at(m, 'W4').arriveMs, null);
  const allUntimed = structuredClone(record.route);
  allUntimed.pts.forEach((q) => { q[3] = null; }); allUntimed.stops = [];
  assert.ok(parse(allUntimed).points.every((q) => q.arriveMs === null));
});

test('waypoint interpolation follows distance, accounts for stops, and retains dwell', () => {
  const m = parse(record);
  assert.ok(Math.abs(at(m, 'W2').arriveMs - (T + 2 * H)) < 1000, 'midpoint, export coordinate rounding <1 s');
  assert.deepEqual([at(m, 'W3').arriveMs, at(m, 'W3').departMs], [T + 4 * H, T + 6 * H]);
  assert.deepEqual([at(m, 'stop1').arriveMs, at(m, 'stop1').departMs], [T + 4 * H, T + 6 * H]);
  const p = structuredClone(record.route);
  const a = toXY(...p.pts[1]), b = toXY(...p.pts[2]);
  p.wps = [{ ...fromXY((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) }];
  assert.ok(Math.abs(at(parse(p), 'W1').arriveMs - (T + 8 * H)) < 2, 'wait until 06:00, then half of remaining drive');
  p.wps = [{ latDeg: -89, lonDeg: 20 }];
  assert.equal(at(parse(p), 'W1').arriveMs, null, 'off-route waypoints do not inherit nearest sample times');
});

test('return routes retain waypoint order at repeated locations; aliases cannot override canonical W names', () => {
  const p = structuredClone(record.route);
  p.stops = []; p.havens = [];
  p.pts.push([-89.45, 222.69, 2.4, T + 20 * H, 0.5, 3]); p.arriveMs = T + 20 * H;
  p.wps = [p.wps[0], p.wps[3], { ...p.wps[0], name: 'W2' }];
  const m = parse(p);
  assert.equal(at(m, 'W3').arriveMs, T + 20 * H);
  assert.equal(at(m, 'W2').arriveMs, T + 10 * H);
  p.wps[0].name = 'same'; p.wps[1].name = 'same';
  assert.match(resolveMissionPoint(parse(p), 'SAME').error, /Ambiguous/);
});

test('an incompletely timed charge cannot turn into an instantaneous waypoint or interpolated drive', () => {
  const p = structuredClone(record.route);
  p.stops[0].toMs = null;
  const m = parse(p);
  assert.equal(at(m, 'W3').arriveMs, T + 4 * H);
  assert.equal(at(m, 'W3').departMs, null);
  assert.equal(at(m, 'W2').arriveMs, null, 'incomplete charge schedule blocks interpolation');
  const rounded = structuredClone(record.route);
  rounded.stops[0].km += 0.00004;
  assert.equal(at(parse(rounded), 'W3').departMs, T + 6 * H, 'respect the payload km precision');
});

test('share link from state.toHash round-trips site/time/stay/slip; route drawing is not a timed plan', () => {
  const site = sites.find((s) => s.id === 'shackleton');
  for (const s of [site, { id: 'custom', name: 'Custom site', latDeg: -89.3, lonDeg: 222.7 }]) {
    const state = { ...DEFAULTS, site: s, landingMs: T, stayDays: 7.5, slipDays: -3, routePlan: { points: [[0, 0], [1, 1]], maxSlopeDeg: 15, selected: 'flat' } };
    const r = parseLink(`https://example.test/demo/index.html${toHash(state)}`, { sites });
    assert.ok(!r.error, r.error);
    assert.equal(r.mission.site.id, s.id); assert.equal(r.mission.site.latDeg, s.latDeg);
    assert.equal(r.mission.landingMs, T); assert.equal(r.mission.stayDays, 7.5); assert.equal(r.mission.slipDays, -3);
    assert.deepEqual(r.mission.points.map((p) => p.name), ['landing']);
    assert.equal(r.mission.route, null); assert.match(r.mission.notes[0], /only landing/);
  }
});

test('share link fallback and hour snapping exactly match state.parseHash, with defaults disclosed', () => {
  const hash = '#site=missing&t=2027-01-15T03:59Z&stay=100&slip=100';
  const expected = parseHash(hash, sites, { startMs: Date.UTC(2026, 10, 1), endMs: Date.UTC(2029, 0, 1) });
  const { mission: m } = parseLink(`index.html${hash}`, { sites });
  assert.equal(m.site.id, expected.site.id); assert.equal(m.landingMs, expected.landingMs);
  assert.equal(m.stayDays, expected.stayDays); assert.equal(m.slipDays, expected.slipDays);
  assert.match(m.notes.join(' '), /defaults.*snaps/);
  assert.ok(parseLink('https://example.test/index.html', { sites }).error);
  assert.ok(parseLink('javascript:alert(1)#site=im2', { sites }).error);
});

test('invalid kinds, versions, coordinates, timelines and GeoJSON return errors, never exceptions', () => {
  const bad = ['{', null, [], 1, { kind: 'other', v: 1 }, { ...record, v: 2 }, { ...record.route, v: 2 },
    { ...record, mission: { latDeg: 91, lonDeg: 0 } }, { ...record, mission: { ...record.mission, stayDays: -1 } }];
  for (const modify of [
    (r) => { r.route.pts[1][2] = -1; }, (r) => { r.route.pts[1][3] = T - H; },
    (r) => { r.route.stops[0].toMs = T; }, (r) => { r.route.wps = {}; },
    (r) => { r.route.wps[0].lonDeg = 800; }, (r) => { r.route.pts[0][3] = 1e20; },
  ]) { const r = structuredClone(record); modify(r); bad.push(r); }
  const g = toGeoJSON(record); g.features[0].properties.tMs = [T]; bad.push(g);
  bad.push({ type: 'FeatureCollection', features: [] });
  for (const value of bad) assert.equal(typeof parseMission(value, { sites }).error, 'string', JSON.stringify(value));
});

test('pasted JSON shares the 5 MB file limit, including UTF-8 bytes; cycles are user errors', () => {
  assert.match(parseMission(' '.repeat(MAX_MISSION_BYTES + 1)).error, /5 MB/);
  assert.match(parseMission({ ...record, name: '月'.repeat(Math.ceil(MAX_MISSION_BYTES / 3)) }).error, /5 MB/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(typeof parseMission(cyclic).error, 'string');
});

test('parser follows the zero-dependency browser bundler convention', () => {
  const code = bundle(new URL('../demo/src/mission-io.js', import.meta.url).pathname);
  assert.doesNotThrow(() => new Function(code));
  assert.ok(!code.includes("from 'node:"));
});
