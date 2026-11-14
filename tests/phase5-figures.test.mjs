// Phase 5 (G, item 3 and item 11): with a mission window set, every figure equals the phase-4 figure; the
// window survives being cleared and set again through the hash; and the compute tier gives the same numbers
// as the page's own path (same input, same number on screen and from the tool).
// tests/fixtures/phase4-figures.json was captured from the phase-4 build (before any phase-5 change) in
// headless Chrome: the page's summarizePair figures, the point card rows, get_energy and set_relay_orbit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCoreContext } from '../tools/core-context.mjs';
import { createCoreTools } from '../demo/src/tools-core.js';
import { parseHash, toHash, alternativeOf } from '../demo/src/state.js';
import { summarizePair, summarize } from '../demo/src/windows.js';
import { compareRows } from '../demo/src/ui/compare.js';
import { bodyAzEl } from '../demo/src/ephemeris.js';
import { skyStatus } from '../demo/src/skydial.js';
import { skylineFor } from '../demo/src/terrain.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/phase4-figures.json', import.meta.url), 'utf8'));
const ctx = loadCoreContext();
const core = createCoreTools(ctx);
// main.js sky(): skylineFor on the 480 m DEM, cached per place
const skyCache = new Map();
const sky = (site) => { const k = `${site.latDeg},${site.lonDeg}`; if (!skyCache.has(k)) skyCache.set(k, skylineFor(ctx.dem, site)); return skyCache.get(k); };
const pick = (s) => (s ? { stayMs: s.stayMs, sunMs: s.sunMs, earthMs: s.earthMs, bothMs: s.bothMs, longestDarkMs: s.longestDarkMs, clipped: s.clipped } : null);

// main.js compute(): the planned stay and the pair cut to the same length
function pageFigures(state) {
  const alt = alternativeOf(state, ctx.sites);
  const pair = summarizePair(ctx.eph, { site: state.site, landingMs: state.landingMs, mask: sky(state.site) }, { ...alt, mask: sky(alt.site) }, state.stayDays, 0);
  const planned = summarize(ctx.eph, state.site, state.landingMs, state.stayDays, sky(state.site));
  const sameSite = alt.site.id === state.site.id;
  const compared = pair.alt !== null && !(sameSite && state.slipDays === 0);
  return { pair, planned, compared };
}

test('phase 5: with a window, the figures equal the phase-4 build (summaries, point rows)', () => {
  assert.equal(fixture.length, 5);
  for (const f of fixture) {
    const st = parseHash(f.hash, ctx.sites, ctx.eph);
    assert.equal(st.windowOn, true, 'a phase-4 link opens with its window');
    const { pair, planned, compared } = pageFigures(st);
    assert.deepEqual(pick(pair.planned), f.planned, `${f.hash} planned`);
    assert.deepEqual(pick(pair.alt), f.alt, `${f.hash} alternative`);
    const rows = compareRows(compared ? pair.planned : planned, compared ? pair.alt : null).slice(0, 3).map((r) => `${r.label}${r.planned}${r.alt}`);
    assert.deepEqual(rows, f.rows, `${f.hash} point card rows`);
  }
});

test('phase 5: clearing the window and setting it again through the hash gives the same window and figures', () => {
  for (const f of fixture) {
    const st = parseHash(f.hash, ctx.sites, ctx.eph);
    const off = parseHash(toHash({ ...st, windowOn: false }), ctx.sites, ctx.eph);
    assert.equal(off.windowOn, false);
    assert.equal(off.landingMs, st.landingMs, 'the window is remembered while off');
    const on = parseHash(toHash({ ...off, windowOn: true }), ctx.sites, ctx.eph);
    assert.equal(on.landingMs, st.landingMs);
    assert.equal(on.stayDays, st.stayDays);
    assert.deepEqual(pick(pageFigures(on).pair.planned), f.planned);
  }
});

