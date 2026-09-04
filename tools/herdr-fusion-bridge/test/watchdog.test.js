// watchdog.test.js — proves the core liveness rule: "real progress" is a
// discrete state/event change, never a log line. A task streaming log lines
// with a frozen state/seq is a REAL STALL once the window elapses.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Watchdog, createWatchdog, isRealStall } from '../src/watchdog.js';
import { fakeClock } from '../src/clock.js';
import { loadConfig } from '../src/config.js';

test('a task with real progress resets its stall window', () => {
  const clock = fakeClock(0);
  const wd = new Watchdog({ watchDogTimeoutMs: 1000, clock });
  wd.recordProgress('T-1');
  assert.equal(wd.lastProgressAt('T-1'), 0);
  clock.advance(800);
  assert.equal(wd.isStalled('T-1'), false);
  wd.recordProgress('T-1'); // real progress at t=800
  clock.advance(800); // t=1600, since last progress 800 < 1000
  assert.equal(wd.isStalled('T-1'), false);
  clock.advance(300); // t=1900, since last progress 1100 >= 1000
  assert.equal(wd.isStalled('T-1'), true);
});

test('a task with NO discrete change for the window is a real stall', () => {
  const clock = fakeClock(0);
  const wd = new Watchdog({ watchDogTimeoutMs: 2000, clock });
  wd.recordProgress('T-1', 0);
  clock.advance(1500);
  assert.equal(wd.isStalled('T-1'), false);
  clock.advance(600); // t=2100 > 2000
  assert.equal(wd.isStalled('T-1'), true);
  assert.equal(wd.stallElapsed('T-1'), 2100);
  assert.equal(wd.remainingStall('T-1'), 0);
});

test('LOG LINES DO NOT COUNT AS PROGRESS — churn never masks a stall', () => {
  const clock = fakeClock(0);
  const wd = new Watchdog({ watchDogTimeoutMs: 1000, clock });
  wd.recordProgress('T-1', 0);
  // A task streams log lines every 100ms but never makes a discrete change.
  for (let t = 100; t <= 20000; t += 100) {
    clock.advance(100);
    wd.observeLogLine('T-1', clock.now());
  }
  // Even after a long, noisy log stream, the task is stalled:
  assert.equal(wd.isStalled('T-1'), true);
  // ...and the log volume did not move progress forward.
  assert.equal(wd.lastProgressAt('T-1'), 0);
  // lastLogAt is recorded as context, but never as progress.
  assert.ok(wd.lastLogAt('T-1') >= 20000);
});

test('a task that never makes progress and is never seeded is not marked stalled', () => {
  const clock = fakeClock(0);
  const wd = new Watchdog({ watchDogTimeoutMs: 1000, clock });
  clock.advance(5000);
  assert.equal(wd.isStalled('S-1'), false);
  assert.equal(wd.hasProgress('S-1'), false);
});

test('observeSignature credits progress only when the signature changes', () => {
  const clock = fakeClock(0);
  const wd = new Watchdog({ watchDogTimeoutMs: 1000, clock });
  // First observation of a signature: treated as a discrete change (seeded).
  assert.equal(wd.observeSignature('T-1', 'active|1'), true);
  assert.equal(wd.lastProgressAt('T-1'), 0);
  // Same signature again: NOT a change — no progress credited.
  assert.equal(wd.observeSignature('T-1', 'active|1'), false);
  // Signature change: progress credited.
  clock.advance(500);
  assert.equal(wd.observeSignature('T-1', 'active|2'), true);
  assert.equal(wd.lastProgressAt('T-1'), 500);
});

test('isRealStall treats log churn with a frozen signature as catastrophic stall', () => {
  const clock = fakeClock(0);
  const wd = new Watchdog({ watchDogTimeoutMs: 500, clock });
  wd.recordProgress('T-1', 0);
  // Seed the (frozen) signature so the first observeSignature is not counted
  // as a discrete change.
  wd.diffSignature('T-1', 'blocked|0');
  // Feed a frozen signature repeatedly with logs — each feed advances time but
  // the signature never changes.
  for (let i = 0; i < 10; i += 1) {
    clock.advance(100);
    isRealStall({ watchdog: wd, taskId: 'T-1', signature: 'blocked|0', logLines: 5, now: clock.now() });
  }
  // After 1s of a frozen signature with constant logs, it is a real stall.
  assert.equal(wd.isStalled('T-1', clock.now()), true);
  // A log line is never counted as the discrete event that resets the window.
  assert.equal(wd.lastProgressAt('T-1'), 0);
});

test('a changing signature with logs is NOT a stall (real progress)', () => {
  const clock = fakeClock(0);
  const wd = new Watchdog({ watchDogTimeoutMs: 500, clock });
  wd.recordProgress('T-1', 0);
  // Signature advances each 100ms step -> real progress, never a stall.
  for (let i = 1; i <= 10; i += 1) {
    clock.advance(100);
    isRealStall({ watchdog: wd, taskId: 'T-1', signature: `active|${i}`, logLines: 1, now: clock.now() });
    assert.equal(wd.isStalled('T-1', clock.now()), false);
  }
});

test('clear forgets a task entirely', () => {
  const clock = fakeClock(0);
  const wd = new Watchdog({ watchDogTimeoutMs: 500, clock });
  wd.recordProgress('T-1', 0);
  assert.equal(wd.hasProgress('T-1'), true);
  wd.clear('T-1');
  assert.equal(wd.hasProgress('T-1'), false);
  assert.equal(wd.isStalled('T-1', clock.now()), false);
});

test('createWatchdog reads the timeout from config', () => {
  const cfg = loadConfig({ watchDogTimeoutMs: 1234 }, {});
  const wd = createWatchdog(cfg, fakeClock(0));
  assert.equal(wd.timeout, 1234);
});

test('watchdog never creates dangling timers (no clock side effects)', () => {
  const clock = fakeClock(0);
  const wd = new Watchdog({ watchDogTimeoutMs: 1000, clock });
  wd.recordProgress('T-1', 0);
  // Advancing the fake clock and querying stalls creates no real interval.
  clock.advance(2000);
  assert.equal(wd.isStalled('T-1', clock.now()), true);
  assert.equal(clock.pendingTimers(), 0);
});