// Entry of demo/lander.html (bundled by tools/build-lander.mjs). Reads the inlined JSON data, plans the mission,
// builds the three linked scenes and runs the timeline. Deep link: lander.html?site=<id | lat,lon>&t=<ISO time>.
// Step 2 of the mission flow (mission-flow.js): without URL parameters it starts from the stored mission, it
// stores the site and landing time it plans, and after touchdown it links on to the rover route (step 3).
import { createEphemeris } from '../ephemeris.js';
import { createDem, skylineFor, TERRAIN_MAX_LAT } from '../terrain.js';
import { hasData, readData, loadData } from '../data-loader.js';
import { planMission } from './mission.js';
import { powerTimeline } from './power-timeline.js';
import { buildBranches } from './branches.js';
import { pickLandingTime, landingChecks, skyAt } from './landing.js';
import { loadSiteTerrain } from './terrain-local.js';
import { cleanVehicle, VEHICLE_DEFAULTS } from './vehicle.js';
import { three, bindControls, createLabels } from './view-common.js';
import { buildEarthScene } from './view-earth.js';
import { buildMoonScene } from './view-moon.js';
import { buildSurfaceScene } from './view-surface.js';
import { createTimeline, renderHud, renderPlan, renderBranches, renderLanding, renderVehicle } from './ui.js';
import { readMission, writeMission, stageUrl, stageBar } from '../mission-flow.js';
import { createHiresSet } from '../hires.js';

const $ = (s) => document.querySelector(s);
const json = (id) => JSON.parse(document.getElementById(id)?.textContent ?? 'null');
const DEFAULT_SITE = 'shackleton';
const DEFAULT_FROM = Date.parse('2027-01-01T00:00:00Z');
const PLAYBACK_S = 150;   // the whole timeline in 150 s at 1×

// Where the page starts: URL parameters first (site id or "lat,lon", t), then the stored mission, then the
// default site with a lit landing window. A stored point south of 80°S that is not a listed site becomes a
// custom site. A stored landing time is used only with the stored site and inside the ephemeris.
export function startingPoint(q, mission, sites, eph) {
  const byId = (id) => sites.find((s) => s.id === id);
  const custom = (latDeg, lonDeg, name) => (latDeg <= TERRAIN_MAX_LAT ? { id: 'custom', name: name ?? `${latDeg.toFixed(2)}°, ${lonDeg.toFixed(2)}°`, latDeg, lonDeg } : null);
  const inEph = (t) => Number.isFinite(t) && t > eph.startMs + 10 * 86400e3 && t < eph.endMs - 86400e3;
  const qs = q.get('site');
  if (qs || q.get('t')) {
    const ll = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(qs ?? '');
    const site = byId(qs) ?? (ll ? custom(Number(ll[1]), Number(ll[2])) : null) ?? byId(DEFAULT_SITE) ?? sites[0];
    const t = Date.parse(q.get('t') ?? '');
    return { site, landingMs: inEph(t) ? t : null, from: 'url' };
  }
  if (mission) {
    const site = byId(mission.siteId) ?? custom(mission.latDeg, mission.lonDeg, mission.siteName);
    if (site) return { site, landingMs: inEph(mission.landingMs) ? mission.landingMs : null, from: 'mission' };
  }
  return { site: byId(DEFAULT_SITE) ?? sites[0], landingMs: null, from: 'default' };
}

