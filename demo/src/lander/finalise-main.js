// Entry of demo/finalise.html (bundled by tools/build-lander.mjs): step 2 of the mission, "Finalise".
// Reads the plan made on the Map (mission-flow.js mission, the chosen rover route in lsn-route3d), plans the
// flight to it (lander/mission.js, the same planner the execution page flies), shows the go / no-go rows
// (mission-config.js goNoGoRows) and the vehicle numbers (assumed; editable here, the last place they can change),
// and "Freeze" writes the configuration (mission-config.js) and opens step 3, the execution page.
import { createEphemeris } from '../ephemeris.js';
import { createDem, skylineFor } from '../terrain.js';
import { hasData, readData, loadData } from '../data-loader.js';
import { planMission } from './mission.js';
import { landingChecks, skyAt } from './landing.js';
import { cleanVehicle, VEHICLE_DEFAULTS } from './vehicle.js';
import { FIELDS } from './ui.js';
import { createSiteContexts, isPolarSite } from './globalsite.js';
import { readMission, writeMission, stageUrl, stageBar, EXEC_PHASES, execPhaseOf, ROUTE_KEY } from '../mission-flow.js';
import { buildConfig, readConfig, writeConfig, changesSince, windowAround, goNoGoRows, verdictOf, routeSummary } from '../mission-config.js';
import { bootScreen } from '../boot.js';

