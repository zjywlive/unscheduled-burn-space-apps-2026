// The action bar: one frosted row at the top centre of the map. The side panel keeps the inputs and the
// data; every action of the active panel is here, so none of them needs a scroll to reach.
//
// createActionBar(doc) → { el, set(kind, source, items), activate(kind), active() }
//   kind     'point' | 'region' | 'route' (the same `kind` the side panel follows); the bar shows the items of the
//            active kind only and hides when it has none. It never hides while the kind is active and has items.
//   source   a panel's own name; several sources can fill one kind (they are separated by a divider, in the
//            order they were first set)
//   items    plain objects, in order (set() replaces all items of that source, nodes are reused so focus stays):
//     { id, label, short?, icon?, title?, primary?, pressed?, disabled?, hint?, onClick?, href?, attrs? }
//        a button (or a link when `href`; `cls` adds a class once); `pressed` boolean makes it a toggle (aria-pressed); `disabled` keeps
//        it focusable (aria-disabled) and `hint` says why in its tooltip; `short` is a shorter label for narrow
//        widths, otherwise the label hides and only the icon stays (the name stays as aria-label and tooltip)
//     { type: 'segmented', id, label, options: [{ id, label, short?, sub?, title?, disabled? }], value, hint?, onChange }
//        a chooser: the selected option is highlighted (aria-pressed); with no options it shows `hint` instead
//     { type: 'popover', id, label, text, short?, icon?, title?, disabled?, hint?, content: [...] }
//        a button showing `text` (a compact summary) that opens a small panel under the bar; Escape, a click outside
//        and a choice close it. content: { type: 'text', text, warn? } | { type: 'button', label, onClick, keepOpen?, disabled? } |
//        { type: 'rows', label, empty?, rows: [{ id, label, sub?, selected?, onClick }] }
//     { type: 'progress', id, text, pct, onCancel? }   a progress line (aria-live) with a Cancel button
//     { type: 'status', id, text }                       a short live message
//     { type: 'divider' }
import { h, s, clear } from './dom.js';

