// The Ask panel (phase 3 §4.10): a right-hand drawer with the conversation, one row per tool call
// (expandable to its result), suggested questions and an input. The conversation is rendered by the
// vendored deep-chat web component, loaded on first open with a classic <script src>.
//
// createAgentPanel(el, { agent, suggestions, vendorBase, onOpenChange }) → { open(opener?), close(), toggle(opener?), isOpen(), ask(text), ready }
//   el           an empty element the panel is built into (the integrator places it, e.g. at the end of <body>)
//   agent        createAgent(...) from agent/provider.js
//   suggestions  question strings shown as buttons
//   vendorBase   folder holding deepChat.bundle.js, default 'vendor/'
//   onOpenChange called with true / false when the drawer opens or closes
import { h, clear } from './dom.js';
import { loadScript } from '../agent/vendor.js';

const NOTE = 'Scripted demo. No model is connected.';
const EMPTY_HINT = 'Type a question or pick a suggestion.';
const INTRO = 'Ask about landing ground, regions, slips, the best cells, a rover route, the relay link or energy. Each step the assistant takes is listed, and you can open it to see the result.';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function argsText(input) {
  const entries = Object.entries(input ?? {});
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
}

// One tool call: name and arguments on the summary line, the result inside.
export function toolRowHtml({ name, input, result, isError }) {
  const state = isError ? '<span class="lsn-tool-state lsn-tool-error">Error</span>' : '';
  return `<details class="lsn-tool"><summary><span class="lsn-tool-name">${escapeHtml(name)}</span>`
    + `<span class="lsn-tool-args">${escapeHtml(argsText(input))}</span>${state}</summary>`
    + `<div class="lsn-tool-result">${escapeHtml(JSON.stringify(result, null, 2))}</div></details>`;
}

// Styles inside deep-chat's shadow root. Only the project's tokens: they inherit through the shadow boundary.
const SHADOW_CSS = `
:host { color-scheme: dark; }
#container, #chat-view, #messages { background: var(--surface); }
* { font-family: var(--font); scrollbar-color: var(--control) transparent; scrollbar-width: thin; }
.outer-message-container { margin: 0; }
.lsn-tool { color: var(--muted); font-size: var(--fs-small); line-height: 18px; font-variant-numeric: tabular-nums; }
.lsn-tool summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 0 8px; align-items: baseline; min-height: 36px; padding: 8px 0; box-sizing: border-box; list-style-position: outside; }
.input-button { min-width: 36px; min-height: 36px; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; }
.lsn-tool summary:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; border-radius: var(--radius-inner); }
.lsn-tool-name { color: var(--text); font-weight: 500; }
.lsn-tool-args { color: var(--faint); overflow-wrap: anywhere; }
.lsn-tool-error { color: var(--text); font-weight: 600; }
.lsn-tool-result { margin-top: 6px; padding: 8px 10px; border-radius: var(--radius-inner); background: var(--raised); color: var(--muted);
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; }
#text-input-container { background: var(--raised); border: 0; border-radius: var(--radius-card); box-shadow: none; }
#text-input { color: var(--text); caret-color: var(--text); font-size: var(--fs-body); }
#text-input:focus-visible { outline: none; }
#text-input-container:focus-within { outline: 2px solid var(--text); outline-offset: 2px; }
.text-input-placeholder { color: var(--faint); }
#input { background: var(--surface); border-top: 1px solid var(--rule-on-surface); }
.input-button svg, .input-button-svg { filter: none; }
a { color: var(--text); }
p { margin: 0; }
p + p { margin-top: 8px; }
`;

const BUBBLE = { borderRadius: 'var(--radius-card)', padding: '8px 12px', fontSize: '14px', lineHeight: '20px', maxWidth: '88%', boxShadow: 'none', marginTop: '10px' };

