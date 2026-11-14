// Phase 5 P: the global clock (demo/src/timeline.js): playback rules, window clamping, events, views, ticks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTimeline, createPlayLoop, advanceNow, clampWindow, viewRange, toFraction, fromFraction, niceTicks,
  nextEventMs, prevEventMs, snapMs, rateLabel, defaultRate, RATES, HOUR_MS, DAY_MS, MIN_WINDOW_MS, MAX_TICK_MS,
} from '../demo/src/timeline.js';

// The real ephemeris range (demo/data/ephemeris.json: 2026-11-01 to 2029-01-01).
const START = Date.UTC(2026, 10, 1), END = Date.UTC(2029, 0, 1);
const IN = Date.UTC(2027, 0, 13), OUT = IN + 14 * DAY_MS;
const make = (o = {}) => createTimeline({ startMs: START, endMs: END, ...o });

test('timeline: defaults, rates and labels', () => {
  const tl = make();
  const s = tl.getState();
  assert.equal(s.nowMs, START);
  assert.equal(s.playing, false);
  assert.equal(s.loop, true);
  assert.equal(s.window, null);
  assert.equal(s.rate, DAY_MS);                    // 1 d/s without a window
  assert.ok(Object.isFrozen(s));
  assert.equal(make({ window: { inMs: IN, outMs: OUT } }).getState().rate, 6 * HOUR_MS);   // 6 h/s with one
  assert.equal(make({ window: { inMs: IN, outMs: OUT } }).getState().nowMs, IN);           // starts at In
  assert.deepEqual(RATES.map((r) => r.label), ['1 h/s', '6 h/s', '1 d/s', '7 d/s']);
  assert.deepEqual(RATES.map((r) => r.ms / HOUR_MS), [1, 6, 24, 168]);
  assert.equal(rateLabel(DAY_MS), '1 d/s');
  assert.equal(rateLabel(2 * HOUR_MS), '2 h/s');
  assert.equal(defaultRate(null), DAY_MS);
  assert.throws(() => createTimeline({ startMs: 5, endMs: 5 }));
});

test('timeline: tick advances by rate × real time, clamped per frame, one event per tick', () => {
  const tl = make({ nowMs: IN, rate: 6 * HOUR_MS });
  const seen = [];
  tl.subscribe((st, changed) => seen.push(changed));
  assert.equal(tl.tick(16), false);                 // paused: nothing
  assert.equal(seen.length, 0);
  tl.play();
  assert.deepEqual(seen.pop(), ['playing']);
  tl.tick(1000);                                    // clamped to MAX_TICK_MS
  assert.equal(tl.getState().nowMs, IN + (MAX_TICK_MS / 1000) * 6 * HOUR_MS);
  tl.tick(100);
  assert.equal(tl.getState().nowMs, IN + 0.35 * 6 * HOUR_MS);
  assert.deepEqual(seen, [['now'], ['now']]);       // exactly one notification per tick
  assert.equal(tl.tick(0), false);
  assert.equal(tl.tick(-5), false);
});

test('timeline: window + loop replays between In and Out', () => {
  const st = { startMs: START, endMs: END, window: { inMs: IN, outMs: OUT }, loop: true };
  assert.equal(advanceNow(st, OUT - HOUR_MS, 3 * HOUR_MS), IN + 2 * HOUR_MS);   // overshoot kept
  assert.equal(advanceNow(st, OUT, HOUR_MS), IN + HOUR_MS);                    // exactly at Out
  assert.equal(advanceNow(st, IN, 14 * DAY_MS), OUT);                          // landing on Out stays
  assert.equal(advanceNow(st, OUT - HOUR_MS, 29 * DAY_MS + HOUR_MS), IN + DAY_MS);   // longer than the window: wrapped
  // A running clock outside either end starts its step at In.
  assert.equal(advanceNow(st, IN - DAY_MS, DAY_MS), IN + DAY_MS);
  assert.equal(advanceNow(st, IN - DAY_MS, 16 * DAY_MS), IN + 2 * DAY_MS);
  assert.equal(advanceNow(st, OUT + DAY_MS, HOUR_MS), IN + HOUR_MS);
  assert.equal(advanceNow(st, END - HOUR_MS, 3 * HOUR_MS), IN + 3 * HOUR_MS);
});

