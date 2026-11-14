// The Settings sheet (phase 5, workstream T; approved mock docs/phase4/mock/structure.html?s=settings):
// a frosted sheet on the right with a section list (Display / AI assistant / Data and reset) beside one
// scrolling column. Only rarely-changed things live here; mission parameters stay where they are used.
//
// createSettingsSheet({ settings, sources, makeProvider, onOpenChange, onEvidence })
//   → { el, open(opener?), close(), toggle(opener?), isOpen(), showSection(id), destroy() }
//   settings      createSettings() from ../settings.js; every control writes through settings.set()
//   sources       [{ label, value }] rows for "Data and reset" (what the map is built from)
//   makeProvider  () → provider with test(), for the Test button; default createProviderFromSettings
//   onOpenChange  called with true / false
//   onEvidence    optional: shows a "Details in Evidence" button that calls it
// Root element: <section class="lsn-settings" role="dialog">, hidden until open(). The integrator places
// el (end of <body> or the big-map shell). Esc closes; focus returns to the opener; Tab stays inside.
// The API key is only ever in the password field while it is being typed: on commit it is saved and
// the field is emptied, so no attribute, text node or value in the DOM holds it afterwards.
import { h, s } from './dom.js';
import { PALETTES, PROVIDERS, PANEL_ALPHA, createProviderFromSettings } from '../settings.js';
import { redact } from '../agent/anthropic.js';

let uid = 0;
const SECTIONS = [['display', 'Display'], ['ai', 'AI assistant'], ['data', 'Data and reset']];
const SWATCH_ORDER = ['sun', 'earth', 'both', 'negative'];
const SWATCH_NAME = { sun: 'Sun', earth: 'Earth', both: 'Both', negative: 'Worse' };

const toTransparency = (alpha) => Math.round(((PANEL_ALPHA.max - alpha) / (PANEL_ALPHA.max - PANEL_ALPHA.min)) * 100);
const fromTransparency = (t) => Math.round((PANEL_ALPHA.max - (t / 100) * (PANEL_ALPHA.max - PANEL_ALPHA.min)) * 100) / 100;

function closeIcon() {
  return s('svg', { class: 'lsn-set-icon', viewBox: '0 0 16 16', 'aria-hidden': 'true' }, s('path', { d: 'M4 4l8 8M12 4l-8 8' }));
}

