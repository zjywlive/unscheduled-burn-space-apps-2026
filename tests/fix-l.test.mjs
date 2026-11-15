// Fix workstream L (2026-11-13): the phase 4 hash keys (L5), the scale bar length (L12) and the Ask
// panel's route, relay and energy scripts (L6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHash, toHash, DEFAULTS, cleanEnergy, cleanRelay, cleanRoutePlan, parseShape, shapeParam } from '../demo/src/state.js';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { scaleBarFor } from '../demo/src/map/overlay.js';
import { createCommands } from '../demo/src/commands.js';
import { createAgent } from '../demo/src/agent/provider.js';
import { createMockProvider, matchIntent, MOCK_SUGGESTIONS, SUPPORTED_TEXT } from '../demo/src/agent/mock.js';

const sites = JSON.parse(readFileSync(new URL('../demo/data/sites.json', import.meta.url)));
const eph = createEphemeris(JSON.parse(readFileSync(new URL('../demo/data/ephemeris.json', import.meta.url))));
const BASE = '#view=map&site=im2&t=2027-01-13T00:00Z&stay=14&slip=14&alt=same&mode=both';

// ---------- L5 ----------
test('L5: a default state still hashes as in phase 2; the new keys default to off / none', () => {
  const s = parseHash('', sites, eph);
  assert.equal(toHash(s), BASE);
  assert.equal(s.psr, false);
  assert.equal(s.energy, null); assert.equal(s.relay, null); assert.equal(s.routePlan, null);
  assert.deepEqual(s.regions, { A: null, B: null });
  assert.deepEqual(DEFAULTS.regions, { A: null, B: null });
});

test('L5: PSR, energy, relay, route plan and regions round-trip in a fixed order', () => {
  const h = `${BASE}&z=3&psr=1&en=fixed,3,48,0.2&relay=circular-2h&rp=77.13,138;72.5,141.2&rpslope=25&rpsel=flat`
    + '&ra=circle:-11.3,-12.3,8&rb=poly:1,2;3,4;5,1';
  const s = parseHash(h, sites, eph);
  assert.equal(s.psr, true);
  assert.deepEqual(s.energy, { attitude: 'fixed', panelToLoad: 3, batteryHours: 48, sleepLoad: 0.2 });
  assert.deepEqual(s.relay, { presetId: 'circular-2h' });
  assert.deepEqual(s.routePlan, { points: [[77.13, 138], [72.5, 141.2]], maxSlopeDeg: 25, selected: 'flat' });
  assert.deepEqual(s.regions.A, { type: 'circle', cx: -11.3, cy: -12.3, rKm: 8 });
  assert.deepEqual(s.regions.B, { type: 'polygon', points: [[1, 2], [3, 4], [5, 1]] });
  assert.equal(toHash(s), h);
});

test('L5: defaults are left out of the hash', () => {
  const s = parseHash('', sites, eph);
  // the card defaults, the first relay preset and the default slope limit write nothing
  assert.equal(toHash({ ...s, energy: { attitude: 'track', panelToLoad: 2, batteryHours: 24, sleepLoad: 0.1 } }), BASE);
  assert.equal(toHash({ ...s, relay: { presetId: 'elliptical-12h' } }), BASE);
  assert.equal(toHash({ ...s, routePlan: { points: [[1, 2], [3, 4]], maxSlopeDeg: 15, selected: null } }), `${BASE}&rp=1,2;3,4`);
  assert.equal(cleanEnergy({ attitude: 'track', panelToLoad: 2, batteryHours: 24, sleepLoad: 0.1 }), null);
  assert.equal(cleanRelay('elliptical-12h'), null);
  // the minimum elevation is written on its own key, with the default preset too
  assert.equal(toHash({ ...s, relay: { presetId: 'elliptical-12h', minElDeg: 5 } }), `${BASE}&relaymin=5`);
  assert.deepEqual(parseHash(`${BASE}&relay=circular-2h&relaymin=10`, sites, eph).relay, { presetId: 'circular-2h', minElDeg: 10 });
  assert.equal(parseHash('#relaymin=99', sites, eph).relay.minElDeg, 45);
});

test('L5: custom relay elements and every region shape type', () => {
  const r = cleanRelay({ elements: { aKm: 6000, e: 0.5, iDeg: 80, raanDeg: 10, argpDeg: 90, m0Deg: 0, epochMs: null } });
  const s = { ...parseHash('', sites, eph), relay: r };
  assert.match(toHash(s), /&relay=c:6000,0\.5,80,10,90,0$/);
  assert.deepEqual(parseHash(toHash(s), sites, eph).relay, r);
  for (const sh of [{ type: 'rect', x0: -5, y0: 2, x1: 10, y1: 30 }, { type: 'circle', cx: 0, cy: 0, rKm: 12.5 }, { type: 'polygon', points: [[0, 0], [10, 0], [5, 8]] }]) {
    assert.deepEqual(parseShape(shapeParam(sh)), sh);
  }
});

