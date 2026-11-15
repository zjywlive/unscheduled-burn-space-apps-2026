// The map frame (task book phase 3 §4.1, §4.5, §4.6): canvas (hillshade and heat), the annotation SVG,
// the shapes SVG, the hover card and the loading line. Handles the viewport (wheel, drag, pinch, keys),
// snapping, the keyboard crosshair and drawing. Holds the live viewport during a gesture and reports it
// when the gesture ends; everything else comes in through update().
//
// createMapFrame({ coarseGrid, pyramid, features, sites }, callbacks) → { el, update(params), resize(), focus() }
// callbacks: onViewport(view), onPick({ site } | { point }), onBest(cell), onRegionBest(slot),
//   onShape(shape), onDrawing(boolean), onDrawNote(text | null), onReadout(text, fromKeyboard), describe(xKm, yKm, target) → { readout, card } | null
import { h, s, clear } from './dom.js';
import { hillshade, paintBase, paintHeat, readColours, deepHeatStyle } from '../map/layers.js';
import { paintPsr } from '../psr.js';
import { renderOverlay } from '../map/overlay.js';
import { createShapesLayer } from '../map/shapes-layer.js';
import { drawRoutes } from '../map/routes-layer.js';
import { createHoverCard } from './hovercard.js';
import { findSnap, SNAP_RADIUS_PX } from '../map/snap.js';
import { initialDraw, drawReduce, closeTarget } from '../map/draw.js';
import { clampView, viewHalfKm, MIN_ZOOM, MAX_ZOOM, toPx as toPxView } from '../map/view.js';
import { toXY, fromXY, MAP_HALF_KM } from '../terrain.js';
import { heightBand, heightRange, typicalGradient, topoBand, lightBand, exposureFor, bodyDirection, contourInterval, contourSegments, contourLines, contourLabels } from '../map/terrain-style.js';