export function createSettingsSheet({ settings, sources = [], makeProvider, onOpenChange = () => {}, onEvidence } = {}) {
  const id = `lsn-set-${++uid}`;
  const scriptedStub = () => ({ name: 'mock', respond: async () => ({ content: [] }) });
  const provide = makeProvider ?? (() => createProviderFromSettings(settings, { scripted: scriptedStub }));
  let opener = null;
  let testing = 0;
  let destroyed = false;
  let resetArmed = 0;

  // ---------- small builders ----------
  function switchRow(name, label, hint) {
    const lid = `${id}-${name}-l`;
    const btn = h('button', { type: 'button', class: 'lsn-switch', role: 'switch', 'aria-checked': 'false', 'aria-labelledby': lid, 'data-setting': name,
      onclick: () => settings.set(name, !settings.get(name)) });
    const row = h('div', { class: 'lsn-set-field' },
      h('span', { class: 'lsn-set-label' }, h('span', { id: lid }, label), hint ? h('span', { class: 'lsn-set-hint' }, hint) : null), btn);
    return { row, sync: (snap) => btn.setAttribute('aria-checked', String(Boolean(snap[name]))) };
  }

  function fieldRow(label, control, forId) {
    return h('div', { class: 'lsn-set-field' }, h('label', { class: 'lsn-set-label', for: forId }, label), control);
  }

  // ---------- Display ----------
  const presetButtons = Object.entries(PALETTES).map(([pid, p]) => h('button', {
    type: 'button', class: 'lsn-preset', role: 'radio', 'aria-checked': 'false', tabindex: '-1', 'data-palette-id': pid,
    'aria-label': `${p.label}: ${SWATCH_ORDER.map((k) => `${SWATCH_NAME[k]} ${p.colours[k]}`).join(', ')}`,
    onclick: () => settings.set('palette', pid),
  }, h('span', { class: 'lsn-swatches', 'aria-hidden': 'true' },
    SWATCH_ORDER.map((k) => h('i', { style: `background:${p.colours[k]}`, title: SWATCH_NAME[k] }))), h('span', { class: 'lsn-preset-name' }, p.label)));
  const presets = h('div', { class: 'lsn-presets', role: 'radiogroup', 'aria-labelledby': `${id}-preset-h` }, presetButtons);
  presets.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const ids = Object.keys(PALETTES);
    const next = ids[(ids.indexOf(settings.get('palette')) + step + ids.length) % ids.length];
    settings.set('palette', next);
    presetButtons[ids.indexOf(next)].focus();
  });

  const swSmooth = switchRow('heatSmoothing', 'Smooth heat map', 'Off shows the grid cells as squares');
  const swScale = switchRow('scaleBar', 'Scale bar');
  const swSky = switchRow('skyDial', 'Sky dial', 'Sun and Earth directions at the selected site');
  const swMotion = switchRow('reduceMotion', 'Reduce motion', 'Also on when the system asks for it');
  const range = h('input', { type: 'range', id: `${id}-alpha`, class: 'lsn-range', min: '0', max: '100', step: '5', 'aria-valuetext': '' });
  range.addEventListener('input', () => settings.set('panelAlpha', fromTransparency(Number(range.value))));

  const display = h('section', { class: 'lsn-set-sec', id: `${id}-display`, 'aria-labelledby': `${id}-display-h`, 'data-section': 'display' },
    h('h3', { class: 'sr-only', id: `${id}-display-h` }, 'Display'),
    h('h4', { id: `${id}-preset-h` }, 'Colour preset'),
    presets,
    h('div', { class: 'lsn-set-group' },
      swSmooth.row,
      fieldRow('Panel transparency', range, `${id}-alpha`),
      swScale.row,
      swSky.row,
      swMotion.row));

  // ---------- AI assistant ----------
  const providerSel = h('select', { id: `${id}-provider`, class: 'lsn-input' },
    Object.entries(PROVIDERS).map(([pid, p]) => h('option', { value: pid }, p.label)));
  providerSel.addEventListener('change', () => { settings.set('ai.provider', providerSel.value); setTest(''); });

  const keyInput = h('input', { type: 'password', id: `${id}-key`, class: 'lsn-input', autocomplete: 'off', spellcheck: 'false', 'data-lpignore': 'true' });
  const keyRemove = h('button', { type: 'button', class: 'lsn-btn lsn-btn-line', onclick: () => { settings.set('ai.key', ''); setTest(''); } }, 'Remove');
  function commitKey() {
    const v = keyInput.value;
    keyInput.value = '';
    if (!v.trim()) return true;
    const r = settings.set('ai.key', v);
    setNote(keyErr, r.ok ? '' : 'That key has spaces or is too long.');
    return r.ok;
  }
  keyInput.addEventListener('change', commitKey);
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitKey(); } });
  const keyErr = h('p', { class: 'lsn-set-error', role: 'alert', hidden: true });

  const modelInput = h('input', { type: 'text', id: `${id}-model`, class: 'lsn-input', autocomplete: 'off', spellcheck: 'false' });
  const modelErr = h('p', { class: 'lsn-set-error', role: 'alert', hidden: true });
  modelInput.addEventListener('change', () => { const r = settings.set('ai.model', modelInput.value); setNote(modelErr, r.ok ? '' : 'A model id has no spaces.'); });

  const baseInput = h('input', { type: 'url', id: `${id}-base`, class: 'lsn-input', autocomplete: 'off', spellcheck: 'false' });
  const baseErr = h('p', { class: 'lsn-set-error', role: 'alert', hidden: true });
  baseInput.addEventListener('change', () => {
    const r = settings.set('ai.baseUrl', baseInput.value);
    setNote(baseErr, r.ok ? '' : 'Enter a full URL, for example https://api.example.com/v1.');
  });

  const testBtn = h('button', { type: 'button', class: 'lsn-btn lsn-btn-line', onclick: () => runTest() }, 'Test');
  const testOut = h('p', { class: 'lsn-set-status', role: 'status', 'aria-live': 'polite' });

  const keyRow = h('div', { class: 'lsn-set-field' }, h('label', { class: 'lsn-set-label', for: keyInput.id }, 'API key'), h('span', { class: 'lsn-set-ctl' }, keyInput, keyRemove));
  const modelRow = fieldRow('Model', modelInput, modelInput.id);
  const baseRow = fieldRow('Base URL', baseInput, baseInput.id);
  const scriptedNote = h('p', { class: 'lsn-set-note' }, 'The scripted demo runs in this page, answers a fixed set of questions with the page’s own tools and needs no key or connection.');
  const keyNote = h('p', { class: 'lsn-set-note' },
    'The key stays only in this browser on this machine. It is never put in share links or exports. ',
    'Calling a provider from this page sends the key from your browser straight to that provider. Changing provider or base URL removes it.');
  const providerNote = h('p', { class: 'lsn-set-note lsn-set-faint' });

  const ai = h('section', { class: 'lsn-set-sec', id: `${id}-ai`, 'aria-labelledby': `${id}-ai-h`, 'data-section': 'ai' },
    h('h4', { id: `${id}-ai-h` }, 'AI assistant'),
    fieldRow('Provider', providerSel, providerSel.id),
    keyRow, keyErr, modelRow, modelErr, baseRow, baseErr,
    h('div', { class: 'lsn-set-field lsn-set-field-top' }, h('div', {}, scriptedNote, keyNote, providerNote), testBtn),
    testOut);

  // ---------- Data and reset ----------
  const status = h('p', { class: 'lsn-set-status', role: 'status', 'aria-live': 'polite' });
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    let text = '';
    try { text = await f.text(); } catch { status.textContent = 'Couldn’t read that file.'; return; }
    const r = settings.importJson(text);
    status.textContent = r.ok ? `Imported ${r.applied.length} setting${r.applied.length === 1 ? '' : 's'}.` : [r.applied.length ? `Imported ${r.applied.length}.` : '', ...r.errors].filter(Boolean).join(' ');
  });
  const exportBtn = h('button', { type: 'button', class: 'lsn-btn lsn-btn-line', onclick: () => exportFile() }, 'Export settings');
  const importBtn = h('button', { type: 'button', class: 'lsn-btn lsn-btn-line', onclick: () => fileInput.click() }, 'Import');
  const resetBtn = h('button', { type: 'button', class: 'lsn-btn lsn-btn-line', onclick: () => resetClick() }, 'Reset to defaults');
  const storeNote = h('p', { class: 'lsn-set-note lsn-set-faint' });

  const data = h('section', { class: 'lsn-set-sec', id: `${id}-data`, 'aria-labelledby': `${id}-data-h`, 'data-section': 'data' },
    h('h4', { id: `${id}-data-h` }, 'Data and reset'),
    sources.map((src) => h('div', { class: 'lsn-set-field lsn-set-field-top' },
      h('span', { class: 'lsn-set-label' }, src.label), h('span', { class: 'lsn-set-value' }, src.value))),
    onEvidence ? h('div', { class: 'lsn-set-field' }, h('span', {}), h('button', { type: 'button', class: 'lsn-btn', onclick: () => { close(); onEvidence(); } }, 'Details in Evidence')) : null,
    h('div', { class: 'lsn-set-field lsn-set-actions' }, h('span', {}), h('span', { class: 'lsn-set-ctl' }, exportBtn, importBtn, resetBtn)),
    fileInput,
    status,
    storeNote);

  // ---------- frame ----------
  const navButtons = SECTIONS.map(([sid, label]) => h('button', { type: 'button', class: 'lsn-btn lsn-set-navbtn', 'aria-controls': `${id}-${sid}`, 'data-target': sid,
    onclick: () => showSection(sid) }, label));
  const body = h('div', { class: 'lsn-set-body' }, display, ai, data);
  const titleEl = h('h2', { id: `${id}-title`, tabindex: '-1' }, 'Settings');
  const closeBtn = h('button', { type: 'button', class: 'lsn-btn lsn-set-close', 'aria-label': 'Close settings', title: 'Close (Esc)', onclick: () => close() }, closeIcon());
  const guardStart = h('span', { class: 'focus-guard', tabindex: '0' });
  const guardEnd = h('span', { class: 'focus-guard', tabindex: '0' });
  const el = h('section', { class: 'lsn-settings', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-sub`, hidden: true, 'data-settings-sheet': '' },
    guardStart,
    h('header', { class: 'lsn-set-head' },
      h('div', { class: 'lsn-set-titles' }, titleEl, h('p', { id: `${id}-sub`, class: 'lsn-set-sub' }, 'Things you set once. Saved in this browser only.')),
      closeBtn),
    h('div', { class: 'lsn-set-cols' }, h('nav', { class: 'lsn-set-nav', 'aria-label': 'Settings sections' }, navButtons), body),
    guardEnd);

  const focusables = () => [...el.querySelectorAll('button, input, select')].filter((n) => !n.disabled && !n.closest('[hidden]') && n.tabIndex >= 0 && n.getAttribute('aria-hidden') !== 'true');
  guardEnd.addEventListener('focus', () => closeBtn.focus());
  guardStart.addEventListener('focus', () => { const f = focusables(); (f[f.length - 1] ?? closeBtn).focus(); });
  function onKey(e) {
    if (e.key === 'Escape' && !el.hidden && !e.defaultPrevented) { e.preventDefault(); close(); }
  }
  globalThis.document?.addEventListener('keydown', onKey);

  // ---------- state → controls ----------
  function setNote(node, text) { node.textContent = text; node.hidden = !text; }
  function setTest(text, kind) { testOut.textContent = text; if (kind) testOut.dataset.kind = kind; else delete testOut.dataset.kind; }

  function sync(snap) {
    presetButtons.forEach((b) => {
      const on = b.dataset.paletteId === snap.palette;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    for (const sw of [swSmooth, swScale, swSky, swMotion]) sw.sync(snap);
    const t = toTransparency(snap.panelAlpha);
    if (Number(range.value) !== t) range.value = String(t);
    range.setAttribute('aria-valuetext', `${t}% transparent`);

    const pid = snap['ai.provider'];
    const p = PROVIDERS[pid];
    providerSel.value = pid;
    const real = pid !== 'scripted';
    for (const n of [keyRow, modelRow, baseRow, keyNote]) n.hidden = !real;
    scriptedNote.hidden = real;
    keyInput.placeholder = snap['ai.hasKey'] ? 'Saved · type to replace' : (pid === 'openai-compat' ? 'not set (optional for a local server)' : 'not set');
    keyRemove.hidden = !snap['ai.hasKey'];
    if (globalThis.document?.activeElement !== modelInput) modelInput.value = snap['ai.model'];
    modelInput.placeholder = p.defaultModel || 'required: the model id your server lists';
    if (globalThis.document?.activeElement !== baseInput) baseInput.value = snap['ai.baseUrl'];
    baseInput.placeholder = p.defaultBaseUrl ?? '';
    providerNote.textContent = pid === 'anthropic'
      ? 'Sent with Anthropic’s direct-browser-access header. Organisations with zero data retention cannot call it from a browser. Use a key scoped to one workspace.'
      : pid === 'openai-compat'
        ? 'Any server with a Chat Completions endpoint at the base URL that allows requests from this page (CORS).'
        : '';
    storeNote.textContent = settings.persistent ? 'Saved in this browser.' : 'This browser blocks storage: settings last until the page closes.';
  }

  async function runTest() {
    if (destroyed) return;
    if (keyInput.value && !commitKey()) return;
    const requestKey = settings.getKey();
    const safe = (text) => redact(redact(text, requestKey), settings.getKey());
    const mine = ++testing;
    testBtn.disabled = true;
    setTest('Testing…', 'busy');
    let r;
    try { r = await provide().test(); } catch (e) { r = { ok: false, error: e?.message ?? String(e) }; }
    if (mine !== testing) return;
    testBtn.disabled = false;
    const secs = Number.isFinite(r.ms) ? ` in ${(r.ms / 1000).toFixed(1)} s` : '';
    if (r.ok) setTest(safe(`Connected. ${r.model} answered${r.text ? ` “${r.text}”` : ''}${secs}.`), 'ok');
    else setTest(safe(`Failed: ${r.error}`), 'error');
  }

  function invalidateTest() {
    testing += 1;
    testBtn.disabled = false;
    setTest('');
  }

  function exportFile() {
    const text = settings.exportJson();
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = h('a', { href: url, download: 'lunar-site-navigator-settings.json' });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = 'Settings exported. The API key is not in the file.';
    } catch { status.textContent = 'This browser could not save the file.'; }
  }

  function resetClick() {
    if (resetArmed && Date.now() - resetArmed < 5000) {
      resetArmed = 0;
      resetBtn.textContent = 'Reset to defaults';
      settings.reset();
      setTest('');
      status.textContent = 'Settings reset. The saved key was removed.';
      return;
    }
    resetArmed = Date.now();
    resetBtn.textContent = 'Confirm reset';
    status.textContent = 'Resets every setting here and removes the saved API key. Press again to confirm.';
    setTimeout(() => { if (resetArmed && Date.now() - resetArmed >= 5000) { resetArmed = 0; resetBtn.textContent = 'Reset to defaults'; } }, 5100);
  }

  // ---------- sections ----------
  function setActive(sid) {
    for (const b of navButtons) {
      if (b.dataset.target === sid) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
  }
  function showSection(sid) {
    const sec = body.querySelector(`[data-section="${sid}"]`);
    if (!sec) return;
    setActive(sid);
    body.scrollTo?.({ top: sec.offsetTop - body.offsetTop, behavior: 'auto' });
  }
  // the last section is at least as tall as the column (CSS), so every section can scroll to the top
  body.addEventListener('scroll', () => {
    const top = body.scrollTop + 8;
    let cur = SECTIONS[0][0];
    for (const [sid] of SECTIONS) { const sec = body.querySelector(`[data-section="${sid}"]`); if (sec && sec.offsetTop - body.offsetTop <= top) cur = sid; }
    setActive(cur);
  }, { passive: true });

  const unsubscribe = settings.subscribe((snap) => { invalidateTest(); sync(snap); });
  sync(settings.get());
  setActive('display');

  function open(from) {
    if (!el.hidden) return;
    opener = from ?? (globalThis.document?.activeElement instanceof HTMLElement ? globalThis.document.activeElement : null);
    el.hidden = false;
    sync(settings.get());
    titleEl.focus();
    onOpenChange(true);
  }
  function close() {
    invalidateTest();
    if (el.hidden) return;
    keyInput.value = '';
    el.hidden = true;
    onOpenChange(false);
    if (opener && opener.isConnected) opener.focus();
    opener = null;
  }

  return {
    el,
    open,
    close,
    toggle(from) { if (el.hidden) open(from); else close(); },
    isOpen: () => !el.hidden,
    showSection,
    destroy() { destroyed = true; invalidateTest(); unsubscribe(); globalThis.document?.removeEventListener('keydown', onKey); el.remove(); },
  };
}
