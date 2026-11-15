// The Map is the 3D Moon (mission step 1). One globe, zoomed continuously from the whole Moon down to 20 m at the
// south pole, carries everything the south-pole map shows:
//   - inside 80°S, the polar map engine (ui/mapframe.js) keeps running underneath, unseen, with its view following
//     the camera to the ground in sight; what it paints (heat modes, PSR, terrain style, contours, graticule,
//     names, sites, best cells, regions, routes and their slope colours, havens, stops, waypoints, the self-driving
//     search, station coverage, the Sun and Earth arrows) is copied into a picture draped on the terrain;
//   - outside it, the same heat modes from the ephemeris with a smooth horizon (globalheat.js), the listed sites and
//     the major named features as labels, and the terrain style (Topo = height colours, Real light = the Sun at the
//     playhead) and contours of the globe itself.
// Input goes the other way: a click or a drawing gesture on the globe is turned into the polar map's own pointer
// events at the same ground point, so its picking, snapping, hover card and drawing tools (rectangle, circle,
// polygon, route) work unchanged on the 3D surface. North of 80°S a click picks the site; drawing needs the polar
// terrain (the region statistics and the rover planner run on it).
import { createGlobeTerrain, MOON_R_KM, G2 } from '../globe-terrain.js';
import { createRouteLayer } from '../globe-route.js';
import { isGeo, geoRect, geoCircle, geoPolygon, geoOutline } from '../georegion.js';
import { createGlobeView, arcGc, onGc } from '../globe-view.js';
import { toXY, fromXY, TERRAIN_MAX_LAT } from '../terrain.js';
import { loadData } from '../data-loader.js';
import { globalGrid, globalFractions } from '../globalheat.js';
import { heatColour, readColours } from '../map/layers.js';
import { clampView } from '../map/view.js';
import { GAZETTEER } from '../lander/gazetteer.js';

const RAD = Math.PI / 180;
const POLAR_LAT = TERRAIN_MAX_LAT;      // the polar engine's data edge
const COMPOSITE_MAX = 3072;             // longest side of the draped polar picture, device px
const MAX_HALF = 320;                   // the polar map's square, km (map/view.js MAP_HALF_KM)

// The polar map's view {cx, cy, zoom} that covers a ground box (km) in a frame of the given geometry (geo of
// mapframe.js: W × H CSS px, view centre at Cx, Cy, Sref px for ±320 km at zoom 1). Pure.
export function viewCovering(box, geo) {
  const bw = Math.max(0.05, box.x1 - box.x0), bh = Math.max(0.05, box.y1 - box.y0);
  const k = Math.max(bw / geo.W, bh / geo.H);                 // km per CSS px
  const zoom = Math.min(32, Math.max(1, (2 * MAX_HALF) / (k * geo.Sref)));
  const kk = (2 * MAX_HALF) / (zoom * geo.Sref);
  // the box centred in the frame (the frame's view centre is not its middle in the big layout)
  const mx = (box.x0 + box.x1) / 2, my = (box.y0 + box.y1) / 2;
  return { cx: mx + (geo.Cx - geo.W / 2) * kk, cy: my - (geo.Cy - geo.H / 2) * kk, zoom };
}

// The camera heading that puts 0°E at the top of the screen near the south pole, as the polar map draws it (so
// its names read upright); elsewhere north up.
export const northUp = (latDeg, lonDeg) => (latDeg <= -60 ? (360 - (((lonDeg % 360) + 360) % 360)) % 360 : 0);

// The camera distance (km) whose view shows about the polar map's view: the inverse of the frame's scale.
export const distForZoom = (zoom, geo) => ((2 * MAX_HALF) / (zoom * geo.Sref)) * geo.H / (2 * Math.tan(20 * RAD));

