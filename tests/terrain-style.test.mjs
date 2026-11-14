// Terrain styles of the 2D map (map/terrain-style.js): topo colours, contour lines and their interval,
// cast shadows and the Sun's direction on the map plane.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  heightBand, heightRange, typicalGradient, tintAt, topoColour, topoBand, bodyDirection, shadowed, lightBand,
  exposureFor, contourInterval, contourSegments, contourLines, contourLabels, AMBIENT, TINT,
} from '../demo/src/map/terrain-style.js';
import { createDem, toXY } from '../demo/src/terrain.js';
import { unitFromLonLat, azEl } from '../demo/src/geometry.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

// a w × h field of a plane: height = base + gx·col + gy·row
function plane(w, h, base, gx, gy) {
  const f = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) f[r * w + c] = base + gx * c + gy * r;
  return f;
}

test('contours of a plane are straight, evenly spaced and at the right heights', () => {
  const w = 120, h = 60, step = 2, interval = 10;
  const hf = plane(w, h, 3, 1, 0);   // 1 m per pixel to the right: a line every 10 px
  const { segs, level } = contourSegments(hf, w, h, step, interval);
  assert.ok(level.length > 0);
  const byLevel = new Map();
  for (let s = 0; s < level.length; s++) {
    const xs = [segs[4 * s], segs[4 * s + 2]];
    near(xs[0], xs[1], 1e-4, 'vertical');
    const x = xs[0];
    // pixel coordinates: node k sits at k + 0.5, the height there is 3 + k
    near(3 + (x - 0.5), level[s] * interval, 1e-3, 'height of the line');
    byLevel.set(level[s], x);
  }
  const ks = [...byLevel.keys()].sort((a, b) => a - b);
  assert.ok(ks.length >= 10);
  for (let i = 1; i < ks.length; i++) near(byLevel.get(ks[i]) - byLevel.get(ks[i - 1]), 10, 1e-3, 'spacing');
});

test('contours skip cells with no height and mark a flat field with nothing', () => {
  const hf = plane(20, 20, 0, 1, 1);
  hf[5 * 20 + 5] = NaN;
  const a = contourSegments(hf, 20, 20, 1, 5);
  assert.ok(a.level.length > 0);
  assert.equal(contourSegments(plane(20, 20, 7, 0, 0), 20, 20, 1, 5).level.length, 0);
});

test('a saddle gives two segments for one level', () => {
  // 2 × 2 nodes, v0 and v2 high, v1 and v3 low
  const hf = Float32Array.from([10, 0, 0, 10]);
  const out = contourSegments(hf, 2, 2, 1, 8);
  assert.equal(out.level.length, 2);
});

test('the contour interval is 1, 2 or 5 × 10ⁿ and follows the slope', () => {
  const ok = (v) => { const m = v / Math.pow(10, Math.floor(Math.log10(v))); return [1, 2, 5].some((x) => Math.abs(x - m) < 1e-9); };
  for (const g of [0.05, 0.3, 1, 2.2, 7, 16, 40, 300]) assert.ok(ok(contourInterval(g)), `interval for ${g}`);
  assert.equal(contourInterval(1, 16), 20);      // 16 m wanted → 20
  assert.equal(contourInterval(16, 16), 200);    // 256 m wanted → 200
  assert.equal(contourInterval(0, 16), 1);
  assert.ok(contourInterval(32) > contourInterval(8), 'steeper ground: wider interval');
  // the lines of that interval fall 12–20 px apart on a plane of that slope
  for (const g of [0.7, 3, 11, 25]) { const px = contourInterval(g) / g; assert.ok(px > 8 && px < 30, `${g}: ${px}`); }
});

test('typicalGradient is the median of the slope in metres per pixel', () => {
  near(typicalGradient(plane(80, 80, 0, 3, 0), 80, 80), 3, 1e-6);
  near(typicalGradient(plane(80, 80, 0, 3, 4), 80, 80), 5, 1e-6);
  assert.equal(typicalGradient(plane(80, 80, 5, 0, 0), 80, 80), 0);
});

