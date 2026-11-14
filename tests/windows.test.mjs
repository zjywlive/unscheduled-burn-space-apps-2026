import test from 'node:test';
import assert from 'node:assert/strict';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { summarize, visibleIntervals, intersectIntervals, totalMs, longestGapMs } from '../demo/src/windows.js';
import { syntheticData } from './helpers/synthetic.mjs';

const H = 3600e3, D = 24 * H, TOL = 2 * 60e3;
const near = (a, b, tol = TOL) => Math.abs(a - b) <= tol;
const eph = createEphemeris(syntheticData());
const t0 = eph.startMs;
const equator = { lonDeg: 0, latDeg: 0 };

test('sunrise at 20 h and sunset at 380 h on the synthetic equator', () => {
  const s = summarize(eph, equator, t0, 30, 0);
  assert.equal(s.sunIntervals.length, 1);
  assert.ok(near(s.sunIntervals[0][0], t0 + 20 * H));
  assert.ok(near(s.sunIntervals[0][1], t0 + 380 * H));
  assert.ok(near(s.sunMs, 360 * H, 2 * TOL));
  assert.ok(near(s.longestDarkMs, 340 * H, 2 * TOL));
  assert.equal(s.sunUpAtLanding, false);
  assert.ok(near(s.firstSunriseMs, t0 + 20 * H));
  assert.ok(Math.abs(s.peakSunElDeg - 90) < 0.1);
  assert.deepEqual(s.events.filter((e) => e.body === 'sun').map((e) => e.kind), ['rise', 'set']);
});

test('a 5 deg mask shortens the sunlit window to 340 h', () => {
  const s = summarize(eph, equator, t0, 30, 5);
  assert.ok(near(s.sunMs, 340 * H, 2 * TOL));
});

test('Earth overhead is in view for the whole stay, and "both" equals sunlit', () => {
  const s = summarize(eph, equator, t0, 30, 0);
  assert.equal(s.earthMs, 30 * D);
  assert.equal(s.earthUpAtLanding, true);
  assert.equal(s.firstEarthsetMs, null);
  assert.ok(near(s.bothMs, s.sunMs, 1));
});

test('far side: Earth never rises, zero hours, no Earth events', () => {
  const s = summarize(eph, { lonDeg: 180, latDeg: 0 }, t0, 14, 0);
  assert.equal(s.earthMs, 0);
  assert.equal(s.bothMs, 0);
  assert.equal(s.earthEverUp, false);
  assert.equal(s.events.filter((e) => e.body === 'earth').length, 0);
});

test('polar site with the Sun 1.5 deg up all stay: no events; a 2 deg mask hides it', () => {
  const polar = createEphemeris(syntheticData({ sunLat: -1.5 }));
  const pole = { lonDeg: 0, latDeg: -90 };
  const up = summarize(polar, pole, polar.startMs, 14, 0);
  assert.equal(up.sunMs, 14 * D);
  assert.equal(up.events.filter((e) => e.body === 'sun').length, 0);
  assert.equal(up.firstSunsetMs, null);
  assert.equal(up.longestDarkMs, 0);
  const masked = summarize(polar, pole, polar.startMs, 14, 2);
  assert.equal(masked.sunMs, 0);
  assert.equal(masked.longestDarkMs, 14 * D);
});

test('stay running past the ephemeris end is clipped, with finite numbers', () => {
  const s = summarize(eph, equator, eph.endMs - 3 * D, 14, 0);
  assert.equal(s.clipped, true);
  assert.equal(s.endMs, eph.endMs);
  assert.equal(s.stayMs, 3 * D);
  for (const k of ['sunMs', 'earthMs', 'bothMs', 'longestDarkMs', 'peakSunElDeg']) assert.ok(Number.isFinite(s[k]));
});

test('landing outside coverage returns null', () => {
  assert.equal(summarize(eph, equator, eph.startMs - H, 14, 0), null);
  assert.equal(summarize(eph, equator, eph.endMs + H, 14, 0), null);
});

test('interval helpers', () => {
  assert.deepEqual(intersectIntervals([[0, 10], [20, 30]], [[5, 25]]), [[5, 10], [20, 25]]);
  assert.equal(totalMs([[0, 10], [20, 25]]), 15);
  assert.equal(longestGapMs([[5, 10], [20, 25]], 0, 40), 15);
  assert.equal(longestGapMs([], 0, 40), 40);
});

