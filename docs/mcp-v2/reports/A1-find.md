# A1 — find_landing_sites

2026-11-15 · Implemented and verified locally on Node v26.0.0, macOS Apple Silicon.

## Delivered

- `demo/src/search.js`: browser-safe hourly series, suffix runs, prefix totals, linear-time sliding longest runs/darkness, fractional-window arithmetic, slip aggregation, date selection, diagnostic summaries, region clipping and greedy spacing.
- `demo/src/tools-v2/find.js`: registered tool/schema; T0–T4 funnel; cap/radius/bbox regions, candidate/mission references, single/window/any-date landings, static constraints, four-child refinement and point-skyline checks, science targets, near misses, feasibility/relaxations, three detail levels and search references.
- `tests/search.test.mjs`, `tests/find-tool.test.mjs`: synthetic and real-data coverage, including independent exact re-evaluation, reference chaining, forced exact failures, loaded ice and explicit PSR fallback, requested slope scales, validation, determinism and performance.
- Only these four files and this report were edited. No dependencies, downloads or commits were introduced. Existing shared-file/data changes belong to other packages.

## Decisions and deviations

- **Hourly convention:** left-endpoint samples represent `[t,t+1h)`; touchdown uses that sample. Fractional final hours are weighted. Exact checks use the shared 15-minute timeline with crossings refined to one minute. Candidate metrics describe the first requested slip offset (`metrics_landing`); `eval` checks the worst value of each active constraint across all offsets.
- **Complete coverage:** every tested stay and slip must fit the ephemeris. An overflowing single landing is an error; windows are trimmed with an assumption, and any-date searches end at the last complete stay. Slip endpoints must be whole hours; both endpoints are included even when the step does not divide the interval.
- **Refinement:** normally the top 60 passing parents; examine all four in-region children, prefer a passing child, otherwise the fewest failures/best rank, then let point checks decide. This can recover a child that narrowly failed its hourly screen. No smooth-horizon substitute is accepted for an exact result.
- **Ranking:** margin is the smallest raw relative check margin. Robustness ranks the last passing tested offset, then worst relative margin (without slip, effectively margin). Remaining ties use grid index / earliest date. Output degrees round to 0.1°, but held candidate references preserve precise coordinates for subsequent tools.
- **Work cap:** deterministic limits of 80 million hourly samples and 4 million landing/offset evaluations; an additional 2-million peak-sample allowance applies to elevation constraints. Sample capped T2 cells evenly across the region in grid order. Large slip/date combinations may also reduce the 60-parent refinement limit. Results explicitly carry `partial` and an explanation; elapsed time never decides which cells are evaluated.
- **Diagnostics:** retain compact per-cell summaries, not all cell timelines. Single-static-check failures receive a separate bounded time evaluation (2 million samples / 100,000 landing-offset evaluations, smaller with peaks). Relaxation counts are screen-level lower bounds over evaluated cells, before spacing/exact checks; diagnostic coverage is reported in `about.diagnostics`.
- **Brief size conflict:** `brief` stays ≤1 KB by returning compact query/assumption references. The complete resolved query and assumptions are held under `search_id`; standard/full include them inline. This deliberately prioritizes the explicit size limit over repeating the full standard envelope.
- Ice packs became available during this session; integration with real Diviner targets passes. Fallback tests explicitly set ice to null, avoiding dependence on another package's arrival. With custom shallow depth, the packed distance still uses the pack's default depth; the requested depth is applied at refinement and the possible coarse omission is named in `assumed`.

## Measured results

Fresh final test run; wall times exclude context setup where stated. Per-tier timings are under `about.timing_ms`.

| Query | Total | T2 | T3 | Result |
|---|---:|---:|---:|---|
| `2027-10-07`, slope ≤5°, PSR 1–5 km/outside, both from landing ≥300 h | 385.5 ms wall | 222.2 ms | 135.9 ms | Candidates pass independent exact checks; monotone funnel; `S1` works in `site_summary` |
| Same + slip 0–7 d, every 6 h | 905.9 ms tool | 627.2 ms | 0 ms | Infeasible; binding `both_continuous_h_min`; explanation includes 468 h |
| Default any-date, full-cap region, refinement enabled | 9,542.8 ms wall | 7,440.3 ms | 2,085.3 ms | Partial search; exact candidates with best dates and passing-date counts |

The default any-date budget evaluates 2,567 of 38,029 static survivors across the full cap; it is **not an exhaustive full-cap/time proof**. The uncapped version was not benchmarked. The measured bounded path meets 20 seconds; the landing path meets 5 seconds. Test ceilings are deliberately generous (8 s / 30 s).

The seven-day case measures a **402 h** starting Sun+Earth run at approximately **84.8°S, 24.4°E**, versus the required `300 + 168 = 468 h`; the best worst-offset value is 234 h. The prototype's 401 h used midpoint samples, explaining the one-hour difference. Continuous criteria themselves remain clipped to the stay; the longer starting run is a separately labelled, span-limited diagnostic. Advertised positive numeric/slip relaxations were rerun successfully at screen level.

## Verification

| Exact command | Final result |
|---|---|
| `node --test tests/search.test.mjs tests/find-tool.test.mjs` | **22 passed, 0 failed, 0 skipped**; 14.17 s total (9 engine + 13 tool tests) |
| `node --test tests/tools-core.test.mjs` | **15 passed, 0 failed, 0 skipped**; 1.93 s |
| `node --check demo/src/search.js && node --check demo/src/tools-v2/find.js && node --check tests/search.test.mjs && node --check tests/find-tool.test.mjs` | All four syntax checks passed |
| `git diff --no-index --check /dev/null demo/src/search.js && git diff --no-index --check /dev/null demo/src/tools-v2/find.js && git diff --no-index --check /dev/null tests/search.test.mjs && git diff --no-index --check /dev/null tests/find-tool.test.mjs` | Passed; checks include the untracked A1 files |

The engine tests exhaust every binary visibility sequence through length 8 against independent brute-force window totals/longest runs. The browser bundler is exercised in memory; no generated build files are needed.

## Known gaps / architect requests

- Partial searches, capped diagnostic counts, and top-60 refinement cannot establish global infeasibility. Output explicitly limits that conclusion. Relaxations are not exact or spacing-filtered guarantees.
- PSR proxy target coordinates come from the nearest 120 m PSR pixel, which may belong to a smaller patch than the ≥1 km² patch used by the distance constraint; this shared `staticMetrics` distinction is disclosed in `about`.
- Please confirm the compact brief-envelope interpretation and expose the held query/assumptions through the search resource if clients need to expand it.
- Please align `criteria`'s “any = surface or shallow” wording with the installed ice pack's “any finite depth” rule, and consider depth-aware packed-distance screening. A1 names the loaded rule/custom-depth limitation rather than changing shared code.
- AI-use record for the README owner: **OpenCode / openai/gpt-6-astra**, A1 engine/tool implementation, synthetic/real-data tests and this report. Existing local LOLA, PSR, NASA averages, JPL ephemeris and the concurrently supplied Diviner pack were reused; no new source was fetched by A1. README is outside this package's edit allowlist.
