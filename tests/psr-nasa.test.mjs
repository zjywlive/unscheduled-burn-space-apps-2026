// Phase 4 T.5 and T.6: the permanently shadowed region bitmap and layer, and the NASA long-term averages.
// Synthetic fixtures follow contracts §4.2 and §4.3; the real packs are checked when present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createPsr, psrMask, psrRaster, paintPsr, PSR_PACK, PSR_DEFAULTS } from '../demo/src/psr.js';
import { createNasaAvg, NASA_PACKS } from '../demo/src/nasa-avg.js';
import { toXY } from '../demo/src/terrain.js';
import { withSoftCanvas, SoftCanvas } from './helpers/raster.mjs';

// a bitmap writer per §4.2: rows top to bottom, high bit first
function writeBits(size, isSet) {
  const out = new Uint8Array(Math.ceil((size * size) / 8));
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (isSet(r, c)) { const i = r * size + c; out[i >> 3] |= 0x80 >> (i & 7); }
  return out;
}

test('psr: reads the §4.2 bit order and orientation (row 0 at +y, high bit first)', () => {
  assert.equal(PSR_PACK, 'psr_120m');
  assert.deepEqual({ ...PSR_DEFAULTS }, { size: 5400, kmPerPixel: 0.12, halfKm: 324 });
  // a tiny 16 × 16 bitmap of 1 km pixels over ±8 km: only pixel (row 2, col 13) and (row 15, col 0)
  const bytes = writeBits(16, (r, c) => (r === 2 && c === 13) || (r === 15 && c === 0));
  assert.equal(bytes[(2 * 16 + 13) >> 3], 0x80 >> ((2 * 16 + 13) & 7));
  const psr = createPsr(bytes, { size: 16, kmPerPixel: 1, halfKm: 8 });
  assert.equal(psr.isPsr(5.5, 5.5), true);             // col 13 → x ∈ [5, 6); row 2 → y ∈ (5, 6]
  assert.equal(psr.isPsr(5.5, 6), true);               // top edge belongs to the row
  assert.equal(psr.isPsr(5.5, 5), false);              // bottom edge belongs to the next row
  assert.equal(psr.isPsr(-7.5, -7.5), true);           // bottom left
  assert.equal(psr.isPsr(-7.5, 7.5), false);
  assert.equal(psr.isPsr(100, 0), false);              // off the bitmap
  assert.throws(() => createPsr(new Uint8Array(10), { size: 16 }), /expected 32/);
});

test('psrMask: the restraint drops specks under 2 px, keeps real patches with an outline, and majority-samples when zoomed out', () => {
  // 1 km pixels over ±50 km: a 12 × 12 km block, a 1 × 1 km speck, a 1 km wide line 20 km long
  const size = 100;
  const set = (r, c) => (r >= 20 && r < 32 && c >= 20 && c < 32) || (r === 70 && c === 70) || (c === 80 && r >= 10 && r < 30);
  const psr = createPsr(writeBits(size, set), { size, kmPerPixel: 1, halfKm: 50 });
  // 1 canvas pixel = 1 km: the speck is 1 px, the line is 1 px wide → both left out; the block stays
  const geo = { width: 100, height: 100, kmPerPx: 1, cx: 0, cy: 0 };
  const m = psrMask(psr, geo);
  assert.equal(m[70 * 100 + 70], 0, 'speck dropped');
  assert.equal(m[20 * 100 + 80], 0, 'thin line dropped');
  assert.equal(m[25 * 100 + 25], 1, 'block interior');
  assert.equal(m[20 * 100 + 25], 2, 'block outline (top row)');
  assert.equal(m[25 * 100 + 31], 2, 'block outline (right column)');
  // with minPx 1 the speck and the line come back
  const m1 = psrMask(psr, geo, { minPx: 1 });
  assert.equal(m1[70 * 100 + 70], 2); assert.equal(m1[20 * 100 + 80], 2);
  // zoomed in 4 ×: the speck is 4 px wide and is drawn
  const zin = psrMask(psr, { width: 40, height: 40, kmPerPx: 0.25, cx: 70 - 50 + 0.5, cy: 50 - 70 - 0.5 });
  assert.ok(zin.some((v) => v > 0));
  // zoomed out 5 ×: the 12 km block is 2.4 px; a pixel is set when most of its footprint is PSR
  const zout = psrMask(psr, { width: 20, height: 20, kmPerPx: 5, cx: 0, cy: 0 }, { minPx: 2 });
  const set5 = []; zout.forEach((v, i) => { if (v) set5.push([Math.floor(i / 20), i % 20]); });
  assert.deepEqual(set5, [[4, 4], [4, 5], [5, 4], [5, 5]]);          // footprints wholly in the block; the 2/5-covered ones are not
  // nothing at all: an empty mask, quickly
  assert.ok(psrMask(createPsr(writeBits(size, () => false), { size, kmPerPixel: 1, halfKm: 50 }), geo).every((v) => v === 0));
});

