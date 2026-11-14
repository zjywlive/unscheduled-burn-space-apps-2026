// The Brief view (spec §9.6): the challenge in our words, objective coverage, and what is still left.
import { h, clear } from './dom.js';

const OBJECTIVES = [
  ['Interactive site selection and comparison', 'Done', 'Flown missions (Apollo 11 and 17, IM-1, IM-2, Blue Ghost M1, Chandrayaan-3, Chang\u2019e-4), Artemis III candidate regions and custom coordinates; planned vs alternative site or date, two drawn regions side by side; the lander page grades every listed site in one table'],
  ['Date and time flexibility', 'Done', 'Landing time, stay length and slip in days; Change mode over the whole map; the best landing date in the next four weeks; a search for rover departure times; the next lit landing window on the lander page'],
  ['Sun and Earth position visualization', 'Done', 'Sky dial on the selected point (direction, elevation, terrain skyline, path), sky panorama, Sun & Earth readout with libration, time to the next sunset and Earthset, every rise and set in the stay'],
  ['Power and communication assessment', 'Done', 'Sun elevation over the real skyline, sunlit and Earth hours, longest dark spell; battery over the stay (Power tab); Earth direct and an example relay (Comms tab); along a rover route, a battery simulation in watts and a surface-station link in dBm (free-space loss plus knife-edge diffraction); landing checks on the lander page'],
  ['Multiple visualization approaches', 'Done', 'South pole map with five heat modes and a weighted suitability map, 1 km cells when zoomed in, Data, Topo and Real light terrain with contours, region statistics, route profile, sky panorama with the terrain skyline, elevation chart, landing-date strip in the time bar, a 3D globe of the whole Moon with the rover drive, 3D lander scenes down to 5 m terrain'],
  ['Temporal dynamics', 'Done', 'One clock plays everywhere: the live light on the map, the sky dial and every chart; it loops the mission window or runs on without one. The globe plays the rover drive and the lander page the whole mission'],
  ['Accessibility across skill levels', 'Done', 'Plain-language verdicts, three short stories and a step-by-step tour, a user guide and glossary, colour-blind and high-contrast presets, reduced motion, keyboard control, phone layouts, and an Ask panel that by default is a scripted demo with no model connected (or uses your own key); not yet tested with a screen reader'],
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
    h('section', { class: 'qa' }, h('h2', null, 'What is still left'),
      h('ul', { class: 'limits' },
        h('li', null, 'Terrain skylines north of 80\u00b0S on this map: sites there use a smooth-sphere horizon (the lander page already computes one anywhere on the Moon).'),
        h('li', null, 'The size of the Sun\u2019s and Earth\u2019s discs (partial sunrise) and Earthshine.'),
        h('li', null, 'Rocks and boulders smaller than the 5 m terrain, and a thermal model for the rover and lander.'),
        h('li', null, 'A table comparing more than two scenarios on this page (the Ask panel and the MCP tools already do it).'),
        h('li', null, 'Dates before November 2026, to replay the real Apollo, IM-1 and IM-2 landing days.'),
        h('li', null, 'A screen-reader test.'))),
    h('section', { class: 'qa' }, h('h2', null, 'Questions for the team'),
      h('ul', { class: 'limits' },
        h('li', null, 'How fine does the terrain need to be before we trust a slope?'),
        h('li', null, 'Should this map compute terrain skylines north of 80\u00b0S, or send those sites to the lander page?'),
        h('li', null, 'Which suitability weights should be the default, and who sets them?'),
        h('li', null, 'Which award category fits: mission concept, technology, or data?'))));
}
