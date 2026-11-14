// Integration boundary: settings → provider → agent context, with real compute results and fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettings, createProviderFromSettings, providerChanged } from '../demo/src/settings.js';
import { createMockProvider } from '../demo/src/agent/mock.js';
import { createAgent } from '../demo/src/agent/provider.js';
import { buildSystemPrompt } from '../demo/src/agent/system-prompt.js';
import { compactResult } from '../demo/src/agent/compact.js';
import { createCoreTools } from '../demo/src/tools-core.js';
import { loadCoreContext } from '../tools/core-context.mjs';

const ctx = loadCoreContext();
const core = createCoreTools(ctx);
const input = { places: ['shackleton', 'im2', 'haworth'].map((site_id) => ({ site_id })), landings: ['2027-01-13', '2027-01-27'], stay_days: 14 };
const state = { site: ctx.sites.find((s) => s.id === 'im2'), landingMs: Date.UTC(2027, 0, 13), cursorMs: Date.UTC(2027, 0, 18, 6), stayDays: 14, windowOn: false };

for (const id of ['anthropic', 'openai-compat']) test(`M4: ${id} receives current planner context and compact evidence through settings`, async () => {
  const settings = createSettings({ storage: null });
  settings.set({ 'ai.provider': id, 'ai.model': 'test-model' });
  settings.set('ai.key', 'FAKE-INTEGRATION-KEY');
  const requests = [];
  const fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const first = requests.length === 1;
    const use = { type: 'tool_use', id: 'compare-1', name: 'compare_scenarios', input };
    const body = id === 'anthropic'
      ? { content: first ? [use] : [{ type: 'text', text: 'Done.' }], stop_reason: first ? 'tool_use' : 'end_turn' }
      : { choices: [{ finish_reason: first ? 'tool_calls' : 'stop', message: first
        ? { role: 'assistant', content: null, tool_calls: [{ id: use.id, type: 'function', function: { name: use.name, arguments: JSON.stringify(input) } }] }
        : { role: 'assistant', content: 'Done.' } }] };
    return { ok: true, status: 200, json: async () => body };
  };
  const provider = createProviderFromSettings(settings, { scripted: createMockProvider, fetch });
  const events = [];
  const agent = createAgent({ provider, commands: core, getState: () => state });
  assert.equal((await agent.send('Compare these scenarios.', (e) => events.push(e))).stop, 'end_turn');
  const prompt = id === 'anthropic' ? requests[0].system : requests[0].messages[0].content;
  assert.equal(prompt, buildSystemPrompt({ state }));
  assert.match(prompt, /Audience: planner/);
  const raw = await core.run('compare_scenarios', input);
  assert.deepEqual(events.find((e) => e.type === 'tool_result').result, raw, 'visible tool log stays complete');
  const packed = id === 'anthropic' ? requests[1].messages.at(-1).content[0].content : requests[1].messages.at(-1).content;
  assert.deepEqual(JSON.parse(packed), compactResult('compare_scenarios', raw));
  assert.ok(packed.length < JSON.stringify(raw).length);
});

test('M4: scripted context stays uncompressed and has no system prompt', async () => {
  const raw = await core.run('compare_scenarios', input);
  const seen = [];
  const provider = { name: 'mock', respond: async (req) => {
    seen.push(req);
    return { content: seen.length === 1 ? [{ type: 'tool_use', id: 'a', name: 'compare_scenarios', input }] : [{ type: 'text', text: 'Done.' }] };
  } };
  await createAgent({ provider, commands: core, getState: () => state }).send('Compare.');
  assert.ok(seen.every((r) => !('system' in r)));
  assert.equal(seen[1].messages.at(-1).content[0].content, JSON.stringify(raw));
});

test('M4: switching providers resets an in-flight turn; missing credentials fail without fallback', async () => {
  const settings = createSettings({ storage: null });
  let release;
  let provider = { name: 'mock', respond: () => new Promise((resolve) => { release = resolve; }) };
  const agent = createAgent({ provider: { get name() { return provider.name; }, respond: (req) => provider.respond(req) }, commands: core });
  settings.subscribe((_snap, changed) => {
    if (providerChanged(changed)) { provider = createProviderFromSettings(settings, { scripted: createMockProvider }); agent.reset(); }
  });
  const old = agent.send('Old question');
  settings.set('ai.provider', 'anthropic');
  const events = [];
  assert.equal((await agent.send('New question', (e) => events.push(e))).stop, 'error');
  assert.match(events.at(-1).message, /No Anthropic API key/);
  release({ content: [{ type: 'text', text: 'Stale answer' }] });
  assert.equal((await old).stop, 'reset');
  assert.equal(agent.messages.length, 1);
  assert.equal(agent.messages[0].content, 'New question');
  assert.equal(agent.busy, false);
});
