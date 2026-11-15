// Opens the built page in headless Chrome for each scenario and checks the rendered DOM text.
// Phase 3: the page is demo/index.html plus classic-script data packs in demo/data/js/ (and vendor/
// once it exists), still opened from file://. Every scenario also fails on any console error, uncaught
// exception or failed load (a missing data pack is a failed load). SMOKE_PAGE=<path> runs the same
// scenarios against another copy of the page, e.g. the unpacked zip.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = pathToFileURL(resolve(new URL('..', import.meta.url).pathname, process.env.SMOKE_PAGE ?? 'demo/index.html')).href;
const ALWAYS_ABSENT = ['NaN', 'Infinity', 'undefined', '[object Object]'];

// A scenario: hash, optional width, mustContain / mustNotContain (DOM text), and for phase 3 wave 2
// optional `steps` (page expressions run in order once the page is ready; a returned promise is
// awaited) and `checks` ([{ label, expr }], page expressions that must be truthy after the steps).
const SCENARIOS = [
  // phase 2: the Map view is the default
  { hash: '', checks: [
    // wave 2: the loader decodes the start-up packs and drops their base64 from the store, so the check is
    // that their static scripts are on the page, ran (the map drew from them) and were consumed
    { label: 'startup data packs registered', expr: "typeof window.__lsnData === 'function' && ['dem_480m', 'horizon_grid', 'slope_2km', 'shadow_2km'].every((n) => document.querySelector(`script[src=\"data/js/${n}.js\"]`) && !(n in window.__lsnStore)) && document.querySelector('.map-frame')?.dataset.demKm === '0.48'" },
    // an on-demand pack injected as a classic script loads from file:// (slope_1km: small, made by workflow A)
    { label: 'on-demand data pack loads from file://', expr: "new Promise((ok) => { const s = document.createElement('script'); s.src = 'data/js/slope_1km.js'; s.onload = () => ok('slope_1km' in window.__lsnStore); s.onerror = () => ok(false); document.head.append(s); })" },
  ], mustContain: ['Lunar south pole', 'Moon map', 'Selected point', 'Best cells', 'data-heat="done"', 'of the mapped area has both Sun and Earth in view', 'Top 5 for this mode', 'class="timedock', 'Now, over skyline', 'data-action="details"', '>Live<', '>Layers<'] },
  { hash: '#view=map&mode=change&slip=0', mustContain: ['Set a slip to see what changes.'] },
  { hash: '#view=map&mode=now', mustContain: ['Sun only', 'Earth only', '>Live<', 'of the mapped area has both Sun and Earth in view.'] },
  { hash: '#view=map&mode=sun', mustContain: ['of the mapped area is sunlit for at least half', 'data-heat="done"'] },
  { hash: '#view=map&mode=earth', mustContain: ['of the mapped area has Earth in view for at least half', 'data-heat="done"'] },
  { hash: '#view=map&mode=change&slip=14', mustContain: ['loses more than a day with both in view', 'data-heat="done"'] },
  // phase 1 scenarios, on the Navigator view until phase 5; an old #view=navigator link now opens the map
  // with the detail sheet, which carries the same pieces
  { hash: '#view=navigator', mustContain: ['Lunar Site Navigator', 'IM-2 Athena', 'Landing sites', 'Artemis III candidates', 'Planned vs alternative', 'Sky at the site', '>Landing 14 days later', 'Elevation over the stay', 'Earth in view', 'Both in view', 'Longest dark', 'Rises and sets during the stay'] },
  { hash: '#view=navigator&site=apollo11&slip=0', mustContain: ['Apollo 11', 'has both Sun and Earth in view for', 'Terrain is mapped south of 80°S'] },
  { hash: '#view=navigator&site=zzz&t=garbage&stay=99', mustContain: ['IM-2 Athena</h2>', 'Landing 14 days later'] },
  { hash: '#view=navigator&t=2029-01-01T00:00Z', mustContain: ['IM-2 Athena</h2>', 'Landing 14 days later'], mustNotContain: ['Stay shortened'] },
  { hash: '#view=navigator&t=2028-12-31T23:00Z&slip=-14', mustContain: ['Stay shortened to 1 h', 'of the 1-hour stay'] },
  { hash: '#view=navigator&t=2028-12-26T00:00Z&slip=-14', mustContain: ['Stay shortened to 6 days', 'of the 6-day stay'] },
  { hash: '#view=navigator&site=change4&slip=0', mustContain: ['Earth never rises here', '<th scope="row">Earth in view</th><td class="n"><span class="value">0 h</span>'] },
  { hash: '#view=navigator&site=shackleton&t=2027-06-01T00:00Z&stay=7&slip=0', mustContain: ['No rises or sets in this stay'] },
  { hash: '#view=navigator&site=shackleton', mustContain: ['Measured from the terrain skyline', 'Markers are not to scale'], mustNotContain: ['Horizon mask', 'Mask 2.0°', 'Terrain is mapped south of 80°S'] },
  { hash: '#view=evidence', mustContain: ['Evidence and limits', 'Who uses this, and when?', 'What is not verified?', '968 comparisons', 'DE441', 'Terrain check', 'LDEM_75S_240M', 'under-estimated'] },
  { hash: '#view=brief', mustContain: ['Coverage of the official objectives', 'Power and communication assessment', 'Questions for the team', 'South pole map with five heat modes'] },
  { hash: '#view=navigator&t=2028-12-28T00:00Z&stay=14', mustContain: ['Stay shortened to'] },
  { hash: '', width: 390, mustContain: ['data-overflow="false"', 'data-viewport="390"', 'data-heat="done"'] },
  { hash: '#view=navigator', width: 390, mustContain: ['data-overflow="false"', 'data-viewport="390"'] },
  { hash: '#view=evidence', width: 390, mustContain: ['data-overflow="false"', 'data-viewport="390"'] },
  { hash: '#view=brief', width: 390, mustContain: ['data-overflow="false"', 'data-viewport="390"'] },
];

// ---------- phase 3 wave 2 (§6): zoom, filters, suitability, regions, route, Ask, tour, 390 px ----------
// Page helpers for the scenarios below. `wait(expr)` polls a page expression in real time (no virtual
// time); `PTR` defines window.__ptr(type, fx, fy), which sends a pointer or mouse event to the map frame
// at a fraction (fx, fy) of its size, so drawing goes through the same handlers as a real pointer.
const wait = (expr, ms = 25000) => `new Promise((ok) => { const t0 = Date.now(); const tick = () => { let v = false; try { v = (${expr}); } catch {} if (v) ok(true); else if (Date.now() - t0 > ${ms}) ok(false); else setTimeout(tick, 50); }; tick(); })`;
const PTR = `(window.__ptr = (type, fx, fy, extra = {}) => { const f = document.querySelector('.map-frame'); const r = f.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + fx * r.width, clientY: r.top + fy * r.height, ...extra }; f.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, o) : new MouseEvent(type, o)); }, true)`;
// layout revision: the drawing tools are icon buttons inside the map frame, named by aria-label
const tool = (name) => `(document.querySelector('.map-toolcol [aria-label="${name}"]').click(), true)`;
const FRAME = "document.querySelector('.map-frame')";
const FINE_DONE = `${FRAME}.dataset.tier === '1 km' && ${FRAME}.dataset.heat === 'done'`;
const REGION_READY = "!document.querySelector('.card-region').hidden && !document.querySelector('.card-region .region-progress')";
// Shackleton ridge (89.45°S 222.69°E) in map km, rounded as the hash keeps it
const SHACK = '&z=4&cx=-11.3&cy=-12.3';
const drawRect = [PTR, tool('Rectangle'), "(__ptr('pointerdown', 0.3, 0.3), __ptr('pointermove', 0.42, 0.4), __ptr('pointerup', 0.55, 0.52), true)", wait(REGION_READY)];
const lastText = "(() => { const m = __lsn.agent.messages; const last = m[m.length - 1]; return typeof last.content === 'string' ? last.content : last.content.filter((c) => c.type === 'text').map((c) => c.text).join(' '); })()";
const toolResult = (name) => `(() => { const blocks = __lsn.agent.messages.flatMap((x) => (Array.isArray(x.content) ? x.content : [])); const use = blocks.filter((c) => c.type === 'tool_use' && c.name === '${name}').pop(); return JSON.parse(blocks.find((c) => c.type === 'tool_result' && c.tool_use_id === use.id).content); })()`;

