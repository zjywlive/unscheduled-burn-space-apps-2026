// The Map's three levels of detail (mission step 1), switched in the top bar:
//   Moon    the whole Moon in 3D (globe.html#pick=1 in a frame): LOLA 7.6 km → 474 m, polar 240–20 m; a click picks
//           a point and opens the region around it
//   Region  "Where to land" (planner.html in a frame): about ±200 km around the point, polar data south of 80°S or
//           the global LOLA terrain with a computed skyline elsewhere; landing ellipse scores, better spots;
//           "Use this site" makes it the mission's site and comes back to the site level
//   Site    this page's own analysis (heat maps, sky dial, route card, comms, havens), detailed south of 80°S
// The frames are made on first use and kept, so going back and forth is instant; they cover the page below the top
// bar, which stays (stage bar, levels, site). Messages from the frames: lsn-pick { latDeg, lonDeg } (globe),
// lsn-site { mission } and lsn-close (planner). index.html?level=moon|region opens on that level.
import { stageUrl } from '../mission-flow.js';

// bumped when the framed pages change, so a browser that cached an older globe.html / planner.html loads the new one
const FRAME_V = 'flow1';

export const LEVELS = Object.freeze([
  { id: 'moon', label: 'Moon', title: 'The whole Moon in 3D: click a point to look at the region around it' },
  { id: 'region', label: 'Region', title: 'Where to land: about ±200 km around the site, landing ellipse scores and better spots nearby' },
  { id: 'site', label: 'Site', title: 'The site analysis: Sun and Earth over the stay, power, comms and the rover route (detailed south of 80°S)' },
]);

export function createMapLevels(doc, { slot, topbar, getMission, onSite }) {
  const seg = doc.createElement('div');
  seg.className = 'map-levels';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Map level of detail');
  const buttons = LEVELS.map((lv) => {
    const b = doc.createElement('button');
    b.type = 'button'; b.dataset.level = lv.id; b.textContent = lv.label; b.title = lv.title;
    b.addEventListener('click', () => show(lv.id));
    seg.appendChild(b);
    return b;
  });
  slot?.appendChild(seg);

  const layer = doc.createElement('section');
  layer.className = 'map-level-layer';
  layer.hidden = true;
  doc.body.appendChild(layer);
  const frames = {};
  let level = 'site', regionAt = null;

  // the layer starts under the top bar (which wraps on narrow screens)
  const place = () => { const r = topbar?.getBoundingClientRect(); doc.documentElement.style.setProperty('--level-top', `${Math.max(0, Math.round(r ? r.bottom : 0))}px`); };
  if (typeof ResizeObserver === 'function' && topbar) new ResizeObserver(place).observe(topbar);
  doc.defaultView.addEventListener('resize', place);

  function frame(id, src) {
    let f = frames[id];
    if (!f) {
      f = doc.createElement('iframe');
      f.className = 'map-level-frame';
      f.title = id === 'moon' ? 'The whole Moon in 3D' : 'Where to land';
      f.setAttribute('allow', 'fullscreen');
      layer.appendChild(f);
      frames[id] = f;
    }
    if (src && f.dataset.src !== src) { f.dataset.src = src; f.src = src; }
    return f;
  }
  function moonSrc() {
    const m = getMission();
    const lat = m?.latDeg ?? -60, lon = m?.lonDeg ?? 0;
    return `globe.html?v=${FRAME_V}#lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&dist=6200&tilt=0&heading=0&pick=1`;
  }
  function show(id, { at = null } = {}) {
    place();
    level = id;
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.level === id));
    layer.hidden = id === 'site';
    doc.documentElement.classList.toggle('map-level-open', id !== 'site');
    if (id === 'moon') frame('moon', frames.moon?.dataset.src ?? moonSrc());
    if (id === 'region') {
      const m = getMission();
      const p = at ?? regionAt ?? (m ? { latDeg: m.latDeg, lonDeg: m.lonDeg } : null);
      regionAt = p;
      const url = stageUrl('region', p ? { ...p, landingMs: m?.landingMs } : m);
      frame('region', `${url}${url.includes('?') ? '&' : '?'}v=${FRAME_V}`);
    }
    for (const [k, f] of Object.entries(frames)) f.hidden = k !== id;
    // the site level's own map is under the layer: give the keyboard back to it
    if (id === 'site') doc.getElementById('main')?.focus?.({ preventScroll: true });
  }
  doc.defaultView.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    const from = Object.values(frames).find((f) => f.contentWindow === e.source);
    if (!from) return;
    if (d.type === 'lsn-pick' && Number.isFinite(d.latDeg) && Number.isFinite(d.lonDeg)) show('region', { at: { latDeg: d.latDeg, lonDeg: d.lonDeg } });
    else if (d.type === 'lsn-site' && d.mission) { regionAt = { latDeg: d.mission.latDeg, lonDeg: d.mission.lonDeg }; show('site'); onSite?.(d.mission); }
    else if (d.type === 'lsn-close') show('site');
  });
  doc.defaultView.addEventListener('keydown', (e) => { if (e.key === 'Escape' && level !== 'site' && !e.defaultPrevented) show('site'); });
  for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.level === 'site'));
  const q = /[?&]level=(moon|region)\b/.exec(doc.defaultView.location.search);
  if (q) setTimeout(() => show(q[1]), 0);
  return { show, get level() { return level; }, el: seg };
}
