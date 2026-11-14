// Phase 6 B: the three stories behind the Tour button (docs/phase6/brief-opus-stories.md §B; the step texts of
// docs/phase6/mock-handoff.md, "三个讲解的逐步文字"). Data and pure functions only, no DOM:
//   STORY_SCENARIO   the one scenario every story uses (not the visitor's selection)
//   STORIES          id, title, subtitle, five steps each: title, text template, the page state to show
//   storyFacts(run)  every figure the texts and states need, from the compute tier (tools-core.js core.run)
//   storyPremises(f) the facts each story's wording relies on, as checks; a failed one means the data changed
//                    and the story would say something false (tests/stories.test.mjs runs them, and the page
//                    does not offer a story whose premises fail)
//   fillText(t, f)   a template with every {slot} filled, or throws on a missing one
//   stepPlan(story, i, f, { reduced }) the page state of one step: mode, playhead, playback, dock, dial, lit
// Figures are never written into the texts: each {slot} is filled from storyFacts when a story starts.
// Fixed wording that is not a figure ("three fingers", "Two weeks later") is checked by a premise instead.
import { fmtSpan } from './format.js';
import { fetchWayOut } from './verdict.js';

const H = 3600e3;
const DAY_MS = 86400e3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// IM-2 Athena, landing 13 Jan 2027 00:00 UTC, 14-day stay, alternative 14 days later at the same site.
export const STORY_SCENARIO = Object.freeze({ siteId: 'im2', landing: '2027-01-13T00:00Z', stayDays: 14, slipDays: 14 });
// the instant story 2 reads Earth's height at ("on 20 Jan"), a week into the stay
const EARTH_NOTE_DAYS = 7;

const iso = (ms) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
const pad2 = (n) => String(n).padStart(2, '0');
const dayMonth = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const dayMonthYear = (ms) => `${dayMonth(ms)} ${new Date(ms).getUTCFullYear()}`;
const hhmm = (ms) => { const d = new Date(ms); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };
const deg1 = (v) => `${(Math.round(v * 10) / 10).toFixed(1)}°`;
const deg0 = (v) => `${Math.round(v)}°`;
// "12 d 15 h" (fmtSpan, as the page prints spans) in words: "12 days 15 hours"
export function spanWords(ms) {
  return fmtSpan(ms).replace(/(\d+) d\b/, (m, n) => `${n} ${n === '1' ? 'day' : 'days'}`)
    .replace(/(\d+) h\b/, (m, n) => `${n} ${n === '1' ? 'hour' : 'hours'}`)
    .replace(/(\d+) min\b/, (m, n) => `${n} ${n === '1' ? 'minute' : 'minutes'}`);
}
// "312 h" (the table's text) → "312"
const num = (text) => String(text).replace(/\s*h$/, '');
const COMPASS = ['north', 'north-north-east', 'north-east', 'east-north-east', 'east', 'east-south-east', 'south-east', 'south-south-east',
  'south', 'south-south-west', 'south-west', 'west-south-west', 'west', 'west-north-west', 'north-west', 'north-north-west'];
export const compass = (azDeg) => COMPASS[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16];

// The widest angle (degrees) between two sky positions { azDeg, elDeg }.
export function widestAngle(points) {
  const r = Math.PI / 180;
  const v = points.filter((p) => Number.isFinite(p.azDeg) && Number.isFinite(p.elDeg))
    .map((p) => [Math.cos(p.elDeg * r) * Math.sin(p.azDeg * r), Math.cos(p.elDeg * r) * Math.cos(p.azDeg * r), Math.sin(p.elDeg * r)]);
  let best = 0;
  for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) {
    const d = Math.min(1, Math.max(-1, v[i][0] * v[j][0] + v[i][1] * v[j][1] + v[i][2] * v[j][2]));
    best = Math.max(best, Math.acos(d) / r);
  }
  return best;
}