test('contour labels sit on every fifth line, apart, along the line', () => {
  const w = 300, h = 200, interval = 10;
  const hf = plane(w, h, 0, 1, 0);
  const c = contourSegments(hf, w, h, 2, interval);
  const labels = contourLabels(c, hf, w, h, interval);
  assert.ok(labels.length > 0);
  for (const l of labels) {
    assert.match(l.text, /^−?\d+$/);
    assert.equal(Number(l.text.replace('−', '-')) % 50, 0);
    near(Math.abs(Math.sin(l.angle)), 1, 1e-6, 'vertical line: label angle is ±90°');
    assert.ok(Math.cos(l.angle) >= -1e-9);
  }
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    assert.ok(Math.abs(labels[i].x - labels[j].x) >= 120 || Math.abs(labels[i].y - labels[j].y) >= 120);
  }
});

test('topo colours stay in range and follow the height', () => {
  for (let t = -0.5; t <= 1.5; t += 0.1) {
    for (let s = -1; s <= 2; s += 0.25) for (const c of topoColour(s, t)) assert.ok(c >= 0 && c <= 255 && Number.isFinite(c));
  }
  assert.deepEqual(tintAt(0), TINT[0][1]);
  assert.deepEqual(tintAt(1), TINT[3][1]);
  assert.deepEqual(tintAt(-3), TINT[0][1]);
  assert.ok(tintAt(1)[0] > tintAt(0)[0], 'high is lighter than low');
  const hf = plane(40, 40, 0, 2, 1);
  const img = new Uint8ClampedArray(40 * 40 * 4);
  const range = heightRange(hf);
  topoBand(hf, 40, 40, 0.01, range, img, 0, 40);
  for (let i = 0; i < 1600; i++) assert.equal(img[4 * i + 3], 255);
  // flat ground at two heights: the higher one is lighter
  const lo = new Float32Array(1600).fill(0), hi = new Float32Array(1600).fill(100);
  const both = new Float32Array(3200); both.set(lo, 0); both.set(hi, 1600);
  const im2 = new Uint8ClampedArray(3200 * 4);
  topoBand(both, 40, 80, 0.01, { lo: 0, hi: 100 }, im2, 0, 80);
  assert.ok(im2[4 * (70 * 40 + 20)] > im2[4 * (10 * 40 + 20)]);
});

test('the height range ignores outliers', () => {
  const hf = new Float32Array(10000).fill(5);
  for (let i = 0; i < 10000; i++) hf[i] = i % 100;
  hf[3] = 1e6; hf[7] = -1e6;
  const r = heightRange(hf);
  assert.ok(r.hi < 1000 && r.lo > -1000);
  assert.equal(heightRange(new Float32Array(4).fill(NaN)), null);
});

test('heightBand reads a DEM, row by row, NaN outside it', () => {
  const size = 20, data = new Int16Array(size * size);
  for (let i = 0; i < data.length; i++) data[i] = 40;   // 20 m at dnToMeters 0.5
  const dem = createDem({ data, size, kmPerPixel: 1 });
  const g = { width: 30, height: 10, kmPerPx: 1, cx: 0, cy: 0 };
  const out = new Float32Array(300);
  heightBand(dem, out, g, 0, 4); heightBand(dem, out, g, 4, 6);
  near(out[5 * 30 + 15], 20, 1e-6);
  assert.ok(Number.isNaN(out[5 * 30 + 0]), 'beyond the DEM');
});

test('a ridge casts a shadow of h / tan(elevation) long', () => {
  // a plateau of H m from x = 0 on (towards the Sun, +x); flat ground at 0 behind it
  const H = 100, el = 3, tanEl = Math.tan((el * Math.PI) / 180), L = H / tanEl / 1000;   // km
  const sample = (x) => (x >= 0 ? H : 0);
  const sh = (dist) => shadowed((x, y) => sample(x), -dist, 0, 0, 1, 0, tanEl, { maxKm: 40 });
  assert.equal(sh(0.8 * L), true, 'inside the shadow');
  assert.equal(sh(0.5 * L), true);
  assert.equal(sh(1.2 * L), false, 'beyond the shadow');
  assert.equal(sh(2 * L), false);
  // flat ground never shadows itself
  assert.equal(shadowed(() => 0, 0, 0, 0, 1, 0, tanEl), false);
  // a higher Sun shortens it
  const tan10 = Math.tan((10 * Math.PI) / 180);
  assert.equal(shadowed((x) => sample(x), -0.8 * L, 0, 0, 1, 0, tan10), false);
  // curvature: a distant ridge of the same height is hidden below the horizon of a 0° Sun
  assert.equal(shadowed((x) => (x >= 30 ? 100 : 0), 0, 0, 0, 1, 0, 0, { maxKm: 40 }), false, '100 m at 30 km is below the horizon plane');
  assert.equal(shadowed((x) => (x >= 30 ? 400 : 0), 0, 0, 0, 1, 0, 0, { maxKm: 40 }), true);
});

