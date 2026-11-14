// Mission file section of the route card: save the selected route as a record, download it as JSON, GeoJSON
// or CSV, list the saved missions (this browser's storage, shared with the 3D globe), load, delete, import.
// The pure helpers (record to card inputs, summary and settings of a record, list text) are tested in Node.
//
// settingsOf({ maxSlopeDeg, mobility, power, station, stationOff, departMs }) → record settings
// summaryOf({ route, plan, drive, comms }) → record summary (null where unknown)
// recordInputs(record) → { points, maxSlopeDeg, mobility, power, station, departMs, routeId, siteName }
// listText(item) → { title, sub }
// createMissionFile(callbacks) → { el, refresh(), setReady(bool), save(), ready() }   (Save mission is a button of the action bar)
// callbacks: {
//   getRecord() → record | null        the record of the selected route as it is now (not stored)
//   onLoad(record)                     Load pressed (or a file imported)
//   onNote(text)                       the section's status line changed (the action bar shows it too)
// }
import { h, clear } from './dom.js';
import { toXY } from '../terrain.js';
import { saveRecord, listRecords, loadRecord, deleteRecord, parseRecord, toGeoJSON, routeCSV, recordingCSV, fileName, downloadText, RECORDS_KEY } from '../mission-save.js';

const num = (v) => (Number.isFinite(v) ? v : null);

// The settings a plan was made with, as stored in a record.
export function settingsOf({ maxSlopeDeg = null, mobility = null, power = null, station = null, stationOff = false, departMs = null } = {}) {
  return { maxSlopeDeg: num(maxSlopeDeg), mobility: mobility ? { ...mobility } : null, power: power ? { ...power } : null, station: stationOff ? null : station ? { ...station } : null, stationOff: !!stationOff, departMs: num(departMs) };
}

// The figures of the selected route for a record's summary; what is not known is null.
export function summaryOf({ route, plan = null, drive = null, comms = null } = {}) {
  const m = comms?.summary ?? null;
  return {
    routeId: route?.id ?? null, label: route?.label ?? null, lengthKm: num(route?.lengthKm),
    hours: drive ? num(drive.driveH + (drive.waitH ?? 0)) : num(route?.hours),
    arriveMs: drive?.ok ? num(drive.arriveMs) : null,
    socMin: drive ? num(drive.socMin) : null,
    oneWayKm: num(route?.oneWayKm),
    returnable: typeof plan?.returnable === 'boolean' ? plan.returnable : null,
    trapsKm2: num(plan?.traps?.km2),
    stationKm: m ? num(m.stationKm) : null,
    earthShare: m && m.totalKm > 0 && m.earthKm !== null ? num(m.earthKm / m.totalKm) : null,
  };
}

// A record as the route card's inputs: the points in map km (start, waypoints, end; the first and last route
// points when the record has none), the limits, power, station and departure, and the route to select.
export function recordInputs(rec) {
  const r = rec.route, s = rec.settings ?? {};
  const ll = r.wps?.length >= 2 ? r.wps.map((w) => [w.latDeg, w.lonDeg]) : [r.pts[0], r.pts[r.pts.length - 1]].map((q) => [q[0], q[1]]);
  const mob = s.mobility ?? null;
  return {
    points: ll.map(([la, lo]) => toXY(la, lo)),
    maxSlopeDeg: num(s.maxSlopeDeg) ?? num(mob?.climbDeg) ?? num(r.limits?.climbDeg),
    mobility: mob ?? (r.limits ? { descentDeg: r.limits.descentDeg, crossDeg: r.limits.crossDeg } : null),
    power: s.power ?? null,
    station: s.stationOff ? null : s.station ?? null,
    stationOff: s.stationOff ?? s.station === null,
    departMs: num(s.departMs) ?? num(r.departMs),
    routeId: rec.summary?.routeId ?? r.routeId ?? null,
    siteName: rec.mission?.siteName ?? null,
  };
}

const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
// Two lines for a list row: the name, and length, date and whether motion was recorded.
export function listText(item) {
  const bits = [Number.isFinite(item.lengthKm) ? `${(Math.round(item.lengthKm * 10) / 10).toFixed(1)} km` : null, Number.isFinite(item.savedMs) ? fmtDate(item.savedMs) : null].filter(Boolean);
  return { title: item.name, sub: bits.join(' · '), recorded: !!item.recorded };
}

// ---------- the section ----------
let uid = 0;

