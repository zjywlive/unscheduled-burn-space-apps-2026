import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCommands, validateInput } from '../demo/src/commands.js';
import { toXY } from '../demo/src/terrain.js';

const sites = JSON.parse(readFileSync(new URL('../demo/data/sites.json', import.meta.url)));

// A fake api that records every call and keeps a plain state object.
function fakeApi(overrides = {}) {
  const calls = [];
  const state = {
    view: 'map', site: sites.find((s) => s.id === 'im2'), landingMs: Date.UTC(2027, 0, 13), stayDays: 14, slipDays: 14,
    mapMode: 'both', maxSlope: null, maxDark: null, weights: { sun: 40, earth: 30, slope: 20, shadow: 10 }, zoom: 1, cx: 0, cy: 0,
  };
  const regions = { A: null, B: null };
  const api = {
    sites,
    calls,
    state,
    getState: () => ({ ...state }),
    update: (patch) => { calls.push(['update', patch]); Object.assign(state, patch); },
    setView: (v) => { calls.push(['setView', v]); Object.assign(state, { cx: v.cx, cy: v.cy, zoom: v.zoom }); },
    setRegion: (slot, shape) => { calls.push(['setRegion', slot, shape]); regions[slot] = shape; },
    setRoute: (p) => { calls.push(['setRoute', p]); },
    regionStats: async (slot) => {
      calls.push(['regionStats', slot]);
      if (!regions[slot]) return null;
      return { cells: 40, areaKm2: 160, sun: 0.61, earth: 0.52, both: 0.33, pass: 0.75, score: 0.58, best: { cell: 1234, value: 0.88, coords: '89.40°S 137.10°W' } };
    },
    bestCells: async (count) => { calls.push(['bestCells', count]); return [{ latDeg: -89.4, lonDeg: 222.9, value: 0.91 }, { latDeg: -85.3, lonDeg: 35.1, value: 0.84 }].slice(0, count); },
    startTour: () => { calls.push(['startTour']); },
    ...overrides,
  };
  return api;
}

const isErr = (r) => r && typeof r.error === 'string' && r.error.length > 0;

test('lists the commands and their tool definitions (phase 4: plus the workflow commands)', () => {
  const c = createCommands(fakeApi());
  const phase3 = ['get_state', 'select_site', 'set_landing', 'set_stay', 'set_slip', 'set_map_mode', 'set_filters', 'set_weights',
    'zoom_to', 'draw_region', 'clear_region', 'region_stats', 'best_cells', 'open_navigator', 'start_tour'];
  assert.deepEqual(c.list.slice(0, 15), phase3);
  assert.deepEqual(c.list.slice(15), ['get_energy', 'plan_route', 'set_relay_orbit']);
  const defs = c.toolDefinitions();
  assert.equal(defs.length, c.list.length);
  for (const d of defs) {
    assert.deepEqual(Object.keys(d).sort(), ['description', 'input_schema', 'name']);
    assert.match(d.name, /^[a-z_]{1,64}$/);
    assert.ok(d.description.length > 10);
    assert.equal(d.input_schema.type, 'object');
    assert.equal(d.input_schema.additionalProperties, false);
    // JSON-serialisable as is, for the Messages API tools field
    assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
  }
  // Callers get a copy: editing it does not change the next call.
  defs[0].input_schema.properties.x = {};
  assert.deepEqual(c.toolDefinitions()[0].input_schema.properties, {});
});

test('unknown command and non-object input return errors', async () => {
  const c = createCommands(fakeApi());
  assert.ok(isErr(await c.run('fly_to_mars', {})));
  assert.ok(isErr(await c.run('get_state', 'hello')));
  assert.ok(isErr(await c.run('get_state', [1])));
  assert.ok(isErr(await c.run('get_state', { extra: 1 })));
});

test('get_state', async () => {
  const api = fakeApi();
  const c = createCommands(api);
  const r = await c.run('get_state', {});
  assert.equal(r.site.id, 'im2');
  assert.equal(r.landing, '2027-01-13T00:00Z');
  assert.equal(r.mapModeLabel, 'Both');
  assert.deepEqual(r.filters, { maxSlopeDeg: null, maxDarkH: null });
  assert.equal(r.sites.length, sites.length);
  assert.equal(r.planned, undefined);
  // With summaries from the integrator, hours are derived from them.
  api.getState = () => ({ ...api.state, summary: { planned: { stayMs: 14 * 864e5, sunMs: 300 * 36e5, earthMs: 200 * 36e5, bothMs: 150 * 36e5, longestDarkMs: 10 * 36e5 }, alt: { stayMs: 14 * 864e5, sunMs: 0, earthMs: 0, bothMs: 0, longestDarkMs: 0 } } });
  const r2 = await c.run('get_state', {});
  assert.deepEqual(r2.planned, { stayH: 336, sunH: 300, earthH: 200, bothH: 150, longestDarkH: 10 });
  assert.equal(r2.slipped.bothH, 0);
  assert.ok(isErr(await c.run('get_state', { site: 'x' })));
});

