// The sky dial's geometry (phase 5, S): pure functions, no DOM. The dial sits on the selected point of the
// polar stereographic map: azimuth goes round the ring in the map's true directions, the radius grows with
// elevation from −10° (inner edge) to +18° (outer edge), with rings at 0° and 10°.
//
// Orientation (checked against geometry.js and terrain.js in tests/skydial.test.mjs): on this map 0°E is up
// and 90°E right (terrain.toXY, screen y down), so local north at longitude λ points away from the pole at
// λ degrees clockwise from screen-up, and east lies 90° clockwise from north: the map is an unmirrored view
// from above the south pole, so azimuth (from north, increasing east) runs clockwise on screen.
// Screen angles here are degrees clockwise from screen-up; points are [x, y] in px from the dial centre,
// y down.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export const SYNODIC_DAYS = 29.530589;
const DAY_MS = 86400e3;

// The default dial: 300 px across including the N/E/S/W letters.
export const DIAL = Object.freeze({
  size: 300,
  elMin: -10, elMax: 18,
  rMin: 48, rMax: 134,       // radius of elMin and elMax
  rings: [0, 10],
  rLabel: 146,               // N, E, S, W
});

const norm360 = (deg) => {
  const v = ((deg % 360) + 360) % 360;
  return v === 360 ? 0 : v + 0;
};

// Where local north points on screen at a site, in degrees clockwise from screen-up. On this map that is
// the site's east longitude itself; null at the pole, where every direction is north.
export function northOnScreenDeg(site) {
  if (!site || !Number.isFinite(site.lonDeg)) return null;
  if (Number.isFinite(site.latDeg) && Math.abs(site.latDeg) > 89.9999) return null;
  return norm360(site.lonDeg);
}

// The same from a map-plane position in km (pole at the origin, 0°E = +y, 90°E = +x): the direction away
// from the pole.
export function northOnScreenFromXY(xKm, yKm) {
  if (Math.hypot(xKm, yKm) < 1e-9) return null;
  return norm360(Math.atan2(xKm, yKm) * DEG);
}

// Screen angle of an azimuth seen from a site whose north is at northDeg.
export function screenAngleDeg(azDeg, northDeg) {
  return norm360((northDeg ?? 0) + azDeg);
}

// Elevation → radius, linear, clamped to the dial.
export function radiusForEl(elDeg, geom = DIAL) {
  const e = Math.max(geom.elMin, Math.min(geom.elMax, elDeg));
  return geom.rMin + ((e - geom.elMin) * (geom.rMax - geom.rMin)) / (geom.elMax - geom.elMin);
}

export function elForRadius(r, geom = DIAL) {
  return geom.elMin + ((r - geom.rMin) * (geom.elMax - geom.elMin)) / (geom.rMax - geom.rMin);
}

// Azimuth and elevation → [x, y] px from the centre. Elevations beyond the dial sit on its edge.
export function dialPoint(azDeg, elDeg, northDeg, geom = DIAL) {
  const a = ((northDeg ?? 0) + azDeg) * RAD;
  const r = radiusForEl(elDeg, geom);
  return [r * Math.sin(a), -r * Math.cos(a)];
}

// A point at radius r in a screen direction (no elevation scale), for the letters and the ticks.
export function polarPoint(screenDeg, r) {
  const a = screenDeg * RAD;
  return [r * Math.sin(a), -r * Math.cos(a)];
}

// The skyline as a function of azimuth. Accepts what terrain.skylineFor returns (a function carrying
// .profile), a bare profile (array of elevations, index i = azimuth i·360/n), a number, or null (flat 0°).
export function skylineFn(skyline) {
  if (typeof skyline === 'function') return skyline;
  if (typeof skyline === 'number') return () => skyline;
  if (skyline && typeof skyline.length === 'number' && skyline.length > 0) {
    const p = skyline, n = p.length;
    return (azDeg) => {
      if (azDeg === null || azDeg === undefined) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += p[i];
        return sum / n;
      }
      const x = (norm360(azDeg) / 360) * n;
      const i0 = Math.floor(x) % n;
      const f = x - Math.floor(x);
      return p[i0] + (p[(i0 + 1) % n] - p[i0]) * f;
    };
  }
  return () => 0;
}

// The terrain profile to draw: the skyline's own samples when it has them, else `samples` evenly spaced.
export function skylineProfile(skyline, samples = 360) {
  const own = typeof skyline === 'function' ? skyline.profile : skyline;
  if (own && typeof own.length === 'number' && own.length > 0 && typeof own !== 'string') return Array.from(own);
  const f = skylineFn(skyline);
  return Array.from({ length: samples }, (_, i) => f((i * 360) / samples));
}

