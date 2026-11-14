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
} finally {
  child.stdin.end();
  const terminate = setTimeout(() => child.kill('SIGTERM'), 2000);
  const kill = setTimeout(() => child.kill('SIGKILL'), 4000);
  const exit = await closed;
  clearTimeout(terminate); clearTimeout(kill);
  assert.deepEqual(exit, { code: 0, signal: null }, 'Server must shut down cleanly on stdin EOF.');
}
console.log('\nServer exited cleanly on stdin EOF.');