test('select_site: by id, by coordinates, and rejected input', async () => {
  const api = fakeApi();
  const c = createCommands(api);
  assert.equal((await c.run('select_site', { site_id: 'shackleton' })).site.name, 'Shackleton ridge');
  assert.equal(api.state.site.id, 'shackleton');
  const r = await c.run('select_site', { lat_deg: -85.2, lon_deg: -10 });
  assert.equal(r.site.id, 'custom');
  assert.equal(r.site.lonDeg, 350);
  assert.ok(isErr(await c.run('select_site', { site_id: 'atlantis' })));
  assert.ok(isErr(await c.run('select_site', {})));
  assert.ok(isErr(await c.run('select_site', { lat_deg: -85 })));
  assert.ok(isErr(await c.run('select_site', { lat_deg: -95, lon_deg: 0 })));
  assert.ok(isErr(await c.run('select_site', { site_id: 'im2', lat_deg: -85, lon_deg: 0 })));
  assert.ok(isErr(await c.run('select_site', { site_id: 12 })));
});

test('set_landing', async () => {
  const api = fakeApi();
  const c = createCommands(api);
  // third wave: set_landing also reports the stay the ephemeris covers (review I5)
  assert.deepEqual(await c.run('set_landing', { date: '2027-03-01' }), { landing: '2027-03-01T00:00Z', stayAvailableH: 336, clipped: false });
  assert.equal(api.state.landingMs, Date.UTC(2027, 2, 1));
  assert.equal((await c.run('set_landing', { date: '2027-03-01T06:45Z' })).landing, '2027-03-01T06:00Z');
  for (const date of ['2025-01-01', '2029-01-01', '2027-02-30', 'tomorrow', '2027-01-01T25:00Z']) assert.ok(isErr(await c.run('set_landing', { date })), date);
  assert.ok(isErr(await c.run('set_landing', {})));
  assert.ok(isErr(await c.run('set_landing', { date: 20270101 })));
  // An integrator-supplied range wins over the default.
  const narrow = createCommands(fakeApi({ landingRange: { startMs: Date.UTC(2027, 0, 1), endMs: Date.UTC(2027, 1, 1) } }));
  assert.ok(isErr(await narrow.run('set_landing', { date: '2027-03-01' })));
});

test('set_stay and set_slip', async () => {
  const api = fakeApi();
  const c = createCommands(api);
  // third wave: set_stay also reports the stay the ephemeris covers (review I5)
  assert.deepEqual(await c.run('set_stay', { days: 30 }), { stayDays: 30, stayAvailableH: 720, clipped: false });
  assert.equal(api.state.stayDays, 30);
  assert.ok(isErr(await c.run('set_stay', { days: 10 })));
  assert.ok(isErr(await c.run('set_stay', { days: '7' })));
  const r = await c.run('set_slip', { days: -7 });
  assert.deepEqual(r, { slipDays: -7, alternativeLanding: '2027-01-06T00:00Z' });
  assert.ok(isErr(await c.run('set_slip', { days: 61 })));
  assert.ok(isErr(await c.run('set_slip', { days: 1.5 })));
  assert.ok(isErr(await c.run('set_slip', {})));
});

test('set_map_mode', async () => {
  const api = fakeApi();
  const c = createCommands(api);
  assert.deepEqual(await c.run('set_map_mode', { mode: 'score' }), { mapMode: 'score', label: 'Suitability' });
  assert.equal(api.state.mapMode, 'score');
  assert.ok(isErr(await c.run('set_map_mode', { mode: 'heat' })));
  assert.ok(isErr(await c.run('set_map_mode', {})));
});

