// Power along the whole mission: attitude mode per phase, solar array output (incidence, eclipse by the Moon or
// Earth, terrain skyline after landing), loads, and the battery state of charge. Built on power.js; the vehicle
// numbers are the assumptions in vehicle.js.
import { attitudeForPhase, powerAt } from './power.js';
import { unit } from './vec.js';

// mission phase ids that power.js does not know, mapped to the nearest one it does
const PHASE_MAP = { 'approach-moon': 'coast', 'descent-coast': 'llo' };
// sampling step per phase, seconds (fine where things change fast)
const STEP_S = { leo: 30, tli: 10, coast: 1800, 'approach-moon': 300, loi: 10, llo: 60, doi: 2, 'descent-coast': 30, braking: 2, approach: 1, terminal: 1, landed: 60 };

export const modeForPhase = (phaseId) => attitudeForPhase(PHASE_MAP[phaseId] ?? phaseId);

// plan: planMission() result. panelAzDeg: azimuth the fixed panel faces after landing (default: the Sun's azimuth
// at touchdown, i.e. the lander is set down facing the Sun; an assumption the page states).
export function powerTimeline(plan, { initialSoc = 1, panelAzDeg = null } = {}) {
  const v = plan.vehicle;
  const ts = [];
  for (const ph of plan.phases) {
    const dt = (STEP_S[ph.id] ?? 60) * 1000;
    const n = Math.max(1, Math.ceil((ph.endMs - ph.startMs) / dt));
    for (let i = 0; i < n; i++) ts.push(ph.startMs + ((ph.endMs - ph.startMs) * i) / n);
  }
  ts.push(plan.times.endMs);
  const land = plan.stateAt(plan.times.landingMs).local;
  const panelAz = Number.isFinite(panelAzDeg) ? panelAzDeg : land?.sun?.azDeg ?? 0;
  const N = ts.length;
  const t = new Float64Array(N), gen = new Float32Array(N), load = new Float32Array(N), soc = new Float32Array(N), factor = new Float32Array(N);
  const mode = new Array(N), lit = new Uint8Array(N);
  let s = Math.max(0, Math.min(1, initialSoc)), minSoc = s, minSocMs = ts[0];
  for (let i = 0; i < N; i++) {
    const st = plan.stateAt(ts[i]);
    const m = modeForPhase(st.phase);
    const up = unit(st.pos);
    const p = powerAt(v, m, {
      sunDir: st.sunDir, burnDir: st.thrustDir ?? up, up, panelAzDeg: panelAz,
      sunAzDeg: st.local?.sun?.azDeg ?? undefined, sunElDeg: st.local?.sun?.elDeg ?? undefined,
      lit: st.sunlit, inLunarOrbit: st.body === 'moon',
    });
    t[i] = ts[i]; gen[i] = p.generationW; load[i] = p.loadW; factor[i] = p.factor; mode[i] = m; lit[i] = st.sunlit ? 1 : 0;
    if (i > 0) {
      const dtS = (ts[i] - ts[i - 1]) / 1000;
      const net = (gen[i - 1] - load[i - 1]) * dtS / 3600;   // Wh over the previous step
      s = v.batteryWh > 0 ? Math.max(0, Math.min(1, s + net / v.batteryWh)) : 0;
    }
    soc[i] = s;
    if (s < minSoc) { minSoc = s; minSocMs = ts[i]; }
  }
  function index(tMs) {
    let lo = 0, hi = N - 1;
    if (tMs <= t[0]) return 0;
    if (tMs >= t[hi]) return hi;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= tMs) lo = mid; else hi = mid; }
    return lo;
  }
  function at(tMs) {
    const i = index(tMs);
    return { generationW: gen[i], loadW: load[i], soc: soc[i], factor: factor[i], mode: mode[i], lit: !!lit[i] };
  }
  return { t, gen, load, soc, factor, mode, lit, minSoc, minSocMs, belowMin: minSoc < v.batteryMinSoc, panelAzDeg: panelAz, at };
}
