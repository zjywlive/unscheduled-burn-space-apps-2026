// Fix R9: the Coordinates form's pure helpers (demo/src/ui/shapeentry.js): typed fields → the same shape
// objects the drawing tools make, and shapes → fields for fine-tuning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeFromFields, fieldsFromShape, blankFields, MAX_RADIUS_KM } from '../demo/src/ui/shapeentry.js';
import { toXY } from '../demo/src/terrain.js';
import { areaKm2 } from '../demo/src/map/shapes.js';

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

test('shape entry: a circle at 89.45S 222.6E, radius 5 km', () => {
  const r = shapeFromFields('circle', { rows: [{ lat: '89.45S', lon: '222.6E' }], r: '5' });
  const [cx, cy] = toXY(-89.45, 222.6);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.shape), ['type', 'cx', 'cy', 'rKm']);
  assert.equal(r.shape.type, 'circle');
  assert.ok(near(r.shape.cx, cx) && near(r.shape.cy, cy));
  assert.equal(r.shape.rKm, 5);
  assert.ok(near(areaKm2(r.shape), Math.PI * 25, 1e-6));
  const bad = shapeFromFields('circle', { rows: [{ lat: '89.45S', lon: '222.6E' }], r: String(MAX_RADIUS_KM + 1) });
  assert.deepEqual(bad.errors.map((e) => e.key), ['r']);
});

test('shape entry: point, rectangle and polygon', () => {
  const p = shapeFromFields('select', { rows: [{ lat: '-89.45', lon: '-137.31' }] });
  assert.equal(p.ok, true);
  assert.ok(near(p.point.lonDeg, 222.69, 1e-9) && near(p.point.latDeg, -89.45));
  assert.deepEqual(p.point.xy, toXY(-89.45, p.point.lonDeg));
  const a = toXY(-89, 45), b = toXY(-88, 135);
  const rect = shapeFromFields('rect', { rows: [{ lat: '-88', lon: '135' }, { lat: '-89', lon: '45' }] });
  assert.equal(rect.ok, true);
  // as draw.js makes it: sorted corners, square to the map
  assert.deepEqual(rect.shape, { type: 'rect', x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) });
  const flat = shapeFromFields('rect', { rows: [{ lat: '-89', lon: '0' }, { lat: '-88', lon: '0' }] });   // same x on the map
  assert.equal(flat.ok, false); assert.match(flat.formError, /both directions/);
  const poly = shapeFromFields('polygon', { rows: [{ lat: '-88', lon: '0' }, { lat: '-88', lon: '120' }, { lat: '-88', lon: '240' }] });
  assert.equal(poly.ok, true);
  assert.equal(poly.shape.points.length, 3);
  assert.deepEqual(poly.shape.points[1], toXY(-88, 120));
  const bow = shapeFromFields('polygon', { rows: [{ lat: '-88', lon: '0' }, { lat: '-88', lon: '180' }, { lat: '-88', lon: '90' }, { lat: '-88', lon: '270' }] });
  assert.equal(bow.ok, false); assert.match(bow.formError, /cross/);
  const two = shapeFromFields('polygon', { rows: [{ lat: '-88', lon: '0' }, { lat: '-88', lon: '120' }] });
  assert.equal(two.ok, false); assert.match(two.formError, /at least 3/);
  const errs = shapeFromFields('polygon', { rows: [{ lat: '-95', lon: '0' }, { lat: '-88', lon: 'x' }, { lat: '', lon: '' }] });
  assert.deepEqual(errs.errors.map((e) => e.key), ['0:lat', '1:lon', '2:lat', '2:lon']);   // every wrong field
  assert.deepEqual(shapeFromFields('point', { rows: [{ lat: '-75', lon: '400' }] }).errors.map((e) => e.key), ['0:lat', '0:lon']);
  assert.deepEqual(blankFields('circle'), { rows: [{ lat: '', lon: '' }], r: '' });
  assert.equal(blankFields('polygon').rows.length, 3);
});

test('shape entry: shape → fields → shape round trip (to the 3 decimals the fields show)', () => {
  const shapes = [
    { type: 'circle', cx: -11.3, cy: -12.3, rKm: 4.25 },
    { type: 'rect', x0: -30.2, y0: 10.1, x1: -5.7, y1: 40.9 },
    { type: 'polygon', points: [[-40, 10], [-20, 30], [0, 5], [-10, -15]] },
  ];
  for (const s of shapes) {
    const f = fieldsFromShape(s);
    const back = shapeFromFields(s.type, f).shape;
    assert.equal(back.type, s.type);
    // 0.001° of latitude is ≈ 30 m; of longitude at 85 km from the pole ≈ 1.5 m
    const tol = 0.05;
    if (s.type === 'circle') assert.ok(near(back.cx, s.cx, tol) && near(back.cy, s.cy, tol) && back.rKm === s.rKm);
    if (s.type === 'rect') for (const k of ['x0', 'y0', 'x1', 'y1']) assert.ok(near(back[k], s[k], tol), k);
    if (s.type === 'polygon') s.points.forEach((p, i) => assert.ok(near(back.points[i][0], p[0], tol) && near(back.points[i][1], p[1], tol)));
  }
  assert.deepEqual(fieldsFromShape({ latDeg: -89.45, lonDeg: 222.69 }), { rows: [{ lat: '−89.450', lon: '222.690' }] });
  assert.equal(fieldsFromShape(null), null);
});

test('north of 80°S the form reads and makes regions in latitude and longitude', async () => {
  const { geoParam } = await import('../demo/src/georegion.js');
  const r = shapeFromFields('rect', { rows: [{ lat: '-10', lon: '20' }, { lat: '5', lon: '30' }] });
  assert.equal(r.ok, true);
  assert.equal(geoParam(r.shape), 'grect:-10,20,5,10');
  const back = fieldsFromShape(r.shape);
  assert.deepEqual(shapeFromFields('rect', back).shape, r.shape);
  const c = shapeFromFields('circle', { rows: [{ lat: '0', lon: '45' }], r: '50' });
  assert.ok(c.ok && c.shape.geo && c.shape.rKm === 50);
  const p = shapeFromFields('polygon', { rows: [{ lat: '0', lon: '0' }, { lat: '0', lon: '10' }, { lat: '10', lon: '5' }] });
  assert.ok(p.ok && p.shape.geo && p.shape.pts.length === 3);
  // south of 80°S: map km as before
  const polar = shapeFromFields('circle', { rows: [{ lat: '-89', lon: '0' }], r: '5' });
  assert.ok(polar.ok && !polar.shape.geo && Number.isFinite(polar.shape.cx));
});
