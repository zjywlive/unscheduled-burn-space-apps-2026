// The Map as one view of the whole Moon (demo/src/ui/moonlayer.js): when the globe hands over to the polar map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handsOver, zoomForDist, HANDOFF_KM, POLAR_EDGE_LAT } from '../demo/src/ui/moonlayer.js';

test('the globe hands over only when zooming in over the polar cap', () => {
  assert.equal(handsOver({ latDeg: -89.4, lonDeg: 222, distKm: 500 }, 800), true);
  assert.equal(handsOver({ latDeg: -89.4, lonDeg: 222, distKm: 500 }, null), true, 'a fly to a polar site');
  assert.equal(handsOver({ latDeg: -89.4, lonDeg: 222, distKm: 500 }, 450), false, 'zooming out: stay on the globe');
  assert.equal(handsOver({ latDeg: -70, lonDeg: 0, distKm: 300 }, 800), false, 'outside the polar map');
  assert.equal(handsOver({ latDeg: -89, lonDeg: 0, distKm: HANDOFF_KM + 1 }, 2000), false, 'still far');
  assert.equal(handsOver({ latDeg: POLAR_EDGE_LAT, lonDeg: 0, distKm: 100 }, 200), true, 'on the edge');
  assert.equal(handsOver(null, 100), false);
});

test('the polar map opens at about the globe\'s scale', () => {
  assert.ok(zoomForDist(HANDOFF_KM) > 1 && zoomForDist(HANDOFF_KM) < 1.2, 'the whole cap just after the hand-over');
  assert.equal(zoomForDist(20), 32, 'capped at the map\'s finest zoom');
  assert.equal(zoomForDist(5000), 1, 'never below the whole map');
});
