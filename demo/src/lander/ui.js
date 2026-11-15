// DOM side of the lander page: timeline scrubber, HUD and the detail panels. No three.js here.
import { VEHICLE_DEFAULTS } from './vehicle.js';
import { ATTITUDE_MODES } from './power.js';
import { ACTIONS } from './contingency.js';

// One playback step: the timeline fraction after dtS real seconds at `speed` (a multiple of the compressed
// timeline, which runs the whole mission in playbackS seconds at 1×), or 'real' (one simulated second per second).
export function playbackStep(f, dtS, speed, timeline, playbackS = 150) {
  if (speed === 'real') return Math.min(1, timeline.tToF(timeline.fToT(f) + dtS * 1000));
  return Math.min(1, f + (dtS * speed) / playbackS);
}

// share of the scrubber each phase gets (the real durations span hours to days)
export const PHASE_WEIGHTS = { leo: 0.05, tli: 0.03, coast: 0.13, 'approach-moon': 0.06, loi: 0.05, llo: 0.09, doi: 0.03, 'descent-coast': 0.05, braking: 0.17, approach: 0.14, terminal: 0.10, landed: 0.10 };
const SHORT = { leo: 'LEO', tli: 'TLI', coast: 'Coast', 'approach-moon': 'SOI', loi: 'LOI', llo: 'Lunar orbit', doi: 'DOI', 'descent-coast': 'To PDI', braking: 'Braking', approach: 'Approach', terminal: 'Terminal', landed: 'Landed' };
const MODE_NAME = { 'sun-point': 'Sun-pointing', burn: 'Thrust vector (burn)', descent: 'Descent, thrust near vertical', surface: 'Upright on the surface', safe: 'Safe mode' };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n0 = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-GB') : '—');
const n1 = (x, d = 1) => (Number.isFinite(x) ? x.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
export const fmtUtc = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
export function fmtDur(s) {
  const a = Math.abs(s);
  if (a >= 86400) return `${Math.floor(a / 86400)} d ${String(Math.floor((a % 86400) / 3600)).padStart(2, '0')} h`;
  if (a >= 3600) return `${Math.floor(a / 3600)} h ${String(Math.floor((a % 3600) / 60)).padStart(2, '0')} min`;
  if (a >= 60) return `${Math.floor(a / 60)} min ${String(Math.floor(a % 60)).padStart(2, '0')} s`;
  return `${a.toFixed(0)} s`;
}
export const fmtMet = (ms, launchMs) => `T${ms >= launchMs ? '+' : '−'}${fmtDur((ms - launchMs) / 1000)}`;

// ---------- timeline ----------

export function createTimeline(root, plan, { onSeek, onBranch }) {
  const segs = root.querySelector('.segs'), ticks = root.querySelector('.ticks'), cursor = root.querySelector('.cursor'), track = root.querySelector('.track');
  const parts = [];
  let acc = 0;
  for (const p of plan.phases) {
    const w = PHASE_WEIGHTS[p.id] ?? 0.05;
    parts.push({ ...p, f0: acc, f1: acc + w });
    acc += w;
  }
  for (const p of parts) { p.f0 /= acc; p.f1 /= acc; }
  const fToT = (f) => {
    const p = parts.find((q) => f <= q.f1) ?? parts[parts.length - 1];
    return p.startMs + ((f - p.f0) / Math.max(1e-9, p.f1 - p.f0)) * (p.endMs - p.startMs);
  };
  const tToF = (t) => {
    const p = parts.find((q) => t <= q.endMs) ?? parts[parts.length - 1];
    return p.f0 + ((t - p.startMs) / Math.max(1, p.endMs - p.startMs)) * (p.f1 - p.f0);
  };
  segs.innerHTML = parts.map((p) => `<div class="seg-ph ${p.scene}" style="left:${p.f0 * 100}%;width:${(p.f1 - p.f0) * 100}%" title="${esc(p.name)}"><span>${SHORT[p.id] ?? p.id}</span></div>`).join('');
  function setBranches(branches, activeId) {
    ticks.innerHTML = plan.events.filter((e) => e.tMs >= plan.times.launchMs && e.tMs <= plan.times.endMs).map((e) => `<i class="tick" style="left:${tToF(e.tMs) * 100}%" title="${esc(e.name)} · ${fmtUtc(e.tMs)}"></i>`).join('')
      + branches.map((b) => `<button class="bmark${b.id === activeId ? ' on' : ''}" data-b="${b.id}" style="left:${tToF(b.tMs) * 100}%" title="${esc(b.title)}: ${esc(b.decision.action)}"></button>`).join('');
  }
  ticks.addEventListener('click', (e) => { const b = e.target.closest('.bmark'); if (b) onBranch(b.dataset.b); });
  let drag = false;
  const seekAt = (e) => { const r = track.getBoundingClientRect(); onSeek(fToT(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)))); };
  track.addEventListener('pointerdown', (e) => { if (e.target.closest('.bmark')) return; drag = true; track.setPointerCapture(e.pointerId); seekAt(e); });
  track.addEventListener('pointermove', (e) => { if (drag) seekAt(e); });
  track.addEventListener('pointerup', () => { drag = false; });
  return { fToT, tToF, parts, setBranches, setT: (t) => { cursor.style.left = `${tToF(t) * 100}%`; } };
}

