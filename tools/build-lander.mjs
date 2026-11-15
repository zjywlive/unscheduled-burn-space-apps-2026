// Builds demo/lander.html in place: the ES modules under demo/src/lander/ are bundled with tools/build.mjs's
// bundle() (same module conventions) and written, with the loader stub and the JSON data, between the
// <!--LANDER:NAME--> … <!--/LANDER:NAME--> markers. The rest of the page (markup and CSS) is edited by hand.
// The data packs (demo/data/js/*.js) are the ones tools/build.mjs and tools/fetch-hires.mjs write; this script does
// not touch them. demo/data/hires.json (the high-resolution patch manifest) is optional: without it the page
// falls back to the 20/40/120 m levels.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundle, LOADER_STUB } from './build.mjs';
import { bootMarkup, BOOT_CSS } from '../demo/src/boot.js';

// BOOTCSS (in <head>) and BOOT (right after <body>): the shared loading screen (demo/src/boot.js), in the page
// itself so it shows before any script runs
export const LANDER_MARKS = ['BOOTCSS', 'STUB', 'BOOT', 'DATA', 'JS'];

export function fillMark(html, name, content) {
  const re = new RegExp(`(<!--LANDER:${name}-->)[\\s\\S]*?(<!--/LANDER:${name}-->)`);
  if (!re.test(html)) throw new Error(`the page is missing <!--LANDER:${name}--> … <!--/LANDER:${name}-->`);
  return html.replace(re, (_, a, b) => `${a}\n${content}\n${b}`);
}

const jsonScript = (id, value) => `<script type="application/json" id="${id}">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`;

// The pages built from the lander modules. lander.html holds the CSS they share (its main <style> block, edited by
// hand); the other pages get a copy of it in their <!--LANDER:CSS--> block. A page missing from the folder is skipped.
//   lander.html    step 3 of the mission: the frozen configuration flown, launch to surface operations
//   planner.html   "Where to land", the Map's region level (also opens on its own)
//   finalise.html  step 2: go / no-go checks, the vehicle, freezing the configuration
export const LANDER_PAGES = [
  { file: 'lander.html', entry: 'main.js', boot: ['Mission execution', 'The frozen mission, launch to surface operations', 'Loading the trajectory and terrain…'] },
  { file: 'planner.html', entry: 'planner-main.js', boot: ['Where to land', 'Landing spots anywhere on the Moon', 'Loading the terrain…'], css: true },
  { file: 'finalise.html', entry: 'finalise-main.js', boot: ['Finalise the mission', 'Go / no-go checks and the frozen configuration', 'Checking the plan…'], css: true },
];

// lander.html's main CSS (the <style> block after the loading screen's)
export function sharedCss(landerHtml) {
  const blocks = [...landerHtml.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).filter((c) => !c.includes('#lsn-boot'));
  if (!blocks.length) throw new Error('demo/lander.html has no main <style> block');
  return blocks[0];
}

export function buildLander(demo = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo'), { log = console.log } = {}) {
  const data = (p) => JSON.parse(readFileSync(join(demo, p), 'utf8'));
  const dataBlock = [
    jsonScript('data-ephemeris', data('data/ephemeris.json')),
    jsonScript('data-sites', data('data/sites.json')),
    jsonScript('data-terrain', data('data/terrain.json')),
    jsonScript('data-hires', existsSync(join(demo, 'data', 'hires.json')) ? data('data/hires.json') : null),
  ].join('\n');
  const css = sharedCss(readFileSync(join(demo, 'lander.html'), 'utf8'));
  let first = null;
  for (const pg of LANDER_PAGES) {
    const file = join(demo, pg.file);
    if (!existsSync(file)) continue;
    let html = readFileSync(file, 'utf8');
    const js = bundle(join(demo, 'src', 'lander', pg.entry)).replace(/<\/script/gi, '<\\/script');
    html = fillMark(html, 'BOOTCSS', `<style>${BOOT_CSS}</style>`);
    if (pg.css) html = fillMark(html, 'CSS', `<style>${css}</style>`);
    html = fillMark(html, 'BOOT', bootMarkup(...pg.boot));
    html = fillMark(html, 'STUB', LOADER_STUB);
    html = fillMark(html, 'DATA', dataBlock);
    html = fillMark(html, 'JS', `<script>\n${js}\n</script>`);
    writeFileSync(file, html);
    const kb = Buffer.byteLength(html) / 1024;
    log(`Wrote demo/${pg.file} (${kb.toFixed(0)} KB; bundle ${(Buffer.byteLength(js) / 1024).toFixed(0)} KB)`);
    first ??= { file, bytes: Buffer.byteLength(html) };
  }
  return first;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) buildLander();
