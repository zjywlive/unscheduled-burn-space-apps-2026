// The frozen mission configuration: what step 2 (Finalise, finalise.html) hands to step 3 (Execute, lander.html).
// Everything is decided while planning (the Map); finalising copies the decisions into one record, stamps it with
// an id made from its content, and stores it. The execution page flies only this record: it never reads the
// planning state, so later changes on the Map do not move a mission that is already finalised. The Map and the
// Finalise page compare the planning state with it and say when it has changed since ("finalise again").
// Pure helpers (browser and Node); the storage is localStorage unless one is passed.
//
// Config = { v: 1, id, frozenMs,
//   site: { id | null, name, latDeg, lonDeg },
//   landing: { requestedMs, windowStartMs | null, windowEndMs | null, earth: bool },   Sun (and Earth) above the skyline
//   stayDays, vehicle (lander/vehicle.js fields, cleaned),
//   route: route3d.js payload | null,  departMs | null,
//   checks: [{ id, label, value, ok, level: 'go' | 'warn' | 'no-go', note }] }

export const CONFIG_KEY = 'lsn-config';
export const CONFIG_VERSION = 1;

const store = (s) => s ?? (typeof localStorage !== 'undefined' ? localStorage : null);

// FNV-1a over a string → 8 hex digits (a short, stable name for a configuration; not a security hash)
export function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// the content that names a configuration: the decisions, not when they were frozen or the check texts
export function configId(c) {
  const r = c.route;
  const route = r ? { label: r.label, lengthKm: r.lengthKm, departMs: r.departMs ?? null, n: r.pts?.length ?? 0, a: r.pts?.[0]?.slice(0, 2), b: r.pts?.[r.pts.length - 1]?.slice(0, 2) } : null;
  return hash32(JSON.stringify([c.site?.id ?? null, c.site?.latDeg, c.site?.lonDeg, c.landing?.requestedMs, c.stayDays, c.vehicle ?? null, route, c.departMs ?? null])).slice(0, 6);
}

// Builds the record from the planning state. mission: mission-flow.js mission; vehicle: cleaned vehicle;
// route: the route3d payload chosen on the Map (or null); window: { startMs, endMs, earth } around the landing.
export function buildConfig({ mission, vehicle, route = null, window = null, checks = [], nowMs = Date.now() }) {
  if (!mission || !Number.isFinite(mission.latDeg) || !Number.isFinite(mission.lonDeg)) throw new Error('No site chosen: pick one on the Map first.');
  if (!Number.isFinite(mission.landingMs)) throw new Error('No landing time set: set one on the Map first.');
  const c = {
    v: CONFIG_VERSION, id: '', frozenMs: nowMs,
    site: { id: mission.siteId ?? null, name: mission.siteName ?? `${mission.latDeg.toFixed(3)}°, ${mission.lonDeg.toFixed(3)}°`, latDeg: mission.latDeg, lonDeg: mission.lonDeg },
    landing: { requestedMs: mission.landingMs, windowStartMs: window?.startMs ?? null, windowEndMs: window?.endMs ?? null, earth: window ? !!window.earth : null },
    stayDays: Number.isFinite(mission.stayDays) ? mission.stayDays : 14,
    vehicle: vehicle ?? null,
    route: route ?? null,
    departMs: route?.departMs ?? null,
    checks,
  };
  c.id = configId(c);
  return c;
}

export function readConfig(storage) {
  try {
    const c = JSON.parse(store(storage)?.getItem(CONFIG_KEY) ?? 'null');
    return c && c.v === CONFIG_VERSION && c.site && Number.isFinite(c.site.latDeg) && Number.isFinite(c.landing?.requestedMs) ? c : null;
  } catch { return null; }
}

export function writeConfig(c, storage) {
  store(storage)?.setItem(CONFIG_KEY, JSON.stringify(c));   // throws when storage is full or blocked: the page says so
  try { if (!storage && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('lsn-mission', { detail: null })); } catch { /* no window */ }
  return c;
}

export function clearConfig(storage) {
  try { store(storage)?.removeItem(CONFIG_KEY); } catch { /* blocked */ }
}

