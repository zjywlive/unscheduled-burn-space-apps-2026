// Canvas layers of the south-pole map (spec phase 2 §4.2, phase 3 §5.3): a low-contrast hillshade from
// a DEM, and a heat layer drawn per grid cell in the data colours of the existing tokens. Without the
// phase 3 options (cx, cy, view, cellKm, halfKm, filtered, rect) both draw exactly as in phase 2.
import { kmPerPx as viewKmPerPx } from './view.js';

const LIGHT_AZ = (315 * Math.PI) / 180;   // from the upper left of the map
const LIGHT_EL = (30 * Math.PI) / 180;

// One brightness value per canvas pixel, row by row. Two forms:
// - square (phase 3): { size, halfKm, cx, cy }: `size` is the pixel width of the square, which spans
//   cx ± halfKm by cy ± halfKm (halfKm is the half-width of the viewport, not of the map).
// - rectangle (phase 4): { width, height, kmPerPx, cx, cy }: width × height pixels of kmPerPx km,
//   centred on (cx, cy) km. → Uint8ClampedArray(width × height).
// `dem` is a createDem level, or a composite from createPyramid().pick() (tiled levels): then each pixel
// takes all four of its slope samples from the finest level of the chain that has them, with that
// level's own sample step, so tile and level borders leave no seam, hole or brightness step.
// 0 where no level has heights.
export function hillshade(dem, opts) {
  const { cx = 0, cy = 0 } = opts;
  let width, height, kpp, halfW, halfH;
  if (opts.size !== undefined) {
    width = height = opts.size;
    kpp = (2 * opts.halfKm) / opts.size;
    halfW = halfH = opts.halfKm;          // the phase 3 arithmetic, so the square form stays byte-identical
  } else {
    ({ width, height } = opts);
    kpp = opts.kmPerPx;
    halfW = (width * kpp) / 2; halfH = (height * kpp) / 2;
  }
  if (dem.chain) return shadeChain(dem.chain, width, height, kpp, halfW, halfH, cx, cy);
  return shadePlain(dem, width, height, kpp, halfW, halfH, cx, cy);
}

const LX = Math.sin(LIGHT_AZ) * Math.cos(LIGHT_EL), LY = Math.cos(LIGHT_AZ) * Math.cos(LIGHT_EL), LZ = Math.sin(LIGHT_EL);

// The phase 3 loop, unchanged apart from width ≠ height.
function shadePlain(dem, width, height, kmPerPx, halfW, halfH, cx, cy) {
  const out = new Uint8ClampedArray(width * height);
  const lx = LX, ly = LY, lz = LZ;
  const d = Math.max(kmPerPx, dem.kmPerPixel);
  for (let row = 0; row < height; row++) {
    const y = cy + halfH - (row + 0.5) * kmPerPx;
    for (let col = 0; col < width; col++) {
      const x = cx - halfW + (col + 0.5) * kmPerPx;
      const hx0 = dem.heightAtXY(x - d, y), hx1 = dem.heightAtXY(x + d, y);
      const hy0 = dem.heightAtXY(x, y - d), hy1 = dem.heightAtXY(x, y + d);
      if (hx0 === null || hx1 === null || hy0 === null || hy1 === null) { out[row * width + col] = 0; continue; }
      // slopes in km per km, with heights in metres
      const gx = (hx1 - hx0) / 1000 / (2 * d), gy = (hy1 - hy0) / 1000 / (2 * d);
      const n = Math.hypot(gx, gy, 1);
      const lit = Math.max(0, (-gx * lx - gy * ly + lz) / n);
      out[row * width + col] = 8 + 36 * lit;         // dark and low in contrast, so the heat colours read on top
    }
  }
  return out;
}

