// Downloads the LOLA south-pole terrain grids, their labels and the polar projection notes from NASA PDS
// into data-raw/lola/ (spec §2.1, phase 3 §5.2), and the phase 4 sources (phase 4 §2): the 40 m and 20 m
// LOLA grids into data-raw/lola/, and the Mazarico et al. (2011, 2016 update) PSR and average-visibility
// rasters from imbrium.mit.edu into data-raw/illumination/. Labels are fetched before their images; the
// expected image size is taken from the label (LINES × LINE_SAMPLES × SAMPLE_BITS / 8, which must equal
// FILE_RECORDS × RECORD_BYTES). Files already present with the right size are skipped. Images are streamed
// to disk through a .part file; an interrupted .part is resumed with an HTTP Range request when the server
// allows it, and each file is retried up to five times.
import { mkdirSync, statSync, readFileSync, existsSync, renameSync, createWriteStream, unlinkSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BASE = 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx';
const IMG = `${BASE}/data/lola_gdr/polar/img`;
const ILLUM = 'http://imbrium.mit.edu/EXTRAS/ILLUMINATION/IMG';
export const FILES = [
  { url: `${IMG}/ldem_75s_240m.lbl`, name: 'ldem_75s_240m.lbl' },
  { url: `${IMG}/ldem_75s_240m.img`, name: 'ldem_75s_240m.img', label: 'ldem_75s_240m.lbl' },
  { url: `${IMG}/ldem_75s_120m.lbl`, name: 'ldem_75s_120m.lbl' },
  { url: `${IMG}/ldem_75s_120m.img`, name: 'ldem_75s_120m.img', label: 'ldem_75s_120m.lbl' },
  { url: `${BASE}/catalog/dsmap_polar.cat`, name: 'dsmap_polar.cat' },
  // phase 4 §2
  { url: `${IMG}/ldem_80s_40m.lbl`, name: 'ldem_80s_40m.lbl' },
  { url: `${IMG}/ldem_80s_40m.img`, name: 'ldem_80s_40m.img', label: 'ldem_80s_40m.lbl' },
  { url: `${IMG}/ldem_875s_20m.lbl`, name: 'ldem_875s_20m.lbl' },
  { url: `${IMG}/ldem_875s_20m.img`, name: 'ldem_875s_20m.img', label: 'ldem_875s_20m.lbl' },
  ...['LPSR_75S_120M_201608', 'AVGVISIB_75S_120M_201608', 'AVGVISIB_75S_120M_201608_EARTH'].flatMap((n) => [
    { url: `${ILLUM}/${n}.LBL`, name: `${n}.LBL`, dir: 'illumination' },
    { url: `${ILLUM}/${n}.IMG`, name: `${n}.IMG`, label: `${n}.LBL`, dir: 'illumination' },
  ]),
];
const RAW = new URL('../data-raw/', import.meta.url);
export const rawPath = (f) => new URL(`${f.dir ?? 'lola'}/${f.name}`, RAW);

// Reads the keys needed to interpret an IMG from a PDS3 label.
export function parseLabel(text) {
  const num = (key) => {
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*([-+0-9.]+)`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const str = (key) => {
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([A-Z_ ]+?)"?\\s*$`, 'm'));
    return m ? m[1] : null;
  };
  return {
    lines: num('LINES'), samples: num('LINE_SAMPLES'), bits: num('SAMPLE_BITS'), sampleType: str('SAMPLE_TYPE'),
    scale: num('SCALING_FACTOR'), offset: num('OFFSET'), mapScaleM: num('MAP_SCALE'),
    lineOffset: num('LINE_PROJECTION_OFFSET'), sampleOffset: num('SAMPLE_PROJECTION_OFFSET'),
    centerLat: num('CENTER_LATITUDE'), centerLon: num('CENTER_LONGITUDE'), rotation: num('MAP_PROJECTION_ROTATION'),
    // phase 4 additions; null when the label does not carry the key
    recordBytes: num('RECORD_BYTES'), fileRecords: num('FILE_RECORDS'), missing: num('MISSING_CONSTANT'),
    derivedMin: num('DERIVED_MINIMUM'), derivedMax: num('DERIVED_MAXIMUM'), maxLat: num('MAXIMUM_LATITUDE'),
    projection: str('MAP_PROJECTION_TYPE'), radiusKm: num('A_AXIS_RADIUS'),
  };
}

// Expected IMG bytes from its label; throws when the label is not a plain 16-bit LSB raster without a header.
export function expectedBytes(l) {
  if (l.sampleType !== 'LSB_INTEGER' || l.bits !== 16) throw new Error(`unexpected ${l.sampleType}/${l.bits}`);
  const size = l.lines * l.samples * l.bits / 8;
  if (l.recordBytes !== null && l.fileRecords !== null && l.recordBytes * l.fileRecords !== size) throw new Error(`records ${l.fileRecords} × ${l.recordBytes} ≠ ${size}`);
  return size;
}

async function download(f, size) {
  const path = rawPath(f), part = new URL(`${f.name}.part`, path);
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      let have = existsSync(part) ? statSync(part).size : 0;
      if (size && have > size) { unlinkSync(part); have = 0; }
      const headers = have ? { Range: `bytes=${have}-` } : {};
      const t0 = Date.now();
      const res = await fetch(f.url, { headers });
      if (res.status === 416 && size && have === size) { /* already complete */ } else {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const append = have > 0 && res.status === 206;
        if (have && !append) console.log(`     server ignored the range, restarting ${f.name}`);
        else if (append) console.log(`     resuming ${f.name} at ${have} bytes`);
        await pipeline(Readable.fromWeb(res.body), createWriteStream(part, { flags: append ? 'a' : 'w' }));
      }
      const got = statSync(part).size;
      if (size && got !== size) throw new Error(`${got} bytes, expected ${size}`);
      renameSync(part, path);
      console.log(`     ${f.name}: ${got} bytes in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      return;
    } catch (e) {
      console.error(`     ${f.name}: attempt ${attempt} failed: ${e.message}`);
      if (attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const only = process.argv.slice(2);   // optional file names to limit the run
  for (const dir of new Set(FILES.map((f) => f.dir ?? 'lola'))) mkdirSync(new URL(`${dir}/`, RAW), { recursive: true });
  for (const f of FILES) {
    if (only.length && !only.includes(f.name) && !only.includes(f.label)) continue;
    const path = rawPath(f);
    let size = null;
    if (f.label) {
      const l = parseLabel(readFileSync(rawPath({ ...f, name: f.label }), 'utf8'));
      try { size = expectedBytes(l); } catch (e) { console.error(`${f.label}: ${e.message}`); process.exit(1); }
      console.log(`     ${f.label}: ${l.lines} × ${l.samples}, ${l.mapScaleM} m/pix, offset ${l.lineOffset}/${l.sampleOffset}, DN × ${l.scale} + ${l.offset}`);
    }
    if (existsSync(path) && (!size || statSync(path).size === size)) { console.log(`skip ${f.name} (present)`); continue; }
    console.log(`get  ${f.url}`);
    try { await download(f, size); } catch (e) { console.error(`${f.name}: giving up (${e.message})`); process.exit(1); }
  }
}
