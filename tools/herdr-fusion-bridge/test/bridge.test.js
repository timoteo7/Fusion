// bridge.test.js — Supervisor core behavior.
//
// Proves: engine detection spacing (no busy loop), engine-absent skip, safe
// fail to a down transport via cooldown, task→executor→pane correlation, and
// start/transition event emission. Nothing here waits on real time.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Supervisor, stateToKind } from '../src/bridge.js';
import { fakeClock } from '../src/clock.js';
import { createLogger, memorySink } from '../src/logger.js';
import { FakeFusionClient, FakeHerdrClient, FakeNotifier } from '../src/adapters/fakes.js';
import { DedupNotifier, DeliveryBackoff } from '../src/adapters/notifier.js';
import { Watchdog } from '../src/watchdog.js';

import { loadConfig } from '../src/config.js';

function makeCfg(overrides = {}) {
  return loadConfig(
    { ...overrides }, // opts override
    {}, // env
  );
}

// Build a supervised harness with fakes and a fake clock.
function makeHarness({ config = null, enginePresent = false } = {}) {
  const clock = fakeClock(0);
  const cfg = config || makeCfg();
  const fusion = new FakeFusionClient();
  fusion.setEnginePresent(enginePresent);
  const herdr = new FakeHerdrClient();
  const notifier = new FakeNotifier();
  const sink = memorySink();
  const logger = createLogger({ sink, clock });
  const sup = new Supervisor({ fusion, herdr, notifier, logger, config: cfg, clock });
  return { sup, clock, cfg, fusion, herdr, notifier, sink, logger };
}

test('by default config engineRecheckMs is finite and used as recheck window', () => {
  const cfg = loadConfig({ engineRecheckMs: 5000 }, {});
  assert.equal(cfg.engineRecheckMs, 5000);
  assert.equal(cfg.tickIntervalMs, 1000);
});

test('engine-absent tick skips work and emits engine_absent once', async () => {
  const { sup, clock, cfg, fusion } = makeHarness({ enginePresent: false });
  const r1 = await sup.tick();
  assert.equal(r1.skipped, true);
  assert.equal(sup.lastTickResult.skipped, true);
  // Subsequent ticks within the recheck window stay skipped (no busy work).
  await clock.advance(cfg.tickIntervalMs);
  const r2 = await sup.tick();
  assert.equal(r2.skipped, true);
});

test('engine detection is re-spaced: never probes faster than engineRecheckMs', async () => {
  const cfg = makeCfg({ engineRecheckMs: 5000 });
  const { sup, clock, fusion } = makeHarness({ config: cfg, enginePresent: true });
  // Advance a bit and tick several times; each tick within the window must NOT
  // re-probe the engine.
  await clock.advance(1000);
  await sup.tick(); // first: probes (1)
  await clock.advance(1000);
  await sup.tick(); // within window: cached (still 1)
  await clock.advance(1000);
  await sup.tick(); // within window: cached
  assert.equal(fusion.transport.count('detectEngine'), 1, 'engine probe count should stay at 1');

  // After engineRecheckMs the next tick re-probes.
  await clock.advance(5000);
  await sup.tick();
  assert.equal(fusion.transport.count('detectEngine'), 2, 'engine should be re-probed after recheck window');
});

test('start() schedules ticks via the clock and stop() cancels cleanly (no busy loop)', async () => {
  const { sup, clock, cfg, fusion } = makeHarness({ enginePresent: true });
  sup.start();
  assert.equal(sup.isRunning(), true);
  // Ticks run at tickIntervalMs. Fire a couple of interval firings.
  await clock.advance(cfg.tickIntervalMs);
  assert.ok(sup.tickCount >= 1);
  assert.ok(clock.pendingTimers() >= 1, 'the interval timer should be pending');
  const stopped = sup.stop();
  assert.equal(stopped, true);
  assert.equal(sup.isRunning(), false);
  assert.equal(clock.pendingTimers(), 0, 'no timers after stop');
  assert.equal(sup.timer, null);
});

