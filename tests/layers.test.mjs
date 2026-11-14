// Map layers and overlay (phase 3 §5.3). The phase 2 modules come from the backup tarball, unpacked
// into a temporary directory, and serve as the reference: without the new options the output must be
// byte for byte the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDem, fromXY, toXY } from '../demo/src/terrain.js';
import { hillshade, heatColour, paintHeat } from '../demo/src/map/layers.js';
import { renderOverlay } from '../demo/src/map/overlay.js';
import { toPx } from '../demo/src/map/view.js';

const backup = new URL('../backups/phase2-final-2026-11-12.tar.gz', import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), 'lsn-phase2-'));
execFileSync('tar', ['-xzf', backup.pathname, '-C', tmp, 'demo/src/map/layers.js', 'demo/src/map/overlay.js', 'demo/src/terrain.js', 'demo/src/ui/dom.js']);
const old = (p) => import(pathToFileURL(join(tmp, 'demo/src', p)).href);
const oldLayers = await old('map/layers.js');
const oldOverlay = await old('map/overlay.js');
const oldTerrain = await old('terrain.js');
test.after(() => rmSync(tmp, { recursive: true, force: true }));

// Synthetic DEM: rolling hills, a crater and a ridge, 400² pixels of 1.6 km (±320 km).
function synthData(size = 400) {
  const data = new Int16Array(size * size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const x = c - size / 2, y = r - size / 2;
      const crater = -3000 * Math.exp(-((x - 40) ** 2 + (y + 30) ** 2) / 300);
      data[r * size + c] = Math.round((800 * Math.sin(x / 13) * Math.cos(y / 17) + crater + 4 * x) / 0.5);
    }
  }
  return data;
}
const synth = synthData();
const demOf = (mod, extra = {}) => mod.createDem({ data: synth, size: 400, kmPerPixel: 1.6, ...extra });
const real = readFileSync(new URL('../demo/data/dem_480m.bin', import.meta.url));
const realData = new Int16Array(real.buffer, real.byteOffset, real.length / 2);

test('hillshade: phase 2 calls give byte-identical output (synthetic DEM and the real 480 m grid)', () => {
  for (const size of [500, 333, 1000]) {
    const ref = oldLayers.hillshade(demOf(oldTerrain), { size, halfKm: 320 });
    const now = hillshade(demOf({ createDem }), { size, halfKm: 320 });
    assert.ok(Buffer.from(ref).equals(Buffer.from(now)), `synthetic ${size}`);
    assert.ok(Buffer.from(ref).equals(Buffer.from(hillshade(demOf({ createDem }), { size, halfKm: 320, cx: 0, cy: 0 }))));
  }
  const ref = oldLayers.hillshade(oldTerrain.createDem({ data: realData, size: 1906, kmPerPixel: 0.48 }), { size: 1000, halfKm: 320 });
  const nowDem = createDem({ data: realData, size: 1906, kmPerPixel: 0.48, dnToMeters: 0.5 });
  assert.ok(Buffer.from(ref).equals(Buffer.from(hillshade(nowDem, { size: 1000, halfKm: 320 }))), 'real 480 m');
  // the look is unchanged: brightness stays within 8–44 (0 off the DEM)
  const now = hillshade(nowDem, { size: 1000, halfKm: 320 });
  let lo = 255, hi = 0;
  for (const v of now) { if (v) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  assert.ok(lo >= 8 && hi <= 44, `${lo}–${hi}`);
});

test('hillshade under a viewport shows the same ground as the full map at the same scale', () => {
  const dem = demOf({ createDem });
  const full = hillshade(dem, { size: 400, halfKm: 320 });                       // 1.6 km per pixel
  const part = hillshade(dem, { size: 100, halfKm: 80, cx: 80, cy: -40 });       // also 1.6 km per pixel
  let worst = 0;
  for (let r = 0; r < 100; r++) for (let c = 0; c < 100; c++) worst = Math.max(worst, Math.abs(part[r * 100 + c] - full[(r + 175) * 400 + c + 200]));
  assert.ok(worst <= 1, `worst ${worst}`);
});

test('hillshade 1000×1000 timing (reported, not asserted)', (t) => {
  const d480 = createDem({ data: realData, size: 1906, kmPerPixel: 0.48 });
  const time = (fn) => { fn(); const runs = []; for (let n = 0; n < 5; n++) { const t0 = performance.now(); fn(); runs.push(performance.now() - t0); } return runs.sort((a, b) => a - b); };
  const full = time(() => hillshade(d480, { size: 1000, halfKm: 320 }));
  t.diagnostic(`480 m, zoom 1, 1000x1000: median ${full[2].toFixed(1)} ms, min ${full[0].toFixed(1)} ms, max ${full[4].toFixed(1)} ms`);
  let raw = null;
  try { raw = readFileSync(new URL('../data-raw/lola/ldem_75s_240m.img', import.meta.url)); } catch { /* optional */ }
  if (raw) {
    const d240 = createDem({ data: new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2), size: 3812, kmPerPixel: 0.24 });
    const [cx, cy] = toXY(-89.67, 129.78);
    const zoomed = time(() => hillshade(d240, { size: 1000, halfKm: 320 / 6, cx, cy }));
    t.diagnostic(`240 m, zoom 6 at Shackleton, 1000x1000: median ${zoomed[2].toFixed(1)} ms, min ${zoomed[0].toFixed(1)} ms, max ${zoomed[4].toFixed(1)} ms`);
  }
});