test('L5: old links and garbage still load; bad values are dropped, not thrown', () => {
  for (const h of ['#psr=yes', '#en=fly,1,2', '#en=track,a,b,c', '#relay=apollo', '#relay=c:1,2', '#rp=1,2', '#rp=1,2;3', '#rp=999999,0;1,1',
    '#ra=rect:1,2,3', '#ra=circle:0,0,-4', '#rb=poly:1,1;2,2', '#ra=hexagon:1', '#rpsel=fast&rp=1,2;3,4']) {
    const s = parseHash(h, sites, eph);
    assert.equal(s.site.id, 'im2', h);
    assert.ok(toHash(s).startsWith(BASE), h);
  }
  assert.equal(parseHash('#psr=yes', sites, eph).psr, false);
  assert.equal(parseHash('#rp=999999,0;1,1', sites, eph).routePlan, null);
  // routes may lie anywhere on the Moon now: 999 km from the pole (about 56°S) is a point like any other
  assert.deepEqual(parseHash('#rp=999,0;1,1', sites, eph).routePlan.points, [[999, 0], [1, 1]]);
  assert.equal(parseHash('#rpsel=fast&rp=1,2;3,4', sites, eph).routePlan.selected, null);
  // the slope limit is held to the card's 5°–30°
  assert.equal(cleanRoutePlan({ points: [[0, 0], [1, 1]], maxSlopeDeg: 60 }).maxSlopeDeg, 30);
  // energy values are held to the energy model's ranges
  assert.equal(cleanEnergy('track,2,24,5').sleepLoad, 1);
});

// ---------- L12 ----------
test('L12: the scale bar is a round 1, 2 or 5 × 10^n length about 80–160 px long', () => {
  for (let k = 1e-4; k < 3; k *= 1.07) {
    const b = scaleBarFor(k);
    const m = b.km / 10 ** Math.floor(Math.log10(b.km) + 1e-9);
    assert.ok([1, 2, 5].some((v) => Math.abs(m - v) < 1e-9), `${k}: ${b.km}`);
    assert.ok(b.px >= 64 && b.px <= 175, `${k}: ${b.px}`);
    assert.ok(Math.abs(b.px - b.km / k) < 1e-9);
  }
  assert.deepEqual(scaleBarFor(0.2), { km: 20, px: 100, label: '20 km' });
  assert.equal(scaleBarFor(0.73).label, '100 km');
  assert.equal(scaleBarFor(0.005).label, '500 m');
  assert.equal(scaleBarFor(0), null);
  assert.equal(scaleBarFor(NaN), null);
});

// ---------- L6 ----------
const H = 36e5;
function fakeApi(more = {}) {
  const state = {
    view: 'map', site: sites.find((s) => s.id === 'im2'), landingMs: Date.UTC(2027, 0, 13), stayDays: 14, slipDays: 0,
    mapMode: 'both', maxSlope: null, maxDark: null, weights: { sun: 40, earth: 30, slope: 20, shadow: 10 },
  };
  return {
    sites, state,
    getState: () => ({ ...state, summary: { planned: { stayMs: 336 * H, sunMs: 200 * H, earthMs: 180 * H, bothMs: 123.4 * H, longestDarkMs: 0 }, alt: null } }),
    update: (p) => Object.assign(state, p), setView: () => {}, setRegion: () => {}, setRoute: () => {},
    regionStats: async () => null, bestCells: async () => [], startTour: () => {},
    ...more,
  };
}
async function ask(api, q) {
  const agent = createAgent({ provider: createMockProvider(), commands: createCommands(api) });
  const events = [];
  const out = await agent.send(q, (e) => events.push(e));
  return { out, calls: events.filter((e) => e.type === 'tool_call').map((e) => [e.name, e.input]) };
}

test('L6: route, relay and energy questions are recognised, with one suggestion each', () => {
  assert.equal(matchIntent('Plan a route from IM-2 Athena to Mons Mouton Plateau'), 'route');
  assert.equal(matchIntent('What is the sunniest path to Haworth?'), 'route');
  assert.equal(matchIntent('Find a flat route for the rover'), 'route');
  assert.equal(matchIntent('How many hours of relay link with the 12 h orbit?'), 'relay');
  assert.equal(matchIntent('Will a 24 h battery last the stay?'), 'energy');
  assert.equal(matchIntent('How much solar power do we get?'), 'energy');
  assert.equal(matchIntent('Find flat, sunlit ground near Shackleton ridge'), 'flat');
  for (const want of ['route', 'relay', 'energy']) assert.equal(MOCK_SUGGESTIONS.filter((q) => matchIntent(q) === want).length, 1, want);
  assert.match(SUPPORTED_TEXT, /route/); assert.match(SUPPORTED_TEXT, /relay/); assert.match(SUPPORTED_TEXT, /battery/);
});

