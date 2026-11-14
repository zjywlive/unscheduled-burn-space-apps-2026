// Hover card for a snapped map target (phase 3 §4.5): name, coordinates, height, the current mode's
// value, slope, longest dark, and whether the cell passes the filters. It never takes the pointer,
// sits beside the target (never on it) and stays inside the map frame.
//
// createHoverCard(el, { id }) → { update(params | null) }
//   el  an element positioned inside the map frame (the card is absolutely positioned in it)
//   id  optional element id, so a focused site mark can point aria-describedby at the card
// params: null hides the card, or {
//   px, py, sizePx,                    target position and map frame side, CSS px
//   name, latDeg, lonDeg,
//   heightM: number | null,
//   valueLabel: string, value: string | null,   e.g. 'Both in view', '54% of the stay' (formatted by the caller)
//   slopeDeg: number | null, darkH: number | null,
//   pass: boolean | null,              null when no filter is set or the value is not known yet
//   psr?: 'Yes' | 'No' | null,         phase 4: in an official permanently shadowed region (null while loading)
//   filterText?: string,               shown instead of "—" when pass is null, e.g. 'No filter set'
// }
// Missing numbers show as "—".
import { h, clear } from './dom.js';
import { formatCoords } from '../sites.js';
import { fmtDeg, DASH } from '../format.js';

const MINUS = '−';
const GAP = 14;                    // px between the target and the card
const intFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);

// Height above the LOLA datum with an explicit sign, as the Selected point card shows it.
export function fmtHeight(m) {
  if (!ok(m)) return DASH;
  const v = Math.round(m);
  return `${v < 0 ? MINUS : '+'}${intFmt.format(Math.abs(v))} m`;
}

export function createHoverCard(el, { id } = {}) {
  const card = h('div', { class: 'hover-card', role: 'tooltip', id: id ?? null, hidden: true });
  el.append(card);

  // the frame is sizePx square, or width × height (phase 4: the big-map frame is the whole window)
  function place(px, py, fw, fh) {
    const w = card.offsetWidth, ht = card.offsetHeight;
    // right and below by default; flip to the other side when it would leave the frame
    let x = px + GAP, y = py + GAP;
    if (x + w > fw) x = px - GAP - w;
    if (y + ht > fh) y = py - GAP - ht;
    x = Math.max(0, Math.min(fw - w, x));
    y = Math.max(0, Math.min(fh - ht, y));
    card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function update(p) {
    if (!p) { card.hidden = true; return; }
    clear(card);
    const row = (label, value) => h('div', { class: 'hover-row' }, h('dt', null, label), h('dd', { class: 'num' }, value));
    const pass = p.pass === true ? 'Passes' : p.pass === false ? 'Filtered out' : (p.filterText ?? DASH);
    card.append(
      h('p', { class: 'hover-name' }, p.name ?? DASH),
      h('p', { class: 'hover-coords num' }, ok(p.latDeg) && ok(p.lonDeg) ? formatCoords(p) : DASH),
      h('dl', { class: 'hover-rows' },
        row('Height', fmtHeight(p.heightM)),
        p.valueLabel ? row(p.valueLabel, p.value ?? DASH) : null,
        row('Slope', fmtDeg(ok(p.slopeDeg) ? p.slopeDeg : null)),
        row('Longest dark', ok(p.darkH) ? `${intFmt.format(p.darkH)} h` : DASH),
        row('Filters', pass),
        p.psr !== undefined ? row('Permanent shadow', p.psr ?? DASH) : null));
    card.classList.toggle('is-filtered', p.pass === false);
    card.hidden = false;
    place(p.px, p.py, p.width ?? p.sizePx, p.height ?? p.sizePx);
  }

  return { update };
}
