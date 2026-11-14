// Phase 4: rectangular frames (view.js), paintHeat on a rectangular canvas and the deep-zoom heat style
// (T.7, revised in fix H; the smoothed display itself is in heat-smooth.test.mjs), and loadPacks (data-loader.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FULL_VIEW, MAX_ZOOM, kmPerPx, toPx, toKm, zoomAt, panBy, viewBounds,
  frameKmPerPx, frameToPx, frameToKm, frameZoomAt, framePanBy, frameBounds, frameGeometry, scaleFrame, unitPxForDisc,
} from '../demo/src/map/view.js';
import { paintHeat, deepHeatStyle, paintBase } from '../demo/src/map/layers.js';
import { loadPacks } from '../demo/src/data-loader.js';
import { withSoftCanvas, SoftCanvas } from './helpers/raster.mjs';

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('frame functions: a square frame is the square functions; a wide one is the same map shifted to its centre', () => {
  const views = [FULL_VIEW, { cx: 31.5, cy: -77.25, zoom: 3.7 }, { cx: -1.2, cy: 0.4, zoom: 32 }];
  const sq = { width: 500, height: 500, unitPx: 500 };
  for (const v of views) {
    assert.equal(frameKmPerPx(v, sq), kmPerPx(v, 500));
    assert.deepEqual(frameToPx(v, sq, 12.3, -45.6), toPx(v, 500, 12.3, -45.6));
    assert.deepEqual(frameToKm(v, sq, 100.5, 250.25), toKm(v, 500, 100.5, 250.25));
    assert.deepEqual(frameBounds(v, sq), viewBounds(v));
    assert.deepEqual(frameZoomAt(v, sq, 300, 210, 1.5), zoomAt(v, 500, 300, 210, 1.5));
    assert.deepEqual(framePanBy(v, sq, 30, -12), panBy(v, 500, 30, -12));
  }
  const wide = { width: 1440, height: 900, unitPx: 880 };
  for (const v of views) {
    const [px, py] = frameToPx(v, wide, 12.3, -45.6), [qx, qy] = toPx(v, 880, 12.3, -45.6);
    assert.ok(near(px, qx + (1440 - 880) / 2) && near(py, qy + (900 - 880) / 2));
    const [x, y] = frameToKm(v, wide, px, py);
    assert.ok(near(x, 12.3, 1e-9) && near(y, -45.6, 1e-9));
    const b = frameBounds(v, wide), k = frameKmPerPx(v, wide);
    assert.ok(near(b.x1 - b.x0, 1440 * k) && near(b.y1 - b.y0, 900 * k) && near((b.x0 + b.x1) / 2, v.cx) && near((b.y0 + b.y1) / 2, v.cy));
  }
  // zoomAt keeps the ground under the cursor (away from the clamp), up to MAX_ZOOM
  let v = { cx: 0, cy: 0, zoom: 2 };
  for (const f of [1.5, 2, 3, 2.2]) {
    const before = frameToKm(v, wide, 1000, 300);
    v = frameZoomAt(v, wide, 1000, 300, f);
    const after = frameToKm(v, wide, 1000, 300);
    assert.ok(near(before[0], after[0], 1e-9) && near(before[1], after[1], 1e-9));
  }
  assert.equal(frameZoomAt({ cx: 0, cy: 0, zoom: 30 }, wide, 720, 450, 4).zoom, MAX_ZOOM);
  const g = frameGeometry({ cx: 3, cy: 4, zoom: 8 }, scaleFrame(wide, 2));
  assert.deepEqual(g, { width: 2880, height: 1800, kmPerPx: kmPerPx({ zoom: 8 }, 1760), cx: 3, cy: 4 });
  // the layout mock: a 832 px disc of 80°S (radius 304.0 km) → unitPx such that 608 km spans 832 px
  assert.ok(near(unitPxForDisc(832, 304) * (2 * 304 / 640), 832, 1e-9));
});

