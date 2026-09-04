// clock.js — injectable clock with real and manual/fake modes.
//
// All time-based assertions in the bridge (watchdog, backoff, dedup) go through
// a clock so tests never wait on real time. The provided modes are mutually
// exclusive; construct the one you need.

// Real clock backed by Date.now() / setTimeout / clearTimeout.
export function realClock() {
  return {
    mode: 'real',
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    // Create a Timer-like object whose cancellation is tracked for tests.
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

// Manual/fake clock: time is advanced explicitly by the test. setTimeout
// schedules callbacks that only fire when the test advances the clock enough
// and fires due callbacks. This is what lets watchdog/backoff/dedup tests
// complete instantly with no real sleep and no dangling timers.
export function fakeClock(startAt = 0) {
  let now = startAt;
  let nextId = 1;
  const timers = new Map(); // id -> { at, fn, intervalMs }
  const fired = [];

  function schedule(fn, ms, intervalMs = null) {
    const id = nextId++;
    // Negative/zero delay fires on the next tick (queue them immediately).
    timers.set(id, { at: now + Math.max(0, ms), fn, intervalMs });
    return id;
  }

  function advance(ms) {
    const target = now + ms;
    // Fire due timers in time order. Guard against infinite loops created by
    // a self-scheduling 0ms timer accumulated by a test bug.
    let guard = 0;
    while (true) {
      // Find the earliest pending timer at or before target.
      let earliest = null;
      let earliestAt = Infinity;
      for (const [id, t] of timers) {
        if (t.at <= target && t.at < earliestAt) {
          earliestAt = t.at;
          earliest = { id, timer: t };
        }
      }
      if (!earliest) {
        break;
      }
      now = earliestAt;
      const { id, timer } = earliest;
      fired.push({ id, at: now, intervalMs: timer.intervalMs });
      if (timer.intervalMs === null) {
        timers.delete(id);
      } else {
        timer.at = now + timer.intervalMs;
      }
      timer.fn();
      guard++;
      if (guard > 1_000_000) {
        throw new Error('fakeClock.advance: too many timer firings (possible infinite timer loop)');
      }
    }
    now = target;
    return now;
  }

  return {
    mode: 'fake',
    now: () => now,
    setTimeout: (fn, ms) => schedule(fn, ms),
    clearTimeout: (handle) => timers.delete(handle),
    setInterval: (fn, ms) => schedule(fn, ms, ms),
    clearInterval: (handle) => timers.delete(handle),
    advance,
    // Number of still-pending (not-yet-fired, not-cleared) timers. Tests assert
    // this is 0 after cleanup to prove no dangling timers remain.
    pendingTimers: () => timers.size,
    // A record of every timer that fired: [{ id, at, intervalMs }].
    fired,
  };
}