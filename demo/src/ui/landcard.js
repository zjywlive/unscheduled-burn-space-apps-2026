// Where to land, in the Map's panel (the planner's method on the 3D Moon; the old planner page's 2D map is gone
// from the Map): a click on the globe proposes a landing point; it and the five best spots found around it (the search
// radius) are scored by lander/landeval.js and shown here: the verdict, each figure against its limit, and the spots side by
// side. The actions are in the action bar (actionbar.js, kind 'land'): Use this site, Find better spots, the
// candidate chooser. The globe draws the point, the search square and the numbered spots (ui/globemap.js).
//
// createLandCard({ actionBar }, cb) → { el, update(params) }
//   cb: { onUse(candidate), onRoute(candidate), onStart(), onSelect(n), onParams(params) }
//   The settings (LAND_FIELDS) sit at the top; nothing runs until Start screening (in the panel and the bar). The
//   target is a drawn region (Where to land in A/B) or a point (a click on the Moon; the site when the panel opens).
//   params (each optional; missing keeps what is shown):
//     assume: string            the assumptions line (ellipse, slope limit, stay, battery)
//     pick: { latDeg, lonDeg } | null   the proposed point
//     region: 'A' | 'B' | null  searching inside that drawn region instead (result.region: spots numbered from 1)
//     busy: { stage: 1 | 2, f } | null  the search running (stage 1: the grid, stage 2: the detail)
//     result: { list: [pick, spot 1…5] } | null, sel: number   landeval.js evaluate() result and the chosen one
//     error: string | null
//     params: { slopeDeg, downrangeM, crossrangeM, batteryWh, loadW, reservePct, minSunPct, minEarthPct, radiusKm, cells, slipDays }
//     stayDays: number           shown beside the settings (it is the time dock's)
//     planned: ms | null         the mission's planned landing (the spots are scored for it), or none
import { h, clear } from './dom.js';

// the screening settings: [key, label, unit, min, max, step, title]
export const LAND_FIELDS = [
  ['slopeDeg', 'Slope limit', '°', 2, 30, 1, 'The lander\'s touchdown slope limit: steeper ground fails (assumed)'],
  ['downrangeM', 'Ellipse down-range', 'm', 10, 5000, 10, '3σ landing dispersion along the descent (assumed)'],
  ['crossrangeM', 'Ellipse cross-range', 'm', 10, 5000, 10, '3σ landing dispersion across the descent (assumed)'],
  ['batteryWh', 'Battery', 'Wh', 100, 100000, 100, 'Battery capacity (assumed)'],
  ['loadW', 'Surface load', 'W', 10, 5000, 10, 'Power drawn on the surface through the night (assumed)'],
  ['reservePct', 'Battery reserve', '%', 0, 90, 5, 'Charge kept unused: the longest dark spell must fit in the rest'],
  ['minSunPct', 'Min. Sun over the stay', '%', 0, 100, 5, 'A grid point passes only with the Sun above the skyline at least this share of the stay'],
  ['minEarthPct', 'Min. Earth over the stay', '%', 0, 100, 5, 'A grid point passes only with the Earth in view at least this share of the stay (0: no direct link needed)'],
  ['radiusKm', 'Search radius (point)', 'km', 2, 60, 1, 'Around a point: the square searched for better spots'],
  ['cells', 'Grid points (region)', '', 50, 2000, 50, 'Over a region: how many points are screened (more is finer and slower)'],
  ['slipDays', 'Slip robustness', 'd', 0, 14, 1, 'Also check landings 1 to N days late: the spots that still pass on the most of those days come first, and each spot is graded on it (0: off)'],
];

const fmtLat = (v) => `${Math.abs(v).toFixed(3)}°${v < 0 ? 'S' : 'N'}`;
const fmtLon = (v) => `${(((v % 360) + 360) % 360).toFixed(3)}°E`;
const utc = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const short = (f) => (f ? f.text.split(' (')[0].split(' · ')[0] : '—');
// a table cell: the short text, the dark spell without the battery and the slip days as k/n, so seven columns fit
const cell = (f) => (!f ? '—' : f.id === 'dark' && Number.isFinite(f.value) ? `${Math.round(f.value)} h` : f.id === 'slip' ? f.text.split(' ')[0] : short(f));

