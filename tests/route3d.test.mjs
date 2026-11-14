// Phase 6: the route handed to the 3D globe (demo/src/route3d.js) and the rover's state over time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, parsePayload, timeSpan, roverAt, frameRoute, FLAGS } from '../demo/src/route3d.js';
import { simulateDrive } from '../demo/src/route-energy.js';
import { toXY } from '../demo/src/terrain.js';

const MOB = { climbDeg: 15, descentDeg: 20, crossDeg: 12, speedKmh: 1 };
const T0 = Date.UTC(2027, 0, 13);
// a 10 km straight drive near the pole, 100 samples of 0.1 km
const [x0, y0] = toXY(-89, 30);
const profile = { x: Float32Array.from({ length: 100 }, (_, i) => x0 + i * 0.1), y: new Float32Array(100).fill(y0), km: new Float32Array(100).fill(0.1), pitch: new Float32Array(100) };
const route = { id: 'short', label: 'Shortest', lengthKm: 10, profile, oneWay: [[[x0 + 2, y0], [x0 + 3, y0]]] };
const lit = () => ({ sunDeg: 5, earthDeg: 5, azDeg: 90, elDeg: 2, earthAzDeg: 0, earthElDeg: 5 });

test('payload: points with km, times, battery and flags; one-way samples marked; JSON round trip', () => {
  const drive = simulateDrive(profile, { mob: MOB, power: { panelW: 600 }, departMs: T0, sky: lit });
  const links = { ok: Uint8Array.from({ length: 100 }, (_, i) => (i < 50 ? 1 : 0)) };
  const p = buildPayload({ route, drive, links, power: { batteryWh: 4000, reserve: 0.2 }, maxPts: 25 });
  assert.equal(p.v, 1);
  assert.ok(p.pts.length >= 25 && p.pts.length <= 27, `${p.pts.length} points`);
  assert.equal(p.pts[0][2], 0);
  assert.ok(Math.abs(p.pts.at(-1)[2] - 9.9) < 1e-6);
  assert.ok(p.pts.every((q) => Number.isFinite(q[3]) && q[4] === 1), 'all reached, battery full in the Sun');
  assert.ok(p.pts.some((q) => q[5] & FLAGS.oneWay) && p.pts.some((q) => !(q[5] & FLAGS.oneWay)));
  assert.ok(p.pts[0][5] & FLAGS.station && !(p.pts.at(-1)[5] & FLAGS.station));
  assert.deepEqual(parsePayload(JSON.stringify(p)), p);
  assert.equal(parsePayload('{"v":2}'), null);
  assert.equal(parsePayload('not json'), null);
});

test('rover: interpolated along the route in time, arrives at the end', () => {
  const drive = simulateDrive(profile, { mob: MOB, power: { panelW: 600 }, departMs: T0, sky: lit });
  const p = parsePayload(JSON.stringify(buildPayload({ route, drive, power: {}, maxPts: 100 })));
  const [a, b] = timeSpan(p);
  assert.equal(a, T0);
  assert.ok(Math.abs(b - (T0 + 10 * 3600e3)) < 2);
  assert.equal(roverAt(p, T0 - 1).state, 'ready');
  const mid = roverAt(p, T0 + 5 * 3600e3);
  assert.equal(mid.state, 'driving');
  assert.ok(Math.abs(mid.km - 5) < 0.15, `km ${mid.km} at 5 h`);
  assert.equal(roverAt(p, b + 1).state, 'arrived');
});

test('rover: waits at a parking stop, and stops where the battery ran out', () => {
  // dark for 30 h then lit: the drive parks once (see route-energy tests), then goes on
  const sky = (x, y, t) => (t < T0 + 30 * 3600e3 ? { ...lit(), sunDeg: -5 } : lit());
  const drive = simulateDrive({ ...profile, km: new Float32Array(100).fill(0.2) }, { mob: MOB, power: { batteryWh: 2000, loadW: 10, driveW: 150, panelW: 500, reserve: 0.2 }, departMs: T0, sky });
  assert.equal(drive.stops.length, 1);
  const p = parsePayload(JSON.stringify(buildPayload({ route: { ...route, profile: { ...profile, km: new Float32Array(100).fill(0.2) } }, drive, power: { batteryWh: 2000, reserve: 0.2 } })));
  const st = p.stops[0];
  const during = roverAt(p, (st.fromMs + st.toMs) / 2);
  assert.equal(during.state, 'parked');
  assert.ok(Math.abs(during.km - st.km) < 1e-6);
  const after = roverAt(p, st.toMs + 1800e3);
  assert.equal(after.state, 'driving');
  assert.ok(after.km > st.km && after.km < st.km + 1, `${after.km} km half an hour after leaving the stop at ${st.km}`);

  const dead = simulateDrive(profile, { mob: MOB, power: { batteryWh: 500, reserve: 0 }, departMs: T0, sky: () => ({ ...lit(), sunDeg: -5 }) });
  const q = parsePayload(JSON.stringify(buildPayload({ route, drive: dead, power: { batteryWh: 500 } })));
  assert.ok(q.emptyAt);
  const end = roverAt(q, timeSpan(q)[1] + 1);
  assert.equal(end.state, 'empty');
  assert.ok(Math.abs(end.km - q.emptyAt.km) < 1e-6);
  assert.ok(q.pts.some((r) => r[3] === null), 'points after the empty battery have no time');
});

test('frameRoute centres on the route and sizes the view to it', () => {
  const p = buildPayload({ route, power: {} });
  const f = frameRoute(p);
  assert.ok(Math.abs(f.lat - -89) < 0.2, `centre lat ${f.lat}`);
  assert.ok(f.dist > 10 && f.dist < 30, `dist ${f.dist}`);
  assert.equal(timeSpan(p), null, 'no drive, no time span');
  assert.equal(roverAt(p, T0).state, 'ready');
});
