// Small 3-vector helpers for the lander modules (plain [x, y, z] arrays).
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export function unit(a) {
  const n = norm(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}
export const lerp3 = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
// rotation of v about the unit axis k by angle (rad), Rodrigues
export function rotate(v, k, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const kv = cross(k, v), kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}
export function rotZ(v, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}
// signed angle from a to b about the axis k (rad, −π..π); a and b need not be unit vectors
export function angleAbout(a, b, k) {
  return Math.atan2(dot(k, cross(a, b)), dot(a, b));
}
export const wrapPi = (x) => x - 2 * Math.PI * Math.floor((x + Math.PI) / (2 * Math.PI));
export const wrap2Pi = (x) => x - 2 * Math.PI * Math.floor(x / (2 * Math.PI));
export const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
