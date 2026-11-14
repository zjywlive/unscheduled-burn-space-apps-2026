// On-screen camera controls for the 3D globe: pan (four arrows), zoom, turn, tilt, north up and a compass
// that shows the heading. A tap moves one step with a short glide; holding a button keeps moving at a steady
// rate. Keys: arrows pan, shift + arrows turn and tilt, + and − zoom, N north up. DOM only; the view does the
// rest (globe-view.js camera, jumpTo, flyTo, kmPerPx, maxTilt).
const RAD = Math.PI / 180, DEG = 180 / Math.PI, MOON_R_KM = 1737.4;

const ICON = {
  up: 'M12 6l6 8H6z', down: 'M12 18l-6-8h12z', left: 'M6 12l8-6v12z', right: 'M18 12l-8 6V6z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z', minus: 'M5 11h14v2H5z',
  ccw: 'M12 5a7 7 0 1 1-6.6 4.7l1.9.6A5 5 0 1 0 12 7v3L7.5 6 12 2z', cw: 'M12 5a7 7 0 1 0 6.6 4.7l-1.9.6A5 5 0 1 1 12 7v3l4.5-4L12 2z',
  tiltUp: 'M4 17h16l-3-7H7zM12 3l3 4H9z', tiltDown: 'M7 9h10l3 8H4zM12 21l-3-4h6z',
};
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

export const CONTROLS_CSS = `
.cam-ctl { position: fixed; right: 16px; bottom: 16px; padding: 8px; display: grid; grid-template-columns: auto auto; gap: 8px; align-items: start; z-index: 5; user-select: none; }
body:not(.route-mode) .cam-ctl { bottom: 92px; }
.cam-ctl .pad { display: grid; grid-template-columns: repeat(3, 30px); grid-template-rows: repeat(3, 30px); gap: 2px; }
.cam-ctl .side { display: grid; grid-template-columns: 30px 30px; grid-auto-rows: 30px; gap: 2px 4px; }
.cam-ctl button { width: 30px; height: 30px; padding: 0; display: grid; place-items: center; color: var(--text); background: rgba(255,255,255,0.07); border: 1px solid var(--line); border-radius: 8px; cursor: pointer; touch-action: none; }
.cam-ctl button:hover { background: rgba(255,255,255,0.16); }
.cam-ctl button:active { background: rgba(138,180,248,0.3); }
.cam-ctl button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.cam-ctl svg { width: 16px; height: 16px; fill: currentColor; }
.cam-ctl .compass { border-radius: 50%; position: relative; background: rgba(0,0,0,0.35); }
.cam-ctl .compass .needle { position: absolute; inset: 0; }
.cam-ctl .compass .needle::before { content: "N"; position: absolute; left: 50%; top: 1px; transform: translateX(-50%); color: #ff6b6b; font: 700 8px/1 Inter, system-ui, sans-serif; }
.cam-ctl .compass .needle::after { content: ""; position: absolute; left: 50%; top: 10px; width: 2px; height: 10px; margin-left: -1px; background: linear-gradient(#ff6b6b 50%, #e8eaed 50%); border-radius: 1px; }
.cam-ctl .read { grid-column: 1 / -1; color: var(--muted); font-size: 10.5px; font-variant-numeric: tabular-nums; text-align: center; line-height: 1.3; white-space: pre-line; }
`;