test('heatColour: unchanged for the phase 2 modes; score uses the Both colour and five steps', () => {
  const colours = { sun: [1, 2, 3], earth: [4, 5, 6], both: [7, 8, 9], negative: [10, 11, 12] };
  const cases = [['both', { value: 0.33 }], ['sun', { value: 0.9 }], ['earth', { value: 0 }], ['now', { state: 3 }], ['now', { state: 0 }],
    ['change', { delta: -0.3 }], ['change', { delta: 0.01 }], ['sun', { value: NaN }]];
  for (const [mode, v] of cases) assert.deepEqual(heatColour(mode, v, colours), oldLayers.heatColour(mode, v, colours));
  assert.deepEqual(heatColour('score', { value: 0.33 }, colours), heatColour('both', { value: 0.33 }, colours));
  assert.deepEqual(heatColour('score', { value: 1 }, colours), [colours.both, 0.75]);
  assert.equal(heatColour('score', { value: NaN }, colours), null);
  assert.equal(heatColour('score', { value: 0 }, colours), null);
});

// ---------- paintHeat with stand-ins for ImageData, OffscreenCanvas and a 2D context ----------
class FakeImageData { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } }
class FakeOffscreen { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { putImageData: (img) => { this.img = img; } }; } }
function fakeCtx() {
  const calls = [];
  return { calls, set imageSmoothingEnabled(v) { calls.push(['smooth', v]); }, createImageData: (w, h) => new FakeImageData(w, h), putImageData: (img, x, y) => calls.push(['put', Buffer.from(img.data), x, y]), drawImage: (src, ...a) => calls.push(['draw', Buffer.from(src.img.data), src.width, src.height, ...a]) };
}
function withCanvas(fn) {
  const saved = [globalThis.ImageData, globalThis.OffscreenCanvas];
  globalThis.ImageData = FakeImageData; globalThis.OffscreenCanvas = FakeOffscreen;
  try { return fn(); } finally { [globalThis.ImageData, globalThis.OffscreenCanvas] = saved; }
}
const colours = { sun: [200, 150, 0], earth: [0, 120, 255], both: [100, 220, 120], negative: [255, 60, 60] };
const G = 32;
const values = Float32Array.from({ length: G * G }, (_, k) => ((k * 7) % 11) / 10);
const states = Uint8Array.from({ length: G * G }, (_, k) => k % 4);
const alt = Float32Array.from(values, (v, k) => v + ((k % 5) - 2) * 0.1);
const inside = Uint8Array.from({ length: G * G }, (_, k) => (k % 13 ? 1 : 0));
const shade = Uint8ClampedArray.from({ length: 64 * 64 }, (_, k) => 8 + (k % 37));

test('paintHeat: phase 2 calls draw exactly what they did', () => withCanvas(() => {
  const calls = [
    { mode: 'both', values, gridSize: G, canvasSize: 64, inside, colours },
    { mode: 'sun', values, gridSize: G, canvasSize: 64, rows: 10, inside, colours, shade },
    { mode: 'now', states, gridSize: G, canvasSize: 64, colours },
    { mode: 'change', planned: values, alt, gridSize: G, canvasSize: 64, rows: 20, inside, colours },
  ];
  for (const p of calls) {
    const a = fakeCtx(), b = fakeCtx();
    oldLayers.paintHeat(a, p); paintHeat(b, p);
    assert.deepEqual(b.calls, a.calls, p.mode);
  }
}));

