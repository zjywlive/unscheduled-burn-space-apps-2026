// Phase 4 T.4: hillshade on a rectangular canvas and over tiled terrain. The phase 3 modules come from
// backups/phase3-final-2026-11-12.tar.gz, unpacked into a temporary directory, as the reference for the
// square form (it must stay byte for byte the same).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDem, createPyramid, createTiledDem, toXY } from '../demo/src/terrain.js';
import { hillshade } from '../demo/src/map/layers.js';
import { LEVEL_40, LEVEL_20, terrainM, makeTile, tilesMeeting, referenceDem, plainDem } from './helpers/tiles.mjs';

const backup = new URL('../backups/phase3-final-2026-11-12.tar.gz', import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), 'lsn-phase3-'));
execFileSync('tar', ['-xzf', backup.pathname, '-C', tmp, 'demo/src/map/layers.js', 'demo/src/map/view.js', 'demo/src/terrain.js']);
const p3 = await import(pathToFileURL(join(tmp, 'demo/src/map/layers.js')).href);
const p3t = await import(pathToFileURL(join(tmp, 'demo/src/terrain.js')).href);
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const real = (name) => { const b = readFileSync(new URL(`../demo/data/${name}.bin`, import.meta.url)); return new Int16Array(b.buffer, b.byteOffset, b.length / 2); };
const d480data = real('dem_480m'), d120data = real('dem_120m');
const same = (a, b) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
function maxDiff(a, b) { let w = 0; for (let i = 0; i < a.length; i++) w = Math.max(w, Math.abs(a[i] - b[i])); return w; }
function zeros(a) { let n = 0; for (const v of a) if (v === 0) n++; return n; }

test('square form: byte-identical to the phase 3 hillshade (synthetic, real 480 m and real 120 m, centred and offset)', () => {
  // both DEMs from the same arrays, each through its own version's createDem
  const cases = [
    [{ data: d480data, size: 1906, kmPerPixel: 0.48, dnToMeters: 0.5 }, [{ size: 1000, halfKm: 320 }, { size: 777, halfKm: 53.3, cx: -11.3, cy: -12.3 }, { size: 333, halfKm: 320 / 7.5, cx: 120.25, cy: -64 }]],
    [{ data: d120data, size: 2600, kmPerPixel: 0.12, dnToMeters: 0.5, halfKm: 156 }, [{ size: 960, halfKm: 320 / 6, cx: -11.3, cy: -12.3 }, { size: 500, halfKm: 320 / 12, cx: 40, cy: 76 }, { size: 641, halfKm: 320 / 30, cx: 0.4, cy: -3 }]],
  ];
  for (const [args, opts] of cases) {
    const now = createDem(args), old = p3t.createDem(args);
    for (const o of opts) assert.ok(same(hillshade(now, o), p3.hillshade(old, o)), JSON.stringify({ k: args.kmPerPixel, ...o }));
  }
  // a synthetic DEM through both versions
  const size = 400, data = new Int16Array(size * size);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) data[r * size + c] = Math.round(terrainM((c - 200) * 0.3, (200 - r) * 0.3) / 0.5);
  const a = createDem({ data, size, kmPerPixel: 1.6 }), b = p3t.createDem({ data, size, kmPerPixel: 1.6 });
  for (const o of [{ size: 500, halfKm: 320 }, { size: 300, halfKm: 40, cx: 33, cy: -17 }]) assert.ok(same(hillshade(a, o), p3.hillshade(b, o)));
});

test('rectangle form: the same picture as the square form at the same scale, and any window of it', () => {
  const dem = createDem({ data: d120data, size: 2600, kmPerPixel: 0.12, dnToMeters: 0.5, halfKm: 156 });
  const sq = hillshade(dem, { size: 600, halfKm: 30, cx: -10, cy: -12 });                      // 0.1 km/px
  const rs = hillshade(dem, { width: 600, height: 600, kmPerPx: 0.1, cx: -10, cy: -12 });
  assert.ok(maxDiff(sq, rs) <= 1, `square vs rect ${maxDiff(sq, rs)}`);
  // a 300 × 140 window whose top-left pixel is (120, 200) of the square
  const w = 300, h = 140, cx = -10 - 30 + (120 + w / 2) * 0.1, cy = -12 + 30 - (200 + h / 2) * 0.1;
  const win = hillshade(dem, { width: w, height: h, kmPerPx: 0.1, cx, cy });
  assert.equal(win.length, w * h);
  let worst = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) worst = Math.max(worst, Math.abs(win[r * w + c] - sq[(r + 200) * 600 + c + 120]));
  assert.ok(worst <= 1, `window ${worst}`);
  // the look is unchanged: 8–44, 0 only off the terrain
  let lo = 255, hi = 0;
  for (const v of win) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert.ok(lo >= 8 && hi <= 44, `${lo}–${hi}`);
});

