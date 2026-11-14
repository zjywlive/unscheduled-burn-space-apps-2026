import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCommands } from '../demo/src/commands.js';
import { createAgent } from '../demo/src/agent/provider.js';
import { createMockProvider, matchIntent, namedSites, MOCK_SUGGESTIONS, SUPPORTED_TEXT } from '../demo/src/agent/mock.js';

const sites = JSON.parse(readFileSync(new URL('../demo/data/sites.json', import.meta.url)));
const H = 36e5;

function fakeApi(stats = {}, more = {}) {
  const state = {
    view: 'map', site: sites.find((s) => s.id === 'im2'), landingMs: Date.UTC(2027, 0, 13), stayDays: 14, slipDays: 0,
    mapMode: 'both', maxSlope: null, maxDark: null, weights: { sun: 40, earth: 30, slope: 20, shadow: 10 },
  };
  const regions = {};
  const calls = [];
  return {
    sites, state, calls,
    getState: () => ({
      ...state,
      summary: { planned: { stayMs: 336 * H, sunMs: 200 * H, earthMs: 180 * H, bothMs: 123.4 * H, longestDarkMs: 0 }, alt: { stayMs: 336 * H, sunMs: 150 * H, earthMs: 170 * H, bothMs: 98.1 * H, longestDarkMs: 0 } },
    }),
    update: (p) => { calls.push(['update', p]); Object.assign(state, p); },
    setView: (v) => calls.push(['setView', v]),
    setRegion: (slot, shape) => { calls.push(['setRegion', slot]); regions[slot] = shape; },
    setRoute: () => {},
    regionStats: async (slot) => (regions[slot] ? { cells: 57, areaKm2: 706.9, sun: 0.637, earth: 0.512, both: 0.291, pass: 0.43, score: 0.5, best: { cell: 9, value: 0.873, coords: '89.41°S 137.02°W' }, ...(stats[slot] ?? {}) } : null),
    bestCells: async (n) => [{ latDeg: -89.41, lonDeg: 222.98, value: 0.947 }, { latDeg: -85.3, lonDeg: 35.2, value: 0.902 }, { latDeg: -86.1, lonDeg: 0.4, value: 0.856 }].slice(0, n),
    startTour: () => calls.push(['startTour']),
    ...more,
  };
}

// A provider that replays a fixed list of responses.
function replay(responses) {
  let i = 0;
  const seen = [];
  return { seen, respond: async (req) => { seen.push(req); const r = responses[Math.min(i, responses.length - 1)]; i++; if (r instanceof Error) throw r; return r; } };
}

const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const say = (text) => ({ type: 'text', text });

async function ask(api, q) {
  const agent = createAgent({ provider: createMockProvider(), commands: createCommands(api) });
  const events = [];
  const out = await agent.send(q, (e) => events.push(e));
  return { out, events, calls: events.filter((e) => e.type === 'tool_call').map((e) => e.name) };
}

// ---------- the loop ----------
test('loop: tool calls run through the commands and the loop ends on a text-only answer', async () => {
  const api = fakeApi();
  const provider = replay([{ content: [say('Checking.'), use('t1', 'set_map_mode', { mode: 'sun' })] }, { content: [say('Done.')] }]);
  const agent = createAgent({ provider, commands: createCommands(api) });
  const events = [];
  const out = await agent.send('switch to sun', (e) => events.push(e));
  assert.deepEqual(out, { stop: 'end_turn', text: 'Done.', steps: 2 });
  assert.deepEqual(events.map((e) => e.type), ['user', 'assistant', 'tool_call', 'tool_result', 'assistant']);
  assert.equal(api.state.mapMode, 'sun');
  // Second request carries the Messages API shapes: assistant content blocks, then a user tool_result.
  const m = provider.seen[1].messages;
  assert.equal(m.length, 3);
  assert.deepEqual(m[0], { role: 'user', content: 'switch to sun' });
  assert.equal(m[1].role, 'assistant');
  assert.deepEqual(m[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({ mapMode: 'sun', label: 'Sunlit' }) }] });
  assert.equal(provider.seen[0].tools.length, createCommands(api).list.length);   // phase 4: 15 plus the workflow commands
  assert.ok(provider.seen[0].tools.every((t) => t.input_schema.additionalProperties === false));
  assert.equal(agent.messages.length, 4);
});

test('loop: stops after maxSteps provider calls', async () => {
  const provider = replay([{ content: [use('t', 'get_state')] }]);
  const agent = createAgent({ provider, commands: createCommands(fakeApi()), maxSteps: 3 });
  const events = [];
  const out = await agent.send('loop forever', (e) => events.push(e));
  assert.equal(out.stop, 'max_steps');
  assert.equal(provider.seen.length, 3);
  assert.equal(events.filter((e) => e.type === 'tool_call').length, 3);
  assert.deepEqual(events.at(-1), { type: 'error', message: 'Stopped after 3 steps without a final answer.' });
});

