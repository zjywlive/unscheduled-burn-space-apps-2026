// Lander track: smooth following. The descent state is continuous in position and velocity across its 1 s
// samples (cubic Hermite), and the follow camera eases by real time (1 − exp(−dt/τ)) and moves with the craft, so
// it neither lags a fast craft nor jumps when frame times vary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { planMission, hermite3 } from '../demo/src/lander/mission.js';
import { createControls } from '../demo/src/lander/view-common.js';

const demo = new URL('../demo/', import.meta.url).pathname;

test('smooth: Hermite interpolation meets both ends and their velocities', () => {
  const p0 = [0, 0, 0], v0 = [10, 0, -2], p1 = [12, 1, -3], v1 = [14, 2, -4], h = 1;
  assert.deepEqual(hermite3(p0, v0, p1, v1, h, 0), p0);
  assert.deepEqual(hermite3(p0, v0, p1, v1, h, 1).map((x) => +x.toFixed(12)), p1);
  const e = 1e-6;
  const d0 = hermite3(p0, v0, p1, v1, h, e).map((x, i) => (x - p0[i]) / (e * h));
  const d1 = hermite3(p0, v0, p1, v1, h, 1 - e).map((x, i) => (p1[i] - x) / (e * h));
  d0.forEach((x, i) => assert.ok(Math.abs(x - v0[i]) < 1e-4, `start velocity ${i}`));
  d1.forEach((x, i) => assert.ok(Math.abs(x - v1[i]) < 1e-4, `end velocity ${i}`));
});

test('smooth: the descent path has no velocity kinks at the 1 s samples', () => {
  const eph = createEphemeris(JSON.parse(readFileSync(join(demo, 'data', 'ephemeris.json'), 'utf8')));
  const sites = JSON.parse(readFileSync(join(demo, 'data', 'sites.json'), 'utf8'));
  const plan = planMission({ eph, site: sites.find((s) => s.id === 'shackleton'), landingMs: Date.parse('2027-01-10T02:00:00Z') });
  const tPdi = plan.times.pdiMs;
  const kmPerS = (a, b, dtS) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / dtS;
  let worst = 0, worstKnot = 0;
  // braking (hard deceleration) and approach: compare the slope just before and just after a sample time
  for (const tS of [60, 200, 400, 560, 620, 700]) {
    const t = tPdi + tS * 1000, eps = 50;   // ms
    const pm = plan.stateAt(t - eps).pos, p0 = plan.stateAt(t).pos, pp = plan.stateAt(t + eps).pos;
    const vin = pm.map((x, i) => (p0[i] - x) / (eps / 1000)), vout = p0.map((x, i) => (pp[i] - x) / (eps / 1000));
    const kink = Math.hypot(vout[0] - vin[0], vout[1] - vin[1], vout[2] - vin[2]) * 1000;   // m/s
    worst = Math.max(worst, kink);
    // the drawn velocity at the knot is the simulated one
    const v = plan.stateAt(t).vel;
    worstKnot = Math.max(worstKnot, Math.abs(kmPerS(pm, pp, 2 * eps / 1000) - Math.hypot(...v)) * 1000);
  }
  assert.ok(worst < 0.5, `velocity kink ${worst.toFixed(3)} m/s at a sample`);
  assert.ok(worstKnot < 0.5, `speed at a sample off by ${worstKnot.toFixed(3)} m/s`);
});

// a minimal THREE for the controls (they use Vector3 and a camera with position and lookAt)
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  clone() { return new V3(this.x, this.y, this.z); }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  lerp(v, k) { this.x += (v.x - this.x) * k; this.y += (v.y - this.y) * k; this.z += (v.z - this.z) * k; return this; }
  multiplyScalar(k) { this.x *= k; this.y *= k; this.z *= k; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { return this.multiplyScalar(1 / (this.length() || 1)); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
}
function withThree(fn) {
  const prev = globalThis.THREE;
  globalThis.THREE = { Vector3: V3 };
  try { return fn(); } finally { globalThis.THREE = prev; }
}
const camera = () => ({ position: new V3(), lookAt() {}, matrix: {} });

test('smooth: the follow camera tracks a moving craft with no lag, whatever the frame times', () => withThree(() => {
  const c = createControls(camera(), { radius: 400 });
  const view = new V3(0.3, 0.5, 0.8);
  let rnd = 3;
  const r = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
  let t = 0;
  const craftAt = (s) => new V3(1700 * s, 50 * Math.sin(s), -30 * s);   // 1.7 km/s, scene units of 1 m
  for (let i = 0; i < 600; i++) {
    const dt = (1 / 60) * (0.5 + r());   // 8–25 ms frames
    t += dt;
    c.followView(craftAt(t), 420, view, { tau: 0.27, dt, key: 'craft' });
    if (i > 200) assert.ok(c.state.target.distanceTo(craftAt(t)) < 1e-6, `lag ${c.state.target.distanceTo(craftAt(t))} at frame ${i}`);
  }
  assert.ok(Math.abs(c.state.radius - 420) < 1e-3);
}));

test('smooth: easing depends on elapsed time, not on the number of frames', () => withThree(() => {
  const run = (dt, n) => {
    const c = createControls(camera(), { radius: 100, theta: 0, phi: 1 });
    for (let i = 0; i < n; i++) c.followView(new V3(500, 0, 0), 300, new V3(1, 0.2, 0), { tau: 0.3, dt, key: 'k' });
    return c.state;
  };
  const a = run(1 / 120, 60), b = run(1 / 30, 15);   // half a second either way
  assert.ok(Math.abs(a.radius - b.radius) < 1e-9 && a.target.distanceTo(b.target) < 1e-9 && Math.abs(a.theta - b.theta) < 1e-12);
  assert.ok(a.radius > 100 && a.radius < 300, 'still easing after 0.5 s');
  // a new framing (key) eases over from where the camera is instead of jumping with the request
  const c = createControls(camera(), { radius: 100 });
  c.follow(new V3(0, 0, 0), 100, { key: 'orbit', dt: 1 / 60 });
  c.follow(new V3(1000, 0, 0), 100, { key: 'craft', dt: 1 / 60, tau: 0.2 });
  assert.ok(c.state.target.x > 0 && c.state.target.x < 200, `eased to ${c.state.target.x}`);
  // the user's own camera is left alone, and following resumes without a jump
  c.state.user = true;
  c.follow(new V3(5000, 0, 0), 100, { key: 'craft', dt: 1 / 60 });
  const held = c.state.target.x;
  c.state.user = false;
  c.follow(new V3(5010, 0, 0), 100, { key: 'craft', dt: 1 / 60, tau: 0.2 });
  assert.ok(c.state.target.x - held < 600, 'no jump on resume');
}));
