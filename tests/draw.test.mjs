import test from 'node:test';
import assert from 'node:assert/strict';
import { initialDraw, drawReduce, draftShape, closeTarget, CLOSE_RADIUS_PX } from '../demo/src/map/draw.js';

// 1 km = 10 px in these tests
const ev = (type, x, y, extra = {}) => ({ type, xKm: x, yKm: y, px: x * 10, py: -y * 10, ...extra });
const key = (k, x, y) => (x === undefined ? { type: 'key', key: k } : { type: 'key', key: k, xKm: x, yKm: y, px: x * 10, py: -y * 10 });
function run(tool, events) {
  let state = initialDraw(tool);
  const done = [];
  for (const e of events) {
    const r = drawReduce(state, e);
    state = r.state;
    if (r.completed) done.push(r.completed);
  }
  return { state, done };
}

test('select ignores everything', () => {
  const { state, done } = run('select', [ev('down', 0, 0), ev('move', 5, 5), ev('up', 5, 5), key('Enter', 1, 1)]);
  assert.deepEqual(state, initialDraw('select'));
  assert.equal(done.length, 0);
});

test('rectangle: drag out the corners, normalised', () => {
  const { state, done } = run('rect', [ev('down', 5, 5), ev('move', 3, 4), ev('move', 1, 2), ev('up', 1, 2)]);
  assert.deepEqual(done, [{ type: 'rect', x0: 1, y0: 2, x1: 5, y1: 5 }]);
  assert.deepEqual(state, initialDraw('rect'));
});

test('rectangle: click, move, click works too; a zero-area box does not finish', () => {
  const r = run('rect', [ev('down', 0, 0), ev('up', 0.1, 0), ev('move', 2, 3)]);
  assert.equal(r.done.length, 0);
  assert.deepEqual(draftShape(r.state), { type: 'rect', x0: 0, y0: 0, x1: 2, y1: 3 });
  const r2 = drawReduce(r.state, ev('down', 2, 3));
  assert.deepEqual(r2.completed, { type: 'rect', x0: 0, y0: 0, x1: 2, y1: 3 });
  const flat = run('rect', [ev('down', 0, 0), ev('move', 6, 0), ev('up', 6, 0)]);
  assert.equal(flat.done.length, 0);
});

test('circle: press for the centre, drag to the radius', () => {
  const { done } = run('circle', [ev('down', 1, 1), ev('move', 4, 5), ev('up', 4, 5)]);
  assert.deepEqual(done, [{ type: 'circle', cx: 1, cy: 1, rKm: 5 }]);
  const draft = run('circle', [ev('down', 1, 1), ev('move', 1, 3)]).state;
  assert.deepEqual(draftShape(draft), { type: 'circle', cx: 1, cy: 1, rKm: 2 });
});

test('polygon: click points, close on the first vertex', () => {
  const r = run('polygon', [ev('down', 0, 0), ev('up', 0, 0), ev('down', 10, 0), ev('down', 10, 10), ev('move', 0.5, 0.5)]);
  assert.equal(r.state.points.length, 3);
  assert.deepEqual(closeTarget(r.state), { id: 'first-vertex', kind: 'vertex', name: 'First point', xKm: 0, yKm: 0 });
  // 0.5 km = 5 px from the first vertex: inside the 12 px close radius
  const end = drawReduce(r.state, ev('down', 0.5, 0.5));
  assert.deepEqual(end.completed, { type: 'polygon', points: [[0, 0], [10, 0], [10, 10]] });
  assert.deepEqual(end.state, initialDraw('polygon'));
  // 2 km = 20 px: just another vertex
  const more = drawReduce(r.state, ev('down', 2, 0));
  assert.equal(more.completed, undefined);
  assert.equal(more.state.points.length, 4);
  assert.equal(CLOSE_RADIUS_PX, 12);
});

