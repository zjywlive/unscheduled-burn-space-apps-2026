// Phase 4 T.1–T.2: tiled elevation levels, the pyramid's choice and fall-back, and the packs a viewport
// needs. Fixtures follow task book phase 4 §4.1 exactly (256² tiles, 1 px apron, −32768 = no data).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDem, createPyramid, createTiledDem, planTiles, tilesIn, tileBounds, tileGridSize, parseTile, tilePack,
  TILE_BUDGET, NO_DATA,
} from '../demo/src/terrain.js';
import { neededPacks, STARTUP_PACKS } from '../demo/src/map/tiers.js';
import { viewBounds, frameBounds, kmPerPx, scaleFrame, unitPxForDisc } from '../demo/src/map/view.js';
import { LEVEL_40, LEVEL_20, terrainM, makeTile, tileBytes, tilesMeeting, referenceDem } from './helpers/tiles.mjs';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('tile geometry follows §4.1: names, extents, the grid and the point → tile rule', () => {
  assert.equal(tileGridSize(LEVEL_40), 60);
  assert.equal(tileGridSize(LEVEL_20), 30);
  assert.deepEqual(parseTile('dem_40m_r27c30'), { level: 'dem_40m', row: 27, col: 30 });
  assert.deepEqual(parseTile('r05c09'), { level: null, row: 5, col: 9 });
  assert.equal(parseTile('dem_40m'), null);
  assert.equal(tilePack(LEVEL_20, 14, 5), 'dem_20m_r14c05');
  const b = tileBounds(LEVEL_40, 27, 30);
  assert.ok(near(b.x0, 0, 1e-9) && near(b.x1, 10.24, 1e-9) && near(b.y1, 307.2 - 27 * 10.24, 1e-9) && near(b.y0, b.y1 - 10.24, 1e-9));
  // the pole sits on the corner of four 40 m tiles (rows 29/30, cols 29/30) and of four 20 m tiles (14/15)
  const lvl = createTiledDem({ ...LEVEL_40, tiles: ['r29c29', 'r29c30', 'r30c29', 'r30c30'] });
  assert.deepEqual(tilesIn(lvl, { x0: -1, y0: -1, x1: 1, y1: 1 }).map((t) => t.id).sort(), ['r29c29', 'r29c30', 'r30c29', 'r30c30']);
  assert.deepEqual(tilesIn(lvl, { x0: 0.5, y0: 0.5, x1: 1, y1: 1 }).map((t) => t.id), ['r29c30']);   // +x right, +y up
  assert.deepEqual(tilesIn(lvl, { x0: -1, y0: -1, x1: -0.5, y1: -0.5 }).map((t) => t.id), ['r30c29']);
  assert.deepEqual(tilesIn(lvl, { x0: 50, y0: 50, x1: 60, y1: 60 }), []);                              // not listed
});

test('a tiled level reproduces the source pixels, bilinear between centres, with no seam at tile borders', () => {
  const ids = tilesMeeting(LEVEL_40, { x0: -5, y0: -5, x1: 5, y1: 5 });
  const lvl = createTiledDem({ ...LEVEL_40, tiles: ids.map((t) => t.id) });
  for (const t of ids) lvl.addTile(t.id, tileBytes(makeTile(LEVEL_40, t.row, t.col)));
  assert.equal(lvl.loadedCount, 4);
  const ref = referenceDem(LEVEL_40);
  let worst = 0;
  // a fine grid of points, including points exactly on and next to the tile border at x = 0 and y = 0
  for (let x = -3; x <= 3; x += 0.0137) for (const y of [-2.5, -0.02, -1e-9, 0, 1e-9, 0.019, 0.02, 0.0213, 1.7]) {
    worst = Math.max(worst, Math.abs(lvl.heightAtXY(x, y) - ref.heightAtXY(x, y)));
    worst = Math.max(worst, Math.abs(lvl.heightAtXY(y, x) - ref.heightAtXY(y, x)));
  }
  assert.ok(worst < 1e-6, `worst ${worst} m`);
  // at a pixel centre the height is the DN × 0.5
  const xc = -307.2 + (30 * 256 + 10 + 0.5) * 0.04, yc = 307.2 - (29 * 256 + 200 + 0.5) * 0.04;
  assert.equal(lvl.heightAtXY(xc, yc), Math.round(terrainM(xc, yc) / 0.5) * 0.5);
  // continuity across the border: left and right limits agree
  assert.ok(Math.abs(lvl.heightAtXY(-1e-12, 0.5) - lvl.heightAtXY(0, 0.5)) < 1e-6);
});

