// Phase 4: surface radio links (demo/src/comms.js). Known values first (free-space loss, the knife-edge
// formula, the radio horizon of a smooth Moon), then terrain, then the real station site.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fsplDb, knifeEdgeDb, link, coverage, routeLinks, linkSummary, cleanStation, STATION_DEFAULTS, MOON_R_M } from '../demo/src/comms.js';
import { createDem, toXY } from '../demo/src/terrain.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);
const S = { mhz: 2245, txDbm: 0, gainsDbi: 0 };

test('free-space loss: 1 km at 2245 MHz is 99.47 dB, and +6 dB per doubling', () => {
  near(fsplDb(1, 2245), 32.45 + 20 * Math.log10(2245), 1e-9);
  near(fsplDb(1, 2245), 99.47, 0.01);
  near(fsplDb(2, 442.5) - fsplDb(1, 442.5), 6.02, 0.01);
});

test('knife edge (ITU-R P.526): 0 dB below v = −0.78, about 6 dB at grazing, more as the edge rises', () => {
  assert.equal(knifeEdgeDb(-1), 0);
  near(knifeEdgeDb(0), 6.0, 0.1);
  assert.ok(knifeEdgeDb(2) > knifeEdgeDb(1) && knifeEdgeDb(1) > knifeEdgeDb(0));
  near(knifeEdgeDb(2.4), 6.9 + 20 * Math.log10(Math.sqrt(2.3 * 2.3 + 1) + 2.3), 1e-9);
});

const smooth = () => 0;   // heights above the sphere: a smooth Moon

test('radio horizon of a smooth Moon: 15 m mast and 2 m rover see each other to √(2Rh₁)+√(2Rh₂) ≈ 9.9 km', () => {
  const horizonKm = (Math.sqrt(2 * MOON_R_M * 15) + Math.sqrt(2 * MOON_R_M * 2)) / 1000;
  near(horizonKm, 9.86, 0.01);
  const at = (d) => link(smooth, { x: 0, y: 0, heightM: 15 }, { x: d, y: 0, heightM: 2 }, S);
  assert.equal(at(9.0).los, true);
  assert.equal(at(10.8).los, false);
  assert.ok(at(10.8).diffDb > 0, 'past the horizon the bulge diffracts');
  near(at(5).rxDbm, -fsplDb(5, 2245) - at(5).diffDb, 1e-9);
});

test('a ridge between them blocks the line of sight and costs more the higher it is', () => {
  const ridge = (hM) => (x) => (Math.abs(x - 2) < 0.2 ? hM : 0);
  const L = (hM) => link((x) => ridge(hM)(x), { x: 0, y: 0, heightM: 15 }, { x: 4, y: 0, heightM: 2 }, S);
  assert.equal(L(5).los, true);
  assert.equal(L(40).los, false);
  assert.ok(L(80).diffDb > L(40).diffDb && L(40).diffDb > 6, `${L(40).diffDb} dB at 40 m, ${L(80).diffDb} dB at 80 m`);
  assert.ok(L(40).rxDbm < L(5).rxDbm);
  // lower frequency diffracts better (smaller v for the same edge)
  const uhf = link((x) => ridge(40)(x), { x: 0, y: 0, heightM: 15 }, { x: 4, y: 0, heightM: 2 }, { ...S, mhz: 442.5 });
  assert.ok(uhf.diffDb < L(40).diffDb);
});

test('coverage on a smooth Moon: everything within 8 km is in sight, and power falls with distance', () => {
  const c = coverage(smooth, { latDeg: -89.5, lonDeg: 0, radiusKm: 8 }, { cellKm: 0.5 });
  assert.equal(c.losShare, 1);
  const i0 = Math.floor(c.n / 2), mid = c.rx[i0 * c.n + i0], edge = c.rx[i0 * c.n + 1];
  assert.ok(mid > edge, `${mid} dBm near the station, ${edge} dBm at the edge`);
  assert.equal(c.settings.mastM, 15);
});

test('route links and the summary: station-only, Earth-only and gaps', () => {
  const profile = { x: Float32Array.from([1, 2, 3, 4, 5, 30, 31]), y: new Float32Array(7), km: new Float32Array(7).fill(1), pitch: new Float32Array(7) };
  const st = { latDeg: -90, lonDeg: 0, txDbm: 30 };   // at the pole, x = y = 0
  const L = routeLinks(smooth, profile, st);
  assert.deepEqual([...L.los], [1, 1, 1, 1, 1, 0, 0]);
  const earth = Uint8Array.from([0, 0, 0, 0, 0, 0, 1]);
  const s = linkSummary(profile, L, earth, Float64Array.from([0, 1, 2, 3, 4, 5, 6].map((h) => h * 3600e3)));
  assert.equal(s.totalKm, 7);
  assert.equal(s.stationKm, 5);
  assert.equal(s.earthKm, 1);
  assert.equal(s.anyKm, 6);
  assert.equal(s.gapKm, 1);
});

test('cleanStation keeps the station inside the polar terrain and fills the JPL defaults', () => {
  assert.deepEqual(cleanStation({}), { ...STATION_DEFAULTS });
  assert.equal(cleanStation({ latDeg: -70 }).latDeg, -80);
  assert.equal(cleanStation({ lonDeg: -135 }).lonDeg, 225);
  assert.equal(cleanStation({ band: 'x' }).band, 's');
});

const DATA = new URL('../demo/data/', import.meta.url);
const real = existsSync(new URL('dem_240m.bin', DATA)) && existsSync(new URL('terrain.json', DATA));

test('real terrain: the JPL station site sees part of its 8 km circle, not all of it', { skip: !real && 'dem_240m not here' }, () => {
  const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA)));
  const l = meta.levels.find((x) => x.name === 'dem_240m');
  const b = readFileSync(new URL(l.file, DATA));
  const dem = createDem({ data: new Int16Array(b.buffer, b.byteOffset, b.length / 2), size: l.size, kmPerPixel: l.kmPerPixel, dnToMeters: l.dnToMeters, halfKm: l.halfKm });
  const h = (x, y) => dem.heightAtXY(x, y);
  const c = coverage(h, {}, { cellKm: 0.3 });
  const [sx, sy] = toXY(STATION_DEFAULTS.latDeg, STATION_DEFAULTS.lonDeg);
  near(c.station.x, sx, 1e-9); near(c.station.y, sy, 1e-9);
  // the paper found 29 % line-of-sight coverage at its chosen site on a 5 m DEM; a 240 m grid smooths the
  // relief, so expect a share well above that but short of everything
  assert.ok(c.losShare > 0.2 && c.losShare < 1, `line of sight to ${(c.losShare * 100).toFixed(0)}% of the circle`);
});