test('safe-fail: a throwing listTasks is caught, cooled down, and does not crash', async () => {
  const { sup, clock, cfg, fusion } = makeHarness({ enginePresent: true });
  // Make listTasks throw, simulating a down transport.
  fusion.transport.calls.length = 0;
  fusion.listTasks = async () => {
    throw new Error('fusion down');
  };
  // First tick: detect engine (present), then listTasks throws.
  const r = await sup.tick();
  assert.equal(r.skipped, true);
  assert.ok(r.error && r.error.includes('fusion down'));
  assert.equal(sup.inCooldown(clock.now()), true, 'should be in cooldown after a transport failure');
  // While in cooldown, subsequent ticks skip without re-probing the transport.
  const before = fusion.transport.count('listTasks');
  await clock.advance(cfg.tickIntervalMs);
  const r2 = await sup.tick();
  assert.equal(r2.skipped, true);
});

test('task->executor->pane correlation resolves pane and executor from adapters', async () => {
  const { sup, clock, fusion, herdr } = makeHarness({ enginePresent: true });
  herdr.addPane('P-1', true);
  herdr.mapPane('T-7', 'E-7', 'P-1');
  fusion.addTask({ taskId: 'T-7', state: 'active' });
  const r = await sup.tick();
  assert.equal(r.tasks, 1);
  assert.ok(r.events.some((e) => e.kind === 'start' && e.taskId === 'T-7'));
  const obs = sup.syncState().get('T-7');
  assert.equal(obs.paneId, 'P-1');
  // Executor was resolved via the fusion resolveExecutor.
  assert.equal(herdr.transport.count('resolvePane'), 1);
});

test('already-known panes do not re-resolve (correlation is cached)', async () => {
  const { sup, clock, fusion, herdr } = makeHarness({ enginePresent: true });
  herdr.addPane('P-1', true);
  herdr.mapPane('T-9', 'E-9', 'P-1');
  fusion.addTask({ taskId: 'T-9', executorId: 'E-9', paneId: 'P-1', state: 'active' });
  await sup.tick();
  const before = herdr.transport.count('resolvePane');
  await sup.tick();
  assert.equal(herdr.transport.count('resolvePane'), before, 'no redundant resolvePane after first tick');
});

test('state transitions emit stateToKind events; repeated same state deduplicates', async () => {
  const { sup, clock, fusion } = makeHarness({ enginePresent: true });
  fusion.addTask({ taskId: 'T-1', paneId: 'P-1', executorId: 'E-1', state: 'active' });
  await sup.tick(); // start
  fusion.setState('T-1', 'blocked');
  const r = await sup.tick();
  assert.ok(r.events.some((e) => e.kind === 'blocked'));
  // Same state again: no new transition event.
  const r2 = await sup.tick();
  assert.equal(r2.events.length, 0);
});

test('stateToKind maps blocked/error/completed and defaults to progress', () => {
  assert.equal(stateToKind('blocked'), 'blocked');
  assert.equal(stateToKind('error'), 'error');
  assert.equal(stateToKind('failed'), 'error');
  assert.equal(stateToKind('completed'), 'completed');
  assert.equal(stateToKind('done'), 'completed');
  assert.equal(stateToKind('active'), 'progress');
});

test('association change emits association_stale and updates correlation', async () => {
  const { sup, clock, fusion, herdr } = makeHarness({ enginePresent: true });
  herdr.addPane('P-1', true);
  herdr.addPane('P-2', true);
  herdr.mapPane('T-2', 'E-2', 'P-1');
  fusion.addTask({ taskId: 'T-2', executorId: 'E-2', state: 'active' });
  await sup.tick(); // start with P-1
  // The task moved panes.
  herdr.mapPane('T-2', 'E-2', 'P-2');
  fusion.setState('T-2', 'active');
  const r = await sup.tick();
  assert.ok(r.events.some((e) => e.kind === 'association_stale' && e.taskId === 'T-2'));
  assert.equal(sup.syncState().get('T-2').paneId, 'P-2');
});

test('stop() with no running loop returns false (idempotent shutdown)', () => {
  const { sup } = makeHarness();
  assert.equal(sup.stop(), false);
});

test('single-tick gag: an overlapping tick is skipped and logged tick_skipped, never stacked', async () => {
  const { sup, clock, cfg, fusion, sink } = makeHarness({ enginePresent: true });
  fusion.addTask({ taskId: 'T-1', state: 'in-progress' });
  // A listTasks that blocks until we release it: the first tick stays in
  // flight while a second tick arrives and must be skipped (gagged).
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const original = fusion.listTasks.bind(fusion);
  fusion.listTasks = async () => {
    await gate;
    return original();
  };
  const first = sup.tick();
  const second = await sup.tick();
  assert.equal(second.skipped, true, 'overlapping tick is skipped');
  assert.equal(second.reason, 'tick_in_flight');
  release();
  const done = await first;
  assert.equal(done.skipped, false, 'the original tick still completes');
  assert.ok(sink.records.some((r) => r.event === 'tick_skipped'), 'tick_skipped logged');
});