test('loop: default maxSteps is 8', async () => {
  const provider = replay([{ content: [use('t', 'get_state')] }]);
  const out = await createAgent({ provider, commands: createCommands(fakeApi()) }).send('x');
  assert.equal(out.stop, 'max_steps');
  assert.equal(provider.seen.length, 8);
});

test('loop: a tool error goes back to the provider as an is_error result', async () => {
  const provider = replay([{ content: [use('t1', 'set_stay', { days: 9 })] }, { content: [say('That stay is not offered.')] }]);
  const events = [];
  const out = await createAgent({ provider, commands: createCommands(fakeApi()) }).send('stay 9 days', (e) => events.push(e));
  assert.equal(out.stop, 'end_turn');
  const r = events.find((e) => e.type === 'tool_result');
  assert.equal(r.isError, true);
  assert.match(r.result.error, /one of 7, 14, 30/);
  const block = provider.seen[1].messages[2].content[0];
  assert.equal(block.is_error, true);
  assert.equal(block.tool_use_id, 't1');
});

test('loop: an unknown tool name is reported, not run', async () => {
  const provider = replay([{ content: [use('t1', 'launch_rocket', { now: true })] }, { content: [say('I cannot do that.')] }]);
  const events = [];
  await createAgent({ provider, commands: createCommands(fakeApi()) }).send('launch', (e) => events.push(e));
  const r = events.find((e) => e.type === 'tool_result');
  assert.deepEqual(r.result, { error: 'Unknown tool launch_rocket.' });
  assert.equal(r.isError, true);
});

test('loop: several tool_use blocks in one turn each get a result, in order', async () => {
  const api = fakeApi();
  const provider = replay([{ content: [use('a', 'set_stay', { days: 7 }), use('b', 'set_slip', { days: 3 })] }, { content: [say('ok')] }]);
  await createAgent({ provider, commands: createCommands(api) }).send('x');
  assert.deepEqual(provider.seen[1].messages[2].content.map((b) => b.tool_use_id), ['a', 'b']);
  assert.equal(api.state.stayDays, 7);
  assert.equal(api.state.slipDays, 3);
});

test('loop: a provider failure, a throwing listener, and a second send while busy', async () => {
  const failing = replay([new Error('network down')]);
  const events = [];
  const out = await createAgent({ provider: failing, commands: createCommands(fakeApi()) }).send('x', (e) => events.push(e));
  assert.equal(out.stop, 'error');
  assert.deepEqual(events.at(-1), { type: 'error', message: 'The provider failed: network down' });

  const agent = createAgent({ provider: replay([{ content: [say('hi')] }]), commands: createCommands(fakeApi()) });
  const ok = await agent.send('x', () => { throw new Error('listener'); });
  assert.equal(ok.stop, 'end_turn');

  let release;
  const slow = { respond: () => new Promise((r) => { release = () => r({ content: [say('late')] }); }) };
  const a2 = createAgent({ provider: slow, commands: createCommands(fakeApi()) });
  const first = a2.send('one');
  const busyEvents = [];
  const second = await a2.send('two', (e) => busyEvents.push(e));
  assert.equal(second.stop, 'busy');
  assert.equal(busyEvents[0].type, 'error');
  release();
  assert.equal((await first).text, 'late');
});

test('loop: a malformed provider response ends the turn without crashing', async () => {
  const out = await createAgent({ provider: replay([{}]), commands: createCommands(fakeApi()) }).send('x');
  assert.deepEqual(out, { stop: 'end_turn', text: '', steps: 1 });
});

// ---------- the scripted provider ----------
test('mock: intent matching and site names', () => {
  assert.equal(matchIntent('Find flat, sunlit ground near Shackleton ridge'), 'flat');
  assert.equal(matchIntent('Compare region A and region B'), 'compare');
  assert.equal(matchIntent('What if the landing slips 7 days?'), 'slip');
  assert.equal(matchIntent('Show the best 3 cells in this mode'), 'best');
  assert.equal(matchIntent('Give me a tour of the interface'), 'tour');
  assert.equal(matchIntent('What is the weather on Mars?'), null);
  for (const s of MOCK_SUGGESTIONS) assert.notEqual(matchIntent(s), null, s);
  assert.deepEqual(namedSites('compare haworth and shackleton', sites).map((s) => s.id), ['haworth', 'shackleton']);
  assert.deepEqual(namedSites('near Mons Mouton Plateau', sites).map((s) => s.id), ['mons-mouton-plateau']);
  assert.deepEqual(namedSites('nothing here', sites), []);
});

