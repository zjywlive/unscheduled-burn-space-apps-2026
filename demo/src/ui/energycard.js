// Energy card (phase 4 §6 E): the battery over the stay for the planned and the alternative landing, from
// relative panel power (cosine law, zero behind terrain) and assumed panel, battery and sleep ratios.
// No watts: power is a share of the panel's rating, energy and capacity are hours of average load.
// (fix R6) A change reads "+62 h worse" or "−24 h better": the sign is the direction of the change and the
// word says whether it is worse or better; a worse one is also drawn in --negative. No arrow glyphs, so
// an arrow can never disagree with the sign, and colour is never the only cue.
//
// createEnergyCard(deps, { onChange(assumptions) }) → { el, update(params), assumptions() }
// deps: { assumptions?: Partial<ENERGY_DEFAULTS> }   starting values, e.g. restored by the caller
// params: {
//   eph,                                      ephemeris.js createEphemeris() object
//   planned: { site, landingMs, mask },       mask: terrain.js skylineFor(dem, site), as main.js sky(site)
//   alternative: { site, landingMs, mask } | null,   null when nothing is compared
//   stayDays: number,
//   cursorMs?: number | null,                 the time cursor, for "Panel now"
//   plannedLabel?: string, altLabel?: string, column sub-heads, e.g. '13 Jan', 'Haworth, 27 Jan'
//   altNote?: string | null,                  shown when alternative is null
//   assumptions?: Partial<ENERGY_DEFAULTS>,   overrides the card's own (e.g. from a command)
// }
import { h, s, clear } from './dom.js';
import { fmtHours, fmtDeg, fmtPct, DASH } from '../format.js';
import { ENERGY_DEFAULTS, cleanAssumptions, planEnergyPair, bestAngleAt } from '../energy.js';

const MINUS = '−';
const H = 3600e3;
const ATT = [
  ['track', 'Vertical, turns to Sun'],
  ['fixed', 'Fixed, best angle'],
  ['flat', 'Horizontal'],
];
const RATIO = { min: 0.5, max: 6, step: 0.25 };
const BATTERY = { min: 0, max: 200, step: 2 };
const SLEEP = { min: 0, max: 100, step: 5 };
const POLAR = 'Near the pole the Sun stays within a few degrees of the horizon, so a vertical panel turned to the Sun’s azimuth is near optimal and a horizontal one generates almost nothing.';
const CAVEATS = [
  'Relative power only: no watts, no hardware model.',
  'Cosine law on the panel; zero while the Sun is behind terrain.',
  'No partial shading of the Sun’s disc, no thermal model, no dust.',
  'Not coupled to a route: the rover stays at the site.',
];
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
const sign = (v) => (v > 0 ? '+' : v < 0 ? MINUS : '');
// a share as a whole percent, but never a bare 0% for something that is not zero
const share = (v) => (!ok(v) ? DASH : v > 0 && v < 0.005 ? 'under 1%' : fmtPct(v));
const ratioText = (v) => `${Number(v.toFixed(2))}×`;
let uid = 0;
// a stable id per skyline function, so a new skyline for the same site recomputes
const maskIds = new WeakMap();
let maskSeq = 0;
const maskKey = (m) => (typeof m === 'function' ? (maskIds.get(m) ?? (maskIds.set(m, ++maskSeq), maskSeq)) : `c${m ?? 0}`);

// Hours as fmtHours shows them, so a change is the difference of the two figures on screen (compare.js).
const shownHours = (h0) => (Math.round(h0 * 10) / 10 >= 10 ? Math.round(h0) : Math.round(h0 * 10) / 10);
const hrs = (h0) => (ok(h0) ? fmtHours(h0 * H) : DASH);
const azText = (az) => (ok(az) ? `${Math.round(((az % 360) + 360) % 360)}°` : DASH);
// The facing (azimuth the panel face points to) as the value, the tilt from horizontal as a sub-line.
const facingText = (azDeg) => `Facing ${azText(azDeg)}`;
const tiltText = (tiltDeg) => (!ok(tiltDeg) ? DASH : tiltDeg >= 89.5 ? 'Vertical' : tiltDeg <= 0.5 ? 'Flat' : `Tilt ${Math.round(tiltDeg)}°`);

