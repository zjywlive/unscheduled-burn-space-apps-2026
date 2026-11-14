// Builds the products taken from the official LOLA illumination rasters (Mazarico et al. 2011, Icarus 211,
// 1066–1081; 2016 update; phase 4 §3 D.3, D.5, contracts §4.2, §4.3):
//   demo/data/psr_120m.bin       5400 × 5400 bits, rows top (+y) to bottom, MSB first; 1 = permanent shadow
//   demo/data/nasa_sun_480m.bin  1350 × 1350 Uint8, round(mean Sun visibility × 250), 255 = no data
//   demo/data/nasa_earth_480m.bin  same for the Earth
// All three span ±324 km about the pole. The 120 m sources are 7624² with the pole between the two middle
// pixels (LINE/SAMPLE_PROJECTION_OFFSET 3811.5), so the ±324 km window is the centred 5400² crop, and the
// 480 m grids are 4 × 4 means of that crop. Pixel values are decoded with the label's SCALING_FACTOR and
// OFFSET: PSR flag = DN × 0.000025 + 0.5 (DN ±20000), visibility = DN × 0.00004 (0…25000 → 0…1).
// Merges `psr`, `nasaAvg` and the six sources into terrain.json.
// Also hosts the worker used by validate.mjs to compute sunlit shares over the whole ephemeris.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseLabel, FILES, rawPath } from './fetch-lola.mjs';

export const SRC_SIZE = 7624;
export const PSR = { file: 'psr_120m.bin', size: 5400, kmPerPixel: 0.12, halfKm: 324 };
export const AVG = { size: 1350, kmPerPixel: 0.48, halfKm: 324, factor: 4, scale: 250, noData: 255 };
export const ILLUM = {
  psr: 'LPSR_75S_120M_201608',
  sun: 'AVGVISIB_75S_120M_201608',
  earth: 'AVGVISIB_75S_120M_201608_EARTH',
};
export const MAZARICO = 'Mazarico, E., Neumann, G. A., Smith, D. E., Zuber, M. T., Torrence, M. H. (2011), Illumination conditions of the lunar polar regions using LOLA topography, Icarus 211, 1066–1081, doi:10.1016/j.icarus.2010.10.030; LOLA PDS extras, 2016-08 update';

// Checks the label of one of the illumination rasters; returns the decoded label or throws.
export function checkIllumLabel(l, kind) {
  const ok = l.lines === SRC_SIZE && l.samples === SRC_SIZE && l.bits === 16 && l.sampleType === 'LSB_INTEGER'
    && l.mapScaleM === 120 && l.lineOffset === SRC_SIZE / 2 - 0.5 && l.sampleOffset === SRC_SIZE / 2 - 0.5
    && l.centerLat === -90 && l.centerLon === 0 && l.rotation === 0 && l.projection === 'POLAR STEREOGRAPHIC'
    && l.radiusKm === 1737.4 && l.missing === null
    && (kind === 'psr' ? l.scale === 0.000025 && l.offset === 0.5 : l.scale === 0.00004 && l.offset === 0);
  if (!ok) throw new Error(`${ILLUM[kind]}.LBL does not match the expected layout: ${JSON.stringify(l)}`);
  return l;
}

export function readIllum(kind) {
  const name = ILLUM[kind];
  const label = checkIllumLabel(parseLabel(readFileSync(rawPath({ name: `${name}.LBL`, dir: 'illumination' }), 'utf8')), kind);
  const buf = readFileSync(rawPath({ name: `${name}.IMG`, dir: 'illumination' }));
  if (buf.length !== SRC_SIZE * SRC_SIZE * 2) throw new Error(`${name}.IMG: ${buf.length} bytes`);
  return { label, data: new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2) };
}

// Physical value of a DN per the label: DN × SCALING_FACTOR + OFFSET.
export const decode = (label, dn) => dn * label.scale + label.offset;

// PSR flags (Uint8 0/1) of the whole source raster; `odd` counts DNs other than ±20000.
export function psrMask(src, label) {
  const mask = new Uint8Array(src.length);
  let odd = 0;
  for (let k = 0; k < src.length; k++) {
    const v = src[k];
    if (v !== 20000 && v !== -20000) odd++;
    mask[k] = decode(label, v) >= 0.5 ? 1 : 0;
  }
  return { mask, odd };
}

// Centred n² crop of a square raster (any typed array).
export function cropCentred(src, srcSize, n) {
  const o = (srcSize - n) / 2;
  if (!Number.isInteger(o)) throw new Error('crop is not centred on a pixel boundary');
  const dst = new src.constructor(n * n);
  for (let r = 0; r < n; r++) dst.set(src.subarray((o + r) * srcSize + o, (o + r) * srcSize + o + n), r * n);
  return dst;
}

