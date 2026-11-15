// The plan steps on the inspector (demo/src/ui/plansteps.js) and their hash key (state.js step=).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { DEFAULTS, PLAN_STEPS, parseHash, toHash } from '../demo/src/state.js';
import { STEP_IDS, stepForKind, gradeStay, VERDICT_LABEL } from '../demo/src/ui/plansteps.js';
const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const sites = load('../demo/data/sites.json');
const eph = createEphemeris(load('../demo/data/ephemeris.json'));

test('the step ids are the same in the hash and on the tabs, Site first', () => {
  assert.deepEqual(PLAN_STEPS, STEP_IDS);
  assert.equal(DEFAULTS.step, 'site');
  assert.deepEqual(STEP_IDS, ['site', 'date', 'verdict', 'compare', 'route']);
});

test('step= is read, written only when it is not Site, and old links open Site', () => {
  const base = parseHash('', sites, eph);
  assert.equal(base.step, 'site');
  assert.ok(!toHash(base).includes('step='), 'a default state hashes as before');
  for (const id of STEP_IDS.slice(1)) {
    const h = toHash({ ...base, step: id });
    assert.match(h, new RegExp(`&step=${id}(&|$)`));
    assert.equal(parseHash(h, sites, eph).step, id);
  }
  assert.equal(parseHash('#view=map&site=im2&step=nope', sites, eph).step, 'site');
  assert.equal(parseHash('#view=map&site=im2&t=2027-01-13T00:00Z&stay=14', sites, eph).step, 'site');
});

test('the tabs follow what the inspector shows', () => {
  assert.equal(stepForKind('site', 'route'), 'route');        // a route on the panel is the Route step
  assert.equal(stepForKind('verdict', 'route'), 'route');
  assert.equal(stepForKind('date', 'region'), 'site');        // a region or Where to land is part of Site
  assert.equal(stepForKind('compare', 'land'), 'site');
  assert.equal(stepForKind('route', 'point'), 'site');        // leaving the route ends the Route step
  for (const id of ['site', 'date', 'verdict', 'compare']) assert.equal(stepForKind(id, 'point'), id);   // a pick keeps the step
  assert.equal(stepForKind('bogus', 'point'), 'site');
});

test('pass marks: power on the battery (or the dark spell), comms on the Earth, sunlight on the Sun', () => {
  const s = (o) => ({ sunPct: 90, earthPct: 90, longestDarkH: 10, ...o });
  assert.deepEqual(gradeStay(s()), { power: 'ok', comms: 'ok', sun: 'ok', overall: 'ok' });
  assert.equal(gradeStay(s({ longestDarkH: 30 })).power, 'near');
  assert.equal(gradeStay(s({ longestDarkH: 49 })).power, 'bad');
  // the energy model wins over the dark spell when it is there
  assert.equal(gradeStay(s({ longestDarkH: 200 }), { planned: { atEmptyH: 0 } }).power, 'ok');
  assert.equal(gradeStay(s(), { planned: { atEmptyH: 12 } }).power, 'near');
  assert.equal(gradeStay(s(), { planned: { atEmptyH: 25 } }).power, 'bad');
  assert.equal(gradeStay(s({ earthPct: 50 })).comms, 'ok');
  assert.equal(gradeStay(s({ earthPct: 30 })).comms, 'near');
  assert.equal(gradeStay(s({ earthPct: 10 })).comms, 'bad');
  assert.equal(gradeStay(s({ sunPct: 70 })).sun, 'ok');
  assert.equal(gradeStay(s({ sunPct: 40 })).sun, 'near');
  assert.equal(gradeStay(s({ sunPct: 39 })).sun, 'bad');
  // the worst of the three
  assert.equal(gradeStay(s({ sunPct: 50 })).overall, 'near');
  assert.equal(gradeStay(s({ sunPct: 50, earthPct: 0 })).overall, 'bad');
  assert.deepEqual(Object.keys(VERDICT_LABEL), ['ok', 'near', 'bad']);
});