// The change from planned to alternative as on screen: { text: '+62 h worse' | '−24 h better' | '+3 h' |
// 'no change', worse } or null. worseWhen: 'up' (more is worse), 'down' (less is worse) or neither.
export function changeText(pv, av, worseWhen) {
  if (!ok(pv) || !ok(av)) return null;
  const d = Math.round((shownHours(av) - shownHours(pv)) * 10) / 10;
  if (d === 0) return { text: 'no change', worse: false };
  const decimals = Number.isInteger(shownHours(av)) && Number.isInteger(shownHours(pv)) ? 0 : 1;
  const judged = worseWhen === 'up' || worseWhen === 'down';
  const worse = worseWhen === 'up' ? d > 0 : worseWhen === 'down' ? d < 0 : false;
  return { text: `${sign(d)}${Math.abs(d).toFixed(decimals)} h${judged ? (worse ? ' worse' : ' better') : ''}`, worse };
}

function slider(id, label, range, value, show, onInput) {
  const input = h('input', { type: 'range', class: 'range', id, min: range.min, max: range.max, step: range.step, value });
  const out = h('output', { class: 'energy-value num', for: id });
  input.addEventListener('input', () => onInput(Number(input.value)));
  const el = h('div', { class: 'energy-field' },
    h('div', { class: 'energy-field-head' },
      h('label', { for: id }, label, ' ', h('span', { class: 'energy-assumed' }, 'assumed')), out),
    input);
  function set(v) {
    if (Number(input.value) !== v) input.value = String(v);
    out.textContent = show(v);
    input.setAttribute('aria-valuetext', `${show(v)}, assumed`);
  }
  return { el, set };
}

