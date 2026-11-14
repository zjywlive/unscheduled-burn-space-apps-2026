// Phase 6 B: runs a story on the real page (no DOM here; ui/storymode.js draws the card and the menu).
// Each step puts the page in its state through the page's command layer (commands.js: select_site,
// set_window, set_slip, set_map_mode, set_playhead, play, pause, set_layer) and the one clock (timeline.js:
// rate and loop), then hands the view the rest (the card, the time bar's marks, the dial's focus, the lit
// inspector rows). Before the first step it saves the visitor's state; stop() puts it back.
//
// createStoryController({ commands, api, timeline, view, facts, reduced, schedule })
//   commands  createCommands(api); api: the page api of main.js (getState, update)
//   view      { snapshot(), enter(), show(plan), leave(), restore(snap) }: the DOM side
//   facts     () → Promise<storyFacts>, cached by the caller
//   reduced   () → boolean: prefers-reduced-motion or the Settings switch; then nothing plays
// → { start(id), go(i), next(), back(), stop(), isActive(), current(), freeze() }
import { STORIES, STORY_SCENARIO, stepPlan, storyReady } from './stories.js';
import { HOUR_MS } from './timeline.js';

const STORY_RATE_MS = 6 * HOUR_MS;   // 6 h/s, the window rate of the time dock
const iso = (ms) => `${new Date(Math.floor(ms / 60e3) * 60e3).toISOString().slice(0, 16)}Z`;

export function createStoryController({ commands, api, timeline, view, facts, reduced = () => false, schedule = (fn) => queueMicrotask(fn) }) {
  let active = null;     // { story, index, plan }
  let saved = null;      // the visitor's state before the first step
  let segment = null;    // the step's playback: { fromMs, toMs, end }
  let f = null;

  // A step that plays loops its span or pauses at its end. The clock is changed after the notification
  // (scheduled), once per crossing: a pause clears the segment first, so the setNow it makes cannot act again.
  timeline.subscribe((st, changed) => {
    const s = segment;
    if (!s || !changed.includes('now') || !st.playing || st.nowMs < s.toMs) return;
    if (s.end === 'loop') schedule(() => { if (segment === s) timeline.setNow(s.fromMs); });
    else { segment = null; schedule(() => { timeline.pause(); timeline.setNow(s.toMs); }); }
  });

  function snapshot() {
    const st = api.getState(), tl = timeline.getState();
    return {
      patch: { view: st.view, site: st.site, landingMs: st.landingMs, stayDays: st.stayDays, slipDays: st.slipDays, altSite: st.altSite, mapMode: st.mapMode, viewport: st.viewport, windowOn: st.windowOn },
      nowMs: tl.nowMs, playing: tl.playing, rate: tl.rate, loop: tl.loop,
      view: view.snapshot(),
    };
  }

  async function run(name, input) {
    const r = await commands.run(name, input);
    if (r && r.error) throw new Error(`${name}: ${r.error}`);
    return r;
  }

  // the story's fixed scenario, whatever the visitor had selected
  async function applyScenario() {
    if (api.getState().view !== 'map') api.update({ view: 'map' });
    await run('select_site', { site_id: STORY_SCENARIO.siteId });
    await run('set_window', { landing: STORY_SCENARIO.landing, stay_days: STORY_SCENARIO.stayDays });
    await run('set_slip', { days: STORY_SCENARIO.slipDays });
    if (api.getState().altSite !== 'same') api.update({ altSite: 'same' });   // no command sets the alternative site
    await commands.run('set_layer', { name: 'skyDial', on: true });   // no dial switch in a layout is not fatal
  }

  // the map stays usable during a story: a visitor who picked another place gets the story's back on the next step
  function offScenario() {
    const st = api.getState();
    return st.view !== 'map' || st.site?.id !== STORY_SCENARIO.siteId || st.landingMs !== Date.parse(STORY_SCENARIO.landing) || st.stayDays !== STORY_SCENARIO.stayDays
      || st.slipDays !== STORY_SCENARIO.slipDays || st.altSite !== 'same' || st.windowOn === false;
  }

  async function apply(index) {
    if (offScenario()) await applyScenario();
    const plan = stepPlan(active.story, index, f, { reduced: reduced() });
    active = { ...active, index, plan };
    segment = null;
    await run('pause', {});
    if (api.getState().mapMode !== plan.mode) await run('set_map_mode', { mode: plan.mode });
    timeline.setLoop(false);
    timeline.setRate(STORY_RATE_MS);
    await run('set_playhead', { at: iso(plan.play ? plan.play.fromMs : plan.atMs) });
    view.show(plan);
    if (plan.play) {
      segment = { ...plan.play };
      await run('play', {});
    }
    return plan;
  }

  return {
    // → { ok: true, plan } or { ok: false, reason }
    async start(id) {
      const story = STORIES.find((s) => s.id === id);
      if (!story) return { ok: false, reason: `No story ${id}.` };
      f = await facts();
      if (!storyReady(f, id)) return { ok: false, reason: 'The data no longer supports this story.' };
      if (!active) { saved = snapshot(); view.enter(); }
      active = { story, index: 0, plan: null };
      await commands.run('set_layer', { name: 'skyDial', on: true });   // even when the page already shows the scenario
      return { ok: true, plan: await apply(0) };
    },
    async go(i) {
      if (!active) return null;
      const n = active.story.steps.length;
      return apply(Math.max(0, Math.min(n - 1, i)));
    },
    next() { return active && active.index < active.story.steps.length - 1 ? this.go(active.index + 1) : null; },
    back() { return active && active.index > 0 ? this.go(active.index - 1) : null; },
    // Back to the visitor's own state, exactly as it was (the clock included).
    stop() {
      if (!active) return false;
      segment = null;
      active = null;
      view.leave();
      const s = saved;
      saved = null;
      timeline.pause();
      api.update(s.patch);
      timeline.setRate(s.rate);
      timeline.setLoop(s.loop);
      timeline.setNow(s.nowMs);
      if (s.playing) timeline.play();
      view.restore(s.view);
      return true;
    },
    // Hold the step still at its resting instant (screenshots, and a visitor who presses pause keeps it anyway).
    freeze() {
      if (!active?.plan) return;
      segment = null;
      timeline.pause();
      timeline.setNow(active.plan.atMs);
    },
    isActive: () => Boolean(active),
    current: () => (active ? { id: active.story.id, index: active.index, plan: active.plan } : null),
  };
}
