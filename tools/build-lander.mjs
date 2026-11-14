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
  if (!re.test(html)) throw new Error(`demo/lander.html is missing <!--LANDER:${name}--> … <!--/LANDER:${name}-->`);
  return html.replace(re, (_, a, b) => `${a}\n${content}\n${b}`);
}

const jsonScript = (id, value) => `<script type="application/json" id="${id}">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`;

export function buildLander(demo = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo'), { log = console.log } = {}) {
  const file = join(demo, 'lander.html');
  let html = readFileSync(file, 'utf8');
  const data = (p) => JSON.parse(readFileSync(join(demo, p), 'utf8'));
  const js = bundle(join(demo, 'src', 'lander', 'main.js')).replace(/<\/script/gi, '<\\/script');
  html = fillMark(html, 'BOOTCSS', `<style>${BOOT_CSS}</style>`);
  html = fillMark(html, 'BOOT', bootMarkup('Lunar Lander', 'Earth orbit to a south-pole touchdown', 'Loading the trajectory and terrain…'));
  html = fillMark(html, 'STUB', LOADER_STUB);
  html = fillMark(html, 'DATA', [
    jsonScript('data-ephemeris', data('data/ephemeris.json')),
    jsonScript('data-sites', data('data/sites.json')),
    jsonScript('data-terrain', data('data/terrain.json')),
    jsonScript('data-hires', existsSync(join(demo, 'data', 'hires.json')) ? data('data/hires.json') : null),
  ].join('\n'));
  html = fillMark(html, 'JS', `<script>\n${js}\n</script>`);
  writeFileSync(file, html);
  const kb = Buffer.byteLength(html) / 1024;
  log(`Wrote demo/lander.html (${kb.toFixed(0)} KB; bundle ${(Buffer.byteLength(js) / 1024).toFixed(0)} KB)`);
  return { file, bytes: Buffer.byteLength(html) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) buildLander();
