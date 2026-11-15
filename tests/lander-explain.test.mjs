// Lander track: the "What's happening" text (explain.js) and the Earth link maths (link.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPLAIN, explainFor, nextEvent } from '../demo/src/lander/explain.js';
import { fsplDb, eirpDbm, requiredDbm, segmentClear, linkState, strength, sparkPath, radioNote, RADIO_DEFAULTS, C_KMS } from '../demo/src/lander/link.js';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { planMission } from '../demo/src/lander/mission.js';
import { R_EARTH } from '../demo/src/lander/constants.js';

const demo = new URL('../demo/', import.meta.url).pathname;
const plan = (() => {
  const eph = createEphemeris(JSON.parse(readFileSync(join(demo, 'data', 'ephemeris.json'), 'utf8')));
  const sites = JSON.parse(readFileSync(join(demo, 'data', 'sites.json'), 'utf8'));
  return planMission({ eph, site: sites.find((s) => s.id === 'shackleton'), landingMs: Date.parse('2027-01-10T02:00:00Z') });
})();

test('explain: every phase of the plan has a short plain-English entry', () => {
  assert.ok(plan.ok !== false);
  for (const ph of plan.phases) {
    const e = explainFor({ phase: ph.id });
    assert.equal(e.key, ph.id, `phase ${ph.id} has its own entry`);
    assert.ok(e.title && e.what.length > 30 && e.why.length > 30);
  }
  for (const [k, e] of Object.entries(EXPLAIN)) {
    assert.ok(e.what.length + e.why.length < 360, `${k} stays short`);
    assert.ok((e.what.match(/[.!?](\s|$)/g) ?? []).length <= 2, `${k}: what is at most two sentences`);
  }
});

test('explain: separation while the upper stage is attached on the coast; surface operations; unknown phases', () => {
  assert.equal(explainFor({ phase: 'coast', tliStageAttached: true }).key, 'separation');
  assert.equal(explainFor({ phase: 'coast', tliStageAttached: false }).key, 'coast');
  assert.equal(explainFor({ phase: 'tli', tliStageAttached: true }).key, 'tli');
  assert.equal(explainFor({ phase: 'landed', surfaceOps: true }).key, 'surface-ops');
  assert.equal(explainFor({ phase: 'nope' }).key, 'unknown');
});

test('explain: nextEvent is the first event after the time', () => {
  const ev = [{ tMs: 100, id: 'a', name: 'A' }, { tMs: 300, id: 'c', name: 'C' }, { tMs: 200, id: 'b', name: 'B' }];
  assert.deepEqual(nextEvent(ev, 100), { id: 'b', name: 'B', inS: 0.1 });
  assert.equal(nextEvent(ev, 300), null);
  const n = nextEvent(plan.events, plan.times.launchMs);
  assert.ok(n && n.inS > 0);
});

test('link: free-space loss at the Moon is about 211 dB at 2.2 GHz and grows 6 dB per doubling', () => {
  assert.ok(Math.abs(fsplDb(384400, 2200) - 210.99) < 0.05);
  assert.ok(Math.abs(fsplDb(2000, 2200) - fsplDb(1000, 2200) - 6.0206) < 1e-3);
  assert.ok(Number.isNaN(fsplDb(0, 2200)));
});

test('link: the assumed radio closes from the Moon with a modest margin', () => {
  assert.ok(Math.abs(eirpDbm() - 42.99) < 0.02);
  assert.ok(Math.abs(requiredDbm() - (-198.6 + 16.02 + 54.08 + 3)) < 0.05);
  const l = linkState({ pos: [0, 0, 0], earth: [384400 + R_EARTH, 0, 0], inView: true });
  assert.ok(Math.abs(l.rangeKm - 384400) < 1e-6);
  assert.ok(Math.abs(l.lightTimeS - 384400 / C_KMS) < 1e-9 && l.lightTimeS > 1.2 && l.lightTimeS < 1.4);
  assert.ok(l.marginDb > 5 && l.marginDb < 15, `margin ${l.marginDb}`);
  assert.equal(l.quality, 'strong');
  assert.ok(strength(l) > 0 && strength(l) < 1);
  assert.match(radioNote(), /Assumed radio: S-band 2\.2 GHz/);
  assert.equal(RADIO_DEFAULTS.freqMHz, 2200);
});

test('link: no line of sight means no received level; a closer craft has a stronger signal', () => {
  const far = linkState({ pos: [0, 0, 0], earth: [384400, 0, 0], inView: false });
  assert.equal(far.rxDbm, null); assert.equal(far.marginDb, null); assert.equal(far.quality, 'none'); assert.equal(strength(far), 0);
  const near = linkState({ pos: [R_EARTH + 200, 0, 0], earth: [0, 0, 0] });
  const moon = linkState({ pos: [384400, 0, 0], earth: [0, 0, 0] });
  assert.ok(near.rxDbm > moon.rxDbm + 60);
  assert.equal(strength(near), 1);
  assert.ok(linkState({ pos: [R_EARTH + 10, 0, 0], earth: [0, 0, 0] }).rangeKm === 160);
});

test('link: segmentClear blocks a path through the sphere and passes one beside it', () => {
  assert.equal(segmentClear([-5000, 0, 0], [5000, 0, 0], [0, 0, 0], 1737), false);
  assert.equal(segmentClear([-5000, 2000, 0], [5000, 2000, 0], [0, 0, 0], 1737), true);
  assert.equal(segmentClear([2000, 0, 0], [5000, 0, 0], [0, 0, 0], 1737), true);   // the sphere is behind the start
});

test('link: over the flown mission the Earth is hidden behind the Moon for part of the lunar orbit', () => {
  const t = plan.times;
  const ph = plan.phases.find((p) => p.id === 'llo');
  let seen = 0, hidden = 0;
  for (let i = 0; i <= 200; i++) {
    const st = plan.stateAt(ph.startMs + ((ph.endMs - ph.startMs) * i) / 200);
    const l = linkState({ pos: st.pos, earth: st.earth, inView: st.earthInView });
    assert.ok(l.rangeKm > 300000 && l.rangeKm < 420000);
    if (l.inView) seen++; else hidden++;
  }
  assert.ok(seen > 0, 'in view for part of the orbit');
  const leo = plan.stateAt(t.launchMs + 60e3);
  assert.ok(linkState({ pos: leo.pos, earth: leo.earth, inView: leo.earthInView }).rangeKm < 2000);
  assert.ok(hidden >= 0);
});

test('link: sparkPath breaks the line at gaps', () => {
  const d = sparkPath([-100, -100, null, -90, -90], 100, 20, -130, -20);
  assert.equal((d.match(/M/g) ?? []).length, 2);
  assert.equal(sparkPath([1], 10, 10, 0, 1), '');
});
