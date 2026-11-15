# Build phases

Written 14 Nov 2026, 15:30 GMT. Local judging: Sun 15 Nov, 14:00. Final submission: Sun 23:59.
Variables used by each phase are registered in [VARIABLES.md](VARIABLES.md).

Order agreed with the team: **the global terrain model comes first**, because every later analysis
(slope, landing sites, rover routes, terrain occlusion, sunlight, comms visibility) reads heights from it.

---

## Phase 1: global lunar terrain model (done 14 Nov, 16:40 GMT; see status at the end of this section)

**Goal.** One georeferenced elevation model of the whole Moon from real data, with levels of detail:
global coverage at low resolution, and finer data loaded where it exists. A 3D globe view in the
spirit of Google Earth's Moon, where the user can fly from the whole Moon down to the south-pole terrain.

**Data (all NASA PDS, LRO LOLA GDR; same 1737.4 km reference sphere, int16 × 0.5 m, so they stack
without re-levelling):**

| Level | Product | Coverage | Ground pixel | Size | State |
|---|---|---|---|---|---|
| G0 | `LDEM_4.IMG` | global | 7.6 km | 2.1 MB | to fetch |
| G1 | `LDEM_16.IMG` | global | 1.9 km | 33 MB | to fetch |
| G2 | `LDEM_64.IMG` | global | 474 m | 531 MB | to fetch, then tile |
| N1 | `ldem_75n_240m.img` | 75°N–90°N | 240 m | 29 MB | to fetch |
| S1–S4 | `ldem_75s_240m`, `_75s_120m`, `_80s_40m`, `_875s_20m` | south pole | 240 → 20 m | already in `demo/data` | done |

The next steps up (LDEM_128 at 2.1 GB, LDEM_256 at 8.5 GB, LDEM_512 at about 68 GB) are too big for
a weekend. They can be added later for chosen regions only (for example the Apollo sites).
PDS sends no CORS header, so the browser cannot stream from NASA directly; tiles must be built and
served by us.

**Model.**
- `tools/fetch-global.mjs`: download with label checks and resume, reusing `fetch-lola.mjs`.
- `tools/build-global.mjs`: G0 and G1 as single packs, G2 cut into 256 × 256 tiles in a lat/lon
  quadtree with 1 px aprons, plus a `globe.json` manifest (levels, bounds, tile list, sources).
- `demo/src/globe-terrain.js`: `heightAt(latDeg, lonDeg)` that picks the finest level loaded at that
  point (south-pole polar levels → G2 tile → G1 → G0), with bilinear sampling. This becomes the single
  source of height for all later phases.

**View.**
- A 3D globe: tiles are meshed and refined by distance to the camera, with hillshade colouring and a
  vertical exaggeration control. The existing 2D south-pole map stays; the globe is how you get there.

**Done when.**
- Any lat/lon on the Moon returns a height; the result matches the PDS value at test points
  (Shackleton floor, Tycho central peak, Apollo 11 site).
- The globe shows the whole Moon on first load and refines while zooming toward the south pole, with
  no seams between levels.
- Tests pass; the README resource table lists every product.

**Status (14 Nov).** Built and checked:
- `tools/fetch-global.mjs` and `tools/build-global.mjs` run as planned. G0, G1 and the north cap are committed
  (about 40 MB of packs on disk); G2 is about 425 MB on disk, so it is gitignored and built locally with `--g2`.
- `demo/src/globe-terrain.js` `heightAt()`. Tests: it equals the raw LDEM_16 and LDEM_64 values at
  their pixel centres; the overlapping levels agree to within about 120 m (median); the known extremes
  (+10.5 km, −9.1 km) are right.
- `demo/globe.html` (`tools/build-globe.mjs`, `demo/src/globe-view.js`). Screenshots from
  `tools/globe-shots.mjs` (headless Chrome, software WebGL): the whole Moon, Tycho at 474 m, Apollo 11,
  the north pole at 480 m, the south pole at 240 m, Shackleton at 20 m, with no seams between levels.
  Mesh building takes about 0.2 ms per tile.
- Not yet: the globe is a separate page and is not built into the navigator; the light is a display light
  rather than the real Sun at a chosen time; it has not been tried on a phone.

