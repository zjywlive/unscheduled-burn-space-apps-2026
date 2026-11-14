// "Mapped": what of the Moon this app already has mapped, and where to map next. On the globe, outlines of
// the terrain on hand by resolution (the 120 m south polar square, the 40 m and 20 m tiles, the 5–20 m site
// patches), the ground covered by saved rover drives (a camera swath along each route and recorded track),
// and survey targets the team marks for the next mapping (10 × 10 km boxes, kept in localStorage and
// exported as JSON for tools/fetch-hires.mjs-style patch downloads). A panel lists the areas.
import { fromXY, toXY } from './terrain.js';
import { listRecords, loadRecord, RECORDS_KEY, downloadText } from './mission-save.js';

const TARGETS_KEY = 'lsn-survey-targets';
const SWATH_KM = 0.1;            // assumption: a rover's navigation cameras map about ±50 m either side
const R = 1737.4;
const CAP_KM2 = 2 * Math.PI * R * R * (1 - Math.sin((80 * Math.PI) / 180));   // the 80°S–90°S cap
const TIERS = [
  { id: 't120', label: '120 m south polar terrain', colour: 0x5b7cfa, css: '#5b7cfa' },
  { id: 't40', label: '40 m tiles', colour: 0x22d3ee, css: '#22d3ee' },
  { id: 't20', label: '20 m tiles', colour: 0x4ade80, css: '#4ade80' },
  { id: 'hires', label: '5–20 m site patches', colour: 0xffd23d, css: '#ffd23d' },
  { id: 'driven', label: 'Driven by saved missions', colour: 0xff7ad9, css: '#ff7ad9' },
  { id: 'targets', label: 'To map next', colour: 0xffffff, css: '#ffffff' },
];

// squares [x0, y0, x1, y1] (south polar map km) of a tiled level's tiles: keys "rRRcCC", row 0 at the top
export function tileSquares(level) {
  const T = level.tilePx * level.kmPerPixel;
  return (level.tiles ?? []).map((k) => {
    const m = /^r(\d+)c(\d+)$/.exec(k);
    if (!m) return null;
    const r = Number(m[1]), c = Number(m[2]), x0 = -level.halfKm + c * T, y1 = level.halfKm - r * T;
    return [x0, y1 - T, x0 + T, y1];
  }).filter(Boolean);
}

