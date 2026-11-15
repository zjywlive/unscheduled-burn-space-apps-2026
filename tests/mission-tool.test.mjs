// Mission tools on real demo data, cross-checked against the existing sky/event/summary tools and window
// integrals. Small synthetic ephemerides exercise transient outages and coverage boundaries deterministically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCoreContext } from '../tools/core-context.mjs';
import { createCoreTools } from '../demo/src/tools-core.js';
import { missionTools } from '../demo/src/tools-v2/mission.js';
import { buildConfig } from '../demo/src/mission-config.js';
import { toGeoJSON } from '../demo/src/mission-save.js';
import { parseMission } from '../demo/src/mission-io.js';
import { visibleIntervals, longestGapMs } from '../demo/src/windows.js';
import { skylineFor, toXY } from '../demo/src/terrain.js';
import { DEFAULTS, toHash } from '../demo/src/state.js';
import { bundle } from '../tools/build.mjs';

const fixture = fileURLToPath(new URL('./fixtures/mission-record.json', import.meta.url));
const record = JSON.parse(readFileSync(fixture, 'utf8'));
const H = 3600e3, D = 86400e3, T = record.route.departMs;
const ctx = loadCoreContext();
const fresh = (patch = {}) => createCoreTools({ ...ctx, ...patch }, { extensions: [missionTools] });
const ok = (r) => { assert.ok(!r.error, r.error); return r; };
const open = async (core, json = record, more = {}) => ok(await core.run('mission_open', { source: { json }, ...more }));
const h1 = (ms) => Math.round(ms / H * 10) / 10;

test('path import → W2/landing conditions equal sky_at, next_events and site_summary on real data', async (t) => {
  const core = fresh(), start = performance.now();
  const m = ok(await core.run('mission_open', { source: { path: fixture } }));
  const openMs = performance.now() - start, tick = performance.now();
  const c = ok(await core.run('mission_conditions', { points: ['W2', 'landing'] }));
  t.diagnostic(`real data: path open ${openMs.toFixed(2)} ms; W2 + landing conditions ${(performance.now() - tick).toFixed(2)} ms`);
  assert.equal(m.mission_id, 'm_1'); assert.equal(c.mission_id, m.mission_id);
  assert.deepEqual(c.points.map((p) => p.name), ['W2', 'landing']);
  const p = c.points[0];
  const sky = ok(await core.run('sky_at', { mission_point: 'w2', at: p.arrive }));
  const next = ok(await core.run('next_events', { mission_point: 'W2', at: p.arrive }));
  for (const body of ['sun', 'earth']) {
    for (const key of ['elDeg', 'skylineDeg', 'aboveSkylineDeg', 'azDeg', 'visible']) assert.equal(p.pass.arrival[body][key], sky[body][key], `${body}.${key}`);
    for (const event of ['nextSet', 'nextRise']) {
      assert.equal(p.pass[body][event]?.time ?? null, next[body][event]?.time ?? null);
      assert.equal(p.pass[body][event]?.inH ?? null, next[body][event]?.inH ?? null);
    }
  }
  for (const p of c.points) {
    const summary = ok(await core.run('site_summary', { mission_point: p.name, landing: m.landing, stay_days: m.stay_days }));
    for (const key of ['sunH', 'earthH', 'bothH', 'longestDarkH', 'firstSunset', 'firstEarthset', 'firstSunrise', 'firstEarthrise']) assert.equal(p.stay[key], summary[key], `${p.name}.${key}`);
    assert.deepEqual(p.stay.stay, summary.stay);
  }
  assert.equal(c.points[1].pass.available, false);
  assert.match(c.points[1].pass.note, /no pass time in the export/);
  assert.equal(c.query_echo.window, 'both'); assert.equal(c.query_echo.detail, 'standard');
  assert.match(c.about.limits.join(' '), /first-look screen, not a certified landing analysis/);
});