// Levels fine to coarse; the first level with all four samples serves the pixel, at its own step.
// Each level gets its sample columns (x − d, x, x + d) and rows (y − d, y, y + d) once, via grid() when
// the level has it (createDem, createTiledDem), else through sample().
function shadeChain(chain, width, height, kmPerPx, halfW, halfH, cx, cy) {
  const out = new Uint8ClampedArray(width * height);
  const n = chain.length;
  const steps = chain.map((l) => Math.max(kmPerPx, l.kmPerPixel));
  const at = chain.map((l, li) => {
    const d = steps[li];
    const xs = new Float64Array(3 * width), ys = new Float64Array(3 * height);
    for (let col = 0; col < width; col++) { const x = cx - halfW + (col + 0.5) * kmPerPx; xs[3 * col] = x - d; xs[3 * col + 1] = x; xs[3 * col + 2] = x + d; }
    for (let row = 0; row < height; row++) { const y = cy + halfH - (row + 0.5) * kmPerPx; ys[3 * row] = y - d; ys[3 * row + 1] = y; ys[3 * row + 2] = y + d; }
    return l.grid ? l.grid(xs, ys) : (i, j) => l.sample(xs[i], ys[j]);
  });
  for (let row = 0; row < height; row++) {
    const o = row * width, jm = 3 * row, j0 = jm + 1, jp = jm + 2;
    for (let col = 0; col < width; col++) {
      const im = 3 * col, i0 = im + 1, ip = im + 2;
      for (let li = 0; li < n; li++) {
        const s = at[li], d = steps[li];
        const hx0 = s(im, j0); if (hx0 !== hx0) continue;
        const hx1 = s(ip, j0); if (hx1 !== hx1) continue;
        const hy0 = s(i0, jm); if (hy0 !== hy0) continue;
        const hy1 = s(i0, jp); if (hy1 !== hy1) continue;
        const gx = (hx1 - hx0) / 1000 / (2 * d), gy = (hy1 - hy0) / 1000 / (2 * d);
        const lit = Math.max(0, (-gx * LX - gy * LY + LZ) / Math.sqrt(gx * gx + gy * gy + 1));
        out[o + col] = 8 + 36 * lit;
        break;
      }
    }
  }
  return out;
}

