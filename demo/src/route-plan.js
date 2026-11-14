// Route planning (task book phase 4 §6 R): three candidate routes through a start, any waypoints and an
// end, in order, on the 240 m terrain grid. Pure computation, no DOM; runs in slices so the page stays
// responsive, and stops when its AbortSignal fires.
//
// planRoutes({ points, dem, sunAt, isPsr, maxSlopeDeg }, { onProgress, signal, sliceMs, yieldFn }) → Promise<Plan>
//   points       [[xKm, yKm], …] (map km, as the Route tool gives them) or [{ latDeg, lonDeg }, …]; 2–8 points
//   dem          a plain DEM level from terrain.js createDem (the dem_240m level: { size, kmPerPixel, halfKm,
//                heightAtXY, grid? }). Graph nodes are its pixel centres, so the slope baseline is its pixel size.
//   sunAt        (xKm, yKm) → share of the stay sunlit 0–1, or NaN where unknown; optional (see sunFromJobs)
//   isPsr        (xKm, yKm) → true inside the official PSR (psr.js); optional
//   maxSlopeDeg  slope limit in degrees (an assumption, default 15); with mobility it is the climb limit
//   mobility     optional (phase 2, docs/PHASES.md): { descentDeg, crossDeg, speedKmh } (the climb limit is
//                maxSlopeDeg). Moves are then checked by direction: the grade along the move against the climb
//                and descent limits, the slope across it against the cross-slope limit. Adds to the plan
//                `returnable`, `traps` and per route the directional figures (see MOBILITY_DEFAULTS, below).
//   onProgress(fraction 0–1), signal (AbortSignal: rejects with an AbortError), sliceMs (default 12),
//   yieldFn() → Promise (default: setImmediate in Node, a MessageChannel hop in the browser)
//
// Plan = {
//   ok,                   true when the three candidates exist (sunny is unavailable without sunAt)
//   error,                a sentence when the input is unusable (too few points, off the terrain, leg too long)
//   blocked,              null, or { limitDeg, neededDeg, passesAtDeg, leg } when no route keeps under the limit:
//                         passesAtDeg is the whole degree at which the search corridor first lets a route through
//   routes: [{ id: 'short' | 'flat' | 'sunny', label, points: [[x, y], …] (simplified for drawing),
//              lengthKm, maxSlopeDeg, meanSlopeDeg, sunShare (0–1 | null), sunKnown (share of length with a
//              Sun figure), psrKm (number | null), sameAs (id of an earlier candidate it repeats | null),
//              unavailable (a sentence | null), takenFrom (fix R1: the search whose route this label shows,
//              when it is not its own; absent otherwise) }],
//   limitDeg, baselineKm, waypoints: [[x, y], …], nodes (graph nodes searched), ms
//   with mobility, also: mobility (the limits used), returnable (true when the rover could drive from the end
//   back to the start within the limits, by any way), traps: { km2, cellKm, cells: [[x, y], …] } (ground in the
//   search corridors the rover can drive into from the start but from which it can reach neither the end nor
//   the start: dips and valleys it would not climb out of; patches under TRAP_MIN_NODES grid nodes are left out), and per route climbMaxDeg, descentMaxDeg,
//   crossMaxDeg, oneWayKm, oneWay: [[[x, y], [x, y]], …] (stretches descending more steeply than the climb
//   limit: the rover could not come back up them), hours (drive time at speedKmh, slower on slopes)
// }
// Statistics come from the unsimplified path, sampled every quarter node spacing.
import { toXY } from './terrain.js';

const R = 1737.4;
const DEG = 180 / Math.PI;

export const DEFAULT_MAX_SLOPE = 15;
// Phase 2 rover limits. All are assumptions the user can change, not data: a slow solar rover of the VIPER
// class (descending steeper than it climbs, a lower limit across a slope against tipping and sliding).
export const MOBILITY_DEFAULTS = Object.freeze({ descentDeg: 20, crossDeg: 12, speedKmh: 0.8 });
// The limits of a plan, or null without mobility. climbDeg is the planner's maxSlopeDeg.
export function cleanMobility(m, climbDeg) {
  if (!m) return null;
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return {
    climbDeg: Number(climbDeg),
    descentDeg: num(m.descentDeg, 1, 45, MOBILITY_DEFAULTS.descentDeg),
    crossDeg: num(m.crossDeg, 1, 45, MOBILITY_DEFAULTS.crossDeg),
    speedKmh: num(m.speedKmh, 0.01, 50, MOBILITY_DEFAULTS.speedKmh),
  };
}
// Drive speed factor on a grade (tan): slower uphill (half speed at the climb limit), a little slower
// downhill (70 % at the descent limit). An assumption, like the limits.
export function speedFactor(pitchTan, mob) {
  const deg = Math.atan(pitchTan) * DEG;
  return deg >= 0 ? Math.max(0.3, 1 - 0.5 * deg / mob.climbDeg) : Math.max(0.3, 1 - 0.3 * -deg / mob.descentDeg);
}
export const MIN_POINTS = 2;
export const MAX_POINTS = 8;
export const MAX_LEG_KM = 160;
export const CANDIDATES = Object.freeze([
  Object.freeze({ id: 'short', label: 'Shortest' }),
  Object.freeze({ id: 'flat', label: 'Flattest' }),
  Object.freeze({ id: 'sunny', label: 'Sunniest' }),
]);
const SNAP_KM = 0.5;           // a waypoint may start from any passable node this close
const MAX_NODES = 1_500_000;   // per leg corridor

// Corridor margin around a leg's bounding box: half the leg length, 8–40 km; doubled once when the
// first corridor blocks the route.
export const corridorPadKm = (legKm) => Math.max(8, Math.min(40, 0.5 * legKm));

