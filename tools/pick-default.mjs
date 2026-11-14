// Picks the default landing time (spec §7.4): IM-2, 14-day stay, mask 0, slip 14 days.
// Every 00:00 UTC in 2027 with the Sun up at landing; the largest drop in "both in view" hours wins.
import { readFileSync } from 'node:fs';
import { createEphemeris } from '../demo/src/ephemeris.js';
import { summarize } from '../demo/src/windows.js';
import { findSite } from '../demo/src/sites.js';

const DAY = 86400e3, H = 3600e3;
const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const eph = createEphemeris(load('../demo/data/ephemeris.json'));
const site = findSite(load('../demo/data/sites.json'), 'im2');

const ranked = [];
for (let t = Date.UTC(2027, 0, 1); t <= Date.UTC(2027, 11, 31); t += DAY) {
  const planned = summarize(eph, site, t, 14, 0);
  if (!planned.sunUpAtLanding) continue;
  const alt = summarize(eph, site, t + 14 * DAY, 14, 0);
  ranked.push({ t, plannedH: planned.bothMs / H, altH: alt.bothMs / H, dropH: (planned.bothMs - alt.bothMs) / H });
}
ranked.sort((a, b) => b.dropH - a.dropH);
for (const r of ranked.slice(0, 5)) {
  console.log(`${new Date(r.t).toISOString().slice(0, 10)}  planned ${r.plannedH.toFixed(1)} h  alternative ${r.altH.toFixed(1)} h  drop ${r.dropH.toFixed(1)} h`);
}
const best = ranked[0];
console.log(`Default: Date.UTC(${new Date(best.t).getUTCFullYear()}, ${new Date(best.t).getUTCMonth()}, ${new Date(best.t).getUTCDate()})`);
