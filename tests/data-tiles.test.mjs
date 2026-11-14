// Phase 4 workstream D, tiled elevation data (§3 D.2, contract §4.1): tile coordinates, slicing with the
// 1-pixel apron, and the shipped dem_40m / dem_20m tiles against their LOLA sources and against dem_120m.
// (Named data-tiles so it does not collide with workstream T's tiles.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { toXY, createDem } from '../demo/src/terrain.js';
import {
  NO_DATA, BUDGET, tileKm, tileCount, tileId, tileName, parseTileId, tileBounds, tileAt, tilesInCircle,
  sourceShift, sliceTile, coreHasData, tileHeightAt, coverage, blockCorrelation,
} from '../tools/build-tiles.mjs';

const DATA = new URL('../demo/data/', import.meta.url);
const RAW = new URL('../data-raw/lola/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA)));
const int16 = (buf) => new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);

// A toy level: 4 × 4 tiles of 4 px at 1 km/px over ±8 km, and a 12 × 12 source (±6 km, pole between
// the middle pixels) so the outer ring of tiles is partly outside the source.
const TOY = { name: 'toy', kmPerPixel: 1, tilePx: 4, apronPx: 1, halfKm: 8, dnToMeters: 0.5 };
const TOY_SRC = 12;
const toySrc = Int16Array.from({ length: TOY_SRC * TOY_SRC }, (_, k) => k);   // value = row·12 + col

test('D tiles: geometry follows contract §4.1', () => {
  const L40 = meta.levels.find((l) => l.name === 'dem_40m');
  assert.ok(Math.abs(tileKm(L40) - 10.24) < 1e-12);
  assert.equal(tileCount(L40), 60);
  assert.equal(tileId(3, 7), 'r03c07');
  assert.equal(tileName(L40, 27, 30), 'dem_40m_r27c30');
  assert.deepEqual(parseTileId('r27c30'), { row: 27, col: 30 });
  assert.equal(parseTileId('r1c2'), null);
  assert.deepEqual(tileBounds(TOY, 0, 0), { x0: -8, x1: -4, y0: 4, y1: 8 });
  assert.deepEqual(tileBounds(TOY, 3, 2), { x0: 0, x1: 4, y0: -8, y1: -4 });
  // half-open edges: x ∈ [x0, x1), y ∈ (y0, y1]
  assert.deepEqual(tileAt(TOY, 0, 0), { row: 2, col: 2 });
  assert.deepEqual(tileAt(TOY, -0.001, 0.001), { row: 1, col: 1 });
  assert.deepEqual(tileAt(TOY, -8, 8), { row: 0, col: 0 });
  assert.equal(tileAt(TOY, 8, 0), null);
  assert.equal(tileAt(TOY, 0, -8), null);
  // the pole of the real levels sits on the corner shared by four tiles
  assert.deepEqual(tileAt(L40, 0, 0), { row: 30, col: 30 });
  assert.deepEqual(tileAt(meta.levels.find((l) => l.name === 'dem_20m'), 0, 0), { row: 15, col: 15 });
});

test('D tiles: tilesInCircle takes every tile that the circle touches', () => {
  assert.deepEqual(tilesInCircle(TOY, 0, 0, 0.5).map((t) => tileId(t.row, t.col)), ['r01c01', 'r01c02', 'r02c01', 'r02c02']);
  // a circle inside one tile
  assert.deepEqual(tilesInCircle(TOY, 2, 2, 1), [{ row: 1, col: 2 }]);
  // reaching the neighbour exactly at its edge counts
  assert.deepEqual(tilesInCircle(TOY, 2, 2, 2).map((t) => tileId(t.row, t.col)), ['r00c02', 'r01c01', 'r01c02', 'r01c03', 'r02c02']);
  assert.equal(tilesInCircle(TOY, 0, 0, 100).length, 16);
  assert.deepEqual(coverage(TOY, { poleKm: 0.5, siteKm: 1, sites: [{ xKm: 6, yKm: -6 }] }), ['r01c01', 'r01c02', 'r02c01', 'r02c02', 'r03c03']);
});

test('D tiles: sourceShift requires pixel-aligned grids', () => {
  assert.equal(sourceShift(TOY, TOY_SRC / 2 - 0.5), -2);           // 0.5 + 5.5 − 8
  assert.equal(sourceShift(meta.levels.find((l) => l.name === 'dem_40m'), 7599.5), -80);
  assert.equal(sourceShift(meta.levels.find((l) => l.name === 'dem_20m'), 3791.5), -48);
  assert.throws(() => sourceShift(TOY, 5));
});

