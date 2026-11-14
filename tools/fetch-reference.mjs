// Asks Horizons for Sun and Earth azimuth/elevation with the observer on the lunar surface,
// as an independent reference for the demo's own geometry. Writes demo/data/horizons_reference.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { horizonsRequest, parseUtc } from './horizons.mjs';

const SITE_IDS = ['apollo11', 'change4', 'im2', 'shackleton'];
const BODIES = [['sun', '10'], ['earth', '399']];
const EXPECTED = SITE_IDS.length * BODIES.length * 121;

const sites = JSON.parse(readFileSync(new URL('../demo/data/sites.json', import.meta.url)));
const cases = [];
for (const siteId of SITE_IDS) {
  const site = sites.find((s) => s.id === siteId);
  for (const [body, command] of BODIES) {
    const { rows } = await horizonsRequest({
      COMMAND: command, CENTER: 'coord@301', COORD_TYPE: 'GEODETIC',
      SITE_COORD: `${site.lonDeg},${site.latDeg},0`, EPHEM_TYPE: 'OBSERVER', QUANTITIES: '4',
      START_TIME: '2027-03-01', STOP_TIME: '2027-03-31', STEP_SIZE: '6h',
    });
    for (const { utc, values } of rows) cases.push({ siteId, body, tMs: parseUtc(utc), azDeg: values[0], elDeg: values[1] });
    console.log(`${siteId} ${body}: ${rows.length} rows`);
  }
}
if (cases.length !== EXPECTED) {
  console.error(`Expected ${EXPECTED} reference values, got ${cases.length}`);
  process.exit(1);
}
const out = { meta: { generatedAt: new Date().toISOString(), start: '2027-03-01', stop: '2027-03-31', step: '6h' }, cases };
writeFileSync(new URL('../demo/data/horizons_reference.json', import.meta.url), JSON.stringify(out));
console.log(`Wrote ${cases.length} reference values to demo/data/horizons_reference.json`);
