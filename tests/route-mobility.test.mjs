// Phase 2 rover mobility (docs/PHASES.md): directional slope limits, one-way stretches, the return check,
// traps, and drive time. Synthetic terrains with known answers, then one real-terrain run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { planRoutes, cleanMobility, speedFactor, MOBILITY_DEFAULTS } from '../demo/src/route-plan.js';
import { createDem, toXY } from '../demo/src/terrain.js';

const KPP = 0.24, SIZE = 200, HALF = (SIZE * KPP) / 2;   // ±24 km around the pole
const xOf = (c) => -HALF + (c + 0.5) * KPP, yOf = (r) => HALF - (r + 0.5) * KPP;
function demFrom(fn) {
  const data = new Int16Array(SIZE * SIZE);
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) data[r * SIZE + c] = Math.round(fn(xOf(c), yOf(r)) / 0.5);
  return createDem({ data, size: SIZE, kmPerPixel: KPP, dnToMeters: 0.5 });
}
const fast = { yieldFn: () => Promise.resolve() };
const TAN = (deg) => Math.tan((deg * Math.PI) / 180);
const MOB = { descentDeg: 20, crossDeg: 12, speedKmh: 0.8 };   // climb 15° is maxSlopeDeg

// A scarp across the whole grid: high in the west, 19° down to the east between x = −2 and +2 km.
// Descending 19° is within 20°; climbing back is not, and no switchback helps: to climb within 15° on a
// 19° slope the rover must cross at ≥ 38.9° off the fall line, which puts 12.2° across it (limit 12°).
const scarp = demFrom((x) => (x < -2 ? 0 : x > 2 ? -4000 * TAN(19) : -(x + 2) * 1000 * TAN(19)));

test('one-way scarp: the route descends it, flags the stretch, and says the rover cannot drive back', async () => {
  const plan = await planRoutes({ points: [[-12, 0], [12, 0]], dem: scarp, maxSlopeDeg: 15, mobility: MOB }, fast);
  assert.ok(plan.ok, plan.error);
  assert.equal(plan.returnable, false);
  const r = plan.routes.find((x) => x.id === 'short');
  assert.ok(r.oneWayKm > 3 && r.oneWayKm < 5.5, `one-way ${r.oneWayKm} km`);
  assert.ok(r.oneWay.length >= 1 && r.oneWay[0][0][0] > -3 && r.oneWay.at(-1)[1][0] < 3, JSON.stringify(r.oneWay));
  assert.ok(r.descentMaxDeg > 17 && r.descentMaxDeg < 21, `descent ${r.descentMaxDeg}`);
  assert.ok(r.climbMaxDeg < 1, `climb ${r.climbMaxDeg}`);
  assert.equal(plan.mobility.climbDeg, 15);
});

test('one-way scarp, the other way: no route climbs it within the limits', async () => {
  const plan = await planRoutes({ points: [[12, 0], [-12, 0]], dem: scarp, maxSlopeDeg: 15, mobility: MOB }, fast);
  assert.equal(plan.ok, false);
  assert.match(plan.error, /climb \(15°\), descent \(20°\) and cross-slope \(12°\)/);
});

// Switchbacks are limited to the planner's 16 move directions (26.6° apart): on 17° the window of headings
// that climbs within 15° and keeps under 12° across (28.7°–44° off the fall line) falls between two of them,
// so the planner is conservative there. On 16° the 26.6° move fits (15.0° up, 7.4° across).
test('a gentler scarp (16°) can be climbed back by switchbacks, so the trip is returnable', async () => {
  const gentle = demFrom((x) => (x < -2 ? 0 : x > 2 ? -4000 * TAN(16) : -(x + 2) * 1000 * TAN(16)));
  const down = await planRoutes({ points: [[-12, 0], [12, 0]], dem: gentle, maxSlopeDeg: 15, mobility: MOB }, fast);
  assert.ok(down.ok, down.error);
  assert.equal(down.returnable, true);
  const up = await planRoutes({ points: [[12, 0], [-12, 0]], dem: gentle, maxSlopeDeg: 15, mobility: MOB }, fast);
  assert.ok(up.ok, up.error);
  const r = up.routes.find((x) => x.id === 'short');
  assert.ok(r.climbMaxDeg <= 15.5, `climbs at ${r.climbMaxDeg}° (switchbacks keep it near 15°)`);
  assert.ok(r.crossMaxDeg <= 12.5, `across ${r.crossMaxDeg}°`);
  assert.ok(r.lengthKm > 24.3, `switchbacks at 26.6° over the 4 km scarp add ~0.47 km to the straight 24 km: ${r.lengthKm}`);
});

