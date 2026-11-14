// Fix H: the smoothed heat display (layers.js paintSmooth, paintHeat's automatic smoothing) and the
// Sun / Earth margins that nowStates keeps for it (heat.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { paintHeat, cubicTaps, heatColour } from '../demo/src/map/layers.js';
import { createHeatGrid, nowStates } from '../demo/src/heat.js';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { withSoftCanvas, SoftCanvas } from './helpers/raster.mjs';
import { syntheticData } from './helpers/synthetic.mjs';

const colours = { sun: [242, 179, 61], earth: [80, 160, 255], both: [230, 230, 230], negative: [255, 90, 90] };
const G = 12;
const view = { cx: 0, cy: 0, zoom: 53.333 };   // 640 / zoom = 12 km across a 240 px canvas: 20 px cells

// paints on a soft canvas over a grey base (60) and returns the canvas
function paint(extra) {
  return withSoftCanvas(() => {
    const canvas = new SoftCanvas(240, 240), ctx = canvas.getContext();
    for (let i = 0; i < canvas.img.data.length; i += 4) { canvas.img.data[i] = canvas.img.data[i + 1] = canvas.img.data[i + 2] = 60; canvas.img.data[i + 3] = 255; }
    paintHeat(ctx, { gridSize: G, canvasSize: 240, cellKm: 1, halfKm: 6, view, colours, ...extra });
    return canvas;
  });
}
const px = (c, x, y) => [...c.img.data.slice(4 * (y * c.width + x), 4 * (y * c.width + x) + 3)];
const centre = (i, j) => [i * 20 + 10, j * 20 + 10];
const same = (a, b, tol = 1) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
// the colour a crisp cell of this class shows over the grey base
const over = ([rgb, a], base = 60) => rgb.map((v) => Math.round(v * a + base * (1 - a)));

test('cubicTaps: the weights of every sub-sample sum to 1 and lean towards the nearer cell centre', () => {
  for (const k of [1, 3, 7, 20]) {
    const { start, wts } = cubicTaps(k);
    for (let q = 0; q < k; q++) {
      const w = wts.slice(4 * q, 4 * q + 4);
      assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-6);
      assert.ok(start[q] === -2 || start[q] === -1);
      const own = start[q] === -2 ? w[2] : w[1];   // the weight of the sample's own cell
      assert.ok(own >= Math.max(...w) - 1e-6);
    }
  }
});

test('smoothing is automatic at every cell size and zoom, explicitly switchable, and off for legacy Node calls', () => {
  const values = Float32Array.from({ length: G * G }, (_, k) => ((k % G) < 6 ? 0.9 : 0.3));
  const crisp = paint({ mode: 'sun', values, style: { smooth: false } });
  const plain = paint({ mode: 'sun', values });                               // no style, no devicePixelRatio
  assert.ok(Buffer.from(plain.img.data).equals(Buffer.from(crisp.img.data)));
  const smooth = paint({ mode: 'sun', values, style: { edgePx: 2 } });         // 20 device px = 10 CSS px
  assert.ok(!Buffer.from(smooth.img.data).equals(Buffer.from(crisp.img.data)));
  const tiny = paint({ mode: 'sun', values, style: { edgePx: 8 } });          // 2.5 CSS px: still smooth
  assert.ok(!Buffer.from(tiny.img.data).equals(Buffer.from(crisp.img.data)));
  const z1 = withSoftCanvas(() => {
    const a = new SoftCanvas(64, 64), b = new SoftCanvas(64, 64);
    const v1 = { cx: 0, cy: 0, zoom: 1 };
    paintHeat(a.getContext(), { mode: 'sun', values, gridSize: G, canvasSize: 64, view: v1, colours, style: { edgePx: 1 } });
    paintHeat(b.getContext(), { mode: 'sun', values, gridSize: G, canvasSize: 64, view: v1, colours, style: { smooth: false } });
    return Buffer.from(a.img.data).equals(Buffer.from(b.img.data));
  });
  assert.ok(!z1);
});