// `height` defaults to `size` (the phase 3 square call).
export function paintBase(ctx, shade, size, height = size) {
  const img = ctx.createImageData(size, height);
  for (let i = 0; i < shade.length; i++) {
    const v = shade[i];
    img.data[4 * i] = v; img.data[4 * i + 1] = v; img.data[4 * i + 2] = v; img.data[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function rgb(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
}

// Colour and opacity (0–1) for one cell in each mode; null for no colour.
export function heatColour(mode, { value = 0, state = 0, delta = 0 }, colours) {
  if (mode === 'night') return state & 1 ? null : [[0, 0, 0], 0.5];   // live "No Sun now" veil
  if (mode === 'now') {
    if (state === 3) return [colours.both, 0.7];
    if (state === 1) return [colours.sun, 0.7];
    if (state === 2) return [colours.earth, 0.7];
    return null;
  }
  if (mode === 'change') {
    if (Math.abs(delta) < 0.02) return null;                 // under 2 % of the stay
    return [delta < 0 ? colours.negative : colours.both, Math.min(1, Math.abs(delta) / 0.5) * 0.8];
  }
  if (!(value > 0)) return null;
  // the legend's five steps; Suitability uses the Both colour and steps
  return [colours[mode === 'score' ? 'both' : mode], (Math.ceil(value * 5) / 5) * 0.75];
}

export function readColours() {
  return { sun: rgb('--sun'), earth: rgb('--earth'), both: rgb('--both'), negative: rgb('--negative') };
}

// The heat layer is drawn cell by cell into a gridSize² image, then scaled over the hillshade.
// Rows at or beyond `rows` are left clear (a job still running). `inside[k]` = 0 hides cells off the map.
// Phase 3 options:
// - view ({ cx, cy, zoom }): draw the grid under this viewport; the canvas is canvasSize device px.
//   The grid spans ±halfKm (default gridSize × cellKm / 2) in cells of cellKm (default 640 / gridSize).
// - rect ({ i0, j0, i1, j1 }, inclusive): only these cells are drawn, and `rows` counts from j0.
// - filtered (Uint8, 1 = filtered out): in the both, sun, earth and score modes such a cell gets no heat
//   colour and the base under it is dimmed to half. Ignored in the now and change modes.
// Phase 4 options:
// - frame ({ width, height, kmPerPx, cx, cy }, canvas px, the hillshade's rectangle form): a rectangular
//   canvas; takes the place of view and canvasSize. A square frame draws exactly what `view` draws.
// - style ({ fill = 1, edge = 0, edgePx = 2 }, see deepHeatStyle): fill scales each cell's opacity;
//   edge > 0 draws a band edgePx wide inside each cell along every side where the neighbour's colour
//   step differs, in the cell's own colour, so that the band shows the step opacity × edge (with edge 1
//   the band looks exactly like the default cell). Cell values are never interpolated.
// Fix H (smoothed display): style.smooth (true / false; default: automatic) draws the cells as a smooth
//   field instead of squares, see paintSmooth. Automatic is on at every zoom with a CSS scale
//   (style.pxPerCss ?? style.edgePx ?? devicePixelRatio); with none (legacy Node calls) it stays off.
//   The edge bands are not drawn when smoothing. style.smooth: false always keeps crisp cells.
export function paintHeat(ctx, { mode, values, states, planned, alt, shade, gridSize, canvasSize, rows = gridSize, inside, colours = readColours(), view, cellKm, halfKm, filtered, rect, frame, style }) {
  if (!view && !rect && !filtered && !frame && !style) {
    paintHeatPhase2(ctx, { mode, values, states, planned, alt, shade, gridSize, canvasSize, rows, inside, colours });
    return;
  }
  const cell = cellKm ?? 640 / gridSize;
  const gHalf = halfKm ?? (gridSize * cell) / 2;
  const r = rect ?? { i0: 0, j0: 0, i1: gridSize - 1, j1: gridSize - 1 };
  const jEnd = Math.min(r.j1, r.j0 + rows - 1);   // last computed row
  let i0 = r.i0, i1 = r.i1, j0 = r.j0, j1 = jEnd;
  const g = frame ?? (view ? { width: canvasSize, height: canvasSize, kmPerPx: viewKmPerPx(view, canvasSize), cx: view.cx, cy: view.cy } : null);
  if (g) {
    // cells that touch the viewport
    const kpp = g.kmPerPx, halfW = (g.width * kpp) / 2, halfH = (g.height * kpp) / 2;
    i0 = Math.max(i0, Math.floor((g.cx - halfW + gHalf) / cell));
    i1 = Math.min(i1, Math.ceil((g.cx + halfW + gHalf) / cell) - 1);
    j0 = Math.max(j0, Math.floor((gHalf - g.cy - halfH) / cell));
    j1 = Math.min(j1, Math.ceil((gHalf - g.cy + halfH) / cell) - 1);
  }
  i0 = Math.max(0, i0); j0 = Math.max(0, j0); i1 = Math.min(gridSize - 1, i1); j1 = Math.min(gridSize - 1, j1);
  if (shade) paintBase(ctx, shade, g ? g.width : canvasSize, g ? g.height : canvasSize);
  if (i1 < i0 || j1 < j0) return;
  const w = i1 - i0 + 1, hgt = j1 - j0 + 1;
  const dim = mode !== 'now' && mode !== 'night' && mode !== 'change' ? filtered : null;
  const fill = style?.fill ?? 1;
  const cellPx = g ? cell / g.kmPerPx : canvasSize / gridSize;
  const pxPerCss = style?.pxPerCss ?? style?.edgePx ?? globalThis.devicePixelRatio;   // none outside a browser: crisp
  const smooth = style?.smooth ?? (pxPerCss > 0);
  if (smooth) {
    const dx = g ? g.width / 2 + (-gHalf + i0 * cell - g.cx) / g.kmPerPx : i0 * cellPx;
    const dy = g ? g.height / 2 - (gHalf - j0 * cell - g.cy) / g.kmPerPx : j0 * cellPx;
    paintSmooth(ctx, {
      mode, values, states, planned, alt, inside, dim, colours, fill, gridSize,
      block: { i0, j0, w, h: hgt }, valid: { i0: Math.max(0, r.i0), j0: Math.max(0, r.j0), i1: Math.min(gridSize - 1, r.i1), j1: Math.min(gridSize - 1, jEnd) },
      dx, dy, s: cellPx, steps: style?.steps ?? true,
    });
    return;
  }
  const img = new ImageData(w, hgt);
  const edge = style?.edge ?? 0;
  // the colour step of a cell, packed (0 = no colour), for the edges between steps
  const keys = edge > 0 ? new Float64Array(w * hgt) : null;
  const colourOf = (k) => heatColour(mode, {
    value: values ? values[k] : 0,
    state: states ? states[k] : 0,
    delta: planned && alt ? alt[k] - planned[k] : 0,
  }, colours);
  const pack = (c) => (((c[0][0] << 16) | (c[0][1] << 8) | c[0][2]) * 256 + Math.round(c[1] * 255) + 1);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * gridSize + i;
      if (inside && !inside[k]) continue;
      const o = 4 * ((j - j0) * w + (i - i0));
      if (dim && dim[k]) { img.data[o + 3] = 128; continue; }   // black at half opacity halves the base
      const c = colourOf(k);
      if (!c) continue;
      img.data[o] = c[0][0]; img.data[o + 1] = c[0][1]; img.data[o + 2] = c[0][2];
      img.data[o + 3] = Math.round(c[1] * 255 * fill);
      if (keys) keys[(j - j0) * w + (i - i0)] = pack(c);
    }
  }
  const tmp = new OffscreenCanvas(w, hgt);
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;   // crisp cells
  let dx, dy, s;
  if (g) {
    dx = g.width / 2 + (-gHalf + i0 * cell - g.cx) / g.kmPerPx;
    dy = g.height / 2 - (gHalf - j0 * cell - g.cy) / g.kmPerPx;
    s = cell / g.kmPerPx;
  } else {
    s = canvasSize / gridSize;
    dx = i0 * s; dy = j0 * s;
  }
  ctx.drawImage(tmp, dx, dy, w * s, hgt * s);
  if (!keys) return;
  // a neighbour outside the drawn block: same rules, computed on demand
  const keyAt = (i, j) => {
    if (i >= i0 && i <= i1 && j >= j0 && j <= j1) return keys[(j - j0) * w + (i - i0)];
    if (i < r.i0 || i > r.i1 || j < r.j0 || j > jEnd || i < 0 || j < 0 || i >= gridSize || j >= gridSize) return 0;
    const k = j * gridSize + i;
    if ((inside && !inside[k]) || (dim && dim[k])) return 0;
    const c = colourOf(k);
    return c ? pack(c) : 0;
  };
  const e = Math.min(style.edgePx ?? 2, s / 2);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const key = keys[(j - j0) * w + (i - i0)];
      if (!key) continue;
      const left = keyAt(i - 1, j) !== key, right = keyAt(i + 1, j) !== key, top = keyAt(i, j - 1) !== key, bottom = keyAt(i, j + 1) !== key;
      if (!left && !right && !top && !bottom) continue;
      const v = key - 1, a = (v % 256) / 255, rgb = Math.floor(v / 256);
      // over the faint fill already there, so that the band shows the step's own opacity × edge
      const af = Math.round(a * 255 * fill) / 255, at = Math.max(af, a * edge);
      const ae = af >= 1 ? 0 : (at - af) / (1 - af);
      if (!(ae > 0)) continue;
      ctx.fillStyle = `rgba(${rgb >> 16},${(rgb >> 8) & 255},${rgb & 255},${Math.round(ae * 1000) / 1000})`;
      const x = dx + (i - i0) * s, y = dy + (j - j0) * s;
      if (left) ctx.fillRect(x, y, e, s);
      if (right) ctx.fillRect(x + s - e, y, e, s);
      if (top) ctx.fillRect(x, y, s, e);
      if (bottom) ctx.fillRect(x, y + s - e, s, e);
    }
  }
}

