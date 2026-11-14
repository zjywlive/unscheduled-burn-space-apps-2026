// A scripted provider with the same respond() shape as a real model (phase 3 §4.10, §5.5). It matches
// the question against scripts, calls real commands one at a time, and builds its final answer only
// from the tool results it finds in the conversation, so every figure it states came from a command.
import { fmtDay } from '../format.js';

export const MOCK_SUGGESTIONS = [
  'Find flat, sunlit ground near Shackleton ridge',
  'Compare region A and region B',
  'Compare Shackleton ridge, IM-2 Athena and Haworth on 2027-01-13 and 2027-01-27',
  "Why can't I see the Earth or Sun now?",
  'What if the landing slips 7 days?',
  'Show the best 3 cells in this mode',
  // fix L6 (phase 4): the Route plan, Relay link and Energy cards
  'Plan a route from IM-2 Athena to Mons Mouton Plateau',
  'How many hours of relay link with the 12 h orbit?',
  'Will a 24 h battery last the stay?',
  'Give me a tour of the interface',
];

export const SUPPORTED_TEXT = 'This scripted demo answers ten kinds of question: flat, sunlit ground near a site; '
  + 'comparing region A and region B; comparing several sites or UTC dates; why the Earth or Sun is hidden now; what changes if the landing slips some days; '
  + 'the best cells in the current map mode; a rover route between two sites; relay link hours with an example orbit; '
  + 'whether the battery lasts the stay; and a tour of the interface. Try one of the suggestions.';

const DASH = '—';
const WORDS = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : DASH);
const num = (v, d = 0) => (Number.isFinite(v) ? (Math.round(v * 10 ** d) / 10 ** d).toFixed(d) : DASH);
const text = (t) => ({ content: [{ type: 'text', text: t }] });

// ---------- reading the conversation ----------
function lastQuestion(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && typeof messages[i].content === 'string') return { index: i, q: messages[i].content };
  }
  return { index: -1, q: '' };
}

function parseResult(content) {
  try { return JSON.parse(content); } catch { return { error: String(content) }; }
}

// Tool calls made since the question, in order, with their results.
function doneSince(messages, index) {
  const out = [];
  const byId = new Map();
  for (let i = index + 1; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') { const d = { id: b.id, name: b.name, input: b.input, result: undefined }; out.push(d); byId.set(b.id, d); }
      if (b.type === 'tool_result' && byId.has(b.tool_use_id)) byId.get(b.tool_use_id).result = parseResult(b.content);
    }
  }
  return out;
}

// ---------- matching ----------
const norm = (s) => String(s).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9.\- ]+/g, ' ');

// Site names mentioned in the question, in the order they appear.
export function namedSites(q, sites) {
  const t = norm(q);
  const found = [];
  for (const site of sites ?? []) {
    const name = norm(site.name);
    const keys = [name, norm(site.id).replace(/-/g, ' ')];
    const first = name.split(' ')[0];
    if (first.length >= 5 && (sites ?? []).filter((x) => norm(x.name).split(' ')[0] === first).length === 1) keys.push(first);
    let best = null;
    for (const k of keys) {
      const m = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).exec(t);
      if (m && (!best || m.index < best.at || (m.index === best.at && k.length > best.end - best.at))) best = { at: m.index, end: m.index + k.length };
    }
    if (best) found.push({ ...best, site });
  }
  // Longest name first where two start together ("Mons Mouton Plateau" over "Mons Mouton"); no overlaps.
  found.sort((a, b) => a.at - b.at || (b.end - b.at) - (a.end - a.at));
  const out = [];
  let end = -1;
  for (const f of found) if (f.at >= end) { out.push(f.site); end = f.end; }
  return out;
}

