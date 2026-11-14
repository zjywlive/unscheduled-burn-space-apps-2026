// Terrain, height and skyline for a landing site anywhere on the Moon. South of 80°S the page's polar pyramid
// (480 m skyline from terrain.js, the fine levels in terrain-local.js); elsewhere the global LOLA terrain
// (globe-terrain.js: G0 7.6 km, G1 1.9 km, G2 474 m tiles, the north cap at 480 m), loaded around the site, with
// the skyline computed on the fly (skyline.js). One context per site, cached.
import { createGlobeTerrain, decodePack, G1, G2 } from '../globe-terrain.js';
import { skylineFor, fromXY, TERRAIN_MAX_LAT } from '../terrain.js';
import { skylineLL } from './skyline.js';

export const isPolarSite = (site) => site.latDeg <= TERRAIN_MAX_LAT;
const key = (s) => `${s.latDeg.toFixed(4)},${s.lonDeg.toFixed(4)}`;

// A fine equirectangular patch (tools/fetch-hires.mjs --at, SLDEM2015 59 m): pixel (i, j) centred at
// latMax − (j + 0.5)/ppd, lonMin + (i + 0.5)/ppd; heights DN × dnToMeters; bilinear, NaN outside.
export function equirectSampler(e, data) {
  const { width: w, height: h, ppd, latMax, lonMin } = e, dn = e.dnToMeters ?? 0.5;
  return (latDeg, lonDeg) => {
    let lo = lonDeg; while (lo < lonMin - 180) lo += 360; while (lo > lonMin + 180) lo -= 360;
    const col = (lo - lonMin) * ppd - 0.5, row = (latMax - latDeg) * ppd - 0.5;
    if (!(col >= 0 && row >= 0 && col <= w - 1 && row <= h - 1)) return NaN;
    const c0 = Math.min(Math.floor(col), w - 2), r0 = Math.min(Math.floor(row), h - 2), fc = col - c0, fr = row - r0, k = r0 * w + c0;
    const top = data[k] + (data[k + 1] - data[k]) * fc, bot = data[k + w] + (data[k + w + 1] - data[k + w]) * fc;
    return (top + (bot - top) * fr) * dn;
  };
}

// load(name) → Promise<Uint8Array> (data-loader.js loadData); getDem() → the 480 m polar DEM; manifest: hires.json
// (its `patches`, equirectangular ones, are the fine patches outside the south polar data).
export function createSiteContexts({ load, getDem, manifest = null }) {
  const globe = createGlobeTerrain({ load });
  const patches = Object.entries(manifest?.patches ?? {}).filter(([, e]) => e.projection === 'equirect').map(([id, e]) => ({ id, ...e }));
  const patchData = new Map();
  async function patchFor(site) {
    const lo = ((site.lonDeg % 360) + 360) % 360;
    const e = patches.find((p) => site.latDeg >= p.latMin && site.latDeg <= p.latMax && ((lo >= p.lonMin && lo <= p.lonMax) || (lo + 360 >= p.lonMin && lo + 360 <= p.lonMax)));
    if (!e) return null;
    if (!patchData.has(e.id)) patchData.set(e.id, load(e.pack).then((b) => decodePack(b, e.width)).then((d) => equirectSampler(e, d)).catch(() => null));
    const sample = await patchData.get(e.id);
    return sample ? { e, sample } : null;
  }
  let init = null;
  const cache = new Map();
  const ready = () => (init ??= globe.init());
  // the global tiles within km of a site (474 m near, 1.9 km beyond)
  async function around(site, km = 190) {
    await ready();
    const dLat = km / 30.3, dLon = Math.min(180, dLat / Math.max(0.05, Math.cos((site.latDeg * Math.PI) / 180)));
    const box = (f) => [Math.max(-90, site.latDeg - dLat * f), Math.min(90, site.latDeg + dLat * f), site.lonDeg - dLon * f, site.lonDeg + dLon * f];
    await globe.need(G1, ...box(1.5), { max: 16 });
    await globe.need(G2, ...box(1), { max: 80 });
  }
  const llXY = (x, y) => { const p = fromXY(x, y); return globe.heightAt(p.latDeg, p.lonDeg); };
  // { polar, mask, heightM, resKm, label, skyline, sampleXY, resAtXY } for a site
  async function context(site) {
    const k = key(site);
    if (cache.has(k)) return cache.get(k);
    let ctx;
    if (isPolarSite(site)) {
      const dem = getDem();
      ctx = { polar: true, mask: skylineFor(dem, site), heightM: dem?.heightAt(site.latDeg, site.lonDeg) ?? 0, resKm: 0.48, label: 'LOLA polar', skyline: 'LOLA 480 m polar DEM (precomputed method)' };
    } else {
      await around(site);
      const [h0, label, kpp] = globe.sample(site.latDeg, site.lonDeg);
      // a fine patch fetched for this place (SLDEM2015, 59 m) is the finest level; the global tiles beyond it
      const fine = await patchFor(site);
      const hAt = fine ? (la, lo) => { const v = fine.sample(la, lo); return v === v ? v : globe.heightAt(la, lo); } : globe.heightAt;
      const res = fine ? fine.e.kmPerPixel : kpp ?? 7.6;
      const terrain = fine ? `SLDEM2015 ${Math.round(res * 1000)} m patch (±${fine.e.halfKm} km), LOLA ${label} beyond` : `LOLA ${label}`;
      const mask = skylineLL(hAt, site, { kmPerPixel: fine ? res : kpp ?? 0.474, maxKm: 180, source: `computed from ${terrain}` });
      const xy = (x, y) => { const p = fromXY(x, y); return hAt(p.latDeg, p.lonDeg); };
      ctx = {
        polar: false, mask, heightM: hAt(site.latDeg, site.lonDeg) ?? h0, resKm: res, label: terrain, skyline: `computed from ${terrain} to 180 km`,
        patch: fine ? { id: fine.e.id, halfKm: fine.e.halfKm, product: fine.e.product, kmPerPixel: res } : null,
        sampleXY: xy, resAtXY: (x, y) => { const p = fromXY(x, y); return fine && fine.sample(p.latDeg, p.lonDeg) === fine.sample(p.latDeg, p.lonDeg) ? res : globe.sample(p.latDeg, p.lonDeg)[2]; },
      };
    }
    cache.set(k, ctx);
    return ctx;
  }
  // a cheaper skyline for screening many points (72 azimuths, 120 km), tiles already around
  const quickMask = (site) => skylineLL(globe.heightAt, site, { azimuths: 72, maxKm: 120, kmPerPixel: 0.474 });
  return { globe, ready, around, context, quickMask, sampleLL: (lat, lon) => globe.heightAt(lat, lon), sampleInfo: (lat, lon) => globe.sample(lat, lon) };
}