test('L6: a route question plans between the named sites and quotes the plan_route figures', async () => {
  let got = null;
  const api = fakeApi({
    planRoute: async (pts, slope) => {
      got = { pts, slope };
      return { selected: 'short', slopeLimitDeg: slope, slopeBaselineKm: 0.24, routes: [
        { id: 'short', label: 'Shortest', lengthKm: 15.4, maxSlopeDeg: 11.1, meanSlopeDeg: 6.2, sunSharePct: 71, psrKm: 0 },
        { id: 'flat', label: 'Flattest', lengthKm: 19.3, maxSlopeDeg: 7.7, meanSlopeDeg: 4.1, sunSharePct: 78, psrKm: 0.4 },
        { id: 'sunny', label: 'Sunniest', lengthKm: 15.8, maxSlopeDeg: 12.6, meanSlopeDeg: 6.9, sunSharePct: 82, psrKm: 0 },
      ] };
    },
  });
  const r = await ask(api, 'Plan a route from IM-2 Athena to Mons Mouton Plateau under 20 degrees');
  assert.deepEqual(r.calls.map((c) => c[0]), ['get_state', 'plan_route']);
  const mmp = sites.find((s) => s.id === 'mons-mouton-plateau');
  assert.deepEqual(r.calls[1][1].points, [[api.state.site.latDeg, api.state.site.lonDeg], [mmp.latDeg, mmp.lonDeg]]);
  assert.equal(got.slope, 20);
  for (const t of ['Shortest 15.4 km', 'max slope 11.1°', 'Flattest 19.3 km', 'sunlit 82%', '0.4 km in permanent shadow', 'under 20°']) assert.ok(r.out.text.includes(t), t);
  // one site named: from the selected site to it
  const r2 = await ask(fakeApi({ planRoute: async () => ({ routes: [], slopeLimitDeg: 15 }) }), 'Find a route to Mons Mouton Plateau');
  assert.deepEqual(r2.calls[1][1].points[0], [api.state.site.latDeg, api.state.site.lonDeg]);
  // none named: asks for two, calls nothing past get_state
  const r3 = await ask(fakeApi(), 'Plan a route');
  assert.deepEqual(r3.calls.map((c) => c[0]), ['get_state']);
  assert.match(r3.out.text, /Name two sites/);
});

test('L6: a blocked route says what slope it needs', async () => {
  const api = fakeApi({ planRoute: async () => ({ blocked: { limitDeg: 5, neededDeg: 6.4, passesAtDeg: 7 } }) });
  const r = await ask(api, 'Plan a route from IM-2 Athena to Mons Mouton Plateau under 5°');
  assert.match(r.out.text, /No route keeps under 5°\. It needs 7°\./);
});

test('L6: relay and energy questions call their commands and quote the figures', async () => {
  const one = { relayH: 263.2, longestRelayGapH: 2.7, earthDirectH: 261, directOrRelayH: 320.4, longestBlindH: 1.5, stayH: 336, periodH: 2 };
  const api = fakeApi({
    relayPresets: [{ id: 'circular-2h', elements: { aKm: 1860.3, e: 0, iDeg: 90, raanDeg: 0, argpDeg: 0, m0Deg: 0 } }, { id: 'elliptical-12h', elements: {} }],
    relayOrbit: (el, presetId) => ({ ok: true, presetId, elements: el, planned: one, alternative: null }),
    energy: (a) => ({ assumptions: { attitude: 'track', panelToLoad: 2, batteryHours: a.batteryHours ?? 24, sleepLoad: 0.1 },
      planned: { label: '13 Jan', sunlitH: 312, atEmptyH: 0, minBatteryH: 18.5, chargingH: 140, asleepH: 24 }, alternative: null, stayDays: 14 }),
  });
  const r = await ask(api, 'How many hours of relay link with the 2 h circular orbit?');
  assert.deepEqual(r.calls.map((c) => c[0]), ['get_state', 'set_relay_orbit']);
  assert.deepEqual(r.calls[1][1], { preset: 'circular-2h' });
  for (const t of ['relay link 263.2 h', 'Earth direct 261.0 h', 'direct or relay 320.4 h', 'not a real mission']) assert.ok(r.out.text.includes(t), t);
  const e = await ask(api, 'Will a 48 h battery last the stay?');
  assert.deepEqual(e.calls.map((c) => c[0]), ['get_state', 'get_energy']);
  assert.deepEqual(e.calls[1][1], { battery_hours: 48 });
  for (const t of ['48 h battery', 'never runs empty', '18.5 h', 'assumption']) assert.ok(e.out.text.includes(t), t);
});