export function boot() {
  const T = three();
  const status = (msg) => { const el = $('#status'); el.textContent = msg || ''; el.hidden = !msg; };
  if (!T) { status('three.js did not load (vendor/three.classic.js).'); return; }
  const eph = createEphemeris(json('data-ephemeris'));
  const sites = json('data-sites').filter((s) => s.latDeg <= TERRAIN_MAX_LAT);
  const meta = json('data-terrain');
  // high-resolution patches (5/10/20 m) around the listed sites; only the selected site's pack is loaded
  const hires = createHiresSet(json('data-hires'), (name) => loadData(name, { timeoutMs: 60000 }));
  const q = new URLSearchParams(location.search);
  const start0 = startingPoint(q, readMission(), sites, eph);
  const choices = start0.site.id === 'custom' ? [start0.site, ...sites] : sites;

  const S = {
    site: start0.site,
    landingMs: start0.landingMs,
    vehicle: cleanVehicle({ ...VEHICLE_DEFAULTS }),
    dem: null, plan: null, power: null, branches: [], checks: null, active: null,
    f: 0, playing: false, speed: 1, scene: 'earth', auto: true, scenes: null, timeline: null, token: 0, terrainNote: '',
  };

  globalThis.__lander = S;   // for inspection from the console
  const canvas = $('#view');
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 1);
  bindControls(canvas, () => S.scenes?.[S.scene].controls, () => { $('#auto').classList.remove('on'); });

  // the top bar wraps on narrow screens: the panels below it start at its bottom edge (--top)
  const setTop = () => document.documentElement.style.setProperty('--top', `${Math.round($('#top').getBoundingClientRect().bottom + 12)}px`);
  if (typeof ResizeObserver === 'function') new ResizeObserver(setTop).observe($('#top'));
  window.addEventListener('resize', setTop);
  setTop();
  // narrow screens start with the details panel closed so the 3D view is visible (the handle reopens it)
  if (window.innerWidth < 760) { $('#side').classList.add('closed'); $('#side-toggle').textContent = 'Details ‹'; }
  // site picker
  $('#site').innerHTML = choices.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  $('#site').value = S.site.id;
  // the mission's steps across the pages; this page is step 2
  const stages = stageBar(document, 'landing');
  $('#stages').replaceChildren(stages);
  const roverUrl = () => stageUrl('rover', readMission());
  const next = $('#next');
  for (const ev of ['pointerenter', 'focus', 'click']) next.addEventListener(ev, () => { next.href = roverUrl(); });

  function readDem() {
    const lv = meta.dem;
    const bytes = readData('dem_480m');
    return createDem({ data: new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1), size: lv.size, kmPerPixel: lv.kmPerPixel, dnToMeters: lv.dnToMeters });
  }

  function disposeScenes() {
    if (!S.scenes) return;
    for (const sc of Object.values(S.scenes)) {
      sc.scene.traverse((o) => { o.geometry?.dispose?.(); const m = o.material; (Array.isArray(m) ? m : m ? [m] : []).forEach((x) => x.dispose?.()); });
    }
    for (const id of ['earth', 'moon', 'surface']) $(`#labels-${id}`).innerHTML = '';
  }

  function skyOkFor(mask) {
    return (site, tMs) => {
      const m = site.id === S.site.id ? mask : skylineFor(S.dem, site);
      const s = skyAt(eph, site, tMs, m);
      return !!s && s.sun.clearDeg > 0 && s.earth.clearDeg > 0;
    };
  }

  function replan({ keepTime = false } = {}) {
    const site = S.site;
    const mask = skylineFor(S.dem, site);
    if (!Number.isFinite(S.landingMs)) {
      status('Finding a landing time with the Sun and Earth both above the skyline…');
      S.landingMs = pickLandingTime(eph, site, mask, DEFAULT_FROM) ?? DEFAULT_FROM + 15 * 86400e3;
    }
    const h = S.dem.heightAt(site.latDeg, site.lonDeg);
    const plan = planMission({ eph, site, landingMs: S.landingMs, vehicle: S.vehicle, siteHeightKm: (h ?? 0) / 1000, mask });
    if (!plan.ok) { status(plan.error); return; }
    status('');
    const tKeep = keepTime && S.plan ? S.timeline.fToT(S.f) : null;
    S.plan = plan;
    S.power = powerTimeline(plan);
    S.branches = buildBranches(plan, { sites, skyOk: skyOkFor(mask) });
    S.checks = landingChecks({ eph, site, tMs: plan.times.landingMs, mask, vehicle: plan.vehicle, touchdown: plan.descent.touchdown });
    S.active = null;
    disposeScenes();
    const sky = (tMs) => skyAt(eph, site, Math.min(Math.max(tMs, eph.startMs), eph.endMs), mask);
    S.labels = { earth: createLabels($('#labels-earth')), moon: createLabels($('#labels-moon')), surface: createLabels($('#labels-surface')) };
    S.scenes = {
      earth: buildEarthScene(plan, S.labels.earth),
      moon: buildMoonScene(plan, S.labels.moon),
      surface: buildSurfaceScene(plan, S.labels.surface, { sky }),
    };
    S.scenes.moon.setDem(S.dem);
    S.timeline = createTimeline($('#timeline'), plan, { onSeek: (t) => { S.f = S.timeline.tToF(t); }, onBranch: selectBranch });
    S.timeline.setBranches(S.branches, S.active);
    S.f = tKeep ? S.timeline.tToF(tKeep) : 0;
    $('#when').value = new Date(plan.times.landingMs).toISOString().slice(0, 16);
    // the site and the requested landing time become the mission the next steps start from. Not the planned
    // touchdown: the planner moves it by up to half an orbit to an overhead pass, and storing that would move the
    // landing again on every visit (a request is a fixed point; a snapped time is not).
    writeMission({ siteId: site.id === 'custom' ? null : site.id, siteName: site.name, latDeg: site.latDeg, lonDeg: site.lonDeg, landingMs: S.landingMs });
    stages.refresh();
    next.href = roverUrl();
    $('#next-where').textContent = `${site.name} · ${new Date(plan.times.landingMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    renderPanels();
    setBranches();
    resize();
    loadTerrain(plan, ++S.token);
  }

  async function loadTerrain(plan, token) {
    S.terrainNote = 'Loading terrain…';
    try {
      const terr = await loadSiteTerrain(meta, plan.site, { hires, onProgress: (m) => status(m) });
      if (token !== S.token) return;
      status('Building the descent terrain…');
      await new Promise((r) => setTimeout(r, 30));   // let the status paint before the mesh build
      if (token !== S.token) return;
      S.terrain = terr;
      S.scenes.surface.setTerrain(terr.sample, { overlay: $('#slope').checked, fine: terr.fine, resAt: terr.resAt });
      S.terrainSample = terr.sample;
      const m = (k) => `${Math.round(k * 1000)} m`;
      const shift = S.scenes.surface.terrainInfo()?.offsetM ?? 0;
      S.terrainNote = `Descent terrain: LOLA DEM at ${terr.levelsKm.map(m).join(' / ')} around the site (finest first), with lunar curvature.`
        + (terr.hires ? ` The ${m(terr.hires.kmPerPixel)} patch covers ${Math.round(terr.hires.sizeKm)} × ${Math.round(terr.hires.sizeKm)} km around the site; the mesh uses its full resolution within ${(terr.fine?.halfM ?? 0) / 1000} km of the target and coarsens outward.` : ' No high-resolution patch here.')
        + (Math.abs(shift) >= 0.5 ? ` The terrain is shifted ${shift > 0 ? 'up' : 'down'} ${Math.abs(shift).toFixed(1)} m so the site matches the 480 m DEM height the trajectory was planned to.` : '');
      // slopes over two pixels of the finest level (10 m on a 5 m patch, 40 m on the 20 m tiles)
      S.checks = landingChecks({ eph, site: plan.site, tMs: plan.times.landingMs, mask: skylineFor(S.dem, plan.site), sample: terr.sample, stepKm: Math.max(0.01, 2 * (terr.finestKm ?? 0.06)), vehicle: plan.vehicle, touchdown: plan.descent.touchdown });
      S.scenes.surface.setSpot(S.checks.spot && S.checks.checks.find((c) => c.id === 'slope' && !c.ok) ? S.checks.spot : null);
      status('');
      renderPanels();
    } catch (e) {
      S.terrainNote = `Terrain could not be loaded (${e.message}); the descent scene shows a flat disc.`;
      status(S.terrainNote);
    }
  }

  function renderPanels() {
    const tab = document.querySelector('.tabs .on')?.dataset.tab ?? 'plan';
    const body = $('#tab-body');
    if (tab === 'plan') renderPlan(body, S.plan, S.power);
    else if (tab === 'branches') renderBranches(body, S.branches, S.active, selectBranch);
    else if (tab === 'landing') renderLanding(body, S.checks, S.plan, S.terrainNote, roverUrl());
    else if (tab === 'vehicle') renderVehicle(body, S.plan.vehicle, (v) => { S.vehicle = cleanVehicle(v); replan({ keepTime: true }); });
  }

  function setBranches() {
    S.scenes.moon.setBranches(S.branches, S.active);
    S.scenes.surface.setBranches(S.branches, S.active);
    S.timeline.setBranches(S.branches, S.active);
  }

  function selectBranch(id) {
    S.active = S.active === id ? null : id;
    setBranches();
    const b = S.branches.find((x) => x.id === S.active);
    if (b) {
      S.f = S.timeline.tToF(b.tMs);
      const ph = S.plan.phases.find((p) => p.id === b.phase);
      if (b.surfaceSamples && !b.moonTrack) setScene('surface', false);
      else if (b.moonTrack) setScene('moon', false);
      else if (ph) setScene(ph.scene, false);
    }
    if (document.querySelector('.tabs .on')?.dataset.tab === 'branches') renderPanels();
  }

  function setScene(id, user = true) {
    S.scene = id;
    if (user) { S.auto = false; $('#auto').classList.remove('on'); }
    document.querySelectorAll('#scenes button').forEach((b) => b.classList.toggle('on', b.dataset.scene === id));
    for (const k of ['earth', 'moon', 'surface']) $(`#labels-${k}`).hidden = k !== id;
  }

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    if (S.scenes) for (const sc of Object.values(S.scenes)) { sc.camera.aspect = w / h; sc.camera.updateProjectionMatrix(); }
  }
  window.addEventListener('resize', resize);

  // controls
  document.querySelectorAll('#scenes button').forEach((b) => b.addEventListener('click', () => setScene(b.dataset.scene)));
  $('#auto').addEventListener('click', () => {
    S.auto = true;
    $('#auto').classList.add('on');
    for (const sc of Object.values(S.scenes)) sc.controls.state.user = false;
  });
  $('#play').addEventListener('click', () => togglePlay());
  $('#speed').addEventListener('change', (e) => { S.speed = Number(e.target.value); });
  $('#site').addEventListener('change', (e) => { S.site = choices.find((s) => s.id === e.target.value); S.landingMs = null; replan(); });
  $('#when').addEventListener('change', (e) => { const t = Date.parse(`${e.target.value}:00Z`); if (Number.isFinite(t)) { S.landingMs = t; replan(); } });
  $('#find').addEventListener('click', () => { S.landingMs = pickLandingTime(eph, S.site, skylineFor(S.dem, S.site), (S.plan?.times.landingMs ?? DEFAULT_FROM) + 86400e3); replan(); });
  $('#slope').addEventListener('change', () => { if (S.terrain) S.scenes.surface.setTerrain(S.terrain.sample, { overlay: $('#slope').checked, fine: S.terrain.fine, resAt: S.terrain.resAt }); });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    renderPanels();
  }));
  $('#side-toggle').addEventListener('click', () => {
    const side = $('#side');
    side.classList.toggle('closed');
    $('#side-toggle').textContent = side.classList.contains('closed') ? 'Details ‹' : 'Details ›';
  });
  function togglePlay() {
    if (!S.playing && S.f >= 0.999) S.f = 0;
    S.playing = !S.playing;
    $('#play').textContent = S.playing ? 'Pause' : 'Play';
  }
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowRight') S.f = Math.min(1, S.f + 0.005);
    if (e.code === 'ArrowLeft') S.f = Math.max(0, S.f - 0.005);
  });

  // start: the 480 m DEM is a startup pack; wait for it if the script tag has not run yet
  const start = () => { S.dem = readDem(); replan(); setScene('earth', false); requestAnimationFrame(frame); };
  if (hasData('dem_480m')) start();
  else { status('Loading terrain…'); loadData('dem_480m').then(start, (e) => status(`dem_480m failed to load: ${e.message}`)); }

  let last = performance.now(), hudAt = 0, lastPhase = null;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!S.plan) return;
    if (S.playing) {
      S.f = Math.min(1, S.f + (dt * S.speed) / PLAYBACK_S);
      if (S.f >= 1) togglePlay();
    }
    const t = S.timeline.fToT(S.f);
    const st = S.plan.stateAt(t);
    if (S.auto && st.scene !== S.scene) setScene(st.scene, false);
    if (st.phase !== lastPhase) { lastPhase = st.phase; document.body.dataset.phase = st.phase; next.hidden = st.phase !== 'landed'; }
    const sc = S.scenes[S.scene];
    sc.update(st, { dt });
    renderer.render(sc.scene, sc.camera);
    S.labels[S.scene].update(sc.camera, window.innerWidth, window.innerHeight);
    S.timeline.setT(t);
    if (now - hudAt > 90) {
      hudAt = now;
      if (st.scene === 'surface') st.ground = S.scenes.surface.groundAt(st);
      renderHud($('#hud'), st, S.power.at(t), S.plan);
    }
  }
}

if (typeof document !== 'undefined' && document.getElementById('view')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