// ---------- HUD ----------

export function renderHud(el, st, pw, plan) {
  const v = plan.vehicle;
  const thr = st.throttle > 0 ? `${Math.round(st.throttle * 100)} %` : 'off';
  const alt = st.altKm >= 100 ? `${n0(st.altKm)} km` : st.altKm >= 2 ? `${n1(st.altKm, 1)} km` : `${n0(st.altKm * 1000)} m`;
  const spd = st.speedKms >= 0.1 ? `${n1(st.speedKms, 3)} km/s` : `${n1(st.speedKms * 1000, 1)} m/s`;
  const ref = st.body === 'earth' ? 'above Earth' : 'above the Moon';
  const desc = st.descent && st.scene === 'surface' && st.phase !== 'landed'
    ? `<div class="row2"><span>Vertical <b>${n1(st.descent.vSpeedMs, 1)} m/s</b></span><span>Horizontal <b>${n1(st.descent.hSpeedMs, 1)} m/s</b></span></div>` : '';
  const soc = pw ? Math.round(pw.soc * 100) : null;
  el.innerHTML = `
    <div class="ph">${esc(st.phaseName)}</div>
    <div class="clock"><span>${fmtMet(st.tMs, plan.times.launchMs)}</span><span>${fmtUtc(st.tMs)}</span></div>
    <dl>
      <dt>Altitude</dt><dd>${alt} <small>${ref}</small></dd>
      ${st.ground ? `<dt>Ground</dt><dd>${st.ground.aglM >= 2000 ? `${n1(st.ground.aglM / 1000, 2)} km` : `${n0(Math.max(0, st.ground.aglM))} m`} below <small>${st.ground.resM ? `${n0(st.ground.resM)} m LOLA` : 'LOLA'}</small></dd>` : ''}
      <dt>Speed</dt><dd>${spd}</dd>
      <dt>Δv left</dt><dd>${n0(st.dvLeftMs)} m/s <small>reserve ${n0(v.reserveDvMs)}</small></dd>
      <dt>Propellant</dt><dd>${n0(st.propellantKg)} kg <small>mass ${n0(st.massKg)} kg</small></dd>
      <dt>Throttle</dt><dd>${thr}</dd>
      <dt>Attitude</dt><dd>${esc(MODE_NAME[pw?.mode] ?? '—')}</dd>
    </dl>
    ${desc}
    <div class="power">
      <div class="pw-row"><span>Array <b>${n0(pw?.generationW)} W</b></span><span>Load <b>${n0(pw?.loadW)} W</b></span><span>Battery <b>${soc ?? '—'} %</b></span></div>
      <div class="bar"><i style="width:${soc ?? 0}%"></i><em style="left:${v.batteryMinSoc * 100}%"></em></div>
    </div>
    <div class="vis"><span class="${st.sunlit ? 'sun on' : 'sun'}">${st.sunlit ? 'Sunlit' : 'In shadow'}</span><span class="${st.earthInView ? 'earth on' : 'earth'}">${st.earthInView ? 'Earth in view' : 'Earth hidden'}</span>${st.tliStageAttached ? '<span>Upper stage attached</span>' : ''}</div>`;
}

// ---------- panels ----------

