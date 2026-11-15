// Regions anywhere on the Moon (pure; browser and Node). The polar map's regions are shapes in polar map km and read
// the polar Sun and Earth grids (terrain skylines, heat.js). North of 80°S there are no such grids, so a region
// drawn there on the globe is kept in latitude and longitude and read from the ephemeris over a SMOOTH horizon, as
// the globe's heat colours outside the polar cap are (globalheat.js): no terrain shadows, an assumption the region
// card names. Slope filters and suitability need the polar data, so they stay empty for these regions.
//
// Geo shapes (geo: true):
//   { type: 'rect', geo: true, lat0, lat1, lonW, spanDeg }   a latitude/longitude box: lat0 < lat1, from lonW
//                                                            eastward over spanDeg (0–180]
//   { type: 'circle', geo: true, latDeg, lonDeg, rKm }       all ground within rKm (great-circle) of the centre
//   { type: 'polygon', geo: true, pts: [[lat, lon], …] }     great-circle edges, 3–64 corners
// Hash form: grect:lat0,lonW,lat1,spanDeg · gcircle:lat,lon,rKm · gpoly:lat,lon;lat,lon;…
const RAD = Math.PI / 180, DEG = 180 / Math.PI;
export const MOON_R_KM = 1737.4;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r2 = (v) => Math.round(v * 100) / 100;
const lon360 = (v) => r4(((v % 360) + 360) % 360);

export const isGeo = (shape) => !!shape?.geo;