test('no data: unlisted or unloaded tiles and −32768 pixels give null; bad tiles are refused', () => {
  const inSource = (x) => x < 1;                                       // the source raster ends at x = 1 km
  const lvl = createTiledDem({ ...LEVEL_40, tiles: ['r29c30', 'r30c30'] });
  assert.equal(lvl.heightAtXY(0.5, 0.5), null);                        // listed, not loaded yet
  lvl.addTile('dem_40m_r29c30', makeTile(LEVEL_40, 29, 30, terrainM, inSource));
  assert.equal(typeof lvl.heightAtXY(0.5, 0.5), 'number');
  assert.equal(lvl.heightAtXY(1.2, 0.5), null);                        // −32768 beyond the source edge
  assert.ok(Number.isNaN(lvl.sample(1.2, 0.5)));
  assert.equal(lvl.heightAtXY(-0.5, 0.5), null);                       // not listed
  assert.equal(lvl.heightAtXY(400, 0), null);                          // off the grid
  assert.throws(() => lvl.addTile('r29c30', new Int16Array(10)), /expected 66564/);
  assert.throws(() => lvl.addTile('dem_20m_r29c30', makeTile(LEVEL_40, 29, 30)), /belongs to dem_20m/);
  assert.throws(() => lvl.addTile('r99c00', makeTile(LEVEL_40, 0, 0)), /no tile/);
  assert.deepEqual(lvl.missing({ x0: 0, y0: -1, x1: 1, y1: 1 }), ['dem_40m_r30c30']);
  assert.equal(NO_DATA, -32768);
});

// Levels as main.js has them: 480 m, 240 m and 120 m plain, plus the two tiled levels.
const flat = (size, k, halfKm) => createDem({ data: new Int16Array(size * size), size, kmPerPixel: k, halfKm });
const plain = () => [flat(4, 0.48, 457.44), flat(4, 0.24, 324), flat(4, 0.12, 156)];
// 40 m tiles within ±41 km of the pole, 20 m tiles within ±20.48 km (the §3 D.2 coverage, as squares)
const ids40 = tilesMeeting(LEVEL_40, { x0: -40, y0: -40, x1: 40, y1: 40 }).map((t) => t.id);
const ids20 = tilesMeeting(LEVEL_20, { x0: -20, y0: -20, x1: 20, y1: 20 }).map((t) => t.id);
const meta40 = { ...LEVEL_40, tiles: ids40 }, meta20 = { ...LEVEL_20, tiles: ids20 };

test('pick without tiled levels is the phase 3 rule; a tiled level only comes in when the plain ones are not fine enough', () => {
  const [d480, d240, d120] = plain();
  const p = createPyramid([d480, d240, d120]);
  const t40 = p.add(createTiledDem(meta40)), t20 = p.add(createTiledDem(meta20));
  assert.deepEqual(p.levels.map((d) => d.kmPerPixel), [0.48, 0.24, 0.12, 0.04, 0.02]);
  const full = { x0: -320, y0: -320, x1: 320, y1: 320 };
  assert.equal(p.pick(0.64, full), d480);                               // zoom 1: unchanged
  assert.equal(p.pick(0.3, full), d240);
  assert.equal(p.pick(0.12, { x0: -20, y0: -20, x1: 20, y1: 20 }), d120);   // 120 m is fine enough: no tiles
  // 0.05 km/px over a 30 km box at the pole: 40 m is the coarsest fine enough level
  const c40 = p.pick(0.05, { x0: -15, y0: -15, x1: 15, y1: 15 });
  assert.equal(c40.composite, true);
  assert.equal(c40.level, t40);
  assert.equal(c40.kmPerPixel, 0.04);
  assert.deepEqual(c40.chain.map((d) => d.kmPerPixel), [0.04, 0.12]);
  const c20 = p.pick(0.01, { x0: -5, y0: -5, x1: 5, y1: 5 });          // none fine enough: the finest
  assert.equal(c20.level, t20);
  assert.deepEqual(c20.chain.map((d) => d.kmPerPixel), [0.02, 0.04, 0.12]);
  // away from the 20 m tiles (but inside the 40 m ones) a fine request gets 40 m
  assert.equal(p.pick(0.01, { x0: 30, y0: 30, x1: 35, y1: 35 }).level, t40);
  // far from all tiles: the phase 3 answer
  assert.equal(p.pick(0.01, { x0: 100, y0: 100, x1: 110, y1: 110 }), d120);
  // without the 120 m level loaded, the 240 m level is the base the chain ends in
  const q = createPyramid([d480, d240, createTiledDem(meta40)]);
  assert.deepEqual(q.pick(0.05, { x0: -15, y0: -15, x1: 15, y1: 15 }).chain.map((d) => d.kmPerPixel), [0.04, 0.24]);
});

