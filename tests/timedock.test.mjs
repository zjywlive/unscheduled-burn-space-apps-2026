// Phase 5 P: the time dock's pure parts (demo/src/ui/timedock.js): clock and summary text, layout
// fractions, shortcuts, the status throttle, the datetime field. The DOM side is exercised in headless
// Chrome by docs/phase5/p-scripts/check.mjs against docs/phase5/harness/P.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtClock, fmtStay, fmtSlip, fmtWindowSummary, fmtDateTime, fmtMonth, eventName, toInputValue, fromInputValue,
  dockLayout, keyCommand, createThrottle, STATUS_INTERVAL_MS, createTimeDock,
} from '../demo/src/ui/timedock.js';
import { windowWithIn, windowWithOut, dragHandle, HOUR_MS, DAY_MS, createTimeline, viewRange, fromFraction } from '../demo/src/timeline.js';
import { loadCoreContext } from '../tools/core-context.mjs';

const START = Date.UTC(2026, 10, 1), END = Date.UTC(2029, 0, 1);
const IN = Date.UTC(2027, 0, 13, 6), OUT = IN + 14 * DAY_MS;
const W = { inMs: IN, outMs: OUT };

test('timedock: the clock reads the day of the stay inside the window, UTC outside it', () => {
  assert.equal(fmtClock({ nowMs: IN + 5 * DAY_MS + 8 * HOUR_MS, window: W }), 'Day 6 14:00 · 18 Jan 2027');
  assert.equal(fmtClock({ nowMs: IN, window: W }), 'Day 1 06:00 · 13 Jan 2027');
  assert.equal(fmtClock({ nowMs: Date.UTC(2027, 0, 13, 23, 59), window: W }), 'Day 1 23:59 · 13 Jan 2027');
  assert.equal(fmtClock({ nowMs: Date.UTC(2027, 0, 14), window: W }), 'Day 2 00:00 · 14 Jan 2027');
  assert.equal(fmtClock({ nowMs: Date.UTC(2027, 0, 11, 6), window: W }), '11 Jan 2027 06:00 UTC');
  assert.equal(fmtClock({ nowMs: Date.UTC(2027, 0, 11, 6), window: null }), '11 Jan 2027 06:00 UTC');
  assert.equal(fmtDateTime(START), '1 Nov 2026 00:00 UTC');
  assert.equal(fmtMonth(START), 'Nov 2026');
  assert.equal(fmtMonth(END), 'Jan 2029');
});

test('timedock: stay, slip and the window summary', () => {
  assert.equal(fmtStay(14 * DAY_MS), '14 d');
  assert.equal(fmtStay(9 * DAY_MS + 13 * HOUR_MS), '9 d 13 h');
  assert.equal(fmtStay(20 * HOUR_MS), '20 h');
  assert.equal(fmtSlip(14), 'alt +14 d');
  assert.equal(fmtSlip(-7), 'alt −7 d');
  assert.equal(fmtSlip(0), 'alt same day');
  assert.equal(fmtWindowSummary(W, 14), '13 Jan 2027 · 14 d · alt +14 d');
  assert.equal(fmtWindowSummary(W, 14, { short: true }), '13 Jan · 14 d');
  assert.equal(fmtWindowSummary(W, null), '13 Jan 2027 · 14 d');
  assert.equal(fmtWindowSummary(null, 14), '');
  assert.deepEqual([{ body: 'sun', kind: 'rise' }, { body: 'sun', kind: 'set' }, { body: 'earth', kind: 'rise' }, { body: 'earth', kind: 'set' }].map(eventName),
    ['Sunrise', 'Sunset', 'Earthrise', 'Earthset']);
});

test('timedock: the landing field round-trips in UTC', () => {
  assert.equal(toInputValue(IN), '2027-01-13T06:00');
  assert.equal(fromInputValue('2027-01-13T06:00'), IN);
  assert.equal(fromInputValue('2027-03-02T12:30:00'), Date.UTC(2027, 2, 2, 12, 30));
  assert.equal(fromInputValue(''), null);
  assert.equal(fromInputValue(undefined), null);
  assert.equal(fromInputValue('13/01/2027'), null);
});

