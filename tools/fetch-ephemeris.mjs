// Fetches Moon-fixed sub-solar and sub-Earth points from JPL Horizons into demo/data/ephemeris.json.
import { writeFileSync } from 'node:fs';
import { horizonsRequest } from './horizons.mjs';

const AU_KM = 149597870.7;
const EXPECTED_ROWS = 6337;
const r4 = (v) => Math.round(v * 1e4) / 1e4;

const params = {
  COMMAND: '301', CENTER: '500@399', EPHEM_TYPE: 'OBSERVER',
  START_TIME: '2026-11-01', STOP_TIME: '2029-01-01', STEP_SIZE: '3h', QUANTITIES: '14,15,20',
};
const { header, rows } = await horizonsRequest(params);
if (rows.length !== EXPECTED_ROWS) {
  console.error(`Expected ${EXPECTED_ROWS} rows, got ${rows.length}`);
  process.exit(1);
}
const apiVersion = /API VERSION:\s*(\S+)/.exec(header)?.[1];
const ephemeris = /source:\s*(DE\d+)/.exec(header)?.[1];
if (!apiVersion || !ephemeris) {
  console.error('Could not read API version or ephemeris from the Horizons header');
  process.exit(1);
}
const out = {
  meta: {
    source: 'JPL Horizons API', apiVersion, ephemeris,
    target: 'Moon (301)', observer: 'Geocentric (500@399)', quantities: params.QUANTITIES,
    start: '2026-11-01T00:00:00Z', stop: '2029-01-01T00:00:00Z', stepHours: 3,
    generatedAt: new Date().toISOString(), moonRadiusKm: 1737.4, auKm: AU_KM,
  },
  subEarthLon: [], subEarthLat: [], subSunLon: [], subSunLat: [], earthRangeKm: [],
};
for (const { utc, values } of rows) {
  if (values.length < 5) { console.error(`Short row at ${utc}: ${values}`); process.exit(1); }
  out.subEarthLon.push(r4(values[0]));
  out.subEarthLat.push(r4(values[1]));
  out.subSunLon.push(r4(values[2]) % 360);
  out.subSunLat.push(r4(values[3]));
  out.earthRangeKm.push(Math.round(values[4] * AU_KM));
}
const path = new URL('../demo/data/ephemeris.json', import.meta.url);
writeFileSync(path, JSON.stringify(out));
console.log(`Wrote ${rows.length} rows (${ephemeris}, API ${apiVersion}) to demo/data/ephemeris.json`);
console.log(`First row ${rows[0].utc}: ${rows[0].values.join(' ')}`);