// n² 0/1 mask → bytes, row by row, most significant bit first (n need not be a multiple of 8: rows are
// concatenated bit by bit).
export function packBits(mask, n) {
  const out = new Uint8Array(Math.ceil((n * n) / 8));
  for (let k = 0; k < n * n; k++) if (mask[k]) out[k >> 3] |= 0x80 >> (k & 7);
  return out;
}
export function bitAt(bits, n, row, col) {
  const k = row * n + col;
  return (bits[k >> 3] >> (7 - (k & 7))) & 1;
}
export function unpackBits(bits, n) {
  const out = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) out[k] = (bits[k >> 3] >> (7 - (k & 7))) & 1;
  return out;
}

// f × f block means of a decoded visibility raster (n² source → (n/f)²), as round(mean × scale);
// DNs whose value is outside [0, 1] are no data; a block without data is `noData`.
export function blockAverage(src, n, f, label, { scale = 250, noData = 255 } = {}) {
  const m = n / f;
  if (!Number.isInteger(m)) throw new Error('block size does not divide the raster');
  const out = new Uint8Array(m * m);
  let missing = 0;
  for (let R = 0; R < m; R++) for (let C = 0; C < m; C++) {
    let sum = 0, cnt = 0;
    for (let r = R * f; r < (R + 1) * f; r++) for (let c = C * f; c < (C + 1) * f; c++) {
      const v = decode(label, src[r * n + c]);
      if (v >= 0 && v <= 1) { sum += v; cnt++; } else missing++;
    }
    out[R * m + C] = cnt ? Math.round((sum / cnt) * scale) : noData;
  }
  return { out, missing };
}

// ---------- sunlit-share worker for validate.mjs ----------
// Per cell of a skyline grid: Sun and Earth shares at `stepH` steps over [startMs, endMs] (both ends
// included, like the terrain checks), and whether any sample on the `coarseH` sub-grid of those steps sees
// the Sun (the phase 3 persistent-shadow test). With `coarseOnly`, only the coarse test runs, stopping at
// the first lit sample.
export async function sunlitShares({ h, cells, stepH = 1, coarseH = 6, coarseOnly = false }) {
  const threads = Math.max(1, availableParallelism() - 1);
  const sun = new Float32Array(h.size * h.size), earth = new Float32Array(h.size * h.size), lit = new Uint8Array(h.size * h.size);
  let next = 0, finished = 0;
  const send = (worker) => {
    if (next >= h.size) { worker.postMessage(null); return; }
    worker.postMessage({ j: next, row: cells.slice(next * h.size, (next + 1) * h.size) });
    next++;
  };
  await new Promise((resolve, reject) => {
    for (let w = 0; w < threads; w++) {
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { mode: 'shares', h, stepH, coarseH, coarseOnly } });
      worker.on('error', reject);
      worker.on('message', ({ j, s, e, l }) => {
        sun.set(s, j * h.size); earth.set(e, j * h.size); lit.set(l, j * h.size);
        finished++;
        send(worker);
        if (finished === h.size) resolve();
      });
      send(worker);
    }
  });
  return { sun, earth, lit };
}

if (!isMainThread && workerData?.mode === 'shares') {
  const { createHeatGrid } = await import('../demo/src/heat.js');
  const { createEphemeris } = await import('../demo/src/ephemeris.js');
  const DATA = new URL('../demo/data/', import.meta.url);
  const { h, stepH, coarseH, coarseOnly } = workerData;
  const horizon = readFileSync(new URL(h.file, DATA));
  const grid = createHeatGrid({ ...h, horizon: new Uint8Array(horizon.buffer, horizon.byteOffset, horizon.length) });
  const eph = createEphemeris(JSON.parse(readFileSync(new URL('ephemeris.json', DATA))));
  const every = coarseH / stepH;
  const dirs = [];
  for (let t = eph.startMs, m = 0; t <= eph.endMs; t += stepH * 3600e3, m++) if (!coarseOnly || m % every === 0) dirs.push(eph.at(t));
  if (dirs.some((d) => !d)) throw new Error('ephemeris gap');
  parentPort.on('message', (msg) => {
    if (msg === null) { process.exit(0); }
    const { j, row } = msg;
    const s = new Float32Array(h.size), e = new Float32Array(h.size), l = new Uint8Array(h.size);
    for (let i = 0; i < h.size; i++) {
      if (!row[i]) continue;
      const k = j * h.size + i;
      if (coarseOnly) {
        for (const d of dirs) if (grid.visibility(k, d) & 1) { l[i] = 1; break; }
        continue;
      }
      let ns = 0, ne = 0, anyCoarse = 0;
      for (let m = 0; m < dirs.length; m++) {
        const v = grid.visibility(k, dirs[m]);
        if (v & 1) { ns++; if (m % every === 0) anyCoarse = 1; }
        if (v & 2) ne++;
      }
      s[i] = ns / dirs.length; e[i] = ne / dirs.length; l[i] = anyCoarse;
    }
    parentPort.postMessage({ j, s, e, l }, [s.buffer, e.buffer, l.buffer]);
  });
}

