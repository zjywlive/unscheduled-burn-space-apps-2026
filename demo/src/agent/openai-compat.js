// A real provider for any server that speaks the OpenAI Chat Completions format (phase 5, workstream T),
// called with the browser's fetch, no SDK. The agent loop works in Claude Messages API shapes, so this
// module converts both ways:
//   messages → chat messages: a user string stays a user message; tool_result blocks become one
//     { role: 'tool', tool_call_id, content } message each; an assistant turn's text joins into content
//     and its tool_use blocks become tool_calls [{ id, type: 'function', function: { name, arguments } }]
//     with the input JSON-encoded; thinking blocks (Claude only) are dropped.
//   tools → [{ type: 'function', function: { name, description, parameters } }]
//   choices[0].message → content blocks: text → { type: 'text' }, each tool call → { type: 'tool_use',
//     id, name, input } with the arguments string parsed.
// Shapes follow the official Chat Completions reference (checked 2026-11-13, URL in docs/phase5/handoff/T.md).
//
// createOpenAICompatProvider({ apiKey, model, baseUrl, fetch, timeoutMs, system })
//   → { name, label, model, respond({ messages, tools, system? }), test() }
import { AGENT_SYSTEM_PROMPT, REAL_PROVIDER_TIMEOUT_MS, fetchWithTimeout, httpError, networkError, redact, redactContent } from './anthropic.js';

export const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');

export function toChatMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages ?? []) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') { out.push({ role: 'user', content: m.content }); continue; }
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b?.type !== 'tool_result') continue;
        const body = typeof b.content === 'string' ? b.content : textOf(b.content) || JSON.stringify(b.content ?? null);
        out.push({ role: 'tool', tool_call_id: String(b.tool_use_id), content: b.is_error ? `Error: ${body}` : body });
      }
      const text = textOf(blocks);
      if (text) out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? []);
      const text = textOf(blocks);
      const calls = blocks.filter((b) => b?.type === 'tool_use').map((b) => ({
        id: String(b.id), type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      if (msg.content !== null || calls.length) out.push(msg);
    }
  }
  return out;
}

export function toChatTools(tools) {
  return (tools ?? []).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

// One choice's message → content blocks. Throws when a tool call's arguments are not a JSON object.
export function fromChatMessage(message, idPrefix = 'call') {
  const blocks = [];
  if (Array.isArray(message?.content) && message.content.some((p) => p?.type !== 'text' || typeof p.text !== 'string')) {
    throw new Error('The model returned invalid or refused content.');
  }
  const text = typeof message?.content === 'string' ? message.content
    : Array.isArray(message?.content) ? message.content.map((p) => p?.text ?? '').join('') : '';
  if (text.trim()) blocks.push({ type: 'text', text });
  (message?.tool_calls ?? []).forEach((c, i) => {
    const name = c?.function?.name;
    if (!name) throw new Error('The model returned a tool call without a name.');
    let input;
    const args = c.function.arguments;
    if (typeof args !== 'string') throw new Error(`The model returned arguments for ${name} that are not a JSON string.`);
    try { input = JSON.parse(args); } catch { throw new Error(`The model returned arguments for ${name} that are not valid JSON.`); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`The model returned arguments for ${name} that are not an object.`);
    blocks.push({ type: 'tool_use', id: c.id ? String(c.id) : `${idPrefix}_${i + 1}`, name, input });
  });
  return blocks;
}

export function createOpenAICompatProvider({
  apiKey = '', model = '', baseUrl = '', fetch: fetchFn = globalThis.fetch?.bind(globalThis),
  timeoutMs = REAL_PROVIDER_TIMEOUT_MS, system = AGENT_SYSTEM_PROMPT,
} = {}) {
  const key = String(apiKey ?? '').trim();
  const useModel = String(model ?? '').trim();
  const base = (String(baseUrl ?? '').trim() || OPENAI_DEFAULT_BASE).replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const label = 'The OpenAI-compatible server';
  let calls = 0;

  async function post(body, parse = (data) => data) {
    if (!useModel) throw new Error('No model is set for the OpenAI-compatible provider. Enter the model id your server lists in Settings → AI assistant.');
    if (typeof fetchFn !== 'function') throw new Error('This browser has no fetch; the OpenAI-compatible provider cannot run here.');
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;   // a local server may need no key
    return fetchWithTimeout(async (requestUrl, init) => {
      try { return await fetchFn(requestUrl, init); }
      catch (e) { throw networkError(e, label, url, key); }
    }, url, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs, label, async (res) => {
      if (!res.ok) throw await httpError(res, label, key);
      let data;
      try { data = await res.json(); } catch { throw new Error(`${label} sent a response that is not JSON.`); }
      if (data?.error) throw new Error(redact(`${label} reported an error (${data.error.message ?? data.error.type ?? 'error'}).`, key));
      return parse(data);
    });
  }

  function reply(data, testing = false) {
    const choice = data?.choices?.[0];
    if (!choice) throw new Error(`${label} returned no choices.`);
    if (choice.message?.refusal) throw new Error(`The model declined to answer: ${redact(choice.message.refusal, key).slice(0, 200)}`);
    if (choice.finish_reason === 'length') throw new Error('The answer was cut off at the token limit before it finished.');
    if (choice.finish_reason === 'content_filter') throw new Error('The provider’s content filter stopped the answer.');
    const content = fromChatMessage(choice.message, `call_${++calls}`);
    if (!content.length) throw new Error(`${label} returned an empty answer.`);
    const hasTools = content.some((b) => b.type === 'tool_use');
    if (!['stop', 'tool_calls'].includes(choice.finish_reason)
      || (data.model !== undefined && (typeof data.model !== 'string' || !data.model.trim()))
      || (choice.finish_reason === 'tool_calls') !== hasTools
      || (testing && hasTools)) throw new Error(`${label} returned an invalid or unfinished answer.`);
    return { content: redactContent(content, key), stop_reason: choice.finish_reason, usage: data.usage };
  }

  return {
    name: 'openai-compat',
    label: redact(`OpenAI-compatible · ${useModel || 'no model set'}`, key),
    model: redact(useModel, key),
    async respond({ messages, tools, system: requestSystem = system } = {}) {
      try {
        const body = { model: useModel, messages: toChatMessages(messages, requestSystem) };
        if (Array.isArray(tools) && tools.length) body.tools = toChatTools(tools);
        return await post(body, reply);
      } catch (e) { throw new Error(redact(e?.message ?? String(e), key)); }
    },
    async test() {
      const t0 = Date.now();
      try {
        const result = await post({ model: useModel, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }, (data) => {
          const text = textOf(reply(data, true).content).trim();
          return { model: redact(data.model ?? useModel, key), text: redact(text, key).slice(0, 80) };
        });
        return { ok: true, ...result, ms: Date.now() - t0 };
      } catch (e) {
        return { ok: false, error: redact(e?.message ?? String(e), key), ms: Date.now() - t0 };
      }
    },
  };
}