// ---------- the stories ----------
// A step: title, text (a template), and the page state:
//   mode      the map mode ('both', 'sun', 'earth')
//   at        the fact (an instant, ms) the playhead rests on: where it stays, or where playback pauses
//   play      { from, to, end: 'loop' | 'pause' } facts; playback over that span (looped, or pausing at its end).
//             Under reduced motion the playhead rests on `at` and nothing plays.
//   dial      the sky dial's focus: 'sun-track', 'sun', 'skyline', 'earth', 'earth-track'
//   marks     facts (rises and sets) marked on the time bar, with their body
//   focus     the time bar window the step points at: 'win' (the planned stay) or 'alt'
//   lit       inspector parts kept bright: 'row:<label>', 'col:planned', 'verdict', 'wayout', 'set-alt'
export const STORIES = [
  {
    id: 'sun', title: 'Why the Sun never climbs here', subtitle: '5 steps · the low Sun and the hills',
    steps: [
      { title: 'The Sun goes round, not up', mode: 'both', at: 'landingMs', dial: 'sun-track',
        text: 'Near the Moon\'s south pole the Sun does not rise high and set each evening. Over a month it circles the whole horizon, always low.' },
      { title: 'Never more than a few degrees', mode: 'both', at: 'midStayMs', play: { from: 'landingMs', to: 'plannedEndMs', end: 'loop' }, dial: 'sun',
        text: 'During this {stayDays}-day stay the Sun is never more than {peakSun} above the level horizon. Hold your hand at arm\'s length: that is about three fingers.' },
      { title: 'Hills decide day and night', mode: 'both', at: 'landingMs', dial: 'skyline',
        text: 'At landing the Sun is {sunElAtLanding} up, but the hills in that direction reach {hillsAtLanding}. So it is still dark. The Sun clears them at {sunriseTime} that day.' },
      { title: 'The skyline here is low', mode: 'sun', at: 'afterSunriseMs', dial: 'skyline',
        text: 'The skyline around this site is never higher than {skylineMax}, in the {skylineMaxDir}. Once the Sun clears it, it mostly stays up.' },
      { title: 'What it means', mode: 'sun', at: 'afterSunriseMs', dial: 'sun', lit: ['row:Sunlit'],
        text: 'The Sun is up for {plannedSunNum} of the {stayH} hours of the stay. The only long dark is the first day, before that first sunrise.' },
    ],
  },
  {
    id: 'earth', title: 'Why Earth can set', subtitle: '5 steps · Earth drifts, and the hills hide it',
    steps: [
      { title: 'Earth is in the {earthDir}', mode: 'both', at: 'landingMs', dial: 'earth',
        text: 'At landing, Earth is {earthAboveAtLanding} above the skyline, low in the {earthDir}.' },
      { title: 'Earth hangs in one part of the sky', mode: 'both', at: 'earthNoteMs', play: { from: 'landingMs', to: 'plannedEndMs', end: 'loop' }, dial: 'earth-track',
        text: 'From the Moon, Earth does not rise and set each day. It stays low in the {earthDir}, and over a month it wanders less than {earthWander} across the sky. Watch the blue dot: on {earthNoteDay} it is {earthNoteAbove} above the skyline.' },
      { title: 'When it drifts under the skyline, it sets', mode: 'both', at: 'earthsetMs', dial: 'earth', marks: ['earthsetMs'],
        text: 'On {earthsetDay} at {earthsetTime} UTC Earth sinks below the skyline. That is {earthsetAfterPlanned} after the planned stay ends.' },
      { title: 'Gone for almost six days', mode: 'both', at: 'earthriseMs', play: { from: 'earthsetMs', to: 'earthriseMs', end: 'pause' }, dial: 'earth', marks: ['earthsetMs', 'earthriseMs'], focus: 'alt',
        text: 'It comes back on {earthriseDay} at {earthriseTime}, {earthGone} later. With no Earth in the sky, a lander cannot talk to Earth directly.' },
      { title: 'What it means for the plan', mode: 'earth', at: 'earthNoteMs', dial: 'earth', lit: ['row:Earth in view'],
        text: 'Planned stay: Earth in view all {plannedEarthNum} hours. Two weeks later: {altEarthNum} hours. A relay satellite, or a different date, closes the gap.' },
    ],
  },
  {
    id: 'slip', title: 'What a two-week slip does', subtitle: '5 steps · the same site, a different month',
    steps: [
      { title: 'The plan', mode: 'both', at: 'landingMs', focus: 'win', lit: ['col:planned'],
        text: 'Land on {landingDay}, stay {stayDays} days: the Sun and Earth are both in view for {plannedBothNum} of {stayH} hours.' },
      { title: 'The same stay, two weeks later', mode: 'both', at: 'altLandingMs', focus: 'alt',
        text: 'Now the landing slips to {altLandingDay}. Same place, same {stayDays} days.' },
      { title: 'The Sun goes down', mode: 'both', at: 'altSunsetMs', play: { from: 'altLandingMs', to: 'altSunsetMs', end: 'pause' }, dial: 'sun', marks: ['altSunsetMs'], focus: 'alt', lit: ['row:Sunlit'],
        text: 'The Sun sets {altSunsetAfter} after landing. The longest dark lasts {altDarkWords}. Sunlit time drops from {plannedSun} to {altSun}.' },
      { title: 'Earth goes too', mode: 'both', at: 'earthsetMs', dial: 'earth', marks: ['earthsetMs', 'earthriseMs'], focus: 'alt', lit: ['row:Both in view'],
        text: 'Earth sets {earthsetAfterAlt} after landing and is gone until {earthriseDay}. Both together: {altBothNum} hours instead of {plannedBothNum}.' },
      { title: 'The way out', mode: 'both', at: 'altLandingMs', focus: 'alt', lit: ['verdict', 'wayout', 'set-alt'],
        text: 'The best landing in the four weeks after the slip is {wayOutDay}: {wayOutBothNum} hours with both in view. Press Set as alternative to compare it.' },
    ],
  },
];

