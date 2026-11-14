// SVG annotation layer of the south-pole map (spec phase 2 §4.2): graticule, crater names, site
// markers, the selected and alternative crosshairs, the top-5 rings and the keyboard crosshair.
// Phase 3 §5.3: an optional `view` ({ cx, cy, zoom }, see map/view.js) zooms and pans the layer; label
// collisions are worked out on the zoomed pixel positions, so labels left out at zoom 1 can appear.
// Without `view` (or with zoom 1 at the centre) the output is the same as in phase 2.
import { s, clear } from '../ui/dom.js';
import { toXY } from '../terrain.js';

const R = 1737.4;
const CIRCLES = [-80, -85, -88];

const radiusKm = (lat) => 2 * R * Math.tan(((90 + lat) / 2) * Math.PI / 180);

function crosshair(px, py, cls) {
  return s('g', { class: `crosshair ${cls}`, transform: `translate(${px.toFixed(1)} ${py.toFixed(1)})`, 'aria-hidden': 'true' },
    s('circle', { r: 9 }),
    s('path', { d: 'M-14 0h8M6 0h8M0 -14v8M0 6v8' }));
}

// Fix L12: the scale bar's length, a round 1, 2 or 5 × 10^n km, so that the bar is about minPx to maxPx
// CSS px long at kmPerPx (map km per CSS px). Returns { km, px, label }.
export function scaleBarFor(kmPerPx, { minPx = 80, maxPx = 160 } = {}) {
  if (!(kmPerPx > 0) || !Number.isFinite(kmPerPx)) return null;
  const want = kmPerPx * maxPx;                 // the longest length that still fits
  let n = 10 ** Math.floor(Math.log10(want));
  let km = [5, 2, 1].map((m) => m * n).find((v) => v <= want) ?? n;
  // shorter than minPx (possible only between a 2 and a 5 step): take the next round length up when it
  // overshoots maxPx by less than this one falls short of minPx
  if (km / kmPerPx < minPx) {
    const up = [2, 5, 10].map((m) => m * n).find((v) => v > km);
    if (up / kmPerPx - maxPx < minPx - km / kmPerPx) km = up;
  }
  km = Number(km.toPrecision(1));
  const label = km >= 1 ? `${km} km` : `${Math.round(km * 1000)} m`;
  return { km, px: km / kmPerPx, label };
}

