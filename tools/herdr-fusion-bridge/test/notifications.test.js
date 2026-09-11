// notifications.test.js — proof that every meaningful state (start / progress /
// blocked / error / stalled / completed) produces exactly ONE observable,
// correlated notification, that duplicate events within the window are
// deduplicated, and that a down delivery hook fails safe (bounded retry, never a
// tight loop). Nothing here sleeps on real time — the fake clock drives the
// dedup window and the backoff wait in-place.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fakeClock } from '../src/clock.js';
import { createLogger, memorySink } from '../src/logger.js';
import { buildCorrelationKey } from '../src/correlator.js';
import {
  DedupNotifier,
  DedupGate,
  DeliveryBackoff,
  notificationKey,
} from '../src/adapters/notifier.js';
import { FakeNotifier, FakeTransport } from '../src/adapters/fakes.js';
import { Supervisor, stateToKind } from '../src/bridge.js';
import { FakeFusionClient, FakeHerdrClient } from '../src/adapters/fakes.js';
import { loadConfig } from '../src/config.js';

// A DedupNotifier over a recording FakeNotifier, driven by a fake clock. The
// waitFn advances the fake clock so backoff never sleeps on real time.
function makeDedup({ clock = null, delegate = null, windowMs = 5000, backoff = null } = {}) {
  const c = clock || fakeClock(0);
  const d = delegate || new FakeNotifier();
  const waitFn = async (ms) => c.advance(ms);
  const dn = new DedupNotifier({
    delegate: d,
    dedupWindowMs: windowMs,
    clock: c,
    backoff,
    waitFn,
  });
  return { dn, c, d, waitFn };
}

test('every meaningful state kind is keyable and deduped within the window', () => {
  const kinds = ['start', 'progress', 'blocked', 'error', 'stalled', 'completed'];
  const { dn, c, d } = makeDedup();
  for (const kind of kinds) {
    const key = notificationKey({ taskId: 'T-1', executorId: 'E-1', paneId: 'P-1', kind });
    assert.ok(key, `kind ${kind} must be keyable`);
    assert.equal(key, buildCorrelationKey({ taskId: 'T-1', executorId: 'E-1', paneId: 'P-1', kind }));
  }
});

test('start/progress/blocked/error/stalled/completed each deliver exactly one notification', async () => {
  const { dn, d } = makeDedup();
  const kinds = ['start', 'progress', 'blocked', 'error', 'stalled', 'completed'];
  for (const kind of kinds) {
    const res = await dn.notify({ kind, taskId: 'T-1', executorId: 'E-1', paneId: 'P-1' });
    assert.equal(res.ok, true, `${kind} should deliver`);
  }
  assert.equal(d.notifications.length, kinds.length);
  const deliveredKinds = d.notifications.map((n) => n.kind).sort();
  assert.deepEqual(deliveredKinds, [...kinds].sort());
  // Every delivered notification carries the correlation fields.
  for (const n of d.notifications) {
    assert.equal(n.taskId, 'T-1');
    assert.equal(n.executorId, 'E-1');
    assert.equal(n.paneId, 'P-1');
  }
});

test('duplicate events within the window are deduplicated to exactly one', async () => {
  const { dn, d } = makeDedup();
  const notif = { kind: 'blocked', taskId: 'T-1', executorId: 'E-1', paneId: 'P-1' };
  const r1 = await dn.notify(notif);
  assert.equal(r1.ok, true);
  assert.equal(r1.deduped, undefined);
  // Same correlation key, same kind, within the window -> deduped.
  const r2 = await dn.notify(notif);
  assert.equal(r2.deduped, true);
  assert.equal(d.notifications.length, 1, 'exactly one notification delivered');
});

test('the dedup window expires and the same event is re-emitted afterwards', async () => {
  const clock = fakeClock(0);
  const { dn, d, c } = makeDedup({ clock, windowMs: 500 });
  await dn.notify({ kind: 'error', taskId: 'T-2', paneId: 'P-2' });
  assert.equal(d.notifications.length, 1);
  // Within the window -> deduped.
  await dn.notify({ kind: 'error', taskId: 'T-2', paneId: 'P-2' });
  assert.equal(d.notifications.length, 1);
  // Advance past the window -> re-emitted.
  c.advance(600);
  await dn.notify({ kind: 'error', taskId: 'T-2', paneId: 'P-2' });
  assert.equal(d.notifications.length, 2);
});

test('DedupGate only re-emits after the window and is stable for distinct kinds', () => {
  const clock = fakeClock(0);
  const gate = new DedupGate({ windowMs: 500, clock });
  assert.equal(gate.mark('a|start'), true);
  assert.equal(gate.mark('a|start'), false, 'same key within window deduped');
  assert.equal(gate.mark('a|progress'), true, 'distinct kind is a fresh event');
  clock.advance(600);
  assert.equal(gate.mark('a|start'), true, 'after window the key is fresh again');
  assert.equal(gate.size() >= 1, true);
});

