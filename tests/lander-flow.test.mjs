// Lander track, mission flow and high-resolution descent terrain: where the page starts (URL, stored mission,
// default), the graded descent mesh, the 5/10/20 m patch as the finest terrain level (real im2 pack), and the
// built page carrying the patch manifest, the stage bar slot and the rover link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startingPoint } from '../demo/src/lander/main.js';
import { gradedAxis, terrainGeometry } from '../demo/src/lander/view-surface.js';
import { loadSiteTerrain, hiresPatchFor, fineCore } from '../demo/src/lander/terrain-local.js';
import { createHiresSet, createPatch } from '../demo/src/hires.js';
import { toXY } from '../demo/src/terrain.js';
import { unitFromLonLat } from '../demo/src/geometry.js';
import { R_MOON } from '../demo/src/lander/constants.js';

const demo = new URL('../demo/', import.meta.url).pathname;
const SITES = [
  { id: 'shackleton', name: 'Shackleton ridge', latDeg: -89.45, lonDeg: -137.31 },
  { id: 'im2', name: 'IM-2 Athena', latDeg: -84.79, lonDeg: 29.2 },
];
const EPH = { startMs: Date.parse('2026-11-01T00:00:00Z'), endMs: Date.parse('2029-01-01T00:00:00Z') };
const T = Date.parse('2027-03-02T10:00:00Z');
const q = (s) => new URLSearchParams(s);

test('flow: URL parameters win, then the stored mission, then the default site', () => {
  const mission = { siteId: 'im2', siteName: 'IM-2 Athena', latDeg: -84.79, lonDeg: 29.2, landingMs: T };
  let s = startingPoint(q('?site=shackleton&t=2027-02-01T05:30Z'), mission, SITES, EPH);
  assert.equal(s.site.id, 'shackleton');
  assert.equal(s.landingMs, Date.parse('2027-02-01T05:30Z'));
  assert.equal(s.from, 'url');
  // a URL site without a time picks a lit window (null), and does not borrow the stored mission's time
  s = startingPoint(q('?site=im2'), mission, SITES, EPH);
  assert.equal(s.site.id, 'im2');
  assert.equal(s.landingMs, null);
  s = startingPoint(q(''), mission, SITES, EPH);
  assert.deepEqual([s.site.id, s.landingMs, s.from], ['im2', T, 'mission']);
  s = startingPoint(q(''), null, SITES, EPH);
  assert.deepEqual([s.site.id, s.landingMs, s.from], ['shackleton', null, 'default']);
});

test('flow: a stored or linked point that is not a listed site becomes a custom site south of 80°S only', () => {
  let s = startingPoint(q(''), { siteId: null, siteName: 'Rim point A', latDeg: -89.43, lonDeg: 220.5, landingMs: T }, SITES, EPH);
  assert.deepEqual(s.site, { id: 'custom', name: 'Rim point A', latDeg: -89.43, lonDeg: 220.5 });
  s = startingPoint(q('?site=-88.5,-66.7'), null, SITES, EPH);
  assert.equal(s.site.id, 'custom');
  assert.equal(s.site.latDeg, -88.5);
  // north of the terrain (Apollo 11) or a time outside the ephemeris: back to the default site / a picked time
  s = startingPoint(q(''), { siteId: 'apollo11', latDeg: 0.67, lonDeg: 23.47, landingMs: T }, SITES, EPH);
  assert.equal(s.site.id, 'shackleton');
  s = startingPoint(q(''), { siteId: 'im2', latDeg: -84.79, lonDeg: 29.2, landingMs: Date.parse('2030-01-01T00:00Z') }, SITES, EPH);
  assert.deepEqual([s.site.id, s.landingMs], ['im2', null]);
});

test('mesh: graded axis is symmetric, fine at the centre, coarse at the edge, and ends exactly at ±half', () => {
  const a = gradedAxis(8000, { fine: { stepM: 5, halfM: 1000 } });
  const mid = a.indexOf(0);
  assert.equal(a.length % 2, 1);
  assert.equal(mid, (a.length - 1) / 2);
  assert.equal(a[0], -8000);
  assert.equal(a[a.length - 1], 8000);
  for (let i = 1; i < a.length; i++) assert.ok(a[i] > a[i - 1], `ascending at ${i}`);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] + a[a.length - 1 - i]) < 1e-9, 'symmetric');
  assert.ok(Math.abs(a[mid + 1] - 5) < 1e-9 && Math.abs(a[mid + 200] - 1000) < 1e-6, '5 m steps out to 1 km');
  const steps = a.slice(1).map((v, i) => v - a[i]);
  assert.ok(Math.max(...steps) <= 80 * 1.3 + 1e-9, 'no cell much coarser than 80 m');
  assert.ok(a.length < 700, `vertex budget (${a.length} per side)`);
  // no fine core: n even steps, as before
  const u = gradedAxis(8000, { n: 320 });
  assert.equal(u.length, 321);
  assert.equal(u[160], 0);
});

