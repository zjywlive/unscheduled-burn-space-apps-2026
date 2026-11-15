# Package D — thermally stable ice (Diviner, Schorghofer & Williams 2020)

Read `docs/mcp-v2/briefs/COMMON.md` first, then DESIGN §2 (the "可能有水冰" row) and §10.

## What is already verified (architect, 2026-11-15)

Downloaded to `data-raw/diviner/` (git-ignored; do not re-download, no network):
`polar_south_80_zit-1.grd` (depth in m to where the sublimation loss falls to 1 kg/m²/Gyr) and
`polar_south_80_Tmax.grd` (maximum temperature after Fourier smoothing, K). Source folder:
https://luna1.diviner.ucla.edu/~jpierre/diviner/level4_polar/24x6_240m/additional_maps/ — citation:
Schorghofer, N. & Williams, J.-P. (2020), Mapping of ice storage processes on the Moon with time-dependent
temperatures, PSJ 1:54, doi:10.3847/PSJ/abb6ff.

Both are **netCDF classic** (`CDF\x01`), GMT grids: dims x = 2533, y = 2533; global attrs node_offset = 1 (pixel
registration), title "polar_south_80_24x6"; variables `x` (double, offset 268), `y` (double, offset 20532), `z`
(float32 big-endian, dims [y, x], offset 40796, 25,664,356 bytes; zit-1 valid_range 0–0.7296 m). Parse the header
properly in your reader (do not hard-code offsets) — the numbers are for checking.

x and y run −0.174908 … +0.174908 with step 0.000138158: they are polar stereographic coordinates **divided by
the lunar radius** (×1737.4 km → ±303.9 km, step 0.2400 km), i.e. r/R = 2·tan(colatitude/2), the same projection
as `terrain.js toXY` (which gives km). The 80°S circle is the grid edge. `z` rows follow the ascending `y` array
(row 0 = most negative y). **Unknown: the longitude orientation** (which direction is 0°E, and whether x is
mirrored) — determine it from the data: for each of the 8 axis flips/rotations, measure agreement between
"Tmax < 110 K" and the PSR bitmap (`ctx.psr.isPsr(x, y)`, 120 m) over the grid; the right orientation agrees far
better than the others. Report the scores. zit-1 values: NaN inside the circle = no stable ice within the
modelled depth (also NaN outside the circle); 0 = stable at the surface; > 0 = ice table depth in m (max 0.73 m
in this file, so "≤ 1 m" covers every finite value). Tmax: 46–330 K, NaN only outside the circle.

## Files you own (create or replace; edit nothing else)

- `tools/build-ice.mjs` — zero-dependency build script: read the two `.grd` files, find the orientation, write
  the packs below and `demo/data/ice.json` (source, citation, URLs, rule, orientation and its agreement scores,
  resolution, encodings, patch rule, build date).
- `demo/src/ice.js` — replace the stub; keep its documented contract exactly (header of the current file):
  `createIce({ meta, read }) → ice` with `ice.meta`, `ice.shallowMaxM`, `ice.at(x, y)`,
  `ice.distKm(cellKm, k, cls)`, `ice.nearest(x, y, { cls, withinKm, depthMaxM })`.
- `demo/data/ice.json`, `demo/data/ice_depth_240m.bin`, `demo/data/ice_tmax_240m.bin`,
  `demo/data/ice_dist_2km.bin`, `demo/data/ice_dist_1km.bin` (names may change if ice.json says so).
- `tests/ice.test.mjs`
- `README.md` — **only** add one row to the data-sources (resource) table for this dataset, matching the
  existing rows' style; nothing else in README.
- `docs/mcp-v2/reports/D-ice.md`

## Packs (suggested encodings; document whatever you choose in ice.json)

- `ice_depth_240m.bin`: Uint8 per Diviner pixel, re-oriented to the repo convention (rows top to bottom = +y to
  −y, columns −x to +x, map km = grid × 1737.4): 0 = surface-stable, 1–254 = ice table depth in cm (rounded up),
  255 = no stable ice / no data.
- `ice_tmax_240m.bin`: Uint8 = round(Tmax / 2) (2 K steps), 255 = no data.
- `ice_dist_2km.bin` / `ice_dist_1km.bin`: for each cell of the 2 km (320², halfKm 320) and 1 km (640²) grids,
  three bytes per cell (or three planes) for classes `surface`, `shallow` (depth ≤ 1 m, surface included) and
  `any`: map-plane km from the cell centre to the nearest pixel of a stable patch of that class (8-connected
  patch of at least 0.5 km² ground area, like `shadow_2km`'s rule with 1 km²), rounded, 0 when the class covers
  most of the cell, capped at 255; 255 also where there is no data. Cells north of 80°S: 255.

Class semantics used by tools (put them in ice.json and the module header): `surface` = depth 0; `shallow` =
depth ≤ depthMaxM (default 1 m, surface included: within drill reach); `any` = any finite depth.
`ice.nearest` searches the 240 m raster outwards (ring search like `point-eval.js nearestPsrPixel`) and returns
`{ xKm, yKm, latDeg, lonDeg, distKm, depthM, tmaxK, cls, patchKm2 }` or null within `withinKm`; it honours a
non-default `depthMaxM`. `ice.at(x, y)` → `{ depthM, tmaxK, cls }` (cls 'surface' | 'shallow' | 'none') or null
outside coverage.

## Tests (must pass)

- the netCDF reader on a tiny synthetic file you write in the test (header + data), incl. a NaN.
- after `loadCoreContext()` (it already loads `ice.json` + `createIce` when ice.json exists), `ctx.ice()` is not
  null; a point deep inside a big PSR crater floor near Shackleton or Haworth is `surface` with Tmax < 110 K; a
  sunlit ridge point (e.g. the `shackleton` site in `sites.json`, on the rim) is not surface-stable; `distKm` at
  that ridge for `shallow` is small (a few km) and agrees within 1 km with `nearest`.
- the orientation scores: the chosen orientation's agreement beats every other by a clear margin.
- `point-eval.js staticMetrics` with `ice: ctx.ice()` and criteria `{ ice: { class: 'shallow', within_km: 5 } }`
  at 84.82°S 24.44°E returns `ice_source: 'diviner'` and a finite `ice_target_km`.

Wording everywhere: "thermally stable, possible ice", never "ice detected" or "has ice".