test('timeline: autoplay normalizes an outside playhead only with a looping window', () => {
  for (const nowMs of [IN - DAY_MS, OUT + DAY_MS]) {
    const opts = { nowMs, window: { inMs: IN, outMs: OUT } };
    assert.equal(make({ ...opts, playing: true }).getState().nowMs, IN);
    assert.equal(make(opts).getState().nowMs, nowMs);
    assert.equal(make({ ...opts, playing: true, loop: false }).getState().nowMs, nowMs);
    assert.equal(make({ nowMs, playing: true }).getState().nowMs, nowMs);
  }
  for (const nowMs of [IN, IN + DAY_MS, OUT]) assert.equal(make({ nowMs, playing: true, window: { inMs: IN, outMs: OUT } }).getState().nowMs, nowMs);
});

test('timeline: a paused drag outside stays until Play; the reset and Play notify atomically', () => {
  for (const nowMs of [IN - DAY_MS, OUT + DAY_MS]) {
    const tl = make({ window: { inMs: IN, outMs: OUT } });
    tl.setNow(nowMs); tl.tick(250);
    assert.equal(tl.getState().nowMs, nowMs);
    const seen = []; tl.subscribe((s, c) => seen.push([s.nowMs, c]));
    tl.play();
    assert.deepEqual(seen, [[IN, ['playing', 'now']]]);
    tl.tick(100);
    assert.equal(tl.getState().nowMs, IN + 0.1 * 6 * HOUR_MS);
  }
});

test('timeline: adding or changing a window while playing resets to the new In, paused and loop-off do not', () => {
  for (const playing of [false, true]) for (const loop of [false, true]) {
    const march = Date.UTC(2027, 2, 1), tl = make({ nowMs: march, playing, loop });
    const seen = []; tl.subscribe((s, c) => seen.push([s.nowMs, c]));
    tl.setWindow(IN, OUT);
    assert.equal(tl.getState().nowMs, playing && loop ? IN : march);
    assert.deepEqual(seen, [[playing && loop ? IN : march, playing && loop ? ['window', 'now'] : ['window']]]);
    tl.setWindow(OUT + DAY_MS, OUT + 3 * DAY_MS);
    assert.equal(tl.getState().nowMs, playing && loop ? OUT + DAY_MS : march);
  }
});

test('timeline: turning loop on and setting an outside time during playback cannot escape the window', () => {
  const tl = make({ nowMs: OUT + DAY_MS, playing: true, loop: false, window: { inMs: IN, outMs: OUT } });
  tl.setLoop(true); assert.equal(tl.getState().nowMs, IN);
  tl.setNow(OUT + 2 * DAY_MS); assert.equal(tl.getState().nowMs, IN);
  tl.setWindow(IN + DAY_MS, OUT, { draft: true }); assert.equal(tl.getState().nowMs, IN + DAY_MS);
  tl.setLoop(false); tl.setNow(OUT + DAY_MS); tl.tick(100);
  assert.equal(tl.getState().nowMs, OUT + DAY_MS + 0.1 * 6 * HOUR_MS);
  tl.pause(); tl.setLoop(true); assert.equal(tl.getState().nowMs, OUT + DAY_MS + 0.1 * 6 * HOUR_MS);
});

test('timeline: window without loop walks out of it and wraps at the end of the ephemeris', () => {
  const st = { startMs: START, endMs: END, window: { inMs: IN, outMs: OUT }, loop: false };
  assert.equal(advanceNow(st, OUT - HOUR_MS, 3 * HOUR_MS), OUT + 2 * HOUR_MS);
  assert.equal(advanceNow(st, END - HOUR_MS, 3 * HOUR_MS), START + 2 * HOUR_MS);
  assert.equal(advanceNow(st, END, 0), END);
});

test('timeline: no window runs over the whole ephemeris and wraps to its start', () => {
  const st = { startMs: START, endMs: END, window: null, loop: true };
  assert.equal(advanceNow(st, IN, DAY_MS), IN + DAY_MS);
  assert.equal(advanceNow(st, END - HOUR_MS, HOUR_MS), END);
  assert.equal(advanceNow(st, END - HOUR_MS, 2 * HOUR_MS), START + HOUR_MS);
  // through the state machine, a full lap at 7 d/s
  const tl = make({ playing: true, rate: 7 * DAY_MS, nowMs: END - DAY_MS });
  tl.tick(250);                                     // 1.75 d: past the end by 0.75 d
  assert.equal(tl.getState().nowMs, START + 0.75 * DAY_MS);
});