SCENARIOS.push(
  // §4.1, §4.2: zoom 4 at Shackleton loads the 1 km grid and the 240 m terrain, and the heat finishes on it
  { name: 'zoom 4 at Shackleton', hash: `#view=map${SHACK}`, steps: [wait(FINE_DONE)],
    checks: [
      { label: '1 km heat done', expr: FINE_DONE },
      // phase 4: the big-map canvas is larger than phase 3's 480 px square, so zoom 4 can already pick 120 m
      { label: 'finer terrain than 480 m picked at zoom 4', expr: `Number(${FRAME}.dataset.demKm) < 0.48` },
      { label: 'labels hidden at zoom 1 appear (Slater)', expr: "[...document.querySelectorAll('.feature-name')].some((t) => t.textContent === 'Slater')" },
      { label: 'graticule clipped to the frame', expr: "getComputedStyle(document.querySelector('.map-overlay')).overflow === 'hidden'" },
    ], mustContain: ['data-heat="done"', '4×'] },
  // Change and Now when zoomed: Change runs planned and alternative 1 km jobs; Now stays on the 2 km grid
  { name: 'change zoomed', hash: `#view=map&mode=change${SHACK}`, steps: [wait(FINE_DONE)],
    checks: [{ label: 'planned and alternative 1 km jobs done', expr: `${FINE_DONE} && __lsn.plan.layers()[1].alt.done` }],
    mustContain: ['data-heat="done"', 'loses more than a day with both in view'] },
  // fix H2.3 (wired in phase 5): paused and zoomed in, Live draws the viewport's 1 km states once that grid is in
  { name: 'now zoomed', hash: `#view=map&mode=now${SHACK}`, steps: [wait(`${FRAME}.dataset.tier === '1 km'`)], checks: [
    { label: 'Live on the 1 km grid when paused at zoom 4; the hover card says 1 km', expr: `${FRAME}.dataset.tier === '1 km' && __lsn.plan.nowLayer(__lsn.timeline.getState().nowMs - (__lsn.timeline.getState().nowMs % 36e5)).full === false` },
  ], mustContain: ['Sun only', '>Live<'] },
  // §4.1: keys on the map frame zoom and reset; the hash follows
  { name: 'keyboard zoom', hash: '', steps: [
    `(${FRAME}.focus(), ${FRAME}.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true })), true)`,
    wait("location.hash.includes('z=1.5')"),
    `(${FRAME}.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true })), true)`,
  ], checks: [{ label: 'zoom 1.5 and back to 1', expr: "!location.hash.includes('z=') && document.querySelector('.zoom-level').textContent === '1×'" }],
  mustContain: ['data-heat="done"'] },
  // §4.3: filters from the hash and from the slider
  { name: 'filters', hash: '#slope=10&dark=96', steps: [
    "(() => { const r = document.querySelector('.filters input[type=range]'); r.value = '15'; r.dispatchEvent(new Event('input', { bubbles: true })); return true; })()",
    wait("location.hash.includes('slope=15') && document.querySelector('.map-frame').dataset.heat === 'done'"),
  ], checks: [{ label: 'slope slider writes the hash', expr: "location.hash.includes('slope=15') && location.hash.includes('dark=96')" }],
  mustContain: ['data-heat="done"', 'of the mapped area passes the filters.', 'Filtered out', 'Only ground that passes the filters counts.', 'Mean slope over a 240 m grid. Real lander-scale slopes are steeper.', 'that pass the filters'] },
  { name: 'filters off in Now', hash: '#mode=now&slope=10', checks: [{ label: 'filter controls disabled', expr: "document.querySelector('.filters input[type=range]').disabled" }],
    mustContain: ['Filters apply to Both in view, Sunlit, Earth in view and Suitability, not to Now or Change.'] },
  // §4.4: suitability, then all weights 0 through the command layer
  { name: 'suitability', hash: '#mode=score', steps: [
    wait("document.querySelectorAll('.best-row').length === 5"),
  ], checks: [{ label: 'five best cells with scores', expr: "[...document.querySelectorAll('.best-value')].every((v) => /^0\\.\\d\\d$|^1\\.00$/.test(v.textContent))" }],
  mustContain: ['data-heat="done"', 'Suitability weights', 'scores 0.5 or more for suitability', '>Low<', '>High<', 'Near persistent shadow, not inside it'] },
  { name: 'suitability without weights', hash: '#mode=score&w=0,0,0,0', mustContain: ['data-heat="done"', 'Set at least one weight.'] },
  // §4.5: snapping and the hover card
  { name: 'hover card', hash: '', steps: [PTR,
    "(() => { const d = document.querySelector('[data-focus-key=\\'site:shackleton\\'] .mark-dot').getBoundingClientRect(); const f = document.querySelector('.map-frame').getBoundingClientRect(); __ptr('pointermove', (d.left + d.width / 2 + 8 - f.left) / f.width, (d.top + d.height / 2 + 6 - f.top) / f.height, { buttons: 0 }); return true; })()"],
  checks: [
    { label: 'snap ring on the site', expr: "!!document.querySelector('.snap-ring')" },
    { label: 'hover card names the site and its grid', expr: "(() => { const c = document.querySelector('.hover-card'); return !c.hidden && c.textContent.includes('Shackleton ridge') && c.textContent.includes('2 km cell') && c.textContent.includes('Longest dark'); })()" },
    { label: 'hover card inside the frame', expr: "(() => { const c = document.querySelector('.hover-card').getBoundingClientRect(), f = document.querySelector('.map-frame').getBoundingClientRect(); return c.left >= f.left && c.top >= f.top && c.right <= f.right + 0.5 && c.bottom <= f.bottom + 0.5; })()" },
  ], mustContain: ['data-heat="done"'] },
  // §4.6, §4.7: a rectangle into A, a polygon into B, both on the 1 km grid
  { name: 'regions A and B', hash: `#view=map${SHACK}`, steps: [wait(FINE_DONE), ...drawRect,
    tool('Polygon'), "(document.querySelector('.map-slots [data-value=\"B\"]').click(), true)",
    "(__ptr('pointerdown', 0.6, 0.6), __ptr('pointerup', 0.6, 0.6), __ptr('pointerdown', 0.8, 0.62), __ptr('pointerup', 0.8, 0.62), __ptr('pointerdown', 0.72, 0.85), __ptr('pointerup', 0.72, 0.85), __ptr('pointerdown', 0.601, 0.601), __ptr('pointerup', 0.601, 0.601), true)",
    wait(`${REGION_READY} && document.querySelector('.card-region').textContent.includes('B vs A')`)],
  checks: [
    { label: 'region A is on the 1 km grid', expr: "__lsn.plan.region('A').tier.label === '1 km' && __lsn.plan.region('B').tier.label === '1 km'" },
    { label: 'both regions have figures', expr: "!document.querySelector('.card-region').textContent.includes('Computing')" },
    { label: 'best cell markers', expr: "document.querySelectorAll('.region-best').length === 2" },
  ], mustContain: ['Regions A and B', 'B vs A', 'km²', 'Clear A', 'Clear B', 'Planar area.'] },
  // third wave (review I2): a figure-eight outline is refused with a line of text, nothing is stored
  { name: 'self-crossing polygon', hash: '', steps: [PTR, tool('Polygon'),
    "(__ptr('pointerdown', 0.3, 0.3), __ptr('pointerup', 0.3, 0.3), __ptr('pointerdown', 0.6, 0.6), __ptr('pointerup', 0.6, 0.6), __ptr('pointerdown', 0.6, 0.3), __ptr('pointerup', 0.6, 0.3), __ptr('pointerdown', 0.3, 0.6), __ptr('pointerup', 0.3, 0.6), __ptr('dblclick', 0.3, 0.6), true)"],
  checks: [{ label: 'no region stored', expr: "document.querySelector('.card-region').hidden && !__lsn.plan.region('A')" }],
  mustContain: ['data-heat="done"', 'This outline crosses itself. Draw it again without crossing.'] },
  // third wave (review I5): a landing an hour before the ephemeris ends is allowed, and the cut is said
  { name: 'stay cut by the ephemeris end', hash: '#t=2028-12-31T23:00Z&slip=0', mustContain: ['data-heat="done"',
    'The ephemeris ends 1 Jan 2029, so this stay is cut to 1 h.', 'The stay is cut short by the end of the ephemeris, so the longest dark here is not reliable.'] },
  // §4.8: a route by clicks and a double-click
  { name: 'route profile', hash: `#view=map${SHACK}`, steps: [wait(FINE_DONE), PTR, tool('Route'),
    "(__ptr('pointerdown', 0.2, 0.7), __ptr('pointerup', 0.2, 0.7), __ptr('pointerdown', 0.5, 0.5), __ptr('pointerup', 0.5, 0.5), __ptr('pointerdown', 0.8, 0.6), __ptr('pointerup', 0.8, 0.6), __ptr('dblclick', 0.8, 0.6), true)",
    wait("!document.querySelector('.card-route').hidden && document.querySelector('.route-elev')")],
  checks: [
    // phase 3 layout: above the landing date card; big map (fix L2): in the point panel, right after Route plan
    { label: 'route card next to Route plan (big map) / above the landing date card', expr: "document.querySelector('.app').classList.contains('is-bigmap') ? document.querySelector('[data-fold=plan]').nextElementSibling === document.querySelector('.card-route') : document.querySelector('.card-route').compareDocumentPosition(document.querySelector('.card-ribbon')) & Node.DOCUMENT_POSITION_FOLLOWING" },
    { label: 'route length matches the drawn line', expr: "(() => { const r = __lsn.plan.routeResult(null); return r.lengthKm > 40 && r.points.length >= 80; })()" },
  ], mustContain: ['Route profile', 'Total climb', 'Max slope', 'Mean sunlit', 'Clear route'] },
  // layout revision: the map leads. At 1440 × 900 the map starts where phase 2's did and the top of the
  // Landing date ribbon is on the first screen; at 390 the map starts by y 560
  // phase 4: at 1440 × 900 the Map view is the big-map layout (task book phase 4 §3 G, §5)
  { name: 'layout: first screen 1440', hash: '', checks: [
    { label: 'the map fills the window, disc ≥ 820 px, time dock on screen', expr: "(() => { const f = document.querySelector('.map-frame').getBoundingClientRect(); return document.querySelector('.app').classList.contains('is-bigmap') && f.left === 0 && f.top === 0 && f.width === innerWidth && f.height === innerHeight && Number(document.querySelector('.map-frame').dataset.discPx) >= 820 && document.querySelector('.timedock').getBoundingClientRect().bottom <= innerHeight; })()" },
    { label: 'phase 5: modes and Layers in the top bar, near its centre; Click sets in the detail sheet', expr: "(() => { const m = document.querySelector('.topbar-modes').getBoundingClientRect(); return document.querySelector('.topbar').contains(document.querySelector('.mode-seg')) && m.bottom <= 56 && Math.abs((m.left + m.right) / 2 - innerWidth / 2) < 200 && document.querySelector('.site-sheet').contains(document.querySelector('.tool-pick')); })()" },
    { label: 'the page does not scroll', expr: "document.documentElement.scrollHeight <= innerHeight + 1" },
    { label: 'tools and zoom inside the map frame', expr: "(() => { const f = document.querySelector('.map-frame'); return f.contains(document.querySelector('[data-tour=tools]')) && f.contains(document.querySelector('[data-tour=zoom]')); })()" },
  ], mustContain: ['data-heat="done"', 'aria-label="Reset zoom"'] },
  { name: 'layout: first screen 390', hash: '', width: 390, checks: [
    { label: 'map top ≤ 560', expr: "document.querySelector('.map-frame').getBoundingClientRect().top <= 560" },
    { label: 'more modes signalled', expr: "!document.querySelector('.mode-more').hidden" },
    { label: 'map buttons are 40 px', expr: "[...document.querySelectorAll('.map-btn:not([hidden])')].filter((b) => b.offsetParent).every((b) => b.offsetWidth >= 40 && b.offsetHeight >= 40)" },
  ], mustContain: ['data-heat="done"', 'data-overflow="false"'] },
  // layout revision: a plain wheel scrolls the page and shows how to zoom; Ctrl with the wheel zooms
  // phase 3 layout (a 1000 px window): the plain wheel scrolls the page, Ctrl with the wheel zooms
  { name: 'wheel needs Ctrl or ⌘', hash: '', width: 1000, desktop: true, steps: [
    { input: [{ wheel: [0.5, 0.5, -200] }] }, "(window.__hint = !document.querySelector('.map-wheel-hint').hidden, window.__z1 = document.querySelector('.zoom-level').textContent, true)",
    { input: [{ wheel: [0.5, 0.5, -200], ctrl: true }, { wait: 300 }] }],
  checks: [
    { label: 'plain wheel: no zoom, hint shown', expr: "window.__z1 === '1×' && window.__hint" },
    { label: 'Ctrl wheel zooms', expr: "document.querySelector('.zoom-level').textContent !== '1×' && location.hash.includes('z=')" },
  ], mustContain: ['data-heat="done"'] },
  // phase 4 big map: the page does not scroll, so the plain wheel zooms. Fix L10a: zooming no longer folds
  // the side panels; they float over the map at every zoom
  // (round 3: the site list starts closed; opened here so the check covers both panels; cleared at the end)
  { name: 'big map: wheel zooms, panels stay open', hash: '', steps: [
    "(document.querySelector('.map-toolcol .sites-btn').click(), true)",
    { input: [{ wheel: [0.6, 0.7, -300] }, { wait: 400 }] },
    "(window.__open = document.querySelector('.app').dataset.left === 'open' && document.querySelector('.app').dataset.right === 'open' && getComputedStyle(document.querySelector('.point-panel')).display !== 'none' && getComputedStyle(document.querySelector('.sidebar')).display !== 'none', window.__z = document.querySelector('.zoom-level').textContent, true)"],
  checks: [
    { label: 'plain wheel zoomed in, both panels still open', expr: "(() => { const ok = window.__z !== '1×' && window.__open; sessionStorage.removeItem('lsn-panels-v4'); return ok; })()" },
  ], mustContain: ['data-heat="done"'] },
  // fix L10b: each panel folds with its own button; folded, a labelled handle at the same edge brings it
  // back; the folded state survives zooming and a reload (session)
  // (round 3: the site list starts closed and opens from the rail's labelled "Sites" button; the inspector
  // folds with its cross and comes back from "Show panel")
  { name: 'big map: fold and reopen the panels with their handles', hash: '', steps: [
    "(document.querySelector('.map-toolcol .sites-btn').click(), true)", { input: [{ wait: 150 }] },
    "(document.querySelector('.side-close').click(), document.querySelector('.right-toggle').click(), true)", { input: [{ wait: 200 }] },
    "(window.__h = (() => { const l = document.querySelector('.map-toolcol .sites-btn'), r = document.querySelector('.right-reopen'); const lr = l.getBoundingClientRect(), rr = r.getBoundingClientRect(); return document.querySelector('.app').dataset.left === 'closed' && document.querySelector('.app').dataset.right === 'closed' && getComputedStyle(document.querySelector('.sidebar')).display === 'none' && getComputedStyle(document.querySelector('.point-panel')).display === 'none' && lr.width > 0 && lr.left < 80 && l.getAttribute('aria-expanded') === 'false' && l.textContent === 'Sites' && rr.width > 0 && innerWidth - rr.right < 40 && r.textContent.includes('Show panel') && r.getAttribute('aria-expanded') === 'false' && document.activeElement === r; })(), true)",
    "(document.querySelector('[aria-label=\"Zoom in\"]').click(), true)", { input: [{ wait: 400 }] },
    "(window.__zoomKept = document.querySelector('.app').dataset.left === 'closed' && document.querySelector('.app').dataset.right === 'closed', true)",
    "(document.querySelector('.map-toolcol .sites-btn').click(), document.querySelector('.right-reopen').click(), true)", { input: [{ wait: 200 }] }],
  checks: [
    { label: 'both folded: Sites in the left tools and the top-right handle, labelled, focus on the handle', expr: 'window.__h' },
    { label: 'zooming keeps them folded', expr: 'window.__zoomKept' },
    { label: 'Sites and the handle bring both back, focus on the inspector cross', expr: "(() => { const ok = document.querySelector('.app').dataset.left === 'open' && document.querySelector('.app').dataset.right === 'open' && document.activeElement === document.querySelector('.right-toggle') && sessionStorage.getItem('lsn-panels-v4') === '11'; sessionStorage.removeItem('lsn-panels-v4'); return ok; })()" },
  ], mustContain: ['data-heat="done"', 'aria-label="Close the site list"', 'aria-label="Hide the inspector"'] },
  { name: 'big map: a folded panel stays folded after a reload', hash: '', steps: [
    "(sessionStorage.setItem('lsn-panels-v4', '10'), location.reload(), true)", { input: [{ wait: 1500 }] }, wait("document.querySelector('.app')?.dataset.right")],
  // (the check also clears the stored state: sessionStorage lives on across the scenarios in this tab)
  checks: [{ label: 'right panel folded, left open', expr: "(() => { const ok = document.querySelector('.app').dataset.right === 'closed' && document.querySelector('.app').dataset.left === 'open'; sessionStorage.removeItem('lsn-panels-v4'); return ok; })()" }],
  mustContain: [] },
  { name: 'big map: full screen', hash: '', steps: [
    "(document.querySelector('.fs-btn').click(), true)", { input: [{ wait: 300 }] },
    "(window.__hidden = ['.topbar', '.sidebar', '.point-panel', '.timedock', '.map-controls', '.map-ui-tl'].every((q) => getComputedStyle(document.querySelector(q)).display === 'none') && getComputedStyle(document.querySelector('.map-zoom')).display !== 'none', true)",
    { input: [{ key: 'Escape' }, { wait: 300 }] }],
  checks: [
    { label: 'only the zoom controls stay', expr: 'window.__hidden' },
    { label: 'Esc brings everything back', expr: "document.querySelector('.app').dataset.ui !== 'hidden' && getComputedStyle(document.querySelector('.topbar')).display !== 'none'" },
  ], mustContain: ['data-heat="done"', 'aria-label="Full screen map"'] },
  // phase 4 step 2: deep zoom loads the 40 m and 20 m terrain tiles around Shackleton (both cover it)
  { name: 'deep zoom: 40 m tiles at 12×', hash: '#view=map&site=shackleton&z=12&cx=-11.3&cy=-12.3', steps: [wait(`${FRAME}.dataset.demKm === '0.04'`)],
    checks: [
      { label: '40 m terrain drawn', expr: `${FRAME}.dataset.demKm === '0.04'` },
      { label: 'a dem_40m tile pack loaded', expr: "[...document.scripts].some((s) => /data\\/js\\/dem_40m_r\\d\\dc\\d\\d\\.js$/.test(s.src))" },
      // phase 5: the inspector no longer repeats the terrain grid; the hover read-out names it (the hover scenario)
      { label: 'the inspector gives the height', expr: "/[+−]\\d[\\d,]* m$/.test(document.querySelector('.point-coords').textContent)" },
    ], mustContain: ['data-heat="done"'] },
  { name: 'deep zoom: 20 m tiles at 32×', hash: '#view=map&site=shackleton&z=32&cx=-11.3&cy=-12.3', steps: [wait(`${FRAME}.dataset.demKm === '0.02'`)],
    checks: [
      { label: '20 m terrain drawn', expr: `${FRAME}.dataset.demKm === '0.02'` },
      { label: 'a dem_20m tile pack loaded', expr: "[...document.scripts].some((s) => /data\\/js\\/dem_20m_r\\d\\dc\\d\\d\\.js$/.test(s.src))" },
      { label: 'zoom in disabled at the limit', expr: "document.querySelector('[aria-label=\"Zoom in\"]').disabled && document.querySelector('.zoom-level').textContent === '32×'" },
    ], mustContain: ['data-heat="done"'] },
  // phase 4 step 2: the official permanently shadowed regions, off at start; phase 5: a switch in Layers
  { name: 'PSR layer switch', hash: '#view=map&site=shackleton', steps: [
    "(window.__off = document.querySelector('.map-frame').dataset.psr === 'off', document.querySelector('.layers-btn').click(), document.querySelector('[data-layer=psr]').click(), true)",
    wait(`${FRAME}.dataset.psr === 'on'`), wait("/Sun \\d+(\\.\\d)?% · Earth/.test(document.querySelector('.insp-table').textContent)")],
  checks: [
    { label: 'off at start, on after the switch', expr: `window.__off && ${FRAME}.dataset.psr === 'on' && document.querySelector('[data-layer=psr]').getAttribute('aria-checked') === 'true'` },
    { label: 'PSR pack loaded', expr: "[...document.scripts].some((s) => s.src.endsWith('data/js/psr_120m.js'))" },
    { label: 'the inspector shows the official values', expr: "(() => { const t = document.querySelector('.insp-table').textContent; return /Permanently shadowed(Yes|No)/.test(t) && /Sun \\d+(\\.\\d)?% · Earth \\d+(\\.\\d)?%/.test(t); })()" },
  ], mustContain: ['data-heat="done"', 'Permanently shadowed regions', '18.6-yr average'] },
  // phase 5: the workflow cards in the detail sheet's Power and Comms tabs, their assumptions open in place
  { name: 'energy card shows the charge curve', hash: '', steps: [
    "(window.__closed = !__lsn.sheet.isOpen(), document.querySelector('[data-action=details]').click(), document.querySelector('.site-sheet-tab[data-tab=power]').click(), true)",
    wait("document.querySelector('.energy-line.is-planned')?.getAttribute('d')?.length > 20")],
  checks: [
    { label: 'sheet closed at start', expr: 'window.__closed' },
    { label: 'charge curve drawn in the Power tab', expr: "document.querySelector('.energy-line.is-planned').getAttribute('d').length > 20 && document.querySelector('.energy-card').offsetHeight > 0 && __lsn.sheet.activeTab() === 'power'" },
    { label: 'figures first, assumptions open in place', expr: "(() => { const c = document.querySelector('.energy-card'); return c.textContent.includes('Battery empty') && c.textContent.includes('assumed') && c.querySelector('details.energy-more').open; })()" },
    { label: 'the inspector steps aside for the sheet; hash says sheet=power', expr: "getComputedStyle(document.querySelector('.point-panel')).display === 'none' && location.hash.includes('sheet=power')" },
  ], mustContain: ['data-heat="done"'] },
  { name: 'relay card shows coverage hours', hash: '#sheet=comms', steps: [wait("document.querySelector('.relay-table tbody tr')")],
  checks: [
    { label: 'first row has hours and a share', expr: "/\\d h/.test(document.querySelector('.relay-table tbody tr').textContent) && /%/.test(document.querySelector('.relay-table tbody tr').textContent)" },
    { label: 'the Comms tab is the open one, orbit inputs in place', expr: "__lsn.sheet.activeTab() === 'comms' && document.querySelector('details.relay-orbit').open" },
  ], mustContain: ['data-heat="done"', 'Relay link'] },
  // IM-2 Athena to Mons Mouton Plateau, typed into the card's point rows (R's test trip, passes at 15°)
  { name: 'route plan: plan a route and pick one', hash: '', steps: [
    "(() => { document.querySelector('.map-toolcol [aria-label=\"Route\"]').click(); const v = ['-84.79', '29.2', '-84.3', '30.6']; [...document.querySelectorAll('.rp-points input')].slice(0, 4).forEach((el, i) => { el.value = v[i]; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }); document.querySelector('.rp-plan').click(); return true; })()",
    wait("document.querySelector('.rp-choice[data-route=flat]') && !document.querySelector('.rp-choice[data-route=flat]').disabled", 20000),
    // fix L3: planning and picking ease the map to the route, so wait for the heat at the new view
    "(document.querySelector('.rp-choice[data-route=flat]').click(), true)", { input: [{ wait: 900 }] }, wait(`${FRAME}.dataset.heat === 'done'`)],
  checks: [
    { label: 'Flattest picked in the card', expr: "document.querySelector('.rp-choice[data-route=flat]').getAttribute('aria-checked') === 'true'" },
    { label: 'candidates drawn on the map, the picked one marked', expr: "document.querySelectorAll('.routes-layer .rp-route').length >= 2 && document.querySelector('.routes-layer .rp-route.is-selected')" },
    { label: 'the picked route is the current Route, profile labels the slope baselines', expr: "!document.querySelector('.card-route').hidden && /Flattest route from Route plan/.test(document.querySelector('.route-planned-note')?.textContent ?? '')" },
  ], mustContain: ['data-heat="done"', 'Route profile'] },
  { name: 'phase 3 layout below 1101 px', hash: '', width: 1000, desktop: true, checks: [
    { label: 'no big map, the frame is a square in its card', expr: "(() => { const f = document.querySelector('.map-frame').getBoundingClientRect(); return !document.querySelector('.app').classList.contains('is-bigmap') && Math.abs(f.width - f.height) < 1 && getComputedStyle(document.querySelector('.map-frame')).position !== 'fixed'; })()" },
  ], mustContain: ['data-heat="done"'] },
  // layout revision: a double-click in Select zooms in one step and does not pick the point
  // (0.6, 0.7) of the frame: open ground on the map in the big layout, clear of site labels
  { name: 'double-click zooms, no pick', hash: '', steps: [{ input: [{ click: [0.6, 0.7], double: true }, { wait: 500 }] }],
    checks: [{ label: 'zoom 1.5, IM-2 still selected', expr: "location.hash.includes('z=1.5') && location.hash.includes('site=im2') && document.querySelector('.point-name').textContent === 'IM-2 Athena'" }],
    mustContain: ['data-heat="done"'] },
  // layout revision: a single click still picks, after the double-click wait
  { name: 'single click picks', hash: '', steps: [{ input: [{ click: [0.6, 0.7] }, { wait: 500 }] }],
    checks: [{ label: 'a map point is selected', expr: "document.querySelector('.point-name').textContent === 'Map point' && !location.hash.includes('z=')" }],
    mustContain: ['data-heat="done"'] },
  // phase 5: Filters, the overlays and the weights live in the Layers menu of the top bar
  { name: 'Layers menu', hash: '', steps: ["(window.__folded = document.querySelector('.layers-pop').hidden && document.querySelector('.layers-count').hidden, true)",
    "(document.querySelector('.layers-btn').click(), true)"],
  checks: [
    { label: 'closed by default, no filter count', expr: 'window.__folded' },
    { label: 'opens on click: filters and the six overlay switches', expr: "!document.querySelector('.layers-pop').hidden && document.querySelector('.layers-btn').getAttribute('aria-expanded') === 'true' && document.querySelector('.layers-pop .filters input[type=range]') && ['live', 'psr', 'dial', 'best', 'labels', 'graticule'].every((k) => document.querySelector(`[data-layer=${k}]`))" },
    { label: 'Esc closes it', expr: "(() => { document.querySelector('.layers-btn').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return document.querySelector('.layers-pop').hidden; })()" },
    { label: 'Graticule off hides it on the map, and comes back', expr: "(() => { const b = document.querySelector('[data-layer=graticule]'); b.click(); const off = getComputedStyle(document.querySelector('.graticule')).display === 'none'; b.click(); return off && getComputedStyle(document.querySelector('.graticule')).display !== 'none'; })()" },
  ], mustContain: ['data-heat="done"', 'Sky dial at selected point'] },
  { name: 'filters from the hash', hash: '#slope=10&dark=96', checks: [
    { label: 'Layers shows two filters on, with the summary', expr: "document.querySelector('.layers-count').textContent === '2' && document.querySelector('.layers-btn').title === 'Filters: Slope ≤ 10°, dark ≤ 96 h'" },
  ], mustContain: ['data-heat="done"'] },
  // UI review I2: a route drawn with the mouse ends on Enter (no keyboard crosshair is on screen)
  { name: 'route ends on Enter after mouse clicks', hash: '', steps: [tool('Route'),
    { input: [{ click: [0.3, 0.3] }, { click: [0.5, 0.35] }, { click: [0.6, 0.6] }, { key: 'Enter' }] },
    wait("!document.querySelector('.card-route').hidden")],
  checks: [{ label: 'three vertices, none added by Enter', expr: "__lsn.plan.routeResult(null) && document.querySelectorAll('.route-vertex, .route-end').length === 3" }],
  mustContain: ['Route profile'] },
  // UI review I4 (b): after Clear A from the keyboard, focus stays in the toolbar
  { name: 'Clear A keeps focus', hash: '', steps: [PTR, tool('Rectangle'), "(__ptr('pointerdown', 0.4, 0.4), __ptr('pointermove', 0.5, 0.5), __ptr('pointerup', 0.55, 0.55), true)",
    wait("!document.querySelector('.card-region').hidden"),
    "(document.querySelector('.tool-clear[aria-label=\"Clear A\"]').focus(), true)", { input: [{ key: 'Enter' }] }],
  checks: [{ label: 'region cleared, focus on a map tool button', expr: "document.querySelector('.card-region').hidden && document.activeElement !== document.body && document.activeElement.closest('.map-toolcol') !== null" }],
  mustContain: ['data-heat="done"'] },
  // §4.9: before any tour has run in this browser profile (the tour scenario below records one)
  // layout revision: a first visit shows "New" on the Tour button instead of a prompt over the page
  { name: 'first-visit prompt', hash: '', checks: [{ label: 'no prompt over the page', expr: "!document.querySelector('[data-tour-prompt]')" }],
    mustContain: ['id="lsn-tour-new"', '>New</span>', 'data-tour="ask"', 'data-tour="modes"', 'data-tour="map"', 'data-tour="ribbon"', 'data-tour="tools"', 'data-tour="zoom"', 'data-tour="filters"'] },
  // §4.10: the Ask drawer runs a scripted question; the figures in the reply are the tool's figures
  { name: 'Ask', hash: '', steps: [
    "(document.querySelector('[data-action=ask]').click(), true)",
    "(__lsn.panel.ask('Show the best 3 cells in this mode'), true)",
    wait("!__lsn.agent.busy && __lsn.agent.messages.length >= 4"),
  ], checks: [
    { label: 'reply quotes every cell of the best_cells result', expr: `(() => { const r = ${toolResult('best_cells')}, t = ${lastText}; return r.cells.length === 3 && r.cells.every((c) => t.includes(c.coords) && t.includes(Math.round(c.value * 100) + '%')); })()` },
    { label: 'drawer open, Ask pressed', expr: "__lsn.panel.isOpen() && document.querySelector('[data-action=ask]').getAttribute('aria-expanded') === 'true'" },
    { label: 'Esc closes and focus returns to Ask', expr: "(() => { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return !__lsn.panel.isOpen() && document.activeElement === document.querySelector('[data-action=ask]'); })()" },
  ], mustContain: ['data-heat="done"', 'Scripted demo. No model is connected.'] },
  // UI review I3: Tab stays in the Ask drawer; Esc closes it from anywhere; full screen it is modal
  { name: 'Ask keeps focus', hash: '', steps: [
    "(document.querySelector('[data-action=ask]').click(), true)", wait("__lsn.panel.isOpen() && document.querySelector('.agent-panel deep-chat')"),
    { input: [{ wait: 400 }, { key: 'Tab', times: 14 }] }, "(window.__inPanel1 = document.querySelector('.agent-panel').contains(document.activeElement), true)",
    { input: [{ key: 'Tab', shift: true, times: 14 }] }, "(window.__inPanel2 = document.querySelector('.agent-panel').contains(document.activeElement), true)",
    "(document.activeElement.blur(), document.body.focus(), true)", { input: [{ key: 'Escape' }] }],
  checks: [
    { label: 'Tab and Shift+Tab stay in the drawer', expr: 'window.__inPanel1 && window.__inPanel2' },
    { label: 'Esc with focus outside closes it', expr: '!__lsn.panel.isOpen()' },
  ], mustContain: ['data-heat="done"'] },
  { name: 'Ask is modal full screen', hash: '', width: 390, steps: ["(document.querySelector('[data-action=ask]').click(), true)", wait('__lsn.panel.isOpen()')],
    checks: [
      { label: 'aria-modal and the page inert', expr: "document.querySelector('.agent-panel').getAttribute('aria-modal') === 'true' && document.getElementById('app').inert" },
      { label: 'closing restores the page', expr: "(__lsn.panel.close(), !document.getElementById('app').inert && document.querySelector('.agent-panel').getAttribute('aria-modal') === 'false')" },
    ], mustContain: ['data-heat="done"'] },
  // UI review I4 (a), I6: a tour started from the keyboard returns focus to the Tour button (the first-visit
  // prompt is gone in the layout revision, so it starts from the Tour button with "New" on it)
  // the Tour button, and every popover sits next to its target
  { name: 'tour from the prompt', hash: '', steps: [
    // phase 6: the Tour button opens a menu; the tour of the controls is its last item (ArrowUp wraps to it)
    "(document.querySelector('[data-action=tour]').focus(), true)", { input: [{ key: 'Enter' }, { wait: 150 }, { key: 'ArrowUp' }, { key: 'Enter' }] },
    wait("document.querySelector('.driver-popover')"),
    "new Promise(async (ok) => { const gaps = []; for (let i = 0; i < 7; i++) { await new Promise((r) => setTimeout(r, 900)); const p = document.querySelector('.driver-popover').getBoundingClientRect(), t = document.querySelector('.driver-active-element').getBoundingClientRect(); gaps.push(Math.round(Math.hypot(Math.max(0, t.left - p.right, p.left - t.right), Math.max(0, t.top - p.bottom, p.top - t.bottom)))); if (i < 6) document.querySelector('.driver-popover-next-btn').click(); } window.__gaps = gaps; ok(true); })",
    { input: [{ key: 'ArrowRight' }, { wait: 600 }] }],
  checks: [
    { label: 'every popover within 40 px of its target', expr: "window.__gaps.length === 7 && window.__gaps.every((g) => g <= 40)" },
    { label: 'focus back on the Tour button', expr: "!__lsn.tour.isActive() && document.activeElement === document.querySelector('[data-action=tour]')" },
    { label: '"New" is gone once the tour has been opened', expr: "!document.getElementById('lsn-tour-new')" },
  ], mustContain: ['data-heat="done"'] },
  // §4.9: the tour opens, walks all seven steps and closes; a second run closes on Escape
  { name: 'tour', hash: '', steps: [
    "(document.querySelector('[data-action=tour]').click(), true)",
    "(document.querySelector('[data-story-pick=controls]').click(), true)",   // phase 6: from the Tour menu
    wait("document.querySelector('.driver-popover')"),
    "new Promise(async (ok) => { const seen = []; for (let i = 0; i < 7; i++) { await new Promise((r) => setTimeout(r, 650)); seen.push(document.querySelector('.driver-popover-progress-text')?.textContent); document.querySelector('.driver-popover-next-btn')?.click(); } window.__tourSeen = seen; ok(true); })",
    wait("!window.__lsn.tour.isActive()", 5000),
  ], checks: [
    { label: 'seven steps, 1 of 7 to 7 of 7', expr: "JSON.stringify(window.__tourSeen) === JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((n) => n + ' of 7'))" },
    { label: 'finished and remembered', expr: "!__lsn.tour.isActive() && localStorage.getItem('lsn-tour-v3') === 'done' && !document.getElementById('lsn-tour-new')" },
    { label: 'Escape closes a second run', expr: "new Promise(async (ok) => { __lsn.tour.start(); for (let i = 0; i < 40 && !document.querySelector('.driver-popover'); i++) await new Promise((r) => setTimeout(r, 50)); await new Promise((r) => setTimeout(r, 500)); window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' })); await new Promise((r) => setTimeout(r, 300)); ok(!__lsn.tour.isActive() && !document.querySelector('.driver-popover')); })" },
  ], mustContain: ['data-heat="done"'] },
  // 390 px: zoomed map with a region and a route, no sideways scroll
  { name: 'phone map with region', hash: `#view=map${SHACK}`, width: 390, steps: [wait(FINE_DONE), ...drawRect,
    "(() => { document.documentElement.dataset.overflow = String(document.documentElement.scrollWidth > window.innerWidth); return true; })()"],
  mustContain: ['data-overflow="false"', 'data-viewport="390"', 'data-heat="done"', 'Region A'] },
);