test('psrRaster / paintPsr: one neutral colour, thin outline, faint hatch fixed to the ground, composited over the map', () => {
  const size = 100;
  const psr = createPsr(writeBits(size, (r, c) => r >= 10 && r < 60 && c >= 10 && c < 60), { size, kmPerPixel: 1, halfKm: 50 });
  const geo = { width: 100, height: 100, kmPerPx: 1, cx: 0, cy: 0 };
  const rgba = psrRaster(psr, geo, { colour: [230, 230, 230], hatchPx: 6 });
  const alphas = new Set();
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3]) { alphas.add(rgba[i + 3]); assert.deepEqual([...rgba.slice(i, i + 3)], [230, 230, 230]); }
  assert.deepEqual([...alphas].sort((a, b) => a - b), [56, 153]);      // hatch 0.22, outline 0.6
  // the hatch covers about 1 pixel in 6 of the interior
  let hatch = 0, inner = 0;
  for (let r = 11; r < 59; r++) for (let c = 11; c < 59; c++) { inner++; if (rgba[4 * (r * 100 + c) + 3] === 56) hatch++; }
  assert.ok(Math.abs(hatch / inner - 1 / 6) < 0.02, `${hatch}/${inner}`);
  // panning by whole pixels moves the hatch with the ground
  const moved = psrRaster(psr, { ...geo, cx: 3 }, { hatchPx: 6 });
  for (let r = 15; r < 50; r++) for (let c = 15; c < 50; c++) assert.equal(moved[4 * (r * 100 + c) + 3] > 0, rgba[4 * (r * 100 + c + 3) + 3] > 0);
  // paintPsr draws over what is there (a grey base stays grey outside the PSR)
  withSoftCanvas(() => {
    const canvas = new SoftCanvas(100, 100);
    const ctx = canvas.getContext();
    canvas.img.data.fill(40);
    for (let i = 3; i < canvas.img.data.length; i += 4) canvas.img.data[i] = 255;
    paintPsr(ctx, psr, geo);
    assert.deepEqual([...canvas.img.data.slice(0, 4)], [40, 40, 40, 255]);
    const o = 4 * (10 * 100 + 30);                                     // outline pixel
    assert.ok(canvas.img.data[o] > 100 && canvas.img.data[o + 3] === 255);
  });
});

