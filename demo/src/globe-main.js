// Entry of demo/globe.html (phase 1): the whole Moon from the global terrain model, in 3D.
import { loadData } from './data-loader.js';
import { createDem, createPyramid, createTiledDem } from './terrain.js';
import { createGlobeTerrain, southFrom } from './globe-terrain.js';
import { createGlobeView, cameraFromHash, cameraToHash } from './globe-view.js';

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
    south: southFrom(pyramid),
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
      const onCamera = (c) => { clearTimeout(hashTimer); hashTimer = setTimeout(() => history.replaceState(null, '', cameraToHash(c)), 300); };
      view = createGlobeView(canvas, terrain, { requestSouth, initial: cameraFromHash(location.hash), onCamera });
      view.onFrame(frame);
      window.__globe = { view, terrain, pyramid };   // for debugging from the console
      window.addEventListener('hashchange', () => view.jumpTo(cameraFromHash(location.hash)));
      document.body.classList.add('ready');
    } catch (e) {
      $('loading').textContent = `Could not load the terrain: ${e.message}`;
    }
  })();
}

startGlobe();