## Phase 2: rover mobility on real terrain (done 14 Nov, 17:40 GMT)

Directional (non-reversible) slopes with separate climb and descent limits, cross-slope limit,
one-way route segments ("point of no return") and trap detection for dips and valleys. Rover profile:
speed, power in watts, mass.

**Status (14 Nov).** Built in the navigator's route planner (`demo/src/route-plan.js`, option `mobility`):
- Each move is checked by direction: the gradient projected on the move against the climb and descent limits,
  the slope across it against the cross-slope limit. The graph is directed.
- Per route: steepest climb, descent and cross-slope, one-way stretches (descending more steeply than the
  climb limit; drawn orange), drive time at the set speed (slower on slopes). Per plan: whether the rover could
  drive from the end back to the start by any way; trap ground (reachable from the start, no way on to the end
  or back; drawn red; patches under 4 grid nodes left out).
- Card: Climb limit slider plus Descent, Across, Speed inputs (all labelled assumptions); a "Rover on the …
  route" summary under the candidates.
- Tests (`tests/route-mobility.test.mjs`): a 19° scarp is one-way and unclimbable, a 16° one is climbable by
  switchbacks, a steep bowl is reported as a trap and avoided, flat ground has none of these, and Shackleton to
  de Gerlache on real terrain. Checked in headless Chrome on that route: 2.0 km one-way, return possible,
  de Gerlache's floor shows as a trap.
- Known limits: switchbacks use the planner's 16 move directions, so some slopes that could be climbed at an
  in-between heading count as one-way (conservative); power and mass are not used yet (phase 3).

## Phase 3: energy along the route (done 14 Nov, 18:30 GMT)

Driving energy versus slope, solar generation in watts, battery state along the route, arrival times
against sunlight.

**Status (14 Nov).** `demo/src/route-energy.js`, fed by a per-route drive profile from the planner:
- The drive is run forward in time from a departure: the load plus drive power plus climbing power
  (m·g·v·sin θ ÷ efficiency), against the panel's output where the Sun clears the local skyline (the 2 km or
  1 km skyline grid and the ephemeris). Below the 20 % reserve the rover parks to recharge; an empty battery
  is reported with its place and time.
- Card: Panel, Battery, Load and Mass inputs (assumptions); arrival time, lowest and final battery, km in
  shadow and share with Earth in view; a battery-along-the-route chart with the shadowed stretches; "Leave at
  the timeline time"; "Find good departure times" (every 6 h for 60 days from landing, the best three by
  lowest battery, each with Use). Map: P where it parks, ! where the battery runs out.
- Tests (`tests/route-energy.test.mjs`): hand-checked drains, an empty battery, charging capped at 100 %,
  the climbing power formula, parking through a dark spell, the departure scan, and the real route.
- Checked in headless Chrome: Shackleton ridge to de Gerlache rim 2 leaving at the timeline time runs out at
  about km 7 on every candidate (the first stretch off the ridge is in terrain shadow); the scan finds 7 of 241
  working departures for the Flattest route, best 18 Jan 2027 18:00 UTC (lowest 42 %, arrives 21 Jan).
- Limits: the panel, battery, load, drive power, mass and efficiency are assumptions, not a real rover's
  data; the skyline grid is 1–2 km, so shadows from small nearby relief are missed; no thermal model.

## Phase 4: communications (done 14 Nov, 19:00 GMT)

Surface-station viewshed (15 m mast, 2 m rover antenna, 8 km radius, from the JPL surface-station
paper), Earth, relay and station link status along the route, and signal strength in dBm (free-space
loss plus knife-edge diffraction along the terrain).

**Status (14 Nov).** `demo/src/comms.js`:
- A link between two antennas: free-space loss plus the dominant knife edge in the terrain profile between
  them (ITU-R P.526), with the Moon's curvature, on the finest terrain loaded. Station coverage within its
  radius; the station link at every sample of a route; a summary with Earth in view from the Phase 3 drive
  (station km, Earth share, km with no link, longest gap in km and hours).
- Card: Surface station on/off, latitude, longitude, mast and band (defaults from the JPL paper); comms lines;
  Earth and station link strips under the battery chart; coverage colours. Map: coverage coloured by received
  power (cells under the threshold left out) and the station mark.