// A bowl next to the route: flat floor r < 1 km, 19° walls to the rim at r = 3 km. The rover could drive in
// but not out (same reason as the scarp), so it is a trap; the route itself keeps out of it.
const bowl = demFrom((x, y) => { const r = Math.hypot(x, y - 5); return r < 1 ? -2000 * TAN(19) : r < 3 ? -(3 - r) * 1000 * TAN(19) : 0; });

test('traps: a steep bowl beside the route is reported, and the route avoids it', async () => {
  const plan = await planRoutes({ points: [[-12, 0], [12, 0]], dem: bowl, maxSlopeDeg: 15, mobility: MOB }, fast);
  assert.ok(plan.ok, plan.error);
  assert.equal(plan.returnable, true);
  assert.ok(plan.traps.km2 > 10 && plan.traps.km2 < 32, `trap area ${plan.traps.km2} km²`);
  for (const [x, y] of plan.traps.cells) assert.ok(Math.hypot(x, y - 5) < 3.3, `trap cell at ${x}, ${y}`);
  const r = plan.routes.find((x) => x.id === 'short');
  for (const [x, y] of r.points) assert.ok(Math.hypot(x, y - 5) > 2.5, 'route stays out of the bowl');
});

test('flat ground: nothing one-way, no traps, returnable, drive time = length / speed', async () => {
  const flat = demFrom(() => 0);
  const plan = await planRoutes({ points: [[-10, -2], [10, 3]], dem: flat, maxSlopeDeg: 15, mobility: { speedKmh: 0.5 } }, fast);
  assert.ok(plan.ok);
  assert.equal(plan.returnable, true);
  assert.equal(plan.traps.km2, 0);
  const r = plan.routes.find((x) => x.id === 'short');
  assert.equal(r.oneWayKm, 0);
  assert.ok(Math.abs(r.hours - r.lengthKm / 0.5) < 1e-6 * r.hours, `${r.hours} h for ${r.lengthKm} km`);
  assert.deepEqual(plan.mobility, { climbDeg: 15, descentDeg: MOBILITY_DEFAULTS.descentDeg, crossDeg: MOBILITY_DEFAULTS.crossDeg, speedKmh: 0.5 });
});

test('without mobility the plan has none of the phase 2 fields', async () => {
  const plan = await planRoutes({ points: [[-10, 0], [10, 0]], dem: scarp, maxSlopeDeg: 20 }, fast);
  assert.ok(plan.ok);
  assert.equal(plan.returnable, undefined);
  assert.equal(plan.traps, undefined);
  assert.equal(plan.routes[0].oneWayKm, undefined);
});

test('cleanMobility clamps and fills defaults; speedFactor slows climbs more than descents', () => {
  assert.equal(cleanMobility(null, 15), null);
  assert.deepEqual(cleanMobility({ descentDeg: 99, crossDeg: 'x', speedKmh: 0 }, 15), { climbDeg: 15, descentDeg: 45, crossDeg: MOBILITY_DEFAULTS.crossDeg, speedKmh: 0.01 });
  const m = { climbDeg: 15, descentDeg: 20 };
  assert.equal(speedFactor(0, m), 1);
  assert.ok(Math.abs(speedFactor(TAN(15), m) - 0.5) < 1e-12);
  assert.ok(Math.abs(speedFactor(-TAN(20), m) - 0.7) < 1e-12);
});

// ---------- real terrain ----------
const DATA = new URL('../demo/data/', import.meta.url);
const real = existsSync(new URL('dem_240m.bin', DATA)) && existsSync(new URL('terrain.json', DATA));

test('real terrain: Shackleton ridge to de Gerlache rim with the default rover limits', { skip: !real && 'dem_240m not here' }, async () => {
  const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA)));
  const l = meta.levels.find((x) => x.name === 'dem_240m');
  const b = readFileSync(new URL(l.file, DATA));
  const dem = createDem({ data: new Int16Array(b.buffer, b.byteOffset, b.length / 2), size: l.size, kmPerPixel: l.kmPerPixel, dnToMeters: l.dnToMeters, halfKm: l.halfKm });
  const sites = JSON.parse(readFileSync(new URL('sites.json', DATA)));
  const at = (id) => { const s = sites.find((x) => x.id === id); return toXY(s.latDeg, s.lonDeg); };
  const plan = await planRoutes({ points: [at('shackleton'), at('de-gerlache-rim-2')], dem, maxSlopeDeg: 15, mobility: {} }, fast);
  assert.ok(plan.ok, plan.error);
  assert.equal(typeof plan.returnable, 'boolean');
  for (const r of plan.routes.filter((x) => x.points)) {
    assert.ok(r.climbMaxDeg <= 15 + 3, `${r.id} climbs ${r.climbMaxDeg}°`);   // samples between nodes may exceed the node-pair test slightly
    assert.ok(r.hours > r.lengthKm / MOBILITY_DEFAULTS.speedKmh, 'slopes slow the rover down');
  }
});
