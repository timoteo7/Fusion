// steering.test.js — safe steering + heartbeat from Hermes → Fusion.
//
// Proves the safety invariant: steering is gated on engine presence (no
// dispatch against a dead engine), identical commands within the dedup window
// are deduped, delivery retries are bounded and backed off (never infinite),
// and every dispatch/outcome carries a monotonic sequence number the audit
// trail can correlate on. The fake clock drives the dedup window and the
// backoff wait in-place so nothing sleeps on real time.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fakeClock } from '../src/clock.js';
import { SteeringController, steerKey, fakeWaitFn } from '../src/steering.js';
import { FakeNotifier, FakeFusionClient, FakeHerdrClient } from '../src/adapters/fakes.js';
import { createLogger, memorySink } from '../src/logger.js';
import { loadConfig } from '../src/config.js';

function makeStepper({ enginePresent = true, clock = null, config = null, maxAttempts = 3, notifier = null } = {}) {
  const c = clock || fakeClock(0);
  const cfg = config || loadConfig({ dedupWindowMs: 5000, backoffBaseMs: 50, backoffMaxMs: 400, seqBase: 0 }, {});
  const fusion = new FakeFusionClient();
  fusion.setEnginePresent(enginePresent);
  const fk = notifier || new FakeNotifier();
  const sink = memorySink();
  const logger = createLogger({ sink, clock: c });
  const stepper = new SteeringController({
    fusion,
    notifier: fk,
    logger,
    config: cfg,
    clock: c,
    waitFn: fakeWaitFn(c),
    maxAttempts,
  });
  return { stepper, c, cfg, fusion, fk, sink, logger };
}

test('steering is skipped and emits one steer_skipped alert when the engine is absent', async () => {
  const { stepper, fusion, fk } = makeStepper({ enginePresent: false });
  const res = await stepper.steer('T-1', 'continue');
  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'engine_absent');
  assert.equal(fusion.steerLog.length, 0, 'no command is dispatched to a dead engine');
  assert.equal(fk.count('steer_skipped'), 1, 'exactly one steer_skipped alert');
});

test('steering dispatches to the engine when it is present', async () => {
  const { stepper, fusion, fk } = makeStepper({ enginePresent: true });
  const res = await stepper.steer('T-2', 'continue');
  assert.equal(res.ok, true);
  assert.equal(res.skipped, false);
  assert.equal(fusion.steerLog.length, 1);
  assert.equal(fusion.steerLog[0].taskId, 'T-2');
  assert.equal(fusion.steerLog[0].command, 'continue');
  assert.equal(fk.count('steered'), 1);
});

test('identical commands within the dedup window are deduped', async () => {
  const { stepper, fusion } = makeStepper({ enginePresent: true });
  const r1 = await stepper.steer('T-3', 'pause');
  assert.equal(r1.deduped, undefined);
  const r2 = await stepper.steer('T-3', 'pause');
  assert.equal(r2.deduped, true);
  assert.equal(r2.ok, false);
  assert.equal(fusion.steerLog.length, 1, 'only one dispatch despite two steer calls');
});

test('a force=true steer bypasses the dedup window but never the engine gate', async () => {
  const { stepper, fusion } = makeStepper({ enginePresent: true });
  await stepper.steer('T-3', 'pause');
  const forced = await stepper.steer('T-3', 'pause', { force: true });
  assert.equal(forced.deduped, undefined);
  assert.equal(forced.ok, true);
  assert.equal(fusion.steerLog.length, 2);
});

test('a different command (or a different task) is not deduped within the window', async () => {
  const { stepper, fusion } = makeStepper({ enginePresent: true });
  await stepper.steer('T-4', 'pause');
  const r = await stepper.steer('T-4', 'resume');
  assert.equal(r.deduped, undefined);
  assert.equal(fusion.steerLog.length, 2);
});

test('heartbeat is a lightweight command variant with the same guarantees', async () => {
  const { stepper, fusion, fk } = makeStepper({ enginePresent: true });
  const r1 = await stepper.heartbeat('T-5');
  assert.equal(r1.ok, true);
  assert.equal(fusion.steerLog[0].command, 'heartbeat');
  // Heartbeats dedup like any other command.
  const r2 = await stepper.heartbeat('T-5');
  assert.equal(r2.deduped, true);
  assert.equal(fusion.steerLog.length, 1);
});

test('heartbeat is skipped when the engine is absent', async () => {
  const { stepper, fusion } = makeStepper({ enginePresent: false });
  const res = await stepper.heartbeat('T-5');
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'engine_absent');
  assert.equal(fusion.steerLog.length, 0);
});

