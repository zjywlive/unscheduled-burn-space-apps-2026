// Lander track: the 3D lander model and its attitude. The attitude follows the power model (body along the
// thrust in burns, square to the Sun when coasting, upright on the surface), so the array the page draws gets
// the same illumination the power budget uses; the model itself (real three.js, vendored build) has its parts,
// its real size, and articulates the array, the dish, the plumes and the trans-lunar stage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { planMission } from '../demo/src/lander/mission.js';
import { arrayFactor } from '../demo/src/lander/power.js';
import { bodyAxes, toBody, arrayAngle, arrayIncidence, attitudeState, attitudeMode, drawScale, sizeNote, buildLanderModel, LANDER_DIMS } from '../demo/src/lander/model.js';
import { unit, dot, cross, norm } from '../demo/src/lander/vec.js';

const demo = new URL('../demo/', import.meta.url).pathname;
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

function orthonormal(ax) {
  for (const k of ['x', 'y', 'z']) close(norm(ax[k]), 1, 1e-9, `|${k}|`);
  close(dot(ax.x, ax.y), 0, 1e-9, 'x·y'); close(dot(ax.y, ax.z), 0, 1e-9, 'y·z'); close(dot(ax.z, ax.x), 0, 1e-9, 'z·x');
  const c = cross(ax.x, ax.y);
  close(dot(c, ax.z), 1, 1e-9, 'right-handed');
}

test('model: body axes per attitude mode, and the array incidence the power model assumes', () => {
  const sun = unit([0.3, -0.8, 0.52]), earth = unit([-0.9, 0.1, 0.4]), vel = [1.2, 0.4, -0.3], thrust = unit([0.2, 0.9, -0.4]), up = unit([0.1, -0.2, 0.97]);
  // burn: body +Y along the thrust; array output = sin(Sun angle from the thrust axis), as power.arrayFactor
  let ax = bodyAxes({ mode: 'burn', thrustDir: thrust, vel, sunDir: sun, earthDir: earth });
  orthonormal(ax);
  close(dot(ax.y, thrust), 1, 1e-12, 'burn y = thrust');
  close(arrayIncidence(toBody(ax, sun)), arrayFactor('burn', { sunDir: sun, burnDir: thrust }), 1e-12, 'burn incidence');
  assert.ok(dot(ax.z, earth) > 0, 'antenna side toward the Earth');
  // the array drive angle turns the panel normal (+Z at 0) onto the Sun's projection
  const sb = toBody(ax, sun), psi = arrayAngle(sb);
  const n = [Math.sin(psi), 0, Math.cos(psi)];
  close(dot(n, sb), arrayIncidence(sb), 1e-12, 'normal on the Sun projection');
  // coasting: square to the Sun, full output
  ax = bodyAxes({ mode: 'sun-point', vel, sunDir: sun, earthDir: earth });
  orthonormal(ax);
  close(dot(ax.y, sun), 0, 1e-12, 'coast y ⟂ Sun');
  close(arrayIncidence(toBody(ax, sun)), 1, 1e-12, 'coast incidence');
  // surface: upright; one-axis tracking about local up gives cos(elevation)
  ax = bodyAxes({ mode: 'surface', vel: [0, 0, 0], sunDir: sun, earthDir: earth, up });
  orthonormal(ax);
  close(dot(ax.y, up), 1, 1e-12, 'surface y = up');
  close(arrayIncidence(toBody(ax, sun)), arrayFactor('surface', { sunDir: sun, up, tracking: 'one-axis' }), 1e-12, 'surface incidence');
  // degenerate inputs still give a frame
  orthonormal(bodyAxes({ mode: 'sun-point', vel: sun, sunDir: sun }));
  orthonormal(bodyAxes({ mode: 'burn' }));
  assert.equal(attitudeMode('approach-moon'), 'sun-point');
  assert.equal(attitudeMode('descent-coast'), 'sun-point');
  assert.equal(attitudeMode('braking'), 'burn');
});

