// Terrain, height and skyline for a landing site anywhere on the Moon. South of 80°S the page's polar pyramid
// (480 m skyline from terrain.js, the fine levels in terrain-local.js); elsewhere the global LOLA terrain
// (globe-terrain.js: G0 7.6 km, G1 1.9 km, G2 474 m tiles, the north cap at 480 m), loaded around the site, with
// the skyline computed on the fly (skyline.js). One context per site, cached.
import { createGlobeTerrain, G1, G2 } from '../globe-terrain.js';
import { skylineFor, fromXY, TERRAIN_MAX_LAT } from '../terrain.js';
import { skylineLL } from './skyline.js';

export const isPolarSite = (site) => site.latDeg <= TERRAIN_MAX_LAT;
const key = (s) => `${s.latDeg.toFixed(4)},${s.lonDeg.toFixed(4)}`;

// load(name) → Promise<Uint8Array> (data-loader.js loadData); getDem() → the 480 m polar DEM.
export function createSiteContexts({ load, getDem }) {
  const globe = createGlobeTerrain({ load });
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
      const [h, label, kpp] = globe.sample(site.latDeg, site.lonDeg);
      const mask = skylineLL(globe.heightAt, site, { kmPerPixel: kpp ?? 0.474, maxKm: 180, source: `computed from LOLA ${label}` });
      ctx = { polar: false, mask, heightM: h, resKm: kpp ?? 7.6, label: `LOLA ${label}`, skyline: `computed from LOLA ${label} to 180 km`, sampleXY: llXY, resAtXY: (x, y) => { const p = fromXY(x, y); return globe.sample(p.latDeg, p.lonDeg)[2]; } };
    }
    cache.set(k, ctx);
    return ctx;
  }
  // a cheaper skyline for screening many points (72 azimuths, 120 km), tiles already around
  const quickMask = (site) => skylineLL(globe.heightAt, site, { azimuths: 72, maxKm: 120, kmPerPixel: 0.474 });
  return { globe, ready, around, context, quickMask, sampleLL: (lat, lon) => globe.heightAt(lat, lon), sampleInfo: (lat, lon) => globe.sample(lat, lon) };
}
