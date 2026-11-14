// Terrain styles of the 2D map (pure, no DOM): the topographic colours and hillshade, the Sun-lit relief with
// cast shadows, contour lines, and the Sun / Earth directions on the map plane. The map draws these from a
// height field: one height in metres per pixel (NaN where no terrain), row by row.
//
// Map plane in km: pole at the origin, 0°E up (+y), 90°E right (+x), as in terrain.js. Pixel (col, row) of a
// frame { width, height, kmPerPx, cx, cy } is at x = cx − w/2 + (col + 0.5)·k, y = cy + h/2 − (row + 0.5)·k.
import { fromXY } from '../terrain.js';

const R_KM = 1737.4;
const RAD = Math.PI / 180;

export const TERRAIN_STYLES = [['data', 'Data'], ['topo', 'Topo'], ['real', 'Real light']];

// ---------- height field ----------

// Heights of rows r0 … r0 + rows − 1 of the frame into out (width × height floats): from the finest level of
// the DEM chain that has the point, else a coarser one. `dem` is a createDem level or a pyramid composite.
export function heightBand(dem, out, g, r0, rows) {
  const { width, height, kmPerPx: k, cx, cy } = g;
  const chain = dem.chain ?? [dem];
  const halfW = (width * k) / 2, halfH = (height * k) / 2;
  const xs = new Float64Array(width), ys = new Float64Array(rows);
  for (let c = 0; c < width; c++) xs[c] = cx - halfW + (c + 0.5) * k;
  for (let j = 0; j < rows; j++) ys[j] = cy + halfH - (r0 + j + 0.5) * k;
  out.fill(NaN, r0 * width, (r0 + rows) * width);
  for (const level of chain) {
    const at = level.grid ? level.grid(xs, ys) : (i, j) => level.sample(xs[i], ys[j]);
    for (let j = 0; j < rows; j++) {
      const o = (r0 + j) * width;
      for (let c = 0; c < width; c++) {
        if (out[o + c] === out[o + c]) continue;
        const v = at(c, j);
        if (v === v) out[o + c] = v;
      }
    }
  }
}

// The 2 % and 98 % heights (a few outliers must not flatten the colours); null when nothing has a height.
export function heightRange(hf, lo = 0.02, hi = 0.98) {
  const pick = [];
  const stride = Math.max(1, Math.floor(hf.length / 40000));
  for (let i = 0; i < hf.length; i += stride) if (hf[i] === hf[i]) pick.push(hf[i]);
  if (!pick.length) return null;
  pick.sort((a, b) => a - b);
  const a = pick[Math.floor(lo * (pick.length - 1))], b = pick[Math.ceil(hi * (pick.length - 1))];
  return b > a ? { lo: a, hi: b } : { lo: a - 1, hi: a + 1 };
}

// Median ground gradient of the view, metres of height per pixel (flat pixels left out); 0 for none.
export function typicalGradient(hf, w, h) {
  const g = [];
  for (let r = 1; r < h - 1; r += 5) {
    for (let c = 1 + (r % 7); c < w - 1; c += 7) {
      const i = r * w + c;
      const gx = (hf[i + 1] - hf[i - 1]) / 2, gy = (hf[i + w] - hf[i - w]) / 2;
      const m = Math.hypot(gx, gy);
      if (m > 0) g.push(m);
    }
  }
  if (!g.length) return 0;
  g.sort((a, b) => a - b);
  return g[g.length >> 1];
}

// ---------- topographic colours ----------
// A muted palette like the globe's minimap: dark blue-grey low, grey, sand high.
export const TINT = [[0, [46, 58, 82]], [0.3, [86, 98, 112]], [0.6, [150, 146, 136]], [1, [222, 205, 165]]];
export function tintAt(t) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  let i = 0;
  while (i < TINT.length - 2 && x > TINT[i + 1][0]) i++;
  const [t0, a] = TINT[i], [t1, b] = TINT[i + 1], f = (x - t0) / (t1 - t0);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// Multi-directional hillshade: four lights from 225° to 360° at 35° up, averaged; 0.5 on flat ground.
