// Phase 5, S: the sky dial's geometry (demo/src/skydial.js) and its orientation on the map, checked against
// the existing projection (terrain.js toXY/fromXY, map/view.js toPx) and azimuths (geometry.js azEl), and
// with the real ephemeris and terrain for Shackleton ridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DIAL, northOnScreenDeg, northOnScreenFromXY, screenAngleDeg, radiusForEl, elForRadius, dialPoint, skylineFn,
  skylineProfile, skylinePath, skyStatus, tracksFromSeries, trackSpan, trackSegments, dialPath, describeBody,
} from '../demo/src/skydial.js';
import { azEl, unitFromLonLat, MOON_RADIUS_KM } from '../demo/src/geometry.js';
import { toXY, fromXY, horizonProfile, createDem, skylineFor } from '../demo/src/terrain.js';
import { toPx, FULL_VIEW } from '../demo/src/map/view.js';
import { createEphemeris, bodyAzEl } from '../demo/src/ephemeris.js';
import { sampleSeries } from '../demo/src/windows.js';
import { bundle } from '../tools/build.mjs';

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
// screen angle of a screen vector, degrees clockwise from up (screen y grows downward)
const screenAngle = (dx, dy) => ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
const SIZE = 1000;   // a square map frame at zoom 1, in px
const px = (lat, lon) => toPx(FULL_VIEW, SIZE, ...toXY(lat, lon));

const SHACKLETON = { latDeg: -89.45, lonDeg: 222.69 };   // 89.45°S 137.31°W
const ON_0E = { latDeg: -85, lonDeg: 0 };
const SITES = [SHACKLETON, ON_0E, { latDeg: -85, lonDeg: 90 }, { latDeg: -88.2, lonDeg: 300.5 }, { latDeg: -80.5, lonDeg: 160 }];

// The azimuth geometry.js gives for a ground point `km` away in a given screen direction from the site.
function azimuthOfScreenDirection(site, screenDeg, km = 0.5) {
  const [x0, y0] = toXY(site.latDeg, site.lonDeg);
  const a = (screenDeg * Math.PI) / 180;
  // screen up = map +y, screen right = map +x
  const p = fromXY(x0 + km * Math.sin(a), y0 + km * Math.cos(a));
  return azEl(unitFromLonLat(p.lonDeg, p.latDeg), MOON_RADIUS_KM, site.lonDeg, site.latDeg).azDeg;
}

test('orientation: local north on screen is the longitude, away from the pole', () => {
  assert.equal(northOnScreenDeg(ON_0E), 0);
  assert.equal(northOnScreenDeg({ latDeg: -85, lonDeg: 90 }), 90);
  assert.ok(near(northOnScreenDeg(SHACKLETON), 222.69, 1e-9));
  assert.equal(northOnScreenDeg({ latDeg: -90, lonDeg: 10 }), null);
  for (const s of SITES) {
    // from the map plane: the direction from the pole to the site
    assert.ok(near(northOnScreenFromXY(...toXY(s.latDeg, s.lonDeg)), northOnScreenDeg(s), 1e-6));
    // on screen: the site lies in its north direction as seen from the pole
    const [pxp, pyp] = toPx(FULL_VIEW, SIZE, 0, 0);
    const [sx, sy] = px(s.latDeg, s.lonDeg);
    assert.ok(angDiff(screenAngle(sx - pxp, sy - pyp), northOnScreenDeg(s)) < 1e-6);
    // and a point a little further north (lat + 0.01°) is in that direction from the site
    const [nx, ny] = px(s.latDeg + 0.01, s.lonDeg);
    assert.ok(angDiff(screenAngle(nx - sx, ny - sy), northOnScreenDeg(s)) < 1e-6);
  }
});

test('orientation: east is clockwise from north on screen (on 0°E: north up, east right)', () => {
  // the 0°E meridian: north is up, east is right, south (towards the pole) down, west left
  for (const [az, want] of [[0, [0, -1]], [90, [1, 0]], [180, [0, 1]], [270, [-1, 0]]]) {
    const [x, y] = dialPoint(az, 0, northOnScreenDeg(ON_0E));
    const r = Math.hypot(x, y);
    assert.ok(near(x / r, want[0], 1e-9) && near(y / r, want[1], 1e-9), `az ${az}`);
  }
  // geometry.js agrees: a point to the screen-right of a 0°E site is due east (az 90), up is due north
  assert.ok(near(azimuthOfScreenDirection(ON_0E, 90), 90, 0.01));
  assert.ok(angDiff(azimuthOfScreenDirection(ON_0E, 0), 0) < 0.01);
  // a point a little east in longitude is clockwise from north on screen
  const [sx, sy] = px(ON_0E.latDeg, ON_0E.lonDeg);
  const [ex, ey] = px(ON_0E.latDeg, ON_0E.lonDeg + 0.05);
  assert.ok(near(screenAngle(ex - sx, ey - sy), 90, 0.05));
});

