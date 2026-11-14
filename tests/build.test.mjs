import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { bundle } from '../tools/build.mjs';

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'lsn-build-'));
  for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
  return join(dir, 'main.js');
}

test('modules keep private names apart and imports resolve, including aliases', () => {
  const entry = fixture({
    'a.js': 'const k = 2;\nexport function twice(x) { return x * k; }\nexport const NAME = "a";\n',
    'b.js': 'import { twice } from "./a.js";\nconst k = 10;\nexport function f(x) { return twice(x) + k; }\n',
    'main.js': 'import { f } from "./b.js";\nimport { NAME as N } from "./a.js";\nglobalThis.out = f(4) + N;\n',
  });
  const ctx = { globalThis: {} }; ctx.globalThis = ctx;
  vm.runInNewContext(bundle(entry), ctx);
  assert.equal(ctx.out, '18a');
});

test('unsupported syntax is rejected with the file name', () => {
  assert.throws(() => bundle(fixture({ 'main.js': 'export default 1;\n' })), /main\.js/);
  assert.throws(() => bundle(fixture({ 'main.js': 'import * as x from "./a.js";\n', 'a.js': '' })), /main\.js/);
});

import { inlineBinary } from '../tools/build.mjs';
test('binary data inlined as base64 decodes byte for byte', () => {
  const buf = Buffer.from(Int16Array.from([0, 1, -1, 32767, -32768, 12345]).buffer);
  assert.deepEqual(Buffer.from(inlineBinary(buf), 'base64'), buf);
  const odd = Buffer.from([1, 2, 3, 250, 251]);
  assert.deepEqual(Buffer.from(inlineBinary(odd), 'base64'), odd);
});

// phase 3: CSS shards, data packs, the loader stub and the legacy inline switch (spec phase 3 §5.1)
import { mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { collectCss, dataPack, writeDataPacks, build, LEGACY_INLINE, LOADER_STUB, STARTUP_PACKS } from '../tools/build.mjs';

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'lsn-build3-'));
  for (const [name, src] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), src);
  }
  return dir;
}

// A minimal demo folder: the template, one module and the JSON the page inlines.
const demoFiles = (extra = {}) => ({
  'src/index.template.html': '<!doctype html><head><meta charset="utf-8">\n<!--STUB-->\n<!--CSS--></head><body>\n<!--DATA-->\n<!--JS-->\n</body>\n',
  'src/main.js': 'globalThis.ran = true;\n',
  'src/styles.css': 'body{}\n',
  'data/ephemeris.json': '{}', 'data/sites.json': '[]', 'data/validation.json': '{}', 'data/terrain.json': '{}', 'data/features.json': '[]',
  ...extra,
});

test('CSS shards follow styles.css in file-name order, and a missing folder is fine', () => {
  const dir = tree({ 'styles.css': 'a{}', 'styles/phase3-map.css': 'm{}', 'styles/phase3-agent.css': 'g{}', 'styles/notes.txt': 'x' });
  const { css, shards } = collectCss(dir);
  assert.deepEqual(shards, ['phase3-agent.css', 'phase3-map.css']);
  assert.ok(css.indexOf('a{}') < css.indexOf('g{}') && css.indexOf('g{}') < css.indexOf('m{}'));
  assert.ok(!css.includes('x'));
  assert.deepEqual(collectCss(tree({ 'styles.css': 'a{}' })), { css: 'a{}', shards: [] });
  assert.deepEqual(collectCss(tree({ 'styles.css': 'a{}', 'styles/.keep': '' })).shards, []);
});

test('a data pack is one call to __lsnData whose base64 decodes back to the bytes', () => {
  const bytes = Buffer.from(Int16Array.from([0, 1, -1, 32767, -32768, 7]).buffer);
  const text = dataPack('dem_480m', bytes);
  assert.match(text, /^window\.__lsnData\("dem_480m","[A-Za-z0-9+/=]*"\);\n$/);
  const calls = [];
  vm.runInNewContext(text, { window: { __lsnData: (n, b) => calls.push([n, b]) } });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'dem_480m');
  assert.deepEqual(Buffer.from(calls[0][1], 'base64'), bytes);
  assert.throws(() => dataPack('../x', bytes), /bad data pack name/);
});