test('charging pass departure and longest direct-Earth outage equal real window integrals', async () => {
  const core = fresh(); await open(core);
  const c = ok(await core.run('mission_conditions', { points: ['stop1'], window: 'pass', detail: 'full' }));
  const p = c.points[0], raw = parseMission(record).mission.points.find((q) => q.name === 'stop1');
  const mask = skylineFor(ctx.dem, raw);
  for (const body of ['sun', 'earth']) {
    const iv = visibleIntervals(ctx.eph, raw, body, raw.arriveMs, raw.departMs, mask);
    const sky = ok(await core.run('sky_at', { mission_point: 'stop1', at: p.depart }));
    assert.equal(p.pass.departure[body].visible, sky[body].visible);
    assert.equal(p.pass.departure[body].elDeg, sky[body].elDeg);
    assert.equal(p.pass[body].inViewWholePass, iv.length === 1 && iv[0][0] === raw.arriveMs && iv[0][1] === raw.departMs);
    assert.equal(p.pass[body].visible_intervals.length, iv.length);
    if (body === 'earth') assert.equal(p.pass.longestWithoutEarthH, h1(longestGapMs(iv, raw.arriveMs, raw.departMs)));
  }
  assert.equal(p.stay, null);
  assert.equal(p.inside_psr, ctx.psr.isPsr(...toXY(raw.latDeg, raw.lonDeg)));
});

test('all source formats register points; json strings and explicit mission ids work after another open', async () => {
  const core = fresh();
  const a = await open(core, JSON.stringify(record), { name: 'First mission' });
  const config = buildConfig({ mission: { ...record.mission, landingMs: T + D }, route: record.route, vehicle: null, nowMs: T });
  const b = await open(core, config);
  assert.equal(b.kind, 'lsn-config'); assert.equal(b.mission_id, 'm_2');
  assert.equal(ok(await core.run('mission_conditions', { points: ['landing'], window: 'stay' })).mission_id, b.mission_id);
  const old = ok(await core.run('mission_conditions', { mission_id: a.mission_id, points: ['landing'], window: 'stay' }));
  assert.equal(old.points[0].stay.landing, a.landing);
  assert.equal(ok(await core.run('sky_at', { mission_id: a.mission_id, mission_point: 'W2', at: '2027-01-15T02:00Z' })).place.id, 'W2');
  for (const [raw, kind] of [[toGeoJSON(record), 'geojson'], [record.route, 'route3d']]) {
    const m = await open(core, raw); assert.equal(m.kind, kind);
    const c = ok(await core.run('mission_conditions', { points: ['W2'] }));
    assert.equal(c.points[0].pass.available, true);
    assert.equal(c.points[0].stay.available, false);
  }
});

test('share URL is parsed offline and defaults to a landing-only stay', async () => {
  const core = fresh();
  const url = `https://not-contacted.invalid/index.html${toHash({ ...DEFAULTS, site: ctx.sites.find((s) => s.id === 'shackleton') })}`;
  const m = ok(await core.run('mission_open', { source: { url } }));
  assert.deepEqual(m.points.map((p) => p.name), ['landing']);
  const c = ok(await core.run('mission_conditions'));
  assert.equal(c.points.length, 1); assert.equal(c.points[0].stay.available, true);
  assert.equal(c.points[0].pass.available, false); assert.ok(c.assumed.some((s) => /defaults/.test(s)));
});

test('point selection resolves aliases and case, deduplicates names, rejects ambiguity and unknown names', async () => {
  const core = fresh(); await open(core);
  const c = ok(await core.run('mission_conditions', { points: [' cold TRAP entry ', 'w2'], window: 'pass' }));
  assert.deepEqual(c.points.map((p) => p.name), ['W2']);
  assert.deepEqual(c.query_echo.points, ['W2']);
  assert.match((await core.run('mission_conditions', { points: ['bogus'] })).error, /No point bogus/);
  const r = structuredClone(record); r.route.wps[0].name = 'duplicate'; r.route.wps[1].name = 'duplicate';
  await open(core, r);
  assert.match((await core.run('mission_conditions', { points: ['duplicate'] })).error, /Ambiguous/);
});