// Per-node cost factors (cost of a km of ground). All are ≥ 1, so straight-line ground distance is an
// admissible A* heuristic for each.
//   short: length, with a 2 % nudge towards gentler ground to break ties between equal lengths
//   flat:  length × (1 + (slope / 4°)²): 2× at 4°, 5× at 8°, 15× at 15°, so a route takes a long
//          detour to lose a steep stretch; the slope cap is also tightened to the corridor's minimax slope + 1°.
//          The slope in this factor is the 3 × 3-node mean, so the route does not weave after single pixels.
//   sunny: length × (1 + 3 × (1 − sunlit share)) plus a mild slope term; unknown Sun counts as half lit.
//          The Sun share in this factor is the mean over 9 × 9 nodes (≈ 2 km), so the route does not trace
//          the edges of the 1–2 km heat cells.
//          (fix R1) The weight 3 alone often found the shortest path again where the whole corridor is
//          dark, so the sunny search runs once per weight in SUNNY_WEIGHTS and keeps the route with the
//          highest sunlit share; sunny(s, sun, lim, w) takes the weight as a fourth argument (default 3).
// Every candidate keeps to the slope cap on the raw per-node slope; the smoothing only shapes the cost.
// Labels are then kept true (see pickByMetric): each label shows the best of the searched routes by its
// own figure, so Shortest is never longer, Flattest never steeper on average and Sunniest never less
// sunlit than another candidate.
export const SUNNY_WEIGHTS = Object.freeze([3, 10, 30]);
export const COSTS = Object.freeze({
  short: (s, sun, lim) => 1 + 0.02 * (s / lim),
  flat: (s) => 1 + (s / 4) * (s / 4),
  sunny: (s, sun, lim, w = 3) => 1 + w * (1 - (sun === sun ? sun : 0.5)) + 0.3 * (s / lim) * (s / lim),
});
// The last sunny search aims at the share itself: ground at least as lit as the best share found on the
// leg so far costs only its length, darker ground 1 + 30 × the shortfall, so a detour through lit ground
// is cheap and one through dark ground is not (a capped form of maximising lit km / km).
export const sunnyTargetCost = (s, sun, lim, target) => 1 + 30 * Math.max(0, target - (sun === sun ? sun : 0.5)) + 0.3 * (s / lim) * (s / lim);
const COST_BLUR = { short: 0, flat: 1, sunny: 4 };   // box radius in nodes for the factor's inputs
const FLAT_MARGIN_DEG = 1;

function abortError() {
  const e = new Error('Route planning cancelled');
  e.name = 'AbortError';
  return e;
}

function defaultYield() {
  if (typeof setImmediate === 'function') return new Promise((ok) => setImmediate(ok));
  if (typeof MessageChannel === 'function') {
    return new Promise((ok) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); ok(); }; ch.port2.postMessage(0); });
  }
  return new Promise((ok) => setTimeout(ok, 0));
}

// [x, y] map km from [x, y], { xKm, yKm } or { latDeg, lonDeg }; null if unusable.
export function toPoint(p) {
  if (Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) return [p[0], p[1]];
  if (p && Number.isFinite(p.xKm) && Number.isFinite(p.yKm)) return [p.xKm, p.yKm];
  if (p && Number.isFinite(p.latDeg) && Number.isFinite(p.lonDeg)) return toXY(p.latDeg, p.lonDeg);
  return null;
}

// sunAt from heat jobs: layers = [{ grid, job }] finest first (e.g. the 1 km viewport job, then the 2 km
// map job of the planned landing and stay). A cell counts once the job has computed it (inside its rect,
// row done, not masked out). → (xKm, yKm) => 0–1 | NaN
// (fix R2) Or pass the heat plan itself (heatplan.js: { coarse, full }): then only its full 2 km map job
// of the planned stay is sampled, never the 1 km viewport job, so a route's sunlit figures and the sunny
// search do not change with the zoom at which Plan was pressed.
export const planSunLayers = (heatPlan) => (heatPlan?.full?.planned && heatPlan.coarse?.grid ? [{ grid: heatPlan.coarse.grid, job: heatPlan.full.planned }] : []);
export function sunFromJobs(layers) {
  const ls = (Array.isArray(layers) ? layers : planSunLayers(layers)).filter((l) => l && l.grid && l.job);
  return (xKm, yKm) => {
    for (const { grid, job } of ls) {
      const k = grid.cellAt(xKm, yKm);
      if (k === null || k === undefined) continue;
      const r = job.rect;
      if (r) {
        const j = Math.floor(k / grid.size), i = k - j * grid.size;
        const rowsDone = job.done ? r.j1 - r.j0 + 1 : job.rows;
        if (i < r.i0 || i > r.i1 || j < r.j0 || j >= r.j0 + rowsDone) continue;
      }
      if (job.mask && !job.mask[k]) continue;
      return job.sun[k];
    }
    return NaN;
  };
}

// ---------- a binary min-heap of (key, node) ----------
function createHeap(cap = 1 << 16) {
  let keys = new Float64Array(cap), vals = new Int32Array(cap), n = 0;
  return {
    get size() { return n; },
    clear() { n = 0; },
    push(key, val) {
      if (n === keys.length) {
        const k2 = new Float64Array(n * 2); k2.set(keys); keys = k2;
        const v2 = new Int32Array(n * 2); v2.set(vals); vals = v2;
      }
      let i = n++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (keys[p] <= key) break;
        keys[i] = keys[p]; vals[i] = vals[p]; i = p;
      }
      keys[i] = key; vals[i] = val;
    },
    topKey: () => keys[0],
    pop() {
      const top = vals[0];
      const key = keys[--n], val = vals[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c]; vals[i] = vals[c]; i = c;
      }
      keys[i] = key; vals[i] = val;
      return top;
    },
  };
}

