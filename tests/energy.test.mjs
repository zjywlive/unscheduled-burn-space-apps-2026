import test from 'node:test';
import assert from 'node:assert/strict';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { summarize, summarizePair } from '../demo/src/windows.js';
import {
  panelNormal, incidence, panelFactor, sunSeries, litHours, powerSeries, energyOf, bestFixed,
  bestAngleAt, simulate, minBattery, planEnergy, planEnergyPair, cleanAssumptions, ENERGY_DEFAULTS,
} from '../demo/src/energy.js';
import { syntheticData } from './helpers/synthetic.mjs';

const H = 3600e3, D = 24 * H;
const RAD = Math.PI / 180;
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// A hand-made series: bins with a given Sun direction and lit share, one hour each.
const fakeSeries = (bins) => ({ startMs: 0, endMs: bins.length * H, bins: bins.map((b, k) => ({ t0: k * H, dtH: 1, skylineDeg: 0, ...b })) });

test('cosine law: tracking vertical panel gives cos el, horizontal gives sin el, both floored at 0', () => {
  for (const el of [0, 1.5, 5, 30, 60, 89]) {
    assert.ok(close(panelFactor('track', 123, el), Math.cos(el * RAD)));
    assert.ok(close(panelFactor('flat', 123, el), Math.sin(el * RAD)));
  }
  assert.equal(panelFactor('flat', 10, -2), 0);
  // a vertical panel still catches a Sun slightly below the local horizontal (skyline below 0° on a peak)
  assert.ok(close(panelFactor('track', 10, -2), Math.cos(2 * RAD)));
});

test('cosine law: fixed panel incidence is n·s, and 0 when the Sun is behind the face', () => {
  // vertical, facing north (az 0); Sun at az 60°, el 10° → cos el · cos 60°
  assert.ok(close(panelFactor('fixed', 60, 10, { tiltDeg: 90, azDeg: 0 }), Math.cos(10 * RAD) * Math.cos(60 * RAD)));
  // tilt 30° facing az 200°; Sun at az 200°, el 60° → normal on the Sun
  assert.ok(close(panelFactor('fixed', 200, 60, { tiltDeg: 30, azDeg: 200 }), 1));
  // Sun behind a vertical panel
  assert.equal(panelFactor('fixed', 180, 5, { tiltDeg: 90, azDeg: 0 }), 0);
  // tilt 0 is horizontal: same as 'flat'
  assert.ok(close(panelFactor('fixed', 77, 20, { tiltDeg: 0, azDeg: 300 }), Math.sin(20 * RAD)));
  // general formula sinβ cos el cos(az − γ) + cosβ sin el
  const b = 40, g = 100, az = 130, el = 15;
  const want = Math.sin(b * RAD) * Math.cos(el * RAD) * Math.cos((az - g) * RAD) + Math.cos(b * RAD) * Math.sin(el * RAD);
  assert.ok(close(incidence(panelNormal(b, g), az, el), want));
});

test('power is zero when the Sun is behind terrain and scales with the lit share of a bin', () => {
  const s = fakeSeries([{ azDeg: 90, elDeg: 3, litFrac: 0 }, { azDeg: 90, elDeg: 3, litFrac: 0.25 }, { azDeg: 90, elDeg: 3, litFrac: 1 }]);
  const p = powerSeries(s, 'track');
  assert.equal(p[0], 0);
  assert.ok(close(p[1], 0.25 * Math.cos(3 * RAD)));
  assert.ok(close(p[2], Math.cos(3 * RAD)));
});

