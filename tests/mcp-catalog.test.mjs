// MCP v2 prompts and resources through the real stdio server (docs/mcp-v2/DESIGN.md §7): every prompt renders
// with its audience voice and only names tools the server lists; static resources read; held search and
// mission results export as CSV / GeoJSON / JSON; lifecycle and error codes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { AUDIENCES } from '../demo/src/agent/system-prompt.js';
import { PROMPTS } from '../mcp/catalog.mjs';

const server = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const handshake = [
  request('init', 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-catalog-test', version: '1.0.0' } }),
  { jsonrpc: '2.0', method: 'notifications/initialized' },
];

async function exchange(messages, timeoutMs = 120_000) {
  const child = spawn(process.execPath, [server], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'] });
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

const MAIN_TOOLS = ['find_landing_sites', 'check_slip_robustness', 'landing_windows', 'mission_open', 'mission_conditions', 'route_candidates', 'compare_scenarios', 'site_summary', 'sky_at', 'skyline', 'next_events', 'best_landing_dates', 'list_sites', 'point_facts', 'open_in_navigator'];
const sample = { requirements: 'flat, Sun and Earth together 300 h, near a PSR, possible ice', site: 'shackleton', original_date: '2027-01-13', new_date: '2027-01-20', source: '/tmp/mission.json', topic: 'why the Sun stays low', question: 'Why is it dark in craters near the pole?', place: 'shackleton' };

test('initialize advertises prompts and resources; catalog methods need the handshake', async () => {
  const { replies } = await exchange([request(1, 'prompts/list'), ...handshake, request(2, 'prompts/list'), request(3, 'resources/list'), request(4, 'resources/templates/list')]);
  assert.equal(replies.get(1).error.code, -32000);
  assert.deepEqual(replies.get('init').result.capabilities, { tools: {}, prompts: {}, resources: {} });
  assert.deepEqual(replies.get(2).result.prompts.map((p) => p.name), PROMPTS.map((p) => p.name));
  assert.deepEqual(replies.get(3).result.resources.map((r) => r.uri), ['lsn://sites', 'lsn://criteria/presets', 'lsn://about/data', 'lsn://glossary']);
  assert.ok(replies.get(4).result.resourceTemplates.some((t) => t.uriTemplate === 'lsn://search/{search_id}.csv'));
});

test('every prompt renders with its audience voice and names only listed tools', async () => {
  const gets = PROMPTS.map((p, i) => request(`p${i}`, 'prompts/get', { name: p.name, arguments: Object.fromEntries(p.arguments.map((a) => [a.name, sample[a.name] ?? 'x'])) }));
  const { replies } = await exchange([...handshake, request('tools', 'tools/list'), ...gets,
    request('missing', 'prompts/get', { name: 'plan_landing_site', arguments: {} }),
    request('unknown', 'prompts/get', { name: 'nope' })]);
  const tools = new Set(replies.get('tools').result.tools.map((t) => t.name));
  for (const name of MAIN_TOOLS) assert.ok(tools.has(name), `the server lists ${name}`);
  PROMPTS.forEach((p, i) => {
    const r = replies.get(`p${i}`).result;
    assert.equal(r.messages.length, 1, p.name);
    const text = r.messages[0].content.text;
    assert.ok(text.startsWith(AUDIENCES[p.audience]), `${p.name} uses the ${p.audience} voice`);
    assert.match(text, /assumption/i, p.name);
    for (const word of text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) {
      if (tools.has(word) || !MAIN_TOOLS.includes(word)) continue;
      assert.fail(`${p.name} names ${word}, which the server does not list`);
    }
  });
  assert.equal(replies.get('missing').error.code, -32602);
  assert.match(replies.get('missing').error.message, /requirements/);
  assert.equal(replies.get('unknown').error.code, -32602);
});

test('static resources read; unknown and expired ones are -32002', async () => {
  const uris = ['lsn://sites', 'lsn://criteria/presets', 'lsn://about/data', 'lsn://glossary'];
  const { replies } = await exchange([...handshake, ...uris.map((uri, i) => request(i, 'resources/read', { uri })),
    request('bad', 'resources/read', { uri: 'lsn://nothing' }), request('old', 'resources/read', { uri: 'lsn://search/s_99.csv' })]);
  uris.forEach((uri, i) => {
    const c = replies.get(i).result.contents[0];
    assert.equal(c.uri, uri);
    assert.ok(c.text.length > 100, uri);
  });
  const presets = JSON.parse(replies.get(1).result.contents[0].text);
  assert.ok(presets.presets.lander_dte && presets.presets.ice_prospector);
  assert.match(replies.get(2).result.contents[0].text, /\| Resource \|/);
  assert.equal(replies.get('bad').error.code, -32002);
  assert.equal(replies.get('old').error.code, -32002);
});

test('a find_landing_sites result is listed and exported as CSV and GeoJSON', { timeout: 120_000 }, async () => {
  const criteria = { slope_max_deg: 5, psr_distance_km: { min: 1, max: 5 }, inside_psr: false, both_continuous_h_min: 300 };
  const { replies } = await exchange([...handshake,
    request('find', 'tools/call', { name: 'find_landing_sites', arguments: { landing: '2027-10-07', criteria, count: 3 } }),
    request('list', 'resources/list'),
    request('csv', 'resources/read', { uri: 'lsn://search/s_1.csv' }),
    request('geo', 'resources/read', { uri: 'lsn://search/s_1.geojson' })]);
  const found = replies.get('find').result.structuredContent;
  assert.equal(found.search_id, 's_1');
  assert.ok(found.candidates.length >= 1);
  assert.ok(replies.get('list').result.resources.some((r) => r.uri === 'lsn://search/s_1.csv'));
  const csv = replies.get('csv').result.contents[0].text.trim().split('\n');
  assert.ok(csv[0].split(',').includes('ref'));
  assert.equal(csv.length - 1, found.candidates.length);
  const geo = JSON.parse(replies.get('geo').result.contents[0].text);
  assert.equal(geo.features.length, found.candidates.length);
  const [lon, lat] = geo.features[0].geometry.coordinates;
  assert.ok(lat <= -80 && lon >= -180 && lon <= 180);
});
