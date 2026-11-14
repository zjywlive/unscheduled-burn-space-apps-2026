// Route plan card (phase 4 §6 R): the waypoints as latitude and longitude rows (add, remove, reorder),
// a slope limit, a Plan button with progress and Cancel, the three candidates as selectable rows with
// their figures, and the caveats. The card plans nothing itself: it asks the caller with onPlan and shows
// what update() brings back.
//
// createRoutePlanCard(deps, callbacks) → { el, update(params) }
// deps: { maxPoints?: number (default 8), maxLatDeg?: number (default −80, the terrain grid's edge) }
// callbacks: {
//   onPoints(points)                    the edited waypoints, [[xKm, yKm], …], whenever every row is valid
//   onPlan({ points, maxSlopeDeg, mobility })  Plan pressed (or "Plan at N°" after a blocked plan); mobility is
//                                       { descentDeg, crossDeg, speedKmh } (phase 2), the climb limit being maxSlopeDeg
//   onCancel()                          Cancel pressed while planning
//   onPick(routeId)                     a candidate chosen: 'short' | 'flat' | 'sunny'
//   onHover(routeId | null)             a candidate under the pointer or keyboard focus
//   onPower(power)                      phase 3: the power inputs changed ({ panelW, batteryWh, loadW, massKg })
//   onStation(station | null)           phase 4: the surface station's inputs changed (null: switched off)
//   onDepartNow()                       phase 3: "Leave at the timeline time" pressed
//   onFindDepartures()                  phase 3: "Find good departure times" pressed
//   onFly3d()                           phase 6: "Fly along in 3D" pressed
//   onUseDeparture(ms)                  phase 3: one of the found departures chosen
//   onLimit(maxSlopeDeg)                the slope limit slider was let go at a new value (for the URL hash);
//                                       set it back from outside with update({ maxSlopeDeg })
// }
// params (every key optional; a missing key keeps what the card shows):
//   points: [[xKm, yKm], …] | null      e.g. what the Route tool drew; replaces the rows when it is a new array
//   maxSlopeDeg: number                 the slope limit to show
//   running: boolean, progress: 0–1     a plan in progress
//   plan: Plan | null                   the last planRoutes() result
//   selected: routeId | null            the candidate shown as the current route
//   hovered: routeId | null             the candidate highlighted on the map (so map and card agree)
//   energy: { drive, departMs, routeId } | null   phase 3: route-energy.js simulateDrive of the selected route
//   departures: { routeId, scan } | null           phase 3: route-energy.js scanDepartures of the selected route
//   comms: { routeId, summary, links, earth, coverage } | null   phase 4: comms.js figures of the selected route
//   havens: { routeId, result } | null           phase 5: contingency.js findHavens of the selected route
import { h, s, clear } from './dom.js';
import { fromXY, TERRAIN_MAX_LAT } from '../terrain.js';
import { parseLatLon, formatLat, formatLon } from '../coords.js';
import { DEFAULT_MAX_SLOPE, MAX_POINTS, MIN_POINTS, MOBILITY_DEFAULTS } from '../route-plan.js';
import { POWER_DEFAULTS } from '../route-energy.js';
import { STATION_DEFAULTS, BANDS } from '../comms.js';

const LIMIT = { min: 5, max: 30, step: 1 };
const kmFmt = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const intFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
const DASH = '—';
let uid = 0;

// ---------- pure helpers (tested in Node) ----------

// Text for a coordinate input: latitude 3 decimals, east longitude 0–360 with 3 decimals; − as minus sign.
export const coordText = (v) => formatLat(v);

// Rows → { points, errors }: points [[x, y]] for rows that parse, errors [{ index, field, message }].
export function readRows(rows, maxLatDeg = TERRAIN_MAX_LAT) {
  const points = [], errors = [];
  rows.forEach((r, index) => {
    // fix R8/R9: the shared coords.js parser, so every field accepts −89.45, 89.45S, 222.6E, 137.4W …
    const p = parseLatLon(r.lat, r.lon, { maxLatDeg });
    if (!p.ok) { errors.push({ index, field: p.field, message: p.message }); return; }
    points.push(p.xy);
  });
  return { points, errors };
}

// [[x, y]] → rows of text.
export function rowsFromPoints(points) {
  return (points ?? []).map(([x, y]) => { const { latDeg, lonDeg } = fromXY(x, y); return { lat: formatLat(latDeg), lon: formatLon(lonDeg) }; });
}

export const rowTag = (i, n) => (i === 0 ? 'Start' : i === n - 1 ? 'End' : `Via ${i}`);

// The figures of one candidate as display strings.
export function routeFigures(r) {
  const len = ok(r.lengthKm) ? (r.lengthKm >= 100 ? intFmt.format(r.lengthKm) : kmFmt.format(r.lengthKm)) : DASH;
  const deg = (v) => (ok(v) ? `${(Math.round(v * 10) / 10).toFixed(1)}°` : DASH);
  return {
    length: len,
    max: deg(r.maxSlopeDeg),
    mean: deg(r.meanSlopeDeg),
    sun: ok(r.sunShare) ? `${Math.round(r.sunShare * 100)}%` : DASH,
    psr: ok(r.psrKm) ? (r.psrKm > 0 && r.psrKm < 0.05 ? '<0.1' : kmFmt.format(r.psrKm)) : DASH,
  };
}