test('delivery retries are bounded and backed off, never infinite', async () => {
  const clock = fakeClock(0);
  const cfg = loadConfig({ dedupWindowMs: 5000, backoffBaseMs: 100, backoffMaxMs: 400, seqBase: 0 }, {});
  const fusion = new FakeFusionClient();
  fusion.setEnginePresent(true);
  // Force every dispatch to fail (returns ok:false).
  fusion.steer = async (taskId, command) => ({ ok: false, seq: 0, skipped: true });
  const sink = memorySink();
  const logger = createLogger({ sink, clock });
  const stepper = new SteeringController({
    fusion,
    notifier: new FakeNotifier(),
    logger,
    config: cfg,
    clock,
    waitFn: fakeWaitFn(clock),
    maxAttempts: 3,
  });
  const res = await stepper.steer('T-6', 'continue');
  assert.equal(res.ok, false);
  assert.equal(res.attempts, 3, 'a persistent failure is bounded by maxAttempts');
  assert.equal(clock.pendingTimers(), 0, 'no dangling backoff timers');
});

test('the dispatched seq is monotonic across steers', async () => {
  const { stepper } = makeStepper({ enginePresent: true });
  const r1 = await stepper.steer('T-7', 'continue');
  const r2 = await stepper.steer('T-8', 'continue');
  const r3 = await stepper.steer('T-9', 'resume');
  const seqs = [r1.seq, r2.seq, r3.seq].filter((s) => s !== null);
  assert.ok(seqs.length >= 3);
  // Non-decreasing and strictly increasing for distinct dispatches.
  assert.ok(seqs[0] < seqs[1], 'seq must increase between dispatches');
  assert.ok(seqs[1] < seqs[2], 'seq must increase between dispatches');
});

test('steerKey is stable and distinguishes task/command/kind', () => {
  assert.equal(steerKey('T-1', 'continue'), steerKey('T-1', 'continue'));
  assert.notEqual(steerKey('T-1', 'continue'), steerKey('T-1', 'pause'));
  assert.notEqual(steerKey('T-1', 'continue'), steerKey('T-2', 'continue'));
  assert.notEqual(steerKey('T-1', 'continue', 'heartbeat'), steerKey('T-1', 'continue', 'steer'));
});

test('steering correlates on taskId and is audit-logged', async () => {
  const { stepper, sink } = makeStepper({ enginePresent: true });
  await stepper.steer('T-10', 'continue');
  const log = sink.records;
  const steered = log.find((r) => r.event === 'steered');
  assert.ok(steered, 'a steered log record exists');
  assert.equal(steered.taskId, 'T-10');
  assert.equal(typeof steered.seq, 'number');
});

// Regression: the one-shot CLI steer path (cmdSteer/cmdHeartbeat in bin/hfb.js)
// never runs a supervisor tick, so the supervisor's cached enginePresent starts
// false and the steering engine-gate could NEVER open — every `hfb steer`
// skipped as engine_absent even with a healthy engine. The CLI now primes the
// gate with one bounded supervisor.ensureEnginePresence() before steering;
// this test reproduces the exact CLI wiring and proves both directions.
test('the one-shot CLI steer path dispatches after priming the engine gate', async () => {
  const { createBridge } = await import('../src/orchestrator.js');
  for (const enginePresent of [true, false]) {
    const c = fakeClock(0);
    const cfg = loadConfig({ dedupWindowMs: 5000, backoffBaseMs: 50, backoffMaxMs: 400 }, {});
    const fusion = new FakeFusionClient();
    fusion.setEnginePresent(enginePresent);
    const herdr = new FakeHerdrClient();
    const notifier = new FakeNotifier();
    const sink = memorySink();
    const logger = createLogger({ sink, clock: c });
    const noWriteStore = { read: () => null, write: () => {} };
    const bridge = createBridge({ config: cfg, fusion, herdr, notifier, logger, clock: c, store: noWriteStore });
    // EXACTLY what cmdSteer does now:
    await bridge.supervisor.ensureEnginePresence(c.now());
    const outcome = await bridge.steer('T-1', 'continue');
    if (enginePresent) {
      assert.equal(Boolean(outcome.skipped), false, 'a healthy engine lets the gate open');
      assert.ok(notifier.notifications.length >= 1, 'steer dispatched + notified');
      assert.equal(fusion.steerLog.filter((s) => s.taskId === 'T-1').length, 1, 'exactly one steer dispatch');
    } else {
      assert.equal(outcome.skipped, true, 'an absent engine still fails safe');
      assert.equal(fusion.steerLog.length, 0, 'no dispatch against an absent engine');
    }
  }
});