// What changed on the Map since the configuration was frozen: [] when nothing did. mission: the planning
// mission; route: the route3d payload on the Map now (undefined when unknown, then the route is not compared);
// vehicle: the planning vehicle (undefined: not compared).
export function changesSince(c, mission, { route, vehicle } = {}) {
  if (!c) return [];
  const out = [];
  if (!mission) return out;
  const near = (a, b, eps) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;
  if ((c.site.id ?? null) !== (mission.siteId ?? null) || !near(c.site.latDeg, mission.latDeg, 1e-6) || !near(c.site.lonDeg, mission.lonDeg, 1e-6)) out.push('site');
  if (!near(c.landing.requestedMs, mission.landingMs, 30e3)) out.push('landing time');
  if (Number.isFinite(mission.stayDays) && mission.stayDays !== c.stayDays) out.push('stay');
  if (vehicle !== undefined && JSON.stringify(vehicle ?? null) !== JSON.stringify(c.vehicle ?? null)) out.push('vehicle');
  if (route !== undefined) {
    const a = route ? configId({ route }) : null, b = c.route ? configId({ route: c.route }) : null;
    if (a !== b) out.push('rover route');
  }
  return out;
}

// The window around tMs in which clear(t) holds (stepping stepMs out each way, at most maxMs): { startMs, endMs }
// or null when clear(tMs) does not hold. A window that reaches maxMs is open-ended on that side (its edge is the cap).
export function windowAround(tMs, clear, { stepMs = 3600e3, maxMs = 20 * 86400e3 } = {}) {
  if (!clear(tMs)) return null;
  let a = tMs, b = tMs;
  while (tMs - a < maxMs && clear(a - stepMs)) a -= stepMs;
  while (b - tMs < maxMs && clear(b + stepMs)) b += stepMs;
  return { startMs: a, endMs: b };
}

// Overall verdict from the go / no-go rows: 'no-go' if any row is, else 'warn' if any row is, else 'go'.
export function verdictOf(checks) {
  if (checks.some((c) => c.level === 'no-go')) return 'no-go';
  if (checks.some((c) => c.level === 'warn')) return 'warn';
  return 'go';
}

