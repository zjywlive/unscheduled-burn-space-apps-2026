// One mission across the pages (navigator, lander, 3D globe): the chosen landing site and time travel from
// step to step, and every page shows the same stage bar
//   1 Site (index.html) → 2 Landing (lander.html) → 3 Rover (index.html, route card) → 4 3D (globe.html).
// The mission lives in localStorage (per browser, per origin; works from file:// too). Pure helpers plus one
// small DOM builder with no dependencies, so any page can use it.
//
// Mission = { siteId, siteName, latDeg, lonDeg, landingMs, stayDays, updatedMs }

export const MISSION_KEY = 'lsn-mission';
export const ROUTE_KEY = 'lsn-route3d';   // route3d.js ROUTE3D_KEY, repeated so this module has no imports
export const STAGES = Object.freeze([
  { id: 'site', n: 1, label: 'Site', title: 'Choose the landing site and date (navigator)' },
  { id: 'landing', n: 2, label: 'Landing', title: 'Fly the lander from Earth orbit to the site (lander)' },
  { id: 'rover', n: 3, label: 'Rover', title: 'Plan the rover route from the landing site (navigator, route card)' },
  { id: '3d', n: 4, label: '3D', title: 'See the site and the route on the 3D Moon (globe)' },
]);

const store = (s) => s ?? (typeof localStorage !== 'undefined' ? localStorage : null);

export function readMission(storage) {
  try {
    const m = JSON.parse(store(storage)?.getItem(MISSION_KEY) ?? 'null');
    return m && typeof m === 'object' && Number.isFinite(m.latDeg) && Number.isFinite(m.lonDeg) ? m : null;
  } catch { return null; }
}

export function writeMission(patch, storage) {
  const next = { ...(readMission(storage) ?? {}), ...patch, updatedMs: Date.now() };
  try { store(storage)?.setItem(MISSION_KEY, JSON.stringify(next)); } catch { /* storage blocked: the links still carry the site */ }
  // stage bars and next-step rows on this page rebuild their links
  try { if (!storage && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('lsn-mission', { detail: next })); } catch { /* no window */ }
  return next;
}

export function hasRoute(storage) {
  try { return !!store(storage)?.getItem(ROUTE_KEY); } catch { return false; }
}

const isoMin = (ms) => `${new Date(Math.floor(ms / 60e3) * 60e3).toISOString().slice(0, 16)}Z`;

// The URL of a stage for a mission (relative to demo/). Without a mission, the bare page.
export function stageUrl(stage, m, { route = false } = {}) {
  const site = m?.siteId ? encodeURIComponent(m.siteId) : m ? `${m.latDeg.toFixed(4)},${m.lonDeg.toFixed(4)}` : null;
  const t = m && Number.isFinite(m.landingMs) ? isoMin(m.landingMs) : null;
  const nav = (extra = '') => `index.html#view=map${site ? `&site=${site}` : ''}${t ? `&t=${t}` : ''}${m?.stayDays ? `&stay=${m.stayDays}` : ''}${extra}`;
  if (stage === 'site') return nav();
  if (stage === 'rover') return nav('&plan=1');
  if (stage === 'landing') return `lander.html${m?.siteId ? `?site=${encodeURIComponent(m.siteId)}${t ? `&t=${t}` : ''}` : ''}`;
  if (stage === '3d') {
    if (route) return 'globe.html#route=1';
    return m ? `globe.html#lat=${m.latDeg.toFixed(4)}&lon=${m.lonDeg.toFixed(4)}&dist=45&tilt=50&heading=0` : 'globe.html';
  }
  return 'index.html';
}

