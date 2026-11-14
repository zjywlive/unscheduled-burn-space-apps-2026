// Manual Task G browser checks, not a node:test suite. Reuses G's fps sampler and CDP helper.
// node tests/helpers/g-check.mjs fps before|after 1728x996x1|1440x900x2
// node tests/helpers/g-check.mjs shots after 1728x996x1
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { openBrowser } from '../../docs/phase4/g-scripts/cdp.mjs';

const root = new URL('../../', import.meta.url);
// Keep the disposable Chrome profile inside this project too.
process.env.TMPDIR = fileURLToPath(new URL('tests/', root));
const [kind = 'fps', stage = 'after', size = '1728x996x1'] = process.argv.slice(2);
const [W, H, DPR] = size.split('x').map(Number);
const sampler = readFileSync(new URL('docs/phase5/g-scripts/fps.mjs', root), 'utf8').match(/const r = await b.evaluate\(`(new Promise[\s\S]*?)`\);/)[1];
const PAGE = new URL('demo/index.html', root).href;
const rows = [];
let b;
async function timed(label, fn, ms = 20000) {
  let t;
  try { return await Promise.race([fn(), new Promise((_, no) => { t = setTimeout(() => no(new Error(`${label}: timeout ${ms} ms`)), ms); })]); }
  finally { clearTimeout(t); }
}
const ev = (code, ms) => timed('evaluate', () => b.evaluate(code), ms);
async function start() {
  b = await timed('openBrowser', () => openBrowser({ args: ['--allow-file-access-from-files'] }));
  await timed('size', () => b.size(W, H, DPR));
  await timed('media', () => b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }));
}
async function close() { if (b) { const old = b; b = null; await timed('close', () => old.close()); } }
async function ready(hash) {
  if (!b) await start();
  await timed('navigate', () => b.go(PAGE + hash));
  await timed('heat ready', () => b.waitFor("window.__lsn && document.querySelector('.map-frame')?.dataset.heat === 'done' && document.querySelector('.map-frame')?.dataset.sharp !== 'working'", 60000), 65000);
  await sleep(1500);
}
const cases = kind === 'extras'
  ? [...['earth', 'change', 'score'].flatMap(mode => [1, 2].map(z => ({ mode, z }))),
    ...[false, true].flatMap(off => [1, 2, 8].map(z => ({ mode: 'now', z, off, playing: true })))]
  : kind === 'fps'
  ? ['both', 'now'].flatMap(mode => [1, 2, 8].map(z => ({ mode, z })))
  : ['both', 'sun', 'now'].flatMap(mode => [false, true].flatMap(off => [1, 1.5, 2, 2.2, 4].map(z => ({ mode, z, off }))));
try {
  for (const c of cases) {
    if (process.env.ONLY && !`${c.mode}-${c.z}-${c.off ? 'nowin' : 'window'}`.includes(process.env.ONLY)) continue;
    const hash = `#mode=${c.mode}&z=${c.z}&site=im2&cx=-11.8&cy=31.8&t=2027-01-13T00:00Z&stay=14&now=2027-01-20T06:00Z${c.off ? '&win=off' : ''}`;
    try {
      await ready(hash);
      if (kind === 'fps') {
        await ev(`(() => {
          window.__paints = []; window.__livePaints = [];
          const f = document.querySelector('.map-frame');
          new MutationObserver(es => { for (const e of es) if (e.attributeName === 'data-paint-ms') __paints.push(+f.dataset.paintMs); }).observe(f, { attributes: true, attributeFilter: ['data-paint-ms'] });
          const ctx = document.querySelector('.map-live').getContext('2d'), clear = ctx.clearRect.bind(ctx), restore = ctx.restore.bind(ctx); let t;
          ctx.clearRect = (...a) => { t = performance.now(); return clear(...a); };
          ctx.restore = (...a) => { const r = restore(...a); __livePaints.push(performance.now() - t); return r; };
          __lsn.timeline.setRate(6 * 3600e3); __lsn.timeline.play(); return true;
        })()`);
        await sleep(1000);
        await ev('(__paints.length = 0, __livePaints.length = 0, true)');
        const fps = await ev(sampler);
        const paint = await ev(`(() => { const stats = a => { a.sort((x,y) => x-y); return { n: a.length, median: a[a.length >> 1] ?? null, p90: a[Math.floor(a.length * .9)] ?? null, max: a.at(-1) ?? null }; }; const f = document.querySelector('.map-frame'); return { heatMs: stats(__paints), veilMs: stats(__livePaints), redrawMs: f.dataset.redrawMs, canvas: [document.querySelector('.map-canvas').width, document.querySelector('.map-canvas').height], tier: f.dataset.tier }; })()`);
        rows.push({ ...c, ...fps, ...paint, errors: [...b.errors] });
        await ev('(__lsn.timeline.pause(), true)');
      } else {
        if (c.playing) {
          await ev('(__lsn.timeline.setRate(1), __lsn.timeline.play(), true)');
          await sleep(500);
        }
        const file = `A-smooth-${c.mode}-${c.off ? 'nowin' : 'window'}${c.playing ? '-playing' : ''}-z${c.z}-${size}.png`;
        const actual = await ev('({mode: __lsn.state().mapMode, tier: document.querySelector(".map-frame").dataset.tier})');
        await timed('screenshot', () => b.shot(fileURLToPath(new URL(`docs/phase5/shots/${file}`, root))));
        rows.push({ ...c, ...actual, file, errors: [...b.errors] });
      }
      console.log(JSON.stringify(rows.at(-1)));
    } catch (e) {
      rows.push({ ...c, error: e.message }); console.log(JSON.stringify(rows.at(-1)));
      await close();
    }
  }
} finally {
  await close();
  writeFileSync(new URL(`g-${kind}-${stage}-${size}.json`, import.meta.url), JSON.stringify(rows, null, 2) + '\n');
}
