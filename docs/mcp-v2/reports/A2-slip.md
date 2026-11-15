# A2 — slip robustness and landing windows

2026-11-15 · Implemented and verified locally · Node v26.0.0, macOS Apple Silicon

## Delivered

- `demo/src/tools-v2/slip.js`: replaces the stub with `check_slip_robustness` and
  `landing_windows`, registered through the existing extension interface.
- One `pointTimeline` per distinct coordinate pair per request, one `staticMetrics` calculation per
  place, and `pointMetrics` / `evaluate` for each sampled landing. All six static sources are awaited
  through `kit.provided`; missing measurements remain unavailable. No dependencies or data sources added.
- Slip rows include the planned/first-offset result, pass share, first failure, worst checks, most
  frequent failure and optional matrix. Global results include survivors, relative-margin ranking,
  feasibility, measured bounds, and re-evaluated relaxation counts.
- Windows include sampled endpoints, landing counts, worst checks, robust windows, best window and
  planned-landing slip budget. Full detail includes all windows and the landing matrix.
- `tests/slip-tool.test.mjs`: 24 focused tests, including real-data recomputation, synthetic boundary
  cases, missing/lazy data, reference places, fractional steps, replayed relaxations and browser bundling.

## Decisions and deviations

1. Omitted criteria use `lander_dte`; an explicit criteria object, including `{}`, is used on its own
   unless it names a preset. Thus `{ longest_dark_h_max: 30 }` really is a battery-only query.
2. Require complete stays within the ephemeris; reject overrun requests instead of treating clipped
   stays as successful. Landing/from/to/planned use the shared whole-hour parser; `from_time` uses
   the shared instant parser. Default `to` is the last whole hour permitting a full stay.
3. Slip offsets are inclusive and also check an off-grid final endpoint. Window samples stay on the
   regular grid, with `sampled_through` exposing any unsampled remainder. Fractional hour steps work.
   Nonzero `from_days` makes `passes_at_planned` refer to that first offset, exposed as
   `evaluated_at_slip_h`. Window indices are zero-based; a single passing sample has length zero.
4. Feasibility is `infeasible` / `thin` / `ok` for zero / one / at least two survivors. Count every failed
   check when choosing the commonest failure; ties use criteria order. Ranking and best-window
   selection use unrounded relative margins, with stable input/time-order ties.
5. `max_surviving_to_days` is the largest tested passing prefix, or null when no place passes its
   first sample. Threshold suggestions are rounded outwards for safe replay and omitted if unavailable
   or outside the public schema. Prefer the best-ranked place whose other checks already pass;
   otherwise explicitly report that changing the binding threshold alone is insufficient.
   `unlocks` counts total survivors after the change, not additional survivors. `within_stay` is
   re-evaluated on the same timelines and stay length, and may unlock zero places.
6. The hour-for-hour explanation is qualified to the same unbroken visibility run. Its observed run
   length is measured from the planned landing without the stay cap, with scan-limited lower bounds
   labelled; the actual checks still apply the stay cap. This avoids treating a later separate run as
   an extension of the original one.
7. A planned landing between window samples is rechecked directly before reporting `inside: true`.
   Slip budget remains a sampled estimate, not a guarantee for every intermediate instant. Standard
   detail caps both window lists at 20 while retaining full counts and global best/planned indices.
8. **Brief-envelope deviation:** complete resolved inputs and assumptions can themselves exceed 1 KB.
   Brief retains them intact in `kit.refs` under kinds `slip` / `windows` and prefixes `sl` / `lw`, and
   returns indirect `query_echo` / `assumed`, four key numbers and a compact `about`. The UTF-8 limit
   is enforced even for long Unicode names. Repeated identical held results reuse their reference;
   IDs otherwise follow the shared store's deterministic call-sequence semantics. This is not a fully
   inline envelope. Standard/full carry the complete inline inputs, assumptions and data notes.

## Verification and measurements

Final verification commands, after the last implementation change:

| Command | Result |
|---|---|
| `node --test tests/slip-tool.test.mjs` | **24 passed, 0 failed, 0 skipped**; 371.43 ms total |
| `node --test tests/tools-core.test.mjs` | **15 passed, 0 failed, 0 skipped**; 1913.03 ms total |
| `node --check demo/src/tools-v2/slip.js` | Exit 0 |
| `git diff --no-index --check /dev/null demo/src/tools-v2/slip.js` | Exit 0 |
| `git diff --no-index --check /dev/null tests/slip-tool.test.mjs` | Exit 0 |

- Default slip query, all 11 curated terrain sites: **98.66 ms**, including first-use lazy packs;
  initial `loadCoreContext()` excluded. Budget: 5000 ms.
- Shackleton, `2027-01-01` through `2028-01-01`, step 6 h, full output: **13.77 ms**, 1461 landings;
  budget: 3000 ms. All samples were checked against direct `pointMetrics` / `evaluate` results.
- Default brief sizes: **695 bytes** (slip), **791 bytes** (windows).
- Existing `V2_EXTENSIONS` registry smoke: both tools returned successful results. Default slip
  survivors: `shackleton` (1/11). Shackleton year query: 12 windows, longest 270 h; the January 13
  landing has 186 h of sampled slip budget. The 300 h from-touchdown query has no survivors;
  required original run is 468 h versus the observed maximum 261.4 h.
- Browser compatibility was checked with the repository bundler and compilation in memory inside
  the A2 tests. No generated build files were needed.

## Known gaps / architect requests

- Expose brief result kinds `slip` and `windows` through the MCP resource/catalog layer, or agree a
  different brief-envelope contract. Currently `kit.refs.get(kind, id)` retrieves the retained result
  internally; clients can rerun with `detail: standard` for complete inline assumptions. This package
  did not edit shared resources or add output schemas to the registry.
- Window edges and robustness are sampling-dependent; brief mode points to retained full horizon,
  data and sampling notes. Terrain-unavailable sites use the shared smooth-horizon note, and active
  unavailable terrain checks fail rather than acquiring guessed values.
- For the README AI-use table, record: **OpenCode / openai/gpt-6-astra — A2 implementation, focused
  tests, local verification and this report; 2026-11-15.** README is outside this package's ownership.
- Worktree already contained shared/untracked work and changed concurrently. This implementation
  edited only the three A2-owned files; verification above is scoped to the tested local snapshot.