test('the Sun below the horizon gives full shadow', () => {
  const w = 24, h = 16, k = 0.05;
  const hf = new Float32Array(w * h).fill(0);
  const [x, y] = toXY(-89, 40);
  const g = { width: w, height: h, kmPerPx: k, cx: x, cy: y };
  // at 89°S the local up is nearly −z: a Sun on the +z side is below the horizon
  const out = new Uint8ClampedArray(w * h);
  lightBand(hf, w, h, g, unitFromLonLat(0, 60), () => 0, 1, out, 0, h);
  for (const v of out) assert.equal(v, AMBIENT);
  // and a Sun on the −z side, 5° over the pole, lights flat ground
  const lit = new Uint8ClampedArray(w * h);
  lightBand(hf, w, h, g, unitFromLonLat(40, -87), () => 0, exposureFor(2), lit, 0, h);
  assert.ok(lit.every((v) => v > AMBIENT), 'flat ground is lit');
});

test('Lambert shading: slopes facing the Sun are brighter, and a shadow darkens the ground behind a step', () => {
  const w = 60, h = 20, k = 0.01;                        // 10 m pixels
  const [x, y] = toXY(-85, 0);                           // lon 0°: +y on the map is away from the pole
  const g = { width: w, height: h, kmPerPx: k, cx: x, cy: y };
  const sun = unitFromLonLat(180, -10);                  // 5° up at 85°S, over the pole side
  const dir = bodyDirection(sun, x, y);
  near(dir.elDeg, 5, 0.1, 'elevation');
  assert.ok(Math.abs(Math.hypot(dir.dx, dir.dy) - 1) < 1e-9);
  assert.ok(dir.dy < -0.99, 'the Sun is towards the pole (−y) from lon 0°');
  // ground rising towards the pole faces away from the Sun here; falling towards it, faces the Sun
  const toward = new Float32Array(w * h), away = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) { toward[r * w + c] = r * 2; away[r * w + c] = -r * 2; }
  const a = new Uint8ClampedArray(w * h), b = new Uint8ClampedArray(w * h);
  lightBand(toward, w, h, g, sun, () => NaN, 1, a, 0, h);
  lightBand(away, w, h, g, sun, () => NaN, 1, b, 0, h);
  // 'away' falls towards the Sun, so it rises away from it and faces it
  assert.equal(a[10 * w + 30], AMBIENT, 'ground rising towards the Sun faces away from it');
  assert.ok(b[10 * w + 30] > 60, 'ground facing the Sun is lit');
});

test('a plateau between the ground and the Sun shadows it in lightBand', () => {
  const w = 40, h = 8, k = 0.02;                         // 20 m pixels, 0.8 km wide
  const [x0, y0] = toXY(-85, 0);
  const g = { width: w, height: h, kmPerPx: k, cx: x0, cy: y0 };
  const sun = unitFromLonLat(180, -10);                  // 5° up, from −y (the pole side)
  const tan5 = Math.tan((5 * Math.PI) / 180);
  const flat = new Float32Array(w * h);
  const wall = (x, y) => (y < y0 - 0.2 ? 80 : 0);        // 80 m plateau starting 0.2 km towards the Sun
  const o = new Uint8ClampedArray(w * h);
  lightBand(flat, w, h, g, sun, wall, 1, o, 0, h);
  // shadow reaches 80 m / tan 5° = 0.91 km behind the edge: all of these 0.8 km of pixels are inside
  assert.ok(o.every((v) => v === AMBIENT), `shadowed, got ${o[0]}`);
  const o2 = new Uint8ClampedArray(w * h);
  lightBand(flat, w, h, g, sun, () => 0, 1, o2, 0, h);
  assert.ok(o2.every((v) => v > AMBIENT), 'without the wall it is lit');
  assert.ok(tan5 > 0);
});

