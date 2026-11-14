// Settings that are set once and rarely changed (phase 5, workstream T): colour preset, display options
// and the AI provider. Mission parameters (landing date, stay, energy assumptions, relay orbit, slope
// limit, filters) are deliberately NOT here: the user asked for them to stay where they are used.
//
// createSettings({ storage }) → {
//   get(name) → value, get() → snapshot (every key except ai.key; 'ai.hasKey' says whether one is saved)
//   getKey() → the API key (only for building a provider; never log, export or render it)
//   set(name, value) | set({ name: value, … }) → { ok, errors: [string] }   invalid values are refused
//   subscribe(fn(snapshot, changedNames)) → unsubscribe
//   reset() → defaults, and the saved key is removed
//   exportJson() → JSON text without the key; importJson(text) → { ok, applied: [names], errors }
//   persistent: false when localStorage is unavailable (the settings still work for this page)
// }
// Storage: localStorage 'lsn-settings' holds { v, values } without the key; 'lsn-ai-key' holds
// { v, provider, origin, key }. Unbound legacy keys must be re-entered. All storage access is guarded.
// Safety rule: switching provider, or pointing the base URL at another origin, removes the saved key, so
// a key is never sent to a host the user did not enter it for; importJson never imports a key.
import { createAnthropicProvider, ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_DEFAULT_BASE } from './agent/anthropic.js';
import { createOpenAICompatProvider, OPENAI_DEFAULT_BASE } from './agent/openai-compat.js';

export const SETTINGS_VERSION = 1;
export const STORAGE_KEY = 'lsn-settings';
export const KEY_STORAGE_KEY = 'lsn-ai-key';
const EXPORT_APP = 'lunar-site-navigator-settings';

// Each preset overrides the four data tokens of styles.css through :root[data-palette="…"] in
// styles/phase5-settings.css; these values must match that file (tests/settings.test.mjs checks it).
// Contrast and separation figures: docs/phase5/harness/T-contrast.mjs, reported in the hand-off.
export const PALETTES = {
  default: { label: 'Default', colours: { sun: '#f2b33d', earth: '#4cb3f0', both: '#e6e6e6', negative: '#e5484d' } },
  'cb-safe': { label: 'Colour-blind safe', colours: { sun: '#e69f00', earth: '#56b4e9', both: '#e6e6e6', negative: '#ec5170' } },
  'high-contrast': { label: 'High contrast', colours: { sun: '#ffd400', earth: '#1ad1ff', both: '#ffffff', negative: '#ff5c8a' } },
};

export const PROVIDERS = {
  scripted: { label: 'Scripted demo (offline)', needsKey: false },
  anthropic: { label: 'Anthropic (Claude)', needsKey: true, defaultModel: ANTHROPIC_DEFAULT_MODEL, defaultBaseUrl: ANTHROPIC_DEFAULT_BASE },
  'openai-compat': { label: 'OpenAI-compatible', needsKey: false, defaultModel: '', defaultBaseUrl: OPENAI_DEFAULT_BASE },
};

export const PANEL_ALPHA = { min: 0.30, max: 0.80, default: 0.40 };   // glass fill opacity; the default matches the lighter shell glass and leaves room to go clearer (G)

export const DEFAULTS = Object.freeze({
  palette: 'default',
  heatSmoothing: true,
  panelAlpha: PANEL_ALPHA.default,
  scaleBar: true,
  skyDial: true,
  reduceMotion: false,
  'ai.provider': 'scripted',
  'ai.model': '',
  'ai.baseUrl': '',
  'ai.key': '',
});
export const SETTING_NAMES = Object.keys(DEFAULTS);

const bool = (v) => (typeof v === 'boolean' ? { value: v } : { error: 'must be true or false' });
const oneOf = (list) => (v) => (list.includes(v) ? { value: v } : { error: `must be one of ${list.join(', ')}` });
const VALIDATE = {
  palette: oneOf(Object.keys(PALETTES)),
  heatSmoothing: bool,
  panelAlpha: (v) => (typeof v === 'number' && Number.isFinite(v) && v >= PANEL_ALPHA.min - 1e-9 && v <= PANEL_ALPHA.max + 1e-9
    ? { value: Math.round(v * 100) / 100 } : { error: `must be a number from ${PANEL_ALPHA.min} to ${PANEL_ALPHA.max}` }),
  scaleBar: bool,
  skyDial: bool,
  reduceMotion: bool,
  'ai.provider': oneOf(Object.keys(PROVIDERS)),
  'ai.model': (v) => (typeof v === 'string' && v.trim().length <= 200 && !/[\s]/.test(v.trim()) ? { value: v.trim() } : { error: 'must be a model id without spaces' }),
  'ai.baseUrl': (v) => {
    if (typeof v !== 'string') return { error: 'must be a URL' };
    const t = v.trim();
    if (!t) return { value: '' };
    try {
      const u = new URL(t);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'must start with https:// or http://' };
      if (u.username || u.password) return { error: 'must not contain a user name or password' };
      return { value: t.replace(/\/+$/, '') };
    } catch { return { error: 'must be a full URL such as https://api.example.com/v1' }; }
  },
  // the message never repeats the value
  'ai.key': (v) => (typeof v === 'string' && v.trim().length <= 512 && !/[\s]/.test(v.trim()) ? { value: v.trim() } : { error: 'is not a valid key (no spaces, at most 512 characters)' }),
};

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