test('model: along the real mission the drawn array gets the power model’s illumination', () => {
  const eph = createEphemeris(JSON.parse(readFileSync(`${demo}data/ephemeris.json`, 'utf8')));
  const sites = JSON.parse(readFileSync(`${demo}data/sites.json`, 'utf8'));
  const plan = planMission({ eph, site: sites.find((s) => s.id === 'shackleton'), landingMs: Date.parse('2027-01-10T02:00:00Z') });
  const seen = new Set();
  for (const ph of plan.phases) {
    for (const f of [0.2, 0.5, 0.8]) {
      const st = plan.stateAt(ph.startMs + (ph.endMs - ph.startMs) * f);
      const a = attitudeState(st, plan);
      orthonormal(a.axes);
      const up = unit(st.pos);
      const want = arrayFactor(a.mode, { sunDir: st.sunDir, burnDir: st.thrustDir ?? up, up, tracking: 'one-axis', sunElDeg: st.local?.sun?.elDeg });
      close(a.arrayIncidence, want, a.mode === 'surface' ? 0.01 : 1e-9, `${st.phase} array`);
      if (st.throttle > 0 && st.thrustDir) close(dot(a.axes.y, st.thrustDir), 1, 1e-9, `${st.phase} along the thrust`);
      assert.equal(a.stage, st.tliStageAttached, `${st.phase} stage`);
      seen.add(a.mode);
    }
  }
  for (const m of ['sun-point', 'burn', 'descent', 'surface']) assert.ok(seen.has(m), m);
});

test('model: drawn at real size close up, enlarged and labelled when far', () => {
  assert.deepEqual(drawScale(5, 1), { s: 1, times: 1 });   // 5 m away in a metre scene: real size
  const far = drawScale(4500, 1, 0.05);                     // 4.5 km away: drawn about 5 % of the distance across
  close(far.times, (4500 * 0.05) / LANDER_DIMS.footprintM, 1e-9, 'enlargement');
  close(drawScale(420, 0.001, 0.05).times, (420e3 * 0.05) / LANDER_DIMS.footprintM, 1e-6, 'km scene');
  assert.equal(sizeNote(1.2), '');
  assert.equal(sizeNote(3.25), 'drawn 3.3× real size');
  assert.equal(sizeNote(48), 'drawn 48× real size');
  assert.equal(sizeNote(330412), 'drawn 330,000× real size');
});

test('model: the mesh has its parts at real size and articulates array, dish, plumes and stage', () => {
  globalThis.window = globalThis;
  vm.runInThisContext(readFileSync(`${demo}vendor/three.classic.js`, 'utf8'));
  const T = globalThis.THREE;
  const m = buildLanderModel();
  m.articulate({ sunBody: [0, 0, 1], earthBody: [0, 1, 0], throttle: 0, stageAttached: false });
  // bounding box of what is shown (Box3.setFromObject would include the hidden stage and plumes)
  const box = new T.Box3();
  m.group.updateMatrixWorld(true);
  const shown = (o) => { for (let q = o; q; q = q.parent) if (!q.visible) return false; return true; };
  m.group.traverse((o) => { if (o.isMesh && shown(o)) box.union(new T.Box3().setFromObject(o)); });
  const size = box.getSize(new T.Vector3());
  close(Math.max(size.x, size.z), LANDER_DIMS.arraySpanM + 1.6, 0.6, 'widest: array wing out to ~3.8 m from the axis plus the far footpad');
  close(size.y, LANDER_DIMS.heightM, 0.25, 'height');
  close(box.min.y, 0, 0.05, 'footpads on y = 0');
  const ids = m.parts().map((p) => p.id);
  for (const id of ['engine', 'legs', 'array', 'antenna', 'tanks', 'rcs']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('stage'));
  // Sun on body +X: the array drive turns 90° so the panel normal (+Z) faces +X; Earth on −X: the dish turns to it
  m.articulate({ sunBody: [1, 0, 0], earthBody: [-1, 0, 0], throttle: 0.8, stageAttached: true, stageFiring: false });
  const arr = m.parts().find((p) => p.id === 'array').pos;
  assert.ok(arr.z < -1.5, `wing swung round to −Z (${arr.z.toFixed(2)})`);
  const ant = m.parts().find((p) => p.id === 'antenna').pos;
  assert.ok(ant.x < -0.8, `dish tipped toward −X (${ant.x.toFixed(2)})`);
  assert.ok(m.plume.visible, 'main engine plume at 80 %');
  assert.ok(m.parts().some((p) => p.id === 'stage'), 'stage shown while attached');
  m.articulate({ sunBody: [0, 0, 1], earthBody: [0, 1, 0], throttle: 1, stageAttached: true, stageFiring: true });
  assert.ok(!m.plume.visible, 'the stage fires, not the lander');
  m.articulate({ throttle: 0, stageAttached: false });
  assert.ok(!m.plume.visible && !m.parts().some((p) => p.id === 'stage'));
});
