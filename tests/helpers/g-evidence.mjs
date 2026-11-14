// Check the saved Task G evidence without a browser; all paths are under this project.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const shots = new URL('../../docs/phase5/shots/', import.meta.url);
const files = readdirSync(shots).filter(f => /^A-smooth-.*\.png$/.test(f)).sort();
const images = files.map(file => {
  const data = readFileSync(new URL(file, shots));
  assert.equal(data.subarray(1, 4).toString(), 'PNG');
  return { file, width: data.readUInt32BE(16), height: data.readUInt32BE(20), sha256: createHash('sha256').update(data).digest('hex') };
});
const duplicates = [];
for (const z of [1, 1.5, 2, 2.2, 4]) {
  const reference = images.find(i => i.file === `A-smooth-now-nowin-z${z}-1728x996x1.png`);
  for (const mode of ['both', 'sun']) {
    const image = images.find(i => i.file === `A-smooth-${mode}-nowin-z${z}-1728x996x1.png`);
    duplicates.push({ file: image.file, sameAsLive: image.sha256 === reference.sha256 });
  }
}
const perf = [];
for (const size of ['1728x996x1', '1440x900x2']) {
  const before = JSON.parse(readFileSync(new URL(`g-fps-before-${size}.json`, import.meta.url)));
  const after = JSON.parse(readFileSync(new URL(`g-fps-after-${size}.json`, import.meta.url)));
  for (let i = 0; i < before.length; i++) {
    const a = before[i], b = after[i];
    assert.equal(a.mode, b.mode); assert.equal(a.z, b.z); assert.ok(!a.error && !b.error);
    perf.push({ size, mode: a.mode, z: a.z, fps: [a.fps, b.fps], paint: [a.paint, b.paint],
      medianRedrawMs: a.mode === 'both' ? [a.veilMs.median, b.veilMs.median] : [a.heatMs.median, b.heatMs.median],
      p90FrameMs: [a.p90, b.p90], worstFrameMs: [a.worst, b.worst] });
  }
}
writeFileSync(new URL('g-evidence.json', import.meta.url), JSON.stringify({ images, duplicates, perf }, null, 2) + '\n');
console.log(JSON.stringify({ pngs: images.length, sameAsLive: duplicates.filter(d => d.sameAsLive).length, comparedNoWindowImages: duplicates.length, perf }, null, 2));
