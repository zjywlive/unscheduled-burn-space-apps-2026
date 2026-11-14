// Phase 1 global terrain model: pack decoding, tile indexing, heights against the raw LOLA grids, and
// agreement between levels (which is what catches a georeferencing mistake: a wrong axis or offset
// shows up as kilometres of difference, a right one as tens of metres).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { encodePack } from '../tools/build-global.mjs';
import { createDem } from '../demo/src/terrain.js';
import {
  createGlobeTerrain, decodePack, tilesInBox, tileOf, tileName, normLon, toXYNorth,
  G0, G1, G2, NORTH,
} from '../demo/src/globe-terrain.js';

const JS = new URL('../demo/data/js/', import.meta.url);
const RAW = new URL('../data-raw/', import.meta.url);
const packPath = (name) => new URL(`${name}.js`, JS);
function load(name) {
  const p = packPath(name);
  if (!existsSync(p)) return Promise.reject(new Error(`${name} missing`));
  const m = readFileSync(p, 'utf8').match(/^window\.__lsnData\("([a-z0-9_]+)","([A-Za-z0-9+/=]+)"\);?\s*$/);
  if (!m || m[1] !== name) return Promise.reject(new Error(`${name}: bad pack`));
  return Promise.resolve(new Uint8Array(Buffer.from(m[2], 'base64')));
}

let seed = 12345;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const south480 = (() => {
  const b = readFileSync(new URL('../demo/data/dem_480m.bin', import.meta.url));
  return createDem({ data: new Int16Array(b.buffer, b.byteOffset, b.length / 2), size: 1906, kmPerPixel: 0.48, dnToMeters: 0.5 });
})();

test('pack encoding round-trips any Int16 values, including jumps that wrap', async () => {
  const w = 37, v = new Int16Array(w * 23);
  for (let i = 0; i < v.length; i++) v[i] = Math.round((rnd() - 0.5) * 65535);
  v[5] = 32767; v[6] = -32768; v[w] = -32768;
  assert.deepEqual(await decodePack(encodePack(v, w), w), v);
});

test('tile indexing: tiles in a box wrap in longitude and stay inside the latitude rows', () => {
  assert.deepEqual(tileOf(G1, 89.9, 0.1), { r: 0, c: 0 });
  assert.deepEqual(tileOf(G1, -89.9, 359.9), { r: 11, c: 23 });
  assert.equal(tileName(G2, 3, 7), 'globe_g2_r03c07');
  const box = tilesInBox(G1, -10, 10, 350, 370).map(({ r, c }) => `${r},${c}`);
  assert.deepEqual(box, ['5,23', '5,0', '6,23', '6,0']);
  assert.equal(tilesInBox(G1, -90, 90, 0, 360).length, G1.rows * G1.cols);
  assert.equal(normLon(-10), 350);
});

test('G0 covers the whole Moon with the known extremes of LOLA heights', async () => {
  const t = await createGlobeTerrain({ load }).init();
  let min = Infinity, max = -Infinity;
  for (let lat = -89.875; lat < 90; lat += 0.25) for (let lon = 0.125; lon < 360; lon += 0.25) {
    const h = t.heightAt(lat, lon); if (h < min) min = h; if (h > max) max = h;
  }
  assert.ok(max > 10000 && max < 11000, `max ${max}`);    // highest point ~10.6 km, on the far side
  assert.ok(min < -8500 && min > -9500, `min ${min}`);    // South Pole–Aitken basin floor ~ −9.1 km
});

test('G1 tiles: Apollo 11 lies on the low mare plain, the far-side highlands are high', async () => {
  const t = await createGlobeTerrain({ load }).init();
  await t.need(G1, -1, 2, 22, 25);
  const [h, src] = t.sample(0.6741, 23.4730);
  assert.equal(src, G1.label);
  assert.ok(h < -1200 && h > -2600, `Apollo 11 at ${h} m`);
  await t.need(G1, 4, 7, 200, 203);
  assert.ok(t.heightAt(5.4, 201.4) > 9000, 'far-side highlands near the highest point');
});