test('energy conservation: generated − consumed = change in charge + spilled − unmet', () => {
  // a Sun that goes up and down, with partial bins, large enough swings to fill and empty the battery
  const bins = [];
  for (let k = 0; k < 400; k++) {
    const lit = (k % 100) < 45 ? 1 : (k % 100) === 45 ? 0.4 : 0;
    bins.push({ azDeg: (k * 15) % 360, elDeg: 2 + 3 * Math.sin(k / 7), litFrac: lit });
  }
  const s = fakeSeries(bins);
  for (const a of [{}, { panelToLoad: 0.7, batteryHours: 10, sleepLoad: 0.3, initialCharge: 0.5 }, { panelToLoad: 5, batteryHours: 200 }]) {
    const p = powerSeries(s, 'track');
    const r = simulate(s, p, a);
    const lhs = r.generatedH - r.consumedH;
    const rhs = r.soc[r.soc.length - 1] - r.soc[0] + r.spilledH - r.unmetH;
    assert.ok(close(lhs, rhs, 1e-9), `${lhs} vs ${rhs}`);
    const C = cleanAssumptions(a).batteryHours;
    assert.ok(r.soc.every((x) => x >= 0 && x <= C + 1e-12));
    assert.ok(close(r.sleepH + r.litH, 400));
  }
});

test('all lit: tracking panel at the horizon above the load never drains the battery', () => {
  const s = fakeSeries(Array.from({ length: 300 }, (_, k) => ({ azDeg: k % 360, elDeg: 1, litFrac: 1 })));
  const r = simulate(s, powerSeries(s, 'track'), { panelToLoad: 2, batteryHours: 24, sleepLoad: 0.1 });
  assert.equal(r.emptyH, 0);
  assert.equal(r.unmetH, 0);
  assert.equal(r.sleepH, 0);
  assert.equal(r.chargingH, 300);
  assert.equal(r.minBatteryH, 0);
  assert.ok(r.soc.every((x) => close(x, 24)));
  // generated 2 cos 1° per hour, used 1 per hour, the rest spilled
  assert.ok(close(r.spilledH, 300 * (2 * Math.cos(RAD) - 1), 1e-9));
});

test('all dark: the battery drains at the sleep load, runs out, and the minimum battery is the whole sleep', () => {
  const s = fakeSeries(Array.from({ length: 300 }, () => ({ azDeg: 0, elDeg: -5, litFrac: 0 })));
  const r = simulate(s, powerSeries(s, 'track'), { panelToLoad: 2, batteryHours: 24, sleepLoad: 0.1 });
  assert.equal(r.generatedH, 0);
  assert.ok(close(r.consumedH, 30));
  assert.equal(r.sleepH, 300);
  assert.equal(r.chargingH, 0);
  // 24 h of load at 0.1 → empty after 240 h, so 60 h at empty
  assert.ok(close(r.emptyH, 60, 1e-9));
  assert.ok(close(r.minBatteryH, 30, 1e-9));
  assert.ok(close(r.soc[240], 0, 1e-9));
});

test('minimum battery equals the worst deficit, and is the exact edge between outage and none', () => {
  // two long nights of different length between days with surplus
  const bins = [];
  const day = (n) => { for (let i = 0; i < n; i++) bins.push({ azDeg: (bins.length * 15) % 360, elDeg: 2, litFrac: 1 }); };
  const night = (n) => { for (let i = 0; i < n; i++) bins.push({ azDeg: 0, elDeg: -3, litFrac: 0 }); };
  day(20); night(50); day(80); night(120); day(30); night(10);
  const s = fakeSeries(bins);
  const p = powerSeries(s, 'track');
  const a = { panelToLoad: 1.5, sleepLoad: 0.2 };
  const r = simulate(s, p, { ...a, batteryHours: 1000 });
  // worst deficit by brute force: largest drop of the running sum S from any earlier level (start included)
  const S = [0];
  r.net.forEach((x) => S.push(S[S.length - 1] + x));
  let worst = 0;
  for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) worst = Math.max(worst, S[i] - S[j]);
  assert.ok(close(r.minBatteryH, worst, 1e-9));
  assert.ok(close(worst, 120 * 0.2, 1e-9));       // the 120 h night at 20% load
  const ok = simulate(s, p, { ...a, batteryHours: worst * (1 + 1e-9) });
  assert.equal(ok.unmetH, 0);
  const short = simulate(s, p, { ...a, batteryHours: worst * 0.99 });
  assert.ok(short.unmetH > 0 && short.emptyH > 0);
});