test('brief stays under 1 KB; standard omits matrices and full carries raw route/visibility detail', async (t) => {
  const core = fresh();
  const brief = await open(core, record, { detail: 'brief' });
  assert.ok(Buffer.byteLength(JSON.stringify(brief)) <= 1024);
  const standard = await open(core);
  assert.equal(standard.route_samples, undefined); assert.equal(standard.settings, undefined);
  const full = await open(core, record, { detail: 'full' });
  assert.deepEqual(full.route_samples.samples, record.route.pts); assert.deepEqual(full.settings, record.settings);
  const tick = performance.now();
  const all = ok(await core.run('mission_conditions', { detail: 'full' }));
  t.diagnostic(`real data: all ${all.points.length} points/full ${(performance.now() - tick).toFixed(2)} ms`);
  assert.equal(all.points.length, standard.points.length);
  assert.ok(all.points[0].stay.visible_intervals);
  const c = ok(await core.run('mission_conditions', { detail: 'brief' }));
  const bytes = Buffer.byteLength(JSON.stringify(c));
  assert.ok(bytes <= 1024, `${bytes} bytes`);
  assert.equal(c.points, undefined);
  t.diagnostic(`brief bytes: open ${Buffer.byteLength(JSON.stringify(brief))}; conditions ${bytes}`);
  const stay = ok(await core.run('mission_conditions', { window: 'stay', detail: 'brief' }));
  assert.equal(stay.sun_up_on_arrival, null, 'unqueried arrival is not a zero count');
  assert.equal(stay.earth_up_on_arrival, null);
  assert.ok(c.assumed.some((s) => /power/.test(s)), 'name the imported engineering assumptions even in brief');
});

test('invalid inputs and absent/failed Node readers return actionable errors', async () => {
  const core = fresh();
  assert.match((await core.run('mission_conditions')).error, /mission_open first/);
  const cases = [
    ['mission_open', {}, /source.*required/], ['mission_open', { source: {} }, /exactly one/],
    ['mission_open', { source: { json: record, path: fixture } }, /exactly one/],
    ['mission_open', { source: { json: '{' } }, /Invalid mission JSON/],
    ['mission_open', { source: { json: { kind: 'unknown' } } }, /Unsupported/],
    ['mission_open', { source: { path: `${fixture}.missing` } }, /No file/],
    ['mission_open', { source: { json: record }, name: ' ' }, /non-empty/],
    ['mission_open', { source: { json: record }, detail: 'verbose' }, /brief.*standard.*full/],
  ];
  for (const [tool, input, re] of cases) assert.match((await core.run(tool, input)).error, re);
  await open(core);
  for (const input of [{ points: [] }, { points: Array(25).fill('landing') }, { points: 'W2' }, { window: 'now' }, { mission_id: 'm_missing' }, { extra: true }]) {
    assert.equal(typeof (await core.run('mission_conditions', input)).error, 'string');
  }
  assert.match((await fresh({ readText: undefined }).run('mission_open', { source: { path: fixture } })).error, /paste the JSON/);
  assert.match((await fresh({ readText: async () => ({ error: 'reader unavailable' }) }).run('mission_open', { source: { path: fixture } })).error, /reader unavailable/);
  assert.match((await fresh({ readText: () => { throw new Error('permission denied'); } }).run('mission_open', { source: { path: fixture } })).error, /permission denied/);
});

test('all never silently truncates more than 24 points, while explicit batches work', async () => {
  const core = fresh();
  const p = structuredClone(record.route); p.havens = Array.from({ length: 25 }, () => ({ latDeg: -89.4, lonDeg: 222.7 }));
  await open(core, p);
  assert.match((await core.run('mission_conditions')).error, /at most 24/);
  const c = ok(await core.run('mission_conditions', { points: ['haven25'], window: 'pass' }));
  assert.equal(c.points[0].pass.available, false); assert.equal(c.points[0].stay.available, false);
  const brief = ok(await core.run('mission_conditions', { points: Array.from({ length: 24 }, (_, i) => `haven${i + 1}`), detail: 'brief' }));
  assert.ok(Buffer.byteLength(JSON.stringify(brief)) <= 1024, `${Buffer.byteLength(JSON.stringify(brief))} bytes`);
});