test('set_filters: partial updates, Any, and rejected values', async () => {
  const api = fakeApi();
  const c = createCommands(api);
  assert.deepEqual(await c.run('set_filters', { max_slope_deg: 10 }), { maxSlopeDeg: 10, maxDarkH: null });
  assert.deepEqual(await c.run('set_filters', { max_dark_h: 48 }), { maxSlopeDeg: 10, maxDarkH: 48 });
  assert.deepEqual(await c.run('set_filters', { max_slope_deg: null }), { maxSlopeDeg: null, maxDarkH: 48 });
  assert.equal(api.state.maxDark, 48);
  api.state.mapMode = 'now';
  assert.match((await c.run('set_filters', { max_dark_h: null })).note, /Now and Change/);
  for (const bad of [{}, { max_slope_deg: 2 }, { max_slope_deg: 31 }, { max_slope_deg: 5.5 }, { max_dark_h: 13 }, { max_dark_h: 348 }, { slope: 5 }]) {
    assert.ok(isErr(await c.run('set_filters', bad)), JSON.stringify(bad));
  }
});

test('set_weights: merges, warns on all zero, rejects bad values', async () => {
  const api = fakeApi();
  const c = createCommands(api);
  const r = await c.run('set_weights', { sun: 80 });
  assert.deepEqual(r.weights, { sun: 80, earth: 30, slope: 20, shadow: 10 });
  assert.equal(r.note, undefined);
  const z = await c.run('set_weights', { sun: 0, earth: 0, slope: 0, shadow: 0 });
  assert.match(z.note, /at least one weight/);
  for (const bad of [{}, { sun: -1 }, { sun: 101 }, { sun: 'high' }, { power: 5 }]) assert.ok(isErr(await c.run('set_weights', bad)), JSON.stringify(bad));
});

test('zoom_to: site or point, default zoom, and rejected input', async () => {
  const api = fakeApi();
  const c = createCommands(api);
  const r = await c.run('zoom_to', { site_id: 'shackleton' });
  const [x, y] = toXY(-89.45, 222.69);
  assert.equal(r.zoom, 6);
  assert.ok(Math.abs(api.state.cx - x) < 1e-9 && Math.abs(api.state.cy - y) < 1e-9);
  assert.equal((await c.run('zoom_to', { lat_deg: -86, lon_deg: 0.3, zoom: 3 })).zoom, 3);
  assert.ok(isErr(await c.run('zoom_to', { site_id: 'apollo11' })), 'north of 80°S');
  assert.ok(isErr(await c.run('zoom_to', { lat_deg: -70, lon_deg: 0 })));
  assert.ok(isErr(await c.run('zoom_to', { site_id: 'im2', zoom: 33 })));
  assert.ok(isErr(await c.run('zoom_to', { zoom: 2 })));
});

test('draw_region, clear_region and region_stats', async () => {
  const api = fakeApi();
  const c = createCommands(api);
  assert.ok(isErr(await c.run('region_stats', { slot: 'A' })), 'empty slot');
  const circle = await c.run('draw_region', { slot: 'A', type: 'circle', site_id: 'shackleton', radius_km: 10 });
  assert.equal(circle.shape.type, 'circle');
  assert.equal(circle.shape.rKm, 10);
  const rect = await c.run('draw_region', { slot: 'B', type: 'rect', lat_deg: -86, lon_deg: 0.3, radius_km: 5 });
  assert.ok(Math.abs(rect.shape.x1 - rect.shape.x0 - 10) < 1e-9 && rect.shape.y0 < rect.shape.y1);
  const poly = await c.run('draw_region', { slot: 'A', type: 'polygon', points: [[-89, 0], [-89, 90], [-88, 45]] });
  assert.equal(poly.shape.points.length, 3);
  const stats = await c.run('region_stats', { slot: 'A' });
  assert.equal(stats.slot, 'A');
  assert.equal(stats.cells, 40);
  assert.deepEqual(await c.run('clear_region', { slot: 'A' }), { slot: 'A', cleared: true });
  assert.ok(isErr(await c.run('region_stats', { slot: 'A' })));
  const bad = [
    {}, { slot: 'C', type: 'circle', site_id: 'im2', radius_km: 5 }, { slot: 'A', type: 'hexagon' },
    { slot: 'A', type: 'circle', site_id: 'im2' }, { slot: 'A', type: 'circle', site_id: 'im2', radius_km: 0 },
    { slot: 'A', type: 'circle', site_id: 'apollo17', radius_km: 5 }, { slot: 'A', type: 'polygon' },
    { slot: 'A', type: 'polygon', points: [[-89, 0], [-89, 90]] }, { slot: 'A', type: 'polygon', points: [[-89, 0], [-89, 90], [-70, 45]] },
    { slot: 'A', type: 'polygon', points: [[-89, 0], [-89, 90], [-88, 45]], site_id: 'im2' },
    { slot: 'A', type: 'circle', site_id: 'im2', radius_km: 5, points: [[-89, 0], [-89, 90], [-88, 45]] },
  ];
  for (const b of bad) assert.ok(isErr(await c.run('draw_region', b)), JSON.stringify(b));
  assert.ok(isErr(await c.run('clear_region', {})));
  assert.ok(isErr(await c.run('clear_region', { slot: 'a' })));
  assert.ok(isErr(await c.run('region_stats', {})));
});

