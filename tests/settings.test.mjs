import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSettingsSheet } from '../demo/src/ui/settingssheet.js';
import {
  createSettings, DEFAULTS, PALETTES, PROVIDERS, STORAGE_KEY, KEY_STORAGE_KEY, SETTINGS_VERSION, PANEL_ALPHA,
  applyDisplay, heatSmoothOption, providerChanged, createProviderFromSettings,
} from '../demo/src/settings.js';

const KEY = 'sk-ant-api03-FAKE-TEST-KEY-0123456789abcdef';
const KEY2 = 'sk-other-FAKE-KEY-9876543210';

function memStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('defaults: scripted provider, default palette, smoothing on, nothing stored yet', () => {
  const s = createSettings({ storage: memStorage() });
  const snap = s.get();
  assert.equal(snap.palette, 'default');
  assert.equal(snap.heatSmoothing, true);
  assert.equal(snap.panelAlpha, PANEL_ALPHA.default);
  assert.equal(snap['ai.provider'], 'scripted');
  assert.equal(snap['ai.hasKey'], false);
  assert.ok(!('ai.key' in snap));
  // mission parameters are not settings (the user's explicit request)
  for (const k of ['landingMs', 'stayDays', 'slipDays', 'maxSlope', 'maxDark', 'relay', 'energy', 'battery', 'weights', 'filters']) {
    assert.ok(!Object.keys(DEFAULTS).some((n) => n.toLowerCase().includes(k.toLowerCase())), k);
  }
});

test('works without storage and with storage that throws', () => {
  for (const storage of [null, throwing]) {
    const s = createSettings({ storage });
    assert.deepEqual(s.set('palette', 'cb-safe'), { ok: true, errors: [] });
    assert.equal(s.get('palette'), 'cb-safe');
    s.reset();
    assert.equal(s.get('palette'), 'default');
    assert.equal(s.persistent, false);
  }
});