// Fix H: the smoothed display. Once a cell is a few CSS px wide, squares of flat colour read as a mosaic
// over the terrain (T.7's outlined cells above zoom 12 most of all). Instead of interpolating colours,
// which muddies classes, the per-cell quantities are interpolated between cell centres and every
// sample is classified with the legend's own colours (heatColour's rules):
// - both / sun / earth / score: the value, plus a ±1 "has colour" indicator so that a cell with no
//   colour keeps its own area instead of shrinking to a point; the legend's five steps become smooth
//   contour bands (steps: false lets the opacity follow the value instead).
// - change: the difference planned → alternative, so the sign flips through "no change", not a blend.
// - now: the Sun's and the Earth's elevation above the local skyline (states.sunDeg / earthDeg from
//   nowStates), so the terminator is a smooth contour; without them, ±1 per bit.
// - ±1 indicators for "inside the map" and "fails the filters" (dimmed as in the crisp path).
// Indicators are interpolated with a Mitchell–Netravali cubic (B = 0.6, C = 0.2: round corners and calm
// diagonals; an isolated cell keeps its class as a round dot about 0.75 cell across); values, differences and margins with Catmull-Rom, which passes through the cell
// centres, and the value only among cells that have a colour (normalised by their weight), so cells with
// no colour do not pull a neighbour's step down. Sampled about every SUB_PX device px. Each class boundary is anti-aliased over one sample,
// measured with the local gradient, and the browser scales the rest of the way with smoothing on, so
// two classes meet in a thin soft edge, never in an in-between tint. Cells beyond the computed rect take
// their nearest computed neighbour. Only the picture changes: read-outs keep reporting cell values.
const SUB_PX = 4;
const MAX_SAMPLES = 2.5e6;
const MITCHELL = [0.6, 0.2], CATMULL_ROM = [0, 0.5];   // indicators: B + 2C = 1; an isolated cell peaks at 0.8² > ½