test('best_cells: ranked modes only, count bounds, coordinates added', async () => {
  const api = fakeApi();
  const c = createCommands(api);
  const r = await c.run('best_cells', { count: 2 });
  assert.equal(r.cells.length, 2);
  assert.equal(r.valueKind, 'fraction of stay');
  assert.match(r.cells[0].coords, /°S/);
  assert.equal((await c.run('best_cells', {})).cells.length, 2);
  assert.deepEqual(api.calls.filter((x) => x[0] === 'bestCells').map((x) => x[1]), [2, 5]);
  api.state.mapMode = 'score';
  assert.equal((await c.run('best_cells', { count: 1 })).valueKind, 'score');
  api.state.mapMode = 'change';
  assert.ok(isErr(await c.run('best_cells', { count: 1 })));
  api.state.mapMode = 'both';
  for (const bad of [{ count: 0 }, { count: 11 }, { count: 2.5 }, { n: 3 }]) assert.ok(isErr(await c.run('best_cells', bad)), JSON.stringify(bad));
});

test('open_navigator and start_tour', async () => {
  const api = fakeApi();
  const c = createCommands(api);
  assert.deepEqual(await c.run('open_navigator', {}), { view: 'navigator' });
  assert.equal(api.state.view, 'navigator');
  assert.deepEqual(await c.run('start_tour'), { started: true });
  assert.deepEqual(api.calls.at(-1), ['startTour']);
  assert.ok(isErr(await c.run('open_navigator', { site: 'im2' })));
  assert.ok(isErr(await c.run('start_tour', { step: 2 })));
});

test('an api that throws becomes an error result', async () => {
  const c = createCommands(fakeApi({ regionStats: async () => { throw new Error('heat job lost'); }, startTour: () => { throw new Error('no tour'); } }));
  assert.deepEqual(await c.run('region_stats', { slot: 'A' }), { error: 'region_stats failed: heat job lost' });
  assert.deepEqual(await c.run('start_tour', {}), { error: 'start_tour failed: no tour' });
});

test('validateInput covers the schema subset', () => {
  const schema = { type: 'object', properties: { a: { type: ['integer', 'null'], minimum: 1 }, b: { type: 'array', minItems: 1, items: { type: 'string' } } }, required: ['a'], additionalProperties: false };
  assert.equal(validateInput(schema, { a: null }), null);
  assert.equal(validateInput(schema, { a: 2, b: ['x'] }), null);
  assert.match(validateInput(schema, {}), /a is required/);
  assert.match(validateInput(schema, { a: 0 }), /at least 1/);
  assert.match(validateInput(schema, { a: 1, b: [] }), /at least 1 items/);
  assert.match(validateInput(schema, { a: 1, b: [3] }), /b\[0\] must be string/);
  assert.match(validateInput(schema, { a: 1, c: 1 }), /Unknown field c/);
  assert.match(validateInput(schema, { a: Number.NaN }), /must be integer or null/);
});

// ---------- third wave (correctness review) ----------
test('a landing near the end of the ephemeris is accepted but reported as a clipped stay (review I5)', async () => {
  const api = fakeApi();
  const c = createCommands(api);
  const r = await c.run('set_landing', { date: '2028-12-31T23:00Z' });
  assert.deepEqual(r, { landing: '2028-12-31T23:00Z', stayAvailableH: 1, clipped: true });
  const s = await c.run('get_state', {});
  assert.equal(s.clipped, true); assert.equal(s.stayAvailableH, 1);
  await c.run('set_landing', { date: '2028-12-20' });
  assert.deepEqual(await c.run('set_stay', { days: 7 }), { stayDays: 7, stayAvailableH: 168, clipped: false });
  assert.deepEqual(await c.run('set_stay', { days: 14 }), { stayDays: 14, stayAvailableH: 288, clipped: true });
});

