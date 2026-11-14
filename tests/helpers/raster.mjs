// A small software 2D canvas for Node tests and the phase 4 check scripts: ImageData, OffscreenCanvas and
// a context with putImageData, drawImage (nearest neighbour, source-over), fillRect (rgba fill styles),
// clearRect and globalAlpha, plus PNG and PGM writers. Enough for layers.js and psr.js, nothing more.
import { deflateSync } from 'node:zlib';

export class SoftImageData {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); }
}

function blend(d, o, r, g, b, a) {
  if (a <= 0) return;
  const ia = 1 - a, da = d[o + 3] / 255;
  const oa = a + da * ia;
  d[o] = (r * a + d[o] * da * ia) / oa; d[o + 1] = (g * a + d[o + 1] * da * ia) / oa; d[o + 2] = (b * a + d[o + 2] * da * ia) / oa;
  d[o + 3] = oa * 255;
}

export class SoftCanvas {
  constructor(w, h) { this.width = w; this.height = h; this.img = new SoftImageData(w, h); this.ctx = null; }
  getContext() { return (this.ctx ??= softContext(this)); }
}

export function softContext(canvas) {
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s);
    if (!m) throw new Error(`fill style ${s}`);
    const p = m[1].split(',').map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  };
  return {
    canvas, globalAlpha: 1, fillStyle: 'rgba(0,0,0,1)', imageSmoothingEnabled: true, fills: 0,
    createImageData: (w, h) => new SoftImageData(w, h),
    getImageData() { return canvas.img; },
    putImageData(img, x = 0, y = 0) {
      const d = canvas.img.data;
      for (let r = 0; r < img.height; r++) for (let c = 0; c < img.width; c++) {
        const tx = c + x, ty = r + y;
        if (tx < 0 || ty < 0 || tx >= canvas.width || ty >= canvas.height) continue;
        d.set(img.data.subarray(4 * (r * img.width + c), 4 * (r * img.width + c) + 4), 4 * (ty * canvas.width + tx));
      }
    },
    clearRect() { canvas.img.data.fill(0); },
    drawImage(src, dx = 0, dy = 0, dw = src.width, dh = src.height) {
      const s = src.img.data, d = canvas.img.data;
      const x0 = Math.max(0, Math.round(dx)), y0 = Math.max(0, Math.round(dy));
      const x1 = Math.min(canvas.width, Math.round(dx + dw)), y1 = Math.min(canvas.height, Math.round(dy + dh));
      for (let y = y0; y < y1; y++) {
        const sy = Math.min(src.height - 1, Math.floor(((y + 0.5 - dy) / dh) * src.height));
        for (let x = x0; x < x1; x++) {
          const sx = Math.min(src.width - 1, Math.floor(((x + 0.5 - dx) / dw) * src.width));
          const so = 4 * (sy * src.width + sx);
          blend(d, 4 * (y * canvas.width + x), s[so], s[so + 1], s[so + 2], (s[so + 3] / 255) * this.globalAlpha);
        }
      }
    },
    fillRect(x, y, w, h) {
      this.fills++;
      const [r, g, b, a] = parse(this.fillStyle);
      const d = canvas.img.data;
      // pixels whose centre is inside the rectangle
      for (let py = Math.max(0, Math.ceil(y - 0.5)); py < Math.min(canvas.height, Math.ceil(y + h - 0.5)); py++) {
        for (let px = Math.max(0, Math.ceil(x - 0.5)); px < Math.min(canvas.width, Math.ceil(x + w - 0.5)); px++) {
          blend(d, 4 * (py * canvas.width + px), r, g, b, a * this.globalAlpha);
        }
      }
    },
  };
}

// Runs fn with ImageData and OffscreenCanvas replaced by the soft versions.
export function withSoftCanvas(fn) {
  const saved = [globalThis.ImageData, globalThis.OffscreenCanvas];
  globalThis.ImageData = SoftImageData; globalThis.OffscreenCanvas = SoftCanvas;
  try { return fn(); } finally { [globalThis.ImageData, globalThis.OffscreenCanvas] = saved; }
}

// A grey canvas from hillshade values.
export function greyCanvas(shade, width, height) {
  const c = new SoftCanvas(width, height);
  for (let i = 0; i < shade.length; i++) { const o = 4 * i; c.img.data[o] = c.img.data[o + 1] = c.img.data[o + 2] = shade[i]; c.img.data[o + 3] = 255; }
  return c;
}

const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// RGBA (or grey with channels = 1) → PNG bytes.
export function encodePng(pixels, width, height, channels = 4) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 1 ? 0 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rowLen = width * channels;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * rowLen, rowLen).copy(raw, y * (rowLen + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
