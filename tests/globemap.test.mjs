// The Map as the 3D Moon (demo/src/ui/globemap.js): the polar map's view that covers the ground in sight, the
// camera distance for a polar view, and the heading that keeps the polar map's names upright.
import test from 'node:test';
import assert from 'node:assert/strict';
import { viewCovering, distForZoom, northUp } from '../demo/src/ui/globemap.js';

const geo = { W: 1440, H: 900, Cx: 720, Cy: 478, Sref: 790 };
const bounds = (v) => { const k = 640 / (v.zoom * geo.Sref); return { x0: v.cx - geo.Cx * k, x1: v.cx + (geo.W - geo.Cx) * k, y0: v.cy - (geo.H - geo.Cy) * k, y1: v.cy + geo.Cy * k }; };

test('the polar view covers the box in sight, centred on it', () => {
  const box = { x0: -40, x1: 10, y0: -20, y1: 20 };
  const v = viewCovering(box, geo), b = bounds(v);
  assert.ok(b.x0 <= box.x0 + 1e-9 && b.x1 >= box.x1 - 1e-9 && b.y0 <= box.y0 + 1e-9 && b.y1 >= box.y1 - 1e-9, JSON.stringify(b));
  assert.ok(Math.abs((b.x0 + b.x1) / 2 + 15) < 1e-6 && Math.abs((b.y0 + b.y1) / 2) < 1e-6, 'centred');
  assert.equal(viewCovering({ x0: -400, x1: 400, y0: -400, y1: 400 }, geo).zoom, 1, 'never wider than the whole map');
  assert.equal(viewCovering({ x0: 0, x1: 0.01, y0: 0, y1: 0.01 }, geo).zoom, 32, 'never finer than 20 m terrain allows');
});

test('the camera distance shows about the same ground as the polar view', () => {
  const d1 = distForZoom(1, geo), d4 = distForZoom(4, geo);
  assert.ok(Math.abs(d1 / d4 - 4) < 1e-9);
  const visibleH = 2 * d1 * Math.tan((20 * Math.PI) / 180), mapH = (640 / geo.Sref) * geo.H;
  assert.ok(Math.abs(visibleH - mapH) / mapH < 1e-9);
});

test('near the south pole 0°E is up, as on the polar map; elsewhere north is up', () => {
  assert.equal(northUp(-89, 0), 0);
  assert.equal(northUp(-89, 200), 160);
  assert.equal(northUp(-85, 90), 270);
  assert.equal(northUp(10, 200), 0);
});

test('lines between two points follow the great circle, not the parallels', async () => {
  const { arcGc, onGc } = await import('../demo/src/globe-view.js');
  // two points on 88°S, half a turn apart: the straight line on the sphere runs over the pole
  const a = { latDeg: -88, lonDeg: 0 }, b = { latDeg: -88, lonDeg: 180 };
  assert.ok(Math.abs(arcGc(a, b) - (4 * Math.PI) / 180) < 1e-9);
  assert.ok(Math.abs(onGc(a, b, 0.5).latDeg + 90) < 1e-6);
  // a quarter of the way along stays on the 0° meridian at 89°S
  const q = onGc(a, b, 0.25);
  assert.ok(Math.abs(q.latDeg + 89) < 1e-9 && (Math.abs(q.lonDeg) < 1e-6 || Math.abs(q.lonDeg - 360) < 1e-6));
  // the ends are the points themselves
  assert.ok(Math.abs(onGc(a, b, 1).latDeg + 88) < 1e-9);
});
