// Phase 6 A: the verdict sentence and its way out (demo/src/verdict.js), on the real data: every case reads
// its figures from the same summaries as the inspector table (compareRows), the way out comes from the
// compute tier, and the fetch that brings it cannot chain requests (the phase-5 freeze).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCoreContext } from '../tools/core-context.mjs';
import { createCoreTools } from '../demo/src/tools-core.js';
import { parseHash, alternativeOf } from '../demo/src/state.js';
import { summarizePair, summarize } from '../demo/src/windows.js';
import { compareRows } from '../demo/src/compare-rows.js';
import { skylineFor } from '../demo/src/terrain.js';
import { verdictOf, fetchWayOut, createWayOutFetcher, wayOutKey } from '../demo/src/verdict.js';

const ctx = loadCoreContext();
const core = createCoreTools(ctx);
const run = (name, input) => core.run(name, input);
const skyCache = new Map();
const sky = (site) => { const k = `${site.latDeg},${site.lonDeg}`; if (!skyCache.has(k)) skyCache.set(k, skylineFor(ctx.dem, site)); return skyCache.get(k); };
const DAY = 86400e3;
const BAD = /NaN|undefined|Infinity|null|\{|\}/;

// main.js compute() and verdictInfo(), for a hash
function page(hash) {
  const state = parseHash(hash, ctx.sites, ctx.eph);
  const altScenario = alternativeOf(state, ctx.sites);
  const planned = summarize(ctx.eph, state.site, state.landingMs, state.stayDays, sky(state.site));
  const pair = summarizePair(ctx.eph, { site: state.site, landingMs: state.landingMs, mask: sky(state.site) }, { ...altScenario, mask: sky(altScenario.site) }, state.stayDays, 0);
  const sameSite = altScenario.site.id === state.site.id;
  const compared = pair.alt !== null && !(sameSite && state.slipDays === 0);
  const rows = compareRows(compared ? pair.planned : planned, compared ? pair.alt : null).slice(0, 3);
  const v = verdictOf({
    windowOn: state.windowOn, planned, alt: pair.alt, cmpPlanned: pair.planned, cmpDays: pair.stayDays, compared, sameSite,
    slipDays: state.slipDays, altName: altScenario.site.name, stayDays: state.stayDays, altLandingMs: altScenario.landingMs,
    ephStartMs: ctx.eph.startMs, ephEndMs: ctx.eph.endMs,
  });
  return { state, altScenario, planned, pair, rows, v, compared };
}

test('verdict: the default scenario (worse) says it in the table\'s own figures', () => {
  const { v, rows } = page('');
  assert.equal(v.kind, 'worse');
  assert.equal(v.text, 'Slipping 14 days cuts Sun-and-Earth time from 312 h to 12 h.');
  assert.equal(rows[0].planned, '312 h');
  assert.equal(rows[0].alt, '12 h');
  assert.deepEqual(v.parts.find((p) => p.tone === 'worse'), { text: rows[0].alt, tone: 'worse' });
});

