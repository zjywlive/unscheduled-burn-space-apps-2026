// Entry of demo/lander.html (bundled by tools/build-lander.mjs). Reads the inlined JSON data, plans the mission,
// builds the three linked scenes and runs the timeline. Deep link: lander.html?site=<id>&t=<ISO time>.
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

const $ = (s) => document.querySelector(s);
const json = (id) => JSON.parse(document.getElementById(id).textContent);
const DEFAULT_SITE = 'shackleton';
const DEFAULT_FROM = Date.parse('2027-01-01T00:00:00Z');
const PLAYBACK_S = 150;   // the whole timeline in 150 s at 1×

export function boot() {
  const T = three();
  const status = (msg) => { const el = $('#status'); el.textContent = msg || ''; el.hidden = !msg; };
  if (!T) { status('three.js did not load (vendor/three.classic.js).'); return; }
  const eph = createEphemeris(json('data-ephemeris'));
  const sites = json('data-sites').filter((s) => s.latDeg <= TERRAIN_MAX_LAT);
  const meta = json('data-terrain');
  const q = new URLSearchParams(location.search);

  const S = {
    site: sites.find((s) => s.id === q.get('site')) ?? sites.find((s) => s.id === DEFAULT_SITE) ?? sites[0],
    landingMs: Date.parse(q.get('t') ?? '') || null,
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

  // site picker
  $('#site').innerHTML = sites.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  $('#site').value = S.site.id;

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
    renderPanels();
    setBranches();
    resize();
    loadTerrain(plan, ++S.token);
  }

  async function loadTerrain(plan, token) {
    S.terrainNote = 'Loading terrain…';
    try {
      const terr = await loadSiteTerrain(meta, plan.site, { onProgress: (m) => status(m) });
      if (token !== S.token) return;
      S.scenes.surface.setTerrain(terr.sample, { overlay: $('#slope').checked });
      S.terrainSample = terr.sample;
      S.terrainNote = `Descent terrain: LOLA DEM at ${terr.levelsKm.map((k) => `${Math.round(k * 1000)} m`).join(' / ')} around the site (finest first), with lunar curvature.`;
      S.checks = landingChecks({ eph, site: plan.site, tMs: plan.times.landingMs, mask: skylineFor(S.dem, plan.site), sample: terr.sample, stepKm: Math.max(0.04, terr.finestKm ?? 0.12), vehicle: plan.vehicle, touchdown: plan.descent.touchdown });
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
    else if (tab === 'landing') renderLanding(body, S.checks, S.plan, S.terrainNote);
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
  $('#site').addEventListener('change', (e) => { S.site = sites.find((s) => s.id === e.target.value); S.landingMs = null; replan(); });
  $('#when').addEventListener('change', (e) => { const t = Date.parse(`${e.target.value}:00Z`); if (Number.isFinite(t)) { S.landingMs = t; replan(); } });
  $('#find').addEventListener('click', () => { S.landingMs = pickLandingTime(eph, S.site, skylineFor(S.dem, S.site), (S.plan?.times.landingMs ?? DEFAULT_FROM) + 86400e3); replan(); });
  $('#slope').addEventListener('change', () => { if (S.terrainSample) S.scenes.surface.setTerrain(S.terrainSample, { overlay: $('#slope').checked }); });
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
    if (st.phase !== lastPhase) { lastPhase = st.phase; document.body.dataset.phase = st.phase; }
    const sc = S.scenes[S.scene];
    sc.update(st, { dt });
    renderer.render(sc.scene, sc.camera);
    S.labels[S.scene].update(sc.camera, window.innerWidth, window.innerHeight);
    S.timeline.setT(t);
    if (now - hudAt > 90) { hudAt = now; renderHud($('#hud'), st, S.power.at(t), S.plan); }
  }
}

if (typeof document !== 'undefined' && document.getElementById('view')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