test('all modes interpolate within small cells, including after a grid switch and at playback resolution', () => {
  for (const mode of ['both', 'sun', 'earth', 'score', 'change', 'now', 'night']) {
    for (const [zoom, gridSize] of [[1, 12], [1.5, 12], [2, 24], [2.2, 24], [4, 24]]) {
      const values = Float32Array.from({ length: gridSize ** 2 }, (_, k) => (k % gridSize + Math.floor(k / gridSize)) % 3 ? 0.9 : 0);
      const states = Uint8Array.from(values, v => v ? 3 : 0), original = values.slice();
      withSoftCanvas(() => {
        const draw = smooth => {
          const c = new SoftCanvas(40, 40), ctx = c.getContext(); let source;
          ctx.drawImage = (img) => { source = img; };
          paintHeat(ctx, { mode, values, states, planned: new Float32Array(values.length).fill(0.4), alt: values,
            gridSize, canvasSize: 40, view: { cx: 0, cy: 0, zoom }, colours, style: { edgePx: 1, smooth } });
          return { source, smoothing: ctx.imageSmoothingEnabled };
        };
        const a = draw(undefined), b = draw(false);
        assert.equal(a.smoothing, true, `${mode} ${zoom}`);
        assert.equal(b.smoothing, false);
        assert.ok(a.source.width >= b.source.width * 2, 'sub-cell sampling, not one colour per cell');
      });
      assert.deepEqual(values, original, 'display does not mutate the true cell values');
    }
  }
});

test('No Sun now veil follows the solar clearance, preserves outside cells, and respects crisp mode', () => {
  const states = new Uint8Array(G * G);
  states.sunDeg = Float32Array.from({ length: G * G }, (_, k) => 5.5 - k % G);
  states.forEach((_, k) => { states[k] = states.sunDeg[k] > 0 ? 1 : 0; });
  const inside = new Uint8Array(G * G).fill(1);
  for (let i = 0; i < G; i++) inside[(G - 1) * G + i] = 0;
  const a = paint({ mode: 'night', states, inside, style: { smooth: true } });
  assert.deepEqual(px(a, 40, 60), [60, 60, 60]);
  assert.deepEqual(px(a, 180, 60), [30, 30, 30]);
  assert.deepEqual(px(a, 180, 230), [60, 60, 60]);
  const moved = Uint8Array.from(states); moved.sunDeg = states.sunDeg.map(v => v + 0.4);
  const b = paint({ mode: 'night', states: moved, inside, style: { smooth: true } });
  assert.ok(px(b, 122, 60)[0] > px(a, 122, 60)[0], 'edge moves with the margin even without changing cell bits');
  const crisp = paint({ mode: 'night', states, inside, style: { smooth: false } });
  assert.deepEqual(px(crisp, 119, 60), [60, 60, 60]);
  assert.deepEqual(px(crisp, 120, 60), [30, 30, 30]);
});

test('hours: far from a step border the legend colour is exact; across a border there is a short soft ramp, no square edge left', () => {
  const values = Float32Array.from({ length: G * G }, (_, k) => ((k % G) < 6 ? 0.9 : 0.3));   // step 5 left, step 2 right
  const c = paint({ mode: 'sun', values, style: { smooth: true } });
  const hi = over(heatColour('sun', { value: 0.9 }, colours)), lo = over(heatColour('sun', { value: 0.3 }, colours));
  assert.ok(same(px(c, 40, 100), hi), `${px(c, 40, 100)} vs ${hi}`);
  assert.ok(same(px(c, 200, 100), lo));
  // the border is at x = 120: within a few px of it the colour moves monotonically from hi to lo
  const row = [];
  for (let x = 100; x <= 140; x++) row.push(px(c, x, 100)[0]);
  for (let i = 1; i < row.length; i++) assert.ok(row[i] <= row[i - 1] + 1, `not monotone at ${100 + i}`);
  // in between, the steps 4 and 3 pass as narrow contour bands (the value crosses 0.8, 0.6, 0.4 there),
  // all within one cell either side of the border
  const mid = row.filter((v) => v < hi[0] - 2 && v > lo[0] + 2).length;
  assert.ok(mid >= 3 && mid <= 30, `ramp ${mid} px`);
});