test('orientation: Shackleton ridge, north points down-left (away from the pole), the pole is up-right', () => {
  const north = northOnScreenDeg(SHACKLETON);
  const [nx, ny] = dialPoint(0, 0, north);
  assert.ok(nx < 0 && ny > 0, 'north is down-left on screen');
  const [sx, sy] = dialPoint(180, 0, north);   // due south: towards the pole
  const [px0, py0] = px(SHACKLETON.latDeg, SHACKLETON.lonDeg);
  const [ppx, ppy] = toPx(FULL_VIEW, SIZE, 0, 0);
  assert.ok(sx > 0 && sy < 0, 'south is up-right');
  assert.ok(angDiff(screenAngle(sx, sy), screenAngle(ppx - px0, ppy - py0)) < 1e-6, 'south points at the pole on the map');
  const [ex, ey] = dialPoint(90, 0, north);
  assert.ok(near(screenAngle(ex, ey), (north + 90) % 360, 1e-9), 'east 90° clockwise from north');
  assert.ok(ex < 0 && ey < 0, 'east is up-left at Shackleton');
});

test('orientation: every screen direction maps to the azimuth geometry.js computes, at several sites', () => {
  for (const s of SITES) {
    const north = northOnScreenDeg(s);
    for (let screen = 0; screen < 360; screen += 15) {
      const az = azimuthOfScreenDirection(s, screen);
      const [x, y] = dialPoint(az, 5, north);
      assert.ok(angDiff(screenAngle(x, y), screen) < 0.05, `site ${s.latDeg},${s.lonDeg} screen ${screen}: az ${az}`);
      assert.ok(near(screenAngleDeg(az, north), screen, 0.05) || angDiff(screenAngleDeg(az, north), screen) < 0.05);
    }
  }
});

test('orientation with terrain: a hill on the map shows in the skyline in the same screen direction', () => {
  // a 3 km bump 25 km from the site, up-right on screen, on a flat sphere
  for (const s of [SHACKLETON, { latDeg: -86, lonDeg: 40 }]) {
    const [x0, y0] = toXY(s.latDeg, s.lonDeg);
    for (const screen of [45, 160, 300]) {
      const a = (screen * Math.PI) / 180;
      const hx = x0 + 25 * Math.sin(a), hy = y0 + 25 * Math.cos(a);
      const dem = {
        kmPerPixel: 0.48,
        heightAtXY: (x, y) => (Math.abs(x) > 460 || Math.abs(y) > 460 ? null : (Math.hypot(x - hx, y - hy) < 4 ? 3000 : 0)),
        heightAt(lat, lon) { return this.heightAtXY(...toXY(lat, lon)); },
      };
      const p = horizonProfile(dem, s.latDeg, s.lonDeg, { azimuths: 360 });
      // the middle of the azimuths the hill raises (circular mean of those above 1°)
      let cx = 0, cy = 0;
      for (let i = 0; i < 360; i++) if (p[i] > 1) { cx += Math.sin((i * Math.PI) / 180); cy += Math.cos((i * Math.PI) / 180); }
      const mid = ((Math.atan2(cx, cy) * 180) / Math.PI + 360) % 360;
      const [dx, dy] = dialPoint(mid, 2, northOnScreenDeg(s));
      assert.ok(angDiff(screenAngle(dx, dy), screen) <= 1, `site ${s.lonDeg}, hill at ${screen}, skyline bump drawn at ${screenAngle(dx, dy).toFixed(1)}`);
    }
  }
});

// Real data: the ephemeris and the 480 m terrain the app uses for skylines.
const eph = createEphemeris(JSON.parse(readFileSync(new URL('../demo/data/ephemeris.json', import.meta.url))));
const ephData = JSON.parse(readFileSync(new URL('../demo/data/ephemeris.json', import.meta.url)));

