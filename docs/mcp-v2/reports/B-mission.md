# Package B — mission bridge

2026-11-15 · P0 implemented and verified · Node v26.0.0, macOS / Apple Silicon.

## Delivered

- `demo/src/mission-io.js`: pure browser-safe `parseMission`, `parseLink`, and
  `resolveMissionPoint`; record v1, tagged/untagged config v1, page GeoJSON, route3d v1,
  and share links. JSON inputs enforce the same 5 MiB limit as local files.
- `demo/src/tools-v2/mission.js`: `mission_open` and `mission_conditions`; local paths,
  pasted objects/text, offline links, retained mission references, case-insensitive point
  selection, pass/stay/both, PSR risks, and brief/standard/full output.
- `tests/mission-io.test.mjs`, `tests/mission-tool.test.mjs`, and new fixture
  `tests/fixtures/mission-record.json`. The fixture is checked against `buildPayload` and
  `buildRecord` (fixed id/timestamp; one explicit waypoint alias). Tests also construct
  real-format configurations and GeoJSON with `buildConfig` and `toGeoJSON`.
- Only these five implementation/test files and this report were edited. The workspace
  already contained other packages' changes and accumulated more during execution.

## Decisions and deviations

- Actual `buildConfig()` output has no `kind`; both that shape and `kind: "lsn-config"`
  are accepted. GeoJSON/bare routes have no planned landing/stay: those fields remain
  null, rather than treating route start or actual touchdown as planned landing.
- `W1…Wn` includes every exported waypoint, including endpoints. User names remain
  aliases; canonical names win collisions, and ambiguous aliases return errors.
- Waypoints project onto the exported polar polyline in route order, within **1 m**;
  times interpolate at constant speed between samples/charging stops. The 0.1 m km
  tolerance matches payload rounding. Thinned curves that miss a waypoint by more than
  1 m remain untimed. Missing sample times or incomplete charging schedules are not
  bridged. Havens retain only explicit visit times. Landing/touchdown departure is null.
- A timed transit sample is an instantaneous pass unless dwell is exported; this is
  named in `assumed`. Pass calculations are at the fixed point, not along the route.
  Missing/out-of-coverage passes are unavailable and fall back to stay when possible;
  stays clip at the ephemeris end. No truncated pass is called fully visible.
- Reused `bodyNow`, `nextCrossings`, `summaryFigures`, `summarize`, and
  `visibleIntervals`; export visibility flags do not drive new conditions. Pass angles
  deliberately keep `sky_at`'s **0.01°** precision and coordinates keep **5 decimals**,
  instead of COMMON's blanket 0.1° rounding. Hours/km use 0.1; raw times are retained.
- Links use `state.parseHash` with the documented ephemeris bounds and page defaults;
  only `landing` is imported, including when the hash carries an `rp` drawing.
- Brief is a compact projection of the shared metadata, with named assumptions,
  counts and mission refs; source echo identifies the source kind rather than repeating
  the file path/JSON. Standard has tables; full adds settings, original route samples
  and visibility intervals. Missing arrival counts are null, not zero.
- Determinism follows the shared reference store: the same call sequence has identical
  ids/results; opening again allocates another id. Returned arrays/settings are detached
  from retained state.

## Verification and timings

Final runs (no skips):

| Exact command | Pass | Fail | Elapsed |
|---|---:|---:|---:|
| `node --test tests/mission-io.test.mjs tests/mission-tool.test.mjs` | 29 | 0 | 286.1 ms |
| `node --test tests/tools-core.test.mjs` | 15 | 0 | 1902.3 ms |

The new tests include exact cross-tool comparisons with `sky_at`, `next_events` and
`site_summary`, direct window-integral checks, mid-pass outages with visible endpoints,
charging interpolation, incomplete schedules, missing data, PSR coverage, ephemeris
clipping, schema errors, aliases, return paths, output isolation and deterministic calls.
They compile both browser modules through `bundle()` + `new Function()` in memory.

Single-run real-data timings, after `loadCoreContext()` (not including its startup):
file open **1.46 ms**; W2 + landing conditions **8.99 ms**; all 10 fixture points/full
**18.93 ms**. Fixture brief JSON: open **619 bytes**, conditions **617 bytes**.
A 100,000-haven input with 24 selected long canonical names and all engineering-setting
keys also stays ≤1024 bytes in brief. These are local measurements, not performance bounds.

Integration smoke through `createCoreTools(loadCoreContext(), { extensions: V2_EXTENSIONS })`
opened the fixture as `m_1` and returned `W2` and `landing`. `git diff --check` passed.

## Known gaps and architect requests

- Optional `mission_check` and `changes_since` were not implemented. Dynamic `km12.5`
  references and surface-station/relay link-budget evaluation are also outside this P0.
  Exported engineering assumptions are labelled; settings are retained in full output.
- **Shared refs request:** `refs.js` currently matches only `point.name`. Canonical
  `mission_point: "W2"` works and is tested; custom aliases work in `mission_conditions`
  but need shared PLACE support. Reuse `resolveMissionPoint`, or match `aliases` with
  canonical precedence and ambiguity errors. No shared file was edited for this.
- Page GeoJSON currently omits planned landing/stay, waypoint aliases and `emptyAt`;
  those omissions cannot be reconstructed reliably. Future export improvements should
  preserve these fields. Current parsing reports missing metadata explicitly.
- Existing JPL/LOLA/PSR data were reused; no external source or dependency was added.
  Browser bundling was verified, but no browser UI was exercised.
- **AI-use README request:** add a row for OpenCode / `openai/gpt-6-astra`, 2026-11-15:
  Package B parser/tools, synthetic fixture, tests and this report. README is outside
  this package's editable scope; this report records the use for integration.
