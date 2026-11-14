// The Brief view (spec §9.6): the challenge in our words, objective coverage, and what is left for the weekend.
import { h, clear } from './dom.js';

const OBJECTIVES = [
  ['Interactive site selection and comparison', 'Done', 'Mission and candidate sites, custom coordinates, planned vs alternative, two drawn regions side by side'],
  ['Date and time flexibility', 'Done', 'Landing time, stay length, slip in days'],
  ['Sun and Earth position visualization', 'Done', 'Sky dial on the selected point (direction, elevation, terrain skyline, path), sky panorama, time to the next set'],
  ['Power and communication assessment', 'Partial', 'Hours and elevation against real terrain, longest dark spell as a filter; no power or link model'],
  ['Multiple visualization approaches', 'Done', 'South pole map with five heat modes and a weighted suitability map, 1 km cells when zoomed in, region statistics, route profile, sky panorama with the terrain skyline, elevation chart, landing-date strip in the time bar'],
  ['Temporal dynamics', 'Done', 'One clock plays everywhere: the live light on the map, the sky dial and every chart; it loops the mission window or runs on without one'],
  ['Accessibility across skill levels', 'Partial', 'Plain-language finding, a step-by-step tour and a scripted Ask panel with no model connected; not tested with a screen reader'],
];

export function renderBrief(el, { challengeUrl }) {
  clear(el);
  el.append(
    h('h1', { tabindex: '-1' }, 'The challenge, and what this demo covers'),
    h('section', { class: 'qa' }, h('h2', null, 'The challenge'),
      h('p', null, 'At the lunar south pole the Sun and the Earth both sit low on the horizon, so a small change of site or date can cost a lander its power or its direct link home. The tools that answer this today, such as Quickmap, Moon Trek and JPL Horizons, are built for specialists and are slow to use for quick what-ifs. The challenge asks for an intuitive tool that compares landing sites and dates by showing where the Sun and Earth sit relative to the local horizon.'),
      h('p', null, h('a', { href: challengeUrl, target: '_blank', rel: 'noopener' }, 'Read the official challenge'))),
    h('section', { class: 'qa' }, h('h2', null, 'Coverage of the official objectives'),
      h('div', { class: 'table-scroll' }, h('table', { class: 'doc-table objectives' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Objective'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, 'In this demo'))),
        h('tbody', null, OBJECTIVES.map(([o, st, d]) => h('tr', null,
          h('th', { scope: 'row' }, o), h('td', { class: st === 'Done' ? 'status-done' : 'status-partial' }, st), h('td', null, d))))))),
    h('section', { class: 'qa' }, h('h2', null, 'What a weekend build would add'),
      h('ul', { class: 'limits' },
        h('li', null, 'Heat and skylines finer than 1 km around the chosen sites.'),
        h('li', null, 'Lander-scale slope from the 120 m topography or finer.'),
        h('li', null, 'Disc-limb visibility for partial sunrises.'),
        h('li', null, 'A power and link budget.'),
        h('li', null, 'An exportable planning table, and links that carry regions and filters.'),
        h('li', null, 'A real model behind the Ask panel, with each person’s own key or a proxy.'),
        h('li', null, 'A review of the official resources, due on 13 Nov.'))),
    h('section', { class: 'qa' }, h('h2', null, 'Questions for the team'),
      h('ul', { class: 'limits' },
        h('li', null, 'How fine does the terrain need to be before we trust a site?'),
        h('li', null, 'Is a smooth-sphere horizon enough for a first version?'),
        h('li', null, 'Which suitability weights should be the default, and who sets them?'),
        h('li', null, 'Which award category fits: mission concept, technology, or data?'))));
}
