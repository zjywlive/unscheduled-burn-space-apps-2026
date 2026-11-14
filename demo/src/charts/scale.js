// Linear scales, round ticks and path splitting for the two charts.

export function linear(d0, d1, r0, r1) {
  const k = (r1 - r0) / (d1 - d0);
  return (v) => r0 + (v - d0) * k;
}

export function niceTicks(min, max, target = 5) {
  const raw = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw - 1e-12);
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const ticks = [];
  for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 2; v += step) {
    ticks.push(Number(v.toFixed(decimals)) + 0);
  }
  return ticks;
}

export function elevationDomain(minEl, maxEl) {
  return [Math.min(-10, Math.floor(minEl / 10) * 10), Math.max(30, Math.ceil(maxEl / 10) * 10)];
}

export function splitAtWrap(points) {
  const parts = [];
  let current = [];
  for (const p of points) {
    if (p.az === null || p.az === undefined) {
      if (current.length) parts.push(current);
      current = [];
      continue;
    }
    const prev = current[current.length - 1];
    if (prev && Math.abs(p.az - prev.az) > 180) {
      parts.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length) parts.push(current);
  return parts;
}
