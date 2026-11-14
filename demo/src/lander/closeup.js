// Close-up of the lander at real size (top of the Vehicle tab): the model in its own small scene, lit by the Sun
// from where the Sun is in the lander's body frame at the current time, with the array and the high-gain dish
// articulated as in the main view, arrows to the Sun and the Earth, and the main parts labelled on request.
// Drag to turn it, wheel or pinch to zoom. Its own WebGL canvas, drawn only while it is on screen.
import { three, createControls, bindControls } from './view-common.js';
import { buildLanderModel, LANDER_DIMS } from './model.js';

const MODE_TEXT = {
  'sun-point': 'Coasting, array on the Sun', safe: 'Safe mode, array on the Sun', burn: 'Burn, body along the thrust',
  descent: 'Powered descent, body along the thrust', surface: 'On the surface, array tracking the Sun',
};

export function createCloseup(doc = document) {
  const T = three();
  const el = doc.createElement('section');
  el.className = 'closeup';
  el.innerHTML = `<h3>The lander <small>generic robotic lander, real size: ${LANDER_DIMS.footprintM} m across the footpads, ${LANDER_DIMS.heightM} m tall (assumed)</small></h3>
    <div class="closeup-view"><canvas aria-label="3D close-up of the lander"></canvas><div class="closeup-labels"></div></div>
    <div class="closeup-bar"><label class="check"><input type="checkbox" data-parts checked> Label the parts</label><span class="closeup-hint">drag to turn · wheel to zoom</span></div>
    <p class="note closeup-att"></p>`;
  const canvas = el.querySelector('canvas'), layer = el.querySelector('.closeup-labels'), att = el.querySelector('.closeup-att');
  const partsBox = el.querySelector('[data-parts]');
  let renderer = null, w = 0, h = 0;
  const scene = new T.Scene();
  scene.add(new T.AmbientLight(0x6a7280, 0.6));
  const sun = new T.DirectionalLight(0xfff4e6, 3.0);
  scene.add(sun, sun.target);
  const model = buildLanderModel();
  scene.add(model.group);
  const lineTo = (color) => {
    const g = new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3(0, 1, 0)]);
    const l = new T.Line(g, new T.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    scene.add(l);
    return l;
  };
  const sunLine = lineTo(0xf2b33d), earthLine = lineTo(0x4cb3f0);
  const centre = new T.Vector3(0, 1.6, 0);
  const camera = new T.PerspectiveCamera(35, 1, 0.1, 500);
  const controls = createControls(camera, { target: [0, 1.4, 0], radius: 13, theta: 0.9, phi: 1.25, minRadius: 4, maxRadius: 60 });
  bindControls(canvas, () => controls, null);
  const tags = new Map();
  const tag = (id, text, cls) => {
    if (!tags.has(id)) { const s = doc.createElement('span'); s.className = `part ${cls ?? ''}`; layer.appendChild(s); tags.set(id, s); }
    const s = tags.get(id);
    if (s.textContent !== text) s.textContent = text;
    return s;
  };
  let last = null;

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    if (r.width < 10) return;
    w = Math.round(r.width); h = Math.round(r.height);
    if (!renderer) {
      renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setClearColor(0x000000, 0);
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // a: model.attitudeState(); pw: power timeline sample (factor, mode); dt: seconds since the last frame
  function update(a, pw, dt = 1 / 60) {
    if (!a) return;
    if (!renderer || Math.round(canvas.parentElement.clientWidth) !== w) resize();   // first show, or the panel resized
    last = a;
    model.articulate({ sunBody: a.sunBody, earthBody: a.earthBody, throttle: a.throttle, stageAttached: a.stage, stageFiring: a.stageFiring });
    if (a.sunBody) {
      const d = new T.Vector3(...a.sunBody).normalize();
      sun.position.copy(d).multiplyScalar(30); sun.target.position.set(0, 0, 0);
      sunLine.geometry.setFromPoints([centre, centre.clone().addScaledVector(d, 6)]);
    }
    sunLine.visible = !!a.sunBody;
    if (a.earthBody) earthLine.geometry.setFromPoints([centre, centre.clone().addScaledVector(new T.Vector3(...a.earthBody).normalize(), 6)]);
    earthLine.visible = !!a.earthBody;
    // the lander framed from a little off the array's face (so the wing is seen, not edge-on); with the
    // trans-lunar stage attached, a little lower and wider (the stage runs out below)
    const az = a.arrayAngle + 0.65;
    controls.followView(new T.Vector3(0, a.stage ? 0.2 : 1.4, 0), a.stage ? 16 : 13, new T.Vector3(Math.sin(az), 0.42, Math.cos(az)), { tau: 0.6, dt, key: 'closeup' });
    const pct = (x) => `${Math.round(Math.max(0, x) * 100)} %`;
    const text = `${MODE_TEXT[a.mode] ?? a.mode}. Array at ${pct(a.arrayIncidence)} of full Sun${pw && Number.isFinite(pw.factor) ? ` (power model ${pct(pw.factor)})` : ''}${a.throttle > 0.01 ? `, ${a.stageFiring ? 'trans-lunar stage' : 'main engine'} firing${a.stageFiring ? '' : ` at ${pct(a.throttle)}`}` : ''}. Yellow line: to the Sun; blue: to the Earth.`;
    if (att.textContent !== text) att.textContent = text;
  }

  function render() {
    if (!renderer || !last) return;
    renderer.render(scene, camera);
    const show = partsBox.checked;
    const list = show ? model.parts() : [];
    const live = new Set(), placed = [];
    const items = [...list.map((p) => [p.id, p.label, p.pos, '']),
      ...(last.sunBody ? [['sun', 'Sun', centre.clone().addScaledVector(new T.Vector3(...last.sunBody).normalize(), 6.3), 'sun']] : []),
      ...(last.earthBody ? [['earth', 'Earth', centre.clone().addScaledVector(new T.Vector3(...last.earthBody).normalize(), 6.3), 'earth']] : [])]
      .map(([id, text, p, cls]) => { const q = p.clone().project(camera); return { id, text, cls, q, x: ((q.x + 1) / 2) * w, y: ((1 - q.y) / 2) * h }; })
      .sort((a, b) => a.y - b.y);
    // simple declutter: push a label down until its box clears the ones already placed
    for (const it of items) {
      const s = tag(it.id, it.text, it.cls);
      const on = it.q.z < 1 && Math.abs(it.q.x) < 1.05 && Math.abs(it.q.y) < 1.05;
      s.hidden = !on;
      live.add(it.id);
      if (!on) continue;
      const bw = 14 + it.text.length * 6;
      let y = it.y;
      for (let k = 0; k < 12 && placed.some((p) => Math.abs(p.x - it.x) < (p.w + bw) / 2 + 2 && Math.abs(p.y - y) < 14); k++) y += 14;
      placed.push({ x: it.x + bw / 2, y, w: bw });
      s.style.transform = `translate(${it.x}px, ${y}px)`;
    }
    for (const [id, s] of tags) if (!live.has(id)) s.hidden = true;
  }

  return { el, resize, update, render, model };
}
