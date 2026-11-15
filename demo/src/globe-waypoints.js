// Waypoints on the 3D globe: click the terrain (or type a latitude and longitude) to place numbered
// waypoints, see each one's position, height, the heading and length of the leg to the next, and send them
// to the navigator to plan the rover route through them ("rp=" points on the rover step). Kept in
// localStorage so they survive a reload. DOM, three.js lines draped on the terrain, labels on screen.
import { toXY } from './terrain.js';
import { arcGc, onGc } from './globe-view.js';
import { bearingDeg, compassName } from './rover-attitude.js';
import { stageUrl } from './mission-flow.js';

const KEY = 'lsn-globe-wps', MAX = 8, R = 1737.4, RAD = Math.PI / 180;
const gcKm = (a, b) => {
  const p1 = a.latDeg * RAD, p2 = b.latDeg * RAD, dl = (b.lonDeg - a.lonDeg) * RAD;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2)));
};
const ll = (v) => `${Math.abs(v.latDeg).toFixed(4)}°${v.latDeg < 0 ? 'S' : 'N'} ${v.lonDeg > 180 ? `${(360 - v.lonDeg).toFixed(4)}°W` : `${v.lonDeg.toFixed(4)}°E`}`;

// "−89.45, 222.69" or "89.45S 137.31W" → { latDeg, lonDeg } | null
export function parseLatLon(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?\s*$/i.exec(String(text));
  if (!m) return null;
  let lat = Number(m[1]), lon = Number(m[3]);
  if (m[2] && m[2].toUpperCase() === 'S') lat = -Math.abs(lat);
  if (m[4] && m[4].toUpperCase() === 'W') lon = -Math.abs(lon);
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 360)) return null;
  return { latDeg: lat, lonDeg: ((lon % 360) + 360) % 360 };
}

// the navigator link that plans a rover route through the points (south polar map, 2–8 points)
export function navigatorLink(points, mission) {
  const rp = points.map((p) => toXY(p.latDeg, p.lonDeg).map((v) => v.toFixed(2)).join(',')).join(';');
  const base = mission ? stageUrl('rover', mission) : `index.html#view=map&site=${points[0].latDeg.toFixed(4)},${points[0].lonDeg.toFixed(4)}&plan=1`;
  return `${base}&rp=${rp}`;
}

