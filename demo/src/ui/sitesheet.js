// The site detail sheet (phase 5, S): the old Navigator page as a frosted sheet on the right of the map,
// with tabs Overview / Power / Comms / Compare. It is only a container: the caller mounts the existing
// pieces (Sky at the site, Elevation over the stay, Rises and sets, Planned vs alternative, the energy and
// relay cards) into the tabs with mount(). Header: title, subtitle, close. Each tab may open with a
// headline sentence and up to three figures split by hairlines. Esc closes; focus moves in on open and
// back on close; the tabs follow the ARIA tabs pattern (arrows, Home, End).
import { h, s, clear } from './dom.js';

export const SHEET_TABS = [['overview', 'Overview'], ['power', 'Power'], ['comms', 'Comms'], ['compare', 'Compare']];
const TAB_NAMES = SHEET_TABS.map(([k]) => k);
let uid = 0;

// The tab after `name` for a key press, or null when the key does not move between tabs.
export function tabForKey(name, key) {
  const i = TAB_NAMES.indexOf(name);
  if (i < 0) return null;
  const n = TAB_NAMES.length;
  if (key === 'ArrowRight') return TAB_NAMES[(i + 1) % n];
  if (key === 'ArrowLeft') return TAB_NAMES[(i - 1 + n) % n];
  if (key === 'Home') return TAB_NAMES[0];
  if (key === 'End') return TAB_NAMES[n - 1];
  return null;
}

// `headline` and `tiles` may be given for Overview alone (a string, an array) or per tab
// ({ overview: …, power: … }). Returns { tab: value } for the tabs the patch names.
export function perTab(value) {
  if (value === undefined) return {};
  if (value === null || typeof value === 'string' || Array.isArray(value)) return { overview: value };
  const out = {};
  for (const k of TAB_NAMES) if (k in value) out[k] = value[k];
  return out;
}

function tileEl(tile) {
  const tone = tile.tone === 'negative' ? ' is-negative' : tile.tone === 'positive' ? ' is-positive' : '';
  return h('div', { class: 'site-sheet-tile' },
    h('span', { class: 'site-sheet-tile-label' }, tile.label ?? ''),
    h('b', { class: 'site-sheet-tile-value num' }, tile.value ?? ''),
    tile.note ? h('span', { class: `site-sheet-tile-note num${tone}` }, tile.note) : null);
}