test('stride fills blocks and the full pass covers every pixel', () => {
  const w = 17, h = 13, k = 0.05;
  const [x, y] = toXY(-88, 10);
  const g = { width: w, height: h, kmPerPx: k, cx: x, cy: y };
  const hf = plane(w, h, 0, 0.3, 0.1);
  const sun = unitFromLonLat(190, -88);
  const fine = new Uint8ClampedArray(w * h), coarse = new Uint8ClampedArray(w * h);
  lightBand(hf, w, h, g, sun, () => 0, 3, fine, 0, h, 1);
  lightBand(hf, w, h, g, sun, () => 0, 3, coarse, 0, h, 4);
  assert.equal(coarse[0], coarse[1]);
  assert.equal(coarse[0], coarse[w]);
  near(coarse[w * 12 + 16], fine[w * 12 + 16], 40);
  // sliced into bands it gives the same picture
  const sl = new Uint8ClampedArray(w * h);
  lightBand(hf, w, h, g, sun, () => 0, 3, sl, 0, 8, 1);
  lightBand(hf, w, h, g, sun, () => 0, 3, sl, 8, 5, 1);
  assert.deepEqual(sl, fine);
});

test('bodyDirection agrees with the sky geometry (geometry.js azEl)', () => {
  const lat = -85, lon = 40, [x, y] = toXY(lat, lon);
  for (const [dir, range] of [[unitFromLonLat(70, -3), Infinity], [unitFromLonLat(10, 5), 384400], [unitFromLonLat(300, 1), Infinity]]) {
    const ref = azEl(dir, range, lon, lat), d = bodyDirection(dir, x, y, range);
    near(d.elDeg, ref.elDeg, 1e-6, 'elevation');
    // the azimuth from north, turned onto the map: north at this longitude is (sin λ, cos λ), east (cos λ, −sin λ)
    const az = (ref.azDeg * Math.PI) / 180, l = (lon * Math.PI) / 180;
    near(d.dx, Math.sin(az) * Math.cos(l) + Math.cos(az) * Math.sin(l), 1e-6, 'dx');
    near(d.dy, -Math.sin(az) * Math.sin(l) + Math.cos(az) * Math.cos(l), 1e-6, 'dy');
  }
});

test('contour segments join into polylines: one per straight line, a closed loop round a bowl', () => {
  const w = 120, h = 60;
  const plane1 = plane(w, h, 3, 1, 0);
  const a = contourLines(contourSegments(plane1, w, h, 2, 10));
  const nSeg = contourSegments(plane1, w, h, 2, 10).level.length;
  assert.ok(a.level.length >= 10 && a.level.length < 14, `lines ${a.level.length}`);   // one per level
  assert.equal(a.pts.length / 2, nSeg + a.level.length, 'each segment adds one point to its line');
  // a bowl: heights = distance from the centre, so each level is a ring
  const bowl = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) bowl[r * w + c] = Math.hypot(c - 60.3, r - 30.2);   // off the nodes: no line passes exactly through a node
  const b = contourLines(contourSegments(bowl, w, h, 1, 5));
  const lv = new Set(b.level);
  for (const k of [1, 2, 3, 4]) {
    const i = [...b.level].indexOf(k);
    assert.ok(i >= 0 && [...b.level].filter((x) => x === k).length === 1, `one ring at level ${k}`);
    const p0 = b.start[i], p1 = b.start[i + 1] - 1;
    near(b.pts[2 * p0], b.pts[2 * p1], 1e-4, 'ring closes in x');
    near(b.pts[2 * p0 + 1], b.pts[2 * p1 + 1], 1e-4, 'ring closes in y');
    for (let q = p0; q <= p1; q++) near(Math.hypot(b.pts[2 * q] - 0.5 - 60.3, b.pts[2 * q + 1] - 0.5 - 30.2), k * 5, 0.2, 'on the ring');
  }
  assert.ok(lv.size >= 4);
});
