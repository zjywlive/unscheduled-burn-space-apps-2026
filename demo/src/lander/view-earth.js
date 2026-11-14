// Scene 1: Earth–Moon transfer, geocentric and non-rotating (axes of the MCI frame), 1 unit = 1000 km, true scale.
import { three, v3, makeLine, starField, createControls } from './view-common.js';
import { sub, norm } from './vec.js';
import { R_EARTH, R_MOON } from './constants.js';

const K = 1 / 1000;

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

  const craft = new T.Mesh(new T.SphereGeometry(0.25, 12, 8), new T.MeshBasicMaterial({ color: 0xffffff }));
  scene.add(craft);
  const controls = createControls(camera, { radius: 700, theta: 0.3, phi: 0.9 });
  labels.add('Earth', 'body earth', () => earth.position);
  labels.add('Moon', 'body', () => moon.position);
  const craftLbl = labels.add('Lander', 'craft', () => craft.position);
  labels.add('TLI', 'event', () => geo(t.tliMs));

  function update(st, { dt = 1 / 60 } = {}) {
    const m = moonAt(st.tMs) ?? moon.position;
    moon.position.copy(m);
    const p = st.pos && st.earth ? v3(sub(st.pos, st.earth), K) : craft.position;
    craft.position.copy(p);
    sun.position.copy(v3(st.sunDir, 1000));
    craftLbl.el.textContent = st.tliStageAttached ? 'Lander + upper stage' : 'Lander';
    // automatic framing by phase: the parking orbit close in, the coast between the bodies, the approach on the Moon
    const dE = norm(sub(st.pos, st.earth)) * K;
    let target, radius, key;
    if (st.phase === 'leo' || st.phase === 'tli') { target = new T.Vector3(0, 0, 0); radius = 40; key = 'earth'; }
    else if (dE < 60) { target = p.clone().multiplyScalar(0.5); radius = 60 + dE * 2.2; key = 'departure'; }
    else { target = m.clone().multiplyScalar(0.5); radius = 820; key = 'cruise'; }
    controls.follow(target, radius, { tau: 0.1, dt, key });
  }
  return { scene, camera, controls, update, name: 'earth' };
}
