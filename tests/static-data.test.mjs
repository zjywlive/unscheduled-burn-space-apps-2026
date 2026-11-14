// Phase 3 data products (§5.2): sizes, crops against the LOLA sources, persistent shadow, slope and
// the 1 km skyline grid against the 2 km one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { toXY, createDem } from '../demo/src/terrain.js';

const DATA = new URL('../demo/data/', import.meta.url);
const RAW = new URL('../data-raw/lola/', import.meta.url);
const bytes = (name) => readFileSync(new URL(name, DATA));
const int16 = (buf) => new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
const meta = JSON.parse(bytes('terrain.json'));
const hasRaw = (name) => existsSync(new URL(name, RAW));

const FLOORS = JSON.parse(bytes('validation.json')).terrain.checks.filter((c) => c.kind === 'shadow');
const RIDGE = { latDeg: -89.45, lonDeg: 222.69 };
const SHACKLETON = { latDeg: -89.67, lonDeg: 129.78 };

function cellOf(size, cellKm, halfKm, latDeg, lonDeg) {
  const [x, y] = toXY(latDeg, lonDeg);
  return Math.floor((halfKm - y) / cellKm) * size + Math.floor((x + halfKm) / cellKm);
}

test('file sizes match terrain.json', () => {
  const expected = {
    'dem_480m.bin': 1906 * 1906 * 2, 'horizon_grid.bin': 320 * 320 * 72,
    'dem_240m.bin': 2700 * 2700 * 2, 'dem_120m.bin': 2600 * 2600 * 2, 'horizon_1km.bin': 640 * 640 * 72,
    'slope_2km.bin': 320 * 320, 'slope_1km.bin': 640 * 640, 'shadow_2km.bin': 320 * 320, 'shadow_1km.bin': 640 * 640,
  };
  for (const [name, size] of Object.entries(expected)) assert.equal(statSync(new URL(name, DATA)).size, size, name);
  // phase 4 appends tiled levels (no single file); they are checked in tiles.test.mjs
  const whole = meta.levels.filter((l) => !l.tiled);
  for (const l of whole) assert.equal(statSync(new URL(l.file, DATA)).size, l.size * l.size * 2, l.file);
  for (const h of meta.horizons) assert.equal(statSync(new URL(h.file, DATA)).size, h.size * h.size * h.azimuths, h.file);
  for (const s of [...meta.slope, ...meta.shadow]) assert.equal(statSync(new URL(s.file, DATA)).size, s.size * s.size, s.file);
  assert.deepEqual(whole.map((l) => l.name), ['dem_480m', 'dem_240m', 'dem_120m']);
  for (const l of whole.slice(1)) assert.ok(Math.abs(l.halfKm - (l.size * l.kmPerPixel) / 2) < 1e-9, l.name);
  for (const s of meta.sources) if (hasRaw(s.name)) assert.equal(statSync(new URL(s.name, RAW)).size, s.bytes, s.name);
});

test('phase 2 products and terrain.json keys are unchanged', () => {
  const sha = (name) => createHash('sha256').update(bytes(name)).digest('hex');
  assert.equal(sha('dem_480m.bin'), 'a0094d24e53abbe3250eab3a3c3f037f86d6b522643a53eaa7ae3ee9debfe531');
  assert.equal(sha('horizon_grid.bin'), 'fc8d114aeaf24741b90f98c3128a173f46dc1428891ed124aeb495b4e5804618');
  assert.equal(meta.source, 'NASA PDS, LRO LOLA LDEM_75S_240M (https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ldem_75s_240m.img)');
  assert.deepEqual(meta.dem, { file: 'dem_480m.bin', size: 1906, kmPerPixel: 0.48, dnToMeters: 0.5 });
  assert.deepEqual(meta.horizon, { file: 'horizon_grid.bin', size: 320, cellKm: 2, halfKm: 320, azimuths: 72, offsetDeg: -5, stepDeg: 0.1, observerM: 2, maxKm: 300, sourceKmPerPixel: 0.24 });
  assert.deepEqual(Object.keys(meta).slice(0, 4), ['source', 'generatedAt', 'dem', 'horizon']);
});

const CROP_POINTS = [[0, 0], [1, 2699], [1349, 1350], [2000, 77], [2599, 2599], [517, 1888]];

test('dem_240m is the centred 2700 crop of the 240 m source', { skip: !hasRaw('ldem_75s_240m.img') && 'raw 240 m grid missing' }, () => {
  const src = int16(readFileSync(new URL('ldem_75s_240m.img', RAW)));
  const crop = int16(bytes('dem_240m.bin'));
  const o = (3812 - 2700) / 2;
  for (const [r, c] of [...CROP_POINTS, [2699, 0]]) assert.equal(crop[r * 2700 + c], src[(r + o) * 3812 + c + o], `${r},${c}`);
  // Same heights through createDem, so the crop is centred on the pole.
  const a = createDem({ data: crop, size: 2700, kmPerPixel: 0.24 });
  const b = createDem({ data: src, size: 3812, kmPerPixel: 0.24 });
  for (const p of [SHACKLETON, RIDGE, ...FLOORS, { latDeg: -80.5, lonDeg: 10 }]) assert.ok(Math.abs(a.heightAt(p.latDeg, p.lonDeg) - b.heightAt(p.latDeg, p.lonDeg)) < 1e-6, p.name ?? `${p.latDeg},${p.lonDeg}`);
});

