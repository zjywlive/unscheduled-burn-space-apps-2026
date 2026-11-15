// Where to land, in the Map's panel (the planner's method on the 3D Moon; the old planner page's 2D map is gone
// from the Map): a click on the globe proposes a landing point; it and the five best spots found within 15 km are
// scored by lander/landeval.js and shown here: the verdict, each figure against its limit, and the spots side by
// side. The actions are in the action bar (actionbar.js, kind 'land'): Use this site, Find better spots, the
// candidate chooser. The globe draws the point, the search square and the numbered spots (ui/globemap.js).
//
// createLandCard({ actionBar }, cb) → { el, update(params) }
//   cb: { onUse(candidate), onSearch(), onSelect(n) }
//   params (each optional; missing keeps what is shown):
//     assume: string            the assumptions line (ellipse, slope limit, stay, battery)
//     pick: { latDeg, lonDeg } | null   the proposed point
//     busy: { stage: 1 | 2, f } | null  the search running (stage 1: the grid, stage 2: the detail)
//     result: { list: [pick, spot 1…5] } | null, sel: number   landeval.js evaluate() result and the chosen one
//     error: string | null
import { h, clear } from './dom.js';

const fmtLat = (v) => `${Math.abs(v).toFixed(3)}°${v < 0 ? 'S' : 'N'}`;
const fmtLon = (v) => `${(((v % 360) + 360) % 360).toFixed(3)}°E`;
const utc = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const short = (f) => (f ? f.text.split(' (')[0].split(' · ')[0] : '—');