test('timedock: layout fractions for the window view, the whole view and no window', () => {
  const st = { startMs: START, endMs: END, nowMs: IN + 7 * DAY_MS, window: W };
  const L = dockLayout(st, 'window', { slipDays: 14, events: [{ tMs: IN + DAY_MS, body: 'earth', kind: 'set' }, START] });
  assert.ok(Math.abs(L.win.left - 0.2) < 1e-9 && Math.abs(L.win.right - 0.8) < 1e-9);
  assert.equal(L.win.clipL, false); assert.equal(L.win.clipR, false);
  assert.ok(Math.abs(L.playhead.f - 0.5) < 1e-9 && L.playhead.out === null);
  // the alternative (+14 d) starts at Out and runs off the right edge
  assert.ok(Math.abs(L.alt.left - 0.8) < 1e-9 && L.alt.right === 1 && L.alt.clipR === true);
  assert.equal(L.events.length, 1);                                  // the event at START is out of view
  assert.equal(L.events[0].body, 'earth');
  assert.equal(L.inVisible && L.outVisible, true);
  const all = dockLayout(st, 'all', { slipDays: 0 });
  assert.equal(all.alt, null);                                       // slip 0: no dashed box
  assert.ok(all.win.right - all.win.left < 0.02);                    // 14 of ~790 days
  assert.deepEqual(all.range, { startMs: START, endMs: END });
  const free = dockLayout({ ...st, window: null }, 'window');
  assert.equal(free.win, null); assert.equal(free.alt, null);
  assert.deepEqual(free.range, { startMs: START, endMs: END });      // falls back to the whole data
  // a playhead dragged out of the window view is pinned to the edge and flagged
  const away = dockLayout({ ...st, nowMs: OUT + 60 * DAY_MS }, 'window');
  assert.equal(away.playhead.f, 1); assert.equal(away.playhead.out, 'right');
  // a window partly outside the view is clipped and its handle hidden
  const late = dockLayout({ ...st, window: { inMs: IN - 20 * DAY_MS, outMs: OUT } }, 'window', {});
  assert.equal(late.win.clipL, false);
  const clip = dockLayout(st, 'window', { slipDays: -14 });
  assert.equal(clip.alt.clipL, true);
  assert.ok(Math.abs(clip.alt.right - 0.2) < 1e-9);
});

test('timedock: shortcuts', () => {
  assert.deepEqual(keyCommand({ key: ' ' }), { type: 'play' });
  assert.deepEqual(keyCommand({ key: 'Spacebar', code: 'Space' }), { type: 'play' });
  assert.deepEqual(keyCommand({ key: 'ArrowRight' }), { type: 'step', ms: HOUR_MS });
  assert.deepEqual(keyCommand({ key: 'ArrowLeft', shiftKey: true }), { type: 'step', ms: -6 * HOUR_MS });
  assert.deepEqual(keyCommand({ key: '[' }), { type: 'in' });
  assert.deepEqual(keyCommand({ key: ']' }), { type: 'out' });
  assert.deepEqual(keyCommand({ key: 'L' }), { type: 'loop' });
  assert.equal(keyCommand({ key: 'l', metaKey: true }), null);
  assert.equal(keyCommand({ key: ' ', ctrlKey: true }), null);
  assert.equal(keyCommand({ key: 'k' }), null);                      // K is the sky dial's (S, G)
  assert.equal(keyCommand({ key: 'ArrowUp' }), null);
});

