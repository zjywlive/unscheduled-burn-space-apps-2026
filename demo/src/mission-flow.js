// One mission across the pages. Everything is planned before launch, then frozen and flown:
//   PLAN  1 Map (index.html: the whole Moon → a region → the south-pole site analysis, the landing spot, timing,
//         the rover route)  →  2 Finalise (finalise.html: go/no-go checks, the vehicle, freeze)
//   FLY   3 Execute (lander.html: the frozen configuration flown from launch to surface operations).
// The planning state lives in localStorage (per browser, per origin; works from file:// too); the frozen
// configuration the execution page flies is in mission-config.js. Pure helpers plus one small DOM builder with
// no dependencies, so any page can use it.
//
// Mission = { siteId, siteName, latDeg, lonDeg, landingMs, stayDays, vehicle?, updatedMs,
//             landed: { latDeg, lonDeg, tMs, siteId, missM, source } | null }   where the lander touched down
//             (written by the execution page; the 3D globe draws the lander there)

export const MISSION_KEY = 'lsn-mission';
export const ROUTE_KEY = 'lsn-route3d';   // route3d.js ROUTE3D_KEY, repeated so this module has no imports
export const CONFIG_KEY = 'lsn-config';   // mission-config.js CONFIG_KEY (the frozen configuration)
export const STAGES = Object.freeze([
  { id: 'map', n: 1, group: 'Plan', label: 'Map', title: 'Plan the whole mission: the site anywhere on the Moon, its timing, the landing spot and the rover route (navigator)' },
  { id: 'finalise', n: 2, group: 'Plan', label: 'Finalise', title: 'Check go / no-go and freeze the mission configuration (site, landing time and window, stay, vehicle, rover route)' },
  { id: 'execute', n: 3, group: 'Fly', label: 'Execute', title: 'Fly the frozen mission: launch, spaceflight, orbital manoeuvres, lunar orbit insertion, landing, surface operations' },
]);
// The six phases the execution page flies, in order (lander.html; the phase ids of lander/mission.js in each)
export const EXEC_PHASES = Object.freeze([
  { id: 'launch', label: 'Launch', short: 'Launch', from: ['leo'] },
  { id: 'spaceflight', label: 'Spaceflight', short: 'Spaceflight', from: ['tli', 'coast'] },
  { id: 'orbit', label: 'Orbital manoeuvres', short: 'Manoeuvres', from: ['approach-moon'] },
  { id: 'loi', label: 'Lunar orbit insertion', short: 'LOI', from: ['loi', 'llo'] },
  { id: 'landing', label: 'Landing', short: 'Landing', from: ['doi', 'descent-coast', 'braking', 'approach', 'terminal', 'landed'] },
  { id: 'surface', label: 'Surface operations', short: 'Surface', from: [] },
]);
export const execPhaseOf = (landerPhaseId) => EXEC_PHASES.find((p) => p.from.includes(landerPhaseId))?.id ?? null;

const store = (s) => s ?? (typeof localStorage !== 'undefined' ? localStorage : null);

export function readMission(storage) {
  try {
    const m = JSON.parse(store(storage)?.getItem(MISSION_KEY) ?? 'null');
    return m && typeof m === 'object' && Number.isFinite(m.latDeg) && Number.isFinite(m.lonDeg) ? m : null;
  } catch { return null; }
}

