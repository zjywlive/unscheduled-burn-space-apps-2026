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
// the terrain to the planned touchdown height). Per vertex it also carries the DEM height relative to the landing
// site (aElev, m; without the curvature drop, so contours follow the map heights) and the slope (aSlope, deg).
// → { geometry, slope, elev, axis, N, siteHeightM, elevRange (2nd–98th percentile within ±coreM of the site, so a
//   deep crater at the edge does not wash out the colours near the target) }
export function terrainGeometry(siteF, siteRadiusKm, sample, { halfM = PATCH_HALF_M, n = 320, fine = null, offsetM = 0, coreM = null } = {}) {
  const T = three();
  let east = unit(cross([0, 0, 1], siteF));
  if (norm(east) < 1e-9) east = [0, 1, 0];
  const north = cross(siteF, east);
  const axis = gradedAxis(halfM, { fine, n });
  const N = axis.length;
  const pos = new Float32Array(N * N * 3), up = new Float32Array(N * N), elev = new Float32Array(N * N);
  const R = R_MOON, siteH = (siteRadiusKm - R) * 1000;
  const base = scale(siteF, siteRadiusKm);
  const core = coreM ?? 1500;
  const near = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const e = axis[i], nn = axis[N - 1 - j];
    const d = unit(add(add(base, scale(east, e / 1000)), scale(north, nn / 1000)));
    const lat = Math.asin(d[2]) / RAD, lon = Math.atan2(d[1], d[0]) / RAD;
    const [x, y] = toXY(lat, lon);
    let h = sample(x, y);
    h = Number.isFinite(h) ? h + offsetM : siteH;
    const p = enuAt(siteF, siteRadiusKm, scale(d, R + h / 1000));
    const k = j * N + i;
    pos[k * 3] = p[0]; pos[k * 3 + 1] = p[2]; pos[k * 3 + 2] = -p[1];
    up[k] = p[2];
    elev[k] = h - siteH;
    if (Math.abs(e) <= core && Math.abs(nn) <= core) near.push(elev[k]);
  }
  // slope per vertex from the grid neighbours (central differences on the local up coordinate, real spacing)
  const slope = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    const il = Math.max(0, i - 1), ir = Math.min(N - 1, i + 1), jt = Math.max(0, j - 1), jb = Math.min(N - 1, j + 1);
    const gx = (up[j * N + ir] - up[j * N + il]) / (axis[ir] - axis[il]);
    const gy = (up[jt * N + i] - up[jb * N + i]) / (axis[N - 1 - jt] - axis[N - 1 - jb]);
    const s = Math.atan(Math.hypot(gx, gy)) / RAD;
    slope[k] = s;
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
  geo.setAttribute('aElev', new T.BufferAttribute(elev, 1));
  geo.setAttribute('aSlope', new T.BufferAttribute(slope, 1));
  geo.setIndex(new T.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  const mid = (N - 1) / 2;
  const sorted = Float32Array.from(near).sort();
  const pct = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] : 0);
  return { geometry: geo, slope, elev, axis, N, siteHeightM: up[mid * N + mid], elevRange: { min: pct(0.02), max: pct(0.98) } };
}

// Contour interval for a ground scale (metres per pixel): about one line per 14 px on a 20° slope, rounded to
// 1, 2, 5 × 10ⁿ m, at least 1 m (as the globe does).
export function contourInterval(mPerPx) {
  const want = Math.max(1, mPerPx * 14 * 0.36), p = Math.pow(10, Math.floor(Math.log10(want)));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= want - 1e-9) ?? 10 * p;
}
// Scale bar: the longest 1, 2, 5 × 10ⁿ m length that fits in maxPx. → { m, px, label }
export function scaleBar(mPerPx, maxPx = 110) {
  const want = mPerPx * maxPx, p = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, want))));
  const m = [5, 2, 1].map((k) => k * p).find((v) => v <= want) ?? p;
  return { m, px: m / mPerPx, label: m >= 1000 ? `${m / 1000} km` : `${m} m` };
}