// 16-connected moves: the 8 neighbours and the 8 knight moves. A diagonal or knight move also needs the
// nodes it passes between to be passable, so no route squeezes through the corner of a steep patch.
const MOVES = [
  [1, 0, []], [-1, 0, []], [0, 1, []], [0, -1, []],
  [1, 1, [[1, 0], [0, 1]]], [1, -1, [[1, 0], [0, -1]]], [-1, 1, [[-1, 0], [0, 1]]], [-1, -1, [[-1, 0], [0, -1]]],
  [2, 1, [[1, 0], [1, 1]]], [2, -1, [[1, 0], [1, -1]]], [-2, 1, [[-1, 0], [-1, 1]]], [-2, -1, [[-1, 0], [-1, -1]]],
  [1, 2, [[0, 1], [1, 1]]], [-1, 2, [[0, 1], [-1, 1]]], [1, -2, [[0, -1], [1, -1]]], [-1, -2, [[0, -1], [-1, -1]]],
];

const OPP = MOVES.map(([dx, dy]) => MOVES.findIndex(([ex, ey]) => ex === -dx && ey === -dy));

// Phase 2: the directional test of a move from node n to node m. The grade along the move (the mean of
// the two nodes' gradients projected on its direction) must stay under the climb limit uphill and the
// descent limit downhill; the slope across it (the larger of the two nodes) under the cross-slope limit.
// → (n, m) => boolean
export function edgeTest(cor, mob) {
  const tc = Math.tan(mob.climbDeg / DEG), td = Math.tan(mob.descentDeg / DEG), tx = Math.tan(mob.crossDeg / DEG);
  const { W, gxs, gys } = cor;
  return (n, m) => {
    const un = n % W, vn = (n - un) / W, um = m % W, vm = (m - um) / W;
    let dx = um - un, dy = vn - vm;                      // map direction (+y is up a row)
    const L = Math.hypot(dx, dy); dx /= L; dy /= L;
    const pitch = 0.5 * (gxs[n] * dx + gys[n] * dy + gxs[m] * dx + gys[m] * dy);
    if (!(pitch <= tc && -pitch <= td)) return false;
    const cross = Math.max(Math.abs(gxs[n] * dy - gys[n] * dx), Math.abs(gxs[m] * dy - gys[m] * dx));
    return cross <= tx;
  };
}

// ---------- the corridor graph of one leg ----------
// Nodes are DEM pixel centres (col c0 + u, row r0 + v). slope: degrees (Infinity off the terrain);
// inv: ground km per map km (1 / stereographic scale factor); sun: 0–1 or NaN.
function buildCorridor(dem, a, b, padKm, sunAt) {
  const kpp = dem.kmPerPixel, half = dem.halfKm, size = dem.size ?? Math.round((2 * half) / kpp);
  const colOf = (x) => (x + half) / kpp - 0.5, rowOf = (y) => (half - y) / kpp - 0.5;
  const c0 = Math.max(1, Math.floor(colOf(Math.min(a[0], b[0]) - padKm)));
  const c1 = Math.min(size - 2, Math.ceil(colOf(Math.max(a[0], b[0]) + padKm)));
  const r0 = Math.max(1, Math.floor(rowOf(Math.max(a[1], b[1]) + padKm)));
  const r1 = Math.min(size - 2, Math.ceil(rowOf(Math.min(a[1], b[1]) - padKm)));
  const W = c1 - c0 + 1, H = r1 - r0 + 1;
  if (!(W > 2 && H > 2)) return null;
  const N = W * H;
  const xOf = (u) => -half + (c0 + u + 0.5) * kpp, yOf = (v) => half - (r0 + v + 0.5) * kpp;
  // heights with a one-node ring for the central differences
  const HW = W + 2, HH = H + 2, hts = new Float64Array(HW * HH);
  const xs = new Float64Array(HW), ys = new Float64Array(HH);
  for (let i = 0; i < HW; i++) xs[i] = xOf(i - 1);
  for (let j = 0; j < HH; j++) ys[j] = yOf(j - 1);
  if (typeof dem.grid === 'function') {
    const at = dem.grid(xs, ys);
    for (let j = 0; j < HH; j++) for (let i = 0; i < HW; i++) hts[j * HW + i] = at(i, j);
  } else {
    for (let j = 0; j < HH; j++) for (let i = 0; i < HW; i++) { const v = dem.heightAtXY(xs[i], ys[j]); hts[j * HW + i] = v === null || v === undefined ? NaN : v; }
  }
  const slope = new Float32Array(N), inv = new Float32Array(N), sun = new Float32Array(N);
  const gxs = new Float32Array(N), gys = new Float32Array(N);   // ground gradient (tan) along map +x and +y
  let invMin = Infinity;
  for (let v = 0; v < H; v++) {
    const y = yOf(v);
    for (let u = 0; u < W; u++) {
      const x = xOf(u), n = v * W + u, m = (v + 1) * HW + (u + 1);
      const scale = 1 + (x * x + y * y) / (4 * R * R);     // map distance per ground distance
      inv[n] = 1 / scale;
      if (inv[n] < invMin) invMin = inv[n];
      const span = (2 * kpp * 1000) / scale;                // ground metres across two nodes
      const gx = (hts[m + 1] - hts[m - 1]) / span, gy = (hts[m - HW] - hts[m + HW]) / span;
      const s = Math.atan(Math.hypot(gx, gy)) * DEG;
      slope[n] = s === s && hts[m] === hts[m] ? s : Infinity;
      gxs[n] = gx; gys[n] = gy;
      sun[n] = sunAt ? sunAt(x, y) : NaN;
    }
  }
  return {
    W, H, N, kpp, c0, r0, slope, inv, sun, gxs, gys, invMin, xOf, yOf,
    nodeAt: (x, y) => {
      const u = Math.round(colOf(x)) - c0, v = Math.round(rowOf(y)) - r0;
      return u >= 0 && v >= 0 && u < W && v < H ? v * W + u : -1;
    },
    // nodes within rKm of (x, y), nearest first
    disk(x, y, rKm) {
      const out = [];
      const uc = colOf(x) - c0, vc = rowOf(y) - r0, rn = rKm / kpp;
      for (let v = Math.max(0, Math.floor(vc - rn)); v <= Math.min(H - 1, Math.ceil(vc + rn)); v++) {
        for (let u = Math.max(0, Math.floor(uc - rn)); u <= Math.min(W - 1, Math.ceil(uc + rn)); u++) {
          const d = Math.hypot(u - uc, v - vc) * kpp;
          if (d <= rKm) out.push({ n: v * W + u, d });
        }
      }
      if (!out.length) { const n = this.nodeAt(x, y); if (n >= 0) out.push({ n, d: Math.hypot(xOf(n % W) - x, yOf(Math.floor(n / W)) - y) }); }
      return out.sort((p, q) => p.d - q.d);
    },
  };
}

