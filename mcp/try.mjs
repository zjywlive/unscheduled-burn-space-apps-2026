// A tiny, real stdio client. Default output is selected result fields; --full prints all JSON.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let nextId = 0;
const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
const abort = (error) => { for (const p of pending.values()) p.reject(error); pending.clear(); };
child.once('error', abort);
child.stdin.on('error', abort);
child.once('close', () => abort(new Error('Server closed before replying.')));
createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0');
    const p = pending.get(message.id);
    assert.ok(p, 'Unexpected response id');
    pending.delete(message.id);
    if (message.error) p.reject(new Error(JSON.stringify(message.error)));
    else p.resolve(message.result);
  } catch (error) { abort(error); }
});
function send(message) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); }
async function request(method, params) {
  const id = ++nextId;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      timer = setTimeout(() => {
        send({ method: 'notifications/cancelled', params: { requestId: id, reason: 'Client timeout' } });
        reject(new Error(`${method} timed out after 30 seconds.`));
      }, 30_000);
      send({ id, method, params });
    });
  } finally { clearTimeout(timer); pending.delete(id); }
}
async function call(name, args) {
  const result = await request('tools/call', { name, arguments: args });
  assert.equal(result.isError, false, result.content?.[0]?.text);
  assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
  console.log(`\n${name} ${JSON.stringify(args)}`);
  if (process.argv.includes('--full')) console.log(JSON.stringify(result.structuredContent, null, 2));
  return result.structuredContent;
}

