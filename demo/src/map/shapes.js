// Region and route shapes on the map plane (phase 3 §4.6, §5.5). Pure functions, km plane:
// pole at the origin, +x towards 90°E, +y towards 0°E. Areas and lengths are planar.
//   { type: 'rect', x0, y0, x1, y1 }        corners in any order
//   { type: 'circle', cx, cy, rKm }
//   { type: 'polygon', points: [[x, y], …] } closed implicitly, at least 3 points
//   { type: 'route', points: [[x, y], …] }   open polyline, at least 2 points

export function contains(shape, x, y) {
  if (!shape) return false;
  if (shape.type === 'rect') {
    return x >= Math.min(shape.x0, shape.x1) && x <= Math.max(shape.x0, shape.x1)
      && y >= Math.min(shape.y0, shape.y1) && y <= Math.max(shape.y0, shape.y1);
  }
  if (shape.type === 'circle') return Math.hypot(x - shape.cx, y - shape.cy) <= shape.rKm;
  if (shape.type === 'polygon') {
    // even-odd ray cast towards +x
    const p = shape.points;
    let inside = false;
    for (let a = 0, b = p.length - 1; a < p.length; b = a++) {
      const [xa, ya] = p[a], [xb, yb] = p[b];
      if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
    }
    return inside;
  }
  return false;   // a route encloses nothing
}

export function bbox(shape) {
  if (shape.type === 'rect') {
    return { x0: Math.min(shape.x0, shape.x1), y0: Math.min(shape.y0, shape.y1), x1: Math.max(shape.x0, shape.x1), y1: Math.max(shape.y0, shape.y1) };
  }
  if (shape.type === 'circle') return { x0: shape.cx - shape.rKm, y0: shape.cy - shape.rKm, x1: shape.cx + shape.rKm, y1: shape.cy + shape.rKm };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of shape.points) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export function areaKm2(shape) {
  if (shape.type === 'rect') return Math.abs((shape.x1 - shape.x0) * (shape.y1 - shape.y0));
  if (shape.type === 'circle') return Math.PI * shape.rKm * shape.rKm;
  if (shape.type === 'polygon') {
    const p = shape.points;
    let twice = 0;
    for (let a = 0, b = p.length - 1; a < p.length; b = a++) twice += p[b][0] * p[a][1] - p[a][0] * p[b][1];
    return Math.abs(twice) / 2;
  }
  return 0;
}

// Whether a closed outline crosses or touches itself: any two edges that are not neighbours meet.
// Such a polygon has an even-odd inside (maskFor) but a shoelace area that cancels, so it is refused
// when drawn (draw.js) and by the draw_region command.
function orient(a, b, c) {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}
function onSegment(a, b, c) {
  return Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
}
function segmentsMeet(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d)) || (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b));
}
export function selfIntersects(points) {
  const n = points.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;   // neighbouring edges share a vertex
      if (segmentsMeet(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return true;
    }
  }
  return false;
}

export function lengthKm(points) {
  let d = 0;
  for (let n = 1; n < points.length; n++) d += Math.hypot(points[n][0] - points[n - 1][0], points[n][1] - points[n - 1][1]);
  return d;
}

// Cells whose centre lies inside the shape. grid: { size, cellKm, halfKm }; cell k = j*size + i,
// i to the right, j downwards, centre (−halfKm + (i+½)·cellKm, halfKm − (j+½)·cellKm).
// rect is the tight inclusive cell range { i0, j0, i1, j1 } of the marked cells, null when count is 0.
export function maskFor(shape, grid) {
  const { size, cellKm, halfKm } = grid;
  const mask = new Uint8Array(size * size);
  const b = bbox(shape);
  const iFrom = Math.max(0, Math.ceil((b.x0 + halfKm) / cellKm - 0.5));
  const iTo = Math.min(size - 1, Math.floor((b.x1 + halfKm) / cellKm - 0.5));
  const jFrom = Math.max(0, Math.ceil((halfKm - b.y1) / cellKm - 0.5));
  const jTo = Math.min(size - 1, Math.floor((halfKm - b.y0) / cellKm - 0.5));
  let count = 0, i0 = size, j0 = size, i1 = -1, j1 = -1;
  for (let j = jFrom; j <= jTo; j++) {
    const y = halfKm - (j + 0.5) * cellKm;
    for (let i = iFrom; i <= iTo; i++) {
      if (!contains(shape, -halfKm + (i + 0.5) * cellKm, y)) continue;
      mask[j * size + i] = 1;
      count++;
      if (i < i0) i0 = i; if (i > i1) i1 = i;
      if (j < j0) j0 = j; if (j > j1) j1 = j;
    }
  }
  return { mask, rect: count ? { i0, j0, i1, j1 } : null, count };
}

// Points along a polyline every stepKm from the start, plus the end point; at least 2 points. When that
// would exceed maxPoints, the line is split into maxPoints − 1 equal steps instead.
export function sampleLine(points, stepKm = 0.5, maxPoints = 2000) {
  if (!points.length) return [];
  const total = lengthKm(points);
  let dists;
  const n = Math.floor(total / stepKm + 1e-9) + 1;
  if (total === 0) dists = [0, 0];
  else if (n + 1 > maxPoints) dists = Array.from({ length: maxPoints }, (_, k) => (k === maxPoints - 1 ? total : (total * k) / (maxPoints - 1)));
  else {
    dists = Array.from({ length: n }, (_, k) => k * stepKm);
    if (total - dists[n - 1] > 1e-9) dists.push(total);
  }
  const out = [];
  let seg = 1, segStart = 0;
  for (const d of dists) {
    while (seg < points.length - 1) {
      const len = Math.hypot(points[seg][0] - points[seg - 1][0], points[seg][1] - points[seg - 1][1]);
      if (segStart + len >= d) break;
      segStart += len;
      seg++;
    }
    if (points.length === 1) { out.push({ xKm: points[0][0], yKm: points[0][1], dKm: 0 }); continue; }
    const [xa, ya] = points[seg - 1], [xb, yb] = points[seg];
    const len = Math.hypot(xb - xa, yb - ya);
    const t = len > 0 ? Math.min(1, Math.max(0, (d - segStart) / len)) : 0;
    out.push({ xKm: xa + (xb - xa) * t, yKm: ya + (yb - ya) * t, dKm: d });
  }
  return out;
}
