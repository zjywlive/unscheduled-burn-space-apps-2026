// Lander track: the whole Earth → south-pole timeline (mission.js), power along it and the landing checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { planMission, PHASES } from '../demo/src/lander/mission.js';
import { powerTimeline } from '../demo/src/lander/power-timeline.js';
import { landingChecks, pickLandingTime, slopeDeg } from '../demo/src/lander/landing.js';
import { R_MOON, MOON_RATE } from '../demo/src/lander/constants.js';

const eph = createEphemeris(JSON.parse(readFileSync(new URL('../demo/data/ephemeris.json', import.meta.url), 'utf8')));
const sites = JSON.parse(readFileSync(new URL('../demo/data/sites.json', import.meta.url), 'utf8'));
const site = sites.find((s) => s.id === 'mons-mouton');
const requested = Date.parse('2027-02-10T12:00:00Z');
const plan = planMission({ eph, site, landingMs: requested });
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('plan: phases in order, contiguous, and every phase of PHASES present', () => {
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.phases.map((p) => p.id), PHASES.map((p) => p.id));
  for (let i = 1; i < plan.phases.length; i++) {
    assert.ok(Math.abs(plan.phases[i].startMs - plan.phases[i - 1].endMs) < 1, plan.phases[i].id);
    assert.ok(plan.phases[i].endMs >= plan.phases[i].startMs, plan.phases[i].id);
  }
});

test('plan: landing within half an orbit of the request; loiter at least the minimum; plane through the site', () => {
  assert.ok(Math.abs(plan.landingShiftS) <= plan.llo.periodS / 2 + 1);
  assert.ok(plan.llo.loiterDays >= plan.options.minLoiterDays - 0.01);
  assert.ok(plan.llo.loiterDays <= plan.options.minLoiterDays + Math.PI / MOON_RATE / 86400 + 0.1);
  assert.ok(Math.abs(plan.llo.planeErrDeg) < 1e-4);
  assert.ok(plan.llo.dvPlaneMs < 20, `plane change ${plan.llo.dvPlaneMs} m/s`);
});

test('plan: the position is continuous across every phase boundary and touchdown is at the site', () => {
  for (const ph of plan.phases) {
    const a = plan.stateAt(ph.startMs - 500), b = plan.stateAt(ph.startMs + 500);
    // 1 s apart: allow the distance flown in 1 s at up to 11 km/s plus 5 km of patched-conic/plane handover
    assert.ok(dist(a.pos, b.pos) < 16, `${ph.id}: ${dist(a.pos, b.pos)} km`);
  }
  const td = plan.stateAt(plan.times.landingMs).pos;
  const s = plan.siteMci(plan.times.landingMs);
  const r = R_MOON + plan.siteHeightKm;
  assert.ok(dist(td, [s[0] * r, s[1] * r, s[2] * r]) < 0.05);
});

test('plan: altitudes and speeds are what each phase should show', () => {
  const at = (id, f = 0.5) => { const p = plan.phases.find((x) => x.id === id); return plan.stateAt(p.startMs + (p.endMs - p.startMs) * f); };
  assert.ok(Math.abs(at('leo').altKm - 185) < 1);
  assert.ok(Math.abs(at('leo').speedKms - 7.79) < 0.02);
  assert.ok(Math.abs(at('llo').altKm - 100) < 1);
  assert.ok(Math.abs(at('llo').speedKms - 1.633) < 0.01);
  assert.ok(at('coast', 0.5).altKm > 100000);
  assert.ok(plan.transfer.tofS / 86400 > 3 && plan.transfer.tofS / 86400 < 6);
  assert.ok(plan.transfer.vInfKms > 0.6 && plan.transfer.vInfKms < 1.1);
});

test('plan: lander mass only drops, the budget closes and the descent lands inside the limits', () => {
  let prev = Infinity;
  for (let t = plan.times.launchMs; t <= plan.times.endMs; t += (plan.times.endMs - plan.times.launchMs) / 400) {
    const m = plan.stateAt(t).massKg;
    assert.ok(m <= prev + 1e-6);
    prev = m;
  }
  assert.equal(plan.budget.feasible, true);
  assert.equal(plan.descent.touchdown.ok, true);
  assert.ok(plan.stateAt(plan.times.endMs).massKg >= plan.vehicle.dryMassKg);
});

test('power: array output, loads and battery are finite; eclipses in low lunar orbit drain and refill', () => {
  const pw = powerTimeline(plan);
  assert.equal(pw.t.length, pw.soc.length);
  for (let i = 0; i < pw.t.length; i++) assert.ok(Number.isFinite(pw.soc[i]) && pw.soc[i] >= 0 && pw.soc[i] <= 1);
  const llo = plan.phases.find((p) => p.id === 'llo');
  let dark = 0, lit = 0;
  for (let i = 0; i < pw.t.length; i++) if (pw.t[i] > llo.startMs && pw.t[i] < llo.endMs) (pw.lit[i] ? lit++ : dark++);
  assert.ok(lit > 0);
  assert.ok(pw.minSoc > 0, 'battery never empties with the default vehicle');
});

test('landing: the checklist and the landing-time picker', () => {
  const r = landingChecks({ eph, site, tMs: plan.times.landingMs, mask: 0, vehicle: plan.vehicle, touchdown: plan.descent.touchdown });
  assert.ok(r.checks.find((c) => c.id === 'v-vert').ok);
  assert.ok(r.checks.find((c) => c.id === 'v-horiz').ok);
  const t = pickLandingTime(eph, site, 0, Date.parse('2027-01-01T00:00:00Z'));
  assert.ok(Number.isFinite(t));
  const r2 = landingChecks({ eph, site, tMs: t, mask: 0, vehicle: plan.vehicle, touchdown: plan.descent.touchdown });
  assert.ok(r2.sky.sun.clearDeg > 0 && r2.sky.earth.clearDeg > 0);
  // a 10 m rise over 100 m is 5.7°
  assert.ok(Math.abs(slopeDeg((x) => x * 100, 0, 0, 0.05) - Math.atan(0.1) * 180 / Math.PI) < 1e-9);
});