test('dem_120m is the centred 2600 crop of the 120 m source', { skip: !hasRaw('ldem_75s_120m.img') && 'raw 120 m grid missing' }, (t) => {
  const src = int16(readFileSync(new URL('ldem_75s_120m.img', RAW)));
  const crop = int16(bytes('dem_120m.bin'));
  const o = (7624 - 2600) / 2;
  for (const [r, c] of [...CROP_POINTS.filter(([r, c]) => r < 2600 && c < 2600), [1, 2599]]) assert.equal(crop[r * 2600 + c], src[(r + o) * 7624 + c + o], `${r},${c}`);
  // Against the 240 m grid: heights near the pole agree to within the difference in resolution.
  const fine = createDem({ data: crop, size: 2600, kmPerPixel: 0.12 });
  const coarse = createDem({ data: int16(bytes('dem_240m.bin')), size: 2700, kmPerPixel: 0.24 });
  const diffs = [];
  for (let x = -150; x <= 150; x += 7.3) for (let y = -150; y <= 150; y += 7.3) diffs.push(Math.abs(fine.heightAtXY(x, y) - coarse.heightAtXY(x, y)));
  diffs.sort((p, q) => p - q);
  const median = diffs[diffs.length >> 1];
  t.diagnostic(`120 m vs 240 m height, ${diffs.length} points: median |Δ| ${median.toFixed(1)} m, max ${diffs.at(-1).toFixed(1)} m`);
  assert.ok(median < 20, `median ${median} m`);
});

for (const s of meta.shadow) {
  test(`${s.name}: crater floors are persistent shadow, Shackleton ridge is not`, () => {
    const d = bytes(s.file);
    for (const f of FLOORS) assert.equal(d[cellOf(s.size, s.cellKm, 320, f.latDeg, f.lonDeg)], 0, f.name);
    assert.ok(d[cellOf(s.size, s.cellKm, 320, RIDGE.latDeg, RIDGE.lonDeg)] > 0, 'ridge');
    // phase 4: the grids come from the official PSR map, not the 6 h ephemeris scan
    assert.ok(s.source.includes('LPSR_75S_120M_201608'), s.source);
  });
}

for (const s of meta.slope) {
  test(`${s.name}: Shackleton wall is steeper than its floor`, (t) => {
    const g = bytes(s.file);
    const floor = g[cellOf(s.size, s.cellKm, 320, SHACKLETON.latDeg, SHACKLETON.lonDeg)] * s.scale;
    const [cx, cy] = toXY(SHACKLETON.latDeg, SHACKLETON.lonDeg);
    let sum = 0, n = 0;
    for (const r of [6, 7, 8]) {
      for (let a = 0; a < 360; a += 10) {
        const x = cx + r * Math.sin((a * Math.PI) / 180), y = cy + r * Math.cos((a * Math.PI) / 180);
        sum += g[Math.floor((320 - y) / s.cellKm) * s.size + Math.floor((x + 320) / s.cellKm)] * s.scale;
        n++;
      }
    }
    t.diagnostic(`floor ${floor}°, wall ring 6–8 km mean ${(sum / n).toFixed(1)}°`);
    assert.ok(sum / n > floor + 15, `wall ${sum / n}°, floor ${floor}°`);
  });
}

test('1 km skylines agree with the 2 km grid', (t) => {
  const h2 = bytes('horizon_grid.bin'), h1 = bytes('horizon_1km.bin');
  const diffs = new Float64Array(320 * 320 * 72);
  let sum = 0, n = 0;
  // Each 2 km cell centre is the shared corner of four 1 km cells; compare with their mean.
  for (let J = 0; J < 320; J++) for (let I = 0; I < 320; I++) for (let a = 0; a < 72; a++) {
    let m = 0;
    for (const [dj, di] of [[0, 0], [0, 1], [1, 0], [1, 1]]) m += h1[((2 * J + dj) * 640 + 2 * I + di) * 72 + a];
    const d = (m / 4 - h2[(J * 320 + I) * 72 + a]) * 0.1;
    diffs[n++] = Math.abs(d);
    sum += d;
  }
  diffs.sort();
  const q = (p) => diffs[Math.floor(p * (n - 1))].toFixed(3);
  t.diagnostic(`${n} cell-azimuths: bias ${(sum / n).toFixed(4)}°, |Δ| median ${q(0.5)}°, p90 ${q(0.9)}°, p95 ${q(0.95)}°, p99 ${q(0.99)}°, max ${q(1)}°`);
  assert.ok(Math.abs(sum / n) < 0.05, 'bias');
  assert.ok(Number(q(0.5)) < 0.5, 'median');
});