test('mesh: slopes use the real (graded) spacing; the site is levelled to the planned height', () => {
  const site = SITES[0];
  const siteF = unitFromLonLat(site.lonDeg, site.latDeg);
  const prev = globalThis.THREE;
  globalThis.THREE = {
    BufferGeometry: class { setAttribute(k, v) { this[k] = v; } setIndex(i) { this.index = i; } computeVertexNormals() {} },
    BufferAttribute: class { constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; } },
  };
  try {
    const fine = { stepM: 5, halfM: 500 };
    // a uniform 5° tilt on the map plane reads 5° at the site (curvature adds well under 0.1° here)
    const tan5 = Math.tan(5 * Math.PI / 180);
    const tilt = terrainGeometry(siteF, R_MOON + 1, (x) => 1000 + x * 1000 * tan5, { halfM: 3000, fine, offsetM: 0 });
    const mid = (tilt.N - 1) / 2;
    assert.ok(Math.abs(tilt.slope[mid * tilt.N + mid] - 5) < 0.15, `slope ${tilt.slope[mid * tilt.N + mid]}`);
    assert.ok(Math.abs(tilt.slope[mid * tilt.N + 3] - 5) < 0.3, 'coarse cells too');
    assert.ok(tilt.geometry.index.array instanceof Uint32Array, 'large mesh uses 32-bit indices');
    // flat ground 100 m above the planned site height, shifted down by 100 m: the site vertex sits at 0
    const flat = terrainGeometry(siteF, R_MOON + 1, () => 1100, { halfM: 3000, fine, offsetM: -100 });
    assert.ok(Math.abs(flat.siteHeightM) < 0.01, `site at ${flat.siteHeightM} m`);
    assert.ok(flat.slope[(flat.N - 1) / 2 * flat.N + (flat.N - 1) / 2] < 0.1);
  } finally {
    globalThis.THREE = prev;
  }
});

test('hires: fine core stays inside the patch and on its pixel grid', () => {
  const site = SITES[1];
  const [x, y] = toXY(site.latDeg, site.lonDeg);
  const patch = createPatch({ id: 't', data: new Int16Array(100 * 100), n: 100, kmPerPixel: 0.01, xMin: x - 0.5, yMax: y + 0.5 });
  const c = fineCore(patch, site);
  assert.equal(c.stepM, 10);
  assert.ok(c.halfM > 0 && c.halfM <= (0.5 - 0.02) * 1000 * Math.SQRT1_2 + 1e-9, `half ${c.halfM}`);
  assert.equal(c.halfM % 10, 0);
  assert.equal(fineCore(patch, SITES[0]), null, 'site outside the patch');
  assert.equal(fineCore(null, site), null);
});

// the real im2 pack (20 m, 500 × 500) decoded through hires.js, as the page does
function packLoader(name) {
  const text = readFileSync(join(demo, 'data', 'js', `${name}.js`), 'utf8');
  const b64 = /"([A-Za-z0-9+/=]{100,})"/.exec(text)[1];
  return Promise.resolve(new Uint8Array(Buffer.from(b64, 'base64')));
}
const manifest = JSON.parse(readFileSync(join(demo, 'data', 'hires.json'), 'utf8'));

test('hires: the site patch is the finest terrain level, with its resolution and fine core', async () => {
  const hires = createHiresSet(manifest, packLoader);
  const site = SITES[1];
  const terr = await loadSiteTerrain({ levels: [] }, site, { hires });
  assert.deepEqual(terr.levelsKm, [0.02]);
  assert.equal(terr.hires.id, 'im2');
  assert.equal(terr.hires.sizeKm, 10);
  assert.equal(terr.fine.stepM, 20);
  assert.ok(terr.fine.halfM >= 3400 && terr.fine.halfM <= 5000 * Math.SQRT1_2 && terr.fine.halfM % 20 === 0, `half ${terr.fine.halfM}`);
  const [x, y] = toXY(site.latDeg, site.lonDeg);
  const h = terr.sample(x, y);
  assert.ok(Number.isFinite(h) && Math.abs(h) < 10000, `height ${h}`);
  assert.equal(terr.resAt(x, y), 0.02);
  assert.equal(terr.resAt(x + 20, y), null, 'outside every level');
  // a custom point 2 km from im2 finds the same patch; a point far from every site finds none
  const near = await hiresPatchFor(hires, { id: 'custom', latDeg: site.latDeg, lonDeg: site.lonDeg + 1.3 });
  assert.equal(near?.id, 'im2');
  assert.equal(await hiresPatchFor(hires, { id: 'custom', latDeg: -81, lonDeg: 100 }), null);
  assert.equal(await hiresPatchFor(null, site), null);
});

test('page: the built lander carries the patch manifest, the stage bar slot and the rover link', () => {
  const page = readFileSync(join(demo, 'lander.html'), 'utf8');
  const m = /<script type="application\/json" id="data-hires">(.*?)<\/script>/s.exec(page);
  assert.ok(m, 'data-hires inlined');
  const inl = JSON.parse(m[1]);
  assert.ok(inl.sites.shackleton.kmPerPixel === 0.005 && inl.sites['mons-mouton'].kmPerPixel === 0.01);
  assert.ok(page.includes('id="stages"') && page.includes('id="next"') && page.includes('Plan the rover route'));
  const js = page.split('<!--LANDER:JS-->')[1];
  assert.ok(js.includes("__m['../mission-flow.js']") && js.includes("__m['../hires.js']"));
});
