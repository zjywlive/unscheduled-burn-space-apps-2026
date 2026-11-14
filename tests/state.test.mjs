import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { DEFAULTS, parseHash, toHash, alternativeOf } from '../demo/src/state.js';
const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const sites = load('../demo/data/sites.json');
const eph = createEphemeris(load('../demo/data/ephemeris.json'));

test('empty hash gives the defaults', () => {
  const s = parseHash('', sites, eph);
  assert.equal(s.site.id, 'im2'); assert.equal(s.stayDays, 14); assert.equal(s.slipDays, 14);
  // phase 2: the map is the default view and the horizon mask is gone (spec phase 2 §3)
  assert.equal(s.altSite, 'same'); assert.equal('maskDeg' in s, false); assert.equal(s.view, 'map');
  assert.equal(s.landingMs, DEFAULTS.landingMs); assert.equal(s.cursorMs, s.landingMs);
});

test('garbage in every field falls back without throwing', () => {
  for (const h of ['#site=zzz&stay=99&slip=abc&mask=x&t=garbage&alt=nope&view=??', '#%%%', '#=&=&', '#t=1999-01-01T00:00Z', '#site=c:999,1', '#' + 'a'.repeat(5000)]) {
    const s = parseHash(h, sites, eph);
    assert.equal(s.site.id, 'im2'); assert.equal(s.stayDays, 14); assert.equal(s.landingMs, DEFAULTS.landingMs);
  }
});

test('out-of-range numbers clamp', () => {
  const s = parseHash('#slip=999&mask=99', sites, eph);
  assert.equal(s.slipDays, 60); assert.equal('maskDeg' in s, false);   // phase 2: a legacy mask is ignored
  assert.equal(parseHash('#slip=-999&mask=1.3', sites, eph).slipDays, -60);
  assert.equal(parseHash('#slip=1.3', sites, eph).slipDays, 1);
});

test('round trip, including a custom site', () => {
  const h = '#view=evidence&site=c:-85.2,31.5&t=2027-06-01T12:00Z&stay=30&slip=-7&alt=shackleton&mode=sun';
  const s = parseHash(h, sites, eph);
  assert.equal(s.site.id, 'custom'); assert.equal(s.site.latDeg, -85.2);
  assert.equal(toHash(s), h);
});

test('alternative scenario', () => {
  const s = parseHash('#site=im2&t=2027-06-01T00:00Z&slip=14&alt=same', sites, eph);
  assert.deepEqual(alternativeOf(s, sites), { site: s.site, landingMs: Date.UTC(2027, 5, 15) });
  const o = parseHash('#site=im2&t=2027-06-01T00:00Z&slip=0&alt=shackleton', sites, eph);
  assert.equal(alternativeOf(o, sites).site.id, 'shackleton');
});

test('a landing time at the very end of the ephemeris falls back to the default', () => {
  assert.equal(parseHash('#t=2029-01-01T00:00Z', sites, eph).landingMs, DEFAULTS.landingMs);
  assert.equal(parseHash('#t=2028-12-31T23:00Z', sites, eph).landingMs, Date.UTC(2028, 11, 31, 23));
});

test('map defaults, custom alternative and ignored legacy mask', () => {
  const s = parseHash('', sites, eph);
  assert.equal(s.view, 'map'); assert.equal(s.mapMode, 'both'); assert.equal('maskDeg' in s, false);
  const h = '#view=map&site=im2&t=2027-06-01T00:00Z&stay=14&slip=7&alt=c:-88.5,45&mode=change';
  const c = parseHash(h, sites, eph);
  assert.equal(alternativeOf(c, sites).site.latDeg, -88.5);
  assert.equal(toHash(c), h);
  assert.equal(parseHash('#mask=3&mode=zzz', sites, eph).mapMode, 'both');
});

// phase 3: viewport, filters, weights and the score mode (spec phase 3 §4.1, §4.3, §4.4)
import { cleanViewport, cleanMaxSlope, cleanMaxDark, cleanWeights } from '../demo/src/state.js';

test('phase 3 defaults: Any filters, default weights, full view, select tool, slot A', () => {
  const s = parseHash('', sites, eph);
  assert.deepEqual(s.viewport, { cx: 0, cy: 0, zoom: 1 });
  assert.equal(s.maxSlope, null); assert.equal(s.maxDark, null);
  assert.deepEqual(s.weights, { sun: 40, earth: 30, slope: 20, shadow: 10 });
  assert.equal(s.tool, 'select'); assert.equal(s.slot, 'A');
  assert.deepEqual(DEFAULTS.weights, { sun: 40, earth: 30, slope: 20, shadow: 10 });
});

test('a default state hashes exactly as in phase 2', () => {
  const s = parseHash('', sites, eph);
  assert.equal(toHash(s), '#view=map&site=im2&t=2027-01-13T00:00Z&stay=14&slip=14&alt=same&mode=both');
  // a phase 2 state object without the new fields hashes the same way
  const { viewport, maxSlope, maxDark, weights, tool, slot, ...old } = s;
  assert.equal(toHash(old), toHash(s));
  // explicit defaults in the hash are dropped again
  assert.equal(toHash(parseHash('#z=1&cx=0&cy=0&w=40,30,20,10&slope=Any&dark=', sites, eph)), toHash(s));
});

