// sse-watcher.test.js — resilient SSE consumption: reconnect with bounded
// exponential backoff + jitter (never a busy loop), event dedup, and clean
// shutdown that aborts the in-flight stream and cancels the reconnect schedule.
//
// All reconnects are driven through a CONTROLLED wait gate rather than real
// timers, so every test terminates and there is no wall-clock dependence.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fakeClock } from '../src/clock.js';
import { SseWatcher, eventKey } from '../src/watchers/sse-watcher.js';
import { createLogger, memorySink } from '../src/logger.js';
import { loadConfig } from '../src/config.js';

// A fusion client whose streamEvents yields a SCRIPTED sequence of stream
// lifetimes. Each call consumes one lifetime (one reconnect). A lifetime may
// yield events and/or throw once (a down transport).
function makeFusionWithStream(cycles) {
  return {
    calls: 0,
    async *streamEvents({ signal } = {}) {
      if (signal && signal.aborted) {
        return;
      }
      const idx = this.calls;
      this.calls += 1;
      // Impose a microtask tick so the generator actually suspends (matches the
      // real async generator that yields over an HTTP reader).
      await Promise.resolve();
      const cycle = cycles[idx] || { events: [] };
      if (cycle.error) {
        throw cycle.error;
      }
      for (const e of cycle.events) {
        yield e;
      }
    },
  };
}

// A controlled reconnect gate: the watcher's backoff wait blocks on `release`,
// which the test resolves to allow exactly one more loop iteration.
function makeGate() {
  let pending = null;
  const waitFn = (ms) =>
    new Promise((resolve) => {
      pending = { resolve, ms };
    });
  return {
    waitFn,
    release() {
      const p = pending;
      if (p) {
        pending = null;
        p.resolve(true);
      }
    },
  };
}

// Flush the microtask queue generously so a started watcher reaches the state
// being asserted (its consume loop and the generator both suspend on ticks).
async function pump(n = 16) {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve();
  }
}

function makeWatcher({ cycles = [], onEvent = null, config = null, clock = null } = {}) {
  const c = clock || fakeClock(0);
  const cfg = config || loadConfig({ backoffBaseMs: 100, backoffMaxMs: 1000, dedupWindowMs: 500 }, {});
  const fusion = makeFusionWithStream(cycles);
  const gate = makeGate();
  const sink = memorySink();
  const logger = createLogger({ sink, clock: c });
  const watcher = new SseWatcher({
    fusion,
    onEvent,
    logger,
    config: cfg,
    clock: c,
    waitFn: gate.waitFn,
    rand: () => 0.5, // deterministic jitter (mid-range)
  });
  return { watcher, fusion, gate, c, cfg, sink };
}

test('events are delivered to onEvent and deduped by SSE id within the window', async () => {
  const seen = [];
  const { watcher, fusion, gate } = makeWatcher({
    cycles: [{ events: [{ id: '1', event: 'progress', data: { taskId: 'T-1', seq: 1 } }] }],
    onEvent: (ev) => seen.push(ev),
  });
  const loop = watcher.start();
  await pump();
  assert.equal(seen.length, 1);
  assert.equal(watcher.eventsSeen, 1);
  assert.equal(seen[0].id, '1');
  // A replay of the same id within the window is deduped.
  const again = watcher.acceptEvent({ id: '1', event: 'progress', data: { taskId: 'T-1', seq: 1 } }, watcher.now());
  assert.equal(again, false, 'same id within window is deduped');
  watcher.stop();
  gate.release();
  await loop;
});

test('reconnect happens after a stream ends, gated by backoff (no busy loop)', async () => {
  const { watcher, fusion, gate } = makeWatcher({ cycles: [{ events: [] }, { events: [] }, { events: [] }] });
  const loop = watcher.start();
  await pump();
  assert.equal(watcher.reconnects, 0, 'first consume ended and is now waiting on the gate');
  // Reconnect costs one gate release each. Drive 2 reconnects.
  gate.release();
  await pump();
  gate.release();
  await pump();
  assert.equal(watcher.reconnects, 2, 'one reconnect per released backoff wait');
  // Backoff for a fresh failure index is a bounded, jittered delay.
  assert.ok(watcher.backoffFor(0) >= 80 && watcher.backoffFor(0) <= 120);
  watcher.stop();
  gate.release();
  await loop;
});