export function renderPlan(el, plan, pw) {
  const b = plan.budget;
  const rows = b.phases.map((p) => `<tr><td>${esc(p.name)}${p.by === 'tli-stage' ? ' <small>upper stage</small>' : ''}</td><td class="r">${n0(p.dvMs)}</td><td class="r muted">${p.published ? `${n0(p.published.lowMs)}–${n0(p.published.highMs)}` : ''}</td><td class="r">${n0(p.propellantKg)}</td></tr>`).join('');
  const t = plan.times;
  el.innerHTML = `
    <h3>Δv budget <small>m/s · rocket equation · vehicle assumed</small></h3>
    <table class="tbl"><thead><tr><th>Phase</th><th class="r">Δv</th><th class="r">Published</th><th class="r">kg</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><td>Lander total</td><td class="r">${n0(b.landerDvMs)}</td><td></td><td class="r">${n0(plan.vehicle.propellantKg - b.propellantLeftKg)}</td></tr>
    <tr><td>Capacity · margin after ${n0(b.reserveDvMs)} reserve</td><td class="r">${n0(b.landerCapacityMs)}</td><td class="r ${b.marginMs >= 0 ? '' : 'neg'}">${b.marginMs >= 0 ? '+' : ''}${n0(b.marginMs)}</td><td></td></tr></tfoot></table>
    <p class="note">Published ranges: Apollo values (Orloff 2000; Bennett 1972), approximate. Powered descent Δv comes from the guidance simulation, gravity losses included.</p>
    <h3>Timeline</h3>
    <dl class="kv">
      <dt>Launch to parking orbit</dt><dd>${fmtUtc(t.launchMs)}</dd>
      <dt>Trans-lunar injection</dt><dd>${fmtUtc(t.tliMs)}</dd>
      <dt>Coast</dt><dd>${fmtDur(plan.transfer.tofS)} · v∞ ${n1(plan.transfer.vInfKms, 2)} km/s</dd>
      <dt>Lunar orbit insertion</dt><dd>${fmtUtc(t.loiMs)}</dd>
      <dt>Wait in lunar orbit</dt><dd>${n1(plan.llo.loiterDays, 1)} d <small>until the site lies in the polar orbit plane</small></dd>
      <dt>Powered descent</dt><dd>${fmtUtc(t.pdiMs)} · ${fmtDur(plan.descent.durationS)} · ${n0(plan.descent.groundRangeM / 1000)} km</dd>
      <dt>Touchdown</dt><dd>${fmtUtc(t.landingMs)} <small>${plan.landingShiftS >= 0 ? '+' : '−'}${fmtDur(Math.abs(plan.landingShiftS))} vs request, to meet an orbit pass</small></dd>
    </dl>
    <p class="note">A polar orbit's plane stays fixed in space (J2 node drift ∝ cos i = 0) while the Moon turns under it once a sidereal month, so the lander waits until the site passes under the plane; DOI includes a ${n1(plan.llo.dvPlaneMs, 1)} m/s plane trim.${pw ? ` Battery minimum ${Math.round(pw.minSoc * 100)} % at ${fmtUtc(pw.minSocMs)}.` : ''}</p>
    ${plan.warnings.length ? `<p class="warn">${plan.warnings.map(esc).join('<br>')}</p>` : ''}`;
}

export function renderBranches(el, branches, activeId, onSelect) {
  el.innerHTML = `<p class="note">Each event is injected at the time shown; the rules in contingency.js pick the action from the numbers. Dashed lines in the views are the alternative paths.</p>`
    + branches.map((b) => `
    <button class="card${b.id === activeId ? ' on' : ''}" data-b="${b.id}">
      <div class="card-h"><b>${esc(b.title)}</b><span class="act act-${esc(b.decision.action)}">${esc(b.decision.action.replace(/-/g, ' '))}</span></div>
      <div class="card-t">${esc(b.phase)} · ${fmtUtc(b.tMs)}${b.moonTrack || b.surfaceSamples ? ' · <i>drawn</i>' : ''}</div>
      <div class="card-r">${esc(b.decision.reason)}</div>
      <ul>${b.numbers.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    </button>`).join('');
  el.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => onSelect(c.dataset.b)));
}

