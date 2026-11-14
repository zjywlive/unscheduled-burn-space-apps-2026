import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCoreContext } from '../tools/core-context.mjs';
import { createCoreTools } from '../demo/src/tools-core.js';
import { createCommands } from '../demo/src/commands.js';
import { createTimeline } from '../demo/src/timeline.js';
import { createAgent } from '../demo/src/agent/provider.js';
import { createMockProvider, MOCK_SUGGESTIONS } from '../demo/src/agent/mock.js';
import { summarize, summarizePair } from '../demo/src/windows.js';
import { compareRows } from '../demo/src/ui/compare.js';
import { skylineFor } from '../demo/src/terrain.js';
import { bodyAzEl } from '../demo/src/ephemeris.js';
import { skyStatus } from '../demo/src/skydial.js';

const ctx = loadCoreContext(), core = createCoreTools(ctx);
const H = 36e5;
function page() {
  const state = { view: 'map', site: ctx.sites.find((s) => s.id === 'im2'), landingMs: Date.UTC(2027, 0, 13), cursorMs: Date.UTC(2027, 0, 13, 5), stayDays: 14, slipDays: 14, mapMode: 'both', windowOn: true };
  const timeline = createTimeline({ startMs: ctx.eph.startMs, endMs: ctx.eph.endMs, nowMs: state.cursorMs });
  timeline.subscribe((s) => { state.cursorMs = s.nowMs; });
  const changes = [], layers = {};
  const api = { core, sites: ctx.sites, landingRange: ctx.eph,
    getState: () => ({ ...state, playing: timeline.getState().playing }),
    update: (p) => { changes.push(p); Object.assign(state, p); },
    setPlayhead: (ms) => timeline.setNow(ms), play: () => timeline.play(), pause: () => timeline.pause(),
    setLayer: (name, on) => { layers[name] = on; return { name, on }; },
    openSiteDetail: (tab) => { state.view = 'map'; state.sheet = tab; }, openSettings: () => { state.settingsOpen = true; },
  };
  return { state, timeline, changes, layers, commands: createCommands(api) };
}

test('M5: one tool table, legacy names preserved, core dispatch never changes page state', async () => {
  const p = page(), c = p.commands, before = structuredClone(p.state);
  assert.equal(c.list.length, 38);
  assert.equal(new Set(c.list).size, c.list.length);
  assert.deepEqual(c.toolDefinitions().map((d) => d.name), c.list);
  for (const name of ['get_energy', 'plan_route', 'set_relay_orbit', 'open_navigator', ...core.list]) assert.ok(c.list.includes(name));
  const input = { site_id: 'shackleton', landing: '2027-01-27', stay_days: 14 };
  assert.deepEqual(await c.run('site_summary', input), await core.run('site_summary', input));
  assert.deepEqual(p.state, before);
  assert.deepEqual(p.changes, []);
  assert.match((await c.run('sky_at', { site_id: 'im2', at: '2030-01-01' })).error, /ephemeris/i);
  assert.ok((await c.run('set_layer', { name: 'bogus', on: true })).error);
});

test('M5: window commands validate, keep clipped landings, and reject cumulative modes without a window', async () => {
  const { commands: c, state } = page();
  await c.run('clear_window');
  assert.equal(state.windowOn, false);
  assert.equal(state.mapMode, 'now');
  for (const mode of ['both', 'sun', 'earth', 'change', 'score']) assert.match((await c.run('set_map_mode', { mode })).error, /set_window/);
  assert.equal((await c.run('set_map_mode', { mode: 'now' })).mapMode, 'now');
  for (const landing of ['2027-02-30', '2026-13-13', '2030-01-01', '2029-01-01']) assert.ok((await c.run('set_window', { landing, stay_days: 14 })).error);
  for (const stay_days of [0.5, 61, '14', null]) assert.ok((await c.run('set_window', { landing: '2027-01-13', stay_days })).error);
  const r = await c.run('set_window', { landing: '2028-12-31T23:45Z', stay_days: 13.75 });
  assert.deepEqual(r, { windowOn: true, landing: '2028-12-31T23:00Z', stayDays: 13.75, stayAvailableH: 1, clipped: true });
  assert.equal(state.landingMs, Date.UTC(2028, 11, 31, 23));
  assert.equal(state.stayDays, 13.75);
});

