// The Map is one view of the whole Moon (mission step 1). Zoomed out it is the 3D globe (globe.html#pick=1 in a frame
// inside the map, under the page's panels): LOLA 7.6 km → 474 m, polar 240–20 m. Zooming in over the south pole
// (south of 80°S, closer than HANDOFF_KM) hands over to the detailed polar map at the same place and scale; zooming
// out of the whole polar map hands back to the globe. A click on the globe picks the site anywhere on the Moon (the
// site card follows). Sites outside the polar map are shown on the globe.
// "Where to land" (planner.html) is a tool over the page, not a level: it opens full-screen under the top bar and
// "Use this site" comes back with the site and its first lit landing time.
// Messages: from the globe lsn-ready (its view exists), lsn-camera { latDeg, lonDeg, distKm }, lsn-pick { latDeg, lonDeg }; to it lsn-fly
// { latDeg, lonDeg, distKm }, lsn-zoom { dir }. From the planner lsn-site { mission }, lsn-close.
import { stageUrl } from '../mission-flow.js';

export const HANDOFF_KM = 600;         // camera distance under which the globe hands over to the polar map
export const POLAR_EDGE_LAT = -80;     // the polar map's data edge
// bumped when the framed pages change, so a browser that cached an older globe.html / planner.html loads the new one
const FRAME_V = 'flow4';

// the polar map's zoom for a globe camera distance (km): at HANDOFF_KM about the whole 80°S cap
export const zoomForDist = (distKm) => Math.min(32, Math.max(1, 650 / Math.max(1, distKm)));
// should the globe hand over? only while zooming in, over the polar cap
export function handsOver(cam, prevDist) {
  return Number.isFinite(cam?.distKm) && cam.distKm < HANDOFF_KM && cam.latDeg <= POLAR_EDGE_LAT && (prevDist === null || cam.distKm < prevDist);
}

export function createMoonLayer(doc, { host, app, topbar, getMission, onPick, onEnterPolar, onSite }) {
  const win = doc.defaultView;
  // ---- the whole Moon, inside the map ----
  const layer = doc.createElement('div');
  layer.className = 'moon-layer';
  layer.hidden = true;
  const hint = doc.createElement('p');
  hint.className = 'map-chip moon-hint';
  hint.innerHTML = '<b>Whole Moon</b> · click to choose a site · zoom into the south pole for the detailed site map';
  layer.appendChild(hint);
  host.appendChild(layer);
  let globe = null, ready = false, queued = null, shown = false, prevDist = null;
  const post = (msg) => { if (ready) globe.contentWindow.postMessage(msg, '*'); else queued = msg; };
  function showMoon({ latDeg = -60, lonDeg = 0, distKm = 1400 } = {}) {
    if (!globe) {
      globe = doc.createElement('iframe');
      globe.className = 'moon-frame';
      globe.title = 'The whole Moon in 3D: click to choose a site';

      globe.src = `globe.html?v=${FRAME_V}#lat=${latDeg.toFixed(3)}&lon=${lonDeg.toFixed(3)}&dist=${Math.round(distKm)}&tilt=0&heading=0&pick=1`;
      layer.prepend(globe);
    } else post({ type: 'lsn-fly', latDeg, lonDeg, distKm });
    prevDist = distKm;
    flyTarget = null;
    shown = true;
    layer.hidden = false;
    app?.classList.add('map-moon-on');
  }
  function hideMoon() {
    shown = false;
    layer.hidden = true;
    app?.classList.remove('map-moon-on');
  }
  // a fly to a site: if it hands over on the way down, the polar map opens at the site, not where the camera passed
  let flyTarget = null;
  function flyTo(cam) { if (shown) { prevDist = null; flyTarget = cam; post({ type: 'lsn-fly', ...cam }); } }
  // the selected site on the globe (sent again once the globe has loaded)
  let markMsg = null;
  function mark(site) { markMsg = { type: 'lsn-mark', latDeg: site.latDeg, lonDeg: site.lonDeg, name: site.name }; if (ready) globe.contentWindow.postMessage(markMsg, '*'); }

  // ---- "Where to land": the planner over the page, under the top bar ----
  const region = doc.createElement('section');
  region.className = 'map-level-layer';
  region.hidden = true;
  doc.body.appendChild(region);
  let planner = null;
  const place = () => { const r = topbar?.getBoundingClientRect(); doc.documentElement.style.setProperty('--level-top', `${Math.max(0, Math.round(r ? r.bottom : 0))}px`); };
  if (typeof ResizeObserver === 'function' && topbar) new ResizeObserver(place).observe(topbar);
  win.addEventListener('resize', place);
  // on narrow screens the top bar scrolls with the page: the action bar (phase10-flow.css) and the layer follow it
  win.addEventListener('scroll', place, { passive: true });
  place();
  function openRegion(at = null) {
    place();
    const m = getMission();
    const p = at ?? (m ? { latDeg: m.latDeg, lonDeg: m.lonDeg } : null);
    const url = stageUrl('region', p ? { ...p, landingMs: m?.landingMs } : m);
    const src = `${url}${url.includes('?') ? '&' : '?'}v=${FRAME_V}`;
    if (!planner) {
      planner = doc.createElement('iframe');
      planner.className = 'map-level-frame';
      planner.title = 'Where to land';
      region.appendChild(planner);
    }
    if (planner.dataset.src !== src) { planner.dataset.src = src; planner.src = src; }
    region.hidden = false;
    doc.documentElement.classList.add('map-level-open');
  }
  function closeRegion() {
    region.hidden = true;
    doc.documentElement.classList.remove('map-level-open');
  }

  win.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (globe && e.source === globe.contentWindow) {
      if (d.type === 'lsn-ready') { ready = true; if (markMsg) globe.contentWindow.postMessage(markMsg, '*'); if (queued) { globe.contentWindow.postMessage(queued, '*'); queued = null; } }
      else if (d.type === 'lsn-camera' && shown) {
        if (handsOver(d, prevDist)) { const at = flyTarget && flyTarget.latDeg <= POLAR_EDGE_LAT ? flyTarget : d; flyTarget = null; hideMoon(); onEnterPolar?.(at); }
        prevDist = d.distKm;
      } else if (d.type === 'lsn-pick' && Number.isFinite(d.latDeg) && Number.isFinite(d.lonDeg)) onPick?.(d);
    } else if (planner && e.source === planner.contentWindow) {
      if (d.type === 'lsn-site' && d.mission) { closeRegion(); onSite?.(d.mission); }
      else if (d.type === 'lsn-close') closeRegion();
    }
  });
  win.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !region.hidden && !e.defaultPrevented) closeRegion(); });
  return {
    showMoon, hideMoon, flyTo, mark, openRegion, closeRegion,
    get isMoon() { return shown; },
    // the map's zoom buttons while the globe shows: they zoom the globe
    zoom(dir) { if (!shown || (dir !== 'in' && dir !== 'out')) return false; post({ type: 'lsn-zoom', dir }); return true; },
  };
}