test('verdict: every case has one sentence, with the table\'s figures and no placeholders', () => {
  const cases = [
    // [hash, kind, exact sentence]
    ['#t=2027-01-27T00:00Z&slip=-14', 'better', 'Landing 14 days earlier raises Sun-and-Earth time from 12 h to 312 h.'],
    ['#slip=0', 'none', 'Sun and Earth are both in view for 312 h of this 14-day stay.'],
    ['#site=change4&slip=7', 'same', 'Slipping 7 days leaves Sun-and-Earth time unchanged at 0 h.'],
    ['#slip=0&alt=shackleton', 'worse', null],
    ['#slip=7&alt=shackleton', null, null],
    ['#t=2028-12-26T00:00Z&slip=-14', null, null],
    ['#t=2028-12-26T00:00Z&slip=14', 'outside', 'Slipping 14 days lands after the ephemeris ends (1 Jan 2029), so there is nothing to compare.'],
    ['#t=2026-11-05T00:00Z&slip=-14', 'outside', 'Landing 14 days earlier lands before the ephemeris starts (1 Nov 2026), so there is nothing to compare.'],
    ['#site=c:-89.5,45&slip=14', null, null],
    ['#site=c:-89.5,45&slip=0', 'none', null],
    ['#slip=14&alt=c:-89.3,120', null, null],
  ];
  for (const [hash, kind, text] of cases) {
    const { v, rows, compared, pair } = page(hash);
    assert.ok(v, `${hash}: a sentence`);
    if (kind) assert.equal(v.kind, kind, hash);
    if (text) assert.equal(v.text, text, hash);
    assert.doesNotMatch(v.text, BAD, hash);
    assert.match(v.text, /\.$/, `${hash}: one sentence`);
    if (compared) {
      // the sentence quotes the table's lead row, as shown
      assert.ok(v.text.includes(rows[0].planned), `${hash}: planned ${rows[0].planned}`);
      if (v.kind !== 'same') assert.ok(v.text.includes(rows[0].alt), `${hash}: alternative ${rows[0].alt}`);
    } else if (pair.alt) {
      assert.ok(v.kind === 'none' && (v.text.includes(rows[0].planned) || /never|all of/.test(v.text)), hash);
    }
  }
  // another site names it; a map point is "the map point"
  assert.match(page('#slip=0&alt=shackleton').v.text, /^Landing at Shackleton ridge instead (cuts|raises|leaves)/);
  assert.match(page('#slip=7&alt=shackleton').v.text, /^Landing at Shackleton ridge 7 days later /);
  assert.match(page('#slip=14&alt=c:-89.3,120').v.text, /^Landing at the map point 14 days later /);
  // the ephemeris end clips the comparison: the sentence says over how long
  assert.match(page('#t=2028-12-26T00:00Z&slip=-14').v.text, /, over the 6 days both stays fit before 1 Jan 2029\.$/);
  // the planned stay alone clipped, no alternative
  assert.match(page('#t=2028-12-26T00:00Z&slip=0').v.text, /of the 6-day stay left before 1 Jan 2029\.$/);
});

test('verdict: no mission window, no block', () => {
  assert.equal(page('#win=off').v, null);
});

test('way out: the best landing in the four weeks after the alternative, and the figure the table then shows', async () => {
  const { state, altScenario, pair } = page('');
  const q = { site: state.site, altSite: altScenario.site, landingMs: state.landingMs, altLandingMs: altScenario.landingMs, stayDays: state.stayDays, slipDays: state.slipDays, altBothMs: pair.alt.bothMs };
  const w = await fetchWayOut(run, q);
  assert.equal(w.none, false);
  assert.equal(w.label, 'Best landing in the 4 weeks after 27 Jan');
  assert.equal(w.value, '10 Feb 2027 · 266 h');
  assert.equal(w.slipDays, 28);
  // the same day as best_landing_dates ranks first over those four weeks
  const best = await run('best_landing_dates', { site_id: 'im2', stay_days: 14, count: 1, from: '2027-01-27', to: '2027-02-24' });
  assert.equal(Date.parse(best.candidates[0].landing), w.landingMs);
  // after "Set as alternative" (slip 28) the table's alternative column shows exactly that figure
  const after = page('#slip=28');
  assert.equal(after.rows[0].alt, w.bothText);
  assert.ok(w.bothH * 3600e3 > pair.alt.bothMs);
});

test('way out: the landing time of day is kept, so the figure still matches the table', async () => {
  const { state, altScenario, pair } = page('#t=2027-01-13T06:00Z');
  const q = { site: state.site, altSite: altScenario.site, landingMs: state.landingMs, altLandingMs: altScenario.landingMs, stayDays: state.stayDays, slipDays: state.slipDays, altBothMs: pair.alt.bothMs };
  const w = await fetchWayOut(run, q);
  assert.equal(w.none, false);
  assert.equal(w.landingMs % DAY, 6 * 3600e3);
  assert.match(w.value, / 06:00 · /);
  assert.equal(page(`#t=2027-01-13T06:00Z&slip=${w.slipDays}`).rows[0].alt, w.bothText);
});

