# Package A2 — `check_slip_robustness` and `landing_windows` (one place at a time, exact)

Read `docs/mcp-v2/briefs/COMMON.md` first, then DESIGN §2, §5, §6.2, §6.3, §8.3.

## Files you own (create or replace; edit nothing else)

- `demo/src/tools-v2/slip.js` — replace the stub: `export function slipTools(kit) → { specs, handlers }`
- `tests/slip-tool.test.mjs`
- `docs/mcp-v2/reports/A2-slip.md`

Both tools use `demo/src/point-eval.js` (already written): scan a place once with `pointTimeline` over the whole
span you need, then read every landing out of it with `pointMetrics` (+ `staticMetrics` once per place, with
`await kit.provided(...)` for `ctx.coarse`, `ctx.fine`, `ctx.psr`, `ctx.nasa`, `ctx.ice`, `ctx.dem240`), and judge
each with `criteria.js evaluate`. Mask: `kit.horizonOf(site).mask` (north of 80°S it is a smooth 0° horizon; say
so via its `note`). Default criteria: preset `lander_dte` (say so in `assumed`).

## `check_slip_robustness`

Answers "which sites still work if the mission slips up to N days?".

Input: `places` (array of `kit.schema.PLACE_OBJ`, 1–24; default = every curated site with latDeg ≤ −80 from
`ctx.sites`), `landing` (required), `slip` `{ from_days = 0, to_days = 7, step_h = 6 }` (to_days ≤ 30, step_h
1–48), `criteria`, `detail`.

Per place: offsets s = from…to by step_h; metrics and `evaluate` at L + s. Output per place: `place`,
`passes_at_planned` (s = 0 or from), `survives_all`, `pass_share`, `first_fail` { slip_h, landing, check, value,
need } | null, `worst` per check { value, margin, at_slip_h }, `limiting` (commonest failing check), and with
`detail: 'full'` the `matrix` [{ slip_h, landing, pass, limiting }].

Global: `survivors` (place ids/names), `ranking` (by worst relative margin), `feasibility` { status ok | thin |
infeasible, binding, why, max_achievable, relaxations[] }. Relaxations: the largest `to_days` for which ≥ 1 place
survives; the binding threshold that lets the best place survive (its worst value); `continuous_from:
within_stay` when a continuous check binds. When `continuous_from` is from_landing and a continuous check binds,
`why` must explain that each hour of slip shortens the run from touchdown by an hour (need ≥ need_h + slip_h of
unbroken run from the planned landing) with the numbers found.

## `landing_windows`

Answers "when can this place land, and how much slip does my date tolerate?" and "battery rides 30 h of dark:
which dates are safe?" (`criteria: { longest_dark_h_max: 30 }`).

Input: PLACE fields flattened like the v1 tools (`...kit.schema.PLACE`), `criteria`, `from` / `to` (UTC dates;
default the whole ephemeris minus one stay; at most 800 days), `step_h` (default 6, 1–48), `min_window_days`
(default 7: a window at least this long is "robust"), `planned` (optional landing to locate), `detail`.

One `pointTimeline` over [from, to + stay]; evaluate a landing every step_h; merge consecutive passing landings
into windows `{ open, close, length_h (close − open), landings, worst_check { id, margin } }`. Output: `windows`
(standard: at most 20, full: all), `window_count`, `robust_windows` (length ≥ min_window_days × 24 h), `best`
(the window with the largest worst margin), and for `planned`: `{ inside: bool, window_index, hours_since_open,
slip_budget_h (close − planned), next_open (if outside) }`. `headline` like "Shackleton ridge: 9 windows in
2027, the longest 11 d (3–14 Feb); your 13 Jan landing has 31 h of slip budget".

Note the step: a window's true edges lie within one step_h of the reported ones; say so in `about`.

## Tests (must pass)

- `check_slip_robustness` with no places, `landing: '2027-01-13'`, default criteria → one row per curated
  terrain site, `survivors` consistent with the rows.
- `criteria: { continuous_from: 'from_landing', both_continuous_h_min: 300 }`, slip 0–7 d → infeasible or thin,
  `why` mentions the hour-for-hour rule.
- `landing_windows` for `site_id: 'shackleton'` over 2027 with default criteria → windows sorted, non-overlapping,
  every reported landing inside a window passes when re-checked with `pointMetrics` directly; `planned` inside a
  window gives a slip budget equal to close − planned.
- `{ lat_deg: '84.82S', lon_deg: '24.44E' }` works; a north-of-80°S site works with the smooth-horizon note.
- timings: check_slip_robustness for all curated sites < 5 s; landing_windows for one year at step 6 h < 3 s.
