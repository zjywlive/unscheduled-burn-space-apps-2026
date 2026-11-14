// Heat computation plan for the Map view (task book phase 3 §4.2–§4.8). Owns the fraction jobs and what
// is derived from them: the full 2 km map job, the 1 km viewport job (zoom ≥ 2), one job per region
// and one for the route, plus the filter masks and suitability scores of each job, worked out row by
// row as the job progresses. A new date, stay or viewport replaces a job; the old one is dropped, so
// rows of old and new jobs never mix.
//
// createHeatPlan({ eph, coarse }) → plan; a tier is { grid, inside, slope, shadow, label, cellKm }
//   plan.setFine(tier)                      the 1 km tier, once horizon_1km, slope_1km and shadow_1km are in
//   plan.configure(cfg)                     cfg: { p0, a0, len, mode, viewport, maxSlope, maxDark, weights,
//                                           altBlocked, regions: { A, B }, route: points | null, keepFull }
//   plan.step(budgetMs) → working           runs the most urgent pending jobs
//   plan.nowLayer(tMs) → { tier, states, rect, full }   Now mode (fix H2.3): the visibility states on
//                                           the finest grid for the viewport (1 km at zoom ≥ 2, else 2 km)
//   plan.nowAt(xKm, yKm, tMs) → { tier, cell, state } | null   the real cell value under a point
import { fractionJob, topCells, nowStates } from './heat.js';
import { filterMask, scoreCells } from './score.js';
import { regionStats, routeProfile } from './region.js';
import { maskFor, sampleLine } from './map/shapes.js';
import { viewBounds } from './map/view.js';

export const FINE_ZOOM = 2;
// G (2026-11-13 round 3): the 1 km grid only once the view holds at most this many of its cells. Right after
// zoom 2 the window still shows most of the map (about 190,000 cells at 1728×996), which took 12–14 s to
// compute while the 2 km map was already done; the smoothed 2 km picture stands in until the view is
// smaller (about zoom 3.6 at 1728×996, 3.2 at 1440×900).
export const FINE_MAX_CELLS = 60000;
export function fineFits(fine, viewport, bounds = null) {
  if (!fine || !(viewport?.zoom >= FINE_ZOOM)) return false;
  const r = viewRect(fine.grid, viewport, 2, bounds);
  return (r.i1 - r.i0 + 1) * (r.j1 - r.j0 + 1) <= FINE_MAX_CELLS;
}
const RANKED = ['both', 'sun', 'earth', 'score'];

// Absolute rows [from, to) that a job has finished, given its rect.
function doneRows(job) {
  return job.rect.j0 + (job.done ? job.total : job.rows);
}

// Whether cell k has a value in job.
export function computed(job, size, k) {
  if (!job || k === null || k === undefined) return false;
  const j = Math.floor(k / size), i = k - j * size, r = job.rect;
  if (i < r.i0 || i > r.i1 || j < r.j0 || j >= doneRows(job)) return false;
  return !job.mask || job.mask[k] !== 0;
}

// Filter mask and score of one job, extended over the rows finished since the last call.
function derive(job, tier, cfg) {
  const size = tier.grid.size;
  const d = job.derived ??= { fKey: null, fRow: 0, filtered: null, sKey: null, sRow: 0, score: null };
  const end = doneRows(job);
  const active = cfg.maxSlope != null || cfg.maxDark != null;
  if (active) {
    const key = `${cfg.maxSlope}|${cfg.maxDark}`;
    if (d.fKey !== key) { d.fKey = key; d.fRow = job.rect.j0; d.filtered ??= new Uint8Array(tier.grid.count); d.filtered.fill(0); }
    if (d.fRow < end) {
      const a = d.fRow * size, b = end * size;
      d.filtered.set(filterMask({ slope: tier.slope.subarray(a, b), dark: job.dark.subarray(a, b), maxSlope: cfg.maxSlope, maxDark: cfg.maxDark, count: b - a }), a);
      d.fRow = end;
    }
  }
  if (cfg.mode === 'score' || cfg.needScore) {
    const w = cfg.weights;
    const key = `${w.sun},${w.earth},${w.slope},${w.shadow}`;
    if (d.sKey !== key) { d.sKey = key; d.sRow = job.rect.j0; d.score ??= new Float32Array(tier.grid.count); d.score.fill(NaN); }
    if (d.sRow < end) {
      const a = d.sRow * size, b = end * size;
      d.score.set(scoreCells({ sun: job.sun.subarray(a, b), earth: job.earth.subarray(a, b), slope: tier.slope.subarray(a, b), shadowKm: tier.shadow.subarray(a, b), weights: w, count: b - a }), a);
      d.sRow = end;
    }
  }
  return { filtered: active ? d.filtered : null, score: cfg.mode === 'score' || cfg.needScore ? d.score : null };
}

