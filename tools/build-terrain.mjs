// Builds the terrain products from the LOLA polar grids (spec phase 2 §2.4, phase 3 §5.2):
//   demo/data/dem_480m.bin     1906 × 1906 Int16 LE, 2×2 mean of the 240 m grid (DN units)
//   demo/data/dem_240m.bin     2700 × 2700 Int16 LE, centred crop of the 240 m grid (±324 km)
//   demo/data/dem_120m.bin     2600 × 2600 Int16 LE, centred crop of the 120 m grid (±156 km)
//   demo/data/horizon_grid.bin 320 × 320 cells × 72 azimuths, Uint8, round((e + 5) / 0.1)
//   demo/data/horizon_1km.bin  640 × 640 cells × 72 azimuths, same encoding
//   demo/data/terrain.json     metadata; existing keys are kept, new keys are merged in
// Skylines run on worker threads, one row of cells at a time, from the full 240 m grid. A skyline grid is
// skipped when the file exists and terrain.json records the same parameters. DEM files are only rewritten
// when their bytes change.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createDem, horizonProfile, fromXY, GRID_SIZE, GRID_CELL_KM, MAP_HALF_KM, OBSERVER_M } from '../demo/src/terrain.js';
import { parseLabel } from './fetch-lola.mjs';

const RAW = new URL('../data-raw/lola/', import.meta.url);
const PDS = 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/';
const SRC_SIZE = 3812;
const AZ = 72, OFFSET = -5, STEP = 0.1, MAX_KM = 300;

function loadImg(name) {
  const buf = readFileSync(new URL(name, RAW));
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
}

