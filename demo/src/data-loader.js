// Data packs (spec phase 3 §5.1). Each demo/data/js/<name>.js is one classic script line,
// window.__lsnData("<name>", "<base64>"), which the inline boot script stores in window.__lsnStore and
// which wakes the waiters in window.__lsnWaiters[name]. Works from file://: no fetch, no modules.
// `env` ({ window, document }) exists for tests; the page leaves it out.

const decoded = new WeakMap();   // window → Map(name → Uint8Array), so a pack is decoded once
const pending = new WeakMap();   // window → Map(name → Promise)
const NAME = /^[a-z0-9_]+$/;

function envOf(env) {
  const win = env?.window ?? globalThis.window ?? globalThis;
  const doc = env?.document ?? win.document ?? globalThis.document;
  return { win, doc };
}

function cache(map, win) {
  if (!map.has(win)) map.set(win, new Map());
  return map.get(win);
}

function decode(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const text = atob(b64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

export function hasData(name, env) {
  const { win } = envOf(env);
  return cache(decoded, win).has(name) || typeof win.__lsnStore?.[name] === 'string';
}

// Bytes of a pack already in the store, in a fresh buffer (offset 0, so Int16Array views work).
// The base64 text is dropped from the store once decoded.
export function readData(name, env) {
  const { win } = envOf(env);
  const done = cache(decoded, win);
  if (done.has(name)) return done.get(name);
  const b64 = win.__lsnStore?.[name];
  if (typeof b64 !== 'string') throw new Error(`data pack ${name} is not loaded`);
  const bytes = decode(b64.trim());
  done.set(name, bytes);
  delete win.__lsnStore[name];
  return bytes;
}

// Resolves with the bytes; injects <script src="data/js/<name>.js"> if the pack is not there yet.
// Rejects if the script fails to load, loads without delivering the pack, or takes over timeoutMs.
export function loadData(name, { timeoutMs = 30000 } = {}, env) {
  const { win, doc } = envOf(env);
  if (!NAME.test(name)) return Promise.reject(new Error(`bad data pack name ${name}`));
  if (hasData(name, env)) {
    try { return Promise.resolve(readData(name, env)); } catch (e) { return Promise.reject(e); }
  }
  const inflight = cache(pending, win);
  if (inflight.has(name)) return inflight.get(name);
  const promise = new Promise((resolve, reject) => {
    win.__lsnStore ??= {};
    win.__lsnWaiters ??= {};
    const script = doc.createElement('script');
    let timer = null;
    const finish = (err) => {
      if (timer === null) return;   // settled already
      clearTimeout(timer); timer = null;
      // a new array, so a forEach in __lsnData that is calling us does not skip the next waiter
      win.__lsnWaiters[name] = (win.__lsnWaiters[name] ?? []).filter((f) => f !== onData);
      inflight.delete(name);
      if (err) { script.remove?.(); reject(err); return; }
      try { resolve(readData(name, env)); } catch (e) { reject(e); }
    };
    function onData() { finish(null); }
    win.__lsnWaiters[name] = [...(win.__lsnWaiters[name] ?? []), onData];
    timer = setTimeout(() => finish(new Error(`data pack ${name} timed out after ${timeoutMs} ms`)), timeoutMs);
    script.onerror = () => finish(new Error(`data pack ${name} failed to load`));
    script.onload = () => { if (!hasData(name, env)) finish(new Error(`data pack ${name} loaded without data`)); };
    script.src = `data/js/${name}.js`;
    (doc.head ?? doc.body ?? doc.documentElement).appendChild(script);
  });
  inflight.set(name, promise);
  return promise;
}

// Phase 4: many packs (elevation tiles) with at most `concurrency` scripts loading at once, nearest-first
// order kept. onEach(name, bytes | null, error | null) runs as each one settles (an exception in it is
// rethrown asynchronously and does not stop the loads). Never rejects: resolves
// with a Map(name → Uint8Array | Error) once all have settled.
export function loadPacks(names, { concurrency = 6, timeoutMs = 30000, onEach } = {}, env) {
  const list = [...new Set(names)];
  const results = new Map();
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const name = list[next++];
      let bytes = null, error = null;
      try { bytes = await loadData(name, { timeoutMs }, env); } catch (err) { error = err; }
      results.set(name, error ?? bytes);
      try { onEach?.(name, bytes, error); } catch (e) { setTimeout(() => { throw e; }, 0); }   // surfaces, does not stop the loads
    }
  };
  const n = Math.max(1, Math.min(concurrency, list.length));
  return Promise.all(Array.from({ length: n }, worker)).then(() => results);
}