test('timedock: [ and ] and the handle drags keep sensible windows', () => {
  const len = 14 * DAY_MS;
  assert.deepEqual(windowWithIn(W, IN + DAY_MS, len), { inMs: IN + DAY_MS, outMs: OUT });
  assert.deepEqual(windowWithIn(W, OUT + DAY_MS, len), { inMs: OUT + DAY_MS, outMs: OUT + DAY_MS + len });   // past Out: length kept
  assert.deepEqual(windowWithIn(null, IN, len), { inMs: IN, outMs: IN + len });
  assert.deepEqual(windowWithOut(W, OUT + 2 * DAY_MS, len), { inMs: IN, outMs: OUT + 2 * DAY_MS });
  assert.deepEqual(windowWithOut(W, IN - DAY_MS, len), { inMs: IN - DAY_MS - len, outMs: IN - DAY_MS });
  assert.deepEqual(windowWithOut(null, OUT, len), { inMs: OUT - len, outMs: OUT });
  assert.deepEqual(dragHandle(W, 'out', OUT + 2.4 * DAY_MS), { inMs: IN, outMs: OUT + 2 * DAY_MS });
  assert.deepEqual(dragHandle(W, 'out', IN - 5 * DAY_MS), { inMs: IN, outMs: IN + DAY_MS });           // at least a day
  assert.deepEqual(dragHandle(W, 'in', IN - 3.6 * DAY_MS), { inMs: IN - 4 * DAY_MS, outMs: OUT });
  assert.deepEqual(dragHandle(W, 'in', OUT + 3 * DAY_MS), { inMs: OUT - DAY_MS, outMs: OUT });
});

test('timedock: the status throttle runs at most every 250 ms and always lands the last text', () => {
  let t = 0;
  const timers = [];
  const clock = { now: () => t, setTimer: (fn, ms) => { timers.push({ fn, at: t + ms }); return timers.length; }, clearTimer: (id) => { timers[id - 1] = null; } };
  const run = () => { for (const x of timers.splice(0)) if (x && x.at <= t) x.fn(); else if (x) timers.push(x); };
  const seen = [];
  const push = createThrottle((s) => seen.push(s), STATUS_INTERVAL_MS, clock);
  assert.equal(STATUS_INTERVAL_MS, 250);
  push('a');                                   // leading call shows at once
  for (let i = 1; i <= 50; i++) { t = i * 10; push(`b${i}`); run(); }   // 500 ms of calls every 10 ms
  t = 1000; run();
  assert.equal(seen[0], 'a');
  assert.equal(seen[seen.length - 1], 'b50');
  assert.ok(seen.length <= 3, `${seen.length} updates in 500 ms`);   // 0, 250, 500
  const p2 = createThrottle((s) => seen.push(s), 250, clock);
  t = 5000; p2('x'); p2('y'); p2.cancel(); t = 6000; run();
  assert.equal(seen[seen.length - 1], 'x');   // cancelled trailing call never lands
});

function dockDOM(t) {
  class N {
    constructor(tag) { this.tag = tag; this.a = {}; this.children = []; this.listeners = {}; this.dataset = {}; this.style = { setProperty() {} }; this.classList = { add() {}, remove() {}, toggle() {} }; this.writes = 0; }
    setAttribute(k, v) { this.a[k] = String(v); if (k === 'aria-valuetext') this.writes++; if (k.startsWith('data-')) this.dataset[k.slice(5)] = String(v); }
    getAttribute(k) { return this.a[k] ?? null; }
    get id() { return this.a.id; }
    get hidden() { return 'hidden' in this.a; }
    set hidden(v) { if (v) this.a.hidden = ''; else delete this.a.hidden; }
    append(...ns) { for (const n of ns) { n.parent = this; this.children.push(n); } }
    replaceChildren(...ns) { this.children = []; this.append(...ns); }
    get firstChild() { return this.children[0]; }
    removeChild(n) { this.children = this.children.filter((x) => x !== n); }
    addEventListener(k, f) { (this.listeners[k] ??= []).push(f); }
    removeEventListener() {}
    getBoundingClientRect() { return { left: 0, width: 1000, height: 32 }; }
    focus() { document.activeElement = this; }
    closest(s) { if (s === '[data-handle]' && this.dataset.handle) return this; return this.parent?.closest(s) ?? null; }
    fire(k, e = {}) { for (const f of this.listeners[k] ?? []) f({ target: this, preventDefault() {}, ...e }); }
    find(c) { if ((this.a.class ?? '').split(' ').includes(c)) return this; for (const n of this.children) { const r = n.find(c); if (r) return r; } return null; }
  }
  const previous = { Node: globalThis.Node, document: globalThis.document };
  Object.assign(globalThis, { Node: N, document: { activeElement: null,
    createElement: (tag) => new N(tag), createElementNS: (_, tag) => new N(tag), createTextNode: (text) => Object.assign(new N('#text'), { textContent: text }),
    addEventListener() {}, removeEventListener() {},
  } });
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } });
}