test('way out: shown only when better; the button only when the slip stays within −60 to 60 days', async () => {
  const base = { site: { id: 'im2' }, altSite: { id: 'im2' }, landingMs: Date.UTC(2027, 0, 13), stayDays: 14 };
  const fake = (candidateDay, bothH) => async (name) => (name === 'best_landing_dates'
    ? { candidates: [{ landing: new Date(candidateDay).toISOString().slice(0, 16) + 'Z' }] }
    : { scenarios: [{}, { bothH, vsBaseline: { card: [{ label: 'Both in view', scenario: `${bothH} h` }] } }] });
  // not better than the alternative as shown
  const same = await fetchWayOut(fake(Date.UTC(2027, 1, 3), 12), { ...base, altLandingMs: Date.UTC(2027, 0, 27), slipDays: 14, altBothMs: 12 * 3600e3 });
  assert.equal(same.none, true);
  // better, but 50 + 20 = 70 days from the plan: shown, no button
  const far = await fetchWayOut(fake(Date.UTC(2027, 2, 24), 200), { ...base, altLandingMs: Date.UTC(2027, 2, 4), slipDays: 50, altBothMs: 12 * 3600e3 });
  assert.equal(far.none, false);
  assert.equal(far.slipDays, null);
  // the compute tier says no (e.g. past the ephemeris end): nothing to show
  const none = await fetchWayOut(async () => ({ error: 'No landing day in that range' }), { ...base, altLandingMs: Date.UTC(2028, 11, 26), slipDays: 14, altBothMs: 0 });
  assert.equal(none.none, true);
});

// ---------- the fetch: no request chain, whatever the answers (phase-5 freeze, verify-2026-11-13) ----------
const tick = () => new Promise((ok) => setTimeout(ok, 0));
const Q = { site: { latDeg: -84.79, lonDeg: 29.2 }, altSite: { latDeg: -84.79, lonDeg: 29.2 }, landingMs: 0, altLandingMs: DAY, stayDays: 14, altBothMs: 0 };

test('way-out fetch: a redraw that asks again finds the cache (one fetch per scenario)', async () => {
  let fetches = 0, draws = 0;
  let w = null;
  const f = createWayOutFetcher({ run: null, fetch: async () => { fetches++; return { none: false, value: 'x' }; }, onUpdate: () => { draws++; w.get('A', Q); } });
  w = f;
  assert.equal(w.get('A', Q), undefined);   // pending
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(fetches, 1);
  assert.equal(draws, 1);
  assert.deepEqual(w.get('A', Q), { none: false, value: 'x' });
});

test('way-out fetch: a failure is cached too, so the redraw does not ask again', async () => {
  let fetches = 0, draws = 0, w = null;
  w = createWayOutFetcher({ run: null, fetch: async () => { fetches++; throw new Error('boom'); }, onUpdate: () => { draws++; w.get('A', Q); } });
  w.get('A', Q);
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(fetches, 1);
  assert.equal(draws, 1);
  assert.equal(w.get('A', Q).none, true);
  // an error result (not a throw) as well
  let n = 0, w2 = null;
  w2 = createWayOutFetcher({ run: null, fetch: async () => { n++; return { none: true, reason: 'error' }; }, onUpdate: () => w2.get('B', Q) });
  w2.get('B', Q);
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(n, 1);
});

test('way-out fetch: a stale answer is dropped and starts nothing; even a synchronous redraw ends', async () => {
  let fetches = [], draws = 0, w = null;
  const gates = {};
  w = createWayOutFetcher({
    run: null,
    fetch: (r, q) => { fetches.push(q.tag); return new Promise((ok) => { gates[q.tag] = ok; }); },
    onUpdate: () => { draws++; w.get('B', { ...Q, tag: 'B' }); },
    schedule: (fn) => fn(),   // worst case: the redraw runs inside the answer
  });
  w.get('A', { ...Q, tag: 'A' });
  await tick();
  w.get('B', { ...Q, tag: 'B' });   // the scenario changed before A answered
  await tick();
  gates.A({ none: false, value: 'a' });   // A answers late: dropped
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(fetches, ['A', 'B']);
  assert.equal(draws, 0);
  gates.B({ none: false, value: 'b' });
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(fetches, ['A', 'B']);   // the redraw inside the answer hit the cache
  assert.equal(draws, 1);
  assert.equal(w.get('B', Q).value, 'b');
});

test('way-out fetch: on the page, the key changes with the scenario and only then', () => {
  const { state, altScenario, pair } = page('');
  const q = { site: state.site, altSite: altScenario.site, landingMs: state.landingMs, altLandingMs: altScenario.landingMs, stayDays: state.stayDays, slipDays: state.slipDays, altBothMs: pair.alt.bothMs };
  assert.equal(wayOutKey(q), wayOutKey({ ...q }));
  assert.notEqual(wayOutKey(q), wayOutKey({ ...q, altLandingMs: q.altLandingMs + DAY }));
  assert.notEqual(wayOutKey(q), wayOutKey({ ...q, stayDays: 7 }));
});