test('the loader stub stores packs and wakes waiters', () => {
  const code = LOADER_STUB.replace(/^<script>|<\/script>$/g, '');
  const ctx = {}; ctx.window = ctx;
  vm.runInNewContext(code, ctx);
  let woke = 0;
  ctx.__lsnWaiters = { a: [() => woke++] };
  vm.runInNewContext(dataPack('a', Buffer.from([1, 2, 3])), ctx);
  vm.runInNewContext(dataPack('b', Buffer.from([4])), ctx);
  assert.equal(woke, 1);
  assert.deepEqual(Buffer.from(ctx.__lsnStore.a, 'base64'), Buffer.from([1, 2, 3]));
  assert.ok('b' in ctx.__lsnStore);
});

test('packs are written only for the .bin files present, and stale packs are removed', () => {
  const dir = tree({ 'a.bin': Buffer.from([9, 8, 7]), 'notes.json': '{}', 'js/gone.js': 'old', 'js/keep.txt': 'x' });
  const packs = writeDataPacks(dir);
  assert.deepEqual(packs.map((p) => p.name), ['a']);
  assert.deepEqual(readdirSync(join(dir, 'js')).sort(), ['a.js', 'keep.txt']);
  assert.equal(readFileSync(join(dir, 'js', 'a.js'), 'utf8'), dataPack('a', Buffer.from([9, 8, 7])));
});

test('build with no .bin files, no CSS shards and no vendor folder still writes the page', () => {
  const demo = tree(demoFiles());
  const r = build(demo, { log: () => {} });
  const html = readFileSync(join(demo, 'index.html'), 'utf8');
  assert.deepEqual(r.packs, []); assert.deepEqual(r.shards, []);
  assert.ok(html.indexOf(LOADER_STUB) < html.indexOf('<style>'));
  assert.ok(!html.includes('data/js/') && !html.includes('data-dem'));
  assert.ok(!existsSync(join(demo, 'vendor')));
});

test('build: startup packs load statically before the main script, others on demand, legacy blocks behind the switch', () => {
  assert.equal(LEGACY_INLINE, false);   // wave 2: main.js reads the data packs; the switch is off by default
  assert.deepEqual(STARTUP_PACKS, ['dem_480m', 'horizon_grid', 'slope_2km', 'shadow_2km']);
  const bins = { 'data/dem_480m.bin': Buffer.from([1, 2]), 'data/horizon_grid.bin': Buffer.from([3]), 'data/slope_2km.bin': Buffer.from([4]), 'data/dem_240m.bin': Buffer.from([5]) };
  const demo = tree(demoFiles({ ...bins, 'src/styles/b.css': 'b{}', 'src/styles/a.css': 'a{}', 'vendor/lib.js': 'x' }));
  const r = build(demo, { legacyInline: true, log: () => {} });
  const html = readFileSync(join(demo, 'index.html'), 'utf8');
  assert.deepEqual(r.packs.map((p) => p.name), ['dem_240m', 'dem_480m', 'horizon_grid', 'slope_2km']);
  const tags = [...html.matchAll(/<script src="data\/js\/([a-z0-9_]+)\.js"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(tags, ['dem_480m', 'horizon_grid', 'slope_2km']);   // shadow_2km absent, dem_240m on demand
  assert.ok(html.lastIndexOf('data/js/') < html.indexOf('globalThis.ran'));
  assert.ok(html.indexOf('a{}') < html.indexOf('b{}'));
  assert.ok(html.includes(`id="data-dem">${Buffer.from([1, 2]).toString('base64')}<`));
  assert.ok(html.includes(`id="data-horizon">${Buffer.from([3]).toString('base64')}<`));
  assert.ok(!html.includes('lib.js'));   // vendor is not inlined
  assert.equal(readFileSync(join(demo, 'vendor', 'lib.js'), 'utf8'), 'x');
  for (const p of r.packs) {
    const text = readFileSync(join(demo, 'data', 'js', `${p.name}.js`), 'utf8');
    assert.deepEqual(Buffer.from(text.split('"')[3], 'base64'), bins[`data/${p.name}.bin`]);
  }
  const off = build(demo, { legacyInline: false, log: () => {} });
  const html2 = readFileSync(off.html, 'utf8');
  assert.ok(!html2.includes('data-dem') && !html2.includes('data-horizon'));
  const byDefault = build(demo, { log: () => {} });   // the default build has no inline blocks either
  const html3 = readFileSync(byDefault.html, 'utf8');
  assert.ok(!html3.includes('data-dem') && !html3.includes('data-horizon'));
});