// Box mean of a node field over (2r + 1)² nodes, skipping non-finite values (NaN where none is finite).
function boxMean(src, W, H, r) {
  if (!r) return src;
  const tmpS = new Float64Array(W * H), tmpN = new Float64Array(W * H), out = new Float32Array(W * H);
  for (let v = 0; v < H; v++) {
    let s = 0, n = 0;
    const row = v * W;
    for (let u = -r; u < W + r; u++) {
      const add = u + r < W ? src[row + u + r] : NaN;
      if (u + r < W && Number.isFinite(add)) { s += add; n++; }
      const drop = u - r - 1 >= 0 ? src[row + u - r - 1] : NaN;
      if (u - r - 1 >= 0 && Number.isFinite(drop)) { s -= drop; n--; }
      if (u >= 0 && u < W) { tmpS[row + u] = s; tmpN[row + u] = n; }
    }
  }
  for (let u = 0; u < W; u++) {
    let s = 0, n = 0;
    for (let v = -r; v < H + r; v++) {
      if (v + r < H) { s += tmpS[(v + r) * W + u]; n += tmpN[(v + r) * W + u]; }
      if (v - r - 1 >= 0) { s -= tmpS[(v - r - 1) * W + u]; n -= tmpN[(v - r - 1) * W + u]; }
      if (v >= 0 && v < H) out[v * W + u] = n > 0.5 ? s / n : NaN;
    }
  }
  return out;
}

// Highest slope a move from n by MOVES[k] meets (the target and the nodes it passes between); -1 off the grid.
function moveSlope(cor, u, v, k) {
  const [dx, dy, mid] = MOVES[k];
  const uu = u + dx, vv = v + dy, W = cor.W;
  if (uu < 0 || vv < 0 || uu >= W || vv >= cor.H) return -1;
  let s = cor.slope[vv * W + uu];
  for (let m = 0; m < mid.length; m++) { const t = cor.slope[(v + mid[m][1]) * W + (u + mid[m][0])]; if (t > s) s = t; }
  return s;
}

// The lowest slope cap under which the goal disk can be reached from the start disk (minimax path).
async function bottleneck(cor, startDisk, goalDisk, ctl) {
  const best = new Float32Array(cor.N).fill(Infinity), done = new Uint8Array(cor.N), goal = new Uint8Array(cor.N);
  for (const g of goalDisk) goal[g.n] = 1;
  const heap = createHeap();
  for (const s of startDisk) { const v = cor.slope[s.n]; if (v < best[s.n]) { best[s.n] = v; heap.push(v, s.n); } }
  let pops = 0;
  while (heap.size) {
    const val = heap.topKey(), n = heap.pop();
    if (done[n]) continue;
    done[n] = 1;
    if (goal[n]) return val;
    if (!Number.isFinite(val)) return Infinity;
    const u = n % cor.W, v = (n - u) / cor.W;
    for (let k = 0; k < 16; k++) {
      const s = moveSlope(cor, u, v, k);
      if (s < 0) continue;
      const m = (v + MOVES[k][1]) * cor.W + (u + MOVES[k][0]);
      const w = s > val ? s : val;
      if (w < best[m]) { best[m] = w; heap.push(w, m); }
    }
    if ((++pops & 4095) === 0) await ctl.tick(Math.min(1, pops / cor.N));
  }
  return Infinity;
}

// Phase 2: nodes reachable from seeds by allowed moves (reverse: nodes from which a seed can be reached).
async function reach(cor, seeds, lim, edgeOk, reverse, ctl) {
  const { W, H, slope } = cor, seen = new Uint8Array(cor.N), stack = [];
  for (const n of seeds) if (slope[n] <= lim && !seen[n]) { seen[n] = 1; stack.push(n); }
  let pops = 0;
  while (stack.length) {
    const a = stack.pop(), u = a % W, v = (a - u) / W;
    for (let k = 0; k < 16; k++) {
      const uu = u + MOVES[k][0], vv = v + MOVES[k][1];
      if (uu < 0 || vv < 0 || uu >= W || vv >= H) continue;
      const b = vv * W + uu;
      if (seen[b] || !(slope[b] <= lim)) continue;
      // forward a → b; reverse: is b → a allowed?
      const ms = reverse ? moveSlope(cor, uu, vv, OPP[k]) : moveSlope(cor, u, v, k);
      if (!(ms <= lim) || !(reverse ? edgeOk(b, a) : edgeOk(a, b))) continue;
      seen[b] = 1; stack.push(b);
    }
    if ((++pops & 8191) === 0) await ctl.tick(0.5);
  }
  return seen;
}

// Trap nodes (reachable from the start, no way on to the end or back to the start), in 8-connected patches of
// at least TRAP_MIN_NODES nodes: smaller pits are at the limit of what the grid resolves, so they are left out.
export const TRAP_MIN_NODES = 4;
function trapPatches(cor, fwd, out) {
  const { W, H, N } = cor, seen = new Uint8Array(N), keep = [];
  for (let n0 = 0; n0 < N; n0++) {
    if (seen[n0] || !fwd[n0] || out[n0]) continue;
    const patch = [n0];
    seen[n0] = 1;
    for (let i = 0; i < patch.length; i++) {
      const a = patch[i], u = a % W, v = (a - u) / W;
      for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
        const uu = u + du, vv = v + dv;
        if (uu < 0 || vv < 0 || uu >= W || vv >= H) continue;
        const b = vv * W + uu;
        if (!seen[b] && fwd[b] && !out[b]) { seen[b] = 1; patch.push(b); }
      }
    }
    if (patch.length >= TRAP_MIN_NODES) keep.push(...patch);
  }
  return keep;
}