test('minimum battery with a part-charged start is checked against the simulation', () => {
  const net = [-3, 2, -1, -4, 6, -2, -5, 1];
  for (const q of [1, 0.75, 0.5, 0.2]) {
    const c = minBattery(net, q);
    const s = fakeSeries(net.map(() => ({ azDeg: 0, elDeg: 0, litFrac: 0 })));
    // drive simulate() with a load profile equal to −net and no generation
    const sim = (C) => {
      let soc = q * C, unmet = 0;
      for (const x of net) { const y = soc + x; unmet += Math.max(0, -y); soc = Math.min(C, Math.max(0, y)); }
      return unmet;
    };
    assert.equal(sim(c * (1 + 1e-9)), 0, `q=${q}`);
    assert.ok(sim(c * 0.98) > 0, `q=${q}`);
    assert.ok(s.bins.length === net.length);
  }
});

test('best fixed attitude: Sun fixed at one direction → the panel normal points at it', () => {
  for (const [az, el] of [[123.4, 20], [10, 3], [271.7, 55]]) {
    const s = fakeSeries(Array.from({ length: 50 }, () => ({ azDeg: az, elDeg: el, litFrac: 1 })));
    const b = bestFixed(s);
    assert.ok(Math.abs(b.tiltDeg - (90 - el)) <= 0.15, `tilt ${b.tiltDeg} for el ${el}`);
    const dAz = Math.abs(((b.azDeg - az + 540) % 360) - 180);
    assert.ok(dAz <= 0.15, `az ${b.azDeg} for ${az}`);
    assert.ok(close(b.energyH, 50, 1e-4));
    // relative to tracking: 1 / cos el
    const track = energyOf(s, powerSeries(s, 'track'));
    assert.ok(close(b.energyH / track, 1 / Math.cos(el * RAD), 1e-4));
  }
});

test('best fixed attitude: Sun going all the way round at 1.5° → vertical panels lose to tracking', () => {
  const s = fakeSeries(Array.from({ length: 360 }, (_, k) => ({ azDeg: k, elDeg: 1.5, litFrac: 1 })));
  const b = bestFixed(s);
  const track = energyOf(s, powerSeries(s, 'track'));
  const flat = energyOf(s, powerSeries(s, 'flat'));
  // a vertical panel facing one way sees cos(az − γ) for half the circle: 1/π of tracking
  assert.ok(b.tiltDeg >= 60, `tilt ${b.tiltDeg}`);
  assert.ok(b.energyH / track < 0.4);
  assert.ok(flat / track < 0.03);
});

test('lit hours of the Sun series equal summarize().sunMs on the synthetic fixture', () => {
  const eph = createEphemeris(syntheticData({ days: 40 }));
  const sites = [{ lonDeg: 0, latDeg: 0 }, { lonDeg: 30, latDeg: -60 }, { lonDeg: 200, latDeg: -85 }];
  const masks = [0, 5, (az) => 2 + 3 * Math.sin((az * Math.PI) / 90)];
  for (const site of sites) for (const mask of masks) for (const days of [7, 14, 30]) {
    const t0 = eph.startMs + 5.5 * H;
    const sum = summarize(eph, site, t0, days, mask);
    const ser = sunSeries(eph, site, sum.startMs, sum.endMs, mask);
    assert.ok(close(litHours(ser) * H, sum.sunMs, 1e-3), `${litHours(ser)} h vs ${sum.sunMs / H} h`);
    assert.equal(ser.litMs, sum.sunMs);
    assert.ok(close(ser.bins.reduce((a, b) => a + b.dtH, 0) * H, sum.stayMs, 1e-3));
  }
});