test('paintHeat: the full view, or a rect covering the grid, gives the same picture as phase 2', () => withCanvas(() => {
  const p = { mode: 'both', values, gridSize: G, canvasSize: 64, rows: 12, inside, colours };
  const a = fakeCtx(); oldLayers.paintHeat(a, p);
  const want = a.calls.find((c) => c[0] === 'draw');
  for (const extra of [{ view: { cx: 0, cy: 0, zoom: 1 } }, { rect: { i0: 0, j0: 0, i1: G - 1, j1: G - 1 } }]) {
    const b = fakeCtx(); paintHeat(b, { ...p, ...extra });
    const got = b.calls.find((c) => c[0] === 'draw');
    // phase 3 crops the image to the rows drawn; compare the drawn rows and the placement
    assert.ok(want[1].subarray(0, 12 * G * 4).equals(got[1]), JSON.stringify(extra));
    assert.deepEqual(got.slice(2), [G, 12, 0, 0, 64, 24]);
    assert.deepEqual(want.slice(2), [G, G, 0, 0, 64, 64]);
  }
}));

test('paintHeat: a zoomed view draws only the cells in view, scaled and placed with view.js', () => withCanvas(() => {
  // a 1 km grid of 64² cells spanning ±32 km, drawn under a viewport 8 km wide centred on (5, -3)
  const g = 64, vals = Float32Array.from({ length: g * g }, (_, k) => (k % 10) / 10 + 0.05);
  const view = { cx: 5, cy: -3, zoom: 40 };   // the view functions do not clamp; 320 / 40 = 8 km half-width
  const b = fakeCtx();
  paintHeat(b, { mode: 'sun', values: vals, gridSize: g, canvasSize: 160, cellKm: 1, halfKm: 32, view, colours });
  const d = b.calls.find((c) => c[0] === 'draw');
  // x from -3 to 13 km → cells 29..44; y from 5 to -11 km → rows 27..42
  assert.deepEqual([d[2], d[3]], [16, 16]);
  const [dx, dy] = toPx(view, 160, -32 + 29, 32 - 27);
  assert.deepEqual(d.slice(4), [dx, dy, 16 * 10, 16 * 10]);   // 1 km = 10 px
  assert.deepEqual([dx, dy], [0, 0]);
  const k = 27 * g + 29;
  assert.deepEqual([...d[1].subarray(0, 4)], [...colours.sun, Math.round(heatColour('sun', { value: vals[k] }, colours)[1] * 255)]);
}));

test('paintHeat: rect limits the cells and rows count from its first row', () => withCanvas(() => {
  const b = fakeCtx();
  paintHeat(b, { mode: 'both', values, gridSize: G, canvasSize: 64, rows: 3, rect: { i0: 4, j0: 10, i1: 9, j1: 20 }, colours });
  const d = b.calls.find((c) => c[0] === 'draw');
  assert.deepEqual(d.slice(2), [6, 3, 8, 20, 12, 6]);
  const e = fakeCtx();
  paintHeat(e, { mode: 'both', values, gridSize: G, canvasSize: 64, rows: 0, rect: { i0: 4, j0: 10, i1: 9, j1: 20 }, colours, shade });
  assert.deepEqual(e.calls.map((c) => c[0]), ['put']);   // base only
}));

test('paintHeat: filtered cells get no heat colour and dim the base to half; now and change ignore the filter', () => withCanvas(() => {
  const filtered = Uint8Array.from({ length: G * G }, (_, k) => (k % 3 === 0 ? 1 : 0));
  for (const mode of ['both', 'sun', 'earth', 'score']) {
    const b = fakeCtx();
    paintHeat(b, { mode, values, gridSize: G, canvasSize: 64, colours, filtered });
    const px = b.calls.find((c) => c[0] === 'draw')[1];
    for (let k = 0; k < G * G; k++) {
      const got = [...px.subarray(4 * k, 4 * k + 4)];
      if (filtered[k]) assert.deepEqual(got, [0, 0, 0, 128], `${mode} ${k}`);
      else {
        const c = heatColour(mode, { value: values[k] }, colours);
        assert.deepEqual(got, c ? [...c[0], Math.round(c[1] * 255)] : [0, 0, 0, 0]);
      }
    }
  }
  for (const [mode, extra] of [['now', { states }], ['change', { planned: values, alt }]]) {
    const a = fakeCtx(), b = fakeCtx();
    paintHeat(a, { mode, ...extra, gridSize: G, canvasSize: 64, colours, rect: { i0: 0, j0: 0, i1: G - 1, j1: G - 1 } });
    paintHeat(b, { mode, ...extra, gridSize: G, canvasSize: 64, colours, filtered });
    assert.deepEqual(b.calls, a.calls, mode);
  }
}));