function configure(chat, handler) {
  chat.connect = { handler };
  chat.introMessage = { text: INTRO };
  chat.chatStyle = { width: '100%', height: '100%', border: 'none', borderRadius: '0', backgroundColor: 'var(--surface)', fontFamily: 'var(--font)', fontSize: '14px', color: 'var(--text)' };
  chat.auxiliaryStyle = SHADOW_CSS;
  chat.textInput = {
    placeholder: { text: 'Ask a question', style: { color: 'var(--faint)' } },
    styles: {
      container: { backgroundColor: 'var(--raised)', border: 'none', borderRadius: 'var(--radius-card)', boxShadow: 'none', width: '78%' },
      text: { color: 'var(--text)', padding: '8px 14px', fontSize: '14px' },
      focus: { border: 'none' },
    },
  };
  chat.inputAreaStyle = { backgroundColor: 'var(--surface)', borderTop: '1px solid var(--rule-on-surface)', padding: '10px 0' };
  chat.submitButtonStyles = {
    alwaysEnabled: true,
    submit: { container: { default: { backgroundColor: 'transparent', boxShadow: 'none' } }, svg: { styles: { default: { filter: 'brightness(0) invert(1)' } } } },
    disabled: { container: { default: { backgroundColor: 'transparent', opacity: '0.4' } } },
  };
  chat.messageStyles = {
    default: {
      shared: { bubble: { ...BUBBLE, color: 'var(--text)' } },
      user: { bubble: { backgroundColor: 'var(--raised)' } },
      ai: { bubble: { backgroundColor: 'transparent', padding: '8px 0', maxWidth: '100%' } },
      tool: { bubble: { backgroundColor: 'transparent', padding: '0', marginTop: '6px', maxWidth: '100%', width: '100%' } },
    },
    html: { tool: { bubble: { backgroundColor: 'transparent', padding: '0', marginTop: '6px', maxWidth: '100%', width: '100%' } } },
    intro: { backgroundColor: 'transparent', color: 'var(--muted)', padding: '8px 0', maxWidth: '100%', boxShadow: 'none', fontSize: '14px', lineHeight: '20px' },
    loading: { message: { styles: { bubble: { backgroundColor: 'var(--raised)', boxShadow: 'none' } } } },
    error: { backgroundColor: 'var(--raised)', color: 'var(--text)', boxShadow: 'none' },
  };
  chat.displayLoadingBubble = true;
  chat.scrollButton = false;
}