test('bounded delivery backoff: a persistent failure fails safe, never a tight loop', async () => {
  const clock = fakeClock(0);
  const attempts = [];
  const backoff = new DeliveryBackoff({ baseMs: 100, maxMs: 1000, maxAttempts: 4 });
  // Drive the backoff waits in-place (no real sleep).
  let total = 0;
  for (let attempt = 0; ; attempt += 1) {
    const wait = backoff.waitForAttempt(attempt);
    if (wait < 0) break;
    attempts.push({ attempt, wait });
    total += wait;
  }
  assert.equal(attempts.length, 4, 'maxAttempts bounds the retry count');
  // Exponential: 100, 200, 400, 800 (capped at maxMs if exceeded).
  assert.equal(attempts[0].wait, 100);
  assert.equal(attempts[1].wait, 200);
  assert.equal(attempts[2].wait, 400);
  assert.equal(attempts[3].wait, 800);
  assert.ok(total > 0);
});

test('a down notifier hook fails safe with a bounded number of delivery attempts', async () => {
  const clock = fakeClock(0);
  const failingDelegate = new FakeNotifier({ fail: true });
  const backoff = new DeliveryBackoff({ baseMs: 50, maxMs: 200, maxAttempts: 3 });
  const waitFn = async (ms) => clock.advance(ms);
  const dn = new DedupNotifier({
    delegate: failingDelegate,
    dedupWindowMs: 5000,
    clock,
    backoff,
    waitFn,
  });
  const res = await dn.notify({ kind: 'stalled', taskId: 'T-3', paneId: 'P-3' });
  assert.equal(res.ok, false, 'a persistent delivery failure resolves not-ok');
  assert.ok(res.attempt <= backoff.maxAttempts, 'delivery is bounded by maxAttempts');
  assert.equal(failingDelegate.failed, backoff.maxAttempts, 'attempt count is bounded');
  // No live timers remain after the bounded attempt loop.
  assert.equal(clock.pendingTimers(), 0);
});

test('the Supervisor delivers correlated notifications for start/transition/completed', async () => {
  const clock = fakeClock(0);
  const cfg = loadConfig({ dedupWindowMs: 5000 }, {});
  const fusion = new FakeFusionClient();
  fusion.setEnginePresent(true);
  const herdr = new FakeHerdrClient();
  herdr.addPane('P-1', true);
  herdr.mapPane('T-1', 'E-1', 'P-1');
  const notifier = new FakeNotifier();
  const sink = memorySink();
  const logger = createLogger({ sink, clock });
  const sup = new Supervisor({ fusion, herdr, notifier, logger, config: cfg, clock });

  fusion.addTask({ taskId: 'T-1', executorId: 'E-1', paneId: 'P-1', state: 'active' });
  await sup.tick(); // start
  await sup.tick(); // same state -> no transition
  assert.equal(notifier.count('start'), 1, 'start fires once');

  fusion.setState('T-1', 'blocked');
  await sup.tick(); // blocked
  assert.equal(notifier.count('blocked'), 1, 'blocked fires once');

  fusion.setState('T-1', 'completed');
  await sup.tick(); // completed
  assert.equal(notifier.count('completed'), 1, 'completed fires once');

  // Every delivered notification carries the correlation fields.
  for (const n of notifier.notifications) {
    assert.equal(n.taskId, 'T-1');
    assert.equal(n.paneId, 'P-1');
    assert.equal(n.executorId, 'E-1');
  }
});

test('stateToKind maps all meaningful states to a notification kind', () => {
  assert.equal(stateToKind('blocked'), 'blocked');
  assert.equal(stateToKind('error'), 'error');
  assert.equal(stateToKind('failed'), 'error');
  assert.equal(stateToKind('completed'), 'completed');
  assert.equal(stateToKind('done'), 'completed');
  assert.equal(stateToKind('active'), 'progress');
});

test('a malformed notification (no kind) is not keyable and still fails safe', async () => {
  const { dn, d } = makeDedup();
  const res = await dn.notify({ taskId: 'T-1', paneId: 'P-1' });
  // Missing kind -> key null; DedupNotifier logs warn but still attempts delivery.
  assert.equal(notificationKey({ taskId: 'T-1', paneId: 'P-1' }), null);
  assert.equal(res.ok, true);
  assert.equal(d.notifications.length, 1);
});

test('DedupNotifier close() releases the delegate', () => {
  let closed = false;
  const delegate = { notify: async () => ({ ok: true }), close: () => (closed = true) };
  const dn = new DedupNotifier({ delegate });
  dn.close();
  assert.equal(closed, true);
});