// ---------------------------------------------------------------------------
// Stall wiring (Watchdog.isStalled() → Supervisor scan → emit('stalled')).
// Uses the SAME Supervisor-as-installed-in-production shape: a real Watchdog
// passed to the constructor and a real DedupNotifier wrapping FakeNotifier for
// the dedup contract. The harness drives the poll path through sup.tick() and
// the log-line path through `watchdog.observeLogLine` (mirroring what the
// SSE onEvent handler in src/orchestrator.js would do).
// ---------------------------------------------------------------------------

function makeStallHarness({ timeoutMs = 1000, dedupWindowMs = 5000 } = {}) {
  const clock = fakeClock(0);
  const cfg = makeCfg({ watchDogTimeoutMs: timeoutMs, dedupWindowMs });
  const fusion = new FakeFusionClient();
  fusion.setEnginePresent(true);
  const herdr = new FakeHerdrClient();
  const fakeDelegate = new FakeNotifier();
  // The same DedupNotifier shape the CLI's `run` subcommand builds in
  // production. waitFn=() => {} makes backoff a no-op so ticks are synchronous
  // and the test never blocks on real timers.
  const notifier = new DedupNotifier({
    delegate: fakeDelegate,
    dedupWindowMs,
    clock,
    backoff: new DeliveryBackoff({ baseMs: 0, maxMs: 0, maxAttempts: 1 }),
    waitFn: () => {},
  });
  const sink = memorySink();
  const logger = createLogger({ sink, clock });
  const watchdog = new Watchdog({ watchDogTimeoutMs: timeoutMs, clock });
  const sup = new Supervisor({ fusion, herdr, notifier, logger, config: cfg, clock, watchdog });
  return { sup, clock, cfg, fusion, herdr, notifier, fakeDelegate, watchdog, sink, logger };
}

test('stall scan: frozen past window emits one stalled with payload {lastProgressMs, timeoutMs} and log churn does NOT reset', async () => {
  const { sup, clock, fusion, fakeDelegate, watchdog } = makeStallHarness();
  // A task streaming log lines but never advancing state/seq.
  fusion.addTask({ taskId: 'T-FROZEN', state: 'active', seq: 1, executorId: 'E-1', paneId: 'P-1' });
  await sup.tick(); // t=0: seeds signature (poll-path observeSignature credits lastProgressAt=0)
  // Stream log lines between t=0 and t=1100 — these must NOT credit progress.
  for (let i = 0; i < 10; i++) {
    clock.advance(100); // t=100, 200, ... 1000
    watchdog.observeLogLine('T-FROZEN');
  }
  // At t=1000 lastProgressAt is still 0 (log lines never credit).
  assert.equal(watchdog.lastProgressAt('T-FROZEN'), 0);
  // Advance past the timeout.
  clock.advance(100); // t=1100
  const r = await sup.tick();
  // Exactly ONE stalled in the FakeNotifier (the delegate underneath DedupNotifier).
  const stalled = fakeDelegate.notifications.filter((n) => n.kind === 'stalled');
  assert.equal(stalled.length, 1, 'exactly one stalled emitted on first stall');
  assert.equal(stalled[0].taskId, 'T-FROZEN');
  assert.equal(stalled[0].executorId, 'E-1');
  assert.equal(stalled[0].paneId, 'P-1');
  // Payload is the two-field {lastProgressMs, timeoutMs} from events.json.
  assert.deepEqual(stalled[0].payload, { lastProgressMs: 0, timeoutMs: 1000 });
  // The supervisor's per-scan events also push one stalled.
  const scanEvents = r.events.filter((e) => e.kind === 'stalled' && e.taskId === 'T-FROZEN');
  assert.equal(scanEvents.length, 1, 'one stalled pushed to r.events for the scan');
});

