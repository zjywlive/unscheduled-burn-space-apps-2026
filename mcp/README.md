# Lunar Site Navigator MCP

A zero-dependency, tools-only MCP server for the same stateless calculations used by Lunar Site Navigator. It reads the repository's local data, needs no browser or API key, and writes no user data. Node built-ins only; tested only on Node 26.0.0 (other versions not tried).

## Who this is for

- Mission planners who work in their own AI assistant with their own material at hand (a slip notice, battery figures) and want the Navigator's numbers without opening the page.
- People who need batch sweeps: many sites × many landing dates in one call, instead of clicking through scenarios.
- Developers who want the calculations as plain functions with JSON in and JSON out.

## Run

From the repository root:

```sh
node mcp/server.mjs
```

The server waits for newline-delimited JSON-RPC on stdin. Stdout contains protocol messages only; diagnostics go to stderr. Closing stdin drains accepted requests and exits.

For an end-to-end demonstration and transport tests:

```sh
node mcp/try.mjs
node mcp/try.mjs --full
node --test tests/mcp-server.test.mjs
```

The demonstration handshakes, lists tools, compares Shackleton ridge / IM-2 Athena / Haworth for 14-day stays on 13 and 27 January 2027, finds the next sunset and Earthset at 89.3°S 137.3°W from 13 January 2027 00:00 UTC, ranks IM-2 landing dates, and asks `open_in_navigator` for a link to the IM-2 plan-versus-slip view. Default output selects useful result fields; `--full` includes every result field and its units, resolution and limitations.

## Client configuration

Each client starts `node` with the server path. Data paths are relative to the server module, so the client's working directory does not matter for data. If the client cannot find Node, replace `node` with its absolute path (`which node`). Set `LSN_PAGE_URL` (see `open_in_navigator`) in the client's environment block if links should point somewhere other than this repository's `demo/index.html`.

**Claude Code, project scope.** The repository root already has `.mcp.json`:

```json
{
  "mcpServers": {
    "lunar-site-navigator": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR:-.}/mcp/server.mjs"]
    }
  }
}
```

