// A real provider for the agent loop (phase 5, workstream T): the Claude Messages API called with the
// browser's fetch, no SDK (the project has no dependencies and opens from a double-clicked file).
// Same respond() shape as agent/mock.js: it takes Messages-API messages and tool definitions and
// redacts display content, but preserves signed thinking blocks exactly for the next tool-loop request.
//
// Request shape, headers and model id follow the official docs (checked 2026-11-13, URLs in
// docs/phase5/handoff/T.md): POST {baseUrl}/v1/messages; anthropic-version 2026-10-21; a request from a
// browser is a CORS request and needs `anthropic-dangerous-direct-browser-access: true`.
//
// createAnthropicProvider({ apiKey, model, baseUrl, fetch, timeoutMs, maxTokens, system })
//   → { name, label, model, respond({ messages, tools, system? }), test() }
// Failures reject with an Error whose message says what went wrong; the key never appears in it.

export const ANTHROPIC_VERSION = '2026-10-21';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';
export const REAL_PROVIDER_TIMEOUT_MS = 55000;   // under the agent loop's 60 s provider limit, so the request is aborted, not left running

export const AGENT_SYSTEM_PROMPT = [
  'You are the assistant inside Lunar Site Navigator, a map of the lunar south pole used to compare landing sites.',
  'Use the tools to read the page state and to change the map. Every figure you state must come from a tool result in this conversation; never estimate one.',
  'If a tool returns an error, say so plainly. Keep answers short: two to four sentences, plain text, no headings or tables.',
  'Mark assumptions (battery size, orbit, stay length) as assumed. Slopes are means over the map grid; real lander-scale slopes are steeper.',
].join(' ');

// Replaces every copy of the key in a string (an error body could echo a header back).
export function redact(text, secret) {
  let s = String(text ?? '');
  if (secret) s = s.split(secret).join('[key]');
  return s;
}

// Protocol thinking blocks are opaque signed data, never display strings. All other returned
// strings (including tool names/inputs) may be shown by the agent and need the same exit guard.
export function redactContent(content, secret) {
  const clean = (value) => {
    if (typeof value === 'string') return redact(value, secret);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k, secret), clean(v)]));
    return value;
  };
  return content.map((block) => ['thinking', 'redacted_thinking'].includes(block?.type) ? block : clean(block));
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url); }
}