const $ = (s) => document.querySelector(s);
const json = (id) => JSON.parse(document.getElementById(id)?.textContent ?? 'null');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const utc = (ms) => (Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—');
const dur = (ms) => { const h = ms / 3600e3; return h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(h < 10 ? 1 : 0)} h`; };
const latlon = (lat, lon) => `${Math.abs(lat).toFixed(3)}°${lat < 0 ? 'S' : 'N'} ${(((lon % 360) + 360) % 360).toFixed(3)}°E`;
const LEVEL = { go: 'Go', warn: 'Check', 'no-go': 'No-go' };

export function readRoute() {
  try { const p = JSON.parse(localStorage.getItem(ROUTE_KEY) ?? 'null'); return p?.v === 1 && p.pts?.length ? p : null; } catch { return null; }
}

export function boot() {
  const loading = bootScreen(document);
  setTimeout(() => loading.done(), 15000);
  const eph = createEphemeris(json('data-ephemeris'));
  const sites = json('data-sites');
  const meta = json('data-terrain');
  let dem = null;
  const siteCtx = createSiteContexts({ load: (name) => loadData(name, { timeoutMs: 90000 }), getDem: () => dem, manifest: json('data-hires') });
  $('#stages').replaceChildren(stageBar(document, 'finalise'));
  $('#back-map').href = stageUrl('map', readMission());
  const S = { mission: readMission(), vehicle: null, route: null, routeRaw: null, plan: null, rows: [], window: null, ctx: null, token: 0 };
  S.vehicle = cleanVehicle(S.mission?.vehicle ?? { ...VEHICLE_DEFAULTS });
  globalThis.__finalise = S;

  function renderEmpty() {
    $('#cfg').innerHTML = `<section class="fz-card"><h2>No site chosen yet</h2><p class="note">Pick a site and a landing time on the Map first (step 1): the whole Moon, a region, or the south-pole site list.</p><p><a class="btn primary" href="${esc(stageUrl('map', null))}">Open the Map</a></p></section>`;
    $('#checks').innerHTML = '';
    loading.done();
  }

  async function compute() {
    const m = S.mission;
    const token = ++S.token;
    const site = { id: m.siteId ?? 'custom', name: m.siteName ?? latlon(m.latDeg, m.lonDeg), latDeg: m.latDeg, lonDeg: m.lonDeg };
    $('#verdict').textContent = 'Planning the flight to the site…';
    if (!S.ctx || S.ctx.key !== `${site.latDeg},${site.lonDeg}`) {
      try { S.ctx = { ...(await siteCtx.context(site)), key: `${site.latDeg},${site.lonDeg}` }; } catch (e) { S.ctx = { polar: false, mask: () => 0, heightM: 0, resKm: 7.6, key: '', error: e.message }; }
    }
    if (token !== S.token) return;
    const polar = isPolarSite(site);
    const mask = S.ctx.mask ?? (polar ? skylineFor(dem, site) : () => 0);
    const tMs = m.landingMs;
    const sky0 = Number.isFinite(tMs) ? skyAt(eph, site, tMs, mask) : null;
    const sky = sky0 ? { sun: sky0.sun.clearDeg, earth: sky0.earth.clearDeg } : null;
    const upBoth = (t) => { const s = skyAt(eph, site, t, mask); return !!s && s.sun.clearDeg > 0 && s.earth.clearDeg > 0; };
    const upSun = (t) => { const s = skyAt(eph, site, t, mask); return !!s && s.sun.clearDeg > 0; };
    S.window = Number.isFinite(tMs) ? (windowAround(tMs, upBoth) ? { ...windowAround(tMs, upBoth), earth: true } : windowAround(tMs, upSun) ? { ...windowAround(tMs, upSun), earth: false } : null) : null;
    let planError = null;
    S.plan = null;
    if (Number.isFinite(tMs)) {
      const p = planMission({ eph, site, landingMs: tMs, vehicle: S.vehicle, siteHeightKm: (S.ctx.heightM ?? dem.heightAt(site.latDeg, site.lonDeg) ?? 0) / 1000, mask });
      if (p.ok) S.plan = p; else planError = p.error;
    } else planError = 'No landing time set on the Map.';
    const checks = S.plan ? landingChecks({ eph, site, tMs: S.plan.times.landingMs, mask, vehicle: S.plan.vehicle, touchdown: S.plan.descent.touchdown }).checks : null;
    S.routeRaw = readRoute();
    S.route = routeSummary(S.routeRaw, site);
    S.rows = goNoGoRows({ site: { latDeg: site.latDeg, polar, resKm: polar ? 0.24 : S.ctx.resKm ?? 0.474 }, sky, window: S.window, plan: S.plan, planError, checks, route: S.route });
    render(site, polar);
    loading.done();
  }

  function render(site, polar) {
    const m = S.mission, p = S.plan, r = S.route, w = S.window;
    const cur = readConfig();
    const routeForCfg = r?.belongs ? S.routeRaw : null;
    const changed = cur ? changesSince(cur, m, { route: routeForCfg, vehicle: S.vehicle }) : [];
    const verdict = verdictOf(S.rows);
    // the configuration, as it will be frozen
    const phaseRows = p ? EXEC_PHASES.map((ph) => {
      const ids = ph.from;
      const parts = p.phases.filter((x) => ids.includes(x.id));
      if (ph.id === 'surface') return { ph, from: r?.belongs ? r.departMs ?? p.times.landingMs : p.times.landingMs, to: r?.belongs ? r.arriveMs : null, what: r?.belongs ? `${r.label} route, ${r.lengthKm.toFixed(1)} km` : 'the lander stays at the site' };
      return { ph, from: parts[0]?.startMs ?? null, to: parts[parts.length - 1]?.endMs ?? null, what: parts.map((x) => x.name).join(' · ') };
    }) : [];
    $('#cfg').innerHTML = `
      <section class="fz-card">
        <h2>Site <a class="fz-edit" href="${esc(stageUrl('map', m))}">Change on the Map</a></h2>
        <p class="fz-big">${esc(site.name)}</p>
        <p class="muted">${latlon(site.latDeg, site.lonDeg)} · ${polar ? 'south polar LOLA terrain and skyline' : `global LOLA terrain (${Math.round((S.ctx.resKm ?? 0.474) * 1000)} m), skyline computed at the site`}</p>
      </section>
      <section class="fz-card">
        <h2>Landing time and window <a class="fz-edit" href="${esc(stageUrl('map', m))}">Change on the Map</a></h2>
        <dl class="kv">
          <dt>Requested landing</dt><dd>${utc(m.landingMs)}</dd>
          <dt>Touchdown (planned pass)</dt><dd>${p ? utc(p.times.landingMs) : '—'}<small>the polar orbit passes over the site within half an orbit of the request</small></dd>
          <dt>Window</dt><dd>${w ? `${utc(w.startMs)} → ${utc(w.endMs)}` : 'none'}<small>${w ? `${dur(w.endMs - w.startMs)} with the Sun${w.earth ? ' and the Earth' : ''} above the skyline` : 'the Sun is not above the skyline at the requested time'}</small></dd>
          <dt>Stay</dt><dd>${m.stayDays ?? 14} days</dd>
          ${p ? `<dt>Launch</dt><dd>${utc(p.times.launchMs)}<small>parking orbit insertion; ${dur(p.times.landingMs - p.times.launchMs)} before touchdown</small></dd>` : ''}
        </dl>
      </section>
      <section class="fz-card">
        <h2>Rover route <a class="fz-edit" href="${esc(stageUrl('rover', m))}">Plan on the Map</a></h2>
        ${r && r.belongs ? `<dl class="kv">
          <dt>Route</dt><dd>${esc(r.label)}, ${r.lengthKm.toFixed(1)} km</dd>
          <dt>Departure</dt><dd>${utc(r.departMs)}</dd>
          <dt>Arrival</dt><dd>${r.arriveMs ? utc(r.arriveMs) : r.emptyAt ? `battery empty at km ${r.emptyAt.km.toFixed(1)}` : '—'}</dd>
          ${r.minSoc !== null ? `<dt>Lowest battery</dt><dd>${Math.round(r.minSoc * 100)} %<small>reserve ${Math.round(r.reserve * 100)} % (assumed)</small></dd>` : ''}
          <dt>Safe havens</dt><dd>${r.havens}</dd></dl>` : `<p class="note">${r ? `The route stored on the Map starts ${r.startKm.toFixed(0)} km from this site, so it is left out.` : 'No rover route chosen.'} Surface operations will keep the lander at the site. ${polar ? 'Plan one in the route card (Map, Site level).' : 'The rover planner needs the polar terrain (south of 80°S).'}</p>`}
      </section>
      <section class="fz-card">
        <h2>Vehicle <small>assumed numbers · last chance to change them</small></h2>
        <div class="form">${FIELDS.map(([k, label, unit]) => `<label><span>${label} <small>${unit}</small></span><input type="number" step="any" data-k="${k}" value="${S.vehicle[k]}"></label>`).join('')}</div>
        <div class="form-actions"><button class="btn" data-reset type="button">Default numbers</button><span class="muted">changes re-check at once</span></div>
      </section>
      ${phaseRows.length ? `<section class="fz-card">
        <h2>What will be flown</h2>
        <ol class="fz-phases">${phaseRows.map((x, i) => `<li><span class="n">${i + 1}</span><div><b>${esc(x.ph.label)}</b> <span class="muted">${utc(x.from)}${x.to ? ` → ${utc(x.to)}` : ''}</span><br><small>${esc(x.what)}</small></div></li>`).join('')}</ol>
      </section>` : ''}`;
    $('#cfg').querySelectorAll('input[data-k]').forEach((inp) => inp.addEventListener('change', () => {
      const v = { ...S.vehicle };
      $('#cfg').querySelectorAll('input[data-k]').forEach((i) => { v[i.dataset.k] = Number(i.value); });
      S.vehicle = cleanVehicle(v);
      S.mission = writeMission({ vehicle: S.vehicle });
      compute();
    }));
    $('#cfg [data-reset]').addEventListener('click', () => { S.vehicle = cleanVehicle({ ...VEHICLE_DEFAULTS }); S.mission = writeMission({ vehicle: S.vehicle }); compute(); });

    const counts = { go: 0, warn: 0, 'no-go': 0 };
    for (const row of S.rows) counts[row.level]++;
    $('#verdict').className = `fz-verdict v-${verdict}`;
    $('#verdict').innerHTML = `<b>${verdict === 'go' ? 'Go' : verdict === 'warn' ? 'Go, with items to check' : 'No-go items open'}</b><span>${counts.go} go · ${counts.warn} to check · ${counts['no-go']} no-go</span>`;
    $('#checks').innerHTML = S.rows.map((row) => `<li class="lv-${row.level}"><span class="tag">${LEVEL[row.level]}</span><div><b>${esc(row.label)}</b><br>${esc(row.value)}${row.note ? `<small>${esc(row.note)}</small>` : ''}</div></li>`).join('');
    $('#current').innerHTML = cur
      ? `Frozen configuration <b>${esc(cur.id)}</b> (${esc(cur.site.name)}, landing ${utc(cur.landing.requestedMs)}), frozen ${utc(cur.frozenMs)}. ${changed.length ? `<span class="neg">Changed since: ${esc(changed.join(', '))}.</span> Freezing again replaces it.` : 'The plan is the same as that one.'} <a href="${esc(stageUrl('execute'))}">Open it</a>`
      : 'Nothing frozen yet.';
    const btn = $('#freeze');
    btn.disabled = !Number.isFinite(m.landingMs);
    btn.textContent = verdict === 'no-go' ? 'Freeze with no-go items and go to launch' : cur && !changed.length ? 'Freeze again and go to launch' : 'Freeze and go to launch';
  }

  $('#freeze').addEventListener('click', () => {
    try {
      const m = readMission();
      const routeForCfg = S.route?.belongs ? S.routeRaw : null;
      const cfg = buildConfig({ mission: { ...m, vehicle: S.vehicle }, vehicle: S.vehicle, route: routeForCfg, window: S.window, checks: S.rows });
      writeConfig(cfg);
      location.href = stageUrl('execute');
    } catch (e) {
      $('#current').innerHTML = `<span class="neg">Could not freeze: ${esc(e.message)}</span>`;
    }
  });

  const start = () => {
    const lv = meta.dem, bytes = readData('dem_480m');
    dem = createDem({ data: new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1), size: lv.size, kmPerPixel: lv.kmPerPixel, dnToMeters: lv.dnToMeters });
    if (!S.mission) { renderEmpty(); return; }
    compute().catch((e) => { $('#verdict').textContent = `Could not check the plan: ${e.message}`; loading.done(); });
  };
  loading.set(0.3, 'Loading the 480 m terrain map…');
  if (hasData('dem_480m')) start();
  else loadData('dem_480m').then(start, (e) => { loading.done(); $('#verdict').textContent = `dem_480m failed to load: ${e.message}`; });
  // a change on the Map in another tab: check again
  window.addEventListener('storage', (e) => { if (e.key === 'lsn-mission' || e.key === ROUTE_KEY) { S.mission = readMission(); if (S.mission && dem) compute(); } });
  void execPhaseOf; void sites;
}

if (typeof document !== 'undefined' && document.getElementById('cfg')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
