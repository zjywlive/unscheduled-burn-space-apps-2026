// Lander track: on-screen and keyboard camera controls (zoom, rotate, raise/lower, pan, follow craft).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createControls, cameraStep, cameraKey, CAMERA_ACTIONS, CAMERA_KEYS, CAMERA_CHARS } from '../demo/src/lander/view-common.js';

class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  clone() { return new V3(this.x, this.y, this.z); }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  lerp(v, k) { this.x += (v.x - this.x) * k; this.y += (v.y - this.y) * k; this.z += (v.z - this.z) * k; return this; }
  addScaledVector(v, k) { this.x += v.x * k; this.y += v.y * k; this.z += v.z * k; return this; }
  multiplyScalar(k) { this.x *= k; this.y *= k; this.z *= k; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { return this.multiplyScalar(1 / (this.length() || 1)); }
  setFromMatrixColumn(m, i) { return this.set(...m.cols[i]); }
}
function controls() {
  globalThis.THREE = { Vector3: V3 };
  // camera looking along −z: right = +x, up = +y
  return createControls({ position: new V3(), lookAt() {}, matrix: { cols: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] } }, { radius: 100, theta: 0.5, phi: 1.2 });
}

test('camera: each button moves the camera the stated way and takes it off the automatic follow', () => {
  const dt = 0.5;
  const run = (action) => { const c = controls(); const s0 = { ...c.state, target: c.state.target.clone() }; assert.equal(cameraStep(c, action, dt), true); return [s0, c.state]; };
  let [a, b] = run('rotate-left');
  assert.ok(Math.abs(b.theta - a.theta - 1.2 * dt) < 1e-9 && b.user === true);
  [a, b] = run('rotate-right');
  assert.ok(Math.abs(b.theta - a.theta + 1.2 * dt) < 1e-9);
  [a, b] = run('raise');
  assert.ok(Math.abs(b.phi - (a.phi - 0.8 * dt)) < 1e-9, 'raise = camera higher (smaller polar angle)');
  [a, b] = run('lower');
  assert.ok(Math.abs(b.phi - (a.phi + 0.8 * dt)) < 1e-9);
  [a, b] = run('zoom-in');
  assert.ok(Math.abs(b.radius - a.radius * Math.exp(-1.2 * dt)) < 1e-9);
  [a, b] = run('zoom-out');
  assert.ok(Math.abs(b.radius - a.radius * Math.exp(1.2 * dt)) < 1e-9);
  [a, b] = run('pan-left');
  assert.ok(Math.abs(b.target.x - (a.target.x - 0.6 * dt * a.radius)) < 1e-9 && b.target.y === a.target.y, 'pan 0.6 view radii per second');
  [a, b] = run('pan-right');
  assert.ok(b.target.x > a.target.x);
  [a, b] = run('pan-up');
  assert.ok(b.target.y > a.target.y);
  [a, b] = run('pan-down');
  assert.ok(b.target.y < a.target.y);
  const c = controls();
  assert.equal(cameraStep(c, 'spin', dt), false);
  assert.equal(c.state.user, false, 'unknown action leaves the follow on');
  // following ignores the request while the user holds the camera, and takes it back once released
  cameraStep(c, 'pan-left', dt);
  const held = c.state.target.clone();
  c.follow(new V3(500, 0, 0), 100, { key: 'craft', dt: 1 / 60 });
  assert.deepEqual([c.state.target.x, c.state.target.y], [held.x, held.y]);
  c.state.user = false;
  c.follow(new V3(500, 0, 0), 100, { key: 'craft', dt: 1, tau: 0.1 });
  assert.ok(Math.abs(c.state.target.x - 500) < 1, 'follow craft eases back to the craft');
});

test('camera: keys map to actions and leave the arrows to the timeline; the page has every button', () => {
  for (const a of [...Object.values(CAMERA_KEYS), ...Object.values(CAMERA_CHARS)]) assert.ok(CAMERA_ACTIONS.includes(a), a);
  assert.equal(cameraKey({ code: 'KeyQ', key: 'q' }), 'rotate-left');
  assert.equal(cameraKey({ code: '', key: '-' }), 'zoom-out', 'by character when the event has no key code');
  assert.equal(cameraKey({ code: '', key: 'W' }), 'pan-up');
  assert.equal(cameraKey({ code: 'ArrowLeft', key: 'ArrowLeft' }), null);
  assert.ok(!Object.keys(CAMERA_KEYS).some((k) => k.startsWith('Arrow') || k === 'Space'));
  const page = readFileSync(new URL('../demo/lander.html', import.meta.url), 'utf8');
  const block = page.split('id="camctl"')[1].split('</div>')[0];
  for (const a of CAMERA_ACTIONS) assert.ok(block.includes(`data-cam="${a}"`), a);
  assert.ok(block.includes('id="cam-follow"') && block.includes('aria-label="Follow craft"'));
});