test('set validates every key and refuses bad values without changing anything', () => {
  const s = createSettings({ storage: memStorage() });
  const r = s.set({ palette: 'neon', heatSmoothing: 'yes', panelAlpha: 2, 'ai.provider': 'gpt', 'ai.baseUrl': 'ftp://x', bogus: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 6);
  assert.deepEqual(s.get(), createSettings({ storage: memStorage() }).get());
  assert.equal(s.set('panelAlpha', 0.62).ok, true);
  assert.equal(s.get('panelAlpha'), 0.62);
  assert.equal(s.set('ai.baseUrl', 'https://user:pw@example.com').ok, false);
});

test('persists with a version, reloads, and keeps the key in its own storage entry', () => {
  const st = memStorage();
  const s = createSettings({ storage: st });
  s.set({ palette: 'high-contrast', scaleBar: false, 'ai.provider': 'anthropic' });
  s.set('ai.key', KEY);
  const blob = JSON.parse(st.getItem(STORAGE_KEY));
  assert.equal(blob.v, SETTINGS_VERSION);
  assert.equal(blob.values.palette, 'high-contrast');
  assert.ok(!st.getItem(STORAGE_KEY).includes(KEY), 'the settings blob never carries the key');
  assert.ok(!('ai.key' in blob.values));
  assert.deepEqual(JSON.parse(st.getItem(KEY_STORAGE_KEY)), { v: 1, provider: 'anthropic', origin: 'https://api.anthropic.com', key: KEY });
  const again = createSettings({ storage: st });
  assert.equal(again.get('palette'), 'high-contrast');
  assert.equal(again.get('scaleBar'), false);
  assert.equal(again.getKey(), KEY);
  assert.equal(again.get('ai.hasKey'), true);
});

test('a corrupt or partly invalid stored blob falls back per key', () => {
  const st = memStorage();
  st.setItem(STORAGE_KEY, '{not json');
  assert.equal(createSettings({ storage: st }).get('palette'), 'default');
  st.setItem(STORAGE_KEY, JSON.stringify({ v: 99, values: { palette: 'cb-safe', panelAlpha: 'x', future: 1 } }));
  const s = createSettings({ storage: st });
  assert.equal(s.get('palette'), 'cb-safe');
  assert.equal(s.get('panelAlpha'), PANEL_ALPHA.default);
});

test('the key never appears in exportJson, the snapshot, errors, or thrown messages', () => {
  const s = createSettings({ storage: memStorage() });
  s.set({ 'ai.provider': 'anthropic', 'ai.key': KEY });
  assert.equal(s.getKey(), KEY);
  const exported = s.exportJson();
  assert.ok(!exported.includes(KEY));
  assert.ok(!exported.includes('ai.key'));
  assert.ok(!JSON.stringify(s.get()).includes(KEY));
  assert.throws(() => s.get('ai.key'), (e) => !e.message.includes(KEY));
  const bad = s.set('ai.key', `${KEY} with spaces`);
  assert.equal(bad.ok, false);
  assert.ok(!bad.errors.join(' ').includes(KEY));
  assert.equal(s.getKey(), KEY, 'a refused key leaves the saved one');
  let seen = '';
  s.subscribe((snap, changed) => { seen += JSON.stringify(snap) + changed.join(); });
  s.set('ai.model', 'claude-sonnet-5-5');
  assert.ok(!seen.includes(KEY), 'listeners never get the key');
});

test('switching provider, or the base URL to another origin, removes the key; the same origin keeps it', () => {
  const s = createSettings({ storage: memStorage() });
  s.set({ 'ai.provider': 'openai-compat', 'ai.baseUrl': 'https://llm.example.com/v1', 'ai.model': 'm1' });
  s.set('ai.key', KEY2);
  s.set('ai.baseUrl', 'https://llm.example.com/v2');
  assert.equal(s.getKey(), KEY2, 'same origin');
  s.set('ai.baseUrl', 'https://elsewhere.example.net/v1');
  assert.equal(s.getKey(), '', 'another origin');
  s.set('ai.key', KEY2);
  s.set('ai.provider', 'anthropic');
  assert.equal(s.getKey(), '');
  assert.equal(s.get('ai.model'), '', 'model and base URL start over for the new provider');
  assert.equal(s.get('ai.baseUrl'), '');
  s.set({ 'ai.provider': 'anthropic', 'ai.key': KEY });
  s.set('ai.provider', 'scripted');
  assert.equal(s.getKey(), '');
  assert.equal(s.set('ai.key', KEY).ok, true);
  assert.equal(s.getKey(), '', 'the scripted demo never holds a key');
});

test('H1: a failed settings write cannot reattach an orphan key on a later save', () => {
  for (const failingOperation of ['setItem', 'removeItem']) {
    const st = memStorage();
    const original = st[failingOperation];
    let deny = false;
    st[failingOperation] = (k, v) => {
      if (deny && k === (failingOperation === 'setItem' ? STORAGE_KEY : KEY_STORAGE_KEY)) throw Error('blocked');
      return original(k, v);
    };
    const s = createSettings({ storage: st });
    s.set({ 'ai.provider': 'openai-compat', 'ai.baseUrl': 'https://a.example/v1', 'ai.key': KEY });
    deny = true;
    s.set('ai.baseUrl', 'https://b.example/v1');
    assert.equal(s.getKey(), '');
    assert.equal(s.persistent, false);
    deny = false;
    s.set('palette', 'cb-safe');
    const reloaded = createSettings({ storage: st });
    assert.equal(reloaded.get('ai.baseUrl'), 'https://b.example/v1');
    assert.equal(reloaded.getKey(), '', failingOperation);
    assert.equal(st.getItem(KEY_STORAGE_KEY), null);
  }
});

test('H1: origin/provider changes retain only a valid same-patch replacement key', () => {
  for (const change of [{ 'ai.baseUrl': 'https://b.example/v1' }, { 'ai.provider': 'anthropic' }]) {
    const st = memStorage();
    const s = createSettings({ storage: st });
    s.set({ 'ai.provider': 'openai-compat', 'ai.baseUrl': 'https://a.example/v1', 'ai.key': KEY });
    assert.equal(s.set({ ...change, 'ai.key': 'invalid key' }).ok, false);
    assert.equal(s.getKey(), '');
    assert.equal(createSettings({ storage: st }).getKey(), '');
    s.set({ 'ai.baseUrl': 'https://c.example/v1', 'ai.key': KEY2 });
    assert.equal(createSettings({ storage: st }).getKey(), KEY2);
  }
});

test('H1: stored credentials carry their provider/origin and mismatches or legacy keys are ignored', () => {
  const st = memStorage();
  const s = createSettings({ storage: st });
  s.set({ 'ai.provider': 'openai-compat', 'ai.baseUrl': 'https://a.example/v1', 'ai.key': KEY });
  const record = JSON.parse(st.getItem(KEY_STORAGE_KEY));
  assert.deepEqual(record, { v: 1, provider: 'openai-compat', origin: 'https://a.example', key: KEY });
  for (const values of [
    { 'ai.provider': 'openai-compat', 'ai.baseUrl': 'https://b.example/v1' },
    { 'ai.provider': 'anthropic', 'ai.baseUrl': 'https://a.example/v1' },
  ]) {
    st.setItem(STORAGE_KEY, JSON.stringify({ v: 1, values }));
    assert.equal(createSettings({ storage: st }).getKey(), '');
  }
  st.setItem(KEY_STORAGE_KEY, KEY);
  assert.equal(createSettings({ storage: st }).getKey(), '');
});

test('importJson applies known settings, never a key, and a provider or origin change drops the saved key', () => {
  const s = createSettings({ storage: memStorage() });
  s.set({ 'ai.provider': 'anthropic', 'ai.key': KEY });
  const other = createSettings({ storage: memStorage() });
  other.set({ palette: 'cb-safe', reduceMotion: true });
  const r = s.importJson(other.exportJson().replace('"reduceMotion": true', '"reduceMotion": true, "ai.key": "sk-planted"'));
  assert.ok(r.errors.some((e) => /never imported/.test(e)));
  assert.equal(s.get('palette'), 'cb-safe');
  assert.equal(s.get('reduceMotion'), true);
  assert.equal(s.get('ai.provider'), 'scripted');
  assert.equal(s.getKey(), '', 'importing another provider removed the key; the planted key was ignored');

  const t = createSettings({ storage: memStorage() });
  t.set({ 'ai.provider': 'openai-compat', 'ai.baseUrl': 'https://a.example.com/v1', 'ai.model': 'm' });
  t.set('ai.key', KEY2);
  const planted = JSON.stringify({ app: 'lunar-site-navigator-settings', v: 1, values: { 'ai.provider': 'openai-compat', 'ai.baseUrl': 'https://evil.example.org/v1' } });
  t.importJson(planted);
  assert.equal(t.getKey(), '', 'a settings file cannot redirect a saved key to another host');

  assert.equal(s.importJson('nope').ok, false);
  assert.equal(s.importJson('{"app":"other","v":1,"values":{}}').ok, false);
  assert.equal(s.importJson('{"app":"lunar-site-navigator-settings","v":2,"values":{}}').ok, false);
});

test('reset restores the defaults and removes the stored key', () => {
  const st = memStorage();
  const s = createSettings({ storage: st });
  s.set({ palette: 'cb-safe', 'ai.provider': 'anthropic', 'ai.key': KEY });
  let changed = null;
  s.subscribe((_, c) => { changed = c; });
  s.reset();
  assert.deepEqual(s.get(), createSettings({ storage: memStorage() }).get());
  assert.equal(st.getItem(KEY_STORAGE_KEY), null);
  assert.ok(changed.includes('palette') && changed.includes('ai.key'));
});

test('subscribe: listeners get the snapshot and changed names; a throwing listener does not stop others; unsubscribe works', () => {
  const s = createSettings({ storage: memStorage() });
  const calls = [];
  s.subscribe(() => { throw new Error('x'); });
  const off = s.subscribe((snap, changed) => calls.push([snap.palette, changed]));
  s.set('palette', 'cb-safe');
  s.set('palette', 'cb-safe');   // no change, no call
  off();
  s.set('palette', 'default');
  assert.deepEqual(calls, [['cb-safe', ['palette']]]);
});

test('nothing logs, and nothing touches the URL hash', () => {
  for (const f of ['../demo/src/settings.js', '../demo/src/ui/settingssheet.js', '../demo/src/agent/anthropic.js', '../demo/src/agent/openai-compat.js']) {
    const text = src(f);
    assert.ok(!/\bconsole\./.test(text), `${f} uses console`);
    assert.ok(!/location\.hash|history\.(push|replace)State/.test(text), `${f} touches the hash`);
  }
  const orig = {};
  const hits = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) { orig[m] = console[m]; console[m] = (...a) => hits.push(a.join(' ')); }
  try {
    const s = createSettings({ storage: memStorage() });
    s.set({ 'ai.provider': 'anthropic', 'ai.key': KEY });
    s.set('ai.key', 'has spaces in it');
    s.exportJson(); s.importJson(s.exportJson()); s.reset();
  } finally { Object.assign(console, orig); }
  assert.deepEqual(hits, []);
});

