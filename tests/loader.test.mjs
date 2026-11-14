import test from 'node:test';
import assert from 'node:assert/strict';
import { hasData, readData, loadData } from '../demo/src/data-loader.js';

// A page in miniature: the inline boot script of §5.1 and a document whose <script> tags "load" by
// running `behaviour(name)`: 'ok' calls __lsnData, 'error' fires onerror, 'empty' loads without data,
// 'never' does nothing.
function fakePage(packs, behaviour = () => 'ok') {
  const window = {};
  window.__lsnStore = {};
  window.__lsnData = (n, b) => { window.__lsnStore[n] = b; (window.__lsnWaiters?.[n] ?? []).forEach((f) => f()); };
  const injected = [];
  const head = {
    appendChild(el) {
      injected.push(el.src);
      const name = /data\/js\/(\w+)\.js$/.exec(el.src)[1];
      setTimeout(() => {
        const how = behaviour(name);
        if (how === 'ok') { window.__lsnData(name, packs[name]); el.onload?.(); }
        else if (how === 'error') el.onerror?.();
        else if (how === 'empty') el.onload?.();
      }, 1);
    },
  };
  const document = { head, createElement: (tag) => ({ tag, remove() { this.removed = true; } }) };
  return { env: { window, document }, injected };
}
const b64 = (bytes) => Buffer.from(Uint8Array.from(bytes)).toString('base64');

test('readData decodes a pack already in the store, once, and drops the base64 text', () => {
  const { env } = fakePage({});
  env.window.__lsnStore.dem_480m = b64([1, 2, 3, 250]);
  assert.equal(hasData('dem_480m', env), true);
  assert.equal(hasData('dem_240m', env), false);
  const bytes = readData('dem_480m', env);
  assert.deepEqual([...bytes], [1, 2, 3, 250]);
  assert.equal(bytes.byteOffset, 0);
  assert.equal(env.window.__lsnStore.dem_480m, undefined);
  assert.equal(hasData('dem_480m', env), true);
  assert.equal(readData('dem_480m', env), bytes);
  assert.throws(() => readData('dem_240m', env), /not loaded/);
});

test('loadData injects data/js/<name>.js once and resolves with the bytes', async () => {
  const { env, injected } = fakePage({ dem_240m: b64([9, 8, 7]) });
  const [a, b] = await Promise.all([loadData('dem_240m', {}, env), loadData('dem_240m', {}, env)]);
  assert.deepEqual(injected, ['data/js/dem_240m.js']);
  assert.equal(a, b);
  assert.deepEqual([...a], [9, 8, 7]);
  assert.equal(await loadData('dem_240m', {}, env), a);   // already there: no new script
  assert.equal(injected.length, 1);
  assert.deepEqual(env.window.__lsnWaiters.dem_240m, []);
});

test('two waiters on one pack both wake', async () => {
  const { env } = fakePage({ slope_1km: b64([5]) });
  let other = 0;
  env.window.__lsnWaiters = { slope_1km: [() => { other++; }] };
  const bytes = await loadData('slope_1km', {}, env);
  assert.deepEqual([...bytes], [5]);
  assert.equal(other, 1);
});

test('loadData rejects on a load error, on a script without data and on timeout; a retry loads again', async () => {
  let how = 'error';
  const { env, injected } = fakePage({ dem_120m: b64([1]) }, () => how);
  await assert.rejects(loadData('dem_120m', {}, env), /failed to load/);
  how = 'empty';
  await assert.rejects(loadData('dem_120m', {}, env), /without data/);
  how = 'never';
  await assert.rejects(loadData('dem_120m', { timeoutMs: 20 }, env), /timed out/);
  how = 'ok';
  assert.deepEqual([...(await loadData('dem_120m', {}, env))], [1]);
  assert.equal(injected.length, 4);
  await assert.rejects(loadData('../x', {}, env), /bad data pack name/);
});

test('without env it uses the global window and document', async () => {
  const { env } = fakePage({ shadow_1km: b64([3, 4]) });
  globalThis.window = env.window; globalThis.document = env.document;
  try {
    assert.equal(hasData('shadow_1km'), false);
    assert.deepEqual([...(await loadData('shadow_1km'))], [3, 4]);
    assert.equal(hasData('shadow_1km'), true);
  } finally {
    delete globalThis.window; delete globalThis.document;
  }
});
