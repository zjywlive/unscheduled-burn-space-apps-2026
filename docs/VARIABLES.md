# Decision variables

The decision and route engine may only use variables that are listed here. Add a row **before** you
use a new variable in code, and update **Status** when it changes.

- **Status:** ✅ in the engine · 🟡 partial or simplified · ⬜ not yet
- **Source:** *data* (measured product, cite it) · *assumed* (a default the user can change; the UI
  must label it "assumed") · *input* (the user sets it per scenario) · *derived* (computed from other rows)
- **Code:** the module in `demo/src/` that uses the variable (blank = not built yet)

Started 14 Nov 2026 from the team's whiteboard list, the challenge page, and Jun et al., *A Rapid,
Low-Cost Path to Lunar Communication and Navigation with a Lunar Surface Station*, IEEE Aerospace
Conference 2025 (JPL), referred to below as **[JPL-SS]**.

---

## 1. Terrain and mobility

| Variable | Unit | Source | Status | Code | Notes |
|---|---|---|---|---|---|
| Elevation (DEM) | m | data: LOLA global DEMs (7.6 km / 1.9 km / 474 m) + polar DEMs (south 20–480 m, north 480 m) | ✅ | `globe-terrain.js` `heightAt`, `terrain.js` | One height for any lat/lon from the finest level loaded; see PHASES.md phase 1 |
| Slope magnitude | deg | derived from DEM | ✅ | `route-plan.js`, `data/slope_*` | per node, plus a 3 × 3 mean for the "flat" cost |
| Rover max climb slope | deg | assumed (default 15°) | 🟡 | `route-plan.js` `DEFAULT_MAX_SLOPE` | one cap for both directions today |
| **Directional (non-reversible) slope** | deg | derived: slope along the direction of travel | ⬜ | | A slope the rover can drive down but not back up. The route needs a separate **descent limit** and **climb limit**, and the search must check that a return path exists (one-way edges in A*) |
| Rover max descent slope | deg | assumed | ⬜ | | needed for the row above |
| **Dips and valleys (local minima / traps)** | m, km² | derived from DEM | ⬜ | | Flag closed depressions the rover could enter but not leave within the climb limit. Valleys also block line of sight to Earth and relays (see §4) |
| Roughness / rock hazard | — | data (LROC / Diviner rock abundance) | ⬜ | | not loaded yet |
| Path length | km | derived | ✅ | `route-plan.js` | "short" candidate |
| Waypoints | lat/lon | input (2–8 points) | ✅ | `route-plan.js` `MIN_POINTS` / `MAX_POINTS` | |
| Max leg length | km | assumed (160 km) | ✅ | `route-plan.js` `MAX_LEG_KM` | |
| Route cost weights | — | assumed | ✅ | `route-plan.js` `COSTS`, `SUNNY_WEIGHTS` | short / flat / sunny |
| Rover speed | km/h | input | ⬜ | | needed to turn km into hours (energy, comms windows, night arrival) |
| 3D route view (2D topo → 3D) | — | derived from DEM | 🟡 | `globe-view.js`, `map/` | 3D terrain globe built (phase 1); route ribbon on it is phase 6 |

## 2. Sunlight and thermal

| Variable | Unit | Source | Status | Code | Notes |
|---|---|---|---|---|---|
| Sun azimuth / elevation | deg | data: JPL Horizons ephemeris | ✅ | `ephemeris.js`, `data/ephemeris.json` | 2026-11 to 2029-01 |
| Terrain horizon (skyline) | deg per azimuth | derived from DEM | ✅ | `terrain.js`, `data/horizon_*` | |
| Sunlit fraction over time | % | derived | ✅ | `energy.js` `sunSeries`, `heat.js` | |
| Long-term illumination average | % | data: NASA 18.6-year averages | ✅ | `nasa-avg.js`, `data/nasa_sun_480m.bin` | |
| Permanently shadowed regions (PSR) | mask | data: NASA PSR map | ✅ | `psr.js`, `data/psr_120m.bin` | |
| Distance to nearest shadow / PSR | km | derived | ✅ | `score.js`, `data/shadow_*` | |
| Longest dark period at a site | h | derived | ✅ | `score.js` `passes` (`maxDark`) | |
| **Sunlight inside "sunlight-neglected" areas** | % | derived | 🟡 | `heat.js` | Computed per cell; not yet shown as its own layer for PSR edges |
| Surface temperature | K | data (Diviner) or assumed (75–300 K at the south pole, [JPL-SS]) | ⬜ | | |

## 3. Energy

| Variable | Unit | Source | Status | Code | Notes |
|---|---|---|---|---|---|
| Panel attitude | track / fixed / flat | assumed (track) | ✅ | `energy.js` `ENERGY_DEFAULTS` | |
| Panel power ÷ average load | ratio | assumed (2) | ✅ | `energy.js` | |
| **Rover power consumption (absolute)** | W | input | 🟡 | `energy.js` | Only modelled as a ratio today; needs W for driving, idle and sleep, plus speed (§1) |
| **Solar array generation** | W | derived (panel area × efficiency × incidence × sunlit) | 🟡 | `energy.js` `powerSeries` | Relative today; needs panel W rating |
| Battery capacity | h of load (→ Wh) | assumed (24 h) | ✅ | `energy.js` | |
| Sleep load | fraction | assumed (0.1) | ✅ | `energy.js` | |
| Initial charge | fraction | assumed (1) | ✅ | `energy.js` | |
| Minimum battery margin | % | input | ⬜ | | the planner should refuse routes below it |
| Driving energy vs slope | Wh/km | derived (mass × g × Δh + rolling) | ⬜ | | climbing costs energy, so link §1 to §3 |
| RTG option | W | assumed | ⬜ | | [JPL-SS] notes RTGs as the option for a static station |