const TOPO_LIGHTS = [225, 270, 315, 360].map((az) => [Math.sin(az * RAD) * Math.cos(35 * RAD), Math.cos(az * RAD) * Math.cos(35 * RAD)]);
const TOPO_LZ = Math.sin(35 * RAD);
export const TOPO_CONTRAST = 1.9;

// Colour of one pixel from its hillshade (0–1) and its position in the height range (0–1): [r, g, b] 0–255.
export function topoColour(shade, t) {
  const c = tintAt(t);
  const k = 0.3 + 1.0 * Math.min(1, Math.max(0, shade));   // 0.3 in the darkest shade, 1.3 in the brightest
  return [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
}

// Hillshade × tint into RGBA rows r0 … r0 + rows − 1 of img (width × height × 4).
export function topoBand(hf, w, h, kmPerPx, range, img, r0, rows) {
  const inv = 1 / (range.hi - range.lo);
  const d = 2 * kmPerPx * 1000;   // metres between the two samples of a central difference
  for (let r = r0; r < r0 + rows; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c, o = 4 * i, z = hf[i];
      if (z !== z) { img[o] = img[o + 1] = img[o + 2] = 8; img[o + 3] = 255; continue; }
      const xl = c > 0 ? hf[i - 1] : z, xr = c < w - 1 ? hf[i + 1] : z;
      const yu = r > 0 ? hf[i - w] : z, yd = r < h - 1 ? hf[i + w] : z;
      let gx = (xr - xl) / (d * (c > 0 && c < w - 1 ? 1 : 0.5)), gy = (yu - yd) / (d * (r > 0 && r < h - 1 ? 1 : 0.5));   // up is +y on the map
      if (gx !== gx) gx = 0;
      if (gy !== gy) gy = 0;
      const n = Math.sqrt(gx * gx + gy * gy + 1);
      let lit = 0;
      for (let q = 0; q < 4; q++) lit += Math.max(0, (-gx * TOPO_LIGHTS[q][0] - gy * TOPO_LIGHTS[q][1] + TOPO_LZ) / n);
      lit /= 4;
      const col = topoColour(0.5 + (lit - TOPO_LZ) * TOPO_CONTRAST, (z - range.lo) * inv);
      img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2]; img[o + 3] = 255;
    }
  }
}

// ---------- the Sun and the Earth on the map plane ----------

// A direction in the Moon-fixed frame (unit vector `dir`; `rangeKm` for a body that is not at infinity) seen
// from the point (xKm, yKm) of the map: its elevation, and the unit vector (dx, dy) of its horizontal
// direction on the map (the projection is conformal, so angles hold). (dx, dy) is (0, 0) at the zenith.
export function bodyDirection(dir, xKm, yKm, rangeKm = Infinity) {
  const { latDeg, lonDeg } = fromXY(xKm, yKm);
  return bodyDirectionAt(dir, latDeg * RAD, lonDeg * RAD, rangeKm);
}
function bodyDirectionAt(dir, phi, lam, rangeKm) {
  const sp = Math.sin(phi), cp = Math.cos(phi), sl = Math.sin(lam), cl = Math.cos(lam);
  let vx = dir[0], vy = dir[1], vz = dir[2];
  if (Number.isFinite(rangeKm)) { vx = vx * rangeKm - R_KM * cp * cl; vy = vy * rangeKm - R_KM * cp * sl; vz = vz * rangeKm - R_KM * sp; }
  const len = Math.hypot(vx, vy, vz);
  vx /= len; vy /= len; vz /= len;
  const up = cp * cl * vx + cp * sl * vy + sp * vz;
  const east = -sl * vx + cl * vy;
  const north = -sp * cl * vx - sp * sl * vy + cp * vz;
  const hm = Math.hypot(east, north);
  const elDeg = Math.asin(Math.max(-1, Math.min(1, up))) / RAD;
  if (hm < 1e-9) return { elDeg, dx: 0, dy: 0, up };
  // east on the map is (cos λ, −sin λ), north (away from the pole) is (sin λ, cos λ)
  return { elDeg, dx: (east * cl + north * sl) / hm, dy: (-east * sl + north * cl) / hm, up };
}

// ---------- cast shadows ----------