// Phase 2: the rover figures of one candidate under a plan with mobility, as display lines.
export function roverLines(plan, r) {
  if (!plan?.mobility || !r || r.unavailable || !ok(r.hours)) return [];
  const m = plan.mobility, d1 = (v) => `${(Math.round(v * 10) / 10).toFixed(1)}°`;
  const hrs = r.hours >= 48 ? `${(r.hours / 24).toFixed(1)} days` : `${r.hours.toFixed(r.hours < 10 ? 1 : 0)} h`;
  const lines = [
    { key: 'time', text: `Drive time ${hrs} at ${m.speedKmh} km/h, slower on slopes.` },
    { key: 'grades', text: `Steepest along it: up ${d1(r.climbMaxDeg)}, down ${d1(r.descentMaxDeg)}, across ${d1(r.crossMaxDeg)}.` },
    r.oneWayKm > 0.05
      ? { key: 'oneway', warn: true, text: `One-way: ${kmFmt.format(r.oneWayKm)} km in ${r.oneWay.length} stretch${r.oneWay.length === 1 ? '' : 'es'} going down more steeply than the ${m.climbDeg}° climb limit. The rover could not come back up them (orange on the map).` }
      : { key: 'oneway', text: 'No one-way stretches: every part could be driven back up within the limits.' },
    plan.returnable
      ? { key: 'return', text: 'Driving back from the end to the start is possible within the limits.' }
      : { key: 'return', warn: true, text: 'No way back: from the end, the rover could not return to the start within the limits.' },
    plan.traps?.km2 > 0.05
      ? { key: 'traps', warn: true, text: `Traps: ${kmFmt.format(plan.traps.km2)} km² in the search area the rover could drive into but not out of (red on the map).` }
      : { key: 'traps', text: 'No traps in the search area.' },
  ];
  return lines;
}

// Phase 3: the energy figures of a simulated drive as display lines.
const when = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`; };
const dur = (h) => (h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(h < 10 ? 1 : 0)} h`);
export function energyLines(drive, power = POWER_DEFAULTS, skyKm = null) {
  if (!drive) return [];
  if (drive.reason === 'ephemeris') return [{ key: 'energy', warn: true, text: 'Energy not simulated: the departure is outside the ephemeris (1 Nov 2026 to 1 Jan 2029).' }];
  const pct = (v) => `${Math.round(v * 100)}%`;
  const lines = [];
  if (drive.ok) lines.push({ key: 'arrive', text: `Leaving ${when(drive.departMs)}, arrives ${when(drive.arriveMs)}: ${dur(drive.driveH)} driving${drive.waitH > 0.05 ? ` + ${dur(drive.waitH)} parked to recharge (${drive.stops.length} stop${drive.stops.length === 1 ? '' : 's'})` : ''}.` });
  else if (drive.reason === 'empty') lines.push({ key: 'arrive', warn: true, text: `Leaving ${when(drive.departMs)}, the battery runs out at km ${kmFmt.format(drive.emptyAt.km)} (${when(drive.emptyAt.tMs)}), ${drive.stops.length ? 'parked in the dark' : 'in the dark'}. Leave at another time, carry more battery or take a sunnier route.` });
  else if (drive.reason === 'stuck') lines.push({ key: 'arrive', warn: true, text: `Leaving ${when(drive.departMs)}, it is parked for over 30 days waiting for sunlight at km ${kmFmt.format(drive.km)}: this departure does not work.` });
  lines.push({ key: 'battery', warn: drive.socMin < power.reserve + 1e-9, text: `Battery: starts ${pct(drive.socStart)}, lowest ${pct(drive.socMin)} at km ${kmFmt.format(drive.socMinKm)}${drive.ok ? `, ends ${pct(drive.socEnd)}` : ''} (${intFmt.format(power.batteryWh)} Wh, ${pct(power.reserve)} reserve).` });
  if (drive.km > 0) lines.push({ key: 'light', text: `In shadow for ${kmFmt.format(drive.darkKm)} km of ${kmFmt.format(drive.km)}; Earth in view for ${Math.round((drive.earthKm / drive.km) * 100)}% of it${skyKm ? ` (shadows from the ${skyKm} km skyline grid${skyKm > 1 ? '; the 1 km grid is still loading and can change this' : ''})` : ''}.` });
  return lines;
}

// Phase 4: the comms figures as display lines.
export const COVERAGE_BINS = Object.freeze([
  { min: -70, color: '#ff3d7f', label: '≥ −70' }, { min: -80, color: '#ff8a3d', label: '−80' }, { min: -90, color: '#ffd23d', label: '−90' },
  { min: -100, color: '#8be04e', label: '−100' }, { min: -110, color: '#3dd6c6', label: '−110 dBm' },
]);
export function commsLines(comms) {
  if (!comms?.summary) return [];
  const { summary: m, coverage: c } = comms, st = c?.settings ?? comms.links?.settings;
  const pct = (a, b) => `${b > 0 ? Math.round((a / b) * 100) : 0}%`;
  const lines = [];
  if (st) lines.push({ key: 'station', text: `Surface station link (${BANDS[st.band].label}, ${st.txDbm} dBm, ${st.mastM} m mast, usable from ${st.thresholdDbm} dBm): ${kmFmt.format(m.stationKm)} km of ${kmFmt.format(m.totalKm)} (${pct(m.stationKm, m.totalKm)}).` });
  if (m.earthKm !== null) lines.push({ key: 'earth', text: `Earth in view (direct link) for ${pct(m.earthKm, m.totalKm)} of the route at this departure.` });
  lines.push(m.gapKm > 0.05
    ? { key: 'gap', warn: true, text: `No link at all for ${kmFmt.format(m.totalKm - m.anyKm)} km; the longest gap is ${kmFmt.format(m.gapKm)} km${m.gapH !== null && m.gapH > 0 ? ` (${m.gapH.toFixed(1)} h)` : ''}.` }
    : { key: 'gap', text: 'Always in touch: the station or Earth covers every part of the route.' });
  if (c) lines.push({ key: 'coverage', text: `The station has line of sight to ${Math.round(c.losShare * 100)}% of its ${c.settings.radiusKm} km circle and a usable link to ${Math.round(c.linkShare * 100)}% (coloured on the map).` });
  return lines;
}

