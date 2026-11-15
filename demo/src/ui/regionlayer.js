// "Where to land" (planner.html), a tool of the Map: opened full-screen under the top bar from the action bar;
// "Use this site" comes back with the site and its first lit landing time (postMessage lsn-site { mission }),
// "Back to the Map" or Esc closes it (lsn-close).
import { stageUrl } from '../mission-flow.js';

// bumped when the framed page changes, so a browser that cached an older planner.html loads the new one
const FRAME_V = 'flow5';

export function createRegionLayer(doc, { topbar, getMission, onSite }) {
  const win = doc.defaultView;
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
  function open(at = null) {
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
  function close() {
    region.hidden = true;
    doc.documentElement.classList.remove('map-level-open');
  }
  win.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || !planner || e.source !== planner.contentWindow) return;
    if (d.type === 'lsn-site' && d.mission) { close(); onSite?.(d.mission); }
    else if (d.type === 'lsn-close') close();
  });
  win.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !region.hidden && !e.defaultPrevented) close(); });
  return { open, close, get isOpen() { return !region.hidden; } };
}