// Is the ground at (x, y) km, height h0 m, in the shadow of terrain towards the Sun? The ray runs over the map
// in the unit direction (dx, dy) and rises by tanEl; `sample(xKm, yKm)` gives heights in metres (NaN: no data).
// Steps start at step0 km and grow by 10 % of the distance (at least step0) out to maxKm. The ground curves
// away by d²/2R, so a point d km out sits that much lower than the local plane.
export function shadowed(sample, x, y, h0, dx, dy, tanEl, { maxKm = 40, step0 = 0.02 } = {}) {
  let d = step0;
  while (d <= maxKm) {
    const z = sample(x + dx * d, y + dy * d);
    if (z === z && z - (d * d * 1000) / (2 * R_KM) > h0 + d * 1000 * tanEl) return true;
    d += Math.max(step0, 0.1 * d);
  }
  return false;
}

// Brightness 0–255 of the Sun-lit relief into out (width × height bytes), for rows r0 … r0 + rows − 1.
// `sun` is the Sun's unit vector in the Moon-fixed frame; `sample` as in shadowed(). Each pixel takes its own
// local up from its latitude and longitude, so the Sun's elevation and bearing change over a wide view.
// Lambert shading from the slope of hf, zero where the ground is in shadow or the Sun is below the horizon;
// `gain` is the exposure (see exposureFor). `stride` > 1 computes one pixel in a stride × stride block and
// repeats it (the quick first pass). Where the ground is dark, a little (AMBIENT) stays so that the
// relief can still be told apart from missing data; Earthshine is not modelled.
export const AMBIENT = 8;
export function lightBand(hf, w, h, g, sun, sample, gain, out, r0, rows, stride = 1, opts = {}) {
  const k = g.kmPerPx, halfW = (w * k) / 2, halfH = (h * k) / 2, d = 2 * k * 1000;
  const maxKm = opts.maxKm ?? 40, step0 = Math.max(opts.step0 ?? 0, k, 0.005);
  const rEnd = Math.min(h, r0 + rows);
  for (let r = r0; r < rEnd; r += stride) {
    const y = g.cy + halfH - (r + 0.5) * k;
    for (let c = 0; c < w; c += stride) {
      const i = r * w + c;
      let v = AMBIENT;
      const z = hf[i];
      if (z === z) {
        const x = g.cx - halfW + (c + 0.5) * k;
        const { latDeg, lonDeg } = fromXY(x, y);
        const sd = bodyDirectionAt(sun, latDeg * RAD, lonDeg * RAD, Infinity);
        if (sd.up > 0) {
          const xl = c > 0 ? hf[i - 1] : z, xr = c < w - 1 ? hf[i + 1] : z, yu = r > 0 ? hf[i - w] : z, yd = r < h - 1 ? hf[i + w] : z;
          let gx = (xr - xl) / (d * (c > 0 && c < w - 1 ? 1 : 0.5)), gy = (yu - yd) / (d * (r > 0 && r < h - 1 ? 1 : 0.5));
          if (gx !== gx) gx = 0;
          if (gy !== gy) gy = 0;
          const ce = Math.sqrt(Math.max(0, 1 - sd.up * sd.up));
          const lit = (-gx * ce * sd.dx - gy * ce * sd.dy + sd.up) / Math.sqrt(gx * gx + gy * gy + 1);
          if (lit > 0 && !shadowed(sample, x, y, z, sd.dx, sd.dy, sd.up / ce, { maxKm, step0 })) {
            v = AMBIENT + (255 - AMBIENT) * Math.pow(Math.min(1, lit * gain), 0.75);
          }
        }
      }
      if (stride === 1) { out[i] = v; continue; }
      for (let rr = r; rr < Math.min(rEnd, r + stride); rr++) for (let cc = c; cc < Math.min(w, c + stride); cc++) out[rr * w + cc] = v;
    }
  }
}

// Exposure for the view: flat ground in full Sun reads mid-grey; with the Sun lower than 15° the gain stops
// growing, so a Sun a degree above the horizon gives dark ground and bright slopes facing it.
export function exposureFor(sunElDeg) {
  return 0.6 / Math.max(Math.sin(sunElDeg * RAD), Math.sin(15 * RAD));
}