// ---------- fix workstream L (2026-11-13) ----------
// phase 5: the point inspector on the first screen: name and buttons, the live rows, the three hour rows, the
// official values and Best cells, with no scroll and the hours at its top
const PANEL_HEADS = `(() => { const p = document.querySelector('.point-panel'), pr = p.getBoundingClientRect(); const rows = document.querySelector('.point-table tbody tr:nth-child(3)').getBoundingClientRect(); const best = document.querySelector('.best-toggle').getBoundingClientRect(); return p.scrollHeight <= p.clientHeight + 1 && p.dataset.kind === 'point' && document.querySelector('.insp-now').textContent.startsWith('Now, over skyline') && best.bottom <= pr.bottom && rows.bottom - (document.querySelector('.insp-verdict-block')?.getBoundingClientRect().height ?? 0) < pr.top + 340; })()`;
// (phase 6: the verdict and its way out sit above the hours; the rows move down by exactly that block)
const CHROME_BOXES = "['.sidebar', '.map-toolcol', '.map-controls', '.point-panel', '.right-reopen', '.timedock', '.map-zoom', '.site-sheet'].filter((q) => { const e = document.querySelector(q); return e && getComputedStyle(e).display !== 'none' && e.getClientRects().length && e.getBoundingClientRect().width > 0; }).length";
const LOOSE_CHIPS = "[...document.querySelectorAll('.map-chip, .map-player, .finding')].filter((e) => !e.hidden && e.getClientRects().length && e.getBoundingClientRect().width > 1 && !e.closest('.timedock, .map-controls, .map-toolcol, .map-zoom, .status-stash, .site-sheet')).length";
const fillEntry = (vals) => `(() => { const ins = [...document.querySelectorAll('.shape-entry .se-input')]; ${JSON.stringify(vals)}.forEach((v, i) => { const el = ins[i]; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }); document.querySelector('.shape-entry .se-apply').click(); return true; })()`;
SCENARIOS.push(
  // L1: every section heading of the right panel on the first screen, the three hour rows at its top
  { name: 'phase 5: the point inspector on the first screen', hash: '', checks: [{ label: 'live rows, hours on top, no panel scroll', expr: PANEL_HEADS }], mustContain: ['data-heat="done"'] },
  { name: 'phase 5: the point inspector on the first screen', hash: '', width: 1728, height: 996, desktop: true, checks: [{ label: 'live rows, hours on top, no panel scroll', expr: PANEL_HEADS }], mustContain: ['data-heat="done"'] },
  // L3: planning eases the map to the candidates, between the open panels and bars; the panels stay open
  { name: 'fix L3: planned routes are fitted between the panels', hash: '', steps: [
    "__lsn.commands.run('plan_route', { points: [[-84.79, 29.2], [-85.3, 31.5]], max_slope_deg: 25 }).then((r) => (window.__r = r, true))",
    wait("document.querySelector('.zoom-level').textContent !== '1×' && location.hash.includes('rpsel=short')"), { input: [{ wait: 900 }] }],
  checks: [
    { label: 'zoomed to the route, the panels as they were (site list closed by default, inspector open)', expr: "Number(document.querySelector('.map-frame').dataset.zoom) > 4 && document.querySelector('.app').dataset.left === 'closed' && document.querySelector('.app').dataset.right === 'open'" },
    { label: 'the candidates lie between the panels, the top bar and the dock', expr: "(() => { const r = document.querySelector('.routes-layer').getBoundingClientRect(), l = document.querySelector('.sidebar').getBoundingClientRect(), t = document.querySelector('.map-toolcol').getBoundingClientRect(), p = document.querySelector('.point-panel').getBoundingClientRect(), m = document.querySelector('.topbar').getBoundingClientRect(), d = document.querySelector('.timedock').getBoundingClientRect(); return r.width > 100 && r.left >= Math.max(l.right, t.right) && r.right <= p.left && r.top >= m.bottom && r.bottom <= d.top; })()" },
  ], mustContain: ['data-heat="done"'] },
  // L5: the PSR switch, the Energy and Relay link inputs, the planned route and the regions in the hash
  { name: 'fix L5: phase 4 inputs come back from the hash', hash: '#psr=1&en=fixed,3,48,0.2&relay=circular-2h&relaymin=5&ra=circle:-11.3,-12.3,8&rb=rect:20,20,30,35', steps: [
    wait(`${FRAME}.dataset.psr === 'on' && __lsn.plan.region('A') && __lsn.plan.region('B')`),
    "(__lsn.openSheet('comms'), true)", { input: [{ wait: 300 }] },
    "__lsn.commands.run('get_energy', { battery_hours: 72 }).then(() => true)", { input: [{ wait: 200 }] }],
  checks: [
    { label: 'PSR layer on and its switch on', expr: `${FRAME}.dataset.psr === 'on' && document.querySelector('[data-layer=psr]').getAttribute('aria-checked') === 'true'` },
    { label: 'regions A and B drawn from the hash', expr: "__lsn.plan.region('A').shape.type === 'circle' && __lsn.plan.region('B').shape.type === 'rect'" },
    { label: 'relay card on the 2 h example orbit at 5°', expr: "(() => { const o = __lsn.state().relay; return o.presetId === 'circular-2h' && o.minElDeg === 5 && location.hash.includes('relay=circular-2h') && location.hash.includes('relaymin=5'); })()" },
    { label: 'an energy change is written back', expr: "location.hash.includes('en=fixed,3,72,0.2') && location.hash.includes('psr=1') && location.hash.includes('ra=circle:-11.3,-12.3,8')" },
  ], mustContain: ['data-heat="done"'] },
  { name: 'fix L5: a planned route comes back from the hash', hash: '#rp=77.13,138;72.5,141.2&rpslope=25&rpsel=flat&z=3&cx=60&cy=120', steps: [
    wait("document.querySelector('.rp-choice[data-route=flat]')?.getAttribute('aria-checked') === 'true'")],
  checks: [
    { label: 'Flattest picked, the view from the hash kept', expr: "document.querySelector('.routes-layer .rp-route.is-selected') && location.hash.includes('rpsel=flat') && location.hash.includes('rpslope=25') && location.hash.includes('z=3')" },
  ], mustContain: ['data-heat="done"', 'Route profile'] },
  // L6: the Ask panel plans a route with plan_route and quotes its figures
  { name: 'fix L6: Ask plans a route', hash: '', steps: [
    "(document.querySelector('[data-action=ask]').click(), true)",
    "(__lsn.panel.ask('Plan a route from IM-2 Athena to Mons Mouton Plateau'), true)",
    wait("!__lsn.agent.busy && __lsn.agent.messages.length >= 6", 30000),
    // (scenarios run with reduced motion, so the fit to the route is instant and the heat starts at once)
    wait(`${FRAME}.dataset.heat === 'done'`),
  ], checks: [
    { label: 'plan_route ran and the reply quotes every candidate', expr: `(() => { const r = ${toolResult('plan_route')}, t = ${lastText}; return r.routes.length === 3 && r.routes.filter((x) => !x.unavailable).every((x) => t.includes(x.label + ' ' + x.lengthKm.toFixed(1) + ' km')); })()` },
    { label: 'route suggestion offered', expr: "[...document.querySelectorAll('.agent-suggestion')].some((b) => /route/i.test(b.textContent)) && [...document.querySelectorAll('.agent-suggestion')].some((b) => /relay/i.test(b.textContent)) && [...document.querySelectorAll('.agent-suggestion')].some((b) => /battery/i.test(b.textContent))" },
  ], mustContain: ['data-heat="done"', 'Scripted demo. No model is connected.'] },
  // L4: the marks and labels on the disc's rim at 1× are clear of the mode bar
  { name: 'fix L4: rim marks clear of the mode bar at 1×', hash: '', checks: [
    { label: 'IM-1 Odysseus and the best-cell marks below the top bar', expr: "(() => { const m = document.querySelector('.topbar').getBoundingClientRect().bottom; const im1 = document.querySelector('[data-focus-key=\"site:im1\"]'); const lab = im1.querySelector('.mark-label'); const tops = [...document.querySelectorAll('.top-cells circle')].map((c) => c.getBoundingClientRect().top); return im1.querySelector('.mark-dot').getBoundingClientRect().top > m && lab && lab.getBoundingClientRect().top > m && tops.length === 5 && tops.every((t) => t > m); })()" },
    { label: 'the disc keeps its size', expr: "Number(document.querySelector('.map-frame').dataset.discPx) >= 820" },
  ], mustContain: ['data-heat="done"'] },
  // L7 / phase 5: the PSR switch sits beside its label, which may wrap
  { name: 'fix L7: PSR switch beside its label', hash: '', steps: ["(document.querySelector('.layers-btn').click(), true)"], checks: [
    { label: 'switch right of the text', expr: "(() => { const b = document.querySelector('[data-layer=psr]').getBoundingClientRect(), t = document.querySelector('[data-layer=psr]').previousElementSibling.getBoundingClientRect(); return b.width >= 30 && b.left >= t.right; })()" },
  ], mustContain: ['data-heat="done"'] },
  // L11 / L8 / phase 5: at most six floating containers in Live mode, zoomed, with the Route tool; no loose
  // chips; the drawing hint lives in the time dock's status line and goes once the route is finished
  { name: 'fix L11: one container per place, the hint goes when the route is done', hash: '#mode=now&z=5&cx=-60&cy=60', steps: [
    tool('Route'), { input: [{ wait: 400 }] },
    `(window.__count = ${CHROME_BOXES}, window.__loose = ${LOOSE_CHIPS}, window.__hint = document.querySelector('.timedock .td-status').textContent.startsWith('Click to add points'), true)`,
    PTR, "(__ptr('pointerdown', 0.4, 0.5), __ptr('pointerup', 0.4, 0.5), __ptr('pointerdown', 0.5, 0.55), __ptr('pointerup', 0.5, 0.55), __ptr('dblclick', 0.5, 0.55), true)",
    wait("!document.querySelector('.card-route').hidden"), { input: [{ wait: 400 }] }],
  checks: [
    { label: 'at most six floating containers besides the top bar, no loose chips', expr: 'window.__count <= 6 && window.__loose === 0' },
    { label: 'drawing hint in the status line while drawing', expr: 'window.__hint' },
    { label: 'gone once the route is finished (L8)', expr: "document.querySelector('.tool-hint').hidden && !document.querySelector('.timedock .td-status').textContent.startsWith('Click to add points')" },
  ], mustContain: ['data-heat="done"'] },
  // L12: the scale bar: a round length, its label changes with the zoom
  { name: 'fix L12: scale bar follows the zoom', hash: '', steps: [
    "(window.__s1 = document.querySelector('.timedock .map-scale-label').textContent, true)",
    "__lsn.commands.run('zoom_to', { site_id: 'shackleton', zoom: 24 }).then(() => true)", { input: [{ wait: 600 }] }],
  checks: [
    { label: '100 km at 1×, a short length at 24×', expr: "window.__s1 === '100 km' && /^(1|2|5)(00)? m$|^(1|2|5) km$/.test(document.querySelector('.timedock .map-scale-label').textContent) && document.querySelector('.timedock .map-scale-label').textContent !== window.__s1" },
    { label: 'bar 60–170 px, the projection named', expr: "(() => { const b = document.querySelector('.map-scale-bar').getBoundingClientRect().width; return b >= 60 && b <= 170 && /true to scale at the pole/.test(document.querySelector('.map-scale').title); })()" },
  ], mustContain: ['data-heat="done"'] },
  // L13: typed coordinates for every drawing tool, through the same path as drawing
  { name: 'fix L13: typed rectangle', hash: '', steps: [tool('Rectangle'), { input: [{ wait: 200 }] }, fillEntry(['-89.3', '200', '-89.6', '240']), wait(REGION_READY)],
    checks: [{ label: 'region A is a rectangle with figures, in the hash', expr: "__lsn.plan.region('A').shape.type === 'rect' && document.querySelector('.region-shape') && /km²/.test(document.querySelector('.card-region').textContent) && location.hash.includes('ra=rect:')" }],
    mustContain: ['data-heat="done"', 'Coordinates'] },
  { name: 'fix L13: typed circle', hash: '', steps: [tool('Circle'), { input: [{ wait: 200 }] }, fillEntry(['89.45S', '137.31W', '10']), wait(REGION_READY)],
    checks: [{ label: 'region A is a 10 km circle with figures', expr: "(() => { const s = __lsn.plan.region('A').shape; return s.type === 'circle' && Math.abs(s.rKm - 10) < 1e-9 && /km²/.test(document.querySelector('.card-region').textContent) && location.hash.includes('ra=circle:'); })()" }],
    mustContain: ['data-heat="done"'] },
  { name: 'fix L13: typed polygon', hash: '', steps: [tool('Polygon'), { input: [{ wait: 200 }] }, fillEntry(['-89.2', '200', '-89.6', '220', '-89.3', '250']), wait(REGION_READY)],
    checks: [{ label: 'region A is a triangle with figures', expr: "__lsn.plan.region('A').shape.type === 'polygon' && __lsn.plan.region('A').shape.points.length === 3 && /km²/.test(document.querySelector('.card-region').textContent) && location.hash.includes('ra=poly:')" }],
    mustContain: ['data-heat="done"'] },
  // (phase 5: a typed point is the site list's Custom site, below; the Coordinates form serves the regions)
  { name: 'fix L13: custom site takes 89.45S 137.4W', hash: '', steps: [
    "(() => { const la = document.getElementById('lsn-lat'), lo = document.getElementById('lsn-lon'); la.value = '89.45S'; lo.value = '137.4W'; document.querySelector('form.custom button[type=submit]').click(); return true; })()", { input: [{ wait: 300 }] }],
    checks: [{ label: 'custom site at 89.45°S 137.40°W', expr: "document.querySelector('.point-coords').textContent.startsWith('89.45°S 137.40°W')" }],
    mustContain: ['data-heat="done"'] },
);