export function createAgentPanel(el, { agent, suggestions = [], vendorBase = 'vendor/', onOpenChange = () => {} }) {
  let opener = null;
  let chat = null;
  let readyPromise = null;
  let busy = false;
  let generation = 0;
  const inputs = new Map();
  const findInput = (id) => inputs.get(id) ?? {};

  const closeBtn = h('button', { type: 'button', class: 'btn agent-close', 'aria-label': 'Close Ask panel', title: 'Close (Esc)', onclick: () => close() }, 'Close');
  const hint = h('p', { class: 'agent-hint', id: 'lsn-agent-hint', role: 'status', hidden: true }, EMPTY_HINT);
  const status = h('p', { class: 'agent-status', role: 'status' }, 'Loading the chat…');
  const note = h('p', { class: 'agent-note' }, NOTE);
  const chatBox = h('div', { class: 'agent-chat' }, status);
  const suggestButtons = suggestions.map((q) => h('button', { type: 'button', class: 'btn agent-suggestion', onclick: () => ask(q) }, q));
  // Tab stays inside the drawer (review UI I3): two empty focus guards at its ends send focus round.
  const guardStart = h('span', { class: 'focus-guard', tabindex: '0' });
  const guardEnd = h('span', { class: 'focus-guard', tabindex: '0' });
  const panel = h('aside', { class: 'agent-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'lsn-agent-head', hidden: true, 'data-agent-panel': '' },
    guardStart,
    h('header', { class: 'agent-head' }, h('h2', { id: 'lsn-agent-head' }, 'Ask'), closeBtn),
    note,
    chatBox,
    suggestButtons.length ? h('div', { class: 'agent-suggestions', role: 'group', 'aria-label': 'Suggested questions' }, suggestButtons) : null,
    hint,
    guardEnd);
  clear(el);
  el.append(panel);

  guardEnd.addEventListener('focus', () => closeBtn.focus());
  guardStart.addEventListener('focus', () => {
    const last = [...suggestButtons].reverse().find((b) => !b.disabled);
    if (last) last.focus(); else if (chat) focusInput(); else closeBtn.focus();
  });
  // Esc closes the drawer wherever focus is (a click outside can move it out of the panel).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden && !e.defaultPrevented) { e.preventDefault(); close(); }
  });

  // Full screen (≤640 px) the drawer is modal: the page behind it is inert. Wider, it sits beside the
  // page, which stays usable with the pointer while Tab keeps to the drawer.
  const narrow = window.matchMedia?.('(max-width: 640px)');
  function setModal() {
    const modal = !panel.hidden && Boolean(narrow?.matches);
    panel.setAttribute('aria-modal', String(modal));
    for (const sib of document.body.children) {
      if (sib === el || sib.contains(panel) || sib.tagName === 'SCRIPT') continue;
      if (modal) sib.setAttribute('inert', ''); else sib.removeAttribute('inert');
    }
  }
  narrow?.addEventListener?.('change', setModal);

  panel.addEventListener('keydown', (e) => {
    // An empty Enter in the chat input shows the inline hint instead of sending nothing silently.
    if (e.key === 'Enter' && !e.shiftKey && chat && e.composedPath().some((n) => n.id === 'text-input') && inputEmpty()) showHint(true);
  });
  panel.addEventListener('click', (e) => {
    if (chat && e.composedPath().some((n) => n.classList?.contains('input-button') && n.closest?.('#input')) && inputEmpty()) showHint(true);
  }, true);

  function inputEmpty() {
    const input = chat?.shadowRoot?.getElementById('text-input');
    return !input || input.textContent.trim() === '';
  }
  function showHint(on) { hint.hidden = !on; }
  function setBusy(on) {
    busy = on;
    for (const b of suggestButtons) b.disabled = on;
  }

  // deep-chat calls this for each submitted message. Tool rows are added as they finish; the final
  // answer goes back through signals so deep-chat clears its loading bubble.
  function handler(body, signals) {
    const mine = generation;
    const text = String(body?.messages?.[body.messages.length - 1]?.text ?? '').trim();
    showHint(false);
    setBusy(true);
    let last = '';
    const errors = [];
    agent.send(text, (event) => {
      if (mine !== generation) return;
      if (event.type === 'tool_result') chat.addMessage({ role: 'tool', html: toolRowHtml({ name: event.name, input: event.input ?? findInput(event.id), result: event.result, isError: event.isError }) });
      else if (event.type === 'tool_call') inputs.set(event.id, event.input);
      else if (event.type === 'assistant') last = event.text;
      else if (event.type === 'error') errors.push(event.message);
    }).then(() => {
      if (mine !== generation) return;
      const reply = [last, ...errors].filter(Boolean).join('\n\n') || 'No answer.';
      signals.onResponse({ text: reply });
    }, (e) => {
      if (mine !== generation) return;
      signals.onResponse({ text: `Something went wrong: ${e?.message ?? String(e)}` });
    }).finally(() => { if (mine === generation) setBusy(false); });
  }

  // deep-chat builds its view after it is connected; submitUserMessage() before that is dropped with a
  // console warning (a suggestion clicked right after the first open was lost). Wait for its input,
  // or 3 s at most.
  function rendered(c) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (c.shadowRoot?.querySelector('#text-input') || Date.now() - t0 > 3000) resolve(c);
        else setTimeout(tick, 30);
      };
      tick();
    });
  }

  function ensureChat() {
    if (readyPromise) return readyPromise;
    readyPromise = loadScript(`${vendorBase}deepChat.bundle.js`, { ready: () => Boolean(window.customElements?.get('deep-chat')) })
      .then(() => {
        chat = document.createElement('deep-chat');
        chat.setAttribute('aria-label', 'Conversation');
        configure(chat, handler);
        chat.validateInput = (t) => Boolean(t && t.trim()) && !busy;
        status.remove();
        chatBox.append(chat);
        return rendered(chat);
      })
      .catch((e) => {
        status.textContent = 'Couldn’t load the chat panel.';
        readyPromise = null;
        throw e;
      });
    return readyPromise;
  }

  function focusInput() {
    if (chat && typeof chat.focusInput === 'function') chat.focusInput();
  }

  function open(from) {
    if (!panel.hidden) return;
    opener = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    panel.hidden = false;
    setModal();
    document.documentElement.dataset.agentOpen = 'true';
    closeBtn.focus();
    onOpenChange(true);
    ensureChat().then(() => { if (!panel.hidden && panel.contains(document.activeElement)) setTimeout(focusInput, 0); }, () => {});
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    setModal();
    delete document.documentElement.dataset.agentOpen;
    showHint(false);
    onOpenChange(false);
    if (opener && opener.isConnected) opener.focus();
    opener = null;
  }

  function ask(q) {
    if (busy) return;
    showHint(false);
    open();
    const mine = generation;
    ensureChat().then((c) => { if (mine === generation) c.submitUserMessage({ text: q }); }, () => {});
  }

  function setProvider(label, real) {
    note.textContent = real ? `Selected provider: ${label}. Answers come from the model; every step is listed.` : NOTE;
    generation++;
    inputs.clear();
    showHint(false);
    // Vendored deep-chat 2.5.1 exposes clearMessages(). It preserves active/loading bubbles, so a
    // provider switch during a request replaces that element and ignores the old turn's callbacks.
    if (chat && busy) {
      chat.remove();
      chat = null;
      readyPromise = null;
      if (!panel.hidden) ensureChat().catch(() => {});
    } else if (chat) {
      const current = chat;
      rendered(current).then(() => { if (chat === current) current.clearMessages(); });
    }
    setBusy(false);
  }

  return {
    open,
    close,
    toggle(from) { if (panel.hidden) open(from); else close(); },
    isOpen: () => !panel.hidden,
    ask,
    setProvider,
    get ready() { return ensureChat(); },
    el: panel,
  };
}