// The skyline band as one closed SVG path: the terrain edge all the way round, then back round the inner
// edge (−10°), filled with the even-odd rule so the centre stays open.
export function skylinePath(skyline, northDeg, geom = DIAL) {
  const p = skylineProfile(skyline);
  const n = p.length;
  const fmt = ([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`;
  const edge = p.map((el, i) => dialPoint((i * 360) / n, el, northDeg, geom));
  const outline = `M${edge.map(fmt).join('L')}Z`;
  const r = geom.rMin;
  const hole = `M${r.toFixed(1)} 0A${r} ${r} 0 1 0 ${(-r).toFixed(1)} 0A${r} ${r} 0 1 0 ${r.toFixed(1)} 0Z`;
  return { band: outline + hole, edge: outline };
}

// Is a body clear of the terrain? Behind it when its elevation is at or below the skyline in its
// direction (the same rule as the Sky at the site panorama). clearanceDeg is elevation − skyline.
export function skyStatus(pos, skyline) {
  if (!pos || !Number.isFinite(pos.elDeg)) return { visible: false, above: false, clearanceDeg: NaN, skylineDeg: NaN };
  const sk = skylineFn(skyline)(pos.azDeg ?? null);
  const clearanceDeg = pos.elDeg - sk;
  return { visible: pos.azDeg !== null && pos.azDeg !== undefined, above: clearanceDeg > 0, clearanceDeg, skylineDeg: sk };
}

// A track is { t: ms[], az: deg[] (null allowed), el: deg[] }. sampleSeries (windows.js) gives both
// bodies at once; this splits it.
export function tracksFromSeries(series) {
  if (!series) return { sunTrack: null, earthTrack: null };
  return {
    sunTrack: { t: series.t, az: series.sunAz, el: series.sunEl },
    earthTrack: { t: series.t, az: series.earthAz, el: series.earthEl },
  };
}

// The time span to sample the tracks over: one synodic month (a full turn of the Sun round the horizon
// and a full libration loop of the Earth) centred on the stay, or on `nowMs` without a stay; the whole
// stay when it is longer. Kept inside [eph.startMs, eph.endMs].
export function trackSpan({ stayRange = null, nowMs = NaN, startMs = -Infinity, endMs = Infinity, days = SYNODIC_DAYS } = {}) {
  const span = days * DAY_MS;
  let a, b;
  if (stayRange && Number.isFinite(stayRange[0]) && Number.isFinite(stayRange[1])) {
    const len = stayRange[1] - stayRange[0];
    const pad = Math.max(0, (span - len) / 2);
    a = stayRange[0] - pad; b = stayRange[1] + pad;
  } else if (Number.isFinite(nowMs)) {
    a = nowMs - span / 2; b = nowMs + span / 2;
  } else {
    return null;
  }
  if (a < startMs) { b = Math.min(endMs, b + (startMs - a)); a = startMs; }
  if (b > endMs) { a = Math.max(startMs, a - (b - endMs)); b = endMs; }
  return [a, b];
}

// Breaks a track into drawable runs: at a missing azimuth, at a jump of more than maxJumpDeg between
// samples (a pass near the zenith, as in the panorama) and, with linear: true (an azimuth-across chart),
// where it crosses 0°/360°. On the round dial 359° → 1° is a short step, so it stays one run.
// With stayRange, each run is cut where it enters or leaves the stay; the cut point is interpolated in
// time and shared by both sides, so the solid and the faint parts meet. Returns [{ inStay, points:
// [{ t, az, el }] }] in time order.
export function trackSegments(track, { stayRange = null, maxJumpDeg = 45, linear = false } = {}) {
  if (!track || !track.az || track.az.length === 0) return [];
  const n = track.az.length;
  const t = track.t ?? Array.from({ length: n }, (_, i) => i);
  const runs = [];
  let cur = [];
  const flush = () => { if (cur.length > 1) runs.push(cur); cur = []; };   // a lone sample draws nothing
  for (let i = 0; i < n; i++) {
    const az = track.az[i], el = track.el[i];
    if (az === null || az === undefined || !Number.isFinite(az) || !Number.isFinite(el)) { flush(); continue; }
    const prev = cur[cur.length - 1];
    if (prev) {
      const d = Math.abs(((az - prev.az + 540) % 360) - 180);
      if (d > maxJumpDeg || (linear && Math.abs(az - prev.az) > 180)) flush();
    }
    cur.push({ t: t[i], az, el });
  }
  flush();
  const inside = (ms) => !!stayRange && ms >= stayRange[0] && ms <= stayRange[1];
  const out = [];
  for (const run of runs) {
    if (!stayRange) { out.push({ inStay: false, points: run }); continue; }
    let seg = { inStay: inside(run[0].t), points: [run[0]] };
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1], b = run[i];
      const ib = inside(b.t);
      if (ib === seg.inStay) { seg.points.push(b); continue; }
      const edge = Math.min(b.t, Math.max(a.t, ib ? stayRange[0] : stayRange[1]));
      const f = b.t === a.t ? 1 : (edge - a.t) / (b.t - a.t);
      const dAz = ((b.az - a.az + 540) % 360) - 180;
      const cut = f <= 0 ? a : f >= 1 ? b : { t: edge, az: norm360(a.az + dAz * f), el: a.el + (b.el - a.el) * f };
      if (cut !== a) seg.points.push(cut);
      if (seg.points.length > 1) out.push(seg);
      seg = { inStay: ib, points: cut === b ? [b] : [cut, b] };
    }
    if (seg.points.length > 1) out.push(seg);
  }
  return out;
}

// SVG path data for a run on the dial.
export function dialPath(points, northDeg, geom = DIAL) {
  return points.map((p, i) => {
    const [x, y] = dialPoint(p.az, p.el, northDeg, geom);
    return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join('');
}

// A short readout for a body: "az 208.4°, el 1.7°, 0.9° above skyline".
export function describeBody(pos, skyline) {
  const st = skyStatus(pos, skyline);
  const f = (v) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}°`;
  if (!st.visible && !Number.isFinite(pos?.elDeg)) return 'no position';
  const az = pos.azDeg === null || pos.azDeg === undefined ? 'overhead' : `az ${Math.abs(pos.azDeg).toFixed(1)}°`;
  const rel = st.above ? `${f(st.clearanceDeg)} above skyline` : `${Math.abs(st.clearanceDeg).toFixed(1)}° below skyline`;
  return `${az}, el ${f(pos.elDeg)}, ${rel}`;
}