test('polygon: the close test uses current pixels when kmPerPx is given', () => {
  const r = run('polygon', [ev('down', 0, 0), ev('down', 10, 0), ev('down', 10, 10)]);
  // after zooming in, 1 km is 40 px: 0.5 km off is 20 px, too far to close
  const far = drawReduce(r.state, ev('down', 0.5, 0, { kmPerPx: 0.025 }));
  assert.equal(far.completed, undefined);
  const near = drawReduce(r.state, ev('down', 0.2, 0, { kmPerPx: 0.025 }));
  assert.equal(near.completed.type, 'polygon');
});

test('polygon: fewer than 3 points does not close; no closeTarget before 3 points', () => {
  const r = run('polygon', [ev('down', 0, 0), ev('down', 10, 0)]);
  assert.equal(closeTarget(r.state), null);
  const back = drawReduce(r.state, ev('down', 0.2, 0));
  assert.equal(back.completed, undefined);
  const dbl = run('polygon', [ev('down', 0, 0), ev('down', 10, 0), ev('down', 10, 0), ev('dblclick', 10, 0)]);
  assert.equal(dbl.done.length, 0);
  assert.equal(dbl.state.points.length, 2);              // the double-click duplicate is gone
});

test('polygon: double-click closes and drops the duplicate vertex', () => {
  const events = [ev('down', 0, 0), ev('up', 0, 0), ev('down', 10, 0), ev('up', 10, 0),
    ev('down', 10, 10), ev('up', 10, 10), ev('down', 10, 10), ev('up', 10, 10), ev('dblclick', 10, 10)];
  const { done } = run('polygon', events);
  assert.deepEqual(done, [{ type: 'polygon', points: [[0, 0], [10, 0], [10, 10]] }]);
});

test('route: double-click finishes with at least 2 points', () => {
  const one = run('route', [ev('down', 0, 0), ev('down', 0, 0), ev('dblclick', 0, 0)]);
  assert.equal(one.done.length, 0);
  const { done, state } = run('route', [ev('down', 0, 0), ev('down', 3, 4), ev('down', 3, 4), ev('dblclick', 3, 4)]);
  assert.deepEqual(done, [{ type: 'route', points: [[0, 0], [3, 4]] }]);
  assert.deepEqual(state, initialDraw('route'));
});

test('route: Enter without coordinates finishes; draft follows the cursor', () => {
  const r = run('route', [ev('down', 0, 0), ev('down', 3, 4), ev('move', 6, 4)]);
  assert.deepEqual(draftShape(r.state), { type: 'route', points: [[0, 0], [3, 4], [6, 4]], open: true });
  const end = drawReduce(r.state, key('Enter'));
  assert.deepEqual(end.completed, { type: 'route', points: [[0, 0], [3, 4]] });
});

test('Escape cancels, Backspace removes the last vertex', () => {
  const r = run('polygon', [ev('down', 0, 0), ev('down', 10, 0), ev('down', 10, 10)]);
  const back = drawReduce(r.state, key('Backspace')).state;
  assert.deepEqual(back.points, [[0, 0], [10, 0]]);
  assert.equal(back.pxs.length, 2);
  const empty = drawReduce(drawReduce(back, key('Backspace')).state, key('Backspace')).state;
  assert.deepEqual(drawReduce(empty, key('Backspace')).state.points, []);     // nothing left to remove is fine
  assert.deepEqual(drawReduce(r.state, key('Escape')).state, initialDraw('polygon'));
  const rect = run('rect', [ev('down', 0, 0), ev('move', 4, 4)]);
  assert.deepEqual(drawReduce(rect.state, key('Escape')).state, initialDraw('rect'));
  assert.deepEqual(drawReduce(rect.state, key('Backspace')).state, initialDraw('rect'));
  assert.equal(drawReduce(rect.state, key('Escape')).completed, undefined);
});

test('keyboard: Enter at the crosshair, twice for a rectangle or circle', () => {
  const rect = run('rect', [key('Enter', 0, 0), key('Enter', 4, 2)]);
  assert.deepEqual(rect.done, [{ type: 'rect', x0: 0, y0: 0, x1: 4, y1: 2 }]);
  const circle = run('circle', [key('Enter', 0, 0), key('Enter', 0, 3)]);
  assert.deepEqual(circle.done, [{ type: 'circle', cx: 0, cy: 0, rKm: 3 }]);
  // the same spot twice does not make an empty shape; the anchor stays
  const same = run('rect', [key('Enter', 1, 1), key('Enter', 1, 1)]);
  assert.equal(same.done.length, 0);
  assert.deepEqual(same.state.anchor, [1, 1]);
  assert.equal(same.state.dragging, false);
});