test('brief remains under 1 KB with 24 long canonical names and every engineering assumption', async () => {
  const core = fresh();
  const p = { v: 1, pts: [[-89, 0, 0, null, null, 0], [-89, 1, 1, null, null, 0]], havens: Array.from({ length: 100000 }, () => ({ latDeg: -89, lonDeg: 0 })) };
  const settings = Object.fromEntries(['power', 'mobility', 'vehicle', 'station', 'energy', 'relay', 'limits', 'reserve'].map((k) => [k, {}]));
  const m = await open(core, { kind: 'lsn-mission-record', v: 1, route: p, settings }, { detail: 'brief' });
  assert.ok(Buffer.byteLength(JSON.stringify(m)) <= 1024);
  const c = ok(await core.run('mission_conditions', { points: Array.from({ length: 24 }, (_, i) => `haven${99977 + i}`), detail: 'brief' }));
  assert.ok(Buffer.byteLength(JSON.stringify(c)) <= 1024, `${Buffer.byteLength(JSON.stringify(c))} bytes`);
  assert.equal(c.query_echo.points.length, 24);
});

function controlled({ alwaysDown = false, psr = true } = {}) {
  const eph = { startMs: T, endMs: T + 8 * H, stepMs: H, at: (t) => {
    if (t < T || t > T + 8 * H) return null;
    const h = (t - T) / H;
    const direction = (up) => [0, 0, up ? -1 : 1];
    return { sun: direction(!alwaysDown && (h < 2 || h >= 6)), earth: direction(!alwaysDown && (h < 1 || h >= 4)), earthRangeKm: 380000 };
  } };
  const core = fresh({ eph, dem: null, coarse: null, psr: psr ? { isPsr: () => true } : null });
  const p = { v: 1, departMs: T, arriveMs: T + 6 * H,
    pts: [[-89.45, 222.69, 0, T, 1, 0], [-89.44, 222.69, 1, T + 6 * H, 1, 0]],
    stops: [{ latDeg: -89.45, lonDeg: 222.69, km: 0, fromMs: T, toMs: T + 6 * H }] };
  return { core, p };
}

test('interval scan catches a mid-pass outage even when both endpoints are visible; risks are severity-ordered', async () => {
  const { core, p } = controlled(); await open(core, p);
  const q = ok(await core.run('mission_conditions', { points: ['stop1'], window: 'pass', detail: 'full' })).points[0];
  assert.equal(q.pass.arrival.sun.visible, true); assert.equal(q.pass.departure.sun.visible, true);
  assert.equal(q.pass.sun.inViewWholePass, false); assert.equal(q.pass.earth.inViewWholePass, false);
  assert.equal(q.pass.longestWithoutEarthH, 3);
  assert.equal(q.pass.sun.nextSet.inH, 2); assert.equal(q.pass.earth.nextSet.inH, 1);
  assert.match(q.risks[0], /permanently shadowed/);
  assert.ok(q.risks.some((s) => /Sun sets 2 h.*before departure/.test(s)));
  assert.ok(q.risks.some((s) => /Earth sets 1 h/.test(s)));
});

test('body down on arrival includes next rise; a full outage and zero-duration down pass are explicit', async () => {
  const { core, p } = controlled({ psr: false });
  p.stops[0].fromMs = T + 3 * H;
  await open(core, p);
  const q = ok(await core.run('mission_conditions', { points: ['stop1'], window: 'pass' })).points[0];
  assert.equal(q.pass.arrival.earth.visible, false); assert.equal(q.pass.earth.nextRise.inH, 1);
  assert.equal(q.pass.sun.nextRise.inH, 3); assert.equal(q.inside_psr, null);
  assert.match(q.notes.join(' '), /PSR membership unavailable/);
  const down = controlled({ alwaysDown: true }); await open(down.core, down.p);
  const r = ok(await down.core.run('mission_conditions', { points: ['stop1', 'end'], window: 'pass' }));
  assert.equal(r.points[0].pass.longestWithoutEarthH, 6);
  assert.ok(r.points[0].risks.some((s) => /no direct link/.test(s)));
  assert.equal(r.points[1].pass.durationH, 0); assert.equal(r.points[1].pass.sun.inViewWholePass, false);
  assert.equal(r.points[1].pass.sun.nextRise, null);
});