// A* from any passable node of the start disk to any passable node of the goal disk under slope cap lim,
// cost per ground km = factor[node]. → { nodes: Int32Array, g: Float64Array (cumulative cost) } | null
async function search(cor, startDisk, goalDisk, goalXY, lim, factor, ctl, edgeOk = null) {
  const { W, H, N, kpp, inv, slope } = cor;
  const g = new Float64Array(N).fill(Infinity), parent = new Int32Array(N).fill(-1), closed = new Uint8Array(N), goal = new Uint8Array(N);
  for (const q of goalDisk) if (slope[q.n] <= lim) goal[q.n] = 1;
  const gx = goalXY[0], gy = goalXY[1], hScale = cor.invMin * (1 - 1e-9), hTie = 1 + 1e-6;
  const hOf = (n) => {
    const u = n % W, v = (n - u) / W;
    return Math.max(0, Math.hypot(cor.xOf(u) - gx, cor.yOf(v) - gy) - SNAP_KM) * hScale * hTie;
  };
  const heap = createHeap();
  for (const s of startDisk) {
    if (!(slope[s.n] <= lim)) continue;
    const c = s.d * inv[s.n] * factor[s.n];
    if (c < g[s.n]) { g[s.n] = c; heap.push(c + hOf(s.n), s.n); }
  }
  const len = MOVES.map(([dx, dy]) => Math.hypot(dx, dy) * kpp);
  let pops = 0, end = -1;
  while (heap.size) {
    const n = heap.pop();
    if (closed[n]) continue;
    closed[n] = 1;
    if (goal[n]) { end = n; break; }
    const u = n % W, v = (n - u) / W, gn = g[n], fn = factor[n], iv = inv[n];
    for (let k = 0; k < 16; k++) {
      const uu = u + MOVES[k][0], vv = v + MOVES[k][1];
      if (uu < 0 || vv < 0 || uu >= W || vv >= H) continue;
      const m = vv * W + uu;
      if (closed[m]) continue;
      const s = moveSlope(cor, u, v, k);
      if (!(s <= lim)) continue;
      if (edgeOk && !edgeOk(n, m)) continue;
      const c = gn + len[k] * 0.5 * (iv + inv[m]) * 0.5 * (fn + factor[m]);
      if (c < g[m]) { g[m] = c; parent[m] = n; heap.push(c + hOf(m), m); }
    }
    if ((++pops & 2047) === 0) await ctl.tick(Math.min(0.95, pops / (0.6 * N)));
  }
  if (end < 0) return null;
  const rev = [];
  for (let n = end; n >= 0; n = parent[n]) rev.push(n);
  const nodes = Int32Array.from(rev.reverse());
  return { nodes, g: Float64Array.from(nodes, (n) => g[n]) };
}

// Walks the straight segment between two map points through the node grid, step a quarter node:
// visit(n, groundKm) per step; returns false as soon as a node is off the grid or steeper than lim,
// including the nodes a diagonal step passes between. subst maps a waypoint's own node (when it is steeper
// than lim) to the node the route starts or ends on, as the connector rule says.
function walk(cor, ax, ay, bx, by, lim, visit, subst, edgeOk = null) {
  const L = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(L / (cor.kpp * 0.25)));
  const dl = L / steps;
  let prev = -1;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    let n = cor.nodeAt(ax + (bx - ax) * t, ay + (by - ay) * t);
    if (n >= 0 && subst.has(n)) n = subst.get(n);
    if (n < 0 || !(cor.slope[n] <= lim)) return false;
    if (prev >= 0 && n !== prev) {
      const pu = prev % cor.W, pv = (prev - pu) / cor.W, u = n % cor.W, v = (n - u) / cor.W;
      if (Math.abs(pu - u) > 1 || Math.abs(pv - v) > 1) return false;      // a substituted jump
      if (pu !== u && pv !== v && !(cor.slope[pv * cor.W + u] <= lim && cor.slope[v * cor.W + pu] <= lim)) return false;
      if (edgeOk && !edgeOk(prev, n)) return false;
    }
    prev = n;
    if (visit) visit(n, dl * cor.inv[n]);
  }
  return true;
}

// Any-angle smoothing of a leg: the waypoints a, b and the grid path between them. From each kept point,
// jump to the farthest later point that a straight segment reaches within the slope cap and at no more cost
// than the grid path between them. Removes the 16-direction staircase without making the route steeper or
// (by its own cost) worse. The first and last segments, when not replaced, are connectors: a waypoint to the
// node the search started or ended on, measured with that node's values.
// → { line: [[x, y], …], fixed: { segmentIndex: node }, subst }
function smooth(cor, path, a, b, lim, factor, edgeOk = null) {
  const { nodes, g } = path, K = nodes.length;
  const P = (n) => { const u = n % cor.W; return [cor.xOf(u), cor.yOf((n - u) / cor.W)]; };
  const pts = [a, ...Array.from(nodes, P), b];
  const last = nodes[K - 1], pl = pts[K];
  const gs = [0, ...g, g[K - 1] + Math.hypot(b[0] - pl[0], b[1] - pl[1]) * cor.inv[last] * factor[last]];
  const subst = new Map();
  const na = cor.nodeAt(a[0], a[1]), nb = cor.nodeAt(b[0], b[1]);
  if (na >= 0 && !(cor.slope[na] <= lim)) subst.set(na, nodes[0]);
  if (nb >= 0 && !(cor.slope[nb] <= lim)) subst.set(nb, last);
  const out = [0], fixed = {};
  const LOOK = 160;
  let i = 0;
  while (i < pts.length - 1) {
    let best = i + 1, misses = 0;
    const [ax, ay] = pts[i];
    for (let j = i + 2; j < pts.length && j <= i + LOOK; j++) {
      const [bx, by] = pts[j];
      let cost = 0;
      const ok = walk(cor, ax, ay, bx, by, lim, (n, km) => { cost += km * factor[n]; }, subst, edgeOk);
      // relative tolerance: a segment along the grid path itself costs the same up to rounding
      if (ok && cost <= (gs[j] - gs[i]) * (1 + 1e-6) + 1e-9) { best = j; misses = 0; } else if (++misses >= 16) break;
    }
    if (best === i + 1 && i === 0) fixed[out.length - 1] = nodes[0];
    else if (best === i + 1 && best === pts.length - 1) fixed[out.length - 1] = last;
    out.push(best);
    i = best;
  }
  return { line: out.map((k) => pts[k]), fixed, subst };
}