// ---------- the figures, from the compute tier ----------
export async function storyFacts(run, scenario = STORY_SCENARIO) {
  const site = { site_id: scenario.siteId };
  const landingMs = Date.parse(scenario.landing);
  const altLandingMs = landingMs + scenario.slipDays * DAY_MS;
  const plannedEndMs = landingMs + scenario.stayDays * DAY_MS;
  const ask = async (name, input) => {
    const r = await run(name, input);
    if (!r || r.error) throw new Error(`${name}: ${r?.error ?? 'no result'}`);
    return r;
  };
  const cmp = await ask('compare_scenarios', { places: [site], landings: [iso(landingMs), iso(altLandingMs)], stay_days: scenario.stayDays });
  const atLanding = await ask('next_events', { ...site, at: iso(landingMs) });
  const plannedEvents = await ask('rise_set_events', { ...site, start: iso(landingMs), days: scenario.stayDays });
  const altEvents = await ask('rise_set_events', { ...site, start: iso(altLandingMs), days: scenario.stayDays });
  const skyline = await ask('skyline', { ...site, step_deg: 5 });
  const earthNoteMs = landingMs + EARTH_NOTE_DAYS * DAY_MS;
  const note = await ask('sky_at', { ...site, at: iso(earthNoteMs) });
  // Earth over the four weeks from landing, every 14 h (48 samples, the sky_at limit)
  const month = await ask('sky_at', { ...site, times: Array.from({ length: 48 }, (_, i) => iso(landingMs + i * 14 * H)) });
  const wayOut = await fetchWayOut(run, {
    site: { id: scenario.siteId }, altSite: { id: scenario.siteId }, landingMs, altLandingMs, stayDays: scenario.stayDays, slipDays: scenario.slipDays,
    altBothMs: cmp.scenarios[1].bothH * H,
  });

  const card = Object.fromEntries(cmp.scenarios[1].vsBaseline.card.map((r) => [r.label, r]));
  const sunrise = atLanding.sun.nextRise;
  const earthset = altEvents.events.find((e) => e.body === 'earth' && e.event === 'Earthset');
  const earthrise = altEvents.events.find((e) => e.body === 'earth' && e.event === 'Earthrise');
  const altSunset = altEvents.events.find((e) => e.body === 'sun' && e.event === 'Sunset');
  const t = (e) => (e ? Date.parse(e.time) : NaN);
  const sunriseMs = sunrise ? Date.parse(sunrise.time) : NaN;
  const f = {
    // instants (ms) for the step states
    landingMs, altLandingMs, plannedEndMs, midStayMs: landingMs + (scenario.stayDays / 2) * DAY_MS,
    sunriseMs, afterSunriseMs: sunriseMs + H, earthNoteMs,
    earthsetMs: t(earthset), earthriseMs: t(earthrise), altSunsetMs: t(altSunset),
    // texts
    stayDays: String(scenario.stayDays), stayH: String(Math.round(cmp.stayDays * 24)),
    landingDay: dayMonth(landingMs), altLandingDay: dayMonth(altLandingMs),
    plannedBoth: card['Both in view'].baseline, altBoth: card['Both in view'].scenario,
    plannedSun: card.Sunlit.baseline, altSun: card.Sunlit.scenario,
    plannedEarth: card['Earth in view'].baseline, altEarth: card['Earth in view'].scenario,
    plannedDark: card['Longest dark'].baseline, altDark: card['Longest dark'].scenario,
    peakSun: card['Peak Sun elevation'].baseline,
    sunElAtLanding: deg1(atLanding.sun.elDeg), hillsAtLanding: deg1(atLanding.sun.skylineDeg),
    sunriseTime: sunrise ? hhmm(sunriseMs) : '',
    earthAboveAtLanding: deg1(atLanding.earth.aboveSkylineDeg), earthDir: compass(atLanding.earth.azDeg),
    skylineMax: deg0(skyline.highest.elDeg), skylineMaxDir: compass(skyline.highest.azDeg),
    earthNoteDay: dayMonth(earthNoteMs), earthNoteAbove: deg0(note.earth.aboveSkylineDeg),
    earthsetDay: earthset ? dayMonth(t(earthset)) : '', earthsetTime: earthset ? hhmm(t(earthset)) : '',
    earthsetAfterPlanned: earthset ? spanWords(Math.round((t(earthset) - plannedEndMs) / H) * H) : '',
    earthsetAfterAlt: earthset ? spanWords(Math.round((t(earthset) - altLandingMs) / H) * H) : '',
    earthriseDay: earthrise ? dayMonth(t(earthrise)) : '', earthriseTime: earthrise ? hhmm(t(earthrise)) : '',
    earthGone: earthset && earthrise ? spanWords(t(earthrise) - t(earthset)) : '',
    altSunsetAfter: altSunset ? spanWords(t(altSunset) - altLandingMs) : '',
    altDarkWords: spanWords(cmp.scenarios[1].longestDarkH * H),
    // how far Earth wanders over the four weeks: the widest angle between two of its positions, up to the next 5°
    earthWander: `${Math.ceil(widestAngle(month.samples.map((x) => x.earth)) / 5) * 5}°`,
    wayOutDay: wayOut.none ? '' : dayMonthYear(wayOut.landingMs), wayOutBoth: wayOut.none ? '' : wayOut.bothText,
    // the raw results the premises read
    raw: { cmp, atLanding, plannedEvents, altEvents, skyline, note, month, wayOut },
  };
  for (const k of ['plannedBoth', 'altBoth', 'plannedSun', 'altSun', 'plannedEarth', 'altEarth', 'wayOutBoth']) f[`${k}Num`] = num(f[k]);
  return f;
}