test('mock (a): flat sunlit ground near a site, figures from region_stats', async () => {
  const api = fakeApi();
  const { out, calls } = await ask(api, 'Find flat, sunlit ground near Shackleton ridge');
  assert.deepEqual(calls, ['get_state', 'zoom_to', 'set_filters', 'set_map_mode', 'draw_region', 'region_stats']);
  assert.equal(out.stop, 'end_turn');
  assert.match(out.text, /Within 15 km of Shackleton ridge, 43% of the ground passes the 10° slope filter/);
  assert.match(out.text, /707 km² in 57 cells and is sunlit 64% of the stay/);
  assert.match(out.text, /at 89\.41°S 137\.02°W, is sunlit 87% of the stay/);
  assert.equal(api.state.maxSlope, 10);
  assert.equal(api.state.mapMode, 'sun');
  // Different command results give a different answer: nothing is typed in.
  const other = await ask(fakeApi({ A: { pass: 0.12, sun: 0.255, cells: 9, areaKm2: 36 } }), 'flat sunny ground near Haworth');
  assert.match(other.out.text, /Within 15 km of Haworth, 12% .* 36 km² in 9 cells and is sunlit 26%/);
  const none = await ask(fakeApi({ A: { cells: 0 } }), 'flat ground near Haworth');
  assert.match(none.out.text, /smaller than one grid cell/);
  const north = await ask(fakeApi(), 'flat ground near Apollo 11');
  assert.match(north.out.text, /north of 80°S/);
});

test('mock (b): compare regions A and B, or two named sites', async () => {
  const empty = await ask(fakeApi(), 'Compare region A and region B');
  assert.deepEqual(empty.calls, ['get_state', 'region_stats']);
  assert.match(empty.out.text, /Region A is empty/);
  const api = fakeApi({ B: { both: 0.412, sun: 0.7 } });
  const r = await ask(api, 'Compare Shackleton ridge and Haworth');
  assert.deepEqual(r.calls, ['get_state', 'draw_region', 'draw_region', 'region_stats', 'region_stats']);
  assert.match(r.out.text, /Shackleton ridge: sunlit 64%, Earth in view 51%, both 29% of the stay; 43% passes the filters\./);
  assert.match(r.out.text, /Haworth: sunlit 70%/);
  assert.match(r.out.text, /Haworth is 12 percentage points higher than Shackleton ridge/);
  // Regions already drawn by the user: only the stats are read.
  const api2 = fakeApi();
  const c = createCommands(api2);
  await c.run('draw_region', { slot: 'A', type: 'circle', site_id: 'im2', radius_km: 5 });
  await c.run('draw_region', { slot: 'B', type: 'circle', site_id: 'haworth', radius_km: 5 });
  const r2 = await ask(api2, 'compare A vs B');
  assert.deepEqual(r2.calls, ['get_state', 'region_stats', 'region_stats']);
  assert.match(r2.out.text, /same share/);
});

test('mock (c): a slip of N days, figures from get_state summaries', async () => {
  const api = fakeApi();
  const r = await ask(api, 'What if the landing slips 7 days?');
  assert.deepEqual(r.calls, ['get_state', 'set_slip', 'set_map_mode', 'get_state']);
  assert.equal(api.state.slipDays, 7);
  assert.equal(api.state.mapMode, 'change');
  assert.match(r.out.text, /landing on 13 Jan gives 123\.4 h with Sun and Earth both in view over a 14\.0-day stay/);
  assert.match(r.out.text, /Landing 7 days later, on 20 Jan, gives 98\.1 h: 25\.3 h less/);
  const weeks = await ask(fakeApi(), 'What if we postpone by two weeks?');
  assert.match(weeks.out.text, /14 days later, on 27 Jan/);
  const earlier = await ask(fakeApi(), 'What if we land 3 days earlier?');
  assert.match(earlier.out.text, /3 days earlier, on 10 Jan/);
  const noSummary = await ask(fakeApi({}, { getState() { return { ...this.state }; } }), 'delay by 5 days');
  assert.match(noSummary.out.text, /alternative now lands 5 days later, on 18 Jan/);
  const vague = await ask(fakeApi(), 'what if the landing is delayed?');
  assert.match(vague.out.text, /How many days/);
  const tooFar = await ask(fakeApi(), 'what if the landing slips 90 days?');
  assert.match(tooFar.out.text, /at most 60/);
});

