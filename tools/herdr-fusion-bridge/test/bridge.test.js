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