function cubicW(x, [B, C]) {
  x = Math.abs(x);
  if (x < 1) return ((12 - 9 * B - 6 * C) * x * x * x + (-18 + 12 * B + 6 * C) * x * x + (6 - 2 * B)) / 6;
  if (x < 2) return ((-B - 6 * C) * x * x * x + (6 * B + 30 * C) * x * x + (-12 * B - 48 * C) * x + (8 * B + 24 * C)) / 6;
  return 0;
}

// Scratch buffers reused across paints (grow-only), so a redraw does not allocate tens of MB.
const scratch = [];
function buf(slot, n) {
  if (!scratch[slot] || scratch[slot].length < n) scratch[slot] = new Float32Array(Math.max(n, Math.ceil((scratch[slot]?.length ?? 0) * 1.25)));
  return scratch[slot].subarray(0, n);
}
// The last few smoothed images. An image depends only on the block's cell fields, the sample density,
// the mode, the colours, fill and steps, not on where it is drawn, so a repaint with the same cells (the
// 2 km layer under a 1 km job that is still running, a pan by less than a cell) reuses it.
const smoothCache = [];
let smoothImg = null;
const SMOOTH_CACHE = 3;
function sameFields(a, b, nf, n) {
  for (let f = 0; f < nf; f++) { const x = a[f], y = b[f]; for (let i = 0; i < n; i++) if (x[i] !== y[i] && !(x[i] !== x[i] && y[i] !== y[i])) return false; }
  return true;
}
const gradAt = (f, p, lf, rt, up, dn, sx, sy) => Math.abs(f[p + rt] - f[p + lf]) * sx + Math.abs(f[p + dn] - f[p + up]) * sy;

// For sub-sample q of k in a cell: the first of four taps relative to the cell, and the four weights
// of the cubic (B, C) (default Mitchell).
export function cubicTaps(k, bc = MITCHELL) {
  const start = new Int8Array(k), wts = new Float32Array(4 * k);
  for (let q = 0; q < k; q++) {
    const p = (q + 0.5) / k - 0.5;
    const base = p < 0 ? -1 : 0, f = p - base;
    start[q] = base - 1;
    for (let t = 0; t < 4; t++) wts[4 * q + t] = cubicW(f + 1 - t, bc);
  }
  return { start, wts };
}

