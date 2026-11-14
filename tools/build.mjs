// Zero-dependency build: inlines the ES modules, the stylesheets and the JSON data into demo/index.html,
// and writes each demo/data/<name>.bin as a classic-script data pack demo/data/js/<name>.js (spec phase 3 §5.1).
// Module convention (enforced): `export function` / `export const` only; `import { a, b as c } from './x.js'` only.
import { readFileSync, writeFileSync, statSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2\s*;?[ \t]*$/gm;
const EXPORT_DECL = /^export\s+(?:async\s+)?(function\*?|const|let)\s+([A-Za-z_$][\w$]*)/gm;
const BANNED = [
  [/^\s*export\s+default\b/m, 'default export'],
  [/^\s*export\s*\{/m, 'export list'],
  [/^\s*export\s*\*/m, 'export *'],
  [/^\s*import\s*\*/m, 'namespace import'],
  [/^\s*import\s+[A-Za-z_$][\w$]*\s*(,|from)/m, 'default import'],
  [/^\s*import\s*['"]/m, 'side-effect import'],
  [/^\s*export\s+(?:const|let)\s*[{[]/m, 'destructured export'],
  [/^await\b/m, 'top-level await'],
];

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

function fail(file, src, index, what) {
  throw new Error(`${file}:${lineOf(src, index)}: ${what} is not supported by tools/build.mjs`);
}

function parseModule(file) {
  const src = readFileSync(file, 'utf8');
  for (const [re, what] of BANNED) {
    const m = re.exec(src);
    if (m) fail(file, src, m.index, what);
  }
  const imports = [];
  for (const m of src.matchAll(IMPORT)) {
    const spec = m[3];
    if (!spec.startsWith('./') && !spec.startsWith('../')) fail(file, src, m.index, `non-relative import '${spec}'`);
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const [name, alias] = s.split(/\s+as\s+/);
      return { name: name.trim(), alias: (alias ?? name).trim() };
    });
    imports.push({ start: m.index, text: m[0], target: resolve(dirname(file), spec), names });
  }
  // Any other line starting with `import` is outside the convention.
  const stray = /^\s*import\b(?!\s*\()/gm;
  for (const m of src.matchAll(stray)) {
    if (!imports.some((i) => i.start <= m.index && m.index < i.start + i.text.length)) fail(file, src, m.index, 'import form');
  }
  const exports = [...src.matchAll(EXPORT_DECL)].map((m) => m[2]);
  return { file, src, imports, exports };
}

export function bundle(entryPath) {
  const root = dirname(resolve(entryPath));
  const order = [];
  const seen = new Map();
  const visiting = new Set();
  function visit(file) {
    if (seen.has(file)) return;
    if (visiting.has(file)) throw new Error(`${file}: circular import`);
    try { statSync(file); } catch { throw new Error(`${file}: imported module not found`); }
    visiting.add(file);
    const mod = parseModule(file);
    for (const imp of mod.imports) visit(imp.target);
    visiting.delete(file);
    seen.set(file, mod);
    order.push(mod);
  }
  visit(resolve(entryPath));
  const key = (file) => relative(root, file).split(sep).join('/');
  const parts = ["'use strict';", 'const __m = {};'];
  for (const mod of order) {
    let body = mod.src;
    for (const imp of [...mod.imports].reverse()) {
      const target = seen.get(imp.target);
      for (const n of imp.names) {
        if (!target.exports.includes(n.name)) fail(mod.file, mod.src, imp.start, `import of '${n.name}' (not exported by ${key(imp.target)})`);
      }
      const binding = imp.names.map((n) => (n.name === n.alias ? n.name : `${n.name}: ${n.alias}`)).join(', ');
      body = body.slice(0, imp.start) + `const { ${binding} } = __m['${key(imp.target)}'];` + body.slice(imp.start + imp.text.length);
    }
    body = body.replace(/^export\s+/gm, '');
    parts.push(`__m['${key(mod.file)}'] = (() => {\n${body}\nreturn { ${mod.exports.join(', ')} };\n})();`);
  }
  return parts.join('\n');
}

// Binary data goes into the page as base64 text inside a non-executed script block.
export function inlineBinary(buffer) {
  return Buffer.from(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength ?? buffer.length).toString('base64');
}

function binaryScript(id, buffer) {
  return `<script type="application/octet-stream" id="${id}">${inlineBinary(buffer)}</script>`;
}

function jsonScript(id, value) {
  const json = JSON.stringify(value).replace(/</g, '\\u003c');
  return `<script type="application/json" id="${id}">${json}</script>`;
}

// Phase 3 wave 2: main.js reads the data packs, so the phase 2 inline blocks are off. The switch stays
// for tests and for a one-off phase 2 style build (spec phase 3 §5.1).
export const LEGACY_INLINE = false;

// Packs loaded by static <script> tags before the main script; the rest load on demand.
export const STARTUP_PACKS = ['dem_480m', 'horizon_grid', 'slope_2km', 'shadow_2km'];

// Defined first in the page so any data pack, static or injected later, can register itself.
export const LOADER_STUB = '<script>window.__lsnStore = {}; window.__lsnData = (n, b) => { __lsnStore[n] = b; (window.__lsnWaiters?.[n] ?? []).forEach((f) => f()); };</script>';

// styles.css first, then demo/src/styles/*.css in file-name order (a missing folder is fine).
export function collectCss(srcDir) {
  const parts = [readFileSync(join(srcDir, 'styles.css'), 'utf8')];
  const dir = join(srcDir, 'styles');
  const shards = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.css')).sort() : [];
  for (const n of shards) parts.push(`/* styles/${n} */\n` + readFileSync(join(dir, n), 'utf8'));
  return { css: parts.join('\n'), shards };
}

// One data pack: a classic script that hands the base64 bytes to the loader stub.
export function dataPack(name, buffer) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`bad data pack name '${name}'`);
  return `window.__lsnData("${name}","${inlineBinary(buffer)}");\n`;
}

// Writes data/js/<name>.js for every data/<name>.bin present and removes packs whose .bin is gone.
export function writeDataPacks(dataDir) {
  const out = join(dataDir, 'js');
  mkdirSync(out, { recursive: true });
  const names = readdirSync(dataDir).filter((n) => n.endsWith('.bin')).map((n) => n.slice(0, -4)).sort();
  const packs = [];
  for (const name of names) {
    const text = dataPack(name, readFileSync(join(dataDir, `${name}.bin`)));
    const file = join(out, `${name}.js`);
    writeFileSync(file, text);
    packs.push({ name, bytes: Buffer.byteLength(text) });
  }
  for (const n of readdirSync(out)) {
    if (n.endsWith('.js') && !names.includes(n.slice(0, -3))) rmSync(join(out, n));
  }
  return packs;
}

export function packScripts(names) {
  return STARTUP_PACKS.filter((n) => names.includes(n)).map((n) => `<script src="data/js/${n}.js"></script>`).join('\n');
}

const size = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`);

// Builds demo/index.html and demo/data/js/*.js. demo/vendor/ is left alone; the page refers to it as vendor/...
export function build(demo = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo'), { legacyInline = LEGACY_INLINE, log = console.log } = {}) {
  const read = (p) => readFileSync(join(demo, p), 'utf8');
  const data = (p) => JSON.parse(read(p));
  const template = read('src/index.template.html');
  const { css, shards } = collectCss(join(demo, 'src'));
  const js = bundle(join(demo, 'src', 'main.js')).replace(/<\/script/gi, '<\\/script');
  const packs = writeDataPacks(join(demo, 'data'));
  const legacy = [];
  if (legacyInline) {
    for (const [id, file] of [['data-dem', 'dem_480m.bin'], ['data-horizon', 'horizon_grid.bin']]) {
      const path = join(demo, 'data', file);
      if (existsSync(path)) legacy.push(binaryScript(id, readFileSync(path)));
    }
  }
  const dataTags = [
    jsonScript('data-ephemeris', data('data/ephemeris.json')),
    jsonScript('data-sites', data('data/sites.json')),
    jsonScript('data-validation', data('data/validation.json')),
    jsonScript('data-challenge', { url: 'https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/' }),
    jsonScript('data-terrain', data('data/terrain.json')),
    jsonScript('data-features', data('data/features.json')),
    ...legacy,
    packScripts(packs.map((p) => p.name)),
  ].filter(Boolean).join('\n');
  for (const mark of ['<!--STUB-->', '<!--CSS-->', '<!--DATA-->', '<!--JS-->']) {
    if (!template.includes(mark)) throw new Error(`index.template.html is missing ${mark}`);
  }
  const html = template
    .replace('<!--STUB-->', () => LOADER_STUB)
    .replace('<!--CSS-->', () => `<style>\n${css}\n</style>`)
    .replace('<!--DATA-->', () => dataTags)
    .replace('<!--JS-->', () => `<script>\n${js}\n</script>`);
  const out = join(demo, 'index.html');
  writeFileSync(out, html);
  const bytes = Buffer.byteLength(html);
  log(`Wrote demo/index.html (${size(bytes)}; legacy inline data ${legacyInline ? 'on' : 'off'}; css shards: ${shards.join(', ') || 'none'})`);
  for (const p of packs) log(`  data/js/${p.name}.js  ${size(p.bytes)}${STARTUP_PACKS.includes(p.name) ? '  (startup)' : ''}`);
  log(`  vendor/: ${existsSync(join(demo, 'vendor')) ? 'present, referenced as vendor/...' : 'absent'}`);
  return { html: out, bytes, packs, shards };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) build();