// One deadline for headers AND the optional body reader/parser; existing callers may omit consume.
export async function fetchWithTimeout(fetchFn, url, init, ms, what, consume = (res) => res) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const deadline = Date.now() + ms;
  const expired = () => {
    ctl?.abort();
    return new Error(`${what} did not answer within ${Math.round(ms / 1000)} s.`);
  };
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(expired()), ms);
  });
  try {
    const operation = async () => {
      const res = await fetchFn(url, { ...init, ...(ctl ? { signal: ctl.signal } : {}) });
      if (Date.now() >= deadline) throw expired();
      try { return await consume(res); }
      finally { if (Date.now() >= deadline) throw expired(); } // synchronous parsing can delay timers
    };
    return await Promise.race([operation(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Turns a non-2xx response into a readable message: status, the API's error type and message.
export async function httpError(res, label, secret) {
  let body = '';
  try { body = await res.text(); } catch { /* no body */ }
  let type = '', message = '';
  try {
    const j = JSON.parse(body);
    type = j?.error?.type ?? j?.error?.code ?? j?.type ?? '';
    message = j?.error?.message ?? j?.message ?? (typeof j?.error === 'string' ? j.error : '');
  } catch { message = redact(body, secret).slice(0, 300); }
  const hint = res.status === 401 ? ' Check the API key.' : res.status === 429 ? ' Rate or spend limit reached; wait and try again.' : '';
  const detail = [type, message].filter(Boolean).join(': ');
  return new Error(redact(`${label} returned HTTP ${res.status}${detail ? ` (${detail})` : ''}.${hint}`, secret));
}

export function networkError(e, label, url, secret) {
  if (e?.name === 'AbortError') return new Error(redact(`${label} request was cancelled.`, secret));
  if (/did not answer within/.test(e?.message ?? '')) return new Error(redact(e.message, secret));
  return new Error(redact(`Couldn’t reach ${hostOf(url)} (${e?.message ?? 'network error'}). Check the connection and the base URL; a browser can also block a cross-origin request the provider does not allow.`, secret));
}

const STOP_PROBLEMS = {
  refusal: 'The model declined to answer this request.',
  max_tokens: 'The answer was cut off at the token limit before it finished.',
  model_context_window_exceeded: 'The conversation is too long for the model. Start a new conversation.',
  pause_turn: 'The model paused its turn, which this page does not handle.',
};

export function createAnthropicProvider({
  apiKey = '', model = '', baseUrl = '', fetch: fetchFn = globalThis.fetch?.bind(globalThis),
  timeoutMs = REAL_PROVIDER_TIMEOUT_MS, maxTokens = 16000, system = AGENT_SYSTEM_PROMPT,
} = {}) {
  const key = String(apiKey ?? '').trim();
  const useModel = String(model ?? '').trim() || ANTHROPIC_DEFAULT_MODEL;
  const base = (String(baseUrl ?? '').trim() || ANTHROPIC_DEFAULT_BASE).replace(/\/+$/, '');
  const url = `${base}/v1/messages`;
  const label = 'The Anthropic API';

  async function post(body, parse = (data) => data) {
    if (!key) throw new Error('No Anthropic API key is set. Add one in Settings → AI assistant, or switch to the scripted demo.');
    if (typeof fetchFn !== 'function') throw new Error('This browser has no fetch; the Anthropic provider cannot run here.');
    return fetchWithTimeout(async (requestUrl, init) => {
      try { return await fetchFn(requestUrl, init); }
      catch (e) { throw networkError(e, label, url, key); }
    }, url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        'x-api-key': key,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    }, timeoutMs, label, async (res) => {
      if (!res.ok) throw await httpError(res, label, key);
      let data;
      try { data = await res.json(); } catch { throw new Error(`${label} sent a response that is not JSON.`); }
      if (data?.type === 'error') throw new Error(redact(`${label} reported an error (${data.error?.type ?? 'error'}: ${data.error?.message ?? ''}).`, key));
      return parse(data);
    });
  }

  function reply(data, testing = false) {
    const problem = Object.hasOwn(STOP_PROBLEMS, data?.stop_reason) ? STOP_PROBLEMS[data.stop_reason] : null;
    if (problem) {
      const cat = data?.stop_reason === 'refusal' && data?.stop_details?.category ? ` (category: ${data.stop_details.category})` : '';
      throw new Error(`${problem}${cat}`);
    }
    const content = Array.isArray(data?.content) ? data.content : [];
    const text = content.filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim());
    const tools = content.filter((b) => b?.type === 'tool_use');
    if (!text.length && !tools.length) throw new Error(`${label} returned an empty answer.`);
    if (!['end_turn', 'stop_sequence', 'tool_use'].includes(data?.stop_reason)
      || (data.model !== undefined && (typeof data.model !== 'string' || !data.model.trim()))
      || content.some((b) => !['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(b?.type) || (b.type === 'text' && typeof b.text !== 'string'))
      || (data.stop_reason === 'tool_use') !== Boolean(tools.length)
      || tools.some((b) => typeof b.id !== 'string' || !b.id || typeof b.name !== 'string' || !b.name || !b.input || typeof b.input !== 'object' || Array.isArray(b.input))
      || (testing && (!text.length || tools.length))) throw new Error(`${label} returned an invalid or unfinished answer.`);
    return { content: redactContent(content, key), stop_reason: data.stop_reason, usage: data.usage };
  }

  return {
    name: 'anthropic',
    label: redact(`Anthropic · ${useModel}`, key),
    model: redact(useModel, key),
    async respond({ messages, tools, system: requestSystem = system } = {}) {
      try {
        const body = { model: useModel, max_tokens: maxTokens, messages: messages ?? [] };
        if (requestSystem) body.system = requestSystem;
        if (Array.isArray(tools) && tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
        return await post(body, reply);
      } catch (e) { throw new Error(redact(e?.message ?? String(e), key)); }
    },
    // One small request without tools: proves the key, the model id and that the browser may call the API.
    async test() {
      const t0 = Date.now();
      try {
        const result = await post({ model: useModel, max_tokens: 256, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }, (data) => {
          const text = reply(data, true).content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ').trim();
          return { model: redact(data.model ?? useModel, key), text: redact(text, key).slice(0, 80) };
        });
        return { ok: true, ...result, ms: Date.now() - t0 };
      } catch (e) {
        return { ok: false, error: redact(e?.message ?? String(e), key), ms: Date.now() - t0 };
      }
    },
  };
}
