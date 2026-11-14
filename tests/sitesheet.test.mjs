// Phase 5, S: the site detail sheet (demo/src/ui/sitesheet.js) and the sky dial's DOM (demo/src/ui/skydial.js)
// on a small fake DOM: tabs, mounting, header figures, Esc, focus in and back, ARIA wiring, cheap updates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteSheet, tabForKey, perTab, SHEET_TABS } from '../demo/src/ui/sitesheet.js';
import { createSkyDial } from '../demo/src/ui/skydial.js';
import { DIAL } from '../demo/src/skydial.js';

class FakeClassList {
  constructor(node) { this.node = node; }
  get set() { return new Set((this.node.attrs.class ?? '').split(/\s+/).filter(Boolean)); }
  write(set) { this.node.attrs.class = [...set].join(' '); }
  add(...c) { const s = this.set; c.forEach((x) => s.add(x)); this.write(s); }
  remove(...c) { const s = this.set; c.forEach((x) => s.delete(x)); this.write(s); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) { const on = force === undefined ? !this.contains(c) : !!force; if (on) this.add(c); else this.remove(c); return on; }
}

class FakeNode {
  constructor(tag, doc, text = '') {
    this.tagName = tag; this.ownerDocument = doc; this.attrs = {}; this.children = []; this.parentNode = null;
    this.listeners = {}; this.text = text; this.classList = new FakeClassList(this); this.isConnected = true; this.scrollTop = 0;
    this.style = { setProperty: (k, v) => { this.style[k] = v; } };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  get hidden() { return 'hidden' in this.attrs; }
  set hidden(v) { if (v) this.attrs.hidden = ''; else delete this.attrs.hidden; }
  get id() { return this.attrs.id ?? ''; }
  get firstChild() { return this.children[0] ?? null; }
  append(...nodes) { for (const n of nodes) { n.parentNode = this; this.children.push(n); } }
  appendChild(n) { this.append(n); return n; }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); n.parentNode = null; return n; }
  get textContent() { return this.tagName === '#text' ? this.text : this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = []; if (v !== '') this.append(new FakeNode('#text', this.ownerDocument, String(v))); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, init = {}) {
    const e = { type, target: this, defaultPrevented: false, propagationStopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...init };
    for (let n = this; n && !e.propagationStopped; n = n.parentNode) for (const fn of n.listeners[type] ?? []) fn(e);
    return e;
  }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  focus() { this.ownerDocument.activeElement = this; }
  all(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) c.all?.(pred, out); return out; }
  byClass(c) { return this.all((n) => n.classList?.contains(c)); }
}

function withDom(fn) {
  const saved = [globalThis.Node, globalThis.document];
  const doc = { activeElement: null };
  doc.createElement = (t) => new FakeNode(t, doc);
  doc.createElementNS = (ns, t) => new FakeNode(t, doc);
  doc.createTextNode = (t) => new FakeNode('#text', doc, t);
  doc.body = new FakeNode('body', doc);
  globalThis.Node = FakeNode;
  globalThis.document = doc;
  try { return fn(doc); } finally { [globalThis.Node, globalThis.document] = saved; }
}

test('tab keys and per-tab values', () => {
  assert.deepEqual(SHEET_TABS.map(([, l]) => l), ['Overview', 'Power', 'Comms', 'Compare']);
  assert.equal(tabForKey('overview', 'ArrowRight'), 'power');
  assert.equal(tabForKey('overview', 'ArrowLeft'), 'compare');
  assert.equal(tabForKey('comms', 'Home'), 'overview');
  assert.equal(tabForKey('power', 'End'), 'compare');
  assert.equal(tabForKey('power', 'a'), null);
  assert.deepEqual(perTab('x'), { overview: 'x' });
  assert.deepEqual(perTab([1]), { overview: [1] });
  assert.deepEqual(perTab({ power: [2], nope: 1 }), { power: [2] });
  assert.deepEqual(perTab(undefined), {});
});

