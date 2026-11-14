// Phase 5 P: the one clock for the whole product. A playhead (the global "now"), a play state and a rate,
// an optional mission window (In = landing, Out = end of the stay) and the ephemeris range it lives in.
// Pure helpers plus one small state machine; no DOM, so it runs and is tested in Node.
//
// Playback rules (docs/phase4/structure-2026-11-13.md, "时间与播放"):
// - window and loop on: crossing Out goes back to In (the stay replays between its two keyframes);
// - window and loop off: playback walks out of the window and on to the end of the ephemeris, then wraps
//   to its start;
// - no window: playback runs over the whole ephemeris and wraps from its end to its start;
// - while paused, a playhead dragged outside the window stays there; playing with loop on brings it to
//   In, including autoplay, a changed window and turning loop on during playback.

export const HOUR_MS = 3600e3;
export const DAY_MS = 86400e3;
export const MIN_WINDOW_MS = DAY_MS;
// The longest real-time step one tick may advance (a backgrounded tab resumes without a jump).
export const MAX_TICK_MS = 250;
// Simulated milliseconds per real second.
export const RATES = [
  { ms: HOUR_MS, label: '1 h/s' },
  { ms: 6 * HOUR_MS, label: '6 h/s' },
  { ms: DAY_MS, label: '1 d/s' },
  { ms: 7 * DAY_MS, label: '7 d/s' },
];
export const DEFAULT_RATE_WINDOW = 6 * HOUR_MS;
export const DEFAULT_RATE_FREE = DAY_MS;
// In the 'window' view the window takes this share of the timeline, centred.
export const WINDOW_VIEW_SHARE = 0.6;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function rateLabel(ms) {
  const r = RATES.find((x) => x.ms === ms);
  if (r) return r.label;
  return ms >= DAY_MS ? `${+(ms / DAY_MS).toFixed(2)} d/s` : `${+(ms / HOUR_MS).toFixed(2)} h/s`;
}

export function defaultRate(window) {
  return window ? DEFAULT_RATE_WINDOW : DEFAULT_RATE_FREE;
}

// A window inside [startMs, endMs], In before Out, at least MIN_WINDOW_MS long. Returns null when the
// range itself is shorter than that or the input is not two numbers.
// minMs: the shortest window (a day for one made in the dock). A mission copied in from the page passes a
// smaller one, so a stay cut short by the end of the ephemeris keeps its In (review 2 F2).
export function clampWindow(startMs, endMs, inMs, outMs, minMs = MIN_WINDOW_MS) {
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || endMs - startMs < minMs) return null;
  let a = Math.min(inMs, outMs), b = Math.max(inMs, outMs);
  a = clamp(a, startMs, endMs - minMs);
  b = clamp(b, a + minMs, endMs);
  return { inMs: a, outMs: b };
}

// `[` and `]`: one end of the window to `ms`, the other end kept. Moving In to or past Out (or Out to or
// before In) keeps the stay's length instead. Without a window, one of defaultLenMs is made. The result
// still goes through clampWindow (setWindow does that).
export function windowWithIn(window, ms, defaultLenMs) {
  if (!window) return { inMs: ms, outMs: ms + defaultLenMs };
  const len = window.outMs - window.inMs;
  return ms <= window.outMs - MIN_WINDOW_MS ? { inMs: ms, outMs: window.outMs } : { inMs: ms, outMs: ms + len };
}

export function windowWithOut(window, ms, defaultLenMs) {
  if (!window) return { inMs: ms - defaultLenMs, outMs: ms };
  const len = window.outMs - window.inMs;
  return ms >= window.inMs + MIN_WINDOW_MS ? { inMs: window.inMs, outMs: ms } : { inMs: ms - len, outMs: ms };
}