// a gridSize² heat field with two classes in a pattern, drawn on a soft canvas over black
function heatCase(extra, { canvasW = 200, canvasH = 200 } = {}) {
  const gridSize = 8, values = new Float32Array(64);
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) values[j * 8 + i] = i < 4 ? 0.9 : 0.3;   // left half 5th step, right half 2nd
  return withSoftCanvas(() => {
    const canvas = new SoftCanvas(canvasW, canvasH);
    const ctx = canvas.getContext();
    for (let i = 3; i < canvas.img.data.length; i += 4) canvas.img.data[i] = 255;
    paintHeat(ctx, { mode: 'sun', values, gridSize, canvasSize: canvasW, colours: { sun: [242, 179, 61], earth: [0, 0, 0], both: [0, 0, 0], negative: [0, 0, 0] }, cellKm: 1, halfKm: 4, ...extra });
    return { canvas, ctx };
  });
}
const px = (canvas, x, y) => [...canvas.img.data.slice(4 * (y * canvas.width + x), 4 * (y * canvas.width + x) + 3)];

test('paintHeat frame: a square frame draws exactly what `view` draws; a wide frame puts the cells at frameToPx', () => {
  const view = { cx: 0, cy: 0, zoom: 80 };   // past MAX_ZOOM is fine here: 640/80 = 8 km over the canvas, one cell = 25 px
  const a = heatCase({ view });
  const b = heatCase({ frame: { width: 200, height: 200, kmPerPx: kmPerPx(view, 200), cx: 0, cy: 0 } });
  assert.ok(Buffer.from(a.canvas.img.data).equals(Buffer.from(b.canvas.img.data)));
  // style { fill 1, edge 0 } is a no-op
  const c = heatCase({ view, style: { fill: 1, edge: 0 } });
  assert.ok(Buffer.from(a.canvas.img.data).equals(Buffer.from(c.canvas.img.data)));
  // wide: 300 × 200 canvas at 0.04 km/px centred at (0, 0): cell (i 4, j 4) starts at x 0 km → px 150
  const w = heatCase({ frame: { width: 300, height: 200, kmPerPx: 0.04, cx: 0, cy: 0 } }, { canvasW: 300, canvasH: 200 });
  assert.deepEqual(px(w.canvas, 149, 120), px(w.canvas, 60, 120));   // left half colour (the grid spans px 50–250)
  assert.notDeepEqual(px(w.canvas, 150, 120), px(w.canvas, 149, 120));
  assert.deepEqual(px(w.canvas, 150, 120), px(w.canvas, 240, 10));   // right half colour
  assert.deepEqual(px(w.canvas, 20, 120), [0, 0, 0]);                // beyond the grid
  // paintBase takes a height
  withSoftCanvas(() => {
    const cv = new SoftCanvas(3, 2), ctx = cv.getContext();
    paintBase(ctx, Uint8ClampedArray.from([1, 2, 3, 4, 5, 6]), 3, 2);
    assert.deepEqual([...cv.img.data.filter((_, i) => i % 4 === 0)], [1, 2, 3, 4, 5, 6]);
  });
});

test('deepHeatStyle: automatic smoothing at every zoom; no edge bands; fill fades to 0.6 between zoom 12 and 24', () => {
  assert.deepEqual(deepHeatStyle(1), { fill: 1, edge: 0, edgePx: 2 });
  assert.deepEqual(deepHeatStyle(0.8, { edgePx: 1 }), { fill: 1, edge: 0, edgePx: 1 });
  // Smoothing is automatic even below 1 in the rectangular frame's equivalent square view.
  assert.deepEqual(deepHeatStyle(8), { fill: 1, edge: 0, edgePx: 2 });
  assert.deepEqual(deepHeatStyle(12), { fill: 1, edge: 0, edgePx: 2 });
  assert.ok(near(deepHeatStyle(18).fill, 0.8, 1e-4));
  assert.deepEqual(deepHeatStyle(24), { fill: 0.6, edge: 0, edgePx: 2 });
  assert.deepEqual(deepHeatStyle(32), { fill: 0.6, edge: 0, edgePx: 2 });
  assert.deepEqual(deepHeatStyle(18, { minFill: 0.5, edgePx: 4 }), { fill: 0.75, edge: 0, edgePx: 4 });
});

