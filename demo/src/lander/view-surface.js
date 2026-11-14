// Scene 3: final descent onto real south-pole terrain. Local east-north-up at the site in metres
// (three.js x = east, y = up, z = −north). Terrain from the finest LOLA DEM loaded around the site, curvature
// included; Sun from the ephemeris at the current time, so the low polar Sun throws long shadows.
import { three, enu3, makeLine, setLinePoints, starField, createControls } from './view-common.js';
import { enuAt } from './mission.js';
import { R_MOON, MOON_RATE, RAD } from './constants.js';
import { toXY } from '../terrain.js';
import { add, scale, cross, unit, norm, rotZ, dot } from './vec.js';
import { buildLanderModel, drawScale, sizeNote } from './model.js';
import { unitFromLonLat } from '../geometry.js';

export const PATCH_HALF_M = 8000;

// Grid lines along one axis of the descent mesh, ascending from −halfM to +halfM and symmetric about 0: steps
// of fine.stepM out to ±fine.halfM, then steps growing by `growth` up to coarseM, then coarseM to the edge. Without
// fine, n even steps. One mesh with graded spacing has no seams between resolutions.
export function gradedAxis(halfM, { fine = null, coarseM = 80, growth = 1.1, n = 320 } = {}) {
  if (!fine || !(fine.stepM > 0) || !(fine.halfM > 0)) return Array.from({ length: n + 1 }, (_, i) => -halfM + (2 * halfM * i) / n);
  const side = [];
  let p = 0, step = fine.stepM;
  while (p + step <= Math.min(fine.halfM, halfM) + 1e-6) { p += step; side.push(p); }
  while (p < halfM - 1e-6) {
    step = Math.min(coarseM, step * growth);
    p = Math.min(halfM, p + step);
    if (halfM - p < 0.3 * step) p = halfM;   // no sliver cell at the edge
    side.push(p);
  }
  return [...side.slice().reverse().map((v) => -v), 0, ...side];
}