import { compareRows } from '../demo/src/ui/compare.js';
import { eventRows } from '../demo/src/ui/events.js';

test('compare rows: lead row first, worse flagged only when the alternative is worse', () => {
  const planned = summarize(eph, equator, t0, 14, 0);          // Sun up from 20 h to the end: 316 h
  const alt = summarize(eph, equator, t0 + 14 * D, 14, 0);     // Sun up for 44 h, then sets
  const rows = compareRows(planned, alt);
  assert.deepEqual(rows.map((r) => r.label),
    ['Both in view', 'Sunlit', 'Earth in view', 'Longest dark', 'First sunset', 'First Earthset', 'Peak Sun elevation']);
  assert.equal(rows[0].lead, true);
  assert.equal(rows[0].planned, '316 h');
  assert.equal(rows[0].alt, '44 h');
  assert.equal(rows[0].worse, true);
  assert.equal(rows[2].worse, false);                          // Earth in view is unchanged
  assert.equal(rows[3].worse, true);                           // longest dark got longer
  assert.equal(rows[4].planned, 'Sun is down at landing, rises in 20 h');
  assert.equal(rows[5].planned, 'None in stay');
});

test('no alternative prints dashes, and the far side says Earth never rises', () => {
  const far = summarize(eph, { lonDeg: 180, latDeg: 0 }, t0, 14, 0);
  const rows = compareRows(far, null);
  assert.ok(rows.every((r) => r.alt === '—' && r.worse === false));
  assert.equal(rows[2].planned, '0 h');
  assert.equal(rows[5].planned, 'Earth never rises here');
});

test('event rows read as sentences of the trade', () => {
  const rows = eventRows(summarize(eph, equator, t0, 30, 0));
  assert.deepEqual(rows.map((r) => r.event), ['Sunrise', 'Sunset']);
  assert.equal(rows[0].after, '20 h');
  assert.equal(rows[0].then, 'up for 15 d');
  assert.equal(rows[1].then, 'down until the stay ends');
});

import { summarizePair } from '../demo/src/windows.js';

test('landing at the last ephemeris instant leaves no stay, so it is out of range', () => {
  assert.equal(summarize(eph, equator, eph.endMs, 14, 0), null);
  assert.notEqual(summarize(eph, equator, eph.endMs - H, 14, 0), null);
});

test('a clipped stay is compared with an alternative of the same length', () => {
  const p = summarizePair(eph, { site: equator, landingMs: eph.endMs - 3 * D }, { site: equator, landingMs: eph.endMs - 10 * D }, 14, 0);
  assert.equal(p.planned.stayMs, 3 * D);
  assert.equal(p.alt.stayMs, 3 * D);
  assert.equal(p.stayDays, 3);
  const q = summarizePair(eph, { site: equator, landingMs: eph.endMs - 10 * D }, { site: equator, landingMs: eph.endMs - 3 * D }, 14, 0);
  assert.equal(q.planned.stayMs, 3 * D);
  assert.equal(q.alt.stayMs, 3 * D);
  const full = summarizePair(eph, { site: equator, landingMs: t0 }, { site: equator, landingMs: t0 + 14 * D }, 14, 0);
  assert.equal(full.stayDays, 14);
  assert.equal(full.planned.stayMs, 14 * D);
  const out = summarizePair(eph, { site: equator, landingMs: t0 }, { site: equator, landingMs: eph.endMs + D }, 14, 0);
  assert.equal(out.alt, null);
  assert.equal(out.planned.stayMs, 14 * D);
});

test('an hours change is the difference of the two figures as shown, decimals included', () => {
  const base = summarize(eph, equator, t0, 14, 0);
  const rows = compareRows({ ...base, bothMs: 9.5 * H }, { ...base, bothMs: 25 * H });
  assert.equal(rows[0].planned, '9.5 h');
  assert.equal(rows[0].alt, '25 h');
  assert.equal(rows[0].change, '+15.5 h');
});

test('a mask given as a function of azimuth matches the same constant mask', () => {
  const a = summarize(eph, equator, t0, 30, 5);
  const b = summarize(eph, equator, t0, 30, () => 5);
  assert.ok(near(a.sunMs, b.sunMs, 1));
  // a wall in the eastern half of the sky hides the morning Sun only
  const wall = summarize(eph, equator, t0, 30, (az) => (az !== null && az > 0 && az < 180 ? 40 : 0));
  assert.ok(wall.sunMs < a.sunMs && wall.sunMs > 0);
});
