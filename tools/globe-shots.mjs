// Screenshots of demo/globe.html in headless Chrome (software WebGL), each taken once the globe has
// nothing left to build, with the renderer's stats. For checking the globe without a visible browser.
// Usage: node tools/globe-shots.mjs <base url> <out dir> [name=#hash ...]
//   node tools/globe-shots.mjs http://localhost:8741/globe.html /tmp/shots whole= shackleton='#lat=-89.67&lon=129.78&dist=55&tilt=50&heading=30'
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [base, out, ...specs] = process.argv.slice(2);
if (!base || !out) { console.error('usage: node tools/globe-shots.mjs <base url> <out dir> [name=#hash ...]'); process.exit(1); }
mkdirSync(out, { recursive: true });
const shots = (specs.length ? specs : ['whole=']).map((s) => { const i = s.indexOf('='); return { name: s.slice(0, i), hash: s.slice(i + 1) }; });

const profile = mkdtempSync(join(tmpdir(), 'globe-shots-'));
const port = 9300 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--window-size=1280,800', `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 50; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const t = list.find((x) => x.type === 'page'); if (t) return t; } catch {}
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

try {
  const t = await target();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const k = ++id; waiting.set(k, r); ws.send(JSON.stringify({ id: k, method, params })); });
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  for (const s of shots) {
    await send('Page.navigate', { url: `${base}${s.hash}` });
    const t0 = Date.now();
    let stats = null, quiet = 0;
    while (Date.now() - t0 < 120000) {
      await sleep(500);
      stats = await evaluate('window.__globe ? { ...__globe.view.stats, loading: document.getElementById("loading").textContent, centre: document.getElementById("centre-src").textContent } : null');
      quiet = stats && stats.queued === 0 && !stats.loading ? quiet + 1 : 0;
      if (quiet >= 3) break;
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(out, `${s.name}.png`), Buffer.from(shot.result.data, 'base64'));
    console.log(`${s.name}: ${((Date.now() - t0) / 1000).toFixed(1)} s`, JSON.stringify(stats));
    if (process.env.EVAL) console.log('  eval:', JSON.stringify(await evaluate(process.env.EVAL)));
  }
  ws.close();
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