function slipDays(q) {
  const t = norm(q);
  // "earlier" and friends, or a minus sign before the number ("slip -7 days"), mean an earlier landing
  const sign = /\b(earlier|sooner|ahead|advance|brought forward|before)\b/.test(t) || /(^|[^a-z0-9])[-−]\s*\d/.test(String(q)) ? -1 : 1;
  const w = /\b(\d+|a|one|two|three|four|five|six|seven|eight)\s*weeks?\b/.exec(t);
  if (w) return sign * 7 * (WORDS[w[1]] ?? Number(w[1]));
  const d = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(days?|d)\b/.exec(t);
  if (d) return sign * (WORDS[d[1]] ?? Number(d[1]));
  const bare = /\b(slip|slips|delay|delayed|postpone|postponed|push|pushed|move|moved)\b[^0-9]*(\d+)/.exec(t);
  if (bare) return sign * Number(bare[2]);
  return null;
}

function countIn(q, fallback) {
  const t = norm(q);
  const a = /\b(top|best|first)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/.exec(t);
  const b = a ? null : /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(best|top)\b/.exec(t);
  const word = a ? a[2] : b ? b[1] : null;
  if (!word) return fallback;
  const v = WORDS[word] ?? Number(word);
  return Number.isFinite(v) ? Math.min(10, Math.max(1, v)) : fallback;
}

export function matchIntent(q) {
  const t = norm(q);
  if (/\b(sun|earth|sunrise|sunset|earthrise|earthset)\b/.test(t) && /\b(why|hidden|cant see|cannot see|not see|when|how long|how much operating time)\b/.test(t)) return 'visibility';
  if (/\b(tour|onboarding|walk me through|introduce|introduction|intro|how does (this|it) work|what is this|explain the (interface|screen|page)|show me around|get started)\b/.test(t)) return 'tour';
  // phase 4 (fix L6): before the older scripts, so "the sunniest route" or "a flat route" is a route
  if (/\b(route|routes|path|traverse|drive|rover)\b/.test(t)) return 'route';
  if (/\b(relay|orbiter|satellite|comms|communication|communications)\b/.test(t)) return 'relay';
  if (/\b(energy|power|battery|batteries|solar|panel|panels|charge|charging)\b/.test(t)) return 'energy';
  if (/\b(compare|comparison|versus|vs|difference between)\b/.test(t)) return 'compare';
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(t) && /\b(more time|which|better)\b/.test(t)) return 'compare';
  if (/\b(slip|slips|slipped|delay|delayed|postpone|postponed|push back|pushed back|later|earlier|what if the landing)\b/.test(t)) return 'slip';
  if (/\b(flat|level|gentle|smooth|low slope|shallow)\b/.test(t)) return 'flat';
  if (/\b(best|top|highest|optimal|ideal)\b/.test(t)) return 'best';
  return null;
}

// ---------- scripts ----------
// A plan is a list of [tool, input]; the script walks it one call per respond(), stops on an error,
// and writes the answer from the results once every step has run.
function walk(done, offset, plan, finish, onError) {
  for (let k = 0; k < plan.length; k++) {
    const d = done[offset + k];
    if (!d) return { call: plan[k] };
    if (d.result?.error) return onError ? onError(d, k) : text(`I couldn’t finish that: ${d.result.error}`);
  }
  return finish(done.slice(offset).map((d) => d.result));
}

function whereOf(site) {
  return site.id && site.id !== 'custom' ? { site_id: site.id } : { lat_deg: site.latDeg, lon_deg: site.lonDeg };
}

function siteLabel(st, site) {
  return site?.name ?? st.site?.name ?? 'the selected site';
}

// Deliberately small parser: explicit ISO UTC dates and hemisphere coordinates, otherwise the screen
// supplies the site and playhead. The core validates coverage/calendar dates and caps the batch.
const datesIn = (q) => [...new Set(String(q).match(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::00)?Z?)?/gi) ?? [])].map((d) => d.toUpperCase());
function coordinatesIn(q) {
  const m = /(-?\d+(?:\.\d+)?)\s*°?\s*([NS])\s*[,; ]+\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])\b/i.exec(q);
  return m ? { lat_deg: `${m[1]}${m[2]}`, lon_deg: `${m[3]}${m[4]}` } : null;
}