// ---------- overlay with a minimal DOM ----------
class FakeNode {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; }
  get firstChild() { return this.children[0] ?? null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener() {}
  append(...c) { this.children.push(...c); }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.text = t; } }
const serial = (n) => (n.tag === '#text' ? n.text : `<${n.tag}${Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>${n.children.map(serial).join('')}</${n.tag}>`);
function withDom(fn) {
  globalThis.Node = FakeNode;
  globalThis.document = { createElementNS: (ns, tag) => new FakeNode(tag), createElement: (tag) => new FakeNode(tag), createTextNode: (t) => new FakeText(t) };
  try { return fn(); } finally { delete globalThis.Node; delete globalThis.document; }
}
const sites = JSON.parse(readFileSync(new URL('../demo/data/sites.json', import.meta.url)));
const features = JSON.parse(readFileSync(new URL('../demo/data/features.json', import.meta.url)));
const grid = {
  size: 320, cellKm: 2, halfKm: 320,
  cellCenter(k) { const xKm = -320 + ((k % 320) + 0.5) * 2, yKm = 320 - (Math.floor(k / 320) + 0.5) * 2; return { xKm, yKm, ...fromXY(xKm, yKm) }; },
};
const polar = sites.filter((s) => s.latDeg <= -80);
const params = (extra = {}) => ({ sizePx: 500, halfKm: 320, features, sites, selected: polar[0], alternative: polar[3], top: [51360, 52000, 40000], cursorCell: 51200, grid, onSite: () => {}, ...extra });
const render = (mod, p) => withDom(() => { const svg = new FakeNode('svg'); mod.renderOverlay(svg, p); return svg; });
const labels = (svg) => {
  const out = [];
  const walk = (n) => { if (n.attrs?.class === 'mark-label' || n.attrs?.class === 'feature-name') out.push(n.children[0].text); n.children?.forEach(walk); };
  walk(svg); return out;
};

test('renderOverlay: without a view, and with the full view, the output is the phase 2 output', () => {
  for (const extra of [{}, { sizePx: 333 }, { selected: null, alternative: null, cursorCell: null, top: [] }]) {
    const ref = serial(render(oldOverlay, params(extra)));
    assert.equal(serial(render({ renderOverlay }, params(extra))), ref);
    assert.equal(serial(render({ renderOverlay }, params({ ...extra, view: { cx: 0, cy: 0, zoom: 1 } }))), ref);
  }
});

test('renderOverlay: zooming in brings back labels left out at zoom 1, placed at the zoomed positions', () => {
  const at1 = labels(render({ renderOverlay }, params()));
  const missing = [...polar, ...features].filter((f) => !at1.includes(f.name));
  assert.ok(missing.length > 0, 'some labels collide at zoom 1');
  let back = 0;
  for (const f of missing) {
    const [cx, cy] = toXY(f.latDeg, f.lonDeg);
    const view = { cx, cy, zoom: 8 };
    const svg = render({ renderOverlay }, params({ view }));
    if (labels(svg).includes(f.name)) back++;
  }
  assert.equal(back, missing.length, `${back} of ${missing.length} labels shown when zoomed on them`);
  // a site mark sits where view.js puts it
  const view = { cx: 10, cy: -20, zoom: 3 };
  const svg = render({ renderOverlay }, params({ view }));
  const marks = svg.children.find((c) => c.attrs.class === 'site-marks').children;
  for (const g of marks) {
    const site = polar.find((s) => `Pick ${s.name}` === g.attrs['aria-label']);
    const [x, y] = toPx(view, 500, ...toXY(site.latDeg, site.lonDeg));
    assert.equal(g.attrs.transform, `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
  }
});

test('renderOverlay: nothing outside the 80°S disc, even where it falls inside the frame', () => {
  const extra = [{ name: 'Outside', latDeg: -79.5, lonDeg: 45 }, { name: 'Inside', latDeg: -80.5, lonDeg: 45 }];
  const [cx, cy] = toXY(-80, 45);
  const svg = render({ renderOverlay }, params({ features: extra, sites: [], selected: null, alternative: null, top: [], view: { cx, cy, zoom: 6 } }));
  assert.deepEqual(labels(svg), ['Inside']);
});