// Why a screen found few or no places: how the grid fell through the hard limits, and what the shortest dark spell
// on usable ground would take (landeval.js funnel). null when enough passed. Pure.
export function funnelText(result, params = {}) {
  const f = result?.funnel;
  if (!f || (f.passed > 0 && !result.relaxed)) return null;
  const lead = f.passed ? `Only ${f.passed} of ${f.screened} grid points pass every hard limit.` : `No grid point passes every hard limit.`;
  const shares = params.minSunPct || params.minEarthPct ? `, ${f.sharesOk} with the minimum Sun / Earth shares` : '';
  const robust = f.slipDays > 0 ? `, ${f.robustAll} of them on every landing day to ${f.slipDays} days late` : '';
  const counts = `Of ${f.screened}: ${f.slopeOk} with slope ≤ ${result.limit}°, ${f.notPsr} outside permanent shadow, ${f.darkOk} with the longest dark spell ≤ ${result.battH.toFixed(1)} h (+${f.stepH} h for the 4-hourly screen)${shares}; ${f.passed} pass all${robust}.`;
  let need = '';
  if (Number.isFinite(f.minDarkH) && f.minDarkH > result.battH && params.loadW) {
    const wh = Math.ceil((f.minDarkH * params.loadW) / Math.max(0.05, 1 - (params.reservePct ?? 20) / 100) / 100) * 100;
    need = ` On usable ground the shortest dark spell is ${f.minDarkH} h: carrying it at ${params.loadW} W with ${params.reservePct ?? 20} % reserve takes about ${wh.toLocaleString('en-GB')} Wh of battery (now ${Number(params.batteryWh).toLocaleString('en-GB')} Wh), or choose a shorter stay or another landing date.`;
  } else if (!f.usable) need = ' No grid point has both a slope within the limit and no permanent shadow: try a larger region or a higher slope limit.';
  const near = result.relaxed ? ' The spots marked ≈ are the nearest misses (usable ground, shortest dark spells first), scored in detail to show what it would take.' : '';
  return `${lead} ${counts}${need}${near}`;
}

