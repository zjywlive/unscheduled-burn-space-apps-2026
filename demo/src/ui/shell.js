// The app shell: sidebar, top bar, title rows, view switch and every control (spec §4, §9.1; phase 2 §3–§5).
// Controls are created once; sync() only updates their values and states, so keyboard focus survives.
// Phase 5 (G): the Navigator page is gone; its pieces (Sky at the site, Elevation over the stay, Rises and
// sets, Planned vs alternative) are built here and mounted by main.js into the site detail sheet. The
// landing date, stay and slip live in the time dock (ui/timedock.js); the top bar holds the modes (put there
// by ui/mapview.js in the big layout), Tour, Ask and Settings.
import { stageBar } from '../mission-flow.js';
import { h, s } from './dom.js';
import { fmtPct, DASH } from '../format.js';
import { parseCustomSite } from '../sites.js';
import { parseLatLon } from '../coords.js';
import { viewHref } from '../state.js';

const MINUS = '−';
export const SLIPS = [-14, -7, -1, 0, 1, 7, 14];
// the Map itself is the stage bar's step 1; Evidence and Brief are sheets over it (a second click returns to the map)
const VIEWS = [['evidence', 'Evidence'], ['brief', 'Brief']];
const GROUPS = [['missions', 'Landing sites'], ['candidates', 'Artemis III candidates']];

function wordmark() {
  return s('svg', { class: 'mark', width: 20, height: 20, viewBox: '0 0 20 20', 'aria-hidden': 'true' },
    s('circle', { cx: 10, cy: 12, r: 6.25, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }),
    s('path', { d: 'M1.5 13.5h17', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }),
    s('circle', { cx: 10, cy: 3, r: 1.75, fill: 'currentColor' }));
}

