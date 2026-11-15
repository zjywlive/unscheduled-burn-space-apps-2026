// Entry of demo/globe.html (phase 1): the whole Moon from the global terrain model, in 3D.
import { loadData } from './data-loader.js';
import { createDem, createPyramid, createTiledDem } from './terrain.js';
import { createGlobeTerrain } from './globe-terrain.js';
import { createGlobeView, cameraFromHash, cameraToHash, toLatLon } from './globe-view.js';
import { ROUTE3D_KEY, FLAGS, parsePayload, timeSpan, roverAt, frameRoute } from './route3d.js';
import { createRouteLayer } from './globe-route.js';
import { createAttitudePanel, createMinimap } from './globe-route-hud.js';
import { createRouteProfile } from './globe-profile.js';
import { createCameraControls, CONTROLS_CSS } from './globe-controls.js';
import { createWaypointTool } from './globe-waypoints.js';
import { createMappedLayer } from './globe-mapped.js';
import { attitudeAt, bearingDeg } from './rover-attitude.js';
import { createHiresSet } from './hires.js';
import { stageBar, readMission, landedFor, stageUrl } from './mission-flow.js';
import { readConfig, readFlown } from './mission-config.js';
import { bootScreen } from './boot.js';
import { slopeColour, SLOPE_BANDS } from './slope-colours.js';
import { buildRecord, saveRecord, RECORDING_FIELDS, recordingCSV, fileName, downloadText } from './mission-save.js';

function readJson(id) {
  const el = document.getElementById(id);
  return el ? JSON.parse(el.textContent) : null;
}

const PRESETS = [
  { id: 'near', label: 'Whole Moon', lat: 8, lon: 12, dist: 6200 },
  { id: 'far', label: 'Far side', lat: 5, lon: 180, dist: 6200 },
  { id: 'south', label: 'South pole', lat: -88.6, lon: 0, dist: 520, tilt: 0 },
  { id: 'shackleton', label: 'Shackleton', lat: -89.67, lon: 129.78, dist: 55, tilt: 50, heading: 30 },
  { id: 'tycho', label: 'Tycho', lat: -43.31, lon: 348.64, dist: 260, tilt: 45 },
  { id: 'apollo11', label: 'Apollo 11', lat: 0.674, lon: 23.473, dist: 90, tilt: 35 },
];
const hashFlag = (name) => new RegExp(`(^|[#&])${name}=1(&|$)`).test(location.hash);