// The rover route being planned on the Map ({ points, maxSlopeDeg, selected }, map km): kept here as well as in the
// page's hash, so it survives a trip to another page (the 3D globe, Finalise) and comes back with the Map. It goes
// only when the user clears it or draws a new one (main.js persistRoutePlan).
export const ROUTE_PLAN_KEY = 'lsn-route-plan';
export function readRoutePlan(storage) {
  try {
    const r = JSON.parse(store(storage)?.getItem(ROUTE_PLAN_KEY) ?? 'null');
    return r && Array.isArray(r.points) && r.points.length >= 2 ? r : null;
  } catch { return null; }
}
export function writeRoutePlan(plan, storage) {
  try { if (plan) store(storage)?.setItem(ROUTE_PLAN_KEY, JSON.stringify(plan)); else store(storage)?.removeItem(ROUTE_PLAN_KEY); } catch { /* storage blocked: the hash still carries it */ }
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

export function hasConfig(storage) {
  try { return !!store(storage)?.getItem(CONFIG_KEY); } catch { return false; }
}
// The planning mission's site, landing time or stay differs from the frozen configuration (the same test as
// mission-config.js changesSince, repeated so this module has no imports). False when either is missing.
export function planChanged(storage) {
  try {
    const c = JSON.parse(store(storage)?.getItem(CONFIG_KEY) ?? 'null'), m = readMission(storage);
    if (!c?.site || !m) return false;
    const near = (a, b, eps) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;
    return (c.site.id ?? null) !== (m.siteId ?? null) || !near(c.site.latDeg, m.latDeg, 1e-6) || !near(c.site.lonDeg, m.lonDeg, 1e-6)
      || !near(c.landing?.requestedMs, m.landingMs, 30e3) || (Number.isFinite(m.stayDays) && m.stayDays !== c.stayDays);
  } catch { return false; }
}

// Great-circle distance between two lat/lon points on the Moon, km.
export function moonKm(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180, R = 1737.4;
  const s = Math.sin((bLat - aLat) * r / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin((bLon - aLon) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// The mission's touchdown point when it belongs to the mission's site (same id, or within 30 km), else null.
export function landedFor(m) {
  const l = m?.landed;
  if (!l || !Number.isFinite(l.latDeg) || !Number.isFinite(l.lonDeg)) return null;
  if (l.siteId && m.siteId && l.siteId !== m.siteId) return null;
  if (Number.isFinite(m.latDeg) && moonKm(l.latDeg, l.lonDeg, m.latDeg, m.lonDeg) > 30) return null;
  return l;
}

// "land=lat,lon" in a hash → { latDeg, lonDeg } | null
export function landFromHash(hash) {
  const mm = /(?:^|[#&])land=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:&|$)/.exec(String(hash));
  if (!mm) return null;
  const latDeg = Number(mm[1]), raw = Number(mm[2]);
  const lonDeg = raw >= 0 && raw < 360 ? raw : ((raw % 360) + 360) % 360;   // wrap only when needed (no float noise)
  return latDeg >= -90 && latDeg <= 90 ? { latDeg, lonDeg } : null;
}

const isoMin = (ms) => `${new Date(Math.floor(ms / 60e3) * 60e3).toISOString().slice(0, 16)}Z`;

// The URL of a stage (or of a planning tool) for a mission, relative to demo/. Without a mission, the bare page.
//   map, site   the Map at the site and time          rover    the Map with the route card open at the site
//   region      the "Where to land" planner           finalise / execute   their pages (they read the storage)
//   3d          the globe at the site (or the route)
export function stageUrl(stage, m, { route = false } = {}) {
  // a point picked on the map is stored with siteId 'custom', which is not a listed site: the link carries it as c:lat,lon
  const site = m?.siteId && m.siteId !== 'custom' ? encodeURIComponent(m.siteId) : m ? `c:${m.latDeg.toFixed(4)},${m.lonDeg.toFixed(4)}` : null;
  const t = m && Number.isFinite(m.landingMs) ? isoMin(m.landingMs) : null;
  const nav = (extra = '') => `index.html#view=map${site ? `&site=${site}` : ''}${t ? `&t=${t}` : ''}${m?.stayDays ? `&stay=${m.stayDays}` : ''}${extra}`;
  if (stage === 'map' || stage === 'site') return nav();
  const landed = landedFor(m);
  if (stage === 'rover') return nav(`&plan=1${landed ? `&land=${landed.latDeg.toFixed(5)},${landed.lonDeg.toFixed(5)}` : ''}`);
  if (stage === 'region') return `planner.html${m ? `?at=${m.latDeg.toFixed(4)},${m.lonDeg.toFixed(4)}${t ? `&t=${t}` : ''}` : ''}`;
  if (stage === 'finalise') return 'finalise.html';
  if (stage === 'execute') return 'lander.html';
  if (stage === '3d') {
    if (route) return 'globe.html#route=1';
    const c = landed ?? m;
    return c ? `globe.html#lat=${c.latDeg.toFixed(4)}&lon=${c.lonDeg.toFixed(4)}&dist=${landed ? 12 : 45}&tilt=50&heading=0` : 'globe.html';
  }
  return 'index.html';
}

export const STAGE_CSS = `
.lsn-stages { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 999px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); font: 500 12px/1 Inter, system-ui, sans-serif; }
.lsn-stages a { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px 5px 6px; border-radius: 999px; color: #9aa0a6; text-decoration: none; white-space: nowrap; }
.lsn-stages a:hover { color: #e8eaed; background: rgba(255,255,255,0.08); }
.lsn-stages a[aria-current="step"] { color: #0b0c0e; background: #e8eaed; }
.lsn-stages a[data-locked] { opacity: 0.55; }
.lsn-stages .n { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; font-size: 10px; font-weight: 700; background: rgba(255,255,255,0.12); color: inherit; }
.lsn-stages a[aria-current="step"] .n { background: #0b0c0e; color: #e8eaed; }
.lsn-stages .sep { color: rgba(255,255,255,0.25); font-size: 10px; }
.lsn-stages .grp { padding: 0 2px 0 8px; color: rgba(255,255,255,0.38); font-size: 9.5px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }
.lsn-stages .grp + a { margin-left: 2px; }
.lsn-stages .where { margin-left: 4px; padding: 0 8px 0 4px; color: #9aa0a6; font-weight: 400; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lsn-stages.compact .grp { display: none; }
`;

// The stage bar: <nav> with the steps as links under their group (Plan: Map, Finalise; Fly: Execute), the current
// one marked, and the mission's site and date. Execute is marked locked until a configuration is frozen (its link
// still opens the page, which says so). Links are rebuilt from the stored mission when used, so they follow
// changes made on the page.
export function stageBar(doc, current, { getMission = () => readMission(), compact = false, locked = () => !hasConfig() } = {}) {
  if (!doc.getElementById('lsn-stages-css')) {
    const st = doc.createElement('style'); st.id = 'lsn-stages-css'; st.textContent = STAGE_CSS; (doc.head ?? doc.documentElement).appendChild(st);
  }
  const nav = doc.createElement('nav');
  nav.className = `lsn-stages${compact ? ' compact' : ''}`;
  nav.setAttribute('aria-label', 'Mission steps');
  const links = [];
  let group = null;
  STAGES.forEach((s, i) => {
    if (s.group !== group) {
      group = s.group;
      const g = doc.createElement('span'); g.className = 'grp'; g.textContent = s.group; g.setAttribute('aria-hidden', 'true'); nav.appendChild(g);
    } else if (i) { const sep = doc.createElement('span'); sep.className = 'sep'; sep.textContent = '›'; sep.setAttribute('aria-hidden', 'true'); nav.appendChild(sep); }
    const a = doc.createElement('a');
    a.dataset.stage = s.id;
    const showLabel = !compact || s.id === current;   // compact: numbers only, but the current step keeps its name
    a.innerHTML = `<span class="n">${s.n}</span>${showLabel ? s.label : ''}`;
    if (!showLabel) a.setAttribute('aria-label', `Step ${s.n}: ${s.label}`);
    if (s.id === current) a.setAttribute('aria-current', 'step');
    const refresh = () => {
      // Execute while the plan has moved on from the frozen mission: Finalise first, so the new plan is what flies
      const stale = s.id === 'execute' && s.id !== current && current !== 'finalise' && !locked() && planChanged();
      a.href = stageUrl(stale ? 'finalise' : s.id, getMission());
      const lock = s.id === 'execute' && s.id !== current && locked();
      a.toggleAttribute('data-locked', lock);
      a.title = lock ? `${s.title}. Not finalised yet: finalise the mission first (step 2).` : stale ? `${s.title}. The plan has changed since it was frozen: this opens Finalise to freeze the new plan first.` : s.title;
    };
    refresh();
    a.addEventListener('pointerenter', refresh);
    a.addEventListener('focus', refresh);
    a.addEventListener('click', refresh);
    links.push(refresh);
    nav.appendChild(a);
  });
  const listen = (fn) => { try { doc.defaultView?.addEventListener('lsn-mission', fn); doc.defaultView?.addEventListener('storage', fn); } catch { /* no window */ } };
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
