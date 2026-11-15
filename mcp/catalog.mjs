// MCP prompts and resources for v2 (docs/mcp-v2/DESIGN.md §7). Prompts are slash-command templates for the
// three audiences of the challenge (planners, educators, the public), in the voices the page assistant already
// uses (demo/src/agent/system-prompt.js AUDIENCES). Resources expose the reference material and the results the
// server holds (searches and missions, tools-v2/refs.js) as CSV, GeoJSON and JSON. Node built-ins only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AUDIENCES } from '../demo/src/agent/system-prompt.js';
import { PRESETS, CRITERIA_SCHEMA, CHECK_IDS } from '../demo/src/criteria.js';
import { readSites } from './navigator.mjs';

const repo = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
// The standalone MCP package (tools/package-mcp.mjs) carries only what the server imports and the data packs,
// so README.md and the guide may be absent there: say so instead of failing.
const readRepo = (rel) => { try { return readFileSync(repo(rel), 'utf8'); } catch { return null; } };
const ASSUME = 'Name every assumption the tools list in assumed[] or mark as assumed (slope limit, battery hours, ice = thermal stability not detection, orbits). Every number must come from a tool result in this conversation. Results are a first-look screen, not a certified landing analysis.';
const LINK = 'End with an open_in_navigator link so the user can see the map.';

