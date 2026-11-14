// The rover's pitch, roll and yaw from the terrain (demo/src/rover-attitude.js), on planes with known answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attitudeAt, bearingDeg, compassName, limitLevel } from '../demo/src/rover-attitude.js';

const KM_PER_DEG = (1737.4 * Math.PI) / 180;
const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);
// a plane rising to the north at 10° (heights in metres, lat/lon near the equator where degrees are square)
const north10 = (lat) => lat * KM_PER_DEG * 1000 * Math.tan((10 * Math.PI) / 180);

test('driving uphill (north on a north-rising slope): pitch +10°, no roll', () => {
  const a = attitudeAt(north10, 0, 30, 0, 0.01);
  near(a.pitchDeg, 10, 0.01); near(a.rollDeg, 0, 0.01); near(a.slopeDeg, 10, 0.01);
  near(a.downhillDeg, 180, 0.01, 'downhill is south');
});

test('driving downhill: pitch −10°; driving east across it: roll −10° (right side down)', () => {
  near(attitudeAt(north10, 0, 30, 180, 0.01).pitchDeg, -10, 0.01);
  const east = attitudeAt(north10, 0, 30, 90, 0.01);
  near(east.pitchDeg, 0, 0.01);
  near(east.rollDeg, -10, 0.01, 'heading east, the slope rises to the left: right side down');
  near(attitudeAt(north10, 0, 30, 270, 0.01).rollDeg, 10, 0.01, 'heading west: right side up');
});

test('at 45° off the fall line both pitch and roll share the slope', () => {
  const a = attitudeAt(north10, 0, 30, 45, 0.01);
  const t = Math.tan((10 * Math.PI) / 180) / Math.SQRT2;
  near(a.pitchDeg, (Math.atan(t) * 180) / Math.PI, 0.01);
  near(a.rollDeg, -(Math.atan(t) * 180) / Math.PI, 0.01);
});

test('bearings, compass names and limit levels', () => {
  near(bearingDeg(0, 0, 1, 0), 0, 1e-9);
  near(bearingDeg(0, 0, 0, 1), 90, 1e-9);
  assert.equal(compassName(247), 'WSW');
  assert.equal(compassName(359), 'N');
  assert.equal(limitLevel(5, 15), 'ok');
  assert.equal(limitLevel(-12, 15), 'near');
  assert.equal(limitLevel(16, 15), 'over');
  assert.equal(attitudeAt(() => NaN, 0, 0, 0, 0.01), null);
});