// ---------- phase 5 (workstream G): structure, playback, optional window, settings, two-tier commands ----------
const BOXES5 = "['.sidebar', '.map-toolcol', '.point-panel', '.right-reopen', '.timedock', '.map-zoom', '.site-sheet', '.lsn-settings', '.map-controls'].filter((q) => { const e = document.querySelector(q); return e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length && e.getBoundingClientRect().width > 0; }).length";
SCENARIOS.push(
  // item 1, acceptance: at most six floating containers on the map besides the top bar, as in the mock
  { name: 'phase 5 G1: six floating containers at most (1440)', hash: '', steps: ["(document.querySelector('.map-toolcol .sites-btn').click(), true)"], checks: [
    { label: 'containers ≤ 6, no loose chips', expr: `${BOXES5} <= 6 && ${LOOSE_CHIPS} === 0` },
    { label: 'rail at the left edge, site list beside it, dock and zoom along the bottom', expr: "(() => { const r = document.querySelector('.map-toolcol').getBoundingClientRect(), s = document.querySelector('.sidebar').getBoundingClientRect(), d = document.querySelector('.timedock').getBoundingClientRect(), z = document.querySelector('.map-zoom').getBoundingClientRect(); const ok = r.left <= 20 && s.left > r.right && s.bottom < d.top && Math.abs(d.bottom - z.bottom) < 2 && z.left > d.right; sessionStorage.removeItem('lsn-panels-v4'); return ok; })()" },
  ], mustContain: ['data-heat="done"'] },
  { name: 'phase 5 G1: six floating containers at most (1728)', hash: '', width: 1728, height: 996, desktop: true, checks: [
    { label: 'containers ≤ 6, no loose chips', expr: `${BOXES5} <= 6 && ${LOOSE_CHIPS} === 0` },
  ], mustContain: ['data-heat="done"'] },
  // item 1: an old Navigator link opens the map with the detail sheet; its pieces are there
  { name: 'phase 5 G1: #view=navigator opens the map with the detail sheet', hash: '#view=navigator&site=shackleton', checks: [
    { label: 'map view, sheet open on Overview, hash rewritten', expr: "__lsn.state().view === 'map' && __lsn.sheet.isOpen() && __lsn.sheet.activeTab() === 'overview' && location.hash.includes('view=map') && location.hash.includes('sheet=overview')" },
    { label: 'the sky panorama is drawn at the sheet width', expr: "document.querySelector('.site-sheet .chart-pano svg')?.getBoundingClientRect().width > 500" },
    { label: 'three figures split by hairlines', expr: "document.querySelectorAll('.site-sheet-tiles:not([hidden]) .site-sheet-tile').length === 3" },
  ], mustContain: ['Shackleton ridge</h2>', 'Sky at the site', 'Elevation over the stay', 'Rises and sets during the stay', 'Planned vs alternative'] },
  // item 8: one large sheet at a time (detail, Settings, Ask)
  { name: 'phase 5 G8: one large sheet at a time', hash: '', steps: [
    "(document.querySelector('[data-action=details]').click(), true)", { input: [{ wait: 200 }] },
    "(window.__a = __lsn.sheet.isOpen(), document.querySelector('[data-action=settings]').click(), true)", { input: [{ wait: 200 }] },
    "(window.__b = !__lsn.sheet.isOpen() && __lsn.settingsSheet.isOpen(), document.querySelector('[data-action=ask]').click(), true)", wait('__lsn.panel.isOpen()'),
    "(window.__c = !__lsn.settingsSheet.isOpen(), __lsn.openSheet('compare'), true)", { input: [{ wait: 200 }] }],
  checks: [
    { label: 'details, then Settings closes it, then Ask closes Settings, then details closes Ask', expr: "window.__a && window.__b && window.__c && __lsn.sheet.isOpen() && !__lsn.panel.isOpen()" },
    { label: 'Compare holds the alternative picker and Click sets', expr: "__lsn.sheet.activeTab() === 'compare' && document.querySelector('.site-sheet .field-alt select') && document.querySelector('.site-sheet .tool-pick')" },
    { label: 'Esc closes the sheet, the inspector comes back', expr: "(() => { document.querySelector('.site-sheet-tab[data-tab=compare]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return !__lsn.sheet.isOpen() && getComputedStyle(document.querySelector('.point-panel')).display !== 'none' && !location.hash.includes('sheet='); })()" },
  ], mustContain: ['data-heat="done"'] },
  // item 1: the inspector follows the selected object
  { name: 'phase 5 G1: the inspector follows the selected object', hash: '', steps: [
    tool('Route'), { input: [{ wait: 150 }] }, "(window.__route = document.querySelector('.point-panel').dataset.kind === 'route' && getComputedStyle(document.querySelector('[data-fold=plan] .fold-body')).display !== 'none' && getComputedStyle(document.querySelector('.card-point')).display === 'none', true)",
    tool('Rectangle'), { input: [{ wait: 150 }] }, "(window.__region = document.querySelector('.point-panel').dataset.kind === 'region' && getComputedStyle(document.querySelector('[data-fold=coords] .fold-body')).display !== 'none', true)",
    "(document.querySelector('.insp-head .insp-icon').click(), true)", { input: [{ wait: 150 }] }],
  checks: [
    { label: 'Route tool: Route plan; Rectangle: Coordinates; back: the point', expr: "window.__route && window.__region && document.querySelector('.point-panel').dataset.kind === 'point' && __lsn.state().tool === 'select'" },
  ], mustContain: ['data-heat="done"'] },
  // item 4: one clock plays in every mode; with a window it loops between In and Out; aggregates hold still
  ...['both', 'sun', 'earth', 'change', 'score', 'now'].map((mode) => ({ name: `phase 5 G4: plays in ${mode}`, hash: `#mode=${mode}`, motion: true, steps: [
    wait("__lsn.timeline.getState().playing"),
    `(window.__k0 = __lsn.state().cursorMs, window.__sum0 = __lsn.api.getState().summary.planned, window.__job0 = __lsn.plan.full.planned, __lsn.timeline.setRate(7 * 864e5), true)`,
    { input: [{ wait: 2500 }] }],
  checks: [
    { label: 'the playhead moved and stays inside the window (loop)', expr: "(() => { const st = __lsn.timeline.getState(); return st.playing && st.nowMs !== window.__k0 && st.nowMs >= st.window.inMs && st.nowMs <= st.window.outMs; })()" },
    { label: 'aggregates not recomputed while playing', expr: "__lsn.api.getState().summary.planned === window.__sum0 && __lsn.plan.full.planned === window.__job0" },
    { label: 'the inspector live rows follow the playhead', expr: "/^Sun [+−]\\d+\\.\\d° · Earth [+−]\\d+\\.\\d°$/.test(document.querySelector('.insp-now .insp-val').textContent) && /(Sunset|Sunrise|sunrise|stays up).*·/.test(document.querySelector('.insp-count').textContent)" },
    ...(mode === 'now' ? [] : [{ label: 'the live light is drawn over the window mode', expr: "document.querySelector('.map-frame').dataset.live === 'on'" }]),
  ], mustContain: [] })),
  // items 4, 6, 12: the countdown row is next_events of the compute tier; the sky dial follows the playhead
  { name: 'phase 5 G12: countdown row = next_events, dial on the point', hash: '#site=shackleton&now=2027-01-18T06:00Z', steps: [wait("/in \\d/.test(document.querySelector('.insp-count').textContent)")],
    checks: [
      { label: 'the row reads as next_events at the playhead', expr: "__lsn.core.run('next_events', { site_id: 'shackleton', at: '2027-01-18T06:00Z' }).then((r) => r.headline === document.querySelector('.insp-count').textContent)" },
      { label: 'the Now row matches sky_at to 0.1°', expr: "__lsn.core.run('sky_at', { site_id: 'shackleton', at: '2027-01-18T06:00Z' }).then((r) => { const f = (c) => `${c >= 0 ? '+' : '−'}${Math.abs(c).toFixed(1)}°`; const t = document.querySelector('.insp-now .insp-val').textContent; return t.includes(f(r.sun.aboveSkylineDeg).slice(0, -2)) && t.includes(f(r.earth.aboveSkylineDeg).slice(0, -2)); })" },
      { label: 'the sky dial shows on the selected point, around its map position', expr: "(() => { const d = document.querySelector('.skydial'); if (!d || getComputedStyle(d).display === 'none' || d.hidden) return false; const r = d.getBoundingClientRect(), m = document.querySelector(`.site-mark[data-focus-key='site:shackleton'] .mark-dot`)?.getBoundingClientRect(); return m && Math.abs((r.left + r.right) / 2 - (m.left + m.right) / 2) < 3 && Math.abs((r.top + r.bottom) / 2 - (m.top + m.bottom) / 2) < 3 && getComputedStyle(d).pointerEvents === 'none'; })()" },
      { label: 'K hides it, the Layers switch and the inspector button agree, K brings it back', expr: "(() => { const k = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true })); k(); const d = document.querySelector('.skydial'); const hidden = d.hidden || getComputedStyle(d).display === 'none'; const agree = document.querySelector('[data-layer=dial]').getAttribute('aria-checked') === 'false' && document.querySelector('.dial-btn').getAttribute('aria-pressed') === 'false'; k(); return hidden && agree && !(d.hidden || getComputedStyle(d).display === 'none'); })()" },
      { label: 'with a drawing tool (nothing drawn yet) it is see-through; once a route exists it goes', expr: "(() => { document.querySelector(`.map-toolcol [aria-label='Rectangle']`).click(); const d = document.querySelector('.skydial'); const dim = Number(getComputedStyle(d).opacity) < 0.9; document.querySelector(`.map-toolcol [aria-label='Route']`).click(); const still = !d.hidden && Number(getComputedStyle(d).opacity) < 0.9; __lsn.api.setRoute([[-11, -12], [-5, -8]]); const gone = d.hidden || getComputedStyle(d).display === 'none'; return dim && still && gone; })()" },
    ], mustContain: ['data-heat="done"'] },
  // item 3: no window. Live only, the inspector offers to land now, the dock to set a window; playback runs on
  { name: 'phase 5 G3: no mission window', hash: '#win=off&site=shackleton', motion: true, steps: [wait("__lsn.timeline.getState().playing"), "(window.__k0 = __lsn.state().cursorMs, __lsn.timeline.setRate(7 * 864e5), true)", { input: [{ wait: 1500 }] }],
    checks: [
      { label: 'Live selected, the window modes unavailable', expr: "__lsn.state().mapMode === 'now' && document.querySelector('.mode-seg [data-value=both]').disabled && !document.querySelector('.mode-seg [data-value=now]').disabled" },
      { label: 'the playhead runs on without a window', expr: "__lsn.timeline.getState().window === null && __lsn.state().cursorMs > window.__k0 + 5 * 864e5" },
      { label: 'Land here now, stay 14 days; Set window from now', expr: "document.querySelector('[data-action=land-now]')?.textContent === 'Land here now, stay 14 days' && /Set window from now/.test(document.querySelector('.timedock').textContent)" },
      { label: 'Land here now sets a 14-day window at the playhead and brings the hours back', expr: "(() => { __lsn.timeline.pause(); const t = Math.floor(__lsn.state().cursorMs / 36e5) * 36e5; document.querySelector('[data-action=land-now]').click(); const st = __lsn.state(); return st.windowOn && st.landingMs === t && st.stayDays === 14 && st.mapMode === 'both' && document.querySelectorAll('.point-table tbody tr').length === 3 && !location.hash.includes('win=off'); })()" },
    ], mustContain: [] },
  // item 3, acceptance: the window off and on again gives the phase-4 figures (tests/fixtures/phase4-figures.json)
  { name: 'phase 5 G3: window off and on, figures as in phase 4', hash: '#site=shackleton&t=2027-01-13T00:00Z&stay=14&slip=14&alt=same', steps: [
    "(__lsn.timeline.clearWindow(), true)", { input: [{ wait: 300 }] }, "(window.__off = __lsn.state().windowOn === false && location.hash.includes('win=off'), __lsn.timeline.setWindow(Date.UTC(2027, 0, 13), Date.UTC(2027, 0, 27)), true)",
    { input: [{ wait: 300 }] }, wait(`${FRAME}.dataset.heat === 'done'`)],
    checks: [
      { label: 'off, then on with the same window', expr: "window.__off && __lsn.state().windowOn && __lsn.state().landingMs === Date.UTC(2027, 0, 13) && __lsn.state().stayDays === 14" },
      { label: 'inspector rows equal the phase-4 build', expr: "JSON.stringify([...document.querySelectorAll('.point-table tbody tr')].map((tr) => tr.textContent)) === JSON.stringify(['Both in view261 h92 h', 'Sunlit336 h336 h', 'Earth in view261 h92 h'])" },
      { label: 'summary equals the phase-4 build', expr: "(() => { const p = __lsn.api.getState().summary.planned; return p.bothMs === 941090625 && p.sunMs === 1209600000 && p.earthMs === 941090625; })()" },
    ], mustContain: ['data-heat="done"'] },
  // item 4: the sheet's cursors follow the same clock
  { name: 'phase 5 G4: the sheet follows the playhead', hash: '#sheet=overview&site=shackleton', motion: true, steps: [wait("__lsn.timeline.getState().playing && document.querySelector('.site-sheet .chart-pano svg')"),
    "(window.__a = document.querySelector('.sheet-aside').textContent, window.__e = document.querySelector('.chart-elev')?.innerHTML.length, true)", { input: [{ wait: 1200 }] }],
    checks: [{ label: 'the sky readout moved with the playhead', expr: "document.querySelector('.sheet-aside').textContent !== window.__a && /^Sun az \\d+° el /.test(document.querySelector('.sheet-aside').textContent)" }],
    mustContain: [] },
  // item 8 (verify-2026-11-13 #1): every large sheet replaces every other one directly, in all 20 orders
  { name: 'phase 5 G8: each large sheet replaces each other one (20 pairs)', hash: '', steps: [
    `new Promise(async (ok) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const OPEN = { details: () => document.querySelector('[data-action=details]').click(), settings: () => document.querySelector('[data-action=settings]').click(), ask: () => document.querySelector('[data-action=ask]').click(), evidence: () => document.querySelector('.view-tab[data-view=evidence]').click(), brief: () => document.querySelector('.view-tab[data-view=brief]').click() };
      const st = () => ({ details: __lsn.sheet.isOpen(), settings: __lsn.settingsSheet.isOpen(), ask: __lsn.panel.isOpen(), evidence: !document.querySelector('.doc-sheet[data-doc=evidence]').hidden, brief: !document.querySelector('.doc-sheet[data-doc=brief]').hidden });
      const closeAll = async () => { if (__lsn.panel.isOpen()) __lsn.panel.close(); __lsn.settingsSheet.close(); if (__lsn.sheet.isOpen()) __lsn.sheet.close(); if (__lsn.state().view !== 'map') __lsn.api.update({ view: 'map' }); await wait(120); };
      const bad = [];
      for (const a of Object.keys(OPEN)) for (const b of Object.keys(OPEN)) {
        if (a === b) continue;
        await closeAll(); OPEN[a](); await wait(150); OPEN[b](); await wait(200);
        const s = st();
        if (!(s[b] && Object.entries(s).every(([k, v]) => k === b || !v))) bad.push(a + '->' + b + ' ' + JSON.stringify(s));
      }
      window.__pairs = bad; ok(true);
    })`],
    checks: [{ label: 'all 20 switches leave only the target open', expr: "Array.isArray(window.__pairs) && window.__pairs.length === 0" }],
    mustContain: ['data-heat="done"'] },
  // verify-2026-11-13 #2: Settings and Ask take the right like the detail sheet: the dock and the zoom step left,
  // the inspector steps aside, the map centres in what is left
  { name: 'phase 5 G8: Settings and Ask shorten the time dock', hash: '', width: 1728, height: 996, desktop: true, steps: [
    "(window.__c0 = __lsn.mapView?.frame?.geo?.Cx ?? null, document.querySelector('[data-action=settings]').click(), true)", { input: [{ wait: 400 }] },
    "(window.__s = (() => { const d = document.querySelector('.timedock').getBoundingClientRect(), z = document.querySelector('.map-zoom').getBoundingClientRect(), p = document.querySelector('.lsn-settings').getBoundingClientRect(); return d.right < z.left && z.right <= p.left && getComputedStyle(document.querySelector('.point-panel')).display === 'none'; })(), document.querySelector('[data-action=ask]').click(), true)", { input: [{ wait: 400 }] }],
    checks: [
      { label: 'with Settings open: dock and zoom left of it, inspector hidden', expr: 'window.__s' },
      { label: 'with Ask open: dock and zoom left of the panel', expr: "(() => { const d = document.querySelector('.timedock').getBoundingClientRect(), z = document.querySelector('.map-zoom').getBoundingClientRect(), p = document.querySelector('.agent-panel').getBoundingClientRect(); return __lsn.panel.isOpen() && d.right < z.left && z.right <= p.left; })()" },
    ], mustContain: ['data-heat="done"'] },
  // item 9: narrow widths. The time dock sits under the map from the first render; at 390 px it wraps inside the
  // window; the detail sheet is a full-screen page
  ...[[1000, true], [390, false]].map(([w, desktop]) => ({ name: `phase 5 G9: narrow ${w} px`, hash: '#sheet=overview', width: w, desktop,
    checks: [
      { label: 'the dock is in the page, inside the window width', expr: "(() => { const d = document.querySelector('.timedock'); const r = d.getBoundingClientRect(); return document.querySelector('.view-map').contains(d) && !d.classList.contains('timedock--float') && r.width > 0 && r.right <= innerWidth + 0.5 && [...d.querySelectorAll('button')].filter((b) => b.getClientRects().length).every((b) => b.getBoundingClientRect().right <= innerWidth + 0.5); })()" },
      { label: 'the detail sheet fills the window', expr: "(() => { const r = document.querySelector('.site-sheet:not(.doc-sheet)').getBoundingClientRect(); return __lsn.sheet.isOpen() && r.left <= 0.5 && Math.abs(r.width - innerWidth) < 1; })()" },
    ], mustContain: ['data-overflow="false"'] })),
  // item 13: Evidence and Brief are reading sheets over the map, opened from the top bar or the old links
  { name: 'phase 5 G13: Evidence and Brief from the top bar', hash: '', steps: [
    "(document.querySelector('.view-tab[data-view=evidence]').click(), true)", wait("document.querySelector('.doc-sheet[data-doc=evidence]:not([hidden])')"),
    "(window.__ev = getComputedStyle(document.querySelector('.map-frame')).display !== 'none' && document.querySelector('.doc-sheet[data-doc=evidence]').textContent.includes('968 comparisons'), document.querySelector('.view-tab[data-view=brief]').click(), true)",
    wait("document.querySelector('.doc-sheet[data-doc=brief]:not([hidden])')"),
    "(window.__br = document.querySelector('.doc-sheet[data-doc=evidence]').hidden && document.querySelector('.doc-sheet[data-doc=brief]').textContent.includes('Coverage of the official objectives'), true)",
    "(document.querySelector('.doc-sheet[data-doc=brief]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)", { input: [{ wait: 200 }] }],
  checks: [
    { label: 'Evidence over the map, then Brief replaces it', expr: 'window.__ev && window.__br' },
    { label: 'Esc returns to the bare map', expr: "__lsn.state().view === 'map' && document.querySelector('.doc-sheet[data-doc=brief]').hidden && location.hash.includes('view=map')" },
  ], mustContain: ['data-heat="done"'] },
  { name: 'phase 5 G13: #view=evidence deep link', hash: '#view=evidence', checks: [
    { label: 'sheet open, centred, scrolling inside, the page does not scroll', expr: "(() => { const r = document.querySelector('.doc-sheet[data-doc=evidence]').getBoundingClientRect(); const b = document.querySelector('.doc-sheet[data-doc=evidence] .doc-sheet-body'); return Math.abs((r.left + r.right) / 2 - innerWidth / 2) < 2 && r.width >= 880 && b.scrollHeight > b.clientHeight && document.documentElement.scrollHeight <= innerHeight + 1; })()" },
  ], mustContain: ['Evidence and limits', 'What is not verified?', '968 comparisons'] },
  { name: 'phase 5 G13: #view=brief deep link, one sheet at a time', hash: '#view=brief', steps: ["(window.__open = document.querySelector('.doc-sheet[data-doc=brief]').textContent.includes('Coverage of the official objectives'), document.querySelector('[data-action=settings]').click(), true)", { input: [{ wait: 200 }] }],
    checks: [{ label: 'Brief opened from the link; Settings closed it and returned to the map', expr: "window.__open && __lsn.settingsSheet.isOpen() && document.querySelector('.doc-sheet[data-doc=brief]').hidden && __lsn.state().view === 'map'" }],
    mustContain: [] },
  // item 13: no opaque #111 card with a 20 px radius left anywhere, in either layout, in any view
  ...[[1440, ''], [1000, ''], [1440, '#view=evidence'], [1000, '#view=brief']].map(([w, hash]) => ({ name: `phase 5 G13: one material (${w} px${hash ? ` ${hash}` : ''})`, hash, width: w === 1440 ? undefined : w, desktop: w !== 1440,
    steps: ["(document.querySelector('[data-action=tour]') && true)"],
    checks: [{ label: 'no element with the old card background or radius', expr: "[...document.querySelectorAll('body *')].filter((e) => e.getClientRects().length).every((e) => { const c = getComputedStyle(e); return c.backgroundColor !== 'rgb(17, 17, 17)' && c.borderTopLeftRadius !== '20px' && c.borderTopLeftRadius !== '999px'; })" }],
    mustContain: [] })),
);

