// Permanently shadowed regions (task book phase 4 §3 T.5, contract §4.2): the official PSR bitmap
// (Mazarico et al. 2011, 2016 update; 120 m) as a lookup and as a restrained map layer.
// The pack psr_120m is size × size bits, row by row, high bit first; row 0 at the top (+y), as the DEMs;
// pixel (row, col) covers x ∈ [−halfKm + col·k, −halfKm + (col+1)·k), y ∈ (halfKm − (row+1)·k, halfKm − row·k].
// A set bit is permanent shadow.

export const PSR_PACK = 'psr_120m';
export const PSR_DEFAULTS = Object.freeze({ size: 5400, kmPerPixel: 0.12, halfKm: 324 });

// bytes: the pack (Uint8Array); meta: terrain.json `psr` (size, kmPerPixel, halfKm), defaults per §4.2.
export function createPsr(bytes, meta = {}) {
  const size = meta.size ?? PSR_DEFAULTS.size, k = meta.kmPerPixel ?? PSR_DEFAULTS.kmPerPixel, halfKm = meta.halfKm ?? PSR_DEFAULTS.halfKm;
  const need = Math.ceil((size * size) / 8);
  if (!bytes || bytes.length < need) throw new Error(`psr: ${bytes?.length ?? 0} bytes, expected ${need}`);
  const bitAt = (row, col) => {
    const idx = row * size + col;
    return (bytes[idx >> 3] >> (7 - (idx & 7))) & 1;
  };
  // true inside a PSR pixel; false elsewhere, including off the bitmap
  function isPsr(xKm, yKm) {
    const col = Math.floor((xKm + halfKm) / k), row = Math.floor((halfKm - yKm) / k);
    if (!(col >= 0 && row >= 0 && col < size && row < size)) return false;
    return bitAt(row, col) === 1;
  }
  return { size, kmPerPixel: k, halfKm, bytes, isPsr, bitAt };
}

// The PSR mask under a canvas: Uint8Array(width × height), 0 = none, 1 = inside, 2 = outline.
// geom: { width, height, kmPerPx, cx, cy } (the hillshade rectangle form, canvas px).
// - Each pixel takes the strict majority of up to 4 × 4 samples spread over its footprint (one sample when a
//   pixel is smaller than a PSR pixel), so zooming out does not alias.
// - Restraint: a patch (8-connected) narrower than minPx in either direction, or smaller than minPx²
//   pixels, is left out, so the zoomed-out map shows no speckle.
// - Outline: kept pixels with a 4-neighbour outside the kept set (the canvas edge does not count).
export function psrMask(psr, { width, height, kmPerPx, cx = 0, cy = 0 }, { minPx = 2 } = {}) {
  const raw = new Uint8Array(width * height);
  const { size, kmPerPixel: k, halfKm, bitAt } = psr;
  const foot = kmPerPx / k;                                  // PSR pixels per canvas pixel
  const n = foot <= 1 ? 1 : Math.min(4, Math.ceil(foot));    // samples per axis
  const x0 = cx - (width * kmPerPx) / 2, y0 = cy + (height * kmPerPx) / 2;
  // sample columns once per canvas column (and rows once per row): PSR pixel indices, −1 off the bitmap
  const colIdx = new Int32Array(width * n), rowIdx = new Int32Array(height * n);
  for (let c = 0; c < width; c++) for (let s = 0; s < n; s++) {
    const v = Math.floor((x0 + (c + (s + 0.5) / n) * kmPerPx + halfKm) / k);
    colIdx[c * n + s] = v >= 0 && v < size ? v : -1;
  }
  for (let r = 0; r < height; r++) for (let s = 0; s < n; s++) {
    const v = Math.floor((halfKm - (y0 - (r + (s + 0.5) / n) * kmPerPx)) / k);
    rowIdx[r * n + s] = v >= 0 && v < size ? v : -1;
  }
  const half = (n * n) / 2;
  let any = false;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      let hits = 0;
      for (let sr = 0; sr < n; sr++) {
        const pr = rowIdx[r * n + sr];
        if (pr < 0) continue;
        for (let sc = 0; sc < n; sc++) { const pc = colIdx[c * n + sc]; if (pc >= 0) hits += bitAt(pr, pc); }
      }
      if (hits > half) { raw[r * width + c] = 1; any = true; }
    }
  }
  if (!any) return raw;
  // patches: breadth-first fill (the queue doubles as the member list), drop the small ones
  const keep = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  for (let start = 0; start < raw.length; start++) {
    if (raw[start] !== 1) continue;
    let head = 0, tail = 0;
    let minX = width, maxX = -1, minY = height, maxY = -1;
    queue[tail++] = start; raw[start] = 3;               // 3: visited
    while (head < tail) {
      const p = queue[head++];
      const x = p % width, y = (p - x) / width;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const q = yy * width + xx;
          if (raw[q] === 1) { raw[q] = 3; queue[tail++] = q; }
        }
      }
    }
    if (maxX - minX + 1 < minPx || maxY - minY + 1 < minPx || tail < minPx * minPx) continue;
    for (let m = 0; m < tail; m++) keep[queue[m]] = 1;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!keep[p]) continue;
      const out = (x > 0 && !keep[p - 1]) || (x < width - 1 && !keep[p + 1]) || (y > 0 && !keep[p - width]) || (y < height - 1 && !keep[p + width]);
      keep[p] = out ? 2 : 1;
    }
  }
  return keep;
}

// RGBA (Uint8ClampedArray, width × height × 4) for the layer: a fine outline and a faint diagonal hatch
// in one neutral colour (default: the Both ink of readColours, the existing neutral; no new hue). The
// hatch is fixed to the ground, so it moves with the map instead of shimmering over it.
export function psrRaster(psr, geom, { colour = [230, 230, 230], minPx = 2, hatchPx = 6, outlineAlpha = 0.6, hatchAlpha = 0.22 } = {}) {
  const { width, height, kmPerPx, cx = 0, cy = 0 } = geom;
  const mask = psrMask(psr, geom, { minPx });
  const out = new Uint8ClampedArray(width * height * 4);
  const phase = Math.round((cx - cy) / kmPerPx - (width + height) / 2);
  const step = Math.max(2, Math.round(hatchPx));
  const aOut = Math.round(outlineAlpha * 255), aHatch = Math.round(hatchAlpha * 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const m = mask[y * width + x];
      if (!m) continue;
      let a = 0;
      if (m === 2) a = aOut;
      else if ((((x + y + phase) % step) + step) % step === 0) a = aHatch;
      if (!a) continue;
      const o = 4 * (y * width + x);
      out[o] = colour[0]; out[o + 1] = colour[1]; out[o + 2] = colour[2]; out[o + 3] = a;
    }
  }
  return out;
}

// Draws the layer over what is on ctx (composited, not replaced). geom as psrMask.
export function paintPsr(ctx, psr, geom, opts) {
  const { width, height } = geom;
  const img = new ImageData(width, height);
  img.data.set(psrRaster(psr, geom, opts));
  const tmp = new OffscreenCanvas(width, height);
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0);
}
