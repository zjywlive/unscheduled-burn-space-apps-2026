// The lander as a 3D model (generic robotic lander, metres, body frame: +Y up through the top deck, the main
// engine fires along −Y so thrust is +Y), and its attitude from the mission state, as the power model assumes:
//   burn / descent  body +Y along the thrust; the array turns about +Y to face the Sun (output = sin of the Sun's
//                   angle from the thrust axis, power.arrayFactor)
//   sun-point/safe  body +Y perpendicular to the Sun (along-track), array normal on the Sun (output 1)
//   surface         upright on local up; the array tracks the Sun's azimuth about up (one-axis: cos elevation)
// The roll about +Y puts the antenna side (+Z) toward the Earth; the high-gain dish is gimballed onto the Earth.
// Pure vector maths at the top (tested without three.js); the mesh builder needs window.THREE.
import { three } from './view-common.js';
import { attitudeForPhase } from './power.js';
import { add, sub, scale, dot, cross, norm, unit } from './vec.js';

const PHASE_MAP = { 'approach-moon': 'coast', 'descent-coast': 'llo' };   // as power-timeline.js
export const attitudeMode = (phaseId) => attitudeForPhase(PHASE_MAP[phaseId] ?? phaseId);

// outer edges of opposite footpads, top of the high-gain dish, body flat to flat, array wing tip from the axis
export const LANDER_DIMS = Object.freeze({ footprintM: 4.9, heightM: 3.3, bodyM: 2.4, arraySpanM: 3.8 });

const perp = (v, ref) => { const p = sub(v, scale(ref, dot(v, ref))); return norm(p) > 1e-9 ? unit(p) : null; };
const anyPerp = (y) => unit(Math.abs(y[0]) < 0.9 ? cross(y, [1, 0, 0]) : cross(y, [0, 1, 0]));

// Body axes (unit vectors in the caller's frame) for an attitude mode. thrustDir: unit thrust direction while
// firing (null otherwise); vel: velocity relative to the central body; up: local vertical (surface).
export function bodyAxes({ mode, thrustDir = null, vel = null, sunDir = null, earthDir = null, up = null }) {
  let y = null;
  if ((mode === 'burn' || mode === 'descent') && thrustDir) y = unit(thrustDir);
  else if (mode === 'surface' && up) y = unit(up);
  else if (vel && sunDir) y = perp(vel, sunDir);           // along-track, square to the Sun
  if (!y && vel && norm(vel) > 1e-12) y = unit(vel);
  if (!y && up) y = unit(up);
  if (!y) y = [0, 0, 1];
  const z = (earthDir && perp(earthDir, y)) || (sunDir && perp(sunDir, y)) || anyPerp(y);
  return { x: cross(y, z), y, z };
}

export const toBody = (axes, d) => (d ? [dot(d, axes.x), dot(d, axes.y), dot(d, axes.z)] : null);
export const fromBody = (axes, b) => add(add(scale(axes.x, b[0]), scale(axes.y, b[1])), scale(axes.z, b[2]));
// array drive angle about body +Y that turns the panel normal (+Z at 0) toward the Sun, and the resulting
// incidence factor (cos of the angle between the panel normal and the Sun)
export const arrayAngle = (sunBody) => (sunBody ? Math.atan2(sunBody[0], sunBody[2]) : 0);
export const arrayIncidence = (sunBody) => (sunBody ? Math.hypot(sunBody[0], sunBody[2]) : 0);

// The lander's attitude from a plan state (MCI vectors): mode, body axes, Sun and Earth directions, throttle,
// and whether the trans-lunar stage is attached and firing.
export function attitudeState(st, plan) {
  const mode = attitudeMode(st.phase);
  const ev = st.body === 'earth' ? plan.bodies?.earthVelMci?.(st.tMs) : null;
  const vel = ev ? sub(st.vel, ev) : st.vel;
  const earthDir = st.earth ? unit(sub(st.earth, st.pos)) : null;
  const up = unit(st.pos);
  const axes = bodyAxes({ mode, thrustDir: st.throttle > 0 ? st.thrustDir : null, vel, sunDir: st.sunDir, earthDir, up });
  const sunBody = toBody(axes, st.sunDir), earthBody = toBody(axes, earthDir);
  return {
    mode, axes, sunDir: st.sunDir, earthDir, sunBody, earthBody,
    throttle: st.throttle ?? 0, stage: !!st.tliStageAttached, stageFiring: st.phase === 'tli',
    arrayAngle: arrayAngle(sunBody), arrayIncidence: arrayIncidence(sunBody),
  };
}