function sameRect(a, b) {
  return a && b && a.i0 === b.i0 && a.j0 === b.j0 && a.i1 === b.i1 && a.j1 === b.j1;
}
function containsRect(outer, inner) {
  return outer && inner && outer.i0 <= inner.i0 && outer.j0 <= inner.j0 && outer.i1 >= inner.i1 && outer.j1 >= inner.j1;
}

// The cells of a tier's grid that touch the viewport, two cells extra on every side.
// bounds (km) is the ground under the frame when it is not the viewport's square (phase 4 big layout).
export function viewRect(grid, viewport, pad = 2, bounds = null) {
  const b = bounds ?? viewBounds(viewport), c = grid.cellKm, h = grid.halfKm, last = grid.size - 1;
  const clampI = (v) => Math.max(0, Math.min(last, v));
  return {
    i0: clampI(Math.floor((b.x0 + h) / c) - pad), i1: clampI(Math.ceil((b.x1 + h) / c) - 1 + pad),
    j0: clampI(Math.floor((h - b.y1) / c) - pad), j1: clampI(Math.ceil((h - b.y0) / c) - 1 + pad),
  };
}

function andMask(mask, inside) {
  for (let k = 0; k < mask.length; k++) if (!inside[k]) mask[k] = 0;
  return mask;
}

