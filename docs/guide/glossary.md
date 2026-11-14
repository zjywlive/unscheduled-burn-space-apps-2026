# Glossary

Plain-word meanings of the terms the tool and the docs use. **Back to the [guide](../GUIDE.md).**

| Term | What it means here |
|---|---|
| **Azimuth (az)** | Compass direction of the Sun or Earth, measured clockwise from north: 0° north, 90° east, 180° south, 270° west. At the south pole every direction is "north", so the tool uses the map's grid north (towards 0° longitude). |
| **Elevation (el)** | Height of the Sun or Earth above the flat horizon, in degrees. "Over skyline" means above the real terrain skyline in that direction instead. |
| **Skyline / terrain horizon** | The outline of hills and crater rims seen from a point, as an angle for every compass direction. The tool computes it from LOLA heights. The Sun is "up" only when it is above the skyline, not just above 0°. |
| **LOLA** | Lunar Orbiter Laser Altimeter on NASA's Lunar Reconnaissance Orbiter (LRO). Its height maps (DEMs) are the terrain for every page. |
| **DEM** | Digital elevation model: a grid of heights. The tool uses LOLA DEMs from 7.6 km pixels (whole Moon) down to 5 m pixels (around the listed south-pole sites). |
| **Resolution / pixel size** | The ground size of one DEM cell. A 240 m cell cannot show a 2 m rock, which is why slopes say "on the 240 m grid". |
| **PSR** | Permanently shadowed region: ground where the Sun never shines, mostly crater floors near the poles. Cold enough to trap water ice. The tool's map is Mazarico et al. 2011 (2016 update, 120 m). |
| **Persistent shadow** | The tool's own term in Suitability mode: cells where the Sun never clears the horizon between Nov 2026 and Jan 2029. Not the same as an official PSR. |
| **18.6-year average** | NASA's long-term share of time a place sees the Sun (or Earth), averaged over the Moon's 18.6-year orbital cycle. |
| **Libration** | The Moon's slight wobble as seen from Earth. It moves the sub-Earth point a few degrees, so Earth rises and sets at the pole. |
| **Sub-Earth point / subsolar point** | The place on the Moon where Earth (or the Sun) is straight overhead. The subsolar latitude swings about ±1.5° over a year. |
| **Sunlit / Earth in view / Both in view** | Hours (or share) of the stay with the Sun, Earth or both above the skyline. "Both" matters for solar power plus a direct radio link. |
| **Stay** | How long the mission stays on the surface after landing: 7, 14 or 30 days in the navigator. |
| **Slip** | A delay of the landing date. The navigator compares the planned landing with a slipped one ("+14 d"). |
| **Alternative** | A second scenario to compare with: the same site later (the slip) or another site. |
| **Mission window** | The time between landing (In) and the end of the stay (Out), shown on the time bar. |
| **Playhead** | The current time on the time bar. Live mode, the sky dial and Real light follow it. |
| **Best cells** | The top five map cells for the current mode, at least 20 km apart. |
| **Suitability score** | A weighted mix of sunlight (40), Earth (30), gentle slope (20) and nearness to persistent shadow (10). The weights are ours and adjustable. |
| **Climb / descent / across limit** | The rover's assumed steepest uphill (15°), downhill (20°) and sideways (12°) slope. |
| **One-way stretch** | Ground the rover can drive down but not back up (steeper downhill than the climb limit). Orange on the map. |
| **Trap** | Ground the rover could drive into but not out of, toward either the end or the start. Red on the map. |
| **Safe haven** | A place within 10 km that has the Sun on arrival and for the next 24 h, Earth in view and gentle ground, and that the battery left can reach. |
| **Dead reckoning** | Navigating by heading and distance only (no radio fix). The tool assumes 2 % drift. |
| **A\*** | A classic shortest-path search on a grid. It finds the three route candidates. |
| **B-RRT\*** | Bidirectional rapidly-exploring random tree, with rewiring. A planner that grows two random trees of possible moves, one from each end of a leg, joins them and keeps improving the connection. The tool's "Self-driving planner". |
| **Knife-edge diffraction** | How a radio signal bends over a ridge and loses strength (ITU-R P.526). The comms model uses the strongest ridge between the station and the rover. |
| **dBm** | Radio power on a log scale: −70 dBm is strong, −110 dBm is the assumed weakest usable signal. |
| **Surface station** | A radio mast on the ground that rovers talk to, from the JPL concept (Jun et al. 2025): 15 m mast on the Connecting Ridge. |
| **Relay** | A satellite orbiting the Moon that passes messages between the surface and Earth. The tool's relay orbits are examples. |
| **Δv (delta-v)** | The change in velocity an engine burn gives, in m/s. Mission planners budget fuel in Δv. |
| **TLI** | Trans-lunar injection: the burn that sends a spacecraft from Earth orbit towards the Moon. |
| **LOI** | Lunar orbit insertion: the braking burn into orbit around the Moon. |
| **DOI** | Descent orbit insertion: a small burn that lowers the orbit's low point to about 15 km, where the powered descent starts. |
| **PDI** | Powered descent initiation: the start of the main braking burn down to the surface. |
| **High gate / low gate** | Descent milestones: high gate (about 2 km up here) where the lander pitches up to see the site, low gate (30 m here) where the vertical final descent begins. |
| **NRHO** | Near-rectilinear halo orbit: the long, thin, 6.5-day orbit planned for Gateway. NASA dropped it as the landers' meeting point in October 2026. The tool uses a 100 km polar orbit instead. |
| **Patched conics** | Treating the trip as an Earth orbit, then a Moon orbit, joined at the point where the Moon's gravity takes over. A standard first approximation. |
| **J2, C22** | The two biggest terms that describe the Moon's uneven gravity, from the GRAIL mission. |
| **Landing ellipse (3σ)** | The area the lander will touch down inside 99.7 % of the time. The lander page assumes 150 m × 100 m. |
| **Roughness** | Bumpiness about the best-fit plane inside the ellipse; shown only where the DEM is 40 m or finer. |
| **Terrain-relative navigation (TRN)** | Steering the landing by matching camera or lidar views to a stored map. |
| **CLPS** | Commercial Lunar Payload Services: NASA buying robotic deliveries to the Moon from companies. |
| **Artemis** | NASA's programme to return people to the Moon. Artemis II flew in April 2026; the first landing is now planned for Artemis IV (2028). |
| **Ephemeris** | A table of where the Sun and Earth are, over time. The tool uses JPL Horizons, 1 Nov 2026 to 1 Jan 2029. |
