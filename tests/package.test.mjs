import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pack, manifest, stalePacks, README, FOLDER, ZIP_NAME } from '../tools/package.mjs';
import { dataPack } from '../tools/build.mjs';

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'lsn-pkg-'));
  for (const [name, src] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), src);
  }
  return dir;
}

test('the zip holds one folder with the page, data packs, vendor files and README, all byte-identical', () => {
  const demo = tree({
    'index.html': '<!doctype html>page',
    'data/dem_480m.bin': Buffer.from([1, 2, 3]),
    'data/js/dem_480m.js': dataPack('dem_480m', Buffer.from([1, 2, 3])),
    'data/js/.DS_Store': 'x',
    'vendor/driver.js.iife.js': 'lib', 'vendor/VENDOR.md': '# v', 'vendor/licenses/MIT.txt': 'mit',
  });
  const out = join(mkdtempSync(join(tmpdir(), 'lsn-pkg-out-')), 'lunar-site-navigator-v7.zip');
  const r = pack({ demo, out, log: () => {} });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.listed, [
    `${FOLDER}/README.txt`, `${FOLDER}/data/js/dem_480m.js`, `${FOLDER}/lunar-site-navigator.html`,
    `${FOLDER}/vendor/VENDOR.md`, `${FOLDER}/vendor/driver.js.iife.js`, `${FOLDER}/vendor/licenses/MIT.txt`,
  ]);
  const unz = mkdtempSync(join(tmpdir(), 'lsn-pkg-chk-'));
  execFileSync('unzip', ['-q', out, '-d', unz]);
  assert.equal(readFileSync(join(unz, FOLDER, 'lunar-site-navigator.html'), 'utf8'), '<!doctype html>page');
  assert.equal(readFileSync(join(unz, FOLDER, 'README.txt'), 'utf8'), README);
  // repacking replaces the zip instead of appending to it
  assert.deepEqual(pack({ demo, out, log: () => {} }).listed.length, 6);
});

test('README names the data sources and the vendor notes in three or four lines', () => {
  const lines = README.trim().split('\n');
  assert.ok(lines.length >= 3 && lines.length <= 4);
  for (const t of ['lunar-site-navigator.html', 'DE441', 'LDEM_75S_240M', 'LDEM_75S_120M', 'LDEM_80S_40M', 'LDEM_875S_20M', 'LPSR_75S_120M', 'vendor/VENDOR.md']) assert.ok(README.includes(t), t);
});

test('no vendor folder and no data packs is fine', () => {
  const demo = tree({ 'index.html': 'p' });
  assert.deepEqual([...manifest(demo).keys()], [`${FOLDER}/lunar-site-navigator.html`]);
  const out = join(mkdtempSync(join(tmpdir(), 'lsn-pkg-out-')), 'v4.zip');
  assert.deepEqual(pack({ demo, out, log: () => {} }).problems, []);
});

test('the phase 2 zip name is refused', () => {
  const demo = tree({ 'index.html': 'p' });
  const dir = mkdtempSync(join(tmpdir(), 'lsn-pkg-out-'));
  assert.throws(() => pack({ demo, out: join(dir, 'lunar-site-navigator.zip'), log: () => {} }), /phase 2/);
  assert.equal(existsSync(join(dir, 'lunar-site-navigator.zip')), false);
  // phase 4: the phase 3 zip is kept too, and v4 is the new name
  assert.throws(() => pack({ demo, out: join(dir, 'lunar-site-navigator-v3.zip'), log: () => {} }), /phase 3/);
  assert.equal(existsSync(join(dir, 'lunar-site-navigator-v3.zip')), false);
  // phase 5: the phase 4 zip is kept too (and a v2 name), and v5 is the new name
  for (const [name, why] of [['lunar-site-navigator-v4.zip', /phase 4/], ['lunar-site-navigator-v2.zip', /phase 2/]]) {
    assert.throws(() => pack({ demo, out: join(dir, name), log: () => {} }), why);
    assert.equal(existsSync(join(dir, name)), false);
  }
  // phase 6: the phase 5 zip (the copy under test by the owner) is kept too, and v6 is the new name
  assert.throws(() => pack({ demo, out: join(dir, 'lunar-site-navigator-v5.zip'), log: () => {} }), /phase 5/);
  assert.equal(existsSync(join(dir, 'lunar-site-navigator-v5.zip')), false);
  assert.throws(() => pack({ demo, out: join(dir, 'lunar-site-navigator-v6.zip'), log: () => {} }), /phase 6/);
  assert.equal(existsSync(join(dir, 'lunar-site-navigator-v6.zip')), false);
  assert.equal(ZIP_NAME, 'lunar-site-navigator-v7.zip');
});

test('a pack that no longer matches its .bin is reported as stale', () => {
  const demo = tree({
    'data/a.bin': Buffer.from([1]), 'data/js/a.js': dataPack('a', Buffer.from([1])),
    'data/b.bin': Buffer.from([2, 2]), 'data/js/b.js': dataPack('b', Buffer.from([2])),
    'data/js/c.js': dataPack('c', Buffer.from([3])),
  });
  assert.deepEqual(stalePacks(demo).sort(), ['b', 'c']);
});