test('the composite falls back level by level: missing tile → 40 m → 120 m, and reports what is missing', () => {
  const d120 = createDem({ data: new Int16Array(400 * 400).fill(2000), size: 400, kmPerPixel: 0.12, halfKm: 24 });   // 1000 m everywhere
  const p = createPyramid([d120]);
  const t40 = p.add(createTiledDem(meta40)), t20 = p.add(createTiledDem(meta20));
  const box = { x0: -4, y0: -4, x1: 4, y1: 4 };
  const v0 = p.version;
  let c = p.pick(0.01, box);
  assert.equal(c.level, t20);
  assert.equal(c.heightAtXY(1, 1), 1000);                               // nothing loaded: 120 m
  assert.equal(c.kmPerPixelAt(1, 1), 0.12);
  assert.deepEqual([...c.missing].sort(), tilesMeeting(LEVEL_20, { x0: -4.05, y0: -4.05, x1: 4.05, y1: 4.05 }).map((t) => `dem_20m_${t.id}`).sort());
  assert.ok(p.addTile('dem_40m_r29c30', tileBytes(makeTile(LEVEL_40, 29, 30))));
  assert.ok(p.version > v0);
  c = p.pick(0.01, box);
  assert.ok(near(c.heightAtXY(1, 1), terrainM(1, 1), 30));              // 40 m now
  assert.equal(c.kmPerPixelAt(1, 1), 0.04);
  assert.equal(c.kmPerPixelAt(-1, 1), 0.12);                            // its neighbour tile is not loaded
  assert.ok(p.addTile('dem_20m_r14c15', tileBytes(makeTile(LEVEL_20, 14, 15))));
  c = p.pick(0.01, box);
  assert.equal(c.kmPerPixelAt(1, 1), 0.02);
  assert.ok(!c.missing.includes('dem_20m_r14c15'));
  assert.deepEqual(p.missing(0.01, box), c.missing);
  assert.equal(p.addTile('dem_10m_r00c00', new Int16Array(4)), false); // no such level
  assert.equal(t40.loadedCount, 1);
});

test('tile budget: one viewport never needs more than TILE_BUDGET tile packs, at any canvas size', () => {
  assert.equal(TILE_BUDGET, 64);
  // every 40 m tile within ±100 km and every 20 m tile listed: far more than the budget in a wide view
  const wide40 = { ...LEVEL_40, tiles: tilesMeeting(LEVEL_40, { x0: -100, y0: -100, x1: 100, y1: 100 }).map((t) => t.id) };
  const wide20 = { ...LEVEL_20, tiles: tilesMeeting(LEVEL_20, { x0: -76, y0: -76, x1: 76, y1: 76 }).map((t) => t.id) };
  const levels = [{ name: 'dem_480m', kmPerPixel: 0.48, halfKm: 457.44 }, { name: 'dem_240m', kmPerPixel: 0.24, halfKm: 324 }, { name: 'dem_120m', kmPerPixel: 0.12, halfKm: 156 }, wide40, wide20];
  // a 1440 × 900 CSS canvas at device pixel ratio 2, 1× disc 832 px (the layout mock), every zoom 1–32
  const frame = scaleFrame({ width: 1440, height: 900, unitPx: unitPxForDisc(832, 304.0) }, 2);
  let worst = 0, tiled = 0;
  for (let zoom = 1; zoom <= 32; zoom *= 1.1) {
    for (const [cx, cy] of [[0, 0], [5.2, -3.1], [40, 40], [-60, 20]]) {
      const view = { cx, cy, zoom };
      const b = frameBounds(view, frame), kpp = kmPerPx(view, frame.unitPx);
      const plan = planTiles(levels, kpp, b);
      const packs = neededPacks(view, { levels, kmPerPx: kpp, bounds: b }).filter((n) => parseTile(n));
      assert.deepEqual(packs, plan.packs);
      worst = Math.max(worst, packs.length);
      if (packs.length) tiled++;
    }
  }
  assert.ok(worst <= TILE_BUDGET, `worst ${worst}`);
  assert.ok(tiled > 20, 'tiles do come in when zoomed in');
  // and a smaller budget is honoured
  const view = { cx: 0, cy: 0, zoom: 20 };
  const b = frameBounds(view, frame), kpp = kmPerPx(view, frame.unitPx);
  assert.ok(planTiles(levels, kpp, b, { maxTiles: 10 }).packs.length <= 10);
});