// unit vector, the ephemeris frame (geometry.js unitFromLonLat): x to 0°E, z to the north pole
export function unitLL(latDeg, lonDeg) {
  const la = latDeg * RAD, lo = lonDeg * RAD, c = Math.cos(la);
  return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const gcKm = (a, b) => MOON_R_KM * Math.acos(Math.max(-1, Math.min(1, dot(unitLL(a[0], a[1]), unitLL(b[0], b[1])))));

// the box from two clicked corners: the shorter way round in longitude
export function geoRect(a, b) {
  const lat0 = Math.min(a.latDeg, b.latDeg), lat1 = Math.max(a.latDeg, b.latDeg);
  let d = lon360(b.lonDeg - a.lonDeg);
  const lonW = d <= 180 ? lon360(a.lonDeg) : lon360(b.lonDeg);
  if (d > 180) d = 360 - d;
  return lat1 - lat0 > 1e-4 && d > 1e-4 ? { type: 'rect', geo: true, lat0: r4(lat0), lat1: r4(lat1), lonW: r4(lonW), spanDeg: r4(d) } : null;
}
export function geoCircle(c, edge) {
  const rKm = gcKm([c.latDeg, c.lonDeg], [edge.latDeg, edge.lonDeg]);
  return rKm > 0.05 ? { type: 'circle', geo: true, latDeg: r4(c.latDeg), lonDeg: r4(lon360(c.lonDeg)), rKm: r2(rKm) } : null;
}
export function geoPolygon(points) {
  const pts = points.map((p) => [r4(p.latDeg), r4(lon360(p.lonDeg))]);
  return pts.length >= 3 && pts.length <= 64 ? { type: 'polygon', geo: true, pts } : null;
}

export function geoParam(sh) {
  if (!isGeo(sh)) return null;
  // rounded (lon360 leaves float noise such as 25.853099999999984)
  if (sh.type === 'rect') return `grect:${[sh.lat0, sh.lonW, sh.lat1, sh.spanDeg].map(r4).join(',')}`;
  if (sh.type === 'circle') return `gcircle:${[r4(sh.latDeg), r4(sh.lonDeg), r2(sh.rKm)].join(',')}`;
  if (sh.type === 'polygon') return `gpoly:${sh.pts.map((p) => p.map(r4).join(',')).join(';')}`;
  return null;
}
const nums = (s, n) => { const v = s.split(',').map(Number); return v.length === n && v.every(Number.isFinite) ? v : null; };
const latOk = (v) => v >= -90 && v <= 90;
export function parseGeo(kind, body) {
  if (kind === 'grect') {
    const v = nums(body, 4);
    return v && latOk(v[0]) && latOk(v[2]) && v[2] > v[0] && v[3] > 0 && v[3] <= 180 ? { type: 'rect', geo: true, lat0: v[0], lonW: lon360(v[1]), lat1: v[2], spanDeg: v[3] } : null;
  }
  if (kind === 'gcircle') {
    const v = nums(body, 3);
    return v && latOk(v[0]) && v[2] > 0 && v[2] <= 3000 ? { type: 'circle', geo: true, latDeg: v[0], lonDeg: lon360(v[1]), rKm: v[2] } : null;
  }
  if (kind === 'gpoly') {
    const pts = body.split(';').map((p) => nums(p, 2));
    return pts.length >= 3 && pts.length <= 64 && pts.every((p) => p && latOk(p[0])) ? { type: 'polygon', geo: true, pts: pts.map(([a, b]) => [a, lon360(b)]) } : null;
  }
  return null;
}

// the centre of a shape (lat, lon) and a gnomonic projection about it: great circles are straight lines in it, so a
// polygon with great-circle edges is a plain polygon there (fine for shapes smaller than a hemisphere)
function centreOf(sh) {
  if (sh.type === 'rect') return [(sh.lat0 + sh.lat1) / 2, sh.lonW + sh.spanDeg / 2];
  if (sh.type === 'circle') return [sh.latDeg, sh.lonDeg];
  const s = [0, 0, 0];
  for (const [a, b] of sh.pts) { const u = unitLL(a, b); s[0] += u[0]; s[1] += u[1]; s[2] += u[2]; }
  const n = Math.hypot(...s) || 1;
  return [Math.asin(s[2] / n) * DEG, lon360(Math.atan2(s[1], s[0]) * DEG)];
}
function gnomonic(c) {
  const C = unitLL(c[0], c[1]);
  const E = [-Math.sin(c[1] * RAD), Math.cos(c[1] * RAD), 0];
  const N = [C[1] * E[2] - C[2] * E[1], C[2] * E[0] - C[0] * E[2], C[0] * E[1] - C[1] * E[0]];
  return (lat, lon) => { const u = unitLL(lat, lon), d = dot(u, C); return d > 1e-6 ? [dot(u, E) / d, dot(u, N) / d] : null; };
}

// (lat, lon) → inside the shape
export function geoContains(sh) {
  if (sh.type === 'rect') return (lat, lon) => lat >= sh.lat0 && lat <= sh.lat1 && lon360(lon - sh.lonW) <= sh.spanDeg;
  if (sh.type === 'circle') { const c = [sh.latDeg, sh.lonDeg]; return (lat, lon) => gcKm(c, [lat, lon]) <= sh.rKm; }
  const proj = gnomonic(centreOf(sh)), poly = sh.pts.map(([a, b]) => proj(a, b));
  if (poly.some((p) => !p)) return () => false;
  return (lat, lon) => {
    const q = proj(lat, lon);
    if (!q) return false;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > q[1]) !== (yj > q[1]) && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}

// the outline to draw, as { latDeg, lonDeg } corners joined by great circles (the box: its parallels sampled finely,
// since a parallel is not a great circle)
export function geoOutline(sh) {
  if (sh.type === 'rect') {
    const n = Math.max(2, Math.ceil(sh.spanDeg * 2)), out = [];
    for (let k = 0; k <= n; k++) out.push({ latDeg: sh.lat0, lonDeg: sh.lonW + (sh.spanDeg * k) / n });
    for (let k = n; k >= 0; k--) out.push({ latDeg: sh.lat1, lonDeg: sh.lonW + (sh.spanDeg * k) / n });
    out.push(out[0]);
    return out;
  }
  if (sh.type === 'circle') {
    const d = sh.rKm / MOON_R_KM, la = sh.latDeg * RAD, lo = sh.lonDeg * RAD, out = [];
    for (let k = 0; k <= 96; k++) {
      const b = (2 * Math.PI * k) / 96;
      const lat = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
      const lon = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(lat));
      out.push({ latDeg: lat * DEG, lonDeg: lon360(lon * DEG) });
    }
    return out;
  }
  const out = sh.pts.map(([a, b]) => ({ latDeg: a, lonDeg: b }));
  out.push(out[0]);
  return out;
}

