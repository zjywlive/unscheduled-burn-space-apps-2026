// The plan steps on the inspector (docs/FLOW-MOCK.md §5, variant B, chosen 15 Nov 2026): a row of five tabs on top
// of the right panel, Site · Date · Verdict · Compare · Route, the challenge's loop in order. Site and Route are the
// panel's own cards (the point card, the route card); Date, Verdict and Compare are panels of their own in the same
// place. Every number comes from the compute tools (tools-core.js: site_summary, compare_scenarios, next_events,
// best_landing_dates, energy_summary), the figures Details shows; nothing is recomputed here. The pass marks of the
// Verdict (gradeStay) are this panel's.
//
// createPlanSteps(doc, { panel, core, getState, sites, act, onStep }) → { el, set(step), sync(kind), refresh(), step }
//   panel     the inspector (#lsn-point-panel); the tabs go first in it, the step panel last
//   core      createCoreTools(…) (run(name, input) → Promise<result | { error }>)
//   getState  () → the page state (site, landingMs, stayDays, slipDays, cursorMs)
//   act       { setLanding(ms), setStay(days), selectSite(site), openDetail(tab), showSite(), openRoute() }
//   onStep    (step) → void: the step changed (main.js keeps it in the hash, step=)

export const STEP_IDS = ['site', 'date', 'verdict', 'compare', 'route'];
const LABEL = { site: 'Site', date: 'Date', verdict: 'Verdict', compare: 'Compare', route: 'Route' };
const TITLE = {
  site: 'Where to land: a listed site, coordinates or a click on the Moon (Where to land in the point bar screens an area)',
  date: 'When to land and how long to stay: the landing days around it, by hours with the Sun and the Earth in view',
  verdict: 'Is it viable: the Sun and the Earth now, the stay\'s hours, power and communications',
  compare: 'The plan against a slipped date, another site or the best date nearby',
  route: 'The rover route from the landing spot (the route card)',
};
const OWN = new Set(['date', 'verdict', 'compare']);   // the steps with a panel of their own

const DAY = 86400e3, HOUR = 3600e3;
const iso = (ms) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayOf = (ms) => Math.floor(ms / DAY) * DAY;
const fmtDay = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtDayY = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtDT = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const hrs = (h) => `${Math.round(h)} h`;
const dark = (h) => (h >= 48 ? `${Math.round(h / 24)} d` : `${Math.round(h)} h`);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const VERDICT_LABEL = { ok: 'Viable', near: 'Marginal', bad: 'Not viable' };
const GRADE_LABEL = { ok: 'Pass', near: 'Marginal', bad: 'Fail' };

// Which step the tabs show when the inspector's own content changes (main.js `kind`): a route on the panel is the
// Route step, a region or Where to land belongs to the Site step, and leaving the route ends the Route step. A
// point picked on the Moon keeps Date, Verdict or Compare open (they follow the new site).
export function stepForKind(step, kind) {
  if (kind === 'route') return 'route';
  if (kind === 'region' || kind === 'land') return 'site';
  if (step === 'route') return 'site';
  return STEP_IDS.includes(step) ? step : 'site';
}

// The Verdict's pass marks. summary: a site_summary / compare_scenarios result; energy: energy_summary (optional).
// Power passes when the battery never runs empty (marginal up to a day empty); without energy, on the longest dark
// spell (a day passes, two are marginal). Communications: the Earth in view ≥ 50 % of the stay (≥ 25 % marginal).
// Sunlight: the Sun in view ≥ 70 % (≥ 40 % marginal). Overall: the worst of the three.
export function gradeStay(summary, energy = null) {
  const empty = energy?.planned?.atEmptyH;
  const power = Number.isFinite(empty) ? (empty <= 0 ? 'ok' : empty <= 24 ? 'near' : 'bad') : (summary.longestDarkH <= 24 ? 'ok' : summary.longestDarkH <= 48 ? 'near' : 'bad');
  const comms = summary.earthPct >= 50 ? 'ok' : summary.earthPct >= 25 ? 'near' : 'bad';
  const sun = summary.sunPct >= 70 ? 'ok' : summary.sunPct >= 40 ? 'near' : 'bad';
  const all = [power, comms, sun];
  return { power, comms, sun, overall: all.includes('bad') ? 'bad' : all.includes('near') ? 'near' : 'ok' };
}