test('zoom_to returns the centre the viewport really has after clamping (review M2)', async () => {
  const api = fakeApi();
  const c = createCommands(api);
  const r = await c.run('zoom_to', { site_id: 'im1', zoom: 12 });
  const lim = 320 - 320 / 12;
  assert.ok(Math.abs(r.cy) <= lim + 1e-9 && Math.abs(api.state.cy - r.cy) < 0.01, JSON.stringify(r));
  assert.equal(r.centredOnPoint, false);
  assert.equal((await c.run('zoom_to', { site_id: 'shackleton' })).centredOnPoint, true);
});

test('draw_region refuses a polygon whose outline crosses itself (review I2)', async () => {
  const api = fakeApi();
  const c = createCommands(api);
  // four points round the pole: in order a square, out of order a figure eight
  const r = await c.run('draw_region', { slot: 'A', type: 'polygon', points: [[-88, 0], [-88, 90], [-88, 180], [-88, 270]] });
  assert.ok(!isErr(r), 'the square is fine');
  const eight = await c.run('draw_region', { slot: 'A', type: 'polygon', points: [[-88, 0], [-88, 180], [-88, 90], [-88, 270]] });
  assert.ok(isErr(eight));
  assert.equal(eight.error, 'This outline crosses itself. Draw it again without crossing.');
});

test('get_energy: maps its inputs to the card\'s assumptions, and says so when the card is missing', async () => {
  let got = null;
  const c = createCommands({ ...fakeApi(), energy: (a) => { got = a; return { ok: true }; } });
  assert.deepEqual(await c.run('get_energy', { attitude: 'flat', panel_to_load: 3, battery_hours: 48, sleep_load_pct: 20 }), { ok: true });
  assert.deepEqual(got, { attitude: 'flat', panelToLoad: 3, batteryHours: 48, sleepLoad: 0.2 });
  assert.deepEqual((await c.run('get_energy', {}), got), {});
  assert.ok(isErr(await c.run('get_energy', { attitude: 'tilted' })));
  assert.ok(isErr(await createCommands(fakeApi()).run('get_energy', {})));
});

test('set_relay_orbit: a preset, elements merged over it, and invalid orbits', async () => {
  let got = null;
  const relayPresets = [{ id: 'circular-2h', elements: { aKm: 1860.3, e: 0, iDeg: 90, raanDeg: 0, argpDeg: 0, m0Deg: 0, epochMs: null } }];
  const relayOrbit = (el, pid) => { got = { el, pid }; return el.e > 0.9 ? { ok: false, errors: { e: 'Periapsis is below the surface.' } } : { ok: true, presetId: pid }; };
  const c = createCommands({ ...fakeApi(), relayOrbit, relayPresets });
  assert.deepEqual(await c.run('set_relay_orbit', { preset: 'circular-2h' }), { ok: true, presetId: 'circular-2h' });
  assert.equal(got.pid, 'circular-2h');
  await c.run('set_relay_orbit', { preset: 'circular-2h', i_deg: 80 });
  assert.equal(got.pid, null); assert.equal(got.el.iDeg, 80); assert.equal(got.el.aKm, 1860.3);
  assert.ok(isErr(await c.run('set_relay_orbit', { e: 0.94 })));
  assert.ok(isErr(await c.run('set_relay_orbit', { preset: 'circular-2h', e: 2 })));
  assert.ok(isErr(await createCommands(fakeApi()).run('set_relay_orbit', {})));
});

test('plan_route: lat/lon points go to the planner as map km; bad points and a blocked plan are errors', async () => {
  let got = null;
  const planRoute = async (pts, limit) => { got = { pts, limit }; return limit < 6 ? { error: null, blocked: { limitDeg: limit, neededDeg: 11.2, passesAtDeg: 12 } } : { selected: 'short', routes: [] }; };
  const c = createCommands({ ...fakeApi(), planRoute });
  assert.deepEqual(await c.run('plan_route', { points: [[-89.45, 222.69], [-89.9, 0]] }), { selected: 'short', routes: [] });
  assert.equal(got.pts.length, 2); assert.equal(got.limit, 15);
  assert.ok(Math.abs(Math.hypot(...got.pts[1]) - 3.03) < 0.1, 'about 3 km from the pole');
  assert.match((await c.run('plan_route', { points: [[-89.45, 222.69], [-89.9, 0]], max_slope_deg: 5 })).error, /needs 12°/);
  assert.ok(isErr(await c.run('plan_route', { points: [[-70, 0], [-89, 0]] })));
  assert.ok(isErr(await c.run('plan_route', { points: [[-89, 0]] })));
  assert.ok(isErr(await createCommands(fakeApi()).run('plan_route', { points: [[-89, 0], [-88, 0]] })));
});
