// Phase 5 P: the bottom time dock (docs/phase4/mock/structure.html, the footer). Two rows.
// Row one: the clock, one status sentence (the map's hover read-out or finding, passed in by the caller),
// a legend slot and a scale-bar slot (both take ready-made elements).
// Row two: previous event, play/pause, next event, the speed menu, the timeline (landing-date ribbon,
// draggable In/Out handles, the slip's alternative window dashed, rise/set ticks, a draggable playhead;
// a click jumps, the wheel switches between the whole ephemeris and the window), the loop switch and the
// window summary button with its popover (landing date and time, Stay, Slip, Clear window). Without a
// window the right end is "Set window from now".
// The dock drives a timeline from ../timeline.js; the caller learns every change from timeline.subscribe.
import { h, s, clear } from './dom.js';
import {
  RATES, HOUR_MS, DAY_MS, MIN_WINDOW_MS, rateLabel, viewRange, toFraction, fromFraction, snapMs,
  nextEventMs, prevEventMs, windowWithIn, windowWithOut, dragHandle,
} from '../timeline.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MINUS = '−';
const pad2 = (n) => String(n).padStart(2, '0');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const STATUS_INTERVAL_MS = 250;   // the status sentence changes at most 4 times a second
const TIGHT_WINDOW_PX = 130;             // narrower than this, the In/Out labels merge into one

// ---------- pure formatting and layout (tested in Node) ----------

