// The Map view (phase 2 §4, phase 3 §4): the south-pole map card with its modes, tools, frame and
// legend; the Selected point card with the best cells; the Regions card; the Route card. Controls are
// created once; update() repaints from the data main.js hands over, frameUpdate() repaints the heat only.
// Phase 5 (G, docs/phase4/mock/structure.html): in the big layout the modes and the Layers menu (filters,
// overlays, weights) sit in the top bar; the right panel is an inspector that follows the selected object
// (point / route / region); the status line, legend and scale bar go to the time dock (main.js mounts them).
import { stageUrl, readMission, hasRoute } from '../mission-flow.js';
import { createActionBar } from './actionbar.js';
import { h, s, clear } from './dom.js';
import { panelIcon, closeX } from './shell.js';
import { createMapFrame, keepFocus } from './mapframe.js';
import { createMapTools } from './maptools.js';
import { createFilters } from './filters.js';
import { createWeights } from './weights.js';
import { createRegionCard } from './regioncard.js';
import { createRouteCard } from './routecard.js';
import { scaleBarFor } from '../map/overlay.js';
import { DASH } from '../format.js';
import { MAX_ZOOM } from '../map/view.js';
import { TERRAIN_STYLES, TINT } from '../map/terrain-style.js';
import { azEl } from '../geometry.js';

// phase 5: 'now' is the Live view (the playhead's light, no window needed); the others add up a mission window
export const MODES = [['now', 'Live'], ['both', 'Both in view'], ['sun', 'Sunlit'], ['earth', 'Earth in view'], ['change', 'Change'], ['score', 'Suitability']];
export const WINDOW_MODES = ['both', 'sun', 'earth', 'change', 'score'];
const PICKS = [['site', 'Site'], ['alt', 'Alternative']];
const MINUS = '−';
const fmt1 = (v) => (v === null || v === undefined ? DASH : (Math.round(v * 10) / 10).toFixed(1));
const STATE_NAMES = ['Neither', 'Sun only', 'Earth only', 'Both'];
const heightFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
// fix L12: the scale bar's tooltip (the map is polar stereographic, true to scale at the pole)
const SCALE_TIP = 'Polar stereographic map, true to scale at the pole. Near 80°S it is stretched by about 0.8%.';
// fix L10b: the side panels' open or folded state, for this browser session (default open)
const PANELS_KEY = 'lsn-panels-v4';
const BEST_KEY = 'lsn-best-v4';
const TERRAIN_KEY = 'lsn-terrain-v1';   // terrain style, contours, Sun and Earth readout (this browser, localStorage)
const RAD = Math.PI / 180;
const LAYERS_KEY = 'lsn-layers-v5';   // Best cells, site labels, graticule (this browser, localStorage)
function readStore(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
function writeStore(key, v) { try { sessionStorage.setItem(key, v); } catch { /* storage off: in memory only */ } }
function readLocal(key) { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; } }
function writeLocal(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage off: in memory only */ } }
// 16 px line icons for the inspector's buttons (currentColor)
const icon16 = (...kids) => s('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'aria-hidden': 'true' }, ...kids);
const layersIcon = () => icon16(s('path', { d: 'M8 2.5 14 6 8 9.5 2 6z' }), s('path', { d: 'M2 9l6 3.5L14 9' }));
const closeIcon = () => icon16(s('path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' }));

export function fmtHeight(m) {
  if (m === null || m === undefined || !Number.isFinite(m)) return DASH;
  const v = Math.round(m);
  return `${v < 0 ? MINUS : '+'}${heightFmt.format(Math.abs(v))} m`;
}

// A small schematic of the Moon: its spin axis (vertical, south pole down), the equator, and where the Sun
// and the Earth stand in latitude, angles drawn five times too large (1.5° would not show).
function moonSchematic() {
  const X = 5;
  const sun = s('g', { class: 'sch-sun' }, s('line', { x1: 0, y1: 0, x2: 0, y2: 0 }), s('circle', { r: 4 }));
  const earth = s('g', { class: 'sch-earth' }, s('line', { x1: 0, y1: 0, x2: 0, y2: 0 }), s('circle', { r: 3 }));
  const el = s('svg', { class: 'sun-sch', viewBox: '0 0 84 84', width: 84, height: 84, role: 'img', 'aria-label': 'Schematic: the Sun and the Earth in latitude on the Moon, angles five times too large' },
    s('line', { class: 'sch-axis', x1: 42, y1: 6, x2: 42, y2: 78 }),
    s('line', { class: 'sch-eq', x1: 8, y1: 42, x2: 76, y2: 42 }),
    s('circle', { class: 'sch-moon', cx: 42, cy: 42, r: 20 }),
    s('text', { class: 'sch-s', x: 42, y: 83, 'text-anchor': 'middle' }, 'S'),
    sun, earth,
    s('text', { class: 'sch-x', x: 82, y: 9, 'text-anchor': 'end' }, 'angles ×5'));
  const place = (g, lat, side, r) => {
    const a = Math.max(-80, Math.min(80, lat * X)) * RAD, x = 42 + side * r * Math.cos(a), y = 42 - r * Math.sin(a);
    const [line, dot] = g.children;
    line.setAttribute('x1', 42 + side * 20 * Math.cos(a)); line.setAttribute('y1', 42 - 20 * Math.sin(a)); line.setAttribute('x2', x); line.setAttribute('y2', y);
    dot.setAttribute('cx', x); dot.setAttribute('cy', y);
  };
  return { el, update(sunLat, earthLat) { place(sun, sunLat, -1, 36); place(earth, earthLat, 1, 36); } };
}

