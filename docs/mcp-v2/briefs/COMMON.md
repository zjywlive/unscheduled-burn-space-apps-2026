# MCP v2 — rules every package follows

You are implementing one package of the Lunar Site Navigator MCP v2. The design is
`docs/mcp-v2/DESIGN.md` (Chinese, identifiers in English). Read §2 (definitions), §5 (criteria), §9 (output
contract) and your own package's sections. The architect has already built the shared pieces below; build on
them, do not rewrite them.

## Repository facts

- Node 26, ES modules, **zero dependencies**. Tests: `node --test tests/<file>.test.mjs` (node:test + node:assert/strict).
- `demo/src/` runs in the browser too: **no `node:` imports there**. `tools/` and `tests/` may use `node:`.
- Data packs live in `demo/data/` (tracked). Raw downloads live in `data-raw/` (git-ignored).
- Coordinates: map km on a polar stereographic plane, `demo/src/terrain.js` `toXY(lat, lon) → [x, y]` and
  `fromXY(x, y) → { latDeg, lonDeg }` (pole at 0,0; 0°E up; R = 1737.4 km; r = 2R·tan(colatitude/2)).
  Terrain covers 80°S to the pole. Cell grids index `k = j × size + i`, i to +x, j downwards (−y).
- Ephemeris 2026-11-01 to 2029-01-01, `eph.at(tMs)` → Sun/Earth directions. All times UTC.

## Shared pieces (owned by the architect — read, do not edit)

- `demo/src/tools-core.js` — the one tool registry. `createCoreTools(ctx, { extensions })`: each extension is a
  function `kit → { specs: [{ name, description, schema }], handlers: { [name]: async (input) => result } }`.
  Inputs are validated against `schema` before your handler runs (the small JSON-Schema subset in
  `validateCoreInput`: type (may be an array incl. 'null'), enum, minimum, maximum, minItems, maxItems, items,
  properties, required, additionalProperties). Return `kit.err(message)` for user errors; never throw for them.
  The `kit` holds: `ctx, eph, refs, sky(site) → skyline mask fn, horizonOf(site) → { mask, terrain, note },
  about(extra) → about block, withAbout(out, about), err, round(v, d), hours(ms), pct, iso(ms), stayIn,
  provided(v) (awaits a lazy ctx field), span, dateText, rangeText, labelOf, resolvePlace(input, { terrainOnly })
  → { site, place } | { error }, parseLanding(text, field) → { ms } | { error } (snapped to the hour),
  parseInstant, parseUtc, summaryFigures, bodyNow(eph, site, tMs, mask), nextCrossings(site, body, fromMs, mask),
  schema: { obj, PLACE, PLACE_OBJ, LANDING, INSTANT, STAY, SITE_ID, LAT, LON }, conv: { SCAN_RES, VISIBLE_CONV,
  HOURS_CONV, CLIP_CONV }, run(name, input) (call another tool), DAY_MS, HOUR_MS`.
  Spread `kit.schema.PLACE` into your schema to accept `{ site_id } | { lat_deg, lon_deg } | { candidate: "S1" } |
  { mission_point: "W2" }`; `kit.resolvePlace` resolves all of them.
- `demo/src/tools-v2/refs.js` — `kit.refs.put(kind, value, { prefix }) → id`, `kit.refs.get(kind, id?)` (no id =
  latest). A `search` value must carry `candidates: [{ ref: 'S1', latDeg, lonDeg, … }]`; a `mission` value must
  carry `points: [{ name, latDeg, lonDeg, … }]`. Ids are deterministic (`s_1`, `m_1`, …).
- `demo/src/criteria.js` — `resolveCriteria(input) → { criteria, assumed[] } | { error }`, `evaluate(criteria,
  metrics) → { pass, checks[{ id, need, value, margin, pass, unavailable?, beyond? }], limiting, tightest }`,
  `activeChecks`, `onlyFailure`, `PRESETS`, `CRITERIA_SCHEMA` (use it as the `criteria` property of your schema).
  Metric names are listed in its header. A metric you cannot compute must be `null` (→ unavailable), never guessed.
- `demo/src/point-eval.js` — exact metrics at one place: `pointTimeline(eph, site, mask, startMs, endMs)` (one
  15-min scan, crossings refined to 1 min), `pointMetrics(timeline, landingMs, stayMs, { continuous_from, fromMs,
  eph, peaks })`, `staticMetrics({ coarse, fine, psr, nasa, ice, dem240 }, site, criteria)`, `nearestPsrPixel`.
- `tools/core-context.mjs` — Node loader. `ctx.coarse` = 2 km grid `{ grid: createHeatGrid(...), slope, shadow }`
  (Float32Array per cell; shadow = km to the nearest PSR patch ≥ 1 km², 0 inside), `ctx.fine()` = the 1 km grid
  (same shape, lazy), `ctx.psr` (isPsr(x, y), bitAt(row, col)), `ctx.nasa.sample(x, y) → { sunPct, earthPct }`,
  `ctx.dem240()` (lazy), `ctx.ice()` (null until the ice package lands), `ctx.readText(path) → { text, path } | { error }`
  (Node only). `demo/src/heat.js`: `grid.visibility(k, eph.at(t))` → bits (1 Sun, 2 Earth), `grid.cellCenter(k)`,
  `grid.cellAt(x, y)`.
- `demo/src/tools-v2/index.js` lists the extensions; `mcp/server.mjs` already loads them.

Quick start in Node:

```js
import { loadCoreContext } from './tools/core-context.mjs';
import { createCoreTools } from './demo/src/tools-core.js';
import { V2_EXTENSIONS } from './demo/src/tools-v2/index.js';
const core = createCoreTools(loadCoreContext(), { extensions: V2_EXTENSIONS });
console.log(await core.run('your_tool', { … }));
```

## Output contract (DESIGN §9)

- Every result: `query_echo` (resolved inputs incl. defaults), `assumed[]` (start from resolveCriteria's list and
  add your own: anything that is an assumption rather than data must be named), the body, `headline` (one neutral
  English sentence the assistant can rewrite per audience), `about` (via `kit.about({ units, resolution,
  conventions, limits })`: units, resolution, sampling, limitations, "a first-look screen, not a certified landing
  analysis").
- `detail`: `brief` (≤ 1 KB JSON: headline + 3–5 key numbers + refs), `standard` (default: table level),
  `full` (adds matrices / per-sample detail). Add `detail: { type: 'string', enum: ['brief','standard','full'] }`
  to your schema.
- Round for output: hours 0.1, degrees 0.1, km 0.1; keep raw values internally.
- Same input → same output (no randomness, no clock reads except performance timing you do not return).
- Read-only, no network, never write user files.

## Working rules

- Edit **only** the files your brief lists. If you need a change in a shared file, do not make it: write the
  request in your report.
- Do not run `git add/commit/stash/checkout/reset`. Do not delete files you did not create.
- Match the repo style: each module starts with a header comment saying what it does and its contract; plain
  functions; no classes unless needed; no new abstraction layers.
- Tests: write focused tests for your module and tool (real data via `loadCoreContext()` is fine; keep each test
  file under ~60 s). Run them and `node --test tests/tools-core.test.mjs` before you finish.
- Finish with a report at `docs/mcp-v2/reports/<package>.md`: what you built, decisions and deviations from the
  design, measured timings, the exact test commands and their pass/fail counts, known gaps, requests to the
  architect. Keep it short and factual.
- Budget: aim to finish in about 45 minutes. Prefer a working, tested P0 over breadth.