test('psr: the real pack (when present) is the §4.2 size, finds shadow in Shackleton and not on its sunlit rim', (t) => {
  const url = new URL('../demo/data/psr_120m.bin', import.meta.url);
  if (!existsSync(url)) { t.skip('psr_120m.bin not built yet'); return; }
  const bytes = new Uint8Array(readFileSync(url));
  assert.equal(bytes.length, 3645000);
  const meta = JSON.parse(readFileSync(new URL('../demo/data/terrain.json', import.meta.url))).psr;
  const psr = createPsr(bytes, meta);
  // Shackleton's floor (crater centre about 89.67°S 129.8°E, 21 km across) is permanently shadowed
  assert.equal(psr.isPsr(...toXY(-89.67, 129.8)), true);
  // the connecting ridge / rim points used as landing candidates are not
  assert.equal(psr.isPsr(...toXY(-89.45, 222.69)), false);
  let ones = 0; for (const b of bytes) { let v = b; while (v) { ones += v & 1; v >>= 1; } }
  const areaKm2 = ones * 0.12 * 0.12;
  t.diagnostic(`PSR area in the ±324 km crop: ${areaKm2.toFixed(0)} km² (${ones} pixels)`);
  assert.ok(areaKm2 > 1000 && areaKm2 < 50000);
  // timing of the layer at 2880 × 1800, zoom 1 and zoom 8
  for (const [kpp, cx, cy] of [[0.3654, 0, 0], [0.0457, -11, -12]]) {
    const geo = { width: 2880, height: 1800, kmPerPx: kpp, cx, cy };
    psrRaster(psr, geo);
    const t0 = performance.now(); psrRaster(psr, geo); const ms = performance.now() - t0;
    t.diagnostic(`psrRaster 2880x1800 at ${kpp} km/px: ${ms.toFixed(0)} ms`);
    assert.ok(ms < 3000);
  }
});

test('nasa-avg: sample → percent per §4.3 (255 = no data), orientation, either grid alone', () => {
  assert.deepEqual({ ...NASA_PACKS }, { sun: 'nasa_sun_480m', earth: 'nasa_earth_480m' });
  // 4 × 4 grids of 1 km over ±2 km
  const meta = { sun: { size: 4, kmPerPixel: 1, halfKm: 2 }, earth: { size: 4, kmPerPixel: 1, halfKm: 2 } };
  const sun = new Uint8Array(16).fill(125), earth = new Uint8Array(16).fill(250);
  sun[0] = 0; earth[0] = 255;          // row 0, col 0: top left (x ∈ [−2, −1), y ∈ (1, 2])
  sun[15] = 255; earth[15] = 255;      // bottom right: no data in either
  const avg = createNasaAvg({ sun, earth }, meta);
  assert.deepEqual(avg.sample(0.5, -0.5), { sunPct: 50, earthPct: 100 });
  assert.deepEqual(avg.sample(-1.5, 1.5), { sunPct: 0, earthPct: null });
  assert.equal(avg.sample(1.5, -1.5), null);
  assert.equal(avg.sample(9, 0), null);
  assert.deepEqual(createNasaAvg({ sun }, meta).sample(0.5, 0.5), { sunPct: 50, earthPct: null });
  assert.throws(() => createNasaAvg({ sun: new Uint8Array(3) }, meta), /expected 16/);
  // the defaults are the §4.3 grid
  const big = createNasaAvg({ sun: new Uint8Array(1350 * 1350).fill(200) });
  assert.deepEqual(big.sample(-323.9, 323.9), { sunPct: 80, earthPct: null });
});

test('nasa-avg: the real packs (when present) give plausible values at known places', (t) => {
  const urlS = new URL('../demo/data/nasa_sun_480m.bin', import.meta.url), urlE = new URL('../demo/data/nasa_earth_480m.bin', import.meta.url);
  if (!existsSync(urlS) || !existsSync(urlE)) { t.skip('NASA packs not built yet'); return; }
  const meta = JSON.parse(readFileSync(new URL('../demo/data/terrain.json', import.meta.url))).nasaAvg;
  const avg = createNasaAvg({ sun: new Uint8Array(readFileSync(urlS)), earth: new Uint8Array(readFileSync(urlE)) }, meta);
  const floor = avg.sample(...toXY(-89.67, 129.8));      // Shackleton floor: no Sun
  const ridge = avg.sample(...toXY(-89.45, 222.69));     // Shackleton–de Gerlache ridge: much Sun
  t.diagnostic(`Shackleton floor ${JSON.stringify(floor)}, connecting ridge ${JSON.stringify(ridge)}`);
  assert.ok(floor && floor.sunPct < 5);
  assert.ok(ridge && ridge.sunPct > 40);
  for (const v of [floor.sunPct, floor.earthPct, ridge.sunPct, ridge.earthPct]) assert.ok(v === null || (v >= 0 && v <= 100));
});