- Tests (`tests/comms.test.mjs`): free-space loss values, the knife-edge formula, the smooth-Moon radio horizon
  (≈ 9.9 km for 15 m and 2 m antennas), ridge blocking and its loss (lower at UHF), coverage, the route summary,
  and the real site.
- Checked in headless Chrome on the Flattest route to de Gerlache rim 2 leaving 18 Jan 18:00 UTC: station link
  on 22.8 of 52.5 km, Earth in view 90 %, longest gap 1.3 km (2.4 h). Line of sight to 33 % of the 8 km circle,
  against 29 % in the paper on a 5 m DEM.
- Not done: relay orbiters along the route (the site relay card still covers relays at a site); multipath
  and the two-ray model the paper used in line of sight; the coverage is computed once per station on the
  levels loaded at that moment.

## Phase 5: contingency and navigation (done 14 Nov, 19:45 GMT)

Nearest safe haven from any point on the route (lit, Earth-visible, reachable within the energy and
slope limits). Comms-denied heading from the Sun and Earth position.

**Status (14 Nov).** `demo/src/contingency.js` and `reachFrom` in `route-plan.js`:
- From checkpoints every 2 km along the simulated drive (and where the battery runs out): the nearest place by
  drive time, under the same directional limits, that has the Sun on arrival and for the next 24 h (checked
  every 6 h), Earth in view on arrival and ground under 10°, and that the battery left at the checkpoint can
  reach. Card: "If something goes wrong" with the coverage, the farthest haven and the checkpoints without one;
  map: green dots where the checkpoint is itself a haven, H and a dashed link where it needs a detour, red rings
  where there is none.
- Comms-denied cue: the bearing to the haven and where the Sun and Earth sit relative to it, using only bodies
  above the local skyline at that point; dead-reckoning drift of 2 % gives the arrival uncertainty.
- Tests (`tests/contingency.test.mjs`): flat-ground drive times and energy, the nearest lit patch, radius and
  battery limits, the 24 h rule, bearings, checkpoints, and the real route.
- Found while testing: at the south pole's low Sun, the 2 km and 1 km skyline grids can disagree (this drive runs
  out at km 7.8 on the 2 km grid and succeeds on the 1 km grid). The card now says which grid it used, and the
  drive is run again when the 1 km grid finishes loading.
- Checked in headless Chrome on the Flattest route leaving 18 Jan 18:00 UTC: havens from 27 of 27 checkpoints,
  the farthest 1.6 km away (2.5 h, 0.8 kWh).

## Phase 6: 3D route and live position (done 14 Nov, 20:30 GMT)

The route ribbon drawn on the 3D terrain, a simulated rover moving along it over time, and optionally
a GRAIL gravity layer.

**Status (14 Nov).** `demo/src/route3d.js`, `demo/src/globe-route.js`:
- "Fly along in 3D" in the route card stores the selected route and its drive (per-point time, battery,
  sunlight, Earth and station link, one-way flags; parking stops, havens, where the battery ran out) in
  localStorage and opens `globe.html#route=1`.
- The globe draws the route as a ribbon on the terrain (white sunlit, blue in shadow, orange one-way, red under
  the battery reserve, grey not reached), havens, stops and the empty-battery point, and the rover. Playback:
  play/pause, 1 h/s, 6 h/s or 1 day/s, a scrubber over the drive, chips for state, km, battery, sunlight and
  links, and Follow (the camera rides behind the rover along its heading).
- Tests (`tests/route3d.test.mjs`): the payload and its round trip, the rover interpolated in time, waiting at a
  parking stop, stopping where the battery ran out, the framing.
- Checked in headless Chrome: Flattest route to de Gerlache rim 2 leaving 18 Jan 18:00 UTC handed over (299
  points, 27 havens), framed over the terrain; scrubbed to 20 Jan 04:14 with Follow on: km 23.7, battery 66 %.
- Not done: the GRAIL gravity layer (optional); a live position feed (the playback uses the simulated times);
  the surface station is not drawn on the globe.

## Phase 7: one mission flow and high-resolution landing terrain (14 Nov, 21:30 GMT)

Asked by the team after the six phases: "stitch between all of the views in one so after we have decided where
to land we can just plan further", and "high resolution 3D depth map so we would know the surface when it gets
down".

