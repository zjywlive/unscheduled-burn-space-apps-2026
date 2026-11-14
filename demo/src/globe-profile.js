// The route's elevation profile along the bottom of the 3D globe in route mode: height against distance,
// the line coloured by slope, the area under it shaded, strips for sunlight, Earth in view and one-way
// stretches, the waypoints and parking stops, and a cursor at the rover. Click or drag to move the rover
// there; hover to read height and grade. Canvas only; heights come from the payload (pts[i][7]) or from
// heightAt(lat, lon) for older payloads.
import { FLAGS } from './route3d.js';

const kmText = (km) => (km >= 1 ? `${km.toFixed(2)} km` : `${Math.round(km * 1000)} m`);

export function createRouteProfile(parent, payload, { heightAt, slopeColour, onSeek = () => {} } = {}) {
  const pts = payload.pts, n = pts.length;
  const km = pts.map((q) => q[2]);
  const h = pts.map((q) => (Number.isFinite(q[7]) ? q[7] : heightAt(q[0], q[1])));
  // grade per point: from the payload, else from the heights
  const grade = pts.map((q, i) => {
    if (Number.isFinite(q[6])) return q[6];
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1), d = (km[b] - km[a]) * 1000;
    return d > 0 && Number.isFinite(h[a] + h[b]) ? (Math.atan((h[b] - h[a]) / d) * 180) / Math.PI : null;
  });
  const finite = h.filter(Number.isFinite);
  const lo = Math.min(...finite), hi = Math.max(...finite), pad = Math.max(5, (hi - lo) * 0.12);
  const y0 = lo - pad, y1 = hi + pad, total = km[n - 1] || 1;
  const timed = pts.some((q) => Number.isFinite(q[3]));
  // where the waypoints fall along the route: the nearest point to each
  const wpKm = (payload.wps ?? []).map((w) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = (pts[i][0] - w.latDeg) ** 2 + ((pts[i][1] - w.lonDeg) * Math.cos((w.latDeg * Math.PI) / 180)) ** 2; if (d < bd) { bd = d; best = i; } }
    return km[best];
  });

  const wrap = document.createElement('div');
  wrap.className = 'rp-wrap';
  const cv = document.createElement('canvas');
  cv.className = 'rp-canvas';
  cv.setAttribute('role', 'slider');
  cv.setAttribute('aria-label', 'Elevation profile: click or drag to move the rover along the route');
  cv.tabIndex = 0;
  const tip = document.createElement('div');
  tip.className = 'rp-tip';
  wrap.append(cv, tip);
  parent.append(wrap);
  const ctx = cv.getContext('2d');
  let cur = 0, hover = null, W = 0, H = 0, dpr = 1;
  const M = { l: 44, r: 10, t: 8, b: 34 };   // margins (css px): the strips and the distance labels sit in the bottom margin

  const xOf = (k) => M.l + (k / total) * (W - M.l - M.r);
  const kOf = (x) => Math.max(0, Math.min(total, ((x - M.l) / (W - M.l - M.r)) * total));
  const yOf = (v) => M.t + (1 - (v - y0) / (y1 - y0)) * (H - M.t - M.b);
  const at = (k) => {
    let i = 0; while (i + 1 < n && km[i + 1] < k) i++;
    const j = Math.min(n - 1, i + 1), f = km[j] > km[i] ? (k - km[i]) / (km[j] - km[i]) : 0;
    return { i, h: h[i] + ((h[j] ?? h[i]) - h[i]) * f, g: grade[f < 0.5 ? i : j] };
  };

  function draw() {
    const r = cv.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    if (Math.round(r.width * dpr) !== cv.width || Math.round(r.height * dpr) !== cv.height) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    W = r.width; H = r.height;
    if (!(W > 60 && H > 40)) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // height grid: three labelled levels
    ctx.font = '10px Inter, system-ui, sans-serif'; ctx.fillStyle = '#9aa0a6'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
    for (const v of [lo, (lo + hi) / 2, hi]) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(W - M.r, y); ctx.stroke();
      ctx.fillText(`${Math.round(v)} m`, M.l - 5, y);
    }
    // area under the line
    const base = H - M.b;
    const grad = ctx.createLinearGradient(0, M.t, 0, base);
    grad.addColorStop(0, 'rgba(138,180,248,0.28)'); grad.addColorStop(1, 'rgba(138,180,248,0.02)');
    ctx.beginPath(); ctx.moveTo(xOf(0), base);
    for (let i = 0; i < n; i++) if (Number.isFinite(h[i])) ctx.lineTo(xOf(km[i]), yOf(h[i]));
    ctx.lineTo(xOf(total), base); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    // the line, coloured by slope; the part ahead of the rover a little faded
    ctx.lineWidth = 2.4; ctx.lineCap = 'round';
    for (let i = 1; i < n; i++) {
      if (!Number.isFinite(h[i - 1] + h[i])) continue;
      ctx.globalAlpha = km[i] > cur + 1e-6 ? 0.6 : 1;
      ctx.strokeStyle = slopeColour(grade[i]);
      ctx.beginPath(); ctx.moveTo(xOf(km[i - 1]), yOf(h[i - 1])); ctx.lineTo(xOf(km[i]), yOf(h[i])); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // strips: sunlit / shadow, Earth in view, one-way
    const strip = (row, test, on, off) => {
      const y = base + 3 + row * 5;
      for (let i = 1; i < n; i++) {
        const c = test(pts[i]) ? on : off;
        if (!c) continue;
        ctx.fillStyle = c; ctx.fillRect(xOf(km[i - 1]), y, Math.max(1, xOf(km[i]) - xOf(km[i - 1])), 4);
      }
    };
    if (timed) {
      strip(0, (q) => q[5] & FLAGS.lit, '#f5f5f5', '#5c73a8');
      strip(1, (q) => q[5] & FLAGS.earth, '#8ab4f8', 'rgba(255,255,255,0.08)');
    }
    strip(2, (q) => q[5] & FLAGS.oneWay, '#ff9f43', null);
    // parking stops and waypoints
    for (const st of payload.stops ?? []) {
      const x = xOf(st.km);
      ctx.fillStyle = '#8ab4f8'; ctx.beginPath(); ctx.arc(x, M.t + 6, 3.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.textAlign = 'center'; ctx.font = '700 9.5px Inter, system-ui, sans-serif';
    wpKm.forEach((k, i) => {
      const x = xOf(k), v = at(k).h, y = Number.isFinite(v) ? yOf(v) : M.t + 10;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, base); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y - 9, 6.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#111'; ctx.fillText(String(i + 1), x, y - 8.5);
    });
    // distance ticks
    const a = at(cur), x = xOf(cur);
    ctx.fillStyle = '#9aa0a6'; ctx.font = '10px Inter, system-ui, sans-serif'; ctx.textBaseline = 'top';
    if (x > M.l + 190) { ctx.textAlign = 'left'; ctx.fillText('0 km', M.l, base + 20); }
    if (x < W - 200) { ctx.textAlign = 'right'; ctx.fillText(kmText(total), W - M.r, base + 20); }
    // the rover
    ctx.strokeStyle = '#ffd23d'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x + 0.5, M.t); ctx.lineTo(x + 0.5, base); ctx.stroke();
    if (Number.isFinite(a.h)) { ctx.fillStyle = '#ffd23d'; ctx.strokeStyle = '#111'; ctx.beginPath(); ctx.arc(x, yOf(a.h), 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    ctx.textAlign = x > W - 150 ? 'right' : 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = '#ffd23d'; ctx.font = '600 10.5px Inter, system-ui, sans-serif';
    ctx.fillText(`${kmText(cur)} · ${Number.isFinite(a.h) ? `${Math.round(a.h)} m` : '—'} · ${Number.isFinite(a.g) ? `${a.g >= 0 ? '+' : '−'}${Math.abs(a.g).toFixed(1)}°` : '—'}`, x + (ctx.textAlign === 'left' ? 6 : -6), base + 20);
    // hover read-out
    if (hover !== null) {
      const b = at(hover), hx = xOf(hover);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx + 0.5, M.t); ctx.lineTo(hx + 0.5, base); ctx.stroke();
      tip.hidden = false;
      tip.textContent = `${kmText(hover)} · ${Number.isFinite(b.h) ? `${Math.round(b.h)} m` : '—'} · grade ${Number.isFinite(b.g) ? `${b.g >= 0 ? '+' : '−'}${Math.abs(b.g).toFixed(1)}°` : '—'}`;
      tip.style.left = `${Math.min(W - 160, Math.max(0, hx - 70))}px`;
    } else tip.hidden = true;
  }

  // seeking: click, drag, arrow keys
  let dragging = false;
  const kmFrom = (e) => kOf(e.clientX - cv.getBoundingClientRect().left);
  cv.addEventListener('pointerdown', (e) => { dragging = true; cv.setPointerCapture(e.pointerId); onSeek(kmFrom(e)); });
  cv.addEventListener('pointermove', (e) => { hover = kmFrom(e); if (dragging) onSeek(hover); else draw(); });
  cv.addEventListener('pointerup', () => { dragging = false; });
  cv.addEventListener('pointerleave', () => { hover = null; draw(); });
  cv.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? total / 10 : total / 100;
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); onSeek(Math.min(total, cur + step)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); onSeek(Math.max(0, cur - step)); }
  });
  window.addEventListener('resize', draw);

  return {
    update(kmNow) { if (Math.abs(kmNow - cur) < 1e-9 && W) return; cur = kmNow; draw(); },
    draw,
    heights: h, grades: grade,
  };
}
