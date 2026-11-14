// Floating map extras, bottom left over the map: the slope legend (a frosted chip) and the 3D preview window
// (a small frosted window with the globe in an iframe). Neither hides by itself: the legend follows the
// route colour switch, the window opens and closes with its own buttons and remembers that in storage.
//
// createMapFloats(doc) → HTMLElement                    the row both are added to (appended to the app, else the body)
// createSlopeLegend() → { el, setShown(bool) }
// createInset3d({ host, beforeOpen, onFull, storage }) → { open(), close(), toggle(), isOpen(), wanted() }
//   beforeOpen() → boolean   writes the route payload; false: nothing to show yet, the window stays shut
//   onFull()                 "Open full 3D" pressed
//   wanted()                 the remembered state (was it open last time)
import { h } from './dom.js';
import { SLOPE_BANDS } from '../slope-colours.js';

export const INSET_KEY = 'lsn-inset3d';
export const INSET_SRC = 'globe.html#route=1&embed=1';
const store = (s) => { try { return s ?? (typeof localStorage !== 'undefined' ? localStorage : null); } catch { return null; } };

export function readInsetPref(storage) { try { return store(storage)?.getItem(INSET_KEY) === '1'; } catch { return false; } }
export function writeInsetPref(on, storage) { try { store(storage)?.setItem(INSET_KEY, on ? '1' : '0'); } catch { /* storage blocked: it just does not remember */ } }

export function createMapFloats(doc = document) {
  const el = h('div', { class: 'map-floats' });
  (doc.querySelector('.app') ?? doc.body).append(el);
  return el;
}

export function createSlopeLegend() {
  const el = h('div', { class: 'slope-legend', role: 'group', 'aria-label': 'Route colour by slope', hidden: true },
    h('span', { class: 'slope-legend-title' }, 'Slope'),
    ...SLOPE_BANDS.map((b) => h('span', { class: 'slope-legend-item' }, h('i', { style: `background:${b.colour}` }), b.label)));
  return { el, setShown(on) { el.hidden = !on; } };
}

export function createInset3d({ host, beforeOpen = () => true, onFull = () => {}, storage } = {}) {
  let win = null;
  const isOpen = () => !!win;
  function open() {
    if (win) return true;
    if (!beforeOpen()) return false;
    const close = h('button', { type: 'button', class: 'inset3d-btn', 'aria-label': 'Close the 3D preview', title: 'Close the 3D preview', onclick: () => api.close() }, '×');
    const full = h('button', { type: 'button', class: 'inset3d-btn inset3d-full', onclick: () => onFull() }, 'Open full 3D');
    const frame = h('iframe', { class: 'inset3d-frame', title: '3D preview of the route', src: INSET_SRC, loading: 'eager', allow: 'fullscreen' });
    win = h('aside', { class: 'inset3d', 'aria-label': '3D preview' }, h('div', { class: 'inset3d-bar' }, h('span', { class: 'inset3d-title' }, '3D preview'), full, close), frame);
    host.prepend(win);
    writeInsetPref(true, storage);
    return true;
  }
  function close() {
    if (!win) return;
    win.remove();   // the iframe goes with it: the globe's WebGL is freed
    win = null;
    writeInsetPref(false, storage);
  }
  const api = { open, close, toggle() { return isOpen() ? (close(), false) : open(); }, isOpen, wanted: () => readInsetPref(storage) };
  return api;
}
