// MCP v2 A1: find_landing_sites, a read-only cap/region search over the shared terrain and ephemeris.
// T0 coverage → T1 static → T2 hourly series/slip → T3 four 1 km children + exact skyline → T4 spacing.
// Returns evaluated candidates, diagnostic near misses/relaxations, and a held search reference.
import { resolveCriteria, activeChecks, evaluate, onlyFailure, CRITERIA_SCHEMA } from '../criteria.js';
import { pointTimeline, pointMetrics, staticMetrics } from '../point-eval.js';
import { toXY } from '../terrain.js';
import { bodyAzEl } from '../ephemeris.js';
import { STATIC_IDS, sampleSeries, seriesMetrics, scanLandings, landingSet, checkMargin, inRegion, spacedPicks } from '../search.js';

const H = 3600e3, D = 24 * H;
const SCREEN_BUDGET = 80_000_000, DIAGNOSTIC_BUDGET = 2_000_000, LANDING_BUDGET = 4_000_000;
const REFINE_CELLS = 60;
const PROXY = 'ice data not loaded: PSR distance used as a proxy for possible ice (no temperature data)';
const LIMIT = 'a first-look screen, not a certified landing analysis';
// Light changes over a few hundred metres on ridges and rims (Shackleton's ridge is lit while the 2 km cell centre
// 0.8 km away is dark for 325 h on 2027-01-13), so a grid search cannot see ridge-top spots.
// Metrics depend only on the instant: landings a day apart with slip offsets every 6 h read each instant ~7 times.
const memo = (read) => { const seen = new Map(); return (t) => { if (!seen.has(t)) seen.set(t, read(t)); return seen.get(t); }; };
const RIDGE = 'Ridge tops and crater rims narrower than about 1 km are missed by the 1–2 km grid: check named sites or exact points with check_slip_robustness or landing_windows.';
const r1 = (v) => typeof v === 'number' ? Number.isFinite(v) ? Math.round(v * 10) / 10 : null : v;
const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';
const rounded = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'ice_target').map(([k, v]) => [k, typeof v === 'number' ? (k.startsWith('nasa_avg_') ? Math.round(v * 10000) / 10000 : r1(v)) : v]));
const coords = (s) => `${Math.abs(s.latDeg).toFixed(1)}°S ${s.lonDeg.toFixed(1)}°E`;
const compare = (a, b) => b.result.score - a.result.score || b.result.tieScore - a.result.tieScore || a.k - b.k;

function screenGround(sources, pack, k, criteria) {
  const site = pack.grid.cellCenter(k), n = sources.nasa?.sample(site.xKm, site.yKm);
  const psr = pack.shadow?.[k] ?? null;
  return {
    slope_deg: pack.slope?.[k] ?? null, psr_km: psr, inside_psr: psr === null ? null : psr === 0,
    ice_target_km: criteria.ice ? (sources.ice ? sources.ice.distKm(pack.grid.cellKm, k, criteria.ice.class) : psr) : null,
    ice_source: criteria.ice ? (sources.ice ? 'diviner' : 'psr_proxy') : null,
    nasa_avg_sun: Number.isFinite(n?.sunPct) ? n.sunPct / 100 : null,
    nasa_avg_earth: Number.isFinite(n?.earthPct) ? n.earthPct / 100 : null,
  };
}

function evaluateOut(criteria, result) {
  const ev = evaluate(criteria, result.worst);
  return { ...ev, checks: ev.checks.map((c) => ({ ...c, value: c.id.startsWith('nasa_avg_') ? c.value : r1(c.value), margin: r1(c.margin) })) };
}