test('phase 5: the hash carries the playhead and the no-window state; old links still load', () => {
  const s = parseHash('#site=shackleton&t=2027-01-13T00:00Z&stay=14&win=off&now=2027-02-01T07:30Z', ctx.sites, ctx.eph);
  assert.equal(s.windowOn, false);
  assert.equal(s.cursorMs, Date.UTC(2027, 1, 1, 7, 30));
  assert.match(toHash(s), /&win=off/);
  assert.match(toHash(s), /&now=2027-02-01T07:30Z/);
  const old = parseHash('#view=navigator&site=im2&t=2027-01-13T00:00Z&stay=14&slip=14&alt=same&mode=both', ctx.sites, ctx.eph);
  assert.equal(old.view, 'map');
  assert.equal(old.sheet, 'overview');
  assert.equal(old.cursorMs, old.landingMs);
  assert.equal(toHash({ ...old, sheet: null }), '#view=map&site=im2&t=2027-01-13T00:00Z&stay=14&slip=14&alt=same&mode=both');
  // any whole number of hours from 1 to 60 days (the time dock's handles); 7 / 14 / 30 as before
  assert.equal(parseHash('#stay=9', ctx.sites, ctx.eph).stayDays, 9);
  assert.equal(parseHash('#stay=13.75', ctx.sites, ctx.eph).stayDays, 13.75);
  assert.equal(parseHash('#stay=0.5', ctx.sites, ctx.eph).stayDays, 14);
  assert.match(toHash({ ...old, stayDays: 13.75, sheet: null }), /stay=13\.75&/);
});

test('phase 5 item 11: same input, same number on screen and from the tool', async () => {
  for (const f of fixture) {
    const st = parseHash(f.hash, ctx.sites, ctx.eph);
    const at = new Date(st.landingMs).toISOString().slice(0, 16) + 'Z';
    // the inspector's hours and the sheet's tiles are compareRows of summarizePair; site_summary is summarize
    const r = await core.run('site_summary', { lat_deg: st.site.latDeg, lon_deg: st.site.lonDeg, landing: at, stay_days: st.stayDays });
    const planned = summarize(ctx.eph, st.site, st.landingMs, st.stayDays, sky(st.site));
    assert.equal(r.bothH, Math.round(planned.bothMs / 36e4) / 10, `${f.hash} both hours`);
    assert.equal(r.display.bothInView, compareRows(planned, null)[0].planned, `${f.hash} both hours as shown`);
    // the Compare card and compare_scenarios: the same pair, the same card text
    const alt = alternativeOf(st, ctx.sites);
    if (alt.landingMs < ctx.eph.endMs && !(alt.site.id === st.site.id && st.slipDays === 0)) {
      const c = await core.run('compare_scenarios', { scenarios: [
        { lat_deg: st.site.latDeg, lon_deg: st.site.lonDeg, landing: at },
        { lat_deg: alt.site.latDeg, lon_deg: alt.site.lonDeg, landing: new Date(alt.landingMs).toISOString().slice(0, 16) + 'Z' },
      ], stay_days: st.stayDays });
      const rows = compareRows(pageFigures(st).pair.planned, pageFigures(st).pair.alt);
      const card = c.scenarios[1].vsBaseline.card;
      for (let i = 0; i < 4; i++) {
        assert.equal(card[i].baseline, rows[i].planned, `${f.hash} compare card row ${i}`);
        assert.equal(card[i].scenario, rows[i].alt, `${f.hash} compare card alt row ${i}`);
        assert.equal(card[i].change, rows[i].change, `${f.hash} compare card change row ${i}`);
      }
    }
  }
  // the inspector's "Now, over skyline" row and sky_at; the countdown row and next_events
  const site = ctx.sites.find((s) => s.id === 'shackleton');
  const t = Date.UTC(2027, 0, 18, 6, 0);
  const b = bodyAzEl(ctx.eph, site, t);
  const sun = skyStatus(b.sun, sky(site)), earth = skyStatus(b.earth, sky(site));
  const s2 = await core.run('sky_at', { site_id: 'shackleton', at: '2027-01-18T06:00Z' });
  // (sky_at rounds to 0.01°, the row shows 0.1°: the unrounded values agree to the tool's rounding)
  assert.ok(Math.abs(sun.clearanceDeg - s2.sun.aboveSkylineDeg) <= 0.005, `sun ${sun.clearanceDeg} vs ${s2.sun.aboveSkylineDeg}`);
  assert.ok(Math.abs(earth.clearanceDeg - s2.earth.aboveSkylineDeg) <= 0.005, `earth ${earth.clearanceDeg} vs ${s2.earth.aboveSkylineDeg}`);
  const n = await core.run('next_events', { site_id: 'shackleton', at: '2027-01-18T06:00Z' });
  assert.match(n.headline, /^(Sunset|Sunrise) in .+ · (Earthset|Earthrise) in .+$|before 1 Jan 2029|stays up/);
});
