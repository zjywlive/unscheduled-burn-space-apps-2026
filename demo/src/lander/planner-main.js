// Entry of demo/planner.html (bundled by tools/build-lander.mjs): "Where to land", the Map's region level.
// The Map (index.html) opens it full-screen in a frame when the user goes from the whole Moon to a region, or
// presses Where to land; it also opens on its own. planner.html?at=<lat,lon>&t=<ISO UTC>: propose that point
// (else the mission's site). "Use this site" writes the site and its first lit landing time into the mission
// (mission-flow.js) and tells the Map (postMessage { type: 'lsn-site' }); on its own page it opens the Map there.
// Closing tells the Map ({ type: 'lsn-close' }) or opens the Map.
import { createEphemeris } from '../ephemeris.js';
import { createDem } from '../terrain.js';
import { hasData, readData, loadData } from '../data-loader.js';
import { cleanVehicle, VEHICLE_DEFAULTS } from './vehicle.js';
import { createPlanner, parseLatLon } from './planner.js';
import { createSiteContexts } from './globalsite.js';
import { createHiresSet } from '../hires.js';
import { readMission, writeMission, stageUrl } from '../mission-flow.js';
import { bootScreen } from '../boot.js';

const json = (id) => JSON.parse(document.getElementById(id)?.textContent ?? 'null');
const DEFAULT_FROM = Date.parse('2027-01-01T00:00:00Z');

export function boot() {
  const loading = bootScreen(document);
  setTimeout(() => loading.done(), 15000);
  const framed = window.parent && window.parent !== window;
  const tell = (msg) => { try { window.parent.postMessage(msg, '*'); } catch { /* no parent */ } };
  const eph = createEphemeris(json('data-ephemeris'));
  const sites = json('data-sites');
  const meta = json('data-terrain');
  const hires = createHiresSet(json('data-hires'), (name) => loadData(name, { timeoutMs: 60000 }));
  let dem = null;
  const siteCtx = createSiteContexts({ load: (name) => loadData(name, { timeoutMs: 90000 }), getDem: () => dem, manifest: json('data-hires') });
  const q = new URLSearchParams(location.search);
  const at = parseLatLon(q.get('at') ?? '');
  const mission = readMission();
  const tq = Date.parse(q.get('t') ?? '');
  const landingMs = Number.isFinite(tq) ? tq : Number.isFinite(mission?.landingMs) ? mission.landingMs : null;
  const current = at ? { id: 'custom', name: 'Picked point', ...at } : mission ? { id: mission.siteId ?? 'custom', name: mission.siteName, latDeg: mission.latDeg, lonDeg: mission.lonDeg } : sites.find((s) => s.id === 'shackleton');
  const backToMap = () => { location.href = stageUrl('map', readMission()); };

  const planner = createPlanner({
    root: document.getElementById('planner'), eph, sites, meta, hires, siteCtx,
    getDem: () => dem,
    getVehicle: () => cleanVehicle(readMission()?.vehicle ?? { ...VEHICLE_DEFAULTS }),
    getFromMs: () => (Number.isFinite(landingMs) ? landingMs - 2 * 86400e3 : DEFAULT_FROM),
    getStayDays: () => readMission()?.stayDays ?? 14,
    getStayStartMs: () => landingMs ?? DEFAULT_FROM,
    getCurrent: () => current,
    labels: { land: 'Use this site', close: framed ? 'Back to the Map' : 'Open the Map', closeTitle: 'Back to the Map (Esc)' },
    onLand: ({ site, landingMs: tMs }) => {
      const listed = sites.find((s) => s.id === site.id);
      const m = writeMission({ siteId: listed ? listed.id : null, siteName: listed ? listed.name : site.name, latDeg: site.latDeg, lonDeg: site.lonDeg, landingMs: tMs, landed: null });
      if (framed) tell({ type: 'lsn-site', mission: m }); else backToMap();
    },
    onClose: () => { if (framed) tell({ type: 'lsn-close' }); else backToMap(); },
  });
  globalThis.__planner = planner;
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && planner.isOpen) planner.close(); });
  const start = () => {
    const lv = meta.dem, bytes = readData('dem_480m');
    dem = createDem({ data: new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1), size: lv.size, kmPerPixel: lv.kmPerPixel, dnToMeters: lv.dnToMeters });
    planner.open();
    if (at) planner.setPick(at.latDeg, at.lonDeg, { center: true });
    loading.done();
  };
  loading.set(0.3, 'Loading the 480 m terrain map…');
  if (hasData('dem_480m')) start();
  else loadData('dem_480m').then(start, (e) => { loading.done(); document.getElementById('planner').textContent = `dem_480m failed to load: ${e.message}`; });
}

if (typeof document !== 'undefined' && document.getElementById('planner')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
