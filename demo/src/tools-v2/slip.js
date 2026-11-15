// Exact, single-place timeline tools (MCP v2 package A2): one 15-minute visibility scan per place,
// then pointMetrics + criteria.evaluate for each landing. Full stays must fit inside the ephemeris.
// slipTools(kit) → { specs, handlers }; browser-safe, read-only, deterministic for the same call sequence.
// Standard returns tables; full adds sample matrices. Brief holds the complete envelope in kit.refs
// under kind 'slip' or 'windows', so resolved inputs/assumptions remain available within a 1 KB summary.
import { resolveCriteria, evaluate, activeChecks, CRITERIA_SCHEMA } from '../criteria.js';
import { pointTimeline, pointMetrics, staticMetrics } from '../point-eval.js';

const DETAIL = { type: 'string', enum: ['brief', 'standard', 'full'] };
const STEP = { type: 'number', minimum: 1, maximum: 48, description: 'Landing sample step in hours; default 6.' };
const CONTINUOUS = ['both_continuous_h_min', 'sun_continuous_h_min', 'earth_continuous_h_min'];
const SOURCES = ['coarse', 'fine', 'psr', 'nasa', 'ice', 'dem240'];
const SCREEN = 'A first-look screen, not a certified landing analysis.';

// evaluate() rounds displayed margins; ordering and worst cases use the unrounded values instead.
function rawMargin(ch) {
  if (ch.value === null || typeof ch.value === 'boolean') return ch.pass ? Infinity : -Infinity;
  if (ch.kind === 'max') return ch.need - ch.value;
  if (ch.kind === 'min') return ch.value - ch.need;
  if (ch.kind === 'range') return Math.min(ch.value - (ch.need.min ?? -Infinity), (ch.need.max ?? Infinity) - ch.value);
  return ch.pass ? Infinity : -Infinity;
}
function relative(ch) {
  const scale = typeof ch.need === 'number' ? Math.max(1, Math.abs(ch.need)) : Math.max(1, Math.abs(ch.need?.max ?? ch.need?.min ?? 1));
  return rawMargin(ch) / scale;
}
function judged(criteria, metrics, definitions) {
  const result = evaluate(criteria, metrics);
  return { ...result, checks: result.checks.map((ch, i) => ({ ...ch, kind: definitions[i].kind })) };
}
function tightest(checks) {
  return checks.reduce((best, ch) => best === null || relative(ch) < relative(best) ? ch : best, null);
}
function commonFailure(results, definitions) {
  const counts = new Map(definitions.map((ch) => [ch.id, 0]));
  for (const r of results) for (const ch of r.checks) if (!ch.pass) counts.set(ch.id, counts.get(ch.id) + 1);
  let best = null, count = 0;
  for (const [id, n] of counts) if (n > count) { best = id; count = n; }
  return best;
}
function ticks(from, to, step, includeEnd = false) {
  const out = [];
  for (let i = 0; from + i * step <= to; i++) out.push(from + i * step);
  if (includeEnd && out.at(-1) < to) out.push(to);
  return out;
}
const placeKey = (place) => place.id === 'custom' ? `${place.id}@${place.latDeg},${place.lonDeg}` : place.id;

