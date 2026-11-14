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

To run the app locally: `python3 -m http.server 8731 --directory demo`, then open http://localhost:8731/.

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
| _TBD_ | | |

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
