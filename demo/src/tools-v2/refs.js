// The v2 reference store (docs/mcp-v2/DESIGN.md §4): results that later calls can point at instead of
// repeating coordinates. One store per createCoreTools instance, in memory, at most LIMIT entries per kind
// (oldest dropped first). Nothing is written to disk.
//
//   refs.put(kind, value, { prefix }) → id          kind: 'search' | 'mission' | 'route'
//   refs.get(kind, id) → value | null               id omitted → the latest of that kind
//   refs.list(kind) → ids held, oldest first
//   refs.place(input) → { site } | { error } | null  a PLACE that names a reference (null when it does not)
//
// PLACE forms resolved here (tools-core.js resolvePlace hands them over):
//   { candidate: "S2" }               candidate S2 of the latest find_landing_sites (or of search_id)
//   { candidate: "S2", search_id }    of that search
//   { mission_point: "W2" }           point W2 of the latest mission_open (or of mission_id)
//   { mission_point: "W2", mission_id }
// A search value must carry candidates: [{ ref, latDeg, lonDeg, ... }]; a mission value must carry
// points: [{ name, latDeg, lonDeg, ... }] (mission-io.js). Names match case-insensitively.

export const REF_LIMIT = 32;
export const REF_FIELDS = ['candidate', 'search_id', 'mission_point', 'mission_id'];

export function createRefs({ limit = REF_LIMIT } = {}) {
  const kinds = new Map();
  let seq = 0;
  const table = (kind) => {
    if (!kinds.has(kind)) kinds.set(kind, new Map());
    return kinds.get(kind);
  };
  const latest = new Map();

  function put(kind, value, { prefix = kind[0] } = {}) {
    const t = table(kind);
    seq += 1;
    // deterministic (s_1, s_2, …): the same calls give the same ids, so results compare equal across runs
    const id = `${prefix}_${seq}`;
    t.set(id, value);
    while (t.size > limit) t.delete(t.keys().next().value);
    latest.set(kind, id);
    return id;
  }

  function get(kind, id) {
    const t = table(kind);
    const key = id ?? latest.get(kind);
    return key !== undefined && t.has(key) ? t.get(key) : null;
  }

  const latestId = (kind) => (latest.has(kind) && table(kind).has(latest.get(kind)) ? latest.get(kind) : null);
  const list = (kind) => [...table(kind).keys()];

  function place(input) {
    if (!input || typeof input !== 'object') return null;
    const has = (k) => input[k] !== undefined;
    if (!REF_FIELDS.some(has)) return null;
    if (has('site_id') || has('lat_deg') || has('lon_deg')) return { error: 'Give a reference (candidate or mission_point) or a site_id / lat_deg+lon_deg, not both.' };
    if (has('candidate') && has('mission_point')) return { error: 'Give candidate or mission_point, not both.' };
    if (has('candidate')) {
      const search = get('search', input.search_id);
      if (!search) return { error: input.search_id ? `Search ${input.search_id} is no longer held (the server keeps the last ${limit}). Run find_landing_sites again.` : 'No find_landing_sites result is held yet. Run find_landing_sites first, then refer to its candidates as S1, S2, …' };
      const want = String(input.candidate).trim().toLowerCase();
      const c = (search.candidates ?? []).find((x) => String(x.ref).toLowerCase() === want);
      if (!c) return { error: `No candidate ${input.candidate} in search ${input.search_id ?? latestId('search')}. It has ${(search.candidates ?? []).map((x) => x.ref).join(', ') || 'no candidates'}.` };
      return { site: { id: c.ref, name: `Candidate ${c.ref}`, latDeg: c.latDeg, lonDeg: c.lonDeg, verified: true } };
    }
    if (has('mission_point')) {
      const m = get('mission', input.mission_id);
      if (!m) return { error: input.mission_id ? `Mission ${input.mission_id} is no longer held. Run mission_open again.` : 'No mission is open. Run mission_open first, then refer to its points as landing, W1, W2, …' };
      const want = String(input.mission_point).trim().toLowerCase();
      // canonical names (landing, W2, …) first, then names the user gave (aliases), which must be unique
      let p = (m.points ?? []).find((x) => String(x.name).toLowerCase() === want);
      if (!p) {
        const hits = (m.points ?? []).filter((x) => (x.aliases ?? []).some((a) => String(a).toLowerCase() === want));
        if (hits.length > 1) return { error: `Point name ${input.mission_point} is ambiguous; use ${hits.map((x) => x.name).join(' or ')}.` };
        p = hits[0];
      }
      if (!p) return { error: `No point ${input.mission_point} in mission ${input.mission_id ?? latestId('mission')}. It has ${(m.points ?? []).map((x) => x.name).join(', ') || 'no points'}.` };
      return { site: { id: p.name, name: `${m.name ? `${m.name} · ` : ''}${p.name}`, latDeg: p.latDeg, lonDeg: p.lonDeg, verified: true } };
    }
    return { error: 'search_id goes with candidate, and mission_id with mission_point.' };
  }

  return { put, get, latestId, list, place, limit };
}
