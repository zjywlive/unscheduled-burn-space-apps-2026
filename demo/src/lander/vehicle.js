// The vehicle: every number here is an ASSUMPTION for a generic medium robotic lander (no real vehicle's
// data). The page labels each one "assumed" and lets the user edit it; cleanVehicle() clamps the edits.
// Order of magnitude is set against published landers (docs/LANDER.md §4): Apollo LM descent stage
// (45 kN, Isp 311 s, throttle 10–60 %), Intuitive Machines Nova-C (~1.9 t wet), ispace HAKUTO-R (~1 t wet).
import { G0 } from './constants.js';

export const VEHICLE_DEFAULTS = Object.freeze({
  name: 'Generic robotic lander (assumed)',
  dryMassKg: 800,            // structure, avionics, payload, landing legs; residuals included
  propellantKg: 1400,        // usable bipropellant at trans-lunar injection separation
  mainThrustN: 4500,         // one throttleable main engine
  ispS: 320,                 // vacuum Isp, typical MMH/MON bipropellant
  throttleMin: 0.3,          // deep throttle floor; must allow hover at landing mass (T·min < m·g_moon)
  throttleMax: 1.0,
  // power
  arrayPowerW: 1200,         // array output with the Sun on the array normal at 1 AU, unshaded
  arrayTracking: 'one-axis', // 'one-axis' | 'fixed' (body-mounted, normal along +Y body)
  batteryWh: 3000,           // Li-ion capacity
  batteryMinSoc: 0.2,        // never discharge below this fraction
  loadsW: Object.freeze({
    cruise: 320,             // avionics, heaters, radio low rate
    orbit: 380,              // + star tracker and radio high rate
    descent: 650,            // + engine valves, altimeter/velocimeter, hazard lidar
    surface: 220,
    safe: 180,               // safe mode: heaters and receiver only
  }),
  // landing
  touchdown: Object.freeze({
    maxVerticalMs: 2.0,      // stricter than the Apollo LM design case (10 ft/s ≈ 3.0 m/s)
    maxHorizontalMs: 1.0,    // Apollo LM 4 ft/s ≈ 1.2 m/s
    maxSlopeDeg: 10,         // Apollo LM 12°; most robotic landers quote 8–15°
  }),
  reserveDvMs: 60,           // propellant kept back for dispersions, never planned into a burn
  // launcher upper stage that performs trans-lunar injection (the lander does not)
  tliStage: Object.freeze({ dryMassKg: 3000, ispS: 450 }),   // LOX/LH2 class (RL10B-2 ≈ 465 s)
});

const num = (v, lo, hi, def) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);

// Fills missing fields with the defaults and clamps edits to physical ranges.
export function cleanVehicle(v = {}) {
  const d = VEHICLE_DEFAULTS;
  const loads = v.loadsW ?? {};
  const td = v.touchdown ?? {};
  const tli = v.tliStage ?? {};
  const throttleMax = num(v.throttleMax, 0.05, 1, d.throttleMax);
  return {
    name: typeof v.name === 'string' && v.name ? v.name : d.name,
    dryMassKg: num(v.dryMassKg, 50, 1e5, d.dryMassKg),
    propellantKg: num(v.propellantKg, 0, 1e5, d.propellantKg),
    mainThrustN: num(v.mainThrustN, 10, 1e6, d.mainThrustN),
    ispS: num(v.ispS, 50, 1000, d.ispS),
    throttleMin: Math.min(throttleMax, num(v.throttleMin, 0, 1, d.throttleMin)),
    throttleMax,
    arrayPowerW: num(v.arrayPowerW, 0, 1e5, d.arrayPowerW),
    arrayTracking: v.arrayTracking === 'fixed' ? 'fixed' : 'one-axis',
    batteryWh: num(v.batteryWh, 0, 1e6, d.batteryWh),
    batteryMinSoc: num(v.batteryMinSoc, 0, 0.9, d.batteryMinSoc),
    loadsW: Object.fromEntries(Object.keys(d.loadsW).map((k) => [k, num(loads[k], 0, 1e5, d.loadsW[k])])),
    touchdown: {
      maxVerticalMs: num(td.maxVerticalMs, 0.1, 10, d.touchdown.maxVerticalMs),
      maxHorizontalMs: num(td.maxHorizontalMs, 0.05, 10, d.touchdown.maxHorizontalMs),
      maxSlopeDeg: num(td.maxSlopeDeg, 1, 45, d.touchdown.maxSlopeDeg),
    },
    reserveDvMs: num(v.reserveDvMs, 0, 2000, d.reserveDvMs),
    tliStage: { dryMassKg: num(tli.dryMassKg, 0, 1e6, d.tliStage.dryMassKg), ispS: num(tli.ispS, 50, 1000, d.tliStage.ispS) },
  };
}

export const wetMassKg = (v) => v.dryMassKg + v.propellantKg;
export const exhaustVelocityMs = (v) => v.ispS * G0;
// kg/s at a throttle setting (fraction of mainThrustN)
export const massFlowKgS = (v, throttle = 1) => (v.mainThrustN * throttle) / exhaustVelocityMs(v);
// thrust acceleration, m/s², at full throttle (or the given throttle) for a given mass
export const thrustAccelMs2 = (v, massKg, throttle = 1) => (v.mainThrustN * throttle) / massKg;