- **One mission across the pages** (`demo/src/mission-flow.js`): the chosen site, landing time and stay are kept
  in localStorage and carried in the links; every page has the same stage bar (since changed twice: at the team's request to 1 Landing (lander) → 2 Rover
  (navigator) → 3 3D (globe), then to Plan 1 Map → 2 Finalise → Fly 3 Execute, see Phase 9; first version: 1 Site (navigator) → 2 Landing
  (lander) → 3 Rover (navigator, route card opened with the landing site as the start) → 4 3D (globe, at the site,
  or the planned route). The navigator also shows "Plan the landing / Plan the rover route / See it in 3D" under the
  site inspector.
- **High-resolution patches** (`tools/fetch-hires.mjs`, `demo/src/hires.js`, `demo/data/hires.json`): 10 × 10 km
  around every listed south-pole site from the finest LOLA polar product that covers it, 5 m (Shackleton ridge,
  de Gerlache rim 2), 10 m (Haworth, Malapert massif, Mons Mouton, Nobile rim 1) or 20 m (IM-2, Peak near Cabeus B,
  Mons Mouton plateau, Nobile rim 2); IM-1 is outside them. Only the byte ranges of the patch rows were downloaded
  (25 MB in all; 6.9 MB of packs). Single-pixel spikes over 10 m (5 m data; 20 m and 40 m for 10 m and 20 m data)
  are replaced by the median of their 8 neighbours: 0–76 pixels per site, counted in the manifest.
- **Globe**: tiles over a patch refine to its pixel size (depth 12 at 5 m); "Data at centre" reads "LOLA 5 m" at
  Shackleton ridge. **Lander**: the descent scene uses the site's patch (lander session).
- Tests: the window arithmetic, the sampler, despiking, agreement with the 20 m and 120 m levels, the mission links.

## Self-driving planner (14 Nov)

Asked by the team: "self-driving smarts to navigate toughest route for rover path planning", with a flowchart
(initialize trees, select waypoints, B-RRT*, path exists? add it, else adjust waypoints and try again, abort after
a number of tries) and Perseverance AutoNav's candidate paths (blue) with the chosen one (cyan).

- **Planner** (`demo/src/route-rrt.js`, pure): bidirectional RRT* leg by leg on the same 240 m corridor, limits and
  drive profile as the A* planner. Two trees in continuous map km, one from the leg start (edges driven parent →
  child), one from the leg end (child → parent), so ground the rover can go down but not up is handled by direction.
  An edge is checked every quarter node (on the terrain, slope, grade along, slope across); its cost is drive time.
  Choose-parent and rewire within a shrinking radius; a new node connects to the other tree in the driving
  direction; every strictly better connection is a candidate path (8 kept per leg); the best is shortcut-smoothed
  with the same check. A leg with no path moves its end waypoint to a nearby passable spot the start tree can reach
  and tries again; after the tries it aborts and returns the trajectory so far with the reason. Delay is the extra
  time spent on retries. Seeded, so the same inputs give the same trajectory.
- **Navigator**: "Self-driving planner (B-RRT*)" in the route card (Run, Cancel, progress, the flowchart steps, the
  figures, "Use this path" adds a fourth candidate, "Show search trees"). On the map: trees faint blue, candidates
  blue, trajectory cyan, moved waypoints as ghost → marker. The 3D payload carries `autonav` (`autonavPayload`).
- Tests: `tests/route-rrt.test.mjs` (flat plane, wall with a gap, one-way ramp, unreachable pit with adjustment and
  with abort, same seed, directed check of every edge, payload caps).
- Not done: a start waypoint on ground the rover cannot stand on aborts instead of moving; sunlight is not part of
  the cost.

## Phase 8: 3D route tools, saving, mapped areas (14 Nov, evening)

Asked by the team with reference pictures (a robot 3D view with waypoints and frames, routing with no-go volumes and
leg callouts, a slope-coloured hiking route, a drone app's 3D preview and elevation profile), plus "record and save
all the planned route and path and all of the terrain and motion data" and "add the already mapped phase so we can
map more of the Moon"; later: a smoother follow camera, camera controls, the landing site always shown, a sharper
minimap.

- **Shared:** `slope-colours.js` (one slope scale for 2D and 3D: 0–2, 2–5, 5–8, 8–12, 12–15, over 15°);
  the route payload carries grade and terrain height per point, the waypoints and the trap cells (`route3d.js`).
- **Saving** (`mission-save.js`): records of route, settings, summary and recorded motion in localStorage (newest
  20; the oldest dropped when storage is full; search trees thinned) and as JSON, GeoJSON and CSV. Navigator:
  "Mission file" in the route card (save, downloads, saved list with load / delete, import) (`ui/mission-records.js`).
- **Navigator:** the selected route coloured by slope with a legend; a 3D preview window (the globe in embed mode,
  reloaded when the route changes) (`ui/inset3d.js`); the planned landing site drawn when there is no touchdown.
- **Globe:** camera buttons and keys (`globe-controls.js`); the camera's target height and ground clearance ease
  between frames, and the follow camera keeps the rover's exact position while its heading eases towards the way
  ahead (no more snapping at every route vertex); playback speeds chosen so the driving lasts about 25 s, parked time
  40× faster; contour lines in the terrain shader (interval follows the zoom); route coloured by drive or slope;
  trap cells as red volumes; leg labels (distance, time, steepest grade); a rover model (x forward, y left, z up)
  pitched and rolled by the terrain, with labelled frames; the elevation profile along the bottom, synced to
  playback, click or drag to seek (`globe-profile.js`); the minimap redrawn from ~160 × 160 height samples with
  shading, height tint and contours, numbered waypoints, the landing site (on the rim with its distance when off the
  map), a scale bar; motion recording and saving; waypoints placed by click or typed, sent to the navigator as `rp=`
  points (`globe-waypoints.js`); the "Mapped" layer (`globe-mapped.js`); `embed=1` for the navigator's window.
- Checked in headless Chrome: route handoff (171 points, 3 waypoints, 89 trap cells), follow, contours, the
  self-driving search in 3D, record → save (record listed, trees thinned), waypoints → navigator link, mapped areas,
  the navigator's preview window. Tests: `mission-save`, `mission-records`, `route3d` (new payload fields).
- Later the same evening: the follow camera tilts down while terrain hides the rover (and an x-ray outline shows
  it otherwise); the rover is drawn at its real size (2.2 m), sitting on the drawn (exaggerated) slope, with a
  locator ring while it is too small to see, and the camera may come to 20 m; the playback scrubber runs by
  distance and lines up with the elevation profile to the pixel.
- **Navigator map detail** (`map/terrain-style.js`, `ui/mapframe.js`, `ui/mapview.js`): a Terrain chip with Data
  (as before), Topo (multi-directional hillshade × height tint, heat colours at 35 %) and Real light (lit by the Sun
  at the playhead from the ephemeris, per pixel, with cast shadows marched over the terrain out to ~40 km, curvature
  included); contour lines with labelled index lines and an interval that follows the zoom; a Sun & Earth readout
  (azimuth / elevation, subsolar latitude from the 1.54° axis tilt, sub-Earth point from libration, Earth range)
  and Sun / Earth / shadow arrows at the view centre. Built in slices after a gesture; 130–300 ms per full picture
  at 1440 × 900 in headless Chrome. Tests: `tests/terrain-style.test.mjs`.
- **Action bars** (all pages): actions moved out of the side panels into one bar over the map or the view; side
  panels keep the inputs and the data. Navigator: `ui/actionbar.js`, a bar each panel fills by kind (point: Sky
  dial, Details, Plan the landing / rover route, See it in 3D; route: Plan routes, the route chooser with lengths,
  Self-driving and Use this path, the departure time with its menu of good departures, Fly along in 3D, 3D preview,
  Save mission; coordinates: Apply, Pick, Add vertex). It sits in the free span between the docked panels and
  shortens its labels (short names, then two rows, then icons) to fit. Globe: Fly to, waypoints, mapped areas.

## Phase 9: plan before launch, then fly (15 Nov, 00:10–01:20 GMT)

Asked by the team: all planning happens before launch, the Landing page becomes mission execution, the Rover step
becomes the Map and covers the whole Moon, and an explicit "Finalise mission configuration" step freezes the plan.
Workflow: Mission planning (Map) → Finalise → Launch → Spaceflight → Orbital manoeuvres → Lunar orbit insertion →
Landing → Surface operations.

- **Stage bar** (`mission-flow.js`): *Plan* 1 Map (`index.html`) › 2 Finalise (`finalise.html`), *Fly* 3 Execute
  (`lander.html`). Execute is marked locked until a configuration is frozen. The six execution phases are named once
  (`EXEC_PHASES`, each with the lander phases it covers). The globe is no longer a step: it is the Map's whole-Moon
  level, the surface-operations view, and still a page of its own.
- **Map: one view of the whole Moon** (`ui/moonlayer.js`; first built as a Moon · Region · Site switch, replaced at the
  team's request by one continuous view). Zoomed out, the map is the 3D globe in a frame inside the map, under the
  page's panels (`globe.html#pick=1`; LOLA 7.6 km → 474 m, polar 240–20 m); a click anywhere makes that point the site
  and the site card follows (north of 80°S the skyline is computed from the global terrain). Zooming in over the
  south pole (south of 80°S, camera closer than 600 km) hands over to the detailed polar map at the same place and
  about the same scale; zooming out past the whole polar map (wheel or −) hands back to the globe. A site outside the
  polar map opens on the globe; choosing a polar site from the list while the globe shows flies down and hands over
  at the site. The map's zoom buttons drive the globe while it shows; the drawing tools and the map modes are set
  aside. **Where to land** (`planner.html`, moved off the lander page) is a tool from the action bar, over the page:
  ellipse scores and better spots near the site, "Use this site" sets the site and its first lit landing time. The
  point and route action bars end with **Finalise mission**.
- **Finalise** (`finalise.html`, `lander/finalise-main.js`, `mission-config.js`): plans the flight to the Map's site
  and time with the lander's planner, finds the landing window (Sun and Earth above the skyline around the requested
  time), reads the chosen rover route, shows the assumed vehicle (editable here for the last time) and what each phase
  will fly, and rates each item go / check / no-go (terrain, sky at landing, window, Δv margin, landing checks, route,
  battery, comms; thresholds in VARIABLES.md §10). **Freeze** writes `lsn-config` = the site, landing time and
  window, stay, vehicle, route and departure, the rows, and an id made from the decisions, then opens execution. Only
  a missing site or time stops a freeze; no-go rows are shown, not hidden.
- **Execute** (`lander.html`, `lander/main.js`): flies only the frozen configuration (a link with `?site=&t=` flies a
  labelled rehearsal). No site, time, planner or vehicle inputs; a chip names the configuration and says when the Map
  has changed since. The phase strip seeks the timeline and marks the phase flown; Surface operations plays the frozen
  route on the globe (`globe.html#cfg=1`) from the touchdown of the branch flown (`lsn-flown`). The planning mission
  is never written by execution.
- **Build**: `tools/build-lander.mjs` builds `lander.html`, `planner.html` and `finalise.html` from the lander modules;
  the two new pages copy `lander.html`'s CSS at build time.
- Tests: `tests/moonlayer.test.mjs` (when the globe hands over, the scale it hands over at), `tests/mission-config.test.mjs` (the configuration, its id, storage, changes since freezing, the window,
  the route summary, the go / no-go levels), `tests/mission-flow.test.mjs` (new stages and links, the execution
  phases cover every lander phase in order), `tests/lander-flow.test.mjs` (what the execution page flies, the pages
  built). Full suite 741 tests: 725 pass, 16 skipped (data not on disk), 0 fail.
- Checked in the browser at 1440 × 900 and 375 × 812: polar map → zoom out → whole Moon → click a point (site card at
  52.5°S 45°W) → zoom in over the pole → polar map; Apollo 11 opens on the globe, choosing Shackleton flies down and
  hands over at it; Where to land → planner; Finalise → Freeze
  → Execute (phase strip, landing, surface operations with the frozen route); the phone layouts of all three steps.
- Not done: the user guide (`docs/GUIDE.md`, `docs/guide/`) still shows the old three steps and needs a re-shoot; the
  rover planner itself still needs the polar data (south of 80°S); the launch ascent is not modelled (the timeline
  starts at parking-orbit insertion).