test('timeline: setNow and step clamp to the ephemeris; dragging outside the window is kept', () => {
  const tl = make({ window: { inMs: IN, outMs: OUT } });
  tl.setNow(START - DAY_MS); assert.equal(tl.getState().nowMs, START);
  tl.setNow(END + DAY_MS); assert.equal(tl.getState().nowMs, END);
  tl.setNow(OUT + 10 * DAY_MS); assert.equal(tl.getState().nowMs, OUT + 10 * DAY_MS);   // not pulled back
  tl.step(-HOUR_MS); assert.equal(tl.getState().nowMs, OUT + 10 * DAY_MS - HOUR_MS);
  tl.setNow(END); tl.step(HOUR_MS); assert.equal(tl.getState().nowMs, END);           // no wrap on a step
  assert.equal(tl.setNow(NaN), false);
  const seen = [];
  tl.subscribe((s, c) => seen.push(c));
  assert.equal(tl.setNow(END), false);              // unchanged: no event
  assert.equal(seen.length, 0);
});

test('timeline: setWindow orders, clamps to the ephemeris and keeps at least one day', () => {
  assert.deepEqual(clampWindow(START, END, OUT, IN), { inMs: IN, outMs: OUT });
  assert.deepEqual(clampWindow(START, END, START - 5 * DAY_MS, START + 2 * DAY_MS), { inMs: START, outMs: START + 2 * DAY_MS });
  assert.deepEqual(clampWindow(START, END, IN, IN + HOUR_MS), { inMs: IN, outMs: IN + MIN_WINDOW_MS });
  assert.deepEqual(clampWindow(START, END, END - HOUR_MS, END + 9 * DAY_MS), { inMs: END - DAY_MS, outMs: END });
  assert.deepEqual(clampWindow(START, END, END + DAY_MS, END + 9 * DAY_MS), { inMs: END - DAY_MS, outMs: END });
  assert.equal(clampWindow(START, START + HOUR_MS, START, START + HOUR_MS), null);
  assert.equal(clampWindow(START, END, NaN, OUT), null);

  const tl = make({ nowMs: IN + 20 * DAY_MS });
  const seen = [];
  tl.subscribe((s, c) => seen.push([c, s.windowDraft]));
  tl.setWindow(IN, OUT);
  assert.deepEqual(tl.getState().window, { inMs: IN, outMs: OUT });
  assert.equal(tl.getState().nowMs, IN + 20 * DAY_MS);   // the playhead is not moved
  assert.equal(tl.setWindow(IN, OUT), false);             // same window: no event
  tl.setWindow(IN, OUT + DAY_MS, { draft: true });
  tl.setWindow(IN, OUT + DAY_MS);                          // release: same window, draft cleared → reported
  tl.clearWindow();
  assert.equal(tl.clearWindow(), false);
  assert.deepEqual(seen, [[['window'], false], [['window'], true], [['window'], false], [['window'], false]]);
  assert.equal(tl.getState().window, null);
});

test('timeline: rate, loop, play toggles report only real changes', () => {
  const tl = make();
  const seen = [];
  tl.subscribe((s, c) => seen.push(c[0]));
  tl.setRate(HOUR_MS); tl.setRate(HOUR_MS); tl.setRate(0); tl.setRate(-1);
  tl.toggleLoop(); tl.setLoop(false); tl.toggleLoop();
  tl.togglePlay(); tl.play(); tl.togglePlay(); tl.pause();
  assert.deepEqual(seen, ['rate', 'loop', 'loop', 'playing', 'playing']);
  assert.equal(tl.getState().rate, HOUR_MS);
  const off = tl.subscribe(() => seen.push('x'));
  off();
  tl.play();
  assert.ok(!seen.includes('x'));
});

test('timeline: next and previous rise or set', () => {
  const events = [{ tMs: IN + 5 * HOUR_MS, body: 'sun', kind: 'set' }, { tMs: IN + 2 * DAY_MS, body: 'earth', kind: 'rise' }, IN + DAY_MS];
  assert.equal(nextEventMs(events, IN), IN + 5 * HOUR_MS);
  assert.equal(nextEventMs(events, IN + 5 * HOUR_MS), IN + DAY_MS);    // the event under the playhead is skipped
  assert.equal(nextEventMs(events, IN + 3 * DAY_MS), null);
  assert.equal(prevEventMs(events, IN + 3 * DAY_MS), IN + 2 * DAY_MS);
  assert.equal(prevEventMs(events, IN + DAY_MS), IN + 5 * HOUR_MS);
  assert.equal(prevEventMs(events, IN), null);
  assert.equal(nextEventMs(null, IN), null);
  const tl = make({ nowMs: IN });
  assert.equal(tl.nextEvent(events), true); assert.equal(tl.getState().nowMs, IN + 5 * HOUR_MS);
  assert.equal(tl.nextEvent(events), true); assert.equal(tl.getState().nowMs, IN + DAY_MS);
  assert.equal(tl.prevEvent(events), true); assert.equal(tl.getState().nowMs, IN + 5 * HOUR_MS);
  assert.equal(tl.prevEvent(events), false);
  assert.equal(tl.getState().nowMs, IN + 5 * HOUR_MS);
});