// Statistics of a leg's polyline, sampled every quarter node; a fixed (connector) segment takes the values
// of its node, a waypoint's own steep node those of its substitute.
function legStats(cor, line, fixed, subst, isPsr, mob = null) {
  let len = 0, maxS = 0, slopeSum = 0, sunLen = 0, sunSum = 0, psrKm = 0;
  let climb = 0, descent = 0, cross = 0, hours = 0, oneWayKm = 0, run = null;
  const oneWay = [], tc = mob ? Math.tan(mob.climbDeg / DEG) : 0;
  for (let k = 0; k + 1 < line.length; k++) {
    const [ax, ay] = line[k], [bx, by] = line[k + 1];
    const L = Math.hypot(bx - ax, by - ay);
    if (!(L > 0)) continue;
    const steps = Math.max(1, Math.ceil(L / (cor.kpp * 0.25)));
    const fx = fixed[k] ?? -1, ux = (bx - ax) / L, uy = (by - ay) / L;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      let n = fx >= 0 ? fx : cor.nodeAt(x, y);
      if (n >= 0 && subst.has(n)) n = subst.get(n);
      if (n < 0) continue;
      const km = (L / steps) * cor.inv[n], s = cor.slope[n], sun = cor.sun[n];
      if (mob) {
        const pitch = cor.gxs[n] * ux + cor.gys[n] * uy, across = Math.abs(cor.gxs[n] * uy - cor.gys[n] * ux);
        if (pitch > climb) climb = pitch;
        if (-pitch > descent) descent = -pitch;
        if (across > cross) cross = across;
        hours += km / (mob.speedKmh * speedFactor(pitch, mob));
        const h = (L / steps) / 2, p0 = [x - ux * h, y - uy * h], p1 = [x + ux * h, y + uy * h];
        if (-pitch > tc) {
          oneWayKm += km;
          if (run) run[1] = p1; else { run = [p0, p1]; oneWay.push(run); }
        } else run = null;
      }
      len += km;
      if (s > maxS) maxS = s;
      slopeSum += s * km;
      if (sun === sun) { sunLen += km; sunSum += sun * km; }
      if (isPsr && isPsr(x, y)) psrKm += km;
    }
  }
  const deg = (v) => Math.atan(v) * DEG;
  return { len, maxS, slopeSum, sunLen, sunSum, psrKm, ...(mob ? { climb: deg(climb), descent: deg(descent), cross: deg(cross), hours, oneWayKm, oneWay } : {}) };
}

// Douglas–Peucker, tolerance in km.
export function simplify(points, tolKm) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let worst = -1, wd = tolKm;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

