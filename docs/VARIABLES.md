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
| Rover max climb slope | deg | assumed (default 15°) | ✅ | `route-plan.js` `DEFAULT_MAX_SLOPE`, `edgeTest` | the card's Climb limit; checked against the grade along each move |
| **Directional (non-reversible) slope** | deg | derived: gradient projected on each move | ✅ | `route-plan.js` `edgeTest`, `legStats` | Directed graph; per route `oneWayKm` / `oneWay` (descending steeper than the climb limit) and per plan `returnable`. Switchbacks limited to 16 directions (conservative) |
| Rover max descent slope | deg | assumed (default 20°) | ✅ | `route-plan.js` `MOBILITY_DEFAULTS` | card: Descent |
| Rover max cross-slope | deg | assumed (default 12°) | ✅ | `route-plan.js` `MOBILITY_DEFAULTS` | card: Across; slope across each move (tipping, sliding) |
| **Dips and valleys (local minima / traps)** | km² | derived: directed reachability in the search corridor | ✅ | `route-plan.js` `reach`, `trapPatches` | Ground reachable from the start with no way on to the end or back to the start; patches under 4 nodes left out. Line-of-sight effects of valleys are §4 |
| Roughness / rock hazard | — | data (LROC / Diviner rock abundance) | ⬜ | | not loaded yet |
| Path length | km | derived | ✅ | `route-plan.js` | "short" candidate |
| Waypoints | lat/lon | input (2–8 points) | ✅ | `route-plan.js` `MIN_POINTS` / `MAX_POINTS` | |
| Max leg length | km | assumed (160 km) | ✅ | `route-plan.js` `MAX_LEG_KM` | |
| Route cost weights | — | assumed | ✅ | `route-plan.js` `COSTS`, `SUNNY_WEIGHTS` | short / flat / sunny |
| Rover speed | km/h | assumed (default 0.8) | ✅ | `route-plan.js` `speedFactor` | card: Speed; drive time per route, half speed at the climb limit, 70 % at the descent limit (assumed) |
| 3D route view (2D topo → 3D) | — | derived from DEM | ✅ | `globe-view.js`, `globe-route.js`, `route3d.js` | the route draped on the 3D terrain, coloured by sunlight, one-way and battery; "Fly along in 3D" from the navigator |

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
| **Rover power consumption (absolute)** | W | assumed (load 120 W + drive 180 W) | ✅ | `route-energy.js` `drivePowerW` | card: Load; drive power in POWER_DEFAULTS |
| **Solar array generation** | W | derived: rated W × cos(Sun elevation) (vertical panel turned to the Sun) × Sun above the local skyline | ✅ | `route-energy.js` `panelW`, `skyFromGrid` | card: Panel (assumed 450 W); skyline from the 2 km / 1 km grid |
| Battery capacity | Wh | assumed (4000 Wh) | ✅ | `route-energy.js` | card: Battery; the site energy card still uses hours of load |
| Sleep load | fraction | assumed (0.1) | ✅ | `energy.js` | |
| Initial charge | fraction | assumed (1) | ✅ | `energy.js` | |
| Minimum battery margin | % | assumed (20 % reserve, resume at 45 %) | ✅ | `route-energy.js` `simulateDrive` | below the reserve the rover parks to recharge; empty battery is reported with place and time |
| Driving energy vs slope | W | derived: m·g·v·sin θ ÷ efficiency (0.5) on top of the flat drive power | ✅ | `route-energy.js` `drivePowerW` | card: Mass (assumed 450 kg); no regeneration downhill |
| Departure time | UTC | input (timeline time) or found | ✅ | `route-energy.js` `scanDepartures` | "Find good departure times": every 6 h for 60 days from landing |
| RTG option | W | assumed | ⬜ | | [JPL-SS] notes RTGs as the option for a static station |

## 4. Communications

