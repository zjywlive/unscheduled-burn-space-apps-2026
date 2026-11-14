// High-resolution site patches (tools/fetch-hires.mjs, demo/src/hires.js): the pixel window arithmetic, the
// patch sampler, and agreement with the existing 20 m and 120 m levels (a georeferencing check).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { productFor, patchWindow, PRODUCTS, despike, despikeM } from '../tools/fetch-hires.mjs';
import { createPatch, createHiresSet } from '../demo/src/hires.js';
import { createDem, createTiledDem, toXY } from '../demo/src/terrain.js';

const DATA = new URL('../demo/data/', import.meta.url);
const manifestPath = new URL('hires.json', DATA);
const have = existsSync(manifestPath);
const manifest = have ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
function load(name) {
  const p = new URL(`js/${name}.js`, DATA);
  if (!existsSync(p)) return Promise.reject(new Error(`${name} missing`));
  const m = readFileSync(p, 'utf8').match(/^window\.__lsnData\("([a-z0-9_]+)","([A-Za-z0-9+/=]+)"\);?\s*$/);
  return Promise.resolve(new Uint8Array(Buffer.from(m[2], 'base64')));
}
let seed = 99;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

test('product choice: the finest product whose square and latitude limit cover the patch', () => {
  assert.equal(productFor(...toXY(-89.45, 222.69), 5).name, 'ldem_875s_5m');
  assert.equal(productFor(...toXY(-86.7, 336.3), 5).name, 'ldem_85s_10m');
  assert.equal(productFor(...toXY(-84.3, 30.6), 5).name, 'ldem_80s_20m');
  assert.equal(productFor(...toXY(-80.13, 1.44), 5), null);   // IM-1: past the 20 m product's 80°S edge
});

test('patch window: n × n pixels, edges on pixel boundaries, centred on the site within a pixel', () => {
  const p = PRODUCTS[0], [x, y] = toXY(-89.45, 222.69), w = patchWindow(p, x, y, 5);
  assert.equal(w.n, 2000);
  assert.ok(Math.abs((w.xMin + w.xMax) / 2 - x) <= p.kmPerPixel && Math.abs((w.yMin + w.yMax) / 2 - y) <= p.kmPerPixel);
  const c = p.size / 2 - 0.5;
  assert.ok(Math.abs((w.xMin / p.kmPerPixel + c + 0.5) - w.c0) < 1e-6, 'xMin is the left edge of column c0');
});

test('createPatch samples bilinearly between pixel centres and is NaN outside', () => {
  const data = Int16Array.from([0, 2, 4, 6]);   // 2 × 2 DN
  const p = createPatch({ data, n: 2, kmPerPixel: 1, xMin: 0, yMax: 2 });
  assert.equal(p.sample(0.5, 1.5), 0);
  assert.equal(p.sample(1.5, 0.5), 3);           // DN 6 × 0.5 m
  assert.equal(p.sample(1, 1), 1.5);             // the middle: mean of 0, 1, 2, 3 m
  assert.ok(Number.isNaN(p.sample(-0.1, 1)));
  assert.equal(p.heightAtXY(5, 5), null);
});

test('Shackleton 5 m patch agrees with the 20 m level (same terrain, finer pixels)', { skip: !have && 'no hires.json' }, async () => {
  const set = createHiresSet(manifest, load);
  const patch = await set.ensureSite('shackleton');
  assert.equal(patch.kmPerPixel, 0.005);
  const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA)));
  const l20 = meta.levels.find((l) => l.name === 'dem_20m');
  const t20 = createTiledDem(l20);
  const need = t20.missing(patch.bounds);
  for (const pack of need) {
    const f = new URL(`${pack}.bin`, DATA);
    if (existsSync(f)) { const b = readFileSync(f); t20.addTile(pack, new Int16Array(b.buffer, b.byteOffset, b.length / 2)); }
  }
  const d = [];
  for (let k = 0; k < 400; k++) {
    const x = patch.xMin + 0.2 + rnd() * (patch.xMax - patch.xMin - 0.4), y = patch.yMin + 0.2 + rnd() * (patch.yMax - patch.yMin - 0.4);
    const a = patch.sample(x, y), b = t20.sample(x, y);
    if (a === a && b === b) d.push(Math.abs(a - b));
  }
  assert.ok(d.length > 200, `${d.length} comparable points`);
  assert.ok(median(d) < 10, `median |5 m − 20 m| = ${median(d).toFixed(1)} m`);   // a georeferencing slip of even one 20 m pixel on these slopes would give tens of metres
});

test('every patch agrees with the 120 m level where both exist', { skip: !have && 'no hires.json' }, async () => {
  const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA)));
  const l = meta.levels.find((q) => q.name === 'dem_120m');
  const b = readFileSync(new URL(l.file, DATA));
  const d120 = createDem({ data: new Int16Array(b.buffer, b.byteOffset, b.length / 2), size: l.size, kmPerPixel: l.kmPerPixel, dnToMeters: l.dnToMeters, halfKm: l.halfKm });
  const set = createHiresSet(manifest, load);
  for (const e of set.entries) {
    const patch = await set.ensureSite(e.id);
    const d = [];
    for (let k = 0; k < 200; k++) {
      const x = patch.xMin + rnd() * (patch.xMax - patch.xMin), y = patch.yMin + rnd() * (patch.yMax - patch.yMin);
      const a = patch.sample(x, y), c = d120.sample(x, y);
      if (a === a && c === c) d.push(Math.abs(a - c));
    }
    if (d.length < 50) continue;   // outside the 120 m level (it reaches about 84.8°S)
    assert.ok(median(d) < 40, `${e.id}: median |patch − 120 m| = ${median(d).toFixed(1)} m`);
  }
  assert.equal(set.list.length, set.entries.length);
  assert.ok(set.list.every((p, i) => i === 0 || set.list[i - 1].kmPerPixel >= p.kmPerPixel), 'loaded patches stay coarse to fine');
});

test('despike replaces a lone spike with its neighbours\' median and leaves slopes alone', () => {
  const n = 5, ramp = Int16Array.from({ length: 25 }, (_, k) => (k % n) * 20);   // a 10 m-per-pixel ramp (DN 20)
  assert.equal(despike(ramp, n, 10).replaced, 0);
  const spiky = Int16Array.from(ramp); spiky[12] += 60;                          // +30 m on the middle pixel
  const r = despike(spiky, n, 10);
  assert.equal(r.replaced, 1);
  assert.equal(r.data[12], ramp[12]);
  assert.equal(despikeM(0.005), 10);
  assert.equal(despikeM(0.02), 40);
});
