// Shared three.js helpers for the lander view: frame mapping, lines, star field, orbit camera controls and DOM labels.
// three.js is the vendored classic build (demo/vendor/three.classic.js), read from window.THREE at call time.

export const three = () => globalThis.THREE;

// MCI / Moon-fixed (z = north) → three.js (y up): (x, y, z) → (x, z, −y), times a scale
export function v3(p, k = 1) {
  const T = three();
  return new T.Vector3(p[0] * k, p[2] * k, -p[1] * k);
}
// local east-north-up (metres) → three.js: x = east, y = up, z = −north
export function enu3(e, k = 1) {
  const T = three();
  return new T.Vector3(e[0] * k, e[2] * k, -e[1] * k);
}

export function makeLine(points, { color = 0xffffff, opacity = 1, dashed = false, dash = 1, gap = 1, depthTest = true } = {}) {
  const T = three();
  const g = new T.BufferGeometry().setFromPoints(points);
  const m = dashed
    ? new T.LineDashedMaterial({ color, transparent: opacity < 1, opacity, dashSize: dash, gapSize: gap, depthTest })
    : new T.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest });
  const line = new T.Line(g, m);
  if (dashed) line.computeLineDistances();
  return line;
}

export function setLinePoints(line, points) {
  line.geometry.dispose();
  line.geometry = new (three().BufferGeometry)().setFromPoints(points);
  if (line.material.isLineDashedMaterial) line.computeLineDistances();
}

// a deterministic star field on a sphere of the given radius
export function starField(radius, count = 2500, seed = 7) {
  const T = three();
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    pos.set([r * Math.cos(a) * radius, u * radius, r * Math.sin(a) * radius], i * 3);
    const b = 0.35 + 0.65 * rnd() ** 3;
    col.set([b, b, b * (0.9 + 0.1 * rnd())], i * 3);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3));
  g.setAttribute('color', new T.BufferAttribute(col, 3));
  const m = new T.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false });
  return new T.Points(g, m);
}

// Orbit-style camera controls written for this page (the vendored build has no OrbitControls):
// drag = rotate, wheel / pinch = zoom (on the canvas only), shift-drag or right-drag = pan.
export function createControls(camera, { target = [0, 0, 0], radius = 10, minRadius = 0.1, maxRadius = 1e7, theta = 0.6, phi = 1.1 } = {}) {
  const T = three();
  const st = { target: new T.Vector3(...target), radius, theta, phi, minRadius, maxRadius, user: false };
  function apply() {
    st.phi = Math.min(Math.PI - 0.01, Math.max(0.01, st.phi));
    st.radius = Math.min(st.maxRadius, Math.max(st.minRadius, st.radius));
    const sp = Math.sin(st.phi);
    camera.position.set(
      st.target.x + st.radius * sp * Math.sin(st.theta),
      st.target.y + st.radius * Math.cos(st.phi),
      st.target.z + st.radius * sp * Math.cos(st.theta),
    );
    camera.lookAt(st.target);
  }
  function rotate(dx, dy) { st.theta -= dx * 0.005; st.phi -= dy * 0.005; st.user = true; apply(); }
  function zoom(f) { st.radius *= f; st.user = true; apply(); }
  function pan(dx, dy) {
    const k = st.radius * 0.0015;
    const right = new T.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new T.Vector3().setFromMatrixColumn(camera.matrix, 1);
    st.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    st.user = true;
    apply();
  }
  // smooth automatic framing: ease the target and radius toward the requested ones
  function follow(target, radius, ease = 0.15) {
    if (st.user) return;
    st.target.lerp(target, ease);
    st.radius += (radius - st.radius) * ease;
    apply();
  }
  // as follow(), and also turn the view so the camera looks along viewDir (a THREE.Vector3 from target to camera)
  function followView(target, radius, viewDir, ease = 0.08) {
    if (st.user) return;
    const d = viewDir.clone().normalize();
    const th = Math.atan2(d.x, d.z), ph = Math.acos(Math.max(-1, Math.min(1, d.y)));
    let dth = th - st.theta;
    dth -= 2 * Math.PI * Math.round(dth / (2 * Math.PI));
    st.theta += dth * ease;
    st.phi += (ph - st.phi) * ease;
    follow(target, radius, ease * 1.6);
  }
  function jump(target, radius) { st.target.copy(target); st.radius = radius; apply(); }
  apply();
  return { state: st, apply, rotate, zoom, pan, follow, followView, jump, camera };
}

// Pointer and wheel handling on the canvas, dispatched to whichever controls are active.
export function bindControls(dom, getControls, onUser) {
  let last = null, mode = null, pinch = null;
  const pts = new Map();
  dom.addEventListener('contextmenu', (e) => e.preventDefault());
  dom.addEventListener('pointerdown', (e) => {
    dom.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    last = [e.clientX, e.clientY];
    mode = e.button === 2 || e.shiftKey ? 'pan' : 'rotate';
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
  });
  dom.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    const c = getControls();
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) c.zoom(pinch / d);
      pinch = d;
      onUser?.();
      return;
    }
    const dx = e.clientX - last[0], dy = e.clientY - last[1];
    last = [e.clientX, e.clientY];
    if (mode === 'pan') c.pan(dx, dy); else c.rotate(dx, dy);
    onUser?.();
  });
  const end = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
  dom.addEventListener('pointerup', end);
  dom.addEventListener('pointercancel', end);
  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    getControls().zoom(Math.exp(e.deltaY * 0.0012));
    onUser?.();
  }, { passive: false });
}

// DOM labels that follow 3D points. Each label: { el, pos: () => THREE.Vector3 | null, occluder?: { centre, radius } }.
export function createLabels(layer) {
  const T = three();
  const items = [];
  function add(text, cls = '', pos = () => null, occluder = null) {
    const el = document.createElement('div');
    el.className = `lbl ${cls}`;
    el.innerHTML = text;
    layer.appendChild(el);
    const item = { el, pos, occluder, visible: true };
    items.push(item);
    return item;
  }
  const tmp = new T.Vector3(), ray = new T.Vector3();
  function update(camera, w, h, on = true) {
    for (const it of items) {
      const p = on && it.visible ? it.pos() : null;
      if (!p) { it.el.style.display = 'none'; continue; }
      tmp.copy(p).project(camera);
      if (tmp.z > 1 || Math.abs(tmp.x) > 1.2 || Math.abs(tmp.y) > 1.2) { it.el.style.display = 'none'; continue; }
      if (it.occluder) {
        // hidden when the camera → point segment passes through the occluding sphere
        const c = it.occluder.centre(), r = it.occluder.radius;
        ray.copy(p).sub(camera.position);
        const len = ray.length();
        ray.divideScalar(len);
        const oc = new T.Vector3().copy(c).sub(camera.position);
        const along = oc.dot(ray);
        if (along > 0 && along < len && oc.lengthSq() - along * along < r * r * 0.995) { it.el.style.display = 'none'; continue; }
      }
      it.el.style.display = '';
      it.el.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px)`;
    }
  }
  function remove(item) {
    const i = items.indexOf(item);
    if (i >= 0) items.splice(i, 1);
    item?.el.remove();
  }
  return { add, remove, update, items };
}