// ---------- the premises: what each story's wording takes for granted ----------
export function storyPremises(f) {
  const r = f.raw;
  const sunEvents = r.plannedEvents.events.filter((e) => e.body === 'sun');
  const earthAz = r.month.samples.map((s) => s.earth.azDeg);
  const earthEl = r.month.samples.map((s) => s.earth.elDeg);
  const offNW = (az) => Math.abs(((az - 315 + 540) % 360) - 180);
  const p = (story, label, ok) => ({ story, label, ok: Boolean(ok) });
  const base = r.cmp.scenarios[0], alt = r.cmp.scenarios[1];
  return [
    // story 1
    p('sun', 'over the four weeks the Sun goes all round the horizon (no gap over 45° in azimuth) and stays under 7°', (() => {
      const az = r.month.samples.map((x) => x.sun.azDeg).filter(Number.isFinite).sort((a, b) => a - b);
      const gaps = az.map((a, i) => (i ? a - az[i - 1] : a + 360 - az[az.length - 1]));
      return az.length > 40 && Math.max(...gaps) < 45 && Math.max(...r.month.samples.map((x) => x.sun.elDeg)) < 7;
    })()),
    p('sun', 'the Sun stays low: peak under 7° ("about three fingers" at arm\'s length)', base.peakSunElDeg > 3 && base.peakSunElDeg < 7),
    p('sun', 'at landing the Sun is above the level horizon but under the skyline', r.atLanding.sun.elDeg > 0 && !r.atLanding.sun.visible && r.atLanding.sun.skylineDeg > r.atLanding.sun.elDeg),
    p('sun', 'the first sunrise is on the landing day ("that day")', Number.isFinite(f.sunriseMs) && new Date(f.sunriseMs).getUTCDate() === new Date(f.landingMs).getUTCDate() && f.sunriseMs - f.landingMs < DAY_MS),
    p('sun', 'the only Sun event of the stay is that sunrise ("mostly stays up", "the only long dark is the first day")', sunEvents.length === 1 && sunEvents[0].event === 'Sunrise' && Date.parse(sunEvents[0].time) === f.sunriseMs),
    p('sun', 'the longest dark is the first day', f.plannedDark === fmtSpan(f.sunriseMs - f.landingMs)),
    p('sun', 'the skyline is low (under 5°)', r.skyline.highest.elDeg < 5),
    // story 2
    p('earth', 'Earth is up at landing', r.atLanding.earth.visible && r.atLanding.earth.aboveSkylineDeg > 0),
    p('earth', 'Earth stays in the north-west over the four weeks (within 45° of north-west)', earthAz.every((az) => Number.isFinite(az) && offNW(az) <= 45) && f.earthDir === 'north-west'),
    p('earth', 'Earth keeps to one part of the sky over the four weeks (wanders under 30°, elevation never above 15°)', widestAngle(r.month.samples.map((x) => x.earth)) < 30 && Math.max(...earthEl) < 15),
    p('earth', 'Earth is above the skyline on the noted day', r.note.earth.visible),
    p('earth', 'Earth is in view for the whole planned stay ("all 336 hours")', base.earthH === base.stay.coveredH && f.plannedEarth === `${f.stayH} h`),
    p('earth', 'Earth sets after the planned stay ends, within a day', f.earthsetMs > f.plannedEndMs && f.earthsetMs - f.plannedEndMs < DAY_MS),
    p('earth', 'no Earthrise before it, and the next Earthrise is under six days later ("almost six days")', f.earthriseMs > f.earthsetMs && f.earthriseMs - f.earthsetMs < 6 * DAY_MS && f.earthriseMs - f.earthsetMs > 5 * DAY_MS
      && Date.parse(r.atLanding.earth.nextRise.time) === f.earthriseMs),
    p('earth', 'the slip is two weeks ("Two weeks later")', f.altLandingMs - f.landingMs === 14 * DAY_MS),
    // story 3
    p('slip', 'the Sun sets during the slipped stay, after Earth sets', f.altSunsetMs > f.altLandingMs && f.altSunsetMs < f.altLandingMs + 14 * DAY_MS && f.altSunsetMs > f.earthsetMs),
    p('slip', 'the slipped stay has less of everything (Sun, Earth, both)', alt.bothH < base.bothH && alt.sunH < base.sunH && alt.earthH < base.earthH),
    p('slip', 'Earth comes back before the slipped stay ends ("gone until")', f.earthriseMs < f.altLandingMs + 14 * DAY_MS),
    p('slip', 'a better landing exists in the four weeks after the slip', !r.wayOut.none && r.wayOut.bothH > alt.bothH),
    p('slip', 'that landing can be set as the alternative (slip within −60 to 60 days)', !r.wayOut.none && r.wayOut.slipDays !== null),
  ];
}