export function paintSmooth(ctx, { mode, values, states, planned, alt, inside, dim, colours, fill = 1, gridSize, block, valid, dx, dy, s, steps = true }) {
  const P = 2, cw = block.w + 2 * P, ch = block.h + 2 * P, n = cw * ch;
  // fields per padded cell: 0 inside, 1 filtered, then the mode's quantities; exact[f]: Catmull-Rom
  const kind = mode === 'now' ? 'now' : mode === 'night' ? 'night' : mode === 'change' ? 'change' : 'value';
  const sunDeg = states?.sunDeg, earthDeg = states?.earthDeg;
  const nf = kind === 'change' || kind === 'night' ? 3 : kind === 'now' ? 4 : 5;
  const exact = kind === 'change' ? [0, 0, 1] : kind === 'night' ? [0, 0, +!!sunDeg] : kind === 'now' ? [0, 0, +!!sunDeg, +!!earthDeg] : [0, 0, 1, 0, 1];
  const F = Array.from({ length: nf }, (_, f) => buf(f, n));
  for (let pj = 0; pj < ch; pj++) {
    const j = Math.min(valid.j1, Math.max(valid.j0, block.j0 + pj - P));
    for (let pi = 0; pi < cw; pi++) {
      const i = Math.min(valid.i1, Math.max(valid.i0, block.i0 + pi - P));
      const k = j * gridSize + i, o = pj * cw + pi;
      F[0][o] = inside && !inside[k] ? -1 : 1;
      F[1][o] = dim && dim[k] ? 1 : -1;
      if (kind === 'now' || kind === 'night') {
        const st = states ? states[k] : 0;
        F[2][o] = sunDeg ? sunDeg[k] : (st & 1 ? 1 : -1);
        if (kind === 'now') F[3][o] = earthDeg ? earthDeg[k] : (st & 2 ? 1 : -1);
      } else if (kind === 'change') {
        F[2][o] = planned && alt ? alt[k] - planned[k] : 0;
      } else {
        const v = values ? values[k] : 0;
        const has = v > 0;
        F[2][o] = has ? v : 0;      // value × weight
        F[3][o] = has ? 1 : -1;     // has a colour (indicator)
        F[4][o] = has ? 1 : 0;      // weight
      }
    }
  }
  // sub-samples per cell; never more than MAX_SAMPLES in all (a degenerate geometry must not hang a paint)
  // At least two samples per cell: one just bilinearly scales the original cell mosaic, notably at
  // 1×, after the 1 km grid switch and on Live's reduced-resolution playback canvas.
  const kx = Math.max(1, Math.min(Math.max(2, Math.round(s / SUB_PX)), Math.floor(Math.sqrt(MAX_SAMPLES / (block.w * block.h)))));
  if (!(kx < 1e4) || !(s > 0)) return;
  const ck = `${mode}|${exact}|${kx}|${block.w}x${block.h}|${fill}|${steps}|${!!dim}|${colours.sun}|${colours.earth}|${colours.both}|${colours.negative}`;
  const hit = smoothCache.findIndex((e) => e.key === ck && sameFields(e.fields, F, nf, n));
  if (hit >= 0) {
    const e = smoothCache.splice(hit, 1)[0];
    smoothCache.unshift(e);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(e.canvas, dx, dy, block.w * s, block.h * s);
    return;
  }
  const W = block.w * kx, H = block.h * kx;
  const taps = [cubicTaps(kx, MITCHELL), cubicTaps(kx, CATMULL_ROM)];
  const { start } = taps[0];   // the same for both
  // separable: every padded row to W samples, then every column to H
  const T = F.map((_, f) => buf(8 + f, ch * W));
  for (let x = 0; x < W; x++) {
    const c = (x / kx) | 0, q = x - c * kx, t0 = c + P + start[q];
    for (let f = 0; f < nf; f++) {
      const wts = taps[exact[f]].wts;
      const a = wts[4 * q], b = wts[4 * q + 1], cc = wts[4 * q + 2], d = wts[4 * q + 3];
      const src = F[f], dst = T[f];
      for (let pj = 0; pj < ch; pj++) {
        const o = pj * cw + t0;
        dst[pj * W + x] = a * src[o] + b * src[o + 1] + cc * src[o + 2] + d * src[o + 3];
      }
    }
  }
  const V = T.map((_, f) => buf(16 + f, W * H));
  for (let y = 0; y < H; y++) {
    const c = (y / kx) | 0, q = y - c * kx, r0 = (c + P + start[q]) * W;
    for (let f = 0; f < nf; f++) {
      const wts = taps[exact[f]].wts;
      const a = wts[4 * q], b = wts[4 * q + 1], cc = wts[4 * q + 2], d = wts[4 * q + 3];
      const t = T[f], dst = V[f];
      for (let x = 0, o = r0, p = y * W; x < W; x++, o++, p++) dst[p] = a * t[o] + b * t[o + W] + cc * t[o + 2 * W] + d * t[o + 3 * W];
    }
  }
  // coverage of "field > thr" at a sample, soft over one sample: g is the field's change per sample
  // (|∂x| + |∂y|, central differences of the neighbouring samples)
  const soft = (v, g) => (g > 1e-9 ? Math.min(1, Math.max(0, 0.5 + v / g)) : v > 0 ? 1 : 0);
  const valueRgb = kind === 'value' ? colours[mode === 'score' ? 'both' : mode] : null;
  const S = colours.sun, E = colours.earth, B = colours.both, N = colours.negative;
  // one ImageData and at most SMOOTH_CACHE canvases live at a time: their pixels are native memory that
  // the garbage collector does not see, and a new pair per paint grew the renderer by GBs during a job
  if (!smoothImg || smoothImg.width !== W || smoothImg.height !== H) smoothImg = new ImageData(W, H);
  else smoothImg.data.fill(0);
  const img = smoothImg;
  const out = img.data;
  const [Vi, Vf, V2, V3, Vw] = V;
  if (kind === 'value') for (let p = 0; p < V2.length; p++) V2[p] = Vw[p] > 0.05 ? V2[p] / Vw[p] : 0;   // the value among coloured cells
  const fill255 = 255 * fill, dimA = 128 / 255;
  for (let y = 0, p = 0; y < H; y++) {
    const up = y > 0 ? -W : 0, dn = y < H - 1 ? W : 0, sy = up && dn ? 0.5 : 1;
    for (let x = 0; x < W; x++, p++) {
      const lf = x > 0 ? -1 : 0, rt = x < W - 1 ? 1 : 0, sx = lf && rt ? 0.5 : 1;
      const iv = Vi[p];
      const cIn = iv >= 0.999 ? 1 : soft(iv, gradAt(Vi, p, lf, rt, up, dn, sx, sy));
      if (cIn <= 0) continue;
      // premultiplied colour of the heat classes at this sample
      let r = 0, g = 0, b = 0, al = 0;
      if (kind === 'night') {
        al = 0.5 * (1 - soft(V2[p], gradAt(V2, p, lf, rt, up, dn, sx, sy)));
      } else if (kind === 'now') {
        const sv = V2[p], ev = V3[p];
        const cs = soft(sv, gradAt(V2, p, lf, rt, up, dn, sx, sy)), ce = soft(ev, gradAt(V3, p, lf, rt, up, dn, sx, sy));
        const ws = cs * (1 - ce), we = (1 - cs) * ce, wb = cs * ce;
        al = 0.7 * (ws + we + wb);
        r = 0.7 * (ws * S[0] + we * E[0] + wb * B[0]); g = 0.7 * (ws * S[1] + we * E[1] + wb * B[1]); b = 0.7 * (ws * S[2] + we * E[2] + wb * B[2]);
      } else if (kind === 'change') {
        const dl = V2[p], m = Math.abs(dl);
        const c0 = soft(m - 0.02, gradAt(V2, p, lf, rt, up, dn, sx, sy));
        if (c0 > 0) {
          const C = dl < 0 ? N : B;
          al = c0 * Math.min(1, m / 0.5) * 0.8;
          r = al * C[0]; g = al * C[1]; b = al * C[2];
        }
      } else {
        const zv = V3[p];
        const cz = zv >= 0.999 ? 1 : zv <= -0.999 ? 0 : soft(zv, gradAt(V3, p, lf, rt, up, dn, sx, sy));
        if (cz > 0) {
          const v = V2[p];
          let a;
          if (steps) {
            // ceil(v·5)/5 · 0.75 is 0.15 per step threshold (0, 0.2, …, 0.8) below v; only the nearest
            // threshold can be partly covered within one sample
            const t = Math.min(4, Math.max(1, Math.round(v * 5)));
            const below = t - 1;          // thresholds 0.2 … 0.2·(t − 1), fully below unless v is far off
            const gv = gradAt(V2, p, lf, rt, up, dn, sx, sy);
            let n = 1 + below;
            for (let m = 1; m <= 4; m++) {
              const d = v - 0.2 * m;
              if (m <= below) { if (d < 0) n -= 1 - soft(d, gv); }
              else if (d > -gv) n += soft(d, gv);
            }
            a = 0.15 * n;
          } else a = Math.min(1, Math.max(0, v)) * 0.75;
          al = cz * a;
          r = al * valueRgb[0]; g = al * valueRgb[1]; b = al * valueRgb[2];
        }
      }
      if (dim) {
        const fv = Vf[p];
        const cf = fv <= -0.999 ? 0 : fv >= 0.999 ? 1 : soft(fv, gradAt(Vf, p, lf, rt, up, dn, sx, sy));
        if (cf > 0) { const k1 = 1 - cf; r *= k1; g *= k1; b *= k1; al = al * fill * k1 + cf * dimA; al /= fill; }   // black at half opacity halves the base
      }
      al *= cIn; r *= cIn; g *= cIn; b *= cIn;
      if (!(al > 0)) continue;
      const o = 4 * p;
      out[o] = r / al; out[o + 1] = g / al; out[o + 2] = b / al;
      out[o + 3] = Math.round(al * fill255);
    }
  }
  const old = smoothCache.length >= SMOOTH_CACHE ? smoothCache.pop() : null;
  const tmp = old && old.canvas.width === W && old.canvas.height === H ? old.canvas : new OffscreenCanvas(W, H);
  tmp.getContext('2d').putImageData(img, 0, 0);
  smoothCache.unshift({ key: ck, fields: F.map((f) => Float32Array.from(f)), canvas: tmp });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, dx, dy, block.w * s, block.h * s);
}