test('palette CSS matches PALETTES, the default matches styles.css, and every value is 6-digit hex for readColours()', () => {
  const css = src('../demo/src/styles/phase5-settings.css');
  const base = src('../demo/src/styles.css');
  for (const [id, p] of Object.entries(PALETTES)) {
    for (const [name, hex] of Object.entries(p.colours)) {
      assert.match(hex, /^#[0-9a-f]{6}$/);
      if (id === 'default') assert.match(base, new RegExp(`--${name}: ${hex};`), `default ${name}`);
      else {
        const rule = new RegExp(`:root\\[data-palette="${id}"\\] \\{[^}]*--${name}: ${hex};`);
        assert.match(css, rule, `${id} ${name}`);
      }
    }
  }
  assert.deepEqual(Object.keys(PALETTES), ['default', 'cb-safe', 'high-contrast']);
  assert.equal(PALETTES['cb-safe'].colours.sun, '#e69f00', 'Okabe–Ito orange');
  assert.equal(PALETTES['cb-safe'].colours.earth, '#56b4e9', 'Okabe–Ito sky blue');
});

test('applyDisplay sets the attributes and custom property the CSS reads; helpers', () => {
  const props = new Map();
  const root = { dataset: {}, style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } };
  applyDisplay({ ...createSettings({ storage: null }).get(), palette: 'cb-safe', reduceMotion: true, panelAlpha: 0.7 }, root);
  assert.equal(root.dataset.palette, 'cb-safe');
  assert.equal(root.dataset.reduceMotion, 'on');
  assert.equal(root.dataset.panelAlpha, '');
  assert.equal(props.get('--lsn-panel-alpha'), '0.7');
  applyDisplay(createSettings({ storage: null }).get(), root);
  assert.equal(root.dataset.palette, 'default');
  assert.ok(!('reduceMotion' in root.dataset) && !('panelAlpha' in root.dataset) && !props.has('--lsn-panel-alpha'));
  assert.equal(heatSmoothOption({ heatSmoothing: true }), undefined);
  assert.equal(heatSmoothOption({ heatSmoothing: false }), false);
  assert.equal(providerChanged(['palette']), false);
  assert.equal(providerChanged(['palette', 'ai.model']), true);
});

