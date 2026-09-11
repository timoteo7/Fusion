// shutdown.test.js — clean process shutdown.
//
// Proves the production lifecycle (the SAME createBridge wiring the CLI uses)
// shuts down cleanly: stop() stops the supervisor tick loop and the SSE watcher
// (aborting the in-flight stream and the reconnect schedule), persists state,
// releases the notifier, leaves NO pending timer or live handle, and is
// idempotent. The SIGINT/SIGTERM contract is proven by driving exactly the
// stop sequence the CLI's signal handlers invoke — no real long-running child
// is ever spawned, and every test terminates.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fakeClock } from '../src/clock.js';
import { createLogger, memorySink } from '../src/logger.js';
import { loadConfig } from '../src/config.js';
import { createBridge } from '../src/orchestrator.js';
import { FakeFusionClient, FakeHerdrClient, FakeNotifier } from '../src/adapters/fakes.js';
import { PersistentState } from '../src/state.js';

// A controlled SSE stream gate: the fake fusion client's streamEvents blocks
// until release(), modeling an in-flight stream at shutdown time.
function blockingFusion({ enginePresent = true } = {}) {
  const fusion = new FakeFusionClient();
  fusion.setEnginePresent(enginePresent);
  let release = null;
  const gate = () => new Promise((r) => { release = r; });
  let pendingGate = null;
  const originalStream = fusion.streamEvents.bind(fusion);
  fusion.streamEvents = async function *streamEvents(opts = {}) {
    pendingGate = gate();
    await pendingGate;
    pendingGate = null;
    yield* originalStream(opts);
  };
  return {
    fusion,
    releaseStream() {
      if (release) {
        const r = release;
        release = null;
        r();
      }
    },
    blocked() {
      return pendingGate !== null;
    },
  };
}

function makeHarness({ enginePresent = true } = {}) {
  const clock = fakeClock(0);
  const cfg = loadConfig(
    { tickIntervalMs: 100, engineRecheckMs: 500, dedupWindowMs: 500 },
    {},
  );
  const streamCtl = blockingFusion({ enginePresent });
  const fusion = streamCtl.fusion;
  fusion.addTask({ taskId: 'T-1', state: 'in-progress', executorId: 'E-1', paneId: 'P-1' });
  const herdr = new FakeHerdrClient();
  herdr.addPane({ paneId: 'P-1', alive: true });
  const fakeDelegate = new FakeNotifier();
  const sink = memorySink();
  const logger = createLogger({ sink, clock });
  const stateWrites = [];
  const store = {
    read: () => null,
    write: (data) => stateWrites.push(JSON.parse(JSON.stringify(data))),
  };
  const state = new PersistentState({ file: 'tmp-test-state.json', store, now: () => clock.now() });
  const bridge = createBridge({
    config: cfg,
    fusion,
    herdr,
    notifier: fakeDelegate,
    logger,
    clock,
    state,
  });
  return { bridge, clock, cfg, fusion, herdr, sink, state, stateWrites, streamCtl };
}

test('start/stop lifecycle: stop() releases every handle and is idempotent', async () => {
  const { bridge, clock, streamCtl } = makeHarness();
  assert.equal(bridge.start(), true, 'first start returns true');
  assert.equal(bridge.start(), false, 'second start is a no-op');
  // Run at least one tick so the supervisor holds a live interval timer.
  clock.advance(100);
  assert.ok(clock.pendingTimers() >= 1, 'supervisor interval is scheduled while running');

  // Simulate the signal path: stop exactly as the CLI's handler does.
  const stopped = bridge.stop();
  assert.ok(stopped >= 2, 'both the SSE watcher and supervisor were stopped');
  assert.equal(bridge.supervisor.isRunning(), false);
  assert.equal(bridge.sseWatcher.running, false);
  assert.equal(clock.pendingTimers(), 0, 'no dangling timer after shutdown');

  // Idempotent: a repeat stop (double signal) is harmless.
  assert.equal(bridge.stop(), 0);

  // Release the blocked stream gate: the aborted watcher must not process it.
  streamCtl.releaseStream();
  await Promise.resolve();
  assert.equal(bridge.sseWatcher.eventsSeen, 0, 'post-shutdown stream release is inert');
});

test('stop() persists state exactly once (survives restart for dedup markers)', async () => {
  const { bridge, state, stateWrites } = makeHarness();
  const saveSpy = state.save.bind(state);
  let saves = 0;
  state.save = () => {
    saves += 1;
    return saveSpy();
  };
  bridge.start();
  bridge.stop();
  bridge.stop();
  assert.equal(saves, 1, 'state saved exactly once across a double stop');
  assert.ok(stateWrites.length >= 1, 'store received the persisted snapshot');
  const persisted = stateWrites[stateWrites.length - 1];
  assert.ok(persisted.schemaVersion >= 1, 'persisted state is schema-versioned');
  assert.ok('tasks' in persisted && 'markers' in persisted, 'registry + markers persisted');
});

test('SIGINT and SIGTERM drive the same clean stop sequence (exit-0 equivalent)', async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const { bridge, clock } = makeHarness();
    bridge.start();
    clock.advance(100); // supervisor tick scheduled
    // The CLI registers process handlers that call bridge.stop() and exit 0;
    // prove the stop sequence they invoke leaves zero live handles.
    const stopped = bridge.stop();
    assert.ok(stopped >= 2, `${signal}: watcher + supervisor stopped`);
    assert.equal(clock.pendingTimers(), 0, `${signal}: no pending timer`);
    // The CLI then exits 0 — nothing above throws, so the exit is clean.
    bridge.stop();
  }
});

test('a full supervision pass works end-to-end and still shuts down cleanly', async () => {
  const { bridge, clock, fusion, streamCtl } = makeHarness();
  // Simulate an SSE event (discrete state change) reaching the bridge: real
  // progress is credited and the observation is persisted.
  const event = { id: '1', event: 'progress', data: { taskId: 'T-1', state: 'in-progress', seq: 5, executorId: 'E-1', paneId: 'P-1' } };
  bridge.sseWatcher.onEvent(event);
  await bridge.supervisor.tick();
  assert.equal(bridge.supervisor.tickCount, 1);
  assert.ok(bridge.watchdog.hasProgress('T-1'), 'SSE discrete change credited as real progress');
  assert.ok(bridge.state.task('T-1'), 'observation persisted into the registry');

  bridge.stop();
  assert.equal(clock.pendingTimers(), 0);
  streamCtl.releaseStream();
});

test('shutdown with the engine absent is still clean (safe-fail path)', async () => {
  const { bridge, clock, streamCtl } = makeHarness({ enginePresent: false });
  bridge.start();
  await bridge.supervisor.tick(); // engine_absent: skip, no spin
  assert.equal(bridge.supervisor.lastTickResult.skipped, true);
  bridge.stop();
  assert.equal(clock.pendingTimers(), 0);
  streamCtl.releaseStream();
});

test('notifier delegate is released on stop (no orphaned hook handles)', async () => {
  const { bridge } = makeHarness();
  bridge.start();
  bridge.stop();
  assert.ok((bridge.notifier.closeCount || 0) >= 1, 'DedupNotifier.close() released the delegate');
});