// The rover route as the Finalise page and the execution page show it (route3d.js payload v1). pts[i] =
// [lat, lon, km, tMs, soc, flags, …], flags 1 lit, 2 Earth, 4 station. belongs: it starts within 30 km of the site.
export function routeSummary(p, site) {
  if (!p?.pts?.length) return null;
  const R = 1737.4, r = Math.PI / 180;
  const km = (a, b) => 2 * R * Math.asin(Math.min(1, Math.sqrt(Math.sin((b[0] - a[0]) * r / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2)));
  const socs = p.pts.map((q) => q[4]).filter(Number.isFinite);
  const share = (bit) => p.pts.filter((q) => q[5] & bit).length / p.pts.length;
  const startKm = site ? km([site.latDeg, site.lonDeg], p.pts[0]) : 0;
  return {
    label: p.label ?? 'Route', lengthKm: p.lengthKm ?? p.pts[p.pts.length - 1][2],
    departMs: Number.isFinite(p.departMs) ? p.departMs : null, arriveMs: Number.isFinite(p.arriveMs) ? p.arriveMs : null,
    minSoc: socs.length ? Math.min(...socs) : null, reserve: p.reserve ?? 0.2,
    litShare: share(1), earthShare: share(2), stationShare: share(4),
    havens: p.havens?.length ?? 0, emptyAt: p.emptyAt ?? null, startKm, belongs: startKm <= 30,
  };
}

// The go / no-go rows of the Finalise page from what it computed. Levels: 'go', 'warn' (flown anyway, said
// so), 'no-go' (a real problem; freezing is still allowed except without a site or a landing time, which
// buildConfig refuses). Inputs: site { latDeg, polar, resKm }, sky at the landing { sun, earth } clearances in
// degrees (null: outside the ephemeris), window (windowAround) | null, plan (lander/mission.js; null when it failed,
// planError then), checks (lander landingChecks rows) | null, route (routeSummary) | null.
export function goNoGoRows({ site, sky, window, plan, planError = null, checks = null, route = null }) {
  const rows = [];
  const add = (id, label, value, level, note = '') => rows.push({ id, label, value, level, ok: level === 'go', note });
  const h = (ms) => `${Math.round(ms / 3600e3)} h`;
  add('terrain', 'Terrain at the site', site.polar ? `LOLA polar, ${Math.round(site.resKm * 1000)} m and finer near the listed sites` : `global LOLA ${Math.round(site.resKm * 1000)} m, skyline computed`,
    site.polar ? 'go' : 'warn', site.polar ? '' : 'Lander-scale hazards (rocks, small craters, slopes under ~1 km) are not resolved here; the rover planner needs the polar data south of 80°S.');
  if (!sky) add('sky', 'Sun and Earth at landing', 'outside the ephemeris (Nov 2026 – Dec 2028)', 'no-go');
  else {
    const sun = sky.sun > 0, earth = sky.earth > 0;
    add('sky', 'Sun and Earth at landing', `${sun ? 'Sun up' : 'Sun down'} (${sky.sun.toFixed(1)}°) · ${earth ? 'Earth up' : 'no Earth'} (${sky.earth.toFixed(1)}°) over the skyline`,
      sun && earth ? 'go' : sun ? 'warn' : 'no-go', sun && !earth ? 'No direct link to Earth at touchdown: a relay is needed.' : !sun ? 'Touchdown in the dark: no solar power and no lit terrain for the hazard camera.' : '');
  }
  add('window', 'Landing window', window ? `${h(window.endMs - window.startMs)} with the bodies up around the landing` : 'none: the bodies are not both up at the landing time', window && window.endMs - window.startMs >= 6 * 3600e3 ? 'go' : 'warn',
    window ? 'A slip inside the window keeps the same lighting; outside it, plan again.' : '');
  if (!plan) add('dv', 'Trajectory and Δv', planError ?? 'not planned', 'no-go');
  else {
    const m = plan.budget.marginMs;
    add('dv', 'Δv margin (lander)', `${Math.round(m)} m/s after a ${plan.budget.reserveDvMs} m/s reserve`, m >= 0 ? 'go' : 'no-go', m >= 0 ? '' : 'Not enough propellant: change the vehicle (more propellant, higher Isp, lighter) or the site.');
  }
  if (checks) {
    const bad = checks.filter((c) => !c.ok);
    add('landing', 'Landing checks', bad.length ? `${checks.length - bad.length} of ${checks.length} pass` : `all ${checks.length} pass`, bad.length ? 'warn' : 'go', bad.map((c) => `${c.label}: ${c.value} (limit ${c.limit})`).join('; '));
  }
  if (!route) add('route', 'Rover route', 'none planned', 'warn', 'Surface operations will keep the lander at the site. Plan a route on the Map (route card) to drive it.');
  else if (!route.belongs) add('route', 'Rover route', `starts ${route.startKm.toFixed(0)} km from the site`, 'warn', 'This route was planned for another site and is left out. Plan one from this site on the Map.');
  else {
    add('route', 'Rover route', `${route.label}, ${route.lengthKm.toFixed(1)} km${route.departMs ? '' : ', no departure time'}`, route.departMs ? 'go' : 'warn', route.departMs ? '' : 'Set the departure time in the route card (the drive is simulated from it).');
    if (route.minSoc !== null) add('battery', 'Rover battery', route.emptyAt ? `runs out at km ${route.emptyAt.km.toFixed(1)}` : `lowest ${Math.round(route.minSoc * 100)} %`, route.emptyAt || route.minSoc < route.reserve ? 'no-go' : 'go', route.emptyAt ? 'Pick another departure time or route on the Map.' : '');
    add('comms', 'Rover comms', `Earth in view on ${Math.round(route.earthShare * 100)} % of the drive${route.stationShare ? `, station on ${Math.round(route.stationShare * 100)} %` : ''}`, route.earthShare >= 0.5 || route.stationShare >= 0.5 ? 'go' : 'warn');
  }
  return rows;
}

// Where the execution page's lander touched down for a configuration (the nominal descent, or the contingency
// flown): { configId, landed: { latDeg, lonDeg, tMs, missM, source } | null }. The globe draws the lander there in
// surface operations. Kept apart from the planning mission, which execution never changes.
export const FLOWN_KEY = 'lsn-flown';
export function writeFlown(configId, landed, storage) {
  try { store(storage)?.setItem(FLOWN_KEY, JSON.stringify({ configId, landed: landed ?? null })); } catch { /* blocked */ }
}
export function readFlown(configId, storage) {
  try { const f = JSON.parse(store(storage)?.getItem(FLOWN_KEY) ?? 'null'); return f && f.configId === configId ? f.landed ?? null : null; } catch { return null; }
}