test('D tiles: sliceTile core, apron from the neighbours, no data outside the source', () => {
  const shift = sourceShift(TOY, TOY_SRC / 2 - 0.5);
  const n = TOY.tilePx + 2;
  const t11 = sliceTile(toySrc, TOY_SRC, shift, TOY, 1, 1);
  // core pixel (0, 0) of tile (1, 1) is source pixel (1·4 − 2, 1·4 − 2) = (2, 2)
  assert.equal(t11[1 * n + 1], 2 * 12 + 2);
  assert.equal(t11[0], 1 * 12 + 1);                                   // apron corner = diagonal neighbour
  // overlap: tile (1, 2)'s left apron column equals tile (1, 1)'s last core column, and vice versa
  const t12 = sliceTile(toySrc, TOY_SRC, shift, TOY, 1, 2);
  for (let r = 0; r < n; r++) {
    assert.equal(t12[r * n + 0], t11[r * n + n - 2], `row ${r}`);
    assert.equal(t11[r * n + n - 1], t12[r * n + 1], `row ${r}`);
  }
  const t21 = sliceTile(toySrc, TOY_SRC, shift, TOY, 2, 1);
  for (let c = 0; c < n; c++) assert.equal(t21[c], t11[(n - 2) * n + c], `col ${c}`);
  // tile (0, 0): source rows/cols −3…2, so the apron and the first core row/column are outside the source
  const t00 = sliceTile(toySrc, TOY_SRC, shift, TOY, 0, 0);
  assert.equal(t00[0], NO_DATA);
  assert.equal(t00[2 * n + 2], NO_DATA);                              // source (−1, −1)
  assert.equal(t00[3 * n + 3], 0);                                    // source (0, 0)
  assert.ok(coreHasData(t00, TOY));
  assert.ok(!coreHasData(new Int16Array(n * n).fill(NO_DATA), TOY));
});

test('D tiles: tileHeightAt is continuous across tile edges and matches createDem on the source', () => {
  const shift = sourceShift(TOY, TOY_SRC / 2 - 0.5);
  const dem = createDem({ data: toySrc, size: TOY_SRC, kmPerPixel: 1 });
  const tiles = {};
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) tiles[tileId(r, c)] = sliceTile(toySrc, TOY_SRC, shift, TOY, r, c);
  for (let x = -5.25; x <= 5.25; x += 0.25) for (let y = -5.25; y <= 5.25; y += 0.25) {
    const { row, col } = tileAt(TOY, x, y);
    const h = tileHeightAt(tiles[tileId(row, col)], TOY, row, col, x, y);
    assert.ok(Math.abs(h - dem.heightAtXY(x, y)) < 1e-9, `${x},${y}`);
  }
  // a point on the edge x = 0 read from the left tile (through its apron) and from the right tile
  const left = tileHeightAt(tiles.r01c01, TOY, 1, 1, 0, 1.3), right = tileHeightAt(tiles.r01c02, TOY, 1, 2, 0, 1.3);
  assert.ok(Math.abs(left - right) < 1e-9);
  // near the source edge a corner is no data
  assert.equal(tileHeightAt(tiles.r00c00, TOY, 0, 0, -5.9, 5.9), null);
});

const tiled = meta.levels.filter((l) => l.tiled);

test('D tiles: terrain.json lists the two tiled levels after the original three', () => {
  assert.deepEqual(meta.levels.map((l) => l.name), ['dem_480m', 'dem_240m', 'dem_120m', 'dem_40m', 'dem_20m']);
  for (const l of tiled) {
    for (const k of ['name', 'tiled', 'kmPerPixel', 'dnToMeters', 'tilePx', 'apronPx', 'halfKm', 'tiles']) assert.ok(k in l, `${l.name}.${k}`);
    assert.equal(l.tilePx, 256);
    assert.equal(l.apronPx, 1);
    assert.equal(l.dnToMeters, 0.5);
    assert.deepEqual(l.tiles, [...l.tiles].sort());
    assert.equal(new Set(l.tiles).size, l.tiles.length);
  }
  assert.equal(tiled[0].halfKm, 307.2);
  assert.equal(tiled[1].halfKm, 76.8);
});

