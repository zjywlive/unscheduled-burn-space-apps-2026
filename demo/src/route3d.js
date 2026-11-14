// Phase 6 (docs/PHASES.md): a planned route and its simulated drive, handed from the navigator to the 3D
// globe (demo/globe.html#route=1) through localStorage, and the rover's state at any time on it. Pure; no
// DOM, no three.js (globe-route.js draws it).
//
// Payload v1 = {
//   v: 1, label, routeId, lengthKm, departMs, arriveMs | null, reserve (0–1),
//   pts: [[latDeg, lonDeg, km, tMs | null, soc (0–1) | null, flags], …]   flags: 1 lit, 2 Earth in view,
//        4 station link, 8 one-way stretch (going down more steeply than the climb limit)
//   stops: [{ latDeg, lonDeg, km, fromMs, toMs }], havens: [{ latDeg, lonDeg }], emptyAt: { latDeg, lonDeg, km, tMs } | null
// }
import { fromXY, toXY } from './terrain.js';

export const ROUTE3D_KEY = 'lsn-route3d';
export const FLAGS = Object.freeze({ lit: 1, earth: 2, station: 4, oneWay: 8 });

// The payload from a planned route (route-plan.js), its drive (route-energy.js), station links (comms.js),
// havens (contingency.js). Keeps at most maxPts points (every k-th sample, plus the last one reached).
export function buildPayload({ route, drive = null, links = null, havens = null, power = null, maxPts = 400 }) {
  const p = route.profile, n = p.km.length, per = drive?.perSample ?? null;
  const cap = power?.batteryWh ?? null;
  const onWay = new Uint8Array(n);
  if (route.oneWay?.length) {
    // a sample is one-way when it lies on a one-way segment (segments are straight runs along the line)
    for (let i = 0; i < n; i++) for (const [[ax, ay], [bx, by]] of route.oneWay) {
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? ((p.x[i] - ax) * dx + (p.y[i] - ay) * dy) / L2 : 0;
      if (t >= -0.01 && t <= 1.01 && Math.hypot(p.x[i] - ax - t * dx, p.y[i] - ay - t * dy) < 0.05) { onWay[i] = 1; break; }
    }
  }
  const step = Math.max(1, Math.ceil(n / maxPts));
  const pts = [];
  let km = 0;
  for (let i = 0; i < n; i++) {
    const reached = per ? Number.isFinite(per.tMs[i]) : true;
    if (i % step === 0 || i === n - 1 || (per && reached && !Number.isFinite(per.tMs[i + 1] ?? NaN))) {
      const { latDeg, lonDeg } = fromXY(p.x[i], p.y[i]);
      const flags = (per?.lit[i] ? FLAGS.lit : 0) | (per?.earth[i] ? FLAGS.earth : 0) | (links?.ok[i] ? FLAGS.station : 0) | (onWay[i] ? FLAGS.oneWay : 0);
      pts.push([+latDeg.toFixed(6), +lonDeg.toFixed(6), +km.toFixed(4), reached && per ? Math.round(per.tMs[i]) : null, per && cap && reached ? +(per.socWh[i] / cap).toFixed(4) : null, flags]);
    }
    km += p.km[i];
  }
  const ll = (x, y) => { const q = fromXY(x, y); return { latDeg: +q.latDeg.toFixed(6), lonDeg: +q.lonDeg.toFixed(6) }; };
  const seen = new Set(), hv = [];
  for (const c of havens?.checkpoints ?? []) {
    if (!c.haven) continue;
    const k = `${c.haven.x.toFixed(2)},${c.haven.y.toFixed(2)}`;
    if (!seen.has(k)) { seen.add(k); hv.push(ll(c.haven.x, c.haven.y)); }
  }
  return {
    v: 1, label: route.label, routeId: route.id, lengthKm: route.lengthKm,
    departMs: drive?.departMs ?? null, arriveMs: drive?.ok ? drive.arriveMs : null, reserve: power?.reserve ?? null,
    pts,
    stops: (drive?.stops ?? []).map((st) => ({ ...ll(st.x, st.y), km: st.km, fromMs: st.fromMs, toMs: st.toMs })),
    havens: hv,
    emptyAt: drive?.emptyAt ? { ...ll(drive.emptyAt.x, drive.emptyAt.y), km: drive.emptyAt.km, tMs: drive.emptyAt.tMs } : null,
  };
}

