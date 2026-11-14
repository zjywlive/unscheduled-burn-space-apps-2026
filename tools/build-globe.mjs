// Builds demo/globe.html, the phase 1 3D globe page, the same way tools/build.mjs builds index.html:
// the ES modules from demo/src/globe-main.js inlined, small JSON inlined, start-up data packs as classic
// scripts. Run node tools/build-global.mjs first for the globe_* packs.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundle, LOADER_STUB } from './build.mjs';

export const GLOBE_STARTUP_PACKS = ['globe_g0', 'globe_n480', 'dem_480m'];

const jsonScript = (id, value) => `<script type="application/json" id="${id}">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`;

export function buildGlobe(demo = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo'), { log = console.log } = {}) {
  const read = (p) => readFileSync(join(demo, p), 'utf8');
  const template = read('src/globe.template.html');
  const js = bundle(join(demo, 'src', 'globe-main.js')).replace(/<\/script/gi, '<\\/script');
  const data = [
    jsonScript('data-terrain', JSON.parse(read('data/terrain.json'))),
    jsonScript('data-sites', JSON.parse(read('data/sites.json'))),
    ...GLOBE_STARTUP_PACKS.map((n) => `<script src="data/js/${n}.js"></script>`),
  ].join('\n');
  for (const mark of ['<!--STUB-->', '<!--DATA-->', '<!--JS-->']) if (!template.includes(mark)) throw new Error(`globe.template.html is missing ${mark}`);
  const html = template
    .replace('<!--STUB-->', () => LOADER_STUB)
    .replace('<!--DATA-->', () => data)
    .replace('<!--JS-->', () => `<script>\n${js}\n</script>`);
  const out = join(demo, 'globe.html');
  writeFileSync(out, html);
  log(`Wrote demo/globe.html (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) buildGlobe();