export function startGlobe() {
  const $ = (id) => document.getElementById(id);
  const canvas = $('globe');
  const meta = readJson('data-terrain');
  const sites = readJson('data-sites') ?? [];
  const hiresMeta = readJson('data-hires');
  const embed = hashFlag('embed');
  if (embed) document.body.classList.add('embed');
  // pick=1: the Map's whole-Moon level (in a frame on index.html): a click on the terrain picks a point and the Map
  // opens the region around it. cfg=1: the execution page's surface operations: the frozen configuration's route
  const pickMode = hashFlag('pick'), cfgMode = hashFlag('cfg');
  if (pickMode) document.body.classList.add('pick');
  if (cfgMode) document.body.classList.add('exec');
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CONTROLS_CSS }));
  // high-resolution patches around the sites (5 / 10 / 20 m), loaded as the camera comes close
  const hires = createHiresSet(hiresMeta, (name) => load(name), { onLoad: () => invalidateSouth() });
  // the mission's steps (mission-flow.js): the globe is the Map's 3D view (planning)
  const stagesSlot = document.getElementById('stages');
  if (stagesSlot) stagesSlot.replaceChildren(stageBar(document, 'map'));
  let inflight = 0;
  const counted = (p) => { inflight++; showLoading(); return p.finally(() => { inflight--; showLoading(); }); };
  const load = (name) => counted(loadData(name, { timeoutMs: 60000 }));

  // south pole: the existing polar pyramid, 480 m at start, finer levels and tiles on demand
  const pyramid = createPyramid([]);
  const southPending = new Set();
  let view = null, invalidateSouthQueued = false;
  const invalidateSouth = () => {
    if (invalidateSouthQueued) return;
    invalidateSouthQueued = true;
    requestAnimationFrame(() => { invalidateSouthQueued = false; view?.invalidate({ pole: 'S' }); });
  };
  function requestSouth(spacingKm, bounds) {
    if (spacingKm < 0.06) hires.ensure(bounds);
    if (!meta) return;
    for (const l of meta.levels ?? []) {
      if (spacingKm > l.kmPerPixel * 3 || southPending.has(l.name)) continue;
      if (!l.tiled) {
        if (pyramid.levels.some((d) => !d.tiled && d.kmPerPixel === l.kmPerPixel)) continue;
        southPending.add(l.name);
        load(l.name).then((b) => {
          pyramid.add(createDem({ data: new Int16Array(b.buffer), size: l.size, kmPerPixel: l.kmPerPixel, dnToMeters: l.dnToMeters, halfKm: l.halfKm }));
          invalidateSouth();
        }).catch(() => {});
        continue;
      }
      const level = pyramid.levels.find((d) => d.tiled && d.name === l.name);
      for (const pack of level.missing(bounds).slice(0, 12)) {
        if (southPending.has(pack)) continue;
        southPending.add(pack);
        load(pack).then((b) => { pyramid.addTile(pack, b); invalidateSouth(); }).catch(() => {}).finally(() => southPending.delete(pack));
      }
    }
  }

  const terrain = createGlobeTerrain({
    load,
    south: () => (hires.list.length ? [...pyramid.levels, ...hires.list] : pyramid.levels),
    onChange: ({ level, r, c }) => view?.invalidate({ latMin: 90 - (r + 1) * level.tileDeg, latMax: 90 - r * level.tileDeg, lonMin: c * level.tileDeg, lonMax: (c + 1) * level.tileDeg }),
  });

  // ---- UI ----
  const chips = $('presets');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.textContent = p.label;
    b.addEventListener('click', () => view?.flyTo({ lat: p.lat, lon: p.lon, dist: p.dist, tilt: p.tilt ?? 0, heading: p.heading ?? 0 }));
    chips.appendChild(b);
  }
  // the action bar's Fly to menu (the presets were a panel section; actions now sit in the bar over the globe)
  const flyBtn = $('ab-fly'), flyPop = $('presets-pop');
  const setFly = (open) => { flyPop.hidden = !open; flyBtn.setAttribute('aria-expanded', String(open)); };
  flyBtn.addEventListener('click', () => setFly(flyPop.hidden));
  flyPop.addEventListener('click', (e) => { if (e.target.closest('button')) setFly(false); });
  document.addEventListener('pointerdown', (e) => { if (!flyPop.hidden && !e.target.closest('#ab-fly-wrap')) setFly(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !flyPop.hidden) { setFly(false); flyBtn.focus(); } });
  const ex = $('exaggeration'), exOut = $('exaggeration-out');
  ex.addEventListener('input', () => { exOut.textContent = `${ex.value}×`; view?.setExaggeration(Number(ex.value)); });
  for (const r of document.querySelectorAll('input[name="colour"]')) r.addEventListener('change', () => view?.setColour(r.value));
  const contours = $('contours'), contourOut = $('contour-out');
  contours?.addEventListener('change', () => { view?.setContours(contours.checked); });

  const labels = $('labels');
  const labelEls = sites.filter((s) => Number.isFinite(s.latDeg)).map((s) => {
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'site'; el.textContent = s.name; el.title = `${s.name}: ${s.latDeg.toFixed(2)}°, ${s.lonDeg.toFixed(2)}°E`;
    el.addEventListener('click', () => view?.flyTo({ lat: s.latDeg, lon: s.lonDeg, dist: Math.min(view.camera.dist, 120), tilt: 40 }));
    labels.appendChild(el);
    return { s, el };
  });

  function showLoading() { $('loading').textContent = inflight ? `Loading terrain · ${inflight}` : ''; }

  const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  let lastPick = 0;
  canvas.addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (!view || now - lastPick < 50) return;
    lastPick = now;
    const hit = view.pick(e.clientX, e.clientY);
    if (!hit) { $('readout-pos').textContent = 'Point at the Moon'; $('readout-h').textContent = ''; $('readout-src').textContent = ''; return; }
    const [h, src] = terrain.sample(hit.latDeg, hit.lonDeg);
    const lon = hit.lonDeg > 180 ? `${fmt(360 - hit.lonDeg)}°W` : `${fmt(hit.lonDeg)}°E`;
    $('readout-pos').textContent = `${fmt(Math.abs(hit.latDeg))}°${hit.latDeg < 0 ? 'S' : 'N'}  ${lon}`;
    $('readout-h').textContent = `${h >= 0 ? '+' : '−'}${Math.abs(h / 1000).toFixed(3)} km`;
    $('readout-src').textContent = `LOLA ${src}`;
  });

  function niceLength(maxKm) {
    const p = Math.pow(10, Math.floor(Math.log10(maxKm)));
    for (const m of [5, 2, 1]) if (m * p <= maxKm) return m * p;
    return p;
  }
  function frame() {
    if (!view) return;
    const kpp = view.kmPerPx(), km = niceLength(kpp * 130);
    $('scale-bar').style.width = `${Math.round(km / kpp)}px`;
    $('scale-text').textContent = km >= 1 ? `${km} km` : `${Math.round(km * 1000)} m`;
    const c = view.camera;
    $('centre-src').textContent = `Data at centre: LOLA ${terrain.sample(c.lat, c.lon)[1]}`;
    if (contourOut) contourOut.textContent = view.contourInterval ? `every ${view.contourInterval} m` : '';
    const showLabels = c.dist < 4000;
    for (const { s, el, always } of labelEls) {
      const p = showLabels || always ? view.project(s.latDeg, s.lonDeg) : null;
      el.hidden = !p;
      if (p) el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    }
  }

  (async () => {
    try {
      if (meta) {
        const b = await load('dem_480m');
        pyramid.add(createDem({ data: new Int16Array(b.buffer), size: meta.dem.size, kmPerPixel: meta.dem.kmPerPixel, dnToMeters: meta.dem.dnToMeters }));
        for (const l of meta.levels ?? []) if (l.tiled) pyramid.add(createTiledDem(l));
      }
      const boot = bootScreen(document);
      boot.set(0.15, 'Global terrain in; building the view…');
      await terrain.init();
      let hashTimer = 0;
      const routeMode = hashFlag('route') || cfgMode;
      const keep = `${hashFlag('route') ? '&route=1' : ''}${embed ? '&embed=1' : ''}${pickMode ? '&pick=1' : ''}${cfgMode ? '&cfg=1' : ''}`;
      const onCamera = (c) => { clearTimeout(hashTimer); hashTimer = setTimeout(() => history.replaceState(null, '', cameraToHash(c) + keep), 300); };
      // tiles over a high-resolution patch may refine to its pixel size (5 m: depth 12, 10 m: 11), elsewhere 20 m (10)
      const capDepth = (b) => { const k = hires.finestKmAt(b); return k === null ? 10 : k <= 0.0051 ? 12 : k <= 0.0101 ? 11 : 10; };
      const fromHash = cameraFromHash(location.hash);
      // opened from the stage bar without a camera: start over the mission's site
      // in the execution page: the frozen configuration's site (and where it touched down), not the planning one
      // (a rehearsal flown from a link has no configuration: the camera's place only, no route)
      const cfg = cfgMode && !hashFlag('rehearsal') ? readConfig() : null;
      const mission = cfgMode ? (cfg ? { siteId: cfg.site.id, siteName: cfg.site.name, latDeg: cfg.site.latDeg, lonDeg: cfg.site.lonDeg, landingMs: cfg.landing.requestedMs, landed: readFlown(cfg.id) } : null) : readMission();
      const touch = landedFor(mission);   // where the lander came down, if it has
      const startAt = fromHash.lat === undefined && mission && !routeMode ? (touch ? { lat: touch.latDeg, lon: touch.lonDeg, dist: 12, tilt: 50, heading: 0 } : { lat: mission.latDeg, lon: mission.lonDeg, dist: 45, tilt: 50, heading: 0 }) : fromHash;
      view = createGlobeView(canvas, terrain, { requestSouth, initial: startAt, onCamera, capDepth });
      view.onFrame(frame);
      window.__globe = { view, terrain, pyramid, hires };   // for debugging from the console
      showLanding(view, mission, labels, labelEls, chips);
      // camera buttons; using them (other than zoom and tilt) leaves the route's follow mode
      const controls = embed ? null : createCameraControls(view, { onUser: (a) => { if (!['in', 'out', 'tiltUp', 'tiltDown'].includes(a)) window.__globe.route?.stopFollow?.(); } });
      window.__globe.controls = controls;
      window.addEventListener('hashchange', () => { if (!hashFlag('route') || cameraFromHash(location.hash).lat !== undefined) view.jumpTo(cameraFromHash(location.hash)); });
      if (routeMode) startRoute(view, cameraFromHash(location.hash), { embed, mission, payloadOverride: cfgMode ? cfg?.route ?? false : null });
      if (pickMode) startPick(view);
      if (!embed && !pickMode && !cfgMode) {
        window.__globe.waypoints = createWaypointTool(view, { parent: $('wp-slot'), bar: $('ab-wp'), mission, terrain, payload: window.__globe.route?.payload ?? null });
        window.__globe.mapped = createMappedLayer(view, { parent: $('mapped-slot'), bar: $('ab-mapped'), meta, hires: hiresMeta });
      }
      // the small 3D window in the navigator: reload when the navigator writes a new route
      if (embed) window.addEventListener('storage', (e) => { if (e.key === ROUTE3D_KEY) location.reload(); });
      document.body.classList.add('ready');
      // the loading screen lifts once the first view has no tiles left to build (or after 15 s)
      const bootT0 = performance.now();
      let quiet = 0;
      view.onFrame(() => {
        if (!boot.active) return;
        const st = view.stats ?? {}, total = (st.drawn ?? 0) + (st.queued ?? 0);
        const p = total ? st.drawn / total : 0;
        boot.set(0.2 + 0.8 * p, `Building the terrain · ${st.drawn ?? 0} tiles${inflight ? ` · loading ${inflight} data packs` : ''}`);
        quiet = view.idle && !inflight && st.drawn > 0 ? quiet + 1 : 0;   // quiet for a few frames in a row
        if (quiet >= 5 || performance.now() - bootT0 > 15000) boot.done();
      });
    } catch (e) {
      $('loading').textContent = `Could not load the terrain: ${e.message}`;
    }
  })();
}

