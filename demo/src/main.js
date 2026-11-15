// Assembles the page: reads the data packs, keeps the state, schedules rendering and the heat jobs,
// loads finer data on demand, and wires the command layer, the Ask panel and the tour (phase 3 §4).
import { writeMission, readMission, landedFor, landFromHash, moonKm, stageUrl, readRoutePlan, writeRoutePlan } from './mission-flow.js';
import { createGlobeMap } from './ui/globemap.js';
import { createLocalFrame, centreOf, localDem, mapPlan } from './localframe.js';
import { createSiteContexts } from './lander/globalsite.js';
import { createLandingEvaluator } from './lander/landeval.js';
import { ELLIPSE, batteryHours } from './lander/siteplan.js';
import { cleanVehicle, VEHICLE_DEFAULTS } from './lander/vehicle.js';
import { createHiresSet } from './hires.js';
import { createLandCard } from './ui/landcard.js';
import { bootScreen } from './boot.js';
import { createEphemeris, bodyAzEl } from './ephemeris.js';
import { summarize, summarizePair, sampleSeries } from './windows.js';
import { formatCoords, parseCustomSite } from './sites.js';
import { parseHash, toHash, alternativeOf, cleanMaxSlope, cleanMaxDark, cleanWeights, cleanEnergy, cleanRelay, cleanRoutePlan, shapeParam, cleanStay, SHEET_TABS } from './state.js';
import { findingSentence, mapFinding } from './finding.js';
import { fmtDay, fmtSpan, fmtHours, fmtPct, DASH } from './format.js';
import { createDem, createPyramid, createTiledDem, parseTile, skylineFor, toXY, fromXY, TERRAIN_MAX_LAT } from './terrain.js';
import { createPsr, PSR_PACK } from './psr.js';
import { createNasaAvg, NASA_PACKS } from './nasa-avg.js';
import { createHeatGrid, nowStates, changeShares } from './heat.js';
import { staticGrid } from './score.js';
import { createHeatPlan } from './heatplan.js';
import { hasData, readData, loadData, loadPacks } from './data-loader.js';
import { neededPacks } from './map/tiers.js';
import { clampView } from './map/view.js';
import { areaKm2, bbox } from './map/shapes.js';
import { isGeo, geoStats, geoOutline } from './georegion.js';
import { landingRibbon } from './ribbon.js';
import { h, clear } from './ui/dom.js';
import { createShell, SLIPS } from './ui/shell.js';
import { createMapView, fmtHeight, MODES, WINDOW_MODES } from './ui/mapview.js';
import { createEnergyCard } from './ui/energycard.js';
import { planEnergyPair, ENERGY_DEFAULTS } from './energy.js';
import { createRelayCard } from './ui/relaycard.js';
import { PRESETS as RELAY_PRESETS } from './relay.js';
import { createRoutePlanCard } from './ui/routeplan.js';
import { createShapeEntry } from './ui/shapeentry.js';
import { planRoutes, sunFromJobs, simplify } from './route-plan.js';
import { planSelfDriving, autonavPayload } from './route-rrt.js';
import { simulateDrive, skyFromGrid, scanDepartures } from './route-energy.js';
import { coverage as stationCoverage, routeLinks, linkSummary, STATION_DEFAULTS } from './comms.js';
import { findHavens } from './contingency.js';
import { buildPayload, ROUTE3D_KEY } from './route3d.js';
import { createMapFloats, createSlopeLegend, createInset3d } from './ui/inset3d.js';
import { settingsOf, summaryOf, recordInputs } from './ui/mission-records.js';
import { buildRecord } from './mission-save.js';
import { renderPanorama, updatePanoramaCursor } from './charts/panorama.js';
import { renderElevation, updateElevationCursor } from './charts/elevation.js';
import { renderCompare } from './ui/compare.js';
import { compareRows } from './compare-rows.js';
import { renderEvents } from './ui/events.js';
import { renderEvidence } from './ui/evidence.js';
import { DATA_SOURCES } from './data-sources.js';
import { renderBrief } from './ui/brief.js';
import { createCommands } from './commands.js';
import { createAgent } from './agent/provider.js';
import { createMockProvider, MOCK_SUGGESTIONS } from './agent/mock.js';
import { createAgentPanel } from './ui/agentpanel.js';
import { createTour, TOUR_STEPS } from './ui/tour.js';
// phase 5 (G): one clock and the time dock (P), the sky dial and the detail sheet (S), settings and the
// model providers (T), the compute tier (C)
import { createTimeline, createPlayLoop } from './timeline.js';
import { createTimeDock } from './ui/timedock.js';
import { createSiteSheet } from './ui/sitesheet.js';
import { createSkyDial } from './ui/skydial.js';
import { northOnScreenDeg, trackSpan, tracksFromSeries, skyStatus } from './skydial.js';
import { createSettings, applyDisplay, heatSmoothOption, reducedMotion, createProviderFromSettings, providerChanged } from './settings.js';
import { createSettingsSheet } from './ui/settingssheet.js';
import { createDocSheet } from './ui/docsheet.js';
import { createCoreTools } from './tools-core.js';
import { createCountdown } from './countdown.js';
import { createThrottle } from './throttle.js';
import { verdictOf, wayOutKey, createWayOutFetcher } from './verdict.js';
import { storyFacts } from './stories.js';
import { createStoryMode } from './ui/storymode.js';

const DAY_MS = 86400e3;
const HOUR_MS = 3600e3;
const SLICE_MS = 12;
const MINUS = '−';
const STATE_NAMES = ['Neither', 'Sun only', 'Earth only', 'Both'];
const MODE_LABEL = Object.fromEntries(MODES);
const FINE_PACKS = ['horizon_1km', 'slope_1km', 'shadow_1km'];
const BIG_TOP_PX = 56;   // phase 4 big-map layout: the top bar's height (styles.css --big-top)
const SHEET_W = 600, EDGE = 16, SHEET_GAP = 10;   // phase 5: the detail sheet's width and the gaps (phase5-sky.css)
const ISO_MIN = (ms) => `${new Date(Math.floor(ms / 60e3) * 60e3).toISOString().slice(0, 16)}Z`;