export function createLandCard({ actionBar = null } = {}, cb = {}) {
  const assume = h('p', { class: 'ld-assume' });
  const body = h('div', { class: 'ld-body' });
  // the settings, built once (a re-render would take the focus out of a field being typed in)
  const inputs = {};
  const stayNote = h('p', { class: 'ld-note' });
  const settings = h('details', { class: 'ld-settings', open: true },
    h('summary', null, 'Screening settings'),
    h('div', { class: 'ld-grid' }, LAND_FIELDS.map(([key, label, unit, min, max, step, title]) => {
      const inp = h('input', { type: 'number', class: 'input num', min: String(min), max: String(max), step: String(step), 'aria-label': label, title });
      inp.addEventListener('change', () => {
        const v = Number(inp.value);
        if (!Number.isFinite(v)) return;
        const c = Math.min(max, Math.max(min, v));
        if (c !== v) inp.value = String(c);
        cb.onParams?.({ ...st.params, [key]: c });
      });
      inputs[key] = inp;
      return h('label', { class: 'ld-field', title }, h('span', null, label), h('span', { class: 'ld-in' }, inp, unit ? h('span', { class: 'ld-unit' }, unit) : null));
    })),
    stayNote);
  const el = h('section', { class: 'card card-land', 'aria-label': 'Where to land' }, h('h2', null, 'Where to land'), settings, assume, body);
  let st = { assume: '', pick: null, region: null, busy: null, result: null, sel: 0, error: null, params: null, stayDays: 14, planned: null };
  // the target and the Start screening button (also in the action bar)
  function startBlock() {
    const { pick, region, busy } = st;
    const target = region ? `Region ${region}` : pick ? `the point ${fmtLat(pick.latDeg)} ${fmtLon(pick.lonDeg)}` : null;
    const btn = h('button', { type: 'button', class: 'btn primary ld-start', disabled: !target || !!busy ? true : null }, busy ? 'Screening…' : 'Start screening');
    btn.addEventListener('click', () => cb.onStart?.());
    return h('div', { class: 'ld-target' },
      h('p', { class: 'ld-note' }, target ? `Target: ${target}.` : 'Target: click the Moon for a point, or use Where to land in A / B on a drawn region.', ' ', region ? 'The whole region is screened, with the listed sites inside it.' : pick ? `The ground within ${st.params?.radiusKm ?? 15} km is searched for better spots.` : ''),
      btn);
  }

  function renderBody() {
    clear(body);
    const { pick, region, busy, result, sel, error } = st;
    body.append(startBlock());
    if (error) { body.append(h('p', { class: 'ld-note is-warn' }, error)); return; }
    if ((pick || region) && !busy && !result && !error) return;   // ready: waits for Start screening
    if (region && (busy || !result)) {
      const f = busy?.f ?? 0;
      body.append(
        h('p', { class: 'ld-point' }, h('b', null, `Region ${region}`)),
        h('p', { class: 'ld-note' }, busy?.stage === 2 ? 'Scoring the best spots in detail (terrain in the ellipse, sky over the stay, Δv)…' : 'Screening the region: Sun and Earth above the skyline every 4 h over the stay, slope and permanent shadow at each grid point…'),
        h('div', { class: 'ld-prog', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(f * 100)) }, h('i', { style: `width:${Math.round(f * 100)}%` })));
      return;
    }
    if (region && result && !result.list.length) {
      body.append(h('p', { class: 'ld-point' }, h('b', null, `Region ${region}`)), h('p', { class: 'ld-note is-warn' }, funnelText(result, st.params ?? {}) ?? `No grid point in region ${region}${result.screened ? ` (${result.screened} screened every ${result.stepKm.toFixed(1)} km)` : ''} has usable ground. Try a larger region or a point of your own (click the Moon).`));
      return;
    }
    if (!pick && !region) {
      body.append(h('p', { class: 'ld-note' }, `Click the Moon to propose a landing point. It is scored (terrain in the landing ellipse, Sun and Earth over the stay, permanent shadow, Δv) and the ground within ${st.params?.radiusKm ?? 15} km is searched for better spots.`));
      return;
    }
    if (busy || !result) {
      if (!busy) return;
      const f = busy?.f ?? 0;
      body.append(
        h('p', { class: 'ld-point' }, h('b', null, 'Your point'), ` · ${fmtLat(pick.latDeg)} ${fmtLon(pick.lonDeg)}`),
        h('p', { class: 'ld-note' }, busy?.stage === 2 ? 'Scoring the point and the best spots in detail (terrain in the ellipse, sky over the stay, Δv)…' : `${pick.latDeg > -80 ? 'Loading the global LOLA terrain around the point and computing its skyline. ' : ''}Searching ${st.params?.radiusKm ?? 15} km around the point for the best landing spots…`),
        h('div', { class: 'ld-prog', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(f * 100)) }, h('i', { style: `width:${Math.round(f * 100)}%` })));
      return;
    }
    const c = result.list[sel] ?? result.list[0];
    const num = (n) => `${result.region ? String(n + 1) : n === 0 ? 'You' : String(n)}${result.list[n]?.relaxed ? '≈' : ''}`;
    const fig = (id, x) => x.figs.find((q) => q.id === id);
    // the landing: the first lit window within two days of the plan (or the plan), with the place's own first window
    // beside it when that is elsewhere; without a plan, the place's first lit window
    const own = Number.isFinite(c.ownLandingMs) && Math.abs(c.ownLandingMs - c.landingMs) > 3600e3 ? ` · its own first lit window ${utc(c.ownLandingMs)}` : '';
    const when = result.planned ? `landing ${utc(c.landingMs)} (first lit window within 2 days of the planned landing, else the planned time)${own}` : `landing ${utc(c.landingMs)} (first lit window)`;
    const why = funnelText(result, st.params ?? {});
    body.append(
      ...(why ? [h('p', { class: `ld-note${result.funnel.passed ? '' : ' is-warn'}` }, why)] : []),
      h('p', { class: 'ld-point' }, h('b', null, c.name), ` · ${fmtLat(c.latDeg)} ${fmtLon(c.lonDeg)}${c.distKm ? ` · ${c.distKm.toFixed(1)} km from your point` : ''}${c.relaxed ? ' · ≈ nearest miss of the screen' : ''}`, h('br'), h('span', { class: 'muted' }, when)),
      h('p', { class: `ld-badge${c.resKm > 0.04 ? ' is-coarse' : ''}` }, `Terrain ${Math.round(c.resKm * 1000)} m${c.patch ? ' (SLDEM2015 patch)' : ''} · skyline ${c.polar ? 'polar 480 m' : 'computed from the global LOLA terrain'} · ${c.resKm > 0.1 ? 'lander-scale hazards not resolved' : c.resKm > 0.04 ? 'slopes at ~100 m scale, rocks not resolved' : 'lander-scale slopes resolved, rocks not'}`),
      h('p', { class: `ld-verdict g-${c.verdict.grade}` }, c.verdict.text),
      h('ul', { class: 'ld-figs' }, c.figs.map((f) => h('li', { class: `g-${f.grade}` },
        h('div', { class: 'ld-f-h' }, h('span', null, f.label), h('span', { class: 'ld-g' }, f.grade)),
        h('div', { class: 'ld-f-v' }, h('b', null, f.text), h('span', { class: 'muted' }, `limit ${f.limit}`)),
        h('small', null, f.note)))),
      result.region
        ? h('h3', { class: 'ld-h3' }, `Best spots in region ${region}`, h('small', null, `${result.screened} grid points every ${result.stepKm.toFixed(1)} km screened (with the listed sites inside), ${result.passed} pass the hard limits${result.slipDays ? `, ${result.funnel?.robustAll ?? 0} on every day to ${result.slipDays} d late` : ''}; 8 scored in detail${result.slipDays ? ' (the most robust to a slip first)' : ''}, at least ${(2 * result.stepKm).toFixed(1)} km apart, 5 kept by fewest failed checks, then fewest near, then suitability; same stay and method`))
        : h('h3', { class: 'ld-h3' }, 'Better spots nearby', h('small', null, `8 scored in detail from a ${2 * (result.radiusKm ?? 15)} km square around your point${result.slipDays ? ' (the most robust to a slip first)' : ''}, at least 2 km apart; the 5 with the fewest failed checks, then fewest near, then the best suitability; same stay and method`)),
      h('table', { class: 'ld-tbl' },
        h('thead', null, h('tr', null, ['#', 'Safe', 'Sun', 'Earth', 'Dark', ...(result.slipDays ? ['Slip'] : []), 'Δv'].map((t, i) => h('th', { class: i ? 'r' : null, title: { Safe: 'Safe touchdowns in 2000 simulated landings (Monte Carlo)', Slip: `Landing days, to ${result.slipDays} days late, on which the battery still carries every night` }[t] }, t)))),
        h('tbody', null, result.list.map((x, n) => {
          const tr = h('tr', { class: n === sel ? 'on' : null, tabindex: '0', title: `${x.distKm ? `${x.distKm.toFixed(1)} km from your point. ` : ''}${x.verdict.text}` },
            h('td', null, h('span', { class: `ld-dot g-${x.verdict.grade}` }), num(n)),
            ...[fig('safe', x) ? 'safe' : 'slope', 'sun', 'earth', 'dark', ...(result.slipDays ? ['slip'] : []), 'dv'].map((id) => { const f = fig(id, x); return h('td', { class: `r g-${f?.grade ?? ''}`, title: f ? `${f.label}: ${f.text}` : null }, cell(f)); }));
          tr.addEventListener('click', () => cb.onSelect?.(n));
          tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') cb.onSelect?.(n); });
          return tr;
        }))),
      h('p', { class: 'ld-note' }, 'Choose a spot in the bar over the map, a row here or a numbered spot on the Moon; Use this site makes it the mission\'s site with the landing time shown. Safe touchdown: 2000 landings scattered in the ellipse (3σ), each on ground within the slope limit and outside permanent shadow; rocks smaller than the DEM are not modelled. The Δv is from the planned polar orbit with this vehicle (assumed).'));
  }

  function renderBar() {
    if (!actionBar) return;
    const { pick, region, busy, result, sel } = st;
    const c = result?.list[sel] ?? null;
    const target = c ? (c.site.id === 'custom' ? `${fmtLat(c.latDeg)} ${fmtLon(c.lonDeg)}` : c.site.name) : '';
    actionBar.set('land', 'land', [
      { id: 'use', label: c ? `Use this site: ${target}` : 'Use this site', short: 'Use', icon: 'use', primary: !!c, disabled: !c, hint: busy ? 'Searching…' : 'Click the Moon to propose a point', title: c ? `Make ${target} the mission's site, landing ${utc(c.landingMs)}` : undefined, onClick: () => c && cb.onUse?.(c) },
      { id: 'route', label: 'Plan route from here', short: 'Route', icon: 'route', disabled: !c, hint: 'Screen and choose a spot first', title: c ? `Make ${target} the site and plan the rover route from it (the route planned before is cleared)` : undefined, onClick: () => c && cb.onRoute?.(c) },
      { id: 'start', label: busy ? 'Screening…' : 'Start screening', short: 'Start', icon: 'go', primary: !c && !!(pick || region) && !busy, disabled: !(pick || region) || !!busy, hint: 'Click the Moon or choose a region first', title: region ? `Screen region ${region} with the settings` : 'Search around the point with the settings', onClick: () => cb.onStart?.() },
      { type: 'segmented', id: 'spot', label: 'Candidate', value: result ? String(sel) : null, hint: busy ? `Searching… ${Math.round((busy.stage === 2 ? 50 : 0) + (busy.f ?? 0) * 50)}%` : 'No spots yet',
        options: result ? result.list.map((x, n) => ({ id: String(n), label: result.region ? String(n + 1) : n === 0 ? 'Yours' : String(n), title: `${x.name}: ${x.verdict.text}` })) : [],
        onChange: (id) => cb.onSelect?.(Number(id)) },
    ]);
  }

  function update(p = {}) {
    st = { ...st, ...p };
    assume.textContent = st.assume;
    if (p.params) for (const [k, inp] of Object.entries(inputs)) if (document.activeElement !== inp && p.params[k] !== undefined) inp.value = String(p.params[k]);
    stayNote.textContent = `Stay: ${st.stayDays} days ${Number.isFinite(st.planned) ? `from the planned landing, ${utc(st.planned)} (each spot lands in its first lit window within 2 days of it)` : 'from each place\'s first lit window'}; set the landing and the stay in the time dock. Battery, loads, ellipse and slope limit are assumptions.`;
    renderBody();
    renderBar();
  }
  update({});
  return { el, update };
}
