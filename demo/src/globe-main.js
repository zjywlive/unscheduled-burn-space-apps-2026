// Entry of demo/globe.html (phase 1): the whole Moon from the global terrain model, in 3D.
import { loadData } from './data-loader.js';
import { createDem, createPyramid, createTiledDem } from './terrain.js';
import { createGlobeTerrain } from './globe-terrain.js';
import { createGlobeView, cameraFromHash, cameraToHash } from './globe-view.js';
import { ROUTE3D_KEY, FLAGS, parsePayload, timeSpan, roverAt, frameRoute } from './route3d.js';
import { createRouteLayer } from './globe-route.js';
import { createHiresSet } from './hires.js';
import { stageBar, readMission } from './mission-flow.js';

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

export function startGlobe() {
  const $ = (id) => document.getElementById(id);
  const canvas = $('globe');
  const meta = readJson('data-terrain');
  const sites = readJson('data-sites') ?? [];
  // high-resolution patches around the sites (5 / 10 / 20 m), loaded as the camera comes close
  const hires = createHiresSet(readJson('data-hires'), (name) => load(name), { onLoad: () => invalidateSouth() });
  // the mission's steps (mission-flow.js): this page is step 3
  const stagesSlot = document.getElementById('stages');
  if (stagesSlot) stagesSlot.replaceChildren(stageBar(document, '3d'));
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
  const ex = $('exaggeration'), exOut = $('exaggeration-out');
  ex.addEventListener('input', () => { exOut.textContent = `${ex.value}×`; view?.setExaggeration(Number(ex.value)); });
  for (const r of document.querySelectorAll('input[name="colour"]')) r.addEventListener('change', () => view?.setColour(r.value));

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
    const showLabels = c.dist < 4000;
    for (const { s, el } of labelEls) {
      const p = showLabels ? view.project(s.latDeg, s.lonDeg) : null;
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
      await terrain.init();
      let hashTimer = 0;
      const routeMode = /(^|[#&])route=1(&|$)/.test(location.hash);
      const onCamera = (c) => { clearTimeout(hashTimer); hashTimer = setTimeout(() => history.replaceState(null, '', cameraToHash(c) + (routeMode ? '&route=1' : '')), 300); };
      // tiles over a high-resolution patch may refine to its pixel size (5 m: depth 12, 10 m: 11), elsewhere 20 m (10)
      const capDepth = (b) => { const k = hires.finestKmAt(b); return k === null ? 10 : k <= 0.0051 ? 12 : k <= 0.0101 ? 11 : 10; };
      const fromHash = cameraFromHash(location.hash);
      // opened from the stage bar without a camera: start over the mission's site
      const mission = readMission();
      const startAt = fromHash.lat === undefined && mission && !/(^|[#&])route=1/.test(location.hash) ? { lat: mission.latDeg, lon: mission.lonDeg, dist: 45, tilt: 50, heading: 0 } : fromHash;
      view = createGlobeView(canvas, terrain, { requestSouth, initial: startAt, onCamera, capDepth });
      view.onFrame(frame);
      window.__globe = { view, terrain, pyramid, hires };   // for debugging from the console
      window.addEventListener('hashchange', () => view.jumpTo(cameraFromHash(location.hash)));
      if (routeMode) startRoute(view, cameraFromHash(location.hash));
      document.body.classList.add('ready');
    } catch (e) {
      $('loading').textContent = `Could not load the terrain: ${e.message}`;
    }
  })();
}

// phase 6: the route handed over by the navigator (route3d.js payload in localStorage), with playback
function startRoute(view, camFromHash) {
  const $ = (id) => document.getElementById(id);
  let payload = null;
  try { payload = parsePayload(localStorage.getItem(ROUTE3D_KEY)); } catch { payload = null; }
  if (!payload) { $('centre-src').textContent = 'No route to show: plan one in the navigator and press "Fly along in 3D".'; return; }
  document.body.classList.add('route-mode');
  const layer = createRouteLayer(view, payload);
  window.__globe.route = { payload, layer };
  if (camFromHash.lat === undefined) view.flyTo({ ...frameRoute(payload), ms: 1500 });
  const span = timeSpan(payload);
  const fmt = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`; };
  $('rh-name').textContent = `${payload.label} route · ${payload.lengthKm.toFixed(1)} km`;
  const slider = $('rh-t'), play = $('rh-play'), speed = $('rh-speed'), follow = $('rh-follow');
  let t = span ? span[0] : null, playing = false, lastReal = 0;
  if (!span) { slider.disabled = true; play.disabled = true; }
  const colour = { ready: 0xffd23d, driving: 0xffd23d, parked: 0x8ab4f8, arrived: 0x7ee08a, empty: 0xff5252 };
  const label = { ready: 'Ready to leave', driving: 'Driving', parked: 'Parked, charging', arrived: 'Arrived', empty: 'Battery empty' };
  function show() {
    const r = span ? roverAt(payload, t) : roverAt(payload, -Infinity);
    layer.setRover(r, colour[r.state]);
    if (span) { slider.value = String(Math.round(((t - span[0]) / (span[1] - span[0])) * 1000)); $('rh-when').textContent = fmt(t); }
    const chip = (text, on, bad = false) => `<span class="${bad ? 'bad' : on ? 'on' : ''}">${text}</span>`;
    const f = r.flags ?? 0;
    $('rh-chips').innerHTML = [
      chip(label[r.state], r.state === 'driving' || r.state === 'arrived', r.state === 'empty'),
      chip(`km ${r.km.toFixed(1)}`, true),
      r.soc !== null && r.soc !== undefined ? chip(`battery ${Math.round(r.soc * 100)}%`, true, r.soc < (payload.reserve ?? 0.2)) : '',
      span ? chip(f & FLAGS.lit ? 'Sunlit' : 'In shadow', !!(f & FLAGS.lit)) : '',
      span ? chip(f & FLAGS.earth ? 'Earth in view' : 'No Earth link', !!(f & FLAGS.earth)) : '',
      chip(f & FLAGS.station ? 'Station link' : 'No station link', !!(f & FLAGS.station)),
      f & FLAGS.oneWay ? chip('One-way stretch', false, true) : '',
    ].join('');
    if (follow.checked) {
      const nxt = payload.pts[Math.min(payload.pts.length - 1, r.i + 1)], cur = payload.pts[r.i];
      const heading = Math.atan2(Math.sin((nxt[1] - cur[1]) * Math.PI / 180) * Math.cos(nxt[0] * Math.PI / 180),
        Math.cos(cur[0] * Math.PI / 180) * Math.sin(nxt[0] * Math.PI / 180) - Math.sin(cur[0] * Math.PI / 180) * Math.cos(nxt[0] * Math.PI / 180) * Math.cos((nxt[1] - cur[1]) * Math.PI / 180)) * 180 / Math.PI;
      const c = view.camera;
      view.jumpTo({ lat: r.latDeg, lon: r.lonDeg, heading: Number.isFinite(heading) && (nxt !== cur) ? (heading + 360) % 360 : c.heading, dist: Math.min(c.dist, 12), tilt: Math.max(c.tilt, 55) });
    }
  }
  slider.addEventListener('input', () => { if (!span) return; t = span[0] + (Number(slider.value) / 1000) * (span[1] - span[0]); show(); });
  play.addEventListener('click', () => { if (!span) return; if (t >= span[1]) t = span[0]; playing = !playing; play.textContent = playing ? '❚❚' : '▶'; play.setAttribute('aria-label', playing ? 'Pause' : 'Play'); lastReal = performance.now(); });
  follow.addEventListener('change', show);
  let stamp = '';
  view.onFrame(() => {
    const p = window.__globe?.pyramid;
    const s = `${window.__globe?.terrain?.version ?? 0}:${p?.version ?? 0}`;
    layer.frame(s);
    if (s !== stamp) { stamp = s; view.redraw(); }
    if (playing && span) {
      const now = performance.now(), dt = (now - lastReal) / 1000; lastReal = now;
      t = Math.min(span[1], t + dt * Number(speed.value) * 3600e3);
      if (t >= span[1]) { playing = false; play.textContent = '▶'; }
      show();
    }
  });
  show();
}

startGlobe();
