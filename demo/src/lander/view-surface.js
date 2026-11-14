// Scene 3: final descent onto real south-pole terrain. Local east-north-up at the site in metres
// (three.js x = east, y = up, z = −north). Terrain from the finest LOLA DEM loaded around the site, curvature
// included; Sun from the ephemeris at the current time, so the low polar Sun throws long shadows.
import { three, enu3, makeLine, setLinePoints, starField, createControls } from './view-common.js';
import { enuAt } from './mission.js';
import { R_MOON, MOON_RATE, RAD } from './constants.js';
import { toXY } from '../terrain.js';
import { add, scale, cross, unit, norm, rotZ } from './vec.js';

export const PATCH_HALF_M = 8000;

// Terrain grid around the site. sample(xKm, yKm) → metres | NaN on the polar map plane.
// Returns { geometry, slope: Float32Array (deg per vertex), heightAt(eM, nM) }.
export function terrainGeometry(siteF, siteRadiusKm, sample, { halfM = PATCH_HALF_M, n = 320, slopeLimitDeg = 10, overlay = false } = {}) {
  const T = three();
  let east = unit(cross([0, 0, 1], siteF));
  if (norm(east) < 1e-9) east = [0, 1, 0];
  const north = cross(siteF, east);
  const N = n + 1, step = (2 * halfM) / n;
  const pos = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3), up = new Float32Array(N * N);
  const R = R_MOON;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const e = -halfM + i * step, nn = halfM - j * step;
    const d = unit(add(add(scale(siteF, siteRadiusKm), scale(east, e / 1000)), scale(north, nn / 1000)));
    const lat = Math.asin(d[2]) / RAD, lon = Math.atan2(d[1], d[0]) / RAD;
    const [x, y] = toXY(lat, lon);
    let h = sample(x, y);
    if (!Number.isFinite(h)) h = (siteRadiusKm - R) * 1000;
    const p = enuAt(siteF, siteRadiusKm, scale(d, R + h / 1000));
    const k = j * N + i;
    pos.set([p[0], p[2], -p[1]], k * 3);
    up[k] = p[2];
  }
  // slope per vertex from the grid neighbours (central differences on the local up coordinate)
  const slope = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const il = Math.max(0, i - 1), ir = Math.min(n, i + 1), jt = Math.max(0, j - 1), jb = Math.min(n, j + 1);
    const gx = (up[j * N + ir] - up[j * N + il]) / ((ir - il) * step);
    const gy = (up[jt * N + i] - up[jb * N + i]) / ((jb - jt) * step);
    const s = Math.atan(Math.hypot(gx, gy)) / RAD;
    slope[k] = s;
    const g = 0.62;
    const bad = overlay && s > slopeLimitDeg;
    col.set(bad ? [0.85, 0.32, 0.3] : [g, g, g * 0.98], k * 3);
  }
  const idx = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3));
  g.setAttribute('color', new T.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geometry: g, slope, step, N };
}

export function landerModel() {
  const T = three();
  const g = new T.Group();
  const foil = new T.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.6, roughness: 0.35 });
  const white = new T.MeshStandardMaterial({ color: 0xdedede, metalness: 0.1, roughness: 0.6 });
  const dark = new T.MeshStandardMaterial({ color: 0x222222, metalness: 0.4, roughness: 0.5 });
  const panelM = new T.MeshStandardMaterial({ color: 0x1b2a4a, metalness: 0.3, roughness: 0.3, emissive: 0x050a18 });
  const body = new T.Mesh(new T.CylinderGeometry(1.25, 1.25, 1.5, 8), foil);
  body.position.y = 1.55;
  const deck = new T.Mesh(new T.CylinderGeometry(1.1, 1.25, 0.25, 8), white);
  deck.position.y = 2.42;
  const bell = new T.Mesh(new T.CylinderGeometry(0.22, 0.5, 0.7, 16, 1, true), dark);
  bell.position.y = 0.55;
  const panel = new T.Mesh(new T.BoxGeometry(0.06, 1.3, 2.2), panelM);
  panel.position.set(1.45, 1.7, 0);
  const dish = new T.Mesh(new T.SphereGeometry(0.35, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3), white);
  dish.position.set(-0.5, 2.7, 0.4);
  g.add(body, deck, bell, panel, dish);
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    const leg = new T.Mesh(new T.CylinderGeometry(0.06, 0.06, 2.0, 6), white);
    const fx = Math.cos(a) * 2.1, fz = Math.sin(a) * 2.1;
    leg.position.set(fx * 0.7, 0.75, fz * 0.7);
    leg.lookAt(fx, 0.05, fz);
    leg.rotateX(Math.PI / 2);
    const pad = new T.Mesh(new T.CylinderGeometry(0.28, 0.32, 0.08, 12), white);
    pad.position.set(fx, 0.04, fz);
    g.add(leg, pad);
  }
  const plume = new T.Mesh(new T.ConeGeometry(0.55, 1, 20, 1, true), new T.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.55, blending: T.AdditiveBlending, depthWrite: false }));
  plume.rotation.x = Math.PI;
  g.add(plume);
  return { group: g, plume };
}