// → { el, stop() }. onUser() is called when the user moves the camera with these controls (to leave follow mode).
export function createCameraControls(view, { onUser = () => {}, parent = document.body } = {}) {
  const box = document.createElement('nav');
  box.className = 'glass cam-ctl';
  box.setAttribute('aria-label', 'Camera controls');
  const b = (id, label, icon) => `<button type="button" data-a="${id}" aria-label="${label}" title="${label}">${icon}</button>`;
  box.innerHTML = `
    <div class="pad">${'<span></span>'}${b('up', 'Pan forward (↑)', svg(ICON.up))}${'<span></span>'}${b('left', 'Pan left (←)', svg(ICON.left))}<button type="button" class="compass" data-a="north" aria-label="Turn to north up (N)" title="North up (N)"><span class="needle"></span></button>${b('right', 'Pan right (→)', svg(ICON.right))}${'<span></span>'}${b('down', 'Pan back (↓)', svg(ICON.down))}${'<span></span>'}</div>
    <div class="side">${b('in', 'Zoom in (+)', svg(ICON.plus))}${b('out', 'Zoom out (−)', svg(ICON.minus))}${b('ccw', 'Turn left (shift ←)', svg(ICON.ccw))}${b('cw', 'Turn right (shift →)', svg(ICON.cw))}${b('tiltUp', 'Tilt towards the horizon (shift ↑)', svg(ICON.tiltUp))}${b('tiltDown', 'Tilt towards straight down (shift ↓)', svg(ICON.tiltDown))}</div>
    <div class="read" aria-live="off"></div>`;
  parent.appendChild(box);
  const needle = box.querySelector('.needle'), read = box.querySelector('.read');

  // one step of each action (camera → new camera), and the rate per second while held
  const viewKm = () => view.kmPerPx() * (view.canvas?.clientHeight ?? 800);
  function moved(c, fwdKm, rightKm) {
    const h = c.heading * RAD, north = fwdKm * Math.cos(h) - rightKm * Math.sin(h), east = fwdKm * Math.sin(h) + rightKm * Math.cos(h);
    const lat = Math.max(-89.999, Math.min(89.999, c.lat + (north / MOON_R_KM) * DEG));
    return { lat, lon: (c.lon + ((east / MOON_R_KM) * DEG) / Math.max(0.02, Math.cos(lat * RAD)) + 360) % 360 };
  }
  const tiltCap = (c) => (view.maxTilt ? view.maxTilt() : 75);
  const act = {
    up: (c, k) => ({ ...c, ...moved(c, viewKm() * 0.25 * k, 0) }),
    down: (c, k) => ({ ...c, ...moved(c, -viewKm() * 0.25 * k, 0) }),
    left: (c, k) => ({ ...c, ...moved(c, 0, -viewKm() * 0.25 * k) }),
    right: (c, k) => ({ ...c, ...moved(c, 0, viewKm() * 0.25 * k) }),
    in: (c, k) => ({ ...c, dist: Math.max(0.02, c.dist * Math.pow(0.6, k)) }),
    out: (c, k) => ({ ...c, dist: Math.min(14000, c.dist / Math.pow(0.6, k)), tilt: Math.min(c.tilt, 75) }),
    ccw: (c, k) => ({ ...c, heading: (c.heading - 30 * k + 360) % 360 }),
    cw: (c, k) => ({ ...c, heading: (c.heading + 30 * k) % 360 }),
    tiltUp: (c, k) => ({ ...c, tilt: Math.min(tiltCap(c), c.tilt + 12 * k) }),
    tiltDown: (c, k) => ({ ...c, tilt: Math.max(0, c.tilt - 12 * k) }),
  };
  const once = {
    north: (c) => ({ ...c, heading: 0 }),
  };
  const glide = (to) => view.flyTo({ ...to, ms: 320 });

  // hold: after the first glide, keep moving at about two steps per second until released
  let hold = null;
  function startHold(a) {
    stopHold();
    const t0 = performance.now();
    let last = t0;
    const tick = () => {
      if (!hold) return;
      const now = performance.now();
      if (now - t0 > 330) view.jumpTo(act[a](view.camera, ((now - last) / 1000) * 2));
      last = now;
      hold.raf = requestAnimationFrame(tick);
    };
    hold = { a, raf: requestAnimationFrame(tick) };
  }
  function stopHold() { if (hold) cancelAnimationFrame(hold.raf); hold = null; }

  box.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('button[data-a]');
    if (!btn) return;
    e.preventDefault();
    const a = btn.dataset.a;
    onUser(a);
    if (once[a]) { glide(once[a](view.camera)); return; }
    glide(act[a](view.camera, 1));
    btn.setPointerCapture?.(e.pointerId);
    startHold(a);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) box.addEventListener(ev, stopHold);
  // keyboard activation of a focused button (Enter / Space) gives one step
  box.addEventListener('click', (e) => {
    if (e.detail !== 0) return;   // real clicks were handled on pointerdown
    const a = e.target.closest('button[data-a]')?.dataset.a;
    if (!a) return;
    onUser(a);
    glide(once[a] ? once[a](view.camera) : act[a](view.camera, 1));
  });

  const keyAct = (e) => {
    if (e.target.closest?.('input, select, textarea, [contenteditable]')) return null;
    const k = e.key;
    if (k === '+' || k === '=') return 'in';
    if (k === '-' || k === '_') return 'out';
    if (k === 'n' || k === 'N') return 'north';
    if (k === 'ArrowUp') return e.shiftKey ? 'tiltUp' : 'up';
    if (k === 'ArrowDown') return e.shiftKey ? 'tiltDown' : 'down';
    if (k === 'ArrowLeft') return e.shiftKey ? 'ccw' : 'left';
    if (k === 'ArrowRight') return e.shiftKey ? 'cw' : 'right';
    return null;
  };
  const onKey = (e) => {
    const a = keyAct(e);
    if (!a || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    onUser(a);
    glide(once[a] ? once[a](view.camera) : act[a](view.camera, e.repeat ? 0.5 : 1));
  };
  window.addEventListener('keydown', onKey);

  // the compass and the readout follow the camera
  let lastKey = '';
  view.onFrame(() => {
    const c = view.camera, key = `${Math.round(c.heading)}:${Math.round(c.tilt)}:${c.dist.toPrecision(3)}`;
    if (key === lastKey) return;
    lastKey = key;
    needle.style.transform = `rotate(${-c.heading}deg)`;
    const d = c.dist >= 10 ? `${Math.round(c.dist)} km` : c.dist >= 1 ? `${c.dist.toFixed(1)} km` : `${Math.round(c.dist * 1000)} m`;
    read.textContent = `${d}\nhdg ${Math.round(c.heading)}° · tilt ${Math.round(c.tilt)}°`;
  });

  return { el: box, stop() { stopHold(); window.removeEventListener('keydown', onKey); box.remove(); } };
}