test('phase 3 round trip, written in a fixed order after mode', () => {
  const h = '#view=map&site=im2&t=2027-06-01T00:00Z&stay=14&slip=7&alt=same&mode=score&z=4.5&cx=-31.2&cy=88&slope=12&dark=48&w=50,0,25,100';
  const s = parseHash(h, sites, eph);
  assert.equal(s.mapMode, 'score');
  assert.deepEqual(s.viewport, { cx: -31.2, cy: 88, zoom: 4.5 });
  assert.equal(s.maxSlope, 12); assert.equal(s.maxDark, 48);
  assert.deepEqual(s.weights, { sun: 50, earth: 0, slope: 25, shadow: 100 });
  assert.equal(toHash(s), h);
  assert.equal(toHash({ ...s, maxSlope: null, weights: { ...DEFAULTS.weights } }), h.replace('&slope=12', '').replace('&w=50,0,25,100', ''));
  // only the keys that differ are written; the tool and the slot never are
  const z = toHash({ ...parseHash('', sites, eph), viewport: { cx: 0, cy: 0, zoom: 2 }, tool: 'polygon', slot: 'B' });
  assert.match(z, /&mode=both&z=2$/);
});

test('phase 3 garbage and out-of-range values fall back or clamp without throwing', () => {
  for (const h of ['#z=abc&cx=NaN&cy=1e999x&slope=steep&dark=-&w=1,2,3', '#w=a,b,c,d', '#w=', '#w=1,2,3,4,5', '#mode=Score', '#z=&cx=&cy=']) {
    const s = parseHash(h, sites, eph);
    assert.deepEqual(s.viewport, { cx: 0, cy: 0, zoom: 1 }, h);
    assert.equal(s.maxSlope, null, h); assert.equal(s.maxDark, null, h);
    assert.deepEqual(s.weights, DEFAULTS.weights, h);
    assert.equal(s.mapMode, 'both', h);
  }
  const c = parseHash('#z=99&cx=-900&cy=400&slope=1&dark=1000&w=-5,250,33.4,7.6', sites, eph);
  // third wave (review M4): the centre is held inside 320 − 320/zoom, as clampView does; was ±320
  // phase 4: MAX_ZOOM 32 (was 12, giving ±293.3)
  assert.deepEqual(c.viewport, { cx: -310, cy: 310, zoom: 32 });
  assert.equal(c.maxSlope, 3); assert.equal(c.maxDark, 336);
  assert.deepEqual(c.weights, { sun: 0, earth: 100, slope: 33, shadow: 8 });
  assert.equal(parseHash('#z=0.2&slope=99&dark=-30', sites, eph).viewport.zoom, 1);
  assert.equal(parseHash('#slope=99', sites, eph).maxSlope, 30);
  assert.equal(parseHash('#dark=17', sites, eph).maxDark, 12);   // 12 h steps
  assert.equal(parseHash('#dark=19', sites, eph).maxDark, 24);
});

test('phase 3 clean helpers accept code values as well as hash strings', () => {
  assert.deepEqual(cleanViewport({ cx: 12.345, cy: -0.04, zoom: 2.555 }), { cx: 12.3, cy: 0, zoom: 2.56 });
  assert.deepEqual(cleanViewport(null), { cx: 0, cy: 0, zoom: 1 });
  assert.equal(cleanMaxSlope(null), null); assert.equal(cleanMaxSlope(7.4), 7);
  assert.equal(cleanMaxDark(undefined), null); assert.equal(cleanMaxDark(0), 0);
  assert.deepEqual(cleanWeights({ sun: 0, earth: 0, slope: 0, shadow: 0 }), { sun: 0, earth: 0, slope: 0, shadow: 0 });
  assert.deepEqual(cleanWeights({ sun: 10 }), DEFAULTS.weights);
  assert.deepEqual(cleanWeights('0,0,0,0'), { sun: 0, earth: 0, slope: 0, shadow: 0 });
  // an all-zero weight set is kept (the page says "Set at least one weight.")
  assert.match(toHash({ ...parseHash('', sites, eph), weights: { sun: 0, earth: 0, slope: 0, shadow: 0 } }), /&w=0,0,0,0$/);
});

test('the hash viewport is clamped by zoom, so it names the view on screen (review M4)', () => {
  const at1 = parseHash('#z=1&cx=300&cy=-250', sites, eph);
  assert.deepEqual(at1.viewport, { cx: 0, cy: 0, zoom: 1 });
  assert.equal(toHash(at1), toHash(parseHash('', sites, eph)));
  assert.deepEqual(parseHash('#z=2&cx=300&cy=-150', sites, eph).viewport, { cx: 160, cy: -150, zoom: 2 });
  assert.deepEqual(cleanViewport({ cx: 200, cy: 0, zoom: 4 }), { cx: 200, cy: 0, zoom: 4 });
});
