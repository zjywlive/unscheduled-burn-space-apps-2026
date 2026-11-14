// Packs the MCP server on its own: dist/lunar-site-navigator-mcp.zip holding one folder
// lunar-site-navigator-mcp/ with the repository's relative paths kept, so `node mcp/server.mjs` runs after
// unzipping. Contents are computed, not listed by hand:
//   - mcp/server.mjs, mcp/try.mjs, mcp/README.md and every module they import (relative static imports,
//     followed recursively: mcp/navigator.mjs, tools/core-context.mjs, the demo/src modules used)
//   - the raw data files tools/core-context.mjs actually reads (its ctx.files, 240 m DEM included)
// Then unpacks to a new folder under the system temp dir, checks the file list and that every file is
// byte-identical to its source, runs `node mcp/try.mjs` there (exit code must be 0), and removes the folder.
// Writes only dist/lunar-site-navigator-mcp.zip; refuses any other name, so the web-page zips are never touched.
import { mkdtempSync, copyFileSync, readFileSync, rmSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCoreContext, DEFAULT_DATA_DIR } from './core-context.mjs';

export const FOLDER = 'lunar-site-navigator-mcp';
export const ZIP_NAME = 'lunar-site-navigator-mcp.zip';
const REPO = fileURLToPath(new URL('..', import.meta.url));
export const ENTRIES = ['mcp/server.mjs', 'mcp/try.mjs'];
export const EXTRA = ['mcp/README.md'];

const posix = (p) => p.split(sep).join('/');
// import … from '…', export … from '…', import '…', import('…'); comments are stripped first.
const SPECIFIERS = /(?:\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?|\bexport\s*[\w*{}\s,$]*\s*from\s*)['"]([^'"]+)['"]|\bimport\s*\(\s*([^)]*)\)/g;

// Relative module paths (repo-relative, forward slashes) reachable from the entries.
export function importClosure(entries = ENTRIES, repo = REPO) {
  const seen = new Set(), queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const file = join(repo, rel);
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    for (const m of code.matchAll(SPECIFIERS)) {
      let spec = m[1];
      if (spec === undefined) {
        const lit = /^['"]([^'"]+)['"]$/.exec(m[2].trim());
        if (!lit) throw new Error(`${rel}: dynamic import with a computed specifier (${m[2].trim()}) cannot be packed`);
        spec = lit[1];
      }
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) throw new Error(`${rel}: bare import ${spec}; the package has no dependencies`);
      const target = posix(relative(repo, resolve(dirname(file), spec)));
      if (target.startsWith('..')) throw new Error(`${rel}: import ${spec} leaves the repository`);
      queue.push(target);
    }
  }
  return [...seen].sort();
}

// The data files core-context reads, as repo-relative paths.
export function dataFiles() {
  const ctx = loadCoreContext();
  const dataRel = posix(relative(REPO, DEFAULT_DATA_DIR));
  return [...new Set(ctx.files)].map((f) => `${dataRel}/${f}`).sort();
}

export function manifest() {
  const rels = [...new Set([...importClosure(), ...EXTRA, ...dataFiles()])].sort();
  return new Map(rels.map((rel) => [`${FOLDER}/${rel}`, join(REPO, rel)]));
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function pack({ out, log = console.log }) {
  if (basename(out) !== ZIP_NAME) throw new Error(`refusing to write ${basename(out)}: this script only writes ${ZIP_NAME}`);
  const files = manifest();
  for (const src of files.values()) if (!existsSync(src)) throw new Error(`missing source ${src}`);
  const work = mkdtempSync(join(tmpdir(), 'lsn-mcp-pack-'));
  const check = mkdtempSync(join(tmpdir(), 'lsn-mcp-unpack-'));
  try {
    for (const [path, src] of files) {
      mkdirSync(join(work, path, '..'), { recursive: true });
      copyFileSync(src, join(work, path));
    }
    mkdirSync(dirname(out), { recursive: true });
    if (existsSync(out)) rmSync(out);
    execFileSync('zip', ['-r', '-q', '-9', '-X', out, FOLDER], { cwd: work });

    execFileSync('unzip', ['-q', out, '-d', check]);
    const listed = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).trim().split('\n').filter((n) => !n.endsWith('/')).sort();
    const expected = [...files.keys()].sort();
    const problems = [];
    if (listed.join('\n') !== expected.join('\n')) problems.push(`file list differs: expected ${expected.length}, zip has ${listed.length}`);
    for (const [path, src] of files) {
      const got = join(check, path);
      if (!existsSync(got) || !readFileSync(got).equals(readFileSync(src))) problems.push(`${path} differs from ${posix(relative(REPO, src))}`);
    }
    const root = join(check, FOLDER);
    const run = spawnSync(process.execPath, ['mcp/try.mjs'], { cwd: root, encoding: 'utf8', timeout: 120_000 });
    if (run.status !== 0) problems.push(`node mcp/try.mjs in the unpacked folder exited ${run.status ?? run.signal}: ${run.stderr.trim().split('\n').slice(-3).join(' | ')}`);

    const bytes = statSync(out).size;
    log(`${posix(relative(process.cwd(), out)) || out}: ${listed.length} files, ${bytes.toLocaleString('en-GB')} B (${(bytes / 1048576).toFixed(1)} MB)`);
    log(`sha256 ${sha256(out)}`);
    for (const p of listed) log(`  ${p}  ${statSync(join(check, p)).size.toLocaleString('en-GB')} B`);
    log(`unpacked file list as expected and every file byte-identical to its source: ${!problems.some((p) => !p.startsWith('node mcp/try.mjs'))}`);
    log(`node mcp/try.mjs in the unpacked folder exit code: ${run.status ?? run.signal}`);
    if (run.status === 0) log(`  ${run.stdout.trim().split('\n').filter((l) => /^MCP |^Tools \(|exited cleanly/.test(l)).join('\n  ')}`);
    for (const p of problems) log(`  problem: ${p}`);
    return { out, bytes, listed, problems };
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(check, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { problems } = pack({ out: join(REPO, 'dist', ZIP_NAME) });
  if (problems.length) process.exit(1);
}