const SCRIPTS = {
  scenarios(q, st, done) {
    const named = namedSites(q, st.sites);
    const places = named.length ? named.map(whereOf) : [coordinatesIn(q) ?? whereOf(st.site)];
    const dates = datesIn(q);
    const landings = dates.length ? dates : [st.landing];
    if (places.length * landings.length < 2) return text('Name at least two sites or give two UTC dates, for example: Compare IM-2 Athena on 2027-01-13 and 2027-01-27.');
    const stay = /\b(\d+(?:\.\d+)?)\s*[- ]?days?\b/i.exec(q);
    const input = { places, landings, stay_days: stay ? Number(stay[1]) : st.stayDays };
    return walk(done, 1, [['compare_scenarios', input]], ([r]) => {
      const [first, second] = r.ranking.bothH.map((i) => r.scenarios[i]);
      const label = (s) => `${s.place.name}, landing ${s.landing} UTC`;
      const tie = first.bothH === second.bothH;
      return text(`${label(first)} ${tie ? 'ties for the most' : 'has the most'} time with Sun and Earth both in view across the supplied scenarios. `
        + `Both in view: ${num(first.bothH, 1)} h versus ${num(second.bothH, 1)} h at ${label(second)}; longest dark for the first option: ${num(first.longestDarkH, 1)} h. `
        + `Each scenario covers ${r.comparedDays} days${r.cut ? ', cut to the shortest available interval at the ephemeris end; not a full requested stay' : ''}. `
        + `${r.scenarios.some((s) => s.horizon === 'smooth') ? 'Some sites use a smooth horizon outside terrain coverage. ' : ''}This ranks simultaneous visibility, not landing safety. The map selection is unchanged.`);
    });
  },

  visibility(q, st, done) {
    const site = namedSites(q, st.sites)[0] ?? st.site;
    const dates = datesIn(q);
    if (dates.length > 1) return text('For a visibility explanation, ask about one UTC instant at a time. Use Compare for stays on several dates.');
    const input = { ...(coordinatesIn(q) ?? whereOf(site)), at: dates[0] ?? st.at ?? st.landing };
    return walk(done, 1, [['sky_at', input], ['next_events', input]], ([sky, next]) => {
      const t = norm(q), sun = /\bsun(?:rise|set)?\b/.test(t), earth = /\bearth(?:rise|set)?\b/.test(t);
      const bodies = sun && !earth ? ['sun'] : earth && !sun ? ['earth'] : ['sun', 'earth'];
      const verdict = bodies.map((b) => `${b === 'sun' ? 'The Sun' : 'Earth'} is ${sky[b].visible ? 'visible' : 'hidden'}`).join('; ');
      return text(`${verdict} at ${sky.place.name}, ${sky.at} UTC. ${bodies.map((b) => sky[b].why).join(' ')} `
        + `${next.headline}. ${sky.note ? `${sky.note} ` : ''}Visibility uses the body centre and the local skyline (the outline of surrounding terrain). No event before the coverage end does not mean never.`);
    });
  },

  flat(q, st, done) {
    const site = namedSites(q, st.sites)[0] ?? st.site;
    const where = whereOf(site);
    const plan = [
      ['zoom_to', { ...where, zoom: 6 }],
      ['set_filters', { max_slope_deg: 10 }],
      ['set_map_mode', { mode: 'sun' }],
      ['draw_region', { slot: 'A', type: 'circle', ...where, radius_km: 15 }],
      ['region_stats', { slot: 'A' }],
    ];
    return walk(done, 1, plan, ([, filters, , drawn, stats]) => {
      const name = siteLabel(st, site);
      if (!(stats.cells > 0)) return text(`Region A around ${name} is smaller than one grid cell. Zoom in or draw a larger one.`);
      const best = stats.best;
      const bestText = best && Number.isFinite(best.value)
        ? ` The best cell${best.coords ? `, at ${best.coords},` : ''} is sunlit ${pct(best.value)} of the stay.`
        : '';
      // the region figures use every active filter, not only the slope this script set
      const which = filters.maxDarkH == null ? `the ${num(filters.maxSlopeDeg)}° slope filter` : `the filters (slope up to ${num(filters.maxSlopeDeg)}°, longest dark up to ${num(filters.maxDarkH)} h)`;
      return text(`Within ${num(drawn.shape.rKm)} km of ${name}, ${pct(stats.pass)} of the ground passes ${which}. `
        + `Region A covers ${num(stats.areaKm2)} km² in ${num(stats.cells)} cells and is sunlit ${pct(stats.sun)} of the stay on average.${bestText} `
        + 'The map now shows Sunlit mode with the filter applied. Slopes are means over a 240 m grid; real lander-scale slopes are steeper.');
    });
  },

  compare(q, st, done) {
    const named = namedSites(q, st.sites).slice(0, 2);
    const plan = named.length === 2
      ? [
        ['draw_region', { slot: 'A', type: 'circle', site_id: named[0].id, radius_km: 10 }],
        ['draw_region', { slot: 'B', type: 'circle', site_id: named[1].id, radius_km: 10 }],
        ['region_stats', { slot: 'A' }],
        ['region_stats', { slot: 'B' }],
      ]
      : [['region_stats', { slot: 'A' }], ['region_stats', { slot: 'B' }]];
    const labels = named.length === 2 ? [named[0].name, named[1].name] : ['region A', 'region B'];
    return walk(done, 1, plan, (results) => {
      const [a, b] = results.slice(-2);
      const line = (label, r) => `${label[0].toUpperCase()}${label.slice(1)}: sunlit ${pct(r.sun)}, Earth in view ${pct(r.earth)}, both ${pct(r.both)} of the stay; ${pct(r.pass)} passes the filters.`;
      const diff = Number.isFinite(a.both) && Number.isFinite(b.both) ? Math.round((b.both - a.both) * 100) : null;
      const verdict = diff === null ? '' : diff === 0
        ? ' Both have the same share of time with Sun and Earth in view.'
        : ` With Sun and Earth both in view, ${labels[1]} is ${Math.abs(diff)} percentage points ${diff > 0 ? 'higher' : 'lower'} than ${labels[0]}.`;
      return text(`${line(labels[0], a)} ${line(labels[1], b)}${verdict}`);
    }, (d) => {
      if (d.name === 'region_stats') {
        return text(`Region ${d.input.slot} is empty. Draw regions A and B with the map tools, or name two sites, for example: Compare Shackleton ridge and Haworth.`);
      }
      return text(`I couldn’t finish that: ${d.result.error}`);
    });
  },

  slip(q, st, done) {
    const n = slipDays(q);
    if (n === null) return text('How many days? For example: What if the landing slips 7 days?');
    const plan = [['set_slip', { days: n }], ['set_map_mode', { mode: 'change' }], ['get_state', {}]];
    return walk(done, 1, plan, ([slip, , after]) => {
      const name = siteLabel(after);
      const when = `${Math.abs(slip.slipDays)} ${Math.abs(slip.slipDays) === 1 ? 'day' : 'days'} ${slip.slipDays < 0 ? 'earlier' : 'later'}`;
      const p = after.planned, s = after.slipped;
      if (!p || !s) {
        return text(`The alternative now lands ${when}, on ${fmtDay(Date.parse(slip.alternativeLanding))}. The map is in Change mode and shows where the slip gains or loses time with Sun and Earth both in view.`);
      }
      const diff = s.bothH - p.bothH;
      const change = Math.abs(diff) < 0.05 ? 'the same' : `${num(Math.abs(diff), 1)} h ${diff > 0 ? 'more' : 'less'}`;
      return text(`At ${name}, landing on ${fmtDay(Date.parse(after.landing))} gives ${num(p.bothH, 1)} h with Sun and Earth both in view over a ${num(p.stayH / 24, 1)}-day stay. `
        + `Landing ${when}, on ${fmtDay(Date.parse(slip.alternativeLanding))}, gives ${num(s.bothH, 1)} h: ${change}. `
        + 'The map is now in Change mode and shows where the slip gains or loses.');
    });
  },

  best(q, st, done) {
    const count = countIn(q, 3);
    const plan = ['now', 'change'].includes(st.mapMode) ? [['set_map_mode', { mode: 'both' }]] : [];
    plan.push(['best_cells', { count }]);
    return walk(done, 1, plan, (results) => {
      const r = results[results.length - 1];
      if (!r.cells.length) return text('The map is still computing. Ask again when the heat map has finished.');
      const items = r.cells.map((c, i) => `${i + 1}. ${c.coords}, ${r.valueKind === 'score' ? `score ${num(c.value, 2)}` : `${pct(c.value)} of the stay`}`);
      const switched = plan.length > 1 ? `I switched the map to ${r.label} mode, which ranks cells. ` : '';
      return text(`${switched}Best ${r.cells.length} ${r.cells.length === 1 ? 'cell' : 'cells'} in ${r.label} mode, after the filters: ${items.join('; ')}. They are marked on the map.`);
    });
  },

  // phase 4 (fix L6): a route between the sites named in the question (or from the selected site to the one
  // named), on the Route plan card; the slope limit from "under N°" or "N degrees" when given
  route(q, st, done) {
    const south = (x) => x && Number.isFinite(x.latDeg) && x.latDeg <= -80;
    const known = (st.sites ?? []).filter(south);
    let named = namedSites(q, known);
    if (named.length === 1 && st.site && south(st.site) && st.site.id !== named[0].id) named = [st.site, named[0]];
    if (named.length < 2) return text('Name two sites south of 80°S, for example: Plan a route from IM-2 Athena to Mons Mouton Plateau.');
    const pts = named.slice(0, 8).map((x) => [x.latDeg, x.lonDeg]);
    const m = /(\d+(?:\.\d+)?)\s*(?:°|deg|degrees?)/.exec(norm(q).replace(/°/g, ' deg'));
    const input = { points: pts, ...(m ? { max_slope_deg: Math.min(30, Math.max(5, Number(m[1]))) } : {}) };
    return walk(done, 1, [['plan_route', input]], ([r]) => {
      const one = (x) => (x.unavailable ? `${x.label}: ${x.unavailable}`
        : `${x.label} ${num(x.lengthKm, 1)} km, max slope ${num(x.maxSlopeDeg, 1)}°, mean ${num(x.meanSlopeDeg, 1)}°`
          + `${Number.isFinite(x.sunSharePct) ? `, sunlit ${num(x.sunSharePct)}%` : ''}${Number.isFinite(x.psrKm) ? `, ${num(x.psrKm, 1)} km in permanent shadow` : ''}`);
      return text(`From ${named[0].name} to ${named[named.length - 1].name}, under ${num(r.slopeLimitDeg)}° on the 240 m grid: ${r.routes.map(one).join('; ')}. `
        + 'The map now shows the three candidates with Shortest as the current route. Slopes on the 240 m grid are a sketch, not a trafficability check; no speed, time or energy is modelled.');
    }, (d) => text(`I couldn’t plan that route: ${d.result.error}`));
  },

  // the Relay link card with an example orbit (never a real mission's): 2 h circular, 24 h or the 12 h default
  relay(q, st, done) {
    const t = norm(q);
    const preset = /\b(2 ?h|two hour|circular|low)\b/.test(t) ? 'circular-2h' : /\b(24 ?h|24-hour|day)\b/.test(t) ? 'elliptical-24h' : 'elliptical-12h';
    return walk(done, 1, [['set_relay_orbit', { preset }]], ([r]) => {
      const p = r.planned;
      if (!p) return text('The Relay link card is open, but the stay has no figures yet.');
      return text(`With the example ${num(p.periodH, 1)} h orbit (two-body, illustrative, not a real mission), over the ${num(p.stayH)} h stay at ${siteLabel(st)}: `
        + `relay link ${num(p.relayH, 1)} h, longest relay gap ${num(p.longestRelayGapH, 1)} h; Earth direct ${num(p.earthDirectH, 1)} h; `
        + `direct or relay ${num(p.directOrRelayH, 1)} h, longest time with no link ${num(p.longestBlindH, 1)} h. The Relay link card is open with this orbit.`);
    });
  },

  // the Energy card: battery size from "N h battery", the panel from "fixed" or "horizontal"
  energy(q, st, done) {
    const t = norm(q);
    const b = /(\d+(?:\.\d+)?)\s*(?:h|hours?)\b[^.]*\bbatter/.exec(t) ?? /\bbatter\w*\D{0,20}(\d+(?:\.\d+)?)\s*(?:h|hours?)\b/.exec(t);
    const attitude = /\bfixed\b/.test(t) ? 'fixed' : /\b(horizontal|flat panel|lying flat)\b/.test(t) ? 'flat' : null;
    const input = { ...(b ? { battery_hours: Number(b[1]) } : {}), ...(attitude ? { attitude } : {}) };
    return walk(done, 1, [['get_energy', input]], ([r]) => {
      const p = r.planned;
      if (!p) return text('The Energy card is open, but the stay has no figures yet.');
      const a = r.assumptions ?? {};
      const lasts = Number.isFinite(p.atEmptyH) && p.atEmptyH <= 0;
      return text(`With a ${num(a.batteryHours)} h battery and panels rated ${num(a.panelToLoad, 1)}× the average load (assumed), at ${siteLabel(st)}: `
        + `${lasts ? 'the battery never runs empty' : `the battery is empty for ${num(p.atEmptyH, 1)} h`} over the stay; `
        + `the smallest battery that never runs empty is ${num(p.minBatteryH, 1)} h of load. Sunlit ${num(p.sunlitH)} h, charging ${num(p.chargingH)} h, asleep ${num(p.asleepH)} h. `
        + 'Relative units, every input an assumption. The Energy card is open.');
    });
  },

  tour(q, st, done) {
    return walk(done, 0, [['start_tour', {}]], () => text('The tour has started. It covers the map and its modes, hovering and picking, zoom, drawing regions, '
      + 'filters and weights, the landing date ribbon and this panel. Use the arrow keys to move between steps and Esc to leave it.'));
  },
};