test('site sheet: structure, ARIA, open on a tab, Esc closes and focus goes back', () => withDom((doc) => {
  const closed = [], tabsSeen = [];
  const sheet = createSiteSheet({ onClose: () => closed.push(1), onTab: (t) => tabsSeen.push(t) });
  doc.body.append(sheet.el);
  const opener = new FakeNode('button', doc); doc.body.append(opener); opener.focus();
  assert.equal(sheet.el.getAttribute('role'), 'dialog');
  assert.ok(sheet.el.hidden);
  const titleEl = sheet.el.byClass('site-sheet-title')[0];
  assert.equal(sheet.el.getAttribute('aria-labelledby'), titleEl.id);
  const tabs = sheet.el.all((n) => n.getAttribute?.('role') === 'tab');
  const panels = sheet.el.all((n) => n.getAttribute?.('role') === 'tabpanel');
  assert.deepEqual(tabs.map((t) => t.textContent), ['Overview', 'Power', 'Comms', 'Compare']);
  tabs.forEach((t, i) => { assert.equal(t.getAttribute('aria-controls'), panels[i].id); assert.equal(panels[i].getAttribute('aria-labelledby'), t.id); });

  sheet.open('power');
  assert.equal(sheet.isOpen(), true);
  assert.equal(sheet.el.hidden, false);
  assert.equal(sheet.activeTab(), 'power');
  assert.equal(doc.activeElement, tabs[1], 'focus moves to the active tab');
  assert.deepEqual(panels.map((p) => p.hidden), [true, false, true, true]);
  assert.deepEqual(tabs.map((t) => t.getAttribute('aria-selected')), ['false', 'true', 'false', 'false']);
  assert.deepEqual(tabs.map((t) => t.getAttribute('tabindex')), ['-1', '0', '-1', '-1']);

  // arrows move between tabs and take focus along
  tabs[1].dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(sheet.activeTab(), 'comms');
  assert.equal(doc.activeElement, tabs[2]);
  tabs[2].dispatch('click');
  tabs[0].dispatch('click');
  assert.equal(sheet.activeTab(), 'overview');
  assert.deepEqual(tabsSeen, ['power', 'comms', 'overview']);

  // Esc from anywhere inside closes and returns focus to the opener
  const e = tabs[0].dispatch('keydown', { key: 'Escape' });
  assert.ok(e.defaultPrevented);
  assert.equal(sheet.isOpen(), false);
  assert.ok(sheet.el.hidden);
  assert.equal(doc.activeElement, opener);
  assert.deepEqual(closed, [1]);
  sheet.close();   // closing twice does nothing
  assert.deepEqual(closed, [1]);

  // the close button
  sheet.open();
  assert.equal(sheet.activeTab(), 'overview');
  sheet.el.byClass('site-sheet-close')[0].dispatch('click');
  assert.equal(sheet.isOpen(), false);
}));

test('site sheet: header figures split by hairlines, per tab; mount keeps existing elements as they are', () => withDom((doc) => {
  const sheet = createSiteSheet();
  sheet.update({
    title: 'Shackleton ridge', subtitle: '89.45°S 137.31°W · Connecting ridge, candidate',
    headline: 'Landing 14 days later cuts time with both Sun and Earth in view from 261 h to 92 h.',
    tiles: [{ label: 'Both in view', value: '261 h', note: '92 h if +14 d', tone: 'negative' }, { label: 'Sunlit', value: '336 h', note: 'no change' }, { label: 'Earth in view', value: '261 h' }, { label: 'extra', value: 'x' }],
  });
  assert.equal(sheet.el.byClass('site-sheet-title')[0].textContent, 'Shackleton ridge');
  const over = sheet.panel('overview').parentNode;
  const tiles = over.byClass('site-sheet-tile');
  assert.equal(tiles.length, 3, 'three figures at most');
  assert.equal(tiles[0].byClass('site-sheet-tile-note')[0].classList.contains('is-negative'), true);
  assert.equal(tiles[2].byClass('site-sheet-tile-note').length, 0);
  assert.equal(over.byClass('site-sheet-headline')[0].hidden, false);
  // Power has its own figures; Comms none
  sheet.update({ tiles: { power: [{ label: 'Lowest battery level', value: '24 h' }] } });
  assert.equal(sheet.panel('power').parentNode.byClass('site-sheet-tile').length, 1);
  assert.equal(sheet.panel('comms').parentNode.byClass('site-sheet-tiles')[0].hidden, true);
  assert.equal(over.byClass('site-sheet-tile').length, 3, 'a per-tab patch leaves Overview alone');

  const pano = new FakeNode('div', doc); pano.classList.add('chart-pano');
  const card = new FakeNode('section', doc); card.classList.add('energy-card');
  const wrapped = sheet.mount('overview', pano, { title: 'Sky at the site', aside: 'follows the time bar' });
  const bare = sheet.mount('power', card);
  assert.equal(bare, card);
  assert.equal(card.parentNode, sheet.panel('power'));
  assert.equal(pano.parentNode, wrapped);
  assert.ok(wrapped.classList.contains('site-sheet-sec'));
  assert.equal(wrapped.all((n) => n.tagName === 'h3')[0].textContent, 'Sky at the site');
  assert.equal(wrapped.getAttribute('aria-labelledby'), wrapped.all((n) => n.tagName === 'h3')[0].id);
  assert.throws(() => sheet.mount('settings', pano), /no tab settings/);
}));