export function storyReady(f, id) {
  return storyPremises(f).filter((x) => x.story === id).every((x) => x.ok);
}

// ---------- templates ----------
export function fillText(template, f) {
  return template.replace(/\{(\w+)\}/g, (m, key) => {
    const v = f[key];
    if (v === undefined || v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) throw new Error(`story text: no figure for {${key}}`);
    return String(v);
  });
}

// ---------- one step's page state ----------
export function stepPlan(story, index, f, { reduced = false } = {}) {
  const step = story.steps[index];
  const ms = (key) => {
    const v = f[key];
    if (!Number.isFinite(v)) throw new Error(`story state: no instant for ${key}`);
    return v;
  };
  const play = step.play && !reduced ? { fromMs: ms(step.play.from), toMs: ms(step.play.to), end: step.play.end } : null;
  const body = (key) => (/earth/i.test(key) ? 'earth' : 'sun');
  return {
    story: story.id, index, count: story.steps.length,
    title: fillText(step.title, f), text: fillText(step.text, f),
    mode: step.mode ?? 'both', atMs: ms(step.at), play,
    dial: step.dial ?? null, focus: step.focus ?? null,
    marks: (step.marks ?? []).map((k) => ({ tMs: ms(k), body: body(k) })),
    lit: step.lit ?? [],
    // the time bar shows both windows, with two days either side
    viewRange: { startMs: f.landingMs - 2 * DAY_MS, endMs: f.altLandingMs + Number(f.stayDays) * DAY_MS + 2 * DAY_MS },
  };
}