test('mock (d): best cells in the current mode', async () => {
  const api = fakeApi();
  const r = await ask(api, 'Show the best 3 cells in this mode');
  assert.deepEqual(r.calls, ['get_state', 'best_cells']);
  assert.match(r.out.text, /Best 3 cells in Both mode, after the filters: 1\. 89\.41°S 137\.02°W, 95% of the stay; 2\. 85\.30°S 35\.20°E, 90% of the stay; 3\./);
  api.state.mapMode = 'now';
  const r2 = await ask(api, 'top two spots');
  assert.deepEqual(r2.calls, ['get_state', 'set_map_mode', 'best_cells']);
  assert.match(r2.out.text, /switched the map to Both mode.*Best 2 cells/);
  api.state.mapMode = 'score';
  const r3 = await ask(api, 'best cell please, top 1');
  assert.match(r3.out.text, /Best 1 cell in Suitability mode.*score 0\.95/);
  const busy = await ask(fakeApi({}, { bestCells: async () => [] }), 'best cells');
  assert.match(busy.out.text, /still computing/);
});

test('mock (e): tour', async () => {
  const api = fakeApi();
  const r = await ask(api, 'Give me a tour of the interface');
  assert.deepEqual(r.calls, ['start_tour']);
  assert.deepEqual(api.calls.at(-1), ['startTour']);
  assert.match(r.out.text, /tour has started/);
});

test('mock: unmatched questions get the list of supported questions, with no tool calls', async () => {
  const r = await ask(fakeApi(), 'What is the weather on Mars?');
  assert.deepEqual(r.calls, []);
  assert.equal(r.out.text, SUPPORTED_TEXT);
});

test('mock: copy is English sentence case without exclamation marks', () => {
  for (const s of [...MOCK_SUGGESTIONS, SUPPORTED_TEXT]) {
    assert.ok(!s.includes('!'), s);
    assert.ok(/^[A-Z]/.test(s), s);
  }
});

// ---------- third wave (correctness review I4, I5, M3, Q3) ----------
test('a tool that never answers times out as an error result, and the next question is not refused (review I4)', async () => {
  const api = fakeApi({}, { regionStats: () => new Promise(() => {}) });
  const commands = createCommands(api);
  const provider = replay([
    { content: [{ type: 'tool_use', id: 't1', name: 'region_stats', input: { slot: 'A' } }] },
    { content: [{ type: 'text', text: 'Done.' }] },
  ]);
  const agent = createAgent({ provider, commands, toolTimeoutMs: 50 });
  const events = [];
  const r = await agent.send('stats', (e) => events.push(e));
  assert.equal(r.stop, 'end_turn');
  const res = events.find((e) => e.type === 'tool_result');
  assert.equal(res.isError, true); assert.match(res.result.error, /region_stats timed out/);
  assert.equal(agent.busy, false);
  assert.notEqual((await agent.send('again')).stop, 'busy');
});

test('a provider that never answers times out; reset() also frees a stuck agent (review I4)', async () => {
  const commands = createCommands(fakeApi());
  const slow = createAgent({ provider: { respond: () => new Promise(() => {}) }, commands, providerTimeoutMs: 50 });
  const events = [];
  const r = await slow.send('hello', (e) => events.push(e));
  assert.equal(r.stop, 'error'); assert.match(events.at(-1).message, /timed out/);
  assert.equal(slow.busy, false);
  const stuck = createAgent({ provider: { respond: () => new Promise(() => {}) }, commands, providerTimeoutMs: 200 });
  const pending = stuck.send('hello');
  assert.equal(stuck.busy, true);
  stuck.reset();
  assert.equal(stuck.busy, false);
  assert.notEqual((await Promise.race([stuck.send('x'), new Promise((ok) => setTimeout(() => ok({ stop: 'waiting' }), 20))])).stop, 'busy');
  void pending;
});

test('mock: a minus sign means an earlier landing (review M3)', async () => {
  const api = fakeApi();
  const agent = createAgent({ provider: createMockProvider(), commands: createCommands(api) });
  await agent.send('What if the landing slips -7 days?');
  assert.equal(api.state.slipDays, -7);
  await agent.send('What if the landing slips 7 days?');
  assert.equal(api.state.slipDays, 7);
});

test('mock: a stay cut by the end of the ephemeris is stated in the answer (review I5)', async () => {
  const api = fakeApi();
  api.state.landingMs = Date.UTC(2028, 11, 31, 23);
  const agent = createAgent({ provider: createMockProvider(), commands: createCommands(api) });
  const out = await agent.send('Show the best 3 cells in this mode');
  assert.match(out.text, /the ephemeris ends on 1 Jan 2029, so this stay is cut to 1 h/);
  api.state.landingMs = Date.UTC(2027, 0, 13);
  assert.doesNotMatch((await agent.send('Show the best 3 cells in this mode')).text, /ephemeris ends/);
});

test('mock: with a longest-dark filter already on, the flat answer names both filters (review Q3)', async () => {
  const api = fakeApi();
  api.state.maxDark = 96;
  const agent = createAgent({ provider: createMockProvider(), commands: createCommands(api) });
  const out = await agent.send('Find flat, sunlit ground near Shackleton ridge');
  assert.match(out.text, /passes the filters \(slope up to 10°, longest dark up to 96 h\)/);
});