// ---------- contour lines ----------

// 1, 2 or 5 × 10ⁿ metres: the interval whose lines fall about targetPx apart where the ground changes by
// gradMPerPx metres per pixel (the view's typical slope).
export function contourInterval(gradMPerPx, targetPx = 16) {
  if (!(gradMPerPx > 0)) return 1;
  const want = gradMPerPx * targetPx;
  const p = Math.pow(10, Math.floor(Math.log10(want)));
  let best = p, bestErr = Infinity;
  for (const m of [1, 2, 5, 10]) {
    const e = Math.abs(Math.log(m * p / want));
    if (e < bestErr) { bestErr = e; best = m * p; }
  }
  return Math.max(1, best);
}

// Marching squares over the nodes of hf every `step` pixels. → { segs: Float32Array [x0, y0, x1, y1, …] in hf
// pixel coordinates (node k at k·step + 0.5), level: Int32Array (the segment's line number: its height is
// level × interval) }. Cells with a missing corner are skipped.
const CASES = [[], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], [[3, 0], [1, 2]], [[0, 2]], [[3, 2]], [[2, 3]], [[0, 2]], [[0, 1], [2, 3]], [[1, 2]], [[3, 1]], [[0, 1]], [[3, 0]], []];
// edges: 0 top (v0–v1), 1 right (v1–v2), 2 bottom (v3–v2), 3 left (v0–v3); case bits: v0 = 1, v1 = 2, v2 = 4, v3 = 8
export function contourSegments(hf, w, h, step, interval) {
  const nx = Math.floor((w - 1) / step), ny = Math.floor((h - 1) / step);
  const segs = [], levels = [];
  const v = new Float64Array(4);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x0 = i * step, y0 = j * step, x1 = x0 + step, y1 = y0 + step;
      v[0] = hf[y0 * w + x0]; v[1] = hf[y0 * w + x1]; v[2] = hf[y1 * w + x1]; v[3] = hf[y1 * w + x0];
      if (v[0] !== v[0] || v[1] !== v[1] || v[2] !== v[2] || v[3] !== v[3]) continue;
      const lo = Math.min(v[0], v[1], v[2], v[3]), hi = Math.max(v[0], v[1], v[2], v[3]);
      if (lo === hi) continue;
      const mean = (v[0] + v[1] + v[2] + v[3]) / 4;
      for (let k = Math.floor(lo / interval) + 1; k * interval <= hi; k++) {
        const L = k * interval;
        let cs = (v[0] >= L ? 1 : 0) | (v[1] >= L ? 2 : 0) | (v[2] >= L ? 4 : 0) | (v[3] >= L ? 8 : 0);
        if (cs === 0 || cs === 15) continue;
        let pairs = CASES[cs];
        // a saddle: the centre decides which two corners stay joined
        if (cs === 5) pairs = mean >= L ? [[3, 2], [0, 1]] : [[3, 0], [1, 2]];
        else if (cs === 10) pairs = mean >= L ? [[3, 0], [1, 2]] : [[0, 1], [3, 2]];
        for (const [a, b] of pairs) {
          const pa = edgePoint(a, v, L, x0, y0, x1, y1), pb = edgePoint(b, v, L, x0, y0, x1, y1);
          segs.push(pa[0] + 0.5, pa[1] + 0.5, pb[0] + 0.5, pb[1] + 0.5);
          levels.push(k);
        }
      }
    }
  }
  return { segs: Float32Array.from(segs), level: Int32Array.from(levels) };
}
function edgePoint(e, v, L, x0, y0, x1, y1) {
  const f = (a, b) => (b === a ? 0.5 : (L - a) / (b - a));
  if (e === 0) return [x0 + (x1 - x0) * f(v[0], v[1]), y0];
  if (e === 1) return [x1, y0 + (y1 - y0) * f(v[1], v[2])];
  if (e === 2) return [x0 + (x1 - x0) * f(v[3], v[2]), y1];
  return [x0, y0 + (y1 - y0) * f(v[0], v[3])];
}