// ---------- the planner ----------
export async function planRoutes({ points, dem, sunAt = null, isPsr = null, maxSlopeDeg = DEFAULT_MAX_SLOPE, mobility = null } = {}, opts = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const { onProgress = null, signal = null, sliceMs = 12, yieldFn = defaultYield } = opts;
  const climbLim = Number(maxSlopeDeg);
  const mob = climbLim > 0 && climbLim < 90 ? cleanMobility(mobility, climbLim) : null;
  // the node cap: without mobility the slope limit; with it, the steepest ground any direction may cross
  const lim = mob ? Math.max(mob.climbDeg, mob.descentDeg, mob.crossDeg) : climbLim;
  const base = { ok: false, error: null, blocked: null, routes: [], limitDeg: climbLim, baselineKm: dem?.kmPerPixel ?? null, waypoints: [], nodes: 0, ms: 0, ...(mob ? { mobility: mob } : {}) };
  const fail = (error) => ({ ...base, error, ms: Math.round(now() - t0) });
  if (signal?.aborted) throw abortError();
  if (!dem || !(dem.kmPerPixel > 0) || !(dem.halfKm > 0)) return fail('The terrain grid is not loaded yet.');
  if (!(climbLim > 0 && climbLim < 90)) return fail('Set a slope limit between 1° and 89°.');
  const wps = [];
  for (const p of points ?? []) {
    const q = toPoint(p);
    if (!q) return fail('Every point needs a latitude and a longitude.');
    const last = wps[wps.length - 1];
    if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < 1e-6) continue;   // repeated point
    wps.push(q);
  }
  base.waypoints = wps;
  if (wps.length < MIN_POINTS) return fail('Add a start and an end point.');
  if (wps.length > MAX_POINTS) return fail(`Use at most ${MAX_POINTS} points.`);
  for (let i = 0; i < wps.length; i++) {
    const h = dem.heightAtXY(wps[i][0], wps[i][1]);
    if (h === null || h === undefined || Number.isNaN(h)) return fail(`Point ${i + 1} is outside the terrain grid.`);
  }
  for (let i = 0; i + 1 < wps.length; i++) {
    const d = Math.hypot(wps[i + 1][0] - wps[i][0], wps[i + 1][1] - wps[i][1]);
    if (d > MAX_LEG_KM) return fail(`Leg ${i + 1} is ${Math.round(d)} km; split it with a waypoint (at most ${MAX_LEG_KM} km a leg).`);
  }

  const legs = wps.length - 1;
  const ids = CANDIDATES.map((c) => c.id).filter((id) => id !== 'sunny' || sunAt);
  // the searches: one each for short and flat, one per weight for sunny
  const specs = ids.flatMap((id) => (id === 'sunny' ? [...SUNNY_WEIGHTS, 'target'].map((w) => ({ id, key: `sunny@${w}`, w })) : [{ id, key: id, w: undefined }]));
  const unitsPerLeg = 1 + specs.length;
  let unit = 0, sliceStart = now(), lastFrac = 0;
  const ctl = {
    async tick(frac) {
      if (now() - sliceStart < sliceMs) return;
      const f = Math.min(0.999, (unit + Math.max(0, Math.min(1, frac))) / (legs * unitsPerLeg));
      if (f > lastFrac) { lastFrac = f; onProgress?.(f); }
      await yieldFn();
      if (signal?.aborted) throw abortError();
      sliceStart = now();
    },
  };
  const advance = async () => { unit++; await ctl.tick(0); };

  // corridor and minimax slope of every leg; widen a blocked corridor once
  const legData = [];
  let worst = null, directional = null;
  for (let i = 0; i < legs; i++) {
    const a = wps[i], b = wps[i + 1];
    const legKm = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let pad = corridorPadKm(legKm), cor = null, need = Infinity, sd = null, gd = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      cor = buildCorridor(dem, a, b, pad, sunAt);
      if (!cor) return fail(`Leg ${i + 1} is outside the terrain grid.`);
      if (cor.N > MAX_NODES) return fail(`Leg ${i + 1} needs too large a search area; add a waypoint.`);
      sd = cor.disk(a[0], a[1], SNAP_KM); gd = cor.disk(b[0], b[1], SNAP_KM);
      need = await bottleneck(cor, sd, gd, ctl);
      if (need <= lim) break;
      pad *= 2;
    }
    base.nodes += cor.N;
    const leg = { a, b, cor, need, sd, gd };
    if (mob && need <= lim) {
      // directional reachability: can the end be reached, can the start be reached back, and the traps
      leg.edgeOk = edgeTest(cor, mob);
      const seeds = (disk) => disk.map((q) => q.n);
      const fwd = await reach(cor, seeds(sd), lim, leg.edgeOk, false, ctl);
      if (!gd.some((q) => fwd[q.n])) { directional ??= i; }
      else {
        const back = await reach(cor, seeds(gd), lim, leg.edgeOk, false, ctl);
        leg.returnable = sd.some((q) => back[q.n]);
        const out = await reach(cor, [...seeds(gd), ...seeds(sd)], lim, leg.edgeOk, true, ctl);
        leg.traps = trapPatches(cor, fwd, out);
      }
    }
    legData.push(leg);
    if (need > lim && (!worst || need > worst.need)) worst = { need, leg: i };
    await advance();
  }
  if (directional !== null && !worst) {
    return fail(`No route keeps within the climb (${mob.climbDeg}°), descent (${mob.descentDeg}°) and cross-slope (${mob.crossDeg}°) limits${legs > 1 ? ` on leg ${directional + 1}` : ''}. Raise a limit or move a point.`);
  }
  if (worst) {
    const finite = Number.isFinite(worst.need);
    // whole degrees, nudged so that floating error at an exact degree does not round up past it
    const passesAt = finite ? Math.ceil(worst.need - 1e-6) : null;
    return {
      ...base,
      error: finite ? null : `No route found on the terrain grid for leg ${worst.leg + 1}.`,
      blocked: { limitDeg: lim, neededDeg: finite ? worst.need : null, passesAtDeg: passesAt, leg: worst.leg },
      ms: Math.round(now() - t0),
    };
  }

  // the candidates, leg by leg
  const acc = Object.fromEntries(specs.map((p) => [p.key, { line: [], len: 0, maxS: 0, slopeSum: 0, sunLen: 0, sunSum: 0, psrKm: 0, climb: 0, descent: 0, cross: 0, hours: 0, oneWayKm: 0, oneWay: [] }]));
  for (const L of legData) {
    const { cor, a, b, sd, gd, need } = L;
    const blurred = {};
    let legBest = 0;   // the highest sunlit share any search has found on this leg so far
    for (const { id, key, w } of specs) {
      const cap = id === 'flat' ? Math.min(lim, need + FLAT_MARGIN_DEG) : lim;
      const fn = COSTS[id], r = COST_BLUR[id];
      const sl = id === 'flat' ? (blurred.slope ??= boxMean(cor.slope, cor.W, cor.H, r)) : cor.slope;
      const su = id === 'sunny' ? (blurred.sun ??= boxMean(cor.sun, cor.W, cor.H, r)) : cor.sun;
      const factor = new Float32Array(cor.N);
      const target = w === 'target' ? legBest : null;
      for (let n = 0; n < cor.N; n++) {
        const sn = sl[n] === sl[n] ? sl[n] : cor.slope[n];
        factor[n] = !Number.isFinite(cor.slope[n]) ? 1 : target === null ? fn(sn, su[n], lim, w) : sunnyTargetCost(sn, su[n], lim, target);
      }
      const path = await search(cor, sd, gd, b, cap, factor, ctl, L.edgeOk ?? null);
      if (!path) return fail('The search found no path although the slope check passed; try again with a higher limit.');
      const { line, fixed, subst } = smooth(cor, path, a, b, cap, factor, L.edgeOk ?? null);
      const st = legStats(cor, line, fixed, subst, isPsr, mob);
      if (st.sunLen > 0 && st.sunSum / st.sunLen > legBest) legBest = st.sunSum / st.sunLen;
      const t = acc[key];
      // simplified per leg, so every waypoint stays a vertex
      const shown = simplify(line, Math.min(0.06, dem.kmPerPixel * 0.25));
      t.line.push(...(t.line.length ? shown.slice(1) : shown));
      t.len += st.len; t.slopeSum += st.slopeSum; t.sunLen += st.sunLen; t.sunSum += st.sunSum; t.psrKm += st.psrKm;
      if (st.maxS > t.maxS) t.maxS = st.maxS;
      if (mob) {
        t.climb = Math.max(t.climb, st.climb); t.descent = Math.max(t.descent, st.descent); t.cross = Math.max(t.cross, st.cross);
        t.hours += st.hours; t.oneWayKm += st.oneWayKm; t.oneWay.push(...st.oneWay);
      }
      await advance();
    }
  }
  const figures = (t) => ({
    points: t.line,
    lengthKm: t.len,
    maxSlopeDeg: t.maxS,
    meanSlopeDeg: t.len > 0 ? t.slopeSum / t.len : 0,
    sunShare: t.sunLen > 0 ? t.sunSum / t.sunLen : null,
    sunKnown: t.len > 0 ? t.sunLen / t.len : 0,
    psrKm: isPsr ? t.psrKm : null,
    ...(mob ? { climbMaxDeg: t.climb, descentMaxDeg: t.descent, crossMaxDeg: t.cross, hours: t.hours, oneWayKm: t.oneWayKm, oneWay: t.oneWay } : {}),
  });
  // the searched routes: short, flat and the sunniest of the sunny weights (ties: the lower weight)
  const raw = {};
  for (const id of ids) {
    const own = specs.filter((p) => p.id === id).map((p) => ({ ...figures(acc[p.key]), from: id }));
    raw[id] = id === 'sunny' ? pickByMetric(own, 'sunny', 0) : own[0];
  }
  const pool = ids.map((id) => raw[id]);
  const routes = [];
  for (const c of CANDIDATES) {
    if (!raw[c.id]) { routes.push({ id: c.id, label: c.label, points: null, lengthKm: null, maxSlopeDeg: null, meanSlopeDeg: null, sunShare: null, sunKnown: 0, psrKm: null, sameAs: null, unavailable: 'Needs the sunlight figures of the planned stay.', ...(mob ? { climbMaxDeg: null, descentMaxDeg: null, crossMaxDeg: null, hours: null, oneWayKm: null, oneWay: [] } : {}) }); continue; }
    // the label stays true: the best searched route by this label's figure, its own on a tie
    const best = pickByMetric(pool, c.id, ids.indexOf(c.id));
    const { from, ...f } = best;
    const r = { id: c.id, label: c.label, ...f, sameAs: null, unavailable: null };
    for (const prev of routes) if (prev.points && sameRoute(prev, r)) { r.sameAs = prev.id; break; }
    if (from !== c.id) r.takenFrom = from;   // for tests and the agent: which search found it
    routes.push(r);
  }
  onProgress?.(1);
  const extra = {};
  if (mob) {
    extra.returnable = legData.every((L) => L.returnable);
    // trap nodes of all legs, as map points (a node shared by two corridors counts once)
    const seen = new Set(), cells = [];
    let km2 = 0;
    for (const L of legData) {
      const c = L.cor;
      for (const n of L.traps ?? []) {
        const u = n % c.W, v = (n - u) / c.W, x = c.xOf(u), y = c.yOf(v), key = `${Math.round(x / c.kpp)},${Math.round(y / c.kpp)}`;
        if (seen.has(key)) continue;
        seen.add(key); cells.push([x, y]);
        km2 += (c.kpp * c.inv[n]) ** 2;
      }
    }
    extra.traps = { km2, cellKm: dem.kmPerPixel, cells };
  }
  return { ...base, ok: true, routes, ...extra, ms: Math.round(now() - t0) };
}