if (!isMainThread) {
  const { size, cellKm, halfKm } = workerData;
  const dem = createDem({ data: loadImg('ldem_75s_240m.img'), size: SRC_SIZE, kmPerPixel: 0.24 });
  parentPort.on('message', (j) => {
    if (j === null) { process.exit(0); }
    const row = new Uint8Array(size * AZ);
    for (let i = 0; i < size; i++) {
      const x = -halfKm + (i + 0.5) * cellKm;
      const y = halfKm - (j + 0.5) * cellKm;
      const { latDeg, lonDeg } = fromXY(x, y);
      const p = horizonProfile(dem, latDeg, lonDeg, { azimuths: AZ, maxKm: MAX_KM, observerM: OBSERVER_M });
      for (let k = 0; k < AZ; k++) {
        const e = p ? p[k] : 0;
        row[i * AZ + k] = Math.max(0, Math.min(255, Math.round((e - OFFSET) / STEP)));
      }
    }
    parentPort.postMessage({ j, row }, [row.buffer]);
  });
} else {
  const out = (name) => new URL(`../demo/data/${name}`, import.meta.url);
  const writeIfChanged = (name, bytes) => {
    const f = out(name);
    if (existsSync(f) && Buffer.compare(readFileSync(f), bytes) === 0) { console.log(`${name}: unchanged`); return; }
    writeFileSync(f, bytes);
    console.log(`${name}: written, ${bytes.length} bytes`);
  };

  let previous = {};
  try { previous = JSON.parse(readFileSync(out('terrain.json'))); } catch { /* first run */ }
  const horizon2 = { file: 'horizon_grid.bin', size: GRID_SIZE, cellKm: GRID_CELL_KM, halfKm: MAP_HALF_KM, azimuths: AZ, offsetDeg: OFFSET, stepDeg: STEP, observerM: OBSERVER_M, maxKm: MAX_KM, sourceKmPerPixel: 0.24 };
  const horizon1 = { ...horizon2, file: 'horizon_1km.bin', size: 640, cellKm: 1 };

  // Labels: check the layout the crops below assume (pole between the two middle pixels, LSB Int16, DN × 0.5).
  const labels = {};
  for (const [name, size, metres] of [['ldem_75s_240m', SRC_SIZE, 240], ['ldem_75s_120m', 7624, 120]]) {
    const l = parseLabel(readFileSync(new URL(`${name}.lbl`, RAW), 'utf8'));
    const ok = l.lines === size && l.samples === size && l.bits === 16 && l.sampleType === 'LSB_INTEGER'
      && l.scale === 0.5 && l.mapScaleM === metres && l.lineOffset === size / 2 - 0.5 && l.sampleOffset === size / 2 - 0.5
      && l.centerLat === -90 && l.centerLon === 0 && l.rotation === 0;
    if (!ok) { console.error(`${name}.lbl does not match the expected layout`, l); process.exit(1); }
    labels[name] = l;
  }

  const crop = (src, srcSize, n) => {
    const o = (srcSize - n) / 2;
    const dst = new Int16Array(n * n);
    for (let r = 0; r < n; r++) dst.set(src.subarray((o + r) * srcSize + o, (o + r) * srcSize + o + n), r * n);
    return Buffer.from(dst.buffer);
  };

  // 480 m grid: mean of each 2×2 block, rounded.
  const src = loadImg('ldem_75s_240m.img');
  const n480 = 1906;
  const small = new Int16Array(n480 * n480);
  for (let r = 0; r < n480; r++) {
    for (let c = 0; c < n480; c++) {
      const i = 2 * r * SRC_SIZE + 2 * c;
      small[r * n480 + c] = Math.round((src[i] + src[i + 1] + src[i + SRC_SIZE] + src[i + SRC_SIZE + 1]) / 4);
    }
  }
  let t = Date.now();
  writeIfChanged('dem_480m.bin', Buffer.from(small.buffer));
  writeIfChanged('dem_240m.bin', crop(src, SRC_SIZE, 2700));
  console.log(`  ${Date.now() - t} ms`);
  t = Date.now();
  writeIfChanged('dem_120m.bin', crop(loadImg('ldem_75s_120m.img'), 7624, 2600));
  console.log(`  ${Date.now() - t} ms`);

  async function skylines(h, prev) {
    const file = out(h.file);
    const bytes = h.size * h.size * AZ;
    if (prev && JSON.stringify(prev) === JSON.stringify(h) && existsSync(file) && statSync(file).size === bytes) {
      console.log(`${h.file}: parameters unchanged, skipped`);
      return false;
    }
    const grid = new Uint8Array(bytes);
    const threads = Math.max(1, availableParallelism() - 1);
    const t0 = Date.now();
    let next = 0, finished = 0;
    await new Promise((resolve, reject) => {
      for (let w = 0; w < threads; w++) {
        const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { size: h.size, cellKm: h.cellKm, halfKm: h.halfKm } });
        worker.on('error', reject);
        worker.on('message', ({ j, row }) => {
          grid.set(row, j * h.size * AZ);
          finished++;
          if (finished % 64 === 0) console.log(`  rows ${finished}/${h.size}  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
          if (next < h.size) worker.postMessage(next++); else worker.postMessage(null);
          if (finished === h.size) resolve();
        });
        worker.postMessage(next++);
      }
    });
    writeFileSync(file, grid);
    console.log(`${h.file}: ${h.size} × ${h.size} × ${AZ}, ${bytes} bytes in ${((Date.now() - t0) / 1000).toFixed(1)} s on ${threads} threads`);
    return true;
  }
  const changed2 = await skylines(horizon2, previous.horizon);
  const { name: _, ...prev1 } = previous.horizons?.find((h) => h.name === 'horizon_1km') ?? {};
  await skylines(horizon1, prev1);

  const raw = (name) => ({ name, url: PDS + name, bytes: statSync(new URL(name, RAW)).size });
  // Existing keys keep their values and order; a rebuilt 2 km grid refreshes `horizon` and `generatedAt`.
  const meta = {
    source: `NASA PDS, LRO LOLA LDEM_75S_240M (${PDS}ldem_75s_240m.img)`,
    generatedAt: new Date().toISOString(),
    dem: { file: 'dem_480m.bin', size: n480, kmPerPixel: 0.48, dnToMeters: 0.5 },
    horizon: horizon2,
    ...previous,
  };
  if (changed2) { meta.generatedAt = new Date().toISOString(); meta.horizon = horizon2; }
  // Levels and sources added by other scripts (build-tiles.mjs, build-nasa.mjs; phase 4) are kept after ours.
  const own = [
    { name: 'dem_480m', file: 'dem_480m.bin', size: n480, kmPerPixel: 0.48, dnToMeters: 0.5, halfKm: n480 * 0.48 / 2 },
    { name: 'dem_240m', file: 'dem_240m.bin', size: 2700, kmPerPixel: 0.24, dnToMeters: 0.5, halfKm: 324 },
    { name: 'dem_120m', file: 'dem_120m.bin', size: 2600, kmPerPixel: 0.12, dnToMeters: 0.5, halfKm: 156 },
  ];
  meta.levels = [...own, ...(previous.levels ?? []).filter((l) => !own.some((o) => o.name === l.name))];
  meta.horizons = [{ name: 'horizon_grid', ...horizon2 }, { name: 'horizon_1km', ...horizon1 }];
  const ownSources = ['ldem_75s_240m.img', 'ldem_75s_240m.lbl', 'ldem_75s_120m.img', 'ldem_75s_120m.lbl'];
  meta.sources = [...ownSources.map(raw), ...(previous.sources ?? []).filter((s) => !ownSources.includes(s.name))];
  writeFileSync(out('terrain.json'), JSON.stringify(meta, null, 2));
  console.log('terrain.json written');
}