// The Map's whole-Moon level: a click (not a drag) on the terrain picks the point. In the Map's frame it goes to the
// Map (postMessage { type: 'lsn-pick' }), which opens the region around it; on its own page, the region planner.
function startPick(view) {
  const framed = window.parent && window.parent !== window;
  const hint = document.createElement('div');
  hint.className = 'glass pick-hint';
  hint.innerHTML = '<b>Whole Moon</b> · drag to turn, scroll to zoom · <b>click a point</b> to look at the region around it';
  document.body.appendChild(hint);
  let down = null;
  view.canvas.addEventListener('pointerdown', (e) => { down = e.button === 0 ? [e.clientX, e.clientY] : null; });
  view.canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) { down = null; return; }
    down = null;
    const hit = view.pick(e.clientX, e.clientY);
    if (!hit) return;
    const latDeg = +hit.latDeg.toFixed(4), lonDeg = +(((hit.lonDeg % 360) + 360) % 360).toFixed(4);
    hint.innerHTML = `<b>${Math.abs(latDeg).toFixed(2)}°${latDeg < 0 ? 'S' : 'N'} ${lonDeg.toFixed(2)}°E</b> · opening the region around it…`;
    if (framed) window.parent.postMessage({ type: 'lsn-pick', latDeg, lonDeg }, '*');
    else location.href = stageUrl('region', { latDeg, lonDeg });
  });
}