export function createMissionFile(callbacks = {}) {
  const id = `lsn-mf-${++uid}`;
  let ready = false;
  const note = h('p', { class: 'mf-note', role: 'status', 'aria-live': 'polite' });
  const say = (t) => { note.textContent = t ?? ''; callbacks.onNote?.(t ?? ''); };
  const dl = (label, ext, make, mime) => h('button', { type: 'button', class: 'btn mf-btn', onclick: () => {
    const rec = callbacks.getRecord?.();
    if (!rec) return say('Select a route first.');
    downloadText(document, fileName(rec, ext), make(rec), mime);
  } }, label);
  const downloads = [dl('JSON', 'json', (r) => JSON.stringify(r, null, 1), 'application/json'), dl('GeoJSON', 'geojson', (r) => JSON.stringify(toGeoJSON(r)), 'application/geo+json'), dl('CSV', 'csv', routeCSV, 'text/csv')];
  const list = h('ul', { class: 'mf-list', 'aria-label': 'Saved missions' });
  const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true, id: `${id}-file` });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    let rec = null;
    try { rec = parseRecord(await f.text()); } catch { rec = null; }
    if (!rec) return say('That file is not a saved mission.');
    const r = saveRecord(rec);
    say(r.ok ? `Imported ${rec.name}.` : r.reason);
    refresh();
    callbacks.onLoad?.(rec);
  });
  const importBtn = h('button', { type: 'button', class: 'btn mf-btn', onclick: () => file.click() }, 'Import file…');
  const count = h('span', { class: 'num' });
  const summary = h('summary', null, 'Mission file ', count);
  const el = h('details', { class: 'fold-more rp-file', id }, summary,
    h('div', { class: 'mf-body' },
      h('div', { class: 'mf-actions' }, ...downloads),
      note,
      h('p', { class: 'rp-rover-sub' }, 'Saved missions'),
      list,
      h('div', { class: 'mf-actions' }, importBtn, file)));

  function doSave() {
    const rec = callbacks.getRecord?.();
    if (!rec) return say('Select a route first.');
    const r = saveRecord(rec);
    say(r.ok ? `Saved “${rec.name}”.${r.dropped ? ` ${r.dropped} older mission${r.dropped === 1 ? '' : 's'} dropped to make room.` : ''}` : r.reason);
    refresh();
  }

  function refresh() {
    const items = listRecords();
    count.textContent = items.length ? `(${items.length})` : '';
    clear(list);
    if (!items.length) { list.append(h('li', { class: 'mf-empty' }, 'None yet. Save one above, or import a file.')); return; }
    for (const it of items) {
      const t = listText(it);
      const download = (ext, make, mime) => { const rec = loadRecord(it.id); if (rec) downloadText(document, fileName(rec, ext), make(rec), mime); };
      list.append(h('li', { class: 'mf-item', 'data-id': it.id },
        h('span', { class: 'mf-name' }, t.title),
        h('span', { class: 'mf-sub' }, t.sub, t.recorded ? h('span', { class: 'mf-tag' }, 'motion recorded') : null),
        h('span', { class: 'mf-row' },
          h('button', { type: 'button', class: 'btn mf-btn', onclick: () => { const rec = loadRecord(it.id); if (rec) { say(`Loading “${rec.name}”…`); callbacks.onLoad?.(rec); } } }, 'Load'),
          h('button', { type: 'button', class: 'btn mf-btn', onclick: () => download('json', (r) => JSON.stringify(r, null, 1), 'application/json') }, 'Download'),
          t.recorded ? h('button', { type: 'button', class: 'btn mf-btn', onclick: () => download('motion.csv', (r) => recordingCSV(r.recording), 'text/csv') }, 'Motion CSV') : null,
          h('button', { type: 'button', class: 'btn mf-btn mf-del', onclick: () => { if (confirm(`Delete “${it.name}”? This cannot be undone.`)) { deleteRecord(it.id); say('Deleted.'); refresh(); } } }, 'Delete'))));
    }
  }

  function setReady(on) {
    ready = !!on;
    for (const b of downloads) b.disabled = !ready;
  }

  // a record saved from the 3D globe tab shows up here
  window.addEventListener('storage', (e) => { if (e.key === RECORDS_KEY || e.key === null) refresh(); });
  setReady(false);
  refresh();
  return { el, refresh, setReady, save: doSave, ready: () => ready };
}
