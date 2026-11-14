import test from 'node:test';
import assert from 'node:assert/strict';
import { findSnap, SNAP_RADIUS_PX } from '../demo/src/map/snap.js';

const targets = [
  { id: 'a', kind: 'site', name: 'A', px: 100, py: 100 },
  { id: 'b', kind: 'site', name: 'B', px: 110, py: 100 },
  { id: 'c', kind: 'best', name: 'C', px: 300, py: 300 },
];

test('findSnap returns the nearest target inside the radius', () => {
  assert.equal(SNAP_RADIUS_PX, 16);
  assert.equal(findSnap(targets, 103, 100).id, 'a');
  assert.equal(findSnap(targets, 107, 100).id, 'b');
  assert.equal(findSnap(targets, 300, 316).id, 'c');           // exactly on the radius
  assert.equal(findSnap(targets, 300, 316.5), null);
  assert.equal(findSnap(targets, 200, 200), null);
  assert.equal(findSnap(targets, 105, 100).id, 'a');           // a tie keeps the first
  assert.equal(findSnap(targets, 300, 310, 8), null);          // custom radius
  assert.equal(findSnap([], 0, 0), null);
  assert.equal(findSnap(undefined, 0, 0), null);
  assert.equal(findSnap(targets, 100, 100).name, 'A');         // the target object itself comes back
});