export function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export function fmtShortDate(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
export function fmtMonth(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export function fmtTime(ms) {
  const d = new Date(ms);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
export function fmtDateTime(ms) {
  return `${fmtDate(ms)} ${fmtTime(ms)} UTC`;
}

// "Day 6 14:00 · 18 Jan 2027" inside the window (day 1 is the landing's UTC date), else "18 Jan 2027 14:00 UTC".
export function fmtClock(state) {
  const { nowMs, window } = state;
  if (window && nowMs >= window.inMs && nowMs <= window.outMs) {
    const day = Math.floor(nowMs / DAY_MS) - Math.floor(window.inMs / DAY_MS) + 1;
    return `Day ${day} ${fmtTime(nowMs)} · ${fmtDate(nowMs)}`;
  }
  return fmtDateTime(nowMs);
}

// A stay's length: "14 d", "9 d 13 h", "20 h".
export function fmtStay(ms) {
  const hours = Math.round(ms / HOUR_MS);
  const d = Math.floor(hours / 24), hh = hours % 24;
  if (!d) return `${hh} h`;
  return hh ? `${d} d ${hh} h` : `${d} d`;
}

export function fmtSlip(days) {
  if (!days) return 'alt same day';
  return `alt ${days > 0 ? '+' : MINUS}${Math.abs(days)} d`;
}

// The window button: "13 Jan 2027 · 14 d · alt +14 d"; short: "13 Jan · 14 d".
export function fmtWindowSummary(window, slipDays, { short = false } = {}) {
  if (!window) return '';
  const len = fmtStay(window.outMs - window.inMs);
  if (short) return `${fmtShortDate(window.inMs)} · ${len}`;
  return `${fmtDate(window.inMs)} · ${len}${slipDays === null || slipDays === undefined ? '' : ` · ${fmtSlip(slipDays)}`}`;
}

export function eventName(e) {
  const body = e.body === 'earth' ? 'Earth' : 'Sun';
  return `${body}${e.kind === 'set' ? 'set' : 'rise'}`;
}

// datetime-local value in UTC and back.
export function toInputValue(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
export function fromInputValue(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(v ?? ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

// A span clipped to the visible range, as fractions; null when wholly outside.
function clipSpan(a, b, range) {
  const fa = toFraction(a, range), fb = toFraction(b, range);
  if (fb < 0 || fa > 1) return null;
  return { left: Math.max(0, fa), right: Math.min(1, fb), clipL: fa < 0, clipR: fb > 1 };
}

// Everything the timeline draws, as fractions of its width (0 = left edge, 1 = right edge).
export function dockLayout(state, view, { slipDays = 0, events = [], range = viewRange(state, view) } = {}) {
  const w = state.window;
  const win = w ? clipSpan(w.inMs, w.outMs, range) : null;
  const alt = w && slipDays ? clipSpan(w.inMs + slipDays * DAY_MS, w.outMs + slipDays * DAY_MS, range) : null;
  const ph = toFraction(state.nowMs, range);
  const ev = [];
  for (const e of events ?? []) {
    const t = typeof e === 'number' ? e : e?.tMs;
    const f = toFraction(t, range);
    if (f >= 0 && f <= 1) ev.push({ f, tMs: t, body: e.body ?? 'sun', kind: e.kind ?? 'rise' });
  }
  return {
    range, win, alt, events: ev,
    playhead: { f: clamp(ph, 0, 1), out: ph < 0 ? 'left' : ph > 1 ? 'right' : null },
    inVisible: Boolean(win && !win.clipL), outVisible: Boolean(win && !win.clipR),
  };
}

// Global shortcuts. Returns a command or null; the caller filters by focus target.
export function keyCommand(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === ' ' || e.code === 'Space') return { type: 'play' };
  if (e.key === 'ArrowLeft') return { type: 'step', ms: -(e.shiftKey ? 6 : 1) * HOUR_MS };
  if (e.key === 'ArrowRight') return { type: 'step', ms: (e.shiftKey ? 6 : 1) * HOUR_MS };
  if (e.key === '[') return { type: 'in' };
  if (e.key === ']') return { type: 'out' };
  if (e.key === 'l' || e.key === 'L') return { type: 'loop' };
  return null;
}

// Leading-edge throttle with a guaranteed trailing call: fn runs at most once per `ms`, and the last
// value passed always lands. The clock is injectable for tests.
export function createThrottle(fn, ms, { now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let last = -Infinity, timer = null, pending;
  const fire = () => { timer = null; last = now(); fn(...pending); };
  const call = (...args) => {
    pending = args;
    const wait = last + ms - now();
    if (wait <= 0 && timer === null) fire();
    else if (timer === null) timer = setTimer(fire, Math.max(0, wait));
  };
  call.cancel = () => { if (timer !== null) clearTimer(timer); timer = null; };
  call.flush = () => { if (timer !== null) { clearTimer(timer); fire(); } };
  return call;
}

// ---------- the component ----------

const ICONS = {
  prev: 'M11 4l-5 4 5 4zM5 4v8',
  next: 'M5 4l5 4-5 4zM11 4v8',
  play: 'M5 3.5l8 4.5-8 4.5z',
  pause: 'M5.5 3.5v9M10.5 3.5v9',
  loop: 'M3 7a4 4 0 014-4h5M10 1l2 2-2 2M13 9a4 4 0 01-4 4H4M6 15l-2-2 2-2',
};
const icon = (name) => s('svg', { class: 'td-ic', viewBox: '0 0 16 16', 'aria-hidden': 'true' }, s('path', { d: ICONS[name] }));
const caret = () => h('span', { class: 'td-caret', 'aria-hidden': 'true' }, '▾');

const EDITABLE = 'input, select, textarea, [contenteditable=""], [contenteditable="true"]';
const ACTIVATES = 'button, a[href], summary, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="tab"], [role="checkbox"], [role="switch"], [role="option"], [role="radio"]';
const OWN_ARROWS = '[role="slider"], [role="radiogroup"], [role="tablist"], [role="menu"], [role="listbox"], [role="grid"], [role="tree"]';
const matches = (t, sel) => Boolean(t && t.closest && t.closest(sel));

let uid = 0;

export function createTimeDock(opts) {
  const { timeline } = opts;
  const defaultStayMs = (opts.defaultStayDays ?? 14) * DAY_MS;
  const slips = opts.slips ?? [-14, -7, -1, 0, 1, 7, 14];
  const stays = opts.stays ?? [7, 14, 30];
  const onSlip = opts.onSlip ?? (() => {});
  // phase 5 (G, review 2 F2): when given, Landing and Stay from the popover go to the caller as the requested
  // landing and stay (the page keeps the requested stay; the timeline only the part the ephemeris covers)
  const onWindowRequest = opts.onWindowRequest ?? null;
  let reduced = opts.reducedMotion ?? Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const id = `td-${++uid}`;

  let data = { ribbon: null, stayDays: 14, events: [], slipDays: 0 };
  let view = timeline.getState().window ? 'window' : 'all';
  let hadWindow = Boolean(timeline.getState().window);

  // ---- row one
  const clock = h('span', { class: 'td-clock num' });
  const statusText = h('span', { class: 'td-status-text' });
  const status = h('span', { class: 'td-status', 'aria-live': 'polite' }, statusText);
  const legendSlot = h('span', { class: 'td-slot td-legend' });
  const scaleSlot = h('span', { class: 'td-slot td-scale' });
  const row1 = h('div', { class: 'td-row td-row1' }, clock, h('span', { class: 'td-sep', 'aria-hidden': 'true' }), status, legendSlot, scaleSlot);

  // ---- row two: transport
  const prevBtn = h('button', { type: 'button', class: 'td-btn td-icon td-prev', title: 'Previous rise or set', 'aria-label': 'Previous rise or set', onclick: () => timeline.prevEvent(data.events) }, icon('prev'));
  const playBtn = h('button', { type: 'button', class: 'td-btn td-icon td-play', title: 'Play / pause (Space)', 'aria-label': 'Play', onclick: () => timeline.togglePlay() }, icon('play'));
  const nextBtn = h('button', { type: 'button', class: 'td-btn td-icon td-next', title: 'Next rise or set', 'aria-label': 'Next rise or set', onclick: () => timeline.nextEvent(data.events) }, icon('next'));
  const transport = h('span', { class: 'td-transport' }, prevBtn, playBtn, nextBtn);

  // ---- speed menu
  const speedLabel = h('span', { class: 'num' });
  const speedBtn = h('button', { type: 'button', class: 'td-btn td-line td-speed', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': `${id}-speed`, title: 'Playback speed' }, speedLabel, caret());
  const speedItems = RATES.map((r) => h('button', {
    type: 'button', class: 'td-item num', role: 'menuitemradio', 'data-ms': r.ms, tabindex: '-1',
    onclick: () => { timeline.setRate(r.ms); speedPop.close(); },
  }, r.label));
  const speedMenu = h('div', { class: 'td-pop td-speed-menu', id: `${id}-speed`, role: 'menu', 'aria-label': 'Playback speed', hidden: true }, speedItems);
  speedMenu.addEventListener('keydown', (e) => {
    const i = speedItems.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: speedItems.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    speedItems[(to + speedItems.length) % speedItems.length].focus();
  });
  const speedWrap = h('span', { class: 'td-popwrap' }, speedBtn, speedMenu);

  // ---- timeline
  const endA = h('span', { class: 'td-end num', 'aria-hidden': 'true' });
  const endB = h('span', { class: 'td-end num', 'aria-hidden': 'true' });
  const canvas = h('canvas', { class: 'td-canvas', 'aria-hidden': 'true' });
  const altBox = h('div', { class: 'td-alt', 'aria-hidden': 'true' });
  const inLabel = h('em', { class: 'td-wl td-wl-in' });
  const outLabel = h('em', { class: 'td-wl td-wl-out' });
  const handleIn = h('span', { class: 'td-handle td-handle-in', role: 'slider', tabindex: '0', 'aria-label': 'Window In (landing)', 'data-handle': 'in' });
  const handleOut = h('span', { class: 'td-handle td-handle-out', role: 'slider', tabindex: '0', 'aria-label': 'Window Out (end of stay)', 'data-handle': 'out' });
  const winBox = h('div', { class: 'td-win' }, inLabel, outLabel, handleIn, handleOut);
  const playhead = h('span', { class: 'td-ph', role: 'slider', tabindex: '0', 'aria-label': 'Playhead' });
  const hover = h('span', { class: 'td-hover num', 'aria-hidden': 'true', hidden: true });
  // phase 6 B: a story marks the rises and sets it talks about (marks) on top of the canvas ticks
  const markLayer = h('div', { class: 'td-marks', 'aria-hidden': 'true' });
  const track = h('div', { class: 'td-track', role: 'group', 'aria-label': 'Timeline' }, canvas, altBox, winBox, markLayer, playhead, hover);

  const loopBtn = h('button', { type: 'button', class: 'td-btn td-icon td-loop', title: 'Loop between In and Out (L)', 'aria-label': 'Loop between In and Out', onclick: () => timeline.toggleLoop() }, icon('loop'));

  // ---- window popover
  const sumLong = h('span', { class: 'td-sum-long num' });
  const sumShort = h('span', { class: 'td-sum-short num' });
  const sumBtn = h('button', { type: 'button', class: 'td-btn td-line td-sum', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': `${id}-win`, title: 'Landing, stay, alternative' }, sumLong, sumShort, caret());
  const landInput = h('input', { id: `${id}-land`, type: 'datetime-local', class: 'td-input num', step: 3600, autocomplete: 'off' });
  landInput.addEventListener('change', () => {
    const t0 = fromInputValue(landInput.value), w = timeline.getState().window;
    if (t0 === null || !w) return;
    const t = Math.floor(t0 / HOUR_MS) * HOUR_MS;   // review 2 F4: landings are whole hours (the input's step)
    if (t !== t0) landInput.value = toInputValue(t);
    const stayMs = (data.stayDays ?? (w.outMs - w.inMs) / DAY_MS) * DAY_MS;
    if (onWindowRequest) requestWindow(t, stayMs); else applyWindow(t, t + stayMs);
  });
  const stayBtns = stays.map((d) => h('button', { type: 'button', class: 'td-btn td-seg-btn num', 'data-days': d, 'aria-pressed': 'false', onclick: () => {
    const w = timeline.getState().window;
    if (!w) return;
    if (onWindowRequest) requestWindow(w.inMs, d * DAY_MS); else applyWindow(w.inMs, w.inMs + d * DAY_MS);
  } }, `${d} d`));
  const signed = (d) => (d > 0 ? `+${d}` : d < 0 ? `${MINUS}${-d}` : '0');
  const slipBtns = slips.map((d) => h('button', { type: 'button', class: 'td-btn td-seg-btn num', 'data-days': d, 'aria-pressed': 'false', 'aria-label': d ? `Slip ${signed(d)} days` : 'Slip 0 days, same day', onclick: () => onSlip(d) }, signed(d)));
  const clearBtn = h('button', { type: 'button', class: 'td-btn td-line td-clear', onclick: () => { winPop.close(false); timeline.clearWindow(); setWinBtn.focus(); } }, 'Clear window');
  const winPopEl = h('div', { class: 'td-pop td-winpop', id: `${id}-win`, role: 'dialog', 'aria-label': 'Mission window', hidden: true },
    h('label', { class: 'td-field', for: landInput.id }, h('span', { class: 'td-lbl' }, 'Landing (UTC)'), landInput),
    h('div', { class: 'td-field' }, h('span', { class: 'td-lbl', id: `${id}-stay` }, 'Stay'), h('div', { class: 'td-seg', role: 'group', 'aria-labelledby': `${id}-stay` }, stayBtns)),
    h('div', { class: 'td-field' }, h('span', { class: 'td-lbl', id: `${id}-slip` }, 'Slip (alternative, days)'), h('div', { class: 'td-seg', role: 'group', 'aria-labelledby': `${id}-slip` }, slipBtns)),
    // phase 5 (owner: a visible way to close everything): Done closes the popover, as Esc and a click outside do
    h('div', { class: 'td-pop-foot' }, clearBtn, h('button', { type: 'button', class: 'td-btn td-line td-done', title: 'Close (Esc)', onclick: () => winPop.close(true) }, 'Done')));
  const sumWrap = h('span', { class: 'td-popwrap td-sumwrap' }, sumBtn, winPopEl);
  const setWinBtn = h('button', { type: 'button', class: 'td-btn td-pri td-setwin', onclick: () => {
    const t = snapMs(timeline.getState().nowMs);
    applyWindow(t, t + defaultStayMs);
    view = 'window';
    renderAll();
    sumBtn.focus();
  } }, 'Set window from now');

  const row2 = h('div', { class: 'td-row td-row2' }, transport, speedWrap, endA, track, endB, loopBtn, sumWrap, setWinBtn);
  const el = h('div', { class: 'timedock', role: 'region', 'aria-label': 'Time and playback' }, row1, row2);

  // ---- popovers: one open at a time; Esc and an outside click close; focus returns to the button
  const pops = [];
  function popover(btn, panel, focusFirst) {
    const p = {
      open() {
        pops.forEach((o) => o !== p && o.close(false));
        panel.hidden = false; btn.setAttribute('aria-expanded', 'true');
        el.classList.add('has-pop');
        el.style.setProperty('--td-pop-left', `${btn.getBoundingClientRect().left - el.getBoundingClientRect().left}px`);
        renderAll();
        focusFirst()?.focus();
      },
      close(restore = true) {
        if (panel.hidden) return;
        panel.hidden = true; btn.setAttribute('aria-expanded', 'false');
        el.classList.toggle('has-pop', pops.some((o) => o.isOpen()));
        if (restore) btn.focus();
      },
      isOpen: () => !panel.hidden,
    };
    btn.addEventListener('click', () => (p.isOpen() ? p.close() : p.open()));
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); p.close(); } });
    pops.push(p);
    return p;
  }
  const speedPop = popover(speedBtn, speedMenu, () => speedItems.find((b) => Number(b.dataset.ms) === timeline.getState().rate) ?? speedItems[0]);
  const winPop = popover(sumBtn, winPopEl, () => landInput);
  const onDocDown = (e) => { for (const [p, wrap] of [[speedPop, speedWrap], [winPop, sumWrap]]) if (p.isOpen() && !wrap.contains(e.target)) p.close(false); };
  document.addEventListener('pointerdown', onDocDown, true);

  function requestWindow(inMs, stayMs) {
    onWindowRequest({ inMs, stayMs });
    const st = timeline.getState();
    if (st.window && (st.nowMs < st.window.inMs || st.nowMs > st.window.outMs)) timeline.setNow(st.window.inMs);
  }
  // A window set from the popover or the button: the playhead goes to In if it would be outside.
  function applyWindow(inMs, outMs) {
    timeline.setWindow(inMs, outMs);
    const st = timeline.getState();
    if (st.window && (st.nowMs < st.window.inMs || st.nowMs > st.window.outMs)) timeline.setNow(st.window.inMs);
  }

  // ---- drawing
  let width = 0, height = 32;
  let colours = null;
  function readColours() {
    const cs = getComputedStyle(el);
    const v = (n, f) => cs.getPropertyValue(n).trim() || f;
    colours = { both: v('--both', '#e6e6e6'), sun: v('--sun', '#f2b33d'), earth: v('--earth', '#4cb3f0'), muted: v('--muted', '#b4b4b4') };
  }
  let layout = null;

  function drawCanvas() {
    if (!width) return;
    const dpr = globalThis.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    }
    if (!colours) readColours();
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    const range = layout.range;
    const X = (t) => toFraction(t, range) * width;
    // ribbon: one bar per landing day, its strength the share of the stay with both bodies in view
    const RY = 10, RH = 12;
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(255, 255, 255, 0.07)';
    roundRect(g, 0, RY, width, RH, 3); g.fill();
    const rb = data.ribbon;
    if (rb && rb.dayMs?.length) {
      g.save();
      roundRect(g, 0, RY, width, RH, 3); g.clip();
      g.fillStyle = colours.both;
      const stayMs = (data.stayDays || 14) * DAY_MS;
      const n = rb.dayMs.length;
      // only the days in view (binary search for the first)
      let lo = 0, hi = n;
      while (lo < hi) { const m = (lo + hi) >> 1; if (rb.dayMs[m] + DAY_MS < range.startMs) lo = m + 1; else hi = m; }
      for (let i = lo; i < n && rb.dayMs[i] <= range.endMs; i++) {
        const share = rb.bothMs[i] / stayMs;
        if (!(share > 0)) continue;
        // whole device pixels, edge to edge: no overlap, so no lighter seams between bars
        const x0 = Math.round(X(rb.dayMs[i]) * dpr) / dpr, x1 = Math.round(X(rb.dayMs[i] + DAY_MS) * dpr) / dpr;
        if (x1 <= x0) continue;
        g.globalAlpha = 0.9 * Math.min(1, share);
        g.fillRect(x0, RY, x1 - x0, RH);
      }
      g.restore();
    }
    // tidy ticks under the ribbon: month starts over the whole data, days in the window view
    g.globalAlpha = 0.55; g.fillStyle = colours.muted;
    const dayPx = (DAY_MS / (range.endMs - range.startMs)) * width;
    if (dayPx >= 6) {
      for (let t = Math.ceil(range.startMs / DAY_MS) * DAY_MS; t <= range.endMs; t += DAY_MS) {
        const major = new Date(t).getUTCDate() === 1;
        g.fillRect(Math.round(X(t)) - 0.5, RY + RH + 2, 1, major ? 5 : 3);
      }
    } else {
      const d0 = new Date(range.startMs);
      for (let y = d0.getUTCFullYear(), m = d0.getUTCMonth(); ; m++) {
        if (m > 11) { m = 0; y++; }
        const t = Date.UTC(y, m, 1);
        if (t > range.endMs) break;
        if (t < range.startMs) continue;
        g.fillRect(Math.round(X(t)) - 0.5, RY + RH + 2, 1, m === 0 ? 5 : 3);
      }
    }
    // rise and set ticks above
    g.globalAlpha = 1;
    for (const e of layout.events) {
      g.fillStyle = e.body === 'earth' ? colours.earth : colours.sun;
      g.fillRect(Math.round(e.f * width) - 1, 0, 2, 7);
    }
  }

  function roundRect(g, x, y, w, hh, r) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, hh, r); else g.rect(x, y, w, hh);
  }

  const pct = (f) => `${(f * 100).toFixed(3)}%`;

  function renderAll() {
    const st = timeline.getState();
    if (Boolean(st.window) !== hadWindow) { hadWindow = Boolean(st.window); view = st.window ? 'window' : 'all'; }
    if (!st.window) view = 'all';
    // phase 6 B: a story can hold the timeline on its own range (both of its windows in view)
    layout = dockLayout(st, view, { ...data, range: drag?.range ?? data.viewRange ?? undefined });
    el.dataset.window = st.window ? 'on' : 'off';
    el.dataset.view = view;
    el.dataset.playing = String(st.playing);
    // transport
    playBtn.replaceChildren(icon(st.playing ? 'pause' : 'play'));
    playBtn.setAttribute('aria-label', st.playing ? 'Pause' : 'Play');
    playBtn.setAttribute('aria-pressed', String(st.playing));
    const hasEvents = (data.events?.length ?? 0) > 0;
    prevBtn.hidden = nextBtn.hidden = !hasEvents;
    speedLabel.textContent = rateLabel(st.rate);
    speedItems.forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.ms) === st.rate)));
    // ends: the data's first and last month in the 'all' view
    endA.hidden = endB.hidden = view !== 'all';
    endA.textContent = fmtMonth(layout.range.startMs);
    endB.textContent = fmtMonth(layout.range.endMs);
    // window box, labels, handles
    const w = st.window;
    winBox.hidden = !layout.win;
    if (layout.win) {
      winBox.style.left = pct(layout.win.left);
      winBox.style.width = pct(layout.win.right - layout.win.left);
      winBox.dataset.clipL = String(layout.win.clipL);
      winBox.dataset.clipR = String(layout.win.clipR);
      const px = (layout.win.right - layout.win.left) * width;
      const tight = px < TIGHT_WINDOW_PX;
      winBox.dataset.tight = String(tight);
      inLabel.textContent = tight ? `${fmtShortDate(w.inMs)} – ${fmtShortDate(w.outMs)}` : `In · ${fmtShortDate(w.inMs)}`;
      outLabel.textContent = `Out · ${fmtShortDate(w.outMs)}`;
      inLabel.hidden = !layout.inVisible && !tight;
      outLabel.hidden = tight || !layout.outVisible;
      handleIn.hidden = !layout.inVisible;
      handleOut.hidden = !layout.outVisible;
      handleIn.setAttribute('aria-valuetext', `In, ${fmtDateTime(w.inMs)}`);
      handleOut.setAttribute('aria-valuetext', `Out, ${fmtDateTime(w.outMs)}, stay ${fmtStay(w.outMs - w.inMs)}`);
      for (const [hd, v] of [[handleIn, w.inMs], [handleOut, w.outMs]]) {
        hd.setAttribute('aria-valuemin', String(st.startMs)); hd.setAttribute('aria-valuemax', String(st.endMs)); hd.setAttribute('aria-valuenow', String(v));
      }
    }
    // phase 6 B: the window or the alternative a story step points at, and its marked rises and sets
    winBox.classList.toggle('is-focus', data.focus === 'win');
    altBox.classList.toggle('is-focus', data.focus === 'alt');
    clear(markLayer);
    for (const m of data.marks ?? []) {
      const f = toFraction(m.tMs, layout.range);
      if (!(f >= 0 && f <= 1)) continue;
      markLayer.append(h('span', { class: `td-mark td-mark-${m.body === 'earth' ? 'earth' : 'sun'}`, style: `left:${pct(f)}`, 'data-t': new Date(m.tMs).toISOString() }));
    }
    altBox.hidden = !layout.alt;
    if (layout.alt) {
      altBox.style.left = pct(layout.alt.left);
      altBox.style.width = pct(layout.alt.right - layout.alt.left);
      altBox.dataset.clipL = String(layout.alt.clipL);
      altBox.dataset.clipR = String(layout.alt.clipR);
      altBox.title = `Alternative: ${fmtSlip(data.slipDays).replace('alt ', '')}`;
    }
    // loop, summary, set-window
    loopBtn.hidden = !w;
    loopBtn.setAttribute('aria-pressed', String(st.loop));
    sumWrap.hidden = !w;
    setWinBtn.hidden = Boolean(w);
    if (w) {
      // with a caller that keeps the requested stay, the summary and the Stay buttons name that stay (the
      // timeline's window may be cut by the end of the ephemeris)
      const wr = onWindowRequest && Number.isFinite(data.stayDays) ? { inMs: w.inMs, outMs: w.inMs + data.stayDays * DAY_MS } : w;
      sumLong.textContent = fmtWindowSummary(wr, data.slipDays);
      sumShort.textContent = fmtWindowSummary(wr, data.slipDays, { short: true });
      sumBtn.setAttribute('aria-label', `Mission window: landing ${fmtDateTime(w.inMs)}, stay ${fmtStay(wr.outMs - wr.inMs)}, ${fmtSlip(data.slipDays)}`);
      if (!winPopEl.hidden) {
        if (document.activeElement !== landInput) landInput.value = toInputValue(w.inMs);
        landInput.min = toInputValue(st.startMs); landInput.max = toInputValue(st.endMs - (onWindowRequest ? HOUR_MS : MIN_WINDOW_MS));
        stayBtns.forEach((b) => b.setAttribute('aria-pressed', String(wr.outMs - wr.inMs === Number(b.dataset.days) * DAY_MS)));
        slipBtns.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.days) === data.slipDays)));
      }
    } else {
      winPop.close(false);
    }
    status.setAttribute('aria-live', st.playing ? 'off' : 'polite');
    drawCanvas();
    renderNow();
  }

  let lastValueText = -Infinity;
  function renderNow(force = false) {
    const st = timeline.getState();
    const range = layout.range;
    const f = toFraction(st.nowMs, range);
    playhead.style.left = pct(clamp(f, 0, 1));
    playhead.dataset.out = f < 0 ? 'left' : f > 1 ? 'right' : '';
    const text = fmtClock(st);
    if (clock.textContent !== text) clock.textContent = text;
    if (data.events?.length) {
      prevBtn.disabled = prevEventMs(data.events, st.nowMs) === null;
      nextBtn.disabled = nextEventMs(data.events, st.nowMs) === null;
    }
    // while playing, the slider's text changes at most once a second (screen readers are not flooded)
    const t = performance.now();
    if (force || !st.playing || t - lastValueText >= 1000) {
      lastValueText = t;
      playhead.setAttribute('aria-valuetext', fmtDateTime(st.nowMs));
      playhead.setAttribute('aria-valuemin', String(st.startMs));
      playhead.setAttribute('aria-valuemax', String(st.endMs));
      playhead.setAttribute('aria-valuenow', String(Math.round(st.nowMs)));
    }
  }

  const unsub = timeline.subscribe((st, changed) => {
    if (changed.length === 1 && changed[0] === 'now') renderNow();
    else renderAll();
  });

  // ---- pointer: drag a handle, or scrub (pause while scrubbing, resume after), click to jump
  let drag = null;
  const msAt = (clientX) => {
    const box = drag?.box ?? track.getBoundingClientRect();
    return fromFraction(clamp((clientX - box.left) / box.width, 0, 1), drag?.range ?? layout.range);
  };
  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    const which = e.target.closest?.('[data-handle]')?.dataset.handle;
    const st = timeline.getState();
    drag = which && st.window
      ? { which, window: st.window, range: { ...layout.range }, box: track.getBoundingClientRect() }
      : { which: null, resume: st.playing };
    if (!which) { timeline.pause(); timeline.setNow(snapMs(msAt(e.clientX))); }
    track.setPointerCapture?.(e.pointerId);
    track.classList.add('is-dragging');
    hover.hidden = true;
    e.preventDefault();
  });
  track.addEventListener('pointermove', (e) => {
    if (drag) {
      const ms = msAt(e.clientX);
      if (drag.which) { const w = dragHandle(drag.window, drag.which, ms); timeline.setWindow(w.inMs, w.outMs, { draft: true }); }
      else timeline.setNow(snapMs(ms));
      return;
    }
    showHover(e.clientX);
  });
  const endDrag = () => {
    if (!drag) return;
    const d = drag; drag = null;
    track.classList.remove('is-dragging');
    if (d.which) { const w = timeline.getState().window; if (w) timeline.setWindow(w.inMs, w.outMs); renderAll(); }
    else if (d.resume) timeline.play();
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('pointerleave', () => { if (!drag) hover.hidden = true; });
  track.addEventListener('wheel', (e) => {
    if (drag || !timeline.getState().window || !e.deltaY) return;
    e.preventDefault();
    const next = e.deltaY < 0 ? 'window' : 'all';
    if (next !== view) { view = next; renderAll(); }
  }, { passive: false });

  function showHover(clientX) {
    const box = track.getBoundingClientRect();
    const f = clamp((clientX - box.left) / box.width, 0, 1);
    const ms = fromFraction(f, layout.range);
    const near = layout.events.find((ev) => Math.abs(ev.f - f) * box.width <= 4);
    hover.textContent = near ? `${eventName(near)} · ${fmtShortDate(near.tMs)} ${fmtTime(near.tMs)}` : `${fmtDate(ms)} ${fmtTime(snapMs(ms))}`;
    hover.hidden = false;
    const half = hover.offsetWidth / 2;
    hover.style.left = `${clamp(f * box.width, half, box.width - half)}px`;
  }

  // ---- keyboard on the sliders
  playhead.addEventListener('keydown', (e) => {
    const st = timeline.getState();
    const w = st.window;
    const moves = {
      ArrowLeft: -(e.shiftKey ? 6 : 1) * HOUR_MS, ArrowDown: -(e.shiftKey ? 6 : 1) * HOUR_MS,
      ArrowRight: (e.shiftKey ? 6 : 1) * HOUR_MS, ArrowUp: (e.shiftKey ? 6 : 1) * HOUR_MS,
      PageDown: -DAY_MS, PageUp: DAY_MS,
    };
    if (e.key in moves) { e.preventDefault(); timeline.step(moves[e.key]); renderNow(true); return; }
    if (e.key === 'Home') { e.preventDefault(); timeline.setNow(w ? w.inMs : st.startMs); renderNow(true); }
    if (e.key === 'End') { e.preventDefault(); timeline.setNow(w ? w.outMs : st.endMs); renderNow(true); }
  });
  for (const hd of [handleIn, handleOut]) {
    hd.addEventListener('keydown', (e) => {
      const w = timeline.getState().window;
      if (!w) return;
      const dir = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -7, PageUp: 7 }[e.key];
      if (dir === undefined) return;
      e.preventDefault();
      const step = dir * (e.shiftKey && Math.abs(dir) === 1 ? 7 : 1) * DAY_MS;
      const which = hd.dataset.handle;
      const next = dragHandle(w, which, (which === 'in' ? w.inMs : w.outMs) + step);
      timeline.setWindow(next.inMs, next.outMs);
    });
  }

  // ---- global shortcuts
  function onKey(e) {
    if (e.defaultPrevented) return;
    const cmd = keyCommand(e);
    if (!cmd) return;
    const t = e.target;
    if (matches(t, EDITABLE)) return;
    if (cmd.type === 'play' && matches(t, ACTIVATES)) return;
    if (cmd.type === 'step' && matches(t, OWN_ARROWS)) return;
    const st = timeline.getState();
    e.preventDefault();
    if (cmd.type === 'play') timeline.togglePlay();
    else if (cmd.type === 'step') { timeline.step(cmd.ms); renderNow(true); }
    else if (cmd.type === 'loop') { if (st.window) timeline.toggleLoop(); }
    else {
      const now = snapMs(st.nowMs);
      const w = cmd.type === 'in' ? windowWithIn(st.window, now, defaultStayMs) : windowWithOut(st.window, now, defaultStayMs);
      timeline.setWindow(w.inMs, w.outMs);
    }
  }
  if (opts.keyboard !== false) document.addEventListener('keydown', onKey);

  // ---- size
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null;
  function measure() {
    const r = track.getBoundingClientRect();
    if (r.width === width && r.height === height) return;
    width = r.width; height = r.height || 32;
    renderAll();
  }
  ro?.observe(track);

  // ---- status sentence, throttled
  const pushStatus = createThrottle((text, muted) => {
    statusText.textContent = text ?? '';
    status.dataset.tone = muted ? 'muted' : '';
  }, STATUS_INTERVAL_MS);

  renderAll();
  if (opts.autoplay !== false && !reduced) timeline.play();

  return {
    el,
    update(patch) {
      data = { ...data, ...patch };
      renderAll();
    },
    setStatus(text, { muted = false } = {}) { pushStatus(text, muted); },
    mount(slot, node) {
      const target = { legend: legendSlot, scale: scaleSlot, status }[slot];
      if (!target) throw new Error(`timedock.mount: unknown slot ${slot}`);
      clear(target);
      if (node) target.append(node);
    },
    setView(v) { if (v === 'all' || v === 'window') { view = v; renderAll(); } },
    getView: () => view,
    setReducedMotion(on) { reduced = Boolean(on); if (reduced) timeline.pause(); },
    // re-read the palette after a colour preset change, then redraw the ribbon and ticks
    refreshColours() { colours = null; renderAll(); },
    destroy() {
      unsub(); pushStatus.cancel(); ro?.disconnect();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDocDown, true);
    },
  };
}