test('orientation with the ephemeris: near the pole the Sun ray points along the subsolar meridian, the Earth to 0°E', () => {
  const north = northOnScreenDeg(SHACKLETON);
  const step = ephData.meta.stepHours * 3600e3;
  for (let i = 0; i < ephData.subSunLon.length; i += 97) {
    const t = eph.startMs + i * step;
    const b = bodyAzEl(eph, SHACKLETON, t);
    const [x, y] = dialPoint(b.sun.azDeg, b.sun.elDeg, north);
    // seen from 0.55° off the pole the Sun's direction on the map is within ~1° of its sub-solar longitude
    assert.ok(angDiff(screenAngle(x, y), ephData.subSunLon[i]) < 1.2, `t ${new Date(t).toISOString()}`);
    // the Earth hangs over the near side: screen-up (0°E) give or take the libration in longitude
    const [ex, ey] = dialPoint(b.earth.azDeg, b.earth.elDeg, north);
    assert.ok(angDiff(screenAngle(ex, ey), 0) < 10, `earth at ${screenAngle(ex, ey).toFixed(1)}`);
  }
});

test('radius grows with elevation, −10° at the inner edge and +18° at the outer, clamped', () => {
  assert.equal(radiusForEl(-10), DIAL.rMin);
  assert.equal(radiusForEl(18), DIAL.rMax);
  assert.equal(radiusForEl(-40), DIAL.rMin);
  assert.equal(radiusForEl(60), DIAL.rMax);
  assert.ok(radiusForEl(0) < radiusForEl(10) && radiusForEl(-5) < radiusForEl(0));
  assert.ok(near(elForRadius(radiusForEl(7.3)), 7.3, 1e-9));
  assert.ok(DIAL.size >= 2 * DIAL.rLabel && DIAL.size <= 320);
});

test('skyline: function, profile array, number or null; the band path is closed and keeps the centre open', () => {
  const prof = Float32Array.from({ length: 360 }, (_, i) => (i === 90 ? 4 : -1));
  const f = skylineFn(prof);
  assert.ok(near(f(90), 4, 1e-6) && near(f(90.5), 1.5, 1e-6) && near(f(-270), 4, 1e-6) && f(200) === -1);
  assert.equal(skylineFn(null)(123), 0);
  assert.equal(skylineFn(2)(10), 2);
  const fn = Object.assign((az) => az / 100, { profile: prof });
  assert.equal(skylineFn(fn), fn);
  assert.equal(skylineProfile(fn).length, 360);
  assert.equal(skylineProfile(null, 72).length, 72);
  const { band, edge } = skylinePath(prof, 0);
  assert.equal((band.match(/Z/g) ?? []).length, 2);
  assert.ok(edge.startsWith('M') && edge.endsWith('Z'));
  // the bump at azimuth 90 is drawn to the right of a north-up dial
  const pts = edge.slice(1, -1).split('L').map((p) => p.split(' ').map(Number));
  assert.ok(near(pts[90][0], radiusForEl(4), 0.1) && near(pts[90][1], 0, 0.1));
});

test('above or behind the terrain: the panorama rule, elevation at or below the skyline is hidden', () => {
  const sky = (az) => (az > 100 && az < 200 ? 3 : 0);
  assert.deepEqual(skyStatus({ azDeg: 150, elDeg: 2 }, sky).above, false);
  assert.ok(near(skyStatus({ azDeg: 150, elDeg: 2 }, sky).clearanceDeg, -1, 1e-12));
  assert.equal(skyStatus({ azDeg: 150, elDeg: 3 }, sky).above, false);
  assert.equal(skyStatus({ azDeg: 50, elDeg: 0.1 }, sky).above, true);
  assert.equal(skyStatus({ azDeg: null, elDeg: 90 }, sky).visible, false);
  assert.equal(skyStatus(null, sky).visible, false);
  assert.equal(describeBody({ azDeg: 208.44, elDeg: 1.71 }, () => 0.8), 'az 208.4°, el 1.7°, 0.9° above skyline');
  assert.equal(describeBody({ azDeg: 141, elDeg: -5.8 }, () => -0.5), 'az 141.0°, el −5.8°, 5.3° below skyline');
});

