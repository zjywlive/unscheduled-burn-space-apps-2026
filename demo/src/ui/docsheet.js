// Phase 5 (G, item 13): Evidence and Brief as large frosted reading sheets over the map, the same family as
// the site detail sheet (ui/sitesheet.js) and Settings: the same head (title, one-line subtitle, close),
// glass, radii and text scale; centred at a reading width, scrolling inside. Below 1101 px a full-screen page.
//
// createDocSheet({ name, title, subtitle, onClose }) → { el, body, open(), close({ restoreFocus }), isOpen(), setTitle(t) }
//   body: the element the caller fills (the existing Evidence or Brief section goes in it)
//   onClose(): after Esc, the close button or close()
import { h, s } from './dom.js';

const closeIcon = () => s('svg', { class: 'site-sheet-icon', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
  s('path', { d: 'M4 4l8 8M12 4l-8 8' }));

export function createDocSheet({ name, title = '', subtitle = '', onClose } = {}) {
  const id = `doc-sheet-${name}`;
  const titleEl = h('h2', { class: 'site-sheet-title', id: `${id}-title`, tabindex: '-1' }, title);
  const sub = h('p', { class: 'site-sheet-sub' }, subtitle);
  const closeBtn = h('button', { type: 'button', class: 'site-sheet-close', 'aria-label': `Close ${title || name}`, title: 'Close (Esc)' }, closeIcon());
  const body = h('div', { class: 'doc-sheet-body' });
  const el = h('section', { class: 'site-sheet doc-sheet', 'data-doc': name, role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleEl.id, hidden: true },
    h('header', { class: 'site-sheet-head' }, h('div', { class: 'site-sheet-heading' }, titleEl, sub), closeBtn),
    body);
  let opened = false, returnTo = null;

  function open() {
    if (opened) return;
    opened = true;
    const a = document.activeElement;
    returnTo = a && a !== document.body && !el.contains(a) ? a : null;
    el.hidden = false;
    el.classList.add('is-open');
    body.scrollTop = 0;
    titleEl.focus({ preventScroll: true });
  }
  function close({ restoreFocus = true } = {}) {
    if (!opened) return;
    opened = false;
    const had = el.contains(document.activeElement);
    el.hidden = true;
    el.classList.remove('is-open');
    if (restoreFocus && had && returnTo?.isConnected) returnTo.focus();
    returnTo = null;
    onClose?.();
  }
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
  closeBtn.addEventListener('click', () => close());
  return { el, body, open, close, isOpen: () => opened, setTitle(t) { titleEl.textContent = t; closeBtn.setAttribute('aria-label', `Close ${t}`); } };
}
