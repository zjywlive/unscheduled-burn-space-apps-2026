// Phase 4 official illumination products (§3 D.3–D.5, contracts §4.2, §4.3): PSR bitmap read/write,
// 480 m block means, the new shadow-distance rule, and the shipped files against their sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { toXY } from '../demo/src/terrain.js';
import { packBits, bitAt, unpackBits, blockAverage, cropCentred, decode, psrMask, checkIllumLabel, PSR, AVG, ILLUM } from '../tools/build-nasa.mjs';
import { largePatches, nearestSq, cellCounts, shadowGrid } from '../tools/build-static.mjs';
import { parseLabel } from '../tools/fetch-lola.mjs';

const DATA = new URL('../demo/data/', import.meta.url);
const ILL = new URL('../data-raw/illumination/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA)));
const features = JSON.parse(readFileSync(new URL('features.json', DATA)));
const feature = (name) => features.find((f) => f.name === name);
const hasRaw = (kind) => existsSync(new URL(`${ILLUM[kind]}.IMG`, ILL));
const int16 = (buf) => new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);

test('packBits / bitAt / unpackBits round-trip, MSB first, rows concatenated', () => {
  const n = 5;                                    // 25 bits: not a multiple of 8
  const mask = Uint8Array.from({ length: n * n }, (_, k) => (k * 7) % 3 === 0 ? 1 : 0);
  const bits = packBits(mask, n);
  assert.equal(bits.length, 4);
  assert.deepEqual(unpackBits(bits, n), mask);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) assert.equal(bitAt(bits, n, r, c), mask[r * n + c]);
  // the first pixel is the high bit of the first byte
  const one = new Uint8Array(16); one[0] = 1; one[9] = 1;
  assert.deepEqual([...packBits(one, 4)], [0x80, 0x40]);
});

test('blockAverage: f × f means scaled to 250, out-of-range DNs are no data', () => {
  const label = { scale: 0.00004, offset: 0 };
  // 4 × 4 raster, 2 × 2 blocks: [0, 25000] mean 0.5 → 125; all 25000 → 250; one bad DN ignored; all bad → 255
  const src = Int16Array.from([
    0, 25000, 25000, 25000,
    25000, 0, 25000, 25000,
    -1, 12500, -5, -5,
    12500, 12500, -5, -5,
  ]);
  const { out, missing } = blockAverage(src, 4, 2, label);
  assert.deepEqual([...out], [125, 250, 125, 255]);
  assert.equal(missing, 5);
  assert.equal(decode({ scale: 0.000025, offset: 0.5 }, 20000), 1);
  assert.equal(decode({ scale: 0.000025, offset: 0.5 }, -20000), 0);
  assert.throws(() => blockAverage(src, 4, 3, label));
});

test('cropCentred keeps the pole between the two middle pixels', () => {
  const src = Int16Array.from({ length: 36 }, (_, k) => k);
  assert.deepEqual([...cropCentred(src, 6, 2)], [14, 15, 20, 21]);
  assert.throws(() => cropCentred(src, 6, 3));
});