export function createPlanSteps(doc, { panel, core, getState, sites = [], act, onStep = () => {} }) {
  let step = 'site';
  const tabs = doc.createElement('div');
  tabs.className = 'ps-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Plan steps');
  tabs.innerHTML = STEP_IDS.map((id, i) => `<button type="button" role="tab" data-step="${id}" title="${i + 1} · ${TITLE[id]}">${LABEL[id]}</button>`).join('');
  const body = doc.createElement('section');
  body.className = 'ps-body';
  body.setAttribute('aria-live', 'polite');
  panel.prepend(tabs);
  panel.append(body);
  tabs.addEventListener('click', (e) => {
    const id = e.target.closest('[data-step]')?.dataset.step;
    if (!id) return;
    set(id);
    if (id === 'site') act.showSite();
    if (id === 'route') act.openRoute();
  });

  const place = (s) => (s.id && s.id !== 'custom' ? { site_id: s.id } : { lat_deg: s.latDeg, lon_deg: s.lonDeg });
  const run = async (name, input) => { const r = await core.run(name, input); if (r?.error) throw new Error(r.error); return r; };
  const siteName = (s) => esc(s.name ?? 'Map point');
  let token = 0;
  const frame = (title, sub, inner, prev, next, nextLabel) => {
    body.innerHTML = `<div class="ps-head"><h2>${title}</h2><p>${sub}</p></div><div class="ps-main">${inner}</div>
      <div class="ps-foot">${prev ? `<button type="button" class="ps-btn ps-ghost" data-go="${prev}">← ${LABEL[prev]}</button>` : ''}<span class="ps-grow"></span>${next ? `<button type="button" class="ps-btn ps-pri" data-go="${next}">${nextLabel} →</button>` : ''}</div>`;
    body.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { const id = b.dataset.go; set(id); if (id === 'route') act.openRoute(); if (id === 'site') act.showSite(); }));
    return body.querySelector('.ps-main');
  };
  const fail = (main, e) => { main.innerHTML = `<p class="ps-wait">${esc(e.message)}</p>`; };
  const detailLinks = (main) => main.querySelectorAll('[data-detail]').forEach((a) => a.addEventListener('click', () => act.openDetail(a.dataset.detail)));

  // ---- Date: the landing time, the stay, five weeks of landing days, the best starts nearby ----
  async function renderDate() {
    const my = ++token, s = getState(), P = place(s.site);
    const d0 = dayOf(s.landingMs) - 7 * DAY;
    const start = d0 - ((new Date(d0).getUTCDay() + 6) % 7) * DAY;   // the Monday on or before a week earlier
    const days = Array.from({ length: 35 }, (_, i) => start + i * DAY);
    const wd = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x) => `<span class="ps-wd">${x}</span>`).join('');
    const main = frame('When to land', `${siteName(s.site)} · landing time (UTC) and stay`,
      `<label class="ps-lbl" for="ps-land">Landing (UTC)</label><input class="ps-in" type="datetime-local" id="ps-land" step="3600" value="${iso(s.landingMs).slice(0, 16)}">
       <div class="ps-lbl">Stay</div><div class="ps-seg">${[7, 14, 30].map((n) => `<button type="button" aria-pressed="${n === s.stayDays}" data-n="${n}">${n} days</button>`).join('')}</div>
       <div class="ps-lbl">Landing days · hours with the Sun and the Earth both in view over a ${+s.stayDays.toFixed(2)}-day stay</div>
       <div class="ps-cal" id="ps-cal">${wd}<span class="ps-wait" style="grid-column:1/-1">Computing…</span></div>
       <div class="ps-legend"><i></i>fewer → more hours</div>
       <div class="ps-lbl">Best starts nearby</div><div class="ps-best" id="ps-best"><span class="ps-wait">Computing…</span></div>`,
      'site', 'verdict', 'Verdict');
    const land = main.querySelector('#ps-land');
    land.addEventListener('change', () => { const t = Date.parse(`${land.value}:00Z`); if (Number.isFinite(t)) act.setLanding(t); });
    main.querySelectorAll('.ps-seg button').forEach((b) => b.addEventListener('click', () => act.setStay(+b.dataset.n)));
    try {
      const res = [];
      for (let i = 0; i < days.length; i += 24) res.push(...(await run('compare_scenarios', { stay_days: s.stayDays, scenarios: days.slice(i, i + 24).map((t) => ({ ...P, landing: isoDay(t) })) })).scenarios);
      if (my !== token) return;
      const max = Math.max(1, ...res.map((r) => r.bothH));
      const hh = iso(s.landingMs).slice(11, 16);
      main.querySelector('#ps-cal').innerHTML = wd + res.map((r, i) => {
        const f = r.bothH / max, cls = f > 0.66 ? 'hi' : f > 0.33 ? 'mid' : 'lo';
        return `<button type="button" class="${cls}" data-t="${days[i]}" aria-pressed="${dayOf(s.landingMs) === days[i]}" title="${fmtDay(days[i])}: ${hrs(r.bothH)} with the Sun and the Earth, longest dark ${dark(r.longestDarkH)}">${new Date(days[i]).getUTCDate()}<small>${Math.round(r.bothH)} h</small></button>`;
      }).join('');
      main.querySelectorAll('#ps-cal button').forEach((b) => b.addEventListener('click', () => act.setLanding(Date.parse(`${isoDay(+b.dataset.t)}T${hh}:00Z`))));
      const best = await run('best_landing_dates', { ...P, stay_days: s.stayDays, from: isoDay(s.landingMs - 28 * DAY), to: isoDay(s.landingMs + 56 * DAY), count: 4 });
      if (my !== token) return;
      main.querySelector('#ps-best').innerHTML = best.candidates.map((c) => `<button type="button" data-l="${Date.parse(c.landing)}"><span>${fmtDayY(Date.parse(c.landing))}</span><span>${c.display} both · dark ${dark(c.exact.longestDarkH)}</span></button>`).join('') || '<span class="ps-wait">None in range.</span>';
      main.querySelectorAll('#ps-best button').forEach((b) => b.addEventListener('click', () => act.setLanding(+b.dataset.l)));
    } catch (e) { if (my === token) fail(main.querySelector('#ps-cal'), e); }
  }

  // ---- Verdict: one sentence, the Sun and the Earth now, the stay's hours, three graded checks ----
  let nowKey = '', nowAt = 0;
  async function renderNow(s) {
    const el = body.querySelector('#ps-now');
    if (!el) return;
    const at = s.cursorMs ?? s.landingMs;
    nowKey = `${s.site.id}|${s.site.latDeg}|${s.site.lonDeg}|${Math.floor(at / HOUR)}`;
    try {
      const ev = await run('next_events', { ...place(s.site), at: iso(at) });
      const tile = (b, name) => `<div class="ps-tile ps-${name}"><div class="ps-k">${name === 'sun' ? 'Sun' : 'Earth'} at ${fmtDT(Date.parse(ev.at)).slice(5, 16)}</div><div class="ps-v">${b.elDeg.toFixed(1)}°</div><div class="ps-s">${b.visible ? 'in view' : `behind the skyline (${b.skylineDeg.toFixed(1)}°)`}${b.countdown ? ` · ${esc(b.countdown)}` : ''}</div></div>`;
      el.innerHTML = tile(ev.sun, 'sun') + tile(ev.earth, 'earth');
    } catch (e) { el.innerHTML = `<p class="ps-wait">${esc(e.message)}</p>`; }
  }
  async function renderVerdict() {
    const my = ++token, s = getState(), P = place(s.site);
    const main = frame('Is it viable?', `${siteName(s.site)} · landing ${fmtDT(s.landingMs)} · ${+s.stayDays.toFixed(2)}-day stay`, '<p class="ps-wait">Computing…</p>', 'date', 'compare', 'Compare');
    try {
      const [sum, en] = await Promise.all([
        run('site_summary', { stay_days: s.stayDays, scenarios: [{ ...P, landing: iso(s.landingMs) }] }),
        run('energy_summary', { ...P, landing: iso(s.landingMs), stay_days: s.stayDays }).catch(() => null),
      ]);
      if (my !== token) return;
      const r = sum.results[0], g = gradeStay(r, en), cov = r.stay.coveredH || 1;
      const why = [];
      if (g.power !== 'ok') why.push(en ? `the battery runs empty for ${hrs(en.planned.atEmptyH)}` : `a ${dark(r.longestDarkH)} dark spell`);
      if (g.comms !== 'ok') why.push(`the Earth is in view only ${Math.round(r.earthPct)} % of the stay`);
      if (g.sun !== 'ok') why.push(`the Sun is in view only ${Math.round(r.sunPct)} % of the stay`);
      const head = g.overall === 'ok' ? 'Viable: power and communications hold for the whole stay.' : `${VERDICT_LABEL[g.overall]}: ${why.join('; ')}.`;
      const bar = (k, h, c) => `<div class="ps-bar"><span>${k}</span><i><b style="width:${Math.min(100, (h / cov) * 100)}%;background:${c}"></b></i><span>${hrs(h)}</span></div>`;
      const check = (gr, name, note) => `<div class="ps-check"><span class="ps-g g-${gr}">${GRADE_LABEL[gr]}</span><span>${name}<small>${note}</small></span></div>`;
      main.innerHTML = `
        <div class="ps-verdict g-${g.overall}">${head}<small>${en ? `Battery ${en.assumptions.batteryHours} h of load, panels ${en.assumptions.panelToLoad}× the load, sun-tracking: assumed, as Power in Details. ` : ''}Direct-to-Earth link.</small></div>
        <div class="ps-tiles" id="ps-now"><p class="ps-wait">…</p></div>
        <div class="ps-lbl">Over the stay (${hrs(cov)})</div>
        ${bar('Sunlit', r.sunH, 'var(--sun)')}${bar('Earth in view', r.earthH, 'var(--earth)')}${bar('Both', r.bothH, 'var(--both, #e6e6e6)')}
        <div class="ps-checks">
          ${check(g.power, 'Power', `${en ? (en.planned.atEmptyH > 0 ? `Battery empty ${hrs(en.planned.atEmptyH)}, asleep ${hrs(en.planned.asleepH)}` : `Never empty; lowest ${en.planned.minBatteryH.toFixed(1)} h of load left`) + ' · ' : ''}longest dark ${dark(r.longestDarkH)}`)}
          ${check(g.comms, 'Communications', `Earth in view ${Math.round(r.earthPct)} % of the stay (50 % passes)`)}
          ${check(g.sun, 'Sunlight', `Sun in view ${Math.round(r.sunPct)} % of the stay (70 % passes), peak ${r.peakSunElDeg.toFixed(1)}°`)}
        </div>
        <p class="ps-note">Pass marks are this panel's; the hours are the ones Details shows. <a role="button" tabindex="0" data-detail="overview">Overview</a> · <a role="button" tabindex="0" data-detail="power">Power</a> · <a role="button" tabindex="0" data-detail="comms">Comms</a></p>`;
      detailLinks(main);
      await renderNow(s);
    } catch (e) { if (my === token) fail(main, e); }
  }

  // ---- Compare: the plan and up to three columns (a slip, the best date nearby, another site) ----
  let cols = null, colsKey = '';
  async function renderCompare() {
    const my = ++token, s = getState(), P = place(s.site);
    const key = `${s.site.id}|${s.site.latDeg}|${s.site.lonDeg}|${s.landingMs}|${s.stayDays}`;
    const main = frame('Compare options', 'The plan against a slipped date, another site or the best date nearby; any column can become the plan.', '<p class="ps-wait">Computing…</p>', 'verdict', 'route', 'Route');
    try {
      if (!cols || colsKey !== key) {
        colsKey = key;
        const slip = s.slipDays || 14;
        cols = [{ label: `${slip > 0 ? '+' : '−'}${Math.abs(slip)} d`, site: s.site, landingMs: s.landingMs + slip * DAY }];
        const b = await run('best_landing_dates', { ...P, stay_days: s.stayDays, from: isoDay(s.landingMs + DAY), to: isoDay(s.landingMs + 28 * DAY), count: 1 }).catch(() => null);
        if (b?.candidates?.[0]) cols.push({ label: 'Best nearby', site: s.site, landingMs: Date.parse(b.candidates[0].landing) });
      }
      const all = [{ label: 'Plan', site: s.site, landingMs: s.landingMs }, ...cols];
      const res = await run('compare_scenarios', { stay_days: s.stayDays, scenarios: all.map((c) => ({ ...place(c.site), landing: iso(c.landingMs) })) });
      if (my !== token) return;
      const sc = res.scenarios;
      const rows = [['Both', 'bothH', 1, 'Sun and Earth both in view'], ['Sunlit', 'sunH', 1, 'Sun in view'], ['Earth', 'earthH', 1, 'Earth in view'], ['Max dark', 'longestDarkH', -1, 'The longest spell without the Sun']];
      const others = sites.filter((x) => x.id !== s.site.id);
      main.innerHTML = `
        <div class="ps-adds"><button type="button" class="ps-btn" data-add="7">+ Slip 7 d</button><button type="button" class="ps-btn" data-add="14">+ Slip 14 d</button>
          <select class="ps-select" aria-label="Add another site"><option value="">+ Other site…</option>${others.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></div>
        <table class="ps-cmp"><thead><tr><th></th>${all.map((c, i) => `<th>${esc(c.label)}${i ? ` <button type="button" class="ps-x" data-del="${i - 1}" aria-label="Remove ${esc(c.label)}">×</button>` : ''}<small>${esc((c.site.name ?? 'Map point').split(' ')[0])} · ${fmtDay(c.landingMs)}</small></th>`).join('')}</tr></thead><tbody>
        ${rows.map(([k, f, better, t]) => `<tr><td title="${t}">${k}</td>${sc.map((r, i) => { const v = r[f], dl = Math.round(v - sc[0][f]); const cls = i === 0 || !dl ? 'same' : dl * better > 0 ? 'up' : 'down'; return `<td>${hrs(v)}${i ? `<span class="ps-d ${cls}">${dl > 0 ? '+' : dl < 0 ? '−' : '±'}${hrs(Math.abs(dl))}</span>` : ''}</td>`; }).join('')}</tr>`).join('')}
        <tr class="ps-vrow"><td>Verdict</td>${sc.map((r) => `<td>${VERDICT_LABEL[gradeStay(r).overall]}</td>`).join('')}</tr>
        <tr><td></td>${all.map((c, i) => (i ? `<td><button type="button" class="ps-mini" data-make="${i - 1}">Make plan</button></td>` : '<td></td>')).join('')}</tr>
        </tbody></table>
        <p class="ps-note">The figures of Details → Compare (compare_scenarios). <a role="button" tabindex="0" data-detail="compare">Open Compare</a></p>`;
      const push = (c) => { cols.push(c); if (cols.length > 3) cols.shift(); renderCompare(); };
      main.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => push({ label: `+${b.dataset.add} d`, site: s.site, landingMs: s.landingMs + +b.dataset.add * DAY })));
      main.querySelector('.ps-select').addEventListener('change', (e) => { const x = sites.find((y) => y.id === e.target.value); if (x) push({ label: x.name.split(' ')[0], site: x, landingMs: s.landingMs }); });
      main.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { cols.splice(+b.dataset.del, 1); renderCompare(); }));
      main.querySelectorAll('[data-make]').forEach((b) => b.addEventListener('click', () => {
        const c = cols[+b.dataset.make];
        cols = null;
        if (c.site !== s.site) act.selectSite(c.site);
        act.setLanding(c.landingMs);
      }));
      detailLinks(main);
    } catch (e) { if (my === token) fail(main, e); }
  }

  const RENDER = { date: renderDate, verdict: renderVerdict, compare: renderCompare };
  let lastKey = '';
  const planKey = (s) => `${step}|${s.site.id}|${s.site.latDeg}|${s.site.lonDeg}|${s.landingMs}|${s.stayDays}|${s.slipDays}`;

  function set(id, { silent = false } = {}) {
    const next = STEP_IDS.includes(id) ? id : 'site';
    const changed = next !== step;
    step = next;
    tabs.querySelectorAll('[data-step]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.step === step)));
    if (OWN.has(step)) panel.dataset.step = step; else delete panel.dataset.step;
    if (changed) panel.scrollTop = 0;   // each step starts at its top (the tabs are sticky over the scrolled panel)
    if (OWN.has(step) && (changed || !body.childElementCount)) { lastKey = planKey(getState()); RENDER[step](); }
    if (!OWN.has(step)) { token++; body.innerHTML = ''; }
    if (changed && !silent) onStep(step);
  }
  // the page changed: the inspector's kind may move the tabs, a new site, date or stay redraws the open step, and
  // the Verdict's "now" tiles follow the clock by the hour
  function sync(kind) {
    const next = stepForKind(step, kind);
    if (next !== step) set(next);
    refresh();
  }
  function refresh() {
    if (!OWN.has(step)) return;
    const s = getState(), k = planKey(s);
    if (k !== lastKey) { lastKey = k; RENDER[step](); return; }
    if (step === 'verdict') {
      const nk = `${s.site.id}|${s.site.latDeg}|${s.site.lonDeg}|${Math.floor((s.cursorMs ?? s.landingMs) / HOUR)}`;
      if (nk !== nowKey && Date.now() - nowAt > 500) { nowAt = Date.now(); renderNow(s); }   // at most twice a second while it plays
    }
  }
  set('site', { silent: true });
  return { el: tabs, body, set, sync, refresh, get step() { return step; } };
}
