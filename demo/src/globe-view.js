// 3D globe of the global terrain model (phase 1). three.js comes from vendor/three.classic.js (window.THREE).
//
// Terrain is a quadtree of meshes, refined by screen-space error and loaded on demand:
//   - between 80°S and 80°N, cylindrical nodes (36 roots of 40° × 40°);
//   - at each pole, polar-stereographic nodes (one root of ±320 km), so the south-pole terrain is a
//     square grid and not slivers of longitude. Caps draw over the band where the two overlap.
// Every vertex height comes from globe-terrain.js heightAt(), so all levels share one surface. Each node
// has a skirt (its edge pulled down) that hides cracks between neighbours of different detail.
// Units are km; the Moon's centre is the origin, +Y the north pole, +X 0°E, −Z 90°E.
import { MOON_R_KM, G1, G2 } from './globe-terrain.js';
import { fromXY } from './terrain.js';

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const lin = (c) => Math.pow(c / 255, 2.2);
const TINT_LINEAR = [[0, [46, 58, 82]], [0.3, [86, 98, 112]], [0.6, [150, 146, 136]], [1, [222, 205, 165]]].map(([t, c]) => [t, c.map(lin)]);   // terrain-style.js TINT
export const SEG = 32;                 // grid cells per node side
export const CAP_HALF_KM = 320;        // polar root: ±320 km (≈ 79.4° latitude at the corners' axes)
export const BAND_LAT = 80;            // cylindrical band edge
const CAP_KEEP_KM = 2 * MOON_R_KM * Math.tan(((90 - BAND_LAT) / 2) * RAD) + 6;   // cap triangles kept inside this radius
const PX_ERROR = 2.2;                  // refine while a cell spans more than this many pixels
const MAX_DEPTH_CYL = 7, MAX_DEPTH_CAP = 10;
const BUILD_MS = 14;                  // mesh building budget per frame
const CACHE_MAX = 2600;
export const MIN_DIST_KM = 0.02;     // the camera may come to 20 m of its target (a rover at real size fills the view)

export function unit(latDeg, lonDeg) {
  const cl = Math.cos(latDeg * RAD);
  return [cl * Math.cos(lonDeg * RAD), Math.sin(latDeg * RAD), -cl * Math.sin(lonDeg * RAD)];
}
export function toLatLon(x, y, z) {
  const r = Math.hypot(x, y, z);
  let lon = Math.atan2(-z, x) * DEG;
  if (lon < 0) lon += 360;
  return { latDeg: Math.asin(y / r) * DEG, lonDeg: lon };
}
export function fromXYNorth(xKm, yKm) {
  const r = Math.hypot(xKm, yKm);
  let lon = Math.atan2(xKm, -yKm) * DEG;
  if (lon < 0) lon += 360;
  return { latDeg: 90 - 2 * Math.atan(r / (2 * MOON_R_KM)) * DEG, lonDeg: lon };
}

