// Downloads the global LOLA elevation products for the phase 1 global terrain model (docs/PHASES.md) from
// NASA PDS into data-raw/: the LDEM_4, LDEM_16 and LDEM_64 simple-cylindrical grids (global, 4 / 16 / 64
// pixels per degree) into data-raw/global/, and the 75°N–90°N 240 m polar grid into data-raw/lola/.
// Same rules as fetch-lola.mjs: label first, expected size from the label, resume with Range, five retries.
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { parseLabel, expectedBytes, download, rawPath } from './fetch-lola.mjs';

const BASE = 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr';
const CYL = `${BASE}/cylindrical/img`;
const POLAR = `${BASE}/polar/img`;
export const GLOBAL_FILES = [
  ...['ldem_4', 'ldem_16', 'ldem_64'].flatMap((n) => [
    { url: `${CYL}/${n}.lbl`, name: `${n}.lbl`, dir: 'global' },
    { url: `${CYL}/${n}.img`, name: `${n}.img`, label: `${n}.lbl`, dir: 'global' },
  ]),
  { url: `${POLAR}/ldem_75n_240m.lbl`, name: 'ldem_75n_240m.lbl' },
  { url: `${POLAR}/ldem_75n_240m.img`, name: 'ldem_75n_240m.img', label: 'ldem_75n_240m.lbl' },
];

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const only = process.argv.slice(2);
  for (const f of GLOBAL_FILES) mkdirSync(new URL('./', rawPath(f)), { recursive: true });
  for (const f of GLOBAL_FILES) {
    if (only.length && !only.includes(f.name) && !only.includes(f.label)) continue;
    const path = rawPath(f);
    let size = null;
    if (f.label) {
      const l = parseLabel(readFileSync(rawPath({ ...f, name: f.label }), 'utf8'));
      size = expectedBytes(l);
      console.log(`     ${f.label}: ${l.lines} × ${l.samples}, ${l.mapScaleM} m/pix, DN × ${l.scale} + ${l.offset}`);
    }
    if (existsSync(path) && (!size || statSync(path).size === size)) { console.log(`skip ${f.name} (present)`); continue; }
    console.log(`get  ${f.url}`);
    try { await download(f, size); } catch (e) { console.error(`${f.name}: giving up (${e.message})`); process.exit(1); }
  }
  console.log('done');
}
