# Package A1 — `find_landing_sites` (grid search)

Read `docs/mcp-v2/briefs/COMMON.md` first, then DESIGN §2, §5, §6.1, §8.1, §8.3, §11, and the two prototypes in
`docs/mcp-v2/proto/` (they show the timeline + run arithmetic that is already measured at 0.3–0.6 s).

## Files you own (create or replace; edit nothing else)

- `demo/src/search.js` — the grid engine (pure, browser-safe)
- `demo/src/tools-v2/find.js` — replace the stub: `export function findTools(kit) → { specs, handlers }`
- `tests/search.test.mjs`, `tests/find-tool.test.mjs`
- `docs/mcp-v2/reports/A1-find.md`

## Tool input

```jsonc
{
  "region": "cap" | { "within_km": 30, "of": PLACE } | { "bbox": { "lat_min": -90, "lat_max": -85, "lon_min": 0, "lon_max": 90 } },
                                   // default "cap" = the declared coverage, cell centre latitude ≤ −80°
  "landing": "2027-01-13",         // one landing (snapped to the hour); or
  "landing_window": { "from": "2027-01-01", "to": "2027-03-01" },   // every landing_step_h in [from, to]; or neither = any date (whole ephemeris)
  "landing_step_h": 24,            // window / any-date landing grid, default 24 (6 allowed)
  "slip": { "from_days": 0, "to_days": 7, "step_h": 6 },            // optional: every offset must pass
  "criteria": { … },               // criteria.js CRITERIA_SCHEMA; default preset lander_dte
  "rank_by": "margin" | "both_continuous" | "robustness" | "ice_distance",   // default margin
  "count": 5, "min_spacing_km": 10, "refine": true, "detail": "standard"
}
```

PLACE in `region.of` is `kit.schema.PLACE_OBJ` (so `{ candidate }`, `{ mission_point }` work).

## Algorithm (DESIGN §6.1 tiers)

- **T0 region**: `ctx.coarse.grid` (2 km, 320²). Keep cells whose centre is ≤ −80° and inside the region. Always
  clip to the coverage (the grid corners at 75–79°S have a truncated skyline and overstate visibility).
- **T1 static**: from `ctx.coarse.slope` / `.shadow` (slope_scale other than 2km: screen at 2 km anyway, apply the
  requested scale at refine), inside_psr (`shadow === 0` at screen, exact `psr.isPsr` at refine), psr distance,
  ice: if `await kit.provided(ctx.ice)` is an ice object use `ice.distKm(2, k, cls)`, else the **PSR proxy**
  (ice target distance = PSR distance) and add to `assumed`: "ice data not loaded: PSR distance used as a proxy
  for possible ice (no temperature data)". NASA averages: `ctx.nasa.sample` at the cell centre.
- **T2 time**: per surviving cell, one 1 h visibility bit series over [earliest landing, latest landing + max
  slip + stay] using `grid.visibility(k, dirs[t])` with the `dirs` array built once (`eph.at`). From it compute,
  for each landing time to test: sun/earth at landing, continuous runs per `continuous_from` (suffix run arrays
  make from_landing O(1); within_stay needs the longest run inside a window), totals (prefix sums), longest dark
  inside the stay. Process cell by cell (do not hold all series at once). Document the sampling convention you
  use (sample instants) in `about`.
  - **slip**: the cell passes only if every offset in [from, to] by step_h passes; record worst value per check,
    `first_fail_h` and its check.
  - **window / any-date**: a cell passes if at least one landing passes (with its slip set if slip is given);
    record `best_landing` (best by rank metric) and `passing_landings` (count). Any-date must finish < 20 s on
    the full cap; measure it. If it cannot, cap the work and say so in the result (`partial: true` + why).
- **T3 refine** (when `refine`): take the top M = 60 cells by rank; for each, evaluate its four 1 km sub-cells
  (`ctx.fine()`, same T2 arithmetic) and keep the best sub-cell; then check that point **exactly** with
  `point-eval.js` (`pointTimeline` once over the landing span incl. slip, `pointMetrics` per landing/offset,
  `staticMetrics` for ground). Exact results decide the final pass; report `screened_vs_exact` for the key
  metrics. Cells that pass the screen but fail exactly become near misses with `fails: "exact_check"` + check id.
- **T4 rank**: greedy by `rank_by` with `min_spacing_km` between picks, then `count`. `margin` = the smallest
  relative margin across active checks (criteria `tightest` logic: margin / max(1, |need|)), larger is better.
  Name candidates `S1…Sn`.

## Output (DESIGN §6.1, trimmed for P0)

`search_id` (`kit.refs.put('search', { candidates: [{ ref, latDeg, lonDeg, … }], query }, { prefix: 's' })`),
`query_echo`, `assumed`, `funnel` (each stage with its cell count: all cells, coverage, region, each static check
in order, time checks, slip, refined/exact), `candidates[]` (ref, lat_deg, lon_deg, coords text, cell_km, landing
or best_landing, passing_landings, `eval` (criteria evaluate on exact metrics, else screen), `metrics` (rounded:
both_continuous_h, both_from_landing_h, longest_both_h, both_total_h, longest_dark_h, slope_deg, psr_km,
ice_target_km, sun/earth_at_landing, nasa_avg_*), `screened_vs_exact`, `slip` { survives_all, worst, first_fail_h,
fail_reason }, `science_target` (from `staticMetrics(...).ice_target`: kind, lat_deg, lon_deg, dist_km, source),
`headline`), `near_misses[]` (fail exactly one check: ref N1…, lat/lon, check, value, need, margin; at most 5),
`feasibility` { status: ok | thin (fewer than count) | infeasible (none), binding (the check that removes the most
cells at the last stage that empties the set, or the commonest limiting check), why (plain English with the
numbers), max_achievable (best value of the binding metric and where/when), relaxations[] ({ change, unlocks:
cells that would pass }) }, `headline`, `about`, `timing_ms` (per tier — this one is allowed to vary; put it under
`about.timing_ms` so tests can ignore it).

Relaxations to compute on the cached per-cell series (cheap; one dimension at a time): the binding numeric
threshold set to the value that admits `count` cells (or the best achievable); the slip shortened to the largest
`to_days` that keeps ≥ 1 cell; `continuous_from: within_stay` when a continuous check binds; ice or PSR distance
widened when they bind.

**The infeasibility case must read right.** With `continuous_from: from_landing`, `both_continuous_h_min: 300` and
slip 0–7 d, each hour of slip shortens the run from touchdown by an hour, so a cell needs ≥ 468 h of unbroken
Sun+Earth from the planned landing. `why` must say this with the numbers found (the prototype found a longest
from-landing run of 401 h at 84.82°S 24.44°E for a 2027-10-07 landing).

## Tests (must pass)

- engine unit tests on a tiny synthetic grid (fake `visibility`) for runs, slip, within_stay, totals, dark.
- real data: `landing: '2027-10-07'`, criteria `{ slope_max_deg: 5, psr_distance_km: { min: 1, max: 5 },
  inside_psr: false, continuous_from: 'from_landing', both_continuous_h_min: 300 }` → ≥ 1 candidate, every
  candidate's exact eval passes, and the funnel's stages are non-increasing.
- same criteria + `slip: { to_days: 7 }` → `feasibility.status === 'infeasible'`, binding names
  both_continuous_h_min, `why` mentions 468.
- `{ candidate: 'S1' }` works in another tool afterwards (e.g. `core.run('site_summary', { candidate: 'S1',
  landing: '2027-10-07' })`).
- timings: landing mode < 5 s, any-date mode < 20 s (assert generously, report the real numbers).
