import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_ZOOM, MAX_ZOOM, FULL_VIEW, viewHalfKm, clampView, kmPerPx, toPx, toKm, zoomAt, panBy, viewBounds } from '../demo/src/map/view.js';

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('zoom 1 at the centre is the phase 2 map: ±320 km over the frame', () => {
  assert.equal(MIN_ZOOM, 1); assert.equal(MAX_ZOOM, 32);   // phase 4: was 12
  assert.deepEqual(viewBounds(FULL_VIEW), { x0: -320, y0: -320, x1: 320, y1: 320 });
  assert.equal(kmPerPx(FULL_VIEW, 500), 640 / 500);
  assert.deepEqual(toPx(FULL_VIEW, 500, 0, 0), [250, 250]);
  assert.deepEqual(toPx(FULL_VIEW, 500, -320, 320), [0, 0]);     // top left is (-x, +y)
  assert.deepEqual(toPx(FULL_VIEW, 500, 320, -320), [500, 500]);
  assert.equal(viewHalfKm({ cx: 0, cy: 0, zoom: 4 }), 80);
});

test('toPx and toKm are inverse', () => {
  for (const view of [FULL_VIEW, { cx: 31.5, cy: -77.25, zoom: 3.7 }, { cx: -290, cy: 293, zoom: 12 }]) {
    for (const [x, y] of [[0, 0], [12.3, -45.6], [-300, 299], [view.cx, view.cy]]) {
      const [px, py] = toPx(view, 437, x, y);
      const [x2, y2] = toKm(view, 437, px, py);
      assert.ok(near(x, x2, 1e-9) && near(y, y2, 1e-9), `${x},${y} -> ${x2},${y2}`);
    }
    for (const [px, py] of [[0, 0], [437, 437], [100.5, 250.25]]) {
      const [x, y] = toKm(view, 437, px, py);
      const [px2, py2] = toPx(view, 437, x, y);
      assert.ok(near(px, px2, 1e-9) && near(py, py2, 1e-9));
    }
  }
});

test('zoomAt keeps the ground point under the cursor where it is', () => {
  const size = 500;
  let view = FULL_VIEW;
  const cursors = [[300, 210], [120, 380], [250, 250], [260, 240]];
  for (const factor of [1.25, 2, 1.5, 1.1]) {
    const [px, py] = cursors.shift();
    const before = toKm(view, size, px, py);
    const next = zoomAt(view, size, px, py, factor);
    assert.ok(near(next.zoom, Math.min(MAX_ZOOM, view.zoom * factor)));
    const after = toKm(next, size, px, py);
    assert.ok(near(before[0], after[0], 1e-9) && near(before[1], after[1], 1e-9), `${before} vs ${after}`);
    view = next;
  }
  // zooming out again also keeps the point (away from the edges, where the clamp takes over)
  const before = toKm(view, size, 240, 260);
  const out = zoomAt(view, size, 240, 260, 0.8);
  const after = toKm(out, size, 240, 260);
  assert.ok(near(before[0], after[0], 1e-9) && near(before[1], after[1], 1e-9));
  // zoom stays within 1–MAX_ZOOM (32 since phase 4)
  assert.equal(zoomAt(FULL_VIEW, size, 10, 10, 0.5).zoom, 1);
  assert.equal(zoomAt({ cx: 0, cy: 0, zoom: 10 }, size, 250, 250, 4).zoom, MAX_ZOOM);
});

test('clamp never lets the viewport leave ±320 km', () => {
  const inside = (v) => { const b = viewBounds(v); return b.x0 >= -320 - 1e-9 && b.x1 <= 320 + 1e-9 && b.y0 >= -320 - 1e-9 && b.y1 <= 320 + 1e-9; };
  assert.deepEqual(clampView({ cx: 100, cy: -50, zoom: 1 }), { cx: 0, cy: 0, zoom: 1 });
  assert.deepEqual(clampView({ cx: 500, cy: -500, zoom: 2 }), { cx: 160, cy: -160, zoom: 2 });
  assert.deepEqual(clampView({ cx: NaN, cy: 3, zoom: 40 }), { cx: 0, cy: 3, zoom: MAX_ZOOM });
  assert.deepEqual(clampView({ cx: 0, cy: 0, zoom: 0.2 }), { cx: 0, cy: 0, zoom: 1 });
  assert.deepEqual(clampView(undefined), { cx: 0, cy: 0, zoom: 1 });
  let v = { cx: 0, cy: 0, zoom: 3 };
  for (let n = 0; n < 50; n++) { v = panBy(v, 400, 37, -53); assert.ok(inside(v)); }
  assert.ok(near(v.cx, -(320 - 320 / 3)) && near(v.cy, -(320 - 320 / 3)));
  for (let n = 0; n < 30; n++) { v = zoomAt(v, 400, 0, 400, 0.9); assert.ok(inside(v), JSON.stringify(v)); }
  for (let n = 0; n < 30; n++) { v = zoomAt(v, 400, 399, 1, 1.3); assert.ok(inside(v), JSON.stringify(v)); }
});

test('panBy moves the ground with the pointer', () => {
  const v = { cx: 10, cy: 20, zoom: 4 };
  const [x, y] = toKm(v, 500, 200, 200);
  const next = panBy(v, 500, 30, -12);
  const [x2, y2] = toKm(next, 500, 230, 188);
  assert.ok(near(x, x2) && near(y, y2));
  assert.equal(next.zoom, 4);
});