export function createMockProvider() {
  let n = 0;
  return {
    name: 'mock',
    async respond({ messages, tools = [] }) {
      const { index, q } = lastQuestion(messages ?? []);
      let intent = matchIntent(q);
      // Preserve the regional script and old embedders; the integrated page compares points/dates
      // directly through core instead of drawing or selecting sites in a loop.
      if (intent === 'compare' && tools.some((t) => t.name === 'compare_scenarios') && !/\bregions?\b|\bA\s+(?:and|vs|versus)\s+B\b/i.test(q)) intent = 'scenarios';
      if (!intent) return text(SUPPORTED_TEXT);
      const done = doneSince(messages, index);
      let step;
      if (intent === 'tour') step = SCRIPTS.tour(q, null, done);
      else {
        const st = done[0]?.result;
        if (!st) step = { call: ['get_state', {}] };
        else if (st.error) step = text(`I couldn’t read the page state: ${st.error}`);
        else step = SCRIPTS[intent](q, st, done);
        // the ephemeris ends on 1 Jan 2029: a stay that runs past it is cut short, and the answer says so
        if (!['scenarios', 'visibility'].includes(intent) && !step.call && st?.clipped && step.content?.[0]?.type === 'text') {
          step = text(`${step.content[0].text} Note: the ephemeris ends on 1 Jan 2029, so this stay is cut to ${num(st.stayAvailableH)} h and the figures cover only that part.`);
        }
      }
      if (step.call) {
        n += 1;
        return { content: [{ type: 'tool_use', id: `toolu_mock_${n}`, name: step.call[0], input: step.call[1] }] };
      }
      return step;
    },
  };
}