// Dragging a handle: the other end stays put and the stay stays a whole number of days (at least one),
// so the landing time of day only changes through the landing field.
export function dragHandle(window, which, ms) {
  if (which === 'in') {
    const days = Math.max(1, Math.round((window.outMs - ms) / DAY_MS));
    return { inMs: window.outMs - days * DAY_MS, outMs: window.outMs };
  }
  const days = Math.max(1, Math.round((ms - window.inMs) / DAY_MS));
  return { inMs: window.inMs, outMs: window.inMs + days * DAY_MS };
}

// One playback step: where the playhead lands after `deltaMs` of simulated time from `nowMs`.
// Pure; follows the rules at the top of this file.
export function advanceNow({ startMs, endMs, window, loop }, nowMs, deltaMs) {
  if (!(deltaMs > 0)) return nowMs;
  const span = endMs - startMs;
  if (window && loop) {
    const { inMs, outMs } = window;
    const len = outMs - inMs;
    nowMs = loopStart({ window, loop }, nowMs);
    const next = nowMs + deltaMs;
    // crossed Out (also when entering and leaving in one step): back to In, keeping the overshoot,
    // wrapped so that a step longer than the window still lands inside it
    if (nowMs <= outMs && next > outMs) return inMs + ((next - outMs) % len);
    return next;
  }
  const next = nowMs + deltaMs;
  if (next <= endMs) return next;
  return startMs + ((next - endMs) % span);
}

// The time span the timeline shows. 'all': the whole ephemeris. 'window': the window centred, taking
// WINDOW_VIEW_SHARE of the width, shifted (not shrunk) to stay inside the ephemeris. Without a window,
// 'window' falls back to 'all'.
export function viewRange(state, mode = 'all') {
  const { startMs, endMs, window } = state;
  if (mode !== 'window' || !window) return { startMs, endMs };
  const span = Math.min(endMs - startMs, (window.outMs - window.inMs) / WINDOW_VIEW_SHARE);
  let a = (window.inMs + window.outMs) / 2 - span / 2;
  a = clamp(a, startMs, endMs - span);
  return { startMs: a, endMs: a + span };
}

export function toFraction(ms, range) {
  return (ms - range.startMs) / (range.endMs - range.startMs);
}

export function fromFraction(f, range) {
  return range.startMs + f * (range.endMs - range.startMs);
}

export function snapMs(ms, stepMs = HOUR_MS) {
  return Math.round(ms / stepMs) * stepMs;
}

// Event times: plain numbers or objects with tMs (the rise/set events of windows.js summarize()).
const timeOf = (e) => (typeof e === 'number' ? e : e?.tMs);
const EPS_MS = 1000;

export function nextEventMs(events, nowMs) {
  let best = null;
  for (const e of events ?? []) {
    const t = timeOf(e);
    if (Number.isFinite(t) && t > nowMs + EPS_MS && (best === null || t < best)) best = t;
  }
  return best;
}

