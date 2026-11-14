import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtHours, fmtSpan, fmtPct, fmtDeg, fmtUtc, fmtDay, fmtDayOfStay } from '../demo/src/format.js';
const H = 3600e3;
test('formats', () => {
  assert.equal(fmtHours(182.4 * H), '182 h');
  assert.equal(fmtHours(6.5 * H), '6.5 h');
  assert.equal(fmtHours(0), '0 h');
  assert.equal(fmtSpan(76 * H), '3 d 4 h');
  assert.equal(fmtSpan(5 * H + 20 * 60e3), '5 h 20 min');
  assert.equal(fmtSpan(40 * 60e3), '40 min');
  assert.equal(fmtSpan(20 * H + 50e3), '20 h');     // rounds to 10 min, drops "0 min"
  assert.equal(fmtSpan(360 * H - 40e3), '15 d');    // rounds to the hour, drops "0 h"
  assert.equal(fmtPct(0.538), '54%');
  assert.equal(fmtDeg(-3.46), '−3.5°');
  assert.equal(fmtDeg(5.24), '5.2°');
  assert.equal(fmtDeg(null), '—');
  assert.equal(fmtUtc(Date.UTC(2027, 2, 12, 6)), '12 Mar 2027, 06:00 UTC');
  assert.equal(fmtDay(Date.UTC(2027, 2, 12, 6)), '12 Mar');
  assert.equal(fmtDayOfStay(Date.UTC(2027, 2, 14, 6), Date.UTC(2027, 2, 12, 0)), 'Day 3, 06:00');
});