// avoid (fix L4/L11): rectangles { x, y, w, h } in this layer's px that labels must not overlap (the
// floating panels and bars of the big-map layout). Marks stay where they are; only labels move or go.
export function renderOverlay(svgEl, { sizePx, halfKm, features, sites, selected, alternative, top, cursorCell, grid, onSite, view, avoid = [] }) {
  clear(svgEl);
  // halfKm is the half-width of the whole map; the viewport is halfKm / zoom around (cx, cy)
  const zoom = view?.zoom ?? 1, vx = view?.cx ?? 0, vy = view?.cy ?? 0;
  const k = sizePx / (2 * halfKm / zoom);
  const px = (x) => sizePx / 2 + (x - vx) * k;
  const py = (y) => sizePx / 2 - (y - vy) * k;
  const at = (lat, lon) => { const [x, y] = toXY(lat, lon); return [px(x), py(y)]; };
  const inMap = ([x, y]) => x >= 0 && y >= 0 && x <= sizePx && y <= sizePx;
  const hits = (x, y, w, hgt) => avoid.some((r) => x < r.x + r.w && r.x < x + w && y < r.y + r.h && r.y < y + hgt);
  svgEl.setAttribute('viewBox', `0 0 ${sizePx} ${sizePx}`);
  svgEl.setAttribute('width', sizePx);
  svgEl.setAttribute('height', sizePx);

  const grat = s('g', { class: 'graticule', 'aria-hidden': 'true' });
  for (let lon = 0; lon < 360; lon += 30) {
    const [x1, y1] = at(-89.6, lon), [x2, y2] = at(-80, lon);
    grat.append(s('line', { x1, y1, x2, y2 }));
    const [lx, ly] = at(-80.6, lon);
    const label = lon === 0 ? '0°' : lon === 180 ? '180°' : lon < 180 ? `${lon}°E` : `${360 - lon}°W`;
    if (hits(lx - 18, ly - 8, 36, 16)) continue;   // under a floating panel or bar
    grat.append(s('text', { x: lx, y: ly + 4, 'text-anchor': 'middle', class: 'grat-label' }, label));
  }
  for (const lat of CIRCLES) {
    grat.append(s('circle', { cx: px(0), cy: py(0), r: radiusKm(lat) * k }));
    if (lat !== -80) {
      // latitude labels sit just inside each circle on the 15°E ray, clear of the meridians
      const [lx, ly] = at(lat + 0.25, 15);
      if (!hits(lx - 16, ly - 12, 32, 16)) grat.append(s('text', { x: lx, y: ly, 'text-anchor': 'middle', class: 'grat-label' }, `${-lat}°S`));
    }
  }
  svgEl.append(grat);

  // Labels are placed greedily (selected site, missions, candidates, then crater names); a label that
  // would overlap one already placed is left out, and its marker keeps its name as a tooltip.
  const boxes = [];
  const fits = (x, y, w, hgt) => {
    if (x < 2 || y < 2 || x + w > sizePx - 2 || y + hgt > sizePx - 2) return false;
    if (hits(x, y, w, hgt)) return false;
    if (boxes.some((b) => x < b.x + b.w && b.x < x + w && y < b.y + b.h && b.y < y + hgt)) return false;
    boxes.push({ x, y, w, h: hgt });
    return true;
  };
  const textW = (t) => t.length * 6.6 + 4;

  const marks = s('g', { class: 'site-marks' });
  const shown = sites
    .map((site) => ({ site, p: at(site.latDeg, site.lonDeg) }))
    .filter(({ site, p }) => inMap(p) && site.latDeg <= -80)
    .sort((a, b) => (b.site.id === selected?.id) - (a.site.id === selected?.id) || (a.site.group === 'missions' ? -1 : 1) - (b.site.group === 'missions' ? -1 : 1));
  for (const { site, p } of shown) boxes.push({ x: p[0] - 5, y: p[1] - 5, w: 10, h: 10 });
  for (const { site, p } of shown) {
    const w = textW(site.name);
    const spots = [[7, -7], [-7 - w, -7], [-w / 2, -21], [-w / 2, 7]];
    const spot = spots.find(([dx, dy]) => fits(p[0] + dx, p[1] + dy, w, 14));
    const g = s('g', {
      class: `site-mark site-${site.group}`, tabindex: '0', role: 'button', 'aria-label': `Pick ${site.name}`, 'data-focus-key': `site:${site.id}`,
      transform: `translate(${p[0].toFixed(1)} ${p[1].toFixed(1)})`,
      onclick: (e) => { e.stopPropagation(); onSite(site); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onSite(site); } },
    },
    s('title', null, site.name),
    s('circle', { class: 'mark-hit', r: 10 }),
    s('circle', { class: 'mark-dot', r: 4 }),
    spot ? s('text', { x: spot[0], y: spot[1] + 11, class: 'mark-label' }, site.name) : null);
    marks.append(g);
  }

  const names = s('g', { class: 'feature-names', 'aria-hidden': 'true' });
  for (const f of features) {
    const p = at(f.latDeg, f.lonDeg);
    if (!inMap(p) || !(f.latDeg <= -80)) continue;   // nothing is drawn outside the 80°S disc
    if (shown.some(({ site }) => site.name === f.name)) continue;   // a site already carries this name (e.g. Haworth)
    const w = textW(f.name);
    if (!fits(p[0] - w / 2, p[1] - 10, w, 14)) continue;
    names.append(s('text', { x: p[0], y: p[1], 'text-anchor': 'middle', class: 'feature-name' }, f.name));
  }
  svgEl.append(names, marks);

  const ranks = s('g', { class: 'top-cells', 'aria-hidden': 'true' });
  top.forEach((cell, n) => {
    const c = grid.cellCenter(cell);
    const x = px(c.xKm), y = py(c.yKm);
    if (!inMap([x, y])) return;   // zoomed out of view (never at zoom 1: cell centres are on the map)
    ranks.append(s('g', { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` },
      s('circle', { r: 8 }), s('text', { y: 4, 'text-anchor': 'middle' }, String(n + 1))));
  });
  svgEl.append(ranks);

  if (alternative) { const p = at(alternative.latDeg, alternative.lonDeg); if (inMap(p)) svgEl.append(crosshair(p[0], p[1], 'is-alt')); }
  if (selected) { const p = at(selected.latDeg, selected.lonDeg); if (inMap(p)) svgEl.append(crosshair(p[0], p[1], 'is-site')); }
  if (cursorCell !== null && cursorCell !== undefined) {
    const c = grid.cellCenter(cursorCell);
    const half = (grid.cellKm * k) / 2;
    svgEl.append(s('rect', { class: 'key-cursor', x: px(c.xKm) - half - 3, y: py(c.yKm) - half - 3, width: 2 * half + 6, height: 2 * half + 6, 'aria-hidden': 'true' }));
  }
}
