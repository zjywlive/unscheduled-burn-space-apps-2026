// High-resolution terrain patches around the landing sites (tools/fetch-hires.mjs, demo/data/hires.json):
// 5 m, 10 m or 20 m LOLA, 10 × 10 km per site, polar stereographic map km like terrain.js. A patch has the
// same sampling interface as the terrain.js levels (sample → metres | NaN, heightAtXY → metres | null,
// kmPerPixel), so it can sit at the fine end of any list of levels.
import { decodePack } from './globe-terrain.js';
import { toXY } from './terrain.js';

// One patch: n × n Int16 DN, pixel centres at xMin + (i + 0.5)·kpp, yMax − (j + 0.5)·kpp; bilinear.
export function createPatch({ id = null, data, n, kmPerPixel: kpp, xMin, yMax, dnToMeters = 0.5 }) {
  const xMax = xMin + n * kpp, yMin = yMax - n * kpp;
  function sample(x, y) {
    const col = (x - xMin) / kpp - 0.5, row = (yMax - y) / kpp - 0.5;
    if (!(col >= 0 && row >= 0 && col <= n - 1 && row <= n - 1)) return NaN;
    const c0 = Math.min(Math.floor(col), n - 2), r0 = Math.min(Math.floor(row), n - 2), fc = col - c0, fr = row - r0, i = r0 * n + c0;
    const top = data[i] + (data[i + 1] - data[i]) * fc, bottom = data[i + n] + (data[i + n + 1] - data[i + n]) * fc;
    return (top + (bottom - top) * fr) * dnToMeters;
  }
  return {
    id, n, kmPerPixel: kpp, xMin, yMax, xMax, yMin, bounds: { x0: xMin, x1: xMax, y0: yMin, y1: yMax },
    sample,
    heightAtXY: (x, y) => { const v = sample(x, y); return v === v ? v : null; },
    heightAt: (latDeg, lonDeg) => { const v = sample(...toXY(latDeg, lonDeg)); return v === v ? v : null; },
  };
}

const meets = (e, b) => e.xMin < b.x1 && e.xMin + e.n * e.kmPerPixel > b.x0 && e.yMax > b.y0 && e.yMax - e.n * e.kmPerPixel < b.y1;

// The manifest's patches as a set that loads on demand. load(pack) → Promise<Uint8Array> (data-loader.js
// loadData in a page). → { entries, list (loaded patches, coarse to fine), entriesIn(bounds), ensure(bounds),
// ensureSite(id), sample(x, y), finestKmAt(bounds) }
export function createHiresSet(manifest, load, { onLoad = () => {} } = {}) {
  const entries = Object.entries(manifest?.sites ?? {}).map(([id, e]) => ({ id, ...e }));
  const loaded = new Map(), pending = new Map();
  const list = [];
  function ensureEntry(e) {
    if (loaded.has(e.id)) return Promise.resolve(loaded.get(e.id));
    if (pending.has(e.id)) return pending.get(e.id);
    const p = load(e.pack).then((b) => decodePack(b, e.n)).then((data) => {
      const patch = createPatch({ id: e.id, data, n: e.n, kmPerPixel: e.kmPerPixel, xMin: e.xMin, yMax: e.yMax });
      loaded.set(e.id, patch);
      list.push(patch);
      list.sort((a, b) => b.kmPerPixel - a.kmPerPixel);   // coarse to fine, like terrain.js levels
      onLoad(patch);
      return patch;
    }).catch(() => null).finally(() => pending.delete(e.id));
    pending.set(e.id, p);
    return p;
  }
  return {
    entries, list,
    entriesIn: (b) => entries.filter((e) => meets(e, b)),
    ensure: (b) => Promise.all(entries.filter((e) => meets(e, b)).map(ensureEntry)),
    ensureSite: (id) => { const e = entries.find((q) => q.id === id); return e ? ensureEntry(e) : Promise.resolve(null); },
    sample(x, y) { for (let i = list.length - 1; i >= 0; i--) { const v = list[i].sample(x, y); if (v === v) return v; } return NaN; },
    // the finest patch resolution available (loaded or not) over a box, km per pixel, or null
    finestKmAt: (b) => entries.filter((e) => meets(e, b)).reduce((m, e) => (m === null || e.kmPerPixel < m ? e.kmPerPixel : m), null),
  };
}
