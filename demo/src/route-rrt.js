// Self-driving rover path planner: bidirectional RRT* (B-RRT*) run leg by leg, after the flowchart of
// autonomous traverse planning (Delay = 0, Overall Path = []; initialize trees; select waypoints; B-RRT*;
// path exists? add it; no: adjust waypoints and try again up to a number of tries, then abort).
// Pure computation, no DOM; runs in slices so the page stays responsive and stops on its AbortSignal.
//
// planSelfDriving({ points, dem, maxSlopeDeg, mobility, seed, maxIter, maxTries, stepKm, timeBudgetMs },
//                 { onProgress, signal, sliceMs, yieldFn }) → Promise<Result>
//   points, dem, maxSlopeDeg, mobility: as planRoutes (route-plan.js): the dem_240m level, the climb limit and
//     the descent / cross-slope limits. Without mobility every limit is the climb limit.
//   seed        the pseudo-random seed (same seed and inputs → same result)
//   maxIter     B-RRT* iterations per try (default 4000), maxTries tries per leg, the first run included (5)
//   stepKm      steering step in map km; default per leg: leg length / 20, between 0.3 and 1 km
//   timeBudgetMs total time budget (default 45000)
//
// Per leg: the corridor graph of route-plan.js gives terrain, slope, gradient and scale at any map point.
// Two trees grow in continuous map km, one from the leg start (edges driven parent → child) and one from the
// leg end (edges driven child → parent, towards the end), so one-way ground is handled by direction. An edge
// is checked every quarter node along it with the planner's limits (slope, grade along, slope across); its
// cost is the drive time (ground km / (speed × speedFactor)). RRT*: choose the cheapest parent among the
// nearby nodes, rewire them through the new node, radius shrinking with the tree size. A new node tries to
// connect to the other tree in the driving direction; every strictly better connection is a candidate path
// (the last CANDIDATES_PER_LEG are kept) and the search goes on until maxIter. The best path is then
// shortcut-smoothed with the same directed check, at no more cost.
// Result = { ok, aborted, reason, error, trajectory: [[x, y], …], legs: [{ from, to, adjustedTo, tries }],
//   candidates: [[[x, y], …], …], candidateLegs, trees: [[x1, y1, x2, y2], …], trace: [{ step, leg, text }],
//   delayMs, nodes, ms, … and the route figures of the planner (lengthKm, maxSlopeDeg, meanSlopeDeg,
//   climbMaxDeg, descentMaxDeg, crossMaxDeg, hours, oneWayKm, oneWay, profile { x, y, km, pitch }) }
import { buildCorridor, legStats, corridorPadKm, cleanMobility, speedFactor, toPoint, MOBILITY_DEFAULTS, DEFAULT_MAX_SLOPE, MIN_POINTS, MAX_POINTS, MAX_LEG_KM } from './route-plan.js';
import { fromXY } from './terrain.js';

