// MCP v2 mission bridge: read exported plans and inspect their named points. The extension is browser-safe;
// only ctx.readText may read an explicitly supplied local path. All sky computations reuse the core/windows
// functions, never the export's cached visibility flags. Missing times/data remain explicitly unavailable.
import { parseMission, parseLink, resolveMissionPoint } from '../mission-io.js';
import { summarize, visibleIntervals, longestGapMs } from '../windows.js';
import { toXY } from '../terrain.js';

const DETAIL = { type: 'string', enum: ['brief', 'standard', 'full'] };
const SCREEN = 'A first-look screen, not a certified landing analysis.';
const instant = (ms) => Number.isFinite(ms) ? new Date(ms).toISOString() : null;

export function missionTools(kit) {
  const { ctx, eph, refs, round, hours, iso, err } = kit;
  const obj = kit.schema.obj;
  const specs = [
    { name: 'mission_open', description: 'Open a page mission record, frozen configuration, GeoJSON, route3d payload or share link, and retain named points for later tools; read-only and offline.',
      schema: obj({ source: obj({ path: { type: 'string' }, url: { type: 'string' }, json: { type: ['object', 'string'] } }), name: { type: 'string' }, detail: DETAIL }, ['source']) },
    { name: 'mission_conditions', description: 'Inspect Sun/Earth visibility at up to 24 named mission points during their exported pass and/or the mission stay; includes next events and direct-link risks.',
      schema: obj({ mission_id: { type: 'string' }, points: { type: ['array', 'string'], minItems: 1, maxItems: 24, items: { type: 'string' }, description: 'Point names (case-insensitive, aliases accepted), or all; default all.' }, window: { type: 'string', enum: ['pass', 'stay', 'both'] }, detail: DETAIL }) },
  ];

  function about(detail) {
    const a = kit.about({ units: { '*H': 'hours', '*Deg': 'degrees', '*km': 'km', times: 'UTC ISO 8601', soc_min: 'battery fraction 0–1' },
      resolution: { scan: kit.conv.SCAN_RES, psr: '120 m bitmap when available' },
      conventions: [kit.conv.VISIBLE_CONV, kit.conv.CLIP_CONV,
        'Pass visibility is evaluated at a fixed point over [arrive, depart], not along the moving route.',
        'Pass angles retain sky_at precision (0.01°); coordinates retain 5 decimals for locating the point; hours/km round to 0.1.',
        'Next events search to the ephemeris end; null means no crossing found in coverage, not never.',
        'An instantaneous pass has zero duration; whole-pass visibility is its instantaneous state.'],
      limits: [SCREEN, '15-minute scans may miss shorter visibility changes; exported route times are planning assumptions.',
        'Earth visibility is direct line of sight, not a surface-station or relay link budget; exported station settings are not evaluated.'] });
    if (detail !== 'brief') return a;
    // Preserve the contract in <1 KB: project the shared about block into compact units/resolution/limits.
    return { units: 'h, deg, km; UTC', resolution: ctx.dem || ctx.skylineKm ? `LOLA ${round((ctx.dem?.kmPerPixel ?? ctx.skylineKm) * 1000, 0)} m` : 'smooth horizon',
      sampling: '15 min; crossings 1 min', limits: [a.limits.find((s) => s === SCREEN), '80°S–pole; 2026-11–2029-01; no link budget.'] };
  }

  function assumptions(m, brief = false) {
    const a = [];
    if (m.route) a.push(brief ? 'Plan times; linear speed; zero unrecorded dwell.' : 'Exported pass times are a plan; waypoint speed is constant between exported samples/charging stops; transit has no dwell unless exported.');
    if (m.kind === 'link') a.push('Page defaults: im2, 2027-01-13, stay/slip 14 d; hour snapping.');
    const settings = ['power', 'mobility', 'vehicle', 'station', 'energy', 'relay', 'limits', 'reserve'].filter((k) => m.settings[k] != null);
    if (settings.length) a.push(brief ? `Assumed exports: ${settings.join(', ')} (not rechecked).` : `Exported ${settings.join(', ')}: assumptions, not re-evaluated.`);
    return a;
  }

  const pointOut = (p) => ({ name: p.name, kind: p.kind, aliases: [...p.aliases], lat_deg: round(p.latDeg, 5), lon_deg: round(p.lonDeg, 5), arrive: instant(p.arriveMs), depart: instant(p.departMs), km: round(p.km) });
  const routeOut = (r) => r ? { label: r.label, route_id: r.routeId, length_km: round(r.lengthKm), hours: round(r.hours), depart: instant(r.departMs), arrive: instant(r.arriveMs), soc_min: round(r.socMin, 4), one_way_km: round(r.oneWayKm), returnable: r.returnable, traps_km2: round(r.trapsKm2), station_km: round(r.stationKm), earth_share: round(r.earthShare, 4) } : null;

  async function mission_open(input) {
    const detail = input.detail ?? 'standard';
    const keys = Object.keys(input.source);
    if (keys.length !== 1) return err('Give exactly one source: { path }, { url } or { json }.');
    if (input.name !== undefined && !input.name.trim()) return err('name must be non-empty.');
    const kind = keys[0];
    let parsed, source;
    if (kind === 'path') {
      if (typeof ctx.readText !== 'function') return err('Local paths are unavailable in the browser; paste the JSON using source.json instead.');
      let read;
      try { read = await ctx.readText(input.source.path); } catch (e) { return err(`Cannot read mission file: ${e.message}`); }
      if (read?.error) return err(read.error);
      if (typeof read?.text !== 'string') return err('The file reader returned no JSON text.');
      source = { path: read.path ?? input.source.path };
      parsed = parseMission(read.text, { sites: ctx.sites });
    } else if (kind === 'url') {
      source = { url: input.source.url };
      parsed = parseLink(input.source.url, { sites: ctx.sites });
    } else {
      source = { json: 'provided' };
      parsed = parseMission(input.source.json, { sites: ctx.sites });
    }
    if (parsed.error) return err(parsed.error);
    const m = parsed.mission;
    if (input.name !== undefined) m.name = input.name.trim();
    const mission_id = refs.put('mission', m, { prefix: 'm' });
    const assumed = assumptions(m);
    const timed = m.points.filter((p) => p.arriveMs !== null && p.departMs !== null).length;
    const headline = `Opened ${m.points.length} mission points; ${timed} have pass times and the stay window is ${m.landingMs !== null && m.stayDays !== null ? 'available' : 'unavailable'}.`;
    if (detail === 'brief') return {
      mission_id, kind: m.kind, query_echo: { source: kind, mission_id, detail }, assumed: assumptions(m, true),
      point_count: m.points.length, timed_points: timed, length_km: round(m.route?.lengthKm), stay_days: m.stayDays,
      headline, refs: { mission: mission_id }, about: about(detail),
    };
    const out = { mission_id, kind: m.kind, name: m.name,
      query_echo: { source, name: m.name, detail, landing: instant(m.landingMs), stay_days: m.stayDays, slip_days: m.slipDays }, assumed,
      site: m.site ? { ...m.site, latDeg: round(m.site.latDeg, 5), lonDeg: round(m.site.lonDeg, 5) } : null,
      landing: instant(m.landingMs), stay_days: m.stayDays, slip_days: m.slipDays, points: m.points.map(pointOut), route: routeOut(m.route),
      notes: [...m.notes], headline, refs: { mission: mission_id }, about: about(detail) };
    if (detail === 'full') { out.settings = structuredClone(m.settings); out.route_samples = m.route ? { fields: ['latDeg', 'lonDeg', 'km', 'tMs', 'soc', 'flags', 'gradeDeg', 'heightM'], samples: structuredClone(m.route.samples) } : null; }
    return out;
  }

  const skyOut = (site, t, mask) => {
    const r = kit.bodyNow(eph, site, t, mask);
    const clean = ({ _el, _sky, ...rest }) => rest;
    return { at: instant(t), sun: clean(r.sun), earth: clean(r.earth) };
  };
  const intervalsOut = (iv) => iv.map(([a, b]) => ({ from: iso(a), to: iso(b), hours: hours(b - a) }));

  function passAt(p, site, mask, detail, risks) {
    const a = p.arriveMs, d = p.departMs;
    if (a === null || d === null) return { available: false, note: 'no pass time in the export; stay conditions are provided when available.' };
    if (a < eph.startMs || d > eph.endMs) return { available: false, note: `Pass is outside ephemeris coverage (${iso(eph.startMs)} to ${iso(eph.endMs)}); no partial pass is treated as complete.` };
    const arrival = skyOut(site, a, mask), departure = skyOut(site, d, mask);
    const result = { available: true, arrive: instant(a), depart: instant(d), durationH: hours(d - a), arrival, departure };
    for (const [body, label] of [['sun', 'Sun'], ['earth', 'Earth']]) {
      const iv = visibleIntervals(eph, site, body, a, d, mask);
      const whole = arrival[body].visible && departure[body].visible && (a === d || (iv.length === 1 && iv[0][0] === a && iv[0][1] === d));
      const next = a < eph.endMs ? kit.nextCrossings(site, body, a, mask) : { nextSet: null, nextRise: null };
      const event = (ms) => ms === null ? null : { time: iso(ms), inH: hours(ms - a) };
      result[body] = { inViewWholePass: whole, nextSet: event(next.nextSet), nextRise: event(next.nextRise) };
      if (detail === 'full') result[body].visible_intervals = intervalsOut(iv);
      if (body === 'earth') result.longestWithoutEarthH = hours(longestGapMs(iv, a, d));
      if (!arrival[body].visible && (iv.length === 0 || a === d)) {
        risks.push({ severity: 1, text: body === 'earth' ? 'Earth not in view for the whole pass: no direct link.' : 'Sun not in view for the whole pass: no solar illumination.' });
      } else if (!arrival[body].visible) {
        risks.push({ severity: 2, text: `${label} is not in view on arrival${next.nextRise !== null ? `; rises ${hours(next.nextRise - a)} h later` : ''}.` });
      }
      if (next.nextSet !== null && next.nextSet < d) risks.push({ severity: 2, text: `${label} sets ${hours(next.nextSet - a)} h after arrival (before departure).` });
      if (body === 'earth' && !whole && a !== d && iv.length) risks.push({ severity: 3, text: `Longest time without Earth during the pass is ${result.longestWithoutEarthH} h.` });
    }
    result.searchedTo = iso(eph.endMs);
    return result;
  }

  function stayAt(m, site, mask, detail) {
    if (m.landingMs === null || m.stayDays === null) return { available: false, note: 'No landing time and stay duration in the export.' };
    const s = summarize(eph, site, m.landingMs, m.stayDays, mask);
    if (!s) return { available: false, note: 'Mission landing is outside ephemeris coverage.' };
    const out = { available: true, landing: instant(m.landingMs), ...kit.summaryFigures(s, m.stayDays) };
    if (detail === 'full') out.visible_intervals = { sun: intervalsOut(s.sunIntervals), earth: intervalsOut(s.earthIntervals), both: intervalsOut(s.bothIntervals) };
    return out;
  }

  async function mission_conditions(input) {
    const m = refs.get('mission', input.mission_id);
    if (!m) return err(input.mission_id ? `Mission ${input.mission_id} is no longer held; run mission_open again.` : 'No mission is open; run mission_open first.');
    const mission_id = input.mission_id ?? refs.latestId('mission'), detail = input.detail ?? 'standard', window = input.window ?? 'both';
    const requested = input.points ?? 'all';
    if (typeof requested === 'string' && requested !== 'all') return err('points must be an array of names or "all".');
    let selected = [];
    if (requested === 'all') selected = m.points;
    else for (const name of requested) {
      const r = resolveMissionPoint(m, name);
      if (r.error) return err(r.error);
      if (!selected.includes(r.point)) selected.push(r.point);
    }
    if (selected.length > 24) return err(`This mission has ${selected.length} points; request at most 24 names per call.`);
    const psr = await kit.provided(ctx.psr);
    const points = selected.map((p) => {
      const site = { id: p.name, name: p.name, latDeg: p.latDeg, lonDeg: p.lonDeg }, h = kit.horizonOf(site);
      const risks = [], [x, y] = toXY(p.latDeg, p.lonDeg);
      const inside = psr && p.latDeg <= -80 && (psr.halfKm == null || (x >= -psr.halfKm && x < psr.halfKm && y <= psr.halfKm && y > -psr.halfKm)) ? psr.isPsr(x, y) : null;
      if (inside === true) risks.push({ severity: 0, text: 'Point inside a permanently shadowed region.' });
      const pass = window === 'stay' ? null : passAt(p, site, h.mask, detail, risks);
      const stay = window !== 'pass' || !pass?.available ? stayAt(m, site, h.mask, detail) : null;
      if (stay?.available && !pass?.available) {
        if (stay.sunH === 0) risks.push({ severity: 1, text: 'Sun not in view during the covered stay.' });
        if (!stay.earthEverUp) risks.push({ severity: 1, text: 'Earth not in view during the covered stay: no direct link.' });
      }
      const notes = [...(h.note ? [h.note] : []), ...(inside === null ? ['PSR membership unavailable at this point.'] : [])];
      if (stay?.stay?.clipped) notes.push('Stay clipped at the ephemeris end; hours cover only the available interval.');
      return { ...pointOut(p), arrival_after_landing_h: m.landingMs !== null && p.arriveMs !== null ? hours(p.arriveMs - m.landingMs) : null,
        horizon: h.terrain ? 'terrain' : 'smooth', inside_psr: inside, pass, stay, risks: risks.sort((a, b) => a.severity - b.severity).map((r) => r.text), notes };
    });
    const riskCount = points.filter((p) => p.risks.length).length;
    const unavailable = points.filter((p) => (window !== 'stay' && !p.pass?.available) || (window !== 'pass' && !p.stay?.available)).length;
    const headline = `Checked ${points.length} mission points; ${riskCount} have visibility or shadow risks and ${unavailable} lack a requested time window.`;
    const query_echo = { mission_id, points: requested === 'all' ? 'all' : selected.map((p) => p.name), window, detail };
    const passes = points.filter((p) => p.pass?.available);
    if (detail === 'brief') return { mission_id, query_echo, assumed: assumptions(m, true),
      point_count: points.length, sun_up_on_arrival: passes.length ? passes.filter((p) => p.pass.arrival.sun.visible).length : null, earth_up_on_arrival: passes.length ? passes.filter((p) => p.pass.arrival.earth.visible).length : null,
      risk_points: riskCount, unavailable_points: unavailable, headline: `${points.length} points checked: ${riskCount} with risks; ${unavailable} missing windows.`, refs: { mission: mission_id }, about: about(detail) };
    return { mission_id, query_echo, assumed: assumptions(m), points, headline, refs: { mission: mission_id }, about: about(detail) };
  }

  return { specs, handlers: { mission_open, mission_conditions } };
}