// Scale for drawing: real size when close, enlarged to about `frac` of the camera distance across when far.
// unitsPerM: scene units per metre. → { s (scene units per model metre), times (enlargement, 1 = real size) }
export function drawScale(camDist, unitsPerM, frac = 0.05) {
  const real = unitsPerM, want = (camDist * frac) / LANDER_DIMS.footprintM;
  const s = Math.max(real, want);
  return { s, times: s / real };
}
export const sizeNote = (times) => (times < 1.5 ? '' : `drawn ${times >= 100 ? Math.round(times).toLocaleString('en-GB', { maximumSignificantDigits: 2 }) : times.toFixed(times < 10 ? 1 : 0)}× real size`);

// ---------- mesh ----------

export function buildLanderModel() {
  const T = three();
  const root = new T.Group();
  const M = (o) => new T.MeshStandardMaterial(o);
  const foil = M({ color: 0xc9a24a, metalness: 0.65, roughness: 0.35 });
  const foilDark = M({ color: 0x8f6f2e, metalness: 0.6, roughness: 0.45 });
  const white = M({ color: 0xdedede, metalness: 0.1, roughness: 0.6 });
  const grey = M({ color: 0xb8bcc2, metalness: 0.4, roughness: 0.45 });
  const dark = M({ color: 0x262626, metalness: 0.55, roughness: 0.45, side: T.DoubleSide });
  const cell = M({ color: 0x1b2a4f, metalness: 0.35, roughness: 0.3, emissive: 0x050a18 });
  const mesh = (g, m, x = 0, y = 0, z = 0) => { const o = new T.Mesh(g, m); o.position.set(x, y, z); return o; };
  // a rod between two points
  const rod = (a, b, r, m) => {
    const A = new T.Vector3(...a), B = new T.Vector3(...b), d = B.clone().sub(A);
    const o = new T.Mesh(new T.CylinderGeometry(r, r, d.length(), 8), m);
    o.position.copy(A).add(B).multiplyScalar(0.5);
    o.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d.normalize());
    return o;
  };

  // descent stage: octagonal body, skirt, top deck, avionics, four propellant tanks bulging between the legs
  const body = new T.Group();
  body.add(mesh(new T.CylinderGeometry(1.2, 1.2, 1.0, 8), foil, 0, 1.75, 0));
  body.add(mesh(new T.CylinderGeometry(1.2, 0.85, 0.35, 8), foilDark, 0, 1.075, 0));
  body.add(mesh(new T.CylinderGeometry(1.05, 1.2, 0.18, 8), white, 0, 2.34, 0));
  body.add(mesh(new T.BoxGeometry(0.7, 0.32, 0.5), white, 0.35, 2.59, -0.35));
  const tanks = [];
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    const t = mesh(new T.SphereGeometry(0.42, 20, 12), grey, Math.cos(a) * 1.02, 1.72, Math.sin(a) * 1.02);
    body.add(t); tanks.push(t);
  }
  root.add(body);

  // main engine and plume (exhaust along −Y)
  const engine = new T.Group();
  engine.add(mesh(new T.CylinderGeometry(0.22, 0.22, 0.2, 16), dark, 0, 1.0, 0));
  engine.add(mesh(new T.CylinderGeometry(0.16, 0.45, 0.7, 24, 1, true), dark, 0, 0.6, 0));
  root.add(engine);
  const plumeMat = new T.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.55, blending: T.AdditiveBlending, depthWrite: false });
  const plume = new T.Mesh(new T.ConeGeometry(0.5, 1, 20, 1, true), plumeMat);
  plume.rotation.x = Math.PI;
  root.add(plume);

  // four landing legs (primary and secondary struts) with footpads, at 45° between the tanks
  const legs = [];
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2, c = Math.cos(a), s = Math.sin(a);
    const pad = [2.1 * c, 0.06, 2.1 * s];
    const g = new T.Group();
    g.add(rod([1.02 * c, 1.95, 1.02 * s], pad, 0.055, white));
    g.add(rod([1.05 * c, 0.95, 1.05 * s], [1.8 * c, 0.42, 1.8 * s], 0.04, white));
    g.add(mesh(new T.CylinderGeometry(0.3, 0.34, 0.08, 16), white, pad[0], 0.04, pad[2]));
    root.add(g); legs.push(pad);
  }

  // reaction-control thruster quads on the body corners (four small nozzles each)
  const rcs = [];
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 8 + (k * Math.PI) / 2, c = Math.cos(a), s = Math.sin(a);
    const q = new T.Group();
    q.position.set(1.22 * c, 2.1, 1.22 * s);
    q.rotation.y = -a;
    q.add(mesh(new T.BoxGeometry(0.16, 0.16, 0.16), white));
    // nozzles up, down and both ways along the body's circumference (local Z), mouths outward
    for (const d of [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const n = new T.Mesh(new T.ConeGeometry(0.045, 0.13, 10, 1, true), dark);
      n.quaternion.setFromUnitVectors(new T.Vector3(0, -1, 0), new T.Vector3(...d));
      n.position.set(d[0] * 0.14, d[1] * 0.14, d[2] * 0.14);
      q.add(n);
    }
    root.add(q); rcs.push(q);
  }

  // solar array: one wing on a boom from a drive that turns about body +Y (panel normal +Z at angle 0)
  const arrayDrive = new T.Group();
  arrayDrive.add(mesh(new T.CylinderGeometry(1.24, 1.24, 0.08, 8), grey, 0, 2.02, 0));
  arrayDrive.add(rod([1.15, 1.95, 0], [1.65, 1.95, 0], 0.035, grey));
  const panel = new T.Group();
  panel.position.set(2.75, 1.95, 0);
  panel.add(mesh(new T.BoxGeometry(2.2, 1.2, 0.04), cell));
  for (const x of [-0.55, 0, 0.55]) panel.add(mesh(new T.BoxGeometry(0.02, 1.2, 0.05), grey, x, 0, 0));
  panel.add(mesh(new T.BoxGeometry(2.2, 0.02, 0.05), grey, 0, 0, 0));
  arrayDrive.add(panel);
  root.add(arrayDrive);

  // high-gain antenna: mast, two-axis gimbal, dish (opening along the gimbal's +Y) with its feed
  root.add(rod([-0.55, 2.43, 0.35], [-0.55, 2.95, 0.35], 0.04, grey));
  const dish = new T.Group();
  dish.position.set(-0.55, 2.98, 0.35);
  const bowl = new T.Mesh(new T.SphereGeometry(0.62, 28, 8, 0, Math.PI * 2, 0, 0.75), white);
  bowl.material = white.clone(); bowl.material.side = T.DoubleSide;
  bowl.rotation.x = Math.PI;
  bowl.position.y = 0.62;
  dish.add(bowl);
  dish.add(mesh(new T.CylinderGeometry(0.02, 0.02, 0.36, 6), grey, 0, 0.18, 0));
  dish.add(mesh(new T.SphereGeometry(0.05, 10, 8), dark, 0, 0.37, 0));
  root.add(dish);

  // trans-lunar injection stage under the lander until it separates (generic cryogenic upper stage). Its own
  // materials, so it can fade out as it drifts away after separation without touching the lander's.
  const stage = new T.Group();
  const sGrey = grey.clone(), sWhite = white.clone(), sDark = dark.clone();
  const stageMats = [sGrey, sWhite, sDark];
  stage.add(mesh(new T.CylinderGeometry(1.0, 1.5, 0.6, 24), sGrey, 0, -0.3, 0));
  stage.add(mesh(new T.CylinderGeometry(1.5, 1.5, 6.0, 32), sWhite, 0, -3.6, 0));
  stage.add(mesh(new T.CylinderGeometry(0.3, 0.9, 1.4, 24, 1, true), sDark, 0, -7.3, 0));
  const stagePlume = new T.Mesh(new T.ConeGeometry(1.0, 1, 24, 1, true), plumeMat.clone());
  stagePlume.rotation.x = Math.PI;
  stage.add(stagePlume);
  stage.visible = false;
  root.add(stage);
  // separation puff: a short-lived ring of gas at the interface (illustrative)
  const puff = new T.Mesh(new T.SphereGeometry(1, 20, 12), new T.MeshBasicMaterial({ color: 0xdfe8ff, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
  puff.position.set(0, -0.3, 0);
  puff.visible = false;
  root.add(puff);

  root.traverse((o) => { if (o.isMesh && o !== plume && o !== stagePlume && o !== puff) { o.castShadow = true; o.receiveShadow = true; } });
  const up = new T.Vector3(0, 1, 0), tmp = new T.Vector3();

  // Stage separation, drawn (illustrative: the mission model only has the separation time). When the stage goes
  // from attached to separated it stays visible for SEP_S seconds of wall-clock time: it eases away along −Y with a
  // slow tumble and fades, with a brief puff at the interface. A model first drawn after separation shows no stage.
  const SEP_S = 9, SEP_DRIFT_M = 15, SEP_TAU_S = 3.5;
  const nowS = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  let wasAttached = null, sepT0 = null;
  const stageRest = () => { stage.position.set(0, 0, 0); stage.rotation.set(0, 0, 0); for (const m of stageMats) { m.transparent = false; m.opacity = 1; } puff.visible = false; };
  function stageStep(attached) {
    if (attached) { if (sepT0 !== null || !stage.visible) stageRest(); sepT0 = null; stage.visible = true; }
    else if (wasAttached === true) sepT0 = nowS();
    wasAttached = attached;
    if (attached) return;
    if (sepT0 === null) { stage.visible = false; puff.visible = false; return; }
    const ts = nowS() - sepT0;
    if (ts >= SEP_S) { sepT0 = null; stage.visible = false; stageRest(); return; }
    const e = 1 - Math.exp(-ts / SEP_TAU_S);                 // eased drift, no jump at t = 0
    stage.visible = true;
    stage.position.set(0.9 * e, -SEP_DRIFT_M * e, 0);
    stage.rotation.set(0.5 * e, 0, 0.22 * e);
    const fade = Math.min(1, Math.max(0, (SEP_S - ts) / 3));  // last 3 s fade to nothing
    for (const m of stageMats) { m.transparent = fade < 1; m.opacity = fade; }
    const pf = ts / 1.6;
    puff.visible = pf < 1;
    if (puff.visible) { puff.scale.set(1.2 + 3.5 * pf, 0.25 + 0.5 * pf, 1.2 + 3.5 * pf); puff.material.opacity = 0.5 * (1 - pf) * Math.min(1, ts / 0.08); }
  }

  // articulation: array drive, dish on the Earth, plumes; sunBody/earthBody are body-frame unit vectors
  function articulate({ sunBody = null, earthBody = null, throttle = 0, stageAttached = false, stageFiring = false } = {}) {
    if (sunBody) arrayDrive.rotation.y = arrayAngle(sunBody);
    if (earthBody) dish.quaternion.setFromUnitVectors(up, tmp.set(...earthBody).normalize());
    stageStep(stageAttached);
    const th = stageFiring ? 0 : Math.max(0, Math.min(1, throttle));
    plume.visible = th > 0.01;
    plume.scale.set(1, 2 + th * 9, 1);
    plume.position.y = 0.25 - (1 + th * 9) / 2;
    stagePlume.visible = stageAttached && stageFiring;
    stagePlume.scale.set(1, 8, 1);
    stagePlume.position.y = -8.0 - 4;
  }
  // part anchors in the model's own frame (for labels), current with the articulation
  function parts() {
    root.updateMatrixWorld(true);
    const inv = root.matrixWorld.clone().invert();
    const local = (o, x = 0, y = 0, z = 0) => o.localToWorld(new T.Vector3(x, y, z)).applyMatrix4(inv);
    const out = [
      { id: 'engine', label: 'Main engine', pos: new T.Vector3(0, 0.3, 0) },
      { id: 'legs', label: 'Landing leg', pos: new T.Vector3(...legs[1]) },
      { id: 'array', label: 'Solar array', pos: local(panel, 0.6, 0.35, 0) },
      { id: 'antenna', label: 'High-gain antenna', pos: local(dish, 0, 0.45, 0) },
      { id: 'tanks', label: 'Propellant tank', pos: tanks[0].position.clone().add(new T.Vector3(0.38, 0, 0)) },
      { id: 'rcs', label: 'RCS thrusters', pos: rcs[2].position.clone() },
    ];
    if (stage.visible && wasAttached) out.push({ id: 'stage', label: 'Trans-lunar stage', pos: new T.Vector3(1.5, -3.6, 0) });
    return out;
  }
  return { group: root, plume, articulate, parts, stage };
}
