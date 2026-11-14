# Troubleshooting and FAQ

**Back to the [guide](../GUIDE.md).**

### The map is blank or grey north of 80°S
The navigator's terrain, skylines and heat maps cover the **south pole from 80°S to the pole** only. Sites further
north (Apollo 11, Apollo 17, Blue Ghost M1, Chandrayaan-3, Chang'e-4) are in the list, but there the horizon is a
smooth sphere at 0°, not real terrain, and their figures say so. The **3D globe** has the whole Moon (7.6 km and
1.9 km everywhere, 474 m only if you built the large tiles, see the README). The lander's site planner scores
points south of 80°S on the polar data and elsewhere on the coarser global terrain.

### Dates before November 2026 or after 2028 don't work
The Sun and Earth positions come from a JPL Horizons table that runs from **1 Nov 2026 to 1 Jan 2029**. Outside that
span the page cannot draw a sky, and a stay that runs past the end is cut at 1 Jan 2029 (the card says "clipped").
That is also why you cannot replay the real 2024–25 landings of IM-1, IM-2 or Blue Ghost.

### The first load is slow
The navigator loads several MB of terrain and sky grids, then computes the heat map for the stay; the globe and the
lander build 3D terrain. On a laptop the loading screen lifts in a few seconds; on a slow machine or a machine
without a graphics card (software WebGL) the globe and lander can take tens of seconds. "Show the map now" on the
loading screen lets you start while the rest loads. Zooming in loads finer terrain (40 m, 20 m, 5 m tiles), so the
map sharpens a moment after you stop.

### My mission, route or saved missions disappeared
They are kept in **this browser's local storage** (keys starting with `lsn-`): the shared mission (site, landing time,
touchdown point), the route handed to 3D, saved missions (newest 20), the globe's marked areas and the settings.
A private window, clearing site data, another browser or another port (localhost:8731 vs :8741) starts empty.
To keep a mission, use **Save mission** and then **JSON** in the route card's *Mission file* to download it; *Import
file…* loads it back. Settings can be exported and imported in *Settings → Data and reset*.

### The links between the pages don't carry my plan
Open the pages from the same address (all three from the same server and port, or all from files). The stage bar
links carry the site and time in the URL, and the touchdown point and route go through local storage, which is per
address.

### The timeline keeps moving
The time bar plays on load (6 hours of mission time per second). Press pause, or turn on *Reduce motion* in Settings
(or in your system) and it starts paused.

### "Slope 19°" but the route is supposed to stay under 15°
Two different numbers: the route profile's *Max slope* is the mean slope of the map cells along the route, while the
route's limits are checked move by move on the 240 m grid in the direction of travel. The card explains which is
which. Neither sees rover-scale rocks.

### The Ask panel gives the same few answers
By default it is a **scripted offline demo** that answers a fixed set of questions with the page's own tools; no model
is connected. In *Settings → AI assistant* you can choose Anthropic or an OpenAI-compatible provider with your own API
key; nothing is sent anywhere otherwise.

### The 3D globe is dark or blank
It needs WebGL. If the browser blocks it, try another browser or turn hardware acceleration on. The globe opened from
"Fly along in 3D" needs a route planned in the navigator first; without one it shows the whole Moon.

### Can I run it offline?
Yes. All three pages open straight from the files in `demo/` with no network. The only online parts are the web font
(falls back to the system font) and the optional Ask provider.

### Are the numbers NASA's?
The terrain (LOLA), shadowed regions and long-term averages (Mazarico et al.) and the Sun and Earth positions (JPL
Horizons) are NASA data. Everything about the vehicles is an assumption: rover speed, panel, battery and loads, the
lander's masses and engine, the landing ellipse, radio power. Every card labels its assumptions, and
[VARIABLES.md](../VARIABLES.md) and [LANDER.md](../LANDER.md) list each one with its source.