// 40 m tiles over x, y ∈ [−6, 6] km around the pole (4 × 4 tiles: borders at 0 and ±10.24 km fall in view)
function tiledPyramid({ only, plain120 = true, with20 = false } = {}) {
  const ids = tilesMeeting(LEVEL_40, { x0: -12, y0: -12, x1: 12, y1: 12 });
  const p = createPyramid(plain120 ? [plainDem(0.12, 30)] : []);
  const t40 = p.add(createTiledDem({ ...LEVEL_40, tiles: ids.map((t) => t.id) }));
  for (const t of ids) if (!only || only(t)) t40.addTile(t.id, makeTile(LEVEL_40, t.row, t.col));
  if (with20) {
    const ids20 = tilesMeeting(LEVEL_20, { x0: -6, y0: -6, x1: 6, y1: 6 });
    const t20 = p.add(createTiledDem({ ...LEVEL_20, tiles: ids20.map((t) => t.id) }));
    for (const t of ids20) t20.addTile(t.id, makeTile(LEVEL_20, t.row, t.col));
  }
  return p;
}

test('tiled terrain: no seam at tile borders: the same picture as one untiled raster of the same pixels', () => {
  const p = tiledPyramid();
  for (const [kpp, cx, cy, w, h] of [[0.04, 0, 0, 500, 400], [0.013, 10.24, -0.5, 320, 260], [0.07, -1, 1, 300, 300]]) {
    const geo = { width: w, height: h, kmPerPx: kpp, cx, cy };
    const dem = p.pick(kpp, { x0: cx - (w * kpp) / 2, y0: cy - (h * kpp) / 2, x1: cx + (w * kpp) / 2, y1: cy + (h * kpp) / 2 });
    assert.equal(dem.kmPerPixel, 0.04);
    const ref = hillshade(referenceDem(LEVEL_40), geo);
    const got = hillshade(dem, geo);
    assert.ok(maxDiff(ref, got) <= 1, `kpp ${kpp}: ${maxDiff(ref, got)}`);
    assert.equal(zeros(got), 0, 'no holes');
  }
});

test('tiled terrain: a tile not loaded yet, and the edge of the 40 m coverage, fall back to 120 m without holes or a brightness step', () => {
  const geo = { width: 600, height: 300, kmPerPx: 0.04, cx: 0, cy: 3 };       // x ∈ [−12, 12] km
  const bounds = { x0: -12, y0: -3, x1: 12, y1: 9 };
  const mixed = tiledPyramid({ only: (t) => t.col >= 30 });                     // 40 m only for x ≥ 0
  const all40 = tiledPyramid();
  const only120 = plainDem(0.12, 30);
  const C = hillshade(mixed.pick(0.04, bounds), geo), F = hillshade(all40.pick(0.04, bounds), geo), G = hillshade(only120, geo);
  assert.equal(zeros(C), 0, 'no holes');
  // left of x = 0 the mixed picture is the 120 m picture, right of it the 40 m one (beyond the slope step)
  const W = geo.width, x0col = 300;
  let left = 0, right = 0;
  for (let r = 0; r < geo.height; r++) {
    for (let c = 0; c < x0col - 4; c++) left = Math.max(left, Math.abs(C[r * W + c] - G[r * W + c]));
    for (let c = x0col + 4; c < W; c++) right = Math.max(right, Math.abs(C[r * W + c] - F[r * W + c]));
  }
  assert.equal(left, 0); assert.equal(right, 0);
  // brightness: mean of 40 columns either side of the border, mixed picture vs all-40 m picture
  const band = (img, c0, c1) => { let s = 0, n = 0; for (let r = 0; r < geo.height; r++) for (let c = c0; c < c1; c++) { s += img[r * W + c]; n++; } return s / n; };
  const stepMixed = band(C, x0col, x0col + 40) - band(C, x0col - 40, x0col);
  const stepAll = band(F, x0col, x0col + 40) - band(F, x0col - 40, x0col);
  const meanGap = band(F, 0, W) - band(G, 0, W);
  assert.ok(Math.abs(stepMixed - stepAll) < 1.5, `step ${stepMixed.toFixed(2)} vs ${stepAll.toFixed(2)}`);
  assert.ok(Math.abs(meanGap) < 1.5, `40 m vs 120 m mean ${meanGap.toFixed(2)}`);
});

test('tiled terrain: 20 m over 40 m over 120 m in one picture, and no tiled data at all, still have no holes', () => {
  const p = tiledPyramid({ with20: true });
  const geo = { width: 700, height: 500, kmPerPx: 0.03, cx: 4, cy: 0 };          // x ∈ [−6.5, 14.5]: 20 m, 40 m, then 120 m
  const dem = p.pick(0.01, { x0: -6.5, y0: -7.5, x1: 14.5, y1: 7.5 });
  assert.deepEqual(dem.chain.map((d) => d.kmPerPixel), [0.02, 0.04, 0.12]);
  const img = hillshade(dem, geo);
  assert.equal(zeros(img), 0);
  const empty = createPyramid([plainDem(0.12, 30)]);
  empty.add(createTiledDem({ ...LEVEL_40, tiles: ['r29c30'] }));
  const e = empty.pick(0.04, { x0: -1, y0: -1, x1: 1, y1: 1 });
  assert.ok(e.composite);
  const a = hillshade(e, { width: 50, height: 50, kmPerPx: 0.04, cx: 0, cy: 0 });
  const b = hillshade(plainDem(0.12, 30), { width: 50, height: 50, kmPerPx: 0.04, cx: 0, cy: 0 });
  assert.equal(maxDiff(a, b), 0, 'nothing loaded: exactly the 120 m picture');
});