// Where the craft lands: the touchdown written by the lander page (a lander on its legs), else the mission's
// planned landing site (a ring on the ground). Both carry a label that stays on screen at every zoom.
function showLanding(view, mission, labels, labelEls, chips) {
  const landed = landedFor(mission);
  const at = landed ?? (mission ? { latDeg: mission.latDeg, lonDeg: mission.lonDeg, planned: true } : null);
  if (!at) return;
  const T = view.THREE, gold = new T.MeshBasicMaterial({ color: 0xffd23d });
  const obj = new T.Group();
  if (landed) {
    const body = new T.Mesh(new T.CylinderGeometry(0.7, 0.9, 0.9, 8), gold); body.position.y = 1.35; obj.add(body);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4, leg = new T.Mesh(new T.CylinderGeometry(0.06, 0.06, 1.5, 6), gold);
      leg.position.set(Math.cos(a) * 0.95, 0.6, Math.sin(a) * 0.95); leg.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5); obj.add(leg);
    }
  }
  // a ring and a dot on the ground, drawn over the terrain so the spot reads from any angle
  const ring = new T.Mesh(new T.RingGeometry(2.2, 2.8, 48), new T.MeshBasicMaterial({ color: 0xffd23d, transparent: true, opacity: 0.9, side: T.DoubleSide, depthTest: false }));
  ring.rotation.x = -Math.PI / 2; ring.renderOrder = 6; obj.add(ring);
  const dot = new T.Mesh(new T.CircleGeometry(0.7, 24), new T.MeshBasicMaterial({ color: 0xffd23d, side: T.DoubleSide, depthTest: false }));
  dot.rotation.x = -Math.PI / 2; dot.position.y = 0.01; dot.renderOrder = 6; obj.add(dot);
  view.addObject(obj);
  view.onFrame(() => {
    const [x, y, z] = view.surface(at.latDeg, at.lonDeg, 0.002 * view.exaggeration);
    obj.position.set(x, y, z);
    obj.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), obj.position.clone().normalize());
    obj.scale.setScalar(view.kmPerPx() * 6);
    obj.visible = view.camera.dist < 3000;
  });
  const name = landed ? (landed.source && landed.source !== 'nominal' ? 'Lander (diverted)' : 'Lander') : 'Landing site';
  const el = document.createElement('button');
  el.type = 'button'; el.className = 'site site-lander'; el.textContent = name;
  el.title = `${landed ? 'Touchdown' : 'Planned landing site'} ${at.latDeg.toFixed(4)}°, ${at.lonDeg.toFixed(4)}°E`;
  el.addEventListener('click', () => view.flyTo({ lat: at.latDeg, lon: at.lonDeg, dist: 3, tilt: 55 }));
  labels.appendChild(el);
  labelEls.push({ s: { latDeg: at.latDeg, lonDeg: at.lonDeg }, el, always: true });
  const b = document.createElement('button'); b.type = 'button'; b.className = 'chip chip-lander'; b.textContent = name;
  b.addEventListener('click', () => view.flyTo({ lat: at.latDeg, lon: at.lonDeg, dist: 3, tilt: 55 }));
  chips.prepend(b);
}