test('M5: shared playhead, play/pause, layer switches and detail/settings commands', async () => {
  const { commands: c, state, timeline, layers } = page();
  const landing = state.landingMs;
  assert.deepEqual(await c.run('set_playhead', { at: '2027-02-18T06:45Z' }), { at: '2027-02-18T06:45Z' });
  assert.equal(timeline.getState().nowMs, Date.UTC(2027, 1, 18, 6, 45));
  assert.equal(state.landingMs, landing);
  for (const at of ['2027-02-30', '2026-13-13', '2030-01-01']) assert.ok((await c.run('set_playhead', { at })).error);
  assert.ok(!(await c.run('set_playhead', { at: '2029-01-01T00:00Z' })).error, 'coverage endpoint is a valid instant');
  await c.run('play'); assert.equal(timeline.getState().playing, true);
  await c.run('pause'); assert.equal(timeline.getState().playing, false);
  const st = await c.run('get_state');
  assert.equal(st.at, '2029-01-01T00:00Z'); assert.equal(st.windowOn, true); assert.equal(st.playing, false);
  for (const name of ['live', 'psr', 'skyDial', 'dial', 'best', 'labels', 'graticule']) {
    assert.deepEqual(await c.run('set_layer', { name, on: false }), { name, on: false });
    assert.equal(layers[name], false);
  }
  for (const tab of ['overview', 'power', 'comms', 'compare']) {
    assert.deepEqual(await c.run('open_site_detail', { tab }), { view: 'map', sheet: tab });
    assert.equal(state.sheet, tab);
  }
  await c.run('open_site_detail'); assert.equal(state.sheet, 'overview');
  assert.ok((await c.run('open_site_detail', { tab: 'bad' })).error);
  assert.deepEqual(await c.run('open_navigator'), { view: 'navigator' });
  assert.equal(state.view, 'navigator', 'legacy API result stays intact; main maps this to Overview');
  await c.run('open_settings'); assert.equal(state.settingsOpen, true);
});

test('M5: inspector, sheet tiles and compare card share figures with core for sites/dates and clipped stays', async () => {
  for (const [a, b, landing, later] of [
    ['im2', 'shackleton', '2027-01-13', '2027-01-27'],
    ['haworth', 'nobile-rim-2', '2027-03-02', '2027-03-16'],
    ['shackleton', 'apollo11', '2028-12-25', '2028-12-28'],
  ]) {
    const site = (id) => { const s = ctx.sites.find((x) => x.id === id); assert.ok(s, id); return s; };
    const scenario = (id, date) => ({ site: site(id), landingMs: Date.parse(date), mask: skylineFor(ctx.dem, site(id)) });
    const planned = summarize(ctx.eph, site(a), Date.parse(landing), 14, skylineFor(ctx.dem, site(a)));
    const summary = await core.run('site_summary', { site_id: a, landing, stay_days: 14 });
    const singleRows = compareRows(planned, null);
    assert.deepEqual(singleRows.slice(0, 3).map((r) => r.planned), [summary.display.bothInView, summary.display.sunlit, summary.display.earthInView]);
    for (const [field, key] of [['bothH', 'bothMs'], ['sunH', 'sunMs'], ['earthH', 'earthMs'], ['longestDarkH', 'longestDarkMs']]) assert.equal(summary[field], Math.round(planned[key] / H * 10) / 10);
    const pair = summarizePair(ctx.eph, scenario(a, landing), scenario(b, later), 14, 0);
    const rows = compareRows(pair.planned, pair.alt); // main uses first 3 in inspector/tiles, all in Compare
    const result = await core.run('compare_scenarios', { scenarios: [{ site_id: a, landing }, { site_id: b, landing: later }], stay_days: 14 });
    assert.deepEqual(result.scenarios[1].vsBaseline.card, rows.map((r) => ({ label: r.label, baseline: r.planned, scenario: r.alt, change: r.change })));
    assert.equal(result.comparedDays, Math.round(pair.planned.stayMs / 864e5 * 1000) / 1000);
    const sky = await core.run('sky_at', { site_id: a, at: landing });
    const angles = bodyAzEl(ctx.eph, site(a), Date.parse(landing));
    for (const body of ['sun', 'earth']) {
      const visible = skyStatus(angles[body], skylineFor(ctx.dem, site(a)));
      assert.ok(Math.abs(visible.clearanceDeg - sky[body].aboveSkylineDeg) <= 0.005);
    }
  }
});