// the latitude band and longitude span a shape covers (for the sampling grid)
function extent(sh) {
  if (sh.type === 'rect') return { lat0: sh.lat0, lat1: sh.lat1, lonW: sh.lonW, span: sh.spanDeg };
  const o = geoOutline(sh);
  let lat0 = 90, lat1 = -90;
  for (const p of o) { lat0 = Math.min(lat0, p.latDeg); lat1 = Math.max(lat1, p.latDeg); }
  if (sh.type === 'circle') {   // a cap over a pole covers every longitude
    const dLat = (sh.rKm / MOON_R_KM) * DEG;
    if (sh.latDeg + dLat >= 90) lat1 = 90;
    if (sh.latDeg - dLat <= -90) lat0 = -90;
  }
  if (lat1 >= 89.99 || lat0 <= -89.99) return { lat0, lat1, lonW: 0, span: 360 };
  // the smallest eastward span holding every outline longitude
  const lons = o.map((p) => lon360(p.lonDeg)).sort((a, b) => a - b);
  let gap = -1, at = 0;
  for (let i = 0; i < lons.length; i++) { const g = lon360((lons[(i + 1) % lons.length] - lons[i]) || 360); if (g > gap) { gap = g; at = (i + 1) % lons.length; } }
  return { lat0, lat1, lonW: lons[at], span: Math.min(360, 360 - gap) };
}

// Exact areas for the box and the cap; the polygon from the sampled cells (geoStats)
export function geoAreaKm2(sh) {
  const R2 = MOON_R_KM * MOON_R_KM;
  if (sh.type === 'rect') return R2 * sh.spanDeg * RAD * (Math.sin(sh.lat1 * RAD) - Math.sin(sh.lat0 * RAD));
  if (sh.type === 'circle') return 2 * Math.PI * R2 * (1 - Math.cos(sh.rKm / MOON_R_KM));
  return null;
}

// Sun, Earth and both above the smooth horizon over [startMs, startMs + lenMs], on cells of about `targetCells`
// inside the shape: the area-weighted means (0–1), the cell count, the area, and the best cell for `mode`.
// eph.at(t) → { sun, earth } unit vectors (or null outside the ephemeris).
export function geoStats(sh, eph, startMs, lenMs, { mode = 'both', stepMs = 2 * 3600e3, targetCells = 3000 } = {}) {
  const ex = extent(sh), inside = geoContains(sh);
  const midCos = Math.max(0.05, Math.cos(((ex.lat0 + ex.lat1) / 2) * RAD));
  const areaDeg = Math.max(1e-6, (ex.lat1 - ex.lat0) * ex.span * midCos);
  const step = Math.max(0.01, Math.min(1, Math.sqrt(areaDeg / targetCells)));
  const cells = [];
  for (let lat = ex.lat0 + step / 2; lat < ex.lat1; lat += step) {
    const lonStep = step / Math.max(0.05, Math.cos(lat * RAD));
    for (let d = lonStep / 2; d < ex.span; d += lonStep) {
      const lon = lon360(ex.lonW + d);
      if (inside(lat, lon)) cells.push({ lat, lon, u: unitLL(lat, lon), w: Math.cos(lat * RAD) * lonStep * step, sun: 0, earth: 0, both: 0 });
    }
  }
  // a region smaller than one cell: its centre stands for it
  if (!cells.length) { const c = centreOf(sh); cells.push({ lat: c[0], lon: c[1], u: unitLL(c[0], c[1]), w: 1, sun: 0, earth: 0, both: 0 }); }
  let steps = 0;
  for (let t = startMs; t <= startMs + lenMs; t += stepMs) {
    const e = eph.at(t);
    if (!e) continue;
    steps++;
    for (const c of cells) {
      const s = dot(c.u, e.sun) > 0, m = dot(c.u, e.earth) > 0;
      if (s) c.sun++;
      if (m) c.earth++;
      if (s && m) c.both++;
    }
  }
  if (!steps) return null;
  let W = 0, sun = 0, earth = 0, both = 0, best = null;
  for (const c of cells) {
    c.sun /= steps; c.earth /= steps; c.both /= steps;
    W += c.w; sun += c.sun * c.w; earth += c.earth * c.w; both += c.both * c.w;
    const v = c[mode] ?? c.both;
    if (!best || v > best.value) best = { latDeg: r4(c.lat), lonDeg: r4(c.lon), value: v };
  }
  const area = geoAreaKm2(sh) ?? W * RAD * RAD * MOON_R_KM * MOON_R_KM;
  return { cells: cells.length, cellDeg: step, areaKm2: area, sun: sun / W, earth: earth / W, both: both / W, pass: null, score: null, best };
}
