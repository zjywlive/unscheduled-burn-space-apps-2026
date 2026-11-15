import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createCoreTools } from '../demo/src/tools-core.js';
import { V2_EXTENSIONS } from '../demo/src/tools-v2/index.js';
import { loadCoreContext } from '../tools/core-context.mjs';
import { buildInstructions, OPEN_SPEC } from '../mcp/navigator.mjs';

const server = new URL('../mcp/server.mjs', import.meta.url);
const hello = (protocolVersion = '2025-11-25') => ({ protocolVersion, capabilities: {}, clientInfo: { name: 'mcp-test', version: '1.0.0' } });
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const handshake = [request('init', 'initialize', hello()), initialized];

// Independent wire-level harness: send a transcript, close stdin, inspect every stdout line.
async function exchange(messages, args = [fileURLToPath(server)]) {
  const child = spawn(process.execPath, args, {
    cwd: fileURLToPath(new URL('../mcp/', import.meta.url)),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [], errors = [];
  let stderr = '', stdout = '';
  createInterface({ input: child.stdout }).on('line', (line) => lines.push(line));
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', (error) => errors.push(error));
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdin.end(messages.map((m) => typeof m === 'string' ? m : JSON.stringify(m)).join('\n') + '\n');
    assert.deepEqual(await exit, { code: 0, signal: null }, stderr);
    assert.deepEqual(errors, []);
    assert.ok(stdout.endsWith('\n'), 'Every response is newline terminated');
    const replies = lines.map((line) => {
      assert.ok(line.length, 'No blank/log lines on stdout');
      const r = JSON.parse(line);
      assert.equal(r.jsonrpc, '2.0');
      assert.notEqual(Object.hasOwn(r, 'result'), Object.hasOwn(r, 'error'));
      if (r.error) {
        assert.ok(Number.isInteger(r.error.code));
        assert.equal(typeof r.error.message, 'string');
      } else assert.ok(typeof r.id === 'string' || Number.isSafeInteger(r.id));
      return r;
    });
    return { replies, stderr };
  } finally { clearTimeout(timer); }
}

test('MCP handshake, initialized notification, ping and clean EOF; stdout is only JSON-RPC', async () => {
  const { replies, stderr } = await exchange([...handshake, request(0, 'ping')]);
  assert.deepEqual(replies, [
    { jsonrpc: '2.0', id: 'init', result: { protocolVersion: '2025-11-25', capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: 'lunar-site-navigator', version: '2.0.0' }, instructions: buildInstructions() } },
    { jsonrpc: '2.0', id: 0, result: {} },
  ]);
  assert.equal(stderr, '');
});

test('MCP version negotiation counteroffers its supported revision', async () => {
  for (const version of ['2025-11-25', '2024-11-05', '2026-07-28', 'unknown']) {
    const { replies } = await exchange([request('version', 'initialize', hello(version))]);
    assert.equal(replies[0].result.protocolVersion, '2025-11-25');
  }
});

test('MCP tools/list exports the live core schemas (v1 + v2) plus open_in_navigator, with read-only annotations', async () => {
  const { replies, stderr } = await exchange([...handshake, request(1, 'tools/list'), request(2, 'tools/list', { _meta: {} })]);
  const specs = createCoreTools(loadCoreContext(), { extensions: V2_EXTENSIONS }).toolDefinitions();
  const listed = replies[1].result.tools;
  assert.equal(listed.length, specs.length + 1);
  assert.ok(specs.length >= 12);
  assert.deepEqual(listed.slice(0, specs.length).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })), specs);
  assert.deepEqual(listed[specs.length], OPEN_SPEC);
  for (const tool of listed) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.inputSchema.properties);
    assert.equal(Object.hasOwn(tool, 'input_schema'), false);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false });
  }
  assert.deepEqual(replies[1].result, replies[2].result);
  assert.equal(stderr, '');
});

test('MCP successful site_summary equals direct real-data core.run, including every number', async () => {
  const args = { site_id: 'shackleton', landing: '2027-01-13', stay_days: 14 };
  const direct = await createCoreTools(loadCoreContext()).run('site_summary', args);
  assert.equal(typeof direct.bothH, 'number');
  const { replies } = await exchange([...handshake, request(1, 'tools/call', { name: 'site_summary', arguments: args })]);
  const result = replies[1].result;
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, direct);
  assert.deepEqual(JSON.parse(result.content[0].text), direct);
});