test('an isolated cell keeps its class and colour at its centre, and its outline is round, not square', () => {
  const values = new Float32Array(G * G);
  values[5 * G + 5] = 0.5;                                   // one coloured cell among cells with no colour
  const c = paint({ mode: 'both', values, style: { smooth: true } });
  assert.ok(same(px(c, ...centre(5, 5)), over(heatColour('both', { value: 0.5 }, colours)), 2));
  assert.deepEqual(px(c, ...centre(3, 3)), [60, 60, 60]);   // no colour: the base
  // round: the cell's square corner (100, 100) shows the base, points near its centre the colour
  const full = over(heatColour('both', { value: 0.5 }, colours))[0];
  assert.ok(px(c, 101, 101)[0] < 60 + 0.25 * (full - 60), `corner ${px(c, 101, 101)}`);
  assert.ok(px(c, 110, 105)[0] > 60 + 0.5 * (full - 60), `near centre ${px(c, 110, 105)}`);
  assert.ok(px(c, 105, 105)[0] < px(c, 110, 105)[0]);   // fading towards the corner: round
  // a cell with no colour inside a coloured field keeps a hole of its own, too
  const v2 = new Float32Array(G * G).fill(0.7); v2[5 * G + 5] = 0;
  const c2 = paint({ mode: 'both', values: v2, style: { smooth: true } });
  assert.deepEqual(px(c2, ...centre(5, 5)), [60, 60, 60]);
});

test('now: only legend colours away from borders; the class border follows the interpolated margins', () => {
  // the Sun clears the skyline on the left (margin falls with i), the Earth everywhere in the top half
  const states = new Uint8Array(G * G);
  states.sunDeg = new Float32Array(G * G); states.earthDeg = new Float32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const k = j * G + i;
    states.sunDeg[k] = 5.5 - i;      // zero crossing at i = 5.5: x = 5.5·20 + 10 = 120 px
    states.earthDeg[k] = j < 6 ? 2 : -2;
    states[k] = (states.sunDeg[k] > 0 ? 1 : 0) | (states.earthDeg[k] > 0 ? 2 : 0);
  }
  const c = paint({ mode: 'now', states, style: { smooth: true } });
  const legend = [1, 2, 3].map((st) => over(heatColour('now', { state: st }, colours))).concat([[60, 60, 60]]);
  let off = 0;
  for (let y = 0; y < 240; y += 3) for (let x = 0; x < 240; x += 3) {
    if (Math.abs(x - 120) <= 3 || Math.abs(y - 120) <= 6) continue;   // the two borders
    if (!legend.some((l) => same(px(c, x, y), l, 2))) off++;
  }
  assert.equal(off, 0);
  assert.ok(same(px(c, 60, 60), over(heatColour('now', { state: 3 }, colours))));
  assert.ok(same(px(c, 180, 60), over(heatColour('now', { state: 2 }, colours))));
  assert.ok(same(px(c, 60, 180), over(heatColour('now', { state: 1 }, colours))));
  assert.deepEqual(px(c, 180, 180), [60, 60, 60]);
  // the Sun border sits where the margin crosses zero, between cell centres (x ≈ 120), not on a cell edge
  // (top half: Both on the left, Earth only on the right; red drops from 179 to 74 across it)
  let edge = -1;
  for (let x = 100; x < 140 && edge < 0; x++) if (px(c, x, 60)[0] < 130) edge = x;
  assert.ok(Math.abs(edge - 120) <= 3, `edge at ${edge}`);
  // and it moves with the margins: shift the zero crossing by a third of a cell and the border follows
  const st2 = Uint8Array.from(states); st2.sunDeg = states.sunDeg.map((v) => v + 1 / 3); st2.earthDeg = states.earthDeg;
  const c3 = paint({ mode: 'now', states: st2, style: { smooth: true } });
  let edge2 = -1;
  for (let x = 100; x < 150 && edge2 < 0; x++) if (px(c3, x, 60)[0] < 130) edge2 = x;
  assert.ok(Math.abs(edge2 - edge - 20 / 3) <= 3, `edge moved ${edge2 - edge}`);
  // without margins (states only) it still draws, with the same classes away from borders
  const plain = Uint8Array.from(states);
  const c2 = paint({ mode: 'now', states: plain, style: { smooth: true } });
  assert.ok(same(px(c2, 60, 60), px(c, 60, 60)) && same(px(c2, 180, 180), px(c, 180, 180)));
});

