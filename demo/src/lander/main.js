// Entry of demo/lander.html (bundled by tools/build-lander.mjs): step 3 of the mission, Execute. Flies the frozen
// mission configuration (mission-config.js, written by step 2, Finalise) through the six phases of mission-flow.js
// EXEC_PHASES: launch, spaceflight, orbital manoeuvres, lunar orbit insertion, landing (with the contingency
// branches), surface operations (the rover route planned on the Map, played on the 3D globe in a frame).
// Nothing is planned here: the site, time and vehicle come from the configuration. A link with
// ?site=<id | lat,lon>&t=<ISO time> flies a rehearsal of that site instead (labelled, not a finalised mission).
import { createEphemeris } from '../ephemeris.js';
import { createDem, skylineFor, TERRAIN_MAX_LAT } from '../terrain.js';
import { hasData, readData, loadData } from '../data-loader.js';
import { planMission } from './mission.js';
import { powerTimeline } from './power-timeline.js';
import { buildBranches } from './branches.js';
import { pickLandingTime, pickLandingWindow, landingChecks, skyAt, flownTouchdown } from './landing.js';
import { loadSiteTerrain } from './terrain-local.js';
import { cleanVehicle, VEHICLE_DEFAULTS } from './vehicle.js';
import { three, bindControls, createLabels, cameraStep, cameraKey } from './view-common.js';
import { buildEarthScene } from './view-earth.js';
import { buildMoonScene } from './view-moon.js';
import { buildSurfaceScene } from './view-surface.js';
import { createTimeline, renderHud, renderPlan, renderBranches, renderLanding, renderVehicle, playbackStep, vehicleFromForm, renderExplain, renderLink, linkLine } from './ui.js';
import { explainFor, nextEvent } from './explain.js';
import { linkState, radioNote, sparkPath } from './link.js';
import { readMission, stageUrl, stageBar, EXEC_PHASES, execPhaseOf } from '../mission-flow.js';
import { readConfig, changesSince, writeFlown, routeSummary } from '../mission-config.js';
import { attitudeState } from './model.js';
import { createCloseup } from './closeup.js';
import { createSiteContexts, isPolarSite } from './globalsite.js';
import { createHiresSet } from '../hires.js';
import { bootScreen } from '../boot.js';

const $ = (s) => document.querySelector(s);
const json = (id) => JSON.parse(document.getElementById(id)?.textContent ?? 'null');
const DEFAULT_SITE = 'shackleton';
const DEFAULT_FROM = Date.parse('2027-01-01T00:00:00Z');
const PLAYBACK_S = 150;   // the whole timeline in 150 s at 1×