// Joins the segments into polylines (neighbouring cells compute the same point on their shared edge, so the
// ends match exactly): { pts: Float32Array [x, y, …], start: Int32Array (line k is points start[k] … start[k+1] − 1),
// level: Int32Array }. A long polyline costs far less to stroke than the same line as thousands of short pieces.
export function contourLines({ segs, level }) {
  const n = level.length;
  const key = (x, y) => Math.round(x * 256) * 4194304 + Math.round(y * 256);
  const at = new Map();   // point → the segments that end there (at most two)
  for (let s = 0; s < n; s++) {
    for (const e of [0, 2]) {
      const k = key(segs[4 * s + e], segs[4 * s + e + 1]);
      const l = at.get(k);
      if (l) l.push(s); else at.set(k, [s]);
    }
  }
  const used = new Uint8Array(n);
  const pts = [], start = [0], lv = [];
  const other = (s, k) => (key(segs[4 * s], segs[4 * s + 1]) === k ? 2 : 0);   // the offset of the end of s that is not at k
  const next = (s, k) => { const l = at.get(k); if (!l) return -1; for (const t of l) if (t !== s && !used[t] && level[t] === level[s]) return t; return -1; };
  for (let s0 = 0; s0 < n; s0++) {
    if (used[s0]) continue;
    // walk back to one end of the chain (or all the way round a loop), then forward
    let s = s0, k = key(segs[4 * s], segs[4 * s + 1]);
    for (let guard = 0; guard < n; guard++) {
      const t = next(s, k);
      if (t < 0 || t === s0) break;
      const o = other(t, k);   // the far end of t from the shared point is where we go on from
      k = key(segs[4 * t + o], segs[4 * t + o + 1]);
      s = t;
      if (s === s0) break;
    }
    // k is the point at the free end; s the segment there. Now walk from it.
    let cur = s, from = k;
    let e0 = other(cur, from) === 2 ? 0 : 2;   // offset of the end at `from`
    pts.push(segs[4 * cur + e0], segs[4 * cur + e0 + 1]);
    for (let guard = 0; guard <= n; guard++) {
      used[cur] = 1;
      const far = other(cur, from);
      pts.push(segs[4 * cur + far], segs[4 * cur + far + 1]);
      from = key(segs[4 * cur + far], segs[4 * cur + far + 1]);
      const t = next(cur, from);
      if (t < 0) break;
      cur = t;
    }
    start.push(pts.length / 2);
    lv.push(level[s0]);
  }
  return { pts: Float32Array.from(pts), start: Int32Array.from(start), level: Int32Array.from(lv) };
}

// Label spots on every fifth line: at most one per gapPx × gapPx neighbourhood, away from the edges, turned
// along the line (from the gradient of hf, so it does not jitter with the short segments). In hf pixels.
export function contourLabels(contours, hf, w, h, interval, { gapPx = 120, margin = 24, max = 60 } = {}) {
  const { segs, level } = contours;
  const out = [];
  const taken = [];
  for (let s = 0; s < level.length && out.length < max; s++) {
    if (level[s] % 5 !== 0) continue;
    const x = (segs[4 * s] + segs[4 * s + 2]) / 2, y = (segs[4 * s + 1] + segs[4 * s + 3]) / 2;
    if (x < margin || y < margin || x > w - margin || y > h - margin) continue;
    if (taken.some((t) => Math.abs(t[0] - x) < gapPx && Math.abs(t[1] - y) < gapPx)) continue;
    const ci = Math.min(w - 2, Math.max(1, Math.round(x - 0.5))), ri = Math.min(h - 2, Math.max(1, Math.round(y - 0.5)));
    const i = ri * w + ci;
    const gx = hf[i + 1] - hf[i - 1], gy = hf[i + w] - hf[i - w];
    if (!(Math.hypot(gx, gy) > 0)) continue;
    let angle = Math.atan2(gx, -gy);   // along the line in canvas coordinates (y down)
    if (Math.cos(angle) < 0) angle += Math.PI;
    taken.push([x, y]);
    out.push({ x, y, angle, text: heightLabel(level[s] * interval) });
  }
  return out;
}
export function heightLabel(m) {
  const v = Math.round(m);
  return `${v < 0 ? '−' : ''}${Math.abs(v)}`;
}