export function createLandCard({ actionBar = null } = {}, cb = {}) {
  const assume = h('p', { class: 'ld-assume' });
  const body = h('div', { class: 'ld-body' });
  const el = h('section', { class: 'card card-land', 'aria-label': 'Where to land' }, h('h2', null, 'Where to land'), assume, body);
  let st = { assume: '', pick: null, busy: null, result: null, sel: 0, error: null };

  function renderBody() {
    clear(body);
    const { pick, busy, result, sel, error } = st;
    if (error) { body.append(h('p', { class: 'ld-note is-warn' }, error)); return; }
    if (!pick) {
      body.append(h('p', { class: 'ld-note' }, 'Click the Moon to propose a landing point. It is scored (terrain in the landing ellipse, Sun and Earth over the stay, permanent shadow, Δv) and the ground within 15 km is searched for better spots.'));
      return;
    }
    if (busy || !result) {
      const f = busy?.f ?? 0;
      body.append(
        h('p', { class: 'ld-point' }, h('b', null, 'Your point'), ` · ${fmtLat(pick.latDeg)} ${fmtLon(pick.lonDeg)}`),
        h('p', { class: 'ld-note' }, busy?.stage === 2 ? 'Scoring the point and the best spots in detail (terrain in the ellipse, sky over the stay, Δv)…' : `${pick.latDeg > -80 ? 'Loading the global LOLA terrain around the point and computing its skyline. ' : ''}Searching 15 km around the point for the best landing spots…`),
        h('div', { class: 'ld-prog', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(f * 100)) }, h('i', { style: `width:${Math.round(f * 100)}%` })));
      return;
    }
    const c = result.list[sel] ?? result.list[0];
    const fig = (id, x) => x.figs.find((q) => q.id === id);
    body.append(
      h('p', { class: 'ld-point' }, h('b', null, c.name), ` · ${fmtLat(c.latDeg)} ${fmtLon(c.lonDeg)}${c.distKm ? ` · ${c.distKm.toFixed(1)} km from your point` : ''}`, h('br'), h('span', { class: 'muted' }, `landing ${utc(c.landingMs)} (first lit window)`)),
      h('p', { class: `ld-badge${c.resKm > 0.04 ? ' is-coarse' : ''}` }, `Terrain ${Math.round(c.resKm * 1000)} m${c.patch ? ' (SLDEM2015 patch)' : ''} · skyline ${c.polar ? 'polar 480 m' : 'computed from the global LOLA terrain'} · ${c.resKm > 0.1 ? 'lander-scale hazards not resolved' : c.resKm > 0.04 ? 'slopes at ~100 m scale, rocks not resolved' : 'lander-scale slopes resolved, rocks not'}`),
      h('p', { class: `ld-verdict g-${c.verdict.grade}` }, c.verdict.text),
      h('ul', { class: 'ld-figs' }, c.figs.map((f) => h('li', { class: `g-${f.grade}` },
        h('div', { class: 'ld-f-h' }, h('span', null, f.label), h('span', { class: 'ld-g' }, f.grade)),
        h('div', { class: 'ld-f-v' }, h('b', null, f.text), h('span', { class: 'muted' }, `limit ${f.limit}`)),
        h('small', null, f.note)))),
      h('h3', { class: 'ld-h3' }, 'Better spots nearby', h('small', null, 'the 5 best that pass the hard limits within 15 km, at least 2 km apart, by suitability; same stay and method')),
      h('table', { class: 'ld-tbl' },
        h('thead', null, h('tr', null, ['#', 'km', 'Slope', 'Sun', 'Earth', 'Dark', 'Δv'].map((t, i) => h('th', { class: i ? 'r' : null }, t)))),
        h('tbody', null, result.list.map((x, n) => {
          const tr = h('tr', { class: n === sel ? 'on' : null, tabindex: '0', title: x.verdict.text },
            h('td', null, h('span', { class: `ld-dot g-${x.verdict.grade}` }), n === 0 ? 'You' : String(n)),
            h('td', { class: 'r' }, x.distKm.toFixed(1)),
            ...['slope', 'sun', 'earth', 'dark', 'dv'].map((id) => { const f = fig(id, x); return h('td', { class: `r g-${f?.grade ?? ''}` }, short(f)); }));
          tr.addEventListener('click', () => cb.onSelect?.(n));
          tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') cb.onSelect?.(n); });
          return tr;
        }))),
      h('p', { class: 'ld-note' }, 'Choose a spot in the bar over the map, a row here or a numbered spot on the Moon; Use this site makes it the mission\'s site with its first lit landing time. Rocks smaller than the DEM are not modelled; the Δv is from the planned polar orbit with this vehicle (assumed).'));
  }

  function renderBar() {
    if (!actionBar) return;
    const { pick, busy, result, sel } = st;
    const c = result?.list[sel] ?? null;
    const target = c ? (c.site.id === 'custom' ? `${fmtLat(c.latDeg)} ${fmtLon(c.lonDeg)}` : c.site.name) : '';
    actionBar.set('land', 'land', [
      { id: 'use', label: c ? `Use this site: ${target}` : 'Use this site', short: 'Use', icon: 'use', primary: !!c, disabled: !c, hint: busy ? 'Searching…' : 'Click the Moon to propose a point', title: c ? `Make ${target} the mission's site, landing ${utc(c.landingMs)}` : undefined, onClick: () => c && cb.onUse?.(c) },
      { id: 'search', label: busy ? 'Searching…' : 'Find better spots', short: 'Search', icon: 'route', disabled: !pick || !!busy, hint: 'Click the Moon to propose a point', title: 'Search 15 km around your point again', onClick: () => cb.onSearch?.() },
      { type: 'segmented', id: 'spot', label: 'Candidate', value: result ? String(sel) : null, hint: busy ? `Searching… ${Math.round((busy.stage === 2 ? 50 : 0) + (busy.f ?? 0) * 50)}%` : 'No spots yet',
        options: result ? result.list.map((x, n) => ({ id: String(n), label: n === 0 ? 'Yours' : String(n), title: `${x.name}: ${x.verdict.text}` })) : [],
        onChange: (id) => cb.onSelect?.(Number(id)) },
    ]);
  }

  function update(p = {}) {
    st = { ...st, ...p };
    assume.textContent = st.assume;
    renderBody();
    renderBar();
  }
  update({});
  return { el, update };
}