## 4. Communications

| Variable | Unit | Source | Status | Code | Notes |
|---|---|---|---|---|---|
| Earth above the terrain horizon | yes/no, % | derived | ✅ | `windows.js`, `data/nasa_earth_480m.bin` | direct-to-Earth (DTE) |
| Relay orbiter elements | km, deg | assumed (example orbits, not real missions) | ✅ | `relay.js` `PRESETS` | |
| Relay above horizon + relay sees Earth | windows | derived | ✅ | `relay.js` | |
| Min elevation for a link | deg | input (default 0) | ✅ | `relay.js` `minElDeg` | |
| **Communication strength** | dBm | derived (path loss model) | ⬜ | | [JPL-SS] used FEKO: two-ray model in LOS, knife-edge diffraction outside LOS, at UHF 442.5 MHz and S-band 2245 MHz. We can do a simpler free-space + knife-edge estimate along the DEM |
| Surface station position | lat/lon | input | ⬜ | | [JPL-SS] picked (−89.51°, 225°) on the Connecting Ridge |
| Station antenna height | m | assumed (15 m, [JPL-SS]) | ⬜ | | deployable boom |
| Rover antenna height | m | assumed (2 m, [JPL-SS]) | ⬜ | | |
| Station LOS coverage (viewshed) | % of radius | derived from DEM | ⬜ | | [JPL-SS]: 8 km radius, grid search from 1 km down to 100 m |
| Tx power / antenna gains | dBm / dBi | assumed (0 / 0 / 0 in [JPL-SS] path-loss maps) | ⬜ | | |
| Data rate | Mbps | assumed | ⬜ | | [JPL-SS]: up to 300 Mbps near the station |

## 5. Navigation and position

| Variable | Unit | Source | Status | Code | Notes |
|---|---|---|---|---|---|
| **Rover position (real time)** | lat/lon/alt | input (live feed or simulated track) | ⬜ | | time playback exists, but no rover position yet |
| Position accuracy | m (3σ) | assumed | ⬜ | | [JPL-SS]: ≤10 m with a surface station and ≥3 orbiters |
| **Comms-denied navigation (stars / Sun / Earth)** | — | derived from ephemeris + attitude | ⬜ | | If links drop, the rover estimates heading from Sun or star azimuth (we already have ephemeris) and position by dead reckoning |
| Dead-reckoning drift | % of distance | assumed | ⬜ | | |

## 6. Time and scenario

| Variable | Unit | Source | Status | Code | Notes |
|---|---|---|---|---|---|
| Landing time | UTC | input | ✅ | `state.js` | |
| Stay length | days | input | ✅ | `energy.js` `stayWindow` | |
| Site score weights | — | assumed (sun 40, earth 30, slope 20, shadow 10) | ✅ | `score.js` `DEFAULT_WEIGHTS` | |
| Lunar day / night | h | data (≈354 h each at worst, [JPL-SS]) | ✅ | ephemeris-derived | |

## 7. Contingency

| Variable | Unit | Source | Status | Code | Notes |
|---|---|---|---|---|---|
| **Backup plan for extreme events** | — | derived | ⬜ | | Triggers: comms loss, battery below margin, unexpected shadow, solar particle event. Action: nearest safe lit and Earth-visible point reachable within the remaining energy and the climb limit |
| Safe-haven candidates | lat/lon | derived (lit + Earth-visible + gentle slope) | 🟡 | `score.js` | site scoring exists; "nearest safe haven from here" does not |

## 8. Gravity

| Variable | Unit | Source | Status | Code | Notes |
|---|---|---|---|---|---|
| **Local gravity (valleys vs high ground)** | m/s² | data: GRAIL gravity field | ⬜ | | Mean 1.62 m/s². Local anomalies are only a fraction of a percent, so the effect on driving power is tiny next to slope. Low priority unless we show it as a curiosity layer |

## 9. Data stitching

| Variable | Unit | Source | Status | Code | Notes |
|---|---|---|---|---|---|
| **Stitched base maps** | — | data | 🟡 | `tools/build-global.mjs`, `tools/build-*.mjs` | Global LOLA levels and both polar caps stitched into one model, plus NASA PSR and illumination averages; still to add: rock abundance, temperature, imagery |

---

## Team whiteboard list → rows above

| Whiteboard item | Rows |
|---|---|
| Rover power consumption | §3 rover power consumption, driving energy vs slope |
| Solar array power generation | §3 solar array generation |
| Sunlight exposure in sunlight-neglected areas | §2 PSR, sunlit fraction, sunlight in sunlight-neglected areas |
| 3D route builder with rover details | §1 3D route view, rover speed, climb / descent limits |
| Communication strength | §4 communication strength, station LOS coverage |
| Stitching pre-existing data into maps | §9 |
| Constellation navigation if comms are denied | §5 comms-denied navigation |
| Backup plan planner for extreme events | §7 |
| Micro-gravity in valleys vs high ground (consider power) | §8 |
| 2D topology → 3D map converter | §1 3D route view |
| Robot position in real time | §5 rover position |
| Dips, valleys, non-reversible slopes (chat) | §1 directional slope, dips and valleys |