// Phase 5: safe havens and comms-denied navigation as display lines.
const deg0 = (v) => `${Math.round(v)}°`;
const side = (rel) => (Math.abs(rel) < 3 ? 'straight ahead' : rel > 0 ? `${deg0(rel)} to your right` : `${deg0(-rel)} to your left`);
export function havenLines(result, drive = null) {
  if (!result?.checkpoints?.length) return [];
  const cps = result.checkpoints, lines = [];
  const crit = `Sun on arrival and for the next ${result.lookaheadH} h, Earth in view, gentle ground`;
  lines.push({ key: 'havens', text: `Safe havens (${crit}) within ${result.radiusKm} km by drive: found from ${result.found} of ${cps.length} checkpoints along the route.` });
  if (result.worst) {
    const w = result.worst, h = w.haven;
    lines.push({ key: 'worst', text: `Farthest one: from km ${kmFmt.format(w.km)}, ${kmFmt.format(h.distKm)} km away (${h.hours.toFixed(1)} h, ${(h.wh / 1000).toFixed(1)} kWh of the ${(w.socWh / 1000).toFixed(1)} kWh left).` });
  }
  if (result.missing.length) {
    const kms = result.missing.map((c) => kmFmt.format(c.km));
    const why = result.missing[0].why;
    lines.push({ key: 'missing', warn: true, text: `No haven from km ${kms.length > 4 ? `${kms.slice(0, 3).join(', ')} … ${kms.at(-1)}` : kms.join(', ')} (${why}). Keep the battery high there, or add a waypoint by a lit ridge.` });
  }
  // navigation cue: where the battery runs out, else the farthest haven
  const cue = (drive?.emptyAt ? cps.at(-1) : null)?.haven ? cps.at(-1) : result.worst;
  if (cue?.haven?.nav) {
    const nv = cue.haven.nav, refs = [];
    // steer only by what is above the local skyline at the checkpoint
    if (nv.sunVisible && nv.sunRelDeg !== null) refs.push(`the Sun (azimuth ${deg0(nv.sunAzDeg)}, ${Math.max(0, nv.sunElDeg).toFixed(1)}° up) ${side(nv.sunRelDeg)}`);
    if (nv.earthVisible && nv.earthRelDeg !== null) refs.push(`Earth (azimuth ${deg0(nv.earthAzDeg)}, ${nv.earthElDeg.toFixed(1)}° up) ${side(nv.earthRelDeg)}`);
    const keep = refs.length ? `keeping ${refs.join(' and ')}` : 'with neither the Sun nor Earth above the skyline here, so by star tracker or wheel odometry alone';
    const hidden = refs.length === 1 ? (nv.sunVisible ? ' (Earth is behind the terrain here)' : ' (the Sun is behind the terrain here)') : '';
    lines.push({ key: 'nav', text: `Without comms, from km ${kmFmt.format(cue.km)}: head ${deg0(cue.haven.bearingDeg)} to the haven, ${keep}${hidden}. With 2 % dead-reckoning drift it arrives within about ${intFmt.format(Math.max(10, Math.round(nv.drift95M / 10) * 10))} m.` });
  }
  return lines;
}