function readJson(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing ${id}`);
  return JSON.parse(el.textContent);
}

function insideMask(grid) {
  const out = new Uint8Array(grid.count);
  for (let k = 0; k < grid.count; k++) out[k] = grid.cellCenter(k).latDeg <= TERRAIN_MAX_LAT ? 1 : 0;
  return out;
}

function start() {
  const root = document.getElementById('app');
  let data;
  try {
    data = {
      ephemeris: readJson('data-ephemeris'), sites: readJson('data-sites'),
      validation: readJson('data-validation'), challenge: readJson('data-challenge'),
    };
  } catch {
    root.append(h('p', { class: 'load-error' }, 'Couldn’t load the ephemeris file.'));
    return;
  }
  const { sites } = data;
  const eph = createEphemeris(data.ephemeris);

  // Terrain: without it the page still runs on a smooth sphere and the Map view says so.
  // The start-up packs are loaded by static <script> tags before this script (§4.11).
  let meta = null, dem = null, pyramid = null, grid = null, inside = null, plan = null, features = [], coarse = null;
  try {
    meta = readJson('data-terrain');
    features = readJson('data-features');
    const demBytes = readData('dem_480m');
    dem = createDem({ data: new Int16Array(demBytes.buffer), size: meta.dem.size, kmPerPixel: meta.dem.kmPerPixel, dnToMeters: meta.dem.dnToMeters });
    pyramid = createPyramid([dem]);
    // phase 4: the 40 m and 20 m tiled levels, registered with their tile lists (tiles load on demand)
    for (const l of meta.levels ?? []) if (l.tiled) pyramid.add(createTiledDem(l));
    grid = createHeatGrid({ horizon: readData('horizon_grid'), ...meta.horizon });
    inside = insideMask(grid);
    coarse = { grid, inside, label: '2 km', slope: staticGrid(readData('slope_2km'), 0.25), shadow: staticGrid(readData('shadow_2km'), 1) };
    plan = createHeatPlan({ eph, coarse });
  } catch {
    dem = null; grid = null; plan = null;
  }

  // Skylines (Navigator, ribbon, sidebar figures) stay on the 480 m grid, as in phase 2. North of 80°S (the Map
  // covers the whole Moon), the selected site's skyline is computed from the global LOLA terrain
  // (lander/globalsite.js, as the region level does); until it arrives, and for the other sites in the lists, the
  // smooth-sphere horizon stands in.
  const skylines = new Map();
  const globalSites = createSiteContexts({ load: (name) => loadData(name, { timeoutMs: 90000 }), getDem: () => dem, manifest: null });
  function sky(site) {
    const key = `${site.latDeg.toFixed(5)},${site.lonDeg.toFixed(5)}`;
    if (!skylines.has(key)) {
      skylines.set(key, skylineFor(dem, site));
      let selected = false;
      try { selected = !!state?.site && state.site.latDeg === site.latDeg && state.site.lonDeg === site.lonDeg; } catch { /* before the state exists */ }
      if (site.latDeg > TERRAIN_MAX_LAT && selected) {
        globalSites.context(site).then((ctx) => {
          if (!ctx?.mask?.profile) return;
          skylines.set(key, ctx.mask);
          globalSkyNote.set(key, ctx.skyline);
          ribbons.clear(); allEvents.clear();
          // the figures, the dial and its tracks are cached by site and time: drop them so the terrain skyline replaces the flat one
          computedKey = ''; dialCache = null;
          render();
        }).catch((e) => console.warn('global skyline', e));
      }
    }
    return skylines.get(key);
  }
  const globalSkyNote = new Map();

  // mission-flow.js: a link from the lander's "Plan the rover route" carries plan=1 (open the route card at the site)
  const planOnLoad = /(^|[#&])plan=1(&|$)/.test(location.hash);
  let landHash = landFromHash(location.hash);   // where the lander touched down, from the lander's link
  let state = parseHash(location.hash, sites, eph);
  state.viewport = clampView(state.viewport);
  if (!state.windowOn) state.mapMode = 'now';   // no mission window: the Live view
  // the rover route: a link without one (the 3D globe's way back, a stage link) brings back the stored one
  if (!state.routePlan && !/[#&]rp=/.test(location.hash)) state.routePlan = cleanRoutePlan(readRoutePlan());
  else writeRoutePlan(state.routePlan);
  // phase 5 (T): settings for things rarely changed (palette, smoothing, glass, scale bar, sky dial, motion, AI)
  const settings = createSettings();
  applyDisplay(settings.get());
  let derived = null;
  // region slots are 'A' and 'B' all the way through; fix L5: they come back from the hash (state.regions
  // mirrors this object for toHash)
  const shapes = { A: state.regions?.A ?? null, B: state.regions?.B ?? null };
  let routePoints = state.routePlan && !state.routePlan.selected ? state.routePlan.points : null;

  const shell = createShell(root, { sites, state, onChange: (patch) => update(patch) });
  // the Map is one view of the whole Moon (ui/moonlayer.js): the globe when zoomed out, this page's polar map when
  // zoomed in over the south pole; made once the map exists (below)
  let globeMap = null, pickedOnMap = false;

  // ---------- data packs on demand (§4.1, §5.1) ----------
  const packs = {};   // name → 'loading' | 'ok' | 'error'
  const packMs = {};  // name → load and decode time, for the timing notes
  const fineBytes = {};

  function onPack(name, bytes) {
    const level = meta.levels?.find((l) => l.name === name);
    if (level) {
      if (pyramid.levels.some((l) => !l.tiled && l.kmPerPixel === level.kmPerPixel)) return;   // phase 4: the route planner may have loaded it first
      pyramid.add(createDem({ data: new Int16Array(bytes.buffer), size: level.size, kmPerPixel: level.kmPerPixel, dnToMeters: level.dnToMeters, halfKm: level.halfKm }));
      return;
    }
    if (FINE_PACKS.includes(name)) {
      fineBytes[name] = bytes;
      if (FINE_PACKS.every((n) => fineBytes[n]) && !plan.fine) {
        // the 1 km grid counts as loaded once its skylines, slopes and shadow distances are all in,
        // so a filter never runs on a missing array
        const g = createHeatGrid({ horizon: fineBytes.horizon_1km, ...meta.horizons[1] });
        plan.setFine({ grid: g, inside: insideMask(g), label: '1 km', slope: staticGrid(fineBytes.slope_1km, 0.25), shadow: staticGrid(fineBytes.shadow_1km, 1) });
        // phase 3: shadows on a planned route are sharper on the 1 km skyline grid, so its drive is run again
        if (rp?.plan?.ok && rp.energy) setTimeout(() => updateEnergy(), 0);
      }
    }
  }

  // The packs this view needs (§4.1, phase 4 §4.1): the phase 3 grids and terrain levels one by one,
  // and the elevation tiles of the frame's ground in batches; a tile goes straight into the pyramid and
  // the map redraws once per frame however many tiles arrived.
  function packPlan() {
    const fs = mapView?.frame.frameState?.() ?? null;
    return fs ? neededPacks(state.viewport, { levels: meta.levels, kmPerPx: fs.kmPerPx, bounds: fs.bounds }) : neededPacks(state.viewport);
  }
  let tileRedraw = 0;
  function ensurePacks() {
    if (!plan) return;
    const tiles = [];
    for (const name of packPlan()) {
      if (packs[name]) continue;
      if (parseTile(name)) {
        if (hasData(name)) { pyramid.addTile(name, readData(name)); packs[name] = 'ok'; continue; }
        packs[name] = 'loading';
        tiles.push(name);
        continue;
      }
      if (hasData(name)) { packs[name] = 'ok'; continue; }
      packs[name] = 'loading';
      const t0 = performance.now();
      loadData(name).then((bytes) => {
        packs[name] = 'ok';
        packMs[name] = Math.round(performance.now() - t0);
        onPack(name, bytes);
        if (mapView) renderMap(); else configureHeat();
      }, () => {
        packs[name] = 'error';
        if (mapView) renderMap();
      });
    }
    if (!tiles.length) return;
    const t0 = performance.now();
    loadPacks(tiles, {
      concurrency: 6,
      onEach: (name, bytes, err) => {
        if (err || !bytes) { packs[name] = 'error'; } else { pyramid.addTile(name, bytes); packs[name] = 'ok'; packMs[name] = Math.round(performance.now() - t0); }
        if (!tileRedraw) tileRedraw = requestAnimationFrame(() => { tileRedraw = 0; if (mapView) renderMap(); });
      },
    });
  }

  // Phase 4: the official permanently shadowed regions and the NASA 18.6-year averages load once the map
  // has drawn (they are not start-up packs), or at once when the PSR layer is switched on.
  let psr = null, nasa = null, extrasAsked = false, showPsr = state.psr;   // fix L5: the layer switch is in the hash (psr=1)
  // phase 5 (C): the compute tier: stateless tools over the same data and caches as the page (sky shares the
  // skyline cache); the inspector's countdown, the scripted Ask replies and the AI's tool table use it
  const core = createCoreTools({ eph, sites, dem, skylineFor: sky, coarse, dem240, psr: () => psr, nasa: () => nasa });
  function loadExtras() {
    if (extrasAsked || !meta) return;
    extrasAsked = true;
    loadPacks([PSR_PACK, NASA_PACKS.sun, NASA_PACKS.earth], { concurrency: 3 }).then((got) => {
      const b = (n) => (got.get(n) instanceof Uint8Array ? got.get(n) : null);
      try { if (b(PSR_PACK)) psr = createPsr(b(PSR_PACK), meta.psr); } catch { psr = null; }
      try { if (b(NASA_PACKS.sun) || b(NASA_PACKS.earth)) nasa = createNasaAvg({ sun: b(NASA_PACKS.sun), earth: b(NASA_PACKS.earth) }, meta.nasaAvg); } catch { nasa = null; }
      packs[PSR_PACK] = psr ? 'ok' : 'error';
      if (mapView) renderMap();
    });
  }

  function loadingText() {
    const need = packPlan();
    if (need.some((n) => packs[n] === 'loading')) return 'Loading finer terrain…';
    const finest = pyramid?.levels[pyramid.levels.length - 1];
    const out = [];
    if (need.some((n) => n.startsWith('dem_') && packs[n] === 'error')) out.push(`Couldn’t load finer terrain. Showing ${Math.round(finest.kmPerPixel * 1000)} m.`);
    if (need.some((n) => FINE_PACKS.includes(n) && packs[n] === 'error')) out.push('Couldn’t load the 1 km grid. Showing 2 km cells.');
    return out.length ? out.join(' ') : null;
  }

  // The finest loaded terrain that covers a box (km), for heights.
  function demFor(b) { return pyramid ? pyramid.pick(0, b) : dem; }
  function heightAtXY(x, y) { const d = demFor({ x0: x, y0: y, x1: x, y1: y }); return d ? d.heightAtXY(x, y) : null; }

  // ---------- map view ----------
  const mapPoint = ({ latDeg, lonDeg }) => ({ id: 'custom', name: 'Map point', subtitle: '', latDeg, lonDeg, verified: true });
  const cellPoint = (g, cell) => { const c = g.cellCenter(cell); return mapPoint({ latDeg: Math.round(c.latDeg * 1e4) / 1e4, lonDeg: Math.round(c.lonDeg * 1e4) / 1e4 }); };
  let profileAt = null;

  // a site or a point picked on the map, or typed in the Coordinates fold (fix L13): the same path
  function pickOnMap({ site, point }) {
    // with Where to land open, a click proposes a landing point instead of choosing the site
    if (kind === 'land') { proposeLanding(site ?? point); return; }
    kind = 'point';
    if (state.picking === 'alt') {
      if (site) update({ altSite: site.id === state.site.id ? 'same' : site.id });
      else update({ altSite: `c:${point.latDeg},${point.lonDeg}` });
    } else {
      update({ site: site ?? mapPoint(point) });
    }
  }
  // phase 5: what the inspector shows ('point' | 'route' | 'region'), set by the tool, a drawn or typed
  // shape, a planned route or a pick
  let kind = 'point';
  const pickHome = h('div', { class: 'sheet-pick' });
  let sheet = null, dock = null, settingsSheet = null;
  let storyMode = null;   // phase 6 B (ui/storymode.js), made once the commands and the dock exist
  let hashFrozen = false;  // phase 6 B: while a story runs the address bar keeps the visitor's own state (written again on exit)
  let onCoordsFold = () => {};   // the Coordinates fold opened or closed: its form's actions show in the action bar
  const mapView = plan ? createMapView({
    mapCard: shell.regions.mapCard, pointCard: shell.regions.pointCard, filtersCard: shell.regions.filtersCard,
    regionCard: shell.regions.regionCard, routeCard: shell.regions.routeCard,
    shellParts: {
      app: shell.app, sideToggle: shell.sideToggle, sideReopen: shell.sideReopen, mapFinding: shell.regions.mapFinding,
      topModes: shell.topModes, pickHome, chrome: () => [dock?.el, sheet?.isOpen() ? sheet.el : null, settingsSheet?.isOpen() ? settingsSheet.el : null].filter(Boolean),
    },
  }, { coarseGrid: grid, pyramid, features, sites }, {
    onPick: (picked) => { pickedOnMap = true; pickOnMap(picked); pickedOnMap = false; },
    onBest: (cell) => update({ site: cellPoint(grid, cell) }),
    onRegionBest: (slot) => {
      if (isGeo(shapes[slot])) { const b = geoSlot(slot).stats?.best; if (b) update({ site: mapPoint(b) }); return; }
      const r = plan.region(slot);
      if (r?.stats.best) update({ site: cellPoint(r.tier.grid, r.stats.best.cell) });
    },
    onMode: (mapMode) => update({ mapMode }),
    onPicking: (picking) => update({ picking }),
    onFold: (name, open) => { if (name === 'coords') onCoordsFold(open); },
    onTool: (tool) => { kind = tool === 'route' ? 'route' : tool === 'select' ? 'point' : 'region'; update({ tool }); entryFold(tool); },
    onKind: (k) => { kind = k; update(k === 'point' ? { tool: 'select' } : {}); },
    onSlot: (slot) => update({ slot }),
    onClear: (what) => { if (what === 'route') clearRoute(); else api.setRegion(what, null); },   // the route: card, hash, the browser's copy and the globe
    onShape: (shape) => {
      if (shape.type !== 'route') { kind = 'region'; api.setRegion(state.slot, shape); return; }
      setHandRoute(shape.points);
    },
    onViewport: (viewport) => update({ viewport }),
    onFilters: ({ maxSlope, maxDark }) => update({ maxSlope, maxDark }),
    onWeights: (weights) => update({ weights }),
    onPsr: (on) => { showPsr = on; persist({ psr: on }); if (on) loadExtras(); renderMap(); },
    onDial: (on) => settings.set('skyDial', !!on),
    onLivePref: () => renderMap(),
    onDetails: () => openSheet('overview'),
    onLevel: () => openLanding(),   // Where to land, in the panel on this Moon
    onZoomOverride: (dir) => globeMap?.zoom(dir) ?? false,
    onFinalise: () => goFinalise(),
    onLandNow: () => landHereNow(),
    // phase 6 A: the way out's "Set as alternative" (the slip the time dock offers, −60 to 60 days)
    onSetAlternative: (slipDays) => { if (Number.isInteger(slipDays) && slipDays >= -60 && slipDays <= 60) update({ slipDays }); },
    onStatus: (text, { muted }) => dock?.setStatus(text, { muted }),
    onMove: () => placeDial(),
    onLayout: (big) => placeDock(big),
    onProfileHover: (pt) => { profileAt = pt ? { xKm: pt.xKm, yKm: pt.yKm } : null; mapView.setProfileAt(profileAt); },
    describe: (xKm, yKm, target) => describe(xKm, yKm, target),
  }) : null;
  if (mapView) {
    // the Map is the 3D Moon (ui/globemap.js): the polar map runs underneath and is draped on it inside 80°S
    globeMap = createGlobeMap(document, {
      frame: mapView.frame, pyramid, eph, sites, features, getState: () => state,
      // a click north of 80°S (or on a listed site's label there): that point or site becomes the site
      onPickOutside: (picked) => { pickedOnMap = true; pickOnMap(picked); pickedOnMap = false; },
      onCamera: () => placeDial(),
    });
    // the polar map's view follows the ground in sight (it loads the finer terrain and heat for it)
    globeMap.onPolarView = (v) => update({ viewport: v });
    // the globe's own Route tool (anywhere on the Moon)
    // a route drawn on the globe is planned at once (as pressing Plan routes): its candidates replace the drawn line
    globeMap.onRouteDrawn = (lls) => { setHandRoute(lls.map((p) => toXY(p.latDeg, p.lonDeg))); routePlanCard?.plan(); };
    // a rectangle, circle or polygon clicked out north of 80°S (georegion.js): into the current slot
    globeMap.onRegionDrawn = (shape) => { kind = 'region'; api.setRegion(state.slot, polarIfInside(shape)); };
    globeMap.onLandSpot = (n) => selectLanding(land.region ? n - 1 : n);
    // a route drawn on the Moon starts from the start point already set (the landing spot, plan=1)
    globeMap.draftSeed = () => (rp.points?.length === 1 ? { ...fromXY(rp.points[0][0], rp.points[0][1]) } : null);
    // a click on a region's outline or on a route: the panel turns to it (a candidate route is chosen as well)
    globeMap.isDrawing = () => !!mapView?.drawing;
    // the region to fill: the one the Regions panel works on, or the Where to land target
    globeMap.regionFocus = () => { try { return kind === 'land' ? land.region : kind === 'region' ? state.slot : null; } catch { return null; } };
    globeMap.onFocus = (f) => {
      if (f.kind === 'region') {
        kind = 'region';
        // with a region tool on, the tool follows the focused shape (its form shows; the next click draws that kind into that slot)
        const sh = shapes[f.slot], regionTool = ['rect', 'circle', 'polygon'].includes(state.tool);
        update(regionTool && sh ? { slot: f.slot, tool: sh.type } : { slot: f.slot });
        return;
      }
      kind = 'route';
      if (f.id && f.id !== rp.selected) pickPlanned(f.id);
      update({});
    };
    globeMap.ready.then(() => redrawRoutes());   // a route from the link shows as soon as the globe exists
    globalThis.__globeMap = globeMap;   // for inspection from the console
    // (Where to land is the panel on this Moon, ui/landcard.js; the planner page's 2D map no longer opens here)
  }
  // a site chosen from a list, a link or Where to land: the camera goes to it (a click on the map does not move it)
  let globeSiteKey = null;
  function syncGlobeSite() {
    const s0 = state.site;
    if (!globeMap || !s0) return;
    const key = `${s0.latDeg},${s0.lonDeg}`;
    if (key === globeSiteKey) return;
    const first = globeSiteKey === null;
    globeSiteKey = key;
    if (first || pickedOnMap) return;   // the first view comes from the state; a map click keeps the camera
    globeMap.ready.then(() => globeMap.flyTo({ lat: s0.latDeg, lon: s0.lonDeg, dist: s0.latDeg <= TERRAIN_MAX_LAT ? 140 : 450 }));
  }

  // ---------- phase 4: the workflow cards in the right panel's folds ----------
  // Each card works only while its fold is open; refreshFolds() runs after every map render and cursor move.
  // fix L5: the cards start from the hash and write their inputs back to it (only the cards' exported
  // update/setOrbit and their callbacks are used)
  let energyAssumptions = state.energy ? { ...state.energy } : null;
  const energyCard = mapView ? createEnergyCard(state.energy ? { assumptions: state.energy } : {}, { onChange: (a) => { energyAssumptions = a; persist({ energy: cleanEnergy(a) }); } }) : null;
  const relayCard = mapView ? createRelayCard({ eph }, {
    onCursor: (ms) => timeline.setNow(ms),
    onOrbit: (elements, presetId, extra) => persist({ relay: cleanRelay({ ...(presetId ? { presetId } : { elements }), minElDeg: extra?.minElDeg ?? 0 }) }),
  }) : null;
  // fix L13: R's coordinate entry in the Coordinates fold. Typed shapes and points take the drawing tools'
  // path (setRegion, the map pick), so they get the same statistics, compare and hash.
  const shapeEntry = mapView ? createShapeEntry({
    onShape: (shape, slot) => { if (slot !== state.slot) state = { ...state, slot }; api.setRegion(slot, shape); },
    onPoint: (xy, { latDeg, lonDeg }) => pickOnMap({ point: { latDeg: Math.round(latDeg * 1e4) / 1e4, lonDeg: Math.round(lonDeg * 1e4) / 1e4 } }),
    onOpenRoutePlan: () => mapView.setFold('plan', true),
    actionBar: mapView.actionBar,
  }) : null;
  if (shapeEntry) mapView.mountFold('coords', shapeEntry.el);
  onCoordsFold = (open) => shapeEntry?.setBar(open);
  onCoordsFold(mapView?.foldOpen('coords'));
  let entryShapes = { A: shapes.A, B: shapes.B };   // a new object only when a region changes (it refills the form)
  function syncEntry() {
    if (!shapeEntry) return;
    if (entryShapes.A !== shapes.A || entryShapes.B !== shapes.B) entryShapes = { A: shapes.A, B: shapes.B };
    // a region focused by a click on its outline (Select tool): the form shows that region's shape
    const focused = kind === 'region' && state.tool === 'select' ? shapes[state.slot] : null;
    shapeEntry.update({ tool: focused ? focused.type : state.tool, slot: state.slot, shapes: entryShapes, point: state.site });
  }
  // choosing a tool opens its form (the Route tool: the Route plan section); big layout only, where the
  // folds live in the floating panel and opening one does not scroll the page
  function entryFold(tool) {
    if (!mapView?.layoutBig) return;
    if (tool === 'route') mapView.setFold('plan', true);
    else if (shapeEntry) mapView.setFold('coords', true);
  }
  function applyRelay(r) {
    if (!relayCard) return;
    const preset = RELAY_PRESETS.find((x) => x.id === (r?.presetId ?? (r ? null : RELAY_PRESETS[0].id)));
    const opts = { minElDeg: r?.minElDeg ?? 0 };
    if (preset) relayCard.setOrbit({ ...preset.elements }, preset.id, opts);
    else if (r?.elements) relayCard.setOrbit({ ...r.elements }, null, opts);
  }
  if (state.relay) applyRelay(state.relay);
  function scenarioLabels() {
    const { altScenario, sameSite } = derived;
    const altDay = fmtDay(altScenario.landingMs);
    return { plannedLabel: fmtDay(state.landingMs), altLabel: sameSite ? altDay : `${altScenario.site.name}, ${altDay}` };
  }
  // phase 5: the energy and relay cards work only while their tab of the open detail sheet shows
  function refreshFolds() {
    if (!mapView || !derived || !sheet?.isOpen() || !state.windowOn) return;
    const tab = sheet.activeTab();
    if (energyCard && tab === 'power') energyCard.update(lastEnergyParams());
    if (relayCard && tab === 'comms') relayCard.update(relayParams());
  }
  // K's hand-off §10: the summarizePair stays when compared (same length as the Compare card), else the planned one
  function relayParams() {
    const { planned, alt, cmpPlanned, altScenario, compared } = derived;
    const labels = scenarioLabels();
    return {
      landingMs: state.landingMs, cursorMs: state.cursorMs,
      planned: { label: labels.plannedLabel, site: state.site, mask: derived.skyline, summary: compared ? cmpPlanned : planned },
      alt: compared ? { label: labels.altLabel, site: altScenario.site, mask: sky(altScenario.site), summary: alt } : null,
    };
  }
  // R's hand-off §8: the Route plan card. Plans on the 240 m grid (loaded on demand), with the Sun shares of
  // the planned stay's heat jobs and the official PSR map when they are in. The picked candidate becomes the
  // current Route shape, simplified to 0.25 km so the shapes layer does not draw 150 vertex dots; the
  // candidates themselves are drawn from the full polylines.
  let rp = { points: state.routePlan?.points ?? null, maxSlopeDeg: state.routePlan?.maxSlopeDeg ?? null, plan: null, selected: null, hovered: null }, rpAbort = null, plannedRoute = null;
  // fix L5: a planned route in the hash is planned again once the first heat map is in
  let rpRestore = state.routePlan?.selected ? { ...state.routePlan } : null;
  function persistRoutePlan() {
    const routePlan = cleanRoutePlan(rp.points ? { points: rp.points, maxSlopeDeg: rp.maxSlopeDeg, selected: rp.selected } : null);
    writeRoutePlan(routePlan);   // kept until the user clears it or draws a new one (mission-flow.js)
    persist({ routePlan });
  }
  const routePlanCard = mapView ? createRoutePlanCard({ actionBar: mapView?.actionBar, maxLatDeg: 90 }, {
    onPoints: (points) => { rp = { ...rp, points }; routePlanCard.update({ points }); redrawRoutes(); persistRoutePlan(); },
    onLimit: (deg) => { rp = { ...rp, maxSlopeDeg: deg }; persistRoutePlan(); },
    onPlan: ({ points, maxSlopeDeg, mobility }) => { rp = { ...rp, mobility, departMs: null }; routePlanCard.update({ departures: null }); runPlan(points, maxSlopeDeg).catch(() => {}); },
    onPower: (power) => { rp = { ...rp, power }; routePlanCard.update({ departures: null }); updateEnergy(); },
    onDepartNow: () => { rp = { ...rp, departMs: timelineNow() }; updateEnergy(); },
    onFindDepartures: () => {
      const r = rp.plan?.ok ? rp.plan.routes.find((x) => x.id === rp.selected) : null;
      const g = plan?.fine?.grid ?? coarse?.grid;
      if (!r?.profile || !rp.plan.mobility || !g) return;
      const fromMs = Math.max(eph.startMs, state.landingMs ?? timelineNow());
      const scan = scanDepartures(r.profile, { mob: rp.plan.mobility, power: rp.power ?? {}, sky: skyAny(g), fromMs, toMs: Math.min(eph.endMs, fromMs + 60 * 86400e3) });
      routePlanCard.update({ departures: { routeId: r.id, scan } });
    },
    onUseDeparture: (ms) => { rp = { ...rp, departMs: ms }; updateEnergy(); },
    // phase 6: hand the selected route and its drive to the 3D globe
    onFly3d: () => openFull3d(),
    onFinalise: () => goFinalise(),
    // the self-driving planner (route-rrt.js)
    onAutoRun: ({ points, maxSlopeDeg, mobility }) => { rp = { ...rp, mobility }; runAuto(points, maxSlopeDeg).catch(() => {}); },
    onAutoCancel: () => autoAbort?.abort(),
    onAutoUse: () => useAuto(),
    onAutoTrees: (on) => setAuto({ showTrees: on }),
    onColour: (mode) => { rp = { ...rp, routeColour: mode }; redrawRoutes(); },
    onInset3d: () => inset3d.toggle(),
    insetOpen: () => inset3d.isOpen(),
    onMissionRecord: () => missionRecord(),
    onMissionLoad: (rec) => { loadMission(rec).catch(() => {}); },
    onStation: (st) => { rp = { ...rp, station: st, stationOff: !st, coverage: null }; updateComms(); },
    onCancel: () => rpAbort?.abort(),
    onReveal: () => mapView?.setFold('plan', true),
    onPick: (id) => { pickPlanned(id); fitPlanned(id); },
    onHover: (id) => { rp = { ...rp, hovered: id }; routePlanCard.update({ hovered: id }); redrawRoutes(); },
  }) : null;
  // the 3D payload of the selected route and its drive, as the globe reads it; null without a route with a profile
  function route3dPayload() {
    const r = rp.plan?.ok ? rp.plan.routes.find((q) => q.id === rp.selected) : null;
    if (!r?.profile) return null;
    const payload = buildPayload({ route: r, drive: rp.energy?.routeId === r.id ? rp.energy.drive : null, links: rp.comms?.routeId === r.id ? rp.comms.links : null, havens: rp.havens?.routeId === r.id ? rp.havens.result : null, power: { batteryWh: 4000, reserve: 0.2, ...(rp.power ?? {}) }, mobility: rp.plan.mobility, heightAtXY: terrainHeight, waypoints: rp.plan.waypoints, traps: rp.plan.traps });
    // the self-driving planner's trees, candidates and trajectory, when it ran for these points
    if (autoMatches()) payload.autonav = autonavPayload(rp.auto.result);
    return payload;
  }
  // writes it for the globe (a tab, or the preview window, which reloads on the storage event); the payload as written
  let lastRoute3d = '';
  function writeRoute3d() {
    const payload = route3dPayload();
    if (!payload) return null;
    const json = JSON.stringify(payload);
    if (json !== lastRoute3d) { try { localStorage.setItem(ROUTE3D_KEY, json); } catch { return null; } lastRoute3d = json; }
    return payload;
  }
  function openFull3d() { if (writeRoute3d()) window.open('globe.html#route=1', '_blank'); }
  // step 2 of the mission: the Finalise page reads the mission and the chosen route from the storage
  function goFinalise() { saveMission(); writeRoute3d(); location.href = stageUrl('finalise', readMission()); }
  // the 3D preview window and the slope legend float over the map's bottom left
  const floats = mapView ? createMapFloats(document) : null;
  const slopeLegend = createSlopeLegend();
  if (floats) floats.append(mapView.terrainEl, slopeLegend.el);   // the Sun & Earth readout and the terrain chip keep the left edge
  const inset3d = createInset3d({ host: floats ?? document.body, beforeOpen: () => !!writeRoute3d(), onFull: () => openFull3d() });
  // while it is open, the globe gets the new payload when the route, its drive, links or havens change
  let insetTimer = 0;
  function pushInset() {
    if (!inset3d.isOpen()) return;
    clearTimeout(insetTimer);
    insetTimer = setTimeout(() => { if (inset3d.isOpen()) writeRoute3d(); }, 150);
  }
  // a mission record of the selected route as it is now (not stored): settings, summary and the 3D payload
  function missionRecord() {
    const r = rp.plan?.ok ? rp.plan.routes.find((q) => q.id === rp.selected) : null;
    const route = route3dPayload();
    if (!r || !route) return null;
    const drive = rp.energy?.routeId === r.id ? rp.energy.drive : null, comms = rp.comms?.routeId === r.id ? rp.comms : null;
    return buildRecord({
      mission: readMission(),
      settings: settingsOf({ maxSlopeDeg: rp.maxSlopeDeg, mobility: rp.plan.mobility, power: rp.power ?? null, station: rp.station ?? { ...STATION_DEFAULTS }, stationOff: !!rp.stationOff, departMs: rp.departMs ?? null }),
      summary: summaryOf({ route: r, plan: rp.plan, drive, comms }),
      route,
    });
  }
  // restores a saved mission: the points, limits, power, station and departure, then plans again and picks its route
  async function loadMission(rec) {
    const inp = recordInputs(rec);
    if (!inp.points?.length || !routePlanCard) return;
    const maxSlopeDeg = inp.maxSlopeDeg ?? rp.maxSlopeDeg ?? 15;
    rp = { ...rp, mobility: inp.mobility ?? undefined, power: inp.power ?? undefined, station: inp.station ?? undefined, stationOff: inp.stationOff, coverage: null, departMs: inp.departMs, selected: null };
    routePlanCard.update({ points: inp.points, maxSlopeDeg, mobility: inp.mobility, power: inp.power, station: inp.stationOff ? null : inp.station ?? { ...STATION_DEFAULTS }, departures: null });
    rp = { ...rp, points: inp.points, maxSlopeDeg };
    persistRoutePlan();
    await runPlan(inp.points, maxSlopeDeg, { pick: inp.routeId ?? 'short' });
  }
  if (routePlanCard) mapView.mountFold('plan', routePlanCard.el);

  // ---- Where to land in the Map's panel (ui/landcard.js; the planner's method, lander/landeval.js). The target is a
  // point (a click on the Moon while the panel is open; the site when it opens) or a drawn region (Where to land in
  // A / B); the settings sit in the panel and nothing runs until Start screening. The globe shows the point, the
  // search square or the filled region, and the numbered spots; Use this site makes one the mission's site ----
  const LAND_KEY = 'lsn-land-params';
  const baseVehicle = () => cleanVehicle(readMission()?.vehicle ?? { ...VEHICLE_DEFAULTS });
  const v0 = baseVehicle();
  let landParams = {
    slopeDeg: v0.touchdown.maxSlopeDeg, downrangeM: ELLIPSE.downrangeM, crossrangeM: ELLIPSE.crossrangeM,
    batteryWh: v0.batteryWh, loadW: v0.loadsW.surface, reservePct: Math.round(v0.batteryMinSoc * 100),
    minSunPct: 0, minEarthPct: 0, radiusKm: 15, cells: 500,
    ...(() => { try { return JSON.parse(localStorage.getItem(LAND_KEY) ?? 'null') ?? {}; } catch { return {}; } })(),
  };
  // the mission's vehicle with the screening settings over it (the settings stay the screen's own: Finalise keeps its vehicle)
  const landVehicle = () => {
    const v = baseVehicle(), p = landParams;
    return { ...v, batteryWh: p.batteryWh, batteryMinSoc: p.reservePct / 100, loadsW: { ...v.loadsW, surface: p.loadW }, touchdown: { ...v.touchdown, maxSlopeDeg: p.slopeDeg } };
  };
  const landOpts = () => ({ minSun: landParams.minSunPct / 100, minEarth: landParams.minEarthPct / 100, radiusKm: landParams.radiusKm, cells: landParams.cells, ellipse: { downrangeM: landParams.downrangeM, crossrangeM: landParams.crossrangeM } });
  const landEval = createLandingEvaluator({
    eph, sites, meta, getDem: () => dem, siteCtx: globalSites,
    hires: (() => { const m = readJson('data-hires'); return m ? createHiresSet(m, (name) => loadData(name, { timeoutMs: 60000 })) : null; })(),
    getVehicle: landVehicle,
    // as the planner page: the first lit window from two days before the planned landing (or from the playhead)
    getFromMs: () => (state.windowOn && Number.isFinite(state.landingMs) ? state.landingMs - 2 * DAY_MS : state.cursorMs),
    getStayDays: () => state.stayDays,
  });
  let land = { pick: null, region: null, busy: null, result: null, sel: 0, error: null };
  const landCard = mapView ? createLandCard({ actionBar: mapView.actionBar }, {
    onUse: (c) => useLanding(c),
    onRoute: (c) => useLanding(c, { route: true }),
    onStart: () => runLanding(),
    onSelect: (n) => selectLanding(n),
    onParams: (p) => { landParams = p; try { localStorage.setItem(LAND_KEY, JSON.stringify(p)); } catch { /* not remembered */ } showLanding(); },
  }) : null;
  if (landCard) mapView.mountFold('land', landCard.el);
  function landAssume() {
    const v = landVehicle();
    return `With these settings: ${landParams.downrangeM} × ${landParams.crossrangeM} m landing ellipse, slope limit ${v.touchdown.maxSlopeDeg}°, battery ${v.batteryWh} Wh with ${Math.round(v.batteryMinSoc * 100)} % reserve on ${v.loadsW.surface} W = ${batteryHours(v).toFixed(1)} h of darkness${landParams.minSunPct ? `, Sun ≥ ${landParams.minSunPct} %` : ''}${landParams.minEarthPct ? `, Earth ≥ ${landParams.minEarthPct} %` : ''}.`;
  }
  function showLanding() {
    landCard?.update({ ...land, assume: landAssume(), params: landParams, stayDays: state.stayDays });
    mapView?.setFoldSummary('land', land.result ? land.result.list[land.sel]?.verdict.grade ?? '' : land.busy ? 'Screening…' : land.region ? `Region ${land.region}` : land.pick ? 'Point' : 'Click the Moon');
    landMarks();
  }
  // the point, the square and the spots on the globe, while the panel is open (globemap.js skips an unchanged set)
  function landMarks() {
    if (!globeMap) return;
    if (kind !== 'land' || !(land.pick || land.region)) { globeMap.setLanding(null); return; }
    // in a region every result is a numbered spot (1…5); around a point the point itself is result 0
    const off = land.region ? 1 : 0, from = land.region ? 0 : 1;
    const spots = (land.result?.list ?? []).slice(from).map((c, i) => ({ n: i + 1, latDeg: c.latDeg, lonDeg: c.lonDeg, grade: c.verdict.grade, title: `${c.name}: ${c.verdict.text}` }));
    globeMap.setLanding({ pick: land.pick, box: land.box ?? null, spots, sel: land.sel + off });
  }
  // the target: a point (ready, not run)
  function proposeLanding(p) {
    landEval.cancel();
    const pick = { latDeg: +p.latDeg.toFixed(5), lonDeg: +(((p.lonDeg % 360) + 360) % 360).toFixed(5) };
    land = { pick, region: null, busy: null, result: null, sel: 0, error: null, box: null };
    showLanding();
  }
  // the target: a drawn region (its outline is on the globe; it is filled while it is the target)
  function searchRegion(slot) {
    if (!shapes[slot]) return;
    landEval.cancel();
    land = { pick: null, region: slot, busy: null, result: null, sel: 0, error: null, box: null };
    kind = 'land';
    update({ tool: 'select', slot });
    showLanding();
  }
  // Start screening: the point's search or the region's, with the settings
  function runLanding() {
    if (!(land.pick || land.region) || land.busy) return;
    const token = {}, region = land.region, pick = land.pick;
    land = { ...land, busy: { stage: 1, f: 0 }, result: null, sel: 0, error: null, box: null, token };
    showLanding();
    const hooks = {
      onGrid: (g) => { if (land.token === token && g.box && land.box !== g.box) { land.box = g.box; landMarks(); } },
      onProgress: (stage, f) => { if (land.token !== token) return; land.busy = { stage, f }; landCard?.update({ busy: land.busy }); },
    };
    const job = region ? landEval.evaluateRegion(shapes[region], hooks, landOpts()) : landEval.evaluate(pick.latDeg, pick.lonDeg, hooks, landOpts());
    job.then((res) => {
      if (!res || land.token !== token) return;
      land = { ...land, busy: null, result: res, sel: 0 };
      showLanding();
    }).catch((e) => {
      if (land.token !== token) return;
      land = { ...land, busy: null, error: `The search failed: ${e?.message ?? e}` };
      showLanding();
    });
  }
  // the Regions panel's bar: Where to land in the current region
  function syncRegionLandBar() {
    const slot = state.slot ?? 'A', sh = shapes[slot];
    mapView?.actionBar.set('region', 'land', sh ? [{ id: 'land-region', label: `Where to land in ${slot}`, short: 'Land', icon: 'go', title: `Screen region ${slot} for the best landing spots: opens Where to land with the region as the target; set the screening, then Start screening`, onClick: () => searchRegion(slot) }] : []);
  }
  function selectLanding(n) {
    const c = land.result?.list[n];
    if (!c) return;
    land = { ...land, sel: n };
    showLanding();
    globeMap?.flyTo({ lat: c.latDeg, lon: c.lonDeg, dist: Math.min(globeMap.camera?.dist ?? 120, 120) });
  }
  // the chosen spot becomes the mission's site with its first lit landing time (the mission and the hash; the regions
  // stay). A route planned before belongs to the old site, so it goes. route: open route planning from the spot
  // (plan=1: the Route tool with the spot as the start; the first click on the Moon continues from it)
  function useLanding(c, { route = false } = {}) {
    const listed = sites.find((s) => s.id === c.site.id);
    clearRoute();
    const m = writeMission({ siteId: listed ? listed.id : null, siteName: listed ? listed.name : 'Map point', latDeg: c.latDeg, lonDeg: c.lonDeg, landingMs: c.landingMs, landed: null });
    kind = 'point';
    globeMap?.setLanding(null);
    // the regions and the view stay (without z / cx / cy the map's view resets and the globe flies to the pole); the
    // camera then goes to the new site (syncGlobeSite)
    const url = stageUrl(route ? 'rover' : 'map', m), keep = location.hash.match(/(^|[#&])(ra|rb|z|cx|cy)=[^&]*/g) ?? [];
    location.hash = url.slice(url.indexOf('#')) + keep.map((k) => `&${k.replace(/^[#&]/, '')}`).join('');
  }
  function openLanding() {
    kind = 'land';
    update(state.view !== 'map' ? { view: 'map', tool: 'select' } : { tool: 'select' });
    if (!land.pick && !land.region && state.site) proposeLanding(state.site);   // the site as the first target; Start runs it
    else showLanding();
  }
  if (routePlanCard && rp.points) routePlanCard.update({ points: rp.points, ...(rp.maxSlopeDeg ? { maxSlopeDeg: rp.maxSlopeDeg } : {}) });

  function redrawRoutes() {
    // the self-driving layer is drawn only while its points are the current ones
    if (rp.auto?.result && !!rp.auto.draw !== autoMatches()) rp = { ...rp, auto: { ...rp.auto, draw: autoMatches() ? autoDraw(rp.auto) : null } };
    mapView?.frame.redrawShapes({ routePlan: rp });
    const sel = rp.plan?.ok ? rp.plan.routes.find((x) => x.id === rp.selected) : null;
    slopeLegend.setShown(rp.routeColour !== 'plain' && !!sel?.profile?.x?.length);
    // every route is drawn on the globe itself (the polar picture leaves routes out)
    if (globeMap) {
      // while Where to land is open the route planned before is out of the way (a spot chosen there replaces it)
      if (!rp.points?.length || kind === 'land') globeMap.setGlobalRoute(null);
      else {
        const ll = (pts) => (pts ?? []).map(([x, y]) => fromXY(x, y));
        const payload = sel?.profile ? route3dPayload() : null;
        globeMap.setGlobalRoute({
          key: [rp.selected, rp.plan?.ms ?? null, rp.energy?.departMs ?? null, rp.havens?.stamp ?? null, rp.auto?.draw ? 1 : 0],
          payload, colourBy: rp.routeColour === 'plain' ? 'state' : 'slope',
          candidates: rp.plan?.ok ? rp.plan.routes.filter((r) => r.id !== rp.selected && r.points?.length && !r.sameAs).map((r) => ({ id: r.id, points: ll(r.points) })) : [],
          hand: rp.plan?.ok ? null : ll(rp.points), waypoints: ll(rp.plan?.waypoints ?? rp.points),
        });
      }
    }
  }
  function dem240() {
    const l = pyramid?.levels.find((x) => !x.tiled && x.kmPerPixel === 0.24);
    if (l) return Promise.resolve(l);
    return loadData('dem_240m').then((bytes) => { if (!pyramid.levels.some((x) => !x.tiled && x.kmPerPixel === 0.24)) onPack('dem_240m', bytes); packs.dem_240m = 'ok'; return pyramid.levels.find((x) => !x.tiled && x.kmPerPixel === 0.24); });
  }
  // the same planner on the global LOLA terrain (474 m) around the route, in a local frame centred on it; the Sun
  // share for the sunny candidate from the ephemeris with a smooth horizon (globalheat.js); no PSR outside the poles
  async function planGlobal(points, maxSlopeDeg, signal) {
    const lls = points.map(([x, y]) => fromXY(x, y));
    const c = centreOf(lls), frameL = createLocalFrame(c.latDeg, c.lonDeg);
    const loc = lls.map((p) => frameL.toLocal(p.latDeg, p.lonDeg));
    const halfKm = Math.min(420, Math.max(...loc.flat().map(Math.abs)) + 45);
    const pad = halfKm / 30.3, la0 = Math.max(-90, Math.min(...lls.map((p) => p.latDeg)) - pad), la1 = Math.min(90, Math.max(...lls.map((p) => p.latDeg)) + pad);
    const lonPad = Math.min(180, pad / Math.max(0.05, Math.cos(Math.max(Math.abs(la0), Math.abs(la1)) * Math.PI / 180)));
    const lons = lls.map((p) => p.lonDeg), lo0 = Math.min(...lons) - lonPad, lo1 = Math.max(...lons) + lonPad;
    routePlanCard.update({ progress: 0.02 });
    await globeMap.need(la0, la1, lo0, lo1);
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const dem = localDem(frameL, { halfKm, kmPerPixel: 0.474, heightAt: (la, lo) => globeMap.heightAt(la, lo) });
    const sunAt = (x, y) => { const p = frameL.fromLocal(x, y); return globeMap.sunShare(p.latDeg, p.lonDeg); };
    const result = await planRoutes({ points: loc, dem, sunAt, isPsr: null, maxSlopeDeg, mobility: rp.mobility ?? {} },
      { signal, onProgress: (f) => routePlanCard.update({ progress: f }) });
    const back = mapPlan(result, ([x, y]) => { const p = frameL.fromLocal(x, y); return toXY(p.latDeg, p.lonDeg); });
    back.global = { terrainM: 474, centre: c };
    return back;
  }
  async function runPlan(points, maxSlopeDeg, { pick = 'short', fit = true } = {}) {
    rpAbort?.abort();
    const ac = new AbortController();
    rpAbort = ac;
    routePlanCard.update({ points, maxSlopeDeg, running: true, progress: 0 });
    try {
      if (globeMap && isGlobalRoute(points)) {
        const result = await planGlobal(points, maxSlopeDeg, ac.signal);
        const first = result.ok ? (result.routes.some((r) => r.id === pick && r.points?.length) ? pick : 'short') : null;
        rp = { ...rp, points, maxSlopeDeg, plan: result, selected: first, hovered: null };
        routePlanCard.update({ running: false, plan: result, selected: rp.selected, hovered: null });
        if (result.ok) { pickPlanned(first); if (fit) fitPlanned(null); } else { redrawRoutes(); persistRoutePlan(); }
        return result;
      }
      const dem = await dem240();
      if (ac.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      loadExtras();
      // fix R2 (workstream R): always the full 2 km map job of the stay, never the viewport's 1 km job,
      // so the sunlit figures and the sunny search do not depend on the zoom at which Plan was pressed
      const sunAt = sunFromJobs(plan);
      // phase 2: always with the rover's directional limits (the card's values, or the defaults)
      const result = await planRoutes({ points, dem, sunAt, isPsr: psr ? (x, y) => psr.isPsr(x, y) : null, maxSlopeDeg, mobility: rp.mobility ?? {} },
        { signal: ac.signal, onProgress: (f) => routePlanCard.update({ progress: f }) });
      const first = result.ok ? (result.routes.some((r) => r.id === pick && r.points?.length) ? pick : 'short') : null;
      rp = { ...rp, points, maxSlopeDeg, plan: result, selected: first, hovered: null };
      routePlanCard.update({ running: false, plan: result, selected: rp.selected, hovered: null });
      if (result.ok) { pickPlanned(first); if (fit) fitPlanned(null); } else { redrawRoutes(); persistRoutePlan(); }
      return result;
    } catch (e) {
      routePlanCard.update({ running: false });
      if (e?.name !== 'AbortError') throw e;
      return null;
    } finally {
      if (rpAbort === ac) rpAbort = null;
    }
  }
  // The self-driving planner (route-rrt.js): B-RRT* leg by leg on the 240 m grid. Its state lives in rp.auto:
  // { running, progress, result, used, showTrees, draw (what the map layer draws) }.
  let autoAbort = null;
  const sameWps = (a, b) => !!a && !!b && a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i][0]) < 0.05 && Math.abs(p[1] - b[i][1]) < 0.05);
  const autoMatches = () => !!rp.auto?.result && sameWps(rp.auto.result.waypoints, rp.points);
  function autoDraw(a) {
    const r = a.result;
    return r ? { trees: r.trees, candidates: r.candidates, trajectory: r.trajectory, adjusted: r.legs.filter((l) => l.adjustedTo).map((l) => ({ from: l.to, to: l.adjustedTo })), showTrees: a.showTrees !== false } : null;
  }
  function setAuto(p) {
    const prev = rp.auto ?? { showTrees: true };
    const next = { ...prev, ...p };
    if (p.result !== undefined || 'showTrees' in p) next.draw = autoDraw(next);
    rp = { ...rp, auto: next };
    routePlanCard?.update({ auto: next });
    redrawRoutes();
  }
  async function runAuto(points, maxSlopeDeg) {
    autoAbort?.abort();
    const ac = new AbortController();
    autoAbort = ac;
    rp = { ...rp, points, maxSlopeDeg };
    setAuto({ running: true, progress: 0, result: null, draw: null, used: false });
    try {
      const dem = await dem240();
      if (ac.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const result = await planSelfDriving({ points, dem, maxSlopeDeg, mobility: rp.mobility ?? {} },
        { signal: ac.signal, onProgress: (f) => { rp = { ...rp, auto: { ...rp.auto, progress: f } }; routePlanCard?.update({ auto: rp.auto }); } });
      setAuto({ running: false, progress: 1, result });
      if (result.trajectory.length > 1) mapView?.fitRoute(result.trajectory);
      return result;
    } catch (e) {
      setAuto({ running: false });
      if (e?.name !== 'AbortError') throw e;
      return null;
    } finally {
      if (autoAbort === ac) autoAbort = null;
    }
  }
  // "Use this path": the trajectory becomes a fourth candidate, selected, so the battery run, the station links,
  // the havens and the 3D hand-off work on it as on the others. Without a matching A* plan (for example when it was
  // blocked) the plan holds just this route.
  function useAuto() {
    const res = rp.auto?.result;
    if (!res?.ok || !routePlanCard) return;
    const route = {
      id: 'auto', label: 'Self-driving', points: res.trajectory, lengthKm: res.lengthKm, maxSlopeDeg: res.maxSlopeDeg, meanSlopeDeg: res.meanSlopeDeg,
      sunShare: null, sunKnown: 0, psrKm: null, sameAs: null, unavailable: null,
      climbMaxDeg: res.climbMaxDeg, descentMaxDeg: res.descentMaxDeg, crossMaxDeg: res.crossMaxDeg, hours: res.hours, oneWayKm: res.oneWayKm, oneWay: res.oneWay, profile: res.profile,
    };
    const base = rp.plan?.ok && sameWps(rp.plan.waypoints, res.waypoints) ? rp.plan
      : { ok: true, error: null, blocked: null, routes: [], limitDeg: res.limitDeg, baselineKm: 0.24, waypoints: res.waypoints, nodes: 0, ms: res.ms, mobility: res.mobility, returnable: res.oneWayKm <= 0.05, selfDriving: true };
    const plan = { ...base, routes: [...base.routes.filter((r) => r.id !== 'auto'), route] };
    rp = { ...rp, plan };
    routePlanCard.update({ plan });
    setAuto({ used: true });
    pickPlanned('auto');
  }
  // phase 3: the selected route's drive, run forward from the departure (the timeline time when it was planned)
  function timelineNow() {
    try { return timeline.getState().nowMs; } catch { return state.cursorMs ?? state.landingMs; }
  }
  function updateEnergy() {
    const r = rp.plan?.ok ? rp.plan.routes.find((x) => x.id === rp.selected) : null;
    const g = plan?.fine?.grid ?? coarse?.grid;
    if (!r?.profile || !rp.plan.mobility || (!g && !rp.plan.global)) { rp = { ...rp, energy: null }; routePlanCard?.update({ energy: null }); return; }
    const departMs = rp.departMs ?? timelineNow();
    const drive = simulateDrive(r.profile, { mob: rp.plan.mobility, power: rp.power ?? {}, departMs, sky: skyAny(g) });
    rp = { ...rp, departMs, energy: { drive, departMs, routeId: r.id, skyKm: rp.plan.global ? null : g.cellKm } };
    routePlanCard?.update({ energy: rp.energy });
    updateHavens();
    updateComms();
    redrawRoutes();
    // the preview window comes back as it was left, once there is a route to show
    if (!insetRestored && inset3d.wanted() && inset3d.open()) insetRestored = true;
    pushInset();
  }
  let insetRestored = false;
  // phase 5: safe havens from checkpoints along the drive, on the planner's 240 m grid
  function updateHavens() {
    const r = rp.plan?.ok ? rp.plan.routes.find((x) => x.id === rp.selected) : null;
    const dem240 = pyramid?.levels.find((x) => !x.tiled && x.kmPerPixel === 0.24);
    const g = plan?.fine?.grid ?? coarse?.grid;
    // (havens are searched on the polar 240 m grid: not for a route planned on the global terrain)
    if (!r?.profile || !rp.energy || !dem240 || !g || rp.plan.global) { rp = { ...rp, havens: null }; routePlanCard?.update({ havens: null }); return; }
    const result = findHavens({ dem: dem240, mob: rp.plan.mobility, power: rp.power ?? {}, profile: r.profile, drive: rp.energy.drive, sky: skyAny(g) });
    rp = { ...rp, havens: { routeId: r.id, result, stamp: Date.now() } };
    routePlanCard?.update({ havens: rp.havens });
    pushInset();
  }
  // phase 4: the surface station's coverage and the links along the selected route, on the finest terrain loaded
  function terrainHeight(x, y) {
    const ls = pyramid?.levels ?? [];
    for (let i = ls.length - 1; i >= 0; i--) { const v = ls[i].sample(x, y); if (v === v) return v; }
    // away from the polar data: the global LOLA terrain
    if (globeMap) { const p = fromXY(x, y), h = globeMap.heightAt(p.latDeg, p.lonDeg); if (Number.isFinite(h)) return h; }
    return null;
  }
  // the Sun and Earth over the local skyline for the drive: the polar horizon grid where it exists, elsewhere a
  // smooth horizon from the ephemeris (labelled in the route card's note)
  function skyAny(g) {
    const polar = g ? skyFromGrid(g, eph, bodyAzEl, fromXY) : null;
    return (x, y, tMs) => {
      const s0 = polar ? polar(x, y, tMs) : null;
      if (s0 && Number.isFinite(s0.sunDeg)) return s0;
      const { latDeg, lonDeg } = fromXY(x, y), r = bodyAzEl(eph, { latDeg, lonDeg }, tMs);
      if (!r) return null;
      return { sunDeg: r.sun.elDeg, earthDeg: r.earth.elDeg, azDeg: r.sun.azDeg, elDeg: r.sun.elDeg, earthAzDeg: r.earth.azDeg, earthElDeg: r.earth.elDeg };
    };
  }
  function updateComms() {
    const r = rp.plan?.ok ? rp.plan.routes.find((x) => x.id === rp.selected) : null;
    if (!r?.profile) { routePlanCard?.update({ comms: null }); return; }
    const st = rp.stationOff ? null : (rp.station ?? { ...STATION_DEFAULTS });
    const cov = st ? (rp.coverage ??= stationCoverage(terrainHeight, st)) : null;
    const links = st ? routeLinks(terrainHeight, r.profile, st) : null;
    const per = rp.energy?.routeId === r.id ? rp.energy.drive.perSample : null;
    const summary = linkSummary(r.profile, links, per?.earth ?? null, per?.tMs ?? null);
    rp = { ...rp, coverage: cov, comms: { routeId: r.id, summary, links, earth: per?.earth ?? null, coverage: cov, stamp: Date.now() } };
    routePlanCard?.update({ comms: rp.comms });
    redrawRoutes();
    pushInset();
  }
  function pickPlanned(id) {
    const r = rp.plan?.routes.find((x) => x.id === id);
    if (!r?.points?.length) return;
    rp = { ...rp, selected: id };
    routePlanCard.update({ selected: id });
    plannedRoute = { id, label: r.label, maxSlopeDeg: r.maxSlopeDeg, baselineKm: rp.plan.baselineKm, lengthKm: r.lengthKm };
    // (the polar map's route card measures in its plane on the polar DEM: not for a route on the global terrain,
    // whose figures are in the Route plan card)
    api.setRoute(isGlobalRoute(rp.points) ? null : simplify(r.points, 0.25));
    persistRoutePlan();
    updateEnergy();
  }
  // fix L3: ease the map to the candidates (all of them after planning, the picked one on a click), in the
  // space between the open panels and bars; the panels stay as they are
  // a route drawn by hand (the polar map's Route tool, or the globe's anywhere on the Moon) fills the Route plan card's
  // points; planning waits for its Plan button
  function setHandRoute(points) {
    kind = 'route';
    plannedRoute = null;
    rp = { ...rp, points, plan: null, selected: null };
    routePlanCard?.update({ points, plan: null, selected: null });
    api.setRoute(isGlobalRoute(points) ? null : points);
    persistRoutePlan();
    redrawRoutes();
  }
  // a route with a point outside the polar data (north of 80°S) is planned on the global LOLA terrain in a local
  // frame (localframe.js) and drawn on the globe itself
  const isGlobalRoute = (pts) => (pts ?? []).some((p) => fromXY(p[0], p[1]).latDeg > TERRAIN_MAX_LAT);
  function fitPlanned(id) {
    if (!mapView) return;
    if (globeMap) {   // the Map is the globe: frame the routes on it
      const routes = (rp.plan?.routes ?? []).filter((r) => r.points?.length && (!id || r.id === id));
      globeMap.flyToPoints(routes.flatMap((r) => r.points).map(([x, y]) => fromXY(x, y)));
      return;
    }
    const routes = (rp.plan?.routes ?? []).filter((r) => r.points?.length && (!id || r.id === id));
    mapView?.fitRoute(routes.flatMap((r) => r.points));
  }
  // the rover route gone everywhere: the card's points and plan, the hash and the browser's copy, the globe
  function clearRoute() {
    clearPlanned();
    routePoints = null;
    routePlanCard?.update({ points: null, plan: null, selected: null });
    redrawRoutes();
    api.setRoute(null);   // re-renders: the rail's Clear route goes with the route
  }
  function clearPlanned() {
    rpAbort?.abort();
    autoAbort?.abort();
    rp = { ...rp, auto: null };
    routePlanCard?.update({ auto: null });
    plannedRoute = null;
    rpRestore = null;
    rp = { ...rp, points: null, plan: null, selected: null, hovered: null };
    routePlanCard?.update({ plan: null, selected: null, hovered: null, running: false });
    persistRoutePlan();
  }

  function lastEnergyParams() {
    const { altScenario, compared, alt } = derived;
    return {
      eph, planned: { site: state.site, landingMs: state.landingMs, mask: sky(state.site) },
      alternative: compared ? { ...altScenario, mask: sky(altScenario.site) } : null,
      stayDays: state.stayDays, cursorMs: state.cursorMs, ...scenarioLabels(),
      altNote: alt === null ? 'The alternative lands outside the ephemeris, which covers 1 Nov 2026 to 1 Jan 2029.' : undefined,
    };
  }
  if (!plan) shell.regions.mapCard.append(h('div', { class: 'card-head' }, h('h2', { id: 'lsn-map-head' }, 'South pole map')), h('p', { class: 'map-message' }, 'Couldn’t load the terrain data.'));

  // "5 days", "5.5 days", "1 day", or a span under a day ("23 h").
  function daysText(ms) {
    if (ms < DAY_MS) return fmtSpan(ms);
    const d = Math.round((ms / DAY_MS) * 10) / 10;
    return d === 1 ? '1 day' : `${d} days`;
  }

  let computedKey = '';
  function compute() {
    const key = `${state.site.id}|${state.site.latDeg}|${state.site.lonDeg}|${state.landingMs}|${state.stayDays}|${state.slipDays}|${state.altSite}`;
    if (key === computedKey && derived) return derived;
    computedKey = key;
    const skyline = sky(state.site);
    // The planned stay as requested drives the charts and the events table.
    const planned = summarize(eph, state.site, state.landingMs, state.stayDays, skyline);
    const altScenario = alternativeOf(state, sites);
    // The comparison uses both stays cut to the same length when the ephemeris end clips either one.
    const pair = summarizePair(eph, { site: state.site, landingMs: state.landingMs, mask: skyline },
      { ...altScenario, mask: sky(altScenario.site) }, state.stayDays, 0);
    const alt = pair.alt;
    const sameSite = altScenario.site.id === state.site.id;
    const compared = alt !== null && !(sameSite && state.slipDays === 0);
    const series = sampleSeries(eph, state.site, planned.startMs, planned.endMs, HOUR_MS, skyline);
    const figures = {};
    for (const site of sites) {
      const s = summarize(eph, site, state.landingMs, state.stayDays, sky(site));
      figures[site.id] = s && s.stayMs > 0 ? s.sunMs / s.stayMs : NaN;
    }
    return { skyline, planned, alt, cmpPlanned: pair.planned, cmpDays: pair.stayDays, altScenario, sameSite, compared, series, figures };
  }

  // phase 5: the detail sheet's head (the old Navigator title, finding and notices) and its three figures
  const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `${MINUS}${-n}` : '0');
  function altHead() {
    const { altScenario, sameSite, compared } = derived;
    if (!compared) return 'Alternative';
    return sameSite ? `${signed(state.slipDays)} d` : altScenario.site.name;
  }
  function renderSheetHead() {
    if (!sheet) return;
    const { planned, alt, cmpPlanned, cmpDays, altScenario, sameSite, compared } = derived;
    const notes = [];
    if (!state.windowOn) notes.push('No mission window. Set one in the time bar, or press Land here now in the inspector; the sky and the rises and sets follow the playhead.');
    else {
      notes.push(findingSentence({
        siteName: state.site.name, altSiteName: altScenario.site.name, sameSite: compared ? sameSite : true,
        slipDays: compared ? state.slipDays : 0, stayDays: compared ? cmpDays : state.stayDays,
        plannedBothMs: compared ? cmpPlanned.bothMs : planned.bothMs, altBothMs: compared ? alt.bothMs : planned.bothMs,
      }));
      if (planned.clipped) notes.push(`Stay shortened to ${daysText(planned.stayMs)}: the ephemeris ends on 1 Jan 2029.`);
    }
    if (!(state.site.latDeg <= TERRAIN_MAX_LAT)) {
      const g = globalSkyNote.get(`${state.site.latDeg.toFixed(5)},${state.site.lonDeg.toFixed(5)}`);
      notes.push(g ? `North of 80°S: the skyline is ${g}. The heat maps here assume a smooth horizon; slope filters, suitability, best cells and permanent shadow need the polar data south of 80°S.` : 'North of 80°S: the skyline is being computed from the global LOLA terrain (a smooth-sphere horizon until then). The heat maps here assume a smooth horizon; slope filters, suitability, best cells and permanent shadow need the polar data south of 80°S.');
    }
    shell.regions.finding.textContent = notes[0] ?? '';
    const rows = compareRows(compared ? cmpPlanned : planned, compared ? alt : null).slice(0, 3);
    const note = (r) => (!compared ? null : r.alt === r.planned ? 'no change' : `${r.alt} ${sameSite ? `if ${signed(state.slipDays)} d` : `at ${altScenario.site.name}`}`);
    const noWin = { overview: notes.join(' '), power: 'Needs a mission window.', comms: 'Needs a mission window.', compare: 'Needs a mission window.' };
    sheet.update({
      title: state.site.name,
      subtitle: `${formatCoords(state.site)}${state.site.verified ? '' : ' approx.'}${state.site.subtitle ? ` · ${state.site.subtitle}` : ''}`,
      headline: state.windowOn ? { overview: notes.join(' '), power: null, comms: null, compare: null } : noWin,
      tiles: { overview: state.windowOn ? rows.map((r) => ({ label: r.label, value: r.planned, note: note(r), tone: r.worse ? 'negative' : null })) : null },
    });
    sheet.el.dataset.window = state.windowOn ? 'on' : 'off';
  }

  function renderCompareCard() {
    const { planned, alt, cmpPlanned, altScenario, sameSite, compared } = derived;
    let altNote = null;
    if (alt === null) altNote = 'The alternative lands outside the ephemeris, which covers 1 Nov 2026 to 1 Jan 2029.';
    else if (!compared) altNote = 'Pick a slip or another site to compare.';
    else if (alt.stayMs < state.stayDays * DAY_MS) altNote = `Both stays are compared over ${daysText(alt.stayMs)}: the ephemeris ends on 1 Jan 2029.`;
    const altDay = fmtDay(altScenario.landingMs);
    renderCompare(shell.regions.compare, {
      planned: compared ? cmpPlanned : planned, alt: compared ? alt : null,
      plannedLabel: fmtDay(state.landingMs),
      altLabel: compared ? (sameSite ? altDay : `${altScenario.site.name}, ${altDay}`) : DASH,
      altNote,
    });
  }

  function cursorBodies() {
    return bodyAzEl(eph, state.site, state.cursorMs);
  }

  // the sheet's charts: the stay's series with a window; without one, the sky around the playhead (the
  // sky dial's month of tracks, sampled hourly)
  function chartSeries() {
    if (state.windowOn) return derived.series;
    const tr = dialTracks();
    return tr.series;
  }
  function renderCharts() {
    renderPanorama(shell.regions.panorama, { series: chartSeries(), cursor: cursorBodies(), siteName: state.site.name, skyline: derived.skyline });
    if (state.windowOn) {
      renderElevation(shell.regions.elevation, {
        series: derived.series, summary: derived.planned, cursorMs: state.cursorMs,
        stayDays: state.stayDays, onScrub: (ms) => timeline.setNow(ms),
      });
    }
  }

  // ---------- map: heat jobs, sliced across animation frames ----------
  const now = { states: null, at: NaN, layer: null };
  const ribbons = new Map();
  let raf = 0;
  let frames = 0;
  const waiters = [];   // commands waiting for the heat of the current state: { test, resolve }

  function heatSpan() {
    const stayMs = state.stayDays * DAY_MS;
    const p0 = state.landingMs;
    const a0 = state.landingMs + state.slipDays * DAY_MS;
    let len = Math.min(stayMs, eph.endMs - p0);
    if (state.mapMode === 'change' && a0 >= eph.startMs && a0 < eph.endMs) len = Math.min(len, eph.endMs - a0);
    return { p0, a0, len };
  }

  function emptyText() {
    if (state.mapMode !== 'change') return null;
    if (state.slipDays === 0) return 'Set a slip to see what changes.';
    const a0 = state.landingMs + state.slipDays * DAY_MS;
    if (!(a0 >= eph.startMs && a0 < eph.endMs)) return 'The alternative lands outside the ephemeris, which covers 1 Nov 2026 to 1 Jan 2029.';
    return null;
  }

  const filtersActive = () => state.maxSlope != null || state.maxDark != null;
  const rankedMode = () => ['both', 'sun', 'earth', 'score'].includes(state.mapMode);
  const weightTotal = () => state.weights.sun + state.weights.earth + state.weights.slope + state.weights.shadow;

  function configureHeat() {
    if (!plan) return;
    const { p0, a0, len } = heatSpan();
    plan.configure({
      p0, a0, len, mode: state.mapMode, viewport: state.viewport,
      // the ground under the frame: the viewport's square in the phase 3 layout, the window in the big one
      bounds: mapView?.frame.boundsFor(state.viewport) ?? null,
      maxSlope: state.maxSlope, maxDark: state.maxDark, weights: state.weights,
      altBlocked: !!emptyText(), regions: polarShapes(), route: routePoints, keepFull: waiters.length > 0,
    });
    liveStates();
  }

  // phase 5: the light at the playhead, on the 2 km grid, once per whole hour of the playhead (the finding's
  // shares and the live veil over the window modes); in Live, zoomed in and paused, the viewport's 1 km
  // states too (fix H2.3, heatplan nowLayer; 2 km while playing, which keeps playback smooth)
  const liveT = () => Math.floor(state.cursorMs / HOUR_MS) * HOUR_MS;
  function liveStates() {
    if (!grid) return false;
    const t = liveT();
    let changed = false;
    if (now.at !== t) { now.states = nowStates(grid, eph, t); now.at = t; changed = true; }
    const fine = state.mapMode === 'now' && !playing() && plan?.fineOn();
    const layer = fine ? plan.nowLayer(t) : null;
    if (layer !== now.layer) { now.layer = layer; changed = true; }
    return changed;
  }

  function insideValues(values) {
    const out = [];
    for (let k = 0; k < values.length; k++) if (inside[k]) out.push(values[k]);
    return Float32Array.from(out);
  }

  // The Map finding, or null while the numbers it needs are still being computed.
  function mapFindingText() {
    const { len } = heatSpan();
    const base = { mode: state.mapMode, stayDays: len / DAY_MS, landingMs: state.landingMs, cursorMs: state.mapMode === 'now' && Number.isFinite(now.at) ? now.at : state.cursorMs, slipDays: state.slipDays, share: 0, loses: 0, gains: 0 };
    if (state.mapMode === 'now') {
      if (!now.states) return null;
      let both = 0, n = 0;
      for (let k = 0; k < grid.count; k++) if (inside[k]) { n++; if (now.states[k] === 3) both++; }
      return mapFinding({ ...base, share: both / n });
    }
    if (state.mapMode === 'change') {
      const e = emptyText();
      if (e) return e;
      const f = plan.full;
      if (!f.planned?.done || !f.alt?.done) return null;
      return mapFinding({ ...base, ...changeShares(insideValues(f.planned.both), insideValues(f.alt.both), len) });
    }
    if (state.mapMode === 'score' && weightTotal() === 0) return 'Set at least one weight.';
    const share = plan.shareAtLeast(state.mapMode, 0.5);
    if (share === null) return null;
    const after = filtersActive() ? ' Only ground that passes the filters counts.' : '';
    if (state.mapMode === 'score') return `${fmtPct(share)} of the mapped area scores 0.5 or more for suitability with these weights.${after}`;
    return mapFinding({ ...base, share }) + after;
  }

  function fmtModeValue(mode, v, len) {
    if (!Number.isFinite(v)) return DASH;
    return mode === 'score' ? v.toFixed(2) : fmtHours(v * len);
  }

  function bestCells() {
    if (!rankedMode() || !plan.fullDone()) return { top: [], best: [] };
    const { len } = heatSpan();
    const cells = plan.best(state.mapMode, 5);
    return {
      top: cells.map((c) => c.cell),
      best: cells.map((c, n) => ({ cell: c.cell, rank: n + 1, coords: formatCoords(grid.cellCenter(c.cell)), value: fmtModeValue(state.mapMode, c.value, len) })),
    };
  }

  // A shape drawn on the globe (latitude/longitude, georegion.js) that lies wholly south of 80°S becomes a polar region in
  // map km, so the polar grids (terrain skylines, slope, darkness) read it: a cap stays a circle (radius in map km at
  // its centre), a box and a polygon become polygons (the box's parallels sampled, at most 24 corners; a box with
  // both corners south of 80°S already arrives square to the polar map, globemap.js boxShape)
  function polarIfInside(sh) {
    if (!isGeo(sh) || !geoOutline(sh).every((q) => q.latDeg <= TERRAIN_MAX_LAT)) return sh;
    if (sh.type === 'circle') { const [cx, cy] = toXY(sh.latDeg, sh.lonDeg); return { type: 'circle', cx, cy, rKm: sh.rKm * mapScaleAt(sh.latDeg) }; }
    // (the coordinates form takes at most 24 corners)
    let ring = sh.type === 'rect' ? geoOutline(sh).slice(0, -1) : sh.pts.map(([la, lo]) => ({ latDeg: la, lonDeg: lo }));
    if (ring.length > 24) { const st = ring.length / 24; ring = Array.from({ length: 24 }, (_, i) => ring[Math.floor(i * st)]); }
    return { type: 'polygon', points: ring.map((q) => toXY(q.latDeg, q.lonDeg).map((v) => Math.round(v * 100) / 100)) };
  }
  // map km per ground km of the polar stereographic map at a latitude (1 at the pole, 1.008 at 80°S)
  const mapScaleAt = (latDeg) => 2 / (1 + Math.sin(-latDeg * Math.PI / 180));
  // Regions north of 80°S (georegion.js) are drawn on the globe in latitude and longitude and read over a smooth
  // horizon; the polar map, its heat plan and the coordinates form take only the polar regions
  function polarShapes() { return { A: isGeo(shapes.A) ? null : shapes.A, B: isGeo(shapes.B) ? null : shapes.B }; }
  const geoCache = {};
  function geoSlot(slot) {
    const sh = shapes[slot];
    const mode = ['sun', 'earth'].includes(state.mapMode) ? state.mapMode : 'both';
    const win = state.windowOn && Number.isFinite(state.landingMs);
    const p0 = win ? state.landingMs : state.cursorMs, len = win ? heatSpan().len : state.stayDays * DAY_MS;
    const key = `${shapeParam(sh)}|${p0}|${len}|${mode}`;
    if (geoCache[slot]?.key !== key) {
      const stats = geoStats(sh, eph, p0, len, { mode });
      const best = stats?.best ? { coords: formatCoords(stats.best), value: `${fmtPct(stats.best.value)} of the ${win ? 'stay' : 'next days'}` } : null;
      geoCache[slot] = { key, slot: { progress: 1, stats, best, mark: null, tier: 'smooth horizon',
        note: `Away from the polar data: the Sun and the Earth over a smooth horizon (assumed, no terrain shadows), on ${stats ? stats.cellDeg.toFixed(2) : '—'}° cells${win ? '' : ' over the next days (no mission window)'}. Passes filters and Suitability need the polar slope and darkness grids.` } };
    }
    return geoCache[slot].slot;
  }

  function regionSlot(slot) {
    if (isGeo(shapes[slot])) return geoSlot(slot);
    const r = plan.region(slot);
    if (!r) return null;
    const stats = { ...r.stats, areaKm2: areaKm2(r.shape) };
    let best = null, mark = null;
    if (r.progress >= 1 && r.stats.best) {
      const c = r.tier.grid.cellCenter(r.stats.best.cell);
      const mode = state.mapMode === 'score' ? 'score' : ['sun', 'earth'].includes(state.mapMode) ? state.mapMode : 'both';
      const value = mode === 'score' ? r.stats.best.value.toFixed(2) : `${fmtPct(r.stats.best.value)} of the stay`;
      best = { coords: formatCoords(c), value };
      mark = { xKm: c.xKm, yKm: c.yKm, name: `Pick the best cell in region ${slot}, ${formatCoords(c)}` };
    }
    return { progress: r.progress, stats, best, mark, tier: r.tier.label };
  }

  function regionCards() {
    if (!plan || (!shapes.A && !shapes.B)) return { regionCard: null, regionBest: { A: null, B: null } };
    const a = regionSlot('A'), b = regionSlot('B');
    const mode = state.mapMode === 'score' ? 'Suitability' : ['sun', 'earth'].includes(state.mapMode) ? MODE_LABEL[state.mapMode] : 'Both in view';
    return {
      regionCard: { stayMs: heatSpan().len, modeLabel: mode, A: a, B: b },
      regionBest: { A: a?.mark ?? null, B: b?.mark ?? null },
    };
  }

  function routeCard() {
    if (!plan || !routePoints) return null;
    const b = bbox({ type: 'route', points: routePoints });
    const r = plan.routeResult(demFor(b));
    // R flagged: the profile's max slope is the map cells' mean slope, the planner's is 240 m node slope
    return r && plannedRoute ? { ...r, planned: plannedRoute } : r;
  }

  function liveCards() {
    const { regionCard, regionBest } = regionCards();
    mapView.setCards({ regionCard, routeCard: routeCard(), regionBest, filters: filterParams() });
  }

  // The stay the ephemeris covers on the map, when it is shorter than the stay asked for (review I5).
  function clippedText() {
    const { len } = heatSpan();
    if (len >= state.stayDays * DAY_MS) return null;
    return `The ephemeris ends 1 Jan 2029, so this stay is cut to ${daysText(Math.max(0, len))}.`;
  }

  function filterParams() {
    return {
      maxSlope: state.maxSlope, maxDark: state.maxDark, passShare: plan ? plan.passShare() : null,
      note: clippedText() ? 'The stay is cut short by the end of the ephemeris, so the longest dark here is not reliable.' : null,
    };
  }

  function fineLoading() {
    return state.mapMode !== 'now' && neededPacks(state.viewport).some((n) => FINE_PACKS.includes(n) && packs[n] === 'loading');
  }

  function visibleJob() {
    return plan.viewJob ?? plan.full.planned;
  }

  function frameParams(working) {
    return {
      heat: { layers: plan.layers(), states: state.mapMode === 'now' ? now.states : null, nowLayer: state.mapMode === 'now' ? now.layer : null, coarseInside: inside },
      lowRes: playing() && state.mapMode === 'now', smoothOff: heatSmoothOption(settings.get()) === false,
      // while the 1 km grid the viewport asks for is still loading, the map is not final either
      working: working || fineLoading(), progressJob: state.mapMode === 'now' ? null : visibleJob(),
      tierLabel: state.mapMode === 'now' ? (now.layer && !now.layer.full ? '1 km' : '2 km') : plan.viewJob ? '1 km' : '2 km',
      psrLayer: showPsr ? psr : null,
      visibleDone: plan.visibleDone() && !fineLoading(),
    };
  }

  let firstHeatMs = null;
  function finishHeat() {
    loadExtras();
    if (rpRestore && plan.fullDone() && routePlanCard) {
      const r = rpRestore; rpRestore = null;
      runPlan(r.points, r.maxSlopeDeg ?? undefined, { pick: r.selected, fit: false }).catch(() => {});
    }
    const text = mapFindingText();
    if (text !== null) shell.regions.mapFinding.textContent = text;
    const { top, best } = bestCells();
    mapView.setTop(top, best);
    liveCards();
    if (firstHeatMs === null && plan.fullDone()) {
      firstHeatMs = Math.round(performance.now());
      document.documentElement.dataset.heatDoneMs = String(firstHeatMs);
    }
  }

  function checkWaiters() {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].test()) { const w = waiters.splice(i, 1)[0]; w.resolve(); }
    }
  }

  function waitFor(test) {
    return new Promise((resolve) => {
      waiters.push({ test, resolve });
      configureHeat();
      checkWaiters();
      kick();
    });
  }

  const HEAT_PAINT_MS = 250;
  let lastHeatPaint = 0;
  function heatLoop() {
    raf = 0;
    const mapOn = mapView;
    if (!plan || (!mapOn && !waiters.length)) return;
    const working = plan.step(SLICE_MS);
    if (mapOn) {
      // G (round 3): while the heat is still working, the map repaints a few times a second, not every frame:
      // with the smoothed heat a repaint costs tens of ms, which left the job 12 ms of every ~66 ms frame
      // (about 15 fps, 13.8 s at zoom 2.05); the finished map paints at once
      const t = performance.now();
      if (!working || t - lastHeatPaint >= HEAT_PAINT_MS) { lastHeatPaint = t; mapView.frameUpdate(frameParams(working)); }
      if (working && ++frames % 8 === 0) liveCards();
    }
    checkWaiters();
    if (working) raf = requestAnimationFrame(heatLoop);
    else if (mapOn) finishHeat();
  }

  function kick() {
    if (!raf && plan) raf = requestAnimationFrame(heatLoop);
  }

  function ribbonFor(site) {
    const key = `${site.latDeg.toFixed(5)},${site.lonDeg.toFixed(5)}|${state.stayDays}`;
    if (!ribbons.has(key)) ribbons.set(key, landingRibbon(eph, site, sky(site), state.stayDays));
    return ribbons.get(key);
  }

  // The hover card and the readout line: the numbers at a map point, and which grid they come from.
  function describe(xKm, yKm, target) {
    if (!plan) return null;
    const { latDeg, lonDeg } = fromXY(xKm, yKm);
    const heightM = heightAtXY(xKm, yKm);
    const where = `${formatCoords({ latDeg, lonDeg })}, ${fmtHeight(heightM)}`;
    const info = Math.hypot(xKm, yKm) <= 2 * 1737.4 * Math.tan((5 * Math.PI) / 180) ? plan.infoAt(xKm, yKm) : null;
    const mode = state.mapMode;
    const { len } = heatSpan();
    let value = null, text = null;
    const empty = emptyText();
    if (info && !empty) {
      if (mode === 'now') {
        const a = now.layer ? plan.nowAt(xKm, yKm, now.at) : null;
        const k = grid.cellAt(xKm, yKm);
        if (a) { value = STATE_NAMES[a.state]; text = value.toLowerCase(); }
        else if (now.states && k !== null && k !== undefined) { value = STATE_NAMES[now.states[k]]; text = value.toLowerCase(); }
      } else if (mode === 'change') {
        if (info.ready && info.altBoth !== null) {
          const d = (info.altBoth - info.both) * len;
          value = Math.abs(d) < 0.02 * len ? 'No change' : `${d > 0 ? '+' : MINUS}${fmtSpan(Math.abs(d))}`;
          text = value === 'No change' ? 'no change' : `${value} with both in view`;
        }
      } else if (mode === 'score') {
        if (info.ready && Number.isFinite(info.score)) { value = info.score.toFixed(2); text = `suitability ${value}`; }
      } else if (info.ready) {
        value = fmtPct(info[mode]); text = `${value} of the stay`;
      }
    }
    const cellLabel = mode === 'now' ? (now.layer && !now.layer.full ? '1 km cell' : '2 km cell') : info ? `${info.tier.label} cell` : null;
    // phase 4: the terrain resolution actually used at this point (20 m, 40 m tiles, or a whole level)
    const terrainKm = terrainAt(xKm, yKm);
    const terrain = terrainKm ? ` · Terrain ${Math.round(terrainKm * 1000)} m` : '';
    const readout = (text && cellLabel ? `${where}, ${text} (${cellLabel})` : where) + terrain;
    const card = {
      psr: psrText(xKm, yKm),
      name: target?.name ?? 'Map point', latDeg, lonDeg, heightM,
      valueLabel: cellLabel ? `${MODE_LABEL[mode]} (${cellLabel})` : MODE_LABEL[mode], value,
      slopeDeg: info?.slopeDeg ?? null, darkH: info?.darkH ?? null, pass: rankedMode() ? info?.pass ?? null : null,
      // "—" means "not computed yet"; say plainly when there is simply no filter to pass (review UI minor 3)
      filterText: !rankedMode() ? 'Not used in this mode' : !filtersActive() ? 'No filter set' : null,
    };
    return { readout, card };
  }

  function terrainAt(x, y) {
    const d = pyramid?.pick(0, { x0: x, y0: y, x1: x, y1: y });
    return d ? (d.kmPerPixelAt?.(x, y) ?? d.kmPerPixel) : null;
  }
  // "Yes" / "No" for a point and the official PSR map, or null while it loads
  function psrText(x, y) {
    if (!psr) return null;
    return psr.isPsr(x, y) ? 'Yes' : 'No';
  }

  function renderMap() {
    const el = shell.regions.mapTitle;
    clear(el);
    el.append(h('h1', { tabindex: '-1' }, 'Lunar south pole'), h('p', { class: 'site-sub' }, 'South of 80°S, LOLA terrain'));
    const cut = clippedText();
    if (cut) el.append(h('p', { class: 'notice map-clipped' }, cut));
    if (!mapView) return;
    ensurePacks();
    configureHeat();
    const { planned, alt, cmpPlanned, compared, altScenario } = derived;
    const empty = emptyText();
    const working = !plan.allDone();
    const { top, best } = bestCells();
    const { regionCard, regionBest } = regionCards();
    const keyGrid = plan.fineOn() ? plan.fine.grid : grid;
    const big = bigLayout();
    mapView.update({
      layout: { big, top: BIG_TOP_PX, right: big ? rightTaken() : 0 },
      kind, noWindow: !state.windowOn, dialOn: settings.get('skyDial'), liveOn: liveOn(),
      smoothOn: heatSmoothOption(settings.get()) !== false,
      mode: state.mapMode, picking: state.picking, tool: state.tool, slot: state.slot, viewport: state.viewport,
      stayMs: heatSpan().len, emptyText: empty, loading: loadingText(), keyGrid,
      ...frameParams(working),
      selected: state.site,
      alternative: state.altSite !== 'same' ? altScenario.site : null,
      top, best,
      filters: filterParams(), filtersActive: filtersActive() && rankedMode(), weights: state.weights, showPsr,
      regions: polarShapes(), hasRegions: { A: !!shapes.A, B: !!shapes.B }, hasRoute: !!rp.points?.length, route: routePoints, regionCard, regionBest, routeCard: routeCard(), profileAt, routePlan: rp,
      pointInfo: {
        name: state.site.name,
        coords: `${formatCoords(state.site)}${state.site.verified ? '' : ' approx.'}`,
        height: fmtHeight(dem.heightAt(state.site.latDeg, state.site.lonDeg)),
        rows: compareRows(compared ? cmpPlanned : planned, compared ? alt : null).slice(0, 3),
        altHead: altHead(), noWindow: !state.windowOn,
        // phase 4: the official products for the selected point
        ...(() => {
          const [x, y] = toXY(state.site.latDeg, state.site.lonDeg);
          const n = nasa?.sample(x, y) ?? null;
          return {
            psr: psrText(x, y),
            nasa: nasa ? (n ? { sunPct: n.sunPct, earthPct: n.earthPct } : 'none') : null,
            terrainM: (() => { const k = terrainAt(x, y); return k ? Math.round(k * 1000) : null; })(),
          };
        })(),
      },
    });
    mapView.frame.setLive(now.states, liveOn());
    pushLight();
    const text = mapFindingText();
    if (text !== null) shell.regions.mapFinding.textContent = text;
    refreshFolds();
    syncEntry();
    updateDial(true);
    renderLiveRows(true);
    renderVerdict();
    storyMode?.relight();   // the table was drawn again: a story step's lit rows with it
    if (working) kick(); else finishHeat();
  }

  // ---------- phase 6 A: the verdict and its way out (verdict.js) ----------
  // The sentence is compareRows of the same summaries as the table under it. The way out comes from the
  // compute tier (best_landing_dates, compare_scenarios), fetched once per scenario: the fetcher caches every
  // answer and schedules the redraw after it, so the redraw never asks again (no request chain).
  let wayOutFetcher = null;   // made on first use (renderMap can run before this line is reached)
  function verdictInfo() {
    wayOutFetcher ??= createWayOutFetcher({ run: (name, input) => core.run(name, input), onUpdate: () => renderVerdict() });
    const { planned, alt, cmpPlanned, cmpDays, compared, sameSite, altScenario } = derived;
    const v = verdictOf({
      windowOn: state.windowOn, planned, alt, cmpPlanned, cmpDays, compared, sameSite, slipDays: state.slipDays,
      altName: altScenario.site.name, stayDays: state.stayDays, altLandingMs: altScenario.landingMs, ephStartMs: eph.startMs, ephEndMs: eph.endMs,
    });
    if (!v) return null;
    let wayOut = null;
    if (v.kind === 'worse') {
      const q = { site: state.site, altSite: altScenario.site, landingMs: state.landingMs, altLandingMs: altScenario.landingMs, stayDays: state.stayDays, slipDays: state.slipDays, altBothMs: alt.bothMs };
      const w = wayOutFetcher.get(wayOutKey(q), q);
      if (w && !w.none) wayOut = w;
    }
    return { ...v, wayOut };
  }
  function renderVerdict() {
    if (!mapView || !derived) return;
    mapView.setVerdict(verdictInfo());
  }
  const liveOn = () => state.mapMode !== 'now' && state.windowOn && (mapView?.livePref ?? true);
  // the width an open right-hand sheet takes (detail 600, Settings 600, Ask 400): the map centres in what is left
  function rightTaken() {
    if (sheet?.isOpen() || settingsSheet?.isOpen()) return SHEET_W + EDGE + SHEET_GAP;
    if (panel?.isOpen()) return 400 + EDGE + SHEET_GAP;
    return 0;
  }

  // ---------- phase 5: everything that follows the playhead (one clock, timeline.js) ----------
  // Called on every playhead change (once per frame while playing): the live layer (Live mode's states or
  // the veil, recomputed once per whole hour), the sky dial, the inspector's two live rows and the sheet's
  // cursors (throttled). Aggregates (hours, suitability, compare) are not touched: they follow the window.
  // the rows a few times a second while playing, and always the last instant (review 2 F5: trailing calls)
  const rowsThrottle = createThrottle(() => renderLiveRows(), 240);
  const cardsThrottle = createThrottle(() => refreshFolds(), 480);
  function renderLive() {
    if (!mapView || !derived) return;
    pushLight();
    if (liveStates()) {
      if (state.mapMode === 'now') {
        mapView.frameUpdate(frameParams(!plan.allDone()));
        const t = mapFindingText();
        if (t !== null && shell.regions.mapFinding.textContent !== t) shell.regions.mapFinding.textContent = t;
      } else mapView.frame.setLive(now.states, liveOn());
    }
    updateDial(false);
    rowsThrottle.call();
    if (sheet?.isOpen()) {
      const tab = sheet.activeTab();
      if (tab === 'overview') {
        updatePanoramaCursor(shell.regions.panorama, cursorBodies(), { quiet: playing() });
        if (state.windowOn) updateElevationCursor(shell.regions.elevation, state.cursorMs);
        panoAside.textContent = asideText();
      } else {
        // the battery cursor moves every frame (review 2 F7); the cards' tables refresh a few times a second
        if (tab === 'power' && state.windowOn) energyCard?.setCursor?.(state.cursorMs);
        cardsThrottle.call();
      }
    }
  }

  // "Now, over skyline": each body's height above the terrain skyline at the playhead (the sky_at rule);
  // the countdown: the next set (or rise, when down) from next_events of the compute tier, cached until the
  // playhead passes one of them or the place changes, and told relative to the moving playhead.
  const fmtClear = (c) => (Number.isFinite(c) ? `${c >= 0 ? '+' : MINUS}${Math.abs(c).toFixed(1)}°` : DASH);
  function nowOverSkyline() {
    const b = cursorBodies();
    const sun = skyStatus(b.sun, derived.skyline), earth = skyStatus(b.earth, derived.skyline);
    return `Sun ${fmtClear(sun.clearanceDeg)} · Earth ${fmtClear(earth.clearanceDeg)}`;
  }
  const siteKey = (site) => `${site.latDeg.toFixed(5)},${site.lonDeg.toFixed(5)}`;
  // countdown.js: one next_events request at a time, a cache that is never stale on arrival, and the redraw
  // scheduled after the answer, never chained from it (review 2 F1; the page freeze at a rise or set)
  const countdown = createCountdown({ run: (name, input) => core.run(name, input), endMs: eph.endMs, onUpdate: () => renderLiveRows() });
  function countdownText() { return countdown.text(state.site, state.cursorMs); }
  // the playhead's Sun and Earth for the terrain styles, the arrows and the Sun & Earth readout on the map
  function pushLight() {
    if (!mapView) return;
    const d = eph.at(state.cursorMs);
    mapView.setLight(d ? { tMs: state.cursorMs, sun: d.sun, earth: d.earth, earthRangeKm: d.earthRangeKm } : null);
  }
  function renderLiveRows() {
    if (!mapView || !derived) return;
    mapView.setLive({ now: nowOverSkyline(), countdown: countdownText(), dialOn: settings.get('skyDial') });
  }
  const panoAside = h('span', { class: 'sheet-aside num' });
  function asideText() {
    const b = cursorBodies();
    const f = (v) => `${Math.round(v * 10) / 10}°`;
    return `Sun az ${Math.round(b.sun.azDeg)}° el ${f(b.sun.elDeg)} · Earth az ${Math.round(b.earth.azDeg)}° el ${f(b.earth.elDeg)}`;
  }

  // ---------- the sky dial on the selected point (structure-2026-11-13.md: its show and hide rules) ----------
  // Only with a selected point (not a route or a region), on the Map view; one switch in three places
  // (the inspector button, Layers, the K key), stored in settings; half see-through and click-through while
  // a drawing tool is on; fixed screen size; follows its point (off screen with it).
  let dial = null, dialCache = null;
  function dialTracks() {
    const span = trackSpan({ stayRange: state.windowOn ? [derived.planned.startMs, derived.planned.endMs] : null, nowMs: state.cursorMs, startMs: eph.startMs, endMs: eph.endMs });
    const key = `${siteKey(state.site)}|${state.windowOn ? `${state.landingMs}|${state.stayDays}` : 'free'}`;
    const c = dialCache;
    // without a window the month of tracks is centred on the playhead; it is sampled again once the playhead
    // has gone half way to either end
    const inside = c && c.key === key && (state.windowOn || (state.cursorMs >= c.a + (c.b - c.a) / 4 && state.cursorMs <= c.b - (c.b - c.a) / 4) || (c.a <= eph.startMs && state.cursorMs < c.b) || (c.b >= eph.endMs && state.cursorMs > c.a));
    if (inside) return c;
    const [a, b] = span ?? [state.cursorMs, state.cursorMs + DAY_MS];
    const series = sampleSeries(eph, state.site, a, b, 3 * HOUR_MS, derived.skyline);
    dialCache = { key, a, b, series, ...tracksFromSeries(series) };
    return dialCache;
  }
  // the dial stays on the selected point; while a drawing tool or the Route / Region panel is on it is dimmed
  function dialVisible() {
    if (!dial || state.view !== 'map' || !settings.get('skyDial')) return false;
    return true;   // with the Route or Region panel open it is dimmed (and lets clicks through), not hidden
  }
  function updateDial(full) {
    if (!dial || !derived) return;
    const vis = dialVisible();
    dial.setVisible(vis);
    if (!vis) return;
    const tr = dialTracks();
    dial.update({
      skyline: derived.skyline, sunTrack: tr.sunTrack, earthTrack: tr.earthTrack,
      stayRange: state.windowOn ? [derived.planned.startMs, derived.planned.endMs] : null,
      now: cursorBodies(), northDeg: northOnScreenDeg(state.site) ?? 0, dimmed: state.tool !== 'select' || kind !== 'point',
    });
    if (full) placeDial();
  }
  function placeDial() {
    if (!dial || !mapView || !dialVisible()) return;
    // on the globe: where the site is on screen (hidden when it is out of sight)
    const at = globeMap ? globeMap.toFramePx(state.site.latDeg, state.site.lonDeg) : mapView.frame.toPx(...toXY(state.site.latDeg, state.site.lonDeg));
    if (dial.el) dial.el.style.visibility = at ? '' : 'hidden';
    if (at) dial.moveTo(at[0], at[1]);
  }

  let lastView = state.view;

  // Records whether the page scrolls sideways (read by tools/smoke.mjs at phone width).
  function markOverflow() {
    document.documentElement.dataset.overflow = String(document.documentElement.scrollWidth > window.innerWidth);
    document.documentElement.dataset.viewport = String(window.innerWidth);
  }
  window.addEventListener('load', markOverflow);
  window.addEventListener('resize', markOverflow);

  // Phase 4: the big-map layout on a wide window's Map view; everything else keeps the phase 3 layout.
  const wideScreen = window.matchMedia('(min-width: 1101px)');
  // phase 5 (item 13): the map stays the canvas under Evidence and Brief, so the big layout holds in every view
  function bigLayout() { return Boolean(mapView) && wideScreen.matches; }
  wideScreen.addEventListener?.('change', () => render());

  // mission-flow.js: the chosen site and landing date go with the user to the lander, rover and 3D steps
  let missionKey = '';
  function saveMission() {
    const s = state.site;
    if (!s) return;
    const key = `${s.id ?? ''}:${s.latDeg}:${s.lonDeg}:${state.landingMs}:${state.stayDays}`;
    if (key === missionKey) return;
    missionKey = key;
    writeMission({ siteId: s.id ?? null, siteName: s.name ?? null, latDeg: s.latDeg, lonDeg: s.lonDeg, landingMs: state.landingMs, stayDays: state.stayDays });
  }
  // where the lander touched down (the lander page writes it into the mission, its link carries land=): shown on the
  // map and used as the rover route's start, while it belongs to the selected site (within 30 km)
  let landedKey = '';
  function syncLanded(force = false) {
    const s = state.site;
    const key = `${s?.id ?? ''}:${s?.latDeg}:${s?.lonDeg}`;
    if (!force && key === landedKey) return;
    landedKey = key;
    const m = readMission();
    let l = landHash ?? landedFor(m);
    if (l && s && moonKm(l.latDeg, l.lonDeg, s.latDeg, s.lonDeg) > 30) l = null;
    // anywhere on the Moon (routes plan off the pole too): the rover starts where the lander came down
    const next = l ? { ...l, x: toXY(l.latDeg, l.lonDeg)[0], y: toXY(l.latDeg, l.lonDeg)[1] } : null;
    // the planned landing site (the mission's), drawn when there is no touchdown
    const pl = Number.isFinite(m?.latDeg) && Number.isFinite(m?.lonDeg) ? m : s;
    const landing = pl ? { x: toXY(pl.latDeg, pl.lonDeg)[0], y: toXY(pl.latDeg, pl.lonDeg)[1] } : null;
    const moved = (landing?.x ?? null) !== (rp.landing?.x ?? null) || (landing?.y ?? null) !== (rp.landing?.y ?? null);
    if (moved) rp = { ...rp, landing };
    if ((next?.x ?? null) !== (rp.landed?.x ?? null) || (next?.y ?? null) !== (rp.landed?.y ?? null)) { rp = { ...rp, landed: next }; redrawRoutes(); } else if (moved) redrawRoutes();
  }
  window.addEventListener('storage', (e) => { if (e.key === 'lsn-mission') syncLanded(true); });
  let routesHidden = false;   // the globe's route drawing is off while the Where to land panel is open
  function render() {
    syncGlobeSite();
    globeMap?.update();
    try { landMarks(); syncRegionLandBar(); } catch { /* before Where to land exists */ }
    if ((kind === 'land') !== routesHidden) { routesHidden = kind === 'land'; redrawRoutes(); }
    saveMission();
    syncLanded();
    derived = compute();
    if (mapView && !bigLayout()) mapView.setLayout(false);
    shell.sync(state, derived.figures);
    renderMap();
    renderDocs();
    if (sheet?.isOpen()) renderSheet();
    syncDock();
    if (state.view !== lastView) {
      lastView = state.view;
      if (state.view === 'map') document.querySelector('[data-view="map"] h1')?.focus({ preventScroll: true });
    }
    writeHash();
    markOverflow();
  }
  function writeHash() {
    if (hashFrozen) return;
    const hash = toHash(state);
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  // The one entry point for every state change, from the controls and from the command layer alike.
  // Phase 5: no state change stops playback any more (the old stopPlay is gone); the playhead belongs to the
  // timeline, and a new window from elsewhere than the time dock is handed to it (syncTimelineWindow).
  let modeBeforeNoWindow = null;
  function update(patch, { fromDock = false } = {}) {
    let openTab = null;
    if (patch.view === 'navigator') { patch = { ...patch, view: 'map' }; openTab = 'overview'; }   // old links, open_navigator
    const prev = state;
    const next = { ...state, ...patch };
    if ('stayDays' in patch) next.stayDays = cleanStay(patch.stayDays);
    if ('viewport' in patch) next.viewport = clampView(patch.viewport);
    if ('maxSlope' in patch) next.maxSlope = patch.maxSlope == null ? null : cleanMaxSlope(patch.maxSlope);
    if ('maxDark' in patch) next.maxDark = patch.maxDark == null ? null : cleanMaxDark(patch.maxDark);
    if ('weights' in patch) next.weights = cleanWeights(patch.weights);
    // without a window the modes that add up a stay are unavailable: Live is selected, and the mode comes back
    if (prev.windowOn && next.windowOn === false) modeBeforeNoWindow = prev.mapMode;
    if (!prev.windowOn && next.windowOn && !('mapMode' in patch)) next.mapMode = modeBeforeNoWindow ?? 'both';
    if (!next.windowOn && WINDOW_MODES.includes(next.mapMode)) next.mapMode = 'now';
    state = next;
    const winChanged = prev.windowOn !== next.windowOn || prev.landingMs !== next.landingMs || prev.stayDays !== next.stayDays;
    if (winChanged && !fromDock) syncTimelineWindow();
    render();
    if (openTab) openSheet(openTab);
  }

  // fix L5: a change that only needs the hash (a card input, the PSR switch): no re-render; the view
  // links are refreshed so switching view keeps it
  function persist(patch) {
    state = { ...state, ...patch };
    writeHash();
    if (derived) shell.sync(state, derived.figures);
  }

  // ---------- phase 5: the clock and the time dock (P) ----------
  // The state's window (landing + stay, or none) is the authority for the figures; the timeline holds a copy
  // for the dock. A window the user sets in the dock comes back through update(…, { fromDock }).
  // windowMinMs / minMs: the mission is copied as it is, even when the ephemeris end leaves less than a day
  // (review 2 F2: the dock's one-day minimum moved In earlier)
  const timeline = createTimeline({
    startMs: eph.startMs, endMs: eph.endMs, nowMs: state.cursorMs, windowMinMs: HOUR_MS,
    window: state.windowOn ? { inMs: state.landingMs, outMs: Math.min(eph.endMs, state.landingMs + state.stayDays * DAY_MS) } : null,
  });
  const playLoop = createPlayLoop(timeline);
  const playing = () => timeline.getState().playing;
  let syncingTimeline = false;
  function syncTimelineWindow() {
    syncingTimeline = true;
    try {
      if (!state.windowOn) { timeline.clearWindow(); return; }
      const inMs = state.landingMs, outMs = Math.min(eph.endMs, inMs + state.stayDays * DAY_MS);
      timeline.setWindow(inMs, outMs, { minMs: HOUR_MS });
    } finally { syncingTimeline = false; }
  }
  timeline.subscribe((st, changed) => {
    if (changed.includes('window') && !st.windowDraft && !syncingTimeline) {
      if (!st.window) update({ windowOn: false }, { fromDock: true });
      else update({ windowOn: true, landingMs: Math.floor(st.window.inMs / HOUR_MS) * HOUR_MS, stayDays: cleanStay((st.window.outMs - st.window.inMs) / DAY_MS) }, { fromDock: true });
    }
    if (changed.includes('now')) {
      state = { ...state, cursorMs: st.nowMs };
      renderLive();
      if (!st.playing) writeHash();
    }
    if (changed.includes('playing')) {
      // while it plays, the Live finding changes every step; it is announced once playback stops
      shell.regions.mapFinding.setAttribute('aria-live', st.playing ? 'off' : 'polite');
      document.documentElement.dataset.playing = String(st.playing);
      // Live, zoomed in: 2 km states while it plays, the viewport's 1 km states once paused (fix H2.3)
      if (!st.playing) { writeHash(); if (state.mapMode === 'now' && mapView && liveStates()) renderMap(); }
      else if (now.layer) { now.layer = null; if (mapView) renderMap(); }
    }
  });
  dock = createTimeDock({
    timeline, defaultStayDays: 14, slips: SLIPS, stays: [7, 14, 30],
    autoplay: !reducedMotion(settings.get()), reducedMotion: reducedMotion(settings.get()),
    onSlip: (d) => update({ slipDays: d }),
    // Landing and Stay from the window popover carry the requested stay (review 2 F2, F4): the timeline only
    // holds the part the ephemeris covers, so its length must not come back as the stay
    onWindowRequest: ({ inMs, stayMs }) => update({ windowOn: true, landingMs: Math.floor(inMs / HOUR_MS) * HOUR_MS, stayDays: cleanStay(stayMs / DAY_MS) }),
  });
  dock.el.setAttribute('data-tour', 'ribbon');
  // the rises and sets of the whole ephemeris at the selected place, for the dock's event ticks and its
  // previous / next buttons (they work without a window too)
  const allEvents = new Map();
  function eventsFor(site) {
    const key = siteKey(site);
    if (!allEvents.has(key)) allEvents.set(key, summarize(eph, site, eph.startMs, (eph.endMs - eph.startMs) / DAY_MS, sky(site)).events);
    return allEvents.get(key);
  }
  function syncDock() {
    dock.update({ ribbon: ribbonFor(state.site), stayDays: state.stayDays, events: eventsFor(state.site), slipDays: state.windowOn ? state.slipDays : 0 });
  }
  function placeDock(big) {
    if (big) {
      dock.el.classList.add('timedock--float');
      shell.app.append(dock.el);
      dock.mount('legend', mapView.legendEl);
      dock.mount('scale', mapView.scaleEl);
    } else {
      dock.el.classList.remove('timedock--float');
      shell.mapSection.append(dock.el);
    }
  }
  if (!mapView) shell.mapSection.append(dock.el);
  function landHereNow() {
    update({ windowOn: true, landingMs: Math.floor(state.cursorMs / HOUR_MS) * HOUR_MS, stayDays: 14 });
  }

  // ---------- phase 5: the detail sheet (S): the old Navigator page on the map ----------
  sheet = createSiteSheet({
    onClose: () => { persist({ sheet: null }); shell.app.dataset.sheet = ''; if (mapView) renderMap(); },
    onTab: (tab) => { persist({ sheet: tab }); renderSheet(); },
  });
  shell.app.append(sheet.el);
  const elevLegend = h('span', { class: 'sheet-legend' }, h('span', { class: 'dot dot-sun', 'aria-hidden': 'true' }), 'Sun ', h('span', { class: 'dot dot-earth', 'aria-hidden': 'true' }), 'Earth');
  sheet.mount('overview', shell.sheetParts.panorama, { title: 'Sky at the site', aside: panoAside });
  sheet.mount('overview', shell.sheetParts.elevation, { title: 'Elevation over the stay', aside: elevLegend }).classList.add('needs-window');
  sheet.mount('overview', shell.sheetParts.events, { title: 'Rises and sets during the stay' }).classList.add('needs-window');
  if (energyCard) { sheet.mount('power', energyCard.el).classList.add('needs-window'); energyCard.el.querySelector('details.energy-more')?.setAttribute('open', ''); }
  if (relayCard) { sheet.mount('comms', relayCard.el).classList.add('needs-window'); relayCard.el.querySelector('details.relay-orbit')?.setAttribute('open', ''); }
  sheet.mount('compare', h('div', { class: 'sheet-compare' }, shell.sheetParts.altField, pickHome, shell.sheetParts.compare), { title: 'Planned vs alternative' }).classList.add('needs-window');
  // ---------- phase 5 (item 13): Evidence and Brief, reading sheets over the map ----------
  // The top bar's Map / Evidence / Brief stay the navigation (and #view=evidence / #view=brief deep links);
  // closing a sheet returns to the bare map. They count in "one large sheet at a time".
  const docSheets = {
    evidence: createDocSheet({ name: 'evidence', title: 'Evidence and limits', subtitle: 'How the figures were checked, and what is not verified', onClose: () => { if (state.view === 'evidence') update({ view: 'map' }); } }),
    brief: createDocSheet({ name: 'brief', title: 'The challenge', subtitle: 'NASA Space Apps 2026 challenge brief', onClose: () => { if (state.view === 'brief') update({ view: 'map' }); } }),
  };
  docSheets.evidence.body.append(shell.regions.evidence);
  docSheets.brief.body.append(shell.regions.brief);
  const docScrim = h('div', { class: 'doc-scrim', hidden: true, onclick: () => update({ view: 'map' }) });
  shell.app.append(docScrim, docSheets.evidence.el, docSheets.brief.el);
  function renderDocs() {
    for (const [name, ds] of Object.entries(docSheets)) {
      const on = state.view === name;
      const region = shell.regions[name];
      if (!on) { if (ds.isOpen()) ds.close({ restoreFocus: false }); clear(region); continue; }
      if (!region.childElementCount) {
        if (name === 'evidence') renderEvidence(region, { validation: data.validation, meta: eph.meta, sites });
        else renderBrief(region, { challengeUrl: data.challenge.url });
        // the content's own h1 becomes the sheet's title (one heading, the sheet's)
        const h1 = region.querySelector('h1');
        if (h1) { ds.setTitle(h1.textContent); h1.remove(); }
      }
      if (!ds.isOpen()) {
        closeSheet(); settingsSheet?.close(); if (panel?.isOpen()) panel.close();
        ds.open();
      }
    }
    const doc = state.view === 'evidence' || state.view === 'brief';
    docScrim.hidden = !doc;
    shell.app.dataset.doc = doc ? 'open' : '';
  }

  // One large sheet at a time: the detail sheet, Settings or Ask (or Evidence / Brief)
  function openSheet(tab) {
    if (state.view !== 'map') update({ view: 'map' });
    settingsSheet?.close();
    if (panel?.isOpen()) panel.close();
    sheet.open(SHEET_TABS.includes(tab) ? tab : undefined);
    shell.app.dataset.sheet = 'open';
    persist({ sheet: sheet.activeTab() });
    renderMap();
    renderSheet();
  }
  function closeSheet() { if (sheet.isOpen()) sheet.close({ restoreFocus: false }); }
  function renderSheet() {
    if (!sheet.isOpen() || !derived) return;
    renderSheetHead();
    const tab = sheet.activeTab();
    // the light pieces are kept current in every tab (the sheet's text is in the page for search and tests);
    // the charts need the tab's width, the energy and relay cards their tab
    if (state.windowOn) { renderEvents(shell.regions.events, derived.planned, { stayDays: state.stayDays }); renderCompareCard(); }
    if (tab === 'overview') { renderCharts(); panoAside.textContent = asideText(); } else refreshFolds();
  }

  // The detail sheet's Power or Comms tab for get_energy / set_relay_orbit, unless the Ask panel is open
  // (opening a large sheet closes the others). Says where the card is, for the answer.
  function showCard(tab) {
    const where = `the ${tab === 'power' ? 'Power' : 'Comms'} tab of the site detail sheet`;
    if (panel?.isOpen() || !mapView) return `${where} (not opened while the Ask panel is open)`;
    openSheet(tab);
    return where;
  }

  // ---------- command layer, Ask panel and tour (§4.9, §4.10) ----------
  const api = {
    sites, core,
    landingRange: { startMs: eph.startMs, endMs: eph.endMs },
    getState: () => ({
      ...state, playing: playing(), zoom: state.viewport.zoom, cx: state.viewport.cx, cy: state.viewport.cy,
      summary: derived ? { planned: derived.cmpPlanned, alt: derived.alt } : undefined,
    }),
    update: (patch) => update(patch),
    setPlayhead: (ms) => timeline.setNow(ms),
    play: () => timeline.play(),
    pause: () => timeline.pause(),
    openSiteDetail: (tab) => openSheet(tab),
    openSettings: () => settingsSheet.open(shell.settingsButton),
    setLayer: (name, on) => {
      const key = name === 'skyDial' ? 'dial' : name;
      // Reuse the Layers handlers, including their persistence, lazy loading and redraw paths.
      const btn = shell.app.querySelector(`[data-layer="${key}"]`);
      if (!btn) return { error: `Layer ${name} is unavailable in this build.` };
      if ((btn.getAttribute('aria-checked') === 'true') !== on) btn.click();
      return { name, on: btn.getAttribute('aria-checked') === 'true' };
    },
    setView: (v) => update({ viewport: v }),
    setRegion: (slot, shape) => { if (!(slot in shapes)) return; shapes[slot] = shape ?? null; state = { ...state, regions: { ...shapes } }; render(); },
    setRoute: (points) => { routePoints = points ?? null; profileAt = null; render(); },
    // phase 4: plan_route. Runs the Route plan card's planner on these points and opens the card.
    planRoute: routePlanCard ? async (points, maxSlopeDeg) => {
      if (state.view !== 'map') update({ view: 'map' });
      kind = 'route';
      mapView.setFold('plan', true);
      routePlanCard.update({ points });
      plannedRoute = null;
      const result = await runPlan(points, maxSlopeDeg);
      if (!result) return { error: 'Planning was cancelled.' };
      if (!result.ok) return { error: result.error ?? null, blocked: result.blocked ?? null };
      const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
      return {
        selected: rp.selected, slopeLimitDeg: result.limitDeg, slopeBaselineKm: result.baselineKm,
        routes: result.routes.map((r) => ({ id: r.id, label: r.label, lengthKm: r1(r.lengthKm), maxSlopeDeg: r1(r.maxSlopeDeg), meanSlopeDeg: r1(r.meanSlopeDeg),
          sunSharePct: r.sunShare == null ? null : r1(r.sunShare * 100), psrKm: r1(r.psrKm), sameAs: r.sameAs ?? null, unavailable: r.unavailable ?? null })),
        note: 'Slope on the 240 m grid is a sketch, not a trafficability check. No speed, time or energy.',
      };
    } : null,
    // phase 4: set_relay_orbit. Applies the orbit in the Relay link card, opens it and reads its figures.
    relayOrbit: relayCard ? (elements, presetId) => {
      const set = relayCard.setOrbit(elements, presetId);
      if (!set.ok) return set;
      if (state.view !== 'map') update({ view: 'map' });
      relayCard.update(relayParams());   // phase 5: the card computes in the Comms tab whether or not it shows
      // review 2 F8: the card is shown in the detail sheet's Comms tab, except while the Ask panel is open (one
      // large sheet at a time: opening the sheet would close the panel the answer is being written in)
      const shown = showCard('comms');
      const o = relayCard.getOrbit();
      const h1 = (ms) => (Number.isFinite(ms) ? Math.round(ms / 360e3) / 10 : null);
      const one = (r) => (r ? { relayH: h1(r.relayMs), longestRelayGapH: h1(r.longestRelayGapMs), earthDirectH: h1(r.directMs), directOrRelayH: h1(r.anyMs), longestBlindH: h1(r.longestBlindMs), stayH: h1(r.stayMs), periodH: Math.round(r.periodS / 36) / 100 } : null);
      return { ok: true, presetId: o.presetId, elements: o.elements, minElDeg: o.minElDeg, planned: one(o.results?.planned), alternative: one(o.results?.alt), shownIn: shown };
    } : null,
    relayPresets: RELAY_PRESETS,
    // phase 4: get_energy. The same numbers as the Energy card, which it opens with these assumptions.
    energy: energyCard ? (patch) => {
      const assumptions = { ...(energyAssumptions ?? energyCard.assumptions()), ...patch };
      if (state.view !== 'map') update({ view: 'map' });
      const { altScenario, compared } = derived;
      const r = planEnergyPair(eph, { site: state.site, landingMs: state.landingMs, mask: sky(state.site) },
        compared ? { ...altScenario, mask: sky(altScenario.site) } : null, state.stayDays, assumptions, { atMs: state.cursorMs });
      energyCard.update({ ...lastEnergyParams(), assumptions });
      energyAssumptions = energyCard.assumptions();
      persist({ energy: cleanEnergy(energyAssumptions) });
      const shown = showCard('power');   // review 2 F8, as for the relay card
      const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
      const one = (x, label) => (x ? {
        label, sunlitH: r1(x.litMs / HOUR_MS), atEmptyH: r1(x.sim.emptyH), minBatteryH: r1(x.sim.minBatteryH),
        chargingH: r1(x.sim.chargingH), asleepH: r1(x.sim.sleepH),
        bestFixed: x.bestFixed ? { tiltDeg: r1(x.bestFixed.tiltDeg), facingDeg: r1(x.bestFixed.azDeg), shareOfTracking: r1(x.bestFixed.vsTrack * 100) } : null,
        horizontalShareOfTracking: r1(x.flatVsTrack * 100),
      } : null);
      const labels = scenarioLabels();
      return {
        assumptions: { ...r.planned?.assumptions, note: 'Assumed, not data. Relative units: hours of average load.' },
        planned: one(r.planned, labels.plannedLabel), alternative: one(r.alt, labels.altLabel), stayDays: r1(r.stayDays), shownIn: shown,
      };
    } : null,
    regionStats: (slot) => {
      const s = slot;
      if (isGeo(shapes[s])) { const g = geoSlot(s); return Promise.resolve(g.stats ? { ...g.stats, best: g.stats.best ? { ...g.stats.best, coords: formatCoords(g.stats.best) } : null, note: g.note } : null); }
      if (!shapes[s] || !plan) return Promise.resolve(null);
      // the finest grid the viewport asks for first, so the answer matches the card once it is in
      return waitFor(() => !neededPacks(state.viewport).some((n) => FINE_PACKS.includes(n) && packs[n] === 'loading') && (plan.region(s)?.progress ?? 1) >= 1).then(() => {
        const r = plan.region(s);
        if (!r) return null;
        const out = { ...r.stats, areaKm2: areaKm2(r.shape), gridCellKm: r.tier.grid.cellKm };
        if (r.stats.best) {
          const c = r.tier.grid.cellCenter(r.stats.best.cell);
          out.best = { ...r.stats.best, latDeg: c.latDeg, lonDeg: c.lonDeg, coords: formatCoords(c) };
        }
        return out;
      });
    },
    bestCells: (count) => {
      if (!plan) return Promise.resolve([]);
      return waitFor(() => plan.fullDone()).then(() => plan.best(state.mapMode, count).map((c) => {
        const p = grid.cellCenter(c.cell);
        return { latDeg: p.latDeg, lonDeg: p.lonDeg, value: c.value };
      }));
    },
    startTour: () => startTour(),
  };
  const commands = createCommands(api);
  // phase 5 (T 2.5): the Ask panel's provider follows Settings (default: the scripted demo); a forwarding
  // provider so a change takes effect at once, with the conversation reset
  let provider = createProviderFromSettings(settings, { scripted: createMockProvider });
  const agent = createAgent({ provider: { get name() { return provider.name; }, respond: (args) => provider.respond(args) }, commands, getState: () => state });
  const agentRoot = h('div', { class: 'agent-root' });
  document.body.append(agentRoot);
  const panel = createAgentPanel(agentRoot, {
    agent, suggestions: MOCK_SUGGESTIONS,
    onOpenChange: (open) => {
      shell.askButton.setAttribute('aria-expanded', String(open));
      if (open) { closeSheet(); settingsSheet?.close(); if (state.view !== 'map') update({ view: 'map' }); }
      if (mapView && mapView.layoutBig) renderMap();   // the map centres beside the panel (verify-2026-11-13 #2)
    },
  });
  // the Filters step opens the folded Filters card first (layout revision)
  const tour = createTour({ steps: TOUR_STEPS.map((s) => (s.targets[0] === 'filters' ? { ...s, prepare: () => mapView?.openFilters() } : s)) });
  // First visit: a small "New" next to the Tour button instead of a prompt over the page (layout
  // revision). It goes once the tour has been opened; tour.seen() reads the same storage key.
  const tourNew = tour.seen() ? null : h('span', { class: 'tour-new', id: 'lsn-tour-new' }, 'New');
  if (tourNew) { shell.tourButton.append(tourNew); }
  function startTour() {
    if (tourNew?.isConnected) tourNew.remove();
    panel.close();
    if (state.view !== 'map') update({ view: 'map' });
    return tour.start();
  }
  shell.askButton.addEventListener('click', () => panel.toggle(shell.askButton));
  // phase 6 B: the Tour button opens a small menu: three stories, and the tour of the controls above
  let factsPromise = null;
  storyMode = mapView ? createStoryMode({
    app: shell.app, tourButton: shell.tourButton, askButton: shell.askButton, settingsButton: shell.settingsButton,
    commands, api, timeline, dock, dial: null, mapView, sheet, panel, settings,
    get settingsSheet() { return settingsSheet; },
    openSheet: (tab) => openSheet(tab),
    facts: () => (factsPromise ??= storyFacts((name, input) => core.run(name, input)).catch((e) => { factsPromise = null; throw e; })),
    reduced: () => reducedMotion(settings.get()),
    startControlsTour: () => startTour(),
    setHashFrozen: (on) => { hashFrozen = on; if (!on) writeHash(); },
    getKind: () => kind,
    setKind: (k, tool) => { if (kind !== k || state.tool !== tool) { kind = k; update({ tool }); } },
    siteKm: (site) => toXY(site.latDeg, site.lonDeg),
    dialRadius: 150,
  }) : null;
  shell.tourButton.addEventListener('click', () => (storyMode ? storyMode.toggleMenu() : startTour()));
  // For tools/smoke.mjs and the timing scripts: the same commands the Ask panel uses.
  panel.setProvider(provider.label, provider.name !== 'mock');

  // ---------- phase 5: Settings (T) ----------
  settingsSheet = createSettingsSheet({
    settings,
    // what the page is drawn from (data-sources.js; the MCP-only rows stay in Evidence)
    sources: DATA_SOURCES.filter((s) => s.shown !== 'tools').map((s) => ({
      label: s.label,
      value: s.shown === 'official' ? `${s.value}. Shown unchanged.` : s.shown === 'ours' ? `${s.value}. Calculated by this tool.` : s.value,
    })),
    makeProvider: () => createProviderFromSettings(settings, { scripted: createMockProvider }),
    onOpenChange: (open) => {
      shell.settingsButton.setAttribute('aria-expanded', String(open));
      if (open) { closeSheet(); if (panel.isOpen()) panel.close(); if (state.view !== 'map') update({ view: 'map' }); }
      renderMap();
    },
    onEvidence: () => { settingsSheet.close(); update({ view: 'evidence' }); },
  });
  shell.app.append(settingsSheet.el);
  shell.settingsButton.addEventListener('click', (e) => settingsSheet.toggle(e.currentTarget));
  shell.app.dataset.scale = settings.get('scaleBar') ? 'on' : 'off';
  settings.subscribe((snap, changed) => {
    applyDisplay(snap);
    if (changed.includes('palette')) { mapView?.frame.refreshColours(); dock.refreshColours(); if (sheet.isOpen()) renderSheet(); }
    if (changed.includes('heatSmoothing') && mapView) renderMap();
    if (changed.includes('reduceMotion')) dock.setReducedMotion(reducedMotion(snap));
    if (changed.includes('scaleBar')) shell.app.dataset.scale = snap.scaleBar ? 'on' : 'off';
    if (changed.includes('skyDial') && mapView) renderMap();
    if (providerChanged(changed)) {
      provider = createProviderFromSettings(settings, { scripted: createMockProvider });
      agent.reset();
      panel.setProvider(provider.label, provider.name !== 'mock');
    }
  });
  // K: the sky dial on and off (structure-2026-11-13.md), not while typing
  document.addEventListener('keydown', (e) => {
    if ((e.key !== 'k' && e.key !== 'K') || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const t = e.target;
    if (t?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], deep-chat')) return;
    settings.set('skyDial', !settings.get('skyDial'));
  });
  dial = mapView ? createSkyDial() : null;
  if (dial) mapView.frame.el.append(dial.el);
  if (storyMode && dial) storyMode.setDial(dial);

  window.__lsn = { commands, agent, panel, tour, api, plan, packMs, state: () => state, timeline, dock, sheet, settings, settingsSheet, core, openSheet, story: storyMode };

  // Charts are drawn at their container's pixel width; redraw them when that width changes.
  let lastWidth = 0;
  new ResizeObserver(() => {
    const w = shell.regions.panorama.clientWidth;
    if (!derived || w === lastWidth || !sheet.isOpen()) return;
    lastWidth = w;
    renderCharts();
    markOverflow();
  }).observe(shell.regions.panorama);
  let lastMapWidth = 0;
  new ResizeObserver(() => {
    const w = shell.regions.mapCard.clientWidth;
    if (!mapView || w === lastMapWidth) return;
    lastMapWidth = w;
    mapView.resize();
    markOverflow();
  }).observe(shell.regions.mapCard);

  window.addEventListener('hashchange', () => {
    if (location.hash === toHash(state)) return;
    // the stage bar's "3 Rover" inside this page: a hash change with plan=1, no reload
    const planNow = /(^|[#&])plan=1(&|$)/.test(location.hash);
    const lh = landFromHash(location.hash);
    if (lh) { landHash = lh; setTimeout(() => syncLanded(true), 0); }
    if (planNow) setTimeout(() => openPlanAtSite(), 0);
    const next = parseHash(location.hash, sites, eph);
    if (!/[#&]rp=/.test(location.hash)) next.routePlan = state.routePlan;   // a link without a route keeps the current one
    else writeRoutePlan(next.routePlan);
    const openTab = next.sheet;
    next.picking = state.picking;
    next.tool = state.tool;
    next.slot = state.slot;
    next.viewport = clampView(next.viewport);
    // The playhead is the clock's; a link without now= keeps it, subject to the running loop window.
    const nowInHash = /[#&]now=/.test(location.hash);
    if (!nowInHash && next.landingMs === state.landingMs && next.stayDays === state.stayDays) next.cursorMs = state.cursorMs;
    if (!next.windowOn) next.mapMode = 'now';
    // A point picked on the map comes back from the hash as a custom site; keep its map name.
    if (next.site.id === 'custom' && state.site.id === 'custom' && next.site.latDeg === state.site.latDeg && next.site.lonDeg === state.site.lonDeg) next.site = state.site;
    // The hash rounds the viewport; keep the exact one when it is the same place.
    const v = state.viewport;
    if (Math.abs(next.viewport.zoom - v.zoom) < 0.006 && Math.abs(next.viewport.cx - v.cx) < 0.06 && Math.abs(next.viewport.cy - v.cy) < 0.06) next.viewport = v;
    // fix L5: the phase 4 keys, applied only where they changed
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    if (next.psr !== Boolean(showPsr)) { showPsr = next.psr; if (showPsr) loadExtras(); }
    if (!same(next.energy, cleanEnergy(state.energy)) && energyCard && derived) {
      energyCard.update({ ...lastEnergyParams(), assumptions: next.energy ?? ENERGY_DEFAULTS });
      energyAssumptions = energyCard.assumptions();
    }
    if (!same(next.relay, cleanRelay(state.relay))) applyRelay(next.relay);
    for (const k of ['A', 'B']) if (shapeParam(next.regions[k]) !== shapeParam(shapes[k])) shapes[k] = next.regions[k];
    if (!same(next.routePlan, cleanRoutePlan(state.routePlan)) && routePlanCard) {
      const r = next.routePlan;
      plannedRoute = null;
      rp = { ...rp, points: r?.points ?? null, maxSlopeDeg: r?.maxSlopeDeg ?? null, plan: null, selected: null, hovered: null };
      routePlanCard.update({ points: rp.points, plan: null, selected: null, hovered: null, ...(r?.maxSlopeDeg ? { maxSlopeDeg: r.maxSlopeDeg } : {}) });
      routePoints = r && !r.selected ? r.points : null;
      if (r?.selected) runPlan(r.points, r.maxSlopeDeg ?? undefined, { pick: r.selected, fit: false }).catch(() => {});
    }
    const winChanged = next.windowOn !== state.windowOn || next.landingMs !== state.landingMs || next.stayDays !== state.stayDays;
    next.sheet = sheet.isOpen() ? sheet.activeTab() : null;
    state = next;
    if (winChanged) syncTimelineWindow();
    // syncTimelineWindow can move the clock to In. Do not restore the pre-sync March playhead from
    // `next` afterwards; a supplied now= still goes through the clock's running-loop constraint.
    if (nowInHash && next.cursorMs !== timeline.getState().nowMs) timeline.setNow(next.cursorMs);
    state = { ...state, cursorMs: timeline.getState().nowMs };
    render();
    if (openTab && (!sheet.isOpen() || sheet.activeTab() !== openTab)) openSheet(openTab);
    else if (!openTab && sheet.isOpen()) closeSheet();
  });

  render();
  // step 2 of the mission (mission-flow.js): arriving with plan=1 opens the Route tool with the landing site as
  // the start; done after the first full render, once the timeline and the map exist
  function openPlanAtSite() {
    if (!routePlanCard || !state.site) return;   // anywhere on the Moon (routes off the pole plan on the global terrain)
    // the same path as pressing the Route tool (which card the panel shows follows `kind`)
    kind = 'route';
    update({ tool: 'route' });
    entryFold('route');
    // the rover starts where the lander touched down, else at the site
    if (!rp.points) {
      const start = rp.landed ? [rp.landed.x, rp.landed.y] : toXY(state.site.latDeg, state.site.lonDeg);
      rp = { ...rp, points: [start] };   // the start alone: shown on the globe; a route drawn on the Moon continues from it
      routePlanCard.update({ points: [start] });
      redrawRoutes();
    }
  }
  if (planOnLoad) openPlanAtSite();
  // the loading screen (boot.js): terrain is in; it lifts when the 2 km map of the stay is done (or after 20 s)
  const boot = bootScreen(document);
  const bootT0 = performance.now();
  (function bootPoll() {
    if (!boot.active) return;
    const p = plan ? plan.fullProgress : 1;
    boot.set(0.25 + 0.75 * p, plan ? `Sun and Earth above the skyline over the ${state.stayDays}-day stay · ${Math.round(p * 100)}%` : 'Terrain unavailable: showing the map without it');
    if (!plan || plan.fullDone() || performance.now() - bootT0 > 20000) { boot.done(); return; }
    requestAnimationFrame(bootPoll);
  })();
  // an old #view=navigator link, or sheet= in the hash: the map with the detail sheet open
  if (state.sheet && mapView) openSheet(state.sheet);
}

start();
