// Phase 6 B: the three stories (demo/src/stories.js) and the controller that runs them on the page
// (demo/src/story-controller.js). The facts each story's wording relies on are tested here, so a change in
// the data fails a test instead of making a story say something false. The controller is run against the
// real command layer and the real clock, with a recording view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCoreContext } from '../tools/core-context.mjs';
import { createCoreTools } from '../demo/src/tools-core.js';
import { createCommands } from '../demo/src/commands.js';
import { createTimeline, HOUR_MS, DAY_MS } from '../demo/src/timeline.js';
import { parseHash } from '../demo/src/state.js';
import { STORIES, STORY_SCENARIO, storyFacts, storyPremises, storyReady, fillText, stepPlan, spanWords, compass } from '../demo/src/stories.js';
import { createStoryController } from '../demo/src/story-controller.js';

const ctx = loadCoreContext();
const core = createCoreTools(ctx);
const run = (name, input) => core.run(name, input);
const facts = await storyFacts(run);
const BAD = /NaN|undefined|Infinity|null|\[object|\{|\}/;

// ---------- premises ----------
test('stories: every premise holds on the current data', () => {
  const ps = storyPremises(facts);
  assert.ok(ps.length >= 15);
  for (const p of ps) assert.ok(p.ok, `${p.story}: ${p.label}`);
  for (const s of STORIES) assert.ok(storyReady(facts, s.id), s.id);
});

test('stories: the named facts (Earthset 27 Jan 12:26, no Earthrise before 2 Feb, the Sun behind the hills at landing)', async () => {
  const ev = await run('rise_set_events', { site_id: 'im2', start: '2027-01-26T00:00Z', days: 3 });
  const set = ev.events.find((e) => e.event === 'Earthset');
  assert.equal(set.time, '2027-01-27T12:26Z');
  const after = await run('next_events', { site_id: 'im2', at: '2027-01-27T12:30Z' });
  assert.equal(after.earth.upNow, false);
  assert.equal(after.earth.nextRise.time, '2027-02-02T04:51Z');
  assert.ok(Date.parse(after.earth.nextRise.time) >= Date.UTC(2027, 1, 2));
  const at = await run('sky_at', { site_id: 'im2', at: STORY_SCENARIO.landing });
  assert.equal(at.sun.visible, false);
  assert.ok(at.sun.elDeg > 0 && at.sun.skylineDeg > at.sun.elDeg, 'above the level horizon, under the hills');
  assert.equal(facts.earthsetDay, '27 Jan');
  assert.equal(facts.earthsetTime, '12:26');
  assert.equal(facts.earthriseDay, '2 Feb');
});

test('stories: a failed premise keeps that story off', () => {
  const broken = { ...facts, raw: { ...facts.raw, atLanding: { ...facts.raw.atLanding, sun: { ...facts.raw.atLanding.sun, visible: true } } } };
  assert.equal(storyReady(broken, 'sun'), false);
  assert.equal(storyReady(broken, 'earth'), true);
});

// ---------- texts ----------
test('stories: 3 stories × 5 steps, every slot filled from the compute tier, no placeholders', () => {
  assert.equal(STORIES.length, 3);
  for (const s of STORIES) {
    assert.equal(s.steps.length, 5, s.id);
    for (let i = 0; i < 5; i++) {
      const p = stepPlan(s, i, facts);
      assert.doesNotMatch(p.title, BAD, `${s.id} ${i + 1} title`);
      assert.doesNotMatch(p.text, BAD, `${s.id} ${i + 1} text`);
      assert.ok(p.text.length > 30);
    }
  }
  assert.throws(() => fillText('{nope}', facts), /no figure for \{nope\}/);
});

test('stories: the figures in the texts are the compute tier\'s', async () => {
  const cmp = await run('compare_scenarios', { places: [{ site_id: 'im2' }], landings: ['2027-01-13', '2027-01-27'], stay_days: 14 });
  const card = Object.fromEntries(cmp.scenarios[1].vsBaseline.card.map((r) => [r.label, r]));
  const text = (id, i) => stepPlan(STORIES.find((s) => s.id === id), i, facts).text;
  assert.ok(text('sun', 1).includes(card['Peak Sun elevation'].baseline));
  assert.ok(text('sun', 4).includes(`up for ${card.Sunlit.baseline.replace(' h', '')} of the 336 hours`));
  assert.ok(text('earth', 4).includes(`all ${card['Earth in view'].baseline.replace(' h', '')} hours`));
  assert.ok(text('earth', 4).includes(`${card['Earth in view'].scenario.replace(' h', '')} hours`));
  assert.ok(text('slip', 2).includes(`from ${card.Sunlit.baseline} to ${card.Sunlit.scenario}`));
  assert.ok(text('slip', 2).includes(spanWords(cmp.scenarios[1].longestDarkH * HOUR_MS)));
  assert.ok(text('slip', 3).includes(`${card['Both in view'].scenario.replace(' h', '')} hours instead of ${card['Both in view'].baseline.replace(' h', '')}`));
  const next = await run('next_events', { site_id: 'im2', at: STORY_SCENARIO.landing });
  assert.ok(text('sun', 2).includes(`${next.sun.elDeg.toFixed(1)}° up`));
  assert.ok(text('sun', 2).includes(`at ${next.sun.nextRise.time.slice(11, 16)} that day`));
  assert.ok(text('earth', 0).includes(`${next.earth.aboveSkylineDeg.toFixed(1)}° above the skyline`));
  const sk = await run('skyline', { site_id: 'im2', step_deg: 5 });
  assert.ok(text('sun', 3).includes(`${Math.round(sk.highest.elDeg)}°, in the ${compass(sk.highest.azDeg)}`));
  const best = await run('best_landing_dates', { site_id: 'im2', stay_days: 14, count: 1, from: '2027-01-27', to: '2027-02-24' });
  assert.equal(best.candidates[0].landing, '2027-02-10T00:00Z');
  assert.ok(text('slip', 4).includes(`10 Feb 2027: ${best.candidates[0].exact.bothH} hours`));
  assert.equal(spanWords(5 * DAY_MS + 16 * HOUR_MS), '5 days 16 hours');
  assert.equal(spanWords(DAY_MS + 9 * HOUR_MS), '1 day 9 hours');
});

// ---------- the controller on the command layer and the clock ----------
function makePage({ reduced = false } = {}) {
  const st0 = parseHash('#site=shackleton&t=2027-06-01T06:00Z&stay=7&slip=-7&alt=haworth&mode=sun&z=2&cx=10&cy=-20', ctx.sites, ctx.eph);
  let state = { ...st0 };
  const timeline = createTimeline({ startMs: ctx.eph.startMs, endMs: ctx.eph.endMs, nowMs: state.landingMs + 30 * HOUR_MS, windowMinMs: HOUR_MS, window: { inMs: state.landingMs, outMs: state.landingMs + state.stayDays * DAY_MS } });
  timeline.setRate(DAY_MS);
  timeline.setLoop(true);
  const dialLayer = { on: false };
  const api = {
    sites: ctx.sites, core,
    landingRange: { startMs: ctx.eph.startMs, endMs: ctx.eph.endMs },
    getState: () => ({ ...state, playing: timeline.getState().playing }),
    update(patch) {
      const prev = state;
      state = { ...state, ...patch };
      if (prev.landingMs !== state.landingMs || prev.stayDays !== state.stayDays || prev.windowOn !== state.windowOn) {
        if (state.windowOn) timeline.setWindow(state.landingMs, state.landingMs + state.stayDays * DAY_MS, { minMs: HOUR_MS }); else timeline.clearWindow();
      }
    },
    setPlayhead: (ms) => timeline.setNow(ms),
    play: () => timeline.play(),
    pause: () => timeline.pause(),
    setLayer: (name, on) => { dialLayer.on = on; return { name, on }; },
  };
  const commands = createCommands(api);
  const shown = [];
  const calls = [];
  const view = {
    snapshot: () => ({ token: 'visitor view' }),
    enter: () => calls.push('enter'),
    show: (plan) => shown.push(plan),
    leave: () => calls.push('leave'),
    restore: (s) => calls.push(['restore', s.token]),
  };
  const controller = createStoryController({ commands, api, timeline, view, facts: async () => facts, reduced: () => reduced });
  return { controller, timeline, api, shown, calls, dialLayer, state: () => state, st0 };
}

test('story controller: each step puts the page in its state, through the commands and the clock', async () => {
  const pg = makePage();
  for (const story of STORIES) {
    const r = await pg.controller.start(story.id);
    assert.equal(r.ok, true, story.id);
    for (let i = 0; i < 5; i++) {
      const plan = i === 0 ? r.plan : await pg.controller.next();
      const st = pg.state(), tl = pg.timeline.getState();
      const want = stepPlan(story, i, facts);
      assert.equal(plan.index, i);
      assert.equal(plan.text, want.text);
      // the fixed scenario, whatever the visitor had
      assert.equal(st.site.id, 'im2');
      assert.equal(st.landingMs, Date.parse(STORY_SCENARIO.landing));
      assert.equal(st.stayDays, 14);
      assert.equal(st.slipDays, 14);
      assert.equal(st.altSite, 'same');
      assert.equal(st.windowOn, true);
      assert.equal(pg.dialLayer.on, true, 'the sky dial is on');
      // the step's own state
      assert.equal(st.mapMode, want.mode, `${story.id} ${i + 1} mode`);
      assert.equal(tl.rate, 6 * HOUR_MS);
      assert.equal(tl.loop, false);
      assert.equal(tl.playing, Boolean(want.play), `${story.id} ${i + 1} playing`);
      assert.equal(tl.nowMs, want.play ? want.play.fromMs : want.atMs, `${story.id} ${i + 1} playhead`);
      assert.deepEqual(pg.shown.at(-1).marks, want.marks);
      assert.equal(pg.shown.at(-1).dial, want.dial);
      assert.deepEqual(pg.shown.at(-1).lit, want.lit);
    }
    assert.equal(await pg.controller.next(), null, 'no step after the fifth');
  }
  assert.equal(pg.calls.filter((c) => c === 'enter').length, 1, 'one save for several stories in a row');
});

test('story controller: stop() puts back the visitor\'s state exactly (window, slip, site, mode, viewport, clock)', async () => {
  const pg = makePage();
  pg.timeline.play();
  const before = pg.api.getState();
  const tl0 = pg.timeline.getState();
  await pg.controller.start('slip');
  await pg.controller.go(3);
  assert.equal(pg.controller.stop(), true);
  const after = pg.api.getState(), tl = pg.timeline.getState();
  for (const k of ['view', 'landingMs', 'stayDays', 'slipDays', 'altSite', 'mapMode', 'windowOn']) assert.deepEqual(after[k], before[k], k);
  assert.equal(after.site.id, before.site.id);
  assert.deepEqual(after.viewport, before.viewport);
  assert.deepEqual(tl.window, tl0.window);
  assert.equal(tl.nowMs, tl0.nowMs);
  assert.equal(tl.rate, tl0.rate);
  assert.equal(tl.loop, tl0.loop);
  assert.equal(tl.playing, true);
  assert.deepEqual(pg.calls.slice(-2), ['leave', ['restore', 'visitor view']]);
  assert.equal(pg.controller.isActive(), false);
  assert.equal(pg.controller.stop(), false);
});

test('story controller: playback loops a step\'s span, or pauses at its end; reduced motion plays nothing', async () => {
  const pg = makePage();
  await pg.controller.start('earth');
  await pg.controller.go(1);   // plays the planned stay, looped
  const loop = pg.controller.current().plan.play;
  assert.equal(loop.end, 'loop');
  pg.timeline.setNow(loop.toMs - HOUR_MS);
  pg.timeline.tick(1000);   // 6 h of story time
  await new Promise((ok) => setTimeout(ok, 0));
  assert.equal(pg.timeline.getState().nowMs, loop.fromMs, 'back to the start of the span');
  assert.equal(pg.timeline.getState().playing, true);

  await pg.controller.go(3);   // Earthset to Earthrise, then pause
  const span = pg.controller.current().plan.play;
  assert.equal(span.end, 'pause');
  pg.timeline.setNow(span.toMs - HOUR_MS);
  pg.timeline.tick(1000);
  await new Promise((ok) => setTimeout(ok, 0));
  const tl = pg.timeline.getState();
  assert.equal(tl.playing, false);
  assert.equal(tl.nowMs, span.toMs, 'paused on the Earthrise');
  pg.controller.stop();

  const calm = makePage({ reduced: true });
  await calm.controller.start('earth');
  const p = await calm.controller.go(1);
  assert.equal(p.play, null);
  assert.equal(calm.timeline.getState().playing, false);
  assert.equal(calm.timeline.getState().nowMs, facts.earthNoteMs, 'resting on 20 Jan');
});

test('story controller: a story whose premises fail does not start, and changes nothing', async () => {
  const pg = makePage();
  const broken = { ...facts, raw: { ...facts.raw, wayOut: { none: true } } };
  const c = createStoryController({ commands: createCommands({ ...pg.api }), api: pg.api, timeline: pg.timeline, view: { snapshot: () => ({}), enter() { throw new Error('should not enter'); }, show() {}, leave() {}, restore() {} }, facts: async () => broken });
  const r = await c.start('slip');
  assert.equal(r.ok, false);
  assert.equal(pg.state().site.id, 'shackleton');
});