| Variable | Unit | Source | Status | Code | Notes |
|---|---|---|---|---|---|
| Earth above the terrain horizon | yes/no, % | derived | ✅ | `windows.js`, `data/nasa_earth_480m.bin` | direct-to-Earth (DTE) |
| Relay orbiter elements | km, deg | assumed (example orbits, not real missions) | ✅ | `relay.js` `PRESETS` | |
| Relay above horizon + relay sees Earth | windows | derived | ✅ | `relay.js` | |
| Min elevation for a link | deg | input (default 0) | ✅ | `relay.js` `minElDeg` | |
| **Communication strength** | dBm | derived: Tx + gains − free-space loss − dominant knife edge (ITU-R P.526), with curvature | ✅ | `comms.js` `link` | [JPL-SS] used FEKO: two-ray model in LOS, knife-edge diffraction outside LOS, at UHF 442.5 MHz and S-band 2245 MHz. We can do a simpler free-space + knife-edge estimate along the DEM |
| Surface station position | lat/lon | input (default the JPL site −89.51°, 225°) | ✅ | `comms.js` `STATION_DEFAULTS` | [JPL-SS] picked (−89.51°, 225°) on the Connecting Ridge |
| Station antenna height | m | assumed (15 m, [JPL-SS]) | ✅ | `comms.js` | card: Mast | deployable boom |
| Rover antenna height | m | assumed (2 m, [JPL-SS]) | ✅ | `comms.js` | |
| Station LOS coverage (viewshed) | % of radius | derived from the finest terrain loaded | ✅ | `comms.js` `coverage` | 33 % of the 8 km circle at the JPL site on our grids ([JPL-SS]: 29 % on a 5 m DEM) | [JPL-SS]: 8 km radius, grid search from 1 km down to 100 m |
| Tx power / antenna gains / threshold | dBm / dBi / dBm | assumed (30 dBm, 0 dBi as [JPL-SS], −110 dBm) | ✅ | `comms.js` `STATION_DEFAULTS` | |
| Data rate | Mbps | assumed | ⬜ | | [JPL-SS]: up to 300 Mbps near the station |

## 5. Navigation and position

| Variable | Unit | Source | Status | Code | Notes |
|---|---|---|---|---|---|
| **Rover position (real time)** | lat/lon | simulated track (no live feed) | 🟡 | `route3d.js` `roverAt` | the simulated drive played back on the globe: position, battery, sunlight, links, parked or driving; a live feed would replace the simulated times |
| Position accuracy | m (3σ) | assumed | ⬜ | | [JPL-SS]: ≤10 m with a surface station and ≥3 orbiters |
| **Comms-denied navigation (stars / Sun / Earth)** | deg | derived: bearing to the haven, Sun and Earth azimuth relative to it, only when above the local skyline | ✅ | `contingency.js` `bearing`, `relAngle` | stars are not modelled (named as the fallback when neither body is up) |
| Dead-reckoning drift | % of distance | assumed (2 %) | ✅ | `contingency.js` `HAVEN_DEFAULTS` | arrival uncertainty on the haven drive | |

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
| **Backup plan for extreme events** | — | derived | 🟡 | `contingency.js` `findHavens` | Covered: battery low or empty, unexpected shadow, comms loss (nearest haven and heading). Not modelled: solar particle events for the rover |
| Safe-haven candidates | lat/lon | derived: Sun on arrival and for 24 h, Earth in view on arrival, ground ≤ 10°, reachable by drive within 10 km and the battery left | ✅ | `contingency.js`, `route-plan.js` `reachFrom` | every 2 km along the route and where the battery runs out |

## 8. Gravity

| Variable | Unit | Source | Status | Code | Notes |
|---|---|---|---|---|---|
| **Local gravity (valleys vs high ground)** | m/s² | data: GRAIL gravity field | ⬜ | | Mean 1.62 m/s² (used in the climbing power). Local anomalies are a fraction of a percent, tiny next to slope; not built (phase 6 optional) |

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