const R80 = 2 * 1737.4 * Math.tan((5 * Math.PI) / 180);   // radius of the 80°S circle, km
const DRAG_PX = 4;              // a press that moves less than this is a click
const WHEEL_IDLE_MS = 70;       // a wheel gesture ends this long after its last event
const ZOOM_STEP = 1.5;
const CROSSES = 'This outline crosses itself. Draw it again without crossing.';
const round4 = (v) => Math.round(v * 1e4) / 1e4;
const sameView = (a, b) => a && b && a.cx === b.cx && a.cy === b.cy && a.zoom === b.zoom;
const isFull = (v) => v.zoom === 1 && v.cx === 0 && v.cy === 0;
const HEAT_ON_TERRAIN = 0.35;    // the heat colours over Topo and Real light
const CONTOUR_INK = {            // contour lines per terrain style: minor, index, label halo, label text
  data: ['rgba(255,255,255,0.24)', 'rgba(255,255,255,0.6)', 'rgba(0,0,0,0.75)', '#ffffff'],
  topo: ['rgba(74,46,24,0.5)', 'rgba(58,32,14,0.9)', 'rgba(236,224,196,0.9)', '#3a200c'],
  real: ['rgba(255,196,130,0.38)', 'rgba(255,206,150,0.85)', 'rgba(0,0,0,0.8)', '#ffe2bd'],
};
const degText = (v) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}°`;

export function createMapFrame({ coarseGrid, pyramid, features, sites }, cb) {
  const canvas = h('canvas', { class: 'map-canvas', 'aria-hidden': 'true' });
  // phase 5: the live layer over the window modes (ground without the Sun at the playhead, darkened). Its own
  // canvas at 1 CSS px per px, so playback repaints only this veil, never the heat underneath.
  const liveCanvas = h('canvas', { class: 'map-canvas map-live', 'aria-hidden': 'true' });
  // tabindex -1: Chrome otherwise lets Tab stop on the overlay itself (a clipped box counts as a scroller)
  const overlay = s('svg', { class: 'map-overlay', tabindex: '-1' });
  const shapesSvg = s('svg', { class: 'map-shapes', 'aria-hidden': 'false', tabindex: '-1' });
  const shapesG = s('g');
  const extrasG = s('g', { class: 'map-extras', 'aria-hidden': 'true' });
  const routesG = s('g', { class: 'routes-layer' });   // phase 4: R's route candidates, under the current Route
  shapesSvg.append(routesG, shapesG, extrasG);
  const empty = h('p', { class: 'map-empty', hidden: true });
  const progress = h('div', { class: 'map-progress', 'aria-hidden': 'true' });
  const loading = h('p', { class: 'map-chip map-loading', role: 'status', hidden: true });
  const wheelHint = h('p', { class: 'map-chip map-wheel-hint', 'aria-hidden': 'true', hidden: true });
  // Controls and notes drawn over the map (layout revision): four corners and the top centre. The layer
  // comes first in the frame, so Tab goes frame → tools → zoom before the site marks of the map.
  const slot = (name) => h('div', { class: `map-ui-slot map-ui-${name}` });
  const ui = { tl: slot('tl'), tc: slot('tc'), bl: slot('bl'), br: slot('br') };
  ui.tc.append(loading);
  const uiLayer = h('div', { class: 'map-ui' }, ui.tl, ui.tc, ui.bl, ui.br, wheelHint);
  // the Sun and Earth directions at the view centre (terrain-style.js bodyDirection), drawn in a box around it
  const sky = s('svg', { class: 'map-sky', 'aria-hidden': 'true', width: 260, height: 260, viewBox: '-130 -130 260 260' });
  const el = h('div', {
    class: 'map-frame', tabindex: '0', role: 'group', 'aria-roledescription': 'map', 'data-tour': 'map',
    'aria-label': 'South pole map. Arrow keys move the crosshair, Shift with an arrow moves five cells, Enter picks the point or places a vertex. Plus and minus zoom, 0 resets.',
  }, uiLayer, canvas, liveCanvas, overlay, shapesSvg, sky, progress, empty);
  const hoverId = 'lsn-map-hover';
  const hover = createHoverCard(el, { id: hoverId });
  const shapes = createShapesLayer(shapesG, { onBest: (slot) => cb.onRegionBest(slot) });

  let sizePx = 0;                  // narrow layout: the square frame's side, CSS px
  // Frame geometry, CSS px (phase 4). The narrow layout is the phase 3 square (W = H = Sref = Sq, the view
  // centre in the middle). The big-map layout (≥ 1101 px, Map view) is the whole window: W × H, the view
  // centre C in the middle of the area below the top bar, and Sref the side of the square that holds the
  // map at zoom 1, chosen so the 80°S disc is the free height less 12 px. Sq is the square around C that
  // covers the whole window; the phase 3 square-frame functions (heat, overlay, shapes) draw in it, and
  // (ox, oy) is where it sits in the window.
  let geo = { big: false, W: 0, H: 0, Cx: 0, Cy: 0, Sref: 1, Sq: 1, ox: 0, oy: 0, dpr: 1 };
  let view = { cx: 0, cy: 0, zoom: 1 };
  let p = null;                    // the last update() parameters
  let base = null, baseKey = '', baseView = null;
  let heatCanvas = null;
  let heatAll = null;              // zoom > 1: the heat layers, shaded by the terrain before they go on the map
  let baseShade = null;            // the hillshade values behind `base`
  let baseGeo = null;              // the frame geometry `base` was made for
  let baseScale = 1;               // device px per CSS px of `base` (lower than the canvas's for a draft)
  let rs = 1;                      // device px per CSS px of the canvas being painted (paint() sets it)
  let lowCanvas = null;            // big layout, during a gesture: the frame painted at 1× and scaled up
  let refine = null;               // big layout: the full-resolution hillshade being built in slices
  let gestureEndAt = 0;
  // terrain styles (Topo, Real light, contours): the height field of the view and what is drawn from it
  let ts = { style: 'data', contours: false, arrows: true };
  let terr = null;                 // { key, view, sref, hs, w, h, g, hf, ready, range, interval, topo, real, contour }
  let terrJob = null;              // the slices that build it, or the Sun's light on it
  let lightJob = null;
  let light = null;                // { tMs, sun, earth, earthRangeKm }: the playhead's Sun and Earth
  let lightTimer = 0, lightAt = 0;
  let shownPic = null, shownContour = null;   // the last pictures on screen, kept while the next ones are built
  let colours = null;
  let drapeOnly = false, drapeHeat = true;   // drapeHeat false: the globe shows Live as real light, no heat colours
  let draw = initialDraw('select');
  let snap = null;                 // { target, px, py }
  let keyPt = null;                // keyboard crosshair, km
  let gesture = null;              // { kind: 'drag' | 'wheel' | 'pinch', ... }
  let wheelTimer = 0;
  let wheelHintTimer = 0;
  let pendingPick = 0;             // a click in Select waits for a possible double-click (zoom)
  let suppressClick = false;
  const pointers = new Map();

  // ---------- size and base ----------
  // km per CSS px, and the conversions between map km and frame CSS px, for the user's view
  const kpp = (v) => (2 * MAP_HALF_KM) / (v.zoom * geo.Sref);
  const toPxR = (v, x, y) => { const k = kpp(v); return [geo.Cx + (x - v.cx) / k, geo.Cy - (y - v.cy) / k]; };
  const toKmR = (v, px, py) => { const k = kpp(v); return [v.cx + (px - geo.Cx) * k, v.cy - (py - geo.Cy) * k]; };
  const boundsR = (v) => { const k = kpp(v); return { x0: v.cx - geo.Cx * k, x1: v.cx + (geo.W - geo.Cx) * k, y0: v.cy - (geo.H - geo.Cy) * k, y1: v.cy + geo.Cy * k }; };
  // the same view for the square-frame functions drawing in the Sq square
  const sqView = (v) => ({ cx: v.cx, cy: v.cy, zoom: (v.zoom * geo.Sref) / geo.Sq });
  const zoomAtR = (v, px, py, f) => {
    const [gx, gy] = toKmR(v, px, py);
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * f));
    const k = (2 * MAP_HALF_KM) / (z * geo.Sref);
    return clampView({ cx: gx - (px - geo.Cx) * k, cy: gy + (py - geo.Cy) * k, zoom: z });
  };
  const panByR = (v, dx, dy) => { const k = kpp(v); return clampView({ cx: v.cx - dx * k, cy: v.cy + dy * k, zoom: v.zoom }); };

  function measure() {
    const body = el.parentElement;
    if (!body) return false;
    const dprWanted = Math.min(2, window.devicePixelRatio || 1);
    if (p?.layout?.big) {
      // the whole window; the map centre sits in the middle of the area below the top bar
      const W = Math.round(window.innerWidth), H = Math.round(window.innerHeight), top = Math.round(p.layout.top ?? 64);
      const Sref = ((H - top - 12) * 2 * MAP_HALF_KM) / (2 * R80);
      // fix L4: the disc keeps its size; its top starts below the floating mode bar (layout.discTop, CSS px
      // from the window top), so the marks and labels on its rim are not under the bar
      const discR = (H - top - 12) / 2;
      // phase 5: an open detail sheet takes the right of the window; the map centres in what is left
      const Cx = Math.round((W - (p.layout.right ?? 0)) / 2), Cy = Math.max(top + (H - top) / 2, Math.round(p.layout.discTop ?? 0) + discR);
      const Sq = 2 * Math.max(Cx, W - Cx, Cy, H - Cy);
      // device pixels: the window at up to 2× (canvas sharpness), capped at about 5.2 million pixels
      const dpr = Math.min(dprWanted, Math.sqrt(5.2e6 / (W * H)));
      const same = geo.big && geo.W === W && geo.H === H && geo.Cx === Cx && geo.Cy === Cy && geo.Sref === Sref && geo.dpr === dpr && base;
      geo = { big: true, W, H, Cx, Cy, Sref, Sq, ox: Cx - Sq / 2, oy: Cy - Sq / 2, dpr };
      if (same) return false;
      sizePx = 0;
      el.style.width = ''; el.style.height = '';
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
      sizeLive();
      placeSvgs();
      baseKey = '';
      return true;
    }
    // The map fills the card's width (layout revision), up to 720 px. On a two-column screen it is also
    // held to the viewport height, so the whole map and the top of the Landing date ribbon fit on the
    // first screen: 124 px below the map is the card padding, the gap and the ribbon card's heading.
    let avail = body.clientWidth;
    if (window.matchMedia('(min-width: 1101px)').matches) {
      const top = el.getBoundingClientRect().top + window.scrollY;
      avail = Math.min(avail, Math.max(400, window.innerHeight - top - 124));
    }
    // in 20 px steps, so dragging the window edge recomputes the hillshade a few times, not every pixel
    const size = Math.max(240, Math.min(720, Math.floor(avail / 20) * 20));
    if (size === sizePx && base && !geo.big) return false;
    sizePx = size;
    geo = { big: false, W: size, H: size, Cx: size / 2, Cy: size / 2, Sref: size, Sq: size, ox: 0, oy: 0, dpr: dprWanted };
    const px = Math.round(size * dprWanted);
    canvas.width = px; canvas.height = px;
    canvas.style.width = `${size}px`; canvas.style.height = `${size}px`;
    el.style.width = `${size}px`; el.style.height = `${size}px`;
    sizeLive();
    placeSvgs();
    baseKey = '';
    return true;
  }

  function sizeLive() {
    liveCanvas.width = Math.round(geo.W); liveCanvas.height = Math.round(geo.H);
    liveCanvas.style.width = `${geo.W}px`; liveCanvas.style.height = `${geo.H}px`;
  }

  // ---------- phase 5: the live veil ----------
  // states: nowStates() of the 2 km grid at the playhead (bit 1 = Sun up). The cells without the Sun are
  // drawn black at half opacity. Use the same cached scalar interpolation as Live, including at 1×,
  // rather than scaling a grid of on/off squares. The Settings switch also applies to this veil.
  const live = { states: null, on: false };
  function setLive(states, on) {
    live.on = !!on;
    live.states = states;
    drawLive();
  }
  function drawLive() {
    const ctx = liveCanvas.getContext('2d');
    ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
    el.dataset.live = live.on && live.states && ts.style !== 'real' ? 'on' : 'off';
    if (!live.on || !live.states || !p || p.emptyText || ts.style === 'real') return;   // Real light shows the Sun itself
    const g = coarseGrid, k = kpp(view);
    ctx.save();
    const [cx, cy] = toPxR(view, 0, 0);
    ctx.beginPath(); ctx.arc(cx, cy, R80 / kpp(view), 0, 2 * Math.PI); ctx.clip();
    paintHeat(ctx, { mode: 'night', states: live.states, gridSize: g.size, cellKm: g.cellKm, halfKm: g.halfKm,
      inside: p.heat.coarseInside, colours: colours ??= readColours(), style: { smooth: !p.smoothOff },
      frame: { width: liveCanvas.width, height: liveCanvas.height, kmPerPx: k,
        cx: view.cx + (geo.W / 2 - geo.Cx) * k, cy: view.cy - (geo.H / 2 - geo.Cy) * k } });
    ctx.restore();
  }

  // The two SVG layers draw in the Sq square; in the big layout it is larger than the window and offset.
  function placeSvgs() {
    for (const svg of [overlay, shapesSvg]) {
      svg.style.left = geo.ox ? `${geo.ox}px` : '';
      svg.style.top = geo.oy ? `${geo.oy}px` : '';
      svg.style.width = geo.big ? `${geo.Sq}px` : '';
      svg.style.height = geo.big ? `${geo.Sq}px` : '';
    }
  }

  // A rectangle hillshade (T's rectangular form, phase 4): a band of `rows` canvas rows from row r0, so
  // the full resolution can be built a band at a time. ccx, ccy: km at the canvas centre; k: km per px.
  function shadeBand(dem, out, wd, hd, ccx, ccy, k, r0, rows) {
    const band = hillshade(dem, { width: wd, height: rows, kmPerPx: k, cx: ccx, cy: ccy + (hd / 2 - r0 - rows / 2) * k });
    out.set(band, r0 * wd);
  }
  function shadeImage(shade, wd, hd) {
    const c = new OffscreenCanvas(wd, hd);
    const cx = c.getContext('2d');
    const img = cx.createImageData(wd, hd);
    for (let i = 0; i < shade.length; i++) { const v = shade[i]; const o = 4 * i; img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255; }
    cx.putImageData(img, 0, 0);
    return c;
  }

  // The hillshade for the viewport from the coarsest loaded terrain fine enough for it (§4.1).
  // Big layout: a draft at 1 device px per CSS px first (fast), then the full resolution is built in
  // slices over the next frames and swapped in when done, so input never waits on it.
  function ensureBase() {
    const kd = kpp(view) / geo.dpr;
    const dem = pyramid.pick(kd, boundsR(view));
    // pyramid.version: a tile that arrives makes a new base (phase 4)
    const key = `${view.cx}|${view.cy}|${view.zoom}|${geo.W}x${geo.H}@${geo.dpr}|${geo.Sref}|${dem.kmPerPixel}|${pyramid.version ?? 0}`;
    if (key === baseKey) return false;
    const t0 = performance.now();
    if (refine) { cancelAnimationFrame(refine.raf); refine = null; }
    if (!geo.big) {
      const wd = canvas.width;
      const shade = hillshade(dem, { size: wd, halfKm: viewHalfKm(view), cx: view.cx, cy: view.cy });   // phase 3, unchanged
      if (!base || base.width !== wd || base.height !== wd) base = new OffscreenCanvas(wd, wd);
      paintBase(base.getContext('2d'), shade, wd);
      baseShade = shade; baseScale = geo.dpr;
    } else {
      const ccx = view.cx + (geo.W / 2 - geo.Cx) * kpp(view), ccy = view.cy - (geo.H / 2 - geo.Cy) * kpp(view);
      const draftScale = Math.min(1, geo.dpr);
      const wd = Math.round(geo.W * draftScale), hd = Math.round(geo.H * draftScale), k = kpp(view) / draftScale;
      const shade = new Uint8ClampedArray(wd * hd);
      shadeBand(dem, shade, wd, hd, ccx, ccy, k, 0, hd);
      base = shadeImage(shade, wd, hd);
      baseShade = shade; baseScale = draftScale;
      if (geo.dpr > draftScale) startRefine(dem, key, ccx, ccy, t0);
      else el.dataset.sharpMs = String(Math.round(performance.now() - t0));
    }
    baseKey = key; baseView = { ...view }; baseGeo = { ...geo };
    el.dataset.demKm = String(dem.kmPerPixel);
    el.dataset.shadeMs = String(Math.round(performance.now() - t0));
    return true;
  }

  function startRefine(dem, key, ccx, ccy, t0) {
    const wd = Math.round(geo.W * geo.dpr), hd = Math.round(geo.H * geo.dpr), k = kpp(view) / geo.dpr;
    const BAND = 96;   // rows per slice
    const bands = [];
    for (let r = 0; r < hd; r += BAND) bands.push([r, Math.min(BAND, hd - r)]);
    const job = { key, dem, wd, hd, k, ccx, ccy, tiles: bands, shade: new Uint8ClampedArray(wd * hd), raf: 0, t0, scale: geo.dpr };
    el.dataset.sharp = 'working';
    const step = () => {
      if (refine !== job) return;
      const until = performance.now() + 24;
      while (job.tiles.length && performance.now() < until) { const [r0, rows] = job.tiles.shift(); shadeBand(job.dem, job.shade, job.wd, job.hd, job.ccx, job.ccy, job.k, r0, rows); }
      if (job.tiles.length) { job.raf = requestAnimationFrame(step); return; }
      refine = null;
      if (baseKey !== job.key) return;
      base = shadeImage(job.shade, job.wd, job.hd);
      baseShade = job.shade; baseScale = job.scale;
      el.dataset.sharp = 'done';
      el.dataset.sharpMs = String(Math.round(performance.now() - job.t0));
      paint();
    };
    refine = job;
    job.raf = requestAnimationFrame(step);
  }

  // ---------- terrain styles (map/terrain-style.js) ----------
  // Topo, Real light and the contour lines are drawn from a height field of the view (heights per pixel), built
  // in slices over the next frames so input never waits on it; until a picture is ready the plain hillshade
  // shows. The picture is made after a gesture settles, never during one (the last one is moved and scaled
  // like the base). Topo is full device resolution; Real light and contours use half of it.
  function* sliced(n, perSlice, fn) {
    for (let r = 0; r < n; r += perSlice) { fn(r, Math.min(perSlice, n - r)); yield; }
  }
  function runJob(job, onDone) {
    const step = () => {
      if (job.dead) return;
      const until = performance.now() + 18;
      for (;;) {
        const r = job.gen.next();
        if (r.done) { onDone?.(); return; }
        if (performance.now() >= until) break;
      }
      job.raf = requestAnimationFrame(step);
    };
    job.raf = requestAnimationFrame(step);
  }
  function killJob(job) { if (job) { job.dead = true; cancelAnimationFrame(job.raf); } }

  function reportTerrain() {
    const t = terr;
    cb.onTerrain?.({
      style: ts.style, contours: ts.contours,
      working: !!t && !t.ready,
      range: t?.ready && ts.style === 'topo' ? t.range : null,
      interval: t?.ready && ts.contours ? t.interval : null,
    });
  }

  function stopTerrain() {
    killJob(terrJob); killJob(lightJob); terrJob = lightJob = null;
    clearTimeout(lightTimer);
    terr = null; shownPic = null; shownContour = null;
    reportTerrain();
  }

  function ensureTerrain() {
    if (!p || !geo.W || !pyramid) return;
    if (ts.style === 'data' && !ts.contours) { if (terr || terrJob) stopTerrain(); return; }
    const hs = ts.style === 'topo' ? 1 : 0.5;
    const dem = pyramid.pick(kpp(view) / (geo.dpr * hs), boundsR(view));
    if (!dem) return;
    const key = `${view.cx}|${view.cy}|${view.zoom}|${geo.W}x${geo.H}@${geo.dpr}|${geo.Sref}|${dem.kmPerPixel}|${pyramid.version ?? 0}|${hs}`;
    if (terr?.key === key) { if (terr.ready && afterHeights(terr)) paint(); return; }
    killJob(terrJob); killJob(lightJob); lightJob = null;
    const w = Math.max(3, Math.round(geo.W * geo.dpr * hs)), hgt = Math.max(3, Math.round(geo.H * geo.dpr * hs));
    const k0 = kpp(view);
    const t = {
      key, view: { ...view }, sref: geo.Sref, hs, w, h: hgt, dem, hf: new Float32Array(w * hgt), ready: false,
      g: { width: w, height: hgt, kmPerPx: k0 / (geo.dpr * hs), cx: view.cx + (geo.W / 2 - geo.Cx) * k0, cy: view.cy - (geo.H / 2 - geo.Cy) * k0 },
      range: null, interval: 1, topo: null, real: null, contour: null, t0: performance.now(),
    };
    terr = t;
    const job = { dead: false, raf: 0 };
    terrJob = job;
    job.gen = (function* () {
      yield* sliced(hgt, Math.max(8, Math.floor(70000 / w)), (r, n) => heightBand(dem, t.hf, t.g, r, n));
      t.range = heightRange(t.hf);
      t.interval = contourInterval(typicalGradient(t.hf, w, hgt) * geo.dpr * hs, 16);   // metres per CSS px × 16 px
      yield;
      if (ts.style === 'topo' && t.range) {
        const img = new Uint8ClampedArray(w * hgt * 4);
        yield* sliced(hgt, Math.max(8, Math.floor(120000 / w)), (r, n) => topoBand(t.hf, w, hgt, t.g.kmPerPx, t.range, img, r, n));
        const c = new OffscreenCanvas(w, hgt);
        c.getContext('2d').putImageData(new ImageData(img, w, hgt), 0, 0);
        t.topo = { canvas: c };
      }
    })();
    reportTerrain();
    runJob(job, () => {
      t.ready = true;
      terrJob = null;
      el.dataset.terrainMs = String(Math.round(performance.now() - t.t0));
      afterHeights(t);
      reportTerrain();
      paint();
    });
  }

  // the height field is ready: contours for it, and the Sun's light
  function afterHeights(t) {
    let changed = false;
    if (ts.contours && (!t.contour || t.contour.style !== ts.style)) { buildContours(t); changed = true; }
    if (ts.style === 'real') startLight();
    return changed;
  }

  function buildContours(t) {
    const { w, h: hgt, hs, hf, interval } = t;
    if (!t.contour || t.contour.interval !== interval) {
      const dpr = geo.dpr;
      const segs = contourSegments(hf, w, hgt, hs >= 1 ? 2 : 1, interval);
      const labels = contourLabels(segs, hf, w, hgt, interval, { gapPx: 170 * dpr * hs, margin: 28 * dpr * hs });
      t.contour = { segs, labels, interval, style: null, canvas: null };
    }
    const c = t.contour, { segs, labels } = c;
    const dpr = geo.dpr, sc = 1 / hs;
    const cv = new OffscreenCanvas(Math.round(geo.W * dpr), Math.round(geo.H * dpr));
    const cx = cv.getContext('2d');
    const [minor, index, halo, ink] = CONTOUR_INK[ts.style];
    const lines = c.lines ??= contourLines(segs);
    cx.lineJoin = 'round';
    for (const isIndex of [false, true]) {
      cx.beginPath();
      for (let i = 0; i < lines.level.length; i++) {
        if ((lines.level[i] % 5 === 0) !== isIndex) continue;
        const a = lines.start[i], b = lines.start[i + 1];
        cx.moveTo(lines.pts[2 * a] * sc, lines.pts[2 * a + 1] * sc);
        for (let q = a + 1; q < b; q++) cx.lineTo(lines.pts[2 * q] * sc, lines.pts[2 * q + 1] * sc);
      }
      cx.lineWidth = (isIndex ? 1.6 : 0.9) * dpr;
      cx.strokeStyle = isIndex ? index : minor;
      cx.stroke();
    }
    cx.font = `500 ${Math.round(11 * dpr)}px system-ui, sans-serif`;
    cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.lineJoin = 'round';
    for (const l of labels) {
      cx.save();
      cx.translate(l.x * sc, l.y * sc);
      cx.rotate(l.angle);
      cx.lineWidth = 3.5 * dpr; cx.strokeStyle = halo; cx.strokeText(l.text, 0, 0);
      cx.fillStyle = ink; cx.fillText(l.text, 0, 0);
      cx.restore();
    }
    cx.getImageData(0, 0, 1, 1);   // the browser draws lazily; do it now, not in the middle of a pan
    c.canvas = cv; c.style = ts.style;
  }

  // Real light: the Sun's light and cast shadows on the height field, a quick pass at a quarter of its
  // resolution first, then the full one
  function startLight() {
    const t = terr;
    if (ts.style !== 'real' || !t?.ready || !light) return;
    const sunKey = light.sun.map((v) => v.toFixed(5)).join(',');
    if (t.real?.sunKey === sunKey && t.real.done) return;
    killJob(lightJob);
    const { w, h: hgt, hf, g, dem } = t;
    const real = t.real ??= { out: new Uint8ClampedArray(w * hgt), rgba: new Uint8ClampedArray(w * hgt * 4), canvas: new OffscreenCanvas(w, hgt), sunKey: '', done: false };
    real.done = false;
    const sample = dem.sample ?? ((x, y) => { const v = dem.heightAtXY(x, y); return v === null ? NaN : v; });
    const sun = light.sun;
    const gain = exposureFor(bodyDirection(sun, view.cx, view.cy).elDeg);
    const job = { dead: false, raf: 0 };
    lightJob = job;
    const show = () => {
      const o = real.out, d = real.rgba;
      for (let i = 0, j = 0; i < o.length; i++, j += 4) { d[j] = d[j + 1] = d[j + 2] = o[i]; d[j + 3] = 255; }
      real.canvas.getContext('2d').putImageData(new ImageData(d, w, hgt), 0, 0);
    };
    const t0 = performance.now();
    job.gen = (function* () {
      let rows = 8;
      for (const stride of [4, 1]) {
        for (let r = 0; r < hgt;) {
          const t1 = performance.now();
          const n = Math.min(rows, hgt - r);
          lightBand(hf, w, hgt, g, sun, sample, gain, real.out, r, n, stride);
          r += n;
          const dt = performance.now() - t1;
          rows = Math.max(4, Math.min(160, Math.round((rows * 16) / Math.max(1, dt) / 4) * 4));
          yield;
        }
        show();
        if (stride === 4) { real.sunKey = sunKey; paint(); }
      }
    })();
    runJob(job, () => {
      lightJob = null;
      real.done = true; real.sunKey = sunKey;
      el.dataset.lightMs = String(Math.round(performance.now() - t0));
      paint();
    });
  }

  function styledPicture() {
    if (ts.style === 'data') return null;
    const t = terr;
    const c = t && (ts.style === 'topo' ? t.topo : t.real);
    if (c?.canvas && (ts.style === 'topo' || t.real.sunKey)) shownPic = { canvas: c.canvas, view: t.view, sref: t.sref, kind: ts.style };
    return shownPic?.kind === ts.style ? shownPic : null;
  }
  function contourPicture() {
    const c = terr?.contour;
    if (c?.canvas && c.style === ts.style) shownContour = { canvas: c.canvas, view: terr.view, sref: terr.sref };
    return shownContour;
  }

  // ---------- the Sun and Earth at the view centre ----------
  function drawSky() {
    clear(sky);
    const on = ts.arrows && light && p && !p.emptyText && geo.W;
    sky.style.display = on ? '' : 'none';
    if (!on) return;
    sky.style.left = `${geo.Cx - 130}px`; sky.style.top = `${geo.Cy - 130}px`;
    const arrow = (cls, d, len, label, drop = 0) => {
      if (!(Math.abs(d.dx) + Math.abs(d.dy) > 0)) return;
      const x = d.dx * len, y = -d.dy * len, a = Math.atan2(y, x), hd = 8;
      const side = x >= 0 ? 1 : -1;
      sky.append(
        s('line', { class: `sky-line ${cls}`, x1: 0, y1: 0, x2: x - Math.cos(a) * hd * 0.6, y2: y - Math.sin(a) * hd * 0.6 }),
        s('path', { class: `sky-head ${cls}`, d: `M${x} ${y}L${x - Math.cos(a - 0.4) * hd} ${y - Math.sin(a - 0.4) * hd}L${x - Math.cos(a + 0.4) * hd} ${y - Math.sin(a + 0.4) * hd}Z` }),
        s('text', { class: `sky-text ${cls}`, x: x + side * 8, y: y + 4 + drop, 'text-anchor': side > 0 ? 'start' : 'end' }, label));
    };
    const sd = bodyDirection(light.sun, view.cx, view.cy), ed = bodyDirection(light.earth, view.cx, view.cy, light.earthRangeKm);
    sky.append(s('circle', { class: 'sky-dot', r: 3 }));
    if (ts.style === 'real' && sd.elDeg > 0) {
      const sh = { dx: -sd.dx, dy: -sd.dy };
      const x = sh.dx * 44, y = -sh.dy * 44;
      sky.append(s('line', { class: 'sky-line sky-shadow', x1: 0, y1: 0, x2: x, y2: y }), s('text', { class: 'sky-text sky-shadow', x: x + (x >= 0 ? 6 : -6), y: y + 4, 'text-anchor': x >= 0 ? 'start' : 'end' }, 'Shadows'));
    }
    arrow('sky-sun', sd, 78, `Sun el ${degText(sd.elDeg)}`);
    // the Earth's label drops below its tip when the two tips are close, so the labels do not overlap
    arrow('sky-earth', ed, 62, `Earth el ${degText(ed.elDeg)}`, Math.hypot(sd.dx * 78 - ed.dx * 62, sd.dy * 78 - ed.dy * 62) < 40 ? 15 : 0);
    sky.append(s('text', { class: 'sky-note', x: 0, y: 20, 'text-anchor': 'middle' }, 'view centre'));
  }

  // ---------- painting ----------
  // All painting is in device px of the canvas being drawn: rs per CSS px.
  function clipToMap(ctx) {
    const [cx, cy] = toPxR(view, 0, 0);
    ctx.beginPath();
    ctx.arc(cx * rs, cy * rs, (R80 / kpp(view)) * rs, 0, 2 * Math.PI);
    ctx.clip();
  }

  function drawBase(ctx) {
    if (!base) return;
    drawLayerImage(ctx, base, baseView, baseGeo?.Sref);
  }

  // A picture made for the view `iv` (frame side `sref`), drawn for the live view.
  function drawLayerImage(ctx, img, iv, sref) {
    if (sameView(iv, view) && sref === geo.Sref) {
      if (img.width === Math.round(geo.W * rs)) ctx.drawImage(img, 0, 0);
      else { ctx.imageSmoothingEnabled = true; ctx.drawImage(img, 0, 0, geo.W * rs, geo.H * rs); }
      return;
    }
    // during a gesture: the last picture, scaled and moved to the live viewport (CSS px, then × rs)
    const kb = kpp(iv), k = kpp(view), sc = kb / k;
    const dx = geo.Cx + (iv.cx - view.cx) / k - geo.Cx * sc;
    const dy = geo.Cy - (iv.cy - view.cy) / k - geo.Cy * sc;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, dx * rs, dy * rs, geo.W * sc * rs, geo.H * sc * rs);
  }

  function layerArgs(l, mode) {
    const g = l.tier.grid;
    const a = { gridSize: g.size, inside: l.tier.inside, colours, filtered: l.filtered ?? undefined };
    if (mode === 'change') return { ...a, planned: l.job.both, alt: l.alt?.both, rows: Math.min(l.job.rows, l.alt?.rows ?? 0), rect: l.job.rect };
    return { ...a, values: mode === 'score' ? l.score : l.job[mode], rows: l.job.rows, rect: l.job.rect };
  }

  function paintLayers(ctx) {
    const { mode, heat } = p;
    // the heat functions draw in the Sq square: in device px, at the square's offset in the window
    const px = Math.round(geo.Sq * rs);
    const sv = sqView(view);
    ctx.save();
    if (geo.big && mode !== 'now') ctx.translate(geo.ox * rs, geo.oy * rs);
    const style = { ...deepHeatStyle(view.zoom, { edgePx: rs }), ...(p.smoothOff ? { smooth: false } : {}) };
    try {
      if (mode === 'now') {
        // Live changes every simulated hour. Cull to the actual rectangular canvas, not its enclosing
        // Sq square: smoothing offscreen rows at 2× costs a frame on the reduced-resolution player.
        const k = kpp(view);
        const frame = { width: Math.round(geo.W * rs), height: Math.round(geo.H * rs), kmPerPx: k / rs,
          cx: view.cx + (geo.W / 2 - geo.Cx) * k, cy: view.cy - (geo.H / 2 - geo.Cy) * k };
        // fix H2.3: zoomed in, the 1 km states of the viewport (heatplan nowLayer) when main passes them
        const nl = heat.nowLayer;
        if (nl && !nl.full) {
          const g = nl.tier.grid;
          paintHeat(ctx, { mode, states: nl.states, gridSize: g.size, canvasSize: px, inside: nl.tier.inside, colours, rect: nl.rect,
            frame, cellKm: g.cellKm, halfKm: g.halfKm, style });
          return;
        }
        if (!heat.states) return;
        const args = { mode, states: heat.states, gridSize: coarseGrid.size, canvasSize: px, inside: heat.coarseInside, colours };
        paintHeat(ctx, { ...args, frame, cellKm: coarseGrid.cellKm, halfKm: coarseGrid.halfKm, style });
        return;
      }
      const ls = heat.layers ?? [];
      const [coarse, fine] = ls;
      if (mode === 'change' && coarse && !coarse.alt) return;
      const geoArgs = (l) => ({ view: sv, cellKm: l.tier.grid.cellKm, halfKm: l.tier.grid.halfKm, canvasSize: px, style });
      if (coarse && !(fine && fine.job.done && fine.alt?.done !== false)) {
        const a = layerArgs(coarse, mode);
        if (fine) {
          // the 2 km layer under the 1 km rows not finished yet
          const wd = Math.round(geo.W * rs), hd = Math.round(geo.H * rs);
          if (!heatCanvas || heatCanvas.width !== wd || heatCanvas.height !== hd) heatCanvas = new OffscreenCanvas(wd, hd);
          const hc = heatCanvas.getContext('2d');
          hc.setTransform(1, 0, 0, 1, 0, 0);
          hc.clearRect(0, 0, wd, hd);
          if (geo.big) hc.translate(geo.ox * rs, geo.oy * rs);
          paintHeat(hc, { mode, ...a, rect: undefined, ...geoArgs(coarse) });
          hc.setTransform(1, 0, 0, 1, 0, 0);
          const r = fine.job.rect, g = fine.tier.grid;
          const rows = mode === 'change' ? Math.min(fine.job.rows, fine.alt?.rows ?? 0) : fine.job.rows;
          if (rows > 0) {
            const [x0, y0] = toPxR(view, -g.halfKm + r.i0 * g.cellKm, g.halfKm - r.j0 * g.cellKm);
            const [x1, y1] = toPxR(view, -g.halfKm + (r.i1 + 1) * g.cellKm, g.halfKm - (r.j0 + rows) * g.cellKm);
            const d = rs;
            hc.clearRect(Math.floor(x0 * d), Math.floor(y0 * d), Math.ceil((x1 - x0) * d) + 1, Math.ceil((y1 - y0) * d) + 1);
          }
          ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(heatCanvas, 0, 0);
          ctx.restore();
        } else {
          paintHeat(ctx, { mode, ...a, rect: undefined, ...geoArgs(coarse) });
        }
      }
      if (fine) paintHeat(ctx, { mode, ...layerArgs(fine, mode), ...geoArgs(fine) });
    } finally {
      ctx.restore();
    }
  }

  // Zoomed in, a heat cell spans several screen pixels and a flat colour would hide the terrain under it
  // (review UI I1). So above zoom 1 the heat colour is shaded by the hillshade: lighter where the ground
  // faces the light, darker where it faces away, around the colour itself, so the five legend steps keep
  // their mean brightness. The effect fades in between zoom 1 and 2; at zoom 1 nothing changes.
  const RELIEF_GAIN = 3.5;          // grey levels of heat colour per grey level of hillshade
  const SHADE_FLAT = 26;            // hillshade of flat ground: 8 + 36 × sin 30°
  function reliefAmount() {
    return Math.max(0, Math.min(1, view.zoom - 1));
  }

  function shadeHeat(hctx, t) {
    if (!baseShade || !baseView || !baseGeo || !base) return;
    const wd = Math.round(geo.W * rs), hd = Math.round(geo.H * rs);
    const bw = base.width, bh = base.height;
    if (baseShade.length !== bw * bh) return;
    const img = hctx.getImageData(0, 0, wd, hd);
    const d = img.data;
    // the hillshade was computed for baseView at baseScale; map each live pixel back to it (a gesture
    // moves the view; a draft base has fewer pixels). In CSS px: base = C + (v − bv)/kb + (live − C)·k/kb.
    const kb = kpp(baseView), k = kpp(view), r = k / kb, bs = bw / geo.W;
    const ax = bs * (geo.Cx + (view.cx - baseView.cx) / kb - geo.Cx * r), stepX = (bs * r) / rs;
    const ay = bs * (geo.Cy - (view.cy - baseView.cy) / kb - geo.Cy * r), stepY = (bs * r) / rs;
    const g = RELIEF_GAIN * t;
    for (let y = 0; y < hd; y++) {
      const by = Math.floor(ay + (y + 0.5) * stepY);
      if (by < 0 || by >= bh) continue;
      for (let x = 0; x < wd; x++) {
        const o = 4 * (y * wd + x);
        if (d[o + 3] === 0) continue;
        if (d[o] === 0 && d[o + 1] === 0 && d[o + 2] === 0) continue;   // a filtered-out cell: dimmed, not coloured
        const bx = Math.floor(ax + (x + 0.5) * stepX);
        if (bx < 0 || bx >= bw) continue;
        const off = g * (baseShade[by * bw + bx] - SHADE_FLAT);
        d[o] += off; d[o + 1] += off; d[o + 2] += off;   // Uint8ClampedArray clamps to 0–255
      }
    }
    hctx.putImageData(img, 0, 0);
  }

  // The official PSR outline layer (phase 4), cached per view: drawn at 1 device px per CSS px in the big
  // layout (it is an outline and a hatch, so that is plenty) and at the canvas's scale otherwise; during a
  // gesture the last one is moved and scaled like the base.
  let psrCache = null;   // { key, canvas, view, scale }
  function drawPsr(ctx) {
    const scale = geo.big ? 1 : geo.dpr;
    const key = `${view.cx}|${view.cy}|${view.zoom}|${geo.W}x${geo.H}|${scale}`;
    if (!gesture && psrCache?.key !== key) {
      const wd = Math.round(geo.W * scale), hd = Math.round(geo.H * scale), k = kpp(view) / scale;
      const c = psrCache?.canvas && psrCache.canvas.width === wd && psrCache.canvas.height === hd ? psrCache.canvas : new OffscreenCanvas(wd, hd);
      const cc = c.getContext('2d');
      cc.clearRect(0, 0, wd, hd);
      const geom = { width: wd, height: hd, kmPerPx: k, cx: view.cx + (geo.W / 2 - geo.Cx) * kpp(view), cy: view.cy - (geo.H / 2 - geo.Cy) * kpp(view) };
      paintPsr(cc, p.psrLayer, geom, { colour: colours.both, minPx: Math.round(3 * scale) });
      psrCache = { key, canvas: c, view: { ...view }, scale };
    }
    if (!psrCache) return;
    const kb = kpp(psrCache.view), k = kpp(view), sc = kb / k;
    const dx = geo.Cx + (psrCache.view.cx - view.cx) / k - geo.Cx * sc;
    const dy = geo.Cy - (psrCache.view.cy - view.cy) / k - geo.Cy * sc;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(psrCache.canvas, dx * rs, dy * rs, geo.W * sc * rs, geo.H * sc * rs);
  }

  // Paints the frame. Big layout, during a gesture: at 1 device px per CSS px into a side canvas that is
  // then scaled up, so the redraw keeps up with the pointer; the sharp frame follows when it ends.
  function paint() {
    if (!p) return;
    const tp = performance.now();
    const main = canvas.getContext('2d');
    // phase 5: while the playhead runs over a Live map, paint at 1 device px per CSS px too (p.lowRes)
    const low = geo.big && (gesture || (p.lowRes && !globalThis.__lsnFullRes)) && geo.dpr > 1;   // __lsnFullRes: for the frame-rate comparison in G.md only
    rs = low ? 1 : geo.dpr;
    const wd = Math.round(geo.W * rs), hd = Math.round(geo.H * rs);
    let ctx = main;
    if (low) {
      if (!lowCanvas || lowCanvas.width !== wd || lowCanvas.height !== hd) lowCanvas = new OffscreenCanvas(wd, hd);
      ctx = lowCanvas.getContext('2d');
    }
    colours ??= readColours();
    ctx.clearRect(0, 0, wd, hd);
    ctx.save();
    clipToMap(ctx);
    // drape only (the Map's 3D globe draws the terrain itself, ui/globemap.js): no base, no styled terrain, no
    // contours; the heat at the strength it has over the terrain style, on a clear canvas
    if (!drapeOnly) drawBase(ctx);
    // Topo and Real light: the styled terrain over the plain hillshade (which stays under it while the picture
    // is built), the heat colours translucent on top
    const pic = drapeOnly ? null : styledPicture();
    if (pic) drawLayerImage(ctx, pic.canvas, pic.view, pic.sref);
    if (!p.emptyText && drapeOnly) {
      if (drapeHeat) { ctx.globalAlpha = ts.style === 'data' ? 1 : HEAT_ON_TERRAIN; paintLayers(ctx); ctx.globalAlpha = 1; }
    } else if (!p.emptyText) {
      const t = reliefAmount();
      if (t === 0 && !pic) paintLayers(ctx);
      else {
        if (!heatAll || heatAll.width !== wd || heatAll.height !== hd) heatAll = new OffscreenCanvas(wd, hd);
        const hctx = heatAll.getContext('2d', { willReadFrequently: true });
        hctx.clearRect(0, 0, wd, hd);
        paintLayers(hctx);
        const style = globalThis.__lsnHeatStyle;   // 'alpha' and 'flat' exist only for the comparison shots in G.md
        if (pic) ctx.globalAlpha = HEAT_ON_TERRAIN;
        else if (style === 'alpha') ctx.globalAlpha = 1 - 0.4 * t;
        else if (style !== 'flat') shadeHeat(hctx, t);
        ctx.drawImage(heatAll, 0, 0);
        ctx.globalAlpha = 1;
      }
    }
    const cpic = ts.contours && !drapeOnly ? contourPicture() : null;
    if (cpic) drawLayerImage(ctx, cpic.canvas, cpic.view, cpic.sref);
    if (p.psrLayer) drawPsr(ctx);
    el.dataset.psr = p.psrLayer ? 'on' : 'off';
    ctx.restore();
    if (low) {
      main.clearRect(0, 0, canvas.width, canvas.height);
      main.imageSmoothingEnabled = true;
      main.drawImage(lowCanvas, 0, 0, canvas.width, canvas.height);
    }
    rs = geo.dpr;
    el.dataset.paintMs = String(Math.round(performance.now() - tp));   // the last paint, for the timing notes
  }

  // ---------- annotation and shapes ----------
  function viewTargets() {
    const out = [];
    const add = (t, xKm, yKm) => {
      const [x, y] = toPxR(view, xKm, yKm);
      if (x >= 0 && y >= 0 && x <= geo.W && y <= geo.H) out.push({ ...t, xKm, yKm, px: x, py: y });
    };
    for (const site of sites) {
      if (!(site.latDeg <= -80)) continue;
      const [x, y] = toXY(site.latDeg, site.lonDeg);
      add({ id: `site:${site.id}`, kind: 'site', name: site.name, site }, x, y);
    }
    (p?.top ?? []).forEach((cell, n) => {
      const c = coarseGrid.cellCenter(cell);
      add({ id: `top:${n + 1}`, kind: 'top', name: `Best cell ${n + 1}`, cell }, c.xKm, c.yKm);
    });
    for (const slot of ['A', 'B']) {
      const b = p?.regionBest?.[slot];
      if (b && p.regions?.[slot]) add({ id: `region-best:${slot}`, kind: 'region-best', name: `Best cell in region ${slot}`, slot }, b.xKm, b.yKm);
    }
    const ct = closeTarget(draw);
    if (ct) add(ct, ct.xKm, ct.yKm);
    return out;
  }

  function drawOverlay() {
    if (!p) return;
    const narrowFull = !geo.big && isFull(view);
    // big layout: labels keep clear of the floating chrome (window rects → the Sq square's px)
    const avoid = geo.big ? (cb.avoid?.() ?? []).map((r) => ({ x: r.left - geo.ox, y: r.top - geo.oy, w: r.width, h: r.height })) : undefined;
    keepFocus(overlay, () => renderOverlay(overlay, {
      sizePx: geo.Sq, halfKm: MAP_HALF_KM, features, sites,
      selected: p.selected, alternative: p.alternative, top: p.top ?? [], grid: coarseGrid,
      cursorCell: null, onSite: (site) => { if (p.tool === 'select') cb.onPick({ site }); },
      view: narrowFull ? undefined : sqView(view), avoid,
    }));
    drawSky();
    cb.onScale?.(kpp(view));
    // zoomed in, graticule lines and circles reach far past the frame; at zoom 1 nothing does
    overlay.style.overflow = narrowFull ? '' : 'hidden';
    for (const m of overlay.querySelectorAll('.site-mark')) m.setAttribute('aria-describedby', hoverId);
    drawShapes();
  }

  function drawShapes() {
    if (!p) return;
    const S = geo.Sq;
    shapesSvg.setAttribute('viewBox', `0 0 ${S} ${S}`);
    shapesSvg.setAttribute('width', S);
    shapesSvg.setAttribute('height', S);
    const rp = p.routePlan;
    drawRoutes(routesG, {
      routes: rp?.plan?.routes ?? null, selected: rp?.selected ?? null, hovered: rp?.hovered ?? null,
      waypoints: rp?.plan?.waypoints ?? rp?.points ?? null,
      traps: rp?.plan?.traps ?? null,
      drive: rp?.energy?.drive ?? null,
      havens: rp?.havens?.result ?? null,
      landed: rp?.landed ?? null,
      landing: rp?.landing ?? null,
      slope: rp?.routeColour !== 'plain',
      auto: rp?.auto?.draw ?? null,
      coverage: rp?.stationOff ? null : rp?.coverage ?? null,
      toPx: (x, y) => toPxView(sqView(view), S, x, y),
      width: S, height: S,
    });
    // the shapes SVG draws in the Sq square: frame px less the square's offset
    keepFocus(shapesG, () => shapes.update({
      view: sqView(view), sizePx: S, regions: p.regions ?? {}, activeSlot: p.slot ?? 'A', draw: p.tool === 'select' ? null : draw,
      snap: snap ? { px: snap.px - geo.ox, py: snap.py - geo.oy } : null, route: p.route ?? null,
      best: p.regionBest ?? {}, profileAt: p.profileAt ?? null,
    }));
    clear(extrasG);
    if (snap) {
      const sx = snap.px - geo.ox, sy = snap.py - geo.oy;
      extrasG.append(s('path', { class: 'snap-cross', d: `M${sx - 6} ${sy}h12M${sx} ${sy - 6}v12` }));
    }
    if (keyPt && document.activeElement === el && (el.matches(':focus-visible') || el.classList.contains('has-key'))) {
      const [rx, ry] = toPxR(view, keyPt[0], keyPt[1]);
      const x = rx - geo.ox, y = ry - geo.oy;
      const half = Math.max(4, (p.keyGrid.cellKm / kpp(view)) / 2);
      extrasG.append(s('rect', { class: 'key-cursor', x: x - half - 3, y: y - half - 3, width: 2 * half + 6, height: 2 * half + 6 }));
    }
  }

  // ---------- hover ----------
  function showHover(target, px, py) {
    const [gx, gy] = target ? [target.xKm, target.yKm] : toKmR(view, px, py);
    const d = cb.describe(gx, gy, target);
    if (target && d?.card) hover.update({ ...d.card, px, py, sizePx: geo.W, width: geo.W, height: geo.H });
    else hover.update(null);
    return d;
  }

  function setSnap(t) {
    const prev = snap?.target?.id ?? null;
    snap = t ? { target: t, px: t.px, py: t.py } : null;
    el.classList.toggle('is-snapped', !!snap);
    if ((snap?.target?.id ?? null) !== prev) drawShapes();
  }

  // ---------- viewport ----------
  function setView(v, final) {
    const t0 = performance.now();
    view = clampView(v);
    paint();
    drawLive();
    const t1 = performance.now();
    drawOverlay();
    el.dataset.moveMs = `${Math.round(t1 - t0)}+${Math.round(performance.now() - t1)}`;   // paint + overlay, for the timing notes
    if (final) endGesture();
  }

  function endGesture() {
    gesture = null;
    clearTimeout(wheelTimer);
    const t0 = performance.now();
    gestureEndAt = t0;
    cb.onViewport({ ...view });
    // the parent re-renders and calls update(); make sure the redraw happened (in the big layout at
    // dpr > 1 this is the draft; data-sharp says when the full resolution is in)
    if (ensureBase()) paint();
    else paint();
    ensureTerrain();
    el.dataset.redrawMs = String(Math.round(performance.now() - t0));
  }

  function zoomBy(factor, px = geo.Cx, py = geo.Cy) {
    stopFly();
    setView(zoomAtR(view, px, py, factor), true);
  }

  // fix L3: a programmatic move eases to its target (about half a second; at once with reduced motion).
  // It runs as a gesture, so the frame paints the fast way and the parent hears of it once, at the end.
  // Any wheel, press or key stops it where it is.
  let fly = null;
  function stopFly() {
    if (!fly) return;
    cancelAnimationFrame(fly.raf);
    fly = null;
    endGesture();
  }
  function flyTo(target, ms = 520) {
    stopFly();
    const to = clampView(target);
    if (!p || ms <= 0 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setView(to, true); return; }
    const from = { ...view }, t0 = performance.now();
    // the centre moves in step with the scale (uniform on screen); zoom is interpolated geometrically
    const a = 1 / from.zoom, b = 1 / to.zoom;
    gesture = { kind: 'fly' };
    setSnap(null); hover.update(null);
    const step = (now) => {
      if (!fly) return;
      const t = Math.min(1, (now - t0) / ms), e = 1 - (1 - t) ** 3;
      const z = from.zoom * (to.zoom / from.zoom) ** e;
      const w = Math.abs(a - b) > 1e-9 ? (a - 1 / z) / (a - b) : e;
      if (t >= 1) { fly = null; setView(to, true); return; }
      setView({ cx: from.cx + (to.cx - from.cx) * w, cy: from.cy + (to.cy - from.cy) * w, zoom: z }, false);
      fly.raf = requestAnimationFrame(step);
    };
    fly = { raf: requestAnimationFrame(step) };
  }
  // The view that fits a box (km) into the frame less the insets (CSS px), centred in what is left.
  function viewFor(box, insets = {}, maxZoom = 24) {
    const { left = 16, right = 16, top = 16, bottom = 16 } = insets;
    const aw = Math.max(80, geo.W - left - right), ah = Math.max(80, geo.H - top - bottom);
    const bw = Math.max(2, box.x1 - box.x0), bh = Math.max(2, box.y1 - box.y0);
    const z = Math.max(MIN_ZOOM, Math.min(maxZoom, MAX_ZOOM, (2 * MAP_HALF_KM) / geo.Sref * Math.min(aw / bw, ah / bh)));
    const k = (2 * MAP_HALF_KM) / (z * geo.Sref);
    const ax = left + aw / 2, ay = top + ah / 2;
    return clampView({ cx: (box.x0 + box.x1) / 2 - (ax - geo.Cx) * k, cy: (box.y0 + box.y1) / 2 + (ay - geo.Cy) * k, zoom: z });
  }

  // Pointer capture keeps a drag going outside the frame; a pointer the browser does not know (a
  // synthetic event) cannot be captured, which is harmless.
  function capture(id) {
    try { el.setPointerCapture(id); } catch { /* not an active pointer */ }
  }

  function local(e) {
    const r = el.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * geo.W, ((e.clientY - r.top) / r.height) * geo.H];
  }

  function drawEvent(type, px, py, extra = {}) {
    const t = snap?.target;
    const [x, y] = t ? [t.xKm, t.yKm] : toKmR(view, px, py);
    return { type, xKm: x, yKm: y, px, py, kmPerPx: kpp(view), ...extra };
  }

  function applyDraw(event) {
    const was = draw.points.length > 0 || !!draw.anchor;
    const r = drawReduce(draw, event);
    draw = r.state;
    const now = draw.points.length > 0 || !!draw.anchor;
    if (r.completed) { setSnap(null); hover.update(null); cb.onShape(r.completed); }
    // a figure-eight outline is refused (its area would cancel out); say why, and clear it on the next try
    if (r.rejected) { setSnap(null); hover.update(null); cb.onDrawNote?.(CROSSES); }
    else if (r.completed || (!was && now)) cb.onDrawNote?.(null);
    if (was !== now) cb.onDrawing(now);
    drawShapes();
  }

  const MAC = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');
  // A plain wheel scrolls the page (layout revision); ⌘ or Ctrl with the wheel zooms, and a trackpad
  // pinch arrives as a Ctrl wheel. Over the map a plain wheel shows how to zoom, for 1.5 s.
  function showWheelHint() {
    wheelHint.textContent = MAC ? 'Hold ⌘ and scroll to zoom' : 'Hold Ctrl and scroll to zoom';
    wheelHint.hidden = false;
    wheelHint.classList.remove('is-fading');
    clearTimeout(wheelHintTimer);
    wheelHintTimer = setTimeout(() => {
      wheelHint.classList.add('is-fading');
      wheelHintTimer = setTimeout(() => { wheelHint.hidden = true; wheelHint.classList.remove('is-fading'); }, 300);
    }, 1500);
  }

  const onControl = (e) => Boolean(e.target?.closest?.('.map-ui-ctl'));

  el.addEventListener('wheel', (e) => {
    if (!p) return;
    // the big-map layout does not scroll, so there the plain wheel zooms (phase 4)
    if (!(e.ctrlKey || e.metaKey) && !geo.big) { showWheelHint(); return; }
    e.preventDefault();
    stopFly();
    const [px, py] = local(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    gesture = { kind: 'wheel' };
    setSnap(null); hover.update(null);
    setView(zoomAtR(view, px, py, Math.exp(-dy * 0.002)), false);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(endGesture, WHEEL_IDLE_MS);
  }, { passive: false });

  el.addEventListener('pointerdown', (e) => {
    if (!p || e.button !== 0 || onControl(e)) return;
    stopFly();
    if (el.classList.contains('has-key')) { el.classList.remove('has-key'); drawShapes(); }   // the pointer takes over from the crosshair
    const [px, py] = local(e);
    pointers.set(e.pointerId, [px, py]);
    if (pointers.size === 2) {
      // two fingers: pinch zoom around their midpoint
      const [a, b] = [...pointers.values()];
      gesture = { kind: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), view0: { ...view } };
      capture(e.pointerId);
      return;
    }
    suppressClick = false;
    if (p.tool === 'select') {
      gesture = { kind: 'press', x0: px, y0: py, view0: { ...view }, id: e.pointerId };
    } else {
      capture(e.pointerId);
      setSnap(findSnap(viewTargets(), px, py, SNAP_RADIUS_PX));
      applyDraw(drawEvent('down', px, py));
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!p) return;
    if (onControl(e) && !gesture) { setSnap(null); hover.update(null); return; }
    const [px, py] = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [px, py]);
    if (gesture?.kind === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (gesture.d0 > 0) setView(zoomAtR(gesture.view0, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, d / gesture.d0), false);
      return;
    }
    if (gesture?.kind === 'press' && gesture.id === e.pointerId && Math.hypot(px - gesture.x0, py - gesture.y0) >= DRAG_PX) {
      gesture.kind = 'drag';
      capture(e.pointerId);
      el.classList.add('is-panning');
      setSnap(null); hover.update(null);
    }
    if (gesture?.kind === 'drag') {
      setView(panByR(gesture.view0, px - gesture.x0, py - gesture.y0), false);
      return;
    }
    const t = findSnap(viewTargets(), px, py, SNAP_RADIUS_PX);
    setSnap(t);
    const d = showHover(t, t ? t.px : px, t ? t.py : py);
    cb.onReadout(d?.readout ?? '');
    if (p.tool !== 'select') applyDraw(drawEvent('move', px, py));
  });

  function pointerEnd(e) {
    const had = pointers.delete(e.pointerId);
    if (!p) return;
    if (gesture?.kind === 'pinch') { if (pointers.size < 2) { suppressClick = true; endGesture(); } return; }
    if (gesture?.kind === 'drag') {
      el.classList.remove('is-panning');
      suppressClick = true;
      const [px, py] = local(e);
      setView(panByR(gesture.view0, px - gesture.x0, py - gesture.y0), true);
      return;
    }
    if (gesture?.kind === 'press') gesture = null;
    if (had && p.tool !== 'select' && e.type === 'pointerup') { const [px, py] = local(e); applyDraw(drawEvent('up', px, py)); }
  }
  el.addEventListener('pointerup', pointerEnd);
  el.addEventListener('pointercancel', pointerEnd);
  el.addEventListener('pointerleave', () => {
    if (gesture) return;
    setSnap(null); hover.update(null); cb.onReadout('');
  });

  el.addEventListener('dblclick', (e) => {
    if (!p || onControl(e)) return;
    const [px, py] = local(e);
    if (p.tool === 'select') {
      // double-click zooms in one step around the point; the pick its first click scheduled is dropped
      clearTimeout(pendingPick); pendingPick = 0;
      setView(zoomAtR(view, px, py, ZOOM_STEP), true);
      return;
    }
    applyDraw(drawEvent('dblclick', px, py));
  });

  el.addEventListener('click', (e) => {
    if (!p || p.tool !== 'select' || onControl(e)) return;
    if (suppressClick) { suppressClick = false; return; }
    if (e.detail > 1) return;   // the second click of a double-click
    const [px, py] = local(e);
    clearTimeout(pendingPick);
    // wait out the double-click time before picking, so a double-click only zooms
    pendingPick = setTimeout(() => { pendingPick = 0; pickAt(px, py); }, 250);
  });

  function pickAt(px, py) {
    const t = findSnap(viewTargets(), px, py, SNAP_RADIUS_PX);
    if (t?.kind === 'site') { cb.onPick({ site: t.site }); return; }
    if (t?.kind === 'top') { cb.onBest(t.cell); return; }
    if (t?.kind === 'region-best') { cb.onRegionBest(t.slot); return; }
    const [xKm, yKm] = toKmR(view, px, py);
    if (Math.hypot(xKm, yKm) > R80) return;   // off the map disc
    const { latDeg, lonDeg } = fromXY(xKm, yKm);
    cb.onPick({ point: { latDeg: round4(latDeg), lonDeg: round4(lonDeg) } });
  }
  // the size follows the viewport height too, which the card's ResizeObserver does not see
  window.addEventListener('resize', () => { if (p && measure()) { ensureBase(); paint(); drawLive(); drawOverlay(); } });

  // ---------- keyboard ----------
  function keyCellCentre(x, y) {
    const g = p.keyGrid;
    const k = g.cellAt(x, y) ?? g.cellAt(0, 0);
    const c = g.cellCenter(k);
    return [c.xKm, c.yKm];
  }

  function keyMoved() {
    const d = cb.describe(keyPt[0], keyPt[1], null);
    cb.onReadout(d?.readout ?? '', true);
    // keep the crosshair in view
    const b = boundsR(view), m = (b.x1 - b.x0) * 0.05;
    if (keyPt[0] < b.x0 + m || keyPt[0] > b.x1 - m || keyPt[1] < b.y0 + m || keyPt[1] > b.y1 - m) setView({ ...view, cx: keyPt[0], cy: keyPt[1] }, true);
    drawShapes();
  }

  el.addEventListener('focus', () => {
    if (!p || !el.matches(':focus-visible')) return;   // a click focuses the frame too; only keyboard focus shows the crosshair
    if (!keyPt) {
      const sel = p.selected ? toXY(p.selected.latDeg, p.selected.lonDeg) : [0, 0];
      const b = boundsR(view);
      const inView = sel[0] >= b.x0 && sel[0] <= b.x1 && sel[1] >= b.y0 && sel[1] <= b.y1;
      keyPt = keyCellCentre(...(inView ? sel : [view.cx, view.cy]));
    }
    keyMoved();
  });
  el.addEventListener('blur', () => { el.classList.remove('has-key'); drawShapes(); });
  el.addEventListener('keydown', (e) => {
    if (!p || e.target !== el) return;   // keys on a focused site mark are the mark's own
    stopFly();
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(ZOOM_STEP); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / ZOOM_STEP); return; }
    if (e.key === '0') { e.preventDefault(); setView({ cx: 0, cy: 0, zoom: 1 }, true); return; }
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (moves[e.key]) {
      e.preventDefault();
      const step = (e.shiftKey ? 5 : 1) * p.keyGrid.cellKm;
      const base0 = keyPt ?? [view.cx, view.cy];
      const lim = MAP_HALF_KM - p.keyGrid.cellKm / 2;
      const nx = Math.max(-lim, Math.min(lim, base0[0] + moves[e.key][0] * step));
      const ny = Math.max(-lim, Math.min(lim, base0[1] + moves[e.key][1] * step));
      keyPt = keyCellCentre(nx, ny);
      el.classList.add('has-key');
      if (p.tool !== 'select') applyDraw(keyEvent('move'));
      keyMoved();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // The crosshair counts only while it is on screen (keyboard focus, or arrows used since the last
      // pointer press). Without it, Enter finishes a route or polygon drawn with the mouse (review UI I2);
      // in Select it first puts the crosshair at the centre of the view.
      const crosshair = keyPt && (el.matches(':focus-visible') || el.classList.contains('has-key'));
      if (!crosshair) {
        if (p.tool === 'polygon' || p.tool === 'route') { applyDraw({ type: 'key', key: 'Enter' }); return; }
        keyPt = keyCellCentre(view.cx, view.cy);
        el.classList.add('has-key');
        keyMoved();
        return;
      }
      if (p.tool === 'select') {
        const { latDeg, lonDeg } = fromXY(keyPt[0], keyPt[1]);
        cb.onPick({ point: { latDeg: round4(latDeg), lonDeg: round4(lonDeg) } });
      } else applyDraw(keyEvent('key', { key: 'Enter' }));
      return;
    }
    if ((e.key === 'Escape' || e.key === 'Backspace') && p.tool !== 'select') {
      e.preventDefault();
      applyDraw({ type: 'key', key: e.key });
    }
  });

  function keyEvent(type, extra = {}) {
    const [px, py] = toPxR(view, keyPt[0], keyPt[1]);
    return { type, xKm: keyPt[0], yKm: keyPt[1], px, py, kmPerPx: kpp(view), ...extra };
  }

  // A focused site mark shows the same hover card.
  overlay.addEventListener('focusin', (e) => {
    const m = e.target.closest?.('.site-mark');
    if (!m) return;
    const id = m.getAttribute('data-focus-key')?.slice(5);
    const t = viewTargets().find((x) => x.id === `site:${id}`);
    if (t) showHover(t, t.px, t.py);
  });
  overlay.addEventListener('focusout', () => hover.update(null));

  // ---------- update ----------
  function update(params) {
    const toolChanged = p && p.tool !== params.tool;
    p = params;
    if (toolChanged) { draw = initialDraw(params.tool); snap = null; el.classList.remove('is-snapped'); cb.onDrawing(false); }
    else if (draw.tool !== params.tool) draw = initialDraw(params.tool);
    el.classList.toggle('is-drawing', params.tool !== 'select');
    el.style.touchAction = params.tool === 'select' && view.zoom === 1 ? 'pan-y' : 'none';
    if (!gesture && params.viewport && !sameView(params.viewport, view)) view = clampView(params.viewport);
    if (params.ui) for (const [k, nodes] of Object.entries(params.ui)) for (const n of nodes) if (n.parentElement !== ui[k]) ui[k].append(n);
    empty.hidden = !params.emptyText;
    empty.textContent = params.emptyText ?? '';
    loading.hidden = !params.loading;
    loading.textContent = params.loading ?? '';
    measure();
    if (!gesture) { ensureBase(); ensureTerrain(); }
    frameUpdate(params);
    drawLive();
    drawOverlay();
  }

  // Each animation frame of a running job: repaint the heat only.
  function frameUpdate(params) {
    p = { ...p, ...params };
    const job = p.progressJob;
    progress.style.transform = `scaleX(${job ? job.progress : 1})`;
    progress.hidden = !job || job.done;
    el.dataset.heat = p.working ? 'working' : 'done';
    el.dataset.zoom = String(view.zoom);
    el.dataset.tier = p.tierLabel ?? '2 km';
    el.dataset.discPx = String(Math.round((2 * R80) / kpp(view) / view.zoom));   // the 80°S disc at 1×, CSS px
    el.dataset.visibleHeat = p.visibleDone ? 'done' : 'working';   // the layer on screen; data-heat also waits for the 2 km map
    paint();
  }

  return {
    el,
    update,
    frameUpdate,
    redrawShapes(params) { p = { ...p, ...params }; drawShapes(); },
    redrawOverlay(params) { p = { ...p, ...params }; drawOverlay(); },
    resize() { if (measure()) { ensureBase(); ensureTerrain(); paint(); drawLive(); drawOverlay(); } },
    // terrain style ('data' | 'topo' | 'real'), contour lines, and the Sun / Earth arrows at the view centre
    setTerrain(o) {
      const was = ts;
      ts = { ...ts, ...o };
      el.dataset.terrain = ts.style;
      el.dataset.contours = ts.contours ? 'on' : 'off';
      if (ts.style !== was.style || ts.contours !== was.contours) { if (geo.W) ensureTerrain(); reportTerrain(); }
      drawLive(); paint(); drawSky();
    },
    // the playhead's Sun and Earth (unit vectors in the Moon-fixed frame, Earth range in km); null when outside the ephemeris
    setLight(l) {
      light = l;
      drawSky();
      if (ts.style !== 'real' || !terr?.ready || !l) return;
      clearTimeout(lightTimer);
      lightTimer = setTimeout(() => { lightAt = performance.now(); startLight(); }, Math.max(0, lightAt + 160 - performance.now()));
    },
    get terrain() { return { ...ts }; },
    setLive,
    // T's hand-off 2.2: the canvas caches the palette; a palette change repaints with the new colours
    refreshColours() { colours = null; psrCache = null; paint(); drawOverlay(); },
    zoomBy,
    // the Map's globe draws the terrain: paint only what is draped on it (heat, PSR; the SVG layers as always)
    setDrapeOnly(on) { drapeOnly = !!on; paint(); },
    setDrapeHeat(on) { if (drapeHeat !== !!on) { drapeHeat = !!on; paint(); } },
    resetView() { stopFly(); setView({ cx: 0, cy: 0, zoom: 1 }, true); },
    // fix L3: ease to the view that fits a box (km) inside the insets (CSS px from each frame edge)
    fitBox(box, insets, opts = {}) { if (p && geo.W) flyTo(viewFor(box, insets, opts.maxZoom), opts.ms); },
    viewFor,
    loadingEl: loading,
    get view() { return { ...view }; },
    get sizePx() { return sizePx; },
    get geo() { return { ...geo }; },
    // phase 5: map km → frame CSS px for the live view (the sky dial follows its point with it)
    toPx: (xKm, yKm) => toPxR(view, xKm, yKm),
    // the ground under the frame for a view (km); null before the first measure
    boundsFor: (v) => (geo.W ? boundsR(clampView(v)) : null),
    // what the terrain wants for the live view: km per device px and the ground under the canvas (T §9)
    frameState: () => (geo.W ? { kmPerPx: kpp(view) / geo.dpr, bounds: boundsR(view) } : null),
    slots: ui,
    cancelDraw() { draw = initialDraw(p?.tool ?? 'select'); drawShapes(); },
    get drawState() { return draw; },
  };
}

// A redraw replaces the nodes inside root; if one of them had keyboard focus, focus the node that
// replaces it (same data-focus-key) so a keyboard user is not thrown back to the top of the page.
export function keepFocus(root, fn) {
  const a = document.activeElement;
  const key = a && a !== root && root.contains(a) ? a.getAttribute('data-focus-key') : null;
  fn();
  if (key && !root.contains(document.activeElement)) root.querySelector(`[data-focus-key="${key}"]`)?.focus({ preventScroll: true });
}