// What the page flies: a rehearsal from URL parameters (site id or "lat,lon", t), else the frozen configuration,
// else nothing (the page asks for a finalised mission). A point that is not a listed site becomes a custom site,
// anywhere on the Moon. A landing time outside the ephemeris is dropped (a lit window is picked).
export function startingPoint(q, config, sites, eph) {
  const byId = (id) => sites.find((s) => s.id === id);
  const custom = (latDeg, lonDeg, name) => (latDeg >= -90 && latDeg <= 90 ? { id: 'custom', name: name ?? `${latDeg.toFixed(2)}°, ${lonDeg.toFixed(2)}°`, latDeg, lonDeg } : null);
  const inEph = (t) => Number.isFinite(t) && t > eph.startMs + 10 * 86400e3 && t < eph.endMs - 86400e3;
  const qs = q.get('site');
  if (qs || q.get('t')) {
    const ll = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(qs ?? '');
    const site = byId(qs) ?? (ll ? custom(Number(ll[1]), Number(ll[2])) : null) ?? byId(DEFAULT_SITE) ?? sites[0];
    const t = Date.parse(q.get('t') ?? '');
    return { site, landingMs: inEph(t) ? t : null, from: 'url', vehicle: null };
  }
  if (config) {
    const c = config.site;
    const listed = c.id ? byId(c.id) : null;
    const site = listed ?? custom(c.latDeg, c.lonDeg, c.name);
    if (site) return { site, landingMs: inEph(config.landing?.requestedMs) ? config.landing.requestedMs : null, from: 'config', vehicle: config.vehicle ?? null };
  }
  return { site: null, landingMs: null, from: 'none', vehicle: null };
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
  const sites = json('data-sites');   // every listed site: polar ones on the polar data, others on the global terrain
  const meta = json('data-terrain');
  // high-resolution patches (5/10/20 m) around the listed sites; only the selected site's pack is loaded
  const hires = createHiresSet(json('data-hires'), (name) => loadData(name, { timeoutMs: 60000 }));
  // skyline, height and terrain per site: polar pyramid south of 80°S, global LOLA terrain elsewhere
  const siteCtx = createSiteContexts({ load: (name) => loadData(name, { timeoutMs: 90000 }), getDem: () => S.dem, manifest: json('data-hires') });
  const q = new URLSearchParams(location.search);
  const config = readConfig();
  const start0 = startingPoint(q, config, sites, eph);
  const rehearsal = start0.from === 'url';
  const cfgId = rehearsal ? `rehearsal:${start0.site.id}` : config?.id ?? null;
  if (start0.from === 'none') {
    // nothing finalised: say so, with the way back to planning (and a rehearsal to look at)
    lift();
    $('#stages').replaceChildren(stageBar(document, 'execute'));
    $('#cfg-chip').hidden = true;
    $('#back-plan').href = $('#nc-map').href = stageUrl('map', readMission());
    $('#noconfig').hidden = false;
    return;
  }

  const S = {
    site: start0.site,
    landingMs: start0.landingMs,
    vehicle: cleanVehicle(start0.vehicle ?? { ...VEHICLE_DEFAULTS }),
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
  const userCamera = () => { $('#auto').classList.remove('on'); $('#cam-follow').classList.remove('on'); pressed($('#ab-follow'), false); };
  bindControls(canvas, () => S.scenes?.[S.scene].controls, userCamera);

  // the top bar wraps on narrow screens: the panels below it start at its bottom edge (--top)
  const setTop = () => document.documentElement.style.setProperty('--top', `${Math.round($('#top').getBoundingClientRect().bottom + 12)}px`);
  if (typeof ResizeObserver === 'function') new ResizeObserver(setTop).observe($('#top'));
  window.addEventListener('resize', setTop);
  setTop();
  // narrow screens start with the details panel closed so the 3D view is visible (the handle reopens it)
  if (window.innerWidth < 760) { $('#side').classList.add('closed'); $('#side-toggle').textContent = 'Details ‹'; }
  // the mission's steps across the pages; this page is step 3. The stage bar names the configuration's site.
  const cfgMission = () => ({ siteId: S.site.id === 'custom' ? null : S.site.id, siteName: S.site.name, latDeg: S.site.latDeg, lonDeg: S.site.lonDeg, landingMs: S.landingMs });
  const stages = stageBar(document, 'execute', { getMission: cfgMission });
  $('#stages').replaceChildren(stages);
  $('#back-plan').href = stageUrl('map', readMission());
  // the frozen configuration this page flies (or the rehearsal), and whether the plan on the Map has moved since
  function renderChip() {
    const chip = $('#cfg-chip');
    const day = Number.isFinite(S.landingMs) ? new Date(S.landingMs).toISOString().slice(0, 16).replace('T', ' ') : '';
    const changed = config && !rehearsal ? changesSince(config, readMission()) : [];
    chip.classList.toggle('rehearsal', rehearsal);
    chip.innerHTML = rehearsal
      ? `<span class="id">REHEARSAL</span><b>${S.site.name}</b><span>not a finalised mission</span>`
      : `<span class="id">${config.id}</span><b>${S.site.name}</b><span>${day} UTC</span>${changed.length ? `<button type="button" class="stale">· plan changed since</button>` : ''}`;
    chip.title = rehearsal ? 'A rehearsal from the link: finalise a mission on the Map (step 2) to fly your plan.' : `Frozen configuration ${config.id}, frozen ${new Date(config.frozenMs).toISOString().slice(0, 16).replace('T', ' ')} UTC. ${changed.length ? `The plan on the Map has changed since (${changed.join(', ')}): finalise again to fly the new one.` : 'The plan on the Map is the same.'}`;
    chip.querySelector('button.stale')?.addEventListener('click', () => showStale(changed));
    if (changed.length && !staleShown) {
      staleShown = true;
      let ok = null;
      try { ok = sessionStorage.getItem(STALE_OK_KEY); } catch { /* storage blocked: ask */ }
      if (ok !== staleKey()) showStale(changed);
    }
  }
  // the plan on the Map differs from the frozen configuration: say what each is and offer Finalise. "Fly the frozen
  // mission" is remembered for this tab while neither changes (sessionStorage).
  const STALE_OK_KEY = 'lsn-stale-ok';
  let staleShown = false;
  const staleKey = () => { const m = readMission(); return `${config?.id}|${m?.siteId ?? ''}|${m?.latDeg}|${m?.lonDeg}|${m?.landingMs}|${m?.stayDays}`; };
  const utcDay = (ms) => (Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'no landing time');
  function showStale(changed) {
    const m = readMission();
    if (!m || !config) return;
    $('#st-what').textContent = changed.join(', ');
    $('#st-now').textContent = `${m.siteName ?? `${m.latDeg.toFixed(2)}°, ${m.lonDeg.toFixed(2)}°`} · ${utcDay(m.landingMs)}${Number.isFinite(m.stayDays) ? ` · ${m.stayDays} d stay` : ''}`;
    $('#st-frozen').innerHTML = `<span class="id">${config.id}</span>${config.site.name} · ${utcDay(config.landing?.requestedMs)} · ${config.stayDays} d stay`;
    $('#st-final').href = stageUrl('finalise');
    $('#stale').hidden = false;
    $('#st-final').focus();
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#stale').hidden) $('#st-keep').click(); });
  $('#st-keep')?.addEventListener('click', () => {
    $('#stale').hidden = true;
    try { sessionStorage.setItem(STALE_OK_KEY, staleKey()); } catch { /* storage blocked: it asks again next time */ }
  });
  // the action bar (in the top bar): the page's actions; the side panels keep the data
  const rover = $('#ab-rover');
  const pressed = (el, on) => el.setAttribute('aria-pressed', on ? 'true' : 'false');
  // contingency to fly: nominal or one of the branches the page draws (short names; the tab has the full cards)
  const BRANCH_SHORT = { 'engine-abort': 'Abort', 'hazard-divert': 'Divert', 'wave-off': 'Wave-off', 'engine-low': 'Low thrust', retarget: 'Retarget', 'spe-hold': 'Hold' };
  const RISKY = new Set(['engine-abort', 'wave-off', 'spe-hold', 'retarget']);
  function renderBranchBar() {
    const list = (S.branches ?? []).filter((b) => BRANCH_SHORT[b.id]);
    const opts = [{ id: null, label: 'Nominal', title: 'The planned descent, no contingency' }, ...list.map((b) => ({ id: b.id, label: BRANCH_SHORT[b.id], title: `${b.title}: ${b.decision.action.replace(/-/g, ' ')}`, risky: RISKY.has(b.id) }))];
    const seg = $('#ab-branches');
    seg.innerHTML = opts.map((o) => `<button class="ab-opt${o.risky ? ' risk' : ''}" data-b="${o.id ?? ''}" aria-pressed="${(S.active ?? null) === o.id}" title="${o.title.replace(/"/g, '&quot;')}">${o.label}</button>`).join('');
    seg.querySelectorAll('[data-b]').forEach((b) => b.addEventListener('click', () => { const id = b.dataset.b || null; if ((S.active ?? null) !== id) selectBranch(id ?? S.active); }));
    const sel = $('#ab-branch-sel');
    sel.innerHTML = opts.map((o) => `<option value="${o.id ?? ''}">${o.id ? `Fly: ${o.label}` : 'Fly: nominal'}</option>`).join('');
    sel.value = S.active ?? '';
  }
  $('#ab-branch-sel').addEventListener('change', (e) => { const id = e.target.value || null; if ((S.active ?? null) !== id) selectBranch(id ?? S.active); });
  // Save plan: the mission and the plan's figures as a JSON file
  $('#ab-save').addEventListener('click', () => {
    if (!S.plan) return;
    const p = S.plan, t = p.times, iso = (ms) => new Date(ms).toISOString();
    const out = {
      savedAt: iso(Date.now()), page: 'lander.html', configuration: rehearsal ? null : config, rehearsal,
      site: { id: p.site.id, name: p.site.name, latDeg: p.site.latDeg, lonDeg: p.site.lonDeg, heightM: Math.round(p.siteHeightKm * 1000) },
      times: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, k.endsWith('Ms') ? iso(v) : v])),
      vehicle: p.vehicle, deltaV: { phases: p.budget.phases.map((x) => ({ name: x.name, dvMs: Math.round(x.dvMs), propellantKg: Math.round(x.propellantKg), by: x.by })), marginMs: Math.round(p.budget.marginMs), reserveDvMs: p.budget.reserveDvMs },
      descent: { durationS: Math.round(p.descent.durationS), dvUsedMs: Math.round(p.descent.dvUsedMs), touchdown: p.descent.touchdown },
      landed: S.landed ?? null, flown: S.active ?? 'nominal',
      contingencies: S.branches.map((b) => ({ id: b.id, title: b.title, action: b.decision.action, reason: b.decision.reason, numbers: b.numbers })),
      landingChecks: S.checks?.checks ?? null, terrain: S.terrainNote, assumptions: 'Vehicle numbers, descent gates and decision thresholds are assumed (see the Vehicle tab and docs/LANDER.md).',
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
    a.download = `flight-log-${(p.site.id === 'custom' ? `${p.site.latDeg.toFixed(2)}_${p.site.lonDeg.toFixed(2)}` : p.site.id)}-${iso(t.landingMs).slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });

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
      const m = site.id === S.site.id ? mask : isPolarSite(site) ? skylineFor(S.dem, site) : () => 0;
      const s = skyAt(eph, site, tMs, m);
      return !!s && s.sun.clearDeg > 0 && s.earth.clearDeg > 0;
    };
  }

  // the site's skyline and height first (computed from the global terrain north of 80°S), then the plan
  async function replanAt(opts) {
    if (!isPolarSite(S.site)) status('Loading the global LOLA terrain and computing the skyline at this site…');
    try { S.ctx = await siteCtx.context(S.site); } catch (e) { S.ctx = { polar: false, mask: () => 0, heightM: 0, resKm: 7.6, label: 'none', skyline: `not computed (${e.message})` }; }
    replan(opts);
  }
  function replan({ keepTime = false } = {}) {
    const site = S.site;
    const mask = S.ctx?.mask ?? skylineFor(S.dem, site);
    if (!Number.isFinite(S.landingMs)) {
      status('Finding a landing time with the Sun and Earth both above the skyline…');
      S.landingMs = pickLandingWindow(eph, site, mask, DEFAULT_FROM)?.tMs ?? DEFAULT_FROM + 15 * 86400e3;
    }
    const h = S.ctx ? S.ctx.heightM : S.dem.heightAt(site.latDeg, site.lonDeg);
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
    // where the craft touches down (surface operations start there); the planning mission is not changed
    showLanded(flownTouchdown(plan));
    renderChip();
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
      // polar sites: the polar pyramid and the fine patches; elsewhere the global LOLA terrain around the site
      const ctx = S.ctx;
      const terr = ctx && !ctx.polar
        ? { sample: ctx.sampleXY, resAt: ctx.resAtXY, levelsKm: ctx.patch ? [ctx.resKm, 0.474] : [ctx.resKm], finestKm: ctx.resKm, bounds: null, hires: null, global: ctx.label, patch: ctx.patch,
          fine: ctx.patch ? { stepM: Math.round(ctx.resKm * 1000), halfM: Math.floor(Math.min(200 * ctx.resKm, ctx.patch.halfKm * 0.7) * 1000 / Math.round(ctx.resKm * 1000)) * Math.round(ctx.resKm * 1000) } : null }
        : await loadSiteTerrain(meta, plan.site, { hires, onProgress: (m) => { status(m); loading.set(0.55 + 0.1 * k++, m); } });
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
      S.terrainNote = terr.global
        ? (terr.patch
          ? `Descent terrain: ${terr.global} around the site (no polar data north of 80°S); the skyline is ${S.ctx.skyline}. At ${Math.round(terr.patch.kmPerPixel * 1000)} m, slopes over ~100 m are resolved; rocks and small craters are not.`
          : `Descent terrain: ${terr.global} global LOLA terrain around the site (no polar data north of 80°S); the skyline is ${S.ctx.skyline}. Lander-scale hazards (rocks, small craters, slopes under about 1 km) are not resolved at this resolution. No fine patch here: run node tools/fetch-hires.mjs --at ${plan.site.latDeg.toFixed(3)},${plan.site.lonDeg.toFixed(3)} to fetch one.`)
        : `Descent terrain: LOLA DEM at ${terr.levelsKm.map(m).join(' / ')} around the site (finest first), with lunar curvature.`
        + (terr.hires ? ` The ${m(terr.hires.kmPerPixel)} patch covers ${Math.round(terr.hires.sizeKm)} × ${Math.round(terr.hires.sizeKm)} km around the site; the mesh uses its full resolution within ${(terr.fine?.halfM ?? 0) / 1000} km of the target and coarsens outward.` : ' No high-resolution patch here.')
        + (Math.abs(shift) >= 0.5 ? ` The terrain is shifted ${shift > 0 ? 'up' : 'down'} ${Math.abs(shift).toFixed(1)} m so the site matches the 480 m DEM height the trajectory was planned to.` : '');
      // slopes over two pixels of the finest level (10 m on a 5 m patch, 40 m on the 20 m tiles)
      S.checks = landingChecks({ eph, site: plan.site, tMs: plan.times.landingMs, mask: S.ctx?.mask ?? skylineFor(S.dem, plan.site), sample: terr.sample, stepKm: Math.max(0.01, 2 * (terr.finestKm ?? 0.06)), vehicle: plan.vehicle, touchdown: plan.descent.touchdown });
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
    else if (tab === 'landing') renderLanding(body, S.checks, S.plan, S.terrainNote, null, S.landed);
    else if (tab === 'vehicle') {
      // read-only: the vehicle was frozen with the configuration (Finalise, step 2, is the last place to change it)
      renderVehicle(body, S.plan.vehicle, () => {});
      body.querySelectorAll('input, button[data-reset]').forEach((el) => { el.disabled = true; });
      const fa = body.querySelector('.form-actions');
      if (fa) fa.innerHTML = `<span class="muted">${rehearsal ? 'Rehearsal with the default vehicle.' : `Frozen in configuration ${config.id}.`} To change these numbers, go back to <a href="${stageUrl('finalise')}">Finalise</a> and freeze again.</span>`;
      const intro = body.querySelector('.note');
      if (intro) intro.innerHTML = 'All vehicle numbers are <b>assumed</b> (a generic medium robotic lander, not a real one). They are part of the frozen configuration.';
      body.prepend(closeup.el);
      requestAnimationFrame(() => closeup.resize());
    }
  }

  function setBranches() {
    S.scenes.moon.setBranches(S.branches, S.active);
    S.scenes.surface.setBranches(S.branches, S.active);
    S.timeline.setBranches(S.branches, S.active);
    renderBranchBar();
  }

  // the touchdown point of what is shown as flown: on the page, and for surface operations (mission-config.js)
  function showLanded(p) {
    const ll = p ? `${Math.abs(p.latDeg).toFixed(4)}°${p.latDeg < 0 ? 'S' : 'N'} ${p.lonDeg.toFixed(4)}°E` : null;
    const via = p && p.source !== 'nominal' ? `, after the ${p.source.replace(/-/g, ' ')}` : '';
    $('#ab-touch').textContent = p ? `Lands at ${ll}${p.missM >= 1 ? ` (${Math.round(p.missM)} m from the target${via})` : ''}` : 'No touchdown in this contingency';
    $('#ab-touch').title = p ? `${S.site.name} · touchdown ${new Date(p.tMs).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
    rover.title = `Surface operations: the rover drive planned on the Map. ${$('#ab-touch').textContent}`;
    S.landed = p;
    writeFlown(cfgId, p);
    stages.refresh();
    if (S.surface?.frame) S.surface.stale = true;
  }

  function selectBranch(id) {
    S.active = S.active === id ? null : id;
    showLanded(flownTouchdown(S.plan, S.branches.find((x) => x.id === S.active) ?? null));
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
  $('#ab-look').addEventListener('click', () => { if (closeupOn()) $('#side-toggle').click(); else lookAtLander(); });
  $('#ab-follow').addEventListener('click', () => $('#auto').click());
  $('#auto').addEventListener('click', () => {
    S.auto = true;
    $('#auto').classList.add('on');
    $('#cam-follow').classList.add('on');
    pressed($('#ab-follow'), true);
    for (const sc of Object.values(S.scenes)) sc.controls.state.user = false;
  });
  $('#play').addEventListener('click', () => togglePlay());
  // playback: 0.5–4× of the compressed timeline, or real time (one simulated second per second)
  $('#speed').addEventListener('change', (e) => { S.speed = e.target.value === 'real' ? 'real' : Number(e.target.value); });
  // the six mission phases (mission-flow.js EXEC_PHASES) over the lander's timeline: click to go to one; the one
  // being flown is marked, the ones before it are done; Surface operations opens the rover drive
  const phaseNav = $('#phases');
  phaseNav.innerHTML = EXEC_PHASES.map((p, i) => `<button type="button" data-ph="${p.id}" title="${p.label}"><span class="n">${i + 1}</span><span class="ph-l">${p.label}</span><span class="ph-s">${p.short}</span></button>`).join('');
  phaseNav.querySelectorAll('[data-ph]').forEach((b) => b.addEventListener('click', () => goPhase(b.dataset.ph)));
  let shownPhase = null;
  function markPhase(id) {
    if (id === shownPhase) return;
    shownPhase = id;
    const k = EXEC_PHASES.findIndex((p) => p.id === id);
    phaseNav.querySelectorAll('[data-ph]').forEach((b, i) => {
      b.classList.toggle('done', i < k);
      if (i === k) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
  }
  function goPhase(id) {
    if (id === 'surface') { openSurface(); return; }
    closeSurface();
    const ph = EXEC_PHASES.find((p) => p.id === id);
    const first = S.plan?.phases.find((x) => ph.from.includes(x.id));
    if (!first) return;
    S.f = S.timeline.tToF(first.startMs + 1);
    if (!S.auto) $('#auto').click();
  }
  // surface operations: the frozen route on the 3D globe (globe.html#cfg=1 in a frame), from the touchdown point
  S.surface = { frame: null, stale: false };
  function openSurface() {
    markPhase('surface');
    if (S.playing) togglePlay();
    document.body.classList.add('surface-on');
    $('#surface').hidden = false;
    const route = rehearsal ? null : config?.route ?? null;
    const sum = routeSummary(route, S.site);
    const t = (ms) => (Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—');
    const dLon = S.landed && sum ? ((((S.landed.lonDeg - route.pts[0][1]) % 360) + 540) % 360) - 180 : 0;
    const off = S.landed && sum ? Math.round(1000 * 30.32 * Math.hypot(S.landed.latDeg - route.pts[0][0], dLon * Math.cos(S.landed.latDeg * Math.PI / 180))) : null;
    $('#sf-info').textContent = sum
      ? `${sum.label} route, ${sum.lengthKm.toFixed(1)} km · departs ${t(sum.departMs)} · ${sum.arriveMs ? `arrives ${t(sum.arriveMs)}` : 'no arrival simulated'}${off !== null ? ` · touchdown ${off} m from the route start` : ''}`
      : S.landed ? `No rover route in ${rehearsal ? 'a rehearsal' : 'this configuration'}: the lander stays at ${S.site.name}.` : 'No touchdown in the contingency flown: nothing on the surface.';
    // the radio link at touchdown, from the landed state (Earth over the site's terrain skyline; radio assumed)
    const stL = S.plan?.stateAt(S.plan.times.landingMs + 1000);
    const sfLink = $('#sf-link');
    if (sfLink && stL?.pos && stL.earth && S.landed) {
      const ex = explainFor({ surfaceOps: true });
      sfLink.textContent = linkLine(linkState({ pos: stL.pos, earth: stL.earth, inView: stL.earthInView }));
      sfLink.title = `${ex.what} ${ex.why} Link at touchdown: Earth ${stL.earthInView ? 'above' : 'below'} the site's terrain skyline. ${radioNote()}`;
    } else if (sfLink) sfLink.textContent = '';
    const at = S.landed ?? S.site;
    const src = `globe.html?v=flow2#lat=${at.latDeg.toFixed(4)}&lon=${at.lonDeg.toFixed(4)}&dist=12&tilt=50&heading=0&cfg=1${rehearsal ? '&rehearsal=1' : ''}`;
    if (!S.surface.frame) {
      const f = document.createElement('iframe');
      f.title = 'Surface operations: the rover drive on the 3D Moon';
      $('#surface').prepend(f);
      S.surface.frame = f;
      f.src = src;
    } else if (S.surface.stale) { S.surface.frame.src = src; }
    S.surface.stale = false;
  }
  function closeSurface() {
    if (!document.body.classList.contains('surface-on')) return;
    document.body.classList.remove('surface-on');
    $('#surface').hidden = true;
    shownPhase = null;
  }
  rover.addEventListener('click', () => openSurface());
  $('#sf-close').addEventListener('click', () => { closeSurface(); S.f = 0.999; });
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
    if (document.body.classList.contains('surface-on')) { if (e.key === 'Escape') closeSurface(); return; }
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
    setTimeout(async () => { await replanAt(); setScene('earth', false); requestAnimationFrame(frame); }, loading.active ? 30 : 0);
  };
  if (hasData('dem_480m')) start();
  else { status('Loading terrain…'); loading.set(0.15, 'Loading the 480 m terrain map…'); loadData('dem_480m').then(start, (e) => { lift(); status(`dem_480m failed to load: ${e.message}`); }); }

  // the two info cards: closed and opened only by their own labelled handle; the choice is kept for the browser
  const CARDS_KEY = 'lsn-lander-cards';
  let cardsShut = {};
  try { cardsShut = JSON.parse(localStorage.getItem(CARDS_KEY) ?? 'null') ?? (window.innerWidth < 760 ? { 'ic-explain': true, 'ic-link': true } : {}); } catch { /* storage blocked: both open */ }
  document.querySelectorAll('#info .ic-card').forEach((card) => {
    const h = card.querySelector('.ic-h');
    const set = (shut) => { card.classList.toggle('shut', shut); h.setAttribute('aria-expanded', shut ? 'false' : 'true'); };
    set(!!cardsShut[card.id]);
    h.addEventListener('click', () => {
      const shut = !card.classList.contains('shut');
      set(shut);
      cardsShut[card.id] = shut;
      try { localStorage.setItem(CARDS_KEY, JSON.stringify(cardsShut)); } catch { /* not kept */ }
    });
  });
  // received level as shown, about ten samples a second; a jump on the timeline starts a new trace
  const linkHist = [];
  let linkF = null;
  const RADIO_NOTE = radioNote();
  function renderInfo(st) {
    renderExplain($('#ic-explain-b'), explainFor(st), nextEvent(S.plan.events, st.tMs));
    if (!st.pos || !st.earth) return;
    const link = linkState({ pos: st.pos, earth: st.earth, inView: st.earthInView });
    if (linkF === null || Math.abs(S.f - linkF) > 0.02 || S.f < linkF) linkHist.length = 0;
    if (S.f !== linkF || !linkHist.length) { linkHist.push(link.rxDbm); if (linkHist.length > 90) linkHist.shift(); }
    linkF = S.f;
    renderLink($('#ic-link-b'), link, linkHist, { note: `${RADIO_NOTE} Line of sight: ${st.scene === 'surface' ? 'the Earth against the site\'s terrain skyline' : 'the straight line to the Earth against the Moon\'s sphere'}. Range is to the nearest point of the Earth's surface.`, losBy: st.scene === 'surface' ? 'the terrain' : 'the Moon', sparkPath });
  }

  // frame time: display timestamps wobble by a few ms around the refresh interval, which shows as uneven motion when
  // the playback step follows them exactly. The step is eased towards the measured interval; a real hitch
  // (over 50 ms) is taken as it is, capped at 0.1 s.
  let last = performance.now(), hudAt = 0, lastPhase = null, dtS = 1 / 60, cursorF = -1, cursorTl = null;
  function frame(now) {
    requestAnimationFrame(frame);
    const raw = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    dtS = raw > 0.05 || raw === 0 ? raw || dtS : dtS + (raw - dtS) * 0.15;
    const dt = dtS;
    if (!S.plan || document.body.classList.contains('surface-on')) return;   // surface operations cover the view: no 3D frames
    if (S.playing) {
      S.f = playbackStep(S.f, dt, S.speed, S.timeline, PLAYBACK_S);
      if (S.f >= 1) { togglePlay(); openSurface(); return; }   // the landing is flown: on to the surface
    }
    const t = S.timeline.fToT(S.f);
    const st = S.plan.stateAt(t);
    if (S.auto && st.scene !== S.scene) setScene(st.scene, false);
    if (st.phase !== lastPhase) { lastPhase = st.phase; document.body.dataset.phase = st.phase; }
    markPhase(execPhaseOf(st.phase));
    const sc = S.scenes[S.scene];
    if (S.camHold && now > S.camHold.after) camAct(S.camHold.action, dt);
    const att = attitudeState(st, S.plan);
    sc.update(st, { dt, att });
    if (closeupOn()) { closeup.update(att, S.power.at(t), dt); closeup.render(); }
    renderer.render(sc.scene, sc.camera);
    if (S.liftAfterFrame) { S.liftAfterFrame = false; lift(); }
    S.labels[S.scene].update(sc.camera, window.innerWidth, window.innerHeight);
    renderKey(now);
    if (S.f !== cursorF || S.timeline !== cursorTl) { cursorF = S.f; cursorTl = S.timeline; S.timeline.setT(t); }
    if (now - hudAt > 90) {
      hudAt = now;
      if (st.scene === 'surface') st.ground = S.scenes.surface.groundAt(st);
      pressed($('#ab-look'), closeupOn());
      renderHud($('#hud'), st, S.power.at(t), S.plan);
      renderInfo(st);
    }
  }
}

if (typeof document !== 'undefined' && document.getElementById('view')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