test('filtered, no-data and outside-the-map stay distinguishable after smoothing', () => {
  const values = new Float32Array(G * G).fill(0.7);
  const filtered = new Uint8Array(G * G), inside = new Uint8Array(G * G).fill(1);
  filtered[3 * G + 3] = 1;                       // one filtered cell
  values[3 * G + 8] = 0;                         // one cell with no time
  for (let k = 0; k < G; k++) inside[(G - 1) * G + k] = 0;   // the bottom row off the map
  const c = paint({ mode: 'both', values, filtered, inside, style: { smooth: true } });
  const col = over(heatColour('both', { value: 0.7 }, colours));
  assert.ok(same(px(c, ...centre(6, 6)), col));
  assert.deepEqual(px(c, ...centre(3, 3)), [30, 30, 30]);        // dimmed to half, no colour
  assert.deepEqual(px(c, ...centre(8, 3)), [60, 60, 60]);        // the base
  assert.deepEqual(px(c, ...centre(6, G - 1)), [60, 60, 60]);    // off the map: nothing drawn
  // change mode ignores the filter and flips sign through "no change"
  const alt = Float32Array.from(values, (v, k) => v + ((k % G) < 6 ? -0.4 : 0.4));
  const ch = paint({ mode: 'change', planned: values, alt, filtered, style: { smooth: true } });
  assert.ok(same(px(ch, 40, 100), over(heatColour('change', { delta: -0.4 }, colours))));
  assert.ok(same(px(ch, 200, 100), over(heatColour('change', { delta: 0.4 }, colours))));
});

test('rows not computed yet: the smoothed layer stops at the last computed row and takes its values to the edge', () => {
  const values = Float32Array.from({ length: G * G }, (_, k) => (Math.floor(k / G) < 3 ? 0.9 : 0.1));
  const c = paint({ mode: 'sun', values, rect: { i0: 0, j0: 0, i1: G - 1, j1: G - 1 }, rows: 3, style: { smooth: true } });
  assert.ok(same(px(c, 100, 58), over(heatColour('sun', { value: 0.9 }, colours))));   // no fade towards the 0.1 rows not drawn
  assert.deepEqual(px(c, 100, 61), [60, 60, 60]);
});

test('nowStates keeps the margins: the bits are exactly visibility, the margins carry their signs; rect and mask limit it', () => {
  const SIZE = 16, AZ = 72;
  const horizon = new Uint8Array(SIZE * SIZE * AZ);
  let seed = 11; for (let i = 0; i < horizon.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; horizon[i] = 30 + (seed >>> 24) % 60; }
  const grid = createHeatGrid({ horizon, size: SIZE, cellKm: 40, halfKm: 320, azimuths: AZ, offsetDeg: -5, stepDeg: 0.1 });
  const eph = createEphemeris(syntheticData({ sunLat: -1.5, earthLat: -6, earthLon: 0 }));
  let mixed = 0;
  for (let h = 0; h < 48; h += 7) {
    const t = eph.startMs + h * 3600e3, d = eph.at(t);
    const st = nowStates(grid, eph, t);
    for (let k = 0; k < grid.count; k++) {
      assert.equal(st[k], grid.visibility(k, d));
      assert.equal(st.sunDeg[k] > 0, (st[k] & 1) === 1);
      assert.equal(st.earthDeg[k] > 0, (st[k] & 2) === 2);
    }
    if (new Set(st).size > 1) mixed++;
  }
  assert.ok(mixed > 0);
  const t = eph.startMs + 5 * 3600e3, full = nowStates(grid, eph, t);
  const mask = new Uint8Array(grid.count).fill(1); mask[4 * SIZE + 4] = 0;
  const part = nowStates(grid, eph, t, { rect: { i0: 2, j0: 3, i1: 6, j1: 5 }, mask });
  for (let k = 0; k < grid.count; k++) {
    const i = k % SIZE, j = Math.floor(k / SIZE), on = i >= 2 && i <= 6 && j >= 3 && j <= 5 && mask[k];
    assert.equal(part[k], on ? full[k] : 0);
    assert.equal(Number.isNaN(part.sunDeg[k]), !on);
  }
});