// The best of routes by a label's figure: 'short' the least lengthKm, 'flat' the least meanSlopeDeg,
// 'sunny' the most sunShare (unknown counts as none). Strictly better only, so ties keep routes[own]
// (then the earliest).
export function pickByMetric(routes, id, own = 0) {
  const score = (r) => (id === 'short' ? -r.lengthKm : id === 'flat' ? -r.meanSlopeDeg : r.sunShare ?? -Infinity);
  let best = routes[own] ?? routes[0];
  for (const r of routes) if (score(r) > score(best)) best = r;
  return best;
}

// Two candidates count as the same route when their figures match and no vertex of either lies more than
// one node spacing (0.25 km) from the other line.
function sameRoute(p, q) {
  if (Math.abs(p.lengthKm - q.lengthKm) > 0.005 * Math.max(p.lengthKm, q.lengthKm) + 0.01) return false;
  if (Math.abs(p.maxSlopeDeg - q.maxSlopeDeg) > 0.1) return false;
  return lineGap(p.points, q.points) <= 0.25 && lineGap(q.points, p.points) <= 0.25;
}
function lineGap(from, to) {
  let worst = 0;
  for (const [px, py] of from) {
    let best = Infinity;
    for (let k = 0; k + 1 < to.length; k++) {
      const [ax, ay] = to[k], [bx, by] = to[k + 1];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
    }
    if (best > worst) worst = best;
  }
  return worst;
}

// Slope (degrees) at a map point on the planner's grid: the same central differences and scale
// correction as the graph nodes (handy for tests and for the card's notes). null off the grid.
export function slopeAt(dem, xKm, yKm) {
  const kpp = dem.kmPerPixel, half = dem.halfKm;
  const c = Math.round((xKm + half) / kpp - 0.5), r = Math.round((half - yKm) / kpp - 0.5);
  const x = -half + (c + 0.5) * kpp, y = half - (r + 0.5) * kpp;
  const h = (dx, dy) => dem.heightAtXY(x + dx * kpp, y + dy * kpp);
  const e = h(1, 0), w = h(-1, 0), n = h(0, 1), s = h(0, -1);
  if ([e, w, n, s].some((v) => v === null || v === undefined || Number.isNaN(v))) return null;
  const scale = 1 + (x * x + y * y) / (4 * R * R), span = (2 * kpp * 1000) / scale;
  return Math.atan(Math.hypot((e - w) / span, (n - s) / span)) * DEG;
}