// Assumptions (docs/VARIABLES.md), not data.
export const RRT_DEFAULTS = Object.freeze({
  maxIter: 4000, maxTries: 5, goalBias: 0.1, linkBias: 0.2, timeBudgetMs: 45000,
  stepMinKm: 0.3, stepMaxKm: 1, stepLegDivisor: 20,
  rewireMaxSteps: 4, rewireMinSteps: 1.2, neighbours: 16,
});
export const ADJUST_RINGS_KM = Object.freeze([0.25, 0.5, 1, 2]);
export const CANDIDATES_PER_LEG = 8;
export const MAX_TREE_EDGES = 4000;
export const STEP_LABELS = Object.freeze({ init: 'Start', select: 'Select', brrt: 'B-RRT*', found: 'Path', none: 'No path', adjust: 'Adjust', add: 'Add', goal: 'Goal', abort: 'Abort' });
const TREE_BRUTE = 48;       // trees this small are searched without the hash grid

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function abortError() { const e = new Error('Route planning cancelled'); e.name = 'AbortError'; return e; }
function defaultYield() {
  if (typeof setImmediate === 'function') return new Promise((ok) => setImmediate(ok));
  if (typeof MessageChannel === 'function') return new Promise((ok) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); ok(); }; ch.port2.postMessage(0); });
  return new Promise((ok) => setTimeout(ok, 0));
}
// mulberry32
function makeRng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------- the directed edge check ----------
// edge(ax, ay, bx, by) → drive time in hours when the rover can drive a → b, -1 when not. Samples every
// quarter node (as legStats does) with the node values: on the terrain, slope under the cap, grade along
// the move within the climb / descent limits, slope across within the cross limit.
export function makeEdgeCheck(cor, mob) {
  const tc = Math.tan(mob.climbDeg * Math.PI / 180), td = Math.tan(mob.descentDeg * Math.PI / 180), tx = Math.tan(mob.crossDeg * Math.PI / 180);
  const lim = Math.max(mob.climbDeg, mob.descentDeg, mob.crossDeg);
  const { gxs, gys, slope, inv, kpp } = cor;
  return (ax, ay, bx, by) => {
    const L = Math.hypot(bx - ax, by - ay);
    if (!(L > 1e-9)) return 0;
    const steps = Math.max(1, Math.ceil(L / (kpp * 0.25))), dl = L / steps, ux = (bx - ax) / L, uy = (by - ay) / L;
    let hours = 0;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps, n = cor.nodeAt(ax + (bx - ax) * t, ay + (by - ay) * t);
      if (n < 0 || !(slope[n] <= lim)) return -1;
      const pitch = gxs[n] * ux + gys[n] * uy;
      if (!(pitch <= tc && -pitch <= td)) return -1;
      if (!(Math.abs(gxs[n] * uy - gys[n] * ux) <= tx)) return -1;
      hours += (dl * inv[n]) / (mob.speedKmh * speedFactor(pitch, mob));
    }
    return hours;
  };
}

// ---------- trees with a spatial hash grid ----------
function makeTree(cell) { return { x: [], y: [], par: [], cost: [], kids: [], grid: new Map(), cell, n: 0 }; }
const cellKey = (ix, iy) => (ix + 32768) * 65536 + (iy + 32768);
function addNode(T, x, y, par, cost) {
  const id = T.n++;
  T.x.push(x); T.y.push(y); T.par.push(par); T.cost.push(cost); T.kids.push([]);
  if (par >= 0) T.kids[par].push(id);
  const k = cellKey(Math.floor(x / T.cell), Math.floor(y / T.cell));
  const c = T.grid.get(k);
  if (c) c.push(id); else T.grid.set(k, [id]);
  return id;
}
function nearest(T, x, y) {
  let best = -1, bd = Infinity;
  if (T.n <= TREE_BRUTE) {
    for (let i = 0; i < T.n; i++) { const d = (T.x[i] - x) ** 2 + (T.y[i] - y) ** 2; if (d < bd) { bd = d; best = i; } }
    return best;
  }
  const cx = Math.floor(x / T.cell), cy = Math.floor(y / T.cell);
  for (let r = 0; r < 4000; r++) {
    for (let ix = cx - r; ix <= cx + r; ix++) {
      const edge = ix === cx - r || ix === cx + r;
      for (let iy = cy - r; iy <= cy + r; iy += edge ? 1 : 2 * r || 1) {
        const c = T.grid.get(cellKey(ix, iy));
        if (!c) continue;
        for (const id of c) { const d = (T.x[id] - x) ** 2 + (T.y[id] - y) ** 2; if (d < bd) { bd = d; best = id; } }
      }
    }
    if (best >= 0 && Math.sqrt(bd) <= r * T.cell) break;
  }
  return best;
}
// up to `max` nodes within r of (x, y), nearest first: [{ id, d }]
function near(T, x, y, r, max) {
  const out = [];
  if (T.n <= TREE_BRUTE) {
    for (let i = 0; i < T.n; i++) { const d = Math.hypot(T.x[i] - x, T.y[i] - y); if (d <= r) out.push({ id: i, d }); }
  } else {
    const i0 = Math.floor((x - r) / T.cell), i1 = Math.floor((x + r) / T.cell), j0 = Math.floor((y - r) / T.cell), j1 = Math.floor((y + r) / T.cell);
    for (let ix = i0; ix <= i1; ix++) for (let iy = j0; iy <= j1; iy++) {
      const c = T.grid.get(cellKey(ix, iy));
      if (!c) continue;
      for (const id of c) { const d = Math.hypot(T.x[id] - x, T.y[id] - y); if (d <= r) out.push({ id, d }); }
    }
  }
  out.sort((p, q) => p.d - q.d || p.id - q.id);
  return out.length > max ? out.slice(0, max) : out;
}
function pushCost(T, id, delta) {
  const stack = [id];
  while (stack.length) { const k = stack.pop(); T.cost[k] += delta; for (const c of T.kids[k]) stack.push(c); }
}
const polyLen = (pts) => { let s = 0; for (let i = 0; i + 1 < pts.length; i++) s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); return s; };

