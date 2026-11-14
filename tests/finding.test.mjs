import test from 'node:test';
import assert from 'node:assert/strict';
import { findingSentence } from '../demo/src/finding.js';
const H = 3600e3;
const base = { siteName: 'Mons Mouton', altSiteName: 'Mons Mouton', sameSite: true, stayDays: 14 };
test('finding sentences', () => {
  assert.equal(findingSentence({ ...base, slipDays: 14, plannedBothMs: 182 * H, altBothMs: 96 * H }),
    'Landing 14 days later cuts time with both Sun and Earth in view at Mons Mouton from 182 h to 96 h of the 14-day stay.');
  assert.equal(findingSentence({ ...base, slipDays: -1, plannedBothMs: 96 * H, altBothMs: 120 * H }),
    'Landing 1 day earlier raises time with both Sun and Earth in view at Mons Mouton from 96 h to 120 h of the 14-day stay.');
  assert.equal(findingSentence({ ...base, slipDays: 7, plannedBothMs: 100 * H, altBothMs: 100.4 * H }),
    'Landing 7 days later leaves time with both Sun and Earth in view at Mons Mouton unchanged at 100 h.');
  assert.equal(findingSentence({ ...base, slipDays: 0, plannedBothMs: 182 * H, altBothMs: 182 * H }),
    'Mons Mouton has both Sun and Earth in view for 182 h of the 14-day stay.');
  assert.equal(findingSentence({ ...base, altSiteName: 'Shackleton ridge', sameSite: false, slipDays: 0, plannedBothMs: 182 * H, altBothMs: 240 * H }),
    'Shackleton ridge has both Sun and Earth in view for 240 h over the same 14 days, against 182 h at Mons Mouton.');
  assert.equal(findingSentence({ ...base, altSiteName: 'Shackleton ridge', sameSite: false, slipDays: 14, plannedBothMs: 182 * H, altBothMs: 240 * H }),
    'Shackleton ridge, landing 14 days later, has both Sun and Earth in view for 240 h, against 182 h at Mons Mouton as planned.');
});

test('a stay shorter than a day is named in hours', () => {
  assert.equal(findingSentence({ ...base, slipDays: -14, stayDays: 1 / 24, plannedBothMs: 1 * H, altBothMs: 0 }),
    'Landing 14 days earlier cuts time with both Sun and Earth in view at Mons Mouton from 1.0 h to 0 h of the 1-hour stay.');
  assert.equal(findingSentence({ ...base, slipDays: 0, stayDays: 5.5, plannedBothMs: 30 * H, altBothMs: 30 * H }),
    'Mons Mouton has both Sun and Earth in view for 30 h of the 5.5-day stay.');
});

test('another site over a clipped stay rounds the days', () => {
  assert.equal(findingSentence({ ...base, altSiteName: 'Shackleton ridge', sameSite: false, slipDays: 0, stayDays: 6 - 1 / 24, plannedBothMs: 100 * H, altBothMs: 120 * H }),
    'Shackleton ridge has both Sun and Earth in view for 120 h over the same 6 days, against 100 h at Mons Mouton.');
});

import { mapFinding } from '../demo/src/finding.js';
test('map findings', () => {
  const base = { stayDays: 14, landingMs: Date.UTC(2027, 0, 13), cursorMs: Date.UTC(2027, 0, 13, 6), slipDays: 14, share: 0.123, loses: 0.31, gains: 0.044 };
  assert.equal(mapFinding({ ...base, mode: 'both' }), '12% of the mapped area has both Sun and Earth in view for at least half of the 14-day stay from 13 Jan 2027.');
  assert.equal(mapFinding({ ...base, mode: 'sun' }), '12% of the mapped area is sunlit for at least half of the 14-day stay from 13 Jan 2027.');
  assert.equal(mapFinding({ ...base, mode: 'earth' }), '12% of the mapped area has Earth in view for at least half of the 14-day stay from 13 Jan 2027.');
  assert.equal(mapFinding({ ...base, mode: 'now' }), 'At 13 Jan 2027, 06:00 UTC, 12% of the mapped area has both Sun and Earth in view.');
  assert.equal(mapFinding({ ...base, mode: 'change' }), 'Landing 14 days later, 31% of the mapped area loses more than a day with both in view, and 4% gains more than a day.');
  assert.equal(mapFinding({ ...base, mode: 'change', slipDays: 0 }), 'Set a slip to see what changes.');
});
