// Route planning anywhere on the Moon (pure; browser and Node). The route planner (route-plan.js) works in the
// south polar stereographic plane of terrain.js (toXY / fromXY): node spacing, slopes and the stereographic
// scale correction all follow from it. A local frame turns the sphere so that a chosen centre sits at the south
// pole; in that frame the same stereographic formulas hold exactly (an oblique stereographic projection tangent
// at the centre), so the planner runs unchanged on a DEM sampled from the global LOLA terrain around the centre.
// Its results are turned back into lat/lon (and so into the Map's polar km, which cover the whole sphere bar the
// north pole).
import { toXY, fromXY } from './terrain.js';

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const unit = (lat, lon) => { const c = Math.cos(lat * RAD); return [c * Math.cos(lon * RAD), c * Math.sin(lon * RAD), Math.sin(lat * RAD)]; };
const ll = (v) => { const r = Math.hypot(v[0], v[1], v[2]); let lon = Math.atan2(v[1], v[0]) * DEG; if (lon < 0) lon += 360; return { latDeg: Math.asin(Math.max(-1, Math.min(1, v[2] / r))) * DEG, lonDeg: lon }; };

// The rotation (3×3, row-major) that takes the centre to the south pole (0, 0, −1), by Rodrigues' formula.
export function createLocalFrame(latDeg, lonDeg) {
  const c = unit(latDeg, lonDeg), s = [0, 0, -1];
  let ax = [c[1] * s[2] - c[2] * s[1], c[2] * s[0] - c[0] * s[2], c[0] * s[1] - c[1] * s[0]];
  const sin = Math.hypot(...ax), cos = c[0] * s[0] + c[1] * s[1] + c[2] * s[2];
  let M;
  if (sin < 1e-12) M = cos > 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, -1, 0, 0, 0, -1];   // already the south pole, or the north pole (turn about x)
  else {
    ax = ax.map((v) => v / sin);
    const [x, y, z] = ax, t = 1 - cos;
    M = [cos + x * x * t, x * y * t - z * sin, x * z * t + y * sin,
      y * x * t + z * sin, cos + y * y * t, y * z * t - x * sin,
      z * x * t - y * sin, z * y * t + x * sin, cos + z * z * t];
  }
  const mul = (v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
  const mulT = (v) => [M[0] * v[0] + M[3] * v[1] + M[6] * v[2], M[1] * v[0] + M[4] * v[1] + M[7] * v[2], M[2] * v[0] + M[5] * v[1] + M[8] * v[2]];
  return {
    centre: { latDeg, lonDeg },
    toLocal(la, lo) { const p = ll(mul(unit(la, lo))); return toXY(p.latDeg, p.lonDeg); },
    fromLocal(x, y) { const p = fromXY(x, y); return ll(mulT(unit(p.latDeg, p.lonDeg))); },
  };
}

// The centre for a route: the mean direction of its points (lat/lon).
export function centreOf(points) {
  const v = [0, 0, 0];
  for (const p of points) { const u = unit(p.latDeg, p.lonDeg); v[0] += u[0]; v[1] += u[1]; v[2] += u[2]; }
  return ll(v);
}

// A DEM level for route-plan.js in a local frame: the grid of `kmPerPixel` over ±halfKm, heights from
// heightAt(lat, lon) (metres, NaN or null where unknown).
export function localDem(frame, { halfKm, kmPerPixel, heightAt }) {
  const size = Math.round((2 * halfKm) / kmPerPixel);
  return {
    size, kmPerPixel, halfKm: (size * kmPerPixel) / 2,
    heightAtXY(x, y) {
      if (Math.abs(x) > halfKm || Math.abs(y) > halfKm) return null;
      const p = frame.fromLocal(x, y);
      const h = heightAt(p.latDeg, p.lonDeg);
      return Number.isFinite(h) ? h : null;
    },
  };
}

// A plan from route-plan.js with every map-km coordinate passed through f([x, y]) → [x', y'] (local km to the Map's
// polar km). Route profiles keep their ground km and grades (they do not depend on the projection).
export function mapPlan(plan, f) {
  if (!plan) return plan;
  const pts = (a) => (Array.isArray(a) ? a.map((p) => f(p)) : a);
  const out = { ...plan, waypoints: pts(plan.waypoints) };
  if (plan.traps?.cells) out.traps = { ...plan.traps, cells: pts(plan.traps.cells) };
  out.routes = (plan.routes ?? []).map((r) => {
    const q = { ...r, points: pts(r.points) };
    if (r.oneWay) q.oneWay = r.oneWay.map((seg) => seg.map((p) => f(p)));
    if (r.profile?.x) {
      const n = r.profile.x.length, X = new Float32Array(n), Y = new Float32Array(n);
      for (let i = 0; i < n; i++) { const [a, b] = f([r.profile.x[i], r.profile.y[i]]); X[i] = a; Y[i] = b; }
      q.profile = { ...r.profile, x: X, y: Y };
    }
    return q;
  });
  return out;
}
