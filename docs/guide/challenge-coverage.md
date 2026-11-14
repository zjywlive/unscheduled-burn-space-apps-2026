# Challenge coverage check

*Checked 14 Nov 2026 against `main` at 64757b5 (Brief updated afterwards, see gap 1), using the running pages (screenshots in this guide), the source and
the challenge text ("Lunar Landing Site Navigator", Space Apps 2026). Status: **Met**, **Met, with a limit**, or
**Gap**.*

**Back to the [guide](../GUIDE.md)**

## Summary

All seven objectives are covered, and every "potential consideration" is addressed. The weak points are listed
under [Gaps and actions](#gaps-and-actions):

* the in-app **Brief** described the pre-event state (**fixed**: it now matches this table);
* the navigator has **no terrain horizon north of 80°S**;
* the Sun and Earth are treated as points, with no disc size;
* the pages were **not tested with a screen reader**.

## 1. Objectives

| # | Objective (challenge wording, shortened) | Status | What we built | Where | Evidence |
|---|---|---|---|---|---|
| 1a | Curated list of notable sites: Apollo, CLPS targets, other commercial missions, other countries' landings | Met | Apollo 11 and 17; CLPS: IM-1 Odysseus, IM-2 Athena, Blue Ghost M1; other countries: Chandrayaan-3 (India), Chang'e-4 (China); Artemis candidate regions (8 of NASA's 9, "approx." where the coordinates are ours); Shackleton ridge | Navigator *Sites*; lander *Site*; MCP `list_sites` | [navigator §9](navigator.md#9-the-site-list) |
| 1b | Custom lunar coordinates | Met | *Custom site…*, the *Coordinates* panel (Pick this point), clicking anywhere on the map; the lander takes `?site=lat,lon` and the planner takes typed points anywhere on the Moon | Navigator, lander planner | [navigator §5](navigator.md#5-the-site-card), [lander §5](lander.md#5-choosing-where-to-land) |
| 1c | Side-by-side or sequential comparison of several sites | Met, with a limit | Planned vs alternative (another site or a slipped date) in *Details → Compare*; regions A and B side by side; the site list shows each site's sunlit share; the lander planner grades all listed sites in one table; the scripted Ask compares 3 sites × 2 dates. The navigator compares **two scenarios at a time** in its own UI; larger tables go through Ask or the MCP `compare_scenarios` tool (24 scenarios) | Navigator, lander planner, Ask, `mcp/` | [navigator §6](navigator.md#6-the-sky-dial-and-the-details-sheet), [§8](navigator.md#8-regions-and-comparing-two-areas) |
| 2a | Choose landing date and time | Met | Landing time (UTC), stay 7/14/30 days; the lander's requested time and *Next lit window* | Time bar summary, lander top bar | [navigator §7](navigator.md#7-time-bar-and-landing-slip) |
| 2b | Explore how conditions change across lunar days or seasons | Met | Slip −14 to +14 days; *Change* mode; "best landing in the 4 weeks after"; the time bar's day-by-day strip of landing days; the ephemeris runs from 1 Nov 2026 to 1 Jan 2029 (about 27 lunar days, so the yearly seasonal drift shows); NASA's 18.6-year average; the route's departure search over 60 days | Navigator, route card | [navigator use case A](navigator.md#use-case-a-is-im-2s-landing-date-robust-to-a-two-week-slip) |
| 3a | Sun and Earth position relative to the horizon at a site and date | Met | Sky dial on the map (rings of elevation, the terrain skyline, both paths); *Sky at the site* panorama with the real skyline; *Elevation over the stay* chart; Sun & Earth readout (azimuth, elevation, subsolar latitude, sub-Earth point with libration, Earth range); arrows at the view centre; real-light shading | Navigator; lander HUD and descent scene | [navigator §4](navigator.md#4-terrain-styles-contours-and-the-sun--earth-readout), [§6](navigator.md#6-the-sky-dial-and-the-details-sheet) |
| 3b | Time remaining before sunset or Earthset | Met | Site card: "Sunset in 12 d 21 h · Earthset in 12 d"; Compare: first sunset and Earthset; the table of every rise and set; previous and next rise/set buttons on the time bar | Navigator | [navigator §5](navigator.md#5-the-site-card) |
| 4a | Solar elevation angle | Met | Sun elevation above the skyline on the site card, the readout, the dial and the chart; peak Sun elevation in Compare; panel facing and tilt in *Power*; the route's panel power uses the Sun's elevation and the local skyline | Navigator, route card | [navigator §6](navigator.md#6-the-sky-dial-and-the-details-sheet) |
| 4b | Duration of sunlight, Earth visibility windows | Met | Sunlit, Earth in view and both-in-view hours for the stay; longest dark spell; relay windows; strips over the stay | Site card, Details, Layers | [navigator §5](navigator.md#5-the-site-card) |
| 4c | Is the site-date combination viable (power and communications)? | Met (more than asked) | *Power*: battery over the stay, hours empty, battery needed. *Comms*: Earth direct, an example relay, the longest blind spell. Route: a battery simulation in watts, surface-station link in dBm (free-space plus knife-edge), safe havens. Lander: landing checks with pass/near/fail and a verdict | Navigator, route card, lander | [route §5–7](navigator-route.md#5-battery-and-departure-search), [lander §5](lander.md#5-choosing-where-to-land) |
| 5 | Multiple visualizations: 2D maps, 3D surface, others | Met | 2D polar map with six modes and three terrain styles plus contours; sky dial, panorama and charts; 3D whole-Moon globe with the rover drive; 3D lander scenes (transfer, lunar orbit, descent on 5 m terrain); minimap and elevation profile | All three pages | [GUIDE](../GUIDE.md) |
| 6 | Temporal dynamics: animation or timelines over a lunar day or several days | Met | One clock drives the map (Live mode, Real light shadows), the dial and the charts, playing at 6 h/s with a loop over the mission window; the globe plays the rover drive; the lander plays the whole mission, real time on request | Time bar, globe playback, lander timeline | [navigator §7](navigator.md#7-time-bar-and-landing-slip) |
| 7 | Accessible to mission planners, educators and the public | Met, with a limit | Planners: exact figures, Evidence sheet, exports (JSON, GeoJSON, CSV), MCP tools. Public and teachers: three two-minute stories ("Why the Sun never climbs here", "Why Earth can set", "What a two-week slip does"), a tour of the controls, a plain-language verdict sentence, Ask, this guide and glossary. Accessibility features: colour-blind and high-contrast presets, reduce motion, skip link, aria labels, keyboard control, phone layouts. **Not tested with a screen reader** | Navigator; docs | [navigator §11](navigator.md#11-evidence-brief-tour-ask-settings) |

## 2. Potential considerations

| Consideration | Status | How |
|---|---|---|
| Ephemeris from JPL Horizons or pre-computed data | Met | Pre-computed JPL Horizons (DE441), 3-hour steps, 1 Nov 2026 to 1 Jan 2029, interpolated. Checked against a second Horizons request from the surface at four sites: largest difference 0.006° over 968 comparisons (Evidence sheet) |
| LOLA topography for realistic surfaces and horizons | Met | LOLA GDR global (7.6 km, 1.9 km, 474 m), polar 240 m to 20 m, 5–20 m patches at the listed south-pole sites; skylines ray-cast over 300 km with curvature |
| No atmosphere: horizon from local terrain and the edge of the lunar sphere | Met, with a limit | No refraction anywhere; the skyline is terrain plus curvature from 2 m eye height. **Limit:** north of 80°S the navigator uses a smooth sphere at 0°, not terrain (the lander's planner does compute a terrain skyline anywhere from global LOLA, `lander/skyline.js`). "In view" means the centre of the disc, so a partly risen Sun counts as down |
| Solar elevation displayed prominently | Met | On the site card's "Now, over skyline" line, the readout, the dial and the map arrows |
| Rapid scenario comparison | Met | Slip and alternative in one click; Change mode over the whole map; best cells; regions; Ask; MCP batch tools |
| Communicating time to sunset or Earthset | Met | Countdown on the site card and in the rises-and-sets table |
| Showing extreme lunar vs terrestrial conditions | Met | Real light with 40 km cast shadows; the readout explains the 1.54° tilt; tour stories; long shadows in the descent view; the PSR layer |
| Why small location or date changes matter | Met | Verdict sentence ("Slipping 14 days cuts Sun-and-Earth time from 312 h to 12 h"); Change mode; best cells 20 km apart; the lander planner's "better spots nearby" |
| Actual topography in horizon and visibility | Met (south of 80°S) | See the limit above |
| Earth's libration and the Moon's orbital variations | Met | The Earth direction comes from the Horizons ephemeris, including libration and parallax from the site; the readout shows the sub-Earth point and Earth range; NASA's 18.6-year average is a layer |
| Steep slopes, deep craters, extreme shadows at the south pole | Met | Slope filter and suitability; PSR map; real-light shadows; 5 m descent terrain; slope colours in 2D, 3D and the descent map; route mobility (one-way, traps) |
| Coordination between science and engineering teams | Met | Saved missions and exports; the Evidence sheet; links that carry the scenario; one mission across three pages |
| Responding to schedule or hardware changes | Met | Slip, alternative date, departure search, editable vehicle and rover assumptions with Replan, contingency branches |
| Education | Met | Stories, tour, glossary, this guide, the NASA planning chapter |

## Gaps and actions

| # | Gap | Effect on judging | Suggested action | Owner |
|---|---|---|---|---|
| 1 | **Fixed 14 Nov.** ~~The in-app Brief (`demo/src/ui/brief.js`) is out of date.~~ It rates "Power and communication assessment" *Partial*, saying "no power or link model", while the battery simulation, the dBm link model and the lander checks now exist. It rates accessibility *Partial*. Its "What a weekend build would add" list names work that is already done: finer terrain, lander-scale slope, a power and link budget, an exportable table, a real Ask model, and "a review of the official resources, due on 13 Nov" | Was high | Done: all seven objectives now read *Done* with what covers them, and *What is still left* lists gaps 2–6 below | `demo/src/ui/brief.js`, rebuilt `demo/index.html` |
| 2 | **No terrain horizon north of 80°S in the navigator.** Apollo 11 and 17, Blue Ghost M1, Chandrayaan-3 and Chang'e-4 get a smooth-sphere 0° horizon | Medium: the curated list includes them | Say so on their site card (the MCP results already say it), or reuse `lander/skyline.js` (global LOLA skyline) for those sites | Code |
| 3 | **Point Sun and Earth**: no disc size (the Sun is 0.5° and Earth 1.9° wide), no partial sunrise, no Earthshine | Low; it is stated in Evidence and on the panorama | Optional: count the "upper limb above the skyline" as a second figure | Code |
| 4 | **The ephemeris stops at 1 Jan 2029 and starts on 1 Nov 2026**, so past landings (Apollo, IM-1, IM-2) cannot be replayed on their real dates | Low; stated in the FAQ | Optional: add a historical Horizons pack | Data |
| 5 | **Comparison of more than two scenarios** at once is only in Ask (scripted) and MCP, not in a navigator table | Low to medium | Optional: a "compare sites" table from `compare_scenarios` | Code |
| 6 | **Screen reader not tested** | Low | Run VoiceOver once over the main flow and note the result | Test |
