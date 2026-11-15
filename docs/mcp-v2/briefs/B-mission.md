# Package B — the mission bridge: `mission_open`, `mission_conditions` (+ `mission_check` stretch)

Read `docs/mcp-v2/briefs/COMMON.md` first, then DESIGN §6.4 and §8.2.

The user's plan lives in the browser (localStorage). The page exports it as files; P0 reads those files, a
pasted JSON object, or a page share link. No live bridge, no page changes in this package.

## Files you own (create or replace; edit nothing else)

- `demo/src/mission-io.js` — pure, browser-safe parser/normaliser
- `demo/src/tools-v2/mission.js` — replace the stub: `export function missionTools(kit) → { specs, handlers }`
- `tests/mission-io.test.mjs`, `tests/mission-tool.test.mjs`, `tests/fixtures/mission-*.json` (new fixtures only)
- `docs/mcp-v2/reports/B-mission.md`

Read (do not edit): `demo/src/mission-save.js` (record v1, `toGeoJSON`, `routeCSV`), `demo/src/route3d.js`
(payload v1: `pts`, times, flags, `wps`, havens, stops; `parsePayload`, `timeSpan`, `roverAt`),
`demo/src/mission-config.js` (config v1, `changesSince`, `goNoGoRows`), `demo/src/mission-flow.js` (the
`mission` object: site, landing, touchdown), `demo/src/state.js` (`parseHash`, `DEFAULTS`: the share link),
`demo/src/windows.js`, `demo/src/comms.js`. Build fixtures with the page's own builders where you can
(`buildRecord`, `buildPayload`, `buildConfig`, `toGeoJSON`) so they match real exports.

## `mission-io.js`

`parseMission(textOrObject, { sites }) → { mission } | { error }` accepting: a mission record
(`lsn-mission-record` v1), a frozen config (`lsn-config` v1), the GeoJSON `toGeoJSON` writes, a bare route3d
payload, and `parseLink(url, { sites })` for a page share link (`…index.html#…`: site / landing / stay / slip from
`parseHash`; a link has no waypoints, so its only point is `landing` — say so in `notes`).

Normalised mission: `{ kind, name, site: { id, name, latDeg, lonDeg } | null, landingMs, stayDays, slipDays,
points: [{ name, kind, latDeg, lonDeg, arriveMs, departMs, km }], route: { lengthKm, hours, arriveMs, socMin,
oneWayKm, returnable, … } | null, settings, notes[] }`.

Point names (DESIGN §6.4), case-insensitive when looked up:
`landing` (planned site), `touchdown` (recorded actual touchdown, if any), `start` / `end` (route ends), `W1…Wn`
(waypoints in order), `stop1…` (energy-simulation charging stops, with start/end times), `haven1…` (havens),
`empty` (where the battery runs out, if it does), and any user-given name carried in the export (keep it as an
alias; `W2` must still work). Times come from the payload's per-point times (interpolate along the path for a
waypoint between samples; `roverAt` may help). Leave a time null when the export has none — never invent one.

## `mission_open`

Input: `source` = `{ path }` (Node: `kit.ctx.readText(path)`; absent in the browser → error that says to paste
the JSON instead) | `{ url }` | `{ json }` (object or string), optional `name`, `detail`.
Output: `mission_id` (`kit.refs.put('mission', normalised, { prefix: 'm' })`), `kind`, `name`, `site`, `landing`
(ISO), `stay_days`, `slip_days`, `points` table (name, kind, lat_deg, lon_deg, arrive, depart, km),
`route` summary, `notes`, `headline`, `about`. With a config and a record available together, include
`changes_since` from `changesSince` (stretch).

## `mission_conditions` (request 2: "W2 和 W4 的光照、地球可见性")

Input: `mission_id` (default latest), `points` (array of names, or `"all"`; default all, at most 24), `window`:
`pass` | `stay` | `both` (default both), `detail`.

Per point:
- **pass** (needs arrive/depart; else say "no pass time in the export" and give stay only): Sun and Earth at
  arrival (`kit.bodyNow(kit.eph, site, t, mask)`: elevation, skyline, clearance, visible), at departure, whether
  each body is in view during the whole pass (interval scan with `windows.js visibleIntervals` over
  [arrive, depart]), longest time without Earth during the pass, the next sunset / Earthset after arrival and
  how long after arrival (`kit.nextCrossings`), and the next sunrise / Earthrise when a body is down.
- **stay** (the mission's landing + stay): `summarize` at the point: Sun, Earth, both hours, longest dark, next
  events — reuse `kit.summaryFigures` for the same field names as `site_summary`.
- **risks**: short sentences ordered by severity, e.g. "Sun sets 3.2 h after arrival (before departure)",
  "Earth not in view for the whole pass: no direct link", "point inside a permanently shadowed region"
  (`ctx.psr`).

Top level: `mission_id`, `points` results, `headline` (e.g. "W2: Sun in view, Earth behind terrain on arrival
(+52 h); W4: sunset 3.2 h after arrival"), `about`.

## `mission_check` (stretch, only if the two above are done and tested)

Input: `mission_id`, `slip_days` (array, default [1, 3, 7]), `criteria` (default preset `lander_dte`). Re-evaluate
the landing point at landing + each slip with `point-eval.js` + `criteria.evaluate`, and each point's pass times
shifted by the same slip for Sun/Earth in view; list what changes from pass to fail per slip.

## Tests (must pass)

- parse each fixture kind; names W1…, stop1, haven1, landing, touchdown resolve; unknown kinds give an error.
- a share link built with `state.js toHash` round-trips to landing / stay / site.
- `mission_open` from a fixture path, then `mission_conditions({ points: ['W2', 'landing'] })` returns both, with
  numbers that equal `sky_at` / `next_events` for the same place and instant.
- after `mission_open`, `core.run('sky_at', { mission_point: 'W2', at: … })` works (the refs PLACE form).