const arg = (name, description, required = false) => ({ name, description, required });
export const PROMPTS = [
  {
    name: 'plan_landing_site', title: 'Plan a landing site', audience: 'planner',
    description: 'Planner: find landing sites (and a route to the science target) that meet stated requirements, e.g. flat, Sun and Earth in view 300 h, near a PSR, possible ice.',
    arguments: [arg('requirements', 'What the site must offer, in your own words.', true), arg('region', 'Where to look, e.g. "within 30 km of Shackleton" (default: the whole south-polar cap).'), arg('date', 'Landing date or window, UTC (default: any date in 2026-11 to 2029-01).')],
    steps: (a) => [
      `Requirements: "${a.requirements}".${a.region ? ` Region: ${a.region}.` : ''}${a.date ? ` Landing: ${a.date}.` : ' No landing date given: search any date and say so.'}`,
      'Translate each requirement into a criteria field (lsn://criteria/presets lists fields and presets) and state your reading of vague words before the results: flat = 2 km mean slope ≤ 5°; "continuously N hours" = an unbroken run counted from touchdown (continuous_from from_landing) unless the user says otherwise; near a permanently shadowed region = outside it and within 5 km; possible water ice = a thermally stable shallow-ice target within reach of a rover, not detected ice.',
      'Call find_landing_sites with those criteria (count 5). If the user gave a delay tolerance, add slip.',
      'If feasibility.status is infeasible or thin, lead with feasibility.binding, the best achievable value (max_achievable) and the cheapest relaxation from feasibility.relaxations, and offer to rerun with it.',
      'For the best candidate, sketch the traverse to its science_target: route_candidates with points [{ "candidate": "S1" }, { "lat_deg": …, "lon_deg": … } of the target], landing = its landing, and report length, maximum slope and km inside permanent shadow.',
      'Answer: recommendation → a table of candidates (ref, coordinates, continuous Sun+Earth hours, slope, PSR km, ice target km, landing) → the route summary → assumptions → link.',
    ],
  },
  {
    name: 'respond_to_slip', title: 'Respond to a launch slip', audience: 'planner',
    description: 'Planner: the landing moved. Is the site still good, how much slip does the new date tolerate, and what nearby alternatives work?',
    arguments: [arg('site', 'Site id, name or coordinates.', true), arg('original_date', 'Planned landing, UTC.', true), arg('new_date', 'New landing, UTC.', true)],
    steps: (a) => [
      `Site ${a.site}: landing moved from ${a.original_date} to ${a.new_date}.`,
      'compare_scenarios for the site at both dates (same stay); report what changed (Sun, Earth, both, longest dark).',
      'landing_windows for the site with planned = the new date: is it inside a window, and how many hours of further slip it tolerates (slip_budget_h).',
      'If the new date fails, find_landing_sites with region within 30 km of the site and landing = the new date, and check_slip_robustness for the best two alternatives.',
      'Answer with the decision first (keep, move date, move site), then the figures.',
    ],
  },
  {
    name: 'check_my_mission', title: 'Check my mission plan', audience: 'planner',
    description: 'Planner: load a mission exported from the page (file path, pasted JSON or share link) and report light and Earth visibility at every point, risks first.',
    arguments: [arg('source', 'Path to the exported mission JSON or GeoJSON, or a page share link.', true), arg('points', 'Points to check, e.g. "W2, W4" (default: all).')],
    steps: (a) => [
      `mission_open with source ${/^https?:|#/.test(a.source) ? `{ "url": ${JSON.stringify(a.source)} }` : `{ "path": ${JSON.stringify(a.source)} }`}.`,
      `mission_conditions with points ${a.points ? JSON.stringify(a.points.split(/[,\s]+/).filter(Boolean)) : '"all"'}.`,
      'If mission_check is available, run it with slip_days [1, 3, 7].',
      'Answer: risks first (sorted by severity), then a table per point (planned arrival, Sun and Earth on arrival, time to sunset and Earthset), then what the export did not contain (notes).',
    ],
  },
  {
    name: 'build_lesson', title: 'Build a lesson with real data', audience: 'educator',
    description: 'Educator: a lesson on a lunar south-pole topic with real numbers, two contrasting places, questions and answers that can be recomputed.',
    arguments: [arg('topic', 'e.g. "why the Sun stays low at the lunar south pole".', true), arg('grade', 'Class level, e.g. "age 15".'), arg('minutes', 'Lesson length in minutes (default 40).')],
    steps: (a) => [
      `Topic: ${a.topic}. Class: ${a.grade ?? 'secondary school'}. Length: ${a.minutes ?? 40} minutes.`,
      'Pick two contrasting places a few kilometres apart (find_landing_sites or curated sites from list_sites) and get their numbers with compare_scenarios, sky_at at one instant and skyline.',
      'Keep three ideas apart and say which one each number is: an instant (sky_at), a stay (site_summary), the 18.6-year average (point_facts nasaAverage).',
      'Write the lesson: objective, 3–4 steps each with an open_in_navigator link, 5 questions with answers; after each answer name the tool call and inputs that produced it so it can be recomputed. Add one teacher note on a common misconception.',
    ],
  },
  {
    name: 'explain_simply', title: 'Explain simply', audience: 'public',
    description: 'Public or classroom: answer one question about light and Earth at the lunar south pole in plain words, with real numbers and a link.',
    arguments: [arg('question', 'The question, in your own words.', true), arg('place', 'Optional site or coordinates.')],
    steps: (a) => [
      `Question: "${a.question}"${a.place ? ` (place: ${a.place})` : ''}.`,
      'Compute only the one or two numbers the answer needs (sky_at, next_events, site_summary or best_landing_dates).',
      'Answer in at most four short sentences with at most three numbers, in everyday units (days rather than hundreds of hours).',
    ],
  },
  {
    name: 'virtual_visit', title: 'Stand there', audience: 'public',
    description: 'Public: what would you see standing at a place on the Moon at a moment: where the Sun and Earth are, what hills block them, when they set next.',
    arguments: [arg('place', 'Site id, name or coordinates.', true), arg('time', 'UTC instant (default: 2027-01-13T00:00Z).')],
    steps: (a) => [
      `Place: ${a.place}. Moment: ${a.time ?? '2027-01-13T00:00Z'}.`,
      'Call sky_at, skyline and next_events for that place and moment.',
      'Describe it in the first person: which way to face for the Sun and for Earth, how high they are (compare with something familiar only when the comparison is computed), what blocks them, and when each next sets or rises.',
    ],
  },
  {
    name: 'my_first_mission', title: 'My first mission', audience: 'public',
    description: 'Public: a guided, one-question-at-a-time walk through planning your own south-pole landing: choose a site, a date, see what a week\'s delay does, open the map.',
    arguments: [],
    steps: () => [
      'Guide the user one question at a time; wait for each answer.',
      '1. Offer three curated south-pole sites from list_sites (terrain_only) with one computed fact each (site_summary for a sample landing).',
      '2. For the chosen site, best_landing_dates (count 3) and let them pick a date.',
      '3. Show what a 7-day delay does: check_slip_robustness for that site and date, explained in one sentence.',
      '4. Give the open_in_navigator link for their mission and one sentence on what to look at first.',
    ],
  },
];