const SKY = Object.assign((az) => (az > 120 && az < 160 ? 3 : -1), { profile: Float32Array.from({ length: 360 }, (_, i) => (i > 120 && i < 160 ? 3 : -1)) });
const track = (az0) => ({ t: [0, 1, 2, 3, 4, 5], az: [0, 1, 2, 3, 4, 5].map((i) => az0 + i * 10), el: [1, 1, 1, 1, 1, 1] });

test('sky dial: root ignores the pointer, hollow dot behind terrain, ray to the Sun, dimmed, cheap updates', () => withDom(() => {
  const dial = createSkyDial();
  assert.ok(dial.el.classList.contains('skydial'));
  assert.equal(dial.el.style['--skydial-size'], `${DIAL.size}px`);
  const sunTrack = track(200), earthTrack = track(130);
  const now = { sun: { azDeg: 220, elDeg: 1 }, earth: { azDeg: 140, elDeg: 2 } };   // Earth below the 3° ridge
  dial.update({ skyline: SKY, sunTrack, earthTrack, stayRange: [1, 3], now, northDeg: 0 });
  const dots = dial.el.byClass('skydial-dot');
  const sun = dots.find((d) => d.classList.contains('skydial-dot-sun'));
  const earth = dots.find((d) => d.classList.contains('skydial-dot-earth'));
  assert.equal(sun.classList.contains('is-hidden'), false);
  assert.equal(earth.classList.contains('is-hidden'), true, 'Earth behind the terrain is hollow');
  const sunPaths = dial.el.byClass('skydial-track-sun')[0].children;
  assert.deepEqual(sunPaths.map((p) => p.getAttribute('class')), ['skydial-beyond', 'skydial-stay', 'skydial-beyond']);
  const ray = dial.el.byClass('skydial-ray')[0];
  const sunG = dial.el.byClass('skydial-body-sun')[0];
  const [, tx, ty] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(sunG.getAttribute('transform'));
  assert.equal(ray.getAttribute('x2'), tx); assert.equal(ray.getAttribute('y2'), ty);
  // north up: azimuth 220 is lower left
  assert.ok(Number(tx) < 0 && Number(ty) > 0);
  assert.match(dial.el.getAttribute('aria-label'), /Sun az 220\.0°, el 1\.0°, 2\.0° above skyline\. Earth az 140\.0°, el 2\.0°, 1\.0° below skyline\./);

  // the static layers are rebuilt only when their inputs change
  const before = dial.el.byClass('skydial-track-sun')[0].children[0];
  dial.update({ skyline: SKY, sunTrack, earthTrack, stayRange: [1, 3], now: { ...now, sun: { azDeg: 230, elDeg: 1 } }, northDeg: 0 });
  assert.equal(dial.el.byClass('skydial-track-sun')[0].children[0], before);
  dial.update({ skyline: SKY, sunTrack, earthTrack, stayRange: [1, 4], now, northDeg: 0 });
  assert.notEqual(dial.el.byClass('skydial-track-sun')[0].children[0], before);

  // rotating north moves the letters: N goes where the site's north points (Shackleton: 222.69°)
  dial.update({ skyline: SKY, sunTrack, earthTrack, stayRange: null, now, northDeg: 222.69, dimmed: true });
  const n = dial.el.byClass('skydial-north')[0];
  assert.ok(Number(n.getAttribute('x')) < 0 && Number(n.getAttribute('y')) > 0, 'N is down-left at Shackleton');
  assert.ok(dial.el.classList.contains('is-dimmed'));
  assert.deepEqual(dial.el.byClass('skydial-track-sun')[0].children.map((p) => p.getAttribute('class')), ['skydial-beyond'], 'no stay: all faint');

  // a body without a position is hidden, the hover tip shows the readout
  dial.update({ skyline: SKY, sunTrack, earthTrack, now: { sun: { azDeg: null, elDeg: 90 }, earth: now.earth } });
  assert.equal(sunG.getAttribute('visibility'), 'hidden');
  dial.el.byClass('skydial-body-earth')[0].children[0].dispatch('pointerenter');
  const tip = dial.el.byClass('skydial-tip')[0];
  assert.equal(tip.hidden, false);
  assert.match(tip.textContent, /Earth, behind terrainaz 140\.0°, el 2\.0°, 1\.0° below skyline/);
  dial.moveTo(400, 300);
  assert.equal(dial.el.style.transform, `translate(${400 - DIAL.size / 2}.0px, ${300 - DIAL.size / 2}.0px)`);
  dial.setVisible(false);
  assert.ok(dial.el.hidden);
}));