// fix L10b: the side panel icon (a window with its left or right column marked), 16 px, currentColor
export function panelIcon(side) {
  return s('svg', { class: 'panel-icon', width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'aria-hidden': 'true' },
    s('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2.5 }),
    s('path', { d: side === 'left' ? 'M6 2.5v11' : 'M10 2.5v11' }));
}

function brand(extraClass) {
  return h('div', { class: `brand ${extraClass}` }, wordmark(),
    h('div', { class: 'brand-text' }, h('span', { class: 'brand-name', translate: 'no' }, 'Lunar Site Navigator'), h('span', { class: 'brand-sub' }, 'Briefing demo')));
}

// fix L10b / phase 5: the gear for the Settings sheet (16 px, currentColor), as in the mock
function gearIcon() {
  return s('svg', { class: 'gear-icon', width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'aria-hidden': 'true' },
    s('circle', { cx: 8, cy: 8, r: 2.4 }),
    s('path', { d: 'M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4', 'stroke-linecap': 'round' }));
}

// a standard close cross, 16 px, currentColor
export function closeX() {
  return s('svg', { class: 'close-x', width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'aria-hidden': 'true' },
    s('path', { d: 'M4 4l8 8M12 4l-8 8' }));
}

function siteOptions(sites) {
  return GROUPS.map(([g, label]) => h('optgroup', { label }, sites.filter((x) => x.group === g).map((x) => h('option', { value: x.id }, x.name))));
}

export function createShell(root, { sites, state, onChange }) {
  const ids = (id) => `lsn-${id}`;

  // ---------- sidebar ----------
  const siteButtons = sites.map((site) => {
    const pct = h('span', { class: 'site-pct num' }, '');
    const btn = h('button', { type: 'button', class: 'site', 'data-id': site.id, onclick: () => onChange({ site }) },
      h('span', { class: 'site-name' }, site.name), h('span', { class: 'sr-only' }, ', sunlit '), pct);
    return { site, btn, pct };
  });

  const latInput = h('input', { id: ids('lat'), name: 'latitude', type: 'text', inputmode: 'text', autocomplete: 'off', spellcheck: 'false', class: 'input', placeholder: '−85.2' });
  const lonInput = h('input', { id: ids('lon'), name: 'longitude', type: 'text', inputmode: 'text', autocomplete: 'off', spellcheck: 'false', class: 'input', placeholder: '31.5' });
  const latError = h('p', { id: ids('lat-error'), class: 'field-error', hidden: true });
  const lonError = h('p', { id: ids('lon-error'), class: 'field-error', hidden: true });
  const setFieldError = (input, errorEl, message) => {
    errorEl.textContent = message ?? '';
    errorEl.hidden = !message;
    if (message) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', errorEl.id); }
    else { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
  };
  const customForm = h('form', {
    class: 'custom', novalidate: true, 'aria-labelledby': ids('custom-head'),
    onsubmit: (e) => {
      e.preventDefault();
      // fix L13: the shared coordinate parser, so "89.45S" and "137.4W" work here as in the Coordinates fold
      const c = parseLatLon(latInput.value, lonInput.value, { maxLatDeg: 90 });
      const r = c.ok ? parseCustomSite(String(c.latDeg), String(c.lonDeg)) : c;
      setFieldError(latInput, latError, r.ok || r.field !== 'lat' ? null : r.message);
      setFieldError(lonInput, lonError, r.ok || r.field !== 'lon' ? null : r.message);
      if (!r.ok) { (r.field === 'lat' ? latInput : lonInput).focus(); return; }
      onChange({ site: r.site });
    },
  },
  h('p', { class: 'group-head', id: ids('custom-head') }, 'Custom site'),
  h('div', { class: 'field' }, h('label', { for: latInput.id }, 'Latitude'), latInput, latError),
  h('div', { class: 'field' }, h('label', { for: lonInput.id }, 'Longitude (east)'), lonInput, lonError),
  h('button', { type: 'submit', class: 'btn btn-block' }, 'Use coordinates'));

  // Phase 4 big-map layout: the site list floats over the map and folds away to a button.
  // fix L10b: an icon with a label on hover and focus; folded, the handle sits at the top of the map tools
  // phase 5 (owner, 2026-11-13): the list is closed by default; the tool rail's first control is a labelled
  // "Sites" button, and the open list has a standard close button in its header
  const sideToggle = h('button', { type: 'button', class: 'panel-toggle side-toggle side-close', 'aria-label': 'Close the site list', title: 'Close the site list (Esc)', 'aria-expanded': 'true', 'aria-controls': 'lsn-sidebar' }, closeX());
  const sideReopen = h('button', { type: 'button', class: 'panel-reopen side-reopen map-btn sites-btn', title: 'Show the site list', 'aria-expanded': 'false', 'aria-controls': 'lsn-sidebar' }, 'Sites');
  const sidebar = h('aside', { class: 'sidebar', id: 'lsn-sidebar' },
    brand('brand-side'),
    sideToggle,
    GROUPS.map(([g, label], n) => h('nav', { class: `site-list site-list-${g}`, 'aria-labelledby': ids(`sites-head-${g}`) },
      h('div', { class: 'group-head', id: ids(`sites-head-${g}`) }, h('span', null, label), n === 0 ? h('span', { 'aria-hidden': 'true' }, 'Sunlit') : null),
      h('ul', { class: 'sites' }, siteButtons.filter((b) => b.site.group === g).map((b) => h('li', null, b.btn))))),
    customForm);

  // ---------- top bar ----------
  const siteSelect = h('select', {
    id: ids('site-select'), name: 'site', class: 'input select',
    onchange: () => {
      if (siteSelect.value === 'custom') { app.dataset.custom = 'open'; latInput.focus(); return; }
      delete app.dataset.custom;
      const site = sites.find((x) => x.id === siteSelect.value);
      if (site) onChange({ site });
    },
  }, siteOptions(sites), h('option', { value: 'custom' }, 'Custom site…'));

  const viewButtons = VIEWS.map(([id, label]) => h('a', { class: 'view-tab', 'data-view': id, href: `#view=${id}` }, label));
  // "Where to land" (the planner, the Map's region level): in the top bar, reachable whatever panel is open
  const landButton = h('button', { type: 'button', class: 'view-tab view-land', 'data-action': 'where-to-land', title: 'Where to land: landing ellipse scores and better spots around a point (Map, region level)' }, 'Where to land');

  // Phase 3: the guided tour and the Ask drawer open from the top bar (§4.9, §4.10).
  const tourButton = h('button', { type: 'button', class: 'top-action', 'data-action': 'tour' }, 'Tour');
  const askButton = h('button', { type: 'button', class: 'top-action', 'data-tour': 'ask', 'data-action': 'ask', 'aria-expanded': 'false', 'aria-haspopup': 'dialog' }, 'Ask');
  const settingsButton = h('button', { type: 'button', class: 'top-action top-icon', 'data-action': 'settings', 'aria-label': 'Settings', title: 'Settings', 'aria-expanded': 'false', 'aria-haspopup': 'dialog' }, gearIcon());
  // phase 5: the modes and Layers sit in the middle of the top bar in the big layout (ui/mapview.js moves them)
  const topModes = h('div', { class: 'topbar-modes' });

  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-brand' }, brand('brand-top'),
      h('div', { class: 'site-picker' }, h('label', { class: 'sr-only', for: siteSelect.id }, 'Landing site'), siteSelect)),
    // the mission's steps across the pages (mission-flow.js): this page is step 1, the Map
    h('div', { class: 'topbar-stages' }, typeof document !== 'undefined' ? stageBar(document, 'map', { compact: true }) : null),
    h('div', { class: 'topbar-nav' },
      h('nav', { class: 'views', 'aria-label': 'Views' }, landButton, viewButtons),
      topModes,
      h('div', { class: 'top-actions' }, tourButton, askButton, settingsButton)));

  // ---------- map view (its cards are filled by ui/mapview.js) ----------
  const mapTitle = h('div', { class: 'title-block' });
  const mapFinding = h('p', { class: 'finding', 'aria-live': 'polite' });
  const mapCard = h('section', { class: 'card card-map', 'aria-labelledby': ids('map-head') });
  const pointCard = h('section', { class: 'card card-point', 'aria-labelledby': ids('point-head') });
  const filtersCard = h('section', { class: 'card card-filters', 'aria-labelledby': ids('filters-head') });
  const regionCard = h('section', { class: 'card card-region', 'aria-labelledby': ids('region-head'), hidden: true });
  const routeCard = h('section', { class: 'card card-route', 'aria-labelledby': ids('route-head'), hidden: true });
  const mapSection = h('section', { class: 'view view-map', 'data-view': 'map' },
    h('div', { class: 'title-row' }, h('div', { class: 'title-main' }, mapTitle)),
    mapFinding,
    h('div', { class: 'map-grid' }, h('div', { class: 'map-col' }, mapCard, regionCard), h('div', { class: 'map-col' }, pointCard, filtersCard)),
    routeCard);

  // ---------- the detail sheet's pieces (the old Navigator page; main.js mounts them) ----------
  const finding = h('p', { class: 'finding', 'aria-live': 'polite' });
  const panorama = h('div', { class: 'chart chart-pano' });
  const elevation = h('div', { class: 'chart chart-elev' });
  const mapPointOption = h('option', { value: '', hidden: true }, 'Map point');
  const altSelect = h('select', { id: ids('alt'), name: 'alternative-site', class: 'input select', onchange: () => { if (altSelect.value) onChange({ altSite: altSelect.value }); } },
    h('option', { value: 'same' }, 'Same site'), siteOptions(sites), mapPointOption);
  const compare = h('div', { class: 'compare' });
  const events = h('div', { class: 'events' });
  const sheetParts = {
    panorama: h('div', { class: 'sheet-pano' }, panorama,
      h('p', { class: 'caption' }, 'Markers are not to scale. The Sun is 0.5° wide and the Earth 1.9° wide from the Moon.')),
    elevation: h('div', { class: 'sheet-elev' }, h('p', { class: 'card-sub' }, 'Measured from the terrain skyline in each body’s direction.'), elevation),
    events,
    altField: h('div', { class: 'field field-inline field-alt' }, h('label', { for: altSelect.id }, 'Alternative site'), altSelect),
    compare,
  };

  const evidence = h('section', { class: 'view view-doc', 'data-view': 'evidence', hidden: true });
  const brief = h('section', { class: 'view view-doc', 'data-view': 'brief', hidden: true });
  // phase 5 (item 13): the map is the canvas of every view; Evidence and Brief are reading sheets over it
  // (main.js mounts these two sections into them)
  const main = h('main', { id: 'main', tabindex: '-1' }, mapSection);
  const views = { map: mapSection };

  const app = h('div', { class: 'app' }, sidebar, sideReopen, topbar, main);
  root.append(app);

  let lastSiteId = state.site.id;

  function sync(st, figures) {
    for (const b of siteButtons) {
      const current = st.site.id === b.site.id;
      b.btn.toggleAttribute('aria-current', false);
      if (current) b.btn.setAttribute('aria-current', 'true');
      const f = figures[b.site.id];
      b.pct.textContent = Number.isFinite(f) ? fmtPct(f) : DASH;
    }
    customForm.classList.toggle('is-current', st.site.id === 'custom');
    if (st.site.id === 'custom' && document.activeElement !== latInput && document.activeElement !== lonInput) {
      latInput.value = String(st.site.latDeg).replace('-', MINUS);
      lonInput.value = String(st.site.lonDeg);
    }
    if (app.dataset.custom !== 'open' || st.site.id !== 'custom') siteSelect.value = st.site.id === 'custom' ? 'custom' : st.site.id;
    if (st.site.id !== 'custom' && siteSelect.value !== 'custom') delete app.dataset.custom;

    for (const b of viewButtons) {
      // phase 5: a view tab never carries the detail sheet (sheet=), so Evidence or Brief replaces an open
      // sheet instead of the sheet reopening over them, and Map returns to the bare map
      const on = b.dataset.view === st.view;
      b.setAttribute('href', viewHref(st, on ? 'map' : b.dataset.view));   // open: a second click closes it
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    for (const el of Object.values(views)) el.hidden = false;
    evidence.hidden = st.view !== 'evidence';
    brief.hidden = st.view !== 'brief';

    if (st.site.id !== lastSiteId) {
      lastSiteId = st.site.id;
      setFieldError(latInput, latError, null);
      setFieldError(lonInput, lonError, null);
    }
    const custom = st.altSite.startsWith('c:');
    mapPointOption.hidden = !custom;
    mapPointOption.value = custom ? st.altSite : '';
    altSelect.value = st.altSite;
  }

  return {
    regions: { finding, panorama, elevation, compare, events, evidence, brief, mapTitle, mapFinding, mapCard, pointCard, filtersCard, regionCard, routeCard },
    sheetParts, mapSection,
    tourButton, askButton, settingsButton, topModes, landButton,
    app, sidebar, sideToggle, sideReopen, topbar, mapTitleRow: mapSection.querySelector('.title-row'),
    sync,
  };
}
