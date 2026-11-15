// The Evidence view (spec §9.5, phase 3 §7 item 8): five questions a judge asks, the validation tables, and the limits.
import { h, clear } from './dom.js';
import { DATA_SOURCES, SHOWN_LABEL } from '../data-sources.js';

// Every dataset, how the page shows it (a NASA product as published, NASA data we calculate with, or our own
// calculation) and where it appears.
function sourcesTable() {
  return h('div', { class: 'table-scroll' }, h('table', { class: 'doc-table sources-table' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Data'), h('th', { scope: 'col' }, 'How it is shown'), h('th', { scope: 'col' }, 'Where in the app'))),
    h('tbody', null, DATA_SOURCES.map((s) => h('tr', { 'data-shown': s.shown },
      h('th', { scope: 'row' }, h('b', null, s.label), h('br'), h('span', { class: 'src-value' }, s.value)),
      h('td', { class: 'src-shown' }, SHOWN_LABEL[s.shown]),
      h('td', null, s.where))))));
}

const MINUS = '−';
const deg3 = (v) => `${v < 0 ? MINUS : ''}${Math.abs(v).toFixed(3)}°`;
const signed3 = (v) => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(3)}°`;

const pct1 = (v) => `${(v * 100).toFixed(1)}%`;

function terrainCheck(terrain) {
  if (!terrain) return null;
  const published = (c) => (c.kind === 'shadow' ? 'Permanently shadowed' : c.kind === 'lit' ? `Long illumination (${pct1(c.published)})` : pct1(c.published)); // taste-skill-ignore: 'shadow' is the validation check kind (a permanently shadowed floor), not a CSS shadow
  const note = (c) => {
    if (c.kind === 'shadow') return 'Limit under 1%'; // taste-skill-ignore: check kind, not a CSS shadow
    if (c.kind === 'lit') return `Limit at least 50%. ${c.note}`;
    return c.note;
  };
  return h('div', { class: 'terrain-check' },
    h('h3', null, 'Terrain check'),
    h('p', null, 'The terrain skyline was checked two ways. Crater floors known to be permanently shadowed must come out with no sunlight, and a ridge known for long illumination is compared with a published figure.'),
    h('div', { class: 'table-scroll' }, h('table', { class: 'doc-table terrain-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Point'), h('th', { scope: 'col' }, 'Published'), h('th', { scope: 'col', class: 'n' }, 'This demo'), h('th', { scope: 'col' }, 'Note'))),
      h('tbody', null, terrain.checks.map((c) => h('tr', null,
        h('th', { scope: 'row' }, c.name), h('td', null, published(c)), h('td', { class: 'n' }, `${pct1(c.sunlitShare)} sunlit`), h('td', { class: 'terrain-note' }, note(c))))))));
}

const pp1 = (v) => `${(v * 100).toFixed(1)}`;
const deg1 = (v) => `${v.toFixed(1)}°`;
const grid = (list, tag) => list.find((c) => c.grid === tag);

// Phase 3 checks (task book §7 item 4 is the only hard limit; the rest is shown without a pass mark).
function phase3Check(p3) {
  if (!p3) return null;
  const pts = p3.shadow.points;
  const hard = (stem) => ['2km', '1km'].map((tag) => pts.find((c) => c.grid === tag && c.name.startsWith(stem)));
  const rows = ['Shackleton floor', 'Shoemaker floor', 'Haworth floor', 'Faustini floor', 'Shackleton ridge'];
  const cell = (c) => `${c.shadowKm} km, ${c.pass ? 'pass' : 'fail'}`;
  const s2 = grid(p3.slope, '2km'), s1 = grid(p3.slope, '1km');
  const sh2 = grid(p3.shadow.shares, '2km'), sh1 = grid(p3.shadow.shares, '1km');
  const k = p3.consistency, sc2 = grid(p3.suitability, '2km');
  const floorScores = sc2.floors.map((f) => f.score);
  const earthFloors = sc2.floors.filter((f) => f.earth > 0).map((f) => f.name.replace(' floor', ''));
  const earthClause = earthFloors.length ? ` and, at ${earthFloors.join(' and ')}, a view of the Earth` : '';
  const closer = k.sites.filter((r) => r.closerToPoint === '1km').length;
  const landing = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(k.landingUtc));
  return h('div', { class: 'terrain-check' },
    h('h3', null, 'Slope, persistent shadow and the 1 km grid'), // taste-skill-ignore: persistent shadow is the terrain product (sunless cells), not a CSS shadow
    h('p', null, 'Crater floors known to be permanently shadowed must sit in persistent shadow, at a distance of 0 km, on both heat grids. The Shackleton ridge must not. These are the only pass marks; the other figures are shown as they came out.'),
    h('div', { class: 'table-scroll' }, h('table', { class: 'doc-table terrain-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Point'), h('th', { scope: 'col' }, 'Limit'), h('th', { scope: 'col', class: 'n' }, '2 km grid'), h('th', { scope: 'col', class: 'n' }, '1 km grid'))),
      h('tbody', null, rows.map((label) => {
        const [a, b] = hard(label);
        return h('tr', null, h('th', { scope: 'row' }, label), h('td', null, label.endsWith('ridge') ? 'Not persistent shadow' : 'Distance to persistent shadow 0 km'), h('td', { class: 'n' }, cell(a)), h('td', { class: 'n' }, cell(b))); // taste-skill-ignore: persistent shadow is the terrain product (sunless cells), not a CSS shadow
      })))),
    h('ul', { class: 'limits' },
      h('li', null, `Slope. The Shackleton floor averages ${deg1(s2.shackletonFloorDeg)} on the 2 km grid and ${deg1(s1.shackletonFloorDeg)} on the 1 km grid. Its wall, 6 to 8 km from the centre, averages ${deg1(s2.shackletonWallRingDeg)} and ${deg1(s1.shackletonWallRingDeg)}. Across the map the median cell is ${deg1(s2.mapDeg.p50)} and 90% of cells are under ${deg1(s2.mapDeg.p90)}.`),
      h('li', null, `Persistent shadow covers ${pp1(sh2.share)}% of the ground south of 80°S on the 2 km grid and ${pp1(sh1.share)}% on the 1 km grid.`), // taste-skill-ignore: persistent shadow is the terrain product (sunless cells), not a CSS shadow
      h('li', null, `Agreement. Over the default stay, ${k.stayDays} days from ${landing}, the mean sunlit share is ${pp1(k.mapMeanSun['2km'])}% on the 2 km grid and ${pp1(k.mapMeanSun['1km'])}% on the 1 km grid. Half of the 2 km cells are within ${pp1(k.blockAbsDiff.p50)} points of the four 1 km cells they cover, and 90% are within ${pp1(k.blockAbsDiff.p90)} points.`),
      h('li', null, `Suitability. At the default weights the median cell scores ${sc2.map.p50.toFixed(2)} and the top tenth scores above ${sc2.map.p90.toFixed(2)}. The four crater floors get no sunlight and score ${Math.min(...floorScores).toFixed(2)} to ${Math.max(...floorScores).toFixed(2)}. Being inside persistent shadow earns nothing; what is left comes from gentle slopes${earthClause}. Use the longest dark filter to rule such ground out.`)),
    h('p', null, `Sunlit share at the named sites over the same stay. The point value is what the point card shows. A 2 km cell can average a narrow ridge away; the 1 km cell is closer to the point value at ${closer} of ${k.sites.length} sites.`),
    h('div', { class: 'table-scroll' }, h('table', { class: 'doc-table terrain-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Site'), h('th', { scope: 'col', class: 'n' }, '2 km cell'), h('th', { scope: 'col', class: 'n' }, '1 km cell'), h('th', { scope: 'col', class: 'n' }, 'Point'))),
      h('tbody', null, k.sites.map((r) => h('tr', null,
        h('th', { scope: 'row' }, r.name), h('td', { class: 'n' }, `${pp1(r.grid2km)}%`), h('td', { class: 'n' }, `${pp1(r.grid1km)}%`), h('td', { class: 'n' }, `${pp1(r.point480m)}%`)))))));
}

// Phase 4: our figures beside NASA's official 18.6-year products (comparisons only, no pass marks).
function phase4Check(p4) {
  if (!p4?.sunVsOfficial) return null;
  const sun = p4.sunVsOfficial, earth = p4.earthVsOfficial;
  const old = (p4.oldShadowVsPsr ?? []).find((c) => c.grid === '2km');
  const tiles = p4.georef?.tiles ?? [];
  return h('div', { class: 'terrain-check' },
    h('h3', null, 'Compared with NASA’s 18.6-year products'),
    h('p', null, 'The official products count any part of the disc over 18.6 years at 1 h steps. Ours count the disc centre from Nov 2026 to Jan 2029. These are comparisons only, with no pass marks.'),
    h('div', { class: 'table-scroll' }, h('table', { class: 'doc-table terrain-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, '2 km grid'), h('th', { scope: 'col', class: 'n' }, 'Correlation'), h('th', { scope: 'col', class: 'n' }, 'Mean difference'), h('th', { scope: 'col', class: 'n' }, 'Largest difference'))),
      h('tbody', null, [['Sunlit share', sun], ['Earth in view', earth]].filter(([, c]) => c).map(([label, c]) => h('tr', null,
        h('th', { scope: 'row' }, label), h('td', { class: 'n' }, c.correlation.toFixed(3)),
        h('td', { class: 'n' }, `${pp1(c.meanAbsDiff)} points`), h('td', { class: 'n' }, `${pp1(Math.abs(c.worst?.[0]?.diff ?? 0))} points`)))))),
    h('ul', { class: 'limits' },
      old ? h('li', null, `Phase 3 rule. Cells our own skylines called sunless agree with the official map on ${pp1(old.agreement)}% of the 2 km grid. They miss ${pp1(old.missedShareOfPsr)}% of the official regions, and ${pp1(old.falseShareOfOld)}% of them are not official regions. The official map is now used.`) : null,
      ...tiles.filter((t) => t.zeroShift).map((t) => h('li', null, `Registration. The ${t.level.replace('dem_', '')} tiles (${t.tiles}) differ from the 120 m grid by ${t.zeroShift.meanAbsDiffM.toFixed(2)} m on average, correlation ${t.zeroShift.r.toFixed(4)}.`))));
}

function qa(question, ...answer) {
  return h('section', { class: 'qa' }, h('h2', null, question), ...answer);
}

export function renderEvidence(el, { validation, meta, sites }) {
  clear(el);
  const n = validation.comparisons.toLocaleString('en-GB');
  const x = validation.maxElDiffDeg.toFixed(3);
  const y = validation.maxAzDiffDeg.toFixed(3);
  const generated = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(meta.generatedAt));
  const approx = sites.filter((s) => !s.verified).length;

  el.append(
    h('h1', { tabindex: '-1' }, 'Evidence and limits'),
    qa('Who uses this, and when?',
      h('p', null, 'A mission planner whose landing date or site has just moved, and who needs to know within minutes whether power and a direct link to Earth survive the change. It also works for a teacher showing why the lunar south pole is hard.')),
    qa('What goes in, what happens, what comes out?',
      h('p', null, "A site, a landing time and a stay length go in. The page interpolates JPL’s Moon-fixed directions to the Sun and the Earth, converts them to azimuth and elevation at the site, compares them with the terrain skyline in that direction, and finds every rise and set. Out come the hours of sunlight, the hours with Earth in view, the overlap, and the same figures for the alternative.")),
    qa('Which step depends on NASA data?',
      h('p', null, `Every curve. The sub-solar and sub-Earth points come from JPL Horizons (ephemeris ${meta.ephemeris}) at 3-hour steps from 1 Nov 2026 to 1 Jan 2029. Without that file the page can draw nothing. The skyline at each point comes from NASA’s LOLA topography (LDEM_75S_240M). Zoomed-in shading also uses LDEM_75S_120M at 120 m per pixel, LDEM_80S_40M at 40 m around the named sites, and LDEM_875S_20M at 20 m around the two sites nearest the pole. Slope comes from the 240 m grid. Persistent shadow comes from NASA’s official map of permanently shadowed regions (LPSR_75S_120M, Mazarico et al. 2011, 2016 update).`)), // taste-skill-ignore: persistent shadow is the terrain product (sunless cells), not a CSS shadow
    qa('Where does each picture come from?',
      h('p', null, 'The page shows three kinds of thing: NASA products drawn exactly as published, NASA data this tool calculates with, and our own calculations from that data. The colours on the heat map are our calculation; the permanently shadowed regions and the 18.6-year averages are NASA’s. The checks below compare our calculations with NASA’s own products. Full citations, versions and links are in the README.'),
      sourcesTable()),
    qa('What check supports the main claim?',
      h('p', null, `The same angles were requested from Horizons a second way, with the observer placed on the lunar surface at four sites. Across ${n} comparisons the largest elevation difference is ${x}° and the largest azimuth difference is ${y}°.`),
      h('div', { class: 'table-scroll' }, h('table', { class: 'doc-table per-site' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Site'), h('th', { scope: 'col', class: 'n' }, 'Largest elevation difference'), h('th', { scope: 'col', class: 'n' }, 'Largest azimuth difference'))),
        h('tbody', null, validation.perSite.map((p) => h('tr', null, h('th', { scope: 'row' }, p.name), h('td', { class: 'n' }, deg3(p.maxElDiffDeg)), h('td', { class: 'n' }, deg3(p.maxAzDiffDeg))))))),
      h('div', { class: 'table-scroll' }, h('table', { class: 'doc-table samples' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, 'Time (UTC)'), h('th', { scope: 'col' }, 'Site'), h('th', { scope: 'col' }, 'Body'),
          h('th', { scope: 'col', class: 'n' }, 'Horizons'), h('th', { scope: 'col', class: 'n' }, 'Demo'), h('th', { scope: 'col', class: 'n' }, 'Difference'))),
        h('tbody', null, validation.samples.map((r) => h('tr', null,
          h('td', { class: 's-time' }, r.utc.replace('T', ' ').replace('Z', '')), h('th', { scope: 'row', 'data-body': r.body === 'sun' ? 'Sun' : 'Earth' }, r.siteName), h('td', { class: 's-body' }, r.body === 'sun' ? 'Sun' : 'Earth'),
          h('td', { class: 'n', 'data-label': 'Horizons' }, deg3(r.horizonsElDeg)), h('td', { class: 'n', 'data-label': 'Demo' }, deg3(r.demoElDeg)), h('td', { class: 'n', 'data-label': 'Difference' }, signed3(r.diffDeg))))))),
      terrainCheck(validation.terrain),
      phase3Check(validation.phase3),
      phase4Check(validation.phase4)),
    qa('What is not verified?',
      h('ul', { class: 'limits' },
        h('li', null, 'Terrain. The skyline uses LOLA topography at 480 m per pixel for a selected point, and the 240 m grid sampled every 2 km for the map. Ridge tops and small craters are smoothed, so the best-lit points are under-estimated. North of 80°S the horizon is still a smooth sphere. At the map edge the lines of sight stop at 75°S, so terrain beyond it is not counted, and the observer always stands 2 m above the ground.'),
        h('li', null, 'Heat cells. Heat cells are 2 km on the full map and 1 km when zoomed in. The Live view uses the 2 km grid while it plays and the 1 km grid when paused and zoomed in; the live light over the other modes stays on the 2 km grid. Zoomed-in shading uses the 240 m and 120 m grids, but that sharpens the picture, not the heat values. The map and the point card can still disagree on a narrow ridge.'),
        h('li', null, 'Slope. Slope is the mean over a 240 m grid within each cell. Real lander-scale slopes are steeper, so the slope filter is a coarse screen, not a landing hazard check.'),
        h('li', null, 'Persistent shadow. A cell counts as persistent shadow when more than half of it lies in an official permanently shadowed region: ground that never sees any part of the Sun in an 18.6-year simulation at 1 h steps (Mazarico et al. 2011, 2016 update, 120 m). Elsewhere the score uses the distance to the nearest such region of at least 1 km². Our own hours of sunlight still use our skylines and the mission window, so a cell can be sunless in our heat map without being a permanently shadowed region.'), // taste-skill-ignore: persistent shadow is the terrain product (sunless cells), not a CSS shadow
        h('li', null, 'Route plan. Candidate routes keep under a slope limit measured on the 240 m grid, a baseline far coarser than a rover, so they are a sketch and cannot tell whether a vehicle can pass. Rover speed, travel time and energy use are not modelled. The search stays in a corridor around the points, and slope does not depend on the direction of travel.'),
        h('li', null, 'Areas and lengths. Region areas and route lengths are measured on the polar stereographic plane. At 80°S this overstates distances by about 0.8% and areas by about 1.5%; near the pole the error falls to zero.'),
        h('li', null, 'Suitability. The score is a weighted mean of four parts: sunlight, Earth in view, slope and closeness to persistent shadow. You set the weights. It ranks ground for discussion and is not a finding that a mission is feasible.'),
        h('li', null, 'Ask panel. The Ask panel is a scripted demo and no model is connected. It recognises a few kinds of question and runs the same commands as the page controls, so the numbers in its replies come from those commands.'),
        h('li', null, 'Disc size. Visibility uses the centre of each disc. Partial sunrises and a half-visible Earth are not modelled.'),
        h('li', null, 'Power. The Energy card uses a relative power model: panel output is a share of its rating by the cosine law, and zero while the Sun is behind terrain. There are no watts. Panel size, load and battery are assumptions, not data. Partial shading of the Sun’s disc, temperature, dust and ageing are not modelled, and energy is not coupled to a route: the lander stays at the site.'),
        h('li', null, "Communications. A line of sight to Earth’s centre is not a link. Ground stations, antennas and link budgets are not modelled. The Relay link card propagates an assumed example orbit as a two-body Kepler orbit, with no pull from the Earth or the Sun and no lunar gravity field, so it drifts from a real orbit within weeks. The Earth is a point and the Moon a smooth sphere for the relay-to-Earth line."),
        h('li', null, `Site coordinates. Entries marked “approx.” have not been checked against a primary source.${approx === 0 ? ' All eight listed sites were checked.' : ''}`))),
    h('footer', { class: 'doc-foot' },
      h('p', null, `Data: JPL Horizons API ${meta.apiVersion}, target ${meta.target}, observer ${meta.observer}, quantities ${meta.quantities}, ${meta.stepHours}-hour steps, generated ${generated}. Validation: Horizons observer on the lunar surface (quantity 4), 6-hour steps through March 2027.`),
      h('p', null, 'Built with AI assistance (Claude). No NASA branding is used.')));
}