export function listPrompts() {
  return PROMPTS.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args }));
}

export function getPrompt(name, args = {}) {
  const p = PROMPTS.find((x) => x.name === name);
  if (!p) return { error: `Unknown prompt: ${name}` };
  for (const a of p.arguments) if (a.required && !(typeof args[a.name] === 'string' && args[a.name].trim())) return { error: `Prompt ${name} needs the argument ${a.name}.` };
  const text = [AUDIENCES[p.audience], ...p.steps(args), ASSUME, LINK].join('\n\n');
  return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text } }] };
}

// ---------- resources ----------
// Every primitive field of an object as dotted columns (candidates, points): the CSV/GeoJSON exports follow
// whatever the tools put in a result, so a new field needs no change here.
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else if (Array.isArray(v)) { if (v.every((x) => x === null || typeof x !== 'object')) out[key] = v.join(' '); }
    else out[key] = v;
  }
  return out;
}
const csvCell = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function toCsv(rows) {
  const flat = rows.map((r) => flatten(r));
  const cols = [...new Set(flat.flatMap((r) => Object.keys(r)))];
  return [cols.join(','), ...flat.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}
const lat = (r) => r.latDeg ?? r.lat_deg, lon = (r) => r.lonDeg ?? r.lon_deg;
function toGeoJson(rows, name) {
  return JSON.stringify({
    type: 'FeatureCollection', name,
    features: rows.filter((r) => Number.isFinite(lat(r)) && Number.isFinite(lon(r))).map((r) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [lon(r) > 180 ? lon(r) - 360 : lon(r), lat(r)] }, properties: flatten(r),
    })),
  }, null, 1);
}

function aboutData() {
  const readme = (readRepo('README.md') ?? '| Resource | Source | How we used it |\n| (README.md is not in this package; see the project repository) | | |').split('\n');
  const start = readme.findIndex((l) => l.startsWith('| Resource |'));
  const table = [];
  for (let i = start; start >= 0 && i < readme.length && readme[i].startsWith('|'); i++) table.push(readme[i]);
  return [
    '# Lunar Site Navigator — data behind the tools',
    '',
    'Coverage: terrain from 80°S to the pole (LOLA polar DEMs); ephemeris 2026-11-01 to 2029-01-01 UTC (JPL Horizons DE441, 3 h samples).',
    'Visibility = the centre of the Sun or Earth above the terrain skyline, observer 2 m above the ground. Screening: 2 km / 1 km skyline grids (72 azimuths), 1 h samples. Exact: the site skyline from the 480 m DEM (360 azimuths), 15-minute scans refined to 1 minute.',
    'Slope: 2 km and 1 km cell means of the 240 m grid; point slope on the 240 m grid. PSR: Mazarico et al. 120 m map; distance = to the nearest PSR patch of at least 1 km². Possible ice: thermal stability from Diviner (Schorghofer & Williams 2020) when the ice packs are built, otherwise the PSR distance as a proxy (results say which).',
    'Results are a first-look screen, not a certified landing analysis. Battery, panel, load, slope limits, relay orbits and drill depth are assumptions.',
    '',
    '## Sources (from README.md)',
    '',
    ...table,
  ].join('\n');
}