// #lat=…&lon=…&dist=…&tilt=…&heading=… (km and degrees): a shareable camera
export function cameraFromHash(hash) {
  const q = new URLSearchParams(String(hash).replace(/^#/, ''));
  const out = {};
  for (const k of ['lat', 'lon', 'dist', 'tilt', 'heading']) { const v = Number(q.get(k)); if (q.has(k) && Number.isFinite(v)) out[k] = v; }
  return out;
}
export function cameraToHash(c) {
  return `#lat=${c.lat.toFixed(4)}&lon=${c.lon.toFixed(4)}&dist=${c.dist.toPrecision(4)}&tilt=${Math.round(c.tilt)}&heading=${Math.round(c.heading)}`;
}

// ---------- quadtree nodes ----------
function roots() {
  const out = [];
  for (const lat0 of [-80, -40, 0, 40]) for (let lon0 = 0; lon0 < 360; lon0 += 40) out.push({ kind: 'cyl', depth: 0, lat0, lat1: lat0 + 40, lon0, lon1: lon0 + 40 });
  for (const pole of ['S', 'N']) out.push({ kind: 'cap', pole, depth: 0, x0: -CAP_HALF_KM, x1: CAP_HALF_KM, y0: -CAP_HALF_KM, y1: CAP_HALF_KM });
  for (const n of out) n.id = nodeId(n);
  return out;
}
function nodeId(n) { return n.kind === 'cyl' ? `c${n.depth}:${n.lat0.toFixed(4)}:${n.lon0.toFixed(4)}` : `${n.pole}${n.depth}:${n.x0.toFixed(4)}:${n.y0.toFixed(4)}`; }
function children(n) {
  if (n._kids) return n._kids;
  const d = n.depth + 1, k = [];
  if (n.kind === 'cyl') {
    const lm = (n.lat0 + n.lat1) / 2, om = (n.lon0 + n.lon1) / 2;
    for (const [a, b] of [[n.lat0, lm], [lm, n.lat1]]) for (const [c, e] of [[n.lon0, om], [om, n.lon1]]) k.push({ kind: 'cyl', depth: d, lat0: a, lat1: b, lon0: c, lon1: e });
  } else {
    const xm = (n.x0 + n.x1) / 2, ym = (n.y0 + n.y1) / 2;
    for (const [a, b] of [[n.y0, ym], [ym, n.y1]]) for (const [c, e] of [[n.x0, xm], [xm, n.x1]]) k.push({ kind: 'cap', pole: n.pole, depth: d, x0: c, x1: e, y0: a, y1: b });
  }
  for (const c of k) { c.id = nodeId(c); c.parent = n; }   // relief: see reliefKm()
  n._kids = k;
  return k;
}
// lat/lon of grid point (i, j) of a node, i along x / longitude, j along y / latitude (j = 0 at the south edge)
function nodeLatLon(n, u, v) {
  if (n.kind === 'cyl') return { latDeg: n.lat0 + (n.lat1 - n.lat0) * v, lonDeg: n.lon0 + (n.lon1 - n.lon0) * u };
  const x = n.x0 + (n.x1 - n.x0) * u, y = n.y0 + (n.y1 - n.y0) * v;
  return n.pole === 'S' ? fromXY(x, y) : fromXYNorth(x, y);
}
function nodeSizeKm(n) {
  if (n.kind === 'cap') return n.x1 - n.x0;
  const mid = Math.cos(((n.lat0 + n.lat1) / 2) * RAD);
  return Math.max((n.lat1 - n.lat0), (n.lon1 - n.lon0) * mid) * MOON_R_KM * RAD;
}
function capRadius(n, u, v) { return Math.hypot(n.x0 + (n.x1 - n.x0) * u, n.y0 + (n.y1 - n.y0) * v); }
function nodeOutsideCap(n) {   // the whole node beyond the cap's kept radius
  if (n.kind !== 'cap') return false;
  const nx = Math.max(n.x0, Math.min(0, n.x1)), ny = Math.max(n.y0, Math.min(0, n.y1));
  return Math.hypot(nx, ny) > CAP_KEEP_KM;
}

// Largest |height| (m) known for a node: measured when its mesh (or an ancestor's) was built; until then
// the Moon's extreme relief. Bounds use it times the exaggeration, so small tiles get tight spheres.
function reliefM(n) {
  for (let p = n; p; p = p.parent) if (p._reliefM !== undefined) return p._reliefM + 150;
  return 11000;
}

// ---------- the view ----------
// Options for the Map (index.html), which drapes its own layers on the globe:
//   canDrag(event) → false leaves a left-button drag to the page (a drawing tool), not the camera
//   overlays: true adds two draped pictures to the terrain shader, set with setOverlay():
//     polar   a canvas in south polar stereographic km (terrain.js toXY) over the box { x0, x1, y0, y1 }: the Map's
//             own picture of the polar cap (heat modes, terrain style, contours, shapes, routes, labels)
//     global  an equirectangular canvas (0°E at the left, 90°N at the top): the whole-Moon heat layer
export function createGlobeView(canvas, terrain, { requestSouth = () => {}, onStatus = () => {}, initial = {}, onCamera = () => {}, capDepth = () => MAX_DEPTH_CAP, canDrag = () => true, overlays = false, shadeGrey = 0.36 } = {}) {
  const THREE = window.THREE;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // cast shadows, used with the real Sun (setSun): a shadow map fitted each frame to the ground around the view
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 20000);
  const sun = new THREE.DirectionalLight(0xffffff, 3.2);
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  const ambient = new THREE.AmbientLight(0xffffff, 0.18);
  scene.add(sun, sun.target, ambient);
  scene.add(makeStars(THREE));
  const group = new THREE.Group();
  scene.add(group);
  const matCyl = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const matCap = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  // contour lines drawn in the fragment shader from the height of each pixel (radius minus the Moon's, without
  // the exaggeration), every uInterval metres, each fifth one stronger; the interval follows the zoom
  const contourU = { uContours: { value: 0 }, uInterval: { value: 50 }, uExag: { value: 3 }, uMoonR: { value: MOON_R_KM } };
  const blank = () => { const t = new THREE.DataTexture(new Uint8Array(4), 1, 1); t.needsUpdate = true; return t; };
  const overlayU = {
    uPolarTex: { value: blank() }, uPolarBox: { value: new THREE.Vector4(-1, 1, -1, 1) }, uPolarOn: { value: 0 }, uPolarMix: { value: 1 },
    uGlobalTex: { value: blank() }, uGlobalOn: { value: 0 }, uGlobalAlpha: { value: 1 }, uGlobalEdge: { value: -80 * RAD },
    // Live (Sun and Earth now) worked out per pixel with a smooth horizon: no cells, so the terminators are smooth
    uLiveOn: { value: 0 }, uNightOn: { value: 0 }, uLiveSun: { value: new THREE.Vector3(1, 0, 0) }, uLiveEarth: { value: new THREE.Vector3(1, 0, 0) },
    uColSun: { value: new THREE.Vector3(1, 0.7, 0.2) }, uColEarth: { value: new THREE.Vector3(0.3, 0.7, 0.95) }, uColBoth: { value: new THREE.Vector3(1, 1, 1) },
  };
  contourU.uContourInk = { value: new THREE.Vector3(1.0, 0.86, 0.45) };
  for (const m of [matCyl, matCap]) {
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, contourU, overlays ? overlayU : {});
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLsnWorld;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLsnWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      // the draped pictures: the lit terrain is kept as relief (its brightness) under the picture's colours
      const drape = overlays ? `
        float lsnInPolar = 0.0;
        {
          vec3 nU = normalize(vLsnWorld);
          float lat = asin(clamp(nU.y, -1.0, 1.0)), lon = atan(-nU.z, nU.x);
          float lum = clamp(dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114)) / 0.42, 0.25, 1.6);
          // the whole-Moon layers stop at the polar data's edge, where the polar picture takes over
          if (lat > uGlobalEdge) {
            // the smooth-horizon layers fade out towards the polar data (between 74°S and 80°S): near the pole the
            // terrain decides what is lit, and a smooth horizon there draws straight, false terminators
            float fadeS = smoothstep(-1.3963, -1.2915, lat);   // 80°S → 74°S
            // the polar map's "no Sun now" veil, carried on outside it (smooth horizon)
            if (uNightOn > 0.5 && dot(vec3(nU.x, -nU.z, nU.y), uLiveSun) <= 0.0) gl_FragColor.rgb *= mix(1.0, 0.5, fadeS);
            if (uLiveOn > 0.5) {
              vec3 nM = vec3(nU.x, -nU.z, nU.y);   // Moon-fixed (x 0°E, y 90°E, z north), as the ephemeris
              bool sUp = dot(nM, uLiveSun) > 0.0, eUp = dot(nM, uLiveEarth) > 0.0;
              vec3 lc = sUp && eUp ? uColBoth : sUp ? uColSun : uColEarth;
              float la = (sUp || eUp) ? 0.7 * uGlobalAlpha * fadeS : 0.0;
              gl_FragColor.rgb = mix(gl_FragColor.rgb, lc * (0.55 + 0.45 * lum), la);
            } else if (uGlobalOn > 0.5) {
              float u = fract(lon / 6.2831853 + 1.0), vt = (1.5707963 - lat) / 3.1415927;
              vec4 g = texture2D(uGlobalTex, vec2(u, 1.0 - vt));
              gl_FragColor.rgb = mix(gl_FragColor.rgb, g.rgb * (0.55 + 0.45 * lum), g.a * uGlobalAlpha * fadeS);
            }
          }
          if (uPolarOn > 0.5 && lat < uGlobalEdge) {   // the polar picture holds data only inside 80°S
            float rS = 2.0 * uMoonR * tan((1.5707963 + lat) * 0.5);
            float X = rS * sin(lon), Y = rS * cos(lon);
            vec2 uv = vec2((X - uPolarBox.x) / (uPolarBox.y - uPolarBox.x), (uPolarBox.w - Y) / (uPolarBox.w - uPolarBox.z));
            if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
              vec4 c = texture2D(uPolarTex, vec2(uv.x, 1.0 - uv.y));
              lsnInPolar = step(0.5, c.a);
              gl_FragColor.rgb = mix(gl_FragColor.rgb, c.rgb * (0.55 + 0.45 * lum), c.a * uPolarMix * (1.0 - smoothstep(-1.4224, -1.3963, lat)));   // feathered over the last 1.5° to 80°S   // as the whole-Moon layers: over the lit terrain
            }
          }
        }` : '\n        float lsnInPolar = 0.0;';
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vLsnWorld;\nuniform float uContours, uInterval, uExag, uMoonR;${overlays ? '\nuniform sampler2D uPolarTex, uGlobalTex;\nuniform vec4 uPolarBox;\nuniform float uPolarOn, uPolarMix, uGlobalOn, uGlobalAlpha, uGlobalEdge, uLiveOn, uNightOn;\nuniform vec3 uLiveSun, uLiveEarth, uColSun, uColEarth, uColBoth;' : ''}\nuniform vec3 uContourInk;`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>${drape}
        if (uContours > 0.5) {
          float hm = (length(vLsnWorld) - uMoonR) * 1000.0 / uExag;
          float q = hm / uInterval, w = fwidth(q);
          float d = abs(fract(q + 0.5) - 0.5) / max(w, 1e-5);
          float major = abs(fract(q / 5.0 + 0.5) - 0.5) * 5.0 / max(w, 1e-5);
          float line = (1.0 - smoothstep(0.3, 1.1, d)) * 0.4 + (1.0 - smoothstep(0.6, 1.8, major)) * 0.45;
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uContourInk, clamp(line, 0.0, 0.85) * step(w, 0.45));
        }`);
    };
  }

  const state = { exaggeration: 3, colour: 'shade', contours: false };
  let realSun = null;
  const cam = { lat: -20, lon: 20, dist: 6200, heading: 0, tilt: 0, ...initial };
  const cache = new Map();   // node id → { mesh, used, stale }
  const top = roots();
  let frame = 0, raf = 0, dirty = true, fly = null, lastStatus = '', stats = {};
  const perf = { buildMs: 0, builds: 0, renderMs: 0, frames: 0 };

  // ---- mesh building ----
  function colourFor(hM, out, k) {
    if (state.colour === 'height' || state.colour === 'tint') {
      // 'height': a rainbow over the Moon's whole range; 'tint': the polar map's Topo tint (terrain-style.js TINT, made
      // linear) over ±7 km, so the globe and the draped polar picture share one palette
      const tint = state.colour === 'tint';
      const t = tint ? Math.min(1, Math.max(0, (hM + 7000) / 14000)) : Math.min(1, Math.max(0, (hM + 9000) / 19500));
      const stops = tint ? TINT_LINEAR : [[0.0, [0.13, 0.17, 0.55]], [0.25, [0.1, 0.55, 0.8]], [0.45, [0.25, 0.75, 0.35]], [0.6, [0.95, 0.9, 0.3]], [0.8, [0.9, 0.35, 0.15]], [1, [0.98, 0.95, 0.95]]];
      let i = 0; while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
      const [t0, c0] = stops[i], [t1, c1] = stops[i + 1], f = (t - t0) / (t1 - t0);
      out[k] = c0[0] + (c1[0] - c0[0]) * f; out[k + 1] = c0[1] + (c1[1] - c0[1]) * f; out[k + 2] = c0[2] + (c1[2] - c0[2]) * f;
    } else {
      const g = shadeGrey + 0.05 * Math.max(-1, Math.min(1, hM / 6000));   // lunar grey (linear), a touch lighter on high ground
      out[k] = g; out[k + 1] = g * 0.985; out[k + 2] = g * 0.96;
    }
  }

  function buildMesh(n) {
    const N = SEG + 1, B = N + 2;   // B: with a one-sample border for normals
    const E = state.exaggeration / 1000;
    const P = new Float64Array(B * B * 3), H = new Float64Array(B * B);
    for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
      const u = (i - 1) / SEG, v = (j - 1) / SEG;
      const { latDeg, lonDeg } = nodeLatLon(n, u, v);
      const h = terrain.heightAt(Math.max(-90, Math.min(90, latDeg)), lonDeg);
      const r = MOON_R_KM + h * E, [x, y, z] = unit(latDeg, lonDeg), k = (j * B + i) * 3;
      P[k] = x * r; P[k + 1] = y * r; P[k + 2] = z * r; H[j * B + i] = h;
    }
    const c = P.slice(((1 + SEG / 2) * B + 1 + SEG / 2) * 3, ((1 + SEG / 2) * B + 1 + SEG / 2) * 3 + 3);   // centre sample
    let hmax = 0;
    for (let k = 0; k < H.length; k++) { const a = Math.abs(H[k]); if (a > hmax) hmax = a; }
    n._reliefM = hmax;
    // deep enough to cover the height step to a coarser neighbour (a few cells of relief, exaggerated)
    const skirtKm = nodeSizeKm(n) * 0.04 + 0.04 * state.exaggeration;
    const verts = N * N + 4 * SEG;
    const pos = new Float32Array(verts * 3), nor = new Float32Array(verts * 3), col = new Float32Array(verts * 3);
    const at = (i, j) => ((j + 1) * B + (i + 1)) * 3;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = at(i, j), o = (j * N + i) * 3;
      pos[o] = P[k] - c[0]; pos[o + 1] = P[k + 1] - c[1]; pos[o + 2] = P[k + 2] - c[2];
      const xa = at(i + 1, j), xb = at(i - 1, j), ya = at(i, j + 1), yb = at(i, j - 1);
      const ax = P[xa] - P[xb], ay = P[xa + 1] - P[xb + 1], az = P[xa + 2] - P[xb + 2];
      const bx = P[ya] - P[yb], by = P[ya + 1] - P[yb + 1], bz = P[ya + 2] - P[yb + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      // keep normals pointing out of the Moon (the grid's handedness differs between kinds and poles)
      if (nx * P[k] + ny * P[k + 1] + nz * P[k + 2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const l = Math.hypot(nx, ny, nz) || 1;
      nor[o] = nx / l; nor[o + 1] = ny / l; nor[o + 2] = nz / l;
      colourFor(H[(j + 1) * B + (i + 1)], col, o);
    }
    // skirt: the edge ring again, pulled towards the centre of the Moon
    const ring = [];
    for (let i = 0; i < SEG; i++) ring.push([i, 0]);
    for (let j = 0; j < SEG; j++) ring.push([SEG, j]);
    for (let i = SEG; i > 0; i--) ring.push([i, SEG]);
    for (let j = SEG; j > 0; j--) ring.push([0, j]);
    ring.forEach(([i, j], s) => {
      const src = (j * N + i) * 3, o = (N * N + s) * 3, k = at(i, j);
      const r = Math.hypot(P[k], P[k + 1], P[k + 2]), f = (r - skirtKm) / r;
      pos[o] = P[k] * f - c[0]; pos[o + 1] = P[k + 1] * f - c[1]; pos[o + 2] = P[k + 2] * f - c[2];
      nor.copyWithin(o, src, src + 3); col.copyWithin(o, src, src + 3);
    });
    const idx = [];
    // winding: surface triangles face out of the Moon, skirt triangles face away from the tile, so the
    // materials can be single-sided (a back face seen through a hairline crack would light up dark)
    const face = (a, b, d, wx, wy, wz) => {
      const ax = pos[b * 3] - pos[a * 3], ay = pos[b * 3 + 1] - pos[a * 3 + 1], az = pos[b * 3 + 2] - pos[a * 3 + 2];
      const bx = pos[d * 3] - pos[a * 3], by = pos[d * 3 + 1] - pos[a * 3 + 1], bz = pos[d * 3 + 2] - pos[a * 3 + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      if (nx * wx + ny * wy + nz * wz >= 0) idx.push(a, b, d); else idx.push(a, d, b);
    };
    const out = (a) => [pos[a * 3] + c[0], pos[a * 3 + 1] + c[1], pos[a * 3 + 2] + c[2]];   // radial direction
    const keep = (i, j) => n.kind !== 'cap' || capRadius(n, i / SEG, j / SEG) <= CAP_KEEP_KM;
    for (let j = 0; j < SEG; j++) for (let i = 0; i < SEG; i++) {
      if (!(keep(i, j) || keep(i + 1, j) || keep(i, j + 1) || keep(i + 1, j + 1))) continue;
      const a = j * N + i, b = a + 1, d = a + N, e = d + 1;
      const w = out(a);
      face(a, b, e, ...w); face(a, e, d, ...w);
    }
    ring.forEach(([i, j], s) => {
      const [i2, j2] = ring[(s + 1) % ring.length];
      if (n.kind === 'cap' && !keep(i, j) && !keep(i2, j2)) return;
      const a = j * N + i, b = j2 * N + i2, sa = N * N + s, sb = N * N + ((s + 1) % ring.length);
      const w = [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]];   // from the tile centre to its edge
      face(a, sa, b, ...w); face(b, sa, sb, ...w);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, n.kind === 'cap' ? matCap : matCyl);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.position.set(c[0], c[1], c[2]);
    mesh.userData.node = n;
    return mesh;
  }

  function nodeBounds(n) {
    if (n._centre) return;
    const { latDeg, lonDeg } = nodeLatLon(n, 0.5, 0.5);
    const [x, y, z] = unit(latDeg, lonDeg);
    n._centre = new THREE.Vector3(x * MOON_R_KM, y * MOON_R_KM, z * MOON_R_KM);
    let rad = 0;
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]]) {
      const p = nodeLatLon(n, u, v), q = unit(p.latDeg, p.lonDeg);
      rad = Math.max(rad, Math.hypot(q[0] * MOON_R_KM - n._centre.x, q[1] * MOON_R_KM - n._centre.y, q[2] * MOON_R_KM - n._centre.z));
    }
    n._radius = rad;   // flat; select() adds the relief (±11 km × exaggeration)
  }

  // ---- data requests for a node about to be drawn ----
  function requestData(n) {
    const spacing = nodeSizeKm(n) / SEG;
    if (n.kind === 'cyl') {
      const box = [n.lat0 - 0.01, n.lat1 + 0.01, n.lon0 - 0.01, n.lon1 + 0.01];
      if (spacing < G1.kmPerPixel * 3) terrain.need(G1, ...box);
      if (spacing < G2.kmPerPixel * 3) terrain.need(G2, ...box);
    } else if (n.pole === 'S') {
      requestSouth(spacing, { x0: n.x0, x1: n.x1, y0: n.y0, y1: n.y1 });
    } else if (spacing < G1.kmPerPixel * 3) {
      terrain.need(G1, BAND_LAT - 6, 90, 0, 360, { max: 24 });
    }
  }

  // Marks built meshes over a lat/lon box (or a whole pole) stale, so they rebuild with new data.
  function invalidate({ latMin = -90, latMax = 90, lonMin = 0, lonMax = 360, pole = null } = {}) {
    for (const [, e] of cache) {
      const n = e.mesh.userData.node;
      if (pole) { if (n.kind === 'cap' && n.pole === pole) e.stale = true; continue; }
      if (n.kind === 'cyl') {
        if (n.lat1 < latMin || n.lat0 > latMax || n.lon1 < lonMin || n.lon0 > lonMax) continue;
        e.stale = true;
      } else if ((n.pole === 'N' && latMax > BAND_LAT - 6) || (n.pole === 'S' && latMin < -(BAND_LAT - 6))) e.stale = true;
    }
    dirty = true;
  }

  function rebuildAll() { for (const [, e] of cache) e.stale = true; dirty = true; }

  // ---- camera ----
  // Highest terrain radius (km) under a point and at 8 points on a ring of ringKm around it.
  function groundAround(p, ringKm) {
    const U = p.clone().normalize();
    const T1 = new THREE.Vector3(0, 1, 0).cross(U); if (T1.lengthSq() < 1e-8) T1.set(1, 0, 0).cross(U);
    T1.normalize();
    const T2 = U.clone().cross(T1).normalize();
    let best = -Infinity;
    for (let k = -1; k < 8; k++) {
      const q = U.clone().multiplyScalar(MOON_R_KM);
      if (k >= 0) { const a = (k / 8) * 2 * Math.PI; q.addScaledVector(T1, Math.cos(a) * ringKm).addScaledVector(T2, Math.sin(a) * ringKm); }
      const { latDeg, lonDeg } = toLatLon(q.x, q.y, q.z);
      const r = surfaceR(latDeg, lonDeg);
      if (r > best) best = r;
    }
    return best;
  }
  function surfaceR(lat, lon) { return MOON_R_KM + terrain.heightAt(lat, lon) * state.exaggeration / 1000; }
  // the target's radius and the ground clearance ease towards their new values over a few frames, so a camera
  // that follows the rover over rough ground glides instead of stepping with every height sample
  const ease = { r: null, clear: null };
  function placeCamera() {
    const T = unit(cam.lat, cam.lon), rNow = surfaceR(cam.lat, cam.lon);
    if (ease.r === null || fly || Math.abs(rNow - ease.r) > Math.max(0.05, cam.dist * 0.2)) ease.r = rNow;
    else { ease.r += (rNow - ease.r) * 0.18; if (Math.abs(rNow - ease.r) > 1e-5) dirty = true; }
    const r = ease.r;
    const U = new THREE.Vector3(...T), tgt = U.clone().multiplyScalar(r);
    const N = new THREE.Vector3(-Math.sin(cam.lat * RAD) * Math.cos(cam.lon * RAD), Math.cos(cam.lat * RAD), Math.sin(cam.lat * RAD) * Math.sin(cam.lon * RAD));
    const Ea = new THREE.Vector3(-Math.sin(cam.lon * RAD), 0, -Math.cos(cam.lon * RAD));
    const f = N.clone().multiplyScalar(Math.cos(cam.heading * RAD)).add(Ea.clone().multiplyScalar(Math.sin(cam.heading * RAD)));
    const t = cam.tilt * RAD;
    const back = U.clone().multiplyScalar(Math.cos(t)).sub(f.clone().multiplyScalar(Math.sin(t)));
    camera.position.copy(tgt).addScaledVector(back, cam.dist);
    camera.up.copy(U.clone().multiplyScalar(Math.sin(t)).add(f.clone().multiplyScalar(Math.cos(t))));
    camera.lookAt(tgt);
    // keep the camera above the ground: the terrain under it and in a ring around it (so a ridge beside it
    // cannot swallow the near plane), plus a margin that grows with the distance to the target
    // (margins scale with the distance, so a close-up of a 2 m rover is not pushed tens of metres back)
    const ground = groundAround(camera.position, Math.max(0.006, cam.dist * 0.12));
    const soft = ground + Math.max(0.003, cam.dist * 0.04), hard = ground + Math.max(0.0015, cam.dist * 0.012);
    if (ease.clear === null || fly || Math.abs(soft - ease.clear) > Math.max(0.2, cam.dist * 0.5)) ease.clear = soft;
    else { ease.clear += (soft - ease.clear) * 0.12; if (Math.abs(soft - ease.clear) > 1e-5) dirty = true; }
    const minR = Math.max(hard, ease.clear);
    const camRad = camera.position.length();
    if (camRad < minR) { camera.position.multiplyScalar(minR / camRad); camera.lookAt(tgt); }
    camera.updateMatrixWorld();   // select() culls with this frame's matrices, not the last render's
    camera.near = Math.max(0.002, cam.dist * 0.002);
    camera.far = cam.dist + 3 * MOON_R_KM;
    camera.updateProjectionMatrix();
    // Display light, not the real Sun: low (30° above the local horizon at the view centre) and from the
    // upper left of the screen, so relief reads at every zoom; at whole-Moon scale it gives a gibbous phase.
    const az = (cam.heading - 135) * RAD, el = 30 * RAD;
    const horiz = N.clone().multiplyScalar(Math.cos(az)).add(Ea.clone().multiplyScalar(Math.sin(az)));
    const L = realSun ? new THREE.Vector3(realSun[0], realSun[2], -realSun[1]).normalize()
      : U.clone().multiplyScalar(Math.sin(el)).addScaledVector(horiz, Math.cos(el)).normalize();
    if (realSun) {
      // the real Sun: its light grazes the poles, so the exposure rises as it gets low (as the polar map's Real light
      // does) and the terrain casts shadows. The shadow camera looks along the light over the ground in view.
      const el = Math.asin(Math.max(-1, Math.min(1, L.dot(U))));
      sun.intensity = Math.min(40, 2.4 / Math.max(0.06, Math.sin(Math.max(el, 0.01))));
      ambient.intensity = 0.16;   // shadows stay readable, as the polar map's Real light keeps an ambient
      const span = Math.max(2, cam.dist * (1.2 + Math.sin(cam.tilt * RAD) * 1.5));
      const D = Math.max(60, span * 3);
      sun.position.copy(tgt).addScaledVector(L, D);
      sun.target.position.copy(tgt);
      sun.castShadow = true;
      const sc = sun.shadow.camera;
      sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = Math.max(0.01, D - span * 2 - 30); sc.far = D + span * 2 + 30;
      sc.updateProjectionMatrix();
      sun.shadow.normalBias = span / 4096 * 1.5;
    } else {
      sun.intensity = 3.2; ambient.intensity = 0.18; sun.castShadow = false;
      sun.position.copy(tgt).addScaledVector(L, 5000);
    }
    sun.target.position.copy(tgt);
    sun.target.updateMatrixWorld();
  }

  // ---- selection ----
  // A node is refined only when all of its visible children have meshes; until then it is drawn itself and
  // its children are queued. So two levels never overlap (no z-fighting) and there is never a hole.
  const frustum = new THREE.Frustum(), projView = new THREE.Matrix4(), sphere = new THREE.Sphere();
  function visible(n, camU, horizon) {
    if (nodeOutsideCap(n)) return false;
    nodeBounds(n);
    const rad = n._radius + reliefM(n) * state.exaggeration / 1000;
    sphere.center.copy(n._centre); sphere.radius = rad;
    if (!frustum.intersectsSphere(sphere)) return false;
    const ang = Math.acos(Math.max(-1, Math.min(1, n._centre.clone().normalize().dot(camU))));
    return ang - Math.asin(Math.min(1, rad / n._centre.length())) <= horizon;
  }
  function select() {
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);
    const K = renderer.domElement.clientHeight / (2 * Math.tan((camera.fov / 2) * RAD));
    const camU = camera.position.clone().normalize();
    const horizon = Math.acos(Math.min(1, (MOON_R_KM - 12 * state.exaggeration) / camera.position.length()));
    const draw = [], build = [];
    const ready = (n) => cache.has(n.id);
    const visit = (n) => {
      const rad = n._radius + reliefM(n) * state.exaggeration / 1000;
      const d = Math.max(0.001, camera.position.distanceTo(n._centre) - rad);
      const err = (nodeSizeKm(n) / SEG) / d * K;
      // caps refine past 20 m only where finer data exists (the high-resolution site patches)
      const max = n.kind === 'cap' ? (n.pole === 'S' ? capDepth({ x0: n.x0, x1: n.x1, y0: n.y0, y1: n.y1 }) : MAX_DEPTH_CAP) : MAX_DEPTH_CYL;
      if (err > PX_ERROR && n.depth < max) {
        const kids = children(n).filter((c) => visible(c, camU, horizon));
        const missing = kids.filter((c) => !ready(c));
        if (ready(n)) cache.get(n.id).used = frame;   // an ancestor of what is drawn: keep it
        if (!missing.length) { for (const c of kids) visit(c); return; }
        build.push(...missing);
        for (const c of kids) if (ready(c)) cache.get(c.id).used = frame;   // keep the ready siblings from eviction
      }
      if (ready(n)) draw.push(n); else build.push(n);
    };
    for (const r of top) if (visible(r, camU, horizon)) visit(r);
    return { draw, build };
  }

  function frameLoop() {
    raf = requestAnimationFrame(frameLoop);
    frame++;
    if (fly) stepFly();
    if (!dirty && !fly) return;
    dirty = false;
    resize();
    placeCamera();
    onCamera({ ...cam });
    const { draw, build } = select();
    const t0 = performance.now();
    const budget = () => performance.now() - t0 < BUILD_MS;
    const make = (n) => {
      const old = cache.get(n.id);
      if (old) { group.remove(old.mesh); old.mesh.geometry.dispose(); }
      requestData(n);
      const tb = performance.now();
      const e = { mesh: buildMesh(n), used: frame, stale: false };
      perf.buildMs += performance.now() - tb; perf.builds++;
      cache.set(n.id, e); group.add(e.mesh);
      dirty = true;   // draw it next frame (and refine further)
    };
    // missing meshes first (coarse to fine), then stale ones that are on screen
    build.sort((a, b) => a.depth - b.depth);
    for (const n of build) { if (!budget()) break; if (!cache.has(n.id)) make(n); }
    const stale = draw.filter((n) => cache.get(n.id).stale).sort((a, b) => a.depth - b.depth);
    for (const n of stale) { if (!budget()) break; make(n); }
    if (build.some((n) => !cache.has(n.id)) || draw.some((n) => cache.get(n.id).stale)) dirty = true;
    const shown = new Set(draw.map((n) => cache.get(n.id).mesh));
    for (const n of draw) cache.get(n.id).used = frame;
    for (const [, e] of cache) e.mesh.visible = shown.has(e.mesh);
    stats = { drawn: draw.length, queued: build.filter((n) => !cache.has(n.id)).length, cached: cache.size, maxDepth: Math.max(0, ...draw.map((n) => n.depth)) };
    if (cache.size > CACHE_MAX) evict();
    if (state.contours) {
      // about one line per 14 px on a 20° slope: interval ≈ 14 px × km per px × tan 20°, rounded to 1, 2, 5 × 10ⁿ m
      const want = kmPerPx() * 1000 * 14 * 0.36, p = Math.pow(10, Math.floor(Math.log10(Math.max(1, want))));
      contourU.uInterval.value = [1, 2, 5, 10].map((m) => m * p).find((v) => v >= want) ?? 10 * p;
    }
    contourU.uContours.value = state.contours ? 1 : 0; contourU.uExag.value = state.exaggeration;
    const tr = performance.now();
    renderer.render(scene, camera);
    perf.renderMs += performance.now() - tr; perf.frames++;
    const status = `${draw.length}/${stats.queued}`;
    if (status !== lastStatus) { lastStatus = status; onStatus(stats); }
  }

  function evict() {
    const old = [...cache.entries()].filter(([, e]) => e.used < frame - 30).sort((a, b) => a[1].used - b[1].used);
    for (const [id, e] of old.slice(0, cache.size - CACHE_MAX * 0.8)) { group.remove(e.mesh); e.mesh.geometry.dispose(); cache.delete(id); }
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
    }
  }

  // ---- controls ----
  let drag = null;
  const kmPerPx = () => cam.dist / (canvas.clientHeight / (2 * Math.tan((camera.fov / 2) * RAD)));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 0 && !e.shiftKey && !e.ctrlKey && !canDrag(e)) return;
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, rotate: e.button === 2 || e.shiftKey || e.ctrlKey };
    fly = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.rotate) {
      cam.heading = (cam.heading - dx * 0.3 + 360) % 360;
      cam.tilt = Math.max(0, Math.min(maxTilt(), cam.tilt + dy * 0.25));
    } else {
      const s = kmPerPx() / MOON_R_KM * DEG;   // degrees of arc per pixel at the target
      const h = cam.heading * RAD;
      const north = (dy * Math.cos(h) + dx * Math.sin(h)) * s, east = (-dx * Math.cos(h) + dy * Math.sin(h)) * s;
      cam.lat = Math.max(-89.999, Math.min(89.999, cam.lat + north));
      cam.lon = (cam.lon + east / Math.max(0.02, Math.cos(cam.lat * RAD)) + 360) % 360;
    }
    dirty = true;
  });
  canvas.addEventListener('pointerup', (e) => { if (!drag) return; drag = null; try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ } });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.dist = Math.max(MIN_DIST_KM, Math.min(14000, cam.dist * Math.exp(e.deltaY * 0.0012)));
    cam.tilt = Math.min(cam.tilt, maxTilt());
    fly = null; dirty = true;
  }, { passive: false });
  canvas.addEventListener('dblclick', (e) => {
    if (!canDrag(e)) return;
    const hit = pick(e.clientX, e.clientY);
    if (hit) flyTo({ lat: hit.latDeg, lon: hit.lonDeg, dist: cam.dist * 0.35 });
  });
  const maxTilt = () => (cam.dist > 2500 ? 0 : cam.dist > 600 ? 40 : 80);

  // ---- fly-to ----
  function flyTo({ lat, lon, dist = cam.dist, heading = 0, tilt = 0, ms = 1800 }) {
    let dl = ((lon - cam.lon + 540) % 360) - 180;
    const from = { ...cam }, to = { lat, lon: cam.lon + dl, dist, heading, tilt };
    const arc = Math.acos(Math.max(-1, Math.min(1, new THREE.Vector3(...unit(from.lat, from.lon)).dot(new THREE.Vector3(...unit(lat, lon))))));
    const peak = Math.max(from.dist, dist, arc * MOON_R_KM * 0.9);
    fly = { from, to, peak, t0: performance.now(), ms };
    dirty = true;
  }
  function stepFly() {
    const { from, to, peak, t0, ms } = fly;
    const t = Math.min(1, (performance.now() - t0) / ms), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    cam.lat = from.lat + (to.lat - from.lat) * e;
    cam.lon = (from.lon + (to.lon - from.lon) * e + 360) % 360;
    // distance: log-interpolate through a peak so long flights rise above the surface
    const lf = Math.log(from.dist), lt = Math.log(to.dist), lp = Math.log(peak);
    const base = lf + (lt - lf) * e, lift = Math.max(0, lp - Math.max(lf, lt)) * 4 * e * (1 - e);
    cam.dist = Math.exp(base + lift);
    let dh = ((to.heading - from.heading + 540) % 360) - 180;
    cam.heading = (from.heading + dh * e + 360) % 360;
    cam.tilt = from.tilt + (to.tilt - from.tilt) * e;
    dirty = true;
    if (t >= 1) fly = null;
  }

  // ---- picking ----
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(group.children.filter((m) => m.visible), false);
    if (!hits.length) return null;
    const p = hits[0].point;
    return toLatLon(p.x, p.y, p.z);
  }

  function makeStars(T) {
    const n = 2500, p = new Float32Array(n * 3);
    let s = 7;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < n; i++) {
      const z = 2 * rnd() - 1, a = 2 * Math.PI * rnd(), q = Math.sqrt(1 - z * z), R = 18000;
      p[i * 3] = R * q * Math.cos(a); p[i * 3 + 1] = R * z; p[i * 3 + 2] = R * q * Math.sin(a);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(p, 3));
    return new T.Points(g, new T.PointsMaterial({ color: 0x9aa4b2, size: 1.2, sizeAttenuation: false }));
  }

  // screen position of a lat/lon (for labels); null when behind the Moon or off screen
  const tmp = new THREE.Vector3();
  function project(lat, lon) {
    const [x, y, z] = unit(lat, lon), r = surfaceR(lat, lon);
    tmp.set(x * r, y * r, z * r);
    const toCam = camera.position.clone().sub(tmp);
    if (toCam.dot(new THREE.Vector3(x, y, z)) < 0) return null;
    tmp.project(camera);
    if (tmp.z > 1 || Math.abs(tmp.x) > 1.05 || Math.abs(tmp.y) > 1.05) return null;
    return { x: (tmp.x + 1) / 2 * canvas.clientWidth, y: (1 - tmp.y) / 2 * canvas.clientHeight };
  }

  // screen position of a world point (km), for labels on 3D objects; null when behind the camera or off screen
  function projectWorld(x, y, z) {
    tmp.set(x, y, z);
    const toP = tmp.clone().sub(camera.position);
    if (toP.dot(camera.getWorldDirection(new THREE.Vector3())) <= 0) return null;
    // hidden behind the Moon's limb: the point is on the far side of the horizon from the camera
    const pr = tmp.length(), cr = camera.position.length();
    if (tmp.dot(camera.position) / (pr * cr) < Math.min(MOON_R_KM, pr) / cr - 1e-4 && cr > MOON_R_KM * 1.02) return null;
    tmp.project(camera);
    if (tmp.z > 1 || Math.abs(tmp.x) > 1.05 || Math.abs(tmp.y) > 1.05) return null;
    return { x: (tmp.x + 1) / 2 * canvas.clientWidth, y: (1 - tmp.y) / 2 * canvas.clientHeight };
  }

  frameLoop();
  window.addEventListener('resize', () => { dirty = true; });

  return {
    flyTo, pick, project, projectWorld, invalidate,
    jumpTo(c) { fly = null; Object.assign(cam, c); dirty = true; },
    // a follow camera's target: centre and heading (and tilt, when given) without cancelling a glide in progress,
    // so a zoom or tilt button still glides while the camera rides along
    followTo({ lat, lon, heading, tilt }) {
      if (fly) {
        for (const k of ['from', 'to']) { fly[k].lat = lat; fly[k].lon = lon; fly[k].heading = heading; }
      } else {
        cam.lat = lat; cam.lon = lon; cam.heading = heading;
        if (Number.isFinite(tilt)) cam.tilt = Math.max(0, Math.min(maxTilt(), tilt));
      }
      dirty = true;
    },
    get flying() { return !!fly; },
    // where the camera was at the last drawn frame (km, world frame)
    get cameraPosition() { return camera.position.clone(); },
    // phase 6: extra objects in the scene, and points on the terrain surface (km, world frame)
    THREE,
    addObject(o) { scene.add(o); dirty = true; },
    removeObject(o) { scene.remove(o); dirty = true; },
    surface(lat, lon, liftKm = 0) { const [x, y, z] = unit(lat, lon), r = surfaceR(lat, lon) + liftKm; return [x * r, y * r, z * r]; },
    get exaggeration() { return state.exaggeration; },
    debug() {
      placeCamera();
      const { draw, build } = select();
      const camU = camera.position.clone().normalize();
      const horizon = Math.acos(Math.min(1, (MOON_R_KM - 12 * state.exaggeration) / camera.position.length()));
      const roots = top.map((r) => ({ id: r.id, vis: visible(r, camU, horizon) }));
      return { cam: { ...cam }, camPos: camera.position.toArray().map((v) => +v.toFixed(2)), camR: +camera.position.length().toFixed(2), near: camera.near, far: camera.far, draw: draw.map((n) => n.id), build: build.map((n) => n.id).slice(0, 20), roots: roots.filter((r) => r.vis).map((r) => r.id) };
    },
    get camera() { return { ...cam }; },
    get stats() { return stats; },
    // nothing left to build or animate: the render loop has gone quiet
    get idle() { return !dirty && !fly; },
    get perf() { return { ...perf, msPerBuild: +(perf.buildMs / Math.max(1, perf.builds)).toFixed(2), msPerRender: +(perf.renderMs / Math.max(1, perf.frames)).toFixed(2) }; },
    kmPerPx,
    setExaggeration(v) { state.exaggeration = v; rebuildAll(); },
    setColour(mode) { state.colour = mode; for (const [, e] of cache) e.stale = true; dirty = true; },
    setContours(on) { state.contours = !!on; dirty = true; },
    // the draped pictures (overlays: true): { polar: { canvas, box, mix } | null, global: { canvas, alpha } | null };
    // a canvas already set is uploaded again (its pixels changed)
    setOverlay({ polar, global } = {}) {
      const put = (u, cv) => {
        if (!cv) return;
        const t = u.value;
        if (t.image === cv) t.needsUpdate = true;
        else { const n = new THREE.CanvasTexture(cv); n.colorSpace = THREE.SRGBColorSpace; n.minFilter = THREE.LinearFilter; n.generateMipmaps = false; n.anisotropy = 4; u.value = n; }
      };
      if (polar !== undefined) {
        overlayU.uPolarOn.value = polar ? 1 : 0;
        if (polar) { put(overlayU.uPolarTex, polar.canvas); overlayU.uPolarBox.value.set(polar.box.x0, polar.box.x1, polar.box.y0, polar.box.y1); overlayU.uPolarMix.value = polar.mix ?? 1; }
      }
      if (global !== undefined) {
        overlayU.uGlobalOn.value = global ? 1 : 0;
        if (global) { put(overlayU.uGlobalTex, global.canvas); overlayU.uGlobalAlpha.value = global.alpha ?? 1; }
      }
      dirty = true;
    },
    // the light: null = the display light (low, from the upper left of the screen); a unit vector in the
    // Moon-fixed frame of geometry.js (x 0°E, y 90°E, z north) = the real Sun
    setSun(dir) { realSun = dir; dirty = true; },
    // Live per pixel: { sun, earth } unit vectors (Moon-fixed, geometry.js) and colours [r, g, b] 0–255, or null
    setLive(live) {
      overlayU.uLiveOn.value = live ? 1 : 0;
      if (live) {
        overlayU.uLiveSun.value.set(...live.sun); overlayU.uLiveEarth.value.set(...live.earth);
        const c = (v) => new THREE.Vector3(...v.map(lin));
        if (live.colours) { overlayU.uColSun.value = c(live.colours.sun); overlayU.uColEarth.value = c(live.colours.earth); overlayU.uColBoth.value = c(live.colours.both); }
      }
      dirty = true;
    },
    // the night veil outside the polar map: the Sun's direction (Moon-fixed unit vector), or null for none
    setNight(sun) { overlayU.uNightOn.value = sun ? 1 : 0; if (sun && !overlayU.uLiveOn.value) overlayU.uLiveSun.value.set(...sun); dirty = true; },
    setContourInk(rgb) { contourU.uContourInk.value.set(...rgb.map(lin)); dirty = true; },
    get contourInterval() { return state.contours ? contourU.uInterval.value : null; },
    maxTilt,
    get canvas() { return canvas; },
    redraw() { dirty = true; },
    onFrame(fn) { const loop = () => { fn(); requestAnimationFrame(loop); }; requestAnimationFrame(loop); },
    destroy() { cancelAnimationFrame(raf); renderer.dispose(); },
  };
}