test('heatplan.nowLayer (fix H2.3): 2 km over the whole map below zoom 2, 1 km under the viewport from zoom 2, real cell values', async () => {
  const { createHeatPlan } = await import('../demo/src/heatplan.js');
  const AZ = 72;
  const eph = createEphemeris(syntheticData({ sunLat: -1.5, earthLat: -6, earthLon: 0 }));
  const tier = (size, label) => {
    const horizon = new Uint8Array(size * size * AZ).fill(50);
    for (let k = 0; k < size * size; k += 3) horizon.fill(120, k * AZ, k * AZ + AZ / 2);
    const grid = createHeatGrid({ horizon, size, cellKm: 640 / size, halfKm: 320, azimuths: AZ, offsetDeg: -5, stepDeg: 0.1 });
    return { grid, inside: new Uint8Array(grid.count).fill(1), slope: new Float32Array(grid.count), shadow: new Float32Array(grid.count), label };
  };
  const coarse = tier(16, '2 km'), fine = tier(32, '1 km');
  const plan = createHeatPlan({ eph, coarse });
  const cfg = { p0: eph.startMs, a0: eph.startMs, len: 86400e3, mode: 'now', weights: { sun: 40, earth: 30, slope: 20, shadow: 10 }, regions: {}, route: null };
  const t = eph.startMs + 9 * 3600e3;
  plan.configure({ ...cfg, viewport: { cx: 0, cy: 0, zoom: 1 } });
  let l = plan.nowLayer(t);
  assert.equal(l.tier, coarse); assert.equal(l.full, true);
  assert.deepEqual(Array.from(l.states), Array.from(nowStates(coarse.grid, eph, t)));   // what main.js computed before
  plan.setFine(fine);
  plan.configure({ ...cfg, viewport: { cx: 0, cy: 0, zoom: 1.5 } });
  assert.equal(plan.nowLayer(t).tier, coarse);
  plan.configure({ ...cfg, viewport: { cx: 0, cy: 0, zoom: 4 } });
  l = plan.nowLayer(t);
  assert.equal(l.tier, fine); assert.equal(l.full, false);
  assert.deepEqual(l.rect, { i0: 10, j0: 10, i1: 21, j1: 21 });
  const all = nowStates(fine.grid, eph, t);
  for (let k = 0; k < fine.grid.count; k++) {
    const i = k % 32, j = Math.floor(k / 32), on = i >= 10 && i <= 21 && j >= 10 && j <= 21;
    assert.equal(l.states[k], on ? all[k] : 0);
  }
  assert.equal(plan.nowLayer(t), l);                                         // cached
  plan.configure({ ...cfg, viewport: { cx: 3, cy: 0, zoom: 4.5 } });         // still inside the rect
  assert.equal(plan.nowLayer(t), l);
  assert.notEqual(plan.nowLayer(t + 3600e3), l);                             // a new time
  // nowAt reports the real 1 km cell and its state
  const a = plan.nowAt(3, -7, t + 3600e3), k = fine.grid.cellAt(3, -7);
  assert.equal(a.tier, fine); assert.equal(a.cell, k); assert.equal(a.state, nowStates(fine.grid, eph, t + 3600e3)[k]);
  assert.equal(plan.nowAt(300, 300, t + 3600e3), null);                      // outside the rect
});

test('a repaint with the same cells reuses the smoothed image; any change in the cells or the class colours does not', () => {
  const values = Float32Array.from({ length: G * G }, (_, k) => ((k * 7) % 10) / 10);
  const draw = (v, cols = colours, cx = 0) => withSoftCanvas(() => {
    const canvas = new SoftCanvas(240, 240), ctx = canvas.getContext();
    let src = null;
    const real = ctx.drawImage.bind(ctx);
    ctx.drawImage = (img, ...a) => { src = img; real(img, ...a); };
    paintHeat(ctx, { mode: 'sun', values: v, gridSize: G, canvasSize: 240, cellKm: 1, halfKm: 6, view: { ...view, cx }, colours: cols, style: { smooth: true } });
    return { src, canvas };
  });
  const a = draw(values), b = draw(values);
  assert.equal(b.src, a.src);
  assert.ok(Buffer.from(a.canvas.img.data).equals(Buffer.from(b.canvas.img.data)));
  const v2 = Float32Array.from(values); v2[40] = 0.95;
  assert.notEqual(draw(v2).src, a.src);
  assert.notEqual(draw(values, { ...colours, sun: [1, 2, 3] }).src, a.src);
  // a pan by a fraction of a cell keeps the same cells: same image, drawn shifted
  const p = draw(values, colours, 0.3);
  assert.equal(p.src, draw(values).src);
});