test('M3: window handle drags freeze coordinates and the other end until release', (t) => {
  dockDOM(t);
  const { eph } = loadCoreContext({ terrain: false });
  for (const which of ['out', 'in']) {
    const timeline = createTimeline({ startMs: eph.startMs, endMs: eph.endMs, window: W });
    const dock = createTimeDock({ timeline, autoplay: false });
    const track = dock.el.find('td-track');
    const box = dock.el.find('td-win');
    const range = viewRange(timeline.getState(), 'window');
    const x = which === 'out' ? 900 : 100;
    const expected = dragHandle(W, which, fromFraction(x / 1000, range));
    track.fire('pointerdown', { target: dock.el.find(`td-handle-${which}`), button: 0, clientX: which === 'out' ? 800 : 200, pointerId: 1 });
    const days = [];
    for (let i = 0; i < 5; i++) {
      track.fire('pointermove', { clientX: x, clientY: i * 10 });
      const w = timeline.getState().window;
      days.push((w.outMs - w.inMs) / DAY_MS);
    }
    assert.deepEqual(days, Array(5).fill((expected.outMs - expected.inMs) / DAY_MS));
    assert.deepEqual(timeline.getState().window, expected);
    assert.equal(timeline.getState().windowDraft, true);
    const frozenWidth = box.style.width;
    // Another subscriber can update a draft; the next move still uses the pointerdown anchor.
    timeline.setWindow(expected.inMs + DAY_MS, expected.outMs + DAY_MS, { draft: true });
    track.fire('pointermove', { clientX: x });
    assert.deepEqual(timeline.getState().window, expected);
    track.fire(which === 'out' ? 'pointerup' : 'pointercancel');
    assert.equal(timeline.getState().windowDraft, false);
    assert.notEqual(box.style.width, frozenWidth);
    assert.equal(box.style.width, '60.000%');
    dock.destroy();
  }
});

test('L2: focused playhead keeps playback ARIA throttling, with immediate keyboard updates', (t) => {
  dockDOM(t);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const timeline = createTimeline({ startMs: START, endMs: END, window: W });
  const dock = createTimeDock({ timeline, autoplay: false });
  const ph = dock.el.find('td-ph');
  ph.focus(); timeline.play(); ph.writes = 0;
  for (let i = 0; i < 10; i++) timeline.tick(16);
  assert.equal(ph.writes, 0);
  now = 1001; timeline.tick(16);
  assert.equal(ph.writes, 1);
  ph.writes = 0;
  dock.update({ slipDays: 7 }); timeline.setRate(DAY_MS);
  assert.equal(ph.writes, 0, 'redraws do not bypass playback throttling');
  for (const key of ['ArrowRight', 'PageUp', 'Home', 'End']) {
    ph.fire('keydown', { key });
    assert.equal(ph.getAttribute('aria-valuetext'), fmtDateTime(timeline.getState().nowMs));
  }
  assert.equal(ph.writes, 4);
  ph.writes = 0; timeline.tick(16);
  assert.equal(ph.writes, 0);
  timeline.pause();
  assert.equal(ph.getAttribute('aria-valuetext'), fmtDateTime(timeline.getState().nowMs));
  dock.destroy();
});
