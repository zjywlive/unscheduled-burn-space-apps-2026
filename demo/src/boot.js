// Loading screen over a page until its map is ready. The build scripts put bootMarkup() and BOOT_CSS into the
// page itself, so it shows while the page and its data load, before any script runs; the page's script then
// moves the bar with bootScreen().set() and lifts the screen with done(). "Show the map now" lifts it at once.
export const BOOT_ID = 'lsn-boot';

export const BOOT_CSS = `
#lsn-boot { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; background: radial-gradient(ellipse at 50% 40%, #15171b 0%, #050506 70%); color: #e8eaed; font: 13px/1.4 Inter, system-ui, sans-serif; transition: opacity .45s ease; }
#lsn-boot.is-done { opacity: 0; pointer-events: none; }
#lsn-boot .boot-card { display: grid; justify-items: center; gap: 14px; padding: 24px; text-align: center; }
#lsn-boot .boot-moon { width: 64px; height: 64px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, #d9d9d6 0%, #9a9a96 45%, #3a3a38 80%); box-shadow: 0 0 40px rgba(232,234,237,.12); animation: lsn-boot-spin 6s linear infinite; }
#lsn-boot h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: .01em; }
#lsn-boot .boot-sub { margin: -8px 0 0; color: #9aa0a6; font-size: 12px; }
#lsn-boot .boot-bar { position: relative; width: min(280px, 70vw); height: 4px; border-radius: 2px; background: rgba(255,255,255,.1); overflow: hidden; }
#lsn-boot .boot-bar i { position: absolute; inset: 0; transform-origin: left; transform: scaleX(.04); background: #e8eaed; border-radius: 2px; transition: transform .3s ease; }
#lsn-boot .boot-bar.is-wait i { width: 30%; transform: none; animation: lsn-boot-slide 1.4s ease-in-out infinite; }
#lsn-boot .boot-text { color: #9aa0a6; font-size: 12px; min-height: 17px; font-variant-numeric: tabular-nums; }
#lsn-boot button { font: inherit; font-size: 12px; color: #e8eaed; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.18); border-radius: 999px; padding: 5px 14px; cursor: pointer; }
#lsn-boot button:hover { background: rgba(255,255,255,.14); }
@keyframes lsn-boot-spin { from { background-position: 0 0; } to { background-position: 64px 0; } }
@keyframes lsn-boot-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(340%); } }
@media (prefers-reduced-motion: reduce) { #lsn-boot, #lsn-boot .boot-bar i { transition: none; animation: none; } }
`;

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// The screen's HTML, for a build script to put right after <body>. The bar waits (a sliding stripe) until the
// script reports progress.
export function bootMarkup(title, sub, text = 'Loading the terrain…') {
  return `<div id="${BOOT_ID}" role="status" aria-live="polite" aria-label="Loading">
<div class="boot-card"><div class="boot-moon" aria-hidden="true"></div><h1>${esc(title)}</h1><p class="boot-sub">${esc(sub)}</p>
<div class="boot-bar is-wait"><i></i></div><div class="boot-text">${esc(text)}</div>
<button type="button" onclick="this.closest('#${BOOT_ID}').classList.add('is-done')">Show the map now</button></div></div>`;
}

// Control of the screen in the page. All calls are safe when the screen is not there.
export function bootScreen(doc = typeof document !== 'undefined' ? document : null) {
  const el = doc?.getElementById(BOOT_ID) ?? null;
  const barBox = el?.querySelector('.boot-bar'), bar = el?.querySelector('.boot-bar i'), text = el?.querySelector('.boot-text');
  let finished = !el || el.classList.contains('is-done');
  const api = {
    set(frac, msg) {
      if (finished || !el) return;
      if (Number.isFinite(frac) && bar) { barBox.classList.remove('is-wait'); bar.style.transform = `scaleX(${Math.max(0.04, Math.min(1, frac)).toFixed(3)})`; }
      if (msg && text) text.textContent = msg;
    },
    done() {
      if (finished || !el) return;
      finished = true;
      if (bar) { barBox.classList.remove('is-wait'); bar.style.transform = 'scaleX(1)'; }
      el.classList.add('is-done');
      setTimeout(() => el.remove(), 500);
    },
    // false once lifted, by the page or by "Show the map now"
    get active() { return !finished && !!el && !el.classList.contains('is-done'); },
  };
  return api;
}