test('the pair is cut to a common length like summarizePair, and lit hours still agree', () => {
  const eph = createEphemeris(syntheticData({ days: 40 }));
  const site = { lonDeg: 30, latDeg: -60 };
  const mask = 1;
  const planned = { site, landingMs: eph.startMs, mask };
  const alternative = { site, landingMs: eph.startMs + 20 * D, mask };
  const want = summarizePair(eph, planned, alternative, 30, 0);
  const got = planEnergyPair(eph, planned, alternative, 30);
  assert.equal(got.stayDays, want.stayDays);
  assert.ok(got.cut);
  assert.ok(close(got.planned.litMs, want.planned.sunMs));
  assert.ok(close(got.alt.litMs, want.alt.sunMs));
  // outside the ephemeris: the alternative is null, the planned stay is the full one
  const out = planEnergyPair(eph, planned, { site, landingMs: eph.endMs + D, mask }, 14);
  assert.equal(out.alt, null);
  assert.ok(close(out.planned.litMs, summarize(eph, site, eph.startMs, 14, mask).sunMs));
});

test('planEnergy: defaults are the assumed ones, tracking beats horizontal at a low Sun, now angle faces the Sun', () => {
  assert.deepEqual(cleanAssumptions({}), { ...ENERGY_DEFAULTS });
  const eph = createEphemeris(syntheticData({ days: 40, sunLat: -1.5 }));
  const site = { lonDeg: 0, latDeg: -88 };
  const r = planEnergy(eph, { site, landingMs: eph.startMs, mask: 0 }, eph.startMs + 14 * D, {}, { atMs: eph.startMs + 3 * H });
  assert.ok(r.energy.track > r.energy.fixed && r.energy.fixed > r.energy.flat);
  assert.ok(r.flatVsTrack < 0.1);
  assert.ok(r.now && Math.abs(r.now.tiltDeg - (90 - r.now.elDeg)) < 1e-9);
  const n = bestAngleAt(eph, site, eph.startMs + 3 * H, 0);
  if (n.lit) assert.ok(close(n.best, 1, 1e-9));
  assert.equal(r.sim.soc.length, r.series.bins.length + 1);
});

// fix R6: a change reads with one sign and one word: "+62 h worse", "−24 h better"; no "▼ +"
import { changeText } from '../demo/src/ui/energycard.js';
test('energy card fix R6: change sign and worse/better word agree', () => {
  assert.deepEqual(changeText(0, 62, 'up'), { text: '+62 h worse', worse: true });
  assert.deepEqual(changeText(2.4, 30.2, 'up'), { text: '+27.6 h worse', worse: true });   // the figures on screen: 30 h − 2.4 h
  assert.deepEqual(changeText(312, 33.4, 'down'), { text: '−279 h worse', worse: true });
  assert.deepEqual(changeText(33.4, 312, 'down'), { text: '+279 h better', worse: false });
  assert.deepEqual(changeText(30, 2.4, 'up'), { text: '−27.6 h better', worse: false });
  assert.deepEqual(changeText(5, 5, 'up'), { text: 'no change', worse: false });
  assert.equal(changeText(NaN, 5, 'up'), null);
  for (const [p, a, w] of [[0, 62, 'up'], [312, 33, 'down'], [3, 1, 'up']]) assert.doesNotMatch(changeText(p, a, w).text, /[▼▲]/);
});

// fix R6: what the two figures mean, on the walkthrough numbers (Asleep 302.6 h at 10 % load, 24 h battery)
test('energy fix R6: Battery needed is the smallest battery that never empties; Battery empty the hours it is empty', () => {
  // 1 h of sunlit charge to full, then 302 dark hours at the sleep load 0.1
  const bins = [{ azDeg: 0, elDeg: 5, litFrac: 1 }, ...Array.from({ length: 302 }, () => ({ azDeg: 0, elDeg: -5, litFrac: 0 }))];
  const series = fakeSeries(bins);
  const sim = simulate(series, powerSeries(series, 'track'), { panelToLoad: 2, batteryHours: 24, sleepLoad: 0.1, initialCharge: 1 });
  assert.ok(close(sim.minBatteryH, 30.2, 1e-6), `needed ${sim.minBatteryH}`);         // 302 h × 0.1
  assert.ok(close(sim.emptyH, 62, 1e-6), `empty ${sim.emptyH}`);                     // (30.2 − 24) / 0.1
  assert.equal(sim.minSocH, 0);                                                       // the curve reaches 0 h
});