export function createEnergyCard(deps = {}, callbacks = {}) {
  const id = `lsn-energy-${++uid}`;
  let cur = cleanAssumptions({ ...ENERGY_DEFAULTS, ...(deps.assumptions ?? {}) });
  let last = null, planKey = '', pair = null;

  const el = h('section', { class: 'energy-card', 'aria-labelledby': `${id}-head` });
  const select = h('select', { class: 'select energy-select', id: `${id}-att`, 'aria-describedby': `${id}-att-note` },
    ATT.map(([v, t]) => h('option', { value: v }, t)));
  select.addEventListener('change', () => set({ attitude: select.value }));
  const ratio = slider(`${id}-ratio`, 'Panel ÷ load', RATIO, cur.panelToLoad, ratioText, (v) => set({ panelToLoad: v }));
  const battery = slider(`${id}-bat`, 'Battery', BATTERY, cur.batteryHours, (v) => `${v} h of load`, (v) => set({ batteryHours: v }));
  const sleep = slider(`${id}-sleep`, 'Sleep load', SLEEP, Math.round(cur.sleepLoad * 100), (v) => `${v}%`, (v) => set({ sleepLoad: v / 100 }));
  const reset = h('button', { type: 'button', class: 'text-btn energy-reset', onclick: () => set({ ...ENERGY_DEFAULTS }) }, 'Reset');
  const body = h('div', { class: 'energy-body' });
  // G (phase 4 step 2, coordinator's layout rule): figures first; the assumption controls and the notes are
  // one click away in disclosures closed by default, so the card fits the floating panel.
  const notesBody = h('div', { class: 'fold-more-body' });
  const notesBox = h('details', { class: 'fold-more energy-notes' }, h('summary', null, 'Notes'), notesBody);

  el.append(
    h('div', { class: 'card-head card-head-stack' }, h('h2', { id: `${id}-head` }, 'Energy'),
      h('p', { class: 'card-sub' }, 'Battery over the stay, in hours of average load')),
    body,
    h('details', { class: 'fold-more energy-more' }, h('summary', null, 'Assumptions'), h('fieldset', { class: 'energy-assumptions' },
      h('legend', { class: 'energy-legend' }, 'Assumptions, not data', reset),
      h('div', { class: 'energy-field' },
        h('div', { class: 'energy-field-head' },
          h('label', { for: select.id }, 'Panel', ' ', h('span', { class: 'energy-assumed' }, 'assumed'))),
        select,
        h('p', { class: 'energy-note', id: `${id}-att-note` }, 'Fixed uses the best tilt and facing for each stay.')),
      ratio.el,
      h('p', { class: 'energy-note' }, 'Rated panel power ÷ average load. Load is full while sunlit, the sleep share while dark.'),
      battery.el,
      sleep.el)));

  function syncControls() {
    select.value = cur.attitude;
    ratio.set(cur.panelToLoad);
    battery.set(cur.batteryHours);
    sleep.set(Math.round(cur.sleepLoad * 100));
    reset.hidden = ['attitude', 'panelToLoad', 'batteryHours', 'sleepLoad'].every((k) => cur[k] === ENERGY_DEFAULTS[k]);
  }

  function set(patch) {
    cur = cleanAssumptions({ ...cur, ...patch });
    syncControls();
    callbacks.onChange?.({ ...cur });
    render();
  }

  // ---------- the chart ----------
  let cursorGeo = null;
  // The battery charge of the planned stay at an instant (the curve's value), and where it is drawn.
  function setCursor(ms) {
    const c = cursorGeo;
    if (!c) return;
    const r = c.p, t = ms - r.startMs;
    const inside = Number.isFinite(ms) && t >= 0 && t <= r.stayMs;
    c.g.setAttribute('display', inside ? 'inline' : 'none');
    if (!inside) return;
    const bins = r.series.bins;
    let k = 0;
    while (k < bins.length - 1 && bins[k + 1].t0 <= ms) k++;
    const v = r.sim.soc[Math.min(k, r.sim.soc.length - 1)];
    const px = c.x(t).toFixed(1), py = c.y(v).toFixed(1);
    c.line.setAttribute('x1', px); c.line.setAttribute('x2', px);
    c.dot.setAttribute('cx', px); c.dot.setAttribute('cy', py);
    c.text.textContent = `${hrs(v)} now`;
    const right = Number(px) > (c.L + c.W - c.R) / 2;
    c.text.setAttribute('x', String(Number(px) + (right ? -6 : 6)));
    c.text.setAttribute('text-anchor', right ? 'end' : 'start');
  }

  function chart(p, a, labels) {
    const W = Math.max(240, Math.round(el.clientWidth ? el.clientWidth : 272));
    const L = 40, R = 34, T = 8, PH = 92, BAND = 6, GAP = 5, AX = 18;
    const bandP = T + PH + 14, bandA = bandP + BAND + GAP;
    const Ht = (a ? bandA + BAND : bandP + BAND) + AX;
    const span = p.stayMs || 1;
    const C = p.assumptions.batteryHours;
    const top = C > 0 ? C : 1;
    const x = (ms) => L + (ms / span) * (W - L - R);
    const y = (v) => T + (1 - v / top) * PH;
    const path = (r) => r.sim.soc.map((v, k) => {
      const t = k < r.series.bins.length ? r.series.bins[k].t0 - r.startMs : r.stayMs;
      return `${k ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`;
    }).join('');
    const spans = (r) => r.series.intervals.map(([t0, t1]) => [t0 - r.startMs, t1 - r.startMs]);
    const rect = (cls, [t0, t1], y0, hh) => s('rect', { class: cls, x: x(t0).toFixed(1), y: y0, width: Math.max(0.6, x(t1) - x(t0)).toFixed(1), height: hh });
    const end = (r) => y(r.sim.soc[r.sim.soc.length - 1]);
    let yP = end(p), yA = a ? end(a) : null;
    if (a && Math.abs(yP - yA) < 11) { const mid = (yP + yA) / 2; const up = yP <= yA ? -1 : 1; yP = mid + up * 5.5; yA = mid - up * 5.5; }
    // phase 5 (review 2 F7): the playhead on the battery curve, moved by setCursor() without a re-render
    const cursorLine = s('line', { class: 'energy-cursor', x1: 0, x2: 0, y1: T, y2: bandP + BAND });
    const cursorDot = s('circle', { class: 'energy-cursor-dot', r: 3, cx: 0, cy: 0 });
    const cursorText = s('text', { class: 'energy-cursor-label', x: 0, y: T + 10 });
    const cursorG = s('g', { class: 'energy-cursor-g' }, cursorLine, cursorDot, cursorText);
    cursorGeo = { x, y, p, L, W, R, line: cursorLine, dot: cursorDot, text: cursorText, g: cursorG };
    const days = Math.round((p.stayMs / 86400e3) * 10) / 10;
    const label = `Battery charge over the ${days}-day stay, 0 to ${C} hours of load. Planned: empty for ${hrs(p.sim.emptyH)}, lowest charge ${hrs(p.sim.minSocH)}.`
      + (a ? ` Alternative: empty for ${hrs(a.sim.emptyH)}, lowest charge ${hrs(a.sim.minSocH)}.` : '');
    const svg = s('svg', { class: 'energy-svg', width: W, height: Ht, viewBox: `0 0 ${W} ${Ht}`, role: 'img', 'aria-label': label },
      s('g', { 'aria-hidden': 'true' },
        spans(p).map((iv) => rect('energy-lit', iv, T, PH)),
        s('line', { class: 'grid', x1: L, x2: W - R, y1: y(0), y2: y(0) }),
        s('line', { class: 'grid', x1: L, x2: W - R, y1: y(top), y2: y(top) }),
        s('text', { class: 'tick', x: L - 6, y: y(top) + 4, 'text-anchor': 'end' }, `${C} h`),
        s('text', { class: 'tick', x: L - 6, y: y(0) + 4, 'text-anchor': 'end' }, '0 h'),
        a ? s('path', { class: 'energy-line is-alt', d: path(a) }) : null,
        s('path', { class: 'energy-line is-planned', d: path(p) }),
        s('text', { class: 'energy-end', x: W - R + 4, y: yP + 4 }, 'Plan'),
        a ? s('text', { class: 'energy-end is-alt', x: W - R + 4, y: yA + 4 }, 'Alt') : null,
        s('text', { class: 'tick', x: L - 6, y: bandP + 6, 'text-anchor': 'end' }, a ? 'Sun P' : 'Sun'),
        s('rect', { class: 'energy-track', x: L, y: bandP, width: W - L - R, height: BAND }),
        spans(p).map((iv) => rect('energy-band', iv, bandP, BAND)),
        a ? [
          s('text', { class: 'tick', x: L - 6, y: bandA + 6, 'text-anchor': 'end' }, 'Sun A'),
          s('rect', { class: 'energy-track', x: L, y: bandA, width: W - L - R, height: BAND }),
          spans(a).map((iv) => rect('energy-band', iv, bandA, BAND)),
        ] : null,
        cursorG,
        s('text', { class: 'tick', x: L, y: Ht - 4 }, 'Day 1'),
        s('text', { class: 'tick', x: W - R, y: Ht - 4, 'text-anchor': 'end' }, `Day ${Math.max(1, Math.ceil(p.stayMs / 86400e3 - 1e-9))}`)));
    const key = h('p', { class: 'energy-key', 'aria-hidden': 'true' },
      h('span', { class: 'energy-key-item' }, h('span', { class: 'energy-swatch is-planned' }), `Planned${labels.planned ? `, ${labels.planned}` : ''}`),
      a ? h('span', { class: 'energy-key-item' }, h('span', { class: 'energy-swatch is-alt' }), `Alternative${labels.alt ? `, ${labels.alt}` : ''}`) : null,
      h('span', { class: 'energy-key-item' }, h('span', { class: 'energy-swatch is-sun' }), 'Sunlit'));
    return h('div', { class: 'chart energy-chart' }, key, svg);
  }

  // ---------- the table ----------
  function change(pv, av, worseWhen) {
    const c = changeText(pv, av, worseWhen);
    return c ? h('span', { class: `change${c.worse ? ' is-worse' : ''}` }, c.text) : null;
  }

  function nowCell(n) {
    if (!n) return h('td', { class: 'n' }, h('span', { class: 'value' }, DASH));
    if (!n.lit) return h('td', { class: 'n' }, h('span', { class: 'value value-text' }, 'Sun behind terrain'), h('span', { class: 'sub num' }, `Sun ${fmtDeg(n.elDeg)}, az ${azText(n.azDeg)}`));
    return h('td', { class: 'n' }, h('span', { class: 'value num' }, facingText(n.azDeg)), h('span', { class: 'sub num' }, tiltText(n.tiltDeg)), h('span', { class: 'sub num' }, `Sun ${fmtDeg(n.elDeg)} up`));
  }

  function table(p, a, nowP, nowA, labels) {
    const hourRow = (label, get, worseWhen, lead = false) => h('tr', { class: lead ? 'is-lead' : null },
      Array.isArray(label) ? h('th', { scope: 'row' }, label[0], h('span', { class: 'th-sub' }, label[1])) : h('th', { scope: 'row' }, label),
      h('td', { class: 'n' }, h('span', { class: 'value num' }, hrs(get(p)))),
      h('td', { class: 'n' }, h('span', { class: 'value num' }, a ? hrs(get(a)) : DASH), a ? change(get(p), get(a), worseWhen) : null));
    const fixedCell = (r) => (r?.bestFixed
      ? h('td', { class: 'n' }, h('span', { class: 'value num' }, facingText(r.bestFixed.azDeg)), h('span', { class: 'sub num' }, tiltText(r.bestFixed.tiltDeg)),
        h('span', { class: 'sub num' }, ok(r.bestFixed.vsTrack) ? `${share(r.bestFixed.vsTrack)} of tracking` : DASH))
      : h('td', { class: 'n' }, h('span', { class: 'value' }, DASH)));
    return h('table', { class: 'energy-table' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Measure')),
        h('th', { scope: 'col', class: 'n' }, 'Planned', labels.planned ? h('span', { class: 'th-sub' }, labels.planned) : null),
        h('th', { scope: 'col', class: 'n' }, 'Alternative', h('span', { class: 'th-sub' }, a ? labels.alt || '' : DASH)))),
      h('tbody', null,
        // (fix R6) sim.emptyH is the time the battery spends empty; sim.minBatteryH the smallest capacity
        // that never runs empty over the stay (energy.js minBattery), not the lowest charge on the chart
        hourRow(['Battery empty', 'Hours with no charge'], (r) => r.sim.emptyH, 'up', true),
        hourRow(['Battery needed', 'To never run empty'], (r) => r.sim.minBatteryH, 'up'),
        hourRow('Sunlit', (r) => r.litMs / H, 'down'),
        hourRow(['Charging', 'Panel covers load'], (r) => r.sim.chargingH, 'down'),
        hourRow(['Asleep', 'Dark, sleep load'], (r) => r.sim.sleepH, 'up'),
        h('tr', null, h('th', { scope: 'row' }, 'Best fixed'), fixedCell(p), a ? fixedCell(a) : h('td', { class: 'n' }, DASH)),
        h('tr', null, h('th', { scope: 'row' }, 'Panel now'), nowCell(nowP), a ? nowCell(nowA) : h('td', { class: 'n' }, DASH))));
  }

  function render() {
    clear(body);
    const q = last;
    if (!q || !q.eph || !q.planned?.site) { body.append(h('p', { class: 'energy-note' }, 'Pick a site to see its energy.')); return; }
    const key = [q.planned.site.latDeg, q.planned.site.lonDeg, q.planned.landingMs, q.alternative?.site.latDeg, q.alternative?.site.lonDeg,
      q.alternative?.landingMs, q.stayDays, maskKey(q.planned.mask), maskKey(q.alternative?.mask), JSON.stringify(cur)].join('|');
    if (key !== planKey) { pair = planEnergyPair(q.eph, q.planned, q.alternative ?? null, q.stayDays, cur); planKey = key; }
    const p = pair.planned, a = pair.alt;
    if (!p) { body.append(h('p', { class: 'energy-note' }, 'The landing is outside the ephemeris, which covers 1 Nov 2026 to 1 Jan 2029.')); return; }
    const labels = { planned: q.plannedLabel ?? '', alt: q.altLabel ?? '' };
    const at = ok(q.cursorMs) && q.cursorMs >= p.startMs && q.cursorMs <= p.endMs ? q.cursorMs : p.startMs;
    const nowP = bestAngleAt(q.eph, q.planned.site, at, q.planned.mask ?? 0);
    const nowA = a ? bestAngleAt(q.eph, q.alternative.site, a.startMs + (at - p.startMs), q.alternative.mask ?? 0) : null;
    body.append(chart(p, a, labels), table(p, a, nowP, nowA, labels));
    setCursor(q.cursorMs);
    const notes = [];
    if (!a) notes.push(q.altNote || 'Pick a slip or another site to compare.');
    if (pair.cut) notes.push(`Both stays are compared over ${Math.round(pair.stayDays * 10) / 10} days: the ephemeris ends on 1 Jan 2029.`);
    else if (pair.plannedClipped) notes.push(`Stay shortened to ${Math.round(pair.stayDays * 10) / 10} days: the ephemeris ends on 1 Jan 2029.`);
    for (const n of notes) body.append(h('p', { class: 'energy-note' }, n));
    clear(notesBody);
    notesBody.append(h('p', { class: 'energy-note' }, a ? 'Panel now is at the time cursor; for the alternative, the same time into its stay.' : 'Panel now is at the time cursor.'),
      // fix R6: the two battery figures in words
      h('p', { class: 'energy-note' }, `Battery empty: hours in the stay with the battery at 0 h. Battery needed: the smallest battery that would never run empty over this stay; above the assumed ${hrs(cur.batteryHours)}, the battery runs out.`));
    const here = ok(p.peakLitElDeg)
      ? ` Here the Sun rises at most ${fmtDeg(p.peakLitElDeg)} while sunlit; a horizontal panel makes ${share(p.flatVsTrack)} of a tracking panel’s energy.`
      : ' Here the Sun stays behind terrain for the whole stay.';
    notesBody.append(h('p', { class: 'energy-polar' }, POLAR, here),
      h('ul', { class: 'energy-caveats' }, CAVEATS.map((c) => h('li', null, c))));
    body.append(notesBox);
  }

  function update(params) {
    last = params ?? null;
    if (params?.assumptions) cur = cleanAssumptions({ ...cur, ...params.assumptions });
    syncControls();
    render();
  }

  syncControls();
  render();
  return { el, update, setCursor, assumptions: () => ({ ...cur }) };
}
