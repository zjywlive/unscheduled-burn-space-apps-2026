# Flow mock (15 Nov 2026)

`demo/mock-flow.html` (served at http://localhost:8741/mock-flow.html) is a clickable mock of a smoother
planning flow. It is a standalone page: it loads nothing from the app's code except the real 3D Moon
(`globe.html`, embed mode, in an iframe) and changes no existing page. Its numbers come from a simplified
sky model inside the page (a banner says so); they are not the app's engine.

## 1. The operation today (map of what exists)

| Challenge question | Where it lives today | Friction |
|---|---|---|
| Pick a site (listed, coordinates, click) | Map: site list, Coordinates, click on the globe | fine |
| Not sure where: screen an area | Map: draw rect / circle / polygon → point bar → Where to land → settings → Start screening | strong, but it looks like a required step |
| Landing date and stay | time-bar popover; landing-day strip | hidden behind a small control |
| Sun / Earth elevation now, time to sunset / Earthset | site card, Sky dial, time bar | spread over three places |
| Sunlit, Earth-in-view, both hours; longest dark vs battery | Details → Overview / Power / Comms | several clicks, no single verdict |
| What if the date slips, or another site | Details → Compare (slip, alternative) | hard to find (asked "where did it go?") |
| Rover route | Map route card (Short / Flat / Sunny) | fine, but mixed in with planning |
| Finalise / Execute | separate pages | fine |

## 2. The target flow (what the mock shows)

The challenge's core loop is **site → date → verdict → compare**. The mock makes that loop the top bar:

1. **Site**: list (with each site's Sun-and-Earth share for the current dates), coordinates, a click.
   *Screen an area* is offered as help inside this step, not as a step of its own.
2. **Date**: landing date/time, stay (7 / 14 / 30 days), an 8-week calendar coloured by Sun-and-Earth
   hours, and "best start in the next weeks".
3. **Verdict**: one sentence (Viable / Marginal / Not viable and why), Sun and Earth elevation now with
   time to their next set or rise, the stay's sunlit / Earth / both hours, and power, comms and sunlight
   graded against stated thresholds (battery 10.9 h of darkness, assumed).
4. **Compare**: the plan as the first column; add +7 d, +14 d, best date nearby or another site as columns,
   each with differences against the plan; **Make plan** promotes a column.
5. **Go deeper**: the existing rover route, area screening, Finalise and Execute, opened as they are
   today with the plan's site, date and stay in the link.

Always on screen: the 3D Moon, the Sky dial (Sun and Earth now plus their tracks over the stay) and the
time bar (landing days coloured, the stay outlined, compared stays dashed, ▶ plays the stay). A summary
row of chips (site, landing, verdict, compare count) jumps back to any step. Steps are a guide, not a gate.

## 3. What adopting it would change in the app (not done)

- Add the stepper and the summary chips to the shell; each step opens an existing card (no new engine).
- Move the date popover's fields into a Date card and add the calendar strip (the data exists: landing-day
  strip).
- A Verdict card built from the figures Details already computes.
- Compare as a column table over the existing scenario code (slip, alternative, best date).
- Route / Where to land / Finalise / Execute stay as they are.

## 4. Verified

Checked in the browser at 1440×900: all five steps render; site switch flies the globe; Date calendar and
stay change the numbers; Compare adds columns and Make plan works; ▶ moves the clock and the dial; no
console errors. Cold start of the embedded globe takes about 10 s.
