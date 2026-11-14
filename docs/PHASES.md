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
  in localStorage and carried in the links; every page has the same stage bar, 1 Site (navigator) → 2 Landing
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