export function createGlobeMap(doc, { frame, pyramid, eph, getState, onPickOutside, onCamera = () => {}, sites = [], features = [] }) {
  const host = frame.el;
  const layer = doc.createElement('div');
  layer.className = 'globe-map';
  const canvas = doc.createElement('canvas');
  canvas.className = 'globe-map-canvas';
  canvas.style.touchAction = 'none';
  const labels = doc.createElement('div');
  labels.className = 'globe-map-labels';
  const note = doc.createElement('p');
  note.className = 'map-chip globe-map-note';
  note.hidden = true;
  layer.append(canvas, labels, note);
  host.insertBefore(layer, host.querySelector('.map-canvas'));
  // the globe draws the terrain (one lighting and palette across 80°S); the polar map paints only its layers
  frame.setDrapeOnly?.(true);
  // the polar map's own pointer handlers must not see the globe's raw events (they get mapped copies instead)
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave', 'click', 'dblclick', 'wheel', 'contextmenu']) {
    layer.addEventListener(t, (e) => e.stopPropagation(), t === 'wheel' ? { passive: true } : undefined);
  }

  // ---- terrain: the global LOLA levels, and the polar pyramid the map already loads for its view ----
  let view = null;
  const terrain = createGlobeTerrain({
    load: (name) => loadData(name, { timeoutMs: 60000 }),
    south: () => pyramid.levels,
    onChange: ({ level, r, c }) => view?.invalidate({ latMin: 90 - (r + 1) * level.tileDeg, latMax: 90 - r * level.tileDeg, lonMin: c * level.tileDeg, lonMax: (c + 1) * level.tileDeg }),
  });
  const ready = terrain.init().then(() => {
    const st = getState(), s0 = st.site;
    const polar = s0 && s0.latDeg <= POLAR_LAT;
    const geo = frame.geo;
    const initial = polar
      ? { lat: -89.999, lon: 0, heading: 0, tilt: 0, dist: geo.W ? distForZoom(st.viewport?.zoom ?? 1, geo) : 850 }
      : { lat: s0?.latDeg ?? 0, lon: s0?.lonDeg ?? 0, heading: 0, tilt: 0, dist: 1600 };
    if (polar && st.viewport && (st.viewport.cx || st.viewport.cy)) { const c = fromXY(st.viewport.cx, st.viewport.cy); initial.lat = c.latDeg; initial.lon = c.lonDeg; initial.heading = northUp(c.latDeg, c.lonDeg); }
    view = createGlobeView(canvas, terrain, {
      overlays: true, initial, shadeGrey: 0.1,   // about the polar map's hillshade grey, so the two meet without a seam
      canDrag: () => true,   // a drag always moves the camera; the drawing tools place points by clicking
      dblZoom: () => (getState().tool ?? 'select') === 'select',
      onCamera: (c) => { cameraMoved(c); onCamera(c); },
    });
    view.setExaggeration(1);   // true relief: the cast shadows of the real Sun have their true length
    api.view = view;
    view.onFrame(frameTick);
    refreshGlobal(true);
    return view;
  });

  // ---- the camera → the polar map's view, once the camera rests ----
  let restTimer = 0, gesturing = false, lastCam = null;
  function cameraMoved(c) {
    lastCam = c;
    clearTimeout(restTimer);
    restTimer = setTimeout(syncPolarView, 180);
    placeLabels();
  }
  function syncPolarView() {
    if (!view || gesturing) return;
    // the ground in sight: a grid over the polar square projected to the screen, kept where it lands on it, and
    // refined once around what is visible (so a close view still gets a tight box)
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, n = 0;
    const scan = (ax, bx, ay, by, N) => {
      for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
        const x = ax + ((bx - ax) * i) / N, y = ay + ((by - ay) * j) / N;
        if (Math.hypot(x, y) > 306) continue;
        const ll = fromXY(x, y), p = view.project(ll.latDeg, ll.lonDeg);
        if (!p || p.x < 0 || p.y < 0 || p.x > W || p.y > H) continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); n++;
      }
    };
    scan(-MAX_HALF, MAX_HALF, -MAX_HALF, MAX_HALF, 40);
    if (n && n < 60) {
      // few hits: a close view; look again finely around them (one coarse cell beyond)
      const c = (2 * MAX_HALF) / 40, a0 = x0 - c, a1 = x1 + c, b0 = y0 - c, b1 = y1 + c;
      x0 = Infinity; x1 = -Infinity; y0 = Infinity; y1 = -Infinity; n = 0;
      scan(a0, a1, b0, b1, 40);
    }
    if (!n) {
      // closer still: the view centre and the ground under the screen corners
      const c = view.camera;
      if (c.lat <= POLAR_LAT + 0.6) {
        const [cx, cy] = toXY(c.lat, c.lon), r = Math.max(0.2, c.dist * 0.8);
        x0 = cx - r; x1 = cx + r; y0 = cy - r; y1 = cy + r; n = 1;
      }
    }
    // a tilted view sees far across the cap: keep the picture to the ground near the camera's target (about eight
    // camera distances across), so it stays sharp where the user looks; farther ground keeps the globe's own layers
    const cam = view.camera;
    if (n && cam.lat <= POLAR_LAT + 0.6 && cam.tilt > 20) {
      const [tx, ty] = toXY(cam.lat, cam.lon), R = Math.max(1, cam.dist * 4);
      x0 = Math.max(x0, tx - R); x1 = Math.min(x1, tx + R); y0 = Math.max(y0, ty - R); y1 = Math.min(y1, ty + R);
      if (!(x1 > x0 && y1 > y0)) n = 0;
    }
    polarInView = n > 0;
    if (!polarInView) { view.setOverlay({ polar: null }); return; }
    const pad = 0.04 * Math.max(x1 - x0, y1 - y0);
    const want = viewCovering({ x0: x0 - pad, x1: x1 + pad, y0: y0 - pad, y1: y1 + pad }, frame.geo);
    const cur = frame.view;
    const same = Math.abs(cur.zoom - want.zoom) / want.zoom < 0.04 && Math.hypot(cur.cx - want.cx, cur.cy - want.cy) < 0.02 * (2 * MAX_HALF) / want.zoom;
    // (the map clamps a view to its square; the clamped view is what it will show)
    if (!same) { requested = clampView(want); requestedAt = performance.now(); api.onPolarView?.(requested); }
    else requested = { ...cur };
    schedule(60);
  }
  let polarInView = true;
  let requested = null;   // the polar view the camera last asked for
  let requestedAt = 0;
  // the polar map moved by itself (fit to a planned route, a story step, the Coordinates fold): the camera follows
  function followPolarView() {
    // (only once the map has had time to take the camera's own request: the page renders before the map applies it)
    if (!view || gesturing || !requested || view.flying || performance.now() - requestedAt < 900) return;
    const v = frame.view, geo = frame.geo;
    if (!geo.W) return;
    const near = Math.abs(v.zoom - requested.zoom) / requested.zoom < 0.08 && Math.hypot(v.cx - requested.cx, v.cy - requested.cy) < 0.05 * (2 * MAX_HALF) / v.zoom;
    if (near) return;
    requested = { ...v };
    // the camera looks at the middle of the frame's picture, from the distance that shows about the same ground
    const kk = (2 * MAX_HALF) / (v.zoom * geo.Sref);
    const mx = v.cx - (geo.Cx - geo.W / 2) * kk, my = v.cy + (geo.Cy - geo.H / 2) * kk;
    const c = fromXY(mx, my);
    view.flyTo({ lat: c.latDeg, lon: c.lonDeg, dist: distForZoom(v.zoom, geo), tilt: 0, heading: northUp(c.latDeg, c.lonDeg), ms: 900 });
  }

  // ---- the polar map's picture, draped ----
  const comp = doc.createElement('canvas');
  const cctx = comp.getContext('2d');
  let compTimer = 0, compBusy = false, compAgain = false;
  function schedule(ms = 250) { clearTimeout(compTimer); compTimer = setTimeout(composite, ms); }
  // an SVG layer as an image, with its computed styles written into a copy (the page's CSS does not travel)
  const STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-size', 'font-weight', 'font-family', 'paint-order', 'text-anchor', 'dominant-baseline', 'display', 'visibility', 'letter-spacing'];
  function svgImage(svg) {
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(svg).display === 'none') return Promise.resolve(null);
    const copy = svg.cloneNode(true);
    const src = [svg, ...svg.querySelectorAll('*')], dst = [copy, ...copy.querySelectorAll('*')];
    for (let i = 0; i < src.length; i++) {
      // the graticule, site marks and feature names are drawn by the globe itself, over the whole Moon, upright
      if (src[i].matches?.('.graticule, .site-marks, .feature-names')) { dst[i].setAttribute('style', 'display:none'); continue; }
      // routes too (hand-drawn and planned, with their havens, stops and traps): the globe draws them as ribbons
      // and lines on the terrain. The station's coverage and the landing marks stay in the picture.
      const KEEP = '.rp-cov, .rp-station-mark, [class*="rp-lander"], [class*="rp-landing"]';
      if (src[i].matches?.('svg.map-shapes path.route, svg.map-shapes polyline.route, svg.map-shapes .route')
        || (src[i].parentElement?.matches?.('.routes-layer') && !src[i].matches(KEEP) && !src[i].querySelector?.(KEEP))) { dst[i].setAttribute('style', 'display:none'); continue; }
      const cs = getComputedStyle(src[i]);
      let style = '';
      for (const k of STYLE_PROPS) { const v = cs.getPropertyValue(k); if (v) style += `${k}:${v};`; }
      dst[i].setAttribute('style', style);
      dst[i].removeAttribute('class');
    }
    copy.setAttribute('width', String(r.width)); copy.setAttribute('height', String(r.height));
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const xml = new XMLSerializer().serializeToString(copy);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ img, r });
      img.onerror = () => resolve(null);
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    });
  }
  async function composite() {
    if (!view) return;
    if (compBusy) { compAgain = true; return; }
    compBusy = true;
    try {
      const fr = host.getBoundingClientRect();
      if (!fr.width || !polarInView) return;
      const dpr = Math.min(2, Math.max(1, COMPOSITE_MAX / Math.max(fr.width, fr.height), 1));
      const s = Math.min(dpr, window.devicePixelRatio || 1, COMPOSITE_MAX / Math.max(fr.width, fr.height));
      const w = Math.round(fr.width * s), h = Math.round(fr.height * s);
      if (comp.width !== w || comp.height !== h) { comp.width = w; comp.height = h; } else cctx.clearRect(0, 0, w, h);
      const put = (el) => { const r = el.getBoundingClientRect(); if (r.width && el.width) cctx.drawImage(el, (r.left - fr.left) * s, (r.top - fr.top) * s, r.width * s, r.height * s); };
      // (not the polar map's "no Sun now" veil: the globe lights the whole Moon by the real Sun instead, one light
      // across 80°S, with cast shadows)
      for (const c of host.querySelectorAll(':scope > canvas.map-canvas:not(.map-live)')) if (getComputedStyle(c).display !== 'none') put(c);
      // (not the Sun and Earth arrows: they sit at the polar map's view centre, which is not the globe's; the sky dial
      // shows the directions at the site)
      const imgs = await Promise.all([...host.querySelectorAll(':scope > svg.map-overlay, :scope > svg.map-shapes')].map(svgImage));
      for (const it of imgs) if (it) cctx.drawImage(it.img, (it.r.left - fr.left) * s, (it.r.top - fr.top) * s, it.r.width * s, it.r.height * s);
      const box = frame.boundsFor(frame.view);
      if (box) view.setOverlay({ polar: { canvas: comp, box, mix: 1 } });
    } finally {
      compBusy = false;
      if (compAgain) { compAgain = false; schedule(80); }
    }
  }
  // the polar map repaints after data arrives and in slices: copy again whenever its layers change
  const mo = new MutationObserver(() => schedule(gesturing ? 40 : 200));
  for (const el of host.querySelectorAll(':scope > svg')) mo.observe(el, { childList: true, subtree: true, attributes: true });
  let lastSharp = '';
  let lastUpd = 0;
  function frameTick() {
    const now = performance.now();
    if (gRoute?.layer) gRoute.layer.frame(`${terrain.version ?? 0}`);
    frameCandidates();
    if (draft && getState().tool !== 'route') { draft = null; drawDraft(); }
    if (rdraft && getState().tool !== rdraft.tool) { rdraft = null; drawRegionDraft(); }
    if (now - lastUpd > 500) { lastUpd = now; refreshGlobal(); refreshTerrain(); followPolarView(); placeLabels(); }
    // (and when the playhead moves: the live veil and the Live mode repaint every hour of it)
    const st = getState();
    const k = `${host.dataset.sharp ?? ''}|${host.dataset.redrawMs ?? ''}|${host.dataset.moveMs ?? ''}|${host.dataset.paintMs ?? ''}|${host.dataset.live ?? ''}|${pyramid.version ?? ''}|${Math.floor((st.cursorMs ?? 0) / 1800e3)}`;
    if (k !== lastSharp) { lastSharp = k; schedule(120); }
    if (pyramid.version !== pyrV) { pyrV = pyramid.version; view.invalidate({ pole: 'S' }); }
  }
  let pyrV = pyramid.version;

  // ---- the heat modes over the whole Moon (smooth horizon) ----
  const grid = globalGrid(1);
  const gcv = doc.createElement('canvas');
  gcv.width = grid.w; gcv.height = grid.h;
  const gctx = gcv.getContext('2d');
  let gKey = '', fracCache = new Map();
  function fractions(startMs, days) {
    const k = `${startMs}:${days}`;
    if (!fracCache.has(k)) { if (fracCache.size > 6) fracCache.clear(); fracCache.set(k, globalFractions(grid, eph, startMs, startMs + days * 86400e3, { stepMs: 2 * 3600e3 })); }
    return fracCache.get(k);
  }
  function refreshGlobal(force = false) {
    if (!view) return;
    const st = getState();
    const mode = st.mapMode ?? 'both';
    const style = frame.terrain?.style ?? 'data';
    const tenMin = Math.floor((st.cursorMs ?? st.landingMs ?? 0) / 600e3);
    const live = mode === 'now' || !st.windowOn || !Number.isFinite(st.landingMs);
    const night = host.dataset.live === 'on';   // the polar map's "Light at the playhead" veil is showing
    const key = `${mode}|${st.landingMs}|${st.stayDays}|${st.slipDays}|${live || night ? tenMin : ''}|${st.windowOn}|${style}|${night}`;
    if (!force && key === gKey) return;
    gKey = key;
    const colours = readColours();
    // over Topo and Real light the heat goes on at the polar map's strength there (mapframe.js HEAT_ON_TERRAIN)
    const alpha = style === 'data' ? 1 : 0.35;
    view.setNight(null);
    if (live) {
      // Live (and no mission window): the globe is lit by the real Sun at the playhead with cast shadows
      // (refreshTerrain), which is what "now" looks like; no flat Sun / Earth fills from a smooth horizon outside the
      // polar data, whose straight half-Moon edges read as terminators that are not there
      // (inside 80°S too: the polar picture leaves its Live colours out, so the cap matches the rest of the Moon)
      view.setLive(null);
      view.setOverlay({ global: null });
      frame.setDrapeHeat?.(false);
      return;
    }
    frame.setDrapeHeat?.(true);
    view.setLive(null);
    const img = gctx.createImageData(grid.w, grid.h), d = img.data;
    const N = grid.w * grid.h;
    let pick = null;
    if (mode === 'change') {
      const a = fractions(st.landingMs, st.stayDays), b = fractions(st.landingMs + (st.slipDays ?? 0) * 86400e3, st.stayDays);
      pick = (c) => heatColour('change', { delta: b.both[c] - a.both[c] }, colours);
    } else if (mode === 'both' || mode === 'sun' || mode === 'earth') {
      const f = fractions(st.landingMs, st.stayDays);
      const arr = f[mode];
      pick = (c) => heatColour(mode, { value: arr[c] }, colours);
    }
    for (let c = 0; c < N; c++) {
      const hc = pick ? pick(c) : null;
      if (!hc) continue;
      const [[r, g, b], a] = hc;
      d[c * 4] = r; d[c * 4 + 1] = g; d[c * 4 + 2] = b; d[c * 4 + 3] = Math.round(a * 255);
    }
    gctx.putImageData(img, 0, 0);
    view.setOverlay({ global: { canvas: gcv, alpha } });
  }

  // ---- terrain style and contours of the globe (the polar picture carries its own) ----
  let tsKey = '';
  function refreshTerrain() {
    if (!view) return;
    const ts = frame.terrain ?? {}, st = getState();
    // the real Sun at the playhead lights the globe (with cast shadows) in Real light, and whenever the polar map
    // would show "Light at the playhead" (its veil): one light across 80°S that moves with the time
    const liveMode = st.mapMode === 'now' || !st.windowOn || !Number.isFinite(st.landingMs);
    const realSun = ts.style === 'real' || host.dataset.live === 'on' || liveMode;
    const key = `${ts.style}|${ts.contours}|${realSun ? Math.floor((st.cursorMs ?? 0) / 300e3) : ''}`;
    if (key === tsKey) return;
    tsKey = key;
    view.setColour(ts.style === 'topo' ? 'tint' : 'shade');
    view.setContours(!!ts.contours);
    // contour ink as on the polar map for each style (mapframe.js CONTOUR_INK, the index lines)
    view.setContourInk(ts.style === 'topo' ? [58, 32, 14] : ts.style === 'real' ? [255, 206, 150] : [235, 235, 235]);
    const d = realSun ? eph.at(st.cursorMs ?? st.landingMs) : null;
    view.setSun(d ? d.sun : null);
  }

  // ---- labels outside the polar picture: listed sites and the major named features ----
  // ---- labels over the whole Moon: the listed sites, the named features (the polar map's list near the pole, the
  // IAU gazetteer's major features elsewhere), the selected site; upright on screen, decluttered by priority ----
  const labelEls = [];
  const addLabel = (latDeg, lonDeg, text, cls, onClick, extra = {}) => {
    const el = doc.createElement(onClick ? 'button' : 'span');
    el.className = `globe-label ${cls}`; el.textContent = text;
    if (onClick) {
      el.type = 'button'; el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      el.addEventListener('dblclick', (e) => { e.stopPropagation(); if (getState().tool === 'route') finishDraft(); });   // a route may end on a site
    }
    labels.appendChild(el);
    labelEls.push({ latDeg, lonDeg, el, cls, ...extra });
    return el;
  };
  // a site's label picks it as the site, or adds it as a point while the Route tool is drawing
  for (const s0 of sites) if (Number.isFinite(s0.latDeg)) addLabel(s0.latDeg, s0.lonDeg, s0.name, 'is-site', () => (getState().tool === 'route' ? addDraftPoint({ latDeg: s0.latDeg, lonDeg: s0.lonDeg, name: s0.name }) : onPickOutside?.({ site: s0 })), { rank: 1 });
  for (const f of features) if (Number.isFinite(f.latDeg)) addLabel(f.latDeg, f.lonDeg, f.name, 'is-feature is-crater', null, { rank: 3, diameterKm: f.diameterKm ?? 20 });
  for (const g of GAZETTEER) if (!features.some((f) => f.name === g.name)) addLabel(g.latDeg, g.lonDeg, g.name, `is-feature is-${g.type}`, null, { rank: 2, diameterKm: g.diameterKm ?? 100 });
  const selEl = addLabel(0, 0, '', 'is-selected', null, { rank: 0 });
  // the graticule's degree labels, placed along the lines that cross the view centre (made as needed)
  const gratEls = [];
  const gratEl = (i) => { while (gratEls.length <= i) { const el = doc.createElement('span'); el.className = 'globe-grat'; labels.appendChild(el); gratEls.push(el); } return gratEls[i]; };
  // the polar map's Layers switches (Graticule, Site labels) apply to the globe's own lines and labels too
  const layerOn = (k) => host.dataset[k] !== 'off';
  const gratStep = (dist) => (dist > 2500 ? 30 : dist > 700 ? 10 : dist > 180 ? 5 : dist > 40 ? 1 : 0.5);
  let gratKey = '';
  let taken = [];   // screen boxes already used by labels this frame (sites and names first, then degrees)
  function placeGraticule() {
    const on = layerOn('graticule'), c = view.camera, step = gratStep(c.dist);
    const key = `${on}|${step}`;
    if (key !== gratKey) {
      gratKey = key;
      // the polar map's graticule ink (styles.css --rule-on-surface)
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(getComputedStyle(host).getPropertyValue('--rule-on-surface') || '');
      const ink = m ? [Number(m[1]), Number(m[2]), Number(m[3]), Math.min(0.85, Math.max(0.35, Number(m[4] ?? 1)))] : [0, 0, 0, 0.5];
      view.setGraticule(on ? { stepDeg: step, ink } : null);
    }
    let n = 0;
    if (on && c.dist < 9000) {
      const fmtLat = (v) => (Math.abs(v) < 1e-6 ? '0°' : `${+Math.abs(v).toFixed(1)}°${v < 0 ? 'S' : 'N'}`);
      const fmtLon = (v) => { const L = ((v % 360) + 360) % 360; return L === 0 || L === 180 ? `${L}°` : L < 180 ? `${+L.toFixed(1)}°E` : `${+(360 - L).toFixed(1)}°W`; };
      const put = (lat, lon, text) => {
        const p = view.project(lat, lon);
        if (!p) return;
        const w = text.length * 6 + 8;
        if (taken.some((r) => p.x < r.x + r.w && p.x + w > r.x && Math.abs(p.y - r.y) < 14)) return;
        taken.push({ x: p.x, y: p.y, w });
        const el = gratEl(n++);
        el.hidden = false; el.textContent = text;
        el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
      };
      // parallels: labelled along the meridian through the view centre
      const lat0 = Math.round(c.lat / step) * step;
      for (let k = -6; k <= 6; k++) { const la = lat0 + k * step; if (la > -90 && la < 90) put(la, c.lon, fmtLat(la)); }
      // meridians: labelled along a parallel where they stand at least ~70 px apart (away from a pole the view may
      // be centred on), with the same 3× / 9× thinning as the lines
      const kpp = view.kmPerPx(), mer = (lat) => (MOON_R_KM * Math.cos(lat * RAD) * step * RAD) / kpp;
      const want = 70;
      let latL = c.lat;
      if (mer(latL) < want) {
        const cosNeed = Math.min(1, (want * kpp) / (MOON_R_KM * step * RAD));
        latL = Math.sign(c.lat || -1) * Math.acos(cosNeed) / RAD;
      }
      const m = mer(latL), lonStep = step * (m >= want * 0.9 ? 1 : m * 3 >= want * 0.9 ? 3 : 9);
      const lon0 = Math.round(c.lon / lonStep) * lonStep;
      for (let k = -8; k <= 8; k++) put(latL, lon0 + k * lonStep, fmtLon(lon0 + k * lonStep));
    }
    for (let i = n; i < gratEls.length; i++) gratEls[i].hidden = true;
  }
  function placeLabels() {
    if (!view) return;
    labels.classList.toggle('labels-off', !layerOn('labels'));
    const dist = view.camera.dist, st = getState(), s0 = st.site;
    if (s0) { selEl.textContent = s0.name ?? 'Site'; const it = labelEls.find((x) => x.el === selEl); it.latDeg = s0.latDeg; it.lonDeg = s0.lonDeg; }
    const kpp = view.kmPerPx(), placed = [];
    const clash = (x, y, w) => placed.some((r) => x < r.x + r.w && x + w > r.x && Math.abs(y - r.y) < 16);
    // the selected site first, then the sites, then features by size; a feature shows while it is between about
    // 30 px and the whole view across; a listed site matching the selected one is not repeated
    const order = [...labelEls].sort((a, b) => a.rank - b.rank || (b.diameterKm ?? 0) - (a.diameterKm ?? 0));
    for (const L of order) {
      let show = dist < 9000;
      if (L.el === selEl) show = !!s0 && !sites.some((x) => x.latDeg === s0.latDeg && x.lonDeg === s0.lonDeg);
      else if (L.diameterKm) { const px = L.diameterKm / kpp; show = show && px > 30 && px < 2500; }
      const p = show ? view.project(L.latDeg, L.lonDeg) : null;
      const w = p ? L.el.textContent.length * 6.4 + 18 : 0;
      if (p && L.el !== selEl && clash(p.x, p.y, w)) { L.el.hidden = true; continue; }
      L.el.hidden = !p;
      if (p) { L.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`; placed.push({ x: p.x, y: p.y, w }); }
    }
    taken = layerOn('labels') ? placed.slice() : [];
    placeGraticule();
  }

  // ---- input: globe points → the polar map's own events ----
  const frameClient = (latDeg, lonDeg) => {
    const [x, y] = toXY(latDeg, lonDeg), [px, py] = frame.toPx(x, y), g = frame.geo, r = host.getBoundingClientRect();
    return { clientX: r.left + (px * r.width) / g.W, clientY: r.top + (py * r.height) / g.H, xKm: x, yKm: y };
  };
  const send = (type, at, extra = {}) => {
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    host.dispatchEvent(new Ctor(type, { bubbles: false, cancelable: true, clientX: at.clientX, clientY: at.clientY, button: 0, buttons: type === 'pointermove' ? extra.buttons ?? 0 : type === 'pointerdown' ? 1 : 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, detail: extra.detail ?? 1 }));
  };
  const hit = (e) => (view ? view.pick(e.clientX, e.clientY) : null);
  let down = null, moveAt = 0;
  const say = (text) => { note.textContent = text; note.hidden = !text; clearTimeout(say.t); if (text) say.t = setTimeout(() => { note.hidden = true; }, 3500); };
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, tool: getState().tool ?? 'select' };
    // the drawing tools act on a click (pointer up without a drag), so a drag (or a three-finger drag) still moves
    // the globe: the Route tool draws on the globe itself; rectangle, circle and polygon are clicked out on the polar
    // map (two clicks for a rectangle or circle, a click per vertex for a polygon)
  });
  canvas.addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (now - moveAt < 30) return;
    moveAt = now;
    const h = hit(e);
    if (!h) return;
    if (draft) { draft.cursor = snapped(e, h); drawDraft(); }
    if (rdraft) { rdraft.cursor = { latDeg: h.latDeg, lonDeg: h.lonDeg }; drawRegionDraft(); return; }
    if (h.latDeg > POLAR_LAT) { if (!gesturing) host.dispatchEvent(new PointerEvent('pointerleave')); return; }
    const at = frameClient(h.latDeg, h.lonDeg);
    send('pointermove', at, { buttons: 0 });
    if (getState().tool !== 'select' && getState().tool !== 'route') schedule(40);   // the draft shape follows
    // the hover card sits by the real pointer, not where the event was replayed
    const card = host.querySelector('.hover-card, #lsn-map-hover');
    if (card) { const r = host.getBoundingClientRect(); card.style.transform = `translate(${Math.round(e.clientX - r.left + 14)}px, ${Math.round(e.clientY - r.top + 14)}px)`; }
    if (gesturing) schedule(30);
  });
  canvas.addEventListener('pointerup', (e) => {
    const d = down; down = null;
    if (!d) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4;
    const h = hit(e);
    if (d.tool === 'route') { if (!moved && h) addDraftPoint(snapped(e, h)); return; }
    if (d.tool !== 'select') {
      if (moved || !h) return;
      // north of 80°S (or once started there) the shape is clicked out on the globe in latitude and longitude
      if (rdraft || h.latDeg > POLAR_LAT) { addRegionPoint(d.tool, { latDeg: h.latDeg, lonDeg: h.lonDeg }, e); return; }
      const at = frameClient(h.latDeg, h.lonDeg);
      send('pointerdown', at); send('pointerup', at);
      schedule(30);
      return;
    }
    if (moved || !h) return;
    if (h.latDeg > POLAR_LAT) { onPickOutside?.({ point: { latDeg: +h.latDeg.toFixed(4), lonDeg: +h.lonDeg.toFixed(4) } }); return; }
    send('click', frameClient(h.latDeg, h.lonDeg));
    schedule(300);
  });
  canvas.addEventListener('dblclick', (e) => {
    if ((getState().tool ?? 'select') === 'select') return;   // the globe zooms in itself
    if (getState().tool === 'route') { finishDraft(); return; }
    if (rdraft) { finishRegion(); return; }
    const h = hit(e);
    if (h && h.latDeg <= POLAR_LAT) { send('dblclick', frameClient(h.latDeg, h.lonDeg), { detail: 2 }); schedule(40); }
  });
  canvas.addEventListener('pointerleave', () => { if (!gesturing) host.dispatchEvent(new PointerEvent('pointerleave')); });

  // ---- the Route tool on the globe, anywhere on the Moon: click to add points (a click near a listed site snaps to
  // it), double-click or Enter to finish, Backspace to drop the last point, Esc to cancel ----
  let draft = null, draftObj = null;
  function snapped(e, h) {
    const r = canvas.getBoundingClientRect();
    let best = null, bd = 14;
    for (const s0 of sites) {
      const p = view.project(s0.latDeg, s0.lonDeg);
      if (!p) continue;
      const d = Math.hypot(p.x - (e.clientX - r.left), p.y - (e.clientY - r.top));
      if (d < bd) { bd = d; best = s0; }
    }
    return best ? { latDeg: best.latDeg, lonDeg: best.lonDeg, name: best.name } : { latDeg: +h.latDeg.toFixed(5), lonDeg: +h.lonDeg.toFixed(5) };
  }
  // a line along the surface through lat/lon points (great-circle steps), drawn over the terrain
  function surfaceLine(lls, color, { dashed = false, opacity = 0.95 } = {}) {
    const T = view.THREE, pts = [];
    for (let i = 0; i + 1 < lls.length; i++) {
      const a = lls[i], b = lls[i + 1];
      const d = arcGc(a, b), n = Math.max(2, Math.ceil((d / RAD) * 8));   // 8 steps a degree of arc
      for (let k = 0; k <= n; k++) {
        const q = onGc(a, b, k / n, d);
        pts.push(new T.Vector3(...view.surface(q.latDeg, q.lonDeg, 0.02)));
      }
    }
    const g = new T.BufferGeometry().setFromPoints(pts);
    const m = dashed ? new T.LineDashedMaterial({ color, dashSize: 2, gapSize: 1.5, depthTest: false, transparent: true, opacity }) : new T.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity });
    const line = new T.Line(g, m);
    if (dashed) line.computeLineDistances();
    line.renderOrder = 20;
    return line;
  }
  function surfaceDots(lls, color, px = 7) {
    const T = view.THREE;
    const g = new T.BufferGeometry().setFromPoints(lls.map((p) => new T.Vector3(...view.surface(p.latDeg, p.lonDeg, 0.03))));
    const pts = new T.Points(g, new T.PointsMaterial({ color, size: px, sizeAttenuation: false, depthTest: false, transparent: true }));
    pts.renderOrder = 21;
    return pts;
  }
  function clearObj(o) { if (!o) return; view.removeObject(o); o.traverse((x) => { x.geometry?.dispose?.(); x.material?.dispose?.(); }); }
  function drawDraft() {
    clearObj(draftObj); draftObj = null;
    if (!draft) return;
    const T = view.THREE, g = new T.Group();
    const lls = draft.cursor ? [...draft.pts, draft.cursor] : draft.pts;
    if (lls.length >= 2) g.add(surfaceLine(lls, 0xffffff));
    if (draft.pts.length) g.add(surfaceDots(draft.pts, 0xffffff, 8));
    view.addObject(g); draftObj = g;
  }
  function addDraftPoint(p) {
    if (!draft) { draft = { pts: [], cursor: null }; say('Route: click to add points · double-click or Enter to finish · Backspace removes the last · Esc cancels'); }
    const last = draft.pts[draft.pts.length - 1];
    if (last && Math.abs(last.latDeg - p.latDeg) < 1e-6 && Math.abs(last.lonDeg - p.lonDeg) < 1e-6) return;
    if (draft.pts.length >= 8) { say('At most 8 points: double-click or press Enter to finish.'); return; }
    draft.pts.push(p); drawDraft();
  }
  function finishDraft() {
    if (!draft) return;
    const pts = draft.pts;
    draft = null; drawDraft(); say('');
    if (pts.length >= 2) api.onRouteDrawn?.(pts);
    else say('A route needs a start and an end point.');
  }
  window.addEventListener('keydown', (e) => {
    if (rdraft) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); finishRegion(); }
      else if (e.key === 'Escape') { e.preventDefault(); rdraft = null; drawRegionDraft(); say(''); }
      else if (e.key === 'Backspace' && !e.target.closest?.('input, textarea, select')) { e.preventDefault(); rdraft.pts.pop(); if (!rdraft.pts.length) rdraft = null; drawRegionDraft(); }
      return;
    }
    if (!draft) return;
    // while a route is being drawn, Enter and Esc are the drawing's even with a field focused (Enter there would
    // plan the card's old points instead); Backspace stays the field's
    if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); finishDraft(); }
    else if (e.key === 'Escape') { e.preventDefault(); draft = null; drawDraft(); say(''); }
    else if (e.key === 'Backspace' && !e.target.closest?.('input, textarea, select')) { e.preventDefault(); draft.pts.pop(); if (!draft.pts.length) draft = null; drawDraft(); }
  }, true);   // capture: before a focused field's own Enter

  // ---- rectangle, circle and polygon north of 80°S, on the globe itself (georegion.js): a box from two corners, a
  // cap from its centre and a point on its edge, a polygon from its corners (click the first, double-click or Enter
  // to close). The page reads them over a smooth horizon; inside 80°S the polar map draws and reads them as before ----
  let rdraft = null, rdraftObj = null, geoObj = null, geoKey = '';
  const REGION_SAY = {
    rect: 'Rectangle: click the opposite corner · Esc cancels',
    circle: 'Circle: click a point on the edge · Esc cancels',
    polygon: 'Polygon: click the next corner · click the first one, double-click or Enter to close · Backspace removes the last · Esc cancels',
  };
  function previewShape(d) {
    if (!d.cursor || !d.pts.length) return null;
    if (d.tool === 'rect') return geoRect(d.pts[0], d.cursor);
    if (d.tool === 'circle') return geoCircle(d.pts[0], d.cursor);
    return null;
  }
  function drawRegionDraft() {
    clearObj(rdraftObj); rdraftObj = null;
    if (!rdraft) return;
    const T = view.THREE, g = new T.Group(), shape = previewShape(rdraft);
    if (shape) g.add(surfaceLine(geoOutline(shape), 0xffffff, { dashed: true }));
    else if (rdraft.tool === 'polygon') {
      const lls = rdraft.cursor ? [...rdraft.pts, rdraft.cursor] : rdraft.pts;
      if (lls.length >= 2) g.add(surfaceLine(lls, 0xffffff, { dashed: true }));
    }
    if (rdraft.pts.length) g.add(surfaceDots(rdraft.pts, 0xffffff, 8));
    view.addObject(g); rdraftObj = g;
  }
  function addRegionPoint(tool, p, e) {
    if (!rdraft) rdraft = { tool, pts: [], cursor: null };
    say(REGION_SAY[tool] ?? '');
    if (tool === 'rect' || tool === 'circle') {
      if (!rdraft.pts.length) { rdraft.pts.push(p); drawRegionDraft(); return; }
      const shape = tool === 'rect' ? geoRect(rdraft.pts[0], p) : geoCircle(rdraft.pts[0], p);
      rdraft = null; drawRegionDraft(); say('');
      if (shape) api.onRegionDrawn?.(shape); else say('Too small: click two points further apart.');
      return;
    }
    const last = rdraft.pts[rdraft.pts.length - 1];
    if (last && Math.abs(last.latDeg - p.latDeg) < 1e-6 && Math.abs(last.lonDeg - p.lonDeg) < 1e-6) return;   // the double-click's second click
    if (rdraft.pts.length >= 3) {   // a click on the first corner closes it
      const f = view.project(rdraft.pts[0].latDeg, rdraft.pts[0].lonDeg), r = canvas.getBoundingClientRect();
      if (f && Math.hypot(f.x - (e.clientX - r.left), f.y - (e.clientY - r.top)) < 12) { finishRegion(); return; }
    }
    if (rdraft.pts.length >= 64) { say('At most 64 corners: click the first one, double-click or press Enter to close.'); return; }
    rdraft.pts.push(p); drawRegionDraft();
  }
  function finishRegion() {
    if (!rdraft) return;
    const d = rdraft;
    rdraft = null; drawRegionDraft(); say('');
    if (d.tool !== 'polygon') return;
    const shape = geoPolygon(d.pts);
    if (shape) api.onRegionDrawn?.(shape); else say('A polygon needs at least three corners.');
  }
  // the regions held in latitude and longitude, drawn on the globe (the polar ones are in the draped picture)
  function refreshGeoRegions() {
    if (!view) return;
    const regs = getState().regions ?? {};
    const list = ['A', 'B'].filter((k) => isGeo(regs[k])).map((k) => [k, regs[k]]);
    const key = JSON.stringify(list);
    if (key === geoKey) return;
    geoKey = key;
    clearObj(geoObj); geoObj = null;
    if (!list.length) return;
    const T = view.THREE, g = new T.Group();
    for (const [k, sh] of list) {
      g.add(surfaceLine(geoOutline(sh), k === 'A' ? 0xffffff : 0xffd23d));
      g.add(surfaceDots(sh.type === 'polygon' ? sh.pts.map(([a, b]) => ({ latDeg: a, lonDeg: b })) : [], 0xffffff, 6));
    }
    view.addObject(g); geoObj = g;
  }

  // ---- a route away from the polar picture, on the globe itself: the chosen route as a ribbon coloured by the
  // drive or by slope (globe-route.js), the other candidates dashed, or the hand-drawn line with its points ----
  let gRoute = null;   // { layer, extras }
  // the other candidates: strips a constant CAND_PX wide on screen, over the terrain, in the card's styles (Flattest
  // dashed, Sunniest dotted, others solid); rebuilt when the zoom changes by more than 12 %
  const CAND_PX = 3;
  let candLines = [], candBuilt = null, candObj = null;
  function candStrips(kpp) {
    const T = view.THREE, w = kpp * CAND_PX, lift = Math.min(0.012 * view.exaggeration, 0.0003 + w * 0.6);
    const pos = [], idx = [];
    let o = null;
    for (const c of candLines) {
      const P = c.points.map((p) => new T.Vector3(...view.surface(p.latDeg, p.lonDeg, lift)));
      // on, off (km); close up a long route would need too many dashes: then they spread out (at most 20 000)
      let total = 0;
      for (let i = 0; i + 1 < P.length; i++) total += P[i].distanceTo(P[i + 1]);
      const base = c.id === 'flat' ? [4, 2.6] : c.id === 'sunny' ? [1.2, 1.6] : null;
      const f = base ? w * Math.max(1, total / (w * (base[0] + base[1]) * 20000)) : 0;
      const pat = base ? [base[0] * f, base[1] * f] : null;
      o ??= P[0].clone();
      let phase = 0;
      for (let i = 0; i + 1 < P.length; i++) {
        const a = P[i], b = P[i + 1], len = a.distanceTo(b);
        if (!(len > 0)) continue;
        const side = new T.Vector3().crossVectors(b.clone().sub(a), a.clone().normalize()).normalize().multiplyScalar(w / 2);
        const quad = (t0, t1) => {
          const p0 = a.clone().lerp(b, t0).sub(o), p1 = a.clone().lerp(b, t1).sub(o), k = pos.length / 3;
          pos.push(p0.x - side.x, p0.y - side.y, p0.z - side.z, p0.x + side.x, p0.y + side.y, p0.z + side.z,
            p1.x - side.x, p1.y - side.y, p1.z - side.z, p1.x + side.x, p1.y + side.y, p1.z + side.z);
          idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        };
        if (!pat) { quad(0, 1); continue; }
        // walk the dash pattern along the segment (at most 40 000 dashes in all: farther apart when zoomed close)
        const period = pat[0] + pat[1];
        // the steps never shrink below a millionth of the period, so rounding cannot stall the walk
        let d = 0;
        for (let guard = 0; d < len && pos.length < 480000 && guard < 200000; guard++) {
          const at = (phase + d) % period, on = at < pat[0];
          const step = Math.min(len - d, Math.max(period * 1e-6, on ? pat[0] - at : period - at));
          if (on) quad(d / len, (d + step) / len);
          d += step;
        }
        phase = (phase + len) % period;
      }
    }
    if (!pos.length) return null;
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const m = new T.Mesh(g, new T.MeshBasicMaterial({ color: 0xdfe3e8, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, side: T.DoubleSide }));
    m.position.copy(o); m.renderOrder = 14;   // under the chosen route's ribbon (15)
    return m;
  }
  function frameCandidates() {
    if (!candLines.length) { if (candObj) { clearObj(candObj); candObj = null; } return; }
    const kpp = view.kmPerPx();
    if (candBuilt && kpp / candBuilt < 1.12 && candBuilt / kpp < 1.12) return;
    candBuilt = kpp;
    clearObj(candObj); candObj = candStrips(kpp);
    if (candObj) view.addObject(candObj);
  }
  let gKeyRoute = '';
  function setGlobalRoute(data) {
    if (!view) return;
    const k = data ? JSON.stringify([data.key ?? null, data.colourBy, data.hand, data.waypoints, (data.candidates ?? []).map((c) => c.points.length), data.payload?.pts?.length, data.payload?.departMs]) : '';
    if (k === gKeyRoute && (gRoute || !data)) return;
    gKeyRoute = k;
    if (gRoute) { gRoute.layer?.dispose(); clearObj(gRoute.extras); gRoute = null; }
    candLines = []; candBuilt = null;
    if (!data) { view.redraw(); return; }
    const T = view.THREE, extras = new T.Group();
    let lay = null;
    if (data.payload) {
      lay = createRouteLayer(view, data.payload, { onTop: true });
      if (data.colourBy) lay.setColourBy(data.colourBy);
      const q = data.payload.pts[0];
      lay.setRover({ latDeg: q[0], lonDeg: q[1], km: 0, state: 'ready', soc: q[4] }, 0xffd23d, { headingDeg: 0, pitchDeg: 0, rollDeg: 0 });
    }
    candLines = (data.candidates ?? []).filter((c) => c.points.length >= 2); candBuilt = null;
    // the hand-drawn line as a white ribbon (a route payload without a drive), so it reads at every zoom
    if (data.hand?.length >= 2 && !data.payload) {
      const pts = [];
      let km = 0;
      for (let i = 0; i + 1 < data.hand.length; i++) {
        const a = data.hand[i], b = data.hand[i + 1];
        const d = arcGc(a, b), seg = MOON_R_KM * d;   // along the great circle, not the parallels
        const n = Math.max(2, Math.ceil(seg / 0.5));
        for (let k = i ? 1 : 0; k <= n; k++) { const f = k / n, q = onGc(a, b, f, d); pts.push([q.latDeg, q.lonDeg, km + seg * f, null, null, 1]); }
        km += seg;
      }
      lay = createRouteLayer(view, { v: 1, label: 'Drawn', lengthKm: km, departMs: null, arriveMs: null, reserve: 0.2, pts }, { onTop: true });
      lay.setRover({ latDeg: pts[0][0], lonDeg: pts[0][1], km: 0, state: 'ready', soc: null }, 0xffd23d, { headingDeg: 0, pitchDeg: 0, rollDeg: 0 });
    }
    const wps = data.waypoints ?? data.hand ?? [];
    if (wps.length) extras.add(surfaceDots(wps, 0xffffff, 9));
    view.addObject(extras);
    gRoute = { layer: lay, extras };
  }

  const api = {
    view: null, ready, el: layer,
    onRouteDrawn: null,
    onRegionDrawn: null,   // (geo shape) a rectangle, circle or polygon clicked out north of 80°S (georegion.js)
    setGlobalRoute: (d) => { ready.then(() => setGlobalRoute(d)); },
    // the global LOLA terrain: heights (m) anywhere, and its 474 m tiles over a box loaded on demand
    heightAt: (la, lo) => terrain.heightAt(la, lo),
    need: (latMin, latMax, lonMin, lonMax) => terrain.need(G2, latMin, latMax, lonMin, lonMax, { max: 160 }),
    // share of the planned stay with the Sun above a smooth horizon at a place (globalheat.js), or NaN
    sunShare(la, lo) {
      const st = getState();
      if (!Number.isFinite(st.landingMs)) return NaN;
      const f = fractions(st.landingMs, st.stayDays);
      const j = Math.min(grid.h - 1, Math.max(0, Math.floor((90 - la) / grid.stepDeg))), i = Math.floor(((((lo % 360) + 360) % 360)) / grid.stepDeg) % grid.w;
      return f.sun[j * grid.w + i];
    },
    // frame a set of points on the globe
    flyToPoints(lls) {
      if (!view || !lls.length) return;
      let x = 0, y = 0, z = 0;
      for (const p of lls) { const c = Math.cos(p.latDeg * RAD); x += c * Math.cos(p.lonDeg * RAD); y += c * Math.sin(p.lonDeg * RAD); z += Math.sin(p.latDeg * RAD); }
      const lat = Math.asin(z / Math.hypot(x, y, z)) / RAD, lon = (Math.atan2(y, x) / RAD + 360) % 360;
      let ext = 1;
      for (const p of lls) ext = Math.max(ext, MOON_R_KM * RAD * Math.hypot(p.latDeg - lat, ((p.lonDeg - lon + 540) % 360 - 180) * Math.cos(lat * RAD)));
      view.flyTo({ lat, lon, dist: Math.max(6, ext * 3.2), tilt: 0, heading: northUp(lat, lon), ms: 1200 });
    },
    get picture() { return comp; },   // the draped polar picture (for inspection)
    onPolarView: null,
    // screen position (frame CSS px) of a ground point, for the sky dial; null when out of sight
    toFramePx(latDeg, lonDeg) { const p = view?.project(latDeg, lonDeg); return p ? [p.x, p.y] : null; },
    flyTo(cam) { view?.flyTo({ tilt: 0, heading: northUp(cam.lat, cam.lon), ms: 1400, ...cam }); },
    // + / −; the zoom readout (reset): back to the polar map's 1× scale; north (the tool column's North up): the same
    // place turned back to the map's orientation (north up, 0°E up near the south pole) and looking straight down,
    // since a drag turns the globe freely about its centre
    zoom(dir) {
      if (!view) return false;
      const c = view.camera;
      if (dir === 'north') { view.flyTo({ lat: c.lat, lon: c.lon, dist: c.dist, tilt: 0, heading: northUp(c.lat, c.lon), ms: 600 }); return true; }
      if (dir === 'reset') { view.flyTo({ lat: c.lat, lon: c.lon, dist: frame.geo?.W ? distForZoom(1, frame.geo) : 1600, tilt: c.tilt, heading: c.heading, ms: 600 }); return true; }
      if (dir !== 'in' && dir !== 'out') return false;
      view.flyTo({ lat: c.lat, lon: c.lon, dist: Math.max(0.05, Math.min(14000, c.dist * (dir === 'in' ? 1 / 1.8 : 1.8))), tilt: c.tilt, heading: c.heading, ms: 400 });
      return true;
    },
    // the page re-rendered (mode, window, terrain style, site, playhead): bring the globe's own layers up to date
    update() { refreshGlobal(); refreshTerrain(); refreshGeoRegions(); placeLabels(); schedule(150); },
    get camera() { return view?.camera ?? null; },
  };
  void lastCam;
  return api;
}
