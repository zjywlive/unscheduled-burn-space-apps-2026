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
| _TBD_ | | |

## What it does

_TBD_

## NASA data and other resources

Every dataset, library, tool, image and piece of text used in the project is listed here,
as the submission rules require.

| Resource | Source | How we used it |
|---|---|---|
| LRO LOLA GDR global DEMs `LDEM_4`, `LDEM_16`, `LDEM_64` (4 / 16 / 64 px per degree) | NASA PDS Geosciences Node, https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ | Global terrain model: whole-Moon levels of detail at 7.6 km, 1.9 km and 474 m (`tools/build-global.mjs`) |
| LRO LOLA GDR polar DEMs `LDEM_75S_240M`, `_75S_120M`, `_80S_40M`, `_875S_20M`, `LDEM_75N_240M` | NASA PDS Geosciences Node, https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ | South-pole terrain down to 20 m; north-pole cap at 480 m |
| Mazarico et al. PSR and average-visibility rasters (`LPSR_75S_120M_201608`, `AVGVISIB_75S_120M_201608`, `_EARTH`) | http://imbrium.mit.edu/EXTRAS/ILLUMINATION/IMG | Permanently shadowed regions and long-term Sun/Earth visibility |
| JPL Horizons ephemeris | https://ssd.jpl.nasa.gov/api/horizons.api | Sun and Earth directions from the Moon, 2026-11 to 2029-01 |
| three.js 0.187.0 (MIT) | https://registry.npmjs.org/three/-/three-0.187.0.tgz | 3D globe rendering (`demo/vendor/three.classic.js`, see `demo/vendor/VENDOR.md`) |
| driver.js 1.10.2, deep-chat 2.5.1 (MIT) | registry.npmjs.org | Guided tour and assistant panel in the navigator |

## Use of AI tools

As the Space Apps rules require, this section lists where and how AI tools were used.
AI-generated images or videos carry a visible watermark. No NASA logos, flags or mission
identifiers are used or generated.

| Where | Tool | How |
|---|---|---|
| _TBD_ | | |

## Running it locally

_TBD_

## License

MIT, see [LICENSE](LICENSE).