// M4: verify pixels, not just the palette attribute; all changes are restored before the next page.
const CANVAS_PIXELS = `(() => { const c = document.querySelector('.map-canvas:not(.map-live)'); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; })()`;
const LIVE_PIXELS = CANVAS_PIXELS.replace('.map-canvas:not(.map-live)', '.map-live');
SCENARIOS.push(
  { name: 'astra G: playing in March then a January window link without now', hash: '#win=off&t=2027-01-13T00:00Z&stay=14&now=2027-02-28T23:00Z', motion: true, steps: [
    wait('__lsn.state().cursorMs >= Date.UTC(2027, 2, 1)'),
    "(window.__wasMarch = __lsn.timeline.getState().playing && !__lsn.timeline.getState().window && __lsn.state().cursorMs >= Date.UTC(2027, 2, 1), location.hash = '#mode=both&t=2027-01-13T00:00Z&stay=14', true)",
    wait("__lsn.state().windowOn && document.querySelector('.map-frame').dataset.heat === 'done'"), { input: [{ wait: 600 }] }], checks: [
      { label: 'same running clock is back inside 13–27 January and the dock shows Day N', expr: "(() => { const s = __lsn.timeline.getState(); return __wasMarch && s.playing && s.loop && s.window.inMs === Date.UTC(2027,0,13) && s.window.outMs === Date.UTC(2027,0,27) && s.nowMs >= s.window.inMs && s.nowMs < s.window.outMs && __lsn.state().cursorMs === s.nowMs && /Day \\d/.test(document.querySelector('.timedock').textContent); })()" },
    ], mustContain: ['data-heat="done"'] },
  { name: 'astra G: outside now on autoplay returns to In', hash: '#mode=now&t=2027-01-13T00:00Z&stay=14&now=2027-03-01T00:00Z', motion: true, checks: [
    { label: 'autoplay and app cursor agree inside the window', expr: '(() => { const s = __lsn.timeline.getState(); return s.playing && s.nowMs >= s.window.inMs && s.nowMs <= s.window.outMs && s.nowMs === __lsn.state().cursorMs; })()' },
  ] },
  { name: 'astra G: paused outside remains until Play, loop off stays outside', hash: '#mode=now', steps: [
    "(__lsn.timeline.setNow(Date.UTC(2027,2,1)), location.hash = '#mode=now&t=2027-02-01T00:00Z&stay=7', true)",
    wait('__lsn.timeline.getState().window.inMs === Date.UTC(2027,1,1)'),
    '(window.__kept = !__lsn.timeline.getState().playing && __lsn.state().cursorMs === Date.UTC(2027,2,1), __lsn.timeline.play(), window.__reset = __lsn.state().cursorMs === Date.UTC(2027,1,1), __lsn.timeline.setLoop(false), __lsn.timeline.setNow(Date.UTC(2027,2,1)), true)',
    { input: [{ wait: 300 }] }], checks: [
      { label: 'paused playhead stays in March when changing the window', expr: '__kept' },
      { label: 'Play resets the app cursor to the new In immediately', expr: '__reset' },
      { label: 'loop-off playback continues beyond Out', expr: '__lsn.timeline.getState().playing && __lsn.state().cursorMs > Date.UTC(2027,2,1)' },
    ] },
  ...['both', 'sun', 'earth', 'score', 'change', 'now'].map(mode => ({ name: `astra G: smooth toggle at 1x in ${mode}`, hash: `#mode=${mode}&now=2027-01-20T06:00Z`, steps: [
    `(window.__pixels = ${CANVAS_PIXELS}, window.__veil = ${LIVE_PIXELS}, window.__summary = __lsn.api.getState().summary.planned, __lsn.settings.set('heatSmoothing', false), true)`,
    wait(`${FRAME}.dataset.heat === 'done'`)], checks: [
      { label: 'off changes heat pixels, not the reported values', expr: `!__lsn.settings.get('heatSmoothing') && (${CANVAS_PIXELS}).some((v,i) => v !== __pixels[i]) && __lsn.api.getState().summary.planned === __summary` },
      ...(mode === 'now' ? [] : [{ label: 'off also changes the No Sun now veil', expr: `(${LIVE_PIXELS}).some((v,i) => v !== __veil[i])` }]),
      { label: 'restore smoothing', expr: "(__lsn.settings.set('heatSmoothing', true), true)" },
    ], mustContain: ['data-heat="done"'] })),
  ...[{ z: 1, width: 1000 }, { z: 2 }, { z: 2.2 }].map(({ z, width }) => ({ name: `astra G: smooth at ${z}x ${width ? 'narrow' : 'grid switch'}`, hash: `#mode=sun&z=${z}`, width, desktop: !!width, steps: [
    ...(z >= 2 ? [wait(FINE_DONE)] : []),
    `(window.__pixels = ${CANVAS_PIXELS}, __lsn.settings.set('heatSmoothing', false), true)`, wait(`${FRAME}.dataset.heat === 'done'`)], checks: [
      { label: 'smoothing survives the layout or grid switch', expr: `(${CANVAS_PIXELS}).some((v,i) => v !== __pixels[i])` },
      { label: 'restore smoothing', expr: "(__lsn.settings.set('heatSmoothing', true), true)" },
    ], mustContain: ['data-heat="done"'] })),
  { name: 'astra G: playing Live respects smoothing at reduced resolution', hash: '#mode=now&z=2', motion: true, dpr: 2, steps: [
    // Keep playing but slow the clock enough to compare the same whole-hour state.
    '(__lsn.timeline.setRate(1), true)', { input: [{ wait: 300 }] },
    `(window.__pixels = ${CANVAS_PIXELS}, __lsn.settings.set('heatSmoothing', false), true)`, wait(`${FRAME}.dataset.heat === 'done'`)], checks: [
      { label: 'playing on coarse cells and off changes the heat', expr: `__lsn.timeline.getState().playing && ${FRAME}.dataset.tier === '2 km' && (${CANVAS_PIXELS}).some((v,i) => v !== __pixels[i])` },
      { label: 'restore smoothing', expr: "(__lsn.settings.set('heatSmoothing', true), true)" },
    ] },
);
SCENARIOS.push(
  { name: 'phase 5 M4: settings palette repaints canvas and sky dial', hash: `#mode=sun&site=shackleton${SHACK}`, steps: [wait(FINE_DONE),
    "(document.querySelector('[data-action=settings]').click(), true)",
    `(window.__pixels = ${CANVAS_PIXELS}, window.__sunColour = getComputedStyle(document.querySelector('.skydial')).getPropertyValue('--sun'), document.querySelector('[data-palette-id=high-contrast]').click(), true)`,
    wait(`${FRAME}.dataset.heat === 'done'`)], checks: [
      { label: 'settings opened; selected palette reaches SVG and changes heat pixels', expr: `__lsn.settingsSheet.isOpen() && document.documentElement.dataset.palette === 'high-contrast' && getComputedStyle(document.querySelector('.skydial')).getPropertyValue('--sun') !== window.__sunColour && (${CANVAS_PIXELS}).some((v, i) => v !== window.__pixels[i])` },
      { label: 'restore default palette', expr: "(__lsn.settings.reset(), true)" },
    ], mustContain: ['data-heat="done"'] },
  { name: 'phase 5 M4: display switches affect the page', hash: `#mode=sun&site=shackleton${SHACK}`, steps: [wait(FINE_DONE),
    "(document.querySelector('[data-action=settings]').click(), true)",
    `(window.__pixels = ${CANVAS_PIXELS}, document.querySelector('[data-setting=heatSmoothing]').click(), true)`, wait(`${FRAME}.dataset.heat === 'done'`)], checks: [
      { label: 'smoothing toggle changes heat pixels', expr: `!__lsn.settings.get('heatSmoothing') && (${CANVAS_PIXELS}).some((v, i) => v !== window.__pixels[i])` },
      { label: 'transparency slider changes glass', expr: "(() => { const app = document.querySelector('.app'), before = getComputedStyle(app).getPropertyValue('--glass'); const r = document.querySelector('.lsn-range'); r.value = '0'; r.dispatchEvent(new Event('input', { bubbles: true })); return __lsn.settings.get('panelAlpha') === 0.8 && getComputedStyle(app).getPropertyValue('--glass') !== before; })()" },
      { label: 'scale and sky dial hide and return', expr: "(() => { const toggle = (n) => document.querySelector(`[data-setting=${n}]`).click(); toggle('scaleBar'); toggle('skyDial'); const off = document.querySelector('.app').dataset.scale === 'off' && document.querySelector('.skydial').hidden; toggle('scaleBar'); toggle('skyDial'); return off && document.querySelector('.app').dataset.scale === 'on' && !document.querySelector('.skydial').hidden; })()" },
      { label: 'reduce motion stops playback', expr: "(() => { __lsn.timeline.play(); document.querySelector('[data-setting=reduceMotion]').click(); return !__lsn.timeline.getState().playing && document.documentElement.dataset.reduceMotion === 'on'; })()" },
      { label: 'restore display settings', expr: "(__lsn.settings.reset(), true)" },
    ], mustContain: ['data-heat="done"'] },
  { name: 'phase 5 M4: provider notice, cleared chat, explicit no-key error', hash: '', steps: [
    "(__lsn.panel.ask('What is the weather on Mars?'), true)", wait("!__lsn.agent.busy && document.querySelector('deep-chat')?.getMessages().some((m) => m.role === 'ai')"),
    "(() => { document.querySelector('[data-action=settings]').click(); __lsn.settingsSheet.showSection('ai'); const s = document.querySelector('.lsn-settings select'); s.value = 'anthropic'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()",
    wait("document.querySelector('deep-chat').getMessages().length === 0"),
    "(window.__reset = __lsn.agent.messages.length === 0 && document.querySelector('.agent-note').textContent.includes('Anthropic'), __lsn.panel.ask('Compare sites'), true)",
    wait("document.querySelector('deep-chat')?.shadowRoot?.textContent.includes('No Anthropic API key')")], checks: [
      { label: 'provider change clears both histories, then shows the real provider error', expr: "window.__reset && document.querySelector('.agent-note').textContent.includes('Selected provider: Anthropic') && !__lsn.agent.messages.some((m) => typeof m.content === 'string' && m.content.includes('weather'))" },
      { label: 'return to scripted notice', expr: "(__lsn.settings.set('ai.provider', 'scripted'), document.querySelector('.agent-note').textContent === 'Scripted demo. No model is connected.')" },
    ], mustContain: ['data-heat="done"'] },
);

