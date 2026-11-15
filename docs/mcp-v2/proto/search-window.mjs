// MCP v2 design prototype (2026-11-15): the 2 km grid search behind find_landing_sites, "anywhere in the stay" semantics.
// Filters: >= 80°S, 2 km cell slope <= 5°, distance to a PSR patch 1–10 km; then the longest uninterrupted Sun+Earth
// run inside a 30-day stay, for every daily landing in [L, L+7 d]. Not refined, no ice data. Run from the repo root:
//   node docs/mcp-v2/proto/search-window.mjs 2027-01-13
import { loadCoreContext } from '../../../tools/core-context.mjs';
const ctx = loadCoreContext({ dem240: false });
const { grid, slope, shadow } = ctx.coarse; const eph = ctx.eph;
const H = 3600e3;
const [y, m, d] = (process.argv[2] || '2027-01-13').split('-').map(Number);
const L0 = Date.UTC(y, m - 1, d), SLIP = 7, STAY = 30, NEED = 300;
const n = (SLIP + STAY) * 24;
const dirs = []; for (let s = 0; s < n; s++) dirs.push(eph.at(L0 + (s + 0.5) * H));
const cand = []; for (let k = 0; k < grid.count; k++) if (slope[k] <= 5 && shadow[k] >= 1 && shadow[k] <= 10 && grid.cellCenter(k).latDeg <= -80) cand.push(k);
const t0 = performance.now(); const bits = new Uint8Array(n); let onDay = 0, robust = 0; const best = [];
for (const k of cand) {
  for (let s = 0; s < n; s++) bits[s] = grid.visibility(k, dirs[s]);
  let worst = Infinity, base = 0;
  for (let l = 0; l <= SLIP; l++) {
    let run = 0, longest = 0;
    for (let s = l * 24; s < l * 24 + STAY * 24; s++) { if (bits[s] === 3) { if (++run > longest) longest = run; } else run = 0; }
    if (l === 0) base = longest; worst = Math.min(worst, longest);
  }
  if (base >= NEED) onDay++;
  if (worst >= NEED) { robust++; best.push({ k, worst, base }); }
}
console.log({ landing: process.argv[2] || '2027-01-13', cells: grid.count, prefiltered: cand.length, passOnLandingDay: onDay, robustTo7DaySlip: robust, ms: Math.round(performance.now() - t0) });
best.sort((a, b) => b.worst - a.worst);
for (const b of best.slice(0, 5)) { const c = grid.cellCenter(b.k); console.log(`${c.latDeg.toFixed(2)} ${c.lonDeg.toFixed(2)} slope ${slope[b.k]}° psr ${shadow[b.k]} km  longest both: ${b.base} h on the day, ${b.worst} h worst over the slip`); }