test('timeline: views, fractions and snapping', () => {
  const st = { startMs: START, endMs: END, window: { inMs: IN, outMs: OUT } };
  assert.deepEqual(viewRange(st, 'all'), { startMs: START, endMs: END });
  assert.deepEqual(viewRange({ ...st, window: null }, 'window'), { startMs: START, endMs: END });
  const v = viewRange(st, 'window');
  assert.ok(Math.abs(toFraction(IN, v) - 0.2) < 1e-9 && Math.abs(toFraction(OUT, v) - 0.8) < 1e-9);   // centred, 60 %
  // near the start of the data the view shifts but keeps its span
  const early = viewRange({ ...st, window: { inMs: START + DAY_MS, outMs: START + 15 * DAY_MS } }, 'window');
  assert.equal(early.startMs, START);
  assert.ok(Math.abs(early.endMs - early.startMs - (14 * DAY_MS) / 0.6) < 1);
  const late = viewRange({ ...st, window: { inMs: END - 3 * DAY_MS, outMs: END } }, 'window');
  assert.equal(late.endMs, END);
  assert.equal(fromFraction(toFraction(IN + 1234, v), v), IN + 1234);
  assert.equal(snapMs(IN + 29 * 60e3), IN);
  assert.equal(snapMs(IN + 31 * 60e3), IN + HOUR_MS);
  assert.equal(snapMs(IN + 13 * HOUR_MS, DAY_MS), IN + DAY_MS);
});

test('timeline: tidy ticks for the whole ephemeris, a window and a day', () => {
  const all = niceTicks({ startMs: START, endMs: END }, 12);
  assert.ok(all.length <= 12 && all.length >= 4);
  assert.ok(all.every((t) => new Date(t.ms).getUTCDate() === 1 && t.ms >= START && t.ms <= END));
  assert.deepEqual(all.filter((t) => t.major).map((t) => t.label), ['Jan 2027', 'Jan 2028', 'Jan 2029']);
  const win = niceTicks(viewRange({ startMs: START, endMs: END, window: { inMs: IN, outMs: OUT } }, 'window'), 8);
  assert.ok(win.length <= 8 && win.length >= 3);
  assert.ok(win.every((t) => /^\d+ [A-Z][a-z]{2}$/.test(t.label)));
  const day = niceTicks({ startMs: IN, endMs: IN + DAY_MS }, 8);
  // a 3-hour step would give 9 marks (both midnights included), one too many: 6-hourly
  assert.deepEqual(day.map((t) => t.label), ['13 Jan', '06:00', '12:00', '18:00', '14 Jan']);
  assert.deepEqual(niceTicks({ startMs: IN, endMs: IN + DAY_MS }, 9).length, 9);
  const years = niceTicks({ startMs: START, endMs: END }, 3);
  assert.deepEqual(years.map((t) => t.label), ['2027', '2028', '2029']);
  assert.deepEqual(niceTicks({ startMs: IN, endMs: IN }, 5), []);
});

test('timeline: the play loop ticks once per frame while playing and stops when paused', () => {
  const frames = new Map();
  let id = 0;
  const requestFrame = (fn) => { frames.set(++id, fn); return id; };
  const cancelFrame = (n) => frames.delete(n);
  const run = (ts) => { const fs = [...frames.values()]; frames.clear(); fs.forEach((f) => f(ts)); };
  const tl = make({ nowMs: IN, rate: HOUR_MS });
  const loop = createPlayLoop(tl, { requestFrame, cancelFrame });
  assert.equal(frames.size, 0);
  let notes = 0;
  tl.subscribe((s, c) => { if (c.includes('now')) notes++; });
  tl.play();
  assert.equal(frames.size, 1);
  run(1000);                                        // first frame only sets the clock
  run(1100); run(1200);
  assert.equal(notes, 2);
  assert.equal(tl.getState().nowMs, IN + 0.2 * HOUR_MS);
  tl.pause();
  assert.equal(frames.size, 0);
  run(5000);
  tl.play(); run(9000); run(9050);                  // resumes without a jump
  assert.equal(tl.getState().nowMs, IN + 0.25 * HOUR_MS);
  loop.stop();
  assert.equal(frames.size, 0);
});