if (isMainThread && process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const DATA = new URL('../demo/data/', import.meta.url);
  const t0 = Date.now();
  const writeIfChanged = (name, bytes) => {
    const f = new URL(name, DATA);
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (existsSync(f) && Buffer.compare(readFileSync(f), b) === 0) { console.log(`${name}: unchanged`); return; }
    writeFileSync(f, b);
    console.log(`${name}: written, ${b.length} bytes`);
  };

  const psr = readIllum('psr');
  const { mask, odd } = psrMask(psr.data, psr.label);
  if (odd) { console.error(`PSR raster has ${odd} DNs other than ±20000`); process.exit(1); }
  const crop = cropCentred(mask, SRC_SIZE, PSR.size);
  let n = 0;
  for (const v of crop) n += v;
  writeIfChanged(PSR.file, packBits(crop, PSR.size));
  console.log(`  PSR pixels in ±324 km: ${n} (${(100 * n / crop.length).toFixed(3)} %), ${(n * 0.0144).toFixed(0)} km² on the map plane`);

  const avg = {};
  for (const kind of ['sun', 'earth']) {
    const src = readIllum(kind);
    // PSR and Sun visibility must agree: the Sun label says DN 0 means permanent shadow.
    if (kind === 'sun') {
      let both = 0, psrOnly = 0, zeroOnly = 0;
      for (let k = 0; k < mask.length; k++) {
        const z = src.data[k] === 0;
        if (mask[k] && z) both++; else if (mask[k]) psrOnly++; else if (z) zeroOnly++;
      }
      console.log(`  PSR vs Sun DN 0 over the whole raster: both ${both}, PSR only ${psrOnly}, DN 0 only ${zeroOnly}`);
      avg.consistency = { both, psrOnly, zeroOnly };
    }
    const { out, missing } = blockAverage(cropCentred(src.data, SRC_SIZE, PSR.size), PSR.size, AVG.factor, src.label, AVG);
    let sum = 0, cnt = 0;
    for (const v of out) if (v !== AVG.noData) { sum += v; cnt++; }
    writeIfChanged(`nasa_${kind}_480m.bin`, out);
    console.log(`  ${kind}: ${missing} no-data source pixels; mean ${(sum / cnt / 2.5).toFixed(2)} % over ${cnt} cells`);
  }

  const meta = JSON.parse(readFileSync(new URL('terrain.json', DATA)));
  meta.psr = {
    file: PSR.file, size: PSR.size, kmPerPixel: PSR.kmPerPixel, halfKm: PSR.halfKm, bitOrder: 'rows top to bottom, most significant bit first',
    source: `${ILLUM.psr}.IMG (${MAZARICO})`,
    rule: 'Bit = 1 where the official permanently-shadowed-region flag (DN × 0.000025 + 0.5) is 1: the pixel never sees any part of the Sun over the 18.6-year simulation at 1 h steps. Centred 5400² crop of the 120 m source; no resampling.',
  };
  const avgEntry = (kind) => ({ file: `nasa_${kind}_480m.bin`, size: AVG.size, kmPerPixel: AVG.kmPerPixel, halfKm: AVG.halfKm, scale: AVG.scale, noData: AVG.noData, source: `${ILLUM[kind]}.IMG` });
  meta.nasaAvg = {
    sun: { ...avgEntry('sun'), meaning: 'share of time steps with any part of the solar disc above the local horizon' },
    earth: { ...avgEntry('earth'), meaning: 'share of time steps with any part of the Earth disc above the local horizon' },
    source: MAZARICO, span: '18.6 years, 1 h steps',
    rule: 'Byte = round(mean of the 4 × 4 120 m pixels × 250); 255 = no data. Centred ±324 km window of the 120 m source.',
  };
  const names = Object.values(ILLUM).flatMap((n) => [`${n}.IMG`, `${n}.LBL`]);
  meta.sources = [...meta.sources.filter((s) => !names.includes(s.name)), ...names.map((name) => {
    const f = FILES.find((x) => x.name === name);
    return { name, url: f.url, bytes: statSync(rawPath(f)).size };
  })];
  writeFileSync(new URL('terrain.json', DATA), JSON.stringify(meta, null, 2));
  console.log(`terrain.json written; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
