// Phase 5 (docs/PHASES.md): what the rover does when something goes wrong on a planned route.
//
// Safe havens: from checkpoints along the route (every everyKm, and where the battery would run out), the
// closest place by drive time that is lit on arrival and for the next lookaheadH hours, has Earth in view on
// arrival, is gentle enough to park on, and can be reached with the battery left at the checkpoint. Drive
// times and energy come from route-plan.js reachFrom (the same directional limits as the planner).
//
// Comms-denied navigation: the bearing to the haven and where the Sun and Earth sit relative to it, so the
// rover (or an operator reading a camera image) can hold the heading without a link; dead-reckoning error
// grows with the distance driven.
//
// findHavens({ dem, mob, power, profile, drive, sky, opts }) → { checkpoints: [Checkpoint], radiusKm, … }
//   Checkpoint = { km, x, y, tMs, socWh, haven: Haven | null, why (when no haven) }
//   Haven = { x, y, hours, wh, distKm, bearingDeg, nav: { sunAzDeg, sunElDeg, sunRelDeg, earthAzDeg,
//             earthElDeg, earthRelDeg, drift95M, sunVisible, earthVisible } }
import { reachFrom } from './route-plan.js';
import { cleanPower } from './route-energy.js';
import { fromXY } from './terrain.js';

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
export const HAVEN_DEFAULTS = Object.freeze({ everyKm: 2, radiusKm: 10, lookaheadH: 24, stepH: 6, parkSlopeDeg: 10, driftShare: 0.02 });

// Initial great-circle bearing (deg from north, east-positive) from one map point to another.
export function bearing(ax, ay, bx, by) {
  const a = fromXY(ax, ay), b = fromXY(bx, by);
  const p1 = a.latDeg * RAD, p2 = b.latDeg * RAD, dl = (b.lonDeg - a.lonDeg) * RAD;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * DEG) + 360) % 360;
}

// Signed angle from the heading to a body's azimuth: + to the right, − to the left (deg, −180…180).
export const relAngle = (azDeg, headingDeg) => ((azDeg - headingDeg + 540) % 360) - 180;

// Is a place a haven if the rover gets there at tMs? (sky as route-energy.js skyFromGrid; cache optional)
export function isHaven(sky, x, y, tMs, { lookaheadH, stepH }, cache = null) {
  const at = (t) => {
    if (!cache) return sky(x, y, t);
    const key = `${Math.round(x * 2)},${Math.round(y * 2)},${Math.round(t / 3600e3)}`;
    if (!cache.has(key)) cache.set(key, sky(x, y, t));
    return cache.get(key);
  };
  const now = at(tMs);
  if (!now || !(now.sunDeg > 0) || !(now.earthDeg > 0)) return false;
  for (let h = stepH; h <= lookaheadH; h += stepH) { const q = at(tMs + h * 3600e3); if (!q || !(q.sunDeg > 0)) return false; }
  return true;
}

// Checkpoints along a profile: every everyKm from the start, plus the end and, if the battery runs out, the
// last sample before it. Uses the drive's per-sample times and battery.
export function checkpoints(profile, drive, everyKm) {
  const per = drive?.perSample, n = profile.km.length, out = [];
  let km = 0, next = 0;
  for (let i = 0; i < n; i++) {
    const reached = per && Number.isFinite(per.tMs[i]);
    const last = i === n - 1 || (per && !Number.isFinite(per.tMs[i + 1]));
    if (reached && (km >= next || last)) {
      out.push({ i, km, x: profile.x[i], y: profile.y[i], tMs: per.tMs[i], socWh: per.socWh[i] });
      next = km + everyKm;
    }
    km += profile.km[i];
    if (per && !reached) break;
  }
  return out;
}

export function findHavens({ dem, mob, power: p0 = {}, profile, drive, sky, opts = {} }) {
  const o = { ...HAVEN_DEFAULTS, ...opts }, power = cleanPower(p0);
  const cache = new Map();
  const cps = checkpoints(profile, drive, o.everyKm);
  for (const cp of cps) {
    const R = reachFrom(dem, [cp.x, cp.y], { mob, radiusKm: o.radiusKm, power });
    if (!R || R.start < 0) { cp.haven = null; cp.why = 'off the terrain grid'; continue; }
    // candidates by drive time, nearest first
    const order = [];
    for (let n = 0; n < R.hours.length; n++) if (Number.isFinite(R.hours[n]) && R.slope[n] <= o.parkSlopeDeg) order.push(n);
    order.sort((a, b) => R.hours[a] - R.hours[b]);
    let best = null, tooFar = false;
    for (const n of order) {
      if (R.wh[n] > cp.socWh) { tooFar = true; continue; }   // not enough battery to get there
      const [x, y] = R.xy(n), arrive = cp.tMs + R.hours[n] * 3600e3;
      if (!isHaven(sky, x, y, arrive, o, cache)) continue;
      best = { n, x, y, hours: R.hours[n], wh: R.wh[n], arrive };
      break;
    }
    if (!best) { cp.haven = null; cp.why = tooFar ? `none within reach of the ${Math.round(cp.socWh)} Wh left` : `none within ${o.radiusKm} km`; continue; }
    const brg = bearing(cp.x, cp.y, best.x, best.y);
    const s = sky(cp.x, cp.y, cp.tMs) ?? {};
    const distKm = Math.hypot(best.x - cp.x, best.y - cp.y);
    const driveKm = best.hours * mob.speedKmh;   // an upper bound on the km driven (slopes only slow it)
    cp.haven = {
      x: best.x, y: best.y, hours: best.hours, wh: best.wh, distKm, bearingDeg: brg, arriveMs: best.arrive,
      nav: {
        sunAzDeg: s.azDeg ?? null, sunElDeg: s.elDeg ?? null, sunRelDeg: Number.isFinite(s.azDeg) ? relAngle(s.azDeg, brg) : null,
        earthAzDeg: s.earthAzDeg ?? null, earthElDeg: s.earthElDeg ?? null, earthRelDeg: Number.isFinite(s.earthAzDeg) ? relAngle(s.earthAzDeg, brg) : null,
        drift95M: o.driftShare * driveKm * 1000,
        sunVisible: s.sunDeg > 0, earthVisible: s.earthDeg > 0,   // above the local skyline at the checkpoint
      },
    };
  }
  const found = cps.filter((c) => c.haven);
  const worst = found.length ? found.reduce((a, b) => (b.haven.hours > a.haven.hours ? b : a)) : null;
  return { checkpoints: cps, radiusKm: o.radiusKm, lookaheadH: o.lookaheadH, found: found.length, worst, missing: cps.filter((c) => !c.haven) };
}