test('createProviderFromSettings: scripted by default, real providers get the saved key and settings', async () => {
  const s = createSettings({ storage: memStorage() });
  assert.throws(() => createProviderFromSettings(s));
  const mock = { name: 'mock', respond: async () => ({ content: [{ type: 'text', text: 'hi' }] }) };
  const p = createProviderFromSettings(s, { scripted: () => mock });
  assert.equal(p.label, 'Scripted demo · offline');
  assert.equal((await p.respond({ messages: [] })).content[0].text, 'hi');
  assert.equal((await p.test()).ok, true);

  const seen = [];
  const fetch = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ type: 'message', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }) }; };
  s.set({ 'ai.provider': 'anthropic', 'ai.key': KEY });
  const a = createProviderFromSettings(s, { scripted: () => mock, fetch });
  assert.equal(a.name, 'anthropic');
  assert.equal(a.model, PROVIDERS.anthropic.defaultModel);
  assert.equal((await a.test()).ok, true);
  assert.equal(seen[0].init.headers['x-api-key'], KEY);
  assert.ok(!JSON.stringify(a).includes(KEY), 'the provider object does not expose the key');

  s.set({ 'ai.provider': 'openai-compat', 'ai.baseUrl': 'http://localhost:11434/v1', 'ai.model': 'local-model' });
  const o = createProviderFromSettings(s, { scripted: () => mock, fetch });
  assert.equal(o.name, 'openai-compat');
  await o.test();
  assert.equal(seen[1].url, 'http://localhost:11434/v1/chat/completions');
  assert.ok(!('authorization' in seen[1].init.headers), 'no key, no Authorization header');
});

