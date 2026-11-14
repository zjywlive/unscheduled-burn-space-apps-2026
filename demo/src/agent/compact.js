// A JSON-compatible object, ready for JSON.stringify in a tool_result. No rounding or row truncation.
// maxChars measures JSON.stringify(output).length (UTF-16 code units), not bytes or model tokens.
// If the irreducible result exceeds the budget, keep the evidence and mark budgetExceeded: true.
export const DEFAULT_COMPACT_MAX_CHARS = 12000;
const CORE_NAMES = new Set(['list_sites', 'site_summary', 'compare_scenarios', 'rise_set_events', 'next_events', 'sky_at', 'skyline', 'best_landing_dates', 'point_facts', 'energy_summary', 'relay_coverage', 'route_candidates']);
const TABLE_NOTE = 'Dotted columns are original field paths; rows align with columns; {$absent:true} is absent, not null. All numerical fields and rows are retained.';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const size = (v) => JSON.stringify(v).length;

function hasError(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value).some((k) => /^(error|errors)$/i.test(k) || hasError(value[k]));
}

// Do not erase a new numerical field or a note if an upstream display schema later grows one.
function displayOnly(value) {
  if (typeof value === 'string' || value === null) return true;
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).every(([k, v]) => !/error|unit|note|clip|cut|limit|assum/i.test(k) && displayOnly(v));
}

function stripCopies(name, result, omitted) {
  const drop = (obj, key, path) => {
    if (obj && Object.hasOwn(obj, key) && displayOnly(obj[key])) { delete obj[key]; omitted.add(path); }
  };
  if (name === 'site_summary' || name === 'compare_scenarios') {
    const rows = name === 'compare_scenarios' ? result.scenarios : result.results ?? [result];
    if (Array.isArray(rows)) for (const row of rows) {
      if (hasError(row)) continue;
      drop(row, 'display', 'scenario.display');
      if (name === 'compare_scenarios') drop(row.vsBaseline, 'card', 'scenario.vsBaseline.card');
    }
  }
  if (name === 'best_landing_dates' && Array.isArray(result.candidates)) {
    for (const row of result.candidates) if (!hasError(row)) drop(row, 'display', 'candidates.display');
  }
}

// Flatten only plain, named fields. Arrays, null, empty objects and non-identifier keys stay values.
function flatten(row, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(row)) {
    if (!/^[A-Za-z_]\w*$/.test(key)) return null;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isObject(value) && Object.keys(value).length && Object.keys(value).every((k) => /^[A-Za-z_]\w*$/.test(k))) flatten(value, path, out);
    else out[path] = value;
  }
  return out;
}

function tabulate(value, stats) {
  if (!value || typeof value !== 'object') return value;
  if (isObject(value) && (Object.hasOwn(value, 'error') || Object.hasOwn(value, 'errors'))) return value;
  if (Array.isArray(value)) {
    const rows = value.map((v) => tabulate(v, stats));
    if (rows.length < 2 || !rows.every(isObject) || hasError(rows)) return rows;
    const flat = rows.map((r) => flatten(r));
    if (flat.some((r) => !r)) return rows;
    const columns = [...new Set(flat.flatMap((r) => Object.keys(r)))];
    const table = { $table: { columns, rows: flat.map((r) => columns.map((k) => Object.hasOwn(r, k) ? r[k] : { $absent: true })) } };
    if (size(table) >= size(rows)) return rows;
    stats.tables = true;
    return table;
  }
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    // Metadata and assumptions stay verbatim and directly readable, even on a small budget.
    out[key] = ['about', 'assumptions', 'orbit', '_compact'].includes(key) ? v : tabulate(v, stats);
  }
  return out;
}

export function compactResult(toolName, result, { maxChars = DEFAULT_COMPACT_MAX_CHARS } = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new RangeError('maxChars must be a positive safe integer.');
  // The tools return JSON. Normalize undefined exactly as the agent loop's JSON serialization does.
  const original = JSON.parse(JSON.stringify(result ?? null));
  let out = original;
  if (CORE_NAMES.has(toolName) && isObject(original) && !Object.hasOwn(original, 'error')) {
    const copy = JSON.parse(JSON.stringify(original)), omitted = new Set(), stats = { tables: false };
    stripCopies(toolName, copy, omitted);
    const packed = tabulate(copy, stats);
    if (stats.tables || omitted.size) {
      packed._compact = { format: 'tables-v1', ...(stats.tables ? { note: TABLE_NOTE } : {}), ...(omitted.size ? { omitted: [...omitted] } : {}) };
      if (size(packed) < size(original)) out = packed;
    }
  }
  if (size(out) > maxChars) {
    const budget = { budgetExceeded: true, maxChars, note: 'Evidence, units, clipping notes and errors cannot fit this budget; nothing was truncated. Request fewer scenarios or times.' };
    if (isObject(out)) out._compact = { ...out._compact, ...budget, ...(out._compact?.note ? { note: `${out._compact.note} ${budget.note}` } : {}) };
    else out = { result: out, _compact: budget };
  }
  return out;
}
