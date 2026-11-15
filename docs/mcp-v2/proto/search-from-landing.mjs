// MCP v2 design prototype (2026-11-15): "continuous from touchdown" semantics. Same filters as search-window.mjs; a
// cell passes when Sun+Earth are both in view at landing and stay so for >= 300 h; the slip is checked every 6 h over
// [L, L+7 d]. Shows why the strict reading is infeasible: each hour of slip removes an hour of the run, so surviving
// a 7-day slip needs a >= 468 h run. Run from the repo root:
//   node docs/mcp-v2/proto/search-from-landing.mjs 2027-10-07
import { loadCoreContext } from '../../../tools/core-context.mjs';
const ctx = loadCoreContext({ dem240: false });
const { grid, slope, shadow } = ctx.coarse; const eph = ctx.eph;
const H = 3600e3;
const [y, m, d] = (process.argv[2] || '2027-01-13').split('-').map(Number);
const L0 = Date.UTC(y, m - 1, d), SLIP_H = 7 * 24, NEED = 300, SLIP_STEP = 6;
const n = SLIP_H + NEED + 1;
const dirs = []; for (let s = 0; s < n; s++) dirs.push(eph.at(L0 + (s + 0.5) * H));
const cand = []; for (let k = 0; k < grid.count; k++) if (slope[k] <= 5 && shadow[k] >= 1 && shadow[k] <= 10 && grid.cellCenter(k).latDeg <= -80) cand.push(k);
const t0 = performance.now(); const bits = new Uint8Array(n); let onDay = 0, robust = 0; const out = [];
for (const k of cand) {
  for (let s = 0; s < n; s++) bits[s] = grid.visibility(k, dirs[s]) === 3 ? 1 : 0;
  const run = new Uint16Array(n + 1); for (let s = n - 1; s >= 0; s--) run[s] = bits[s] ? run[s + 1] + 1 : 0;
  if (run[0] >= NEED) onDay++;
  let worst = Infinity, firstFail = null;
  for (let o = 0; o <= SLIP_H; o += SLIP_STEP) { worst = Math.min(worst, run[o]); if (run[o] < NEED && firstFail === null) firstFail = o; }
  if (run[0] >= NEED) out.push({ k, h0: run[0], worst, firstFail });
  if (firstFail === null) robust++;
}
console.log({ landing: process.argv[2] || '2027-01-13', prefiltered: cand.length, passOnLandingDay: onDay, robustTo7DaySlip: robust, ms: Math.round(performance.now() - t0) });
out.sort((a, b) => (b.firstFail ?? 999) - (a.firstFail ?? 999) || b.h0 - a.h0);
for (const r of out.slice(0, 5)) { const c = grid.cellCenter(r.k); console.log(`${c.latDeg.toFixed(2)} ${c.lonDeg.toFixed(2)} slope ${slope[r.k]}° psr ${shadow[r.k]} km  run from landing ${r.h0} h, worst ${r.worst} h, first fails at ${r.firstFail === null ? 'never' : '+' + r.firstFail + ' h'}`); }
