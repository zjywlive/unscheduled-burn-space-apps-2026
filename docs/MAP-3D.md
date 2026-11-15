# The Map as the 3D Moon: what the south-pole map showed, and where it is now

Written 15 Nov 2026, 01:30 GMT. The 2D south-pole map (`ui/mapframe.js`, `map/*.js`) is no longer shown: the Map
(step 1, `index.html`) is one 3D globe (`ui/globemap.js` on `globe-view.js`) that zooms from the whole Moon down to
20 m at the south pole. This file is the inventory of the old map's information, item by item, and how the globe
carries each one. Code references are to `demo/src/`.

## How it works

- **The terrain is the globe's own everywhere** (one mesh, one lighting, one palette across 80°S, as on Google Moon):
  Data = grey, Topo = the polar map's height tint, and in Real light, or whenever "Light at the playhead" is on, the
  real Sun at the playhead with cast shadows (a shadow map fitted to the ground in view; true relief, 1×), so the
  shadows move with the time over the whole Moon.
- **Inside 80°S** the polar map keeps running underneath, unseen, painting only its layers (`mapframe.js`
  `setDrapeOnly`: no base, no styled terrain, no contours). Its view follows the ground in sight (a grid over the polar
  square projected to the screen; tilted views keep the ground near the camera's target), so it loads the finer
  terrain and the 1 km heat for exactly that ground. Its canvas and two SVG layers (computed styles written in) are
  copied into one picture, refreshed with every repaint and every half hour of playhead time, and draped on the
  terrain in the globe's shader in the same polar stereographic km (`globe-view.js` `setOverlay`), feathered over the
  last 1.5° to 80°S.
- **Input** goes the other way: a click or a drawing gesture on the globe is turned into the polar map's own pointer
  events at the same ground point (`globemap.js` `frameClient`, `send`), so its picking, snapping, hover card and
  drawing tools run unchanged on the 3D surface.
- **When the polar map moves by itself** (fit to a planned route, a story step, the Coordinates fold) the camera
  follows it.
- **Outside 80°S** the globe draws its own layers: the heat modes from the ephemeris with a smooth horizon
  (`globalheat.js`, 1° cells, 2 h steps; Live per pixel in the shader), fading out between 74°S and 80°S where the
  terrain, not a smooth horizon, decides what is lit; labels for the listed sites and 32 major named features (IAU
  gazetteer), the selected site; contours from the globe's shader everywhere (ink per terrain style).

## Inventory

| Old map item | Data | On the globe |
|---|---|---|
| Hillshade base (480 m → 20 m) | polar DEM pyramid | The globe's own relief and lighting everywhere (the polar pyramid feeds the globe's south cap) |
| Topo (multi-direction hillshade × height tint) | height field of the view | The same tint on the globe's terrain everywhere |
| Real light (Sun at the playhead, cast shadows to 40 km) | height field, ephemeris | The globe lit by the real Sun with cast shadows (shadow map), everywhere |
| Heat modes: Live, Both in view, Sunlit, Earth in view, Change | 2 km and 1 km horizon grids | Draped inside 80°S (terrain skyline); outside, the same modes and colours from the ephemeris with a **smooth horizon** (labelled assumption: no terrain shadows away from the pole) |
| Suitability | slope, shadow, weights on the polar grids | Draped inside 80°S; none outside (the inputs exist only for the polar cap) |
| Filters (max slope, max dark), weights | polar grids | Inside 80°S, as before |
| Contour lines with labels | height field | The globe's contour shader everywhere (interval follows the zoom; no height labels) |
| PSR outline and hatch | LOLA PSR 120 m | Draped |
| Live veil (no Sun now); Live mode and no mission window | 2 km now-states | Real lighting: the globe is lit by the real Sun at the playhead with cast shadows, everywhere. In Live (or with no mission window) no Sun / Earth colours are drawn, inside 80°S or out: a smooth horizon outside the polar data would fill half-Moons with straight edges, and the cap alone in colour reads as a disc. The readout and hover card still give the cell's Sun and Earth state |
| Graticule | — | Drawn by the globe's shader over the whole Moon, the polar cap included; spacing 30° / 10° / 5° / 1° / 0.5° with the zoom; degree labels along the lines through the view centre; Layers → Graticule |
| Feature names | polar features list, IAU gazetteer | Screen labels over the whole Moon (the polar map's 12 polar craters, 32 major features elsewhere), upright at any tilt, shown while the feature is 30 px to a view across, decluttered by size; Layers → Site and feature names |
| Site markers and labels | sites | Screen labels for every listed site (click to pick it), decluttered after the selected site; snapping to sites in clicks and drawing is unchanged; Layers → Site and feature names |
| Selected and alternative crosshairs | state | Draped |
| Best cells 1–5 | heat ranking | Draped; clickable through the replayed click |
| Regions A and B (rect, circle, polygon), region best | user shapes | Drawn on the 3D surface with the same tools by clicks (rect and circle: two clicks; polygon: a click per corner), so a drag always pans; draped; region card as before |
| Hand route, route candidates, slope colours, one-way, labels | route plan | Drawn with the Route tool on the surface (click per point, Enter or double-click to finish, Backspace, Esc; a drag pans) and planned at once, as pressing Plan routes; drawn by the globe itself, not draped: the hand route as a white ribbon along great circles between its points (`globe-view.js onGc`; interpolating latitude and longitude bent it along the parallels), the other candidates as 3 px strips (Flattest dashed, Sunniest dotted), the chosen route as a 5 px ribbon, all on top of the terrain at the same width at every zoom. A plan that finds nothing says so in the action bar where the routes would be ("No route · leg 3", the full reason on hover and in the card) |
| Traps, havens, parking stops, empty battery, lander / landing site, waypoints, self-driving trees and trajectory, station coverage | route plan, drive, comms | Draped |
| Sun and Earth arrows, shadow line at the view centre | ephemeris | Left out (they belong to the polar map's view centre); the sky dial shows the directions at the site |
| Snap ring, keyboard crosshair, draft shape | drawing state | Draped (refreshed every 30 ms while drawing) |
| Hover card | `describe()` | Shown by the real pointer |
| Readout line, scale bar, legend, terrain chip, Sun & Earth panel | page | The page's own: the Sun & Earth panel above the terrain chip at the window's left edge (right of the site list when it is open), the slope legend beside them; the route profile above ends short of them |
| Sky dial | site | Placed at the site's screen position on the globe; hidden when the site is out of sight. Dimmed (and letting clicks through) while a drawing tool or the Route / Region panel is on, never hidden by them. Its on / off button sits in the tool column's View group with **North up**, so both are on screen whatever the panel |
| Wheel, drag, pinch, double-click, keyboard zoom | viewport | The globe's camera: wheel; a drag grabs the globe and turns it about its centre, Google Earth style (the point under the cursor stays under it, over the poles too, and the heading follows the turn; `globe-view.js turnGlobe`); right-drag or shift-drag to turn and tilt, double-click to zoom in; the map's + / − buttons zoom the camera, its zoom readout (1×) returns to the polar map's 1× scale, and **North up** in the tool column puts true north at the top (at any latitude) looking straight down. On the 3D globe page the compass and N reset the heading |
| Rover routes north of 80°S | global LOLA 474 m | The Route tool draws on the globe anywhere (snaps to listed sites). A route with a point north of 80°S is planned by the same planner (A* candidates, directional limits, one-way stretches, traps) on the global terrain in a local frame that turns the sphere so the route's centre sits at the south pole, where the planner's stereographic formulas hold exactly (`localframe.js`); the sunny candidate and the drive use the ephemeris Sun over a smooth horizon (assumed); no PSR or havens there (polar data). Drawn on the globe as a ribbon; Fly along in 3D, Finalise and Execute take it as any route |
| The rover route across pages | route plan | Kept in the browser (`lsn-route-plan`, mission-flow.js) as well as the hash: a Map link without a route (the 3D globe's **← Back to route planning**, a stage link) brings the last one back, planned again with the chosen candidate. It goes only when the user clears it or draws a new one. The 3D globe opened from the route card (3D, Fly) is a new tab; its back button closes it and returns to the Map's tab, or loads the Map when it cannot close |
| Focus by clicking | regions, routes | With the Select tool a click within 8 px of a region's outline (A or B, polar or latitude/longitude) or of a route turns the panel to it instead of picking a point: the region's slot becomes the current one and the coordinates form shows its shape; a candidate route clicked becomes the chosen one. The pointer turns to a hand over them; the focused latitude/longitude region is drawn bright, the other dimmed |
| Regions north of 80°S | ephemeris, smooth horizon | Clicked out on the globe itself and kept in latitude and longitude (`georegion.js`; hash `grect:` / `gcircle:` / `gpoly:`): a box from two corners, a cap from its centre and an edge point, a polygon with great-circle edges. The region card reads them over a **smooth horizon** (assumed, no terrain shadows; labelled under the table), on about 3,000 cells; Passes filters and Suitability show — (polar grids only); Best cell picks a point. A shape started north of 80°S stays on the globe even where it reaches into the cap |

## Known limits

- The draped picture is the polar map's raster, refreshed after the camera rests (about 0.2 s) and after each repaint;
  while the camera moves, newly uncovered polar ground shows the globe's own shading until the refresh.
- Labels and arrows in the picture lie flat on the terrain: they read upright from above (the camera turns so 0°E is
  up near the pole, as on the old map) and lean with the ground when the view is tilted.
- Outside 80°S the heat modes use a smooth horizon, Suitability and regions are not available, and routes are planned on the global 474 m terrain without PSR or havens.
- No pinch zoom on the globe yet (buttons and wheel zoom).
