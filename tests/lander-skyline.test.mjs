// Lander track: landing anywhere on the Moon. The skyline computed from a height function (skyline.js) is the
// polar code's own result on the polar DEM and matches the stored polar horizon grid at its resolution; on the
// global LOLA terrain it gives the expected sky at Apollo 11 (near side) and Chang'e-4 (far side); the polar map
// scale corrects slopes away from the pole; far-side sites get a Sun-only landing window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDem, skylineFor, toXY, fromXY } from '../demo/src/terrain.js';
import { createGlobeTerrain, G1, G2 } from '../demo/src/globe-terrain.js';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { skylineLL, distanceBearing, destination, subPoint } from '../demo/src/lander/skyline.js';
import { skyDirections, skyStats } from '../demo/src/lander/siteplan.js';
import { mapScale, slopeDeg, pickLandingWindow } from '../demo/src/lander/landing.js';
import { GAZETTEER } from '../demo/src/lander/gazetteer.js';

const demo = new URL('../demo/', import.meta.url).pathname;
const pack = (n) => { const t = readFileSync(`${demo}data/js/${n}.js`, 'utf8'); const i0 = t.indexOf(',"') + 2; return new Uint8Array(Buffer.from(t.slice(i0, t.indexOf('"', i0)), 'base64')); };
const meta = JSON.parse(readFileSync(`${demo}data/terrain.json`, 'utf8'));
const demOf = (name) => {
  const lv = meta.levels.find((l) => l.name === name), b = pack(name);
  return createDem({ data: new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1), size: lv.size, kmPerPixel: lv.kmPerPixel, dnToMeters: lv.dnToMeters, halfKm: lv.halfKm });
};

test('skyline: on the polar DEM the computed skyline is the polar code\'s own', () => {
  const dem = demOf('dem_480m');
  for (const site of [{ latDeg: -85, lonDeg: 30 }, { latDeg: -89.45, lonDeg: 222.69 }]) {
    const a = skylineFor(dem, site), b = skylineLL((la, lo) => dem.heightAt(la, lo) ?? NaN, site, { kmPerPixel: 0.48, maxKm: 300 });
    for (let az = 0; az < 360; az += 3) assert.ok(Math.abs(a(az) - b(az)) < 1e-6, `${az}°`);
  }
});

test('skyline: computed from the 240 m DEM it matches the stored polar horizon grid (72 azimuths) at its resolution', () => {
  const dem = demOf('dem_240m'), H = meta.horizon, hb = pack('horizon_grid');
  for (const [lat, lon] of [[-85, 30], [-89.45, 222.69], [-87, 100]]) {
    const [x, y] = toXY(lat, lon), i = Math.floor((x + H.halfKm) / H.cellKm), j = Math.floor((H.halfKm - y) / H.cellKm), k = j * H.size + i;
    const c = fromXY(-H.halfKm + (i + 0.5) * H.cellKm, H.halfKm - (j + 0.5) * H.cellKm);
    const m = skylineLL((la, lo) => dem.heightAt(la, lo) ?? NaN, c, { kmPerPixel: 0.24, maxKm: 300 });
    let sq = 0;
    for (let q = 0; q < H.azimuths; q++) { const e = m((q * 360) / H.azimuths) - (hb[k * H.azimuths + q] * H.stepDeg + H.offsetDeg); sq += e * e; }
    assert.ok(Math.sqrt(sq / H.azimuths) < 0.1, `RMS ${Math.sqrt(sq / H.azimuths).toFixed(3)}° at ${lat}, ${lon} (stored step ${H.stepDeg}°)`);
  }
});

test('skyline: anywhere on the global terrain — Apollo 11 sees the Earth, Chang\'e-4 on the far side never does', async () => {
  const g = createGlobeTerrain({ load: async (n) => pack(n) });
  await g.init();
  const eph = createEphemeris(JSON.parse(readFileSync(`${demo}data/ephemeris.json`, 'utf8')));
  const dirs = skyDirections(eph, Date.parse('2027-01-13T00:00:00Z'), 7, 2);
  const out = {};
  for (const [id, lat, lon] of [['apollo11', 0.674, 23.473], ['change4', -45.444, 177.599]]) {
    await g.need(G1, lat - 9, lat + 9, lon - 9, lon + 9); await g.need(G2, lat - 6.3, lat + 6.3, lon - 9, lon + 9, { max: 80 });
    const [h, label] = g.sample(lat, lon);
    assert.equal(label, '474 m');
    const m = skylineLL(g.heightAt, { latDeg: lat, lonDeg: lon }, { kmPerPixel: 0.474, maxKm: 180 });
    const p = Array.from(m.profile);
    assert.ok(Math.max(...p) < 6 && Math.min(...p) > -3, `${id} skyline within a few degrees (${Math.min(...p).toFixed(1)}..${Math.max(...p).toFixed(1)})`);
    out[id] = { h, sky: skyStats(dirs, { latDeg: lat, lonDeg: lon }, m, 2), mask: m };
  }
  assert.ok(out.apollo11.h < -1000 && out.apollo11.h > -3000, `Mare Tranquillitatis floor ${out.apollo11.h}`);
  assert.equal(out.apollo11.sky.earth, 1, 'near side: the Earth always up');
  assert.equal(out.change4.sky.earth, 0, 'far side: never');
  // landing window: Sun and Earth at Apollo 11; Sun only at Chang'e-4 (a relay is needed)
  const w1 = pickLandingWindow(eph, { latDeg: 0.674, lonDeg: 23.473 }, out.apollo11.mask, Date.parse('2027-01-01T00:00:00Z'));
  const w2 = pickLandingWindow(eph, { latDeg: -45.444, lonDeg: 177.599 }, out.change4.mask, Date.parse('2027-01-01T00:00:00Z'));
  assert.equal(w1.earth, true); assert.equal(w2.earth, false); assert.ok(Number.isFinite(w2.tMs));
});

test('skyline: polar map scale, slopes in ground metres, great-circle helpers and the gazetteer', () => {
  assert.equal(mapScale(-90), 1);
  assert.ok(Math.abs(mapScale(-80) - 1.0077) < 0.001 && Math.abs(mapScale(0) - 2) < 1e-12);
  // a 5° slope in ground metres, seen through the polar map at the equator (map km = 2 × ground km)
  const k = mapScale(0), t5 = Math.tan((5 * Math.PI) / 180);
  const sample = (x) => ((x * 1000) / k) * t5;
  assert.ok(Math.abs(slopeDeg(sample, 100, 3000, 0.5, k) - 5) < 1e-6);
  assert.ok(Math.abs(slopeDeg(sample, 100, 3000, 0.5) - 2.5) < 0.05, 'without the scale it reads about half');
  const a = { latDeg: 0.674, lonDeg: 23.473 }, b = destination(a, 1000, 45);
  const db = distanceBearing(a, b);
  assert.ok(Math.abs(db.km - 1000) < 1e-6 && Math.abs(db.bearingDeg - 45) < 1e-6);
  assert.deepEqual(subPoint([0, 0, -1]).latDeg, -90);
  assert.ok(GAZETTEER.length >= 25 && GAZETTEER.every((f) => f.lonDeg >= 0 && f.lonDeg < 360 && Math.abs(f.latDeg) <= 90 && f.url.startsWith('https://planetarynames.wr.usgs.gov/Feature/')));
  assert.equal(new Set(GAZETTEER.map((f) => f.name)).size, GAZETTEER.length);
});