// M5: the same public tool table drives the page and supplies stateless evidence to both providers.
SCENARIOS.push(
  { name: 'phase 5 M5: set/clear window, mode guard, late landing stays authoritative', hash: '#site=shackleton', steps: [
    "(window.__at = __lsn.state().cursorMs, true)", "__lsn.commands.run('clear_window')",
    "__lsn.commands.run('set_map_mode', { mode: 'sun' }).then((r) => { window.__noWindow = !!r.error && __lsn.state().windowOn === false && __lsn.state().mapMode === 'now' && __lsn.timeline.getState().window === null && __lsn.state().cursorMs === window.__at; })",
    "__lsn.commands.run('set_window', { landing: '2028-12-31T23:45Z', stay_days: 13.75 }).then((r) => { window.__late = r.clipped && r.stayAvailableH === 1 && __lsn.state().landingMs === Date.UTC(2028, 11, 31, 23) && __lsn.state().stayDays === 13.75; })",
    "__lsn.commands.run('set_window', { landing: '2027-01-13', stay_days: 14 })", wait(`${FRAME}.dataset.heat === 'done'`)], checks: [
      { label: 'window off leaves playhead; cumulative mode returns an error; last-hour landing is not shifted by timeline', expr: 'window.__noWindow && window.__late' },
      { label: 'restoring the window brings back the original figures', expr: "__lsn.state().windowOn && __lsn.state().mapMode === 'both' && document.querySelector('.point-table tbody tr').textContent === 'Both in view261 h92 h' && !location.hash.includes('win=off')" },
    ], mustContain: ['data-heat="done"'] },
  { name: 'phase 5 M5: set playhead, play and pause share the clock', hash: '#site=shackleton', steps: [
    "(window.__sum = __lsn.api.getState().summary.planned, true)",
    "__lsn.commands.run('set_playhead', { at: '2027-01-18T06:45Z' })",
    "(window.__set = __lsn.state().cursorMs === Date.UTC(2027, 0, 18, 6, 45) && __lsn.timeline.getState().nowMs === __lsn.state().cursorMs && location.hash.includes('now=2027-01-18T06:45Z'), true)",
    "__lsn.commands.run('play')", { input: [{ wait: 250 }] }, "__lsn.commands.run('pause')"], checks: [
      { label: 'playhead command writes the clock and hash; playback moves it; pause stops it; aggregates hold still', expr: "window.__set && __lsn.state().cursorMs > Date.UTC(2027, 0, 18, 6, 45) && !__lsn.timeline.getState().playing && __lsn.api.getState().summary.planned === window.__sum" },
    ], mustContain: ['data-heat="done"'] },
  { name: 'phase 5 M5: layer commands use Layers switches', hash: '#site=shackleton', steps: [
    "(async () => { window.__layers = true; for (const name of ['live','psr','skyDial','best','labels','graticule']) { const key = name === 'skyDial' ? 'dial' : name; for (const on of [false,true]) { const r = await __lsn.commands.run('set_layer', { name, on }); window.__layers &&= !r.error && r.on === on && document.querySelector(`[data-layer=${key}]`).getAttribute('aria-checked') === String(on); if (key === 'live') window.__layers &&= document.querySelector('.map-frame').dataset.live === (on ? 'on' : 'off'); if (key === 'dial') window.__layers &&= __lsn.settings.get('skyDial') === on && document.querySelector('.skydial').hidden === !on; if (['best','labels','graticule'].includes(key)) window.__layers &&= document.querySelector('.map-frame').dataset[key] === (on ? 'on' : 'off'); } } await __lsn.commands.run('set_layer', { name: 'psr', on: false }); })()",
    wait(`${FRAME}.dataset.heat === 'done'`)], checks: [
      { label: 'all six layer commands agree with controls, settings and map attributes', expr: 'window.__layers' },
    ], mustContain: ['data-heat="done"'] },
  { name: 'phase 5 M5: detail tabs, legacy alias and open settings', hash: '', steps: [
    "(async () => { window.__tabs = true; for (const tab of ['overview','power','comms','compare']) { const r = await __lsn.commands.run('open_site_detail', { tab }); window.__tabs &&= !r.error && __lsn.sheet.isOpen() && __lsn.sheet.activeTab() === tab && location.hash.includes(`sheet=${tab}`); } const r = await __lsn.commands.run('open_navigator'); window.__alias = r.view === 'navigator' && __lsn.state().view === 'map' && __lsn.sheet.activeTab() === 'overview'; await __lsn.commands.run('open_settings'); })()",
    wait(`${FRAME}.dataset.heat === 'done'`)], checks: [
      { label: 'every detail tab works; Navigator alias opens Overview; settings replaces the detail sheet', expr: 'window.__tabs && window.__alias && __lsn.settingsSheet.isOpen() && !__lsn.sheet.isOpen() && !__lsn.panel.isOpen()' },
    ], mustContain: ['data-heat="done"'] },
  { name: 'phase 5 M5: unified tools and UI figures agree', hash: '#site=im2&alt=shackleton&slip=14', steps: [
    "(window.__before = JSON.stringify(__lsn.state()), true)",
    "__lsn.commands.run('compare_scenarios', { scenarios: [{ site_id: 'im2', landing: '2027-01-13' }, { site_id: 'shackleton', landing: '2027-01-27' }], stay_days: 14 }).then((r) => { window.__compare = r; window.__pure = JSON.stringify(__lsn.state()) === window.__before; })",
    "__lsn.commands.run('open_site_detail')", wait(`${FRAME}.dataset.heat === 'done'`)], checks: [
      { label: '38 unique definitions include every compute tool', expr: '__lsn.commands.list.length === 38 && new Set(__lsn.commands.list).size === 38 && __lsn.core.list.every((n) => __lsn.commands.toolDefinitions().some((d) => d.name === n))' },
      { label: 'compute did not mutate state; inspector, detail tiles and Compare card show the tool figures', expr: "window.__pure && window.__compare.scenarios[1].vsBaseline.card.slice(0,3).every((r, i) => { const row = document.querySelectorAll('.point-table tbody tr')[i].textContent; const tile = document.querySelectorAll('.site-sheet-tiles:not([hidden]) .site-sheet-tile')[i].textContent; const card = document.querySelector('.sheet-compare').textContent; return row.includes(r.baseline) && row.includes(r.scenario) && tile.includes(r.baseline) && card.includes(r.baseline) && card.includes(r.scenario); })" },
    ], mustContain: ['data-heat="done"'] },
  { name: 'phase 5 M5: scripted multi-site multi-date suggestion', hash: '', steps: [
    "(window.__before = JSON.stringify(__lsn.state()), [...document.querySelectorAll('.agent-suggestion')].find((b) => b.textContent.startsWith('Compare Shackleton ridge,')).click(), true)",
    wait("!__lsn.agent.busy && __lsn.agent.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'text' && b.text.includes('across the supplied scenarios')))"),
    `(window.__comparison = ${toolResult('compare_scenarios')}, true)`], checks: [
      { label: 'six scenarios; grounded figures in the rendered reply; no selected site/window/viewport change', expr: `(() => { const r = window.__comparison, b = r.scenarios[r.ranking.bothH[0]], reply = document.querySelector('deep-chat').shadowRoot.textContent; return r.count === 6 && reply.includes(b.bothH.toFixed(1) + ' h') && reply.includes(b.longestDarkH.toFixed(1) + ' h') && JSON.stringify(__lsn.state()) === window.__before; })()` },
      { label: 'only read-only tools used', expr: "__lsn.agent.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b.type === 'tool_use').every((b) => ['get_state','compare_scenarios'].includes(b.name))" },
    ], mustContain: ['data-heat="done"'] },
  { name: 'phase 5 M5: scripted visibility suggestion without a window', hash: '#win=off&site=im2&now=2027-01-13T05:00Z', steps: [
    "(window.__before = JSON.stringify(__lsn.state()), [...document.querySelectorAll('.agent-suggestion')].find((b) => b.textContent.startsWith(\"Why can't I see\")).click(), true)",
    wait("!__lsn.agent.busy && __lsn.agent.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'text' && b.text.includes('Visibility uses')))"),
    `(window.__sky = ${toolResult('sky_at')}, window.__next = ${toolResult('next_events')}, true)`], checks: [
      { label: 'rendered answer carries sky_at reasons and next_events headline at the playhead; state unchanged', expr: "(() => { const reply = document.querySelector('deep-chat').shadowRoot.textContent; return reply.includes(window.__sky.sun.why) && reply.includes(window.__sky.earth.why) && reply.includes(window.__next.headline) && window.__sky.at === '2027-01-13T05:00Z' && JSON.stringify(__lsn.state()) === window.__before; })()" },
    ], mustContain: [] },
);