const ICONS = {
  route: 'M3 13h2a3 3 0 0 0 0-6H4a3 3 0 0 1 0-6h9M12 3l1.5-1.5M12 3l1.5 1.5',
  car: 'M2 10V8l1.5-3.5h9L14 8v2M2 10h12M2 10v2h2v-2M14 10v2h-2v-2',
  cube: 'M8 1.5l6 3v7l-6 3-6-3v-7zM2 4.5l6 3 6-3M8 7.5v7',
  fly: 'M1.5 8l13-5-5 13-2.5-5.5z',
  save: 'M3 2h8l2 2v10H3zM5 2v4h5V2M5 14v-4h6v4',
  sun: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3',
  details: 'M6 4h6v6M12 4l-7 7',
  plan: 'M2.5 8.5l3 3 8-8',
  apply: 'M2.5 8.5l3 3 8-8',
  add: 'M8 3v10M3 8h10',
  use: 'M2.5 8.5l3 3 8-8',
  clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3.2l2 1.3',
  go: 'M3 8h10M9 4l4 4-4 4',
  x: 'M4 4l8 8M12 4l-8 8',
};
const icon = (name) => (ICONS[name]
  ? s('svg', { class: 'ab-icon', width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, s('path', { d: ICONS[name] }))
  : null);

export function createActionBar(doc = document, { parent, avoid = () => [] } = {}) {
  const bar = h('div', { class: 'ab', role: 'toolbar', 'aria-label': 'Actions for the open panel' });
  const wrap = h('div', { class: 'ab-wrap', hidden: true }, bar);
  (parent ?? doc.querySelector('.app') ?? doc.body).append(wrap);
  const sources = new Map();   // kind → Map(source → items)
  const nodes = new Map();     // `${source}:${id}` → { type, el, ... }
  let kind = null;

  const guard = (fn) => (e) => { if (e.currentTarget.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; } fn?.(e); };

  function makeButton(it) {
    const el = it.href !== undefined ? h('a', { class: 'ab-btn' }) : h('button', { type: 'button', class: 'ab-btn' });
    const label = h('span', { class: 'ab-label' }), short = h('span', { class: 'ab-short' });
    el.append(label, short);
    const n = { type: 'button', el, label, short, ic: null, icName: null, fn: null };
    if (it.cls) el.classList.add(...it.cls.split(' '));
    el.addEventListener('click', guard((e) => n.fn?.(e)));
    return n;
  }
  function patchButton(n, it) {
    const { el } = n;
    n.fn = it.onClick ?? null;
    if (it.icon !== n.icName) { n.ic?.remove(); n.ic = it.icon ? icon(it.icon) : null; n.icName = it.icon; if (n.ic) el.prepend(n.ic); }
    if (n.label.textContent !== it.label) n.label.textContent = it.label;
    const short = it.short ?? (it.icon ? '' : it.label);
    if (n.short.textContent !== short) n.short.textContent = short;
    el.classList.toggle('ab-primary', !!it.primary);
    el.classList.toggle('is-disabled', !!it.disabled);
    el.classList.toggle('is-icon-only', !it.short && !!it.icon);
    if (it.disabled) el.setAttribute('aria-disabled', 'true'); else el.removeAttribute('aria-disabled');
    el.setAttribute('aria-label', it.label + (it.disabled && it.hint ? `. ${it.hint}` : ''));
    el.title = it.disabled && it.hint ? `${it.label}: ${it.hint}` : (it.title ?? it.label);
    if (it.pressed === undefined) el.removeAttribute('aria-pressed'); else el.setAttribute('aria-pressed', String(!!it.pressed));
    if (it.href !== undefined) el.setAttribute('href', typeof it.href === 'function' ? it.href() : it.href);
    for (const [k, v] of Object.entries(it.attrs ?? {})) el.setAttribute(k, v);
    n.hrefFn = typeof it.href === 'function' ? it.href : null;
  }

  function makeSegmented() {
    const el = h('div', { class: 'ab-seg', role: 'group' });
    return { type: 'segmented', el, hint: h('span', { class: 'ab-hint' }), btns: new Map(), fn: null };
  }
  function patchSegmented(n, it) {
    const { el } = n;
    n.fn = it.onChange ?? null;
    el.setAttribute('aria-label', it.label);
    const opts = it.options ?? [];
    el.classList.toggle('is-empty', !opts.length);
    if (!opts.length) {
      if (n.btns.size) { n.btns.clear(); clear(el); }
      n.hint.textContent = it.hint ?? '';
      el.title = it.hint ?? '';
      el.setAttribute('aria-disabled', 'true');
      if (n.hint.parentNode !== el) el.append(n.hint);
      return;
    }
    el.removeAttribute('aria-disabled'); el.removeAttribute('title');
    n.hint.remove();
    const keep = new Set(opts.map((o) => o.id));
    for (const [id, b] of n.btns) if (!keep.has(id)) { b.el.remove(); n.btns.delete(id); }
    opts.forEach((o, i) => {
      let b = n.btns.get(o.id);
      if (!b) {
        const name = h('span', { class: 'ab-opt-name' }), shortN = h('span', { class: 'ab-opt-short' }), sub = h('span', { class: 'ab-opt-sub num' });
        const bEl = h('button', { type: 'button', class: 'ab-opt' }, name, shortN, sub);
        bEl.addEventListener('click', guard(() => n.fn?.(o.id)));
        b = { el: bEl, name, shortN, sub };
        n.btns.set(o.id, b);
      }
      if (b.name.textContent !== o.label) b.name.textContent = o.label;
      const sh = o.short ?? o.label;
      if (b.shortN.textContent !== sh) b.shortN.textContent = sh;
      const sub = o.sub ?? '';
      if (b.sub.textContent !== sub) b.sub.textContent = sub;
      b.el.setAttribute('aria-pressed', String(o.id === it.value));
      b.el.classList.toggle('is-disabled', !!o.disabled);
      if (o.disabled) b.el.setAttribute('aria-disabled', 'true'); else b.el.removeAttribute('aria-disabled');
      b.el.setAttribute('aria-label', `${o.label}${sub ? `, ${sub}` : ''}${o.disabled && o.title ? `. ${o.title}` : ''}`);
      b.el.title = o.title ?? `${o.label}${sub ? ` ${sub}` : ''}`;
      if (el.children[i] !== b.el) el.insertBefore(b.el, el.children[i] ?? null);
    });
  }

  // ---------- popover: a trigger in the bar and a panel under it ----------
  let openNode = null;
  function closePop(focus = false) {
    if (!openNode) return;
    const n = openNode; openNode = null;
    n.panel.remove(); n.trigger.setAttribute('aria-expanded', 'false');
    if (focus) n.trigger.focus();
  }
  function placePop(n) {
    const w = wrap.getBoundingClientRect(), tr = n.trigger.getBoundingClientRect(), pw = n.panel.offsetWidth || 320;
    const left = Math.max(0, Math.min(tr.left - w.left, w.width - pw));
    n.panel.style.left = `${Math.round(left)}px`;
  }
  function fillPop(n) {
    const c = n.cur.content ?? [];
    const sig = JSON.stringify(c, (k, v) => (typeof v === 'function' ? undefined : v));
    if (sig === n.sig) return;
    n.sig = sig;
    const had = n.panel.contains(doc.activeElement) ? doc.activeElement.dataset.k : null;
    clear(n.panel);
    c.forEach((b, i) => {
      if (b.type === 'text') n.panel.append(h('p', { class: `ab-pop-text${b.warn ? ' is-warn' : ''}` }, b.text));
      else if (b.type === 'button') {
        const el = h('button', { type: 'button', class: 'ab-btn ab-pop-btn', 'data-k': `b${i}` }, b.label);
        if (b.disabled) { el.classList.add('is-disabled'); el.setAttribute('aria-disabled', 'true'); }
        el.addEventListener('click', () => { const x = n.cur.content?.[i]; if (!x || el.getAttribute('aria-disabled') === 'true') return; if (!x.keepOpen) closePop(true); x.onClick?.(); });
        n.panel.append(el);
      } else if (b.type === 'rows') {
        if (b.label) n.panel.append(h('p', { class: 'ab-pop-label' }, b.label));
        if (!b.rows?.length) { if (b.empty) n.panel.append(h('p', { class: 'ab-pop-text' }, b.empty)); return; }
        const list = h('div', { class: 'ab-pop-rows', role: 'group', 'aria-label': b.label ?? n.cur.label });
        b.rows.forEach((r, j) => {
          const el = h('button', { type: 'button', class: 'ab-pop-row', 'aria-pressed': String(!!r.selected), 'data-k': `r${i}.${j}` }, h('span', null, r.label), r.sub ? h('span', { class: 'ab-pop-sub num' }, r.sub) : null, r.selected ? h('span', { class: 'ab-pop-mark' }, 'chosen') : null);
          el.addEventListener('click', () => { const x = n.cur.content?.[i]?.rows?.[j]; closePop(true); x?.onClick?.(); });
          list.append(el);
        });
        n.panel.append(list);
      }
    });
    if (had) n.panel.querySelector(`[data-k="${had}"]`)?.focus();
  }
  function makePopover() {
    const trigger = h('button', { type: 'button', class: 'ab-btn ab-pop-trigger', 'aria-haspopup': 'true', 'aria-expanded': 'false' });
    const label = h('span', { class: 'ab-label' }), short = h('span', { class: 'ab-short' });
    trigger.append(label, short);
    const panel = h('div', { class: 'ab-pop', role: 'dialog' });
    const n = { type: 'popover', el: trigger, trigger, label, short, panel, ic: null, icName: null, cur: null, sig: null };
    trigger.addEventListener('click', () => {
      if (trigger.getAttribute('aria-disabled') === 'true') return;
      if (openNode === n) { closePop(); return; }
      closePop();
      openNode = n; trigger.setAttribute('aria-expanded', 'true'); n.sig = null; fillPop(n); wrap.append(panel); placePop(n);
      (panel.querySelector('button') ?? trigger).focus();
    });
    return n;
  }
  function patchPopover(n, it) {
    n.cur = it;
    const { trigger } = n;
    if (it.icon !== n.icName) { n.ic?.remove(); n.ic = it.icon ? icon(it.icon) : null; n.icName = it.icon; if (n.ic) trigger.prepend(n.ic); }
    if (n.label.textContent !== it.text) n.label.textContent = it.text ?? '';
    const sh = it.short ?? '';
    if (n.short.textContent !== sh) n.short.textContent = sh;
    trigger.classList.toggle('is-disabled', !!it.disabled);
    if (it.disabled) { trigger.setAttribute('aria-disabled', 'true'); if (openNode === n) closePop(); } else trigger.removeAttribute('aria-disabled');
    trigger.setAttribute('aria-label', `${it.label}: ${it.text ?? ''}${it.disabled && it.hint ? `. ${it.hint}` : ''}`);
    trigger.title = it.disabled && it.hint ? `${it.label}: ${it.hint}` : (it.title ?? it.label);
    n.panel.setAttribute('aria-label', it.label);
    if (openNode === n) { fillPop(n); placePop(n); }
  }
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openNode) { e.preventDefault(); e.stopPropagation(); closePop(true); } }, true);
  doc.addEventListener('pointerdown', (e) => { if (openNode && !openNode.panel.contains(e.target) && !openNode.trigger.contains(e.target)) closePop(); });

  function makeProgress() {
    const fill = h('span'), text = h('span', { class: 'num ab-prog-text' });
    const cancel = h('button', { type: 'button', class: 'ab-btn ab-cancel' }, 'Cancel');
    const n = { type: 'progress', fill, text, cancel, fn: null };
    cancel.addEventListener('click', () => n.fn?.());
    n.el = h('span', { class: 'ab-prog' }, h('span', { class: 'ab-prog-bar', 'aria-hidden': 'true' }, fill), h('span', { class: 'ab-live', role: 'status', 'aria-live': 'polite' }, text), cancel);
    return n;
  }
  function patchProgress(n, it) {
    n.fn = it.onCancel ?? null;
    n.cancel.hidden = !it.onCancel;
    n.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, it.pct ?? 0)).toFixed(3)})`;
    if (n.text.textContent !== it.text) n.text.textContent = it.text ?? '';
  }

  function makeStatus() { const el = h('span', { class: 'ab-status', role: 'status', 'aria-live': 'polite' }); return { type: 'status', el }; }
  function patchStatus(n, it) { if (n.el.textContent !== (it.text ?? '')) n.el.textContent = it.text ?? ''; n.el.hidden = !it.text; }

  const make = { button: makeButton, segmented: makeSegmented, popover: makePopover, progress: makeProgress, status: makeStatus, divider: () => ({ type: 'divider', el: h('span', { class: 'ab-div', 'aria-hidden': 'true' }) }) };
  const patch = { button: patchButton, segmented: patchSegmented, popover: patchPopover, progress: patchProgress, status: patchStatus, divider: () => {} };

  function render() {
    const map = kind ? sources.get(kind) : null;
    const flat = [];
    let n = 0;
    for (const [source, items] of map ?? []) {
      if (!items.length) continue;
      if (flat.length) flat.push({ key: `div:${n++}`, it: { type: 'divider' } });
      // items without an id (dividers) are numbered within their source: one shared key made a single node hop
      // between the places on every render, moving the buttons after it, so a click pressed mid-render was lost
      const seen = new Map();
      for (const it of items) {
        const base = it.id ?? it.type ?? 'button', k = seen.get(base) ?? 0;
        seen.set(base, k + 1);
        flat.push({ key: `${kind}:${source}:${base}${k ? `:${k}` : ''}`, it });
      }
    }
    wrap.hidden = !flat.length;
    layoutSoon();
    const live = new Set(flat.map((f) => f.key));
    for (const [k, node] of nodes) if (!live.has(k)) { if (openNode === node) closePop(); node.el.remove(); nodes.delete(k); }
    flat.forEach(({ key, it }, i) => {
      const type = it.type ?? 'button';
      let node = nodes.get(key);
      if (!node || node.type !== type) { node?.el.remove(); node = make[type](it); nodes.set(key, node); }
      patch[type](node, it);
      if (bar.children[i] !== node.el) bar.insertBefore(node.el, bar.children[i] ?? null);
    });
  }

  // ---------- where it sits: the free span of the map between the panels ----------
  // Its left edge is 12 px past whatever is docked on the left in the bar's band (tool rail, site list, route
  // profile), its right edge 12 px before whatever is on the right (the inspector); it is centred in that span and
  // shortens its labels (short names, then two rows of them, then icons only) to fit. Re-done when a panel appears, goes or
  // resizes, and when the window does.
  const GAP = 12;
  const watched = new Set();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => layout()) : null;
  let raf = 0;
  function layout() {
    if (wrap.hidden) return;
    const vw = doc.documentElement.clientWidth || window.innerWidth;
    const top = wrap.getBoundingClientRect().top, band = Math.max(bar.offsetHeight, 46);
    let left = GAP, right = GAP;
    for (const el of avoid()) {
      if (!el) continue;
      if (ro && !watched.has(el)) { watched.add(el); ro.observe(el); }
      if (!el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.bottom <= top || r.top >= top + band) continue;
      if (r.left + r.width / 2 < vw / 2) left = Math.max(left, r.right + GAP); else right = Math.max(right, vw - r.left + GAP);
    }
    wrap.style.left = `${Math.round(left)}px`; wrap.style.right = `${Math.round(right)}px`;
    // full names on one row, else short names on one row, else short names on two rows (labels read better than
    // bare icons), else icons on one row
    for (const [level, maxH] of [['', 50], ['is-short', 50], ['is-short', 96], ['is-icons', 50]]) {
      wrap.classList.remove('is-short', 'is-icons');
      if (level) wrap.classList.add(level);
      if (bar.offsetHeight <= maxH) break;
    }
  }
  function layoutSoon() { cancelAnimationFrame(raf); raf = requestAnimationFrame(layout); }
  window.addEventListener('resize', layoutSoon);
  doc.addEventListener('transitionend', layoutSoon);
  if (ro) ro.observe(bar);

  // a link's address is made when it is used (the mission it points at can change)
  bar.addEventListener('pointerenter', refreshLinks, true);
  bar.addEventListener('focusin', refreshLinks);
  function refreshLinks() { for (const n of nodes.values()) if (n.hrefFn) n.el.setAttribute('href', n.hrefFn()); }

  return {
    el: wrap,
    layout: layoutSoon,
    set(k, source, items) {
      if (!sources.has(k)) sources.set(k, new Map());
      sources.get(k).set(source, items ?? []);
      if (k === kind) render();
    },
    activate(k) { if (k === kind) return; closePop(); kind = k; render(); },
    active: () => kind,
  };
}
