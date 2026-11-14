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

## Phase 2: rover mobility on real terrain

Directional (non-reversible) slopes with separate climb and descent limits, cross-slope limit,
one-way route segments ("point of no return") and trap detection for dips and valleys. Rover profile:
speed, power in watts, mass.

## Phase 3: energy along the route

Driving energy versus slope, solar generation in watts, battery state along the route, arrival times
against sunlight.

## Phase 4: communications

Surface-station viewshed (15 m mast, 2 m rover antenna, 8 km radius, from the JPL surface-station
paper), Earth, relay and station link status along the route, and signal strength in dBm (free-space
loss plus knife-edge diffraction along the terrain).

## Phase 5: contingency and navigation

Nearest safe haven from any point on the route (lit, Earth-visible, reachable within the energy and
slope limits). Comms-denied heading from the Sun and Earth position.

## Phase 6: 3D route and live position

The route ribbon drawn on the 3D terrain, a simulated rover moving along it over time, and optionally
a GRAIL gravity layer.