// Terrain grid around the site. sample(xKm, yKm) → metres | NaN on the polar map plane. fine: { stepM, halfM }
// for a finer core around the site (terrain-local.fineCore); offsetM is added to every height (the scene levels
// the terrain to the planned touchdown height). → { geometry, slope (deg per vertex), axis, N, siteHeightM }
export function terrainGeometry(siteF, siteRadiusKm, sample, { halfM = PATCH_HALF_M, n = 320, fine = null, slopeLimitDeg = 10, overlay = false, offsetM = 0 } = {}) {
  const T = three();
  let east = unit(cross([0, 0, 1], siteF));
  if (norm(east) < 1e-9) east = [0, 1, 0];
  const north = cross(siteF, east);
  const axis = gradedAxis(halfM, { fine, n });
  const N = axis.length;
  const pos = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3), up = new Float32Array(N * N);
  const R = R_MOON;
  const base = scale(siteF, siteRadiusKm);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const e = axis[i], nn = axis[N - 1 - j];
    const d = unit(add(add(base, scale(east, e / 1000)), scale(north, nn / 1000)));
    const lat = Math.asin(d[2]) / RAD, lon = Math.atan2(d[1], d[0]) / RAD;
    const [x, y] = toXY(lat, lon);
    let h = sample(x, y);
    h = Number.isFinite(h) ? h + offsetM : (siteRadiusKm - R) * 1000;
    const p = enuAt(siteF, siteRadiusKm, scale(d, R + h / 1000));
    const k = j * N + i;
    pos[k * 3] = p[0]; pos[k * 3 + 1] = p[2]; pos[k * 3 + 2] = -p[1];
    up[k] = p[2];
  }
  // slope per vertex from the grid neighbours (central differences on the local up coordinate, real spacing)
  const slope = new Float32Array(N * N);
  const g = 0.62;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const il = Math.max(0, i - 1), ir = Math.min(N - 1, i + 1), jt = Math.max(0, j - 1), jb = Math.min(N - 1, j + 1);
    const gx = (up[j * N + ir] - up[j * N + il]) / (axis[ir] - axis[il]);
    const gy = (up[jt * N + i] - up[jb * N + i]) / (axis[N - 1 - jt] - axis[N - 1 - jb]);
    const s = Math.atan(Math.hypot(gx, gy)) / RAD;
    slope[k] = s;
    const bad = overlay && s > slopeLimitDeg;
    col[k * 3] = bad ? 0.85 : g; col[k * 3 + 1] = bad ? 0.32 : g; col[k * 3 + 2] = bad ? 0.3 : g * 0.98;
  }
  const cells = (N - 1) * (N - 1);
  const idx = N * N > 65535 ? new Uint32Array(cells * 6) : new Uint16Array(cells * 6);
  let q = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
  }
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(pos, 3));
  geo.setAttribute('color', new T.BufferAttribute(col, 3));
  geo.setIndex(new T.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  const mid = (N - 1) / 2;
  return { geometry: geo, slope, axis, N, siteHeightM: up[mid * N + mid] };
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
  let terrainInfo = null, offsetM = 0, groundSample = null, groundRes = null;
  // The plan's touchdown height comes from the 480 m DEM; the fine terrain at the site differs by metres to tens
  // of metres. The whole patch is shifted by that difference so the lander touches its own ground (the shape is
  // unchanged; only the local reference height moves).
  function setTerrain(sample, { overlay = false, fine = null, resAt = null } = {}) {
    if (terrain) { scene.remove(terrain); terrain.geometry.dispose(); }
    groundSample = sample; groundRes = resAt;
    const [sx, sy] = toXY(plan.site.latDeg, plan.site.lonDeg);
    const hSite = sample(sx, sy);
    offsetM = Number.isFinite(hSite) ? plan.siteHeightKm * 1000 - hSite : 0;
    terrainInfo = terrainGeometry(plan.siteFixed, siteRadiusKm, sample, { slopeLimitDeg: plan.vehicle.touchdown.maxSlopeDeg, overlay, fine, offsetM });
    terrainInfo.offsetM = offsetM;
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

  // the lander model (metres, real size; enlarged with a note only when the camera is far)
  const model = buildLanderModel();
  const lander = model.group;
  let shadowsOn = true;
  // Moon-centred inertial direction → this scene (ENU at the site with the landing-time rotation, as toEnu)
  let east0 = unit(cross([0, 0, 1], plan.siteFixed));
  if (norm(east0) < 1e-9) east0 = [0, 1, 0];
  const north0 = cross(plan.siteFixed, east0);
  const mciDir3 = (d) => { const f = rotZ(d, -thL); return new T.Vector3(dot(f, east0), dot(f, plan.siteFixed), -dot(f, north0)); };
  const qAtt = new T.Quaternion(), basis = new T.Matrix4();
  let attInit = false;
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
  const craftLbl = labels.add('Lander', 'craft', () => (lander.visible ? lander.position.clone().setY(lander.position.y + 4 * lander.scale.y) : null));

  function sampleAt(tS) {
    const s = plan.descent.samples;
    let best = s[0];
    for (const x of s) { if (x.tS <= tS) best = x; else break; }
    return best;
  }

  const controls = createControls(camera, { radius: 900, theta: 0.8, phi: 1.15, minRadius: 3, maxRadius: 3e5 });
  const heading = new T.Vector3(0.6, 0, 0.8);
  const dirTo = (az, el, dist) => enu3([Math.sin(az * RAD) * Math.cos(el * RAD) * dist, Math.cos(az * RAD) * Math.cos(el * RAD) * dist, Math.sin(el * RAD) * dist]);

  function update(st, { dt = 0.016, att = null } = {}) {
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
    // the 40 m site pin would run through the lander on the way down: hide it once the lander is close
    pin.visible = far || Math.hypot(e[0], e[1]) > 60 || e[2] > 80;
    farLbl.el.textContent = far ? `Lander is ${st.descent ? Math.round(Math.hypot(e[0], e[1]) / 1000) + ' km away' : 'still in orbit'}` : '';
    if (!far) {
      lander.position.copy(enu3(e));
      // attitude as in the other views (body along the thrust, upright after touchdown), array on the Sun, dish on Earth
      if (att) {
        basis.makeBasis(mciDir3(att.axes.x), mciDir3(att.axes.y), mciDir3(att.axes.z));
        qAtt.setFromRotationMatrix(basis);
        if (!attInit) { lander.quaternion.copy(qAtt); attInit = true; } else lander.quaternion.slerp(qAtt, 1 - Math.exp(-dt / 0.35));
        model.articulate({ sunBody: att.sunBody, earthBody: att.earthBody, throttle: att.throttle, stageAttached: false });
      }
      const ds = drawScale(camera.position.distanceTo(lander.position), 1, 0.012);
      lander.scale.setScalar(ds.s);
      const big = ds.times >= 1.5;
      if (big === shadowsOn) { shadowsOn = !big; lander.traverse((o) => { if (o.isMesh) o.castShadow = shadowsOn; }); }
      const lbl = big ? `Lander · ${sizeNote(ds.times)}` : 'Lander';
      if (craftLbl.el.textContent !== lbl) craftLbl.el.textContent = lbl;
      const alt = Math.max(0, e[2]);
      const v = st.descent.v;
      const vh = toEnu(add(st.descent.r, scale(v, 1)));
      // chase from behind the horizontal motion; in the vertical terminal descent the horizontal speed is
      // millimetres per second and its direction is noise, so keep the last heading below 1 m/s
      const hv = enu3([e[0] - vh[0], e[1] - vh[1], 0]);
      if (hv.lengthSq() > 1) heading.copy(hv).normalize();
      const back = heading.clone();
      const radius = Math.min(260, 22 + alt * 0.09);
      controls.followView(lander.position.clone(), radius, back.multiplyScalar(0.85).add(new T.Vector3(0, 0.55, 0)), { tau: 0.32, dt, key: 'craft' });
    } else {
      controls.followView(new T.Vector3(0, 0, 0), 9000, new T.Vector3(0.5, 0.6, 0.6), { tau: 0.32, dt, key: 'site' });
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
  // the flattest nearby spot from landing.flattestNear (green pin), or null to hide it
  const spotPin = new T.Mesh(new T.CylinderGeometry(0.4, 0.4, 30, 8), new T.MeshBasicMaterial({ color: 0x7fd18b }));
  spotPin.visible = false;
  scene.add(spotPin);
  let spotLbl = null;
  function setSpot(spot) {
    if (spotLbl) { labels.remove(spotLbl); spotLbl = null; }
    spotPin.visible = !!spot;
    if (!spot) return;
    const p = enu3(enuAt(plan.siteFixed, siteRadiusKm, scale(unitFromLonLat(spot.lonDeg, spot.latDeg), R_MOON + ((spot.heightM ?? 0) + offsetM) / 1000)));
    spotPin.position.copy(p).setY(p.y + 15);
    spotLbl = labels.add(`${spot.ok ? 'Flat spot' : 'Flattest spot'} ${spot.slopeDeg.toFixed(1)}°, ${Math.round(spot.distM)} m`, 'spot', () => spotPin.position.clone().setY(spotPin.position.y + 18));
  }
  // height of the lander above the DEM directly below it (what a radar altimeter reads), during powered descent:
  // → { aglM, resM } | null
  function groundAt(st) {
    if (!groundSample || !st.descent || st.phase === 'landed' || st.phase === 'descent-coast') return null;
    const f = rotZ(plan.descentFrame.pdToMci(st.descent.r), -thL);   // Moon-fixed km (landing-time rotation, as toEnu)
    const u = unit(f);
    const lat = Math.asin(u[2]) / RAD, lon = Math.atan2(u[1], u[0]) / RAD;
    const [x, y] = toXY(lat, lon);
    const h = groundSample(x, y);
    if (!Number.isFinite(h)) return null;
    const res = groundRes?.(x, y);
    return { aglM: (norm(f) - R_MOON) * 1000 - (h + offsetM), resM: res ? res * 1000 : null };
  }
  return { scene, camera, controls, update, setTerrain, setBranches, setSpot, toEnu, groundAt, name: 'surface', terrainInfo: () => terrainInfo };
}