test('stall scan: within dedup window, a second emit is deduped; after window expiry, it re-emits', async () => {
  const { sup, clock, fusion, fakeDelegate, watchdog } = makeStallHarness({
    timeoutMs: 1000,
    dedupWindowMs: 5000,
  });
  fusion.addTask({ taskId: 'T-FROZEN', state: 'active', seq: 1, executorId: 'E-1', paneId: 'P-1' });
  await sup.tick(); // t=0 seeds
  clock.advance(1100);
  await sup.tick(); // t=1100 → first stalled (FakeNotifier now has 1 stalled)
  // Same stall continues: deduped within the 5000ms window.
  clock.advance(900); // t=2000
  await sup.tick();
  let stalled = fakeDelegate.notifications.filter((n) => n.kind === 'stalled');
  assert.equal(stalled.length, 1, 'deduped within 5000ms window — still 1 stalled');
  // Advance past the dedup window (window was stamped at t=1100, so 5000+1ms later it expires).
  clock.advance(5001); // t=7001
  await sup.tick();
  stalled = fakeDelegate.notifications.filter((n) => n.kind === 'stalled');
  assert.equal(stalled.length, 2, 'after dedup window expires, a new stalled is emitted');
  // Each emission has the same payload shape (timestamp fields reflect the new scan).
  assert.equal(stalled[1].payload.timeoutMs, 1000);
  assert.equal(stalled[1].payload.lastProgressMs, 0);
});

test('stall scan: a discrete state/seq change re-arms the window and suppresses the next stall', async () => {
  const { sup, clock, fusion, fakeDelegate, watchdog } = makeStallHarness();
  fusion.addTask({ taskId: 'T-FROZEN', state: 'active', seq: 1, executorId: 'E-1', paneId: 'P-1' });
  await sup.tick(); // t=0: seeds signature → lastProgressAt = 0
  clock.advance(1100);
  await sup.tick(); // t=1100 → emits stalled (FakeNotifier: 1)
  let stalled = fakeDelegate.notifications.filter((n) => n.kind === 'stalled');
  assert.equal(stalled.length, 1);
  // Discrete change: state 'active' → 'in-progress' (non-terminal). The poll
  // path's reconcileOne sees stateToKind('in-progress')='progress' and emits
  // a progress event; observeSignature diffs the new signature and credits
  // progress at the current tick time, re-arming the stall window.
  fusion.setState('T-FROZEN', 'in-progress');
  clock.advance(500); // t=1600
  const r = await sup.tick();
  assert.equal(watchdog.lastProgressAt('T-FROZEN'), 1600, 'discrete change re-credits lastProgressAt at tick time');
  // No new stalled since the change (window is fresh).
  stalled = fakeDelegate.notifications.filter((n) => n.kind === 'stalled');
  assert.equal(stalled.length, 1, 'discrete change suppresses the next stall');
  // The scan saw the new lastProgressAt, so result.events for this tick has
  // no stalled entry for T-FROZEN (progress yes; stalled no).
  const stalledInTick = r.events.filter((e) => e.kind === 'stalled' && e.taskId === 'T-FROZEN');
  assert.equal(stalledInTick.length, 0, 'scan skipped T-FROZEN (just re-armed)');
  // Wait past both the new stall window (from t=1600) AND the prior dedup
  // window (stamped at t=1100). At t=6500: stall elapsed = 6500-1600=4900 ≥
  // 1000 → isStalled true; dedup elapsed = 6500-1100=5400 ≥ 5000 → window
  // expired, so a new emit lands in the FakeNotifier.
  clock.advance(4900); // t=6500
  await sup.tick();
  stalled = fakeDelegate.notifications.filter((n) => n.kind === 'stalled');
  assert.equal(stalled.length, 2, 'a fresh stall after the re-arm emits a new stalled');
});

test('stall scan: terminal-state tasks (completed/done/error/failed) never emit stalled', async () => {
  const { sup, clock, fusion, fakeDelegate, watchdog } = makeStallHarness();
  fusion.addTask({ taskId: 'T-DONE', state: 'active', seq: 1, executorId: 'E-1', paneId: 'P-1' });
  await sup.tick(); // t=0: seeds
  // Move to a terminal state. The poll path emits a 'completed' event; the
  // signature changes → credits progress. The stall scan skips terminal.
  fusion.setState('T-DONE', 'completed');
  clock.advance(1100); // t=1100
  await sup.tick();
  // No stalled: the terminal exclusion fires.
  let stalled = fakeDelegate.notifications.filter((n) => n.kind === 'stalled' && n.taskId === 'T-DONE');
  assert.equal(stalled.length, 0, 'terminal state at first scan: no stalled');
  // Far past the window, still no stalled.
  clock.advance(20000); // t=21100
  await sup.tick();
  stalled = fakeDelegate.notifications.filter((n) => n.kind === 'stalled' && n.taskId === 'T-DONE');
  assert.equal(stalled.length, 0, 'terminal state held for 20s: still no stalled');
  // Other terminal variants: error, failed, done — all skipped.
  for (const terminal of ['error', 'failed', 'done']) {
    fusion.addTask({ taskId: `T-${terminal}`, state: 'active', seq: 1, executorId: 'E-X', paneId: 'P-X' });
    await sup.tick();
    fusion.setState(`T-${terminal}`, terminal);
    clock.advance(2000);
    await sup.tick();
    const s = fakeDelegate.notifications.filter((n) => n.kind === 'stalled' && n.taskId === `T-${terminal}`);
    assert.equal(s.length, 0, `terminal state "${terminal}" never emits stalled`);
  }
});