// Terrain material: lit like the rest of the scene; colour by mode (0 plain, 1 height relative to the site,
// 2 slope with everything over the lander's limit in red) and contour lines from the DEM height of each pixel,
// every uInterval metres, every fifth stronger (fwidth-based, the same approach as the globe).
export function terrainMaterial(uniforms) {
  const T = three();
  const m = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aElev;\nattribute float aSlope;\nvarying float vElev;\nvarying float vSlope;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvElev = aElev; vSlope = aSlope;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vElev; varying float vSlope;
uniform float uMode, uSlopeLimit, uHmin, uHmax, uContours, uInterval; uniform vec3 uLine;
// colours are given as linear values (as the vertex colours were), brighter than sRGB-converted ones
vec3 lsnLin(vec3 c) { return c; }
vec3 lsnBase = vec3(0.0);
vec3 lsnRamp(float t, vec3 a, vec3 b, vec3 c, vec3 d, vec3 e) {
  t = clamp(t, 0.0, 1.0) * 4.0;
  return t < 1.0 ? mix(a, b, t) : t < 2.0 ? mix(b, c, t - 1.0) : t < 3.0 ? mix(c, d, t - 2.0) : mix(d, e, t - 3.0);
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  if (uMode > 1.5) {
    float t = vSlope / max(1.0, uSlopeLimit);
    vec3 c = t < 0.6 ? mix(vec3(0.37, 0.50, 0.39), vec3(0.79, 0.71, 0.35), t / 0.6) : mix(vec3(0.79, 0.71, 0.35), vec3(0.88, 0.54, 0.24), (t - 0.6) / 0.4);
    diffuseColor.rgb = lsnLin(t > 1.0 ? vec3(0.90, 0.28, 0.30) : c);
  } else if (uMode > 0.5) {
    diffuseColor.rgb = lsnLin(lsnRamp((vElev - uHmin) / max(1.0, uHmax - uHmin), vec3(0.14, 0.20, 0.29), vec3(0.24, 0.43, 0.48), vec3(0.50, 0.60, 0.42), vec3(0.78, 0.69, 0.48), vec3(0.94, 0.91, 0.84)));
  } else {
    diffuseColor.rgb = lsnLin(vec3(0.62, 0.62, 0.61));
  }
  lsnBase = diffuseColor.rgb;`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
  // map colours stay readable in the long polar shadows: part of the colour unlit
  if (uMode > 0.5) gl_FragColor.rgb = mix(gl_FragColor.rgb, lsnBase * 0.8, 0.35);
  if (uContours > 0.5) {
    float q = vElev / uInterval, w = fwidth(q);
    float d = abs(fract(q + 0.5) - 0.5) / max(w, 1e-5);
    float major = abs(fract(q / 5.0 + 0.5) - 0.5) * 5.0 / max(w, 1e-5);
    float line = (1.0 - smoothstep(0.3, 1.1, d)) * 0.45 + (1.0 - smoothstep(0.6, 1.8, major)) * 0.45;
    gl_FragColor.rgb = mix(gl_FragColor.rgb, uLine, clamp(line, 0.0, 0.85) * step(w, 0.45));
  }`);
  };
  return m;
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
  // terrain look: colour mode (plain / height / slope), contour lines whose interval follows the zoom
  const style = { mode: 'plain', contours: true };
  const tU = {
    uMode: { value: 0 }, uSlopeLimit: { value: plan.vehicle.touchdown.maxSlopeDeg }, uHmin: { value: -50 }, uHmax: { value: 50 },
    uContours: { value: 1 }, uInterval: { value: 10 }, uLine: { value: new T.Color(1.0, 0.86, 0.45) },
  };
  const terrainMat = terrainMaterial(tU);
  function setStyle({ mode = style.mode, contours = style.contours } = {}) {
    style.mode = mode; style.contours = !!contours;
    tU.uMode.value = mode === 'slope' ? 2 : mode === 'height' ? 1 : 0;
    tU.uContours.value = style.contours ? 1 : 0;
    // warm lines on the plain grey, dark lines over the colour ramps
    if (mode === 'plain') tU.uLine.value.setRGB(1.0, 0.86, 0.45); else tU.uLine.value.setRGB(0.04, 0.04, 0.05);
  }
  function setTerrain(sample, { fine = null, resAt = null } = {}) {
    if (terrain) { scene.remove(terrain); terrain.geometry.dispose(); }
    groundSample = sample; groundRes = resAt;
    const [sx, sy] = toXY(plan.site.latDeg, plan.site.lonDeg);
    const hSite = sample(sx, sy);
    offsetM = Number.isFinite(hSite) ? plan.siteHeightKm * 1000 - hSite : 0;
    terrainInfo = terrainGeometry(plan.siteFixed, siteRadiusKm, sample, { fine, offsetM });
    terrainInfo.offsetM = offsetM;
    tU.uHmin.value = terrainInfo.elevRange.min; tU.uHmax.value = terrainInfo.elevRange.max;
    terrain = new T.Mesh(terrainInfo.geometry, terrainMat);
    terrain.castShadow = true;
    terrain.receiveShadow = true;
    scene.add(terrain);
    placeholder.visible = false;
    drapeRing();
  }
  // a point on the drawn terrain at local east/north metres (the same construction as the mesh vertices)
  function groundPoint(eM, nM, liftM = 0) {
    const d = unit(add(add(scale(plan.siteFixed, siteRadiusKm), scale(east0, eM / 1000)), scale(north0, nM / 1000)));
    let h = groundSample ? groundSample(...toXY(Math.asin(d[2]) / RAD, Math.atan2(d[1], d[0]) / RAD)) : NaN;
    h = Number.isFinite(h) ? h + offsetM : plan.siteHeightKm * 1000;
    return enu3(enuAt(plan.siteFixed, siteRadiusKm, scale(d, R_MOON + (h + liftM) / 1000)));
  }

  // target ring (divert reach, assumed 150 m), draped on the terrain as a ribbon once the DEM is in
  const ringR = 150;
  const ringMat = new T.MeshBasicMaterial({ color: 0xf2b33d, transparent: true, opacity: 0.85, side: T.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const ring = new T.Mesh(new T.RingGeometry(ringR - 2, ringR + 2, 128).rotateX(-Math.PI / 2).translate(0, 1, 0), ringMat);
  function drapeRing() {
    const n = 160, pos = new Float32Array((n + 1) * 2 * 3), idx = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      for (const [k, r] of [[0, ringR - 1], [1, ringR + 1]]) {
        const p = groundPoint(r * Math.sin(a), r * Math.cos(a), 0.4);
        pos.set([p.x, p.y, p.z], (i * 2 + k) * 3);
      }
      if (i < n) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setIndex(idx);
    ring.geometry.dispose();
    ring.geometry = g;
  }
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
  // phases along the simulated track
  const evAt = (name) => { const e = plan.descent.events.find((x) => x.name === name); return e ? enu3(toEnu(sampleAt(e.tS).r)) : null; };
  labels.add('High gate · approach, pitch-over', 'event', () => evAt('high-gate'));
  labels.add('Low gate · terminal descent', 'event', () => evAt('low-gate'));
  const contactLbl = labels.add('Contact · engine off', 'craft', () => (contactLbl.el.style.opacity !== '0' && lander.visible ? lander.position.clone().setY(lander.position.y + 6 * lander.scale.y) : null));

  // plume–surface cue (illustrative, not a dust model): a sheet of dust blown out under the engine below ~25 m,
  // and an expanding ring at contact
  const DUST_N = 520;
  const dustPos = new Float32Array(DUST_N * 3), dustSeed = new Float32Array(DUST_N * 3);
  for (let i = 0; i < DUST_N; i++) dustSeed.set([Math.random() * Math.PI * 2, 6 + Math.random() * 16, Math.random()], i * 3);
  const dustGeo = new T.BufferGeometry();
  dustGeo.setAttribute('position', new T.BufferAttribute(dustPos, 3));
  // soft round sprite (a radial gradient) so the grains read as dust, not squares
  let dustMap = null;
  if (typeof document !== 'undefined') {
    const cv = document.createElement('canvas'); cv.width = cv.height = 32;
    const cx = cv.getContext('2d'), gr = cx.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = gr; cx.fillRect(0, 0, 32, 32);
    dustMap = new T.CanvasTexture(cv);
  }
  const dust = new T.Points(dustGeo, new T.PointsMaterial({ color: 0xd8d1c4, size: 0.32, map: dustMap, transparent: true, opacity: 0, depthWrite: false }));
  dust.frustumCulled = false;
  const contactRing = new T.Mesh(new T.RingGeometry(0.95, 1, 96).rotateX(-Math.PI / 2), new T.MeshBasicMaterial({ color: 0xe8e2d6, transparent: true, opacity: 0, side: T.DoubleSide, depthWrite: false, depthTest: false }));
  scene.add(dust, contactRing);
  let dustClock = 0;
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
    // contour interval and scale from the ground scale at the camera target
    mPerPx = (2 * camera.position.distanceTo(controls.state.target) * Math.tan((camera.fov * RAD) / 2)) / Math.max(1, (typeof innerHeight === 'number' ? innerHeight : 800));
    tU.uInterval.value = contourInterval(mPerPx);
    // dust sheet under the engine near the ground, and the contact ring
    dustClock += dt;
    const g = !far && st.descent ? groundAt(st) : null;
    const agl = g ? g.aglM : (st.phase === 'landed' ? 0 : Infinity);
    const sinceTd = (st.tMs - plan.times.landingMs) / 1000;
    // after contact the engine is off: the dust settles over about two seconds (no air, it falls ballistically)
    const th = st.phase === 'landed' ? Math.max(0, 0.4 * (1 - sinceTd / 2)) : (st.descent?.throttle ?? 0);
    const k = Math.max(0, Math.min(1, (25 - agl) / 20)) * Math.min(1, th * 2.5);
    dust.material.opacity = 0.6 * k;
    dust.visible = k > 0.01;
    if (dust.visible) {
      const c = groundPoint(e[0], e[1], 0.3);
      for (let i = 0; i < DUST_N; i++) {
        const a = dustSeed[i * 3], v = dustSeed[i * 3 + 1], ph = (dustSeed[i * 3 + 2] + dustClock * 0.9) % 1;
        // blown out from under the bell along the ground, thinning with distance (grains spend less time far out)
        const r = 1.2 + v * Math.pow(ph, 1.6) * 1.4;
        dustPos[i * 3] = c.x + Math.sin(a) * r; dustPos[i * 3 + 1] = c.y + 0.05 + ph * (1 - ph) * 1.2 * k; dustPos[i * 3 + 2] = c.z + Math.cos(a) * r;
      }
      dustGeo.attributes.position.needsUpdate = true;
    }
    const contact = st.phase === 'landed' && sinceTd >= 0 && sinceTd < 6;
    contactRing.visible = contact && lander.visible;
    if (contactRing.visible) {
      const c = groundPoint(e[0], e[1], 0.25);
      contactRing.position.copy(c);
      contactRing.scale.setScalar(3 + sinceTd * 5);
      contactRing.material.opacity = 0.55 * (1 - sinceTd / 6);
    }
    contactLbl.el.style.opacity = contact ? String(Math.min(1, 2 * (1 - sinceTd / 6))) : '0';
  }
  let mPerPx = 1;
  // what the terrain key shows: interval, scale bar, height range, the finest resolution in view
  function terrainKey() {
    const iv = tU.uInterval.value;
    return { style: { ...style }, intervalM: iv, majorM: iv * 5, scale: scaleBar(mPerPx), elevRange: terrainInfo?.elevRange ?? null, slopeLimitDeg: tU.uSlopeLimit.value, ready: !!terrainInfo };
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
  return { scene, camera, controls, update, setTerrain, setStyle, terrainKey, setBranches, setSpot, toEnu, groundAt, name: 'surface', terrainInfo: () => terrainInfo };
}