async function ask(p, question) {
  const events = [];
  const answer = await createAgent({ provider: createMockProvider(), commands: p.commands }).send(question, (e) => events.push(e));
  assert.equal(answer.stop, 'end_turn');
  return { answer: answer.text, calls: events.filter((e) => e.type === 'tool_call').map((e) => e.name), results: events.filter((e) => e.type === 'tool_result') };
}

test('M5: scripted batch comparisons quote real figures and never mutate the page', async () => {
  for (const q of [MOCK_SUGGESTIONS[2], 'Compare IM-2 Athena on 2027-01-13 and 2027-01-27 for a 7-day stay', 'Compare Shackleton ridge on 2028-12-25 and 2028-12-28 for 14 days']) {
    const p = page(), before = structuredClone(p.state), r = await ask(p, q);
    assert.deepEqual(r.calls, ['get_state', 'compare_scenarios']);
    const result = r.results.at(-1).result;
    assert.ok(!result.error);
    const best = result.scenarios[result.ranking.bothH[0]];
    assert.ok(r.answer.includes(`${best.bothH.toFixed(1)} h`));
    assert.ok(r.answer.includes(`${best.longestDarkH.toFixed(1)} h`));
    assert.ok(r.answer.includes(best.landing));
    assert.equal(r.answer.includes('cut to the shortest'), result.cut);
    assert.deepEqual(p.state, before); assert.deepEqual(p.changes, []);
  }
});

test('M5: scripted visibility uses the playhead without a window, or explicit coordinates/time', async () => {
  for (const q of ["Why can't I see the Earth or Sun now?", 'At 89.3°S, 222.7°E on 2027-03-02T10:00Z, why can we not see Earth?', 'Why is the Sun hidden at IM-2 Athena on 2027-01-13T05:00Z?']) {
    const p = page(); p.state.windowOn = false;
    const before = structuredClone(p.state), r = await ask(p, q);
    assert.deepEqual(r.calls, ['get_state', 'sky_at', 'next_events']);
    const sky = r.results[1].result, next = r.results[2].result;
    assert.ok(r.answer.includes(next.headline));
    assert.ok(r.answer.includes(sky.sun.why) || r.answer.includes(sky.earth.why));
    if (q.includes('now')) assert.equal(sky.at, '2027-01-13T05:00Z');
    if (q.includes('89.3')) { assert.equal(sky.place.latDeg, -89.3); assert.equal(next.earth.nextRise, null); }
    assert.deepEqual(p.state, before); assert.deepEqual(p.changes, []);
  }
});

test('M5: scripted comparison/visibility errors are explicit and do not change the page', async () => {
  const p = page();
  assert.match((await ask(p, 'Compare IM-2 Athena')).answer, /at least two sites|two UTC dates/);
  assert.match((await ask(p, 'Compare IM-2 Athena on 2030-01-13 and 2030-01-27')).answer, /ephemeris/);
  assert.match((await ask(p, 'Why is Earth hidden on 2030-01-13?')).answer, /ephemeris/);
  assert.deepEqual(p.changes, []);
});
