# The Map as the 3D Moon: what the south-pole map showed, and where it is now

Written 15 Nov 2026, 01:30 GMT. The 2D south-pole map (`ui/mapframe.js`, `map/*.js`) is no longer shown: the Map
(step 1, `index.html`) is one 3D globe (`ui/globemap.js` on `globe-view.js`) that zooms from the whole Moon down to
20 m at the south pole. This file is the inventory of the old map's information, item by item, and how the globe
carries each one. Code references are to `demo/src/`.

## How it works

- **Inside 80°S** the polar map keeps running underneath, unseen. Its view follows the ground in sight (a grid over
  the polar square projected to the screen; tilted views keep the ground near the camera's target), so it loads the
  finer terrain and the 1 km heat for exactly that ground. Everything it paints (its two canvases and its three SVG
  layers, with their computed styles written in) is copied into one picture and draped on the terrain in the globe's
  shader, in the same polar stereographic km (`globe-view.js` `setOverlay`). The terrain's own lighting stays under the
  picture as relief.
- **Input** goes the other way: a click or a drawing gesture on the globe is turned into the polar map's own pointer
  events at the same ground point (`globemap.js` `frameClient`, `send`), so its picking, snapping, hover card and
  drawing tools run unchanged on the 3D surface.
- **When the polar map moves by itself** (fit to a planned route, a story step, the Coordinates fold) the camera
  follows it.
- **Outside 80°S** the globe draws its own layers: the heat modes from the ephemeris with a smooth horizon
  (`globalheat.js`, 1° cells, 2 h steps), labels for the listed sites and 32 major named features (IAU gazetteer), the
  selected site, the terrain style and contours.

## Inventory

| Old map item | Data | On the globe |
|---|---|---|
| Hillshade base (480 m → 20 m) | polar DEM pyramid | Draped inside 80°S; the globe's own relief everywhere |
| Topo (multi-direction hillshade × height tint) | height field of the view | Draped inside 80°S; height colours of the globe outside |
| Real light (Sun at the playhead, cast shadows to 40 km) | height field, ephemeris | Draped inside 80°S (with the cast shadows); outside, the globe lit by the real Sun at the playhead (no cast shadows) |
| Heat modes: Live, Both in view, Sunlit, Earth in view, Change | 2 km and 1 km horizon grids | Draped inside 80°S (terrain skyline); outside, the same modes and colours from the ephemeris with a **smooth horizon** (labelled assumption: no terrain shadows away from the pole) |
| Suitability | slope, shadow, weights on the polar grids | Draped inside 80°S; none outside (the inputs exist only for the polar cap) |
| Filters (max slope, max dark), weights | polar grids | Inside 80°S, as before |
| Contour lines with labels | height field | Draped inside 80°S; the globe's contour shader outside (interval follows the zoom) |
| PSR outline and hatch | LOLA PSR 120 m | Draped |
| Live veil (no Sun now) | 2 km now-states | Draped inside 80°S; the Live mode outside |
| Graticule, 80°S edge, feature names | features list | Draped inside 80°S; gazetteer names outside |
| Site markers and labels, selected and alternative crosshairs | sites | Draped inside 80°S (click a site to pick it, as before); labels outside (click to pick) |
| Best cells 1–5 | heat ranking | Draped; clickable through the replayed click |
| Regions A and B (rect, circle, polygon), region best | user shapes | Drawn on the 3D surface with the same tools; draped; region card as before |
| Hand route, route candidates, slope colours, one-way, labels | route plan | Drawn with the Route tool on the surface; draped |
| Traps, havens, parking stops, empty battery, lander / landing site, waypoints, self-driving trees and trajectory, station coverage | route plan, drive, comms | Draped |
| Sun and Earth arrows, shadow line at the view centre | ephemeris | Draped |
| Snap ring, keyboard crosshair, draft shape | drawing state | Draped (refreshed every 30 ms while drawing) |
| Hover card | `describe()` | Shown by the real pointer |
| Readout line, scale bar, legend, terrain chip, Sun & Earth panel | page | Unchanged (they belong to the page, not the canvas) |
| Sky dial | site | Placed at the site's screen position on the globe; hidden when the site is out of sight |
| Wheel, drag, pinch, double-click, keyboard zoom | viewport | The globe's camera: wheel, drag to pan, right-drag or shift-drag to turn and tilt, double-click to zoom in; the map's + / − buttons zoom the camera |
| Drawing north of 80°S | — | Refused with a note: the region statistics and the rover planner need the polar terrain |

## Known limits

- The draped picture is the polar map's raster, refreshed after the camera rests (about 0.2 s) and after each repaint;
  while the camera moves, newly uncovered polar ground shows the globe's own shading until the refresh.
- Labels and arrows in the picture lie flat on the terrain: they read upright from above (the camera turns so 0°E is
  up near the pole, as on the old map) and lean with the ground when the view is tilted.
- Outside 80°S the heat modes use a smooth horizon, and Suitability, regions and routes are not available.
- No pinch zoom on the globe yet (buttons and wheel zoom).
