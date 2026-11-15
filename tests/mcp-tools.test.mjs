// Every tool through the real stdio server: the compute tools (v1 + v2) against direct core.run, the handshake
// instructions, and open_in_navigator links read back by the page's own parseHash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createCoreTools } from '../demo/src/tools-core.js';
import { V2_EXTENSIONS } from '../demo/src/tools-v2/index.js';
import { loadCoreContext } from '../tools/core-context.mjs';
import { parseHash, DEFAULTS } from '../demo/src/state.js';
import { EPHEMERIS_SPAN, MAP_MODES, DEFAULT_PAGE_URL, readSites } from '../mcp/navigator.mjs';

const server = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const handshake = [
  request('init', 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-tools-test', version: '1.0.0' } }),
  { jsonrpc: '2.0', method: 'notifications/initialized' },
];
const call = (id, name, args) => request(id, 'tools/call', { name, arguments: args });

// Send a transcript, close stdin, return the replies by id.
async function exchange(messages, { env = {}, timeoutMs = 15_000 } = {}) {
  const child = spawn(process.execPath, [server], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  let stderr = '';
  createInterface({ input: child.stdout }).on('line', (line) => { const r = JSON.parse(line); replies.set(r.id, r); });
  child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    const exit = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    child.stdin.end(messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
    assert.deepEqual(await exit, { code: 0, signal: null }, stderr);
    return { replies, stderr };
  } finally { clearTimeout(timer); }
}

const ctx = loadCoreContext();
const core = createCoreTools(ctx, { extensions: V2_EXTENSIONS });

const CASES = {
  list_sites: {},
  site_summary: { site_id: 'shackleton', landing: '2027-01-13', stay_days: 14 },
  compare_scenarios: { places: [{ site_id: 'shackleton' }, { site_id: 'im2' }, { lat_deg: '89.3S', lon_deg: '137.3W' }], landings: ['2027-01-13', '2027-01-27'], stay_days: 14, baseline: 1 },
  rise_set_events: { site_id: 'im2', start: '2027-01-13', days: 30 },
  next_events: { lat_deg: '89.3S', lon_deg: '137.3W', at: '2027-01-13T00:00Z' },
  sky_at: { site_id: 'shackleton', times: ['2027-01-13T00:00Z', '2027-01-20T12:00Z'] },
  skyline: { site_id: 'haworth', step_deg: 10 },
  best_landing_dates: { site_id: 'im2', stay_days: 14, count: 3, compare_to: '2027-01-13' },
  point_facts: { site_id: 'shackleton' },
  energy_summary: { site_id: 'im2', landing: '2027-01-13', battery_hours: 48, alternative: { landing: '2027-01-27' } },
  relay_coverage: { site_id: 'shackleton', landing: '2027-01-13', min_el_deg: 10, alternative: { site_id: 'im2', landing: '2027-01-13' } },
  route_candidates: { points: [{ site_id: 'shackleton' }, { site_id: 'de-gerlache-rim-2' }], landing: '2027-01-13', max_slope_deg: 15 },
  // v2, in call order: the mission tools and references depend on earlier calls in the same process
  find_landing_sites: { landing: '2027-10-07', criteria: { slope_max_deg: 5, psr_distance_km: { min: 1, max: 5 }, inside_psr: false, both_continuous_h_min: 300 }, count: 3 },
  check_slip_robustness: { landing: '2027-01-13' },
  landing_windows: { site_id: 'shackleton', from: '2027-01-01', to: '2027-03-01', planned: '2027-01-13' },
  mission_open: { source: { path: 'tests/fixtures/mission-record.json' } },
  mission_conditions: { points: ['W2', 'landing'] },
};
// Timings are measured, so they differ between two runs; everything else must match exactly.
const untimed = (v) => { const c = structuredClone(v); if (c?.about) delete c.about.timing_ms; return c; };

test('every compute tool through MCP equals direct core.run, in full', { timeout: 180_000 }, async () => {
  assert.deepEqual(Object.keys(CASES).sort(), [...core.list].sort(), 'one case per core tool');
  const names = Object.keys(CASES);
  const { replies, stderr } = await exchange([...handshake, request('list', 'tools/list'), ...names.map((n, i) => call(i, n, CASES[n]))], { timeoutMs: 170_000 });
  assert.equal(stderr, '');
  assert.deepEqual(replies.get('list').result.tools.map((t) => t.name), [...core.list, 'open_in_navigator']);
  for (const [i, name] of names.entries()) {
    const direct = await core.run(name, CASES[name]);
    assert.equal(Object.hasOwn(direct, 'error'), false, `${name}: ${direct.error}`);
    const r = replies.get(i).result;
    assert.equal(r.isError, false, name);
    assert.deepEqual(untimed(r.structuredContent), untimed(direct), name);
    assert.deepEqual(r.structuredContent, JSON.parse(r.content[0].text), name);
  }
});

test('initialize returns instructions with every site id from sites.json and the real ephemeris span', async () => {
  const { replies } = await exchange(handshake.slice(0, 1));
  const { instructions } = replies.get('init').result;
  assert.equal(typeof instructions, 'string');
  const sites = readSites();
  assert.ok(sites.length > 0);
  for (const s of sites) assert.ok(instructions.includes(`- ${s.id}: `), s.id);
  for (const text of ['80°S', 'UTC', '24', 'open_in_navigator', 'about', 'assumptions']) assert.ok(instructions.includes(text), text);
  const prose = instructions.split('\n').filter((l) => !l.startsWith('- ')).join(' ');
  assert.ok(prose.split(/\s+/).filter(Boolean).length <= 260, 'about 250 words without the site table');
  assert.equal(new Date(ctx.eph.startMs).toISOString().slice(0, 10), EPHEMERIS_SPAN.start);
  assert.equal(new Date(ctx.eph.endMs).toISOString().slice(0, 10), EPHEMERIS_SPAN.end);
});

const HOUR = 3600e3, DAY = 86400e3;
const back = (url) => parseHash(new URL(url).hash, ctx.sites, ctx.eph);

test('open_in_navigator links read back through state.js parseHash to the requested view', async () => {
  const inputs = [
    { site_id: 'shackleton' },
    { site_id: 'haworth', landing: '2027-03-02T07:45Z', stay_days: 7.5, slip_days: -21, mode: 'change', at: '2027-03-04T10:31Z', sheet: 'compare' },
    { lat_deg: '89.3S', lon_deg: '137.3W', landing: '2027-01-27', stay_days: 30, slip_days: 0, mode: 'now' },
    { lat_deg: -85.25, lon_deg: 12.5, landing: '2028-12-31T23:00Z', stay_days: 1, mode: 'score', sheet: 'power' },
    ...MAP_MODES.map((mode) => ({ site_id: 'im2', mode })),
  ];
  const { replies } = await exchange([...handshake, ...inputs.map((a, i) => call(i, 'open_in_navigator', a))]);
  for (const [i, input] of inputs.entries()) {
    const r = replies.get(i).result;
    assert.equal(r.isError, false, JSON.stringify(r.structuredContent));
    assert.deepEqual(Object.keys(r.structuredContent).sort(), ['opens', 'url']);
    const { url, opens } = r.structuredContent;
    assert.ok(url.startsWith(`${DEFAULT_PAGE_URL}#`), url);
    assert.equal(typeof opens, 'string');
    const s = back(url);
    assert.equal(s.view, 'map');
    if (input.site_id) assert.equal(s.site.id, input.site_id);
    else {
      assert.equal(s.site.id, 'custom');
      assert.ok(Math.abs(s.site.latDeg - (typeof input.lat_deg === 'number' ? input.lat_deg : -89.3)) < 1e-9);
      assert.ok(Math.abs(s.site.lonDeg - (typeof input.lon_deg === 'number' ? input.lon_deg : 222.7)) < 1e-9);
    }
    const landing = input.landing ? Math.floor(Date.parse(input.landing.length === 10 ? `${input.landing}T00:00Z` : input.landing) / HOUR) * HOUR : DEFAULTS.landingMs;
    assert.equal(s.landingMs, landing);
    assert.equal(s.stayDays, input.stay_days ?? DEFAULTS.stayDays);
    assert.equal(s.slipDays, input.slip_days ?? DEFAULTS.slipDays);
    assert.equal(s.mapMode, input.mode ?? 'both');
    assert.equal(s.cursorMs, input.at ? Date.parse(input.at) : landing);
    assert.equal(s.sheet, input.sheet ?? null);
  }
  // spot checks of the sentence
  assert.match(replies.get(1).result.structuredContent.opens, /Haworth.*2 Mar 2027 07:00 UTC for 7\.5 days.*9 Feb 2027 07:00 UTC.*playhead at 4 Mar 2027 10:31 UTC.*Compare tab/);
  assert.match(replies.get(2).result.structuredContent.opens, /the point 89\.30°S 137\.30°W/);
  assert.equal(back(replies.get(0).result.structuredContent.url).slipDays * DAY + DEFAULTS.landingMs, DEFAULTS.landingMs + 14 * DAY);
});

test('open_in_navigator uses LSN_PAGE_URL and returns tool errors for bad input', async () => {
  const page = 'https://example.org/lsn/lunar-site-navigator.html';
  const bad = [
    {},
    { site_id: 'no-such-site' },
    { site_id: 'im2', lat_deg: -89, lon_deg: 0 },
    { lat_deg: -89 },
    { lat_deg: '91S', lon_deg: 0 },
    { site_id: 'im2', landing: '2030-01-01' },
    { site_id: 'im2', landing: '2027-02-30' },
    { site_id: 'im2', at: '2026-01-01T00:00Z' },
    { site_id: 'im2', mode: 'heat' },
    { site_id: 'im2', sheet: 'charts' },
    { site_id: 'im2', stay_days: 61 },
    { site_id: 'im2', slip_days: 2.5 },
    { site_id: 'im2', extra: 1 },
  ];
  const { replies } = await exchange([...handshake, call('ok', 'open_in_navigator', { site_id: 'im2', landing: '2027-01-13' }), ...bad.map((a, i) => call(i, 'open_in_navigator', a))], { env: { LSN_PAGE_URL: page } });
  const ok = replies.get('ok').result.structuredContent;
  assert.ok(ok.url.startsWith(`${page}#view=map&`), ok.url);
  assert.equal(back(ok.url).site.id, 'im2');
  assert.doesNotMatch(ok.opens, /not found/);
  for (const [i, input] of bad.entries()) {
    const r = replies.get(i);
    assert.equal(r.error, undefined, JSON.stringify(input));
    assert.equal(r.result.isError, true, JSON.stringify(input));
    assert.equal(typeof r.result.structuredContent.error, 'string');
    assert.deepEqual(JSON.parse(r.result.content[0].text), r.result.structuredContent);
  }
});
