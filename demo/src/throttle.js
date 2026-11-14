// At most one call per `ms`, and the last call always lands (a trailing call after the wait). Used for the
// inspector's live rows and the energy and relay cards while the playhead moves: during playback they update
// a few times a second; after the last jump (a pause, a scrub, a command) they show that last instant
// (phase-5 review F5).
//
// createThrottle(fn, ms, { now, setTimer, clearTimer }) → { call(), flush(), cancel() }
export function createThrottle(fn, ms, { now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let last = -Infinity, timer = null;
  const run = () => { timer = null; last = now(); fn(); };
  return {
    call() {
      const wait = last + ms - now();
      if (wait <= 0) { if (timer !== null) { clearTimer(timer); timer = null; } run(); return; }
      if (timer === null) timer = setTimer(run, wait);
    },
    flush() { if (timer !== null) { clearTimer(timer); run(); } },
    cancel() { if (timer !== null) { clearTimer(timer); timer = null; } },
  };
}