test('a throwing stream counts a failure and grows backoff, never an infinite loop', async () => {
  const { watcher, fusion, gate, sink } = makeWatcher({
    cycles: [
      { error: new Error('stream down') },
      { error: new Error('stream down') },
      { error: new Error('stream down') },
    ],
  });
  const loop = watcher.start();
  await pump();
  assert.equal(watcher.failures, 1, 'first failure counted');
  assert.equal(watcher.reconnects, 0, 'no reconnect until the backoff wait releases');
  gate.release();
  await pump();
  assert.equal(watcher.failures, 2, 'second failure counted');
  // Backoff is monotonic: later failures wait longer than earlier ones.
  assert.ok(watcher.backoffFor(1) >= watcher.backoffFor(0));
  assert.ok(watcher.backoffFor(2) >= watcher.backoffFor(1));
  watcher.stop();
  gate.release();
  await loop;
  assert.ok(sink.records.some((r) => r.event === 'sse_error'), 'sse_error logged');
});

test('clean shutdown aborts the stream and stops reconnecting', async () => {
  const { watcher, fusion, gate } = makeWatcher({ cycles: [{ events: [] }, { events: [] }] });
  const loop = watcher.start();
  await pump();
  assert.equal(watcher.running, true);
  const stopped = watcher.stop();
  assert.equal(stopped, true);
  assert.equal(watcher.running, false);
  assert.equal(watcher.stop(), false, 'stop() is idempotent');
  // Release the pending wait: the loop must NOT reconnect after stop.
  gate.release();
  await loop;
  assert.equal(watcher.reconnects, 0, 'no reconnect after shutdown');
});

test('stop() with no running loop returns false (idempotent shutdown)', () => {
  const { watcher } = makeWatcher();
  assert.equal(watcher.stop(), false);
  assert.equal(watcher.close(), false);
});

test('a missing/unconfigured SSE stream ends immediately with zero events (safe idle)', async () => {
  const seen = [];
  // cycles entry for the first call resolves to { events: [] } -> zero events.
  const { watcher, fusion, gate } = makeWatcher({
    cycles: [{ events: [] }],
    onEvent: (ev) => seen.push(ev),
  });
  const loop = watcher.start();
  await pump();
  assert.equal(seen.length, 0);
  assert.equal(watcher.eventsSeen, 0);
  watcher.stop();
  gate.release();
  await loop;
});

test('dedup window expiry re-accepts the same SSE id afterwards', async () => {
  const { watcher } = makeWatcher({ config: loadConfig({ dedupWindowMs: 500 }, {}) });
  assert.equal(watcher.acceptEvent({ id: '9' }, 0), true);
  assert.equal(watcher.acceptEvent({ id: '9' }, 300), false, 'within window deduped');
  assert.equal(watcher.acceptEvent({ id: '9' }, 600), true, 'after window re-accepted');
});

test('backoffFor is clamped to backoffMaxMs', async () => {
  const { watcher } = makeWatcher({ config: loadConfig({ backoffBaseMs: 100, backoffMaxMs: 400 }, {}) });
  // Even with a huge failure index, the raw delay clamps at maxMs; jitter (0.5)
  // keeps it within [0.8, 1.2] * 400.
  const clampBase = watcher.backoffFor(20);
  assert.ok(clampBase >= 320 && clampBase <= 480, 'clamped to max with jitter');
});

test('eventKey is stable, prefers SSE id, and distinguishes signatures', () => {
  assert.equal(eventKey({ id: '1', event: 'x' }), 'sse|1');
  assert.equal(eventKey({ id: '1', event: 'y' }), 'sse|1', 'id dominates');
  assert.notEqual(eventKey({ data: { taskId: 'A' } }), eventKey({ data: { taskId: 'B' } }));
  // Missing discriminators collapse to a deterministic value.
  assert.equal(eventKey(null), eventKey(undefined), 'null/undefined collapse deterministically');
});

test('a consumer callback failure never kills the watcher', async () => {
  let threw = 0;
  const { watcher, gate } = makeWatcher({
    cycles: [{ events: [{ id: '1', event: 'progress' }] }],
    onEvent: () => {
      threw += 1;
      throw new Error('consumer boom');
    },
  });
  const loop = watcher.start();
  await pump();
  assert.equal(threw, 1);
  assert.equal(watcher.eventsSeen, 1, 'event accepted even when consumer throws');
  assert.equal(watcher.running, true, 'watcher survives a consumer error');
  watcher.stop();
  gate.release();
  await loop;
});