test('paintHeat style: cells keep their own flat colour (no interpolation), fainter; a band marks only the borders between steps', () => {
  const view = { cx: 0, cy: 0, zoom: 80 };   // 25 px cells
  const flat = heatCase({ view });
  const deep = heatCase({ view, style: { fill: 0.3, edge: 1, edgePx: 3, smooth: false } });
  const lum = (p) => p[0] + p[1] + p[2];
  // inside a cell, away from any border: one flat colour, fainter than the default
  const inA = px(deep.canvas, 37, 37), inA2 = px(deep.canvas, 45, 45);
  assert.deepEqual(inA, inA2);
  assert.ok(lum(inA) < lum(px(flat.canvas, 37, 37)) * 0.5);
  // between two cells of the same step (x = 25 at row 37): no band
  assert.deepEqual(px(deep.canvas, 24, 37), inA); assert.deepEqual(px(deep.canvas, 25, 37), inA);
  // across the step change at x = 100: a band on both sides, each in its own cell's colour and step opacity
  const bandL = px(deep.canvas, 98, 37), bandR = px(deep.canvas, 101, 37);
  assert.ok(lum(bandL) > lum(inA));
  const close = (p, q) => p.every((v, i) => Math.abs(v - q[i]) <= 2);
  assert.ok(close(bandL, px(flat.canvas, 98, 37)), `${bandL} vs ${px(flat.canvas, 98, 37)}`);   // the step's own opacity: the default colour
  assert.ok(close(bandR, px(flat.canvas, 101, 37)));
  assert.deepEqual(px(deep.canvas, 96, 37), inA);                    // 3 px wide only
  // the outer border of the coloured area (grid edge) is a step border too; filtered and off-grid cells have no colour
  assert.ok(close(px(deep.canvas, 1, 37), px(flat.canvas, 1, 37)));
  assert.ok(deep.ctx.fills > 0 && deep.ctx.fills < 200);
});

test('paintHeat style with rect and rows: borders against rows not computed yet and against the rect edge are drawn', () => {
  const view = { cx: 0, cy: 0, zoom: 80 };
  const d = heatCase({ view, rect: { i0: 1, j0: 1, i1: 6, j1: 6 }, rows: 3, style: { fill: 0.3, edge: 1, edgePx: 2, smooth: false } });
  const f = heatCase({ view, rect: { i0: 1, j0: 1, i1: 6, j1: 6 }, rows: 3 });
  // last computed row j = 3 (rows from j0 = 1): its bottom 2 px are a band; row 4 is empty
  const close = (p, q) => p.every((v, i) => Math.abs(v - q[i]) <= 2);
  assert.ok(close(px(d.canvas, 60, 98), px(f.canvas, 60, 98)));
  assert.deepEqual(px(d.canvas, 60, 110), [0, 0, 0]);
  // column i = 1 is the rect's left edge: band at x 25–26
  assert.ok(close(px(d.canvas, 25, 60), px(f.canvas, 25, 60)));
  assert.ok(!close(px(d.canvas, 30, 60), px(f.canvas, 30, 60)));
});

test('loadPacks: bounded concurrency, order kept, failures reported, never rejects', async () => {
  const window = {};
  window.__lsnStore = {};
  window.__lsnData = (n, b) => { window.__lsnStore[n] = b; (window.__lsnWaiters?.[n] ?? []).forEach((f) => f()); };
  let live = 0, peak = 0;
  const order = [];
  const head = {
    appendChild(el) {
      const name = /data\/js\/(\w+)\.js$/.exec(el.src)[1];
      order.push(name); live++; peak = Math.max(peak, live);
      setTimeout(() => {
        live--;
        if (name === 'bad_one') el.onerror?.();
        else { window.__lsnData(name, Buffer.from([name.length]).toString('base64')); el.onload?.(); }
      }, 2);
    },
  };
  const env = { window, document: { head, createElement: () => ({ remove() {} }) } };
  const names = Array.from({ length: 20 }, (_, i) => `dem_40m_r00c${String(i).padStart(2, '0')}`);
  const seen = [];
  const res = await loadPacks([...names, 'bad_one', names[0]], { concurrency: 4, onEach: (n, b, e) => seen.push([n, !!b, !!e]) }, env);
  assert.equal(peak, 4);
  assert.deepEqual(order, [...names, 'bad_one']);
  assert.equal(res.size, 21);
  assert.deepEqual([...res.get(names[3])], [14]);
  assert.ok(res.get('bad_one') instanceof Error);
  assert.equal(seen.length, 21);
  assert.deepEqual(seen.find((s) => s[0] === 'bad_one'), ['bad_one', false, true]);
  assert.equal((await loadPacks([], {}, env)).size, 0);
});
