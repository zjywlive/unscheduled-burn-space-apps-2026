// The guided tour (phase 3 §4.9), drawn by the vendored driver.js, loaded on first start with a classic
// <script src>. Each step highlights the first element found among its data-tour targets; a step whose
// targets are all missing or hidden is skipped. The first-visit prompt is a small non-blocking card.
//
// createTour({ steps, onDone, vendorBase, storageKey, returnTo }) → { start(), stop(), isActive(), seen(), showPrompt(parent?), hidePrompt() }
// A step may carry prepare(): run before its target is highlighted (e.g. open a folded card).
import { h } from './dom.js';
import { loadScript, loadStyle } from '../agent/vendor.js';

export const TOUR_STORAGE_KEY = 'lsn-tour-v3';

export const TOUR_STEPS = [
  { targets: ['modes', 'map'], title: 'Map and modes', text: 'The map shows the lunar south pole south of 80°S. The modes switch what the colour means: Live (the light at the playhead), or over the mission window Sun, Earth, both, change or suitability.' },
  { targets: ['map'], title: 'Hover and pick', text: 'Move the pointer near a site or a best cell to see its figures. Click to make a point the selected site; double-click to zoom in.' },
  { targets: ['zoom'], title: 'Zoom', text: 'Use + and − in the corner of the map, or scroll over it (in a narrow window, hold Ctrl or ⌘ while you scroll). The terrain sharpens as finer elevation loads. The zoom level button goes back to the whole map.' },
  { targets: ['tools'], title: 'Draw a region', text: 'The tools at the top left of the map draw a rectangle, circle or polygon for region figures, or a route for a profile. Draw a second region in slot B to compare the two.' },
  { targets: ['filters', 'weights'], title: 'Layers', text: 'Layers holds the filters that rule out steep ground or long darkness, the map overlays and, in Suitability mode, the weights.', side: 'bottom', align: 'center' },
  { targets: ['ribbon'], title: 'Time bar', text: 'Play the light over the map in any mode. The strip shades each landing day by the hours with both Sun and Earth in view; drag In and Out to set the mission window, or step between rises and sets.' },
  { targets: ['ask'], title: 'Ask', text: 'Ask questions in plain words. In this demo the answers are scripted, and every figure comes from the page’s own commands.' },
];

function safeGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* private mode or blocked storage: the tour still works */ }
}

function visible(el) {
  if (!el || !el.isConnected) return false;
  if (el.closest('[hidden]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// Steps whose target is on the page, with the element resolved.
export function resolveSteps(steps, root = document) {
  const out = [];
  for (const step of steps) {
    const el = step.targets.map((t) => root.querySelector(`[data-tour="${t}"]`)).find(visible);
    if (el) out.push({ ...step, el });
  }
  return out;
}

export function createTour({ steps = TOUR_STEPS, onDone = () => {}, vendorBase = 'vendor/', storageKey = TOUR_STORAGE_KEY, returnTo = '[data-action="tour"]' } = {}) {
  let driver = null;
  let returnFocus = null;
  let prompt = null;

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  async function start() {
    if (driver?.isActive()) { hidePrompt(); return; }
    // Where focus goes back afterwards. Read it before the prompt goes: its Start button is about to be
    // removed, and focus would end on <body> (review UI I4). Then fall back to the Tour button.
    const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    returnFocus = active && !(prompt && prompt.contains(active)) ? active : document.querySelector(returnTo);
    hidePrompt();
    safeSet(storageKey, 'started');
    await Promise.all([
      loadStyle(`${vendorBase}driver.css`),
      loadScript(`${vendorBase}driver.js.iife.js`, { ready: () => Boolean(window.driver?.js?.driver) }),
    ]);
    const live = resolveSteps(steps);
    if (!live.length) { onDone({ reason: 'empty' }); return; }
    const calm = reducedMotion();
    driver = window.driver.js.driver({
      steps: live.map((s, i) => ({
        element: s.el,
        popover: {
          title: s.title, description: s.text,
          ...(s.side ? { side: s.side, align: s.align ?? 'start' } : {}),
          ...(i === live.length - 1 ? { doneBtnText: 'Done' } : {}),
        },
        prepare: s.prepare,
      })),
      animate: !calm,
      smoothScroll: !calm,
      allowKeyboardControl: true,
      allowClose: true,
      overlayColor: '#000',
      overlayOpacity: 0.6,
      stagePadding: 6,
      stageRadius: 20,   // --radius-card
      popoverOffset: 12,
      popoverClass: 'lsn-tour',
      showProgress: true,
      progressText: '{{current}} of {{total}}',
      nextBtnText: 'Next',
      prevBtnText: 'Back',
      doneBtnText: 'Done',
      closeBtnLabel: 'Close tour',
      skipMissingElement: true,
      // Bring the target to the middle of the viewport before driver.js places the popover; placing it
      // during a smooth scroll left the Filters popover far from its card (review UI I6). Then refresh
      // once the highlight has settled so the popover follows the final position.
      // (only the page scrolls: scrollIntoView would also slide a sideways-scrolling row such as the modes)
      onHighlightStarted: (el, step) => {
        step?.prepare?.();
        const r = el?.getBoundingClientRect?.();
        if (r) window.scrollBy(0, r.top + r.height / 2 - window.innerHeight / 2);
      },
      onHighlighted: () => { setTimeout(() => driver?.refresh(), 0); },
      onPopoverRender: (popover) => {
        popover.wrapper.setAttribute('role', 'dialog');
        popover.wrapper.setAttribute('aria-labelledby', 'driver-popover-title');
        popover.title.id = 'driver-popover-title';
        popover.closeButton.textContent = '×';
        popover.closeButton.setAttribute('aria-label', 'Close tour');
        popover.closeButton.setAttribute('title', 'Close the tour (Esc)');
        // Keep keyboard focus with the tour: the primary button takes it on every step.
        setTimeout(() => (popover.nextButton.isConnected ? popover.nextButton : popover.closeButton).focus({ preventScroll: true }), 0);
      },
      onDestroyed: (el, step, opts) => {
        const r = opts?.reason ?? 'close';
        driver = null;
        if (r === 'done') safeSet(storageKey, 'done');
        const back = returnFocus && returnFocus.isConnected ? returnFocus : document.querySelector(returnTo);
        back?.focus();
        returnFocus = null;
        onDone({ reason: r });
      },
    });
    driver.drive();
  }

  function stop() {
    if (driver?.isActive()) driver.destroy();
  }

  function hidePrompt() {
    if (prompt) { prompt.remove(); prompt = null; }
  }

  // The first-visit card. Returns false when the visitor has already chosen (or storage says so).
  function showPrompt(parent = document.body) {
    if (safeGet(storageKey) || prompt) return false;
    const startBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { start(); } }, 'Start tour');
    const laterBtn = h('button', { type: 'button', class: 'btn', onclick: () => { safeSet(storageKey, 'dismissed'); hidePrompt(); } }, 'Not now');
    prompt = h('div', { class: 'tour-prompt', role: 'region', 'aria-label': 'Tour', 'data-tour-prompt': '' },
      h('p', null, 'New here? Take the 1-minute tour.'),
      h('div', { class: 'tour-prompt-actions' }, startBtn, laterBtn));
    parent.append(prompt);
    return true;
  }

  return {
    start,
    stop,
    isActive: () => Boolean(driver?.isActive()),
    seen: () => Boolean(safeGet(storageKey)),
    showPrompt,
    hidePrompt,
  };
}