const originOf = (url, provider) => {
  const u = url || PROVIDERS[provider]?.defaultBaseUrl || '';
  try { return new URL(u).origin; } catch { return ''; }
};

export function createSettings({ storage = defaultStorage() } = {}) {
  const values = { ...DEFAULTS };
  const subs = new Set();
  let persistent = Boolean(storage);

  // ---------- load ----------
  function read(name) {
    try { return storage?.getItem(name); }
    catch { persistent = false; return null; }
  }
  try {
    const raw = read(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const stored = saved && typeof saved === 'object' && saved.values && typeof saved.values === 'object' ? saved.values : {};
      // version 1 is the first; a later version's unknown keys are skipped, known valid ones kept
      for (const name of SETTING_NAMES) {
        if (name === 'ai.key' || !Object.hasOwn(stored, name)) continue;
        const r = VALIDATE[name](stored[name]);
        if (!r.error) values[name] = r.value;
      }
    }
  } catch { /* unreadable or blocked storage: defaults */ }
  try {
    const credential = JSON.parse(read(KEY_STORAGE_KEY) ?? 'null');
    if (credential?.v === 1 && credential.provider === values['ai.provider']
      && credential.origin === originOf(values['ai.baseUrl'], values['ai.provider'])
      && !VALIDATE['ai.key'](credential.key).error) values['ai.key'] = credential.key.trim();
  } catch { /* no key */ }
  if (values['ai.provider'] === 'scripted') values['ai.key'] = '';

  // ---------- save ----------
  function save() {
    if (!storage) return;
    try {
      const out = {};
      for (const name of SETTING_NAMES) if (name !== 'ai.key') out[name] = values[name];
      // Clear first on EVERY save, including retries after partial failures. A failed removal
      // prevents the settings write; a failed settings write cannot leave a newly orphaned key.
      storage.removeItem(KEY_STORAGE_KEY);
      storage.setItem(STORAGE_KEY, JSON.stringify({ v: SETTINGS_VERSION, values: out }));
      if (values['ai.key']) storage.setItem(KEY_STORAGE_KEY, JSON.stringify({
        v: 1, provider: values['ai.provider'], origin: originOf(values['ai.baseUrl'], values['ai.provider']), key: values['ai.key'],
      }));
      persistent = true;
    } catch { persistent = false; }
  }

  function snapshot() {
    const s = {};
    for (const name of SETTING_NAMES) if (name !== 'ai.key') s[name] = values[name];
    s['ai.hasKey'] = Boolean(values['ai.key']);
    return s;
  }

  function emit(changed) {
    if (!changed.length) return;
    const snap = snapshot();
    for (const fn of [...subs]) { try { fn(snap, changed.slice()); } catch { /* a listener error must not stop the others */ } }
  }

  // Applies a patch; `fromImport` drops ai.key. Returns the changed names and the errors.
  function apply(patch, { fromImport = false } = {}) {
    const errors = [];
    const next = { ...values };
    let validReplacement = false;
    for (const [name, raw] of Object.entries(patch ?? {})) {
      if (!Object.hasOwn(VALIDATE, name)) { errors.push(`Unknown setting ${name}.`); continue; }
      if (name === 'ai.key' && fromImport) { errors.push('An API key is never imported; enter it in Settings.'); continue; }
      const r = VALIDATE[name](raw);
      if (r.error) { errors.push(`${name} ${r.error}.`); continue; }
      next[name] = r.value;
      if (name === 'ai.key') validReplacement = true;
    }
    // the key belongs to one provider and one origin: a change of either removes it
    const providerChanged = next['ai.provider'] !== values['ai.provider'];
    if (providerChanged) {
      if (!('ai.model' in (patch ?? {}))) next['ai.model'] = '';
      if (!('ai.baseUrl' in (patch ?? {}))) next['ai.baseUrl'] = '';
    }
    const originChanged = originOf(next['ai.baseUrl'], next['ai.provider']) !== originOf(values['ai.baseUrl'], values['ai.provider']);
    if (providerChanged || originChanged || next['ai.provider'] === 'scripted') {
      if (!validReplacement || next['ai.provider'] === 'scripted') next['ai.key'] = '';
    }
    const changed = SETTING_NAMES.filter((n) => next[n] !== values[n]);
    Object.assign(values, next);
    return { changed, errors };
  }

  const api = {
    get(name) {
      if (name === undefined) return snapshot();
      if (name === 'ai.key') throw new Error('Use getKey() to read the API key.');
      if (name === 'ai.hasKey') return Boolean(values['ai.key']);
      return values[name];
    },
    getKey() { return values['ai.key']; },
    set(nameOrPatch, value) {
      const patch = typeof nameOrPatch === 'string' ? { [nameOrPatch]: value } : nameOrPatch;
      const { changed, errors } = apply(patch);
      if (changed.length) { save(changed); emit(changed); }
      return { ok: errors.length === 0, errors };
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    reset() {
      const changed = SETTING_NAMES.filter((n) => values[n] !== DEFAULTS[n]);
      Object.assign(values, DEFAULTS);
      try { storage?.removeItem(KEY_STORAGE_KEY); storage?.removeItem(STORAGE_KEY); persistent = Boolean(storage); } catch { persistent = false; }
      emit(changed);
    },
    exportJson() {
      const out = {};
      for (const name of SETTING_NAMES) if (name !== 'ai.key') out[name] = values[name];
      return JSON.stringify({ app: EXPORT_APP, v: SETTINGS_VERSION, values: out }, null, 2);
    },
    importJson(text) {
      let data;
      try { data = JSON.parse(String(text)); } catch { return { ok: false, applied: [], errors: ['The file is not JSON.'] }; }
      if (!data || typeof data !== 'object' || data.app !== EXPORT_APP || typeof data.values !== 'object' || data.values === null || Array.isArray(data.values)) {
        return { ok: false, applied: [], errors: ['This is not a Lunar Site Navigator settings file.'] };
      }
      if (typeof data.v !== 'number' || data.v > SETTINGS_VERSION) {
        return { ok: false, applied: [], errors: [`Settings file version is invalid or newer than this page understands (${SETTINGS_VERSION}).`] };
      }
      const patch = { ...data.values };
      const hadKey = 'ai.key' in patch;
      delete patch['ai.key'];
      const { changed, errors } = apply(patch, { fromImport: true });
      if (hadKey) errors.push('An API key is never imported; enter it in Settings.');
      if (changed.length) { save(changed); emit(changed); }
      return { ok: errors.length === 0, applied: changed.filter((n) => n !== 'ai.key'), errors };
    },
    get persistent() { return persistent; },
  };
  return api;
}

// ---------- applying the display settings ----------
// Sets the attributes and the custom property that styles/phase5-settings.css reads:
//   data-palette on <html> (the preset id), data-reduce-motion="on" when forced,
//   data-panel-alpha + --lsn-panel-alpha when the glass opacity differs from the default.
// The canvas does not follow CSS by itself: see paletteChanged() in the hand-off.
export function applyDisplay(snapshot, root = globalThis.document?.documentElement) {
  if (!root) return;
  root.dataset.palette = snapshot.palette;
  if (snapshot.reduceMotion) root.dataset.reduceMotion = 'on'; else delete root.dataset.reduceMotion;
  if (Math.abs(snapshot.panelAlpha - PANEL_ALPHA.default) > 1e-9) {
    root.dataset.panelAlpha = '';
    root.style.setProperty('--lsn-panel-alpha', String(snapshot.panelAlpha));
  } else {
    delete root.dataset.panelAlpha;
    root.style.removeProperty('--lsn-panel-alpha');
  }
}

// prefers-reduced-motion from the system, or the setting forcing it on
export function reducedMotion(snapshot) {
  if (snapshot?.reduceMotion) return true;
  try { return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
}

// map/layers.js paintHeat style.smooth: undefined keeps the automatic rule, false turns smoothing off
export function heatSmoothOption(snapshot) {
  return snapshot?.heatSmoothing === false ? false : undefined;
}

// ---------- the provider the Ask panel should use ----------
// createProviderFromSettings(settings, { scripted, fetch }) → provider with respond() / test() / label
//   scripted  () => the scripted provider (pass createMockProvider from agent/mock.js)
// A real provider without what it needs still returns a provider: its respond() and test() fail with a
// clear message, so the panel shows the problem instead of quietly falling back to the script.
export function createProviderFromSettings(settings, { scripted, fetch } = {}) {
  const provider = settings.get('ai.provider');
  const model = settings.get('ai.model');
  const baseUrl = settings.get('ai.baseUrl');
  if (provider === 'anthropic') return createAnthropicProvider({ apiKey: settings.getKey(), model, baseUrl, ...(fetch ? { fetch } : {}) });
  if (provider === 'openai-compat') return createOpenAICompatProvider({ apiKey: settings.getKey(), model, baseUrl, ...(fetch ? { fetch } : {}) });
  const p = scripted ? scripted() : null;
  if (!p) throw new Error('createProviderFromSettings needs { scripted } for the scripted demo.');
  return {
    ...p,
    respond: p.respond.bind(p),
    name: p.name ?? 'mock',
    label: 'Scripted demo · offline',
    async test() { return { ok: true, model: 'scripted', text: 'The scripted demo runs in this page and needs no connection.', ms: 0 }; },
  };
}

// True when a change to these settings means the Ask panel must rebuild its provider and start over.
export function providerChanged(changedNames) {
  return changedNames.some((n) => n.startsWith('ai.'));
}
