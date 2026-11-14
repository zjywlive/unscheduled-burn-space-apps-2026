// Phase 6 B (mock docs/phase4/mock/personas.html?s=tour and ?s=story): the Tour button's menu (three stories
// and the original Tour of the controls) and, while a story runs, the card above the time bar, the dimming of
// the controls the story does not use, and the view side of each step (time bar marks, dial focus, lit
// inspector parts, a viewport that keeps the dial clear of the card). The steps themselves are run by
// ../story-controller.js through the page's command layer; this module is the DOM.
//
// createStoryMode(host) → { controller, openMenu(), closeMenu(), toggleMenu(), menuOpen(), card, menu }
// host: { app, tourButton, commands, api, timeline, dock, dial, mapView, sheet, settingsSheet, panel, settings,
//         facts(), reduced(), startControlsTour(), setHashFrozen(on), getKind(), setKind(kind, tool),
//         siteKm(site) → [x, y], dialRadius }
import { h, clear } from './dom.js';
import { STORIES } from '../stories.js';
import { createStoryController } from '../story-controller.js';

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], deep-chat, [role="slider"]';
const closeIcon = () => {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M4 4l8 8M12 4l-8 8'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.5'); p.setAttribute('stroke-linecap', 'round');
  svg.append(p);
  return svg;
};

