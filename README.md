# Unscheduled Burn — NASA Space Apps Challenge 2026

Team **Unscheduled Burn**, Bristol (UK) Local Event, 14–15 November 2026.

- **Challenge:** [Lunar Landing Site Navigator](https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/)
- **Demo:** _TBD_
- **Project page:** _TBD_

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
| `mcp/` | MCP server exposing the compute tools |

To run the app locally: `python3 -m http.server 8731 --directory demo`, then open http://localhost:8731/
(south-pole navigator) or http://localhost:8731/globe.html (3D global terrain).

## Team

| Name | Role | GitHub |
|---|---|---|
| _add name_ | _add role_ | [@zjywlive](https://github.com/zjywlive) |
| _add name_ | _add role_ | [@PaperPlaneLSY](https://github.com/PaperPlaneLSY) |
| _add name_ | _add role_ | [@Pro-Machine](https://github.com/Pro-Machine) |

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

**One mission, four steps.** Every page carries the same stage bar: 1 Site → 2 Landing → 3 Rover → 4 3D. The site and
landing date chosen in the navigator go with you to the lander, then back to the route card with the landing site as
the start, then to the 3D globe.

**3D (`demo/globe.html`).** A globe of the whole Moon from LOLA elevation at several levels of detail, down to
20 m at the south pole and 5–20 m around the landing sites. "Fly along in 3D" puts the planned route on it and plays the simulated rover along it.

**Lander (`demo/lander.html`).** A generic robotic lander from Earth parking orbit through lunar orbit to a
powered descent at a south-pole site: Δv and propellant budget, J2/C22 and third-body dynamics, power and
attitude, landing checks against the terrain, and contingency branches (abort to orbit, divert, wave-off, hold).
See `docs/LANDER.md`.

All vehicle, rover and radio figures are assumptions the user can change; the cards label them so. The decision
variables and their sources are listed in `docs/VARIABLES.md`, the build in `docs/PHASES.md`.

## NASA data and other resources

Every dataset, library, tool, image and piece of text used in the project is listed here,
as the submission rules require.

| Resource | Source | How we used it |
|---|---|---|
| LRO LOLA GDR global DEMs `LDEM_4`, `LDEM_16`, `LDEM_64` (4 / 16 / 64 px per degree) | NASA PDS Geosciences Node, https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ | Global terrain model: whole-Moon levels of detail at 7.6 km, 1.9 km and 474 m (`tools/build-global.mjs`) |
| LRO LOLA GDR polar DEMs `LDEM_75S_240M`, `_75S_120M`, `_80S_40M`, `_875S_20M`, `LDEM_75N_240M` | NASA PDS Geosciences Node, https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ | South-pole terrain down to 20 m; north-pole cap at 480 m |
| LRO LOLA GDR polar DEMs `LDEM_875S_5M`, `LDEM_85S_10M`, `LDEM_80S_20M` (byte ranges only) | same | 10 × 10 km patches at 5 / 10 / 20 m around each landing site (`tools/fetch-hires.mjs`), for the descent view and the globe |
| Mazarico et al. PSR and average-visibility rasters (`LPSR_75S_120M_201608`, `AVGVISIB_75S_120M_201608`, `_EARTH`) | http://imbrium.mit.edu/EXTRAS/ILLUMINATION/IMG | Permanently shadowed regions and long-term Sun/Earth visibility |
| JPL Horizons ephemeris | https://ssd.jpl.nasa.gov/api/horizons.api | Sun and Earth directions from the Moon, 2026-11 to 2029-01 |
| three.js 0.187.0 (MIT) | https://registry.npmjs.org/three/-/three-0.187.0.tgz | 3D globe rendering (`demo/vendor/three.classic.js`, see `demo/vendor/VENDOR.md`) |
| driver.js 1.10.2, deep-chat 2.5.1 (MIT) | registry.npmjs.org | Guided tour and assistant panel in the navigator |
| Jun et al., "A Rapid, Low-Cost Path to Lunar Communication and Navigation with a Lunar Surface Station", IEEE Aerospace Conference 2025 (JPL), DOI 10.1109/AERO63441.2025.11068684 | IEEE | Surface station site, mast and antenna heights, coverage radius and bands (`demo/src/comms.js`) |
| ITU-R P.526 (single knife-edge diffraction) | ITU | Diffraction loss over terrain (`demo/src/comms.js`) |
| GRAIL gravity model GRGM900C (Lemoine et al. 2014) | NASA PDS, https://pds-geosciences.wustl.edu/grail/grail-l-lgrs-5-rdr-v1/grail_1001/shadr/ | Lunar J2 and C22 in the lander dynamics |
| Orloff, *Apollo by the Numbers* (NASA SP-2000-4029); Bennett, NASA TN D-6846 | NASA | Published Apollo Δv values the lander budget is compared with |
| Grün et al. (1985), *Icarus* 62; NOAA SWPC Space Weather Scales | Icarus; https://www.swpc.noaa.gov/noaa-scales-explanation | Micrometeoroid flux and solar radiation storm levels in the lander's contingency decisions |
| Further lander references | `docs/LANDER.md` §11 | Constants, guidance and comparisons, each marked where unverified |

## Use of AI tools

As the Space Apps rules require, this section lists where and how AI tools were used.
AI-generated images or videos carry a visible watermark. No NASA logos, flags or mission
identifiers are used or generated.

| Where | Tool | How |
|---|---|---|
| Code, tests, data scripts and documentation written during the event (`demo/src/`, `tools/`, `tests/`, `docs/`) | Claude (Anthropic) through Claude Code | The team chose the challenge, set the priorities and the order of the phases, and reviewed each result; Claude wrote most of the code, tests and documents and checked the pages in headless Chrome. Commits it wrote carry a `Co-Authored-By: Claude` line. |
| The lander track (`demo/src/lander/`, `demo/lander.html`, `docs/LANDER.md`, `tests/lander-*`) | Claude (Anthropic) through Claude Code, in a separate session | Same way of working: a brief from the team, code and tests by Claude, results reviewed. |
| The pre-event visualisation MVP (12–13 Nov, see Project history) | Claude (Anthropic) through Claude Code; an OpenAI model through opencode | Claude wrote the MVP; the OpenAI model did two independent code reviews. |
| Research before the event (challenge analysis, past winners, a participant guide) | ChatGPT (OpenAI) | Background reading and summaries only; none of it is in the code. |
| The navigator's "Ask" assistant (`demo/src/agent/`) | Optional: an Anthropic or OpenAI-compatible model with the user's own API key | Answers questions with the page's own tools. By default it runs a scripted offline demo and calls no model. |
| Images and video | None | No AI-generated images or video. Every picture is rendered from NASA data by the code. |

## Running it locally

Needs Node 22 or later and Python 3 (only for a static web server); no npm install.

```sh
python3 -m http.server 8731 --directory demo
```

Then open http://localhost:8731/ (navigator), http://localhost:8731/globe.html (3D globe) or
http://localhost:8731/lander.html (lander). The pages also open straight from the files, offline.

Rebuild the pages after changing `demo/src/`:

```sh
node tools/build.mjs          # demo/index.html
node tools/build-globe.mjs    # demo/globe.html
node tools/build-lander.mjs   # demo/lander.html
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