// ---------- one B-RRT* run on a leg ----------
// → { found, path: [[x, y], …] (smoothed), candidates, iterations, nodes, A, B }
async function bRrt(ctx, start, goal, tryIndex) {
  const { cor, edge, mob, rng, step, maxIter, deadline, ctl, P } = ctx;
  const A = makeTree(step), B = makeTree(step);
  addNode(A, start[0], start[1], -1, 0);
  addNode(B, goal[0], goal[1], -1, 0);
  const legKm = Math.hypot(goal[0] - start[0], goal[1] - start[1]);
  const pad = Math.min(corridorPadKm(legKm), 0.35 * legKm + 2) * (1 + 0.6 * tryIndex);
  const ex0 = cor.xOf(0), ex1 = cor.xOf(cor.W - 1), ey0 = cor.yOf(cor.H - 1), ey1 = cor.yOf(0);
  const rx0 = Math.max(ex0, Math.min(start[0], goal[0]) - pad), rx1 = Math.min(ex1, Math.max(start[0], goal[0]) + pad);
  const ry0 = Math.max(ey0, Math.min(start[1], goal[1]) - pad), ry1 = Math.min(ey1, Math.max(start[1], goal[1]) + pad);
  const area = Math.max(1e-6, (rx1 - rx0) * (ry1 - ry0)), gamma = 2 * Math.sqrt((1.5 * area) / Math.PI);
  const radius = (n) => Math.max(P.rewireMinSteps * step, Math.min(P.rewireMaxSteps * step, gamma * Math.sqrt(Math.log(Math.max(n, 2)) / n)));
  const lbScale = 0.999 * cor.invMin / mob.speedKmh;   // drive time ≥ map distance × this
  const candidates = [];
  let best = null, bestLen = Infinity, iterations = 0;

  const chain = (T, id) => { const out = []; for (let k = id; k >= 0; k = T.par[k]) out.push([T.x[k], T.y[k]]); return out; };
  const record = (a, o, e) => {
    const total = A.cost[a] + e + B.cost[o];
    const path = [...chain(A, a).reverse(), ...chain(B, o)];
    best = { a, o, e, total };
    bestLen = polyLen(path);
    candidates.push(path);
    if (candidates.length > CANDIDATES_PER_LEG) candidates.shift();
  };
  // try to link a new node of one tree to the other tree in the driving direction
  const connect = (isA, id) => {
    const T = isA ? A : B, O = isA ? B : A;
    const x = T.x[id], y = T.y[id];
    const cand = near(O, x, y, 2.5 * step, 6);
    let bt = Infinity, bo = -1, be = 0;
    const tot = (o) => (isA ? T.cost[id] + O.cost[o] : O.cost[o] + T.cost[id]);
    cand.sort((p, q) => tot(p.id) + p.d * lbScale - (tot(q.id) + q.d * lbScale));
    for (const { id: o, d } of cand) {
      const lb = tot(o) + d * lbScale;
      if (lb >= bt || (best && lb >= best.total)) break;
      const e = isA ? edge(x, y, O.x[o], O.y[o]) : edge(O.x[o], O.y[o], x, y);
      if (e < 0) continue;
      const t = tot(o) + e;
      if (t < bt) { bt = t; bo = o; be = e; }
    }
    if (bo < 0 || (best && bt >= best.total - 1e-9)) return;
    if (isA) record(id, bo, be); else record(bo, id, be);
  };
  const extend = (isA, qx, qy) => {
    const T = isA ? A : B;
    const ni = nearest(T, qx, qy);
    const dx = qx - T.x[ni], dy = qy - T.y[ni], d = Math.hypot(dx, dy);
    if (!(d > 1e-6)) return;
    const nx = d <= step ? qx : T.x[ni] + (dx / d) * step, ny = d <= step ? qy : T.y[ni] + (dy / d) * step;
    if (cor.nodeAt(nx, ny) < 0) return;
    const nb = near(T, nx, ny, radius(T.n), P.neighbours);
    const dirEdge = (id) => (isA ? edge(T.x[id], T.y[id], nx, ny) : edge(nx, ny, T.x[id], T.y[id]));
    // choose the cheapest valid parent, cheapest lower bound first
    const order = nb.map((q) => ({ ...q, lb: T.cost[q.id] + q.d * lbScale })).sort((p, q) => p.lb - q.lb || p.id - q.id);
    let par = -1, pc = Infinity;
    for (const q of order) {
      if (q.lb >= pc) break;
      const e = dirEdge(q.id);
      if (e < 0) continue;
      if (T.cost[q.id] + e < pc) { pc = T.cost[q.id] + e; par = q.id; }
    }
    if (par < 0) return;
    const id = addNode(T, nx, ny, par, pc);
    // rewire the neighbours through the new node
    for (const q of nb) {
      if (q.id === par || q.id === 0) continue;
      if (pc + q.d * lbScale >= T.cost[q.id]) continue;
      const e = isA ? edge(nx, ny, T.x[q.id], T.y[q.id]) : edge(T.x[q.id], T.y[q.id], nx, ny);
      if (e < 0 || pc + e >= T.cost[q.id] - 1e-9) continue;
      const old = T.par[q.id], kids = T.kids[old];
      kids.splice(kids.indexOf(q.id), 1);
      T.par[q.id] = id; T.kids[id].push(q.id);
      pushCost(T, q.id, pc + e - T.cost[q.id]);
    }
    connect(isA, id);
  };
  const sample = (isA) => {
    const O = isA ? B : A, u = rng();
    if (u < P.goalBias) return isA ? goal : start;
    if (u < P.goalBias + P.linkBias && O.n > 1) { const k = Math.floor(rng() * O.n); return [O.x[k], O.y[k]]; }
    for (let k = 0; k < 30; k++) {
      const x = rx0 + rng() * (rx1 - rx0), y = ry0 + rng() * (ry1 - ry0);
      if (bestLen < Infinity && Math.hypot(x - start[0], y - start[1]) + Math.hypot(x - goal[0], y - goal[1]) > bestLen * 1.25) continue;
      return [x, y];
    }
    return [rx0 + rng() * (rx1 - rx0), ry0 + rng() * (ry1 - ry0)];
  };
  const recheck = () => {
    if (!best) return;
    const total = A.cost[best.a] + best.e + B.cost[best.o];
    if (total < best.total - 1e-9) record(best.a, best.o, best.e);
  };
  for (; iterations < maxIter; iterations++) {
    if ((iterations & 7) === 0) {
      await ctl.tick(iterations / maxIter);
      if (nowMs() > deadline) break;
    }
    if ((iterations & 63) === 63) recheck();
    const isA = (iterations & 1) === 0, q = sample(isA);
    extend(isA, q[0], q[1]);
  }
  recheck();
  if (!best) return { found: false, path: null, candidates, iterations, nodes: A.n + B.n, A, B };
  // the chosen path: the best candidate, shortcut-smoothed with the same directed check at no more cost
  const raw = candidates[candidates.length - 1];
  return { found: true, path: shortcut(edge, raw), candidates, iterations, nodes: A.n + B.n, A, B };
}

