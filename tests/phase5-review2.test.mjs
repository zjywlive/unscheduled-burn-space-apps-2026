// Phase-5 review 2 (docs/phase5/review/astra-review-2.md): regression tests for F1, F3, F5, F6, F9 and the
// timeline half of F2. Each reproduces the review's case; the integrated-page halves (F2 Landing edit, F4,
// F7, F8) are smoke scenarios in tools/smoke.mjs ("phase 5 R2 …").
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCoreContext } from '../tools/core-context.mjs';
import { createCoreTools } from '../demo/src/tools-core.js';
import { createCountdown, countdownFrom, validUntil } from '../demo/src/countdown.js';
import { createThrottle } from '../demo/src/throttle.js';
import { parseHash, toHash, viewHref, cleanStay } from '../demo/src/state.js';
import { createTimeline, clampWindow, HOUR_MS, DAY_MS } from '../demo/src/timeline.js';
import { summarize } from '../demo/src/windows.js';
import { skylineFor } from '../demo/src/terrain.js';

const ctx = loadCoreContext();
const core = createCoreTools(ctx);
const site = (id) => ctx.sites.find((s) => s.id === id);

// a scheduler we drain by hand, so a chain of answers would show as a growing request count
function harness() {
  const queue = [];
  let requests = 0;
  const run = (name, input) => { requests++; return core.run(name, input); };
  const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise((r) => setImmediate(r)); while (queue.length) queue.shift()(); } };
  return { run, schedule: (fn) => queue.push(fn), settle, get requests() { return requests; } };
}

test('F1: at the very end of the ephemeris the countdown asks once and then answers from its cache', async () => {
  const hz = harness();
  let updates = 0;
  const cd = createCountdown({ run: hz.run, endMs: ctx.eph.endMs, schedule: hz.schedule, onUpdate: () => { updates++; cd.text(site('im2'), ctx.eph.endMs); } });
  cd.text(site('im2'), ctx.eph.endMs);
  await hz.settle();
  assert.equal(hz.requests, 1, 'one next_events request, not a chain');
  assert.equal(updates, 1);
  assert.match(cd.text(site('im2'), ctx.eph.endMs), /before 1 Jan 2029|stays up past 1 Jan 2029/);
  assert.equal(hz.requests, 1);
});

test('F1 (the freeze): a playhead inside the minute of a rise or set does not start an endless chain', async () => {
  const s = site('shackleton');
  const ev = summarize(ctx.eph, s, Date.UTC(2027, 0, 13), 14, skylineFor(ctx.dem, s)).events[0];
  assert.ok(ev, 'Shackleton has an event in the stay');
  for (const at of [ev.tMs, ev.tMs + 20e3, Math.floor(ev.tMs / 60e3) * 60e3 + 1]) {
    const hz = harness();
    const cd = createCountdown({ run: hz.run, endMs: ctx.eph.endMs, schedule: hz.schedule, onUpdate: () => cd.text(s, at) });
    cd.text(s, at);
    await hz.settle();
    assert.ok(hz.requests <= 2, `at ${new Date(at).toISOString()}: ${hz.requests} requests`);
    assert.notEqual(cd.text(s, at), '');
  }
});

test('F1: the cache never arrives already stale, and the row equals the next_events headline at its instant', async () => {
  const r = await core.run('next_events', { site_id: 'shackleton', at: '2027-01-18T06:00Z' });
  const from = Date.UTC(2027, 0, 18, 6);
  assert.ok(validUntil(r, from, ctx.eph.endMs) > from);
  assert.equal(countdownFrom(r, from), r.headline);
  assert.equal(validUntil({ sun: { upNow: true }, earth: { upNow: false } }, ctx.eph.endMs, ctx.eph.endMs), Infinity);
});

test('F5: the throttle drops nothing at the end: the last call lands after the wait', () => {
  let t = 1000, timer = null, calls = [];
  const th = createThrottle(() => calls.push(t), 240, { now: () => t, setTimer: (fn, ms) => { timer = { fn, at: t + ms }; return 1; }, clearTimer: () => { timer = null; } });
  th.call();                 // runs at once
  t = 1100; th.call();       // inside the wait: a trailing call is scheduled
  assert.deepEqual(calls, [1000]);
  assert.ok(timer && timer.at === 1240);
  t = 1240; timer.fn();
  assert.deepEqual(calls, [1000, 1240], 'the second instant is shown');
});