export function createStoryMode(host) {
  const { app, tourButton, timeline, dock, mapView } = host;
  let dial = host.dial ?? null;   // the sky dial is made after the menu; setDial hands it over

  // ---------- the card ----------
  const kicker = h('span', { class: 'story-kicker' });
  const count = h('span', { class: 'story-count num' });
  const closeBtn = h('button', { type: 'button', class: 'story-close', 'aria-label': 'Close the story', title: 'Close the story (Esc)', onclick: () => stop() }, closeIcon());
  const title = h('h2', { class: 'story-title', id: 'lsn-story-title', tabindex: '-1' });
  const body = h('p', { class: 'story-text', id: 'lsn-story-text' });
  const dots = h('span', { class: 'story-dots', 'aria-hidden': 'true' });
  const backBtn = h('button', { type: 'button', class: 'story-btn', 'data-story-nav': 'back', onclick: () => back() }, 'Back');
  const nextBtn = h('button', { type: 'button', class: 'story-btn story-btn-pri', 'data-story-nav': 'next', onclick: () => next() }, 'Next');
  const live = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const card = h('section', { class: 'story-card', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': title.id, 'aria-describedby': body.id, hidden: true },
    h('div', { class: 'story-hd' }, kicker, count, closeBtn), title, body,
    h('div', { class: 'story-ft' }, dots, backBtn, nextBtn), live);
  app.append(card);

  // ---------- the menu under the Tour button ----------
  tourButton.setAttribute('aria-haspopup', 'menu');
  tourButton.setAttribute('aria-expanded', 'false');
  tourButton.setAttribute('aria-controls', 'lsn-tour-menu');
  tourButton.append(h('span', { class: 'tour-caret', 'aria-hidden': 'true' }));
  const items = STORIES.map((s, i) => h('button', { type: 'button', class: 'tour-item', role: 'menuitem', tabindex: '-1', 'data-story-pick': String(i + 1), onclick: () => { closeMenu(false); start(s.id); } },
    h('span', { class: 'tour-item-n num', 'aria-hidden': 'true' }, String(i + 1)),
    h('span', { class: 'tour-item-text' }, s.title, h('span', { class: 'tour-item-sub' }, s.subtitle))));
  const controlsItem = h('button', { type: 'button', class: 'tour-item', role: 'menuitem', tabindex: '-1', 'data-story-pick': 'controls', onclick: () => { if (controller.isActive()) stop(); closeMenu(true); host.startControlsTour(); } },   // focus on Tour first: the tour returns it there
    h('span', { class: 'tour-item-n', 'aria-hidden': 'true' }, cursorIcon()),
    h('span', { class: 'tour-item-text' }, 'Tour of the controls', h('span', { class: 'tour-item-sub' }, 'What each panel and button does')));
  const menuItems = [...items, controlsItem];
  const menu = h('div', { class: 'tour-menu', id: 'lsn-tour-menu', role: 'menu', 'aria-label': 'Tour', hidden: true },
    h('p', { class: 'tour-menu-head', role: 'presentation' }, 'Stories · about 2 minutes each'),
    ...items, h('div', { class: 'tour-sep', role: 'separator' }), controlsItem);
  tourButton.parentElement.style.position = 'relative';
  tourButton.after(menu);

  function cursorIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '12'); svg.setAttribute('height', '12');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M4 2l8 6-3.5.8L7 12z'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.4'); p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
    return svg;
  }

  const menuOpen = () => !menu.hidden;
  function openMenu() {
    menu.hidden = false;
    tourButton.setAttribute('aria-expanded', 'true');
    host.facts().catch(() => {});   // start the figures now; a story waits for them anyway
    menuItems[0].focus();
  }
  function closeMenu(focusButton = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    tourButton.setAttribute('aria-expanded', 'false');
    if (focusButton) tourButton.focus();
  }
  function toggleMenu() { if (menuOpen()) closeMenu(); else openMenu(); }
  menu.addEventListener('keydown', (e) => {
    const i = menuItems.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      menuItems[(i + (e.key === 'ArrowDown' ? 1 : menuItems.length - 1)) % menuItems.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault(); menuItems[e.key === 'Home' ? 0 : menuItems.length - 1].focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); }
      closeMenu(e.key === 'Escape');
    }
  });
  document.addEventListener('pointerdown', (e) => { if (menuOpen() && !menu.contains(e.target) && !tourButton.contains(e.target)) closeMenu(false); }, true);

  // ---------- the view side of the controller ----------
  let lit = [], litNames = [];
  function clearLit() { for (const el of lit) el.classList.remove('story-lit'); lit = []; }
  function light(el) { if (el) { el.classList.add('story-lit'); lit.push(el); } }
  function applyLit(names, { scroll = true } = {}) {
    litNames = names;
    clearLit();
    const insp = app.querySelector('.card-point');
    if (!insp) return;
    for (const n of names) {
      if (n.startsWith('row:')) {
        const tr = [...insp.querySelectorAll('.point-table tbody tr')].find((r) => r.dataset.row === n.slice(4));
        if (tr) for (const c of tr.children) light(c);
      } else if (n === 'col:planned') {
        for (const c of insp.querySelectorAll('.point-table tr > :nth-child(2)')) light(c);
      } else {
        light(insp.querySelector(`[data-story="${n}"]`));
      }
    }
    if (lit.length && scroll) {
      // the lit part in view inside the inspector's own scroll
      const panel = app.querySelector('.point-panel');
      const r = lit[0].getBoundingClientRect(), p = panel?.getBoundingClientRect();
      if (p && (r.top < p.top || r.bottom > p.bottom)) lit[0].scrollIntoView?.({ block: 'nearest' });
    }
  }

  // Keep the sky dial whole and above the card: zoom in a little only when panning is needed (at 1× the view
  // cannot pan), then pan so the dial sits over the card's centre line and clear of the bars.
  function placeDial() {
    if (!mapView?.layoutBig || card.hidden) return;
    const R = host.dialRadius + 8;
    for (let pass = 0; pass < 3; pass++) {
      const st = host.api.getState();
      const [x, y] = host.siteKm(st.site);
      const p = mapView.frame.toPx(x, y);
      const frameBox = mapView.frame.el.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const top = (app.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 56) + 8;
      const insp = app.querySelector('.point-panel')?.getBoundingClientRect();
      const left = (app.querySelector('.map-toolcol')?.getBoundingClientRect().right ?? 0) + 8;
      const right = insp && insp.width ? insp.left - 8 : window.innerWidth - 8;
      const px = frameBox.left + p[0], py = frameBox.top + p[1];
      const want = (lo, hi, v, mid) => (hi - lo < 0 ? mid : Math.min(hi, Math.max(lo, v)));
      const ty = want(top + R, c.top - R, py, (top + c.top) / 2);
      const tx = want(left + R, right - R, px, c.left + c.width / 2);
      if (Math.abs(ty - py) < 2 && Math.abs(tx - px) < 2) return;
      const v = st.viewport;
      if (v.zoom < 1.5) { host.api.update({ viewport: { ...v, zoom: 1.5 } }); continue; }
      // screen px per km along x and y here, then the km the centre moves for the wanted shift
      const ax = mapView.frame.toPx(x + 1, y), ay = mapView.frame.toPx(x, y + 1);
      const a = [ax[0] - p[0], ax[1] - p[1]], b = [ay[0] - p[0], ay[1] - p[1]];
      const det = a[0] * b[1] - a[1] * b[0];
      if (!det) return;
      const dx = -(tx - px), dy = -(ty - py);   // the centre moves the other way from the point
      const kx = (dx * b[1] - dy * b[0]) / det, ky = (a[0] * dy - a[1] * dx) / det;
      host.api.update({ viewport: { ...v, cx: v.cx + kx, cy: v.cy + ky } });
    }
  }

  const view = {
    snapshot() {
      return {
        panels: mapView?.getPanels?.() ?? null,
        sheetTab: host.sheet?.isOpen() ? host.sheet.activeTab() : null,
        settings: Boolean(host.settingsSheet?.isOpen()),
        ask: Boolean(host.panel?.isOpen()),
        dial: host.settings.get('skyDial'),
        dockView: dock.getView(),
        kind: host.getKind(), tool: host.api.getState().tool,
        focus: document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null,
      };
    },
    enter() {
      host.setHashFrozen(true);
      if (host.sheet?.isOpen()) host.sheet.close({ restoreFocus: false });
      if (host.settingsSheet?.isOpen()) host.settingsSheet.close();
      if (host.panel?.isOpen()) host.panel.close();
      host.setKind('point', 'select');
      mapView?.setPanels?.(false, true);
      app.dataset.story = 'on';
      tourButton.setAttribute('aria-pressed', 'true');
      card.hidden = false;
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', placeDial);
    },
    show(plan) {
      const story = STORIES.find((s) => s.id === plan.story);
      kicker.textContent = `Story · ${story.title}`;
      count.textContent = `${plan.index + 1} / ${plan.count}`;
      title.textContent = plan.title;
      body.textContent = plan.text;
      card.dataset.story = plan.story;
      card.dataset.step = String(plan.index + 1);
      clear(dots);
      for (let i = 0; i < plan.count; i++) dots.append(h('i', { class: i === plan.index ? 'is-on' : null }));
      backBtn.disabled = plan.index === 0;
      nextBtn.textContent = plan.index === plan.count - 1 ? 'Done' : 'Next';
      live.textContent = `Step ${plan.index + 1} of ${plan.count}: ${plan.title}. ${plan.text}`;
      dock.update({ viewRange: plan.viewRange, marks: plan.marks, focus: plan.focus });
      dial?.setFocus(plan.dial);
      applyLit(plan.lit);
      placeDial();
    },
    leave() {
      litNames = [];
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', placeDial);
      card.hidden = true;
      delete app.dataset.story;
      tourButton.removeAttribute('aria-pressed');
      dock.update({ viewRange: null, marks: [], focus: null });
      dial?.setFocus(null);
      clearLit();
    },
    restore(s) {
      if (s.panels) mapView?.setPanels?.(s.panels.left, s.panels.right);
      if (host.settings.get('skyDial') !== s.dial) host.settings.set('skyDial', s.dial);
      host.setKind(s.kind, s.tool);
      dock.setView(s.dockView);
      host.setHashFrozen(false);
      if (s.sheetTab) host.openSheet(s.sheetTab);
      else if (s.settings) host.settingsSheet.open(host.settingsButton);
      else if (s.ask) host.panel.open(host.askButton);
      (s.focus?.isConnected && !card.contains(s.focus) && !menu.contains(s.focus) ? s.focus : tourButton).focus?.({ preventScroll: true });
    },
  };

  const controller = createStoryController({
    commands: host.commands, api: host.api, timeline, view, facts: host.facts, reduced: host.reduced,
  });

  // ---------- actions ----------
  let busy = Promise.resolve();
  const queue = (fn) => (busy = busy.then(fn, fn).catch((e) => { console.warn('story:', e?.message ?? e); }));
  function start(id) {
    return queue(async () => {
      const r = await controller.start(id);
      if (!r.ok) { notice(r.reason); return; }
      nextBtn.focus({ preventScroll: true });
    });
  }
  function next() {
    return queue(async () => {
      const cur = controller.current();
      if (!cur) return;
      if (cur.index >= cur.plan.count - 1) { stop(); return; }
      await controller.next();
      if (document.activeElement === backBtn || !card.contains(document.activeElement)) nextBtn.focus({ preventScroll: true });
    });
  }
  function back() {
    return queue(async () => {
      await controller.back();
      if (backBtn.disabled) nextBtn.focus({ preventScroll: true });
    });
  }
  function stop() { return controller.stop(); }
  // a story that cannot run says so in the card, with only Close
  function notice(text) {
    if (controller.isActive()) return;
    card.hidden = false;
    kicker.textContent = 'Story';
    count.textContent = '';
    title.textContent = 'This story is not available';
    body.textContent = text ?? 'The figures could not be computed.';
    clear(dots);
    backBtn.disabled = true;
    nextBtn.textContent = 'Close';
    nextBtn.onclick = () => { card.hidden = true; nextBtn.onclick = () => next(); tourButton.focus(); };
    nextBtn.focus();
  }

  function onKey(e) {
    if (!controller.isActive() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target?.closest?.(EDITABLE) || menu.contains(e.target)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); back(); }
  }

  return {
    setDial: (d) => { dial = d; },
    // after the inspector is drawn again: light the same parts in the new rows
    relight: () => { if (controller.isActive() && litNames.length) applyLit(litNames, { scroll: false }); },
    controller, card, menu, openMenu, closeMenu, toggleMenu, menuOpen, start, next, back, stop, freeze: () => controller.freeze(), current: () => controller.current() };
}