export const STAGE_CSS = `
.lsn-stages { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 999px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); font: 500 12px/1 Inter, system-ui, sans-serif; }
.lsn-stages a { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px 5px 6px; border-radius: 999px; color: #9aa0a6; text-decoration: none; white-space: nowrap; }
.lsn-stages a:hover { color: #e8eaed; background: rgba(255,255,255,0.08); }
.lsn-stages a[aria-current="step"] { color: #0b0c0e; background: #e8eaed; }
.lsn-stages .n { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; font-size: 10px; font-weight: 700; background: rgba(255,255,255,0.12); color: inherit; }
.lsn-stages a[aria-current="step"] .n { background: #0b0c0e; color: #e8eaed; }
.lsn-stages .sep { color: rgba(255,255,255,0.25); font-size: 10px; }
.lsn-stages .where { margin-left: 4px; padding: 0 8px 0 4px; color: #9aa0a6; font-weight: 400; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

// The stage bar: <nav> with the four stages as links (the current one marked), and the mission's site and
// date. Links are rebuilt from the stored mission when clicked, so they follow changes made on the page.
export function stageBar(doc, current, { getMission = () => readMission(), compact = false } = {}) {
  if (!doc.getElementById('lsn-stages-css')) {
    const st = doc.createElement('style'); st.id = 'lsn-stages-css'; st.textContent = STAGE_CSS; (doc.head ?? doc.documentElement).appendChild(st);
  }
  const nav = doc.createElement('nav');
  nav.className = 'lsn-stages';
  nav.setAttribute('aria-label', 'Mission steps');
  const links = [];
  STAGES.forEach((s, i) => {
    if (i) { const sep = doc.createElement('span'); sep.className = 'sep'; sep.textContent = '›'; sep.setAttribute('aria-hidden', 'true'); nav.appendChild(sep); }
    const a = doc.createElement('a');
    a.dataset.stage = s.id;
    a.title = s.title;
    const showLabel = !compact || s.id === current;   // compact: numbers only, but the current step keeps its name
    a.innerHTML = `<span class="n">${s.n}</span>${showLabel ? s.label : ''}`;
    if (!showLabel) a.setAttribute('aria-label', `Step ${s.n}: ${s.label}`);
    if (s.id === current) a.setAttribute('aria-current', 'step');
    const refresh = () => { a.href = stageUrl(s.id, getMission(), { route: s.id === '3d' && hasRoute() }); };
    refresh();
    a.addEventListener('pointerenter', refresh);
    a.addEventListener('focus', refresh);
    a.addEventListener('click', refresh);
    links.push(refresh);
    nav.appendChild(a);
  });
  const listen = (fn) => { try { doc.defaultView?.addEventListener('lsn-mission', fn); } catch { /* no window */ } };
  if (compact) { nav.refresh = () => links.forEach((f) => f()); listen(nav.refresh); return nav; }
  const where = doc.createElement('span');
  where.className = 'where';
  const show = () => {
    const m = getMission();
    where.textContent = m ? `${m.siteName ?? `${m.latDeg.toFixed(2)}°, ${m.lonDeg.toFixed(2)}°`}${Number.isFinite(m.landingMs) ? ` · ${new Date(m.landingMs).toISOString().slice(0, 10)}` : ''}` : '';
    where.hidden = !m;
  };
  show();
  nav.appendChild(where);
  nav.refresh = () => { links.forEach((f) => f()); show(); };
  listen(nav.refresh);
  return nav;
}

// The next steps after a stage as a row of links (for a page's own panel): e.g. after 'site', "Plan the landing",
// "Plan the rover route", "See in 3D". Links are rebuilt from the stored mission when used.
export const NEXT_LABELS = Object.freeze({ landing: 'Plan the landing', rover: 'Plan the rover route', '3d': 'See it in 3D' });
export function nextSteps(doc, after, { getMission = () => readMission(), className = 'lsn-next' } = {}) {
  const at = STAGES.findIndex((s) => s.id === after);
  const row = doc.createElement('div');
  row.className = className;
  for (const s of STAGES.slice(at + 1)) {
    const a = doc.createElement('a');
    a.dataset.stage = s.id;
    a.title = s.title;
    a.textContent = `${NEXT_LABELS[s.id] ?? s.label} →`;
    const refresh = () => { a.href = stageUrl(s.id, getMission(), { route: s.id === '3d' && hasRoute() }); };
    refresh();
    a.addEventListener('pointerenter', refresh); a.addEventListener('focus', refresh); a.addEventListener('click', refresh);
    try { doc.defaultView?.addEventListener('lsn-mission', refresh); } catch { /* no window */ }
    row.appendChild(a);
  }
  return row;
}