// A payload read back (from JSON); null when it is not one.
export function parsePayload(text) {
  try {
    const p = typeof text === 'string' ? JSON.parse(text) : text;
    if (!p || p.v !== 1 || !Array.isArray(p.pts) || p.pts.length < 2) return null;
    if (!p.pts.every((q) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]) && Number.isFinite(q[2]))) return null;
    return p;
  } catch { return null; }
}

// The span of the drive in time: [departMs, end], end = arrival, or when the battery ran out, or the last time.
export function timeSpan(p) {
  const ts = p.pts.map((q) => q[3]).filter(Number.isFinite);
  if (!ts.length || !Number.isFinite(p.departMs)) return null;
  const end = p.arriveMs ?? p.emptyAt?.tMs ?? ts[ts.length - 1];
  return [p.departMs, Math.max(end, ts[ts.length - 1])];
}

// The rover at time tMs: { latDeg, lonDeg, km, soc, flags, state: 'ready' | 'driving' | 'parked' | 'arrived'
// | 'empty', i (the point before it) }. Positions are interpolated linearly in lat/lon (points are ≤ ~150 m apart).
export function roverAt(p, tMs) {
  const pts = p.pts, timed = pts.filter((q) => Number.isFinite(q[3]));
  const at = (q, state, i) => ({ latDeg: q[0], lonDeg: q[1], km: q[2], soc: q[4], flags: q[5], state, i });
  if (!timed.length) return at(pts[0], 'ready', 0);
  if (!(tMs > (p.departMs ?? timed[0][3]))) return at(pts[0], 'ready', 0);
  for (const st of p.stops ?? []) if (tMs >= st.fromMs && tMs < st.toMs) {
    const i = Math.max(0, pts.findIndex((q) => q[2] >= st.km) - 1);
    return { latDeg: st.latDeg, lonDeg: st.lonDeg, km: st.km, soc: pts[i]?.[4] ?? null, flags: pts[i]?.[5] ?? 0, state: 'parked', i };
  }
  const last = timed[timed.length - 1];
  if (tMs >= last[3]) {
    const i = pts.indexOf(last);
    if (p.emptyAt) return { ...at(last, 'empty', i), latDeg: p.emptyAt.latDeg, lonDeg: p.emptyAt.lonDeg, km: p.emptyAt.km };
    return at(pts[pts.length - 1], p.arriveMs ? 'arrived' : 'driving', pts.length - 1);
  }
  // first timed point → depart: interpolate from the start
  let i = 0;
  while (i + 1 < pts.length && !(Number.isFinite(pts[i + 1][3]) && pts[i + 1][3] > tMs)) i++;
  const a = pts[i], b = pts[i + 1];
  const ta = Number.isFinite(a[3]) ? a[3] : p.departMs, tb = b[3];
  // a stop between a and b: the rover waits at the stop, so drive the remaining time only
  const stop = (p.stops ?? []).find((st) => st.km >= a[2] - 1e-6 && st.km <= b[2] + 1e-6 && st.toMs <= tb);
  const t0 = stop && tMs >= stop.toMs ? stop.toMs : ta;
  const f = tb > t0 ? Math.min(1, Math.max(0, (tMs - t0) / (tb - t0))) : 1;
  let dl = b[1] - a[1];
  if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
  return {
    latDeg: a[0] + (b[0] - a[0]) * f, lonDeg: (a[1] + dl * f + 360) % 360, km: a[2] + (b[2] - a[2]) * f,
    soc: a[4] !== null && b[4] !== null ? a[4] + (b[4] - a[4]) * f : a[4] ?? b[4], flags: f < 0.5 ? a[5] : b[5], state: 'driving', i,
  };
}

// A camera that frames the whole route: centre and distance (km) for globe-view.js flyTo.
export function frameRoute(p) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const q of p.pts) { const [x, y] = toXY(q[0], q[1]); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const c = fromXY((x0 + x1) / 2, (y0 + y1) / 2);
  const extent = Math.max(x1 - x0, y1 - y0, 2);
  return { lat: c.latDeg, lon: c.lonDeg, dist: extent * 1.6, tilt: 45, heading: 0 };
}