export function createHeatPlan({ eph, coarse }) {
  let fine = null;
  let cfg = { mode: 'both', weights: { sun: 40, earth: 30, slope: 20, shadow: 10 }, maxSlope: null, maxDark: null };
  const full = { planned: null, alt: null, pk: '', ak: '' };
  const view = { planned: null, alt: null, key: '', rect: null };
  const regions = { A: null, B: null };
  let route = null;

  const timeKey = () => `${cfg.p0}|${cfg.len}`;

  function configure(next) {
    cfg = { ...cfg, ...next };
    const { p0, a0, len, mode } = cfg;
    const tk = timeKey();
    const fineOn = fineFits(fine, cfg.viewport, cfg.bounds ?? null);

    // regions and the route: the finest loaded grid, only the cells they cover
    for (const slot of ['A', 'B']) {
      const shape = cfg.regions?.[slot] ?? null;
      if (!shape) { regions[slot] = null; continue; }
      const tier = fine ?? coarse;
      const key = `${tk}|${tier.label}`;
      const r = regions[slot];
      if (r && r.shape === shape && r.key === key) continue;
      const m = maskFor(shape, tier.grid);
      const mask = andMask(m.mask, tier.inside);
      let count = 0;
      for (let k = 0; k < mask.length; k++) count += mask[k];
      const job = tier === coarse || !m.rect || !count ? null : fractionJob(tier.grid, eph, p0, p0 + len, { rect: m.rect, mask });
      regions[slot] = { shape, key, tier, mask, rect: m.rect, count, job };
    }
    const points = cfg.route ?? null;
    if (!points) route = null;
    else {
      const tier = fine ?? coarse;
      const key = `${tk}|${tier.label}`;
      if (!route || route.points !== points || route.key !== key) {
        const samples = sampleLine(points, 0.5, 2000);
        let job = null;
        if (tier !== coarse) {
          const mask = new Uint8Array(tier.grid.count);
          const rect = { i0: Infinity, j0: Infinity, i1: -1, j1: -1 };
          for (const s of samples) {
            const k = tier.grid.cellAt(s.xKm, s.yKm);
            if (k === null || k === undefined || !tier.inside[k]) continue;
            mask[k] = 1;
            const j = Math.floor(k / tier.grid.size), i = k - j * tier.grid.size;
            rect.i0 = Math.min(rect.i0, i); rect.i1 = Math.max(rect.i1, i); rect.j0 = Math.min(rect.j0, j); rect.j1 = Math.max(rect.j1, j);
          }
          if (rect.i1 >= 0) job = fractionJob(tier.grid, eph, p0, p0 + len, { rect, mask });
        }
        route = { points, key, tier, samples, job };
      }
    }

    // the full 2 km map: shown at zoom < 2, and the source of the finding, the best cells and the
    // pass share at every zoom; also what 2 km regions and routes read
    const coarseUsers = (regions.A && !regions.A.job) || (regions.B && !regions.B.job) || (route && !route.job);
    const needFull = mode !== 'now' || coarseUsers || cfg.keepFull;
    if (needFull && full.pk !== tk) { full.planned = fractionJob(coarse.grid, eph, p0, p0 + len); full.pk = tk; }
    if (!needFull) { full.planned = null; full.pk = ''; }
    const altKey = `${a0}|${len}`;
    if (mode === 'change' && !cfg.altBlocked) {
      if (full.ak !== altKey) { full.alt = fractionJob(coarse.grid, eph, a0, a0 + len); full.ak = altKey; }
    }

    // the 1 km viewport job (zoom ≥ 2): kept while the new viewport stays inside its cells
    if (fineOn && mode !== 'now' && !(mode === 'change' && cfg.altBlocked)) {
      const rect = viewRect(fine.grid, cfg.viewport, 2, cfg.bounds ?? null);
      const key = `${tk}|${mode === 'change' ? altKey : ''}`;
      if (view.key !== key || !containsRect(view.rect, rect)) {
        view.planned = fractionJob(fine.grid, eph, p0, p0 + len, { rect, mask: fine.inside });
        view.alt = mode === 'change' ? fractionJob(fine.grid, eph, a0, a0 + len, { rect, mask: fine.inside }) : null;
        view.key = key; view.rect = rect;
      }
    } else {
      view.planned = null; view.alt = null; view.key = ''; view.rect = null;
    }
  }

  // Groups of jobs from the most to the least urgent; each frame works on the first unfinished group.
  function groups() {
    const visible = view.planned ? [view.planned, view.alt] : [full.planned, cfg.mode === 'change' ? full.alt : null];
    return [
      visible,
      [full.planned, cfg.mode === 'change' && !cfg.altBlocked ? full.alt : null],
      [regions.A?.job, regions.B?.job],
      [route?.job],
    ].map((g) => g.filter((j) => j && !j.done));
  }

  function step(budgetMs) {
    const g = groups().find((x) => x.length);
    if (!g) return false;
    for (const j of g) j.run(budgetMs / g.length);
    return groups().some((x) => x.length);
  }

  // What the map draws: the 2 km layer and, at zoom ≥ 2 with the 1 km grid in, the 1 km viewport layer.
  function layers() {
    const out = [];
    const add = (tier, job, alt) => {
      if (!job) return;
      const d = derive(job, tier, cfg);
      out.push({ tier, job, alt, filtered: d.filtered, score: d.score });
    };
    add(coarse, full.planned, cfg.mode === 'change' ? full.alt : null);
    if (view.planned) add(fine, view.planned, view.alt);
    return out;
  }

  // Now mode (fix H2.3). Before, Now always used the 2 km states that main.js computed over the whole
  // map, so a zoomed-in Now view showed 2 km squares. Here the states come from the 1 km grid for the
  // cells under the viewport (plus two, like the fraction jobs) once the 1 km grid is in and zoom ≥ 2,
  // and from the whole 2 km grid otherwise (unchanged). A layer is kept while the time is the same and
  // the viewport stays inside its rect. The states carry the Sun / Earth margins for the smoothed display.
  let nowCache = null;
  function nowLayer(tMs) {
    const fineOn = fineFits(fine, cfg.viewport, cfg.bounds ?? null);
    const tier = fineOn ? fine : coarse;
    const rect = fineOn ? viewRect(fine.grid, cfg.viewport, 2, cfg.bounds ?? null) : null;
    const c = nowCache;
    if (c && c.t === tMs && c.tier === tier && (!rect || containsRect(c.rect, rect))) return c.layer;
    const states = fineOn ? nowStates(tier.grid, eph, tMs, { rect, mask: tier.inside }) : nowStates(tier.grid, eph, tMs);
    const layer = { tier, states, rect: rect ?? { i0: 0, j0: 0, i1: tier.grid.size - 1, j1: tier.grid.size - 1 }, full: !fineOn };
    nowCache = { t: tMs, tier, rect: layer.rect, layer };
    return layer;
  }
  function nowAt(xKm, yKm, tMs) {
    const l = nowLayer(tMs);
    const k = l.tier.grid.cellAt(xKm, yKm);
    if (k === null || k === undefined || !l.tier.inside[k]) return null;
    const j = Math.floor(k / l.tier.grid.size), i = k - j * l.tier.grid.size, r = l.rect;
    if (i < r.i0 || i > r.i1 || j < r.j0 || j > r.j1) return null;
    return { tier: l.tier, cell: k, state: l.states[k] };
  }

  // The value at a map point from the finest layer that has computed it.
  function infoAt(xKm, yKm) {
    const ls = layers().reverse();
    for (const l of ls) {
      const k = l.tier.grid.cellAt(xKm, yKm);
      if (k === null || k === undefined || !l.tier.inside[k]) continue;
      const ready = computed(l.job, l.tier.grid.size, k) && (cfg.mode !== 'change' || computed(l.alt, l.tier.grid.size, k));
      if (!ready && l !== ls[ls.length - 1]) continue;
      return {
        tier: l.tier, cell: k, ready,
        sun: ready ? l.job.sun[k] : null, earth: ready ? l.job.earth[k] : null, both: ready ? l.job.both[k] : null,
        darkH: ready ? l.job.dark[k] : null,
        score: ready && l.score ? l.score[k] : null,
        altBoth: ready && l.alt ? l.alt.both[k] : null,
        slopeDeg: l.tier.slope[k],
        pass: !l.filtered ? null : ready ? !l.filtered[k] : null,
      };
    }
    // no job (Now mode): the static numbers of the finest grid that covers the point
    const tier = fineFits(fine, cfg.viewport, cfg.bounds ?? null) ? fine : coarse;
    const k = tier.grid.cellAt(xKm, yKm);
    if (k === null || k === undefined || !tier.inside[k]) return null;
    return { tier, cell: k, ready: false, slopeDeg: tier.slope[k], darkH: null, pass: null };
  }

  const fullDone = () => !!full.planned?.done && (cfg.mode !== 'change' || cfg.altBlocked || !!full.alt?.done);
  const visibleDone = () => groups()[0].length === 0;
  const allDone = () => groups().every((g) => g.length === 0);

  // Share of the mapped area that passes the filters (null without a filter or before the 2 km map is done).
  function passShare() {
    if (cfg.maxSlope == null && cfg.maxDark == null) return null;
    if (!full.planned?.done) return null;
    const { filtered } = derive(full.planned, coarse, cfg);
    let n = 0, p = 0;
    for (let k = 0; k < coarse.grid.count; k++) if (coarse.inside[k]) { n++; if (!filtered[k]) p++; }
    return n ? p / n : null;
  }

  // The 2 km values of a ranked mode with filtered and off-map cells set to 0.
  function rankedValues(mode) {
    if (!full.planned?.done || !RANKED.includes(mode)) return null;
    const d = derive(full.planned, coarse, { ...cfg, needScore: mode === 'score' });
    const src = mode === 'score' ? d.score : full.planned[mode];
    const out = new Float32Array(coarse.grid.count);
    for (let k = 0; k < out.length; k++) out[k] = coarse.inside[k] && !(d.filtered && d.filtered[k]) && Number.isFinite(src[k]) ? src[k] : 0;
    return out;
  }

  // Share of the mapped area at or above `threshold` in the current mode, filtered cells counting as below.
  function shareAtLeast(mode, threshold) {
    const v = rankedValues(mode);
    if (!v) return null;
    let n = 0, hit = 0;
    for (let k = 0; k < v.length; k++) if (coarse.inside[k]) { n++; if (v[k] >= threshold) hit++; }
    return n ? hit / n : null;
  }

  function best(mode, count = 5) {
    const v = rankedValues(mode);
    if (!v) return [];
    return topCells(v, full.planned.sun, coarse.grid, { count, minKm: 20 }).filter((cell) => v[cell] > 0).map((cell) => ({ cell, value: v[cell] }));
  }

  function region(slot) {
    const r = regions[slot];
    if (!r) return null;
    const job = r.job ?? (r.tier === coarse ? full.planned : null);
    if (!r.count || !job) {
      return { tier: r.tier, shape: r.shape, progress: 1, stats: regionStats({ grid: r.tier.grid, mask: r.mask, rect: r.rect, job: null, mode: cfg.mode, stayMs: cfg.len }) };
    }
    const d = derive(job, r.tier, { ...cfg, needScore: true });
    const stats = regionStats({ grid: r.tier.grid, mask: r.mask, rect: r.rect, job, slope: r.tier.slope, score: d.score, filtered: d.filtered, mode: cfg.mode, stayMs: cfg.len });
    // figures are final once no cell of the region is pending, even if the job (the 2 km map) runs on
    const progress = stats.pending ? Math.min(0.99, job.progress) : 1;
    return { tier: r.tier, shape: r.shape, progress, done: !stats.pending, stats };
  }

  function routeResult(dem) {
    if (!route) return null;
    const job = route.job ?? (route.tier === coarse ? full.planned : null);
    const d = job ? derive(job, route.tier, cfg) : { filtered: null };
    const prof = routeProfile({ samples: route.samples, dem, grid: route.tier.grid, job, slope: route.tier.slope, filtered: d.filtered });
    return { ...prof, progress: job ? job.progress : 1, done: job ? job.done : true, tier: route.tier };
  }

  return {
    setFine(tier) { fine = tier; },
    get fine() { return fine; },
    coarse,
    configure, step, layers, infoAt, fineOn: () => fineFits(fine, cfg.viewport, cfg.bounds ?? null), passShare, shareAtLeast, best, region, routeResult, nowLayer, nowAt,
    fullDone, visibleDone, allDone,
    get full() { return full; },
    get viewJob() { return view.planned; },
    get config() { return cfg; },
  };
}