// Shortcut smoothing: from each kept point jump to the farthest later point the rover can drive to directly
// at no more drive time than along the path between them.
function shortcut(edge, pts) {
  const K = pts.length, pre = [0];
  for (let i = 0; i + 1 < K; i++) { const e = edge(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]); pre.push(pre[i] + (e < 0 ? Infinity : e)); }
  const out = [pts[0]];
  let i = 0;
  while (i < K - 1) {
    let next = i + 1;
    for (let j = K - 1; j >= i + 2; j--) {
      const e = edge(pts[i][0], pts[i][1], pts[j][0], pts[j][1]);
      if (e >= 0 && e <= (pre[j] - pre[i]) * (1 + 1e-6) + 1e-9) { next = j; break; }
    }
    out.push(pts[next]);
    i = next;
  }
  return out;
}

// "Adjust Waypoints": a nearby passable spot for a goal the trees could not reach. Rings around it; spots the
// start tree plausibly reaches (a tree node close by and an edge to it) come first, then the gentlest ground.
// → [x, y] | null
function adjustGoal(ctx, goal, tree, tried, tryIndex) {
  const { cor, edge, mob, step } = ctx;
  const lim = Math.max(mob.climbDeg, mob.descentDeg, mob.crossDeg);
  let fallback = null;
  for (const r of ADJUST_RINGS_KM) {
    let best = null;
    const off = ((tryIndex * 11) % 360) * Math.PI / 180;
    for (let k = 0; k < 16; k++) {
      const ang = off + (k * Math.PI) / 8, x = goal[0] + r * Math.cos(ang), y = goal[1] + r * Math.sin(ang);
      const n = cor.nodeAt(x, y);
      if (n < 0 || !(cor.slope[n] <= lim) || tried.some((t) => Math.hypot(t[0] - x, t[1] - y) < 0.1)) continue;
      const s = cor.slope[n];
      if (!fallback || s < fallback.s) fallback = { x, y, s };
      const ni = nearest(tree, x, y);
      if (Math.hypot(tree.x[ni] - x, tree.y[ni] - y) > 2.5 * step) continue;
      if (edge(tree.x[ni], tree.y[ni], x, y) < 0) continue;
      if (!best || s < best.s) best = { x, y, s };
    }
    if (best) return [best.x, best.y];
  }
  return fallback ? [fallback.x, fallback.y] : null;
}

