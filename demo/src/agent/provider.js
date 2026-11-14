// The agent loop (phase 3 §5.5). A provider answers with Claude Messages API content blocks; tool_use
// blocks run through the command layer and go back as tool_result blocks until the provider answers
// with text only, or maxSteps provider calls have been made.
//
// provider.respond({ messages, tools, system? }) → Promise<{ content: [{ type: 'text', text } | { type: 'tool_use', id, name, input }] }>
// onEvent receives { type: 'user', text } | { type: 'tool_call', id, name, input }
//   | { type: 'tool_result', id, name, result, isError } | { type: 'assistant', text } | { type: 'error', message }.
import { buildSystemPrompt } from './system-prompt.js';
import { compactResult } from './compact.js';

function blocksOf(response) {
  return Array.isArray(response?.content) ? response.content : [];
}

export const TOOL_TIMEOUT_MS = 30000;
export const PROVIDER_TIMEOUT_MS = 60000;

// Resolves like `promise`, or rejects with a timeout error after `ms`; the timer never outlives it.
function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms); });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// A command that never settles (a heat job that never finishes) or a provider that never answers must
// not leave the panel busy for good: each tool call and each provider call has a time limit.
export function createAgent({ provider, commands, getState, audience = 'planner', maxSteps = 8, toolTimeoutMs = TOOL_TIMEOUT_MS, providerTimeoutMs = PROVIDER_TIMEOUT_MS }) {
  const messages = [];
  let busy = false;
  let turn = 0;   // reset() starts a new turn; an old turn still waiting ends quietly

  async function runTool(block) {
    if (!commands.list.includes(block.name)) return { error: `Unknown tool ${block.name}.` };
    try {
      return await withTimeout(commands.run(block.name, block.input ?? {}), toolTimeoutMs, block.name);
    } catch (e) {
      return { error: `${block.name} failed: ${e?.message ?? String(e)}` };
    }
  }

  async function send(text, onEvent = () => {}) {
    const emit = (event) => { try { onEvent(event); } catch { /* a listener error must not break the loop */ } };
    if (busy) {
      emit({ type: 'error', message: 'Wait for the current answer to finish.' });
      return { stop: 'busy', text: '', steps: 0 };
    }
    busy = true;
    const mine = ++turn;
    try {
      messages.push({ role: 'user', content: String(text) });
      emit({ type: 'user', text: String(text) });
      const tools = commands.toolDefinitions();
      let finalText = '';
      for (let step = 1; step <= maxSteps; step++) {
        let response;
        try {
          const system = provider.name === 'mock' ? undefined : buildSystemPrompt({ audience, state: getState?.() });
          response = await withTimeout(provider.respond({ messages: messages.slice(), tools, ...(system ? { system } : {}) }), providerTimeoutMs, 'The provider');
        } catch (e) {
          if (mine !== turn) return { stop: 'reset', text: '', steps: step };
          const message = `The provider failed: ${e?.message ?? String(e)}`;
          emit({ type: 'error', message });
          return { stop: 'error', text: finalText, steps: step };
        }
        if (mine !== turn) return { stop: 'reset', text: '', steps: step };
        const content = blocksOf(response);
        messages.push({ role: 'assistant', content });
        const said = content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n\n');
        if (said) { finalText = said; emit({ type: 'assistant', text: said }); }
        const uses = content.filter((b) => b.type === 'tool_use');
        if (uses.length === 0) return { stop: 'end_turn', text: finalText, steps: step };
        const results = [];
        for (const use of uses) {
          emit({ type: 'tool_call', id: use.id, name: use.name, input: use.input ?? {} });
          const result = await runTool(use);
          if (mine !== turn) return { stop: 'reset', text: '', steps: step };
          const isError = Boolean(result && typeof result === 'object' && 'error' in result);
          emit({ type: 'tool_result', id: use.id, name: use.name, result, isError });
          // Keep full results in the visible tool log; compact only the model's context.
          const context = provider.name === 'mock' ? result : compactResult(use.name, result);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(context ?? null), ...(isError ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
      }
      emit({ type: 'error', message: `Stopped after ${maxSteps} steps without a final answer.` });
      return { stop: 'max_steps', text: finalText, steps: maxSteps };
    } finally {
      if (mine === turn) busy = false;
    }
  }

  return {
    send,
    get messages() { return messages.slice(); },
    get busy() { return busy; },
    reset() { messages.length = 0; busy = false; turn++; },
  };
}
