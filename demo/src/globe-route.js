// Phase 6: a planned route on the 3D globe (route3d.js payload): a ribbon draped on the terrain, coloured
// by what the drive met (sunlit, in shadow, one-way, battery under the reserve, not reached), markers for the
// havens, parking stops and where the battery ran out, and the rover itself. Sizes follow the zoom.
import { FLAGS } from './route3d.js';

const COLORS = { lit: [0.96, 0.96, 0.96], dark: [0.36, 0.45, 0.66], oneWay: [1, 0.62, 0.26], low: [1, 0.32, 0.32], unreached: [0.35, 0.35, 0.35] };

export function createRouteLayer(view, payload) {
  const THREE = view.THREE;
  const group = new THREE.Group();
  view.addObject(group);
  let ribbon = null, built = null;
  const reserve = payload.reserve ?? 0.2, timed = payload.pts.some((q) => Number.isFinite(q[3]));

  function colourOf(q) {
    if (timed && !Number.isFinite(q[3])) return COLORS.unreached;
    if (q[5] & FLAGS.oneWay) return COLORS.oneWay;
    if (q[4] !== null && q[4] < reserve) return COLORS.low;
    return !timed || q[5] & FLAGS.lit ? COLORS.lit : COLORS.dark;
  }

  // ribbon: a strip of width w km, lifted above the terrain, vertices relative to the first point
  function buildRibbon(w) {
    const pts = payload.pts, n = pts.length, lift = 0.012 * view.exaggeration + w * 0.4;
    const P = pts.map((q) => new THREE.Vector3(...view.surface(q[0], q[1], lift)));
    const o = P[0].clone();
    const pos = new Float32Array(n * 2 * 3), col = new Float32Array(n * 2 * 3), idx = [];
    for (let i = 0; i < n; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
      const t = b.clone().sub(a).normalize(), up = P[i].clone().normalize();
      const side = new THREE.Vector3().crossVectors(t, up).normalize().multiplyScalar(w / 2);
      const L = P[i].clone().sub(side).sub(o), R = P[i].clone().add(side).sub(o);
      pos.set([L.x, L.y, L.z, R.x, R.y, R.z], i * 6);
      const c = colourOf(pts[i]);
      col.set([...c, ...c], i * 6);
      if (i + 1 < n) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }));
    m.position.copy(o);
    m.renderOrder = 2;
    return m;
  }

  // markers: spheres scaled with the zoom
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

  // the rover: a bright sphere on a mast
  const rover = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffd23d }));
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1, 8), new THREE.MeshBasicMaterial({ color: 0xffd23d }));
  rover.add(body, mast);
  group.add(rover);
  let roverAt = { latDeg: first[0], lonDeg: first[1] };

  function place(obj, lat, lon, size, lift = 0) {
    const [x, y, z] = view.surface(lat, lon, lift);
    obj.position.set(x, y, z);
    obj.scale.setScalar(size);
  }

  // per frame: keep sizes in step with the zoom, rebuild the ribbon when the zoom, exaggeration or terrain changes
  function frame(terrainStamp) {
    const kpp = view.kmPerPx(), w = Math.min(3, Math.max(0.02, kpp * 5));
    const key = `${terrainStamp}:${view.exaggeration}`;
    if (!built || built.key !== key || w / built.w > 1.35 || built.w / w > 1.35) {
      if (ribbon) { group.remove(ribbon); ribbon.geometry.dispose(); ribbon.material.dispose(); }
      ribbon = buildRibbon(w);
      group.add(ribbon);
      built = { key, w };
    }
    const s = kpp * 5;
    for (const m of markers) place(m, m.userData.lat, m.userData.lon, s * m.userData.r, s * m.userData.r);
    const rs = kpp * 7;
    place(rover, roverAt.latDeg, roverAt.lonDeg, 1, 0);
    // the mast stands along the local vertical: body at the top
    const up = rover.position.clone().normalize();
    body.scale.setScalar(rs); body.position.copy(up.clone().multiplyScalar(rs * 3.2));
    mast.scale.set(rs * 0.6, rs * 3.2, rs * 0.6); mast.position.copy(up.clone().multiplyScalar(rs * 1.6));
    mast.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  }

  return {
    frame,
    setRover(r, color = 0xffd23d) { roverAt = r; body.material.color.setHex(color); mast.material.color.setHex(color); view.redraw(); },
    dispose() { view.removeObject(group); },
  };
}