// ---------- the planner ----------
export async function planSelfDriving({ points, dem, maxSlopeDeg = DEFAULT_MAX_SLOPE, mobility = null, seed = 1, maxIter = RRT_DEFAULTS.maxIter, maxTries = RRT_DEFAULTS.maxTries, stepKm = null, timeBudgetMs = RRT_DEFAULTS.timeBudgetMs } = {}, opts = {}) {
  const t0 = nowMs();
  const { onProgress = null, signal = null, sliceMs = 12, yieldFn = defaultYield } = opts;
  const P = RRT_DEFAULTS;
  const climbLim = Number(maxSlopeDeg);
  const mobIn = climbLim > 0 && climbLim < 90 ? cleanMobility(mobility, climbLim) : null;
  // without mobility every limit is the climb limit; the drive speed is the default one
  const mob = mobIn ?? (climbLim > 0 && climbLim < 90 ? { climbDeg: climbLim, descentDeg: climbLim, crossDeg: climbLim, speedKmh: MOBILITY_DEFAULTS.speedKmh } : null);
  const empty = { ok: false, aborted: false, reason: null, error: null, trajectory: [], legs: [], candidates: [], candidateLegs: [], trees: [], trace: [], delayMs: 0, nodes: 0, ms: 0, seed };
  const fail = (error) => ({ ...empty, error, reason: error, ms: Math.round(nowMs() - t0) });
  if (signal?.aborted) throw abortError();
  if (!dem || !(dem.kmPerPixel > 0) || !(dem.halfKm > 0)) return fail('The terrain grid is not loaded yet.');
  if (!mob) return fail('Set a slope limit between 1° and 89°.');
  const wps = [];
  for (const p of points ?? []) {
    const q = toPoint(p);
    if (!q) return fail('Every point needs a latitude and a longitude.');
    const last = wps[wps.length - 1];
    if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < 1e-6) continue;
    wps.push(q);
  }
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

  const nLegs = wps.length - 1, tries = Math.max(1, Math.floor(maxTries)), iters = Math.max(1, Math.floor(maxIter));
  const rng = makeRng(seed);
  let sliceStart = nowMs(), legNo = 0, lastFrac = 0;
  const ctl = {
    async tick(frac) {
      if (nowMs() - sliceStart < sliceMs) return;
      const f = Math.min(0.999, (legNo + Math.max(0, Math.min(1, frac))) / nLegs);
      if (f > lastFrac) { lastFrac = f; onProgress?.(f); }
      await yieldFn();
      if (signal?.aborted) throw abortError();
      sliceStart = nowMs();
    },
  };
  const trace = [];
  const say = (step, leg, text) => trace.push({ step, leg, text });
  const legs = [], candidates = [], candidateLegs = [], treeEdges = [];
  let trajectory = [wps[0]], delayMs = 0, nodes = 0, aborted = false, reason = null;
  const acc = { len: 0, maxS: 0, slopeSum: 0, climb: 0, descent: 0, cross: 0, hours: 0, oneWayKm: 0, oneWay: [], prof: { x: [], y: [], km: [], pitch: [] } };
  say('init', -1, 'Delay = 0, overall path = []. Initialize trees.');

  let from = wps[0];
  for (let li = 0; li < nLegs; li++) {
    legNo = li;
    const to = wps[li + 1];
    const legKm = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const leg = { from, to, adjustedTo: null, tries: [] };
    legs.push(leg);
    say('select', li, `Waypoints: leg ${li + 1} of ${nLegs}, ${legKm.toFixed(1)} km.`);
    const cor = buildCorridor(dem, from, to, corridorPadKm(legKm), null);
    if (!cor) { aborted = true; reason = `Leg ${li + 1} is outside the terrain grid.`; say('abort', li, reason); break; }
    if (!(cor.slope[cor.nodeAt(from[0], from[1])] <= Math.max(mob.climbDeg, mob.descentDeg, mob.crossDeg))) {
      aborted = true; reason = `The start of leg ${li + 1} is on ground the rover cannot stand on.`; say('abort', li, reason); break;
    }
    const step = stepKm > 0 ? stepKm : Math.max(P.stepMinKm, Math.min(P.stepMaxKm, legKm / P.stepLegDivisor));
    const edge = makeEdgeCheck(cor, mob);
    const ctx = { cor, edge, mob, rng, step, maxIter: iters, ctl, P, deadline: 0 };
    let goal = to, found = null;
    const tried = [to];
    for (let ti = 0; ti < tries; ti++) {
      const remaining = timeBudgetMs - (nowMs() - t0);
      if (remaining <= 0) { reason = 'The time budget ran out.'; break; }
      ctx.deadline = nowMs() + Math.max(400, remaining / (nLegs - li + 1));
      say('brrt', li, `Growing trees from both ends${ti ? ` (try ${ti + 1} of ${tries})` : ''}.`);
      const tt = nowMs();
      const run = await bRrt(ctx, from, goal, ti);
      const ms = Math.round(nowMs() - tt);
      if (ti > 0) delayMs += ms;
      nodes += run.nodes;
      leg.tries.push({ goal, found: run.found, iterations: run.iterations, nodes: run.nodes, ms });
      for (const T of [run.A, run.B]) for (let k = 1; k < T.n; k++) { const p = T.par[k]; treeEdges.push([T.x[p], T.y[p], T.x[k], T.y[k]]); }
      for (const c of run.candidates) { candidates.push(c); candidateLegs.push(li); }
      if (run.found) { found = run; break; }
      say('none', li, `The trees did not meet (${run.iterations} iterations, ${run.nodes} nodes).`);
      if (ti + 1 >= tries) { reason = `No path to waypoint ${li + 2} after ${tries} ${tries === 1 ? 'try' : 'tries'}.`; break; }
      const ta = nowMs();
      const moved = adjustGoal(ctx, goal, run.A, tried, ti);
      delayMs += Math.round(nowMs() - ta);
      if (!moved) { reason = `No passable ground within ${ADJUST_RINGS_KM[ADJUST_RINGS_KM.length - 1]} km of waypoint ${li + 2}.`; break; }
      const m = Math.round(Math.hypot(moved[0] - goal[0], moved[1] - goal[1]) * 1000);
      say('adjust', li, `Moved the end waypoint ${m} m to ground the start tree can reach.`);
      goal = moved; tried.push(moved);
      leg.adjustedTo = moved;
    }
    if (!found) { aborted = true; reason ??= `No path for leg ${li + 1}.`; say('abort', li, reason); break; }
    say('found', li, `A path of ${found.path.length - 1} segments after ${found.iterations} iterations.`);
    // add the leg to the overall trajectory, and its figures
    trajectory.push(...found.path.slice(1));
    const st = legStats(cor, found.path, {}, new Map(), null, mob);
    acc.len += st.len; acc.slopeSum += st.slopeSum; acc.maxS = Math.max(acc.maxS, st.maxS);
    acc.climb = Math.max(acc.climb, st.climb); acc.descent = Math.max(acc.descent, st.descent); acc.cross = Math.max(acc.cross, st.cross);
    acc.hours += st.hours; acc.oneWayKm += st.oneWayKm; acc.oneWay.push(...st.oneWay);
    for (const k of ['x', 'y', 'km', 'pitch']) for (const v of st.prof[k]) acc.prof[k].push(v);
    say('add', li, `${st.len.toFixed(1)} km added to the trajectory.`);
    from = goal;
    if (li + 1 < nLegs) say('goal', li, 'Overall goal reached? No, next leg.'); else say('goal', li, 'Overall goal reached? Yes, resulting trajectory.');
    await ctl.tick(1);
  }
  if (aborted) say('goal', legs.length - 1, 'Resulting trajectory: the part driven so far.');
  onProgress?.(1);

  // candidates: the last of each leg first, at most 8 per leg (kept as found); trees thinned to the cap
  const trees = treeEdges.length > MAX_TREE_EDGES ? Array.from({ length: MAX_TREE_EDGES }, (_, i) => treeEdges[Math.floor((i * treeEdges.length) / MAX_TREE_EDGES)]) : treeEdges;
  return {
    ...empty,
    ok: !aborted && trajectory.length >= 2, aborted, reason: aborted ? reason : null, error: null,
    trajectory, points: trajectory, legs, candidates, candidateLegs, trees, trace, delayMs: Math.round(delayMs), nodes, ms: Math.round(nowMs() - t0),
    limitDeg: climbLim, mobility: mob, waypoints: wps,
    lengthKm: acc.len, maxSlopeDeg: acc.maxS, meanSlopeDeg: acc.len > 0 ? acc.slopeSum / acc.len : 0,
    climbMaxDeg: acc.climb, descentMaxDeg: acc.descent, crossMaxDeg: acc.cross, hours: acc.hours, oneWayKm: acc.oneWayKm, oneWay: acc.oneWay,
    profile: { x: Float32Array.from(acc.prof.x), y: Float32Array.from(acc.prof.y), km: Float32Array.from(acc.prof.km), pitch: Float32Array.from(acc.prof.pitch) },
  };
}