// parent: the panel section (typed entry, the list, hints); bar: where its actions go (the page's action bar)
export function createWaypointTool(view, { parent, bar = null, mission = null, terrain, payload = null } = {}) {
  if (!parent) return null;
  const THREE = view.THREE;
  let pts = [];
  try { const a = JSON.parse(localStorage.getItem(KEY) ?? '[]'); if (Array.isArray(a)) pts = a.filter((p) => Number.isFinite(p?.latDeg) && Number.isFinite(p?.lonDeg)).slice(0, MAX); } catch { pts = []; }
  let adding = false;
  const actions = `
      <button type="button" class="ab-btn wp-add" aria-pressed="false" title="Click the terrain to place waypoints">Add points</button>
      ${payload?.wps?.length ? '<button type="button" class="ab-btn wp-from" title="Start from the planned route\'s waypoints">Route\'s</button>' : ''}
      <button type="button" class="ab-btn wp-clear" title="Remove all waypoints">Clear</button>
      <a class="ab-btn ab-primary wp-plan" target="_blank" rel="noopener" title="Open the navigator and plan the rover route through these points">Plan route →</a>`;
  if (bar) bar.insertAdjacentHTML('beforeend', actions);
  parent.innerHTML = `
    <h2>Waypoints</h2>
    ${bar ? '' : `<div class="wp-tools">${actions}</div>`}
    <form class="wp-type"><input type="text" placeholder="lat, lon  (e.g. -89.45, 222.69)" aria-label="Add a waypoint by latitude and longitude"><button type="submit" class="chip">Add</button></form>
    <ol class="wp-list"></ol>
    <p class="hint wp-hint"></p>`;
  const $ = (s) => parent.querySelector(s) ?? bar?.querySelector(s);
  const addBtn = $('.wp-add'), list = $('.wp-list'), planA = $('.wp-plan'), hint = $('.wp-hint');
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(pts)); } catch { /* storage blocked */ } };

  // the 3D part: a marker per waypoint and the legs between them, draped on the terrain
  const group = new THREE.Group();
  view.addObject(group);
  const labels = document.getElementById('labels');
  let labelEls = [], built = '';
  function rebuild() {
    for (const c of [...group.children]) { group.remove(c); c.geometry?.dispose(); c.material?.dispose(); }
    for (const el of labelEls) el.remove();
    labelEls = pts.map((p, i) => {
      const el = document.createElement('div');
      el.className = 'wp-pin'; el.textContent = String(i + 1);
      labels.appendChild(el);
      return el;
    });
    built = '';
  }
  function drape() {
    const kpp = view.kmPerPx(), key = `${pts.length}:${JSON.stringify(pts.at(-1) ?? null)}:${view.exaggeration}:${Math.round(Math.log(kpp) * 3)}:${window.__globe?.pyramid?.version ?? 0}`;
    if (key === built) return;
    built = key;
    for (const c of [...group.children]) { group.remove(c); c.geometry?.dispose(); c.material?.dispose(); }
    if (pts.length < 2) return;
    const lift = Math.max(0.01, kpp * 3), o = new THREE.Vector3(...view.surface(pts[0].latDeg, pts[0].lonDeg, 0));
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], n = Math.max(8, Math.min(200, Math.ceil(gcKm(a, b) / Math.max(0.02, kpp * 4))));
      const d = arcGc(a, b), line = [];   // along the great circle (globe-view.js), not the parallels
      for (let k = 0; k <= n; k++) { const q = onGc(a, b, k / n, d); line.push(new THREE.Vector3(...view.surface(q.latDeg, q.lonDeg, lift)).sub(o)); }
      const m = new THREE.Line(new THREE.BufferGeometry().setFromPoints(line), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: kpp * 10, gapSize: kpp * 6, transparent: true, opacity: 0.9, depthTest: false }));
      m.computeLineDistances(); m.position.copy(o); m.renderOrder = 7;
      group.add(m);
    }
  }
  view.onFrame(() => {
    drape();
    pts.forEach((p, i) => {
      const s = view.project(p.latDeg, p.lonDeg), el = labelEls[i];
      if (!el) return;
      el.hidden = !s;
      if (s) el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`;
    });
  });

  function render() {
    list.innerHTML = '';
    pts.forEach((p, i) => {
      const h = terrain.heightAt(p.latDeg, p.lonDeg), next = pts[i + 1];
      const leg = next ? `→ ${Math.round(bearingDeg(p.latDeg, p.lonDeg, next.latDeg, next.lonDeg))}° ${compassName(bearingDeg(p.latDeg, p.lonDeg, next.latDeg, next.lonDeg))} · ${gcKm(p, next).toFixed(2)} km` : 'end';
      const li = document.createElement('li');
      li.innerHTML = `<span class="n">${i + 1}</span><span class="wp-pos">${ll(p)}<small>${Number.isFinite(h) ? `${Math.round(h)} m` : ''} · ${leg}</small></span><button type="button" class="wp-x" aria-label="Remove waypoint ${i + 1}">×</button>`;
      li.querySelector('.wp-pos').addEventListener('click', () => view.flyTo({ lat: p.latDeg, lon: p.lonDeg, dist: Math.min(view.camera.dist, 6), tilt: 50, heading: view.camera.heading }));
      li.querySelector('.wp-x').addEventListener('click', () => { pts.splice(i, 1); changed(); });
      list.appendChild(li);
    });
    const total = pts.slice(1).reduce((a, p, i) => a + gcKm(pts[i], p), 0);
    const south = pts.every((p) => p.latDeg < -79.5);
    const ok = pts.length >= 2 && south;
    // never hidden: greyed out, with the reason in its tooltip, until there is a route to plan
    planA.classList.toggle('is-off', !ok); planA.setAttribute('aria-disabled', String(!ok));
    if (ok) { planA.href = navigatorLink(pts, mission); planA.title = 'Open the navigator and plan the rover route through these points'; }
    else { planA.removeAttribute('href'); planA.title = pts.length < 2 ? 'Add at least a start and an end' : 'The navigator plans south of 79.5°S'; }
    hint.textContent = pts.length < 2 ? `${adding ? 'Click the terrain to place a waypoint' : 'Add a start, any waypoints and an end'} (2–${MAX}).` : !south ? 'The navigator plans rover routes south of 79.5°S; move the points there.' : `${pts.length} points, ${total.toFixed(2)} km in straight legs; the planner finds the drivable way.`;
  }
  function changed() { save(); rebuild(); render(); view.redraw(); }
  function add(p) { if (pts.length >= MAX) { hint.textContent = `At most ${MAX} points.`; return; } pts.push(p); changed(); }

  addBtn.addEventListener('click', () => { adding = !adding; addBtn.setAttribute('aria-pressed', String(adding)); addBtn.textContent = adding ? 'Adding… (click the map)' : 'Add points'; view.canvas.classList.toggle('adding', adding); render(); });
  $('.wp-clear').addEventListener('click', () => { pts = []; changed(); });
  $('.wp-from')?.addEventListener('click', () => { pts = payload.wps.map((w) => ({ latDeg: w.latDeg, lonDeg: w.lonDeg })).slice(0, MAX); changed(); });
  $('.wp-type').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('.wp-type input'), p = parseLatLon(inp.value);
    if (!p) { hint.textContent = 'Type a latitude and longitude, e.g. -89.45, 222.69 or 89.45S 137.31W.'; return; }
    inp.value = ''; add(p);
  });
  // a click (not a drag) on the terrain adds a point while adding is on
  let down = null;
  view.canvas.addEventListener('pointerdown', (e) => { down = adding && e.button === 0 ? [e.clientX, e.clientY] : null; });
  view.canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) { down = null; return; }
    down = null;
    const hit = view.pick(e.clientX, e.clientY);
    if (hit) add({ latDeg: +hit.latDeg.toFixed(6), lonDeg: +hit.lonDeg.toFixed(6) });
  });
  rebuild(); render();
  return { get points() { return pts.map((p) => ({ ...p })); }, add, clear() { pts = []; changed(); } };
}