test('largePatches: 8-connected patches, area threshold', () => {
  // two diagonal pixels join; a lone pixel and a 2-pixel patch fall below 3 units of area
  const W = 6, H = 4;
  const mask = Uint8Array.from([
    1, 0, 0, 0, 1, 1,
    0, 1, 0, 0, 0, 0,
    0, 0, 1, 0, 0, 0,
    0, 0, 0, 0, 0, 1,
  ]);
  const { keep, patches, kept } = largePatches(mask, W, H, () => 1, 3);
  assert.equal(patches, 3);
  assert.equal(kept, 1);
  assert.deepEqual([...keep], [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  // with per-pixel area the 2-pixel patch passes at 2
  assert.equal(largePatches(mask, W, H, () => 1, 2).kept, 2);
});

test('nearestSq equals brute force at fractional query positions', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const W = 37, H = 29;
  const mask = Uint8Array.from({ length: W * H }, () => (rnd() < 0.03 ? 1 : 0));
  const qc = Float64Array.from({ length: 11 }, (_, i) => -3.3 + i * 4.1);
  const qr = Float64Array.from({ length: 9 }, (_, i) => -1.7 + i * 3.9);
  const d = nearestSq(mask, W, H, qc, qr);
  for (let q = 0; q < qr.length; q++) for (let i = 0; i < qc.length; i++) {
    let best = Infinity;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (mask[r * W + c]) best = Math.min(best, (qc[i] - c) ** 2 + (qr[q] - r) ** 2);
    assert.ok(Math.abs(d[q * qc.length + i] - best) < 1e-9, `${q},${i}`);
  }
  assert.ok(nearestSq(new Uint8Array(W * H), W, H, qc, qr).every((v) => v === Infinity));
});

test('shadowGrid: majority PSR → 0, otherwise distance to a large patch, at least 1, capped at 255', () => {
  // 40 × 40 source at 0.5 km/px (±10 km); 4 × 4 cells of 5 km over ±10 km (each cell = 10 × 10 px)
  const S = 40, kmpp = 0.5, grid = { size: 4, cellKm: 5, halfKm: 10 };
  const mask = new Uint8Array(S * S);
  // cell (0, 0): 60 of its 100 pixels set → majority
  for (let r = 0; r < 6; r++) for (let c = 0; c < 10; c++) mask[r * S + c] = 1;
  // cell (3, 3): 30 % set, a patch touching the cell centre
  for (let r = 33; r < 36; r++) for (let c = 30; c < 40; c++) mask[r * S + c] = 1;
  const { n, set } = cellCounts(mask, S, kmpp, grid);
  assert.equal(n[0], 100);
  assert.equal(set[0], 60);
  assert.equal(set[15], 30);
  const { out, majority, raisedToOne } = shadowGrid(mask, mask, S, kmpp, grid);
  assert.equal(out[0], 0);
  assert.equal(majority, 1);
  // cell (3, 3) centre is (7.5, −7.5) km = pixel (34.5, 34.5); nearest set pixel centre 0.5 px away → 0.35 km → 1
  assert.equal(out[15], 1);
  assert.equal(raisedToOne, 1);
  // cell (0, 1) centre (−2.5, 7.5) km = pixel (14.5, 4.5) row/col (row 4.5, col 14.5); nearest set pixel (4, 9): 5.52 px = 2.76 km → 3
  assert.equal(out[1], 3);
  // only the large patches count for distances: dropping the lower patch moves cell (3, 3) to the upper one
  const upper = Uint8Array.from(mask, (v, k) => (k < 10 * S ? v : 0));
  const d = shadowGrid(mask, upper, S, kmpp, grid).out;
  assert.equal(d[15], Math.round(Math.hypot(34.5 - 9, 34.5 - 5) * kmpp));
  // no patches at all → capped
  const far = shadowGrid(new Uint8Array(S * S), new Uint8Array(S * S), S, kmpp, grid).out;
  assert.ok(far.every((v) => v === 255));
});

test('psr_120m.bin, nasa_*_480m.bin: sizes and terrain.json entries', () => {
  assert.equal(statSync(new URL('psr_120m.bin', DATA)).size, 5400 * 5400 / 8);
  assert.deepEqual([meta.psr.file, meta.psr.size, meta.psr.kmPerPixel, meta.psr.halfKm], ['psr_120m.bin', 5400, 0.12, 324]);
  assert.ok(meta.psr.source.includes('LPSR_75S_120M_201608') && meta.psr.rule);
  for (const kind of ['sun', 'earth']) {
    const e = meta.nasaAvg[kind];
    assert.deepEqual([e.file, e.size, e.kmPerPixel, e.halfKm, e.scale, e.noData], [`nasa_${kind}_480m.bin`, 1350, 0.48, 324, 250, 255]);
    assert.equal(statSync(new URL(e.file, DATA)).size, 1350 * 1350);
  }
  assert.equal(meta.nasaAvg.span, '18.6 years, 1 h steps');
  for (const s of meta.shadow) {
    assert.ok(s.source.includes('LPSR_75S_120M_201608'), s.name);
    assert.equal(s.minPatchKm2, 1);
    assert.equal(s.majority, 0.5);
  }
});

// Georeferencing: crater floors are PSR, the Shackleton rim and ridge are not.
const bits = readFileSync(new URL('psr_120m.bin', DATA));
const psrAt = (x, y) => bitAt(bits, 5400, Math.floor((324 - y) / 0.12), Math.floor((x + 324) / 0.12));
const ringShare = (cx, cy, r0, r1) => {
  let n = 0, s = 0;
  for (let r = r0; r <= r1; r += 0.12) for (let a = 0; a < 360; a += 0.5) {
    s += psrAt(cx + r * Math.sin((a * Math.PI) / 180), cy + r * Math.cos((a * Math.PI) / 180)); n++;
  }
  return s / n;
};

test('psr_120m: crater floors are PSR, Shackleton rim and ridge are not', (t) => {
  for (const name of ['Shackleton', 'Haworth', 'Shoemaker', 'Faustini']) {
    const [x, y] = toXY(feature(name).latDeg, feature(name).lonDeg);
    assert.equal(psrAt(x, y), 1, `${name} floor point`);
  }
  const [sx, sy] = toXY(feature('Shackleton').latDeg, feature('Shackleton').lonDeg);
  const floor = ringShare(sx, sy, 0, 2), rim = ringShare(sx, sy, 10, 11.5);
  t.diagnostic(`Shackleton: PSR share within 2 km of the centre ${(100 * floor).toFixed(1)} %, on the 10–11.5 km rim ring ${(100 * rim).toFixed(1)} %`);
  assert.ok(floor > 0.99);
  assert.ok(rim < 0.1);
  assert.equal(psrAt(...toXY(-89.45, 222.69)), 0, 'Shackleton ridge');
});

test('psr_120m.bin is the centred crop of the PSR raster', { skip: !hasRaw('psr') && 'PSR raster missing' }, () => {
  const label = checkIllumLabel(parseLabel(readFileSync(new URL(`${ILLUM.psr}.LBL`, ILL), 'utf8')), 'psr');
  const src = int16(readFileSync(new URL(`${ILLUM.psr}.IMG`, ILL)));
  const { mask, odd } = psrMask(src, label);
  assert.equal(odd, 0);
  assert.deepEqual(unpackBits(bits, 5400), cropCentred(mask, 7624, 5400));
});

for (const kind of ['sun', 'earth']) {
  test(`nasa_${kind}_480m.bin is the 4 × 4 mean of the centred 120 m crop`, { skip: !hasRaw(kind) && 'raster missing' }, () => {
    const label = checkIllumLabel(parseLabel(readFileSync(new URL(`${ILLUM[kind]}.LBL`, ILL), 'utf8')), kind);
    const src = int16(readFileSync(new URL(`${ILLUM[kind]}.IMG`, ILL)));
    const out = readFileSync(new URL(`nasa_${kind}_480m.bin`, DATA));
    const o = (7624 - 5400) / 2;
    for (const [R, C] of [[0, 0], [674, 675], [1349, 1349], [300, 1000], [1000, 77]]) {
      let s = 0;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) s += src[(o + 4 * R + i) * 7624 + o + 4 * C + j] * label.scale;
      assert.equal(out[R * 1350 + C], Math.round((s / 16) * 250), `${R},${C}`);
    }
    // PSR cells read 0 in the Sun average
    if (kind === 'sun') {
      for (const name of ['Shackleton', 'Haworth', 'Shoemaker', 'Faustini']) {
        const [x, y] = toXY(feature(name).latDeg, feature(name).lonDeg);
        assert.equal(out[Math.floor((324 - y) / 0.48) * 1350 + Math.floor((x + 324) / 0.48)], 0, name);
      }
    }
  });
}