// The result for the 3D globe, in latitude / longitude: the trajectory, up to 12 candidate paths (spread over
// the legs, each up to 300 points), up to 4000 tree edges, the moved waypoints (ghost → moved) and the trace.
export function autonavPayload(result, toLatLon = fromXY) {
  if (!result) return null;
  const ll = ([x, y]) => { const p = toLatLon(x, y); const q = Array.isArray(p) ? [p[0], p[1]] : [p.latDeg, p.lonDeg]; return [Math.round(q[0] * 1e5) / 1e5, Math.round(q[1] * 1e5) / 1e5]; };
  const thin = (pts, max) => {
    if (pts.length <= max) return pts;
    return Array.from({ length: max }, (_, i) => pts[Math.round((i * (pts.length - 1)) / (max - 1))]);
  };
  const cands = result.candidates ?? [], legOf = result.candidateLegs ?? [];
  let chosen = cands.map((_, i) => i);
  if (chosen.length > 12) {
    // the last candidate of every leg (the best of it) first, then the other late ones
    const lastOf = new Map();
    chosen.forEach((i) => lastOf.set(legOf[i] ?? 0, i));
    const first = [...lastOf.values()];
    const rest = chosen.filter((i) => !first.includes(i)).reverse();
    chosen = [...first, ...rest].slice(0, 12).sort((a, b) => a - b);
  }
  return {
    trajectory: thin(result.trajectory ?? [], 2000).map(ll),
    candidates: chosen.map((i) => thin(cands[i], 300).map(ll)),
    trees: (result.trees ?? []).slice(0, MAX_TREE_EDGES).map(([x1, y1, x2, y2]) => [...ll([x1, y1]), ...ll([x2, y2])]),
    adjusted: (result.legs ?? []).filter((l) => l.adjustedTo).map((l) => ({ from: ll(l.to), to: ll(l.adjustedTo) })),
    aborted: !!result.aborted,
    reason: result.reason ?? null,
    trace: (result.trace ?? []).map((t) => `${STEP_LABELS[t.step] ?? t.step}: ${t.text}`),
  };
}