const STATIC = [
  { uri: 'lsn://sites', name: 'sites', title: 'Curated landing sites', description: 'Site ids, names and coordinates (sites.json).', mimeType: 'application/json', read: () => JSON.stringify(readSites(), null, 1) },
  { uri: 'lsn://criteria/presets', name: 'criteria-presets', title: 'Criteria language and presets', description: 'The criteria fields every v2 tool takes, their meaning, and the presets.', mimeType: 'application/json', read: () => JSON.stringify({ presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, { meaning: v.text, criteria: v.criteria }])), checks: CHECK_IDS, fields: Object.fromEntries(Object.entries(CRITERIA_SCHEMA.properties).map(([k, v]) => [k, v.description])) }, null, 1) },
  { uri: 'lsn://about/data', name: 'about-data', title: 'Data sources and limits', description: 'Coverage, resolution, conventions and the README data-source table.', mimeType: 'text/markdown', read: aboutData },
  { uri: 'lsn://glossary', name: 'glossary', title: 'Glossary', description: 'Terms used by the page and the tools (docs/guide/glossary.md).', mimeType: 'text/markdown', read: () => readRepo('docs/guide/glossary.md') ?? '# Glossary\n\nThe glossary (docs/guide/glossary.md) is not in this package; see the project repository.\n' },
];

export const RESOURCE_TEMPLATES = [
  { uriTemplate: 'lsn://search/{search_id}.csv', name: 'search-csv', title: 'Search candidates (CSV)', description: 'The candidates of a find_landing_sites result, one row each.', mimeType: 'text/csv' },
  { uriTemplate: 'lsn://search/{search_id}.geojson', name: 'search-geojson', title: 'Search candidates (GeoJSON)', description: 'The candidates as points (longitude −180…180).', mimeType: 'application/geo+json' },
  { uriTemplate: 'lsn://mission/{mission_id}', name: 'mission', title: 'Open mission', description: 'A mission loaded with mission_open, normalised (points with names and times).', mimeType: 'application/json' },
  { uriTemplate: 'lsn://mission/{mission_id}.geojson', name: 'mission-geojson', title: 'Mission points (GeoJSON)', description: 'The named points of a mission.', mimeType: 'application/geo+json' },
];

// refs: tools-core api.refs (may be null before the core loads)
export function listResources(refs) {
  const held = [];
  for (const id of refs?.list?.('search') ?? []) {
    held.push({ uri: `lsn://search/${id}.csv`, name: `${id}-csv`, title: `Search ${id} (CSV)`, mimeType: 'text/csv' });
    held.push({ uri: `lsn://search/${id}.geojson`, name: `${id}-geojson`, title: `Search ${id} (GeoJSON)`, mimeType: 'application/geo+json' });
  }
  for (const id of refs?.list?.('mission') ?? []) {
    held.push({ uri: `lsn://mission/${id}`, name: id, title: `Mission ${id}`, mimeType: 'application/json' });
  }
  return [...STATIC.map(({ read, ...r }) => r), ...held];
}

// → { contents: [{ uri, mimeType, text }] } | { error, code }   (code -32002: resource not found)
export function readResource(uri, refs) {
  const s = STATIC.find((r) => r.uri === uri);
  if (s) return { contents: [{ uri, mimeType: s.mimeType, text: s.read() }] };
  let m = /^lsn:\/\/search\/([\w-]+)\.(csv|geojson)$/.exec(uri);
  if (m) {
    const search = refs?.get?.('search', m[1]);
    if (!search) return { error: `No search ${m[1]} is held (the server keeps the last ${refs?.limit ?? 32}; run find_landing_sites again).`, code: -32002 };
    const rows = search.candidates ?? [];
    return m[2] === 'csv'
      ? { contents: [{ uri, mimeType: 'text/csv', text: toCsv(rows) }] }
      : { contents: [{ uri, mimeType: 'application/geo+json', text: toGeoJson(rows, m[1]) }] };
  }
  m = /^lsn:\/\/mission\/([\w-]+?)(\.geojson)?$/.exec(uri);
  if (m) {
    const mission = refs?.get?.('mission', m[1]);
    if (!mission) return { error: `No mission ${m[1]} is held; run mission_open again.`, code: -32002 };
    return m[2]
      ? { contents: [{ uri, mimeType: 'application/geo+json', text: toGeoJson(mission.points ?? [], m[1]) }] }
      : { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(mission, null, 1) }] };
  }
  return { error: `Resource not found: ${uri}`, code: -32002 };
}