// Minimal DOM from review R3b; exercise the actual sheet's event handlers without a browser.
function sheetDOM(t) {
  class N {
    constructor(tag) { this.tag = tag; this.a = {}; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; }
    setAttribute(k, v) { this.a[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v); }
    getAttribute(k) { return this.a[k] ?? null; }
    removeAttribute(k) { delete this.a[k]; }
    get id() { return this.a.id; }
    get hidden() { return 'hidden' in this.a; }
    set hidden(v) { if (v) this.a.hidden = ''; else delete this.a.hidden; }
    append(...ns) { this.children.push(...ns); }
    get textContent() { return this.text ?? this.children.map((n) => n.textContent).join(''); }
    set textContent(v) { this.text = String(v); this.children = []; }
    addEventListener(k, f) { (this.listeners[k] ??= []).push(f); }
    remove() {}
    focus() { document.activeElement = this; }
    async fire(k) { await Promise.all((this.listeners[k] ?? []).map((f) => f({ target: this }))); }
    find(pred) { if (pred(this)) return this; for (const n of this.children) { const r = n.find(pred); if (r) return r; } return null; }
  }
  const previous = { Node: globalThis.Node, HTMLElement: globalThis.HTMLElement, document: globalThis.document };
  Object.assign(globalThis, { Node: N, HTMLElement: N, document: {
    activeElement: null, createElement: (tag) => new N(tag), createElementNS: (_, tag) => new N(tag),
    createTextNode: (text) => Object.assign(new N('#text'), { textContent: text }), addEventListener() {}, removeEventListener() {},
  } });
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } });
}
const sheetTestButton = (sheet) => sheet.el.find((n) => n.tag === 'button' && n.textContent === 'Test');
const sheetTestStatus = (sheet) => sheet.el.find((n) => n.getAttribute('class') === 'lsn-set-status');

test('H2: settings Test redacts successful model/text and thrown errors at the DOM exit', async (t) => {
  sheetDOM(t);
  const settings = createSettings({ storage: null });
  settings.set({ 'ai.provider': 'openai-compat', 'ai.model': 'm', 'ai.key': KEY });
  for (const testReply of [async () => ({ ok: true, model: KEY, text: KEY, ms: 0 }), async () => { throw Error(KEY); }]) {
    const sheet = createSettingsSheet({ settings, makeProvider: () => ({ test: testReply }) });
    await sheetTestButton(sheet).fire('click');
    assert.ok(!sheet.el.textContent.includes(KEY));
    assert.match(sheetTestStatus(sheet).textContent, /\[key\]/);
    sheet.destroy();
  }
});