export function createMappedLayer(view, { parent, meta, hires } = {}) {
  if (!parent) return null;
  const THREE = view.THREE;
  const levels = meta?.levels ?? [];
  const sq = {
    t120: levels.filter((l) => !l.tiled && l.kmPerPixel <= 0.12).map((l) => [-l.halfKm, -l.halfKm, l.halfKm, l.halfKm]),
    t40: tileSquares(levels.find((l) => l.tiled && l.kmPerPixel === 0.04) ?? {}),
    t20: tileSquares(levels.find((l) => l.tiled && l.kmPerPixel === 0.02) ?? {}),
    hires: Object.values(hires?.sites ?? {}).map((s) => [s.xMin, s.yMax - s.n * s.kmPerPixel, s.xMin + s.n * s.kmPerPixel, s.yMax]),
  };
  let targets = [];
  try { const a = JSON.parse(localStorage.getItem(TARGETS_KEY) ?? '[]'); if (Array.isArray(a)) targets = a.filter((t) => Number.isFinite(t?.latDeg) && Number.isFinite(t?.lonDeg)); } catch { targets = []; }
  let drives = [];
  function readDrives() {
    drives = listRecords().map((x) => loadRecord(x.id)).filter(Boolean).map((r) => ({
      name: r.name,
      lines: [r.route.pts.map((q) => [q[0], q[1]]), ...(r.recording?.samples?.length ? [r.recording.samples.map((s) => [s[1], s[2]])] : [])],
      km: r.route.lengthKm ?? r.route.pts.at(-1)[2],
    }));
  }
  readDrives();

  parent.innerHTML = `
    <h2>Mapped</h2>
    <label class="row"><input type="checkbox" class="mp-on"> Show what is mapped</label>
    <ul class="mp-key"></ul>
    <div class="wp-tools"><button type="button" class="chip mp-add" aria-pressed="false">Mark an area to map</button><button type="button" class="chip mp-export">Export targets</button></div>
    <ol class="mp-list"></ol>
    <p class="hint mp-hint"></p>`;
  const $ = (s) => parent.querySelector(s);
  const on = $('.mp-on'), key = $('.mp-key'), list = $('.mp-list'), hint = $('.mp-hint'), addBtn = $('.mp-add');
  let adding = false;

  const area = (list) => list.reduce((a, [x0, y0, x1, y1]) => a + (x1 - x0) * (y1 - y0), 0);
  function renderKey() {
    const km2 = { t120: area(sq.t120.slice(-1)), t40: area(sq.t40), t20: area(sq.t20), hires: area(sq.hires), driven: drives.reduce((a, d) => a + d.km * SWATH_KM, 0), targets: targets.length * 100 };
    const fmt = (v) => (v >= 1000 ? `${Math.round(v).toLocaleString('en-GB')} km²` : `${v.toFixed(v >= 10 ? 0 : 1)} km²`);
    key.innerHTML = TIERS.map((t) => {
      const n = t.id === 'hires' ? `${sq.hires.length} patches · ` : t.id === 'driven' ? `${drives.length} drives, ${drives.reduce((a, d) => a + d.km, 0).toFixed(1)} km · ` : t.id === 't40' || t.id === 't20' ? `${sq[t.id].length} tiles · ` : t.id === 'targets' ? `${targets.length} · ` : '';
      const share = t.id === 't20' || t.id === 'hires' ? ` (${((km2[t.id] / CAP_KM2) * 100).toFixed(2)}% of the cap)` : '';
      return `<li><i style="border-color:${t.css}${t.id === 'driven' || t.id === 'hires' ? `;background:${t.css}44` : ''}${t.id === 'targets' ? ';border-style:dashed' : ''}"></i><span>${t.label}<small>${n}${fmt(km2[t.id])}${share}</small></span></li>`;
    }).join('');
    list.innerHTML = '';
    targets.forEach((t, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="wp-pos">${Math.abs(t.latDeg).toFixed(3)}°${t.latDeg < 0 ? 'S' : 'N'} ${t.lonDeg.toFixed(3)}°E<small>10 × 10 km to map</small></span><button type="button" class="wp-x" aria-label="Remove target ${i + 1}">×</button>`;
      li.querySelector('.wp-pos').addEventListener('click', () => view.flyTo({ lat: t.latDeg, lon: t.lonDeg, dist: 30, tilt: 40 }));
      li.querySelector('.wp-x').addEventListener('click', () => { targets.splice(i, 1); changed(); });
      list.appendChild(li);
    });
    hint.textContent = `Rover-scale terrain (20 m or finer) covers ${(((km2.t20 + km2.hires) / CAP_KM2) * 100).toFixed(2)}% of the 80°S cap in this app. ${adding ? 'Click the terrain to mark a 10 km box to map next.' : 'Mark boxes to plan the next mapping.'}`;
  }
  const save = () => { try { localStorage.setItem(TARGETS_KEY, JSON.stringify(targets)); } catch { /* storage blocked */ } };
  function changed() { save(); renderKey(); built = ''; view.redraw(); }

  // ---- the 3D outlines and swaths ----
  const group = new THREE.Group();
  group.visible = false;
  view.addObject(group);
  let built = '';
  function outline(squares, colour, lift, dashed = false) {
    const pos = [], o = new THREE.Vector3(...view.surface(-90, 0, 0));
    const P = (x, y) => { const q = fromXY(x, y); return new THREE.Vector3(...view.surface(q.latDeg, q.lonDeg, lift)).sub(o); };
    for (const [x0, y0, x1, y1] of squares) {
      const n = Math.max(2, Math.min(24, Math.ceil((x1 - x0) / Math.max(0.05, view.kmPerPx() * 20))));
      const ring = [];
      for (let k = 0; k < n; k++) ring.push([x0 + ((x1 - x0) * k) / n, y0]);
      for (let k = 0; k < n; k++) ring.push([x1, y0 + ((y1 - y0) * k) / n]);
      for (let k = 0; k < n; k++) ring.push([x1 - ((x1 - x0) * k) / n, y1]);
      for (let k = 0; k < n; k++) ring.push([x0, y1 - ((y1 - y0) * k) / n]);
      for (let k = 0; k < ring.length; k++) { const a = P(...ring[k]), b = P(...ring[(k + 1) % ring.length]); pos.push(a.x, a.y, a.z, b.x, b.y, b.z); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const mat = dashed ? new THREE.LineDashedMaterial({ color: colour, dashSize: view.kmPerPx() * 8, gapSize: view.kmPerPx() * 6 }) : new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.85 });
    const m = new THREE.LineSegments(g, mat); if (dashed) m.computeLineDistances();
    m.position.copy(o); m.renderOrder = 5;
    return m;
  }
  function fill(squares, colour, lift, opacity) {
    const pos = [], o = new THREE.Vector3(...view.surface(-90, 0, 0)), N = 8;
    const P = (x, y) => { const q = fromXY(x, y); return new THREE.Vector3(...view.surface(q.latDeg, q.lonDeg, lift)).sub(o); };
    for (const [x0, y0, x1, y1] of squares) {
      const G = [];
      for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) G.push(P(x0 + ((x1 - x0) * i) / N, y0 + ((y1 - y0) * j) / N));
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const a = G[j * (N + 1) + i], b = G[j * (N + 1) + i + 1], c = G[(j + 1) * (N + 1) + i + 1], d = G[(j + 1) * (N + 1) + i];
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
    m.position.copy(o); m.renderOrder = 4;
    return m;
  }
  function swath(line, lift) {
    // a strip SWATH_KM wide (at least a few pixels) along a lat/lon line
    const w = Math.max(SWATH_KM, view.kmPerPx() * 3), o = new THREE.Vector3(...view.surface(line[0][0], line[0][1], 0));
    const P = line.map(([la, lo]) => new THREE.Vector3(...view.surface(la, lo, lift)));
    const pos = [];
    for (let i = 0; i + 1 < P.length; i++) {
      const t = P[i + 1].clone().sub(P[i]); if (t.lengthSq() < 1e-12) continue;
      const side = t.clone().cross(P[i].clone().normalize()).normalize().multiplyScalar(w / 2);
      const a = P[i].clone().sub(side).sub(o), b = P[i].clone().add(side).sub(o), c = P[i + 1].clone().add(side).sub(o), d = P[i + 1].clone().sub(side).sub(o);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff7ad9, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
    m.position.copy(o); m.renderOrder = 5;
    return m;
  }
  const targetSquares = () => targets.map((t) => { const [x, y] = toXY(t.latDeg, t.lonDeg); return [x - 5, y - 5, x + 5, y + 5]; });
  view.onFrame(() => {
    if (!group.visible) return;
    const kpp = view.kmPerPx(), k = `${Math.round(Math.log(kpp) * 2)}:${view.exaggeration}:${targets.length}:${drives.length}:${window.__globe?.pyramid?.version ?? 0}`;
    if (k === built) return;
    built = k;
    for (const c of [...group.children]) { group.remove(c); c.geometry?.dispose(); c.material?.dispose(); }
    const lift = Math.max(0.02, kpp * 2.5) + 0.01 * view.exaggeration;
    group.add(outline(sq.t120, TIERS[0].colour, lift));
    if (sq.t40.length) group.add(outline(sq.t40, TIERS[1].colour, lift));
    if (sq.t20.length) group.add(outline(sq.t20, TIERS[2].colour, lift));
    if (sq.hires.length) { group.add(fill(sq.hires, TIERS[3].colour, lift, 0.07)); group.add(outline(sq.hires, TIERS[3].colour, lift)); }
    for (const d of drives) for (const line of d.lines) if (line.length > 1) group.add(swath(line, lift));
    if (targets.length) { const s = targetSquares(); group.add(fill(s, 0xffffff, lift, 0.08)); group.add(outline(s, 0xffffff, lift, true)); }
  });

  on.addEventListener('change', () => { group.visible = on.checked; built = ''; view.redraw(); if (on.checked && view.camera.dist > 2000) view.flyTo({ lat: -89, lon: 0, dist: 700, tilt: 0 }); });
  addBtn.addEventListener('click', () => { adding = !adding; addBtn.setAttribute('aria-pressed', String(adding)); addBtn.textContent = adding ? 'Click the terrain…' : 'Mark an area to map'; if (adding && !on.checked) on.click(); renderKey(); });
  let down = null;
  view.canvas.addEventListener('pointerdown', (e) => { down = adding && e.button === 0 ? [e.clientX, e.clientY] : null; });
  view.canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) { down = null; return; }
    down = null;
    const hit = view.pick(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.latDeg > -79.5) { hint.textContent = 'Targets go on the south polar map (south of 79.5°S) for now.'; return; }
    targets.push({ latDeg: +hit.latDeg.toFixed(5), lonDeg: +hit.lonDeg.toFixed(5), halfKm: 5, addedMs: Date.now() });
    adding = false; addBtn.setAttribute('aria-pressed', 'false'); addBtn.textContent = 'Mark an area to map';
    changed();
  });
  $('.mp-export').addEventListener('click', () => downloadText(document, 'survey-targets.json', JSON.stringify({ about: 'Areas to map next, from the Lunar Site Navigator globe. Centres in selenographic degrees (east longitude); 10 × 10 km boxes.', targets }, null, 1)));
  window.addEventListener('storage', (e) => { if (e.key === RECORDS_KEY) { readDrives(); changed(); } if (e.key === TARGETS_KEY) { try { targets = JSON.parse(e.newValue ?? '[]'); } catch { targets = []; } renderKey(); built = ''; } });
  renderKey();
  return { get targets() { return targets.map((t) => ({ ...t })); }, refresh() { readDrives(); changed(); } };
}
