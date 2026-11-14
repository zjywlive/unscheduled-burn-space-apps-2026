// Scene 2: lunar approach and low lunar orbit, Moon-centred inertial (MCI), 1 unit = 1 km, true scale.
// The Moon turns under the orbit (synchronous rotation); the south polar cap is LOLA relief from dem_480m.
import { three, v3, makeLine, starField, createControls } from './view-common.js';
import { R_MOON, R_EARTH, MOON_RATE, RAD } from './constants.js';
import { fromXY } from '../terrain.js';
import { unitFromLonLat } from '../geometry.js';
import { norm, scale, unit } from './vec.js';
import { buildLanderModel, drawScale, sizeNote } from './model.js';

// LOLA polar cap mesh in Moon-fixed km (three.js axes). dem: terrain.createDem(); edge at maxLatDeg.
export function polarCapGeometry(dem, { maxLatDeg = -79.5, n = 240 } = {}) {
  const T = three();
  const rMax = 2 * R_MOON * Math.tan(((90 + maxLatDeg) / 2) * RAD);
  const half = rMax, step = (2 * half) / n;
  const N = n + 1;
  const pos = new Float32Array(N * N * 3);
  const ok = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = -half + i * step, y = -half + j * step;
    const k = j * N + i;
    if (Math.hypot(x, y) > rMax + step) continue;
    const h = dem.heightAtXY(x, y);
    const { latDeg, lonDeg } = fromXY(x, y);
    const u = unitFromLonLat(lonDeg, latDeg);
    const r = R_MOON + (h ?? 0) / 1000;
    pos.set([u[0] * r, u[2] * r, -u[1] * r], k * 3);
    ok[k] = 1;
  }
  const idx = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    // the map plane seen as drawn (x right, y up) is the view from outside, below the pole: counter-clockwise = outward
    if (ok[a] && ok[b] && ok[c] && ok[d]) idx.push(a, b, c, b, d, c);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildMoonScene(plan, labels) {
  const T = three();
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(45, 1, 0.05, 2e6);
  scene.add(starField(1.5e6));
  scene.add(new T.AmbientLight(0x30343c, 0.35));
  const sun = new T.DirectionalLight(0xffffff, 3.0);
  scene.add(sun, sun.target);

  const moonGroup = new T.Group();
  scene.add(moonGroup);
  const grey = new T.MeshStandardMaterial({ color: 0x8c8c8c, roughness: 1, metalness: 0 });
  // sphere from the north pole down to 79.5° S; the cap fills the rest once the DEM is in
  const sphere = new T.Mesh(new T.SphereGeometry(R_MOON, 160, 90, 0, Math.PI * 2, 0, 169.5 * RAD), grey);
  const capFill = new T.Mesh(new T.SphereGeometry(R_MOON - 0.2, 64, 8, 0, Math.PI * 2, 169 * RAD, 11 * RAD), grey);
  moonGroup.add(sphere, capFill);
  let cap = null;
  function setDem(dem) {
    if (cap || !dem) return;
    cap = new T.Mesh(polarCapGeometry(dem), new T.MeshStandardMaterial({ color: 0x8f8f8f, roughness: 1, metalness: 0 }));
    moonGroup.add(cap);
    capFill.visible = false;
  }
  // landing site marker (Moon-fixed)
  const r0 = R_MOON + plan.siteHeightKm;
  const siteP = v3(scale(plan.siteFixed, r0 + 0.3));
  const siteMark = new T.Mesh(new T.SphereGeometry(1, 12, 8), new T.MeshBasicMaterial({ color: 0xf2b33d }));
  siteMark.position.copy(siteP);
  moonGroup.add(siteMark);

  const t = plan.times;
  const pts = (t0, t1, n) => { const out = []; for (let i = 0; i <= n; i++) out.push(v3(plan.stateAt(t0 + ((t1 - t0) * i) / n).pos)); return out; };
  const approach = makeLine(pts(t.soiMs, t.loiMs, 400), { color: 0xffffff, opacity: 0.85 });
  const llo = makeLine(plan.tracks.llo.map((p) => v3(p)), { color: 0xffffff, opacity: 0.55 });
  const dOrbit = makeLine(plan.tracks.descentOrbit.map((p) => v3(p)), { color: 0xffffff, opacity: 0.9 });
  const pd = makeLine(plan.tracks.poweredDescent.map((p) => v3(p)), { color: 0xf2b33d, opacity: 1 });
  scene.add(approach, llo, dOrbit, pd);

  const earth = new T.Mesh(new T.SphereGeometry(R_EARTH, 48, 24), new T.MeshStandardMaterial({ color: 0x3a6fb0, roughness: 0.8, emissive: 0x0a1830 }));
  scene.add(earth);
  // the lander model (metres) in this km scene: real size close up, enlarged (and said so) when far
  const lander = buildLanderModel();
  const craft = lander.group;
  scene.add(craft);
  const qTarget = new T.Quaternion(), basis = new T.Matrix4();
  let attInit = false;
  const branchGroup = new T.Group();
  scene.add(branchGroup);

  const moonOcc = { centre: () => new T.Vector3(0, 0, 0), radius: R_MOON };
  labels.add('Earth', 'body earth', () => earth.position);
  labels.add(plan.site.name, 'site', () => siteMark.getWorldPosition(new T.Vector3()), moonOcc);
  labels.add('LOI', 'event', () => v3(plan.stateAt(t.loiMs).pos), moonOcc);
  labels.add('DOI', 'event', () => v3(plan.stateAt(t.doiMs).pos), moonOcc);
  labels.add('PDI', 'event', () => v3(plan.stateAt(t.pdiMs).pos), moonOcc);
  const craftLbl = labels.add('Lander', 'craft', () => craft.position, moonOcc);

  const controls = createControls(camera, { radius: 7000, theta: 0.5, phi: 2.2, minRadius: 0.5 });

  function update(st, { dt = 1 / 60, att = null } = {}) {
    moonGroup.rotation.y = (MOON_RATE * (st.tMs - plan.epochMs)) / 1000;
    sun.position.copy(v3(st.sunDir, 1e5));
    if (st.earth) earth.position.copy(v3(st.earth));
    const p = v3(st.pos);
    craft.position.copy(p);
    const camD = camera.position.distanceTo(p);
    const ds = drawScale(camD, 0.001, 0.05);
    craft.scale.setScalar(ds.s);
    const lbl = `Lander${sizeNote(ds.times) ? ` · ${sizeNote(ds.times)}` : ''}`;
    if (craftLbl.el.textContent !== lbl) craftLbl.el.textContent = lbl;
    if (att) {
      basis.makeBasis(v3(att.axes.x), v3(att.axes.y), v3(att.axes.z));
      qTarget.setFromRotationMatrix(basis);
      if (!attInit) { craft.quaternion.copy(qTarget); attInit = true; } else craft.quaternion.slerp(qTarget, 1 - Math.exp(-dt / 0.35));
      lander.articulate({ sunBody: att.sunBody, earthBody: att.earthBody, throttle: att.throttle, stageAttached: att.stage, stageFiring: att.stageFiring });
    }
    siteMark.scale.setScalar(Math.max(0.05, camera.position.distanceTo(siteMark.getWorldPosition(new T.Vector3())) * 0.004));
    const r = norm(st.pos);
    const out = p.clone().normalize();
    if (st.phase === 'approach-moon' || st.phase === 'coast') {
      controls.followView(new T.Vector3(0, 0, 0), Math.max(9000, r * 1.4), out.clone().add(new T.Vector3(0, -0.4, 0)), { tau: 0.2, dt, key: 'approach' });
    } else if (st.phase === 'braking' && activeBranch) {
      // side view across the descent plane, so a branch that climbs away (abort) separates from the nominal path
      const nrm = v3(plan.descentFrame.h2);
      if (nrm.dot(camera.position.clone().sub(p)) < 0) nrm.multiplyScalar(-1);
      controls.followView(p, 900, nrm.multiplyScalar(0.9).add(out.clone().multiplyScalar(0.35)), { tau: 0.27, dt, key: 'craft' });
    } else if (st.phase === 'braking') {
      const back = v3(unit(st.vel)).multiplyScalar(-1);
      controls.followView(p, 420, out.clone().multiplyScalar(0.9).add(back.multiplyScalar(0.6)), { tau: 0.27, dt, key: 'craft' });
    } else if (st.scene === 'surface') {
      controls.followView(p, 60, out, { tau: 0.27, dt, key: 'craft' });
    } else {
      // off the orbit plane (so the ring reads as an ellipse) and from the south, with the lander on the near side
      const nrm = v3(plan.llo.normal);
      if (nrm.dot(camera.position) < 0) nrm.multiplyScalar(-1);
      controls.followView(new T.Vector3(0, 0, 0), 7600, out.clone().multiplyScalar(0.55).add(nrm.multiplyScalar(0.7)).add(new T.Vector3(0, -0.6, 0)), { tau: 0.4, dt, key: 'orbit' });
    }
  }
  // contingency branches drawn as dashed alternatives (MCI km point lists)
  let activeBranch = null, branchLbl = null;
  function setBranches(list, activeId) {
    activeBranch = list.find((b) => b.id === activeId && b.moonTrack?.length) ?? null;
    branchGroup.clear();
    if (branchLbl) { labels.remove(branchLbl); branchLbl = null; }
    for (const b of list) {
      if (!b.moonTrack?.length) continue;
      const on = b.id === activeId;
      // the selected branch solid red; the others faint dashed grey
      branchGroup.add(makeLine(b.moonTrack.map((q) => v3(q)), on ? { color: 0xff5a5f } : { color: 0x9a9a9a, opacity: 0.4, dashed: true, dash: 10, gap: 10 }));
    }
    if (activeBranch) {
      const end = v3(activeBranch.moonTrack[activeBranch.moonTrack.length - 1]);
      branchLbl = labels.add(`${activeBranch.decision.action.replace(/-/g, ' ')}: ${activeBranch.title}`, 'branch', () => end, moonOcc);
    }
  }
  return { scene, camera, controls, update, setDem, setBranches, name: 'moon' };
}