try {
  const hello = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lunar-mcp-try', version: '1.0.0' } });
  assert.equal(hello.protocolVersion, '2025-11-25');
  console.log(`MCP ${hello.protocolVersion}: ${hello.serverInfo.name} ${hello.serverInfo.version}`);
  send({ method: 'notifications/initialized' });
  const { tools } = await request('tools/list');
  console.log(`Tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);
  console.log('Selected result fields below (hours); --full also prints complete JSON, including about.');

  const cmp = await call('compare_scenarios', { places: [{ site_id: 'shackleton' }, { site_id: 'im2' }, { site_id: 'haworth' }], landings: ['2027-01-13', '2027-01-27'], stay_days: 14 });
  console.log(`Compared days: ${cmp.comparedDays}; clipped: ${cmp.cut}`);
  for (const s of cmp.scenarios) console.log(`${s.label}: ${JSON.stringify({ sunH: s.sunH, earthH: s.earthH, bothH: s.bothH, longestDarkH: s.longestDarkH, vsBaselineBothH: s.vsBaseline?.bothH })}`);

  const next = await call('next_events', { lat_deg: '89.3S', lon_deg: '137.3W', at: '2027-01-13T00:00Z' });
  console.log(next.headline);
  console.log(JSON.stringify({ sunUpNow: next.sun.upNow, sunset: next.sun.nextSet, earthUpNow: next.earth.upNow, earthset: next.earth.nextSet, earthrise: next.earth.nextRise, searchedTo: next.searchedTo }));

  const best = await call('best_landing_dates', { site_id: 'im2', stay_days: 14, count: 5, compare_to: '2027-01-13' });
  for (const candidate of best.candidates) console.log(JSON.stringify(candidate));
  console.log(`Planned: ${JSON.stringify(best.planned)}`);
  console.log(`Days considered: ${best.daysConsidered}; days tied at best: ${best.daysAtBest}`);

  const link = await call('open_in_navigator', { site_id: 'im2', landing: '2027-01-13', stay_days: 14, slip_days: 14, mode: 'change', sheet: 'compare' });
  console.log(link.opens);
  console.log(link.url);

  if (process.argv.includes('--v2')) await v2();
} finally {
  child.stdin.end();
  const terminate = setTimeout(() => child.kill('SIGTERM'), 2000);
  const kill = setTimeout(() => child.kill('SIGKILL'), 4000);
  const exit = await closed;
  clearTimeout(terminate); clearTimeout(kill);
  assert.deepEqual(exit, { code: 0, signal: null }, 'Server must shut down cleanly on stdin EOF.');
}
console.log('\nServer exited cleanly on stdin EOF.');

// --v2: the three example requests of docs/mcp-v2/DESIGN.md §8, end to end over stdio.
async function v2() {
  const row = (o) => console.log(`  ${JSON.stringify(o)}`);
  console.log('\n=== Request 1: flat, Sun and Earth together 300 h, near a PSR, possible ice, and a route ===');
  const find = await call('find_landing_sites', { criteria: { preset: 'ice_prospector', slope_max_deg: 5, both_continuous_h_min: 300, continuous_from: 'from_landing', psr_distance_km: { max: 5 } }, count: 5, min_spacing_km: 10 });
  console.log(find.headline);
  console.log(`funnel: ${find.funnel.map((f) => `${f.stage} ${f.cells}`).join(' → ')}`);
  for (const c of find.candidates) row({ ref: c.ref, lat: c.lat_deg, lon: c.lon_deg, landing: c.best_landing ?? c.landing, passingDays: c.passing_landings, bothFromLandingH: c.metrics.both_from_landing_h, slope: c.metrics.slope_deg, psrKm: c.metrics.psr_km, ice: c.science_target && { km: c.science_target.dist_km, at: [c.science_target.lat_deg, c.science_target.lon_deg], source: c.science_target.source } });
  console.log(`assumed: ${find.assumed.join(' | ')}`);
  const s1 = find.candidates[0];
  if (s1?.science_target) {
    const route = await call('route_candidates', { points: [{ candidate: 'S1' }, { lat_deg: s1.science_target.lat_deg, lon_deg: s1.science_target.lon_deg }], landing: (s1.best_landing ?? s1.landing).slice(0, 10), max_slope_deg: 15 });
    for (const r of route.routes) row({ route: r.label, km: r.lengthKm, maxSlope: r.maxSlopeDeg, sunPct: r.sunSharePct, psrKm: r.psrKm });
  }
  const csv = await request('resources/read', { uri: `lsn://search/${find.search_id}.csv` });
  console.log(`resource lsn://search/${find.search_id}.csv: ${csv.contents[0].text.split('\n').length - 2} rows`);

  console.log('\n=== Request 2: light and Earth at W2 and W4 of my mission ===');
  const mission = await call('mission_open', { source: { path: fileURLToPath(new URL('../tests/fixtures/mission-record.json', import.meta.url)) } });
  console.log(mission.headline);
  const cond = await call('mission_conditions', { points: ['W2', 'W4'] });
  console.log(cond.headline);
  for (const p of cond.points) {
    const a = p.pass?.arrival;
    row({ point: p.name, arrive: p.arrive, afterLandingH: p.arrival_after_landing_h, sunOnArrival: a && { visible: a.sun.visible, aboveSkylineDeg: a.sun.aboveSkylineDeg }, earthOnArrival: a && { visible: a.earth.visible, aboveSkylineDeg: a.earth.aboveSkylineDeg }, sunsetInH: p.pass?.sun?.nextSet?.inH, earthsetInH: p.pass?.earth?.nextSet?.inH, stayBothH: p.stay?.bothH, risks: p.risks });
  }

  console.log('\n=== Request 3: landing sites still usable if the mission slips 7 days ===');
  const slip = await call('check_slip_robustness', { landing: '2027-01-13', slip: { to_days: 7 } });
  console.log(slip.headline);
  for (const r of slip.rows) row({ place: r.place.id, survives: r.survives_all, firstFail: r.first_fail && `${r.first_fail.check} at +${r.first_fail.slip_h} h` });
  const robust = await call('find_landing_sites', { landing: '2027-01-13', slip: { to_days: 7 }, count: 5 });
  console.log(robust.headline);
  for (const c of robust.candidates) row({ ref: c.ref, lat: c.lat_deg, lon: c.lon_deg, survives: c.slip?.survives_all, worstBothFromLandingH: c.slip?.worst?.both_continuous_h_min ?? null });
  const both = await call('find_landing_sites', { landing: '2027-10-07', slip: { to_days: 7 }, criteria: { slope_max_deg: 5, psr_distance_km: { min: 1, max: 5 }, inside_psr: false, both_continuous_h_min: 300 } });
  console.log(`Requests 1 + 3 together: ${both.feasibility.status}. ${both.feasibility.why}`);
  for (const r of both.feasibility.relaxations ?? []) row(r);
}