test('missing pass times fall back to stay; off-terrain PSR stays null and smooth horizon is disclosed', async () => {
  const core = fresh();
  const r = structuredClone(record); r.route = null; r.mission = { latDeg: 0.67416, lonDeg: 23.47314, landingMs: record.mission.landingMs, stayDays: 14 };
  await open(core, r);
  const p = ok(await core.run('mission_conditions', { points: ['landing'], window: 'pass' })).points[0];
  assert.equal(p.pass.available, false); assert.equal(p.stay.available, true);
  assert.equal(p.inside_psr, null); assert.equal(p.horizon, 'smooth');
  assert.match(p.notes.join(' '), /North of 80°S/);
});

test('coverage: stays clip explicitly; invalid passes are unavailable; boundary instants need no future crossing', async () => {
  const { core, p } = controlled({ psr: false });
  const r = { ...record, mission: { ...record.mission, landingMs: T + 6 * H, stayDays: 1 }, route: p };
  p.stops[0].toMs = T + 9 * H;
  await open(core, r);
  const q = ok(await core.run('mission_conditions', { points: ['stop1'] })).points[0];
  assert.equal(q.pass.available, false); assert.match(q.pass.note, /outside ephemeris/);
  assert.equal(q.stay.stay.clipped, true); assert.equal(q.stay.stay.coveredH, 2);
  p.stops[0].fromMs = T + 8 * H; p.stops[0].toMs = T + 8 * H;
  await open(core, p);
  const end = ok(await core.run('mission_conditions', { points: ['stop1'], window: 'pass' })).points[0];
  assert.equal(end.pass.available, true); assert.equal(end.pass.durationH, 0);
  assert.equal(end.pass.sun.nextSet, null); assert.equal(end.pass.earth.nextRise, null);
  r.mission.landingMs = T - D; await open(core, r);
  assert.equal(ok(await core.run('mission_conditions', { points: ['landing'], window: 'stay' })).points[0].stay.available, false);
});

test('same call sequence produces deterministic references/results; source objects are not changed', async () => {
  const a = fresh(), b = fresh(), before = structuredClone(record);
  assert.deepEqual(await open(a), await open(b));
  const input = { points: ['W2', 'landing'], window: 'both' };
  const first = ok(await a.run('mission_conditions', input));
  assert.deepEqual(first, ok(await a.run('mission_conditions', input)));
  assert.deepEqual(first, ok(await b.run('mission_conditions', input)));
  assert.deepEqual(record, before);
});

test('mutating a returned full result does not change the retained mission reference', async () => {
  const core = fresh(), m = await open(core, record, { detail: 'full' });
  m.settings.power.batteryWh = 0;
  m.route_samples.samples[0][0] = 0;
  m.points.find((p) => p.name === 'W2').aliases.push('injected');
  m.notes.push('injected');
  assert.match((await core.run('mission_conditions', { points: ['injected'] })).error, /No point/);
  assert.equal(ok(await core.run('sky_at', { mission_point: 'start', at: '2027-01-15' })).place.latDeg, record.route.pts[0][0]);
});

test('extension is browser-bundle compatible and exposes validated schemas', () => {
  assert.doesNotThrow(() => new Function(bundle(new URL('../demo/src/tools-v2/mission.js', import.meta.url).pathname)));
  const core = fresh();
  for (const name of ['mission_open', 'mission_conditions']) {
    const spec = core.specs().find((s) => s.name === name);
    assert.ok(spec.description.length > 40); assert.equal(spec.input_schema.additionalProperties, false);
    assert.deepEqual(spec.input_schema.properties.detail.enum, ['brief', 'standard', 'full']);
  }
});