// sky(tMs) → { sun: { azDeg, elDeg }, earth: { azDeg, elDeg } } at the site (landing.skyAt)
export function buildSurfaceScene(plan, labels, { sky } = {}) {
  const T = three();
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(50, 1, 0.5, 4e6);
  scene.add(starField(3e6, 2500, 11));
  const amb = new T.AmbientLight(0x5a6270, 0.55);   // fill so shadowed ground stays readable (real earthshine is weaker)
  scene.add(amb);
  const sun = new T.DirectionalLight(0xfff4e6, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -PATCH_HALF_M; sc.right = PATCH_HALF_M; sc.top = PATCH_HALF_M; sc.bottom = -PATCH_HALF_M; sc.near = 10; sc.far = 80000;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 6;
  scene.add(sun, sun.target);

  const siteRadiusKm = R_MOON + plan.siteHeightKm;
  const thL = (MOON_RATE * (plan.times.landingMs - plan.epochMs)) / 1000;
  // descent samples (PD frame, metres) → ENU metres at the site; all with the landing-time rotation (see mission.js)
  const toEnu = (pdR) => enuAt(plan.siteFixed, siteRadiusKm, rotZ(plan.descentFrame.pdToMci(pdR), -thL));
  const enuTrack = (samples, maxM = PATCH_HALF_M * 3) => samples.map((s) => toEnu(s.r)).filter((e) => Math.hypot(e[0], e[1]) < maxM).map((e) => enu3(e));
  const nominal = makeLine(enuTrack(plan.descent.samples), { color: 0xf2b33d, opacity: 1 });
  scene.add(nominal);

  let terrain = null;
  const placeholder = new T.Mesh(new T.CircleGeometry(PATCH_HALF_M, 64), new T.MeshStandardMaterial({ color: 0x555555, roughness: 1 }));
  placeholder.rotation.x = -Math.PI / 2;
  placeholder.receiveShadow = true;
  scene.add(placeholder);
  let terrainInfo = null;
  function setTerrain(sample, { overlay = false } = {}) {
    if (terrain) { scene.remove(terrain); terrain.geometry.dispose(); }
    terrainInfo = terrainGeometry(plan.siteFixed, siteRadiusKm, sample, { slopeLimitDeg: plan.vehicle.touchdown.maxSlopeDeg, overlay });
    terrain = new T.Mesh(terrainInfo.geometry, new T.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
    terrain.castShadow = true;
    terrain.receiveShadow = true;
    scene.add(terrain);
    placeholder.visible = false;
  }

  // target ring (divert reach) and site marker
  const ringR = 150;
  const ring = new T.Mesh(new T.RingGeometry(ringR - 3, ringR, 96), new T.MeshBasicMaterial({ color: 0xf2b33d, transparent: true, opacity: 0.7, side: T.DoubleSide, depthTest: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 1;
  const pin = new T.Mesh(new T.CylinderGeometry(0.4, 0.4, 40, 8), new T.MeshBasicMaterial({ color: 0xf2b33d }));
  pin.position.y = 20;
  scene.add(ring, pin);

  const { group: lander, plume } = landerModel();
  lander.traverse((o) => { if (o.isMesh && o !== plume) { o.castShadow = true; } });
  scene.add(lander);
  const earthDot = new T.Mesh(new T.SphereGeometry(1, 16, 8), new T.MeshBasicMaterial({ color: 0x4cb3f0 }));
  const sunDot = new T.Mesh(new T.SphereGeometry(1, 16, 8), new T.MeshBasicMaterial({ color: 0xffe6a8 }));
  scene.add(earthDot, sunDot);
  const branchGroup = new T.Group();
  scene.add(branchGroup);

  labels.add(plan.site.name, 'site', () => pin.position.clone().setY(42));
  labels.add('Earth', 'body earth', () => earthDot.visible ? earthDot.position : null);
  labels.add('Sun', 'body sun', () => sunDot.visible ? sunDot.position : null);
  labels.add('High gate', 'event', () => { const e = plan.descent.events.find((x) => x.name === 'high-gate'); return e ? enu3(toEnu(sampleAt(e.tS).r)) : null; });
  labels.add('Low gate', 'event', () => { const e = plan.descent.events.find((x) => x.name === 'low-gate'); return e ? enu3(toEnu(sampleAt(e.tS).r)) : null; });
  const farLbl = labels.add('', 'note', () => (farLbl.el.textContent ? new T.Vector3(0, 90, 0) : null));
  labels.add('Lander', 'craft', () => (lander.visible ? lander.position.clone().setY(lander.position.y + 4) : null));

  function sampleAt(tS) {
    const s = plan.descent.samples;
    let best = s[0];
    for (const x of s) { if (x.tS <= tS) best = x; else break; }
    return best;
  }

  const controls = createControls(camera, { radius: 900, theta: 0.8, phi: 1.15, minRadius: 3, maxRadius: 3e5 });
  const qTmp = new T.Quaternion(), yAxis = new T.Vector3(0, 1, 0);
  const dirTo = (az, el, dist) => enu3([Math.sin(az * RAD) * Math.cos(el * RAD) * dist, Math.cos(az * RAD) * Math.cos(el * RAD) * dist, Math.sin(el * RAD) * dist]);

  function update(st, { dt = 0.016 } = {}) {
    // Sun and Earth in the local sky at this instant
    const loc = st.local ?? sky?.(st.tMs);
    if (loc) {
      const sd = dirTo(loc.sun.azDeg ?? 0, loc.sun.elDeg, 1).normalize();
      sun.position.copy(sd.clone().multiplyScalar(40000));
      sun.target.position.set(0, 0, 0);
      sunDot.position.copy(sd.clone().multiplyScalar(2.5e6));
      sunDot.scale.setScalar(2.5e6 * 0.0047);
      sunDot.visible = loc.sun.elDeg > -1;
      earthDot.position.copy(dirTo(loc.earth.azDeg ?? 0, loc.earth.elDeg, 2.4e6));
      earthDot.scale.setScalar(2.4e6 * 0.0166);
      earthDot.visible = loc.earth.elDeg > -2;
    }
    let e = null;
    if (st.descent) e = toEnu(st.descent.r);
    const far = !e || Math.hypot(e[0], e[1]) > PATCH_HALF_M * 6;
    lander.visible = !far;
    farLbl.el.textContent = far ? `Lander is ${st.descent ? Math.round(Math.hypot(e[0], e[1]) / 1000) + ' km away' : 'still in orbit'}` : '';
    if (!far) {
      lander.position.copy(enu3(e));
      const th = st.descent.throttle;
      if (th > 0 && st.descent.thrustDir) {
        const d = toEnu(add(st.descent.r, scale(st.descent.thrustDir, 1000)));
        const dir = enu3([d[0] - e[0], d[1] - e[1], d[2] - e[2]]).normalize();
        qTmp.setFromUnitVectors(yAxis, dir);
        lander.quaternion.slerp(qTmp, Math.min(1, dt * 2.5));
      } else if (st.phase === 'landed') {
        lander.quaternion.slerp(new T.Quaternion(), 0.2);
      }
      plume.visible = th > 0.01;
      plume.scale.set(1, 2 + th * 9, 1);
      plume.position.y = -(1 + th * 4.5) + 0.2;
      const alt = Math.max(0, e[2]);
      const v = st.descent.v;
      const vh = toEnu(add(st.descent.r, scale(v, 1)));
      const back = enu3([e[0] - vh[0], e[1] - vh[1], 0]);
      if (back.lengthSq() < 1e-6) back.set(0.6, 0, 0.8);
      back.normalize();
      const radius = Math.min(260, 22 + alt * 0.09);
      controls.followView(lander.position.clone(), radius, back.multiplyScalar(0.85).add(new T.Vector3(0, 0.55, 0)), 0.05);
    } else {
      controls.followView(new T.Vector3(0, 0, 0), 9000, new T.Vector3(0.5, 0.6, 0.6), 0.05);
    }
  }
  let branchLbl = null;
  function setBranches(list, activeId) {
    branchGroup.clear();
    if (branchLbl) { labels.remove(branchLbl); branchLbl = null; }
    for (const b of list) {
      if (!b.surfaceSamples?.length) continue;
      const on = b.id === activeId;
      branchGroup.add(makeLine(enuTrack(b.surfaceSamples), on ? { color: 0xff5a5f } : { color: 0x9a9a9a, opacity: 0.5, dashed: true, dash: 12, gap: 12 }));
      if (on) {
        const last = enu3(toEnu(b.surfaceSamples[b.surfaceSamples.length - 1].r));
        branchLbl = labels.add(`${b.decision.action.replace(/-/g, ' ')}: ${b.title}`, 'branch', () => last.clone().setY(last.y + 30));
      }
      if (b.surfaceTarget && on) {
        const p = enu3(toEnu(b.surfaceTarget));
        const m = new T.Mesh(new T.CylinderGeometry(0.4, 0.4, 30, 8), new T.MeshBasicMaterial({ color: 0xe5484d }));
        m.position.copy(p).setY(p.y + 15);
        branchGroup.add(m);
      }
    }
  }
  return { scene, camera, controls, update, setTerrain, setBranches, toEnu, name: 'surface', terrainInfo: () => terrainInfo };
}