// Phase 4: Earth and station links along the route as two thin strips (x = km).
export function linkStrip(profile, links, earth, totalKm) {
  if (!profile) return null;
  const W = 300, H = 14, n = profile.km.length, L = totalKm || 1;
  const parts = [];
  let km = 0;
  const run = (row, has, y, cls) => {
    let start = null, k = 0;
    for (let i = 0; i <= n; i++) {
      const on = i < n && has(i);
      if (on && start === null) start = k;
      if (!on && start !== null) { parts.push(s('rect', { x: ((start / L) * W).toFixed(1), y, width: Math.max(0.6, ((k - start) / L) * W).toFixed(1), height: 5, class: cls })); start = null; }
      if (i < n) k += profile.km[i];
    }
  };
  if (earth) run('earth', (i) => earth[i] === 1, 1, 'rp-link-earth');
  if (links) run('station', (i) => links.ok[i] === 1, 8, 'rp-link-station');
  km = 0;
  return s('svg', { class: 'rp-links', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Links along the route: top Earth in view, bottom surface station' }, ...parts);
}

// Phase 3: a departure scan as one line.
export function departuresLine(scan) {
  if (!scan) return null;
  const days = Math.round((scan.toMs - scan.fromMs) / 86400e3);
  if (!scan.tried) return 'No departures to try inside the ephemeris.';
  if (!scan.ok) return `None of ${scan.tried} departures (every ${scan.stepMs / 3600e3} h for ${days} days from landing) gets there with these assumptions.`;
  return `${scan.ok} of ${scan.tried} departures (every ${scan.stepMs / 3600e3} h for ${days} days from landing) get there. Best by lowest battery:`;
}

// Phase 3: battery along the route as a small SVG (shadowed stretches as grey bands, the reserve dashed).
export function batteryChart(drive, reserve, totalKm) {
  const W = 300, H = 56, P = 2;
  const ser = drive?.series;
  if (!ser || ser.km.length < 2) return null;
  const L = Math.max(totalKm || 0, ser.km[ser.km.length - 1]) || 1;
  const X = (k) => P + (k / L) * (W - 2 * P), Y = (v) => P + (1 - v) * (H - 2 * P);
  const bands = [];
  for (let i = 1; i < ser.km.length; i++) if (!ser.lit[i]) bands.push(s('rect', { x: X(ser.km[i - 1]).toFixed(1), y: 0, width: Math.max(0.6, X(ser.km[i]) - X(ser.km[i - 1])).toFixed(1), height: H, class: 'rp-bat-dark' }));
  let d = '';
  for (let i = 0; i < ser.km.length; i++) d += `${i ? 'L' : 'M'}${X(ser.km[i]).toFixed(1)} ${Y(ser.soc[i]).toFixed(1)}`;
  return s('svg', { class: 'rp-bat', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Battery charge along the route; grey bands are stretches in shadow' },
    ...bands,
    s('line', { x1: P, x2: W - P, y1: Y(reserve).toFixed(1), y2: Y(reserve).toFixed(1), class: 'rp-bat-reserve' }),
    s('path', { d, class: 'rp-bat-line' }));
}

// One sentence for screen readers.
export function routeSentence(r, names) {
  if (r.unavailable) return `${r.label}: ${r.unavailable}`;
  const f = routeFigures(r);
  const same = r.sameAs ? ` Same route as ${names[r.sameAs] ?? r.sameAs}.` : '';
  return `${r.label}: ${f.length} km, max slope ${f.max}, mean slope ${f.mean}, sunlit ${f.sun} of the length, ${f.psr} km in permanent shadow.${same}`;
}

// Whether a plan answers these points and this limit.
export function planMatches(plan, points, limitDeg, mobility = null) {
  if (!plan || !points || plan.limitDeg !== limitDeg) return false;
  if (mobility && plan.mobility && ['descentDeg', 'crossDeg', 'speedKmh'].some((k) => plan.mobility[k] !== mobility[k])) return false;
  const w = plan.waypoints ?? [];
  if (w.length !== points.length) return false;
  // within 50 m: the rows show 3-decimal degrees (≤ ~30 m), so a plan restored from a link still matches them
  return w.every((p, i) => Math.abs(p[0] - points[i][0]) < 0.05 && Math.abs(p[1] - points[i][1]) < 0.05);
}

// ---------- the card ----------

function swatch(id) {
  return s('svg', { class: 'rp-swatch', width: 16, height: 10, viewBox: '0 0 16 10', 'aria-hidden': 'true' },
    s('path', { class: `rp-line rp-line-${id}`, d: 'M1 5H15' }));
}

export function createRoutePlanCard(deps = {}, callbacks = {}) {
  const maxPoints = deps.maxPoints ?? MAX_POINTS;
  const maxLat = deps.maxLatDeg ?? TERRAIN_MAX_LAT;
  const id = `lsn-rp-${++uid}`;
  let rows = [{ lat: '', lon: '' }, { lat: '', lon: '' }];
  let errs = new Map();          // `${index}:${field}` → message
  let limit = DEFAULT_MAX_SLOPE;
  let mobility = { ...MOBILITY_DEFAULTS };   // phase 2: the rest of the rover limits
  let power = { ...POWER_DEFAULTS };         // phase 3: panel, battery, load, mass
  let energy = null, departures = null, comms = null, havens = null;
  let station = { ...STATION_DEFAULTS }, stationOn = true;
  let lastPoints = null, emitted = null;
  let running = false, progress = 0, plan = null, selected = null, hovered = null;
  let validPoints = null;        // the rows as points when all are valid

  // fix R8: the point rows are the first thing in the card, open by default; one line says both ways in
  const head = h('div', { class: 'card-head card-head-stack' },
    h('h2', { id: `${id}-head` }, 'Route plan'),
    h('p', { class: 'card-sub' }, 'Type coordinates below, or draw with the Route tool on the map.'));

  const list = h('ol', { class: 'rp-points', 'aria-label': 'Route points, in order' });
  const addBtn = h('button', { type: 'button', class: 'btn rp-add', onclick: () => addRow() }, 'Add point');

  const limitInput = h('input', { type: 'range', class: 'range', id: `${id}-limit`, min: LIMIT.min, max: LIMIT.max, step: LIMIT.step, value: limit });
  const limitOut = h('output', { class: 'filter-value num', for: `${id}-limit` });
  limitInput.addEventListener('input', () => { limit = Number(limitInput.value); renderLimit(); renderResults(); });
  limitInput.addEventListener('change', () => callbacks.onLimit?.(limit));   // fix R (for L5): report the limit for the hash

  // phase 2: descent and cross-slope limits and speed, next to the climb limit they go with
  const roverInput = (key, label, unit, min, max, step) => {
    const inp = h('input', { type: 'number', class: 'rp-rover-input num', id: `${id}-${key}`, min, max, step, value: mobility[key], inputmode: 'decimal' });
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      mobility = { ...mobility, [key]: Number.isFinite(v) && v >= min && v <= max ? v : MOBILITY_DEFAULTS[key] };
      inp.value = String(mobility[key]);
      renderResults();
    });
    return h('label', { class: 'rp-rover-field', for: `${id}-${key}` }, h('span', { class: 'rp-rover-name' }, label), h('span', { class: 'rp-rover-box' }, inp, h('span', { class: 'rp-rover-unit' }, unit)));
  };
  const powerInput = (key, label, unit, min, max, step) => {
    const inp = h('input', { type: 'number', class: 'rp-rover-input num', id: `${id}-${key}`, min, max, step, value: power[key], inputmode: 'decimal' });
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      power = { ...power, [key]: Number.isFinite(v) && v >= min && v <= max ? v : POWER_DEFAULTS[key] };
      inp.value = String(power[key]);
      callbacks.onPower?.({ ...power });
    });
    return h('label', { class: 'rp-rover-field', for: `${id}-${key}` }, h('span', { class: 'rp-rover-name' }, label), h('span', { class: 'rp-rover-box' }, inp, h('span', { class: 'rp-rover-unit' }, unit)));
  };
  const powerRow = h('div', { class: 'rp-rover rp-power' },
    powerInput('panelW', 'Panel W', 'W', 0, 20000, 10), powerInput('batteryWh', 'Battery Wh', 'Wh', 100, 100000, 100), powerInput('loadW', 'Load W', 'W', 0, 5000, 5), powerInput('massKg', 'Mass kg', 'kg', 10, 20000, 10));
  // phase 4: the surface station
  const stationField = (key, label, unit, min, max, step) => {
    const inp = h('input', { type: 'number', class: 'rp-rover-input num', id: `${id}-st-${key}`, min, max, step, value: station[key], inputmode: 'decimal' });
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      station = { ...station, [key]: Number.isFinite(v) && v >= min && v <= max ? v : STATION_DEFAULTS[key] };
      inp.value = String(station[key]);
      callbacks.onStation?.(stationOn ? { ...station } : null);
    });
    return h('label', { class: 'rp-rover-field', for: `${id}-st-${key}` }, h('span', { class: 'rp-rover-name' }, label), h('span', { class: 'rp-rover-box' }, inp, unit ? h('span', { class: 'rp-rover-unit' }, unit) : null));
  };
  const bandSel = h('select', { class: 'rp-rover-input', id: `${id}-st-band` }, ...Object.entries(BANDS).map(([k, b]) => h('option', { value: k, selected: k === station.band }, k === 's' ? 'S-band' : 'UHF')));
  bandSel.addEventListener('change', () => { station = { ...station, band: bandSel.value }; callbacks.onStation?.(stationOn ? { ...station } : null); });
  const stationToggle = h('input', { type: 'checkbox', id: `${id}-st-on`, checked: true });
  stationToggle.addEventListener('change', () => { stationOn = stationToggle.checked; stationRow.classList.toggle('is-off', !stationOn); callbacks.onStation?.(stationOn ? { ...station } : null); });
  const stationRow = h('div', { class: 'rp-station' },
    h('label', { class: 'rp-station-head', for: `${id}-st-on` }, stationToggle, h('span', null, 'Surface station '), h('span', { class: 'rp-assumed' }, 'JPL site')),
    h('div', { class: 'rp-rover rp-power' },
      stationField('latDeg', 'Lat °', '°', -90, -80, 0.01), stationField('lonDeg', 'Lon °E', '°', 0, 360, 0.1), stationField('mastM', 'Mast m', 'm', 0, 200, 1),
      h('label', { class: 'rp-rover-field', for: `${id}-st-band` }, h('span', { class: 'rp-rover-name' }, 'Band'), h('span', { class: 'rp-rover-box' }, bandSel))));
  const roverRow = h('div', { class: 'rp-rover' },
    roverInput('descentDeg', 'Descent', '°', 1, 45, 1), roverInput('crossDeg', 'Across', '°', 1, 45, 1), roverInput('speedKmh', 'Speed', 'km/h', 0.05, 20, 0.05));

  const planBtn = h('button', { type: 'submit', class: 'btn btn-primary rp-plan' }, 'Plan routes');   // stays enabled: planning again restarts
  const cancelBtn = h('button', { type: 'button', class: 'btn rp-cancel', hidden: true, onclick: () => callbacks.onCancel?.() }, 'Cancel');
  const formError = h('p', { class: 'field-error rp-form-error', id: `${id}-form-error`, hidden: true });

  // fix R8 (replaces G's closed "Points and slope limit" disclosure): points, Add point, slope limit and
  // Plan in plain sight, then the outcome and the candidates; only the notes stay behind a disclosure.
  const form = h('form', { class: 'rp-form', novalidate: true, 'aria-labelledby': `${id}-head`, onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('div', { class: 'rp-cols', 'aria-hidden': 'true' }, h('span', null, 'Point'), h('span', null, 'Latitude'), h('span', null, 'Longitude (east)')),
    list,
    h('div', { class: 'rp-add-row' }, addBtn),
    h('div', { class: 'filter rp-limit' },
      h('div', { class: 'filter-head' }, h('label', { for: `${id}-limit` }, 'Climb limit ', h('span', { class: 'rp-assumed' }, 'assumed')), limitOut),
      limitInput,
      roverRow,
      powerRow,
      stationRow),
    formError,
    h('div', { class: 'rp-actions' }, planBtn, cancelBtn));

  const status = h('div', { class: 'rp-status', role: 'status', 'aria-live': 'polite' });
  const results = h('div', { class: 'rp-results' });
  const notes = h('ul', { class: 'rp-notes fold-more-body' });

  const el = h('section', { class: 'card rp-card', 'aria-labelledby': `${id}-head`, 'data-tour': 'route-plan' }, head, form, status, results,
    h('details', { class: 'fold-more rp-notes-box' }, h('summary', null, 'Notes'), notes));

  // ---------- points ----------
  function validate(showErrors) {
    const r = readRows(rows, maxLat);
    const next = new Map();
    for (const e of r.errors) next.set(`${e.index}:${e.field}`, e.message);
    // empty rows only count as errors when the user asks to plan
    if (!showErrors) for (const [k] of next) { const i = Number(k.split(':')[0]); if (!rows[i].lat.trim() && !rows[i].lon.trim()) next.delete(k); }
    errs = next;
    validPoints = r.errors.length ? null : r.points;
    return r;
  }

  function emitPoints() {
    if (!validPoints) return;
    emitted = validPoints;
    callbacks.onPoints?.(validPoints);
  }

  function commitRow(i, field, value) {
    if (rows[i][field] === value) return;
    rows[i] = { ...rows[i], [field]: value };
    // re-check this row only; a half-filled row waits for its other field
    const r = readRows([rows[i]], maxLat);
    errs.delete(`${i}:lat`); errs.delete(`${i}:lon`);
    const blank = !rows[i].lat.trim() && !rows[i].lon.trim();
    const half = !rows[i].lat.trim() || !rows[i].lon.trim();
    if (r.errors.length && !blank && !(half && r.errors[0].field !== field)) errs.set(`${i}:${r.errors[0].field}`, r.errors[0].message);
    const all = readRows(rows, maxLat);
    validPoints = all.errors.length ? null : all.points;
    showErrors();   // in place: the list is not rebuilt, so Tab carries on where the user was going
    renderResults();
    emitPoints();
  }

  function addRow() {
    if (rows.length >= maxPoints) return;
    const at = rows.length >= 2 ? rows.length - 1 : rows.length;
    rows.splice(at, 0, { lat: '', lon: '' });
    shiftErrors(at, +1);
    validate(false);
    renderPoints(`${at}:lat`);
    renderResults();
  }

  function removeRow(i) {
    if (rows.length <= MIN_POINTS) return;
    rows.splice(i, 1);
    errs.delete(`${i}:lat`); errs.delete(`${i}:lon`);
    shiftErrors(i + 1, -1);
    validate(false);
    renderPoints(`${Math.min(i, rows.length - 1)}:lat`);
    renderResults();
    emitPoints();
  }

  function shiftErrors(from, by) {
    const next = new Map();
    for (const [k, v] of errs) { const [i, f] = k.split(':'); const n = Number(i); next.set(`${n >= from ? n + by : n}:${f}`, v); }
    errs = next;
  }

  let rowEls = [];   // per row: { lat, lon, box } (the inputs and the error container)

  function coordInput(i, field, tag) {
    const input = h('input', {
      type: 'text', class: 'input rp-input num', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false',
      value: rows[i][field], placeholder: field === 'lat' ? '−89.45' : '222.69',
      'aria-label': `${tag} ${field === 'lat' ? 'latitude' : 'longitude, degrees east'}`, 'data-focus': `${i}:${field}`,
    });
    input.addEventListener('change', () => commitRow(i, field, input.value.trim()));
    return input;
  }

  // error messages and aria-invalid of every row, without rebuilding the inputs
  function showErrors() {
    rowEls.forEach((r, i) => {
      clear(r.box);
      for (const field of ['lat', 'lon']) {
        const msg = errs.get(`${i}:${field}`), input = r[field], errId = `${id}-e${i}-${field}`;
        if (msg) {
          input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', errId);
          r.box.append(h('p', { class: 'field-error', id: errId }, msg));
        } else { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
      }
    });
    if (!errs.size) formError.hidden = true;
  }

  function renderPoints(focusKey = null) {
    clear(list);
    rowEls = [];
    rows.forEach((row, i) => {
      const tag = rowTag(i, rows.length);
      const lat = coordInput(i, 'lat', tag), lon = coordInput(i, 'lon', tag), box = h('div', { class: 'rp-errors' });
      rowEls.push({ lat, lon, box });
      // one line per point: tag, latitude, longitude, remove (fix R8; reordering is by editing the rows)
      const label = `Remove ${tag.toLowerCase()}`;
      list.append(h('li', { class: 'rp-point' },
        h('span', { class: 'rp-tag' }, tag),
        lat, lon,
        h('button', { type: 'button', class: 'rp-tool', 'aria-label': label, title: label, disabled: rows.length <= MIN_POINTS, 'data-focus': `${i}:remove`, onclick: () => removeRow(i) }, '×'),
        box));
    });
    showErrors();
    addBtn.disabled = rows.length >= maxPoints;
    addBtn.textContent = rows.length >= maxPoints ? `At most ${maxPoints} points` : 'Add point';
    if (focusKey) {
      const t = list.querySelector(`[data-focus="${focusKey}"]`);
      (t && !t.disabled ? t : list.querySelector(`[data-focus="${focusKey.split(':')[0]}:lat"]`) ?? addBtn).focus({ preventScroll: true });
    }
  }

  function submit() {
    // take what is typed even if no change event has fired yet (Enter in a field)
    rowEls.forEach((r, i) => { rows[i] = { lat: r.lat.value.trim(), lon: r.lon.value.trim() }; });
    const r = validate(true);
    showErrors();
    if (r.errors.length) {
      formError.hidden = false;
      formError.textContent = r.errors.length === 1 ? 'Fix the highlighted point.' : `Fix the ${r.errors.length} highlighted entries.`;
      const first = r.errors[0];
      list.querySelector(`[data-focus="${first.index}:${first.field}"]`)?.focus();
      return;
    }
    formError.hidden = true;
    emitPoints();
    callbacks.onPlan?.({ points: r.points, maxSlopeDeg: limit, mobility: { ...mobility } });
  }

  function renderLimit() {
    if (Number(limitInput.value) !== limit) limitInput.value = String(limit);
    limitOut.textContent = `${limit}°`;
    limitInput.setAttribute('aria-valuetext', `${limit} degrees`);
  }

  // ---------- results ----------
  const names = { short: 'Shortest', flat: 'Flattest', sunny: 'Sunniest' };

  function pick(rid) { if (rid !== selected) callbacks.onPick?.(rid); }
  function hover(rid) { if (rid !== hovered) { hovered = rid; callbacks.onHover?.(rid); } }

  // status line: progress while planning (updated in place, announced in 10 % steps), then the outcome
  let statusKey = '';
  const progText = h('span', { class: 'num' });
  const progFill = h('span');
  const progLine = h('p', { class: 'region-progress' }, h('span', { class: 'region-progress-bar', 'aria-hidden': 'true' }, progFill), progText);

  function renderStatus(stale) {
    cancelBtn.hidden = !running;
    if (running) {
      const pr = Math.max(0, Math.min(1, progress ?? 0));
      if (statusKey !== 'running') { statusKey = 'running'; clear(status); status.append(progLine); }
      progFill.style.transform = `scaleX(${pr.toFixed(3)})`;
      const text = `Planning… ${Math.floor(pr * 10) * 10}%`;
      if (progText.textContent !== text) progText.textContent = text;
      return;
    }
    const key = `${plan ? plan.ms + ':' + plan.nodes + ':' + (plan.error ?? '') + ':' + (plan.blocked?.passesAtDeg ?? '') : 'none'}|${stale}|${limit}`;
    if (key === statusKey && plan !== null) return;
    statusKey = key;
    clear(status);
    if (!plan) return;
    if (plan.blocked && ok(plan.blocked.passesAtDeg)) {
      const at = plan.blocked.passesAtDeg;
      const can = at <= LIMIT.max;
      status.append(h('div', { class: 'rp-blocked' },
        h('p', null, `No route keeps under ${plan.blocked.limitDeg}°${plan.waypoints?.length > 2 ? ` on leg ${plan.blocked.leg + 1}` : ''}.`),
        h('p', { class: 'rp-blocked-sub' }, `The gentlest way through the search area needs ${at}° on the ${baseText()} grid.`),
        can ? h('button', { type: 'button', class: 'btn rp-relax', onclick: () => { limit = at; renderLimit(); submit(); } }, `Plan at ${at}°`)
          : h('p', { class: 'rp-blocked-sub' }, `That is above the ${LIMIT.max}° the limit goes to.`)));
      return;
    }
    if (plan.error) { status.append(h('p', { class: 'rp-error' }, plan.error)); return; }
    if (plan.ok) {
      if (stale) status.append(h('p', { class: 'rp-stale' }, 'Points or limit changed. Plan again to update.'));
      else status.append(h('p', { class: 'rp-done num' }, `Searched ${intFmt.format(plan.nodes)} terrain nodes in ${(plan.ms / 1000).toFixed(1)} s.`));
    }
  }

  const baseText = () => (plan?.baselineKm ? `${Math.round(plan.baselineKm * 1000)} m` : '240 m');

  // the candidate rows are rebuilt only for a new plan; selection and hover change them in place, so
  // focus stays put and a hover from the map does not re-render under the pointer
  let rowsKey = null, buttons = [];

  function syncRows() {
    const usable = buttons.filter((b) => !b.disabled);
    const focusId = usable.some((b) => b.dataset.route === selected) ? selected : usable[0]?.dataset.route;
    for (const b of buttons) {
      const rid = b.dataset.route;
      b.classList.toggle('is-selected', rid === selected);
      b.classList.toggle('is-hovered', rid === hovered);
      b.setAttribute('aria-checked', String(rid === selected));
      b.tabIndex = rid === focusId ? 0 : -1;
    }
  }

  function renderResults() {
    const stale = !!plan?.ok && !planMatches(plan, validPoints ?? lastPoints, limit, mobility);
    renderStatus(stale);
    const show = !!plan?.ok && !running;
    const key = show ? plan : null;
    if (key !== rowsKey) {
      rowsKey = key;
      clear(results);
      buttons = [];
      if (show) buildRows();
    }
    results.querySelector('.rp-rows')?.classList.toggle('is-stale', stale);
    syncRows();
    renderRover();
  }

  // phase 2: the selected route's rover figures under the rows
  let roverKey = null;
  const roverBox = h('div', { class: 'rp-rover-result', 'aria-live': 'polite' });
  function renderRover() {
    const r = plan?.ok && !running ? plan.routes.find((x) => x.id === selected) : null;
    const key = r ? `${plan.ms}:${plan.nodes}:${selected}:${energy?.departMs ?? ''}:${energy?.routeId ?? ''}:${departures?.scan?.tried ?? ''}:${departures?.routeId ?? ''}:${comms?.stamp ?? ''}:${havens?.stamp ?? ''}` : null;
    if (key === roverKey) return;
    roverKey = key;
    clear(roverBox);
    const lines = roverLines(plan, r);
    if (!lines.length) { roverBox.remove(); return; }
    const drive = energy && energy.routeId === r.id ? energy.drive : null;
    const eLines = energyLines(drive, power, energy?.skyKm ?? null);
    const chart = drive ? batteryChart(drive, power.reserve, r.lengthKm) : null;
    roverBox.append(h('p', { class: 'rp-rover-title' }, `Rover on the ${names[r.id] ?? r.label} route`),
      eLines.length ? h('ul', { class: 'rp-energy' }, ...eLines.map((l) => h('li', { class: l.warn ? 'is-warn' : null, 'data-key': l.key }, l.text))) : null,
      chart ? h('div', { class: 'rp-bat-box' }, chart,
        ...(() => { const c = comms && comms.routeId === r.id ? comms : null; const strip = c ? linkStrip(r.profile, c.links, c.earth, r.lengthKm) : null; return strip ? [strip, h('div', { class: 'rp-link-key' }, h('span', { class: 'k-earth' }, 'Earth in view'), h('span', { class: 'k-station' }, 'Station link'))] : []; })(),
        h('div', { class: 'rp-bat-axis' }, h('span', null, '0 km'), h('span', null, 'battery along the route'), h('span', null, `${kmFmt.format(r.lengthKm)} km`))) : null,
      ...(() => {
        const c = comms && comms.routeId === r.id ? comms : null;
        const cl = commsLines(c);
        if (!cl.length) return [];
        return [h('ul', { class: 'rp-energy rp-comms' }, ...cl.map((l) => h('li', { class: l.warn ? 'is-warn' : null, 'data-key': l.key }, l.text))),
          c.coverage ? h('div', { class: 'rp-cov-key', 'aria-label': 'Station coverage colours, received power' }, ...COVERAGE_BINS.map((b) => h('span', null, h('i', { style: `background:${b.color}` }), b.label))) : null];
      })(),
      ...(() => {
        const hv = havens && havens.routeId === r.id ? havens.result : null;
        const hl = havenLines(hv, drive);
        return hl.length ? [h('p', { class: 'rp-rover-sub' }, 'If something goes wrong'), h('ul', { class: 'rp-energy rp-havens' }, ...hl.map((l) => h('li', { class: l.warn ? 'is-warn' : null, 'data-key': l.key }, l.text)))] : [];
      })(),
      drive ? h('div', { class: 'rp-depart-row' },
        h('button', { type: 'button', class: 'btn rp-depart', onclick: () => callbacks.onDepartNow?.() }, 'Leave at the timeline time'),
        h('button', { type: 'button', class: 'btn rp-depart', onclick: () => callbacks.onFindDepartures?.() }, 'Find good departure times'),
        h('button', { type: 'button', class: 'btn btn-primary rp-depart rp-fly3d', onclick: () => callbacks.onFly3d?.() }, 'Fly along in 3D')) : null,
      ...(() => {
        const scan = departures && departures.routeId === r.id ? departures.scan : null;
        if (!scan) return [];
        return [h('p', { class: 'rp-dep-line' }, departuresLine(scan)),
          scan.best.length ? h('ul', { class: 'rp-dep-list' }, ...scan.best.map((b) => h('li', null,
            h('span', null, `${when(b.departMs)} · lowest ${Math.round(b.socMin * 100)}%${b.waitH > 0.05 ? ` · ${dur(b.waitH)} parked` : ''}`),
            h('button', { type: 'button', class: 'btn rp-dep-use', onclick: () => callbacks.onUseDeparture?.(b.departMs) }, 'Use')))) : null];
      })(),
      h('ul', null, ...lines.map((l) => h('li', { class: l.warn ? 'is-warn' : null, 'data-key': l.key }, l.text))));
    if (!roverBox.isConnected || roverBox.parentNode !== results) results.append(roverBox);
  }

  function buildRows() {
    const routes = plan.routes;
    // fix R3: every column says its unit on a second header line; Max and Mean are slopes
    const col = (name, unit, title) => h('span', { title }, h('span', { class: 'rp-head-name' }, name), h('span', { class: 'rp-head-unit' }, unit));
    const header = h('div', { class: 'rp-row rp-row-head', 'aria-hidden': 'true' },
      h('span', null, 'Route'), col('Length', 'km', 'Length along the route, km'), col('Max', 'slope°', 'Steepest slope along the route'),
      col('Mean', 'slope°', 'Mean slope along the route'), col('Sun', 'lit %', 'Share of the length sunlit during the planned stay'),
      col('PSR', 'km', 'km inside permanently shadowed regions'));
    const group = h('div', { class: 'rp-rows', role: 'radiogroup', 'aria-label': 'Candidate routes' });
    for (const r of routes) {
      const f = routeFigures(r);
      const b = h('button', {
        type: 'button', role: 'radio', class: 'rp-row rp-choice', 'aria-checked': 'false', tabindex: '-1',
        disabled: !!r.unavailable, 'data-route': r.id, 'aria-label': routeSentence(r, names),
        onclick: () => pick(r.id),
        onpointerenter: () => hover(r.id), onpointerleave: () => hover(null),
        onfocus: () => hover(r.id), onblur: () => hover(null),
      },
      h('span', { class: 'rp-name' }, swatch(r.id), h('span', null, r.label)),
      r.unavailable
        ? h('span', { class: 'rp-unavailable' }, r.unavailable)
        : [h('span', { class: 'num' }, f.length), h('span', { class: 'num' }, f.max), h('span', { class: 'num' }, f.mean), h('span', { class: 'num' }, f.sun), h('span', { class: 'num' }, f.psr)],
      r.sameAs ? h('span', { class: 'rp-same' }, `Same route as ${names[r.sameAs]}`) : null);
      buttons.push(b);
      group.append(b);
    }
    group.addEventListener('keydown', (e) => {
      const live = buttons.filter((b) => !b.disabled);
      const at = live.indexOf(document.activeElement);
      if (at < 0) return;
      const to = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: live.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      const b = live[(to + live.length) % live.length];
      b.focus();
      pick(b.dataset.route);
    });
    const sunGap = routes.find((r) => !r.unavailable && r.sunShare !== null && r.sunKnown < 0.95);
    results.append(header, group);
    if (sunGap) results.append(h('p', { class: 'rp-note-inline' }, 'Sunlit figures cover only part of the length; the rest is not computed yet.'));
  }

  function renderNotes() {
    clear(notes);
    notes.append(
      h('li', null, `Slopes come from the ${baseText()} terrain grid. Rover-scale slopes are steeper; this cannot tell whether a vehicle can drive the route.`),
      h('li', null, 'Illustrative only. Drive time uses the speed set above, slower on slopes. Descent, across, speed, panel, battery, load and mass are assumptions, like the climb limit.'),
      h('li', null, `Energy: the drive is run forward from the departure. It draws the load plus ${POWER_DEFAULTS.driveW} W to drive, plus m·g·v·sin θ ÷ ${POWER_DEFAULTS.climbEff} to climb (no regeneration downhill); the panel faces the Sun (vertical, turned to its azimuth) and makes power only where the Sun clears the local skyline (the 2 km or 1 km skyline grid). Below ${Math.round(POWER_DEFAULTS.reserve * 100)}% it parks until it is back to ${Math.round((POWER_DEFAULTS.reserve + POWER_DEFAULTS.resumeMargin) * 100)}%.`),
      h('li', null, 'Moves are checked by direction: the grade along the move against the climb and descent limits, the slope across it against the across limit. Switchbacks are limited to 16 directions, so some climbable slopes count as one-way.'),
      h('li', null, 'Max and Mean: the steepest and the mean slope along the route. Sun: share of the length lit during the planned stay, from the 2 km map of the stay at any zoom. PSR: km inside the official permanently shadowed regions.'),
      h('li', null, 'Each name shows the best of the searched routes by its own figure; when one route is best on two, both rows show it.'),
      h('li', null, `Comms: free-space loss plus the dominant knife edge in the terrain between the station's mast and the rover's ${STATION_DEFAULTS.roverM} m antenna (ITU-R P.526), with the Moon's curvature, on the loaded terrain grid. Site, mast, radius, bands and 0 dBi antennas follow Jun et al. (JPL, IEEE Aerospace 2025); the ${STATION_DEFAULTS.txDbm} dBm transmitter and ${STATION_DEFAULTS.thresholdDbm} dBm threshold are assumptions. Earth in view uses the skyline grid at the simulated times.`));
  }

  function update(p = {}) {
    if ('points' in p && p.points !== lastPoints) {
      lastPoints = p.points ?? null;
      if (p.points && p.points !== emitted) {
        rows = rowsFromPoints(p.points);
        while (rows.length < MIN_POINTS) rows.push({ lat: '', lon: '' });
        if (rows.length > maxPoints) rows = rows.slice(0, maxPoints);
        errs = new Map();
        validate(false);
        renderPoints(null);
      }
    }
    if (ok(p.maxSlopeDeg) && p.maxSlopeDeg !== limit) { limit = Math.max(LIMIT.min, Math.min(LIMIT.max, Math.round(p.maxSlopeDeg))); renderLimit(); }
    if ('running' in p) running = !!p.running;
    if ('progress' in p) progress = p.progress;
    if ('plan' in p) plan = p.plan ?? null;
    if ('selected' in p) selected = p.selected ?? null;
    if ('hovered' in p) hovered = p.hovered ?? null;
    if ('energy' in p) { energy = p.energy ?? null; roverKey = null; }
    if ('departures' in p) { departures = p.departures ?? null; roverKey = null; }
    if ('comms' in p) { comms = p.comms ?? null; roverKey = null; }
    if ('havens' in p) { havens = p.havens ?? null; roverKey = null; }
    const baseBefore = notes.dataset.base;
    renderResults();
    if (baseText() !== baseBefore) { notes.dataset.base = baseText(); renderNotes(); }
  }

  validate(false);
  renderPoints(null);
  renderLimit();
  renderResults();
  notes.dataset.base = baseText();
  renderNotes();
  return { el, update };
}