test('keyboard: polygon by Enter, closed on the first vertex or by Enter twice', () => {
  const closed = run('polygon', [key('Enter', 0, 0), key('Enter', 4, 0), key('Enter', 4, 4), key('Enter', 0, 0)]);
  assert.deepEqual(closed.done, [{ type: 'polygon', points: [[0, 0], [4, 0], [4, 4]] }]);
  const twice = run('polygon', [key('Enter', 0, 0), key('Enter', 4, 0), key('Enter', 4, 4), key('Enter', 4, 4)]);
  assert.deepEqual(twice.done, [{ type: 'polygon', points: [[0, 0], [4, 0], [4, 4]] }]);
  const route = run('route', [key('Enter', 0, 0), key('Enter', 2, 0), key('Enter', 2, 0)]);
  assert.deepEqual(route.done, [{ type: 'route', points: [[0, 0], [2, 0]] }]);
  const other = drawReduce(initialDraw('polygon'), key('a', 1, 1));
  assert.deepEqual(other.state, initialDraw('polygon'));
});

test('draftShape is null with nothing drawn; events without coordinates are ignored', () => {
  for (const tool of ['select', 'rect', 'circle', 'polygon', 'route']) assert.equal(draftShape(initialDraw(tool)), null);
  const s = initialDraw('rect');
  assert.equal(drawReduce(s, { type: 'down' }).state, s);
  assert.equal(drawReduce(s, { type: 'move' }).state, s);
  assert.equal(drawReduce(s, null).state, s);
  assert.equal(initialDraw().tool, 'select');
});

// ---------- third wave (correctness review I1, I2) ----------
test('a zoom between two clicks does not merge far-apart vertices (review I1)', () => {
  // zoom 12 on a 1000 px frame: 0.0533 km/px; zoom 1: 0.64 km/px
  const fine = 640 / 12 / 1000, coarse = 0.64;
  let s = initialDraw('route');
  s = drawReduce(s, { type: 'down', xKm: 0, yKm: 0, px: 500, py: 500, kmPerPx: fine }).state;
  s = drawReduce(s, { type: 'down', xKm: 100, yKm: 0, px: 502, py: 500, kmPerPx: coarse }).state;
  s = drawReduce(s, { type: 'down', xKm: 100, yKm: 0, px: 502, py: 500, kmPerPx: coarse }).state;   // the double-click's second press
  const r = drawReduce(s, { type: 'dblclick', xKm: 100, yKm: 0, px: 502, py: 500, kmPerPx: coarse });
  assert.deepEqual(r.completed, { type: 'route', points: [[0, 0], [100, 0]] });
  // without kmPerPx the old pixel rule still merges a double-click
  const old = run('route', [ev('down', 0, 0), ev('down', 5, 0), ev('down', 5.1, 0), ev('dblclick', 5.1, 0)]);
  assert.deepEqual(old.done[0].points, [[0, 0], [5, 0]]);
});

test('a polygon whose outline crosses itself is rejected, and drawing starts again (review I2)', () => {
  const r = run('polygon', [ev('down', 0, 0), ev('down', 10, 10), ev('down', 10, 0), ev('down', 0, 10)]);
  const end = drawReduce(r.state, { type: 'dblclick', xKm: 0, yKm: 10, px: 0, py: -100 });
  assert.equal(end.completed, undefined);
  assert.equal(end.rejected, 'self-intersecting');
  assert.deepEqual(end.state, initialDraw('polygon'));
  const ok = run('polygon', [ev('down', 0, 0), ev('down', 10, 0), ev('down', 10, 10), ev('down', 0, 10), ev('dblclick', 0, 10)]);
  assert.equal(ok.done.length, 1);
});