test('hillshade 2880 × 1800 timing (reported; asserted only under 3 s)', (t) => {
  const time = (fn) => { fn(); const runs = []; for (let n = 0; n < 3; n++) { const t0 = performance.now(); fn(); runs.push(performance.now() - t0); } return runs.sort((a, b) => a - b); };
  const W = 2880, H = 1800;
  const d480 = createDem({ data: d480data, size: 1906, kmPerPixel: 0.48, dnToMeters: 0.5 });
  const z1 = time(() => hillshade(d480, { width: W, height: H, kmPerPx: 0.3654, cx: 0, cy: 0 }));
  t.diagnostic(`plain 480 m, zoom 1 (0.365 km/px), ${W}x${H}: median ${z1[1].toFixed(0)} ms (min ${z1[0].toFixed(0)}, max ${z1[2].toFixed(0)})`);
  const d120 = createDem({ data: d120data, size: 2600, kmPerPixel: 0.12, dnToMeters: 0.5, halfKm: 156 });
  const z8 = time(() => hillshade(d120, { width: W, height: H, kmPerPx: 0.0457, cx: -11, cy: -12 }));
  t.diagnostic(`plain 120 m, zoom 8, ${W}x${H}: median ${z8[1].toFixed(0)} ms (min ${z8[0].toFixed(0)}, max ${z8[2].toFixed(0)})`);
  // 40 m tiles under the whole canvas (0.02 km/px: 57.6 × 36 km = 7 × 5 tiles), 120 m beneath
  const box = { x0: -29, y0: -18.5, x1: 29, y1: 18.5 };
  const ids = tilesMeeting(LEVEL_40, box);
  const p = createPyramid([d120]);
  const t40 = p.add(createTiledDem({ ...LEVEL_40, tiles: ids.map((x) => x.id) }));
  for (const x of ids) t40.addTile(x.id, makeTile(LEVEL_40, x.row, x.col));
  const comp = p.pick(0.02, box);
  const zt = time(() => hillshade(comp, { width: W, height: H, kmPerPx: 0.02, cx: 0, cy: 0 }));
  t.diagnostic(`tiled 40 m (${ids.length} tiles) over 120 m, ${W}x${H}: median ${zt[1].toFixed(0)} ms (min ${zt[0].toFixed(0)}, max ${zt[2].toFixed(0)})`);
  // half the tiles missing: half the canvas falls back to 120 m
  const q = createPyramid([d120]);
  const h40 = q.add(createTiledDem({ ...LEVEL_40, tiles: ids.map((x) => x.id) }));
  for (const x of ids) if (x.col >= 30) h40.addTile(x.id, makeTile(LEVEL_40, x.row, x.col));
  const zh = time(() => hillshade(q.pick(0.02, box), { width: W, height: H, kmPerPx: 0.02, cx: 0, cy: 0 }));
  t.diagnostic(`tiled 40 m, half the tiles missing, ${W}x${H}: median ${zh[1].toFixed(0)} ms (min ${zh[0].toFixed(0)}, max ${zh[2].toFixed(0)})`);
  for (const r of [z1, z8, zt, zh]) assert.ok(r[1] < 3000);
});

test('real data check: Shackleton at 20 m and a 40 m / 120 m border (only when workstream D\'s tiles are in demo/data)', (t) => {
  const meta = JSON.parse(readFileSync(new URL('../demo/data/terrain.json', import.meta.url)));
  const tiled = (meta.levels ?? []).filter((l) => l.tiled);
  if (!tiled.length || !tiled.every((l) => l.tiles?.length && existsSync(new URL(`../demo/data/${l.name}_${l.tiles[0]}.bin`, import.meta.url)))) {
    t.skip('no tiled levels in demo/data yet');
    return;
  }
  const p = createPyramid([createDem({ data: d120data, size: 2600, kmPerPixel: 0.12, dnToMeters: 0.5, halfKm: 156 })]);
  for (const l of tiled) {
    const lvl = p.add(createTiledDem(l));
    for (const id of l.tiles) lvl.addTile(id, new Uint8Array(readFileSync(new URL(`../demo/data/${l.name}_${id}.bin`, import.meta.url))));
  }
  const [sx, sy] = toXY(-89.9, 0);
  const geo = { width: 800, height: 500, kmPerPx: 0.015, cx: sx, cy: sy };
  const dem = p.pick(0.015, { x0: sx - 6, y0: sy - 3.75, x1: sx + 6, y1: sy + 3.75 });
  const img = hillshade(dem, geo);
  t.diagnostic(`Shackleton 800x500 at 15 m/px: chain ${dem.chain?.map((d) => d.kmPerPixel).join(' → ')}, ${zeros(img)} zero pixels`);
  assert.equal(zeros(img), 0);
});