function seg(labelId, items, onPick) {
  const buttons = items.map(([v, label]) => h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': 'false', 'data-value': v, onclick: () => onPick(v) }, label));
  return { el: h('div', { class: 'seg', role: 'group', 'aria-labelledby': labelId }, buttons), buttons };
}

function legendFor(mode, filtered, live) {
  const sw = (cls, opacity) => h('span', { class: `swatch ${cls}`, style: opacity === undefined ? null : `opacity:${opacity}`, 'aria-hidden': 'true' });
  const out = h('li', { class: 'legend-filtered' }, sw('swatch-filtered'), 'Filtered out');
  // phase 5: over the window modes, the live layer darkens ground without the Sun at the playhead
  const shade = live && mode !== 'now' ? h('span', { class: 'legend-live' }, sw('swatch-shade'), 'No Sun now') : null;
  if (mode === 'now') {
    return h('ul', { class: 'map-legend legend-states' },
      STATE_NAMES.map((name, i) => h('li', null, sw(['swatch-none', 'swatch-sun', 'swatch-earth', 'swatch-both'][i]), name)));
  }
  if (mode === 'change') {
    return h('div', { class: 'map-legend legend-steps' },
      h('span', { class: 'legend-end' }, 'Worse'),
      h('span', { class: 'steps', 'aria-hidden': 'true' }, [0.8, 0.5, 0.25].map((o) => sw('swatch-negative', o)), sw('swatch-none'), [0.25, 0.5, 0.8].map((o) => sw('swatch-both', o))),
      h('span', { class: 'legend-mid' }, 'No change'),
      h('span', { class: 'legend-end' }, 'Better'), shade);
  }
  const colour = mode === 'score' ? 'both' : mode;
  const steps = h('div', { class: 'map-legend legend-steps' },
    h('span', { class: 'legend-end' }, mode === 'score' ? 'Low' : '0%'),
    h('span', { class: 'steps', 'aria-hidden': 'true' }, [0.15, 0.3, 0.45, 0.6, 0.75].map((o) => sw(`swatch-${colour}`, o))),
    h('span', { class: 'legend-end' }, mode === 'score' ? 'High' : '100% of the stay'), shade);
  if (!filtered) return steps;
  return h('div', { class: 'legend-stack' }, steps, h('ul', { class: 'map-legend' }, out));
}

export function createMapView({ mapCard, pointCard, filtersCard, regionCard, routeCard, shellParts = {} }, deps, cb) {
  const ids = (id) => `lsn-map-${id}`;

  // ---------- map card ----------
  // One row above the map (layout revision): the modes, then "Click sets" at the right. The drawing
  // tools, zoom, legend, readout and notes are drawn inside the map frame.
  const modeButtons = MODES.map(([v, label]) => h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': 'false', 'data-value': v, onclick: () => cb.onMode(v) }, label));
  const modeSeg = h('div', { class: 'seg mode-seg', role: 'group', 'aria-labelledby': ids('mode-label'), 'data-tour': 'modes' },
    modeButtons[0], h('span', { class: 'seg-divider', 'aria-hidden': 'true' }), modeButtons.slice(1));
  const modeMore = h('span', { class: 'mode-more', 'aria-hidden': 'true', hidden: true }, '›');
  const modeScroll = h('div', { class: 'mode-scroll' }, modeSeg);
  const modeWrap = h('div', { class: 'mode-wrap' }, modeScroll, modeMore);
  // on a phone the modes scroll sideways; a › at the right edge says there is more
  const syncMore = () => { modeMore.hidden = modeScroll.scrollWidth - modeScroll.clientWidth - modeScroll.scrollLeft < 4; };
  modeScroll.addEventListener('scroll', syncMore, { passive: true });
  window.addEventListener('resize', syncMore);
  const pickSeg = seg(ids('pick-label'), PICKS, cb.onPicking);
  const pickWhy = h('span', { class: 'sr-only', id: ids('pick-why') }, '');
  const pickField = h('div', { class: 'field field-inline tool-pick' }, h('span', { class: 'label', id: ids('pick-label') }, 'Click sets'), pickSeg.el, pickWhy);

  const tools = createMapTools({
    onTool: (tool) => cb.onTool(tool),
    onZoom: (dir) => {
      if (dir !== 'fullscreen' && cb.onZoomOverride?.(dir)) return;   // the Map is the globe: its camera takes the zoom (reset: north up, straight down)
      if (dir === 'fullscreen') setFullScreen(!fullUi);
      else if (dir === 'reset') frame.resetView();
      else frame.zoomBy(dir === 'in' ? 1.5 : 1 / 1.5);
    },
    onSlot: (slot) => cb.onSlot(slot),
    onClear: (what) => {
      cb.onClear(what);
      // the Clear button just hid itself; keep keyboard focus with the map tools (review UI I4)
      if (document.activeElement === document.body || !tools.tools.contains(document.activeElement)) {
        const next = [...tools.tools.querySelectorAll('.tool-clear')].find((b) => !b.hidden)
          ?? tools.tools.querySelector('.map-slots:not([hidden]) [aria-pressed="true"]')
          ?? tools.tools.querySelector('[data-tour="tools"] [aria-pressed="true"]');
        next?.focus();
      }
    },
  });

  const legendSlot = h('div', { class: 'map-chip legend-slot' });
  const readout = h('p', { class: 'map-chip map-readout num', hidden: true });
  const status = h('p', { class: 'sr-only', role: 'status' });   // keyboard moves only; pointer hover is not announced
  const message = h('p', { class: 'map-message', hidden: true });
  const drawNote = h('p', { class: 'map-chip draw-note', role: 'status', hidden: true });
  // fix L12: the km scale bar (the dock in the big layout, the bottom-left corner otherwise)
  const scaleBar = h('span', { class: 'map-scale-bar', 'aria-hidden': 'true' });
  const scaleLabel = h('span', { class: 'map-scale-label num' });
  const scaleEl = h('div', { class: 'map-chip map-scale', role: 'img', title: SCALE_TIP }, scaleBar, scaleLabel);
  const frame = createMapFrame(deps, {
    onViewport: cb.onViewport, onPick: cb.onPick, onBest: cb.onBest, onRegionBest: cb.onRegionBest,
    // fix L8: once a shape is finished the drawing hint goes, until the next one is started
    onShape: (shape) => { last.shapeDone = true; cb.onShape(shape); syncTools(); syncStatus(); },
    onDrawing: (drawing) => { last.drawing = drawing; if (drawing) last.shapeDone = false; syncTools(); syncStatus(); },
    onDrawNote: (text) => { drawNote.textContent = text ?? ''; drawNote.hidden = !text; syncStatus(); },
    describe: cb.describe,
    onReadout: (text, fromKeys) => { readout.textContent = text; readout.hidden = !text; if (fromKeys) status.textContent = text; syncStatus(); },
    avoid: () => avoidRects(),
    onScale: (k) => { drawScale(k); cb.onMove?.(); },
    onTerrain: (info) => setTerrainInfo(info),
  });
  // the frame's corners: the phase 3 layout uses all of them; the big layout keeps the tools and the zoom
  // there and moves the rest into the dock (fix L11)
  const frameUiNarrow = { tl: [tools.tools], tc: [tools.hint, drawNote], bl: [readout, legendSlot, scaleEl], br: [tools.zoom] };
  const frameUiBig = { tl: [tools.tools], tc: [], bl: [], br: [tools.zoom] };

  const fieldModes = h('div', { class: 'field field-inline field-modes' }, h('span', { class: 'sr-only', id: ids('mode-label') }, 'Map mode'), modeWrap);
  const mapBody = h('div', { class: 'map-body' }, frame.el, status);
  mapCard.append(
    h('div', { class: 'card-head' }, h('h2', { id: 'lsn-map-head' }, 'Moon map')),
    h('div', { class: 'map-controls' }, fieldModes, pickField),
    message,
    mapBody);

  // ---------- selected point card ----------
  const pointBody = h('div', { class: 'point-body' });
  // fix L1: in the big layout Best cells folds to one line like Filters, so every section heading of the
  // panel fits on the first screen; folded by default unless the window is tall enough for all of it.
  // The phase 3 layout keeps the plain heading and the open list.
  const bestSummary = h('span', { class: 'filters-summary num' }, '');
  const bestToggle = h('button', { type: 'button', class: 'filters-toggle best-toggle', 'aria-expanded': 'false', 'aria-controls': ids('best-body'), onclick: () => setBestOpen(!bestOpen, true) },
    h('span', { class: 'filters-label' }, 'Best cells'), bestSummary, h('span', { class: 'filters-chevron', 'aria-hidden': 'true' }));
  const bestWrap = h('div', { class: 'best' },
    h('h3', { class: 'best-title' }, 'Best cells'), h('h3', { class: 'best-fold-head' }, bestToggle),
    h('div', { class: 'best-body', id: ids('best-body') },
      h('p', { class: 'card-sub best-sub' }, 'Top 5 for this mode, at least 20 km apart'),
      h('ol', { class: 'best-list' })));
  let bestOpen = readStore(BEST_KEY) ? readStore(BEST_KEY) === 'open' : window.innerHeight >= 1080;
  function setBestOpen(open, byUser) {
    bestOpen = open;
    bestToggle.setAttribute('aria-expanded', String(open));
    bestWrap.classList.toggle('is-folded', !open);
    if (byUser) writeStore(BEST_KEY, open ? 'open' : 'closed');
  }
  setBestOpen(bestOpen, false);
  pointCard.append(h('div', { class: 'card-head' }, h('h2', { id: 'lsn-point-head' }, 'Selected point')), pointBody, bestWrap);

  // ---------- phase 5: the Layers menu (filters, overlays, weights), a popover under its top-bar button ----------
  // The filters card of phase 4 is folded into it; the card itself stays empty and hidden.
  const filtersEl = h('div');
  const weightsEl = h('div');
  const filters = createFilters(filtersEl, { onChange: (v) => cb.onFilters(v) });
  const weights = createWeights(weightsEl, { onChange: (w) => cb.onWeights(w) });
  filtersEl.querySelector('.panel-title')?.classList.add('sr-only');
  filtersEl.removeAttribute('data-tour');
  filtersCard.hidden = true;
  const layerPrefs = { best: true, labels: true, graticule: true, live: true, ...(readLocal(LAYERS_KEY) ?? {}) };
  const switchRow = (key, label, note, onFlip) => {
    const lid = ids(`layer-${key}`);
    const btn = h('button', { type: 'button', class: 'lsn-switch', role: 'switch', 'aria-checked': 'false', 'aria-labelledby': lid, 'data-layer': key, onclick: () => onFlip(btn.getAttribute('aria-checked') !== 'true') });
    const row = h('div', { class: 'layers-row' }, h('div', { class: 'layers-row-text' }, h('span', { id: lid }, label), note ? h('span', { class: 'layers-note' }, note) : null), btn);
    return { row, set: (on) => btn.setAttribute('aria-checked', String(!!on)) };
  };
  const swPsr = switchRow('psr', 'Permanently shadowed regions', 'Official map, Mazarico et al. 2011, 2016 update, 120 m', (on) => cb.onPsr?.(on));
  const swDial = switchRow('dial', 'Sky dial at selected point', 'K', (on) => cb.onDial?.(on));
  const flipPref = (key) => (on) => { layerPrefs[key] = on; writeLocal(LAYERS_KEY, { ...layerPrefs }); applyPrefs(); if (key === 'live') cb.onLivePref?.(on); };
  const swLive = switchRow('live', 'Light at the playhead', 'Darkens ground without the Sun, over the window modes', flipPref('live'));
  const swBest = switchRow('best', 'Best cells', null, flipPref('best'));
  const swLabels = switchRow('labels', 'Site and feature names', null, flipPref('labels'));
  const swGrat = switchRow('graticule', 'Graticule', 'Latitude and longitude lines; the spacing follows the zoom', flipPref('graticule'));
  // ---------- terrain style, contour lines and the Sun / Earth readout (map/terrain-style.js, mapframe.js) ----------
  // One frosted chip in the map's bottom-left floats row (main.js adds terrainEl to it): the terrain style, a
  // contour switch, and under them the height scale of Topo and the contour interval. The Sun and Earth
  // readout stacks above it; closed, its handle sits in the chip's row. All of it is remembered in this browser.
  const tp = { style: 'data', contours: false, arrows: true, sun: window.innerWidth >= 1101, ...(readLocal(TERRAIN_KEY) ?? {}) };   // open by default only where the map has room
  if (!TERRAIN_STYLES.some(([v]) => v === tp.style)) tp.style = 'data';
  let light = null;                  // { tMs, sun, earth, earthRangeKm } from main.js
  const saveTerrain = () => writeLocal(TERRAIN_KEY, { ...tp });
  const swContours = switchRow('contours', 'Contour lines', 'Heights from the terrain under the map; the interval follows the zoom', (on) => setTerrainPref({ contours: on }));
  const swArrows = switchRow('sunarrows', 'Sun and Earth directions', 'Arrows at the view centre, with their elevations', (on) => setTerrainPref({ arrows: on }));
  const REAL_TIP = 'The terrain lit by the real Sun at the timeline time, with the shadows that terrain up to 40 km away casts. Earthshine is not modelled, so ground in shadow is nearly black.';
  const STYLE_TIPS = { data: 'The analysis look: dark, low-contrast relief under the heat colours.', topo: 'Topographic map: full-contrast hillshade with height colours; the heat colours sit translucent on top.', real: REAL_TIP };
  const styleBtns = TERRAIN_STYLES.map(([v, label]) => h('button', { type: 'button', class: 'tc-btn', 'aria-pressed': 'false', 'data-value': v, title: STYLE_TIPS[v], onclick: () => setTerrainPref({ style: v }) }, label));
  const contourBtn = h('button', { type: 'button', class: 'tc-btn tc-contours', 'aria-pressed': 'false', title: 'Contour lines, every fifth one labelled with its height in metres', onclick: () => setTerrainPref({ contours: !tp.contours }) }, 'Contours');
  const sunHandle = h('button', { type: 'button', class: 'tc-btn tc-sunhandle', 'aria-expanded': 'false', title: 'Show the Sun and Earth readout', onclick: () => setTerrainPref({ sun: true }) }, 'Sun & Earth');
  const tcBar = h('span', { class: 'tc-bar', 'aria-hidden': 'true' });
  const tcLo = h('span', { class: 'tc-lo num' }), tcHi = h('span', { class: 'tc-hi num' });
  const tcTopo = h('span', { class: 'tc-topo', hidden: true }, h('span', { class: 'tc-key' }, 'Height'), tcLo, tcBar, tcHi);
  const tcInterval = h('span', { class: 'tc-interval num', hidden: true });
  const tcLegend = h('div', { class: 'tc-legend', hidden: true, role: 'status' }, tcTopo, tcInterval);
  tcBar.style.background = `linear-gradient(90deg, ${TINT.map(([t, c]) => `rgb(${c.join(',')}) ${t * 100}%`).join(', ')})`;
  const terrainChip = h('div', { class: 'terrain-chip', role: 'group', 'aria-label': 'Terrain style' },
    h('div', { class: 'tc-row' }, h('span', { class: 'tc-title' }, 'Terrain'), h('span', { class: 'tc-seg' }, ...styleBtns), h('span', { class: 'tc-div', 'aria-hidden': 'true' }), contourBtn, sunHandle),
    tcLegend);

  // the Sun and Earth readout: for the selected point and the playhead
  const sunClose = h('button', { type: 'button', class: 'sun-close', 'aria-label': 'Hide the Sun and Earth readout', title: 'Hide (reopen with Sun & Earth)', onclick: () => setTerrainPref({ sun: false }) }, 'Hide');
  const sunWhere = h('p', { class: 'sun-where' });
  const sunRows = h('dl', { class: 'sun-rows' });
  const sunWhy = h('p', { class: 'sun-why' });
  const sunDraw = moonSchematic();
  const sunPanel = h('section', { class: 'sun-panel', 'aria-label': 'Sun and Earth geometry' },
    h('div', { class: 'sun-head' }, h('h3', { class: 'sun-title' }, 'Sun & Earth'), sunClose),
    sunWhere,
    h('div', { class: 'sun-body' }, sunDraw.el, sunRows),
    sunWhy);
  const terrainEl = h('div', { class: 'terrain-dock' }, sunPanel, terrainChip);
  function setTerrainPref(o) {
    Object.assign(tp, o);
    saveTerrain();
    applyTerrain();
  }
  function applyTerrain() {
    for (const b of styleBtns) b.setAttribute('aria-pressed', String(b.dataset.value === tp.style));
    contourBtn.setAttribute('aria-pressed', String(tp.contours));
    swContours.set(tp.contours); swArrows.set(tp.arrows);
    sunPanel.hidden = !tp.sun;
    sunHandle.hidden = tp.sun;
    sunHandle.setAttribute('aria-expanded', String(tp.sun));
    frame.setTerrain({ style: tp.style, contours: tp.contours, arrows: tp.arrows });
    renderSun();
  }
  const fmtDeg = (v, plus = true) => `${v < 0 ? MINUS : plus ? '+' : ''}${Math.abs(v).toFixed(1)}°`;
  const fmtAz = (v) => (v === null || v === undefined ? DASH : `${Math.round(v) % 360}°`);
  const latText = (v) => `${Math.abs(v).toFixed(1)}°${v < 0 ? 'S' : 'N'}`;
  const lonText = (v) => { const w = ((v + 540) % 360) - 180; return `${Math.abs(w).toFixed(1)}°${w < 0 ? 'W' : 'E'}`; };
  const utcText = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  function sunRow(label, value, note) { return [h('dt', null, label), h('dd', { class: 'num' }, value, note ? h('span', { class: 'sun-note' }, note) : null)]; }
  function renderSun() {
    const site = last.selected;
    clear(sunRows);
    if (!tp.sun) return;
    if (!light || !site) {
      sunWhere.textContent = 'Outside the ephemeris (1 Nov 2026 to 1 Jan 2029).';
      sunWhy.textContent = '';
      return;
    }
    const sun = azEl(light.sun, Infinity, site.lonDeg, site.latDeg), earth = azEl(light.earth, light.earthRangeKm, site.lonDeg, site.latDeg);
    const sunLat = Math.asin(light.sun[2]) / RAD, earthLat = Math.asin(light.earth[2]) / RAD, earthLon = Math.atan2(light.earth[1], light.earth[0]) / RAD;
    sunWhere.textContent = `${site.name} · ${utcText(light.tMs)}`;
    sunRows.append(
      ...sunRow('Sun', `az ${fmtAz(sun.azDeg)} · el ${fmtDeg(sun.elDeg)}`, sun.elDeg < 0 ? 'below the horizon' : null),
      ...sunRow('Earth', `az ${fmtAz(earth.azDeg)} · el ${fmtDeg(earth.elDeg)}`, earth.elDeg < 0 ? 'below the horizon' : null),
      ...sunRow('Subsolar lat.', latText(sunLat)),
      ...sunRow('Sub-Earth point', `${latText(earthLat)} ${lonText(earthLon)}`, 'libration'),
      ...sunRow('Earth range', `${heightFmt.format(Math.round(light.earthRangeKm))} km`));
    sunWhy.textContent = 'The Moon’s spin axis is tilted 1.54° to the ecliptic, so the subsolar latitude swings about ±1.5° over a year and at the pole the Sun circles the horizon a degree or so up or down.';
    sunDraw.update(sunLat, earthLat);
  }
  function setTerrainInfo(info) {
    const { range, interval } = info;
    tcTopo.hidden = !range;
    if (range) { tcLo.textContent = fmtHeight(range.lo); tcHi.textContent = fmtHeight(range.hi); }
    tcInterval.hidden = !interval;
    if (interval) tcInterval.textContent = `Contours every ${heightFmt.format(interval)} m, labels every ${heightFmt.format(interval * 5)} m`;
    tcLegend.hidden = !range && !interval;
    terrainChip.dataset.working = info.working ? 'on' : 'off';
  }
  function applyPrefs() {
    swBest.set(layerPrefs.best); swLabels.set(layerPrefs.labels); swGrat.set(layerPrefs.graticule); swLive.set(layerPrefs.live);
    const fr = frame?.el;
    if (!fr) return;
    fr.dataset.best = layerPrefs.best ? 'on' : 'off';
    fr.dataset.labels = layerPrefs.labels ? 'on' : 'off';
    fr.dataset.graticule = layerPrefs.graticule ? 'on' : 'off';
  }
  applyPrefs();
  const weightsSec = h('section', { class: 'layers-sec layers-weights', hidden: true }, weightsEl);
  const layersClose = h('button', { type: 'button', class: 'layers-close', 'aria-label': 'Close Layers', title: 'Close (Esc)', onclick: () => { setLayersOpen(false); layersBtn.focus(); } }, closeX());
  const layersPop = h('div', { class: 'layers-pop', id: ids('layers'), role: 'dialog', 'aria-label': 'Layers', hidden: true },
    h('div', { class: 'layers-top' }, h('h2', null, 'Layers'), layersClose),
    h('section', { class: 'layers-sec' }, h('h3', { class: 'layers-head' }, 'Filters'), filtersEl),
    h('section', { class: 'layers-sec' }, h('h3', { class: 'layers-head' }, 'Overlays'), swLive.row, swPsr.row, swDial.row, swBest.row, swLabels.row, swGrat.row, swContours.row, swArrows.row),
    weightsSec);
  const layersBtn = h('button', { type: 'button', class: 'layers-btn', title: 'Filters, overlays and weights', 'aria-expanded': 'false', 'aria-controls': ids('layers'), 'aria-haspopup': 'dialog', onclick: () => setLayersOpen(layersPop.hidden) },
    layersIcon(), h('span', null, 'Layers'), h('span', { class: 'layers-count num', hidden: true }));
  const layersWrap = h('div', { class: 'layers-wrap', 'data-tour': 'filters' }, layersBtn, layersPop);
  mapCard.querySelector('.map-controls').insertBefore(layersWrap, pickField);
  function setLayersOpen(open) {
    layersPop.hidden = !open;
    layersBtn.setAttribute('aria-expanded', String(open));
    if (open) cb.onLayersOpen?.();
  }
  document.addEventListener('pointerdown', (e) => { if (!layersPop.hidden && !layersWrap.contains(e.target)) setLayersOpen(false); });
  layersWrap.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !layersPop.hidden) { e.preventDefault(); e.stopPropagation(); setLayersOpen(false); layersBtn.focus(); } });
  let lastMode = null;
  function filtersSummaryText(f) {
    const parts = [];
    if (f?.maxSlope != null) parts.push(`Slope ≤ ${f.maxSlope}°`);
    if (f?.maxDark != null) parts.push(`dark ≤ ${f.maxDark} h`);
    return parts.length ? parts.join(', ') : 'None';
  }

  // ---------- phase 4 folds: Coordinates, Route plan ----------
  // Folded to one line at start, one open at a time. main mounts each workflow's card into its body
  // (mountFold) and is told when one opens (onFold), so the work behind a card runs only while it is open.
  // fix L13: Coordinates (typed shapes and points, R's shape entry form) right after the selected point.
  // Phase 5: Energy and Relay link moved to the detail sheet's Power and Comms tabs; in the big layout the
  // inspector shows Coordinates with a region and Route plan with a route, open.
  const FOLDS = [['coords', 'Coordinates'], ['plan', 'Route plan']];
  const folds = Object.fromEntries(FOLDS.map(([name, title]) => {
    const summary = h('span', { class: 'filters-summary num' }, '');
    const toggle = h('button', { type: 'button', class: 'filters-toggle fold-toggle', 'aria-expanded': 'false', 'aria-controls': ids(`fold-${name}`), onclick: () => setFold(name, toggle.getAttribute('aria-expanded') !== 'true') },
      h('span', { class: 'filters-label' }, title), summary, h('span', { class: 'filters-chevron', 'aria-hidden': 'true' }));
    const body = h('div', { class: 'fold-body', id: ids(`fold-${name}`), hidden: true },
      h('p', { class: 'fold-empty' }, `Not in this build: the ${title} card was not handed over in time.`));
    const el = h('section', { class: 'card card-fold', 'data-fold': name, 'aria-labelledby': ids(`fold-${name}-head`) },
      h('h2', { id: ids(`fold-${name}-head`), class: 'filters-head' }, toggle), body);
    return [name, { el, toggle, body, summary, open: false }];
  }));
  function setFold(name, open) {
    for (const [n, f] of Object.entries(folds)) {
      const o = n === name ? open : false;
      if (f.open === o) continue;
      f.open = o;
      f.toggle.setAttribute('aria-expanded', String(o));
      f.body.hidden = !o;
      cb.onFold?.(n, o);
    }
  }
  pointCard.after(folds.coords.el);
  // phase 5: with a point selected, Coordinates is where a point is typed (the site list's form is gone)
  folds.coords.summary.textContent = 'Type a point';
  routeCard.after(folds.plan.el);

  // ---------- regions and route ----------
  const regions = createRegionCard(regionCard, { onBest: (slot) => cb.onRegionBest(slot) });
  regionCard.querySelector('h2')?.setAttribute('id', 'lsn-region-head');
  const route = createRouteCard(routeCard, { onHover: (i, pt) => cb.onProfileHover(pt) });
  routeCard.querySelector('h2')?.setAttribute('id', 'lsn-route-head');

  let last = { drawing: false };
  applyTerrain();

  function syncTools() {
    tools.update({ tool: last.tool, slot: last.slot, zoom: last.viewport?.zoom ?? 1, maxZoom: MAX_ZOOM, hasA: !!last.regions?.A, hasB: !!last.regions?.B, hasRoute: !!last.route, drawing: last.drawing, done: last.shapeDone, full: fullUi });
    // "Click sets" belongs to the Select tool; with a drawing tool it stays in place, greyed, and says why
    const off = last.tool !== 'select';
    for (const b of pickSeg.buttons) b.disabled = off;
    pickField.classList.toggle('is-disabled', off);
    pickField.title = off ? 'Clicks draw while a drawing tool is on. Choose Select to pick points.' : '';
    pickWhy.textContent = off ? 'Clicks draw while a drawing tool is on. Choose Select to pick points.' : '';
    pickSeg.el.setAttribute('aria-describedby', ids('pick-why'));
  }

  function openFilters() { setLayersOpen(true); }

  // phase 5: the point inspector (mock state 1). A fixed head (name, coordinates and height, the sky dial
  // and Details buttons, the panel fold), the two live rows that follow the playhead (setLive writes them
  // without a re-render), then the hours table (or, without a mission window, the offer to set one) and
  // the official products.
  // phase 5 (owner: every closable or toggled thing has a visible label, a tooltip and a name): the sky dial
  // is a labelled toggle; the site name opens the site list
  // the point's actions (Sky dial, Details, the next steps of the mission) are in the action bar (actionbar.js)
  const actionBar = createActionBar(document, { parent: shellParts.app, avoid: () => [shellParts.app?.querySelector('.sidebar'), tools.tools, profileDock, pointCol, rightReopen] });
  let dialPressed = true;
  function syncPointBar() {
    actionBar.set('point', 'site', [
      { id: 'dial', label: 'Sky dial', short: 'Sky dial', icon: 'sun', pressed: dialPressed, title: 'Show or hide the sky dial on the map (K)', cls: 'dial-btn', onClick: () => cb.onDial?.(!dialPressed) },
      { id: 'details', label: 'Details', short: 'Details', icon: 'details', cls: 'details-btn', title: 'Open the site details: sky, elevation, rises and sets, power, comms, compare', attrs: { 'data-action': 'details', 'aria-haspopup': 'dialog' }, onClick: () => cb.onDetails?.() },
      { type: 'divider' },
      // planning tools at other levels, then step 2 of the mission (mission-flow.js)
      { id: 'next-region', label: 'Where to land', short: 'Land', icon: 'details', title: 'The region around the site: landing ellipse scores and better spots nearby (Map, Region level)', onClick: () => cb.onLevel?.('region') },
      { id: 'next-rover', label: 'Plan the rover route', short: 'Route', icon: 'route', title: 'Plan the rover route from the landing site (route card)', attrs: { 'data-stage': 'rover' }, href: () => stageUrl('rover', readMission()) },
      { id: 'next-3d', label: 'See it in 3D', short: '3D', icon: 'cube', title: 'The site (or the planned route) on the 3D Moon', attrs: { 'data-stage': '3d' }, href: () => stageUrl('3d', readMission(), { route: hasRoute() }) },
      { type: 'divider' },
      { id: 'next-finalise', label: 'Finalise mission', short: 'Finalise', icon: 'go', primary: true, title: 'Step 2: check go / no-go and freeze the mission configuration for execution', attrs: { 'data-stage': 'finalise' }, onClick: () => cb.onFinalise?.() },
    ]);
  }
  const pName = h('button', { type: 'button', class: 'point-name insp-name-btn', title: 'Show the site list', 'aria-controls': 'lsn-sidebar', onclick: () => openSites() });
  const pSub = h('p', { class: 'point-coords num' });
  const liveNow = h('span', { class: 'insp-val num' }, DASH);
  const liveCount = h('span', { class: 'insp-val num' }, '');
  const nowRow = h('div', { class: 'insp-row insp-now' }, h('span', { class: 'insp-label' }, 'Now, over skyline'), liveNow);
  const countRow = h('div', { class: 'insp-row insp-count' }, liveCount);
  const btnGroup = h('div', { class: 'insp-btns' });
  const pointHead = h('div', { class: 'insp-head-block' },
    h('div', { class: 'insp-title-row' }, h('div', { class: 'insp-title' }, pName, pSub), btnGroup),
    null);
  const pointTable = h('div', { class: 'insp-table' });
  // phase 6 A (mock personas.html?s=verdict): the verdict and the way out above the hours table, the live
  // rows under it, then the official products. setVerdict fills them without a re-render (the way out
  // arrives later, from the compute tier).
  const verdictText = h('p', { class: 'insp-verdict num', 'data-story': 'verdict' });
  const wayLabel = h('span', { class: 'insp-wayout-label' });
  const wayValue = h('strong', { class: 'insp-wayout-value num' });
  const wayBtn = h('button', { type: 'button', class: 'insp-btn insp-wayout-btn', 'data-action': 'set-alternative', 'data-story': 'set-alt', onclick: () => { if (wayBtn.dataset.slip !== undefined) cb.onSetAlternative?.(Number(wayBtn.dataset.slip)); } }, 'Set as alternative');
  const wayOut = h('div', { class: 'insp-wayout', 'data-story': 'wayout', hidden: true }, wayLabel, h('div', { class: 'insp-wayout-row' }, wayValue, wayBtn));
  const verdictBlock = h('div', { class: 'insp-verdict-block', hidden: true }, verdictText, wayOut);
  // the live rows and the official products go into the table's container after the hours (mock order);
  // the live rows are the same nodes every time (setLive writes them)
  pointBody.append(pointHead, verdictBlock, pointTable);
  function renderPoint(info) { keepFocus(pointTable, () => fillPoint(info)); }

  // v: null (no block) or { parts: [{ text, tone }], wayOut: null | { label, value, title, slipDays } }
  function setVerdict(v) {
    verdictBlock.hidden = !v;
    if (!v) { clear(verdictText); wayOut.hidden = true; return; }
    const key = JSON.stringify(v);
    if (verdictBlock.dataset.key === key) return;
    verdictBlock.dataset.key = key;
    clear(verdictText);
    verdictText.append(...v.parts.map((p) => (p.tone ? h('span', { class: `insp-verdict-${p.tone}` }, p.text) : p.text)));
    verdictBlock.dataset.kind = v.kind;
    const w = v.wayOut;
    wayOut.hidden = !w;
    if (!w) return;
    wayLabel.textContent = w.label;
    wayValue.textContent = w.value;
    wayBtn.hidden = w.slipDays === null || w.slipDays === undefined;
    if (wayBtn.hidden) delete wayBtn.dataset.slip; else wayBtn.dataset.slip = String(w.slipDays);
    wayBtn.title = w.title;
  }

  function fillPoint(info) {
    clear(pointTable);
    if (!info) return;
    pName.textContent = info.name;
    pSub.textContent = `${info.coords} · ${info.height}`;
    const official = [
      h('div', { class: 'insp-row', title: 'Official map: any part of the disc never sunlit in 18.6 years (Mazarico et al. 2011, 2016 update)' }, h('span', { class: 'insp-label' }, 'Permanently shadowed'), h('span', { class: 'insp-val num' }, info.psr ?? DASH)),
      h('div', { class: 'insp-row', title: 'Official: any part of the disc over 18.6 years (Mazarico et al. 2011, 2016 update). The hours above: this stay, disc centre.' }, h('span', { class: 'insp-label' }, '18.6-yr average'),
        h('span', { class: 'insp-val num' }, info.nasa === 'none' ? 'no data' : info.nasa ? `Sun ${fmt1(info.nasa.sunPct)}% · Earth ${fmt1(info.nasa.earthPct)}%` : DASH)),
    ];
    if (info.noWindow) {
      pointTable.append(
        h('p', { class: 'insp-note' }, 'No mission window. Hours over a stay need one.'),
        h('button', { type: 'button', class: 'insp-primary', 'data-focus-key': 'land-now', 'data-action': 'land-now', onclick: () => cb.onLandNow?.() }, 'Land here now, stay 14 days'),
        nowRow, countRow, ...official);
      return;
    }
    pointTable.append(
      h('table', { class: 'point-table' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Measure')),
          h('th', { scope: 'col', class: 'n' }, 'Planned'), h('th', { scope: 'col', class: 'n' }, info.altHead ?? 'Alternative'))),
        h('tbody', null, info.rows.map((r) => h('tr', { 'data-row': r.label }, h('th', { scope: 'row' }, r.label),
          h('td', { class: 'n' }, r.planned), h('td', { class: 'n' }, h('span', { class: r.worse ? 'is-worse' : null }, r.alt)))))),
      nowRow, countRow, ...official);
  }

  function setLive({ now, countdown, dialOn } = {}) {
    if (now !== undefined && liveNow.textContent !== now) liveNow.textContent = now;
    if (countdown !== undefined && liveCount.textContent !== countdown) { liveCount.textContent = countdown; countRow.hidden = !countdown; }
    if (dialOn !== undefined && dialPressed !== !!dialOn) { dialPressed = !!dialOn; syncPointBar(); }
  }

  function renderBest(best) {
    const list = bestWrap.querySelector('ol');
    keepFocus(list, () => {
      clear(list);
      bestSummary.textContent = best.length ? `#1 ${best[0].value}` : '';
      for (const b of best) {
        list.append(h('li', null, h('button', { type: 'button', class: 'best-row', 'data-focus-key': `best:${b.rank}`, onclick: () => cb.onBest(b.cell) },
          h('span', { class: 'best-rank num' }, String(b.rank)),
          h('span', { class: 'best-where num' }, b.coords),
          h('span', { class: 'best-value num' }, b.value))));
      }
    });
  }

  function frameUpdate(params) {
    frame.frameUpdate(params);
  }

  function update(params) {
    applyLayout(Boolean(params.layout?.big));
    last = { ...last, ...params };
    mapCard.dataset.mode = params.mode;
    const info = params.pointInfo;
    rightSummaryText.textContent = info ? (info.noWindow ? info.name : `${info.name} · ${info.rows?.[0]?.planned ?? ''} both in view`) : '';
    for (const b of modeButtons) {
      b.setAttribute('aria-pressed', String(b.dataset.value === params.mode));
      // phase 5: without a mission window the modes that add up a stay are unavailable (Live is selected)
      const off = params.noWindow && WINDOW_MODES.includes(b.dataset.value);
      b.disabled = !!off;
      b.title = off ? 'Needs a mission window. Set one in the time bar.' : '';
    }
    setKind(params.kind ?? 'point');
    for (const b of pickSeg.buttons) b.setAttribute('aria-pressed', String(b.dataset.value === params.picking));
    if (params.tool !== last.prevTool) { drawNote.hidden = true; drawNote.textContent = ''; last.prevTool = params.tool; last.shapeDone = false; }
    syncTools();
    clear(legendSlot);
    legendSlot.append(legendFor(params.mode, params.filtersActive, params.liveOn), smoothNote);
    syncSmoothNote();
    message.hidden = !params.terrainError;
    message.textContent = params.terrainError ? 'Couldn’t load the terrain data.' : '';
    bestWrap.hidden = params.mode === 'now' || params.mode === 'change';
    bestWrap.querySelector('.best-sub').textContent = params.filtersActive ? 'Top 5 for this mode that pass the filters, at least 20 km apart' : 'Top 5 for this mode, at least 20 km apart';
    // phase 5: the modes are in the top bar, so the disc is centred below it (fix L4's discTop is not needed)
    frame.update({ ...params, layout: params.layout, ui: layoutBig ? frameUiBig : frameUiNarrow });
    syncStatus();
    syncMore();
    renderPoint(params.pointInfo);
    renderBest(params.best ?? []);
    const ranked = params.mode !== 'now' && params.mode !== 'change';
    filters.update({ ...params.filters, disabled: !ranked });
    renderSun();
    swPsr.set(params.showPsr);
    swDial.set(params.dialOn);
    if (params.dialOn !== undefined && dialPressed !== !!params.dialOn) { dialPressed = !!params.dialOn; syncPointBar(); }
    weightsSec.hidden = params.mode !== 'score';
    weights.update({ weights: params.weights });
    const nFilters = (params.filters?.maxSlope != null ? 1 : 0) + (params.filters?.maxDark != null ? 1 : 0);
    const count = layersBtn.querySelector('.layers-count');
    count.hidden = !nFilters; count.textContent = nFilters ? String(nFilters) : '';
    layersBtn.title = `Filters: ${filtersSummaryText(params.filters)}`;
    lastMode = params.mode;
    regionCard.hidden = !params.regionCard;
    if (params.regionCard) regions.update(params.regionCard);
    routeCard.hidden = !params.routeCard;
    route.update(params.routeCard ?? null);
  }

  // fix H (legend line): the heat is a smoothed picture of the cells; say so, with the grid in use
  const smoothNote = h('span', { class: 'legend-smooth', hidden: true });
  function syncSmoothNote() {
    // astra G: the heat is smoothed at every zoom now, 1× included, so the note shows whenever smoothing is on
    const on = last.smoothOn !== false;
    smoothNote.hidden = !on;
    if (on) smoothNote.textContent = `Smoothed display of ${last.tierLabel === '1 km' ? '1 km' : '2 km'} cells. Hover for the cell value.`;
  }

  // phase 5: the inspector follows the selected object. In the big layout only that object's sections show:
  // the point card; Route plan (open) with the route profile; or the region card with Coordinates (open).
  const KIND_TITLE = { route: 'Route', region: 'Regions' };
  const kindTitle = h('h2', { class: 'insp-kind-title' }, '');
  const kindClose = h('button', { type: 'button', class: 'insp-icon', 'aria-label': 'Close and go back to the selected point', title: 'Close and go back to the selected point', onclick: () => cb.onKind?.('point') }, closeIcon());
  const kindHead = h('div', { class: 'insp-head' }, kindTitle, kindClose);
  let kind = 'point';
  syncPointBar();
  actionBar.activate('point');
  function setKind(k) {
    if (pointCol) pointCol.dataset.kind = k;
    actionBar.activate(k);
    if (k === kind) return;
    kind = k;
    kindTitle.textContent = KIND_TITLE[k] ?? '';
    if (layoutBig && k === 'route') setFold('plan', true);
    if (layoutBig && k === 'region') setFold('coords', true);
  }

  // ---------- phase 4/5: the big-map layout (≥ 1101 px, Map view) ----------
  // The map fills the window and everything else floats over it in glass panels (docs/phase4/mock/
  // structure.html): the tool rail with the site list's toggle and the site list (left), the inspector
  // (right), the time dock and the zoom (bottom, the dock is main.js's), the modes and Layers in the top
  // bar. The narrow layout is phase 3's; switching moves a few nodes between their two homes.
  const { app, sideToggle, sideReopen, mapFinding, topModes, pickHome, chrome } = shellParts;
  const pointCol = pointCard.parentElement, mapCol = regionCard.parentElement;
  // the route profile in the big layout: its own glass panel on the left, in front of the user, beside the
  // tool rail (shown while there is a route; Hide folds it to a labelled tab, it never vanishes by itself)
  const profileToggle = h('button', { type: 'button', class: 'profile-dock-toggle', 'aria-expanded': 'true', 'aria-controls': 'lsn-profile-dock', title: 'Hide or show the route profile',
    onclick: () => { const c = profileDock.classList.toggle('is-collapsed'); profileToggle.setAttribute('aria-expanded', String(!c)); profileToggle.textContent = c ? 'Route profile' : 'Hide'; } }, 'Hide');
  const profileDock = h('aside', { class: 'profile-dock', id: 'lsn-profile-dock', 'aria-label': 'Route profile' }, profileToggle);
  const routeParent = routeCard.parentElement;
  const controlsRow = mapCard.querySelector('.map-controls');
  pointCol.id = 'lsn-point-panel';
  pointCol.classList.add('point-panel');
  // fix L10b: each panel has a plain fold button (icon, with a label on hover and focus) and, folded, a
  // labelled handle at the same edge to bring it back
  const rightToggle = h('button', { type: 'button', class: 'panel-toggle right-toggle', 'aria-label': 'Hide the inspector', title: 'Hide the inspector (Show panel brings it back)', 'aria-expanded': 'true', 'aria-controls': 'lsn-point-panel' }, closeX());
  btnGroup.append(rightToggle);
  const rightSummaryText = h('span', { class: 'right-summary-text num' });
  const rightReopen = h('button', { type: 'button', class: 'panel-reopen right-reopen', 'aria-expanded': 'false', 'aria-controls': 'lsn-point-panel', 'aria-label': 'Show the point panel', title: 'Show the point panel' },
    panelIcon('right'), h('span', { class: 'right-reopen-label' }, 'Show panel'), rightSummaryText);
  mapCard.append(rightReopen);

  // phase 5: one status line in the time dock (fix L11's order: the drawing note, the drawing hint, the hover
  // read-out, the loading line, else the map's summary sentence). The source elements stay in the page,
  // visually hidden (the dock's own line is the live region); cb.onStatus gets the text to show.
  const statusStash = h('div', { class: 'status-stash', 'aria-hidden': 'true' });
  mapCard.append(statusStash);
  if (mapFinding) new MutationObserver(() => syncStatus()).observe(mapFinding, { childList: true, characterData: true, subtree: true });
  let lastStatus = null;
  function syncStatus() {
    if (!layoutBig) return;
    const show = !drawNote.hidden ? 'note' : !tools.hint.hidden ? 'hint' : !readout.hidden ? 'readout' : !frame.loadingEl.hidden ? 'loading' : 'finding';
    const el = { note: drawNote, hint: tools.hint, readout, loading: frame.loadingEl, finding: mapFinding }[show];
    const t = el?.textContent ?? '';
    const key = `${show}|${t}`;
    if (key === lastStatus) return;
    lastStatus = key;
    cb.onStatus?.(t, { kind: show, muted: show === 'hint' || show === 'loading' });
  }
  function drawScale(k) {
    const sb = scaleBarFor(k);
    scaleEl.hidden = !sb;
    if (!sb) return;
    scaleBar.style.width = `${Math.round(sb.px)}px`;
    if (scaleLabel.textContent !== sb.label) { scaleLabel.textContent = sb.label; scaleEl.setAttribute('aria-label', `Scale bar, ${sb.label}`); }
    scaleEl.dataset.km = String(sb.km);
  }
  // the floating chrome on screen, for the labels to keep clear of (window CSS px)
  const shown = (el) => (el && el.getClientRects().length ? el.getBoundingClientRect() : null);
  function avoidRects() {
    if (!layoutBig || fullUi) return [];
    return [app?.querySelector('.topbar'), panelOpen('left') ? app?.querySelector('.sidebar') : null, tools.tools, layersOpen() ? layersPop : null,
      panelOpen('right') ? pointCol : rightReopen, tools.zoom, profileDock, ...(chrome?.() ?? [])].map(shown).filter(Boolean);
  }
  // fix L3: the space the map shows between the floating pieces, as insets from each window edge
  function fitInsets() {
    if (!layoutBig) return { left: 12, right: 12, top: 12, bottom: 12 };
    const g = 20, W = window.innerWidth, H = window.innerHeight;
    const side = panelOpen('left') ? shown(app?.querySelector('.sidebar')) : null, tl = shown(tools.tools), prof = shown(profileDock);
    const extra = (chrome?.() ?? []).map(shown).filter(Boolean);   // the time dock, an open sheet
    const right = panelOpen('right') ? shown(pointCol) : null;
    const sheet = extra.find((r) => r.top < H / 2 && r.left > W / 2);
    const dockR = extra.find((r) => r.top > H / 2);
    return {
      left: Math.max(side?.right ?? 0, tl?.right ?? 0, prof?.right ?? 0) + g,
      right: W - Math.min(right?.left ?? W, sheet?.left ?? W) + g,
      top: (shown(app?.querySelector('.topbar'))?.bottom ?? 0) + g,
      bottom: H - (dockR?.top ?? H) + g,
    };
  }
  let layoutBig = false, fullUi = false;
  const layersOpen = () => !layersPop.hidden;

  function setPanels(left, right) {
    if (!app) return;
    app.dataset.left = left ? 'open' : 'closed';
    app.dataset.right = right ? 'open' : 'closed';
    sideToggle?.setAttribute('aria-expanded', String(left));
    sideReopen?.setAttribute('aria-expanded', String(left));
    sideReopen?.setAttribute('title', left ? 'Hide the site list' : 'Show the site list');
    rightToggle.setAttribute('aria-expanded', String(right));
    rightReopen.setAttribute('aria-expanded', String(right));
  }
  const panelOpen = (side) => app?.dataset[side] !== 'closed';
  // fix L10a: zooming no longer folds the panels; only these buttons do, and the choice is kept for the
  // session (sessionStorage), across zoom and reloads
  function savePanels() { writeStore(PANELS_KEY, `${panelOpen('left') ? 1 : 0}${panelOpen('right') ? 1 : 0}`); }
  // phase 5 (owner): the site list starts closed; whatever the user chose is kept for the session
  function storedPanels() { const v = readStore(PANELS_KEY); return { left: v?.[0] === '1', right: v?.[1] !== '0' }; }
  const userPanels = (left, right, focusEl) => { setPanels(left, right); savePanels(); focusEl?.focus(); drawOverlayLater(); };
  let overlayRaf = 0;
  function drawOverlayLater() { cancelAnimationFrame(overlayRaf); overlayRaf = requestAnimationFrame(() => frame.redrawOverlay({})); }
  sideToggle?.addEventListener('click', () => userPanels(false, panelOpen('right'), sideReopen));
  // phase 5: the tool rail's first button shows and hides the site list (it stays in the rail)
  sideReopen?.addEventListener('click', () => (layoutBig ? userPanels(!panelOpen('left'), panelOpen('right'), panelOpen('left') ? sideReopen : sideToggle) : userPanels(true, panelOpen('right'), sideToggle)));
  // Esc inside the open list closes it (focus back on the Sites button)
  app?.querySelector('.sidebar')?.addEventListener('keydown', (e) => { if (e.key === 'Escape' && layoutBig && panelOpen('left') && !e.defaultPrevented) { e.preventDefault(); userPanels(false, panelOpen('right'), sideReopen); } });
  function openSites() { if (layoutBig) userPanels(true, panelOpen('right'), sideToggle); }
  rightToggle.addEventListener('click', () => userPanels(panelOpen('left'), false, rightReopen));
  rightReopen.addEventListener('click', () => userPanels(panelOpen('left'), true, rightToggle));
  setPanels(true, true);

  // Full screen: every floating piece but the zoom controls goes; the browser goes full screen too where
  // it allows (otherwise only the pieces hide). Esc or the button again brings them back.
  function setFullScreen(on) {
    if (on === fullUi) return;
    fullUi = on;
    if (app) app.dataset.ui = on ? 'hidden' : '';
    syncTools();
    if (on) document.documentElement.requestFullscreen?.()?.catch?.(() => {});
    else if (document.fullscreenElement) document.exitFullscreen?.()?.catch?.(() => {});
    frame.resize();
    drawOverlayLater();
  }
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && fullUi) setFullScreen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && fullUi && !document.fullscreenElement && !e.defaultPrevented) setFullScreen(false); });

  let layoutTold = false;   // the first update tells main the layout even when it is the narrow one (the dock's home)
  function applyLayout(big) {
    if (big === layoutBig) { if (!layoutTold) { layoutTold = true; cb.onLayout?.(big); } return; }
    layoutTold = true;
    layoutBig = big;
    app?.classList.toggle('is-bigmap', big);
    document.documentElement.classList.toggle('lsn-bigmap', big);
    if (big) {
      if (pickHome) pickHome.append(pickField);
      // the inspector: its head (route / region), then the point, Coordinates, the regions, Route plan and
      // the route profile (fix L2: the profile follows Route plan); CSS shows the selected object's
      pointCol.prepend(kindHead);
      pointCol.append(regionCard, folds.plan.el);
      profileDock.append(routeCard);
      app?.append(profileDock);
      if (topModes) topModes.append(fieldModes, layersWrap);
      statusStash.append(drawNote, tools.hint, readout, frame.loadingEl, ...(mapFinding ? [mapFinding] : []));
      if (sideReopen) tools.tools.prepend(sideReopen);
      const st = storedPanels();
      setPanels(st.left, st.right);
      lastStatus = null;
    } else {
      if (fullUi) setFullScreen(false);
      controlsRow.prepend(fieldModes);
      controlsRow.append(layersWrap, pickField);
      kindHead.remove();
      mapCol.append(regionCard);
      routeParent.append(routeCard);
      routeCard.after(folds.plan.el);
      profileDock.remove();
      frame.slots.tc.prepend(frame.loadingEl);
      // the read-out, legend, scale, hint and note go back to the frame's corners on the next update
      const grid = mapCol.parentElement;
      if (mapFinding) grid.parentElement.insertBefore(mapFinding, grid);
      if (sideReopen && app?.firstElementChild) app.firstElementChild.after(sideReopen);
      setPanels(true, true);
    }
    cb.onLayout?.(big);
  }

  return {
    update,
    frameUpdate,
    // light paths: cards that change while jobs run, without rebuilding the rest
    setTop(top, best) { last = { ...last, top }; frame.redrawOverlay({ top }); renderBest(best); },
    setCards({ regionCard: rc, routeCard: rtc, regionBest, filters: f }) {
      if (rc !== undefined) { regionCard.hidden = !rc; if (rc) regions.update(rc); }
      if (rtc !== undefined) { routeCard.hidden = !rtc; route.update(rtc); }
      if (regionBest !== undefined) frame.redrawShapes({ regionBest });
      if (f) filters.update({ ...f, disabled: last.mode === 'now' || last.mode === 'change' });
    },
    // the playhead's Sun and Earth, for the readout and the arrows on the map
    setLight(l) { light = l; frame.setLight(l); renderSun(); },
    terrainEl,
    actionBar,
    setProfileAt(profileAt) { frame.redrawShapes({ profileAt }); },
    openFilters,
    // phase 4: the workflow cards in the folds
    // the fold's line is the card's title, so the card's own h2 is hidden and the fold head names the card
    mountFold(name, cardEl) {
      const f = folds[name]; if (!f) return;
      const own = cardEl.querySelector('.card-head h2, h2');
      if (own) { own.hidden = true; cardEl.setAttribute('aria-labelledby', ids(`fold-${name}-head`)); }
      cardEl.classList.remove('card');   // the fold is the card; no second surface inside it
      clear(f.body); f.body.append(cardEl);
    },
    setFoldSummary(name, text) { if (folds[name]) folds[name].summary.textContent = text ?? ''; },
    setFold: (name, open) => {
      setFold(name, open);
      if (!open) return;
      if (layoutBig && !panelOpen('right')) { setPanels(panelOpen('left'), true); savePanels(); }
      // inside the point panel's own scroll in the big layout; Coordinates sits under the selected point, so
      // only as far as needed (the point stays in view)
      folds[name]?.el.scrollIntoView?.({ block: layoutBig && name === 'coords' ? 'nearest' : 'start' });
    },
    foldOpen: (name) => Boolean(folds[name]?.open),
    // fix L3: ease the map to a route (points in km), between the panels and bars that are open
    fitRoute(points) {
      if (!points?.length) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const pad = 0.06 * Math.max(x1 - x0, y1 - y0) + 0.3;
      frame.fitBox({ x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }, fitInsets());
    },
    fitInsets,
    frame,
    resize() { frame.resize(); },
    // phase 5: the live rows of the point inspector, the legend and scale bar for the time dock
    setLive,
    setVerdict,
    // phase 6 B: the story mode keeps the site list closed and the inspector open, and puts them back
    getPanels: () => ({ left: panelOpen('left'), right: panelOpen('right') }),
    setPanels: (left, right) => { if (layoutBig) { setPanels(left, right); drawOverlayLater(); } },
    legendEl: legendSlot,
    scaleEl,
    setLayersOpen,
    get kind() { return kind; },
    get livePref() { return layerPrefs.live !== false; },
    setFullScreen,
    setLayout: (big) => applyLayout(big),
    get layoutBig() { return layoutBig; },
  };
}