// ---------- 2026-11-13 round 3: review 2 (F1–F10), the site list, labelled controls ----------
const PAUSED = "(__lsn.timeline.pause(), true)";
// every input and button of an open time-dock popover is the element a click at its centre would reach
const DOCK_POP_ON_TOP = (q) => `(() => { const p = document.querySelector('.timedock ${q}'); const els = [...p.querySelectorAll('input, button')].filter((e) => e.getClientRects().length); return !p.hidden && els.length > 0 && els.every((e) => { const b = e.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return hit === e || e.contains(hit); }); })()`;
const iso = (ms) => `new Date(${ms}).toISOString()`;
SCENARIOS.push(
  // F1: the last instant of the ephemeris: one request, the page answers, the row says nothing more comes
  { name: 'phase 5 R2 F1: countdown at the end of the ephemeris', hash: '#site=im2&win=off&now=2029-01-01T00:00Z', steps: [PAUSED, wait("/before 1 Jan 2029|past 1 Jan 2029/.test(document.querySelector('.insp-count').textContent)", 8000)],
    checks: [{ label: 'the row reads the end, the page still answers', expr: "/before 1 Jan 2029|past 1 Jan 2029/.test(document.querySelector('.insp-count').textContent) && __lsn.timeline.getState().nowMs === Date.UTC(2029, 0, 1)" }], mustContain: [] },
  // F1 (the freeze): the dock's "Next rise or set" puts the playhead on an event; the countdown used to chain
  // requests forever there and the page never answered again
  { name: 'phase 5 R2 F1: next rise or set does not freeze the page', hash: '#site=shackleton', steps: [PAUSED,
    "(document.querySelector('.timedock .td-next').click(), true)", { input: [{ wait: 600 }] }, "(document.querySelector('.timedock .td-next').click(), true)", { input: [{ wait: 600 }] }],
    checks: [{ label: 'the page answers; the row counts down from the event', expr: "/in \\d/.test(document.querySelector('.insp-count').textContent) && __lsn.timeline.getState().nowMs > Date.UTC(2027, 0, 13)" }], mustContain: ['data-heat="done"'] },
  // F2: editing Landing keeps the requested stay, though the ephemeris end cuts the window
  { name: 'phase 5 R2 F2: Landing edit keeps the requested stay', hash: '#site=im2&t=2028-12-26T00:00Z&stay=14', steps: [PAUSED,
    "(document.querySelector('.timedock .td-sum').click(), true)", { input: [{ wait: 200 }] },
    "(() => { const i = document.querySelector('.timedock .td-winpop input[type=datetime-local]'); i.value = '2028-12-20T00:00'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()", { input: [{ wait: 300 }] }],
    checks: [
      { label: 'stay still 14 days, landing moved, timeline = the covered part', expr: "(() => { const st = __lsn.state(), w = __lsn.timeline.getState().window; return st.stayDays === 14 && st.landingMs === Date.UTC(2028, 11, 20) && w.inMs === st.landingMs && w.outMs === Date.UTC(2029, 0, 1) && location.hash.includes('stay=14'); })()" },
      { label: 'the window summary names the requested 14 days', expr: "/14 d/.test(document.querySelector('.timedock .td-sum').textContent)" },
    ], mustContain: [] },
  { name: 'phase 5 R2 F2: a stay cut to its last hour keeps its In', hash: '#t=2028-12-31T23:00Z&stay=13.75&slip=0', steps: [PAUSED],
    checks: [{ label: 'timeline In = landing (23:00), not a day earlier', expr: "__lsn.timeline.getState().window.inMs === __lsn.state().landingMs && __lsn.state().landingMs === Date.UTC(2028, 11, 31, 23)" }], mustContain: [] },
  // F3: the top bar does not move the playhead back
  { name: 'phase 5 R2 F3: switching views keeps the playhead', hash: '#now=2027-01-13T05:00Z', steps: [PAUSED,
    "(__lsn.timeline.setNow(Date.UTC(2027, 0, 18, 6)), true)", { input: [{ wait: 200 }] },
    "(document.querySelector('.view-tab[data-view=evidence]').click(), true)", { input: [{ wait: 400 }] },
    "(document.querySelector('.view-tab[data-view=evidence]').click(), true)", { input: [{ wait: 400 }] }],   // a second click returns to the map
    checks: [{ label: 'still 18 Jan 06:00 after Evidence and back', expr: "__lsn.timeline.getState().nowMs === Date.UTC(2027, 0, 18, 6) && __lsn.state().cursorMs === Date.UTC(2027, 0, 18, 6) && __lsn.state().view === 'map'" }], mustContain: [] },
  // F4: a landing typed with minutes becomes the whole hour on the page and in the timeline alike
  { name: 'phase 5 R2 F4: non-whole-hour Landing', hash: '', steps: [PAUSED,
    "(document.querySelector('.timedock .td-sum').click(), true)", { input: [{ wait: 200 }] },
    "(() => { const i = document.querySelector('.timedock .td-winpop input[type=datetime-local]'); i.value = '2027-01-13T06:45'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()", { input: [{ wait: 300 }] }],
    checks: [{ label: 'landing 06:00 in both, stay 14 d', expr: "__lsn.state().landingMs === Date.UTC(2027, 0, 13, 6) && __lsn.timeline.getState().window.inMs === Date.UTC(2027, 0, 13, 6) && __lsn.timeline.getState().window.outMs - __lsn.timeline.getState().window.inMs === 14 * 864e5" }], mustContain: [] },
  // F5: two quick jumps while paused: the rows show the second instant
  { name: 'phase 5 R2 F5: the last jump lands in the live rows', hash: '#site=im2', steps: [PAUSED,
    "(__lsn.timeline.setNow(Date.UTC(2027, 0, 13, 5)), __lsn.timeline.setNow(Date.UTC(2027, 0, 18, 6)), true)", { input: [{ wait: 700 }] }],
    checks: [{ label: 'Now row = sky_at at the second instant', expr: "__lsn.core.run('sky_at', { site_id: 'im2', at: '2027-01-18T06:00Z' }).then((r) => { const m = /Sun ([+−][\\d.]+)° · Earth ([+−][\\d.]+)°/.exec(document.querySelector('.insp-now .insp-val').textContent); const v = (x) => Number(x.replace('−', '-')); return m && Math.abs(v(m[1]) - r.sun.aboveSkylineDeg) < 0.06 && Math.abs(v(m[2]) - r.earth.aboveSkylineDeg) < 0.06; })" }], mustContain: [] },
  // F7: the battery chart's cursor follows the playhead
  { name: 'phase 5 R2 F7: battery cursor', hash: '#sheet=power&site=im2', steps: [PAUSED, wait("document.querySelector('.energy-cursor')"),
    "(window.__x = document.querySelector('.energy-cursor').getAttribute('x1'), __lsn.timeline.setNow(Date.UTC(2027, 0, 20, 12)), true)", { input: [{ wait: 200 }] }],
    checks: [{ label: 'the cursor moved, with the charge at the playhead', expr: "document.querySelector('.energy-cursor').getAttribute('x1') !== window.__x && / now$/.test(document.querySelector('.energy-cursor-label').textContent)" }], mustContain: [] },
  // F8: get_energy / set_relay_orbit open their tab, except while the Ask panel is open
  { name: 'phase 5 R2 F8: energy and relay commands show their card', hash: '', steps: [PAUSED,
    "__lsn.commands.run('get_energy', {}).then((r) => (window.__e = r, true))", { input: [{ wait: 300 }] },
    "(window.__a = __lsn.sheet.isOpen() && __lsn.sheet.activeTab() === 'power', __lsn.sheet.close(), document.querySelector('[data-action=ask]').click(), true)", wait('__lsn.panel.isOpen()'),
    "__lsn.commands.run('set_relay_orbit', { preset: 'elliptical-12h' }).then((r) => (window.__r = r, true))"],
    checks: [
      { label: 'get_energy opened Power and says so', expr: "window.__a && /Power tab/.test(window.__e.shownIn)" },
      { label: 'with Ask open, set_relay_orbit leaves Ask open and says so', expr: "__lsn.panel.isOpen() && !__lsn.sheet.isOpen() && /not opened while the Ask panel is open/.test(window.__r.shownIn)" },
    ], mustContain: [] },
  // F10: loop off runs past Out; without a window the end of the ephemeris wraps to its start
  { name: 'phase 5 R2 F10: loop off crosses Out', hash: '#site=im2', motion: true, steps: [
    "(__lsn.timeline.pause(), __lsn.timeline.setLoop(false), __lsn.timeline.setNow(Date.UTC(2027, 0, 26, 12)), __lsn.timeline.setRate(7 * 864e5), __lsn.timeline.play(), true)", { input: [{ wait: 1200 }] }],
    checks: [{ label: 'past Out, still playing', expr: "__lsn.timeline.getState().playing && __lsn.timeline.getState().nowMs > Date.UTC(2027, 0, 27)" }], mustContain: [] },
  { name: 'phase 5 R2 F10: no window wraps at the ephemeris end', hash: '#win=off&now=2028-12-31T12:00Z', motion: true, steps: [
    "(__lsn.timeline.setRate(7 * 864e5), __lsn.timeline.play(), true)", { input: [{ wait: 1200 }] }],
    checks: [{ label: 'back at the start of the ephemeris', expr: "__lsn.timeline.getState().playing && __lsn.timeline.getState().nowMs < Date.UTC(2027, 0, 1)" }], mustContain: [] },
  // the site list (owner, 2026-11-13): closed by default, a labelled Sites button, a close cross, Esc,
  // the inspector's site name opens it, remembered for the session; typed points in the inspector
  { name: 'phase 5 sites: closed by default, labelled, closable', hash: '', steps: [PAUSED,
    "(sessionStorage.removeItem('lsn-panels-v4'), location.reload(), true)", { input: [{ wait: 1500 }] }, wait("window.__lsn && document.querySelector('.app.is-bigmap')"),
    "(window.__closed0 = document.querySelector('.app').dataset.left === 'closed' && getComputedStyle(document.querySelector('.sidebar')).display === 'none', true)",
    "(document.querySelector('.map-toolcol .sites-btn').click(), true)", { input: [{ wait: 150 }] },
    "(window.__open1 = document.querySelector('.app').dataset.left === 'open' && document.activeElement === document.querySelector('.side-close'), document.querySelector('.side-close').click(), true)", { input: [{ wait: 150 }] },
    "(window.__closed1 = document.querySelector('.app').dataset.left === 'closed' && document.activeElement === document.querySelector('.sites-btn'), document.querySelector('.insp-name-btn').click(), true)", { input: [{ wait: 150 }] },
    "(window.__open2 = document.querySelector('.app').dataset.left === 'open', document.querySelector('.sidebar .site').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)", { input: [{ wait: 150 }] }],
    checks: [
      { label: 'closed at first; Sites opens; the cross closes; the site name opens; Esc closes', expr: "window.__closed0 && window.__open1 && window.__closed1 && window.__open2 && document.querySelector('.app').dataset.left === 'closed'" },
      { label: 'Sites is a text button; the cross has a name and a tooltip', expr: "document.querySelector('.sites-btn').textContent === 'Sites' && document.querySelector('.side-close').getAttribute('aria-label') === 'Close the site list' && document.querySelector('.side-close').title" },
      { label: 'no Custom site form in the list; Coordinates offers to type a point', expr: "getComputedStyle(document.querySelector('form.custom')).display === 'none' && getComputedStyle(document.querySelector('[data-fold=coords]')).display !== 'none' && /Type a point/.test(document.querySelector('[data-fold=coords] .fold-toggle').textContent)" },
    ], mustContain: [] },
  { name: 'phase 5 sites: the choice is kept for the session', hash: '', steps: [
    "(document.querySelector('.map-toolcol .sites-btn').click(), location.reload(), true)", { input: [{ wait: 1500 }] }, wait("window.__lsn && document.querySelector('.app.is-bigmap')")],
    checks: [{ label: 'open after a reload, then cleared for the next scenario', expr: "(() => { const ok = document.querySelector('.app').dataset.left === 'open'; sessionStorage.removeItem('lsn-panels-v4'); return ok; })()" }], mustContain: [] },
  // a typed point in one step: Coordinates in the point inspector
  { name: 'phase 5 sites: a typed point from the inspector', hash: '', steps: [PAUSED,
    "(document.querySelector('[data-fold=coords] .fold-toggle').click(), true)", { input: [{ wait: 200 }] }, fillEntry(['-88', '30']), { input: [{ wait: 400 }] }],
    checks: [{ label: 'the typed point is the selected point', expr: "document.querySelector('.point-name').textContent === 'Map point' && location.hash.includes('site=c:-88,30')" }], mustContain: ['data-heat="done"'] },
  // every closable or toggled thing: a visible label or a standard close cross, a tooltip, an accessible name
  { name: 'phase 5 labels: closable things are labelled', hash: '', steps: [PAUSED, "(document.querySelector('.layers-btn').click(), document.querySelector('.timedock .td-sum').click(), true)", { input: [{ wait: 200 }] }],
    checks: [{ label: 'each has a name and a tooltip or visible text', expr: "['.sites-btn', '.side-close', '.right-toggle', '.dial-btn', '.details-btn', '.layers-btn', '.layers-close', '.site-sheet-close', '.doc-sheet .site-sheet-close', '.lsn-set-close', '.agent-close', '.timedock .td-done', '.timedock .td-sum', '.right-reopen', '.fs-btn'].every((q) => { const e = document.querySelector(q); if (!e) return false; const name = e.getAttribute('aria-label') || e.textContent.trim(); return name && (e.title || e.textContent.trim() || e.dataset.tip); })" }], mustContain: [] },
  // guide-cn problem 1: an open time-dock popover is never under another panel (the dock is raised while one is open)
  ...[['the inspector', 'true'], ['Details', "(document.querySelector('.details-btn').click(), true)"], ['Ask', "(document.querySelector('[data-action=ask]').click(), true)"], ['Settings', "(document.querySelector('[data-action=settings]').click(), true)"]].map(([what, open]) => ({
    name: `time dock popovers stay on top: ${what}`, hash: '', steps: [PAUSED, open, { input: [{ wait: 900 }] }, "(document.querySelector('.timedock .td-sum').click(), true)", { input: [{ wait: 500 }] }],
    checks: [
      { label: 'the mission window popover is open', expr: "!document.querySelector('.timedock .td-winpop').hidden" },
      { label: 'every control in it is the top element at its centre', expr: DOCK_POP_ON_TOP('.td-winpop') },
      { label: 'the speed menu is on top too', expr: `(document.querySelector('.timedock .td-speed').click(), ${DOCK_POP_ON_TOP('.td-speed-menu')})` },
      { label: 'closing puts the dock back in its layer', expr: "(document.querySelector('.timedock .td-speed').click(), !document.querySelector('.timedock').classList.contains('has-pop') && getComputedStyle(document.querySelector('.timedock')).zIndex === '12')" },
    ], mustContain: [] })),
);

// Every scenario runs in one headless Chrome driven over the DevTools protocol (Node's built-in
// WebSocket). Headless Chrome will not open a window narrower than 500px, so the viewport is set by
// device emulation (1440×900 unless the scenario names a width). --dump-dom is not used: its virtual
// time does not reliably wait for requestAnimationFrame, and the map's heat job runs in rAF slices, so
// a dump could fire while the job was still working. Instead each scenario polls a readiness check in
// the page with a real timeout. Every protocol call has its own timeout and a closed or failed socket
// rejects everything pending, so a stuck browser fails the run instead of hanging it.
const CALL_TIMEOUT_MS = 30000;
const READY_TIMEOUT_MS = 45000;

// ---------- phase 6 (docs/phase6/brief-opus-stories.md): the verdict, the way out, the stories ----------
const VERDICT_READY = "!document.querySelector('.insp-verdict-block').hidden && !document.querySelector('.insp-wayout').hidden";
const STATE_NOW = "(() => { const s = __lsn.state(), t = __lsn.timeline.getState(); return JSON.stringify({ hash: location.hash, site: s.site.id, lat: s.site.latDeg, slip: s.slipDays, alt: s.altSite, mode: s.mapMode, view: s.viewport, win: s.windowOn, land: s.landingMs, stay: s.stayDays, now: t.nowMs, rate: t.rate, loop: t.loop, playing: t.playing, dial: __lsn.settings.get('skyDial'), left: document.querySelector('.app').dataset.left, right: document.querySelector('.app').dataset.right }); })()";
// Open the Tour menu, pick story n, walk steps 1 to 5 with Next (recording the card and the page at each),
// then leave with Escape. window.__walk, __before, __after, __menu hold what was seen.
const WALK = (n) => `new Promise(async (ok) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f) => { for (let i = 0; i < 300 && !f(); i++) await sleep(50); return f(); };
  window.__before = ${STATE_NOW};
  document.querySelector('[data-action=tour]').click();
  const menu = document.getElementById('lsn-tour-menu');
  window.__menu = { open: !menu.hidden, items: [...menu.querySelectorAll('[role=menuitem]')].map((b) => b.textContent), expanded: document.querySelector('[data-action=tour]').getAttribute('aria-expanded') };
  document.querySelector('[data-story-pick="${n}"]').click();
  const card = document.querySelector('.story-card');
  const walk = [];
  for (let s = 1; s <= 5; s++) {
    await until(() => !card.hidden && card.dataset.step === String(s));
    await sleep(200);
    const d = document.querySelector('.skydial'), dr = d && !d.hidden ? d.getBoundingClientRect() : null, cr = card.getBoundingClientRect();
    const st = __lsn.state(), tl = __lsn.timeline.getState();
    walk.push({ step: card.dataset.step, count: card.querySelector('.story-count').textContent, title: card.querySelector('.story-title').textContent, text: card.querySelector('.story-text').textContent,
      site: st.site.id, slip: st.slipDays, land: st.landingMs, mode: st.mapMode, playing: tl.playing, now: tl.nowMs, hash: location.hash,
      lit: document.querySelectorAll('.story-lit').length, marks: document.querySelectorAll('.td-mark').length, dial: d?.dataset.focus ?? null,
      dialClear: !!dr && dr.bottom <= cr.top + 1 && dr.top >= 56 && dr.left >= 0 && dr.right <= innerWidth, dimmed: getComputedStyle(document.querySelector('.views')).opacity, story: document.querySelector('.app').dataset.story });
    if (s < 5) card.querySelector('[data-story-nav=next]').click();
  }
  window.__walk = walk;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => card.hidden);
  await sleep(300);
  window.__after = ${STATE_NOW};
  ok(true);
})`;
const WALK_CHECKS = [
  { label: 'the Tour menu: three stories and the tour of the controls', expr: "__menu.open && __menu.expanded === 'true' && __menu.items.length === 4 && /Why the Sun never climbs here/.test(__menu.items[0]) && /Why Earth can set/.test(__menu.items[1]) && /What a two-week slip does/.test(__menu.items[2]) && /Tour of the controls/.test(__menu.items[3])" },
  { label: 'five steps, 1 / 5 to 5 / 5, each with a title and a text', expr: "__walk.length === 5 && __walk.every((w, i) => w.step === String(i + 1) && w.count === `${i + 1} / 5` && w.title.length > 5 && w.text.length > 30)" },
  { label: 'no placeholder in any card', expr: "__walk.every((w) => !/[{}]|NaN|undefined|null|Infinity/.test(w.title + w.text))" },
  { label: 'the story scenario: IM-2 Athena, 13 Jan 2027, slip 14', expr: "__walk.every((w) => w.site === 'im2' && w.slip === 14 && w.land === Date.UTC(2027, 0, 13))" },
  { label: 'the controls it does not use are dimmed', expr: "__walk.every((w) => w.story === 'on' && Number(w.dimmed) < 0.5)" },
  { label: 'the sky dial whole and above the card', expr: "__walk.every((w) => w.dialClear)" },
  { label: 'paused (reduced motion), the address bar untouched', expr: "__walk.every((w) => !w.playing && w.hash === JSON.parse(__before).hash)" },
  { label: 'leaving puts every part of the state back', expr: "__after === __before && !document.querySelector('.app').dataset.story && document.querySelector('.story-card').hidden && !document.querySelector('.td-mark') && !document.querySelector('.skydial[data-focus]') && !document.querySelector('.story-lit')" },
];
// the visitor's own state before the story: another site, slip, mode and a zoomed view (all must come back)
const VISITOR = '#site=shackleton&slip=7&mode=sun&z=2&cx=-10&cy=-20';
SCENARIOS.push(
  { name: 'phase 6: the verdict and the way out', hash: '', steps: [wait(VERDICT_READY)], checks: [
    { label: 'the verdict sentence', expr: "document.querySelector('.insp-verdict').textContent === 'Slipping 14 days cuts Sun-and-Earth time from 312 h to 12 h.'" },
    { label: 'its figures are the table\'s', expr: "(() => { const r = document.querySelector('.point-table tbody tr'); return r.children[1].textContent === '312 h' && r.children[2].textContent === '12 h' && document.querySelector('.insp-verdict-worse').textContent === '12 h'; })()" },
    { label: 'verdict, way out, table, then the Now row (mock order)', expr: "(() => { const v = document.querySelector('.insp-verdict-block'), t = document.querySelector('.point-table'), n = document.querySelector('.insp-now'); return v.compareDocumentPosition(t) & 4 && t.compareDocumentPosition(n) & 4; })()" },
    { label: 'the way out is best_landing_dates\' first day and compare_scenarios\' figure', expr: "__lsn.core.run('best_landing_dates', { site_id: 'im2', stay_days: 14, count: 1, from: '2027-01-27', to: '2027-02-24' }).then((b) => __lsn.core.run('compare_scenarios', { scenarios: [{ site_id: 'im2', landing: '2027-01-13T00:00Z' }, { site_id: 'im2', landing: b.candidates[0].landing }], stay_days: 14 }).then((c) => b.candidates[0].landing === '2027-02-10T00:00Z' && document.querySelector('.insp-wayout-value').textContent === `10 Feb 2027 · ${c.scenarios[1].vsBaseline.card[0].scenario}` && document.querySelector('.insp-wayout-label').textContent === 'Best landing in the 4 weeks after 27 Jan'))" },
    { label: 'the inspector clear of the time bar', expr: "document.querySelector('.point-panel').getBoundingClientRect().bottom <= document.querySelector('.timedock').getBoundingClientRect().top" },
  ], mustContain: ['data-heat="done"', '>Set as alternative<', 'Best landing in the 4 weeks after 27 Jan'] },
  { name: 'phase 6: the verdict at 1728×996', hash: '', width: 1728, height: 996, desktop: true, steps: [wait(VERDICT_READY)], checks: [
    { label: 'the inspector clear of the time bar', expr: "document.querySelector('.point-panel').getBoundingClientRect().bottom <= document.querySelector('.timedock').getBoundingClientRect().top" },
  ], mustContain: ['Slipping 14 days cuts Sun-and-Earth time from 312 h to <span class="insp-verdict-worse">12 h</span>.'] },
  { name: 'phase 6: Set as alternative', hash: '', steps: [wait(VERDICT_READY),
    "(document.querySelector('[data-action=set-alternative]').click(), true)",
    wait("__lsn.state().slipDays === 28 && document.querySelector('.point-table tbody tr').children[2].textContent !== '12 h'")], checks: [
    { label: 'the alternative is 10 Feb 2027 (slip 28) and the table follows', expr: "__lsn.state().slipDays === 28 && location.hash.includes('slip=28') && document.querySelector('.point-table tbody tr').children[2].textContent === '266 h' && document.querySelector('.point-table thead').textContent.includes('+28 d')" },
    { label: 'the verdict follows', expr: "document.querySelector('.insp-verdict').textContent === 'Slipping 28 days cuts Sun-and-Earth time from 312 h to 266 h.'" },
    { label: 'the time bar names the new alternative', expr: "document.querySelector('.td-sum-long').textContent.includes('alt +28 d')" },
  ], mustContain: ['data-heat="done"'] },
  { name: 'phase 6: no window, no verdict', hash: '#win=off', checks: [{ label: 'no verdict block', expr: "document.querySelector('.insp-verdict-block').hidden" }], mustContain: [] },
  { name: 'phase 6: story 1, why the Sun never climbs here', hash: VISITOR, steps: [WALK(1)], checks: [...WALK_CHECKS,
    { label: 'the figures are the compute tier\'s', expr: "Promise.all([__lsn.core.run('compare_scenarios', { places: [{ site_id: 'im2' }], landings: ['2027-01-13', '2027-01-27'], stay_days: 14 }), __lsn.core.run('next_events', { site_id: 'im2', at: '2027-01-13T00:00Z' })]).then(([c, n]) => __walk[1].text.includes(`never more than ${c.scenarios[0].display.peakSun} above`) && __walk[2].text.includes(`Sun is ${n.sun.elDeg.toFixed(1)}° up`) && __walk[2].text.includes(`reach ${n.sun.skylineDeg.toFixed(1)}°`) && __walk[2].text.includes(`at ${n.sun.nextRise.time.slice(11, 16)} that day`) && __walk[4].text.includes(`up for ${Math.round(c.scenarios[0].sunH)} of the 336 hours`))" },
    { label: 'step states: Both, then Sunlit; the dial points at the Sun\'s track, then the skyline; Sunlit row lit', expr: "__walk.map((w) => w.mode).join() === 'both,both,both,sun,sun' && __walk[0].dial === 'sun-track' && __walk[2].dial === 'skyline' && __walk[4].lit === 3 && __walk[0].now === Date.UTC(2027, 0, 13)" },
  ], mustContain: ['data-heat="done"'] },
  { name: 'phase 6: story 2, why Earth can set', hash: VISITOR, steps: [WALK(2)], checks: [...WALK_CHECKS,
    { label: 'the figures are the compute tier\'s', expr: "Promise.all([__lsn.core.run('next_events', { site_id: 'im2', at: '2027-01-13T00:00Z' }), __lsn.core.run('sky_at', { site_id: 'im2', at: '2027-01-20T00:00Z' }), __lsn.core.run('rise_set_events', { site_id: 'im2', start: '2027-01-27T00:00Z', days: 14 })]).then(([n, s, r]) => { const set = r.events.find((e) => e.event === 'Earthset'), rise = r.events.find((e) => e.event === 'Earthrise'); return __walk[0].text.includes(`Earth is ${n.earth.aboveSkylineDeg.toFixed(1)}° above`) && __walk[1].text.includes(`on 20 Jan it is ${Math.round(s.earth.aboveSkylineDeg)}° above`) && __walk[2].text.includes(`at ${set.time.slice(11, 16)} UTC`) && __walk[3].text.includes(`at ${rise.time.slice(11, 16)}, ${rise.then ? '' : ''}`) && __walk[3].text.includes('5 days 16 hours later') && __walk[2].now === Date.parse(set.time) && __walk[3].now === Date.parse(rise.time); })" },
    { label: 'step states: Earthset and Earthrise marked; Earth in view mode and row lit at the end', expr: "__walk[2].marks === 1 && __walk[3].marks === 2 && __walk[4].mode === 'earth' && __walk[4].lit === 3 && __walk[1].dial === 'earth-track'" },
  ], mustContain: ['data-heat="done"'] },
  { name: 'phase 6: story 3, what a two-week slip does', hash: VISITOR, steps: [WALK(3)], checks: [...WALK_CHECKS,
    { label: 'the figures are the compute tier\'s, and the way out is the inspector\'s', expr: "Promise.all([__lsn.core.run('compare_scenarios', { places: [{ site_id: 'im2' }], landings: ['2027-01-13', '2027-01-27'], stay_days: 14 }), __lsn.core.run('best_landing_dates', { site_id: 'im2', stay_days: 14, count: 1, from: '2027-01-27', to: '2027-02-24' })]).then(([c, b]) => { const card = Object.fromEntries(c.scenarios[1].vsBaseline.card.map((r) => [r.label, r])); return __walk[0].text.includes(`both in view for ${card['Both in view'].baseline.replace(' h', '')} of 336 hours`) && __walk[2].text.includes(`from ${card.Sunlit.baseline} to ${card.Sunlit.scenario}`) && __walk[3].text.includes(`${card['Both in view'].scenario.replace(' h', '')} hours instead of ${card['Both in view'].baseline.replace(' h', '')}`) && __walk[4].text.includes(`10 Feb 2027: ${b.candidates[0].exact.bothH} hours`); })" },
    { label: 'the last step lights the verdict and Set as alternative', expr: "__walk[4].lit >= 3 && __walk[0].lit === 4" },
  ], mustContain: ['data-heat="done"'] },
  // real keys: → and ← page, Esc leaves; the arrows do not move the playhead (the time bar's own shortcut)
  { name: 'phase 6: story keys', hash: '', steps: [
    "(document.querySelector('[data-action=tour]').click(), document.querySelector('[data-story-pick=\"2\"]').click(), true)",
    wait("document.querySelector('.story-card').dataset.step === '1' && document.activeElement === document.querySelector('[data-story-nav=next]')"),
    { input: [{ key: 'ArrowRight' }, { wait: 400 }, { key: 'ArrowRight' }, { wait: 400 }] },
    "(window.__k2 = { step: document.querySelector('.story-card').dataset.step, now: __lsn.timeline.getState().nowMs }, true)",
    { input: [{ key: 'ArrowLeft' }, { wait: 400 }] },
    "(window.__k1 = document.querySelector('.story-card').dataset.step, true)",
    { input: [{ key: 'Escape' }, { wait: 400 }] }], checks: [
    { label: '→ twice: step 3, the playhead on the Earthset', expr: "__k2.step === '3' && __k2.now === Date.UTC(2027, 0, 27, 12, 26)" },
    { label: '← back to step 2', expr: "__k1 === '2'" },
    { label: 'Esc leaves; focus on the Tour button', expr: "document.querySelector('.story-card').hidden && document.activeElement === document.querySelector('[data-action=tour]')" },
    { label: 'the card is a labelled dialog with a live step line', expr: "(() => { const c = document.querySelector('.story-card'); return c.getAttribute('role') === 'dialog' && document.getElementById(c.getAttribute('aria-labelledby')) && c.querySelector('[aria-live=polite]').textContent.startsWith('Step 2 of 5'); })()" },
  ], mustContain: ['data-heat="done"'] },
  // playback inside a step (motion allowed): story 2 step 2 plays the stay; leaving keeps the visitor's playback
  { name: 'phase 6: story playback', hash: '', motion: true, steps: [
    "(document.querySelector('[data-action=tour]').click(), document.querySelector('[data-story-pick=\"2\"]').click(), true)",
    wait("document.querySelector('.story-card').dataset.step === '1'"),
    "(document.querySelector('[data-story-nav=next]').click(), true)",
    wait("document.querySelector('.story-card').dataset.step === '2' && __lsn.timeline.getState().playing"),
    "(window.__t0 = __lsn.timeline.getState().nowMs, true)", { input: [{ wait: 1200 }] },
    "(window.__t1 = __lsn.timeline.getState().nowMs, window.__rate = __lsn.timeline.getState().rate, __lsn.story.stop(), true)", { input: [{ wait: 300 }] }], checks: [
    { label: 'the step plays at 6 h/s', expr: "__t1 > __t0 && __rate === 6 * 3600e3" },
    { label: 'after leaving, the visitor\'s playback and loop are back', expr: "__lsn.timeline.getState().playing === true && __lsn.timeline.getState().loop === true && document.querySelector('.story-card').hidden" },
  ], mustContain: ['data-heat="done"'] },
  // a narrow window: the card readable, paging and leaving work, no sideways scroll
  { name: 'phase 6: story on a phone', hash: '', width: 390, steps: [
    "(document.querySelector('[data-action=tour]').click(), document.querySelector('[data-story-pick=\"3\"]').click(), true)",
    wait("document.querySelector('.story-card').dataset.step === '1'"),
    "(window.__cardBox = JSON.stringify(document.querySelector('.story-card').getBoundingClientRect()), document.querySelector('[data-story-nav=next]').click(), true)",
    wait("document.querySelector('.story-card').dataset.step === '2'"),
    "(document.querySelector('.story-close').click(), true)",
    "(() => { document.documentElement.dataset.overflow = String(document.documentElement.scrollWidth > window.innerWidth); return true; })()"], checks: [
    { label: 'the card inside the screen', expr: "(() => { const r = JSON.parse(__cardBox); return r.left >= 0 && r.right <= 390 && r.top >= 0 && r.bottom <= 844 && r.width > 300; })()" },
    { label: 'closed', expr: "document.querySelector('.story-card').hidden && !document.querySelector('.app').dataset.story" },
  ], mustContain: ['data-overflow="false"', 'data-viewport="390"'] },
);