test('at zoom 24 over Shackleton on a 1440 × 900 canvas (dpr 2) the 20 m tiles are chosen, within budget', () => {
  const levels = [{ name: 'dem_480m', kmPerPixel: 0.48, halfKm: 457.44 }, { name: 'dem_240m', kmPerPixel: 0.24, halfKm: 324 }, { name: 'dem_120m', kmPerPixel: 0.12, halfKm: 156 }, meta40, meta20];
  const frame = scaleFrame({ width: 1440, height: 900, unitPx: unitPxForDisc(832, 304.0) }, 2);
  const view = { cx: 0, cy: -4, zoom: 24 };
  const b = frameBounds(view, frame), kpp = kmPerPx(view, frame.unitPx);
  const plan = planTiles(levels, kpp, b);
  assert.equal(plan.level.name, 'dem_20m');
  assert.ok(plan.packs.length <= TILE_BUDGET && plan.packs.length > 20, `${plan.packs.length}`);
  // the 20 m tiles listed reach x = ±20.48 km; the view (±21.9 km) gets 40 m tiles for the two side strips
  const n20 = plan.packs.filter((n) => n.startsWith('dem_20m_')).length;
  assert.ok(n20 > plan.packs.length / 2 && plan.packs.slice(n20).every((n) => n.startsWith('dem_40m_')), plan.packs.join());
  // nearest the centre first
  const first = parseTile(plan.packs[0]), last = parseTile(plan.packs.at(-1));
  const d = (t) => Math.hypot(-76.8 + (t.col + 0.5) * 5.12 - view.cx, 76.8 - (t.row + 0.5) * 5.12 - view.cy);
  assert.ok(d(first) <= d(last));
});

test('fall-back tiles: a coarser tiled level fills the part of the view the chosen one has no tiles for', () => {
  const levels = [{ name: 'dem_120m', kmPerPixel: 0.12, halfKm: 156 }, meta40, meta20];
  // a 10 km box half inside the 20 m coverage (x ≤ 20.48) and half outside, inside the 40 m coverage
  const b = { x0: 16, y0: -5, x1: 26, y1: 5 };
  const plan = planTiles(levels, 0.01, b);
  assert.equal(plan.level.name, 'dem_20m');
  const p40 = plan.packs.filter((n) => n.startsWith('dem_40m_'));
  assert.ok(p40.length > 0 && p40.length < plan.packs.length);
  // and no 40 m tile wholly under 20 m tiles is asked for: every 40 m tile listed reaches past x = 20.48
  for (const n of p40) { const t = parseTile(n); assert.ok(tileBounds(LEVEL_40, t.row, t.col).x1 > 20.48); }
});

test('neededPacks: the phase 3 call is unchanged; with levels it adds tiles and the 120 m fall-back', () => {
  for (const v of [{ cx: 0, cy: 0, zoom: 1 }, { cx: 0, cy: 0, zoom: 2 }, { cx: 76, cy: -76, zoom: 4 }, { cx: 0, cy: 0, zoom: 32 }, { cx: 0, cy: 200, zoom: 8 }]) {
    const old = neededPacks(v);
    assert.ok(old.every((n) => !parseTile(n)), 'no tiles in the old form');
    // with levels but no kmPerPx: still no tiles, same list
    assert.deepEqual(neededPacks(v, { levels: [meta40, meta20] }), old);
  }
  assert.deepEqual(neededPacks({ cx: 0, cy: 0, zoom: 1 }, { levels: [meta40], kmPerPx: 0.001 }), STARTUP_PACKS);   // zoom 1: start-up only
  const view = { cx: 0, cy: 0, zoom: 16 };
  const levels = [{ name: 'dem_120m', kmPerPixel: 0.12, halfKm: 156 }, meta40, meta20];
  const kpp = kmPerPx(view, 2000);
  const p = neededPacks(view, { levels, kmPerPx: kpp });
  assert.deepEqual(p.slice(0, 9), [...STARTUP_PACKS, 'dem_240m', 'horizon_1km', 'slope_1km', 'shadow_1km', 'dem_120m']);
  assert.deepEqual(p.slice(9), planTiles(levels, kpp, viewBounds(view)).packs);
  assert.equal(new Set(p).size, p.length);
  // a wide frame reaching past ±156 km still gets dem_120m when tiles are listed
  const wide = { x0: -40, y0: -10, x1: 170, y1: 10 };
  const q = neededPacks({ cx: 0, cy: 0, zoom: 4 }, { levels: [{ name: 'dem_120m', kmPerPixel: 0.12, halfKm: 156 }, { ...meta40, tiles: ['r29c30'] }], kmPerPx: 0.03, bounds: wide });
  assert.ok(q.includes('dem_120m') && q.includes('dem_40m_r29c30'));
});