test('MCP core validation and domain errors are tool results, not protocol errors', async () => {
  const { replies } = await exchange([...handshake,
    request(1, 'tools/call', { name: 'site_summary', arguments: { site_id: 'no-such-site', landing: '2027-01-13' } }),
    request(2, 'tools/call', { name: 'next_events', arguments: { site_id: 'shackleton' } }),
    request(3, 'tools/call', { name: 'list_sites' }),
  ]);
  for (const r of replies.slice(1, 3)) {
    assert.equal(r.error, undefined);
    assert.equal(r.result.isError, true);
    assert.deepEqual(JSON.parse(r.result.content[0].text), r.result.structuredContent);
  }
  assert.match(replies[1].result.structuredContent.error, /Unknown site_id/);
  assert.match(replies[2].result.structuredContent.error, /at is required/);
  assert.equal(replies[3].result.isError, false);
});

test('MCP unknown method/tool and malformed parameters have correct protocol errors', async () => {
  const { replies } = await exchange([...handshake,
    request(1, 'does/not/exist'),
    request(2, 'tools/call', { name: 'does_not_exist' }),
    request(3, 'tools/call', { name: 'sky_at', arguments: [] }),
    request(4, 'tools/call', {}),
    request(5, 'tools/list', { cursor: 'not-issued' }),
    request(6, 'tools/list', []),
    request(7, 'tools/call', null),
    request(8, 'ping', { _meta: [] }),
    request(9, 'tools/call', { name: 'list_sites', task: {} }),
  ]);
  assert.deepEqual(replies.slice(1).map((r) => r.error.code), [-32601, -32602, -32602, -32602, -32602, -32602, -32602, -32602, -32602]);
});

test('MCP rejects malformed input and batches, then continues processing valid lines', async () => {
  const { replies } = await exchange(['{broken', [], null, request(null, 'ping'), { jsonrpc: '1.0', id: 5, method: 'ping' }, ...handshake, request(6, 'ping')]);
  assert.deepEqual(replies.slice(0, 5).map((r) => r.error.code), [-32700, -32600, -32600, -32600, -32600]);
  assert.equal(Object.hasOwn(replies[0], 'id'), false);
  assert.equal(replies[4].id, 5);
  assert.deepEqual(replies.at(-1), { jsonrpc: '2.0', id: 6, result: {} });
});

test('MCP enforces lifecycle and never replies to or executes notification tool calls', async () => {
  const { replies } = await exchange([
    request(1, 'tools/list'),
    request(2, 'initialize', { protocolVersion: '2025-11-25' }),
    ...handshake.slice(0, 1),
    request(3, 'tools/list'),
    initialized,
    { jsonrpc: '2.0', method: 'notifications/unknown' },
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'list_sites' } },
    request(4, 'initialize', hello()),
    request(5, 'ping'),
  ]);
  assert.deepEqual(replies.map((r) => r.id), [1, 2, 'init', 3, 4, 5]);
  assert.deepEqual(replies.filter((r) => r.error).map((r) => r.error.code), [-32000, -32602, -32000, -32600]);
});

test('MCP loads context lazily and reports missing data clearly without touching real files', async () => {
  const source = `import { serve } from ${JSON.stringify(server.href)};
    import { loadCoreContext } from ${JSON.stringify(new URL('../tools/core-context.mjs', import.meta.url).href)};
    await serve({ loadContext: () => loadCoreContext({ dataDir: ${JSON.stringify(fileURLToPath(new URL('../mcp/missing-data-for-test/', import.meta.url)))} }) });`;
  const args = ['--input-type=module', '-e', source];
  const initial = await exchange([...handshake, request(1, 'ping')], args);
  assert.equal(initial.stderr, '');
  assert.ok(initial.replies.every((r) => r.result));
  const missing = await exchange([...handshake, request(1, 'tools/list'), request(2, 'tools/call', { name: 'list_sites' }), request(3, 'ping')], args);
  assert.equal(missing.replies[1].error.code, -32603);
  assert.match(missing.replies[1].error.message, /Cannot load lunar data.*ENOENT.*ephemeris\.json/);
  assert.equal(missing.replies[2].result.isError, true);
  assert.match(missing.replies[2].result.structuredContent.error, /files are present and readable/);
  assert.match(missing.stderr, /Cannot load lunar data/);
  assert.deepEqual(missing.replies[3].result, {});
});

test('MCP limits tool invocation rate without losing the connection', async () => {
  // Freeze only the server's rate-limit clock so the assertion does not depend on machine speed.
  const source = `import { serve } from ${JSON.stringify(server.href)}; Date.now = () => 2000; await serve();`;
  const calls = Array.from({ length: 61 }, (_, i) => request(i, 'tools/call', { name: 'list_sites' }));
  const { replies } = await exchange([...handshake, ...calls, request('alive', 'ping')], ['--input-type=module', '-e', source]);
  assert.ok(replies.slice(1, 61).every((r) => r.result.isError === false));
  assert.equal(replies[61].error.code, -32000);
  assert.match(replies[61].error.message, /rate limit/);
  assert.deepEqual(replies[62].result, {});
});