test('F3: the top bar links keep the playhead where it is (no stale now=)', () => {
  const st = parseHash('#now=2027-01-13T05:00Z', ctx.sites, ctx.eph);
  const href = viewHref({ ...st, cursorMs: Date.parse('2027-01-18T06:00Z') }, 'evidence');
  assert.ok(!/[#&]now=/.test(href), href);
  assert.ok(!/[#&]sheet=/.test(href), href);
  assert.match(href, /view=evidence/);
  assert.match(viewHref({ ...st, windowOn: false }, 'map'), /win=off/);
});

test('F9: impossible hash dates fall back instead of rolling over', () => {
  for (const bad of ['2027-13-13T05:00Z', '2027-01-13T05:99Z', '2027-01-13T24:00Z', '2027-02-30T00:00Z']) {
    const s = parseHash(`#t=${bad}&now=${bad}`, ctx.sites, ctx.eph);
    assert.equal(s.landingMs, Date.UTC(2027, 0, 13), bad);
    assert.equal(s.cursorMs, s.landingMs, bad);
  }
  assert.equal(parseHash('#now=2027-01-13T05:30Z', ctx.sites, ctx.eph).cursorMs, Date.UTC(2027, 0, 13, 5, 30));
});

test('F6: a fractional stay is rounded to the hour in the tools as on the page', async () => {
  const r = await core.run('site_summary', { site_id: 'shackleton', landing: '2027-01-13T06:45Z', stay_days: 13.76 });
  assert.equal(cleanStay(13.76), 13.75);
  assert.equal(r.stay.coveredH, 330);
  const s = site('shackleton');
  const p = summarize(ctx.eph, s, Date.UTC(2027, 0, 13, 6), cleanStay(13.76), skylineFor(ctx.dem, s));
  assert.equal(r.sunH, Math.round(p.sunMs / 36e4) / 10);
});

test('F2: a mission window copied into the timeline keeps its In even when the last day is short', () => {
  const end = ctx.eph.endMs, inMs = end - HOUR_MS;
  assert.deepEqual(clampWindow(ctx.eph.startMs, end, inMs, end, HOUR_MS), { inMs, outMs: end });
  const tl = createTimeline({ startMs: ctx.eph.startMs, endMs: end, window: { inMs, outMs: end }, windowMinMs: HOUR_MS });
  assert.equal(tl.getState().window.inMs, inMs);
  tl.setWindow(inMs, end, { minMs: HOUR_MS });
  assert.equal(tl.getState().window.inMs, inMs);
  // a window made in the dock still lasts at least a day
  tl.setWindow(inMs, end);
  assert.equal(tl.getState().window.outMs - tl.getState().window.inMs, DAY_MS);
});

test('F7: the battery chart has a cursor at the playhead, with the charge there', async () => {
  class N {
    constructor(tag, text = '') { this.tag = tag; this.attrs = {}; this.children = []; this.text = text; this.clientWidth = 600; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener() {}
    append(...nodes) { for (const n of nodes.flat(Infinity)) { if (n == null || n === false) continue; const c = typeof n === 'object' ? n : new N('#text', String(n)); if (c.parent) c.parent.removeChild(c); c.parent = this; this.children.push(c); } }
    get firstChild() { return this.children[0]; }
    removeChild(n) { this.children.splice(this.children.indexOf(n), 1); n.parent = null; }
    set textContent(t) { this.children = []; this.text = String(t); }
    get textContent() { return this.text + this.children.map((n) => n.textContent).join(''); }
  }
  const saved = { Node: globalThis.Node, document: globalThis.document };
  globalThis.Node = N;
  globalThis.document = { createElement: (t) => new N(t), createElementNS: (_, t) => new N(t), createTextNode: (t) => new N('#text', t) };
  try {
    const { createEnergyCard } = await import('../demo/src/ui/energycard.js');
    const find = (n, c) => (n.attrs?.class?.split(' ').includes(c) ? n : n.children?.map((x) => find(x, c)).find(Boolean));
    const s = site('im2'), card = createEnergyCard();
    const params = { eph: ctx.eph, planned: { site: s, landingMs: Date.UTC(2027, 0, 13), mask: skylineFor(ctx.dem, s) }, stayDays: 14 };
    card.update({ ...params, cursorMs: Date.UTC(2027, 0, 13, 5) });
    const line = () => find(card.el, 'energy-cursor');
    assert.ok(line(), 'a cursor line on the battery chart');
    const x1 = line().attrs.x1;
    card.setCursor(Date.UTC(2027, 0, 18, 6));
    assert.notEqual(line().attrs.x1, x1, 'setCursor moves it without a re-render');
    assert.match(find(card.el, 'energy-cursor-label').textContent, / now$/);
    card.setCursor(Date.UTC(2027, 1, 20));
    assert.equal(find(card.el, 'energy-cursor-g').attrs.display, 'none', 'hidden outside the stay');
  } finally { globalThis.Node = saved.Node; globalThis.document = saved.document; }
});