const closeIcon = () => s('svg', { class: 'site-sheet-icon', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
  s('path', { d: 'M4 4l8 8M12 4l-8 8' }));

export function createSiteSheet({ onClose, onTab } = {}) {
  const id = `site-sheet-${++uid}`;
  const title = h('h2', { class: 'site-sheet-title', id: `${id}-title`, tabindex: '-1' }, 'Site');
  const subtitle = h('p', { class: 'site-sheet-sub num' });
  const closeBtn = h('button', { type: 'button', class: 'site-sheet-close', 'aria-label': 'Close details', title: 'Close (Esc)' }, closeIcon());
  const tablist = h('div', { class: 'site-sheet-tabs', role: 'tablist', 'aria-labelledby': `${id}-title` });
  const body = h('div', { class: 'site-sheet-body' });
  const tabs = {};
  for (const [key, label] of SHEET_TABS) {
    const btn = h('button', {
      type: 'button', class: 'site-sheet-tab', role: 'tab', id: `${id}-tab-${key}`, 'aria-controls': `${id}-panel-${key}`,
      'aria-selected': 'false', tabindex: '-1', 'data-tab': key,
    }, label);
    const headline = h('p', { class: 'site-sheet-headline', hidden: true });
    const tiles = h('div', { class: 'site-sheet-tiles', hidden: true });
    const slot = h('div', { class: 'site-sheet-slot' });
    const panel = h('div', { class: 'site-sheet-panel', role: 'tabpanel', id: `${id}-panel-${key}`, 'aria-labelledby': btn.id, tabindex: '0', hidden: true },
      headline, tiles, slot);
    btn.addEventListener('click', () => setTab(key, { focus: false }));
    tablist.append(btn);
    body.append(panel);
    tabs[key] = { btn, panel, headline, tiles, slot };
  }
  const el = h('section', { class: 'site-sheet', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': `${id}-title`, hidden: true },
    h('header', { class: 'site-sheet-head' }, h('div', { class: 'site-sheet-heading' }, title, subtitle), closeBtn),
    tablist,
    body);

  let active = 'overview';
  let opened = false;
  let returnTo = null;

  function setTab(name, { focus = false } = {}) {
    if (!tabs[name]) return;
    const changed = name !== active;
    active = name;
    for (const [key, t] of Object.entries(tabs)) {
      const on = key === name;
      t.btn.setAttribute('aria-selected', String(on));
      t.btn.setAttribute('tabindex', on ? '0' : '-1');
      t.btn.classList.toggle('is-active', on);
      t.panel.hidden = !on;
    }
    body.scrollTop = 0;
    if (focus) tabs[name].btn.focus();
    if (changed) onTab?.(name);
  }

  function open(tab) {
    if (tab && tabs[tab]) setTab(tab);
    else setTab(active);
    if (opened) { tabs[active].btn.focus(); return; }
    opened = true;
    const doc = el.ownerDocument ?? globalThis.document;
    const prev = doc?.activeElement ?? null;
    returnTo = prev && !el.contains(prev) ? prev : null;
    el.hidden = false;
    el.classList.add('is-open');
    tabs[active].btn.focus();
  }

  function close({ restoreFocus = true } = {}) {
    if (!opened) return;
    opened = false;
    const hadFocus = el.contains(el.ownerDocument?.activeElement ?? null);
    el.classList.remove('is-open');
    el.hidden = true;
    if (restoreFocus && hadFocus && returnTo && returnTo.isConnected !== false) returnTo.focus?.();
    returnTo = null;
    onClose?.();
  }

  function update({ title: t, subtitle: sub, headline, tiles } = {}) {
    if (t !== undefined) title.textContent = t ?? '';
    if (sub !== undefined) { subtitle.textContent = sub ?? ''; subtitle.hidden = !sub; }
    for (const [key, text] of Object.entries(perTab(headline))) {
      tabs[key].headline.textContent = text ?? '';
      tabs[key].headline.hidden = !text;
    }
    for (const [key, list] of Object.entries(perTab(tiles))) {
      const box = tabs[key].tiles;
      clear(box);
      for (const tile of (list ?? []).slice(0, 3)) box.append(tileEl(tile));
      box.hidden = !list || list.length === 0;
    }
  }

  // Puts an existing element into a tab, after what is there. With `title` it is wrapped in a section with
  // a small heading (and `aside`, a short note or legend on the right of the heading). Returns the element
  // that went into the tab, so the caller can hide or remove it.
  function mount(tabName, element, { title: secTitle, aside } = {}) {
    const t = tabs[tabName];
    if (!t) throw new Error(`site sheet has no tab ${tabName}`);
    let node = element;
    if (secTitle) {
      const hid = `${id}-sec-${++uid}`;
      node = h('section', { class: 'site-sheet-sec', 'aria-labelledby': hid },
        h('div', { class: 'site-sheet-sec-head' }, h('h3', { id: hid }, secTitle), aside ? h('span', { class: 'site-sheet-sec-aside' }, aside) : null),
        element);
    }
    t.slot.append(node);
    return node;
  }

  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    const onTabBtn = e.target?.getAttribute?.('role') === 'tab';
    if (onTabBtn) {
      const next = tabForKey(active, e.key);
      if (next) { e.preventDefault(); setTab(next, { focus: true }); }
    }
  });
  closeBtn.addEventListener('click', () => close());

  setTab('overview');
  return {
    el, open, close, update, setTab: (name) => setTab(name), mount,
    isOpen: () => opened, activeTab: () => active, panel: (name) => tabs[name]?.slot ?? null,
  };
}
