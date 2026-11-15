// Regions anywhere on the Moon (demo/src/georegion.js): shapes in latitude and longitude, their hash form, inside
// tests, areas and smooth-horizon Sun / Earth shares.
import test from 'node:test';
import assert from 'node:assert/strict';
import { geoRect, geoCircle, geoPolygon, geoParam, parseGeo, geoContains, geoAreaKm2, geoStats, geoOutline, MOON_R_KM } from '../demo/src/georegion.js';

const near = (a, b, eps) => Math.abs(a - b) <= eps;

test('a box from two corners takes the shorter way round and survives the hash', () => {
  const r = geoRect({ latDeg: 10, lonDeg: 350 }, { latDeg: 20, lonDeg: 5 });
  assert.equal(r.lonW, 350);
  assert.equal(r.spanDeg, 15);
  const back = parseGeo(...geoParam(r).split(/:(.*)/s).slice(0, 2));
  assert.deepEqual(back, r);
  const inside = geoContains(r);
  assert.ok(inside(15, 0) && inside(15, 355) && !inside(15, 10) && !inside(25, 0));
});

test('a cap: centre and edge give the radius, the area is the spherical cap', () => {
  const c = geoCircle({ latDeg: 0, lonDeg: 0 }, { latDeg: 0, lonDeg: 1 });
  assert.ok(near(c.rKm, MOON_R_KM * Math.PI / 180, 0.01));
  assert.ok(near(geoAreaKm2(c), Math.PI * c.rKm * c.rKm, 1));   // small cap ≈ flat disc
  const inside = geoContains(c);
  assert.ok(inside(0, 0.5) && !inside(0, 1.5));
  assert.ok(geoOutline(c).length > 90);
});

test('a polygon has great-circle edges and an even-odd inside', () => {
  const p = geoPolygon([{ latDeg: 0, lonDeg: 0 }, { latDeg: 0, lonDeg: 10 }, { latDeg: 10, lonDeg: 5 }]);
  const inside = geoContains(p);
  assert.ok(inside(3, 5) && !inside(-1, 5) && !inside(9, 1));
  assert.deepEqual(parseGeo('gpoly', geoParam(p).slice(6)), p);
});

test('smooth-horizon shares: the Sun over the region half the time, the Earth always on the near side', () => {
  // the Sun goes round the equator once in 28 days, the Earth stays over 0°E
  const DAY = 86400e3, eph = { at: (t) => { const a = (2 * Math.PI * t) / (28 * DAY); return { sun: [Math.cos(a), Math.sin(a), 0], earth: [1, 0, 0] }; } };
  const r = geoRect({ latDeg: -5, lonDeg: -5 }, { latDeg: 5, lonDeg: 5 });
  const s = geoStats(r, eph, 0, 28 * DAY, { stepMs: 3600e3 });
  assert.ok(near(s.sun, 0.5, 0.02));
  assert.ok(near(s.earth, 1, 1e-9));
  assert.ok(near(s.both, 0.5, 0.02));
  assert.ok(s.cells > 50 && s.pass === null && s.score === null);
  assert.ok(near(s.areaKm2, geoAreaKm2(r), 1e-6));
});
