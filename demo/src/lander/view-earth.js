// Scene 1: Earth–Moon transfer, geocentric and non-rotating (axes of the MCI frame), 1 unit = 1000 km, true scale.
import { three, v3, makeLine, starField, createControls } from './view-common.js';
import { sub, norm } from './vec.js';
import { R_EARTH, R_MOON } from './constants.js';
import { buildLanderModel, drawScale, sizeNote } from './model.js';

const K = 1 / 1000;
// The mission model starts in the parking orbit; the climb to it is not simulated. For the first ASCENT_S seconds
// after the timeline's start the scene draws an illustrative ascent instead: a pitch-over arc in the orbit plane
// from a ground point ASCENT_RANGE_RAD up-range to the craft's orbit position at the end of that time (so the
// drawn craft joins its simulated orbit with no jump). The ground point is not a real launch site: the Earth here
// is a plain sphere with no geography or rotation.
const ASCENT_S = 540, ASCENT_RANGE_RAD = (18 * Math.PI) / 180, ASCENT_N = 72;

export function buildEarthScene(plan, labels) {
  const T = three();
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(45, 1, 0.01, 5e4);
  scene.add(starField(2e4));
  scene.add(new T.AmbientLight(0x404858, 0.6));
  const sun = new T.DirectionalLight(0xffffff, 2.2);
  scene.add(sun, sun.target);

  const earth = new T.Mesh(new T.SphereGeometry(R_EARTH * K, 64, 32), new T.MeshStandardMaterial({ color: 0x3a6fb0, roughness: 0.8, metalness: 0, emissive: 0x0a1830 }));
  scene.add(earth);
  // thin atmosphere: a rim glow on a slightly larger back-face shell, brighter toward the Sun
  const atmo = new T.Mesh(new T.SphereGeometry(R_EARTH * K * 1.045, 64, 32), new T.ShaderMaterial({
    uniforms: { uSun: { value: new T.Vector3(1, 0, 0) } },
    vertexShader: 'varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'uniform vec3 uSun; varying vec3 vN; varying vec3 vW; void main(){ vec3 v = normalize(cameraPosition - vW); float rim = pow(clamp(1.0 + dot(v, vN), 0.0, 1.0), 2.2); float lit = 0.25 + 0.75 * smoothstep(-0.35, 0.5, dot(normalize(vN), uSun)); gl_FragColor = vec4(vec3(0.35, 0.62, 1.0) * rim * lit, rim * lit); }',
    side: T.BackSide, transparent: true, blending: T.AdditiveBlending, depthWrite: false,
  }));
  scene.add(atmo);
  const moon = new T.Mesh(new T.SphereGeometry(R_MOON * K, 48, 24), new T.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1 }));
  scene.add(moon);

  const t = plan.times;
  // geocentric samples of the spacecraft from launch to LOI, and of the Moon over the same span (+2 days)
  const geo = (ms) => { const s = plan.stateAt(ms); return v3(sub(s.pos, s.earth), K); };
  const moonAt = (ms) => { const e = plan.bodies.earthMci(ms); return e ? v3([-e[0], -e[1], -e[2]], K) : null; };
  const leoPts = [], trPts = [], moonPts = [];
  for (let i = 0; i <= 160; i++) leoPts.push(geo(t.launchMs + ((t.tliMs - t.launchMs) * i) / 160));
  for (let i = 0; i <= 700; i++) {
    const f = i / 700, ms = t.tliMs + (t.loiMs - t.tliMs) * (f * f * (3 - 2 * f) * 0.3 + f * 0.7);
    trPts.push(geo(ms));
  }
  for (let i = 0; i <= 400; i++) {
    const p = moonAt(t.launchMs - 2 * 86400e3 + ((t.landingMs - t.launchMs + 4 * 86400e3) * i) / 400);
    if (p) moonPts.push(p);
  }
  scene.add(makeLine(moonPts, { color: 0x6b6b6b, opacity: 0.55 }));
  const leoLine = makeLine(leoPts, { color: 0xffffff, opacity: 0.8 });
  const trLine = makeLine(trPts, { color: 0xffffff, opacity: 0.95 });
  scene.add(leoLine, trLine);
  // TLI point and SOI entry marks
  const dot = (p, c, r) => { const m = new T.Mesh(new T.SphereGeometry(r, 12, 8), new T.MeshBasicMaterial({ color: c })); m.position.copy(p); scene.add(m); return m; };
  dot(geo(t.tliMs), 0xffcf6b, 0.35);

  // illustrative ascent (see the note at the top): ground point, arc, exhaust trail
  const ascEndMs = t.launchMs + ASCENT_S * 1000;
  const pEnd = geo(ascEndMs), eEnd = pEnd.clone().normalize();
  const orbitN = pEnd.clone().cross(geo(ascEndMs + 60e3)).normalize();
  const rE = R_EARTH * K, hOrbit = pEnd.length() - rE;
  const ascentAt = (f) => {
    const c = Math.min(1, Math.max(0, f));
    return eEnd.clone().applyAxisAngle(orbitN, -ASCENT_RANGE_RAD * (1 - c * c)).multiplyScalar(rE + hOrbit * (1 - (1 - c) * (1 - c)));
  };
  const sitePos = ascentAt(0);
  const ascPts = [];
  for (let i = 0; i <= ASCENT_N; i++) ascPts.push(ascentAt(i / ASCENT_N));
  const ascLine = makeLine(ascPts, { color: 0xffb45a, opacity: 0.35 });
  const ascTrail = makeLine(ascPts, { color: 0xffd9a0, opacity: 0.99 });
  scene.add(ascLine, ascTrail);
  const siteDot = new T.Mesh(new T.SphereGeometry(0.06, 16, 10), new T.MeshBasicMaterial({ color: 0xffb45a }));
  siteDot.position.copy(sitePos);
  const siteRing = new T.Mesh(new T.RingGeometry(0.09, 0.115, 32), new T.MeshBasicMaterial({ color: 0xffb45a, transparent: true, opacity: 0.8, side: T.DoubleSide, depthWrite: false }));
  siteRing.position.copy(sitePos.clone().multiplyScalar(1.002));
  siteRing.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), sitePos.clone().normalize());
  scene.add(siteDot, siteRing);
  const earthOcc = { centre: () => earth.position, radius: rE };
  const yAxis = new T.Vector3(0, 1, 0), qAsc = new T.Quaternion();
  let ascLeftAt = -1e9;
  const wallS = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

  // the lander model (metres) in this 1000 km scene: always enlarged here, with the factor in its label
  const lander = buildLanderModel();
  const craft = lander.group;
  scene.add(craft);
  const qTarget = new T.Quaternion(), basis = new T.Matrix4();
  let attInit = false;
  const controls = createControls(camera, { radius: 700, theta: 0.3, phi: 0.9 });
  labels.add('Earth', 'body earth', () => earth.position);
  labels.add('Moon', 'body', () => moon.position);
  const craftLbl = labels.add('Lander', 'craft', () => craft.position);
  labels.add('TLI', 'event', () => geo(t.tliMs));
  const siteLbl = labels.add('Launch site (illustrative)', 'event', () => sitePos, earthOcc);
  const ascLbl = labels.add('Ascent to parking orbit (illustrative, not simulated)', 'event', () => ascentAt(0.62), earthOcc);

  function update(st, { dt = 1 / 60, att = null } = {}) {
    const m = moonAt(st.tMs) ?? moon.position;
    moon.position.copy(m);
    const ascF = (st.tMs - t.launchMs) / (ASCENT_S * 1000);
    const ascending = st.phase === 'leo' && ascF < 1;
    const p = ascending ? ascentAt(ascF) : st.pos && st.earth ? v3(sub(st.pos, st.earth), K) : craft.position;
    const inLeo = st.phase === 'leo' || st.phase === 'tli';
    ascLine.visible = ascTrail.visible = siteDot.visible = siteRing.visible = inLeo;
    ascTrail.geometry.setDrawRange(0, Math.max(2, Math.round(Math.min(1, Math.max(0, ascF)) * ASCENT_N) + 1));
    ascLbl.visible = ascending;
    siteLbl.visible = inLeo;
    atmo.material.uniforms.uSun.value.set(st.sunDir[0], st.sunDir[2], -st.sunDir[1]).normalize();
    craft.position.copy(p);
    sun.position.copy(v3(st.sunDir, 1000));
    const ds = drawScale(camera.position.distanceTo(p), 1e-6, 0.04);
    craft.scale.setScalar(ds.s);
    const lbl = `${st.tliStageAttached ? 'Lander + upper stage' : 'Lander'}${ascending ? ' (ascent, illustrative)' : ''} · ${sizeNote(ds.times)}`;
    if (craftLbl.el.textContent !== lbl) craftLbl.el.textContent = lbl;
    if (att) {
      basis.makeBasis(v3(att.axes.x), v3(att.axes.y), v3(att.axes.z));
      qTarget.setFromRotationMatrix(basis);
      if (ascending) {
        // nose along the climb: vertical at lift-off, along the orbit at insertion
        const tan = ascentAt(ascF + 0.01).sub(ascentAt(ascF - 0.01));
        if (ascF < 0.01) tan.copy(sitePos);
        qTarget.copy(qAsc.setFromUnitVectors(yAxis, tan.normalize()));
      }
      if (!attInit) { craft.quaternion.copy(qTarget); attInit = true; } else craft.quaternion.slerp(qTarget, 1 - Math.exp(-dt / 0.35));
      lander.articulate({ sunBody: att.sunBody, earthBody: att.earthBody, throttle: att.throttle, stageAttached: att.stage, stageFiring: att.stageFiring || ascending });
    }
    // automatic framing by phase: the parking orbit close in, the coast between the bodies, the approach on the Moon
    const dE = norm(sub(st.pos, st.earth)) * K;
    let target, radius, key;
    if (ascending) {
      // close on the climb, from the side and a little above the ground track
      const out = p.clone().normalize();
      const view = out.clone().multiplyScalar(0.55).addScaledVector(orbitN, 1).addScaledVector(eEnd.clone().cross(orbitN), 0.25);
      ascLeftAt = wallS();
      controls.followView(p, 2.6 + 2.2 * Math.max(0, ascF), view, { tau: 0.5, dt, key: 'ascent' });
      return;
    }
    const tau = 0.1 + 1.1 * Math.max(0, 1 - (wallS() - ascLeftAt) / 4);   // ease out of the ascent framing
    if (st.phase === 'leo' || st.phase === 'tli') { target = new T.Vector3(0, 0, 0); radius = 40; key = 'earth'; }
    else if (dE < 60) { target = p.clone().multiplyScalar(0.5); radius = 60 + dE * 2.2; key = 'departure'; }
    else { target = m.clone().multiplyScalar(0.5); radius = 820; key = 'cruise'; }
    controls.follow(target, radius, { tau, dt, key });
  }
  return { scene, camera, controls, update, name: 'earth' };
}