test('tracks: one synodic month round the stay, cut into stay and beyond, joined at the stay edges', () => {
  const H = 3600e3, D = 24 * H;
  const span = trackSpan({ stayRange: [100 * D, 114 * D] });
  assert.ok(near(span[1] - span[0], 29.530589 * D, 1) && near((span[0] + span[1]) / 2, 107 * D, 1));
  assert.deepEqual(trackSpan({ stayRange: [0, 40 * D] }), [0, 40 * D]);
  const clipped = trackSpan({ nowMs: 1 * D, startMs: 0, endMs: 1000 * D });
  assert.equal(clipped[0], 0); assert.ok(near(clipped[1], 29.530589 * D, 1));
  assert.equal(trackSpan({}), null);

  // a body going round once in 30 days, sampled every 3 h; the stay is days 10–20 (edges between samples)
  const t = [], az = [], el = [];
  for (let ms = 0; ms <= 30 * D; ms += 3 * H) { t.push(ms); az.push((ms / D) * 12 % 360); el.push(1); }
  const stay = [10 * D + H, 20 * D + H];
  const segs = trackSegments({ t, az, el }, { stayRange: stay });
  assert.deepEqual(segs.map((s) => s.inStay), [false, true, false]);
  assert.equal(segs[1].points[0].t, stay[0]); assert.equal(segs[1].points.at(-1).t, stay[1]);
  assert.equal(segs[0].points.at(-1), segs[1].points[0]);   // shared cut point: the lines meet
  assert.equal(segs[1].points.at(-1), segs[2].points[0]);
  assert.ok(near(segs[1].points[0].az, ((10 * D + H) / D) * 12, 1e-9));
  // crossing 360°: one run on the round dial, two on an azimuth-across chart
  const wrap = { t: [0, 1, 2, 3], az: [350, 355, 1, 6], el: [0, 0, 0, 0] };
  assert.equal(trackSegments(wrap).length, 1);
  assert.equal(trackSegments(wrap, { linear: true }).length, 2);
  // missing azimuths and big jumps break the line
  assert.equal(trackSegments({ t: [0, 1, 2, 3, 4], az: [10, 12, null, 14, 100], el: [0, 0, 0, 0, 0] }).length, 1);
  assert.deepEqual(trackSegments({ t: [0, 1, 2, 3], az: [10, 12, 90, 92], el: [0, 0, 0, 0] }).map((s) => s.points.length), [2, 2]);
  // a stay edge exactly on a sample
  const exact = trackSegments({ t: [0, 1, 2, 3, 4], az: [0, 1, 2, 3, 4], el: [0, 0, 0, 0, 0] }, { stayRange: [1, 3] });
  assert.deepEqual(exact.map((s) => [s.inStay, s.points.map((p) => p.t)]), [[false, [0, 1]], [true, [1, 2, 3]], [false, [3, 4]]]);
  assert.match(dialPath(segs[1].points, 0), /^M-?\d+\.\d -?\d+\.\d(L-?\d+\.\d -?\d+\.\d)+$/);
});

test('real data, Shackleton ridge: tracks from sampleSeries, Earth behind the terrain late in Jan 2027', () => {
  const meta = JSON.parse(readFileSync(new URL('../demo/data/terrain.json', import.meta.url)));
  const buf = readFileSync(new URL(`../demo/data/${meta.dem.file}`, import.meta.url));
  const dem = createDem({ data: new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2), size: meta.dem.size, kmPerPixel: meta.dem.kmPerPixel, dnToMeters: meta.dem.dnToMeters });
  const sky = skylineFor(dem, SHACKLETON);
  assert.equal(sky.profile.length, 360);
  const stay = [Date.UTC(2027, 0, 13), Date.UTC(2027, 0, 27)];
  const [a, b] = trackSpan({ stayRange: stay, startMs: eph.startMs, endMs: eph.endMs });
  const { sunTrack, earthTrack } = tracksFromSeries(sampleSeries(eph, SHACKLETON, a, b, 3 * 3600e3));
  assert.equal(sunTrack.t.length, earthTrack.t.length);
  // the Sun goes once round the horizon in the month: one unbroken run on the dial, split by the stay
  const sunSegs = trackSegments(sunTrack, { stayRange: stay });
  assert.deepEqual(sunSegs.map((s) => s.inStay), [false, true, false]);
  // on 18 Jan the Sun clears the ridge's skyline, on 28 Jan the Earth is behind the terrain
  const up = bodyAzEl(eph, SHACKLETON, Date.UTC(2027, 0, 18));
  assert.equal(skyStatus(up.sun, sky).above, true);
  assert.equal(skyStatus(up.earth, sky).above, true);
  const late = bodyAzEl(eph, SHACKLETON, Date.UTC(2027, 0, 28));
  assert.equal(skyStatus(late.earth, sky).above, false);
  assert.ok(skyStatus(late.earth, sky).clearanceDeg < -5);
});

test('the S modules follow the bundler convention', () => {
  for (const f of ['skydial.js', 'ui/skydial.js', 'ui/sitesheet.js']) {
    assert.doesNotThrow(() => bundle(new URL(`../demo/src/${f}`, import.meta.url).pathname), f);
  }
});