async function openBrowser() {
  const profile = mkdtempSync(join(tmpdir(), 'lsn-smoke-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    // SMOKE_OFFLINE=1: no host name resolves, as on a laptop without a network (only the font request needs one)
    ...(process.env.SMOKE_OFFLINE ? ['--host-resolver-rules=MAP * ~NOTFOUND'] : []), 'about:blank'], { stdio: 'ignore' });
  // SIGKILL: a hung Chrome may ignore SIGTERM, and a live child process would keep this script running.
  const close = async () => { chrome.kill('SIGKILL'); await sleep(200); rmSync(profile, { recursive: true, force: true }); };
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
    if (!existsSync(portFile)) throw new Error('Chrome did not open a DevTools port');
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (!target) await sleep(100);
    }
    if (!target) throw new Error('Chrome opened no page target');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('DevTools socket failed to open')); });
    let id = 0;
    const pending = new Map();
    // The first protocol failure marks the browser dead, so every later call fails at once instead of
    // waiting out its own timeout (a killed Chrome may never close the socket).
    let dead = null;
    const rejectAll = (why) => { dead ??= why; for (const p of pending.values()) { clearTimeout(p.timer); p.fail(new Error(why)); } pending.clear(); };
    // Console errors, uncaught exceptions and failed loads since the last navigation.
    const errors = [];
    const onEvent = {
      'Runtime.exceptionThrown': (p) => errors.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`),
      'Runtime.consoleAPICalled': (p) => { if (p.type === 'error' || p.type === 'assert') errors.push(`console.${p.type}: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`); },
      // Inter comes from Google Fonts; offline that request fails, and only that request is excused
      'Log.entryAdded': (p) => { if (p.entry.level === 'error' && !/fonts\.(googleapis|gstatic)\.com/.test(`${p.entry.url ?? ''} ${p.entry.text}`)) errors.push(`${p.entry.source}: ${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`); },
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.method) { onEvent[msg.method]?.(msg.params); return; }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.fail(new Error(`${p.method}: ${msg.error.message}`)); else p.ok(msg.result);
    };
    ws.onclose = () => rejectAll('DevTools socket closed');
    ws.onerror = () => rejectAll('DevTools socket error');
    const send = (method, params = {}) => new Promise((ok, fail) => {
      if (dead) { fail(new Error(`browser unusable: ${dead}`)); return; }
      const n = ++id;
      const timer = setTimeout(() => rejectAll(`${method} timed out after ${CALL_TIMEOUT_MS} ms`), CALL_TIMEOUT_MS);   // fails this call and every other pending one
      pending.set(n, { ok, fail, timer, method });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.text}`);
      return r.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    return { send, evaluate, errors, close: async () => { ws.onclose = null; ws.close(); await close(); } };
  } catch (err) {
    await close();
    throw err;
  }
}

// Ready: the page has drawn its heading, a visible map is not still computing heat, and when the
// scenario checks for finished heat, the map frame says so.
const readyCheck = (needHeat) => `(() => {
  if (!document.querySelector('h1')?.textContent) return false;
  const frame = document.querySelector('.map-frame');
  // (phase 4: the big-map frame is position: fixed, which has no offsetParent; client rects say it is shown)
  const visible = frame && frame.getClientRects().length > 0;
  if (visible && frame.dataset.heat === 'working') return false;
  return ${needHeat} ? !!(visible && frame.dataset.heat === 'done') : true;
})()`;

// Only the rendered app counts: script and style elements (the inlined data and code) are removed in
// the page, so their contents cannot satisfy or fail a check and the 20 MB of inlined terrain never
// crosses the socket.
const VISIBLE_DOM = `(() => {
  const copy = document.documentElement.cloneNode(true);
  copy.querySelectorAll('script, style').forEach((n) => n.remove());
  return copy.outerHTML;
})()`;

// Real input through the DevTools protocol, for the cases where synthetic events behave differently
// (focus-visible after a mouse click, Tab order, keys that reach document listeners). Each item is
// { click: [fx, fy] } (a mouse click at a fraction of the map frame), { key: 'Enter' | 'Tab' | … ,
// shift?, times? } or { wait: ms }.
const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
async function realInput(browser, items) {
  for (const it of items) {
    if (it.wait) { await sleep(it.wait); continue; }
    if (it.wheel) {
      const r = await browser.evaluate("(() => { const r = document.querySelector('.map-frame').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()");
      const x = r[0] + it.wheel[0] * r[2], y = r[1] + it.wheel[1] * r[3];
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: it.wheel[2], modifiers: it.ctrl ? 2 : 0 });
      await sleep(it.pause ?? 60);
      continue;
    }
    if (it.click) {
      const r = await browser.evaluate("(() => { const r = document.querySelector('.map-frame').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()");
      const x = r[0] + it.click[0] * r[2], y = r[1] + it.click[1] * r[3];
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      for (let n = 1; n <= (it.double ? 2 : 1); n++) {
        await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: n });
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: n });
      }
      await sleep(60);
      continue;
    }
    for (let n = 0; n < (it.times ?? 1); n++) {
      const base = { key: it.key, code: it.key, windowsVirtualKeyCode: KEY_CODES[it.key], modifiers: it.shift ? 8 : 0 };
      await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: it.key === 'Enter' ? '\r' : undefined });
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(it.pause ?? 40);
    }
  }
}

async function render(browser, url, width, needHeat, steps, checks, desktop = false, height = 900, motion = false, dpr = 1) {
  // phase 5: the time dock plays on load unless reduced motion is asked for; scenarios run paused (reduced
  // motion) so their figures hold still, except those that test playback (motion: true)
  await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion ? 'no-preference' : 'reduce' }] });
  // `desktop`: a window that is not a phone (phase 4: 1000 px still uses the phase 3 layout); `height` with it
  await browser.send('Emulation.setDeviceMetricsOverride', width
    ? (desktop ? { width, height, deviceScaleFactor: dpr, mobile: false } : { width, height: 844, deviceScaleFactor: dpr, mobile: true })
    : { width: 1440, height: 900, deviceScaleFactor: dpr, mobile: false });
  await browser.send('Page.navigate', { url: 'about:blank' });   // a hash-only change would not reload
  browser.errors.length = 0;
  await browser.send('Page.navigate', { url });
  const t0 = Date.now();
  let ready = false;
  while (!ready && Date.now() - t0 < READY_TIMEOUT_MS) {
    // a script error in the page means not ready yet; a protocol timeout or a closed socket fails now
    ready = await browser.evaluate(readyCheck(needHeat)).catch((err) => { if (err.message.startsWith('page error')) return false; throw err; });
    if (!ready) await sleep(250);
  }
  const ms = Date.now() - t0;
  for (const step of (ready && steps) || []) {
    if (typeof step === 'string') await browser.evaluate(step);
    else await realInput(browser, step.input);
  }
  const failedChecks = [];
  for (const c of (ready && checks) || []) if (!(await browser.evaluate(c.expr).catch(() => false))) failedChecks.push(c.label);
  await sleep(100);   // let late console events from the last evaluation arrive
  return { dom: await browser.evaluate(VISIBLE_DOM), ready, ms, failedChecks, errors: [...browser.errors] };
}

let failed = 0;
// SMOKE_ONLY=<regex> runs only the scenarios whose name matches (for iterating; the full run is the record)
const only = process.env.SMOKE_ONLY ? new RegExp(process.env.SMOKE_ONLY) : null;
const RUN = SCENARIOS.filter((x) => !only || only.test(x.name ?? ''));
const browser = await openBrowser();
try {
  // SMOKE_ONLY=<regex> runs only the scenarios whose name matches (for iterating; the full run is the record)
  for (const sc of RUN) {
    const label = `${sc.name ? `${sc.name}: ` : ''}${sc.hash || '(default)'}${sc.width ? ` @${sc.width}${sc.height ? `×${sc.height}` : ''}px` : ''}`;
    let result;
    try {
      result = await render(browser, PAGE + sc.hash, sc.width, (sc.mustContain ?? []).includes('data-heat="done"'), sc.steps, sc.checks, sc.desktop, sc.height, sc.motion, sc.dpr);
    } catch (err) {
      failed++;
      console.log(`FAIL ${label}\n  error: ${err.message}`);
      continue;
    }
    const { dom, ready, ms, failedChecks, errors } = result;
    const missing = (sc.mustContain ?? []).filter((t) => !dom.includes(t));
    const present = [...ALWAYS_ABSENT, ...(sc.mustNotContain ?? [])].filter((t) => dom.includes(t));
    if (!ready || missing.length || present.length || failedChecks.length || errors.length) {
      failed++;
      console.log(`FAIL ${label}`);
      if (!ready) console.log(`  not ready after ${READY_TIMEOUT_MS} ms`);
      for (const t of missing) console.log(`  missing: ${t}`);
      for (const t of present) console.log(`  must not contain: ${t}`);
      for (const t of failedChecks) console.log(`  check failed: ${t}`);
      for (const t of errors) console.log(`  console: ${t}`);
    } else {
      console.log(`ok   ${label}  (${(ms / 1000).toFixed(1)} s)`);
    }
  }
} finally {
  await browser.close();
}
console.log(`page: ${PAGE}`);
console.log(failed ? `${failed} of ${RUN.length} scenarios failed (each also checks for console errors)` : `all ${RUN.length} scenarios passed, with no console errors`);
process.exit(failed ? 1 : 0);