export function renderLanding(el, checks, plan, terrainNote, roverUrl = null, landed = undefined) {
  const rows = checks.checks.map((c) => `<tr><td>${esc(c.label)}<small>${esc(c.source)}</small></td><td class="r">${esc(c.value)}</td><td class="r muted">${esc(c.limit)}</td><td class="r ${c.ok ? 'ok' : 'neg'}">${c.ok ? 'OK' : 'NO'}</td></tr>`).join('');
  const s = checks.sky;
  el.innerHTML = `
    <h3>Landing constraints <small>${esc(plan.site.name)}</small></h3>
    <table class="tbl"><tbody>${rows}</tbody></table>
    ${s ? `<p class="note">At touchdown the Sun is at azimuth ${n0(s.sun.azDeg)}°, elevation ${n1(s.sun.elDeg, 2)}°; the Earth at ${n0(s.earth.azDeg)}°, ${n1(s.earth.elDeg, 2)}°. Clearance is measured above the LOLA skyline. Limits are assumptions for this vehicle (Apollo LM design: about 3 m/s vertical, 1.2 m/s horizontal, 12°).</p>` : ''}
    <p class="note">${esc(terrainNote)}</p>
    ${landed === undefined ? '' : landed ? `<h3>Touchdown point <small>surface operations start here</small></h3><dl class="kv"><dt>Latitude, longitude</dt><dd>${Math.abs(landed.latDeg).toFixed(5)}°${landed.latDeg < 0 ? 'S' : 'N'}, ${landed.lonDeg.toFixed(5)}°E</dd><dt>From the target</dt><dd>${n1(landed.missM, 1)} m</dd><dt>Time</dt><dd>${esc(fmtUtc(landed.tMs))}</dd><dt>Flown</dt><dd>${landed.source === 'nominal' ? 'nominal descent' : esc(landed.source.replace(/-/g, ' '))}</dd></dl>` : '<h3>Touchdown point</h3><p class="note">No touchdown in the selected contingency (it ends in orbit or waits); surface operations have no lander on the ground.</p>'}
    ${roverUrl ? '<p class="note">Next: <b>Plan the rover route</b> in the bar above the view opens step 2 (the navigator\'s route card) at this touchdown point and time.</p>' : ''}`;
}

export const FIELDS = [
  ['dryMassKg', 'Dry mass', 'kg'], ['propellantKg', 'Propellant', 'kg'], ['mainThrustN', 'Main engine thrust', 'N'], ['ispS', 'Specific impulse', 's'],
  ['throttleMin', 'Throttle floor', '0–1'], ['reserveDvMs', 'Δv reserve', 'm/s'], ['arrayPowerW', 'Solar array (normal Sun, 1 AU)', 'W'], ['batteryWh', 'Battery', 'Wh'],
];
export function renderVehicle(el, vehicle, onApply) {
  el.innerHTML = `<p class="note">All vehicle numbers are <b>assumed</b> (a generic medium robotic lander, not a real one). Change them and re-plan.</p>
    <div class="form">${FIELDS.map(([k, label, unit]) => `<label><span>${label} <small>assumed · ${unit}</small></span><input type="number" step="any" data-k="${k}" value="${vehicle[k]}"></label>`).join('')}
    <label><span>Loads <small>assumed · W</small></span><input type="text" data-loads value="${Object.entries(vehicle.loadsW).map(([k, v]) => `${k} ${v}`).join(', ')}" readonly></label></div>
    <div class="form-actions"><button class="btn ghost" data-reset>Default numbers</button><span class="muted">then <b>Replan</b> in the bar above the view</span></div>
    <h3>Attitude modes</h3><dl class="kv">${Object.entries(ATTITUDE_MODES).map(([k, d]) => `<dt>${esc(MODE_NAME[k] ?? k)}</dt><dd>${esc(d)}</dd>`).join('')}</dl>
    <h3>Actions</h3><dl class="kv">${Object.entries(ACTIONS).map(([k, d]) => `<dt>${esc(k.replace(/-/g, ' '))}</dt><dd>${esc(d)}</dd>`).join('')}</dl>`;
  // the numbers are inputs; the action (Replan) is in the action bar, which reads them (vehicleFromForm)
  el.querySelectorAll('input[data-k]').forEach((i) => i.addEventListener('input', () => onApply(null)));
  el.querySelector('[data-reset]').addEventListener('click', () => onApply({ ...VEHICLE_DEFAULTS }));
}

// the vehicle numbers typed in the Vehicle tab (null when it is not open)
export function vehicleFromForm(el, vehicle) {
  const inputs = el?.querySelectorAll?.('input[data-k]');
  if (!inputs?.length) return null;
  const out = { ...vehicle };
  inputs.forEach((i) => { out[i.dataset.k] = Number(i.value); });
  return out;
}