test('stall scan: engine-absent and transport-cooldown ticks emit nothing (early-return skip)', async () => {
  // Engine-absent: the engine detection step fails; _tickOnce returns before
  // reaching the stall scan, so no stalled can be emitted.
  const cfg = makeCfg({ watchDogTimeoutMs: 1000, dedupWindowMs: 5000 });
  const clock = fakeClock(0);
  const fusion = new FakeFusionClient();
  fusion.setEnginePresent(false);
  const herdr = new FakeHerdrClient();
  const fakeDelegate = new FakeNotifier();
  const notifier = new DedupNotifier({
    delegate: fakeDelegate,
    dedupWindowMs: cfg.dedupWindowMs,
    clock,
    backoff: new DeliveryBackoff({ baseMs: 0, maxMs: 0, maxAttempts: 1 }),
    waitFn: () => {},
  });
  const logger = createLogger({ sink: memorySink(), clock });
  const watchdog = new Watchdog({ watchDogTimeoutMs: cfg.watchDogTimeoutMs, clock });
  const sup = new Supervisor({ fusion, herdr, notifier, logger, config: cfg, clock, watchdog });
  // A task would stall but the engine is absent → skip the entire scan.
  fusion.addTask({ taskId: 'T-FROZEN', state: 'active', seq: 1, executorId: 'E-1', paneId: 'P-1' });
  await sup.tick(); // engine_absent
  clock.advance(2000);
  await sup.tick(); // still engine_absent
  clock.advance(2000);
  await sup.tick(); // still engine_absent
  const stalled = fakeDelegate.notifications.filter((n) => n.kind === 'stalled');
  assert.equal(stalled.length, 0, 'engine-absent: no stalled emitted');

  // Transport cooldown: a throwing listTasks triggers the cooldown. While
  // in cooldown, _tickOnce returns early (skip) so the stall scan never
  // runs even though the engine was present and the task would be stalled.
  const cfg2 = makeCfg({ watchDogTimeoutMs: 1000, dedupWindowMs: 5000 });
  const clock2 = fakeClock(0);
  const fusion2 = new FakeFusionClient();
  fusion2.setEnginePresent(true);
  const herdr2 = new FakeHerdrClient();
  const fakeDelegate2 = new FakeNotifier();
  const notifier2 = new DedupNotifier({
    delegate: fakeDelegate2,
    dedupWindowMs: cfg2.dedupWindowMs,
    clock: clock2,
    backoff: new DeliveryBackoff({ baseMs: 0, maxMs: 0, maxAttempts: 1 }),
    waitFn: () => {},
  });
  const watchdog2 = new Watchdog({ watchDogTimeoutMs: cfg2.watchDogTimeoutMs, clock: clock2 });
  const sup2 = new Supervisor({
    fusion: fusion2,
    herdr: herdr2,
    notifier: notifier2,
    logger: createLogger({ sink: memorySink(), clock: clock2 }),
    config: cfg2,
    clock: clock2,
    watchdog: watchdog2,
  });
  fusion2.addTask({ taskId: 'T-FROZEN', state: 'active', seq: 1, executorId: 'E-1', paneId: 'P-1' });
  fusion2.listTasks = async () => { throw new Error('fusion down'); };
  await sup2.tick(); // first tick: detect engine, listTasks throws → enterCooldown
  clock2.advance(2000);
  await sup2.tick(); // in cooldown: skip
  clock2.advance(2000);
  await sup2.tick(); // in cooldown: skip
  const stalled2 = fakeDelegate2.notifications.filter((n) => n.kind === 'stalled');
  assert.equal(stalled2.length, 0, 'transport-cooldown: no stalled emitted while in cooldown');
});