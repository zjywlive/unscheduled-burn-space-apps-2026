# Unscheduled Burn — NASA Space Apps Challenge 2026

Team **Unscheduled Burn**, Bristol (UK) Local Event, 14–15 November 2026.

- **Challenge:** [Lunar Landing Site Navigator](https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/)
- **Overview (start here):** [`demo/overview.html`](https://zjywlive.github.io/unscheduled-burn-space-apps-2026/demo/overview.html): why the tool exists, the process flow, how NASA data
  becomes a plan, and small interactive models of the algorithms and the contingency rules
- **Demo:** https://zjywlive.github.io/unscheduled-burn-space-apps-2026/demo/overview.html (overview), then
  [the Map](https://zjywlive.github.io/unscheduled-burn-space-apps-2026/demo/), [Finalise](https://zjywlive.github.io/unscheduled-burn-space-apps-2026/demo/finalise.html)
  and [Execute](https://zjywlive.github.io/unscheduled-burn-space-apps-2026/demo/lander.html)
- **Video (30 s):** [ (YouTube link)_](https://www.youtube.com/watch?v=FLRYPm9GKu8)
- **User guide:** [docs/GUIDE.md](docs/GUIDE.md), with screenshots and worked use cases for every page; how NASA
  plans a lunar landing, mapped to the tool: [docs/NASA-MISSION-PLANNING.md](docs/NASA-MISSION-PLANNING.md)

## Project history

- **12–13 November 2026:** a first visualisation MVP (`demo/`, `tools/`, `tests/`, `mcp/`) was built
  before the event.
- **14 November 2026:** we raised this with the judges at the Bristol Local Event, who agreed we could
  build on that MVP as long as the hackathon work itself happens during the event.
- **From 14 November 2026, 09:00 local time:** all hackathon work. It is in this repository's commit
  history, starting with the import of the MVP.

## Repository layout

| Path | What it is |
|---|---|
| `demo/` | The web app: `index.html` (built single file), `src/` (ES modules), `data/` (terrain and ephemeris packs), `vendor/` |
| `tools/` | Zero-dependency Node build and data scripts (`node tools/build.mjs` rebuilds `demo/index.html`) |
| `tests/` | Node test suite: `node --test 'tests/*.test.mjs'` |
| `mcp/` | MCP server exposing the compute tools, site search, slip checks, the mission bridge, prompts and resources (`mcp/README.md`) |

To run the app locally: `python3 -m http.server 8731 --directory demo`, then open http://localhost:8731/overview.html
(the overview), http://localhost:8731/ (south-pole navigator) or http://localhost:8731/globe.html (3D global terrain).

## Team

| Name | Role | GitHub |
|---|---|---|
| Yinan Zhang | Developer | [@zjywlive](https://github.com/zjywlive) |
| Shiyu Luo | Tester | [@PaperPlaneLSY](https://github.com/PaperPlaneLSY) |
| Kaan Karadağ | Researcher | [@Pro-Machine](https://github.com/Pro-Machine) |
| Rushi Vibhandik | Reviewer | [@saintbridgethefirst](https://github.com/saintbridgethefirst) |
| Wantong Wu | Tester | [@1984tkr](https://github.com/1984tkr)|

## What it does

A planning tool for landing and driving at the lunar south pole, built on real NASA elevation data and the
real positions of the Sun and Earth. Everything runs in the browser, offline, from this repository.

**Landing sites (navigator, `demo/index.html`).** Pick a site and a landing date and see where the Sun and
Earth sit above the real terrain skyline, how many hours of the stay have both in view, how that changes if the
landing slips, and which nearby cells do better. Permanently shadowed regions, NASA's 18.6-year illumination
averages, slope and energy for a lander's panels are on the same map.

**Rover routes (navigator, route card).** Draw or type a route and get three candidates (shortest, flattest,
sunniest), then for the chosen one:
- *Mobility:* every move is checked against climb, descent and cross-slope limits; one-way stretches (too
  steep to drive back up), whether the rover can get back to the start at all, and trap ground it could drive
  into but not out of.
- *Energy:* the drive is simulated in time from a departure, with panel power only where the Sun clears the
  local skyline; battery along the route, parking to recharge, where the battery would run out, and a search for
  departure times that work.
- *Communications:* a surface station's coverage over the terrain (free-space loss plus knife-edge
  diffraction, following the JPL surface-station concept), Earth in view along the drive, and the gaps with no
  link at all.
- *Contingency:* the nearest safe haven (sunlit for a day, Earth in view, reachable with the battery left) from
  every 2 km of the route, and a comms-denied heading using the Sun and Earth.

**Plan before launch, then fly.** Every page carries the same stage bar: *Plan* 1 Map → 2 Finalise, then *Fly*
3 Execute. Everything is decided on the Map, which is the 3D Moon: one globe from the whole Moon down to 20 m at the south pole,
carrying the south-pole analysis (heat modes, terrain styles, contours, sites, regions, routes) on its surface,
with the drawing tools working on it ([docs/MAP-3D.md](docs/MAP-3D.md)). There the user picks the site anywhere,
the landing time and its slip, the rover route and its departure; Where to land scores landing spots near any point. Finalise (`demo/finalise.html`) checks go / no-go, takes the last change to the assumed
vehicle and freezes the configuration; Execute (`demo/lander.html`) flies exactly that configuration: launch,
spaceflight, orbital manoeuvres, lunar orbit insertion, landing, and surface operations (the planned rover drive).

**3D (`demo/globe.html`).** A globe of the whole Moon from LOLA elevation at several levels of detail, down to
20 m at the south pole and 5–20 m around the landing sites, with contour lines on request and on-screen camera
controls (pan, zoom, turn, tilt, north up; keys too). "Fly along in 3D" puts the planned route on it and plays the
simulated rover along it: a six-wheeled model that tilts with the ground (pitch, roll and yaw shown on the left,
its coordinate frames on request), a minimap with shaded terrain and contours, the elevation profile along the
bottom (click it to move the rover), the route coloured by drive state or by slope, no-go ground as red volumes,
leg distances and times, the self-driving planner's search, and a follow camera. The rover's motion can be
recorded and saved with the route. Waypoints placed on the globe go back to the navigator to be planned, and a
"Mapped" layer shows which terrain the app already has at each resolution, the ground saved drives covered, and
the areas the team marks to map next.

**Saving.** A mission (route, settings, drive simulation, terrain profile, recorded motion) is kept in the
browser and downloads as JSON, GeoJSON or CSV; saved missions load back into the navigator.

**Self-driving planner.** Besides the A* candidates, a B-RRT* planner grows two random trees per leg under the
same direction-dependent slope limits, moves a waypoint it cannot reach, and aborts after a few tries; its trees,
candidate paths and chosen trajectory show on the map and in 3D.

**Overview (`demo/overview.html`).** One page for a first-time visitor: why a polar landing site is a date as much as a
place, the three-step process, a table from each NASA dataset to the planning question it answers, three interactive
models of the algorithms on toy terrain (the skyline test, the two-stage Where to land screen, the A* route search under
slope limits), and the contingency rules (the Execute page's own decision table, and the rover's safe havens).

**Execution (`demo/lander.html`).** The frozen configuration flown by a generic robotic lander from Earth parking
orbit through lunar orbit to a powered descent at the site: Δv and propellant budget, J2/C22 and third-body
dynamics, power and attitude, landing checks against the terrain, contingency branches (abort to orbit, divert,
wave-off, hold), then the rover drive on the 3D globe. The Earth scene marks an illustrative launch site and ascent and
animates the upper-stage separation; a *What's happening* card explains each phase in plain words, and an *Earth link*
card shows line of sight, range, signal delay, path loss and link margin as the flight goes (the radio is an assumption,
labelled so). A link with `?site=…&t=…` flies a labelled rehearsal
instead. **Where to land (`demo/planner.html`)**, the Map's region level, scores a landing ellipse and finds better
spots near any point on the Moon. See `docs/LANDER.md`.

All vehicle, rover and radio figures are assumptions the user can change; the cards label them so. The decision
variables and their sources are listed in `docs/VARIABLES.md`, the build in `docs/PHASES.md`. How to use every page
is in the [user guide](docs/GUIDE.md) ([glossary](docs/guide/glossary.md), [FAQ](docs/guide/faq.md)), and how NASA
plans a landing in [docs/NASA-MISSION-PLANNING.md](docs/NASA-MISSION-PLANNING.md).

## NASA data and other resources

Every dataset, library, tool, image and piece of text used in the project is listed here,
as the submission rules require.

| Resource | Source | How we used it |
|---|---|---|
| LRO LOLA GDR global DEMs `LDEM_4`, `LDEM_16`, `LDEM_64` (4 / 16 / 64 px per degree) | NASA PDS Geosciences Node, https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ | Global terrain model: whole-Moon levels of detail at 7.6 km, 1.9 km and 474 m (`tools/build-global.mjs`) |
| LRO LOLA GDR polar DEMs `LDEM_75S_240M`, `_75S_120M`, `_80S_40M`, `_875S_20M`, `LDEM_75N_240M` | NASA PDS Geosciences Node, https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ | South-pole terrain down to 20 m; north-pole cap at 480 m |
| LRO LOLA GDR polar DEMs `LDEM_875S_5M`, `LDEM_85S_10M`, `LDEM_80S_20M` (byte ranges only) | same | 10 × 10 km patches at 5 / 10 / 20 m around each landing site (`tools/fetch-hires.mjs`), for the descent view and the globe |
| Mazarico et al. PSR and average-visibility rasters (`LPSR_75S_120M_201608`, `AVGVISIB_75S_120M_201608`, `_EARTH`) | http://imbrium.mit.edu/EXTRAS/ILLUMINATION/IMG | Permanently shadowed regions and long-term Sun/Earth visibility |
| Diviner south-pole ice-table depth and maximum-temperature grids (`polar_south_80_zit-1.grd`, `polar_south_80_Tmax.grd`); Schorghofer & Williams (2020), PSJ 1:54, DOI 10.3847/PSJ/abb6ff | UCLA Diviner, https://luna1.diviner.ucla.edu/~jpierre/diviner/level4_polar/24x6_240m/additional_maps/ | Thermally stable, possible ice: 240 m surface / shallow stability, temperature and distances to patches ≥ 0.5 km² (`tools/build-ice.mjs`); thermal modelling, not a detection |
| JPL Horizons ephemeris | https://ssd.jpl.nasa.gov/api/horizons.api | Sun and Earth directions from the Moon, 2026-11 to 2029-01 |
| three.js 0.187.0 (MIT) | https://registry.npmjs.org/three/-/three-0.187.0.tgz | 3D globe rendering (`demo/vendor/three.classic.js`, see `demo/vendor/VENDOR.md`) |
| driver.js 1.10.2, deep-chat 2.5.1 (MIT) | registry.npmjs.org | Guided tour and assistant panel in the navigator |
| Jun et al., "A Rapid, Low-Cost Path to Lunar Communication and Navigation with a Lunar Surface Station", IEEE Aerospace Conference 2025 (JPL), DOI 10.1109/AERO63441.2025.11068684 | IEEE | Surface station site, mast and antenna heights, coverage radius and bands (`demo/src/comms.js`) |
| ITU-R P.526 (single knife-edge diffraction) | ITU | Diffraction loss over terrain (`demo/src/comms.js`) |
| GRAIL gravity model GRGM900C (Lemoine et al. 2014) | NASA PDS, https://pds-geosciences.wustl.edu/grail/grail-l-lgrs-5-rdr-v1/grail_1001/shadr/ | Lunar J2 and C22 in the lander dynamics |
| Orloff, *Apollo by the Numbers* (NASA SP-2000-4029); Bennett, NASA TN D-6846 | NASA | Published Apollo Δv values the lander budget is compared with |
| Grün et al. (1985), *Icarus* 62; NOAA SWPC Space Weather Scales | Icarus; https://www.swpc.noaa.gov/noaa-scales-explanation | Micrometeoroid flux and solar radiation storm levels in the lander's contingency decisions |
| SLDEM2015 (LOLA merged with SELENE/Kaguya Terrain Camera; Barker et al. 2016, *Icarus* 273), 512 px/deg tiles, byte ranges only; LOLA polar `LDEM_{875,85,80,75,60}N_*` and `LDEM_75S_30M`, `LDEM_60S_60M` for `--at` | NASA PDS Geosciences Node, https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/sldem2015/tiles/float_img/ and …/lola_gdr/polar/img/ | `tools/fetch-hires.mjs --at lat,lon`: a fine patch anywhere (59 m between 60°S and 60°N); the 4 × 4 km patch at Apollo 11 is the lander's finest terrain there |
| IAU/USGS Gazetteer of Planetary Nomenclature (Moon; LOLA 2011 control-network centres and diameters) | https://planetarynames.wr.usgs.gov (accessed 2026-11-14; one feature page per entry in `demo/src/lander/gazetteer.js`) | Names and positions of 32 major maria, craters and basins on the lander planner's whole-Moon map |
| Further lander references | `docs/LANDER.md` §11 | Constants, guidance and comparisons, each marked where unverified |
| NASA programme documents (Systems Engineering Handbook, Artemis landing-region releases, NTRS papers, Lunar Surface Data Book, CLPS and LRO pages) | Listed with links in `docs/NASA-MISSION-PLANNING.md` §9 | Background for the user guide's mission-planning chapter; summarised, not used as data |

## Use of AI tools

As the Space Apps rules require, this section lists where and how AI tools were used.
AI-generated images or videos carry a visible watermark. No NASA logos, flags or mission
identifiers are used or generated.

| Where | Tool | How |
|---|---|---|
| Code, tests, data scripts and documentation written during the event (`demo/src/`, `tools/`, `tests/`, `docs/`) | Claude (Anthropic) through Claude Code | The team chose the challenge, set the priorities and the order of the phases, and reviewed each result; Claude wrote most of the code, tests and documents and checked the pages in headless Chrome. Commits it wrote carry a `Co-Authored-By: Claude` line. |
| The lander track (`demo/src/lander/`, `demo/lander.html`, `docs/LANDER.md`, `tests/lander-*`) | Claude (Anthropic) through Claude Code, in a separate session | Same way of working: a brief from the team, code and tests by Claude, results reviewed. |
| MCP v2 (15 Nov): search, slip and landing-window tools, the mission bridge and the Diviner ice packs (`demo/src/search.js`, `demo/src/tools-v2/`, `demo/src/mission-io.js`, `demo/src/ice.js`, `tools/build-ice.mjs`, their tests; design and briefs in `docs/mcp-v2/`) | Claude (Anthropic) through Claude Code; an OpenAI model (gpt-6-astra) through opencode | Claude wrote the design, the shared modules (`criteria.js`, `point-eval.js`, the MCP prompts and resources) and a brief per package; the OpenAI model implemented the four packages and their tests from those briefs; Claude reviewed, fixed and integrated them and ran the tests and a real MCP client end to end. |
| The pre-event visualisation MVP (12–13 Nov, see Project history) | Claude (Anthropic) through Claude Code; an OpenAI model through opencode | Claude wrote the MVP; the OpenAI model did two independent code reviews. |
| Research before the event (challenge analysis, past winners, a participant guide) | ChatGPT (OpenAI) | Background reading and summaries only; none of it is in the code. |
| The navigator's "Ask" assistant (`demo/src/agent/`) | Optional: an Anthropic or OpenAI-compatible model with the user's own API key | Answers questions with the page's own tools. By default it runs a scripted offline demo and calls no model. |
| The overview page and the Execute page's launch, stage-separation, explanation and Earth-link additions (15 Nov evening: `demo/overview.html`, `demo/src/lander/explain.js`, `link.js`, `view-earth.js`, `model.js`) | Claude (Anthropic) through Claude Code | Written by Claude from the team's list of judging feedback; checked by the tests and in the browser. |
| The 30-second demo video | Claude (Anthropic) through Claude Code | Edited by code from real captures of the app; the soundtrack is synthesised by a script. The video carries a visible "created by AI (Claude Code)" mark. |
| Images | None | No AI-generated images. Every picture in the app is rendered from NASA data by the code. |

## Running it locally

Needs Node 22 or later and Python 3 (only for a static web server); no npm install.

```sh
python3 -m http.server 8731 --directory demo
```

Then open http://localhost:8731/ (step 1, the Map). Finalise (`finalise.html`) and Execute (`lander.html`) follow
from its stage bar; the 3D globe is http://localhost:8731/globe.html. The pages also open straight from the files,
offline.

Rebuild the pages after changing `demo/src/`:

```sh
node tools/build.mjs          # demo/index.html
node tools/build-globe.mjs    # demo/globe.html
node tools/build-lander.mjs   # demo/lander.html, planner.html, finalise.html
```

Run the tests:

```sh
node --test 'tests/*.test.mjs'
```

The 474 m global terrain tiles are not in the repository (about 425 MB). To add them (the globe falls back to
1.9 km without them):

```sh
node tools/fetch-global.mjs   # about 595 MB from NASA PDS into data-raw/
node tools/build-global.mjs --g2
```

## License

MIT, see [LICENSE](LICENSE).