export function findTools(kit) {
  const { ctx, eph } = kit, { obj, PLACE_OBJ, LANDING } = kit.schema;
  const num = (minimum, maximum) => ({ type: 'number', minimum, ...(maximum === undefined ? {} : { maximum }) });
  const bbox = obj({ lat_min: num(-90, 90), lat_max: num(-90, 90), lon_min: num(-360, 360), lon_max: num(-360, 360) }, ['lat_min', 'lat_max', 'lon_min', 'lon_max']);
  const schema = obj({
    region: { type: ['string', 'object'], properties: { within_km: num(0, 1000), of: PLACE_OBJ, bbox }, additionalProperties: false },
    landing: LANDING, landing_window: obj({ from: LANDING, to: LANDING }, ['from', 'to']),
    landing_step_h: { type: 'integer', minimum: 6, maximum: 720 },
    slip: obj({ from_days: num(0, 60), to_days: num(0, 60), step_h: { type: 'integer', minimum: 1, maximum: 1440 } }),
    criteria: CRITERIA_SCHEMA, rank_by: { type: 'string', enum: ['margin', 'both_continuous', 'robustness', 'ice_distance'] },
    count: { type: 'integer', minimum: 1, maximum: 60 }, min_spacing_km: num(0, 1000), refine: { type: 'boolean' },
    detail: { type: 'string', enum: ['brief', 'standard', 'full'] },
  });

  async function find(input) {
    const start = performance.now(), timing = {};
    if (!ctx.coarse?.grid) return kit.err('The 2 km terrain grid is not loaded; find_landing_sites needs it.');
    if (input.landing !== undefined && input.landing_window !== undefined) return kit.err('Give landing or landing_window, not both.');
    const resolved = resolveCriteria(input.criteria ?? { preset: 'lander_dte' });
    if (resolved.error) return kit.err(resolved.error);
    const { criteria, assumed } = resolved;
    const count = input.count ?? 5, spacing = input.min_spacing_km ?? 10, refine = input.refine ?? true;
    const detail = input.detail ?? 'standard', rankBy = input.rank_by ?? 'margin', stepH = input.landing_step_h ?? 24;
    const stayH = criteria.stay_days * 24, checks = activeChecks(criteria), staticChecks = checks.filter((c) => STATIC_IDS.includes(c.id));
    const targetCriteria = rankBy === 'ice_distance' && !criteria.ice ? { ...criteria, ice: { class: 'any', within_km: 20, depth_max_m: 1 } } : criteria;
    if (targetCriteria !== criteria) assumed.push('ice_distance ranking uses any thermally stable ice class, without imposing an ice-distance constraint');
    if (rankBy === 'robustness') assumed.push('robustness ranks the last passing requested slip offset, then worst relative check margin; without slip it reduces to margin ranking');
    let fromMs = null;
    if (criteria.continuous_from === 'from_time') {
      const t = kit.parseInstant(criteria.from_time, 'criteria.from_time');
      if (t.error) return t;
      fromMs = t.ms; criteria.from_time = iso(t.ms);
    }
    const slip = input.slip ? { from_days: input.slip.from_days ?? 0, to_days: input.slip.to_days ?? 7, step_h: input.slip.step_h ?? 6 } : null;
    if (slip && (slip.from_days > slip.to_days || !Number.isInteger(slip.from_days * 24) || !Number.isInteger(slip.to_days * 24))) {
      return kit.err('slip needs from_days ≤ to_days and endpoints at whole hours.');
    }
    const offsetsH = [];
    if (slip) {
      for (let h = slip.from_days * 24; h <= slip.to_days * 24; h += slip.step_h) offsetsH.push(h);
      if (offsetsH.at(-1) !== slip.to_days * 24) offsetsH.push(slip.to_days * 24);
      assumed.push(`slip checked at ${slip.step_h} h intervals, including both endpoints; all ${offsetsH.length} offsets must pass`);
    } else offsetsH.push(0);
    const maxOffset = offsetsH.at(-1), lastValid = Math.floor((eph.endMs - (maxOffset + stayH) * H) / H) * H;
    let first, last, mode;
    if (input.landing !== undefined) {
      const l = kit.parseLanding(input.landing, 'landing'); if (l.error) return l;
      first = last = l.ms; mode = 'landing';
      if (last > lastValid) return kit.err('The full stay including slip must fit inside the ephemeris; choose an earlier landing or shorter stay/slip.');
    } else if (input.landing_window) {
      const a = kit.parseLanding(input.landing_window.from, 'landing_window.from'); if (a.error) return a;
      const b = kit.parseInstant(input.landing_window.to, 'landing_window.to'); if (b.error) return b;
      first = a.ms; last = Math.floor(b.ms / H) * H; mode = 'window';
      if (last < first) return kit.err('landing_window.from must be no later than to.');
      if (last > lastValid) { last = lastValid; assumed.push('landing window trimmed to landings with the complete stay and slip inside the ephemeris'); }
    } else { first = eph.startMs; last = lastValid; mode = 'any_date'; }
    if (last < first) return kit.err('No landing in this range has a complete stay and slip inside the ephemeris.');
    const landings = [];
    for (let t = first; t <= last; t += stepH * H) landings.push(t);
    assumed.push(`landings snapped down to the hour; ${mode === 'landing' ? 'one planned landing' : `landing grid every ${stepH} h; full stays only`}`);
    let region = input.region ?? 'cap', regionEcho = region;
    if (typeof region === 'string') {
      if (region !== 'cap') return kit.err('region must be cap, { within_km, of }, or { bbox }.');
    } else if (region.bbox && region.of === undefined && region.within_km === undefined) {
      if (region.bbox.lat_min > region.bbox.lat_max) return kit.err('bbox.lat_min must be no larger than lat_max.');
    } else if (region.bbox === undefined && region.of && region.within_km !== undefined) {
      const p = kit.resolvePlace(region.of); if (p.error) return p;
      const [xKm, yKm] = toXY(p.site.latDeg, p.site.lonDeg);
      regionEcho = { within_km: region.within_km, of: { lat_deg: p.site.latDeg, lon_deg: p.site.lonDeg } };
      region = { within_km: region.within_km, center: { xKm, yKm } };
    } else return kit.err('region must use exactly one of { within_km, of } and { bbox }.');
    const query = {
      region: regionEcho, mode, ...(mode === 'landing' ? { landing: iso(first) } : { landing_window: { from: iso(first), to: iso(landings.at(-1)) } }),
      landing_step_h: stepH, landing_count: landings.length, slip, criteria, rank_by: rankBy, count, min_spacing_km: spacing, refine, detail,
    };
    const sources = { coarse: ctx.coarse, nasa: ctx.nasa, psr: ctx.psr, ice: targetCriteria.ice ? await kit.provided(ctx.ice) : null };
    if (!sources.ice && (criteria.ice || rankBy === 'ice_distance')) assumed.push(PROXY);
    if (criteria.ice?.class === 'shallow' && sources.ice && criteria.ice.depth_max_m !== (sources.ice.shallowMaxM ?? 1)) assumed.push(`ice distance screen uses the pack's shallow depth (${sources.ice.shallowMaxM ?? 1} m); the requested ${criteria.ice.depth_max_m} m depth is applied at refinement, so coarse screening may omit targets`);
    if (targetCriteria.ice?.class === 'any' && sources.ice?.meta?.classes?.any) assumed.push(`ice class any follows the loaded pack: ${sources.ice.meta.classes.any}`);
    if (criteria.slope_scale !== '2km') assumed.push(`2 km slope used for initial screening; ${criteria.slope_scale} slope requires refinement`);
    const grid = ctx.coarse.grid, funnel = [{ stage: 'all_cells', cells: grid.count }], regionCells = [];
    let coverage = 0;
    for (let k = 0; k < grid.count; k++) {
      const site = grid.cellCenter(k);
      if (site.latDeg <= -80) coverage++;
      if (inRegion(site, region)) regionCells.push(k);
    }
    funnel.push({ stage: 'coverage_80S', cells: coverage }, { stage: 'region', cells: regionCells.length });
    timing.T0_region = performance.now() - start;
    let tick = performance.now();
    const groundByK = new Map(), survivors = [], staticNear = [], staticCounts = staticChecks.map(() => 0);
    for (const k of regionCells) {
      const ground = screenGround(sources, ctx.coarse, k, targetCriteria); groundByK.set(k, ground);
      let alive = true, failures = 0;
      for (let i = 0; i < staticChecks.length; i++) {
        if (checkMargin(staticChecks[i], ground[staticChecks[i].metric]) < 0) { alive = false; failures++; }
        if (alive) staticCounts[i]++;
      }
      if (alive) survivors.push(k); else if (failures === 1) staticNear.push(k);
    }
    staticChecks.forEach((c, i) => funnel.push({ stage: c.id, cells: staticCounts[i] }));
    timing.T1_static = performance.now() - tick; tick = performance.now();
    const seriesStart = first + offsetsH[0] * H, seriesEnd = landings.at(-1) + (maxOffset + stayH) * H;
    const dirs = [];
    for (let t = seriesStart; t < seriesEnd; t += H) dirs.push(eph.at(t));
    const options = { criteria, checks, landings, offsetsH, rankBy };
    const peaks = criteria.sun_elevation_min_deg != null || criteria.earth_elevation_min_deg != null;
    function readGrid(series, site, t, within = false) {
      const m = seriesMetrics(series, t, { continuous_from: within ? 'within_stay' : criteria.continuous_from, fromMs });
      if (peaks && m) {
        let sun = -Infinity, earth = -Infinity;
        for (let u = t; u <= t + stayH * H; u += H) {
          const p = bodyAzEl(eph, site, u); if (p) { sun = Math.max(sun, p.sun.elDeg); earth = Math.max(earth, p.earth.elDeg); }
        }
        m.sun_peak_deg = Number.isFinite(sun) ? sun : null; m.earth_peak_deg = Number.isFinite(earth) ? earth : null;
      }
      return m;
    }
    function scanCell(pack, k, ground, diagnostic = true) {
      const series = sampleSeries(pack.grid, k, dirs, seriesStart, stayH), site = pack.grid.cellCenter(k);
      const scan = scanLandings(memo((t) => readGrid(series, site, t)), ground, { ...options, withinReader: diagnostic && criteria.continuous_from !== 'within_stay' && checks.some((c) => c.id.includes('continuous')) ? memo((t) => readGrid(series, site, t, true)) : null });
      return { k, site, ground, scan, result: scan.best ?? scan.near, cellKm: pack.grid.cellKm };
    }
    // Bound expensive work by sample count, never elapsed time, so partial searches are reproducible.
    // A capped search takes the cells most likely to pass first: the highest NASA 18.6-year share of the
    // bodies the time checks need (min of Sun and Earth for "both" checks). Without those averages, evenly
    // distributed indices keep the search spread across the region. Ties keep grid order (deterministic).
    // Metrics are read once per distinct instant (memo); landing × offset pairs then only compare numbers.
    const instants = new Set(); for (const t of landings) for (const o of offsetsH) instants.add(t + o * H);
    const evalCost = instants.size + (landings.length * offsetsH.length) / 8;
    const limit = Math.max(1, Math.floor(Math.min(SCREEN_BUDGET / dirs.length, LANDING_BUDGET / (evalCost * 2), peaks ? 2_000_000 / (landings.length * offsetsH.length * stayH * 2) : Infinity)));
    const needSun = checks.some((c) => /^(both|sun)_|^longest_dark|^sun_/.test(c.id)), needEarth = checks.some((c) => /^(both|earth)_|^earth_/.test(c.id));
    const priority = (k) => {
      const g = groundByK.get(k), s = g.nasa_avg_sun, e = g.nasa_avg_earth;
      if (needSun && needEarth) return Number.isFinite(s) && Number.isFinite(e) ? Math.min(s, e) : null;
      if (needEarth) return Number.isFinite(e) ? e : null;
      return Number.isFinite(s) ? s : null;
    };
    const ranked = survivors.length > limit && survivors.every((k) => priority(k) !== null);
    const selected = survivors.length <= limit ? survivors
      : ranked ? survivors.map((k, i) => [k, priority(k), i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).slice(0, limit).map((x) => x[0]).sort((a, b) => a - b)
        : Array.from({ length: limit }, (_, i) => survivors[Math.floor(i * survivors.length / limit)]);
    let partial = selected.length < survivors.length;
    if (partial) funnel.push({ stage: 'work_budget', cells: selected.length });
    const rows = selected.map((k) => scanCell(ctx.coarse, k, groundByK.get(k)));
    const timeChecks = checks.filter((c) => !STATIC_IDS.includes(c.id));
    timeChecks.forEach((c, i) => funnel.push({ stage: c.id, cells: rows.filter((r) => r.scan.stages[i]).length }));
    const passing = rows.filter((r) => r.scan.best);
    funnel.push({ stage: 'slip', cells: passing.length });
    timing.T2_time = performance.now() - tick; tick = performance.now();
    const misses = rows.filter((r) => !r.scan.best && r.result && onlyFailure(evaluate(criteria, r.result.worst)));
    // One-static-check failures need time evaluation too, otherwise an advertised relaxation may be false.
    const diagnosticLimit = Math.min(staticNear.length, Math.floor(Math.min(DIAGNOSTIC_BUDGET / dirs.length, 100_000 / evalCost, peaks ? 100_000 / (landings.length * offsetsH.length * stayH) : Infinity)));
    const diagnosticRows = [];
    if (passing.length < count) {
      for (let i = 0; i < diagnosticLimit; i++) {
        const k = staticNear[Math.floor(i * staticNear.length / diagnosticLimit)], row = scanCell(ctx.coarse, k, groundByK.get(k), false);
        diagnosticRows.push(row);
        if (row.result && onlyFailure(evaluate(criteria, row.result.worst))) misses.push(row);
      }
    }
    timing.diagnostics = performance.now() - tick; tick = performance.now();
    let finalists = passing, refined = 0, exactChecked = 0, refinedMiss = 0, exactMiss = 0;
    const limits = [LIMIT, 'Hourly screening can miss short visibility interruptions; only refined candidates have point-skyline checks.',
      'Near 80°S the screening skylines (240 m terrain, ±324 km) are cut short toward the equator, so the screen can overstate visibility there; the exact check uses the 480 m terrain out to ±457 km, at least ~150 km beyond any cell, where farther terrain sits below the curvature dip.',
      'Only the best 60 passing 2 km cells are refined; an empty refined set does not prove the entire region infeasible.',
      RIDGE,
      'PSR distance uses patches ≥ 1 km²; the proxy science target is the nearest PSR pixel and may belong to a smaller patch.'];
    // Ridge tops and crater rims are narrower than a 2 km cell: a cell whose centre fails a time check can
    // hold a point that passes. When the screen leaves room, refine cells that failed one or two time checks
    // too (closest to passing first); the point-skyline check decides.
    const deficit = (r) => {
      const fails = evaluate(criteria, r.result.worst).checks.filter((c) => !c.pass);
      if (!fails.length || fails.length > 2 || fails.some((c) => STATIC_IDS.includes(c.id))) return null;
      return fails.reduce((sum, c) => sum + (Number.isFinite(c.margin) ? -c.margin / Math.max(1, Math.abs(c.need)) : 1), 0);
    };
    const timeMisses = passing.length >= REFINE_CELLS ? [] : rows.filter((r) => !r.scan.best && r.result)
      .map((r) => [r, deficit(r)]).filter(([, d]) => d !== null).sort((a, b) => a[1] - b[1] || compare(a[0], b[0])).map(([r]) => r);
    if (refine && (passing.length || timeMisses.length)) {
      sources.fine = await kit.provided(ctx.fine);
      sources.dem240 = criteria.slope_scale === '240m' ? await kit.provided(ctx.dem240) : null;
      if (!sources.fine || (!ctx.dem && !ctx.skylineFor)) return kit.err('refine requires the 1 km grid and point terrain skyline; load them or set refine: false.');
      finalists = [];
      const fine = sources.fine;
      const refineLimit = Math.max(1, Math.min(REFINE_CELLS, Math.floor(LANDING_BUDGET / (evalCost * 5))));
      if (Math.min(REFINE_CELLS, passing.length) > refineLimit) { partial = true; limits.push(`Refinement limited to ${refineLimit} parents by the deterministic landing/offset budget.`); }
      const parents = [...passing].sort(compare).concat(timeMisses).slice(0, refineLimit);
      if (parents.length > passing.length) limits.push(`Also refined ${parents.length - Math.min(passing.length, refineLimit)} cells that failed one or two time checks on the 2 km screen: narrow ridges can pass at a point.`);
      const fromScreen = new Set(passing);
      for (const parent of parents) {
        const isMiss = !fromScreen.has(parent);
        let bestChild = null;
        for (const dx of [-0.5, 0.5]) for (const dy of [-0.5, 0.5]) {
          const k = fine.grid.cellAt(parent.site.xKm + dx, parent.site.yKm + dy);
          if (k == null || !inRegion(fine.grid.cellCenter(k), region)) continue;
          const site = fine.grid.cellCenter(k), ground = screenGround(sources, fine, k, targetCriteria);
          // Use the requested slope scale and the PSR pixel at refinement, rather than a coarse proxy.
          const exactGround = staticMetrics(sources, site, targetCriteria);
          Object.assign(ground, exactGround);
          const child = scanCell(fine, k, ground, false);
          if (!bestChild || child.result.failures < bestChild.result.failures || (child.result.failures === bestChild.result.failures && compare(child, bestChild) < 0)) bestChild = child;
        }
        if (!bestChild) continue;
        if (isMiss) refinedMiss++; else refined++;
        const { site, ground } = bestChild, horizon = kit.horizonOf(site);
        if (!horizon.terrain) return kit.err('Point terrain skyline unavailable at a refined candidate; exact checks cannot use a smooth horizon.');
        const tl = pointTimeline(eph, site, horizon.mask, seriesStart, seriesEnd);
        const read = memo((t) => pointMetrics(tl, t, stayH * H, { continuous_from: criteria.continuous_from, fromMs, eph, peaks }));
        const scan = scanLandings(read, ground, options); exactChecked++;
        const row = { ...bestChild, scan, result: scan.best ?? scan.near, exact: true };
        if (row.result) {
          // Compare the same point, landing and offset set, not two independently selected best dates.
          const series = sampleSeries(fine.grid, row.k, dirs, seriesStart, stayH);
          const screen = landingSet((t) => seriesMetrics(series, t, { continuous_from: criteria.continuous_from, fromMs }), ground, options, row.result.landingMs);
          row.screenedVsExact = Object.fromEntries(['both_continuous_h', 'both_from_landing_h', 'longest_both_h', 'both_total_h', 'longest_dark_h'].map((key) => [key, { screened: r1(screen.metrics[key]), exact: r1(row.result.metrics[key]) }]));
          if (detail === 'full') row.matrix = landingSet(read, ground, { ...options, full: true }, row.result.landingMs).matrix;
        }
        if (scan.best) { finalists.push(row); if (isMiss) exactMiss++; }
        else if (row.result && onlyFailure(evaluate(criteria, row.result.worst))) misses.push(row);
      }
      // The funnel's main path stays monotone; screen near misses checked at a point are a side branch.
      funnel.push({ stage: 'refined_1km', cells: refined }, { stage: 'exact', cells: finalists.length - exactMiss });
      if (refinedMiss) funnel.push({ stage: 'refined_near_misses', cells: refinedMiss, branch: true }, { stage: 'exact_near_misses', cells: exactMiss, branch: true });
    }
    timing.T3_refine = performance.now() - tick; tick = performance.now();
    const picks = spacedPicks(finalists, count, spacing);
    for (const row of picks) if (!row.exact) {
      if (targetCriteria.ice) row.scienceTarget = staticMetrics(sources, row.site, targetCriteria).ice_target;
      if (detail === 'full') {
        const series = sampleSeries(grid, row.k, dirs, seriesStart, stayH);
        row.matrix = landingSet((t) => readGrid(series, row.site, t), row.ground, { ...options, full: true }, row.result.landingMs).matrix;
      }
    }
    const candidates = picks.map((row, i) => {
      const r = row.result, m = { ...r.metrics }; delete m.ice_target;
      const target = row.ground.ice_target ?? row.scienceTarget;
      return {
        ref: `S${i + 1}`, lat_deg: r1(row.site.latDeg), lon_deg: r1(row.site.lonDeg), coords: coords(row.site), cell_km: row.cellKm,
        ...(mode === 'landing' ? { landing: iso(r.landingMs) } : { best_landing: iso(r.landingMs) }), passing_landings: row.scan.passingLandings,
        eval: { ...evaluateOut(criteria, r), screened: !row.exact }, metrics: rounded(m), metrics_landing: iso(r.landingMs + offsetsH[0] * H), screened_vs_exact: row.screenedVsExact ?? null,
        slip: { survives_all: r.pass, worst: rounded(r.worst), first_fail_h: r.firstFailH, fail_reason: r.failReason },
        science_target: target ? { kind: target.cls ?? criteria.ice?.class ?? 'psr_proxy', lat_deg: r1(target.latDeg), lon_deg: r1(target.lonDeg), dist_km: r1(target.distKm), source: row.ground.ice_source } : null,
        headline: `Candidate S${i + 1} passes ${row.exact ? 'point-skyline' : 'hourly grid'} checks with ${r1(r.metrics.both_continuous_h)} h of continuous Sun and Earth visibility.`,
        ...(detail === 'full' ? { landing_checks: row.matrix?.map((v) => ({ offset_h: v.offset_h, metrics: rounded(v.metrics), eval: evaluateOut(criteria, { worst: v.metrics }) })) ?? [] } : {}),
      };
    });
    funnel.push({ stage: 'spaced_picks', cells: candidates.length });
    const searchId = kit.refs.put('search', { candidates: picks.map((p, i) => ({ ...candidates[i], ref: `S${i + 1}`, latDeg: p.site.latDeg, lonDeg: p.site.lonDeg })), query, assumed }, { prefix: 's' });
    const nearMisses = [...misses].sort((a, b) => Number(!!b.exact) - Number(!!a.exact) || compare(a, b)).slice(0, 5).map((row, i) => {
      const c = onlyFailure(evaluate(criteria, row.result.worst));
      return { ref: `N${i + 1}`, lat_deg: r1(row.site.latDeg), lon_deg: r1(row.site.lonDeg), landing: iso(row.result.landingMs), fails: row.exact ? 'exact_check' : c.id, check: c.id, value: r1(c.value), need: c.need, margin: r1(c.margin), ...(c.unavailable ? { unavailable: true } : {}), ...(c.beyond ? { beyond: true } : {}) };
    });
    const diagnostic = [...rows, ...diagnosticRows];
    const feasibility = explainFeasibility({ criteria, checks, funnel, rows: diagnostic, misses, candidates, count, slip, partial, refined: refined + refinedMiss, exactChecked, spacing });
    if (feasibility.status !== 'ok') feasibility.why = `${feasibility.why} ${RIDGE}`;
    timing.T4_rank = performance.now() - tick; timing.total = performance.now() - start;
    if (partial) limits.push(`Deterministic budgets (${SCREEN_BUDGET} hourly samples, ${LANDING_BUDGET} landing/offset evaluations): searched ${selected.length} of ${survivors.length} static survivors (${ranked ? `those with the highest NASA 18.6-year ${needSun && needEarth ? 'Sun-and-Earth' : needEarth ? 'Earth' : 'Sun'} share first` : 'spread evenly across the region'}); refinement may also be limited. This is not an exhaustive result.`);
    const about = kit.about({
      units: { hours: 'h', angles: 'degrees', distances: 'polar stereographic map km', nasa_avg: 'fraction, 0–1', times: 'UTC' },
      resolution: { screen: '2 km cells, 1 h samples', refine: refine ? 'four 1 km children per top cell; 480 m point skyline, 15 min scan, crossings to 1 min' : 'disabled' },
      conventions: [kit.conv.VISIBLE_CONV, 'Each hourly sample is at the LEFT endpoint and represents [t,t+1h); touchdown uses that instant, totals and runs weight the final fractional hour.', 'Continuous checks are clipped to each stay; available_both_from_landing_h is a separate, span-limited diagnostic.', 'Complete stay and slip coverage is required; the last eligible any-date landing precedes the ephemeris end.', 'Candidate metrics use the first requested slip offset (metrics_landing); eval uses the worst value per check over every offset.', 'Margin ranking uses the minimum raw relative check margin; robustness ranks the last passing tested offset then that margin; other stable ties use grid index then earliest landing.'], limits,
    });
    about.timing_ms = Object.fromEntries(Object.entries(timing).map(([k, v]) => [k, r1(v)]));
    about.diagnostics = { evaluated_static_near_misses: diagnosticRows.length, total_static_near_misses: staticNear.length, relaxations: 'screen-level lower bounds from evaluated cells; not exact or spacing-filtered' };
    const headline = `${candidates.length} ${refine ? 'refined' : 'screened'} landing candidates found${partial ? ' in a partial search' : ''}; feasibility is ${feasibility.status}.`;
    const out = { search_id: searchId, query_echo: query, assumed, partial, ...(partial ? { partial_reason: about.limits.at(-1) } : {}), funnel, candidates, near_misses: nearMisses, feasibility, headline, about };
    if (detail !== 'brief') return out;
    // A brief has a compact envelope; the full resolved query/assumptions remain held with search_id.
    // References retain precise coordinates even though human-facing coordinate fields round to 0.1°.
    return {
      search_id: searchId, query_echo: { search_id: searchId, detail: 'brief' }, assumed: ['Resolved defaults and assumptions held with search_id.', ...(assumed.includes(PROXY) ? [PROXY] : [])],
      headline, partial, candidates: candidates.slice(0, 5).map((c) => c.ref),
      numbers: { candidates: candidates.length, screened: selected.length, exact: exactChecked, best_both_h: candidates[0]?.metrics.both_continuous_h ?? null },
      feasibility: { status: feasibility.status, binding: feasibility.binding },
      about: { units: { best_both_h: 'h' }, resolution: '2 km hourly; refined 1 km + 480 m/15 min', limits: [LIMIT], timing_ms: { total: r1(timing.total) } },
    };
  }
  return { specs: [{ name: 'find_landing_sites', description: 'Search lunar south-polar landing sites by terrain, visibility, science-target and launch-slip constraints; refine candidates and explain infeasibility. A first-look screen, not a certified landing analysis.', schema }], handlers: { find_landing_sites: find } };
}

function explainFeasibility({ criteria, checks, funnel, rows, misses, candidates, count, slip, partial, refined, exactChecked, spacing }) {
  const status = candidates.length >= count ? 'ok' : candidates.length ? 'thin' : 'infeasible';
  const frequency = new Map();
  for (const r of rows) {
    if (!r.result) continue;
    const ev = evaluate(criteria, r.result.worst), id = ev.limiting ?? ev.tightest;
    if (id) frequency.set(id, (frequency.get(id) ?? 0) + 1);
  }
  let binding = [...frequency].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  for (let i = 1; i < funnel.length; i++) if (funnel[i].cells === 0 && funnel[i - 1].cells > 0) {
    if (checks.some((c) => c.id === funnel[i].stage)) binding = funnel[i].stage;
    else if (funnel[i].stage === 'region') binding = 'region';
    else if (funnel[i].stage === 'exact') binding = misses.find((r) => r.exact)?.result?.failReason ?? 'exact_check';
    break;
  }
  const check = checks.find((c) => c.id === binding), relaxations = [];
  let maxAchievable = null;
  if (check) {
    const available = rows.filter((r) => r.scan.achievable[binding]).sort((a, b) => checkMargin(check, b.scan.achievable[binding].value) - checkMargin(check, a.scan.achievable[binding].value));
    const best = available[0];
    if (best) maxAchievable = { metric: check.metric, value: r1(best.scan.achievable[binding].value), lat_deg: r1(best.site.latDeg), lon_deg: r1(best.site.lonDeg), landing: iso(best.scan.achievable[binding].landingMs), source: 'hourly_screen' };
    const one = rows.filter((r) => r.scan.relaxable[binding]).map((r) => r.scan.relaxable[binding]);
    one.sort((a, b) => checkMargin(check, b.value) - checkMargin(check, a.value));
    if (one.length) {
      const target = one[Math.min(count, one.length) - 1].value;
      // Round outward so the advertised numeric change actually admits these raw values.
      const value = (check.kind === 'min' ? Math.floor(target * 10) : Math.ceil(target * 10)) / 10;
      let change;
      if (binding === 'ice') change = { ice: { ...criteria.ice, within_km: value } };
      else if (check.kind === 'range') change = { [binding]: { ...check.need, ...(target < (check.need.min ?? -Infinity) ? { min: Math.floor(target * 10) / 10 } : { max: value }) } };
      else change = { [binding]: value };
      const adjusted = activeChecks({ ...criteria, ...change }).find((c) => c.id === binding);
      const unlocks = one.filter((r) => checkMargin(adjusted, r.value) >= 0).length;
      relaxations.push({ change, unlocks });
    }
  }
  if (slip) {
    const max = rows.reduce((v, r) => Math.max(v, r.scan.slipToH ?? -Infinity), -Infinity);
    if (Number.isFinite(max) && max < slip.to_days * 24) relaxations.push({ change: { slip: { ...slip, to_days: max / 24 } }, unlocks: rows.filter((r) => r.scan.slipToH !== null && r.scan.slipToH >= max).length });
  }
  if (binding?.includes('continuous') && criteria.continuous_from !== 'within_stay') relaxations.push({ change: { continuous_from: 'within_stay' }, unlocks: rows.filter((r) => r.scan.withinStay).length });
  let why = `${candidates.length} of ${count} requested candidates pass after ${spacing} km spacing${binding ? `; binding check: ${binding}` : ''}.`;
  if (check && maxAchievable) why += ` Required ${JSON.stringify(check.need)}; best hourly-screen ${check.metric} with the other checks satisfied: ${maxAchievable.value} at ${maxAchievable.landing}.`;
  if (!candidates.length && !rows.length) why = `No evaluated cells remain after ${binding ?? 'coverage, region and static filters'}.`;
  if (binding === 'both_continuous_h_min' && slip && criteria.continuous_from === 'from_landing' && slip.step_h <= criteria.both_continuous_h_min) {
    const span = (slip.to_days - slip.from_days) * 24, need = criteria.both_continuous_h_min, required = need + span;
    const bestRun = rows.filter((r) => r.scan.maxRun && checks.filter((c) => STATIC_IDS.includes(c.id)).every((c) => checkMargin(c, r.ground[c.metric]) >= 0)).sort((a, b) => b.scan.maxRun.value - a.scan.maxRun.value)[0];
    why = `From touchdown, each hour of slip removes an hour from an unbroken Sun+Earth run: ${need} h + ${span} h slip requires at least ${required} h from the first tested landing (slip sampled every ${slip.step_h} h).`;
    if (bestRun) {
      const v = bestRun.scan.maxRun;
      why += ` The longest sampled starting run among evaluated static survivors is ${r1(v.value)} h at ${coords(bestRun.site)} on ${iso(v.landingMs + slip.from_days * D)}.`;
      maxAchievable = { ...maxAchievable, available_both_from_landing_h: r1(v.value), at: { lat_deg: r1(bestRun.site.latDeg), lon_deg: r1(bestRun.site.lonDeg), landing: iso(v.landingMs + slip.from_days * D) } };
    }
  }
  if (!candidates.length && exactChecked) why += ` ${exactChecked} points were checked exactly out of ${refined} refined parents; none passed.`;
  if (partial) why += ' This is a partial search, so infeasible describes only the evaluated cells.';
  return { status, binding, why, max_achievable: maxAchievable, relaxations: relaxations.sort((a, b) => b.unlocks - a.unlocks) };
}