test('D tiles: shipped files, sizes, budget, coverage', () => {
  let total = 0;
  const sites = JSON.parse(readFileSync(new URL('sites.json', DATA)));
  for (const l of tiled) {
    const listed = new Set(l.tiles.map((id) => `${l.name}_${id}.bin`));
    const onDisk = readdirSync(DATA).filter((f) => f.startsWith(`${l.name}_r`) && f.endsWith('.bin'));
    assert.deepEqual(new Set(onDisk), listed, `${l.name}: files on disk = tiles listed`);
    for (const f of listed) {
      const s = statSync(new URL(f, DATA)).size;
      assert.equal(s, 258 * 258 * 2, f);
      total += s;
    }
    // the pole circle is covered, and every site in the source extent
    const pole = tilesInCircle(l, 0, 0, l.coverage.poleKm).map((t) => tileId(t.row, t.col));
    for (const id of pole) assert.ok(l.tiles.includes(id), `${l.name} pole tile ${id}`);
    for (const siteId of l.coverage.sites) {
      const s = sites.find((x) => x.id === siteId);
      const [x, y] = toXY(s.latDeg, s.lonDeg);
      const t = tileAt(l, x, y);
      assert.ok(l.tiles.includes(tileId(t.row, t.col)), `${l.name} ${siteId}`);
    }
  }
  assert.ok(total <= BUDGET, `${total} bytes`);
});

for (const [name, raw, size] of [['dem_40m', 'ldem_80s_40m.img', 15200], ['dem_20m', 'ldem_875s_20m.img', 7584]]) {
  test(`D tiles: ${name} tiles are slices of ${raw}, with matching aprons`, { skip: !existsSync(new URL(raw, RAW)) && `${raw} missing` }, () => {
    const l = meta.levels.find((x) => x.name === name);
    const src = int16(readFileSync(new URL(raw, RAW)));
    const shift = sourceShift(l, size / 2 - 0.5);
    const n = 258;
    let pairs = 0;
    for (const id of l.tiles) {
      const { row, col } = parseTileId(id);
      const tile = int16(readFileSync(new URL(`${name}_${id}.bin`, DATA)));
      assert.deepEqual(tile, sliceTile(src, size, shift, l, row, col), id);
      // apron overlap with the right-hand and lower neighbours when they are shipped
      const right = tileId(row, col + 1);
      if (l.tiles.includes(right)) {
        const t2 = int16(readFileSync(new URL(`${name}_${right}.bin`, DATA)));
        for (let r = 0; r < n; r++) { assert.equal(t2[r * n], tile[r * n + n - 2]); assert.equal(tile[r * n + n - 1], t2[r * n + 1]); }
        pairs++;
      }
      const below = tileId(row + 1, col);
      if (l.tiles.includes(below)) {
        const t2 = int16(readFileSync(new URL(`${name}_${below}.bin`, DATA)));
        for (let c = 0; c < n; c++) { assert.equal(t2[c], tile[(n - 2) * n + c]); assert.equal(tile[(n - 1) * n + c], t2[n + c]); }
        pairs++;
      }
    }
    assert.ok(pairs > 0);
  });
}

// Georeferencing: f × f block means of the fine tiles against dem_120m over every other 120 m pixel that
// the shipped tiles cover; shifting the fine grid by one 120 m pixel must fit worse.
for (const [name, f] of [['dem_40m', 3], ['dem_20m', 6]]) {
  test(`D tiles: ${name} block means line up with dem_120m`, (t) => {
    const l = meta.levels.find((x) => x.name === name);
    const coarse = { data: int16(readFileSync(new URL('dem_120m.bin', DATA))), size: 2600, kmPerPixel: 0.12 };
    const tiles = new Map(l.tiles.map((id) => [id, int16(readFileSync(new URL(`${name}_${id}.bin`, DATA)))]));
    const zero = blockCorrelation(l, tiles, coarse);
    const shifted = [[0, f], [0, -f], [f, 0], [-f, 0]].map(([dr, dc]) => blockCorrelation(l, tiles, coarse, { dr, dc }));
    t.diagnostic(`${name}: ${zero.n} 120 m pixels, r = ${zero.r.toFixed(6)}, mean |Δh| ${zero.madM.toFixed(2)} m, bias ${zero.biasM.toFixed(2)} m; shifted one 120 m pixel: mean |Δh| ${shifted.map((s) => s.madM.toFixed(1)).join(', ')} m`);
    assert.ok(zero.n > 10000);
    assert.ok(zero.r > 0.999, `r ${zero.r}`);
    for (const s of shifted) assert.ok(s.madM > 2 * zero.madM, 'zero shift fits best');
  });
}
