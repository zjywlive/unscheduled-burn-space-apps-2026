import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findSite, parseCustomSite, formatCoords } from '../demo/src/sites.js';
import { toXY } from '../demo/src/terrain.js';

const sites = JSON.parse(readFileSync(new URL('../demo/data/sites.json', import.meta.url)));

test('eight sites in the agreed order, with valid fields', () => {
  // phase 2: the original eight are the 'missions' group, in their original order
  assert.deepEqual(sites.filter((s) => s.group === 'missions').map((s) => s.id),
    ['apollo11', 'apollo17', 'blueghost1', 'chandrayaan3', 'change4', 'im1', 'im2', 'shackleton']);
  for (const s of sites) {
    assert.ok(s.latDeg >= -90 && s.latDeg <= 90);
    assert.ok(s.lonDeg >= 0 && s.lonDeg < 360);
    assert.equal(typeof s.verified, 'boolean');
    assert.ok(!s.verified || s.source.startsWith('https://'));
  }
  assert.equal(findSite(sites, 'im2').name, 'IM-2 Athena');
  assert.equal(findSite(sites, 'nope'), null);
});

test('custom coordinates: accepted forms', () => {
  assert.deepEqual(parseCustomSite(' -85.2 ', '31.5').site, { id: 'custom', name: 'Custom site', subtitle: '', latDeg: -85.2, lonDeg: 31.5, verified: true });
  assert.equal(parseCustomSite('84,5', '10').site.latDeg, 84.5);
  assert.equal(parseCustomSite('0', '-137.31').site.lonDeg, 222.69);
  assert.equal(parseCustomSite('-90', '360').site.lonDeg, 0);
});

test('custom coordinates: rejected forms name the field and say how to fix it', () => {
  for (const bad of ['', 'abc', '91', '-90.01', '1e999']) {
    const r = parseCustomSite(bad, '10');
    assert.equal(r.ok, false); assert.equal(r.field, 'lat');
    assert.equal(r.message, 'Enter a latitude between −90 and 90.');
  }
  for (const bad of ['', 'x', '-200', '360.5']) {
    const r = parseCustomSite('10', bad);
    assert.equal(r.ok, false); assert.equal(r.field, 'lon');
    assert.equal(r.message, 'Enter an east longitude between −180 and 360.');
  }
});

test('coordinates print with hemispheres', () => {
  assert.equal(formatCoords({ latDeg: -84.7906, lonDeg: 29.1957 }), '84.79°S 29.20°E');
  assert.equal(formatCoords({ latDeg: -89.45, lonDeg: 222.69 }), '89.45°S 137.31°W');
  assert.equal(formatCoords({ latDeg: 0.67416, lonDeg: 23.47314 }), '0.67°N 23.47°E');
});

test('Artemis III candidates and crater names are south-polar and well formed', () => {
  const candidates = sites.filter((s) => s.group === 'candidates');
  assert.ok(candidates.length >= 1);
  for (const s of sites) assert.ok(['missions', 'candidates'].includes(s.group));
  for (const c of candidates) {
    assert.ok(c.latDeg <= -83, c.id);
    assert.ok(!c.verified || c.source.startsWith('https://'));
    assert.equal(c.subtitle, 'Artemis III candidate region');
  }
  const features = JSON.parse(readFileSync(new URL('../demo/data/features.json', import.meta.url)));
  for (const f of features) {
    const [x, y] = toXY(f.latDeg, f.lonDeg);
    assert.ok(Math.abs(x) <= 320 && Math.abs(y) <= 320, f.name);
    assert.ok(f.diameterKm > 0);
    assert.ok(f.source.startsWith('https://planetarynames.wr.usgs.gov/'));
  }
});
