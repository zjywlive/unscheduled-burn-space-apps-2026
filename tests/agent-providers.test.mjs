// The two real providers against a fake fetch (no real key exists for this project and none is used):
// request shape, the tool_use round trip through the agent loop, error paths and the timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from '../demo/src/agent/provider.js';
import { createAnthropicProvider, ANTHROPIC_VERSION, ANTHROPIC_DEFAULT_MODEL, AGENT_SYSTEM_PROMPT, redact } from '../demo/src/agent/anthropic.js';
import { createOpenAICompatProvider, toChatMessages, toChatTools, fromChatMessage } from '../demo/src/agent/openai-compat.js';

const KEY = 'sk-ant-api03-FAKE-TEST-KEY-0123456789abcdef';
const TOOLS = [{ name: 'get_state', description: 'Read the page state.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'set_map_mode', description: 'Set the map mode.', input_schema: { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'] } }];

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
function fakeFetch(replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    return typeof r === 'function' ? r(url, init) : r;
  };
  fn.calls = calls;
  return fn;
}
function fakeCommands() {
  const ran = [];
  return {
    ran,
    list: TOOLS.map((t) => t.name),
    toolDefinitions: () => structuredClone(TOOLS),
    run: async (name, input) => { ran.push([name, input]); return name === 'get_state' ? { mapMode: 'both', site: { name: 'Shackleton ridge' } } : { mode: input.mode }; },
  };
}

// ---------------- Anthropic ----------------
test('anthropic: request shape follows the Messages API docs', async () => {
  const fetch = fakeFetch([json(200, { type: 'message', model: ANTHROPIC_DEFAULT_MODEL, content: [{ type: 'text', text: 'Hello.' }], stop_reason: 'end_turn' })]);
  const p = createAnthropicProvider({ apiKey: ` ${KEY} `, fetch });
  const r = await p.respond({ messages: [{ role: 'user', content: 'Hi' }], tools: TOOLS });
  assert.deepEqual(r.content, [{ type: 'text', text: 'Hello.' }]);
  const { url, init, body } = fetch.calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(ANTHROPIC_VERSION, '2026-10-21');
  assert.equal(init.headers['x-api-key'], KEY, 'trimmed');
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.ok(init.signal, 'abortable');
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.max_tokens, 16000);
  assert.equal(body.system, AGENT_SYSTEM_PROMPT);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Hi' }]);
  assert.deepEqual(body.tools, TOOLS);
  for (const k of ['temperature', 'top_p', 'top_k', 'tool_choice', 'thinking']) assert.ok(!(k in body), `${k} is not sent`);
  assert.equal(p.label, 'Anthropic · claude-opus-5-5');
});