export function slipTools(kit) {
  const { ctx, eph, HOUR_MS: H, DAY_MS: D, round, err, schema } = kit;
  const utc = (ms) => ms % 60000 === 0 ? kit.iso(ms) : new Date(ms).toISOString();
  const briefIds = new Map();
  const specs = [
    {
      name: 'check_slip_robustness',
      description: 'Check which places satisfy all criteria at every sampled slip of a planned landing. Defaults to curated terrain sites, slip 0–7 days every 6 hours, and lander_dte criteria. Reports worst checks, first failures and measured relaxations; full adds the matrix.',
      schema: schema.obj({
        places: { type: 'array', minItems: 1, maxItems: 24, items: schema.PLACE_OBJ },
        landing: schema.LANDING,
        slip: schema.obj({ from_days: { type: 'number', minimum: 0, maximum: 30 }, to_days: { type: 'number', minimum: 0, maximum: 30 }, step_h: STEP }),
        criteria: CRITERIA_SCHEMA, detail: DETAIL,
      }, ['landing']),
    },
    {
      name: 'landing_windows',
      description: 'Find sampled landing windows at one place satisfying all criteria, including battery-limited darkness. Defaults to the full ephemeris minus one stay, 6-hour steps and lander_dte criteria. Locates a planned landing and its sampled slip budget; full returns all windows and samples.',
      schema: schema.obj({
        ...schema.PLACE, criteria: CRITERIA_SCHEMA, from: schema.LANDING, to: schema.LANDING,
        step_h: STEP, min_window_days: { type: 'number', minimum: 0, maximum: 800 },
        planned: schema.LANDING, detail: DETAIL,
      }),
    },
  ];

  function criteriaFor(input) {
    const resolved = resolveCriteria(input.criteria ?? { preset: 'lander_dte' });
    if (resolved.error) return resolved;
    if (input.criteria === undefined) resolved.assumed.push('No criteria supplied: default preset lander_dte.');
    let fromMs = null;
    if (resolved.criteria.continuous_from === 'from_time') {
      const t = kit.parseInstant(resolved.criteria.from_time, 'criteria.from_time');
      if (t.error) return t;
      fromMs = t.ms;
      resolved.criteria.from_time = utc(t.ms);
    }
    return { ...resolved, fromMs, stayMs: resolved.criteria.stay_days * D, definitions: activeChecks(resolved.criteria) };
  }
  async function sourcesFor() {
    const values = await Promise.all(SOURCES.map((name) => kit.provided(ctx[name])));
    return Object.fromEntries(SOURCES.map((name, i) => [name, values[i]]));
  }
  function prepare(p, sources, resolved, start, end) {
    const horizon = kit.horizonOf(p.site);
    return { ...p, horizon, ground: staticMetrics(sources, p.site, resolved.criteria), timeline: pointTimeline(eph, p.site, horizon.mask, start, end) };
  }
  function metricsAt(p, t, resolved, criteria = resolved.criteria) {
    return { ...p.ground, ...pointMetrics(p.timeline, t, resolved.stayMs, {
      continuous_from: criteria.continuous_from, fromMs: resolved.fromMs, eph,
      peaks: criteria.sun_elevation_min_deg != null || criteria.earth_elevation_min_deg != null,
    }) };
  }
  function dataNotes(prepared, assumed) {
    const notes = new Set();
    for (const p of prepared) {
      if (p.horizon.note) notes.add(`${p.place.name}: ${p.horizon.note}`);
      if (p.ground.ice_source === 'psr_proxy') notes.add('Ice data unavailable: PSR proximity is a proxy, not thermal stability or a detection of ice.');
    }
    assumed.push(...notes);
    return [...notes];
  }
  function about(step, notes, windows = false) {
    return kit.about({
      units: { '*_h': 'hours', '*_days': 'days', '*_deg': 'degrees', '*_km': 'km', pass_share: '0–1', times: 'UTC', margin: 'value units; positive passes' },
      resolution: { scan: kit.conv.SCAN_RES, landings: `${step} h`, peaks: 'Elevation maxima, when requested: 1 h samples.', ground: 'Slope: selected 2 km / 1 km cell mean or 240 m point; PSR proximity: finest loaded 1 km / 2 km grid.' },
      conventions: [kit.conv.VISIBLE_CONV, 'Hours, degrees and km rounded to 0.1; decisions use raw values. Coordinates retain PLACE precision.',
        'Only complete stays inside the ephemeris are evaluated; unavailable metrics fail checks.',
        'Ranking and worst checks compare margin / max(1, absolute threshold); ties retain input order.',
        ...(windows ? ['Window close is the last passing sampled landing, not the end of its stay; length = close − open. Window indices are zero-based.'] : ['Each failed check counts once per sampled landing when choosing the commonest failing check.', 'Feasibility: no survivors = infeasible; one = thin; two or more = ok.'])],
      limits: [SCREEN, ...notes, windows ? `Window edges lie within one step_h (${step} h) of the reported sampled edges; scan-boundary windows may extend beyond the query. Passing samples do not guarantee unsampled landings pass.` : `Slip robustness covers sampled landings, not every instant between them; the requested last offset is also checked if off the ${step} h grid.`],
    });
  }
  function number(ch, value) {
    return typeof value === 'number' ? round(value, ch.id.startsWith('nasa_') ? 4 : 1) : value;
  }
  function checkOut(ch) {
    return {
      value: number(ch, ch.value), margin: number(ch, Number.isFinite(rawMargin(ch)) ? rawMargin(ch) : null),
      at_slip_h: round(ch.slip_h, 1), ...(ch.unavailable ? { unavailable: true } : {}), ...(ch.beyond ? { beyond: true } : {}),
    };
  }
  function brief(out, numbers, kind) {
    // Mandatory full inputs/assumptions can exceed 1 KB on their own (24 places and arbitrary criteria).
    // Keep them intact in the existing reference store rather than silently dropping assumptions.
    const key = JSON.stringify(out);
    let id = briefIds.get(key);
    if (!id || !kit.refs.get(kind, id)) {
      id = kit.refs.put(kind, out, { prefix: kind === 'slip' ? 'sl' : 'lw' });
      if (briefIds.size >= 32) briefIds.delete(briefIds.keys().next().value);
      briefIds.set(key, id);
    }
    const fullAbout = out.about;
    const summary = kit.withAbout({
      query_echo: { detail: 'brief', resolved_in: id },
      // assumptions must always be named (DESIGN §2): a shortened list here, the full one in refs
      assumed: (out.assumed ?? []).filter((a) => typeof a === 'string' && !a.startsWith('preset ')).map((a) => (a.length > 80 ? `${a.slice(0, 77)}...` : a)),
      ...numbers, headline: out.headline.length > 220 ? `${out.headline.slice(0, 217)}...` : out.headline,
      refs: { kind, id },
    }, {
      units: { hours: 'h', shares: '0–1' },
      resolution: { scan: '15 min; crossings 1 min; DE441 / LOLA', landings: fullAbout.resolution.landings },
      conventions: ['Sampled landings; full stays only.'],
      limits: [SCREEN, 'Full data notes, horizon model and sampling limits are held in refs.'],
    });
    // Place/mission names may be Unicode: the budget is UTF-8 bytes, not JavaScript string length.
    const encoder = new TextEncoder();
    while (encoder.encode(JSON.stringify(summary)).length > 1024 && summary.assumed.length > 2) summary.assumed.pop();
    const headline = Array.from(summary.headline);
    while (encoder.encode(JSON.stringify(summary)).length > 1024 && headline.length) {
      headline.pop();
      summary.headline = `${headline.join('')}...`;
    }
    return summary;
  }

  // A single threshold change, rounded outwards so replaying it cannot become stricter than the data.
  function relaxThreshold(criteria, definition, checks) {
    if (checks.some((ch) => ch.unavailable || ch.beyond)) return null;
    const { id, kind } = definition;
    const values = checks.map((ch) => ch.value);
    const factor = id.startsWith('nasa_') ? 1e4 : 10;
    const lo = Math.floor(Math.min(...values) * factor) / factor;
    const hi = Math.ceil(Math.max(...values) * factor) / factor;
    if (kind === 'bool') return { [id]: id === 'inside_psr' ? null : false };
    if (kind === 'range') return { [id]: { min: criteria[id].min == null ? null : Math.min(criteria[id].min, lo), max: criteria[id].max == null ? null : Math.max(criteria[id].max, hi) } };
    if (id === 'ice') return hi <= CRITERIA_SCHEMA.properties.ice.properties.within_km.maximum ? { ice: { ...criteria.ice, within_km: hi } } : null;
    const value = kind === 'max' ? hi : lo;
    const bounds = CRITERIA_SCHEMA.properties[id];
    // Do not advertise a threshold that the public input schema would reject on replay.
    if (value < (bounds.minimum ?? -Infinity) || value > (bounds.maximum ?? Infinity)) return null;
    return { [id]: value };
  }
  function feasibility(rows, prepared, resolved, offsets, slip, landing) {
    const { criteria, definitions } = resolved;
    const survivors = rows.filter((r) => r.results.every((e) => e.pass));
    const binding = commonFailure(rows.flatMap((r) => r.results), definitions);
    const status = survivors.length === 0 ? 'infeasible' : survivors.length === 1 ? 'thin' : 'ok';
    const ranked = [...rows].sort((a, b) => b.score - a.score || a.index - b.index);
    const best = ranked.find((r) => r.results.every((e) => e.checks.every((ch) => ch.id === binding || ch.pass))) ?? ranked[0];
    const definition = definitions.find((ch) => ch.id === binding);
    const bindingBest = binding ? rows.reduce((a, b) => !a || relative(b.worst[binding]) > relative(a.worst[binding]) ? b : a, null) : null;
    const maxAchievable = bindingBest ? { check: binding, value: number(bindingBest.worst[binding], bindingBest.worst[binding].value), place: placeKey(bindingBest.place), at_slip_h: round(bindingBest.worst[binding].slip_h, 1) } : null;
    let why = `${survivors.length} of ${rows.length} places pass all ${offsets.length} sampled landings${binding ? `; the commonest failing check is ${binding}` : ''}.`;
    const relaxations = [];
    let maxTo = null;
    for (const row of rows) {
      let last = null;
      for (let i = 0; i < row.results.length && row.results[i].pass; i++) last = offsets[i] / 24;
      if (last !== null) maxTo = maxTo === null ? last : Math.max(maxTo, last);
    }
    if (maxTo !== null && maxTo < slip.to_days) {
      const n = rows.filter((r) => r.results.every((e, i) => offsets[i] > maxTo * 24 || e.pass)).length;
      relaxations.push({ change: { slip: { ...slip, to_days: maxTo } }, unlocks: n, note: 'Largest tested endpoint with a passing prefix; no interpolation between slip samples.' });
    }
    if (definition && best && !best.worst[binding].pass) {
      const change = relaxThreshold(criteria, definition, best.results.map((e) => e.checks.find((ch) => ch.id === binding)));
      if (change) {
        const c = { ...criteria, ...change };
        const n = rows.filter((r) => r.metrics.every((m) => evaluate(c, m).pass)).length;
        relaxations.push({ change: { criteria: change }, for_place: placeKey(best.place), unlocks: n, note: n ? 'Only this threshold changed; all other checks re-evaluated.' : 'This threshold alone is insufficient; other checks still fail.' });
      }
    }
    if (CONTINUOUS.includes(binding)) {
      const c = { ...criteria, continuous_from: 'within_stay' };
      if (criteria.continuous_from !== 'within_stay') {
        const n = prepared.filter((p) => offsets.every((s) => evaluate(c, metricsAt(p, landing + s * H, resolved, c)).pass)).length;
        relaxations.push({ change: { criteria: { continuous_from: 'within_stay' } }, unlocks: n, note: 'Same stay length; all checks re-evaluated on the existing timelines.' });
      }
      if (criteria.continuous_from === 'from_landing') {
        const body = binding.split('_')[0];
        const runs = prepared.map((p) => {
          const run = p.timeline[body].find(([a, b]) => a <= landing && landing < b);
          return { place: placeKey(p.place), h: run ? (run[1] - landing) / H : 0, lower_bound: run?.[1] === p.timeline.endMs };
        });
        const longest = runs.reduce((a, b) => !a || b.h > a.h ? b : a, null);
        const need = criteria[binding], delay = offsets.at(-1);
        why += ` Within the same unbroken run, each hour of slip shortens the run from touchdown by an hour (the hour-for-hour rule): ${need} h + ${round(delay, 1)} h slip requires at least ${round(need + delay, 1)} h of unbroken ${body} visibility from the planned landing; the longest observed here is ${round(longest.h, 1)} h at ${longest.place}${longest.lower_bound ? ' (scan-limited lower bound)' : ''}. Later separate visibility runs do not extend that run; sample checks also apply the stay-length cap.`;
        maxAchievable.planned_unbroken_h = round(longest.h, 1);
        maxAchievable.planned_unbroken_place = longest.place;
        maxAchievable.planned_run_lower_bound = longest.lower_bound;
      }
    }
    return { status, binding, why, max_achievable: maxAchievable, max_surviving_to_days: maxTo, relaxations };
  }

  async function checkSlip(input) {
    const resolved = criteriaFor(input);
    if (resolved.error) return err(resolved.error);
    const l = kit.parseLanding(input.landing, 'landing');
    if (l.error) return err(l.error);
    const detail = input.detail ?? 'standard';
    const slip = { from_days: input.slip?.from_days ?? 0, to_days: input.slip?.to_days ?? 7, step_h: input.slip?.step_h ?? 6 };
    if (slip.from_days > slip.to_days) return err('slip.from_days must not exceed slip.to_days.');
    const end = l.ms + slip.to_days * D + resolved.stayMs;
    if (end > eph.endMs) return err('Every slipped landing needs a complete stay inside the ephemeris; reduce slip.to_days or criteria.stay_days, or use an earlier landing.');
    const places = input.places ?? ctx.sites.filter((s) => s.latDeg <= -80).map((s) => ({ site_id: s.id }));
    if (!places.length) return err('No curated terrain sites are available; supply places explicitly.');
    const locations = places.map((p) => kit.resolvePlace(p));
    const invalid = locations.find((p) => p.error);
    if (invalid) return err(invalid.error);
    const assumed = [...resolved.assumed];
    if (input.places === undefined) assumed.push('Places default to every curated site at or south of 80°S.');
    assumed.push(`Slip sampled from ${slip.from_days} to ${slip.to_days} days every ${slip.step_h} h, including the final endpoint.`);
    const offsets = ticks(slip.from_days * 24, slip.to_days * 24, slip.step_h, true);
    const sources = await sourcesFor();
    const scans = new Map();
    const prepared = locations.map((p) => {
      const key = `${p.site.latDeg},${p.site.lonDeg}`;
      if (!scans.has(key)) scans.set(key, prepare(p, sources, resolved, l.ms, end));
      return { ...scans.get(key), ...p };
    });
    const notes = dataNotes(prepared, assumed);
    const rows = prepared.map((p, index) => {
      const metrics = offsets.map((s) => metricsAt(p, l.ms + s * H, resolved));
      const results = metrics.map((m) => judged(resolved.criteria, m, resolved.definitions));
      const worst = {};
      for (let i = 0; i < results.length; i++) for (const ch of results[i].checks) {
        if (!worst[ch.id] || relative(ch) < relative(worst[ch.id])) worst[ch.id] = { ...ch, slip_h: offsets[i] };
      }
      return { ...p, index, metrics, results, worst, score: tightest(Object.values(worst)) ? relative(tightest(Object.values(worst))) : Infinity };
    });
    const outputRows = rows.map((r) => {
      const first = r.results.findIndex((e) => !e.pass);
      const failure = first < 0 ? null : r.results[first].checks.find((ch) => ch.id === r.results[first].limiting);
      return {
        place: r.place, horizon: r.horizon.terrain ? 'terrain' : 'smooth', note: r.horizon.note,
        passes_at_planned: r.results[0].pass, evaluated_at_slip_h: round(offsets[0], 1),
        survives_all: first < 0, pass_share: round(r.results.filter((e) => e.pass).length / offsets.length, 4),
        first_fail: failure ? { slip_h: round(offsets[first], 1), landing: utc(l.ms + offsets[first] * H), check: failure.id, value: number(failure, failure.value), need: failure.need, ...(failure.unavailable ? { unavailable: true } : {}), ...(failure.beyond ? { beyond: true } : {}) } : null,
        worst: Object.fromEntries(Object.entries(r.worst).map(([id, ch]) => [id, checkOut(ch)])),
        limiting: commonFailure(r.results, resolved.definitions),
        ...(detail === 'full' ? { matrix: r.results.map((e, i) => ({ slip_h: round(offsets[i], 1), landing: utc(l.ms + offsets[i] * H), pass: e.pass, limiting: e.limiting })) } : {}),
      };
    });
    const survivors = rows.filter((r) => r.results.every((e) => e.pass)).map((r) => placeKey(r.place));
    const ranked = [...rows].sort((a, b) => b.score - a.score || a.index - b.index);
    const feasible = feasibility(rows, prepared, resolved, offsets, slip, l.ms);
    const out = kit.withAbout({
      query_echo: { places: locations.map((p) => p.place), landing: utc(l.ms), slip, criteria: resolved.criteria, detail }, assumed,
      rows: outputRows, survivors,
      ranking: ranked.map((r) => ({ place: placeKey(r.place), row_index: r.index, worst_relative_margin: round(r.score, 4) })),
      feasibility: feasible, samples_per_place: offsets.length,
      headline: `${survivors.length} of ${rows.length} places satisfy all criteria at every sampled slip from ${slip.from_days} to ${slip.to_days} days.`,
    }, about(slip.step_h, notes));
    return detail === 'brief' ? brief(out, { place_count: rows.length, survivor_count: survivors.length, samples_per_place: offsets.length, max_surviving_slip_h: feasible.max_surviving_to_days === null ? null : round(feasible.max_surviving_to_days * 24, 1) }, 'slip') : out;
  }

  async function landingWindows(input) {
    const resolved = criteriaFor(input);
    if (resolved.error) return err(resolved.error);
    const p = kit.resolvePlace(input);
    if (p.error) return err(p.error);
    const detail = input.detail ?? 'standard', step = input.step_h ?? 6, minDays = input.min_window_days ?? 7;
    const from = input.from === undefined ? { ms: eph.startMs } : kit.parseLanding(input.from, 'from');
    const to = input.to === undefined ? { ms: Math.floor((eph.endMs - resolved.stayMs) / H) * H } : kit.parseLanding(input.to, 'to');
    if (from.error || to.error) return err(from.error ?? to.error);
    if (to.ms < from.ms) return err('from must not be after to.');
    if (to.ms - from.ms > 800 * D) return err('The landing range must be at most 800 days.');
    if (to.ms + resolved.stayMs > eph.endMs) return err('Every landing needs a complete stay inside the ephemeris; use an earlier to or reduce criteria.stay_days.');
    const planned = input.planned === undefined ? null : kit.parseLanding(input.planned, 'planned');
    if (planned?.error) return err(planned.error);
    const sources = await sourcesFor();
    const prepared = prepare(p, sources, resolved, from.ms, to.ms + resolved.stayMs);
    const assumed = [...resolved.assumed, `A robust window spans at least ${minDays} days of sampled landing times; landing step ${step} h.`];
    if (input.from === undefined || input.to === undefined) assumed.push('Unspecified range endpoints use the ephemeris start and last whole-hour landing with a complete stay.');
    const notes = dataNotes([prepared], assumed);
    const times = ticks(from.ms, to.ms, step * H);
    const windows = [], matrix = [];
    let current = null;
    for (const t of times) {
      const e = judged(resolved.criteria, metricsAt(prepared, t, resolved), resolved.definitions);
      if (detail === 'full') matrix.push({ landing: utc(t), pass: e.pass, limiting: e.limiting });
      if (!e.pass) { current = null; continue; }
      const worst = tightest(e.checks);
      if (!current) { current = { open: t, close: t, landings: 0, worst, score: worst ? relative(worst) : Infinity }; windows.push(current); }
      current.close = t;
      current.landings++;
      if (worst && relative(worst) < current.score) { current.worst = worst; current.score = relative(worst); }
    }
    const outputWindows = windows.map((w, index) => ({
      window_index: index, open: utc(w.open), close: utc(w.close), length_h: round((w.close - w.open) / H, 1), landings: w.landings,
      worst_check: w.worst ? { id: w.worst.id, margin: number(w.worst, Number.isFinite(rawMargin(w.worst)) ? rawMargin(w.worst) : null) } : null,
    }));
    const robust = windows.map((w, i) => w.close - w.open >= minDays * D ? outputWindows[i] : null).filter(Boolean);
    const best = windows.reduce((idx, w, i) => idx < 0 || w.score > windows[idx].score ? i : idx, -1);
    let located = null;
    if (planned) {
      let index = windows.findIndex((w) => planned.ms >= w.open && planned.ms <= w.close);
      // A planned time between sample ticks can cross a short failure; explicitly re-check it.
      if (index >= 0 && !evaluate(resolved.criteria, metricsAt(prepared, planned.ms, resolved)).pass) index = -1;
      located = {
        landing: utc(planned.ms), inside: index >= 0, window_index: index >= 0 ? index : null,
        hours_since_open: index >= 0 ? round((planned.ms - windows[index].open) / H, 1) : null,
        slip_budget_h: index >= 0 ? round((windows[index].close - planned.ms) / H, 1) : null,
        next_open: index >= 0 ? null : utcOrNull(windows.find((w) => w.open > planned.ms)?.open),
      };
    }
    const longest = windows.reduce((a, w) => !a || w.close - w.open > a.close - a.open ? w : a, null);
    const duration = longest ? `, the longest ${round((longest.close - longest.open) / D, 1)} d (${kit.dateText(longest.open)}–${kit.dateText(longest.close)})` : '';
    const plannedText = !located ? '' : located.inside ? `; the planned landing has ${located.slip_budget_h} h of sampled slip budget` : '; the planned landing is outside the passing sampled windows';
    const out = kit.withAbout({
      query_echo: { place: p.place, criteria: resolved.criteria, from: utc(from.ms), to: utc(to.ms), step_h: step, min_window_days: minDays, planned: planned ? utc(planned.ms) : null, detail },
      assumed, place: p.place, horizon: prepared.horizon.terrain ? 'terrain' : 'smooth', note: prepared.horizon.note,
      windows: detail === 'full' ? outputWindows : outputWindows.slice(0, 20), window_count: windows.length,
      robust_windows: detail === 'full' ? robust : robust.slice(0, 20), robust_window_count: robust.length,
      best: best < 0 ? null : outputWindows[best], planned: located,
      samples: times.length, sampled_through: utc(times.at(-1)), windows_truncated: detail !== 'full' && windows.length > 20,
      ...(detail === 'full' ? { matrix } : {}),
      headline: `${p.place.name}: ${windows.length} landing windows from ${kit.dateText(from.ms)} to ${kit.dateText(to.ms)}${duration}${plannedText}.`,
    }, about(step, notes, true));
    return detail === 'brief' ? brief(out, { window_count: windows.length, robust_window_count: robust.length, longest_window_h: longest ? round((longest.close - longest.open) / H, 1) : 0, slip_budget_h: located?.slip_budget_h ?? null }, 'windows') : out;
  }
  function utcOrNull(ms) { return ms === undefined ? null : utc(ms); }

  return { specs, handlers: { check_slip_robustness: checkSlip, landing_windows: landingWindows } };
}