test('G1 matches the raw LDEM_16 grid exactly at its pixel centres', { skip: !existsSync(new URL('global/ldem_16.img', RAW)) && 'data-raw/global/ldem_16.img not here' }, async () => {
  const b = readFileSync(new URL('global/ldem_16.img', RAW));
  const raw = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
  const t = await createGlobeTerrain({ load }).init();
  for (let k = 0; k < 300; k++) {
    const row = Math.floor(240 + rnd() * 2400), col = Math.floor(rnd() * 5760);   // 75°N–75°S: the poles have their own levels
    const lat = 90 - (row + 0.5) / 16, lon = (col + 0.5) / 16;
    const { r, c } = tileOf(G1, lat, lon);
    await t.loadTile(G1, r, c);
    assert.equal(t.heightAt(lat, lon), raw[row * 5760 + col] * 0.5, `row ${row} col ${col}`);
  }
});

test('G2 matches the raw LDEM_64 grid exactly at its pixel centres', { skip: (!existsSync(new URL('global/ldem_64.img', RAW)) || !existsSync(packPath('globe_g2_r00c00'))) && 'G2 raw grid or packs not here' }, async () => {
  const b = readFileSync(new URL('global/ldem_64.img', RAW));
  const raw = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
  const t = await createGlobeTerrain({ load }).init();
  for (let k = 0; k < 120; k++) {
    const row = Math.floor(960 + rnd() * 9600), col = Math.floor(rnd() * 23040);   // 75°N–75°S
    const lat = 90 - (row + 0.5) / 64, lon = (col + 0.5) / 64;
    const { r, c } = tileOf(G2, lat, lon);
    await t.loadTile(G2, r, c);
    assert.equal(t.heightAt(lat, lon), raw[row * 23040 + col] * 0.5, `row ${row} col ${col}`);
  }
});

test('levels agree where they overlap: G0 vs G1, south pole 480 m vs G1, north cap vs G1', async () => {
  const t = await createGlobeTerrain({ load }).init();
  await t.need(G1, -90, 90, 0, 360, { max: 1000 });
  const g1 = (lat, lon) => t.sample(lat, lon);
  const d0 = [], ds = [], dn = [];
  const g0only = await createGlobeTerrain({ load }).init();
  // the same G1 tiles without the north cap, to compare the cap with G1
  const noNorth = await createGlobeTerrain({ load: (n) => (n === NORTH.name ? Promise.reject(new Error('off')) : load(n)) }).init();
  await noNorth.need(G1, 75, 80, 0, 360, { max: 100 });
  assert.equal(noNorth.hasNorth, false);
  for (let k = 0; k < 400; k++) {
    const lat = -70 + 140 * rnd(), lon = 360 * rnd();
    d0.push(Math.abs(g1(lat, lon)[0] - g0only.heightAt(lat, lon)));
    const ls = -79 + 3 * rnd(), lns = 360 * rnd();
    ds.push(Math.abs(g1(ls, lns)[0] - south480.heightAt(ls, lns)));
    const ln = 76 + 3 * rnd(), lnn = 360 * rnd();
    const [hn, src] = t.sample(ln, lnn);
    assert.equal(src, NORTH.label);
    const [hg, srcg] = noNorth.sample(ln, lnn);
    assert.equal(srcg, G1.label);
    dn.push(Math.abs(hn - hg));
  }
  assert.ok(median(d0) < 250, `G0 vs G1 median ${median(d0)} m`);
  assert.ok(median(ds) < 120, `south 480 m vs G1 median ${median(ds)} m`);
  assert.ok(median(dn) < 120, `north cap vs G1 median ${median(dn)} m`);
});

test('the south pole is served by the polar pyramid, and a missing tile falls back to the next level', async () => {
  const t = await createGlobeTerrain({ load: (n) => (n.startsWith('globe_g2') ? Promise.reject(new Error('absent')) : load(n)), south: () => [south480] }).init();
  const [h, src] = t.sample(-89.67, 129.78);   // Shackleton floor
  assert.match(src, /south pole/);
  assert.ok(h < -1500, `Shackleton floor ${h}`);
  assert.equal(await t.loadTile(G2, 10, 10), false);
  assert.equal(t.isMissing(G2, 10, 10), true);
  await t.need(G1, 40, 50, 140, 150);
  assert.equal(t.sample(43, 145)[1], G1.label);
});

test('north polar stereographic axes: 0°E points to −y, 90°E to +x', () => {
  const [x0, y0] = toXYNorth(80, 0), [x9, y9] = toXYNorth(80, 90);
  assert.ok(Math.abs(x0) < 1e-9 && y0 < 0);
  assert.ok(x9 > 0 && Math.abs(y9) < 1e-9);
});