export function prevEventMs(events, nowMs) {
  let best = null;
  for (const e of events ?? []) {
    const t = timeOf(e);
    if (Number.isFinite(t) && t < nowMs - EPS_MS && (best === null || t > best)) best = t;
  }
  return best;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

// Tidy ticks for a range: of the steps below, the finest that gives at most maxTicks marks. Each tick is
// { ms, major, label }: hour ticks are labelled "06:00" (major at midnight, labelled "13 Jan"); day ticks
// "13 Jan" (major on the 1st), placed on the same days of every month (all, odd, 1/6/11/16/21/26,
// 1/8/15/22); month ticks "Mar" (major in January, labelled "Jan 2027"); year ticks "2027".
const DAY_SETS = {
  d1: null,
  d2: [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29],
  d5: [1, 6, 11, 16, 21, 26],
  d7: [1, 8, 15, 22],
};
const STEPS = ['h1', 'h3', 'h6', 'h12', 'd1', 'd2', 'd5', 'd7', 'm1', 'm3', 'm6', 'y1'];

function ticksFor(step, range) {
  const out = [];
  const push = (ms, major, label) => { if (ms >= range.startMs && ms <= range.endMs) out.push({ ms, major, label }); };
  const unit = step[0], n = Number(step.slice(1));
  const d0 = new Date(range.startMs);
  if (unit === 'h') {
    const unitMs = HOUR_MS * n;
    for (let t = Math.ceil(range.startMs / unitMs) * unitMs; t <= range.endMs; t += unitMs) {
      const d = new Date(t);
      const midnight = d.getUTCHours() === 0;
      push(t, midnight, midnight ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : `${pad2(d.getUTCHours())}:00`);
    }
  } else if (unit === 'd') {
    const set = DAY_SETS[step];
    for (let t = Math.ceil(range.startMs / DAY_MS) * DAY_MS; t <= range.endMs; t += DAY_MS) {
      const d = new Date(t), day = d.getUTCDate();
      if (!set || set.includes(day)) push(t, day === 1, `${day} ${MONTHS[d.getUTCMonth()]}`);
    }
  } else {
    const months = unit === 'y' ? 12 : n;
    for (let m = 0; ; m += months) {
      const yy = d0.getUTCFullYear() + Math.floor(m / 12), mm = m % 12;
      const t = Date.UTC(yy, mm, 1);
      if (t > range.endMs) break;
      if (unit === 'y') push(t, true, String(yy));
      else push(t, mm === 0, mm === 0 ? `Jan ${yy}` : MONTHS[mm]);
    }
  }
  return out;
}

// rough marks per step, to skip generating hour ticks over two years
const STEP_ROUGH_MS = { h: HOUR_MS, d: DAY_MS, m: 30.44 * DAY_MS, y: 365.25 * DAY_MS };

export function niceTicks(range, maxTicks = 8) {
  const span = range.endMs - range.startMs;
  if (!(span > 0) || !(maxTicks >= 1)) return [];
  for (const step of STEPS) {
    const unit = step[0], n = Number(step.slice(1));
    if (span / (STEP_ROUGH_MS[unit] * n) > maxTicks * 3) continue;
    const ticks = ticksFor(step, range);
    if (ticks.length <= maxTicks) return ticks;
  }
  return ticksFor('y1', range).slice(0, maxTicks);
}

// ---------- the state machine ----------
function loopStart({ window, loop }, nowMs) {
  return window && loop && (nowMs < window.inMs || nowMs > window.outMs) ? window.inMs : nowMs;
}

// createTimeline({ startMs, endMs, nowMs?, window?, rate?, loop?, playing? })
// State (frozen, replaced on every change):
//   { startMs, endMs, nowMs, playing, rate, window: { inMs, outMs } | null, loop, windowDraft }
// subscribe(fn) → unsubscribe. fn(state, changed) runs synchronously after every change; `changed` lists
// the keys that changed: 'now', 'playing', 'rate', 'window', 'loop', 'range'. One call per operation
// (tick included). While the window is dragged, setWindow(..., { draft: true }) reports 'window' with
// state.windowDraft = true; the release reports 'window' with windowDraft = false. Recompute window
// totals only when 'window' changed and windowDraft is false.
export function createTimeline(opts) {
  const startMs = Number(opts.startMs), endMs = Number(opts.endMs);
  if (!(endMs > startMs)) throw new Error('createTimeline: endMs must be after startMs');
  const window0 = opts.window ? clampWindow(startMs, endMs, opts.window.inMs, opts.window.outMs, opts.windowMinMs ?? MIN_WINDOW_MS) : null;
  let state = Object.freeze({
    startMs, endMs,
    nowMs: clamp(Number.isFinite(opts.nowMs) ? opts.nowMs : (window0 ? window0.inMs : startMs), startMs, endMs),
    playing: Boolean(opts.playing),
    rate: opts.rate > 0 ? opts.rate : defaultRate(window0),
    window: window0 ? Object.freeze(window0) : null,
    loop: opts.loop ?? true,
    windowDraft: false,
  });
  if (state.playing) state = Object.freeze({ ...state, nowMs: loopStart(state, state.nowMs) });
  const subs = new Set();

  function commit(patch, changed) {
    const next = { ...state, ...patch };
    if (next.playing) next.nowMs = loopStart(next, next.nowMs);
    // One atomic notification: subscribers never see a running clock outside its loop window.
    changed = changed.filter((key) => key !== 'now');
    if (next.nowMs !== state.nowMs) changed.push('now');
    if (!changed.length) return false;
    state = Object.freeze(next);
    for (const fn of [...subs]) fn(state, changed);
    return true;
  }

  const sameWindow = (a, b) => (a === b) || (a && b && a.inMs === b.inMs && a.outMs === b.outMs);

  const api = {
    getState: () => state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

    // Advance by dtRealMs of real time (clamped to MAX_TICK_MS). One notification at most.
    tick(dtRealMs) {
      if (!state.playing || !(dtRealMs > 0)) return false;
      const dt = Math.min(dtRealMs, MAX_TICK_MS);
      const nowMs = advanceNow(state, state.nowMs, (dt / 1000) * state.rate);
      return commit({ nowMs }, nowMs !== state.nowMs ? ['now'] : []);
    },
    play() { return commit({ playing: true }, state.playing ? [] : ['playing']); },
    pause() { return commit({ playing: false }, state.playing ? ['playing'] : []); },
    setPlaying(p) { return p ? api.play() : api.pause(); },
    togglePlay() { return api.setPlaying(!state.playing); },

    setNow(ms) {
      if (!Number.isFinite(ms)) return false;
      const nowMs = clamp(ms, startMs, endMs);
      return commit({ nowMs }, nowMs !== state.nowMs ? ['now'] : []);
    },
    // Relative move, clamped to the ephemeris (no wrap): the arrow keys.
    step(deltaMs) { return api.setNow(state.nowMs + deltaMs); },

    setWindow(inMs, outMs, { draft = false, minMs = MIN_WINDOW_MS } = {}) {
      const w = clampWindow(state.startMs, state.endMs, inMs, outMs, minMs);
      if (!w) return false;
      const changed = !sameWindow(w, state.window) || state.windowDraft !== draft ? ['window'] : [];
      return commit({ window: Object.freeze(w), windowDraft: draft }, changed);
    },
    clearWindow() { return commit({ window: null, windowDraft: false }, state.window ? ['window'] : []); },

    setRate(ms) {
      if (!(ms > 0)) return false;
      return commit({ rate: ms }, ms !== state.rate ? ['rate'] : []);
    },
    setLoop(on) { return commit({ loop: Boolean(on) }, Boolean(on) !== state.loop ? ['loop'] : []); },
    toggleLoop() { return api.setLoop(!state.loop); },

    // Jump to the next / previous rise or set after / before the playhead. False when there is none.
    nextEvent(events) { const t = nextEventMs(events, state.nowMs); return t === null ? false : api.setNow(t); },
    prevEvent(events) { const t = prevEventMs(events, state.nowMs); return t === null ? false : api.setNow(t); },
  };
  return api;
}

// Drives a timeline from animation frames while it plays: one tick per frame, nothing while paused.
// requestFrame / cancelFrame default to the browser's; inject fakes in tests. Returns { stop() }.
export function createPlayLoop(timeline, { requestFrame = globalThis.requestAnimationFrame, cancelFrame = globalThis.cancelAnimationFrame } = {}) {
  let frame = 0, last = null;
  const loop = (ts) => {
    frame = 0;
    if (!timeline.getState().playing) return;
    if (last !== null) timeline.tick(ts - last);
    last = ts;
    if (timeline.getState().playing && !frame) frame = requestFrame(loop);
  };
  const sync = (st) => {
    if (st.playing && !frame) { last = null; frame = requestFrame(loop); }
    if (!st.playing && frame) { cancelFrame(frame); frame = 0; }
  };
  const off = timeline.subscribe((st, changed) => { if (changed.includes('playing')) sync(st); });
  sync(timeline.getState());
  return { stop() { off(); if (frame) cancelFrame(frame); frame = 0; } };
}
