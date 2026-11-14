// Entry of demo/lander.html (bundled by tools/build-lander.mjs). Reads the inlined JSON data, plans the mission,
// builds the three linked scenes and runs the timeline. Deep link: lander.html?site=<id | lat,lon>&t=<ISO time>.
// Step 1 of the mission flow (mission-flow.js): without URL parameters it starts from the stored mission, it
// stores the site and landing time it plans, and after touchdown it links on to the rover route (step 2).
import { createEphemeris } from '../ephemeris.js';
import { createDem, skylineFor, TERRAIN_MAX_LAT } from '../terrain.js';
import { hasData, readData, loadData } from '../data-loader.js';
import { planMission } from './mission.js';
import { powerTimeline } from './power-timeline.js';
import { buildBranches } from './branches.js';
import { pickLandingTime, landingChecks, skyAt, flownTouchdown } from './landing.js';
import { loadSiteTerrain } from './terrain-local.js';
import { cleanVehicle, VEHICLE_DEFAULTS } from './vehicle.js';
import { three, bindControls, createLabels, cameraStep, cameraKey } from './view-common.js';
import { buildEarthScene } from './view-earth.js';
import { buildMoonScene } from './view-moon.js';
import { buildSurfaceScene } from './view-surface.js';
import { createTimeline, renderHud, renderPlan, renderBranches, renderLanding, renderVehicle, playbackStep } from './ui.js';
import { readMission, writeMission, stageUrl, stageBar } from '../mission-flow.js';
import { attitudeState } from './model.js';
import { createCloseup } from './closeup.js';
import { createHiresSet } from '../hires.js';
import { bootScreen } from '../boot.js';

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
  // loading screen (boot.js, written into the page by the build): lifted after the first frame with the descent
  // terrain in, on an error, by "Show the map now", or after 15 s at the latest
  const loading = bootScreen(document);
  const lift = () => loading.done();
  setTimeout(lift, 15000);
  if (!T) { lift(); status('three.js did not load (vendor/three.classic.js).'); return; }
  loading.set(0.08, 'Reading the ephemeris and the landing sites…');
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
  const closeup = createCloseup(document);
  const closeupOn = () => closeup.el.isConnected && !$('#side').classList.contains('closed') && document.querySelector('.tabs .on')?.dataset.tab === 'vehicle';
  window.addEventListener('resize', () => { if (closeupOn()) closeup.resize(); });
  const userCamera = () => { $('#auto').classList.remove('on'); $('#cam-follow').classList.remove('on'); };
  bindControls(canvas, () => S.scenes?.[S.scene].controls, userCamera);

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
  // the mission's steps across the pages; this page is step 1
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
    if (!plan.ok) { lift(); status(plan.error); return; }
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
    // and where the craft touched down (the rover is planned from there), even before the user plays to touchdown
    writeMission({ siteId: site.id === 'custom' ? null : site.id, siteName: site.name, latDeg: site.latDeg, lonDeg: site.lonDeg, landingMs: S.landingMs, landed: flownTouchdown(plan) });
    showLanded();
    renderPanels();
    setBranches();
    resize();
    loading.set(0.5, `Loading the terrain around ${site.name}…`);
    loadTerrain(plan, ++S.token);
  }

  async function loadTerrain(plan, token) {
    S.terrainNote = 'Loading terrain…';
    try {
      let k = 0;
      const terr = await loadSiteTerrain(meta, plan.site, { hires, onProgress: (m) => { status(m); loading.set(0.55 + 0.1 * k++, m); } });
      if (token !== S.token) return;
      status('Building the descent terrain…');
      loading.set(0.88, 'Building the descent terrain mesh…');
      await new Promise((r) => setTimeout(r, 30));   // let the status paint before the mesh build
      if (token !== S.token) return;
      S.terrain = terr;
      S.scenes.surface.setTerrain(terr.sample, { fine: terr.fine, resAt: terr.resAt });
      S.scenes.surface.setStyle(S.terrStyle);
      S.terrainSample = terr.sample;
      S.liftAfterFrame = true;
      setTimeout(lift, 400);   // a background tab draws no frames; do not leave the screen up until the cap
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
      lift();
    }
  }

  function renderPanels() {
    const tab = document.querySelector('.tabs .on')?.dataset.tab ?? 'plan';
    const body = $('#tab-body');
    if (tab === 'plan') renderPlan(body, S.plan, S.power);
    else if (tab === 'branches') renderBranches(body, S.branches, S.active, selectBranch);
    else if (tab === 'landing') renderLanding(body, S.checks, S.plan, S.terrainNote, roverUrl(), S.landed);
    else if (tab === 'vehicle') {
      renderVehicle(body, S.plan.vehicle, (v) => { S.vehicle = cleanVehicle(v); replan({ keepTime: true }); });
      body.prepend(closeup.el);
      requestAnimationFrame(() => closeup.resize());
    }
  }

  function setBranches() {
    S.scenes.moon.setBranches(S.branches, S.active);
    S.scenes.surface.setBranches(S.branches, S.active);
    S.timeline.setBranches(S.branches, S.active);
  }

  // the touchdown point of what is shown as flown, in the mission and on the page
  function showLanded() {
    const m = readMission();
    const p = m?.landed ?? null;
    const ll = p ? `${Math.abs(p.latDeg).toFixed(4)}°${p.latDeg < 0 ? 'S' : 'N'} ${p.lonDeg.toFixed(4)}°E` : null;
    const via = p && p.source !== 'nominal' ? `, after the ${p.source.replace(/-/g, ' ')}` : '';
    $('#next-where').textContent = p
      ? `${S.site.name} · ${new Date(p.tMs).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${ll}${p.missM >= 1 ? ` (${Math.round(p.missM)} m from the target${via})` : ''}`
      : `${S.site.name} · no touchdown in the selected contingency`;
    S.landed = p;
    stages.refresh();
    next.href = roverUrl();
  }

  function selectBranch(id) {
    S.active = S.active === id ? null : id;
    writeMission({ landed: flownTouchdown(S.plan, S.branches.find((x) => x.id === S.active) ?? null) });
    showLanded();
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
    if (user) { S.auto = false; userCamera(); }
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
  // camera buttons (bottom left): a tap nudges, holding keeps going (stepped in the frame loop by real time);
  // any of them stops the automatic follow, "Follow craft" brings it back (as Auto camera does)
  const camAct = (action, dt) => { const c = S.scenes?.[S.scene]?.controls; if (c && cameraStep(c, action, dt)) userCamera(); };
  const stopHold = () => { S.camHold = null; };
  document.querySelectorAll('#camctl [data-cam]').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch { /* not an active pointer (synthetic event): the hold still ends on pointerup */ }
      camAct(b.dataset.cam, 0.12);
      S.camHold = { action: b.dataset.cam, after: performance.now() + 180 };
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, stopHold);
    b.addEventListener('keydown', (e) => { if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); e.stopPropagation(); camAct(b.dataset.cam, 0.12); } });
  });
  $('#cam-follow').addEventListener('click', () => $('#auto').click());
  // "Look at the lander": the close-up at the top of the Vehicle tab (opens the panel)
  const lookAtLander = () => {
    const side = $('#side');
    if (side.classList.contains('closed')) $('#side-toggle').click();
    document.querySelector('.tabs button[data-tab="vehicle"]').click();
    $('#tab-body').scrollTop = 0;
  };
  $('#cam-look').addEventListener('click', lookAtLander);
  $('#auto').addEventListener('click', () => {
    S.auto = true;
    $('#auto').classList.add('on');
    $('#cam-follow').classList.add('on');
    for (const sc of Object.values(S.scenes)) sc.controls.state.user = false;
  });
  $('#play').addEventListener('click', () => togglePlay());
  // playback: 0.5–4× of the compressed timeline, or real time (one simulated second per second)
  $('#speed').addEventListener('change', (e) => { S.speed = e.target.value === 'real' ? 'real' : Number(e.target.value); });
  $('#site').addEventListener('change', (e) => { S.site = choices.find((s) => s.id === e.target.value); S.landingMs = null; replan(); });
  $('#when').addEventListener('change', (e) => { const t = Date.parse(`${e.target.value}:00Z`); if (Number.isFinite(t)) { S.landingMs = t; replan(); } });
  $('#find').addEventListener('click', () => { S.landingMs = pickLandingTime(eph, S.site, skylineFor(S.dem, S.site), (S.plan?.times.landingMs ?? DEFAULT_FROM) + 86400e3); replan(); });
  // terrain key (descent view): colour mode, contours, legend, contour interval and scale bar
  S.terrStyle = { mode: 'plain', contours: true };
  document.querySelectorAll('#terrkey [data-tmode]').forEach((b) => b.addEventListener('click', () => {
    S.terrStyle.mode = b.dataset.tmode;
    document.querySelectorAll('#terrkey [data-tmode]').forEach((x) => x.classList.toggle('on', x === b));
    S.scenes?.surface.setStyle(S.terrStyle);
    keyAt = 0;
  }));
  $('#tk-contours').addEventListener('change', (e) => { S.terrStyle.contours = e.target.checked; S.scenes?.surface.setStyle(S.terrStyle); keyAt = 0; });
  let keyAt = 0, keyText = '';
  function renderKey(now) {
    const box = $('#terrkey');
    box.hidden = S.scene !== 'surface';
    if (box.hidden || now - keyAt < 200) return;
    keyAt = now;
    const k = S.scenes.surface.terrainKey();
    const r = k.elevRange, fmtH = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(Math.round(x))} m`;
    const lim = k.slopeLimitDeg;
    const legend = k.style.mode === 'height' && r ? { cls: 'height', lo: fmtH(r.min), mid: 'site 0', hi: fmtH(r.max), cap: 'height relative to the landing site' }
      : k.style.mode === 'slope' ? { cls: 'slope', lo: '0°', mid: `${lim}° lander limit`, hi: `> ${lim}°`, cap: 'slope over the DEM grid; red is steeper than the lander can land on' } : null;
    const res = S.terrain?.levelsKm?.length ? S.terrain.levelsKm.map((x) => `${Math.round(x * 1000)} m`).join(' / ') : '…';
    const html = `${legend ? `<div class="tk-legend ${legend.cls}"><div class="tk-bar"></div><div class="tk-ticks"><span>${legend.lo}</span><span>${legend.mid}</span><span>${legend.hi}</span></div><div class="tk-cap">${legend.cap}</div></div>` : ''}
      <div class="tk-foot"><span>${k.style.contours ? `Contours every ${k.intervalM} m, bold every ${k.majorM} m` : 'Contours off'}</span><span class="tk-scale"><i style="width:${Math.round(k.scale.px)}px"></i>${k.scale.label}</span></div>
      <div class="tk-src">LOLA DEM ${res} around the site. Plume dust is illustrative, not modelled.</div>`;
    if (html !== keyText) { keyText = html; $('#tk-body').innerHTML = html; }
  }
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
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const cam = cameraKey(e);
    if (cam) { e.preventDefault(); camAct(cam, e.repeat ? 0.05 : 0.12); }
    if (e.code === 'Digit0' || e.key === '0' || e.code === 'Home' || e.key === 'Home') $('#auto').click();
    if (e.code === 'KeyL' || e.key === 'l' || e.key === 'L') lookAtLander();
  });

  // start: the 480 m DEM is a startup pack; wait for it if the script tag has not run yet
  const start = () => {
    S.dem = readDem();
    loading.set(0.3, 'Planning the trajectory from Earth orbit to the site…');
    // a moment for the loading text to paint before the (synchronous) planning and scene build
    setTimeout(() => { replan(); setScene('earth', false); requestAnimationFrame(frame); }, loading.active ? 30 : 0);
  };
  if (hasData('dem_480m')) start();
  else { status('Loading terrain…'); loading.set(0.15, 'Loading the 480 m terrain map…'); loadData('dem_480m').then(start, (e) => { lift(); status(`dem_480m failed to load: ${e.message}`); }); }

  let last = performance.now(), hudAt = 0, lastPhase = null;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!S.plan) return;
    if (S.playing) {
      S.f = playbackStep(S.f, dt, S.speed, S.timeline, PLAYBACK_S);
      if (S.f >= 1) togglePlay();
    }
    const t = S.timeline.fToT(S.f);
    const st = S.plan.stateAt(t);
    if (S.auto && st.scene !== S.scene) setScene(st.scene, false);
    if (st.phase !== lastPhase) { lastPhase = st.phase; document.body.dataset.phase = st.phase; next.hidden = st.phase !== 'landed'; }
    const sc = S.scenes[S.scene];
    if (S.camHold && now > S.camHold.after) camAct(S.camHold.action, dt);
    const att = attitudeState(st, S.plan);
    sc.update(st, { dt, att });
    if (closeupOn()) { closeup.update(att, S.power.at(t), dt); closeup.render(); }
    renderer.render(sc.scene, sc.camera);
    if (S.liftAfterFrame) { S.liftAfterFrame = false; lift(); }
    S.labels[S.scene].update(sc.camera, window.innerWidth, window.innerHeight);
    renderKey(now);
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