Claude Code asks for approval before using project-scoped servers in interactive sessions. `${CLAUDE_PROJECT_DIR:-.}` follows the documented form for project `.mcp.json` entries (the variable is set only in the server's environment, so the default is required); with the default, the path is relative to the directory Claude Code starts the server in, which the documentation does not state for stdio servers (not verified). Docs: <https://code.claude.com/docs/en/mcp> (sections "Option 3: Add a local stdio server", "Project scope", "Environment variable expansion in `.mcp.json`").

**Claude Desktop.** Add an entry to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart Claude Desktop. Use an absolute path:

```json
{
  "mcpServers": {
    "lunar-site-navigator": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/NASA2026/mcp/server.mjs"]
    }
  }
}
```

Docs: <https://modelcontextprotocol.io/docs/develop/connect-local-servers>. No script in this repository writes this file.

**opencode.** The repository root's `opencode.json` has:

```json
{
  "mcp": {
    "lunar-site-navigator": {
      "type": "local",
      "command": ["node", "mcp/server.mjs"],
      "cwd": ".",
      "enabled": true
    }
  }
}
```

This is the V1 configuration format (opencode 1.x). The V2 documentation groups servers under `mcp.servers` and replaces `enabled` with `disabled`, and its migration guide says V1 `mcp` members are still recognised. Docs: V1 <https://opencode.ai/v1/docs/mcp-servers/>, V2 <https://opencode.ai/docs/mcp-servers/>, migration <https://opencode.ai/docs/migrate-v1/>. `cwd` relative paths resolve from the workspace (both versions). With opencode 2, if the V1 form is not picked up, use:

```json
{ "mcp": { "servers": { "lunar-site-navigator": { "type": "local", "command": ["node", "mcp/server.mjs"], "cwd": "." } } } }
```

## Three-step demonstration

Say these to a connected assistant (each step uses the previous answer):

1. "Our landing at IM-2 Athena on 13 January 2027 has slipped two weeks, to 27 January. Our battery holds 30 hours of average load and the panels are rated 1.5 × the load. What do we lose?" (expect `energy_summary` with `alternative`, possibly `site_summary`; battery and panel figures are reported as assumptions)
2. "Compare that with Shackleton ridge and Haworth on both dates, 14-day stays." (expect one `compare_scenarios` call: 3 places × 2 landings)
3. "Open the map so I can see the difference." (expect `open_in_navigator` with `mode: "change"`; the link opens the page on that site with the 14-day slip as the alternative)

## Protocol

Implements **MCP 2025-11-25**, the last initialization-based revision, with `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. The only advertised capability is `{ "tools": {} }`. The `initialize` result carries `instructions`: coverage, UTC, the site id table (generated from `demo/data/sites.json`, the only file read at handshake), the 24-scenario batch limit with a split example, which inputs are assumptions, and that results are first-look screening. An unsupported requested version receives `2025-11-25` as a counteroffer; a client unable to use that version must disconnect.

The current **2026-07-28** revision uses per-request metadata and `server/discover` instead of this handshake. This server intentionally implements the task's initialization-based interface. A modern-only client is incompatible; a dual-era client can fall back to the legacy handshake.

The twelve compute tool definitions are generated from `core.specs()` at runtime, mapping `input_schema` to `inputSchema`, with read-only, idempotent, non-destructive, closed-world hints. All tools fit in one page; no cursor is issued. Results include identical JSON in a text block and `structuredContent`. Core `{ error }` results (and invalid `open_in_navigator` input) become `isError: true`; malformed call envelopes and unknown tool names are protocol errors.

Context loading is deferred until the first tool list or call. Missing required data produces a diagnostic naming the data location and underlying file error: `tools/list` returns `-32603`, while `tools/call` returns an error tool result. Failed loads can be retried. Optional data follows the existing loader's behavior: missing terrain uses a labelled smooth horizon, and dependent tools report unavailable data rather than invent values. The 240 m DEM remains lazy.

Requests execute serially; tool calls are limited to 60 per second per process. Rate-limit errors use `-32000`. Unknown notifications are ignored without a reply. Cancellation does not interrupt an ongoing computation; no progress, task execution, resource, prompt, sampling, HTTP or authorization extension is offered. The subprocess's local OS permissions control data access. This is not a general JSON Schema validator: argument validation uses the existing core's schema subset.

## Tools

| Name | Purpose |
| --- | --- |
| `list_sites` | Curated site IDs, coordinates and terrain coverage |
| `site_summary` | Sun / Earth visibility and darkness during one or more stays |
| `compare_scenarios` | Common-duration comparisons, baseline differences and rankings |
| `rise_set_events` | Sun / Earth rise and set events within a time range |
| `next_events` | Next rises / sets and countdowns from an instant |
| `sky_at` | Sun / Earth azimuth, elevation and terrain clearance |
| `skyline` | Terrain horizon profile at a point |
| `best_landing_dates` | Landing dates ranked by simultaneous Sun / Earth visibility |
| `point_facts` | Height, slope, permanent shadow and long-term visibility averages |
| `energy_summary` | Relative battery / panel assessment under supplied assumptions |
| `relay_coverage` | Coverage under an assumed illustrative relay orbit |
| `route_candidates` | Shortest, flattest and sunniest candidate rover routes |
| `open_in_navigator` | A link that opens the web page on a place, landing, stay, slip, map mode, playhead and detail-sheet tab (MCP server only; computes nothing) |

`open_in_navigator` returns `{ url, opens }`, where `opens` is one sentence describing what the page shows. The hash is written by the page's own `demo/src/state.js` `toHash` and read back with `parseHash`; anything the page would read differently is a tool error. The page address is `LSN_PAGE_URL` when set, otherwise the `file://` URL of `demo/index.html` next to this server. The standalone MCP package does not contain the page: set `LSN_PAGE_URL` to wherever the web page lives (for example the unzipped v5 package's `lunar-site-navigator.html`); otherwise `opens` says the page file was not found.

Use `tools/list` for current input schemas. Place arguments accept `site_id` or `lat_deg` plus `lon_deg`, including `"89.3S"` and `"137.3W"`. Dates are UTC.

## Standalone package

`node tools/package-mcp.mjs` writes `dist/lunar-site-navigator-mcp.zip` with one folder, `lunar-site-navigator-mcp/`, keeping repository-relative paths: this folder, `tools/core-context.mjs`, the `demo/src` modules the server imports (computed from the import graph) and the raw data files `core-context.mjs` reads (from its `ctx.files`). After unzipping, run `node mcp/server.mjs` inside that folder. The script unpacks the zip to a temporary folder, checks every file byte for byte, runs `node mcp/try.mjs` there, prints the file count, size and sha256, and refuses to write any other zip name.

## Limits

- Terrain coverage: **80°S to the pole**. Ephemeris-only tools also accept points farther north, explicitly using a smooth 0° horizon there.
- Ephemeris coverage: **1 November 2026 – 1 January 2029**. Landing must precede the end; stays exceeding the end are clipped and labelled. Requested stays are 1–60 days.
- Visibility is the centre of the Sun / Earth above the local skyline. Results include sampling resolution and modelling conventions in `about`; they are rapid planning comparisons, not certified landing analyses.
- Energy inputs (panel attitude, power/load ratio, battery, sleep load) and relay orbit / minimum elevation are **assumptions**, not observed mission data. Rover routes are terrain sketches, not trafficability verification.
- Best-date ranking uses the landing-date strip's sampling; `exact` rechecks selected dates with the finer visibility scan.

## Official specification

- [Current revision](https://modelcontextprotocol.io/specification/latest)
- [2026-07-28 versioning and legacy interoperability](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle)
- [2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [2025-11-25 stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio)
- [2025-11-25 tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [2025-11-25 base messages](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- [Authoritative JSON schema](https://raw.githubusercontent.com/modelcontextprotocol/specification/main/schema/2025-11-25/schema.json)