test('anthropic: model and base URL from settings', async () => {
  const fetch = fakeFetch([json(200, { content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' })]);
  await createAnthropicProvider({ apiKey: KEY, model: 'claude-sonnet-5-5', baseUrl: 'https://proxy.example.com/', fetch }).respond({ messages: [] });
  assert.equal(fetch.calls[0].url, 'https://proxy.example.com/v1/messages');
  assert.equal(fetch.calls[0].body.model, 'claude-sonnet-5-5');
});

test('anthropic: a tool_use round trip through the agent loop, thinking blocks passed back unchanged', async () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig-abc' };
  const fetch = fakeFetch([
    json(200, { content: [thinking, { type: 'tool_use', id: 'toolu_01', name: 'get_state', input: {} }], stop_reason: 'tool_use' }),
    json(200, { content: [{ type: 'tool_use', id: 'toolu_02', name: 'set_map_mode', input: { mode: 'sun' } }], stop_reason: 'tool_use' }),
    json(200, { content: [{ type: 'text', text: 'The map now shows Sunlit mode.' }], stop_reason: 'end_turn' }),
  ]);
  const commands = fakeCommands();
  const agent = createAgent({ provider: createAnthropicProvider({ apiKey: KEY, fetch }), commands });
  const events = [];
  const r = await agent.send('Show sunlit ground', (e) => events.push(e.type));
  assert.equal(r.stop, 'end_turn');
  assert.equal(r.text, 'The map now shows Sunlit mode.');
  assert.deepEqual(commands.ran, [['get_state', {}], ['set_map_mode', { mode: 'sun' }]]);
  const second = fetch.calls[1].body.messages;
  assert.deepEqual(second[1], { role: 'assistant', content: [thinking, { type: 'tool_use', id: 'toolu_01', name: 'get_state', input: {} }] });
  assert.equal(second[2].role, 'user');
  assert.equal(second[2].content[0].type, 'tool_result');
  assert.equal(second[2].content[0].tool_use_id, 'toolu_01');
  assert.deepEqual(JSON.parse(second[2].content[0].content), { mapMode: 'both', site: { name: 'Shackleton ridge' } });
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(events, ['user', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'assistant']);
});

test('anthropic: no key fails clearly without a request', async () => {
  const fetch = fakeFetch([json(200, {})]);
  await assert.rejects(createAnthropicProvider({ fetch }).respond({ messages: [] }), /No Anthropic API key/);
  assert.equal(fetch.calls.length, 0);
});

test('anthropic: HTTP errors carry status, type and message, never the key', async () => {
  const fetch = fakeFetch([json(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` }, request_id: 'req_1' })]);
  const err = await createAnthropicProvider({ apiKey: KEY, fetch }).respond({ messages: [] }).catch((e) => e);
  assert.match(err.message, /HTTP 401/);
  assert.match(err.message, /authentication_error/);
  assert.match(err.message, /Check the API key/);
  assert.ok(!err.message.includes(KEY));
  const cors = fakeFetch([json(401, { type: 'error', error: { type: 'authentication_error', message: 'CORS requests are not allowed for this Organization because of its settings.' } })]);
  const e2 = await createAnthropicProvider({ apiKey: KEY, fetch: cors }).respond({ messages: [] }).catch((e) => e);
  assert.match(e2.message, /CORS requests are not allowed/);
  const e3 = await createAnthropicProvider({ apiKey: KEY, fetch: fakeFetch([{ ok: false, status: 529, text: async () => 'Overloaded' }]) }).respond({ messages: [] }).catch((e) => e);
  assert.match(e3.message, /HTTP 529 \(Overloaded\)/);
});

test('anthropic: network failure, bad JSON, refusal and truncation are errors, not answers', async () => {
  const net = fakeFetch([() => { throw new TypeError('Failed to fetch'); }]);
  await assert.rejects(createAnthropicProvider({ apiKey: KEY, fetch: net }).respond({ messages: [] }), /Couldn’t reach api\.anthropic\.com \(Failed to fetch\)/);
  const bad = fakeFetch([{ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }]);
  await assert.rejects(createAnthropicProvider({ apiKey: KEY, fetch: bad }).respond({ messages: [] }), /not JSON/);
  const refusal = fakeFetch([json(200, { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } })]);
  await assert.rejects(createAnthropicProvider({ apiKey: KEY, fetch: refusal }).respond({ messages: [] }), /declined.*category: cyber/);
  const cut = fakeFetch([json(200, { content: [{ type: 'text', text: 'Partial' }], stop_reason: 'max_tokens' })]);
  await assert.rejects(createAnthropicProvider({ apiKey: KEY, fetch: cut }).respond({ messages: [] }), /cut off/);
  const empty = fakeFetch([json(200, { content: [], stop_reason: 'end_turn' })]);
  await assert.rejects(createAnthropicProvider({ apiKey: KEY, fetch: empty }).respond({ messages: [] }), /empty answer/);
});

test('anthropic: a request that never answers is aborted after timeoutMs', async () => {
  let signal = null;
  const hang = async (url, init) => { signal = init.signal; return new Promise(() => {}); };
  const t0 = Date.now();
  await assert.rejects(createAnthropicProvider({ apiKey: KEY, fetch: hang, timeoutMs: 40 }).respond({ messages: [] }), /did not answer within 0 s/);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(signal.aborted, true, 'the fetch itself is aborted');
});

test('anthropic: test() reports success or the failure, never the key', async () => {
  const ok = fakeFetch([json(200, { model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'OK' }], stop_reason: 'end_turn' })]);
  const r = await createAnthropicProvider({ apiKey: KEY, fetch: ok }).test();
  assert.equal(r.ok, true);
  assert.equal(r.text, 'OK');
  assert.equal(r.model, 'claude-opus-5-5');
  assert.equal(ok.calls[0].body.max_tokens, 256);
  assert.ok(!('tools' in ok.calls[0].body));
  const fail = await createAnthropicProvider({ apiKey: KEY, fetch: fakeFetch([json(403, { error: { type: 'permission_error', message: `key ${KEY} lacks access` } })]) }).test();
  assert.equal(fail.ok, false);
  assert.match(fail.error, /HTTP 403/);
  assert.ok(!fail.error.includes(KEY));
});

test('the agent loop shows a failing real provider as an error and does not fall back to the script', async () => {
  const fetch = fakeFetch([json(500, { type: 'error', error: { type: 'api_error', message: 'Internal' } })]);
  const commands = fakeCommands();
  const agent = createAgent({ provider: createAnthropicProvider({ apiKey: KEY, fetch }), commands });
  const errors = [];
  const r = await agent.send('Compare region A and region B', (e) => { if (e.type === 'error') errors.push(e.message); });
  assert.equal(r.stop, 'error');
  assert.equal(r.text, '');
  assert.equal(commands.ran.length, 0);
  assert.match(errors[0], /^The provider failed: The Anthropic API returned HTTP 500 \(api_error: Internal\)/);
});

test('redact replaces every copy of the key', () => {
  assert.equal(redact(`a ${KEY} b ${KEY}`, KEY), 'a [key] b [key]');
  assert.equal(redact('abc', ''), 'abc');
});

// ---------------- OpenAI-compatible ----------------
test('openai-compat: messages convert to Chat Completions and back', () => {
  const msgs = [
    { role: 'user', content: 'Show sunlit ground' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'call_a', name: 'set_map_mode', input: { mode: 'sun' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: '{"mode":"sun"}' }, { type: 'tool_result', tool_use_id: 'call_b', content: 'Unknown', is_error: true }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  ];
  assert.deepEqual(toChatMessages(msgs, 'SYS'), [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'Show sunlit ground' },
    { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'set_map_mode', arguments: '{"mode":"sun"}' } }] },
    { role: 'tool', tool_call_id: 'call_a', content: '{"mode":"sun"}' },
    { role: 'tool', tool_call_id: 'call_b', content: 'Error: Unknown' },
    { role: 'assistant', content: 'Done.' },
  ]);
  assert.deepEqual(toChatTools(TOOLS.slice(1)), [{ type: 'function', function: { name: 'set_map_mode', description: 'Set the map mode.', parameters: TOOLS[1].input_schema } }]);
  assert.deepEqual(fromChatMessage({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_state', arguments: '{}' } }, { type: 'function', function: { name: 'set_map_mode', arguments: '{"mode":"earth"}' } }] }, 'call_7'), [
    { type: 'tool_use', id: 'c1', name: 'get_state', input: {} },
    { type: 'tool_use', id: 'call_7_2', name: 'set_map_mode', input: { mode: 'earth' } },
  ]);
  assert.deepEqual(fromChatMessage({ content: 'Hello' }), [{ type: 'text', text: 'Hello' }]);
  assert.throws(() => fromChatMessage({ tool_calls: [{ id: 'x', function: { name: 'get_state', arguments: '{bad' } }] }), /not valid JSON/);
  assert.throws(() => fromChatMessage({ tool_calls: [{ id: 'x', function: { name: 'get_state', arguments: '[1]' } }] }), /not an object/);
});

test('openai-compat: request shape and the tool round trip through the agent loop', async () => {
  const fetch = fakeFetch([
    json(200, { model: 'm', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'set_map_mode', arguments: '{"mode":"earth"}' } }] } }] }),
    json(200, { model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Earth mode is on.' } }] }),
  ]);
  const commands = fakeCommands();
  const agent = createAgent({ provider: createOpenAICompatProvider({ apiKey: 'sk-FAKE-oa', model: 'm', baseUrl: 'https://llm.example.com/v1/', fetch }), commands });
  const r = await agent.send('Earth please');
  assert.equal(r.text, 'Earth mode is on.');
  assert.deepEqual(commands.ran, [['set_map_mode', { mode: 'earth' }]]);
  const first = fetch.calls[0];
  assert.equal(first.url, 'https://llm.example.com/v1/chat/completions');
  assert.equal(first.init.headers.authorization, 'Bearer sk-FAKE-oa');
  assert.equal(first.body.model, 'm');
  assert.equal(first.body.messages[0].role, 'system');
  assert.equal(first.body.tools[0].type, 'function');
  assert.equal(first.body.tools.length, 2);
  const second = fetch.calls[1].body.messages;
  assert.deepEqual(second.slice(2), [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'set_map_mode', arguments: '{"mode":"earth"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"mode":"earth"}' },
  ]);
});

test('openai-compat: missing model, cut-off, filter, refusal, HTTP and network errors are clear', async () => {
  await assert.rejects(createOpenAICompatProvider({ fetch: fakeFetch([json(200, {})]) }).respond({ messages: [] }), /No model is set/);
  const mk = (reply) => createOpenAICompatProvider({ apiKey: 'sk-FAKE-oa', model: 'm', fetch: fakeFetch([reply]) }).respond({ messages: [{ role: 'user', content: 'q' }] });
  await assert.rejects(mk(json(200, { choices: [{ finish_reason: 'length', message: { content: 'par' } }] })), /cut off/);
  await assert.rejects(mk(json(200, { choices: [{ finish_reason: 'content_filter', message: { content: '' } }] })), /content filter/);
  await assert.rejects(mk(json(200, { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'No.' } }] })), /declined/);
  await assert.rejects(mk(json(200, { choices: [] })), /no choices/);
  const e = await mk(json(401, { error: { message: 'Incorrect API key provided: sk-FAKE-oa', type: 'invalid_request_error', code: 'invalid_api_key' } })).catch((x) => x);
  assert.match(e.message, /HTTP 401/);
  assert.ok(!e.message.includes('sk-FAKE-oa'));
  await assert.rejects(mk(() => { throw new TypeError('Failed to fetch'); }), /Couldn’t reach api\.openai\.com/);
  const hang = createOpenAICompatProvider({ model: 'm', fetch: () => new Promise(() => {}), timeoutMs: 30 });
  await assert.rejects(hang.respond({ messages: [] }), /did not answer within/);
  const t = await createOpenAICompatProvider({ model: 'm', fetch: fakeFetch([json(200, { model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] })]) }).test();
  assert.deepEqual([t.ok, t.text], [true, 'OK']);
});

test('H2: refusal categories, refusal text and bad-argument tool names never leak the key', async () => {
  for (const [factory, body] of [
    [createOpenAICompatProvider, { choices: [{ finish_reason: 'stop', message: { refusal: KEY } }] }],
    [createOpenAICompatProvider, { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: KEY, arguments: '{' } }] } }] }],
    [createAnthropicProvider, { stop_reason: 'refusal', stop_details: { category: KEY }, content: [] }],
  ]) {
    await assert.rejects(factory({ apiKey: KEY, model: 'm', fetch: fakeFetch([json(200, body)]) }).respond({ messages: [] }),
      (e) => e instanceof Error && !e.message.includes(KEY) && e.message.includes('[key]'));
  }
});

test('H2: successful Test text/model and provider labels redact before truncating', async () => {
  for (const factory of [createAnthropicProvider, createOpenAICompatProvider]) {
    const text = `${'x'.repeat(75)}${KEY}`;
    const body = factory === createAnthropicProvider
      ? { model: KEY, content: [{ type: 'text', text }], stop_reason: 'end_turn' }
      : { model: KEY, choices: [{ finish_reason: 'stop', message: { content: text } }] };
    const p = factory({ apiKey: KEY, model: KEY, fetch: fakeFetch([json(200, body)]) });
    const result = await p.test();
    assert.equal(result.ok, true);
    assert.equal(result.model, '[key]');
    assert.equal(result.text, `${'x'.repeat(75)}[key]`);
    assert.ok(!p.label.includes(KEY));
    assert.equal(p.model, '[key]');
  }
});

test('H2: HTTP/refusal truncation cannot expose a key prefix and short keys are redacted', async () => {
  assert.equal(redact('a abc abc', 'abc'), 'a [key] [key]');
  for (const factory of [createAnthropicProvider, createOpenAICompatProvider]) {
    const p = factory({ apiKey: KEY, model: 'm', fetch: fakeFetch([{ ok: false, status: 500, text: async () => `${'x'.repeat(295)}${KEY}` }]) });
    await assert.rejects(p.respond({ messages: [] }), (e) => e.message.includes('[key]') && !e.message.includes(KEY.slice(0, 5)));
  }
  const p = createOpenAICompatProvider({ apiKey: KEY, model: 'm', fetch: fakeFetch([json(200, { choices: [{ finish_reason: 'stop', message: { refusal: `${'x'.repeat(195)}${KEY}` } }] })]) });
  await assert.rejects(p.respond({ messages: [] }), (e) => e.message.includes('[key]') && !e.message.includes(KEY.slice(0, 5)));
});

test('H2: assistant display strings are redacted but signed thinking blocks stay verbatim', async () => {
  const thinking = { type: 'thinking', thinking: KEY, signature: KEY };
  const hidden = { type: 'redacted_thinking', data: KEY };
  const content = [thinking, hidden, { type: 'text', text: KEY }, { type: 'tool_use', id: 'c', name: 'get_state', input: { note: KEY } }];
  const p = createAnthropicProvider({ apiKey: KEY, fetch: fakeFetch([json(200, { content, stop_reason: 'tool_use' })]) });
  const r = await p.respond({ messages: [] });
  assert.deepEqual(r.content.slice(0, 2), [thinking, hidden]);
  assert.equal(r.content[2].text, '[key]');
  assert.equal(r.content[3].input.note, '[key]');
  const o = createOpenAICompatProvider({ apiKey: KEY, model: 'm', fetch: fakeFetch([json(200, { choices: [{ finish_reason: 'stop', message: { content: KEY } }] })]) });
  assert.equal((await o.respond({ messages: [] })).content[0].text, '[key]');
});

for (const factory of [createAnthropicProvider, createOpenAICompatProvider]) {
  const name = factory === createAnthropicProvider ? 'anthropic' : 'openai-compat';
  test(`M1: ${name} aborts hanging success/error bodies under the same deadline`, async () => {
    for (const ok of [true, false]) {
      let signal;
      const fetch = async (_, init) => {
        signal = init.signal;
        return { ok, status: 500, json: () => new Promise(() => {}), text: () => new Promise(() => {}) };
      };
      const p = factory({ apiKey: KEY, model: 'm', fetch, timeoutMs: 20 });
      let watchdog;
      try {
        const r = await Promise.race([p.test(), new Promise((resolve) => { watchdog = setTimeout(() => resolve('still pending after 100ms'), 100); })]);
        assert.notEqual(r, 'still pending after 100ms');
        assert.equal(r.ok, false);
        assert.match(r.error, /did not answer within/);
        assert.equal(signal.aborted, true);
      } finally { clearTimeout(watchdog); }
    }
  });

  test(`M1: ${name} includes fetch and synchronous JSON parsing in its deadline`, async () => {
    let signal;
    const fetch = async (_, init) => {
      signal = init.signal;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, json() {
        const until = performance.now() + 30;
        while (performance.now() < until) { /* emulate parsing a large body */ }
        return { model: 'm', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] };
      } };
    };
    const r = await factory({ apiKey: KEY, model: 'm', fetch, timeoutMs: 25 }).test();
    assert.equal(r.ok, false);
    assert.match(r.error, /did not answer within/);
    assert.equal(signal.aborted, true);
  });

  test(`M2: ${name} Test rejects empty, refused, truncated and malformed replies`, async () => {
    const bodies = name === 'anthropic' ? [
      {}, { content: [], stop_reason: 'end_turn' },
      ...['refusal', 'max_tokens', 'pause_turn', 'model_context_window_exceeded', 'unknown', undefined].map((stop_reason) => ({ content: [{ type: 'text', text: 'OK' }], stop_reason })),
      { content: [{ type: 'text', text: '   ' }], stop_reason: 'end_turn' },
      { content: [{ type: 'thinking', thinking: 'hidden', signature: 's' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'OK' }], stop_reason: 'tool_use' },
    ] : [
      {}, { choices: [] },
      ...['length', 'content_filter', 'tool_calls', 'unknown', undefined].map((finish_reason) => ({ choices: [{ finish_reason, message: { content: 'OK' } }] })),
      { choices: [{ finish_reason: 'stop', message: { content: 'OK', refusal: 'No' } }] },
      { choices: [{ finish_reason: 'stop', message: { content: '   ' } }] },
      { choices: [{ finish_reason: 'stop', message: { content: 42 } }] },
    ];
    for (const body of bodies) {
      const r = await factory({ apiKey: KEY, model: 'm', fetch: fakeFetch([json(200, body)]) }).test();
      assert.equal(r.ok, false, JSON.stringify(body));
      assert.equal(typeof r.error, 'string');
    }
  });
}

test('M5: tool arguments must be a JSON string containing a non-array object', async () => {
  for (const args of ['', '   ', undefined, 42, {}, [], null, true, 'null', '42', '[]', '"text"', '{bad']) {
    const message = { tool_calls: [{ id: 'c', function: { name: 'get_state', arguments: args } }] };
    assert.throws(() => fromChatMessage(message), /arguments/);
    const commands = fakeCommands();
    const provider = createOpenAICompatProvider({ apiKey: KEY, model: 'm', fetch: fakeFetch([json(200, { choices: [{ finish_reason: 'tool_calls', message }] })]) });
    const result = await createAgent({ provider, commands }).send('Read state');
    assert.equal(result.stop, 'error');
    assert.deepEqual(commands.ran, []);
  }
  assert.deepEqual(fromChatMessage({ tool_calls: [{ id: 'c', function: { name: 'get_state', arguments: '{}' } }] })[0].input, {});
});

test('system: per-turn instructions follow each API protocol and omitted values preserve defaults', async () => {
  for (const factory of [createAnthropicProvider, createOpenAICompatProvider]) {
    const anthropic = factory === createAnthropicProvider;
    const fetch = fakeFetch([json(200, anthropic ? { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }
      : { choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] })]);
    const p = factory({ apiKey: KEY, model: 'm', system: 'Factory default', fetch });
    const messages = [{ role: 'user', content: 'Hi' }];
    for (const system of ['Turn context', '', undefined]) {
      await p.respond({ messages, tools: TOOLS, ...(system === undefined ? {} : { system }) });
      const body = fetch.calls.at(-1).body;
      const expected = system ?? 'Factory default';
      if (anthropic) {
        assert.equal(body.system, expected || undefined);
        assert.deepEqual(body.messages, messages);
      } else {
        assert.deepEqual(body.messages, expected ? [{ role: 'system', content: expected }, ...messages] : messages);
      }
    }
    assert.deepEqual(messages, [{ role: 'user', content: 'Hi' }]);
  }
});

test('M2: malformed content/model fields and refusal blocks cannot pass Test alongside text', async () => {
  for (const [factory, bodies] of [
    [createAnthropicProvider, [
      { content: [{ type: 'text', text: 'OK' }, { type: 'text', text: 42 }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'OK' }, { type: 'refusal', refusal: 'No' }], stop_reason: 'end_turn' },
      { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', model: {} },
    ]],
    [createOpenAICompatProvider, [
      { choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: 42 }] } }] },
      { choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: 'OK' }, { type: 'refusal', refusal: 'No' }] } }] },
      { choices: [{ finish_reason: 'stop', message: { content: 'OK' } }], model: {} },
    ]],
  ]) {
    for (const body of bodies) {
      const r = await factory({ apiKey: KEY, model: 'm', fetch: fakeFetch([json(200, body)]) }).test();
      assert.equal(r.ok, false, JSON.stringify(body));
    }
  }
});
