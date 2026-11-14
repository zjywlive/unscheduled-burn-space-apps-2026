// Number, duration, angle and time formatting (spec §9.3). Minus sign is U+2212.
const H = 3600e3;
const D = 24 * H;
const MINUS = '−';
// The one mark for a missing or not-applicable value (spec §7.3, app-screens §11).
export const DASH = '—';

const utcParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const hours1 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const hours0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

function parts(ms) {
  const out = {};
  for (const p of utcParts.formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

export function fmtHours(ms) {
  const h = ms / H;
  if (h === 0) return '0 h';
  if (Math.round(h * 10) / 10 >= 10) return `${hours0.format(h)} h`;
  return `${hours1.format(h)} h`;
}

export function fmtSpan(ms) {
  const minutes = Math.round(ms / 60e3);
  if (minutes < 60) return `${minutes} min`;
  const tens = Math.round(ms / 600e3) * 10;
  if (tens < 24 * 60) {
    const h = Math.floor(tens / 60), m = tens % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const totalH = Math.round(ms / H);
  const d = Math.floor(totalH / 24), h = totalH % 24;
  return h ? `${d} d ${h} h` : `${d} d`;
}

export function fmtPct(ratio) {
  return `${Math.round(ratio * 100)}%`;
}

export function fmtDeg(deg) {
  if (deg === null || deg === undefined || !Number.isFinite(deg)) return DASH;
  const tenths = Math.round(deg * 10);
  if (tenths === 0) return '0.0°';
  const s = (Math.abs(tenths) / 10).toFixed(1);
  return `${tenths < 0 ? MINUS : ''}${s}°`;
}

export function fmtUtc(ms) {
  const p = parts(ms);
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} UTC`;
}

export function fmtDay(ms) {
  const p = parts(ms);
  return `${p.day} ${p.month}`;
}

export function fmtDayOfStay(ms, landingMs) {
  const day = Math.floor(ms / D) - Math.floor(landingMs / D) + 1;
  const p = parts(ms);
  return `Day ${day}, ${p.hour}:${p.minute}`;
}