// phase 6: the route handed over by the navigator (route3d.js payload in localStorage), with playback
function startRoute(view, camFromHash, { embed = false, mission = null, payloadOverride = null } = {}) {
  const $ = (id) => document.getElementById(id);
  let payload = null;
  if (payloadOverride) payload = payloadOverride;
  else if (payloadOverride === null) { try { payload = parsePayload(localStorage.getItem(ROUTE3D_KEY)); } catch { payload = null; } }
  if (!payload) { $('centre-src').textContent = payloadOverride === false ? 'The frozen configuration has no rover route: the lander stays at the site.' : 'No route to show: plan one in the navigator and press "Fly along in 3D".'; return; }
  document.body.classList.add('route-mode');
  const layer = createRouteLayer(view, payload, { roverPx: embed ? 28 : null });
  const terrain = window.__globe.terrain;
  const heightAt = (lat, lon) => terrain.heightAt(lat, lon);
  const landed = landedFor(mission);
  const ribbonColour = (q) => (q[5] & FLAGS.oneWay ? '#ff9f43' : q[4] !== null && q[4] < (payload.reserve ?? 0.2) ? '#ff5252' : !Number.isFinite(q[3]) && payload.pts.some((p) => Number.isFinite(p[3])) ? '#5a5a5a' : q[5] & FLAGS.lit ? '#f5f5f5' : '#5c73a8');
  const pts = payload.pts, total = pts[pts.length - 1][2];
  if (camFromHash.lat === undefined) view.flyTo({ ...frameRoute(payload), ms: 1500 });
  if (embed) {
    // the navigator's small 3D window: the route and the rover, nothing else; play on a loop
    let t = 0, last = performance.now(), stamp = '';
    view.onFrame(() => {
      const now = performance.now(); t = (t + (now - last) / 14000) % 1; last = now;
      const s = `${window.__globe?.terrain?.version ?? 0}:${window.__globe?.pyramid?.version ?? 0}`;
      layer.frame(s); if (s !== stamp) { stamp = s; view.redraw(); }
      const r = roverAtKm(t * total);
      layer.setRover(r, 0xffd23d, { headingDeg: headingAhead(r.km, 0.05) ?? 0, pitchDeg: 0, rollDeg: 0 });
    });
    return;
  }

  // ---- panels: attitude and minimap on the left, the route view options on the right ----
  const left = $('route-left');
  const attitude = createAttitudePanel(left);
  const minimap = createMinimap(left, payload, heightAt, { landed, site: mission ? { latDeg: mission.latDeg, lonDeg: mission.lonDeg } : null, slopeColour });
  let colourBy = 'state';
  const keyState = $('rh-key-state'), keySlope = $('rh-key-slope');
  keySlope.innerHTML = SLOPE_BANDS.map((b) => `<span><i style="background:${b.colour}"></i>${b.label}</span>`).join('') + '<span class="muted">grade along the way</span>';
  for (const r of document.querySelectorAll('input[name="rcolour"]')) r.addEventListener('change', () => {
    if (!r.checked) return;
    colourBy = r.value; layer.setColourBy(colourBy);
    keyState.hidden = colourBy === 'slope'; keySlope.hidden = colourBy !== 'slope';
    dirtyHud = true;
  });
  const opt = (id, on, enabled = true) => { const c = $(id); c.checked = on; c.disabled = !enabled; c.closest('label').classList.toggle('off', !enabled); return c; };
  const optTraps = opt('rv-traps', layer.hasTraps, layer.hasTraps), optLegs = opt('rv-legs', true, (payload.wps ?? []).length > 1);
  const optFrames = opt('rv-frames', false), optSearch = opt('rv-search', layer.hasSearch, layer.hasSearch);
  if (!layer.hasTraps) $('rv-traps').closest('label').title = 'This route has no trap cells (the plan found no dips the rover could not climb out of, or mobility limits were off).';
  if (!layer.hasSearch) optSearch.closest('label').title = 'Run the self-driving planner in the navigator to show its search here.';
  optTraps.addEventListener('change', () => layer.setVisible('traps', optTraps.checked));
  optSearch.addEventListener('change', () => layer.setVisible('search', optSearch.checked));
  optFrames.addEventListener('change', () => { layer.setVisible('frames', optFrames.checked); framesBox.hidden = !optFrames.checked; });

  // ---- where along the route: by time when the drive was simulated, else by distance ----
  const span = timeSpan(payload);
  const fmt = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`; };
  $('rh-name').textContent = `${payload.label} route · ${total.toFixed(1)} km`;
  const slider = $('rh-t'), play = $('rh-play'), speed = $('rh-speed'), follow = $('rh-follow'), skip = $('rh-skip');
  let t = span ? span[0] : null, kmPos = 0, playing = false, lastReal = performance.now();
  function roverAtKm(k) {
    let i = 0; while (i + 2 < pts.length && pts[i + 1][2] < k) i++;
    const a = pts[i], b = pts[i + 1], f = b[2] > a[2] ? Math.max(0, Math.min(1, (k - a[2]) / (b[2] - a[2]))) : 0;
    let dl = b[1] - a[1]; if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
    return { latDeg: a[0] + (b[0] - a[0]) * f, lonDeg: (a[1] + dl * f + 360) % 360, km: a[2] + (b[2] - a[2]) * f, soc: a[4], flags: f < 0.5 ? a[5] : b[5], state: k >= total ? 'arrived' : k > 0 ? 'driving' : 'ready', i };
  }
  // the bearing from the point at km k to the point lookKm further along (null at the end)
  function headingAhead(k, lookKm) {
    if (k + 1e-6 >= total) return null;
    const a = roverAtKm(k), b = roverAtKm(Math.min(total, k + lookKm));
    return Math.hypot(b.latDeg - a.latDeg, (b.lonDeg - a.lonDeg) * Math.cos(a.latDeg * Math.PI / 180)) < 1e-9 ? null : bearingDeg(a.latDeg, a.lonDeg, b.latDeg, b.lonDeg);
  }
  function tAtKm(k) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (b[2] >= k && Number.isFinite(a[3]) && Number.isFinite(b[3])) return a[3] + (b[3] - a[3]) * (b[2] > a[2] ? Math.max(0, (k - a[2]) / (b[2] - a[2])) : 0);
    }
    return span ? span[1] : null;
  }
  const roverNow = () => (span ? roverAt(payload, t) : roverAtKm(kmPos));
  function seekKm(k) { if (span) t = Math.max(span[0], Math.min(span[1], tAtKm(k))); else kmPos = Math.max(0, Math.min(total, k)); dirtyHud = true; }

  // playback speeds: pick the one that plays the driving in about 25 seconds
  const SPEEDS = [[1 / 60, '1 min/s'], [1 / 6, '10 min/s'], [1, '1 h/s'], [6, '6 h/s'], [24, '1 day/s']];
  const stopH = (payload.stops ?? []).reduce((a, st) => a + (st.toMs - st.fromMs) / 3600e3, 0);
  const driveH = span ? Math.max(0.05, (span[1] - span[0]) / 3600e3 - stopH) : total / 0.8;
  const pick = SPEEDS.reduce((best, s) => (Math.abs(Math.log(s[0] / (driveH / 25))) < Math.abs(Math.log(best[0] / (driveH / 25))) ? s : best));
  speed.innerHTML = SPEEDS.map(([v, l]) => `<option value="${v}"${v === pick[0] ? ' selected' : ''}>${l}</option>`).join('');
  if (!span) { play.title = 'No simulated drive: playing by distance at 0.8 km/h'; }

  const colour = { ready: 0xffd23d, driving: 0xffd23d, parked: 0x8ab4f8, arrived: 0x7ee08a, empty: 0xff5252 };
  const label = { ready: 'Ready to leave', driving: 'Driving', parked: 'Parked, charging', arrived: 'Arrived', empty: 'Battery empty' };
  const profile = createRouteProfile($('rh-profile'), payload, { heightAt, slopeColour, onSeek: (k) => seekKm(k) });

  // ---- the rover's heading eases towards the way ahead, so the model, the panels and the camera turn smoothly ----
  let cur = roverNow(), head = headingAhead(cur.km, 0.06) ?? 0, att = null, dirtyHud = true, lastHudHead = null;
  function updateHud() {
    const kpp = terrain.sample(cur.latDeg, cur.lonDeg)[2] ?? 0.24, baseKm = Math.max(0.01, 2 * kpp);
    att = attitudeAt(heightAt, cur.latDeg, cur.lonDeg, head, baseKm);
    layer.setRover(cur, colour[cur.state], { headingDeg: head, pitchDeg: att?.pitchDeg ?? 0, rollDeg: att?.rollDeg ?? 0 });
    attitude.update({ att, limits: payload.limits, baselineM: baseKm * 1000, stateText: label[cur.state] });
    minimap.draw({ latDeg: cur.latDeg, lonDeg: cur.lonDeg, headingDeg: head, headingUp: follow.checked, colourOf: ribbonColour, km: cur.km, colourBy });
    profile.update(cur.km);
    // the scrubber is by distance, like the profile above it, so the two line up; the time is in the corner
    const fk = total > 0 ? cur.km / total : 0;
    slider.value = String(Math.round(fk * 1000)); slider.style.setProperty('--p', `${(fk * 100).toFixed(2)}%`);
    $('rh-when').textContent = span ? fmt(t) : `${kmPos.toFixed(2)} km of ${total.toFixed(2)} km`;
    const chip = (text, on, bad = false) => `<span class="${bad ? 'bad' : on ? 'on' : ''}">${text}</span>`;
    const f = cur.flags ?? 0;
    $('rh-chips').innerHTML = [
      chip(label[cur.state], cur.state === 'driving' || cur.state === 'arrived', cur.state === 'empty'),
      chip(`km ${cur.km.toFixed(2)}`, true),
      cur.soc !== null && cur.soc !== undefined ? chip(`battery ${Math.round(cur.soc * 100)}%`, true, cur.soc < (payload.reserve ?? 0.2)) : '',
      span ? chip(f & FLAGS.lit ? 'Sunlit' : 'In shadow', !!(f & FLAGS.lit)) : '',
      span ? chip(f & FLAGS.earth ? 'Earth in view' : 'No Earth link', !!(f & FLAGS.earth)) : '',
      chip(f & FLAGS.station ? 'Station link' : 'No station link', !!(f & FLAGS.station)),
      f & FLAGS.oneWay ? chip('One-way stretch', false, true) : '',
    ].join('');
    lastHudHead = head;
    dirtyHud = false;
  }

  // ---- follow: the camera rides behind the rover; position exact, heading eased, zoom and tilt left to the user,
  // except that it tilts down towards overhead while terrain hides the rover, and back once the way is clear ----
  let followHead = null, followFrom = 0, userTilt = null, setTilt = null, clearFor = 0, lastBlocked = -1e9;
  function startFollow() {
    const c = view.camera, h = headingAhead(cur.km, 0.2) ?? head;
    followHead = h; followFrom = performance.now() + 950;
    userTilt = Math.max(c.tilt, 55); setTilt = null; clearFor = 0;
    // close enough that the rover at its real size (2.2 m) is about 25 px long
    view.flyTo({ lat: cur.latDeg, lon: cur.lonDeg, heading: h, dist: Math.min(c.dist, 0.1), tilt: Math.max(c.tilt, 60), ms: 1200 });
  }
  function stopFollow() { if (follow.checked) { follow.checked = false; dirtyHud = true; } }
  follow.addEventListener('change', () => { if (follow.checked) startFollow(); dirtyHud = true; });
  // dragging the map takes the camera back from follow mode (scrolling to zoom does not)
  let downAt = null;
  view.canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  view.canvas.addEventListener('pointermove', (e) => { if (downAt && e.buttons && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) { stopFollow(); downAt = null; } });
  view.canvas.addEventListener('pointerup', () => { downAt = null; });

  slider.addEventListener('input', () => seekKm((Number(slider.value) / 1000) * total));
  play.addEventListener('click', () => {
    const atEnd = span ? t >= span[1] : kmPos >= total;
    if (atEnd) { if (span) t = span[0]; else kmPos = 0; }
    playing = !playing; play.textContent = playing ? '❚❚' : '▶'; play.setAttribute('aria-label', playing ? 'Pause' : 'Play'); lastReal = performance.now();
  });

  // ---- labels on the 3D view: legs between waypoints (distance, time, steepest grade) and the rover's frames ----
  const labelsEl = $('labels');
  const legs = [];
  const wpIdx = (payload.wps ?? []).map((w) => {
    let best = 0, bd = Infinity;
    pts.forEach((q, i) => { const d = (q[0] - w.latDeg) ** 2 + ((q[1] - w.lonDeg) * Math.cos((w.latDeg * Math.PI) / 180)) ** 2; if (d < bd) { bd = d; best = i; } });
    return best;
  });
  const dur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
  for (let k = 0; k + 1 < wpIdx.length; k++) {
    const a = wpIdx[k], b = wpIdx[k + 1];
    if (b <= a) continue;
    const mid = pts[Math.round((a + b) / 2)], km = pts[b][2] - pts[a][2];
    const ms = Number.isFinite(pts[a][3]) && Number.isFinite(pts[b][3]) ? pts[b][3] - pts[a][3] : null;
    let steep = 0; for (let i = a; i <= b; i++) if (Number.isFinite(pts[i][6]) && Math.abs(pts[i][6]) > Math.abs(steep)) steep = pts[i][6];
    const el = document.createElement('div');
    el.className = 'leg-label';
    el.innerHTML = `<b>Leg ${k + 1}</b> ${km.toFixed(2)} km${ms !== null ? ` · ${dur(ms)}` : ''}${steep ? ` · max ${Math.abs(steep).toFixed(0)}°` : ''}`;
    labelsEl.appendChild(el);
    legs.push({ el, lat: mid[0], lon: mid[1] });
  }
  (payload.wps ?? []).forEach((w, i) => {
    const el = document.createElement('div');
    el.className = 'wp-label'; el.textContent = i === 0 ? 'Start' : i === payload.wps.length - 1 ? 'End' : `WP ${i}`;
    labelsEl.appendChild(el);
    legs.push({ el, lat: w.latDeg, lon: w.lonDeg, wp: true });
  });
  const framesBox = document.createElement('div');
  framesBox.className = 'frames-box'; framesBox.hidden = true;
  labelsEl.appendChild(framesBox);
  const frameEls = new Map();
  function placeLabels() {
    for (const L of legs) {
      const p = optLegs.checked ? view.project(L.lat, L.lon) : null;
      L.el.hidden = !p;
      if (p) L.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    }
    if (!optFrames.checked) return;
    for (const { name, p } of layer.frames()) {
      let el = frameEls.get(name);
      if (!el) { el = document.createElement('div'); el.className = 'frame-label'; el.textContent = name; framesBox.appendChild(el); frameEls.set(name, el); }
      const s = view.projectWorld(p.x, p.y, p.z);
      el.hidden = !s;
      if (s) el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`;
    }
    const px = layer.modelPx;
    let note = frameEls.get('_note');
    if (!note) { note = document.createElement('div'); note.className = 'frame-note'; framesBox.appendChild(note); frameEls.set('_note', note); }
    note.textContent = px < 50 ? `The rover is drawn at its real size (2.2 m), ${px < 1 ? 'under a pixel' : `${Math.round(px)} px`} here: zoom in to see it and its frames` : 'Rover at real size (2.2 m); frames: x forward (red), y left (green), z up (blue)';
  }

  // ---- recording the motion during playback, and saving it with the route ----
  const recBtn = $('rh-rec'), recOut = $('rh-rec-out'), recSave = $('rh-rec-save'), recCsv = $('rh-rec-csv');
  let rec = null, lastSample = null;
  // a sample every 30 s of drive time (2 m by distance), at most about 3000 over the whole drive
  const recEvery = span ? Math.max(30e3, (span[1] - span[0]) / 3000) : Math.max(0.002, total / 3000);
  recBtn.addEventListener('click', () => {
    if (rec?.on) { rec.on = false; recBtn.classList.remove('on'); recBtn.textContent = '● Record'; showRec(); return; }
    rec = { on: true, startedMs: Date.now(), fields: [...RECORDING_FIELDS], samples: [] }; lastSample = null;
    recBtn.classList.add('on'); recBtn.textContent = '■ Stop';
    if (!playing) play.click();
    showRec();
  });
  function sample() {
    if (!rec?.on || !att) return;
    const key = span ? t : kmPos;
    if (lastSample !== null && Math.abs(key - lastSample) < recEvery) return;
    lastSample = key;
    const hM = heightAt(cur.latDeg, cur.lonDeg);
    rec.samples.push([span ? Math.round(t) : null, +cur.latDeg.toFixed(6), +cur.lonDeg.toFixed(6), +cur.km.toFixed(4), Number.isFinite(hM) ? +hM.toFixed(1) : null, +att.pitchDeg.toFixed(2), +att.rollDeg.toFixed(2), +att.yawDeg.toFixed(1), cur.soc ?? null, cur.flags ?? 0]);
    if (rec.samples.length % 10 === 0) showRec();
  }
  function showRec() {
    const n = rec?.samples.length ?? 0;
    recOut.textContent = rec ? `${n} samples${rec.on ? ' · recording' : ''}` : '';
    recSave.disabled = recCsv.disabled = !n;
  }
  const record = () => buildRecord({ mission, settings: { limits: payload.limits }, summary: { routeId: payload.routeId, label: payload.label, lengthKm: payload.lengthKm, arriveMs: payload.arriveMs, socMin: Math.min(...pts.map((q) => q[4]).filter(Number.isFinite)) }, route: payload, recording: rec?.samples.length ? { startedMs: rec.startedMs, fields: rec.fields, samples: rec.samples } : null });
  recSave.addEventListener('click', () => {
    const r = record(), res = saveRecord(r);
    recOut.textContent = res.ok ? `Saved, ${r.recording?.samples.length ?? 0} samples · in the navigator's Mission file` : res.reason;
    recOut.title = r.name;
    if (res.ok) { downloadText(document, fileName(r, 'json'), JSON.stringify(r), 'application/json'); window.__globe.mapped?.refresh(); }
  });
  recCsv.addEventListener('click', () => { const r = record(); downloadText(document, fileName(r, 'motion.csv'), recordingCSV(r.recording), 'text/csv'); });
  showRec();

  // ---- keeping the rover in sight: the least clearance (km, as drawn) of the line from the camera to the top of
  // the rover's mast over the terrain; below zero, terrain hides the rover ----
  const T3 = view.THREE, sightP = new T3.Vector3();
  function sightClearance() {
    const cp = view.cameraPosition, top = new T3.Vector3(...view.surface(cur.latDeg, cur.lonDeg, layer.topKm));
    let least = Infinity;
    const N = 40;
    for (let k = 2; k < N; k++) {
      sightP.copy(top).lerp(cp, k / N);
      const { latDeg, lonDeg } = toLatLon(sightP.x, sightP.y, sightP.z);
      const ground = Math.hypot(...view.surface(latDeg, lonDeg, 0));
      least = Math.min(least, sightP.length() - ground);
    }
    return least;
  }
  // the tilt that keeps it in sight: down at 50°/s while hidden; back up towards the user's tilt at 8°/s once the
  // line has been clear by a margin for a while (and not just after it was hidden), so it does not see-saw
  function sightTilt(c, least, now, dt) {
    if (setTilt !== null && Math.abs(c.tilt - setTilt) > 0.3) userTilt = c.tilt;   // the user tilted
    if (userTilt === null) userTilt = c.tilt;
    let want = setTilt ?? c.tilt;
    const margin = 0.02 * c.dist + 0.5 * layer.topKm;
    if (least < 0) { want -= 50 * dt; clearFor = 0; lastBlocked = now; }
    else if (least > margin) { clearFor += dt; if (clearFor > 0.8 && now - lastBlocked > 2500 && want < userTilt) want = Math.min(userTilt, want + 8 * dt); }
    want = Math.max(3, Math.min(view.maxTilt(), want));
    setTilt = want;
    return want;
  }

  // ---- every frame ----
  let stamp = '', lastFrame = performance.now();
  view.onFrame(() => {
    const now = performance.now(), dt = Math.min(0.25, (now - lastFrame) / 1000); lastFrame = now;
    const p = window.__globe?.pyramid;
    const s = `${window.__globe?.terrain?.version ?? 0}:${p?.version ?? 0}`;
    layer.frame(s);
    if (s !== stamp) { stamp = s; view.redraw(); }
    if (playing) {
      const fast = skip.checked && cur.state === 'parked' ? 40 : 1;
      const rate = Number(speed.value) * fast;   // drive hours per real second
      if (span) { t = Math.min(span[1], t + dt * rate * 3600e3); if (t >= span[1]) stopPlay(); }
      else { kmPos = Math.min(total, kmPos + dt * rate * 0.8); if (kmPos >= total) stopPlay(); }
      dirtyHud = true;
    }
    cur = roverNow();
    const want = headingAhead(cur.km, 0.06);
    if (want !== null) { const d = ((want - head + 540) % 360) - 180; head = (head + d * (1 - Math.exp(-dt / 0.35)) + 360) % 360; }
    if (dirtyHud || lastHudHead === null || Math.abs(((head - lastHudHead + 540) % 360) - 180) > 0.3) updateHud();
    const least = sightClearance();
    layer.setHidden(least < 0);   // the x-ray outline while terrain hides the rover
    if (follow.checked && now >= followFrom) {
      const target = headingAhead(cur.km, Math.max(0.08, Math.min(0.6, view.kmPerPx() * 120)));
      if (followHead === null) followHead = target ?? head;
      if (target !== null) { const d = ((target - followHead + 540) % 360) - 180; followHead = (followHead + d * (1 - Math.exp(-dt / 0.9)) + 360) % 360; }
      // a zoom or tilt glide in progress keeps its own tilt; the camera still rides along
      const tilt = view.flying ? undefined : sightTilt(view.camera, least, now, dt);
      view.followTo({ lat: cur.latDeg, lon: cur.lonDeg, heading: followHead, tilt });
    }
    placeLabels();
    sample();
  });
  function stopPlay() { playing = false; play.textContent = '▶'; play.setAttribute('aria-label', 'Play'); if (rec?.on) recBtn.click(); }
  window.__globe.route = { payload, layer, stopFollow, seekKm, sightClearance, get rover() { return cur; }, get recording() { return rec; }, get tilts() { return { userTilt, setTilt }; } };
  updateHud();
}

startGlobe();
