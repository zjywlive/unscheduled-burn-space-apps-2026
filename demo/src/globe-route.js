// Phase 6: a planned route on the 3D globe (route3d.js payload): a ribbon draped on the terrain, coloured by
// what the drive met (sunlit, in shadow, one-way, battery under the reserve, not reached) or by slope,
// markers for the havens, parking stops and where the battery ran out, the no-go ground (traps) as
// translucent red volumes, the self-driving planner's search (trees, candidates, chosen path) when the payload
// has one, and the rover: a six-wheeled model standing on the terrain with its pitch and roll, with its
// coordinate frames (base_link, mast_cam, wheels) for the labels. Sizes follow the zoom.
import { FLAGS } from './route3d.js';
import { slopeColour, rgb01 } from './slope-colours.js';

const COLORS = { lit: [0.96, 0.96, 0.96], dark: [0.36, 0.45, 0.66], oneWay: [1, 0.62, 0.26], low: [1, 0.32, 0.32], unreached: [0.35, 0.35, 0.35] };
const RAD = Math.PI / 180;
const ROVER_LEN_M = 2.2;   // model length in metres

export function createRouteLayer(view, payload, { roverPx = 90 } = {}) {
  const THREE = view.THREE;
  const group = new THREE.Group();
  view.addObject(group);
  let ribbon = null, built = null, colourBy = 'state';
  const reserve = payload.reserve ?? 0.2, timed = payload.pts.some((q) => Number.isFinite(q[3]));
  const show = { traps: true, search: true, frames: false };

  function colourOf(q) {
    if (colourBy === 'slope') return rgb01(slopeColour(q[6]));
    if (timed && !Number.isFinite(q[3])) return COLORS.unreached;
    if (q[5] & FLAGS.oneWay) return COLORS.oneWay;
    if (q[4] !== null && q[4] < reserve) return COLORS.low;
    return !timed || q[5] & FLAGS.lit ? COLORS.lit : COLORS.dark;
  }

  // a strip of width w km through lat/lon points, lifted above the terrain, vertices relative to the first point
  function strip(ll, w, colours, lift, opacity = 0.95) {
    const n = ll.length;
    const P = ll.map(([la, lo]) => new THREE.Vector3(...view.surface(la, lo, lift)));
    const o = P[0].clone();
    const pos = new Float32Array(n * 2 * 3), col = new Float32Array(n * 2 * 3), idx = [];
    for (let i = 0; i < n; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
      const t = b.clone().sub(a).normalize(), up = P[i].clone().normalize();
      const side = new THREE.Vector3().crossVectors(t, up).normalize().multiplyScalar(w / 2);
      const L = P[i].clone().sub(side).sub(o), R = P[i].clone().add(side).sub(o);
      pos.set([L.x, L.y, L.z, R.x, R.y, R.z], i * 6);
      const c = colours(i);
      col.set([...c, ...c], i * 6);
      if (i + 1 < n) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity, depthWrite: false }));
    m.position.copy(o);
    m.renderOrder = 3;
    return m;
  }
  const buildRibbon = (w) => strip(payload.pts.map((q) => [q[0], q[1]]), w, (i) => colourOf(payload.pts[i]), 0.012 * view.exaggeration + w * 0.4);
  const dispose = (o) => { if (!o) return; group.remove(o); o.traverse?.((c) => { c.geometry?.dispose(); c.material?.dispose(); }); };

  // ---- no-go volumes: each trap cell a translucent red box standing on the ground ----
  let traps = null;
  function buildTraps() {
    const cells = payload.traps?.cells ?? [];
    if (!cells.length) return null;
    const c = payload.traps.cellKm ?? 0.24, hKm = 0.035 * view.exaggeration;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(c * 0.96, hKm, c * 0.96), new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.3, depthWrite: false }), cells.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), s = new THREE.Vector3(1, 1, 1);
    const o = new THREE.Vector3(...view.surface(cells[0][0], cells[0][1], 0));
    cells.forEach(([la, lo], i) => {
      const p = new THREE.Vector3(...view.surface(la, lo, hKm / 2 - 0.004));
      q.setFromUnitVectors(up, p.clone().normalize());
      m.compose(p.sub(o), q, s);
      mesh.setMatrixAt(i, m);
    });
    mesh.position.copy(o);
    mesh.renderOrder = 4;
    const g = new THREE.Group(); g.add(mesh);
    return g;
  }

  // ---- the self-driving planner's search (payload.autonav from route-rrt.js) ----
  let search = null;
  function buildSearch(w) {
    const a = payload.autonav;
    if (!a) return null;
    const g = new THREE.Group(), lift = 0.01 * view.exaggeration + w * 0.5;
    const o = new THREE.Vector3(...view.surface(payload.pts[0][0], payload.pts[0][1], 0));
    const V = (la, lo, extra = 0) => new THREE.Vector3(...view.surface(la, lo, lift + extra)).sub(o);
    if (a.trees?.length) {
      const pos = new Float32Array(a.trees.length * 6);
      a.trees.forEach(([la1, lo1, la2, lo2], i) => { const p = V(la1, lo1), q = V(la2, lo2); pos.set([p.x, p.y, p.z, q.x, q.y, q.z], i * 6); });
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x5b7cfa, transparent: true, opacity: 0.35, depthWrite: false }));
      lines.position.copy(o); lines.renderOrder = 2; g.add(lines);
    }
    for (const c of a.candidates ?? []) {
      if (c.length < 2) continue;
      const geo = new THREE.BufferGeometry().setFromPoints(c.map(([la, lo]) => V(la, lo, w * 0.2)));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x3b5bdb, transparent: true, opacity: 0.85, depthWrite: false }));
      line.position.copy(o); line.renderOrder = 3; g.add(line);
    }
    if (a.trajectory?.length > 1) {
      const t = strip(a.trajectory, w * 0.7, () => [0.13, 0.83, 0.93], lift + w * 0.5, 0.95);
      g.add(t);
    }
    return g;
  }

  // ---- markers: spheres scaled with the zoom ----
  const markers = [];
  function marker(lat, lon, color, r = 1, cls = '') {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color }));
    mesh.userData = { lat, lon, r, cls };
    group.add(mesh); markers.push(mesh);
    return mesh;
  }
  const first = payload.pts[0], last = payload.pts[payload.pts.length - 1];
  marker(first[0], first[1], 0xffffff, 1.1, 'start');
  marker(last[0], last[1], 0xffffff, 1.1, 'end');
  for (const h of payload.havens ?? []) marker(h.latDeg, h.lonDeg, 0x7ee08a, 0.8, 'haven');
  for (const st of payload.stops ?? []) marker(st.latDeg, st.lonDeg, 0x8ab4f8, 1, 'stop');
  if (payload.emptyAt) marker(payload.emptyAt.latDeg, payload.emptyAt.lonDeg, 0xff5252, 1.3, 'empty');
  for (const w of payload.wps ?? []) marker(w.latDeg, w.lonDeg, 0xffffff, 0.75, 'waypoint');

  // ---- the rover model, in its own frame: x forward, y left, z up (ROS base_link), metres ----
  const rover = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.6, metalness: 0.2 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2b2f, roughness: 0.9 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x3a62d0, roughness: 0.4, metalness: 0.25, emissive: 0x0b1a44 });
  const accent = new THREE.MeshBasicMaterial({ color: 0xffd23d });
  const box = (x, y, z, sx, sy, sz, mat) => { const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat); m.position.set(x, y, z); rover.add(m); return m; };
  box(0, 0, 0.72, 1.9, 1.25, 0.42, bodyMat);                     // chassis
  box(-0.1, 0, 0.97, 1.7, 1.45, 0.04, panelMat);                 // solar deck
  box(0.98, 0, 0.72, 0.06, 1.0, 0.18, accent);                   // front bumper (shows which way it faces)
  const wheels = {};
  for (const [name, x, y] of [['wheel_fl', 0.75, 0.82], ['wheel_fr', 0.75, -0.82], ['wheel_ml', 0, 0.86], ['wheel_mr', 0, -0.86], ['wheel_rl', -0.75, 0.82], ['wheel_rr', -0.75, -0.82]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.2, 18), darkMat);
    w.position.set(x, y, 0.26); rover.add(w); wheels[name] = w;   // a cylinder's axis is its y: the axle, left–right
    box(x, y * 0.86, 0.5, 0.08, 0.08, 0.42, darkMat);              // suspension leg
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 1.0, 10), bodyMat);
  mast.rotation.x = Math.PI / 2; mast.position.set(0.62, 0.38, 1.45); rover.add(mast);
  box(0.66, 0.38, 2.0, 0.22, 0.42, 0.16, bodyMat);                // mast camera head
  box(0.78, 0.30, 2.0, 0.02, 0.07, 0.07, darkMat); box(0.78, 0.46, 2.0, 0.02, 0.07, 0.07, darkMat);   // camera eyes
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.06, 0.08, 20), bodyMat);
  dish.rotation.x = Math.PI / 2; dish.position.set(-0.7, -0.35, 1.3); rover.add(dish);
  box(-0.7, -0.35, 1.12, 0.04, 0.04, 0.3, darkMat);
  // the x-ray outline: the same parts in flat gold drawn over everything, shown while terrain hides the rover
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0xffd23d, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
  const ghost = new THREE.Group();
  for (const m of [...rover.children]) {
    if (!m.isMesh) continue;
    const g = new THREE.Mesh(m.geometry, ghostMat);
    g.position.copy(m.position); g.quaternion.copy(m.quaternion); g.scale.copy(m.scale); g.renderOrder = 20;
    ghost.add(g);
  }
  ghost.visible = false;
  rover.add(ghost);
  // frame axes (x red, y green, z blue), shown with the labels
  const axes = new THREE.Group();
  const axis = (x, y, z, dir, color, len) => {
    const a = new THREE.ArrowHelper(new THREE.Vector3(...dir), new THREE.Vector3(x, y, z), len, color, len * 0.22, len * 0.12);
    axes.add(a);
  };
  for (const [x, y, z, len] of [[0, 0, 0.72, 1.6], [0.78, 0.38, 2.0, 0.7]]) {
    axis(x, y, z, [1, 0, 0], 0xff5252, len); axis(x, y, z, [0, 1, 0], 0x7ee08a, len); axis(x, y, z, [0, 0, 1], 0x5b9bff, len);
  }
  axes.visible = false;
  rover.add(axes);
  const FRAMES = { base_link: [0, 0, 0.72], mast_cam: [0.78, 0.38, 2.0], wheel_fl: [0.75, 0.82, 0.26], wheel_rr: [-0.75, -0.82, 0.26] };
  group.add(rover);
  let roverAt = { latDeg: first[0], lonDeg: first[1] }, att = { headingDeg: 0, pitchDeg: 0, rollDeg: 0 }, roverScale = 0.001;

  function place(obj, lat, lon, size, lift = 0) {
    const [x, y, z] = view.surface(lat, lon, lift);
    obj.position.set(x, y, z);
    obj.scale.setScalar(size);
  }
  // the rover's basis: forward along the heading, up along the local vertical, then pitched and rolled
  const basis = new THREE.Matrix4();
  function orientRover() {
    const la = roverAt.latDeg * RAD, lo = roverAt.lonDeg * RAD;
    const U = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
    const N = new THREE.Vector3(-Math.sin(la) * Math.cos(lo), Math.cos(la), Math.sin(la) * Math.sin(lo));
    const E = new THREE.Vector3(-Math.sin(lo), 0, -Math.cos(lo));
    const h = att.headingDeg * RAD;
    let f = N.clone().multiplyScalar(Math.cos(h)).addScaledVector(E, Math.sin(h)).normalize();
    let right = f.clone().cross(U).normalize();
    let up = U.clone();
    const p = (att.pitchDeg || 0) * RAD, r = (att.rollDeg || 0) * RAD;
    f.applyAxisAngle(right, p); up.applyAxisAngle(right, p);            // nose up
    right.applyAxisAngle(f, -r); up.applyAxisAngle(f, -r);              // right side up
    const left = right.clone().negate();
    basis.makeBasis(f, left, up);
    rover.quaternion.setFromRotationMatrix(basis);
  }

  // per frame: keep sizes in step with the zoom, rebuild what is draped when the zoom, exaggeration or terrain changes
  function frame(terrainStamp) {
    const kpp = view.kmPerPx(), w = Math.min(3, Math.max(0.02, kpp * 5));
    const key = `${terrainStamp}:${view.exaggeration}:${colourBy}`;
    if (!built || built.key !== key || w / built.w > 1.35 || built.w / w > 1.35) {
      dispose(ribbon); ribbon = buildRibbon(w); group.add(ribbon);
      dispose(search); search = buildSearch(w); if (search) { search.visible = show.search; group.add(search); }
      if (!built || built.key !== key) { dispose(traps); traps = buildTraps(); if (traps) { traps.visible = show.traps; group.add(traps); } }
      built = { key, w };
    }
    const s = kpp * 5;
    for (const m of markers) place(m, m.userData.lat, m.userData.lon, s * m.userData.r, s * m.userData.r);
    // real size (2.2 m) when the camera is close enough, else roverPx pixels long so it stays visible
    roverScale = Math.max(0.001, (kpp * roverPx) / ROVER_LEN_M);
    place(rover, roverAt.latDeg, roverAt.lonDeg, roverScale, 0.004 * view.exaggeration * 0.25);
    orientRover();
  }

  const colours = { state: 0xffd23d };
  return {
    frame,
    setRover(r, color = 0xffd23d, attitude = null) {
      roverAt = r;
      if (attitude) att = attitude;
      accent.color.setHex(color);
      colours.state = color;
      view.redraw();
    },
    setColourBy(mode) { colourBy = mode === 'slope' ? 'slope' : 'state'; built = null; view.redraw(); },
    setVisible(what, on) {
      show[what] = !!on;
      if (what === 'traps' && traps) traps.visible = !!on;
      if (what === 'search' && search) search.visible = !!on;
      if (what === 'frames') axes.visible = !!on;
      view.redraw();
    },
    // world positions (km) of the rover's frames, for their labels
    frames() {
      rover.updateMatrixWorld(true);
      return Object.entries(FRAMES).map(([name, [x, y, z]]) => ({ name, p: new THREE.Vector3(x, y, z).applyMatrix4(rover.matrixWorld) }));
    },
    get scaleUp() { return roverScale / 0.001; },
    // the top of the mast above the ground, km (as drawn), for line-of-sight checks
    get topKm() { return roverScale * 2.1; },
    setHidden(on) { if (ghost.visible !== !!on) { ghost.visible = !!on; view.redraw(); } },
    get hidden() { return ghost.visible; },
    hasTraps: !!payload.traps?.cells?.length,
    hasSearch: !!payload.autonav,
    dispose() { view.removeObject(group); },
  };
}