// T.7 (phase 4), revised in fix H: above `from` the fill fades to minFill (reached at `full`) so the
// 20 m terrain stays the subject. T.7's edge bands between steps are gone (they outlined every cell);
// the smoothed display (paintSmooth) replaces them, including at 1× and just after a grid switch.
// edgePx is the canvas's device px per CSS px (paintHeat reads it as pxPerCss).
export function deepHeatStyle(zoom, { from = 12, full = 24, minFill = 0.6, edgePx = 2 } = {}) {
  const t = zoom > from ? Math.min(1, (zoom - from) / (full - from)) : 0;
  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  return { fill: r4(1 - (1 - minFill) * t), edge: 0, edgePx };
}

// The phase 2 path, unchanged.
function paintHeatPhase2(ctx, { mode, values, states, planned, alt, shade, gridSize, canvasSize, rows, inside, colours }) {
  const img = new ImageData(gridSize, gridSize);
  for (let j = 0; j < Math.min(rows, gridSize); j++) {
    for (let i = 0; i < gridSize; i++) {
      const k = j * gridSize + i;
      if (inside && !inside[k]) continue;
      const c = heatColour(mode, {
        value: values ? values[k] : 0,
        state: states ? states[k] : 0,
        delta: planned && alt ? alt[k] - planned[k] : 0,
      }, colours);
      if (!c) continue;
      img.data[4 * k] = c[0][0]; img.data[4 * k + 1] = c[0][1]; img.data[4 * k + 2] = c[0][2];
      img.data[4 * k + 3] = Math.round(c[1] * 255);
    }
  }
  const tmp = new OffscreenCanvas(gridSize, gridSize);
  tmp.getContext('2d').putImageData(img, 0, 0);
  if (shade) paintBase(ctx, shade, canvasSize);
  ctx.imageSmoothingEnabled = false;   // crisp 2 km cells
  ctx.drawImage(tmp, 0, 0, canvasSize, canvasSize);
}
