// Shared JPL Horizons API helpers (Node built-ins only).
const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const ROW = /^\s*(\d{4}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2})(.*)$/;
const FLOAT = /[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?/g;

export function parseUtc(utc) {
  const m = /^(\d{4})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(utc.trim());
  if (!m || !(m[2] in MONTHS)) throw new Error(`Unparseable Horizons time: ${utc}`);
  return Date.UTC(+m[1], MONTHS[m[2]], +m[3], +m[4], +m[5]);
}

export async function horizonsRequest(params) {
  const q = new URLSearchParams({ format: 'text' });
  for (const [k, v] of Object.entries(params)) q.set(k, `'${v}'`);
  const res = await fetch(`${API}?${q}`);
  const text = await res.text();
  const soe = text.indexOf('$$SOE');
  const eoe = text.indexOf('$$EOE');
  if (soe < 0 || eoe < 0) throw new Error(`Horizons response has no $$SOE block: ${text.slice(0, 300)}`);
  const header = text.slice(0, soe);
  const rows = [];
  for (const line of text.slice(soe + 5, eoe).split('\n')) {
    const m = ROW.exec(line);
    if (!m) continue;
    const values = (m[2].match(FLOAT) || []).map(Number);
    rows.push({ utc: m[1], values });
  }
  return { header, rows };
}
