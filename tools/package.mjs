// Packs the demo for teammates (spec phase 3 §4.11; phase 4: v4; phase 5: v5; phase 6: v6; phase 7: v7): dist/lunar-site-navigator-v7.zip holding one folder
// lunar-site-navigator/ with lunar-site-navigator.html (a copy of demo/index.html), data/js/*.js,
// vendor/* (when demo/vendor exists) and README.txt. Then unpacks it to a temporary folder and checks
// the file list and that every file is byte-identical to its source. The phase 2 zip
// dist/lunar-site-navigator.zip, the phase 3 zip dist/lunar-site-navigator-v3.zip and the phase 4 zip
// dist/lunar-site-navigator-v4.zip, the phase 5 zip dist/lunar-site-navigator-v5.zip (the copy the owner is
// testing) and the phase 6 zip dist/lunar-site-navigator-v6.zip are never touched (pack() refuses their names).
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync, mkdirSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FOLDER = 'lunar-site-navigator';
export const ZIP_NAME = 'lunar-site-navigator-v7.zip';
const KEEP = { 'lunar-site-navigator.zip': 'the phase 2 package', 'lunar-site-navigator-v2.zip': 'the phase 2 package', 'lunar-site-navigator-v3.zip': 'the phase 3 package', 'lunar-site-navigator-v4.zip': 'the phase 4 package', 'lunar-site-navigator-v5.zip': 'the phase 5 package', 'lunar-site-navigator-v6.zip': 'the phase 6 package' };
export const MAX_BYTES = 130e6;   // phase 4 task book: the zip stays under 130 MB (kept for v5, v6 and v7)

export const README = [
  'Lunar Site Navigator: a briefing demo for NASA Space Apps 2026 challenge C04 that shows sunlight, Earth visibility, slope and suitability around the lunar south pole, on real LOLA terrain.',
  'To open it, unzip this file and double-click lunar-site-navigator.html inside the lunar-site-navigator folder; keep the data and vendor folders next to it. It runs in any modern browser and needs no internet except for the Inter web font.',
  'Data: JPL Horizons API (DE441 ephemeris) for the Sun and Earth directions; NASA PDS LRO LOLA LDEM_75S_240M, LDEM_75S_120M, LDEM_80S_40M and LDEM_875S_20M for the terrain; LOLA LPSR_75S_120M and AVGVISIB_75S_120M for the official permanently shadowed regions and 18.6-year averages.',
  'Third-party libraries and their licenses are listed in vendor/VENDOR.md.',
].join('\n') + '\n';

// Every file under dir, as forward-slash paths relative to dir; dotfiles (.DS_Store) are skipped.
function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (e.isFile()) out.push(relative(base, p).split(sep).join('/'));
  }
  return out.sort();
}

// Map of path inside the folder → source file (README is written from the constant above).
export function manifest(demo) {
  const files = new Map([[`${FOLDER}/lunar-site-navigator.html`, join(demo, 'index.html')]]);
  const packs = join(demo, 'data', 'js');
  if (existsSync(packs)) for (const f of walk(packs)) if (f.endsWith('.js')) files.set(`${FOLDER}/data/js/${f}`, join(packs, f));
  const vendor = join(demo, 'vendor');
  if (existsSync(vendor)) for (const f of walk(vendor)) files.set(`${FOLDER}/vendor/${f}`, join(vendor, f));
  return files;
}

export function pack({ demo, out, log = console.log }) {
  if (KEEP[basename(out)]) throw new Error(`refusing to write ${basename(out)} (${KEEP[basename(out)]})`);
  const files = manifest(demo);
  const work = mkdtempSync(join(tmpdir(), 'lsn-pack-'));
  const check = mkdtempSync(join(tmpdir(), 'lsn-unpack-'));
  try {
    for (const [path, src] of files) {
      mkdirSync(join(work, path, '..'), { recursive: true });
      copyFileSync(src, join(work, path));
    }
    writeFileSync(join(work, FOLDER, 'README.txt'), README);
    const expected = [...files.keys(), `${FOLDER}/README.txt`].sort();
    mkdirSync(resolve(out, '..'), { recursive: true });
    if (existsSync(out)) rmSync(out);
    execFileSync('zip', ['-r', '-q', '-9', '-X', out, FOLDER], { cwd: work });

    execFileSync('unzip', ['-q', out, '-d', check]);
    const listed = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).trim().split('\n').filter((n) => !n.endsWith('/')).sort();
    const problems = [];
    if (listed.join('\n') !== expected.join('\n')) problems.push(`file list differs: expected ${expected.length}, zip has ${listed.length}`);
    for (const [path, src] of files) {
      const got = join(check, path);
      if (!existsSync(got) || !readFileSync(got).equals(readFileSync(src))) problems.push(`${path} differs from ${relative(demo, src)}`);
    }
    if (readFileSync(join(check, FOLDER, 'README.txt'), 'utf8') !== README) problems.push('README.txt differs');
    const bytes = statSync(out).size;
    log(`${relative(process.cwd(), out) || out}: ${(bytes / 1048576).toFixed(1)} MB, ${listed.length} files`);
    for (const p of listed) log(`  ${p}  ${(statSync(join(check, p)).size / 1048576).toFixed(2)} MB`);
    log(`unpacked file list as expected and every file byte-identical to its source: ${problems.length === 0}`);
    for (const p of problems) log(`  problem: ${p}`);
    return { out, bytes, listed, problems };
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(check, { recursive: true, force: true });
  }
}

// A pack built before the .bin changed would ship stale data: each pack must decode to its .bin.
export function stalePacks(demo) {
  const dir = join(demo, 'data', 'js');
  if (!existsSync(dir)) return [];
  const stale = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const name = f.slice(0, -3);
    const bin = join(demo, 'data', `${name}.bin`);
    const text = readFileSync(join(dir, f), 'utf8');
    const m = /^window\.__lsnData\("([^"]+)","([A-Za-z0-9+/=]*)"\);\n?$/.exec(text);
    if (!m || m[1] !== name || !existsSync(bin) || !Buffer.from(m[2], 'base64').equals(readFileSync(bin))) stale.push(name);
  }
  return stale;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const demo = join(repo, 'demo');
  const stale = stalePacks(demo);
  if (stale.length) {
    console.log(`data packs out of date with demo/data/*.bin (run node tools/build.mjs): ${stale.join(', ')}`);
    process.exit(1);
  }
  console.log('data packs match demo/data/*.bin byte for byte');
  const { problems, bytes } = pack({ demo, out: join(repo, 'dist', ZIP_NAME) });
  const small = bytes < MAX_BYTES;
  console.log(`under ${MAX_BYTES / 1e6} MB (${bytes.toLocaleString('en-GB')} B): ${small}`);
  if (problems.length || !small) process.exit(1);
}