test('M2: changing settings, closing or destroying the sheet invalidates an in-flight Test', async (t) => {
  sheetDOM(t);
  for (const change of ['ai.model', 'ai.key', 'ai.provider', 'ai.baseUrl', 'palette', 'close', 'destroy']) {
    for (const success of [true, false]) {
      const settings = createSettings({ storage: null });
      settings.set({ 'ai.provider': 'openai-compat', 'ai.model': 'm', 'ai.key': KEY });
      let release;
      const sheet = createSettingsSheet({ settings, makeProvider: () => ({ test: () => new Promise((r) => { release = r; }) }) });
      sheet.open();
      const pending = sheetTestButton(sheet).fire('click');
      assert.equal(sheetTestButton(sheet).disabled, true);
      if (change === 'close' || change === 'destroy') sheet[change]();
      else settings.set(change, { 'ai.model': 'different-model', 'ai.key': KEY2, 'ai.provider': 'anthropic', 'ai.baseUrl': 'https://different.example/v1', palette: 'cb-safe' }[change]);
      assert.equal(sheetTestButton(sheet).disabled, false, change);
      const status = sheetTestStatus(sheet).textContent;
      release(success ? { ok: true, model: 'old-model', text: KEY, ms: 0 } : { ok: false, error: KEY });
      await pending;
      assert.equal(sheetTestStatus(sheet).textContent, status, change);
      assert.ok(!sheet.el.textContent.includes(KEY));
      if (change !== 'destroy') sheet.destroy();
    }
  }
});

test('M6: import never throws for inherited validator names or malformed JSON values', () => {
  const s = createSettings({ storage: null });
  const envelope = (values, v = 1) => JSON.stringify({ app: 'lunar-site-navigator-settings', v, values });
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const r = s.importJson(envelope({ [name]: {}, palette: 'cb-safe' }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes(`Unknown setting ${name}`)));
    assert.equal(s.get('palette'), 'cb-safe');
    assert.equal(s.set(name, {}).ok, false);
  }
  for (const text of ['null', '[]', '{}', '"x"', envelope(null), envelope([]), envelope({}, { toString: 0, valueOf: 0 })]) {
    const r = s.importJson(text);
    assert.equal(r.ok, false, text);
    assert.ok(Array.isArray(r.applied) && Array.isArray(r.errors));
  }
  assert.equal(s.importJson({ toString() { throw Error('bad input'); } }).ok, false);
});

test('L1: initial storage read failures are not persistent; corrupt JSON and empty storage remain available', () => {
  for (const failKey of [STORAGE_KEY, KEY_STORAGE_KEY]) {
    const storage = memStorage();
    storage.getItem = (k) => { if (k === failKey) throw Error('blocked'); return null; };
    assert.equal(createSettings({ storage }).persistent, false, failKey);
  }
  const storage = memStorage();
  assert.equal(createSettings({ storage }).persistent, true);
  storage.setItem(STORAGE_KEY, '{bad');
  storage.setItem(KEY_STORAGE_KEY, '{bad');
  assert.equal(createSettings({ storage }).persistent, true);
});

test('panel alpha: default and CSS fallback match the lighter glass and the first slider input', async (t) => {
  assert.equal(PANEL_ALPHA.default, 0.40);
  const css = src('../demo/src/styles/phase5-settings.css');
  assert.equal([...css.matchAll(/var\(--lsn-panel-alpha, ([\d.]+)\)/g)].length, 2);
  for (const m of css.matchAll(/var\(--lsn-panel-alpha, ([\d.]+)\)/g)) assert.equal(Number(m[1]), PANEL_ALPHA.default);
  sheetDOM(t);
  const settings = createSettings({ storage: null });
  const sheet = createSettingsSheet({ settings });
  const range = sheet.el.find((n) => n.getAttribute('type') === 'range');
  // the default sits below the clearest end, so the user can still make the glass clearer (G)
  assert.equal(range.value, String(Math.round(((PANEL_ALPHA.max - PANEL_ALPHA.default) / (PANEL_ALPHA.max - PANEL_ALPHA.min)) * 100)));
  assert.ok(Number(range.value) < 100);
  await range.fire('input');
  assert.equal(settings.get('panelAlpha'), 0.40);
  sheet.destroy();
});
