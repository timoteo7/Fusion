// process-detector.test.js — the v2 process-event contract.
//
// Proves the schema/validator (schemaVersion 2, exactly six kinds, two-field
// progress payload) and the detector's rising-edge dedup, terminal re-arm,
// stall-on-timeout and association precedence. Everything runs on the fake
// clock with a deterministic adapter: no real timers, no randomness, no sleeps.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROCESS_KINDS,
  PROCESS_SCHEMA_VERSION,
  isProcessKind,
  isTerminalProcessKind,
  normalizeProcessId,
  validateProcessEvent,
} from '../src/process-events.js';
import { NullProcessStreamAdapter, ProcessStreamAdapter } from '../src/process-stream-adapter.js';
import { DEFAULT_STALL_TIMEOUT_MS, ProcessDetector, processSignature } from '../src/process-detector.js';
import { fakeClock } from '../src/clock.js';
import { FakeProcessStreamAdapter, loadProcessFixture } from './adapters/fake-process-stream.js';

// A minimal valid v2 event; individual tests mutate one field at a time.
function baseEvent(overrides = {}) {
  return {
    schemaVersion: 2,
    kind: 'process.started',
    processId: 'proc-1',
    timestamp: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateProcessEvent — the v2 schema gate.
// ---------------------------------------------------------------------------

describe('validateProcessEvent (schemaVersion 2)', () => {
  it('accepts every one of the six canonical kinds', () => {
    assert.equal(PROCESS_KINDS.length, 6, 'exactly six process kinds, no seventh');
    for (const kind of PROCESS_KINDS) {
      const res = validateProcessEvent(baseEvent({ kind }));
      assert.equal(res.ok, true, `${kind} must be accepted (${res.reason})`);
      assert.equal(res.reason, '');
    }
  });

  it('rejects an unknown (seventh) kind', () => {
    for (const kind of ['process.paused', 'process.retrying', 'process.started.again', 'started']) {
      const res = validateProcessEvent(baseEvent({ kind }));
      assert.equal(res.ok, false, `${kind} must be rejected`);
      assert.match(res.reason, /kind must be one of/);
    }
  });

  it('rejects a mismatched schemaVersion (v1 and any other version)', () => {
    for (const schemaVersion of [1, 3, '2', undefined]) {
      const res = validateProcessEvent(baseEvent({ schemaVersion }));
      assert.equal(res.ok, false, `schemaVersion ${String(schemaVersion)} must be rejected`);
      assert.match(res.reason, /schemaVersion must be 2/);
    }
    assert.equal(PROCESS_SCHEMA_VERSION, 2);
  });

  it('rejects a missing or malformed processId', () => {
    const missing = validateProcessEvent({ schemaVersion: 2, kind: 'process.started', timestamp: 1 });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /processId is required/);

    const malformed = validateProcessEvent(baseEvent({ processId: 42 }));
    assert.equal(malformed.ok, false);
    assert.match(malformed.reason, /processId must be a string or null/);
  });

  it('accepts an empty-string and a null processId (both are the unknown bucket)', () => {
    for (const processId of ['', null]) {
      const res = validateProcessEvent(baseEvent({ processId }));
      assert.equal(res.ok, true, `processId ${JSON.stringify(processId)} must be accepted (${res.reason})`);
    }
    assert.equal(normalizeProcessId(null), '');
    assert.equal(normalizeProcessId(''), '');
    assert.equal(normalizeProcessId(undefined), '');
    assert.equal(normalizeProcessId('proc-1'), 'proc-1');
  });

  it('rejects a missing or non-numeric timestamp', () => {
    const missing = validateProcessEvent({ schemaVersion: 2, kind: 'process.started', processId: 'p' });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /timestamp/);

    for (const timestamp of ['1000', null, NaN, Infinity]) {
      const res = validateProcessEvent(baseEvent({ timestamp }));
      assert.equal(res.ok, false, `timestamp ${String(timestamp)} must be rejected`);
    }
  });

  it('accepts the two-field progress payload and rejects the three-field variant', () => {
    const ok = validateProcessEvent(baseEvent({
      kind: 'process.heartbeat',
      payload: { lastProgressMs: 1000, timeoutMs: 120000 },
    }));
    assert.equal(ok.ok, true, ok.reason);

    const threeField = validateProcessEvent(baseEvent({
      kind: 'process.heartbeat',
      payload: { lastProgressMs: 1000, timeoutMs: 120000, state: 'active' },
    }));
    assert.equal(threeField.ok, false, 'a three-field payload is prohibited');
    assert.match(threeField.reason, /payload may only carry lastProgressMs, timeoutMs/);

    // Any other extra field is rejected the same way, and values must be numbers.
    assert.equal(validateProcessEvent(baseEvent({ payload: { message: 'boom' } })).ok, false);
    assert.equal(validateProcessEvent(baseEvent({ payload: { lastProgressMs: '1000' } })).ok, false);
    assert.equal(validateProcessEvent(baseEvent({ payload: 'nope' })).ok, false);
  });

  it('accepts an absent payload and rejects an empty correlationToken', () => {
    assert.equal(validateProcessEvent(baseEvent()).ok, true);
    assert.equal(validateProcessEvent(baseEvent({ correlationToken: 'T-1' })).ok, true);
    for (const correlationToken of ['', '   ', 42]) {
      const res = validateProcessEvent(baseEvent({ correlationToken }));
      assert.equal(res.ok, false, `correlationToken ${JSON.stringify(correlationToken)} must be rejected`);
    }
  });

  it('classifies terminal kinds and non-terminal kinds', () => {
    assert.equal(isProcessKind('process.stalled'), true);
    assert.equal(isProcessKind('process.paused'), false);
    for (const kind of ['process.completed', 'process.failed', 'process.exited']) {
      assert.equal(isTerminalProcessKind(kind), true, `${kind} is terminal`);
    }
    for (const kind of ['process.started', 'process.heartbeat', 'process.stalled']) {
      assert.equal(isTerminalProcessKind(kind), false, `${kind} is not terminal`);
    }
  });
});

// ---------------------------------------------------------------------------
// The adapter seam: the no-op default keeps every pre-v2 construction working.
// ---------------------------------------------------------------------------

describe('process stream adapter seam', () => {
  it('NullProcessStreamAdapter collects nothing and resolves nothing', async () => {
    const adapter = new NullProcessStreamAdapter();
    assert.ok(adapter instanceof ProcessStreamAdapter);
    assert.deepEqual(await adapter.collect(0), []);
    assert.equal(await adapter.getTaskForProcess('proc-1'), null);
  });

  it('a detector with no adapter wired emits nothing', async () => {
    const detector = new ProcessDetector({ heartbeatIntervalMs: 0, now: () => 0 });
    assert.deepEqual(await detector.collect(), []);
  });
});

// ---------------------------------------------------------------------------
// ProcessDetector — rising edge, association precedence, stall scan, bounds.
// ---------------------------------------------------------------------------

// Detector harness: a scripted fake adapter, a fake clock and a warn recorder.
function makeDetector({
  heartbeatIntervalMs = 0,
  stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
  adapter = null,
  warn = null,
} = {}) {
  const clock = fakeClock(0);
  const warnings = [];
  const theAdapter = adapter || new FakeProcessStreamAdapter();
  const detector = new ProcessDetector({
    adapter: theAdapter,
    heartbeatIntervalMs,
    stallTimeoutMs,
    now: () => clock.now(),
    warn: warn || ((...args) => warnings.push(args.join(' '))),
  });
  return { detector, adapter: theAdapter, clock, warnings };
}

describe('ProcessDetector rising-edge dedup', () => {
  it('processSignature treats null and \'\' processIds as the same bucket', () => {
    assert.equal(
      processSignature({ processId: null, kind: 'process.started' }),
      processSignature({ processId: '', kind: 'process.started' }),
    );
    assert.equal(
      processSignature({ processId: undefined, kind: 'process.started' }),
      processSignature({ processId: '', kind: 'process.started' }),
    );
    assert.notEqual(
      processSignature({ processId: 'proc-1', kind: 'process.started' }),
      processSignature({ processId: 'proc-2', kind: 'process.started' }),
    );
    assert.notEqual(
      processSignature({ processId: 'proc-1', kind: 'process.started' }),
      processSignature({ processId: 'proc-1', kind: 'process.heartbeat' }),
    );
  });

  it('emits a repeated same-kind observation exactly once', async () => {
    const { detector, adapter, clock } = makeDetector();
    const started = baseEvent({ processId: 'proc-1', correlationToken: 'T-1' });
    adapter.push(started);
    const first = await detector.collect(clock.now());
    assert.equal(first.length, 1);
    assert.equal(first[0].kind, 'process.started');
    assert.equal(first[0].taskId, 'T-1');

    // The same kind again (a fresh pull, a later tick): tracked, never re-emitted.
    adapter.push({ ...started, timestamp: 2000 });
    assert.deepEqual(await detector.collect(clock.now()), []);
    assert.deepEqual(await detector.collect(clock.now()), []);
  });

  it('a null and an empty processId dedup against each other (one emission)', async () => {
    const { detector, adapter, clock } = makeDetector();
    adapter.push(baseEvent({ processId: null, correlationToken: 'T-1' }));
    adapter.push(baseEvent({ processId: '', correlationToken: 'T-1' }));
    const emitted = await detector.collect(clock.now());
    assert.equal(emitted.length, 1, 'both unknown-process ids are one bucket');
    assert.equal(emitted[0].processId, '');
  });

  it('a terminal kind clears tracked state so a later process.started re-arms', async () => {
    const { detector, adapter, clock } = makeDetector();
    adapter.push(baseEvent({ kind: 'process.started', processId: 'proc-1', correlationToken: 'T-1' }));
    adapter.push(baseEvent({ kind: 'process.completed', processId: 'proc-1', correlationToken: 'T-1' }));
    adapter.push(baseEvent({ kind: 'process.started', processId: 'proc-1', correlationToken: 'T-1', timestamp: 3000 }));
    const emitted = await detector.collect(clock.now());
    assert.deepEqual(
      emitted.map((e) => e.kind),
      ['process.started', 'process.completed', 'process.started'],
      'the restart after a terminal kind is a fresh rising edge',
    );
    assert.equal(detector.lastKind.get('proc-1'), 'process.started');
  });

  it('a repeated terminal kind stays deduped', async () => {
    const { detector, adapter, clock } = makeDetector();
    adapter.push(baseEvent({ kind: 'process.exited', processId: 'proc-1', correlationToken: 'T-1' }));
    adapter.push(baseEvent({ kind: 'process.exited', processId: 'proc-1', correlationToken: 'T-1', timestamp: 2000 }));
    const emitted = await detector.collect(clock.now());
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].kind, 'process.exited');
  });
});

describe('ProcessDetector association precedence', () => {
  it('correlationToken wins and the adapter resolver is never consulted', async () => {
    const { detector, adapter, clock } = makeDetector();
    adapter.addAssociation('proc-1', 'T-OTHER');
    adapter.push(baseEvent({ processId: 'proc-1', correlationToken: 'T-1' }));
    const emitted = await detector.collect(clock.now());
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].taskId, 'T-1');
    assert.equal(emitted[0].associationSource, 'correlationToken');
    assert.deepEqual(adapter.lookups, [], 'the token path never falls through to the resolver');
  });

  it('falls back to the adapter process-to-task resolver', async () => {
    const { detector, adapter, clock } = makeDetector();
    adapter.addAssociation('proc-1', 'T-1');
    adapter.push(baseEvent({ processId: 'proc-1' }));
    const emitted = await detector.collect(clock.now());
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].taskId, 'T-1');
    assert.equal(emitted[0].associationSource, 'adapter');
    assert.deepEqual(adapter.lookups, ['proc-1']);
  });

  it('drops an unresolvable event with a warn and never emits it', async () => {
    const { detector, adapter, clock, warnings } = makeDetector();
    adapter.push(baseEvent({ processId: 'proc-ghost' }));
    adapter.push(baseEvent({ kind: 'process.started', processId: 'proc-ghost', timestamp: 2000 }));
    const emitted = await detector.collect(clock.now());
    assert.deepEqual(emitted, [], 'an unresolvable event is never emitted');
    assert.equal(warnings.length, 2, 'every dropped observation warns');
    assert.match(warnings[0], /dropped/);
    assert.match(warnings[0], /proc-ghost/);
    assert.equal(detector.dropped.length, 2);
    assert.equal(detector.dropped[0].reason, 'unassociated');
    assert.equal(detector.lastKind.has('proc-ghost'), false, 'a dropped event leaves no episode state');
  });

  it('uses console.warn by default (no injected warn recorder)', async () => {
    const original = console.warn;
    const calls = [];
    console.warn = (...args) => calls.push(args.join(' '));
    try {
      const adapter = new FakeProcessStreamAdapter();
      adapter.push(baseEvent({ processId: 'proc-ghost' }));
      const detector = new ProcessDetector({ adapter, heartbeatIntervalMs: 0, now: () => 0 });
      assert.deepEqual(await detector.collect(), []);
      assert.equal(calls.length, 1);
      assert.match(calls[0], /process event dropped/);
    } finally {
      console.warn = original;
    }
  });

  it('a resolver that throws drops the event instead of breaking the tick', async () => {
    const adapter = new FakeProcessStreamAdapter();
    adapter.getTaskForProcess = async () => {
      throw new Error('resolver down');
    };
    adapter.push(baseEvent({ processId: 'proc-1' }));
    const { detector, clock, warnings } = makeDetector({ adapter });
    assert.deepEqual(await detector.collect(clock.now()), []);
    assert.match(warnings.join('\n'), /process association failed/);
  });
});

describe('ProcessDetector stall scan (fake clock)', () => {
  it('synthesizes one process.stalled when the progress cursor outlives the window, then re-arms', async () => {
    const { detector, adapter, clock } = makeDetector();
    adapter.push(baseEvent({
      kind: 'process.heartbeat',
      processId: 'proc-1',
      correlationToken: 'T-1',
      payload: { lastProgressMs: 0, timeoutMs: 5000 },
    }));
    const first = await detector.collect(clock.now());
    assert.deepEqual(first.map((e) => e.kind), ['process.heartbeat']);

    clock.advance(4999);
    assert.deepEqual(await detector.collect(clock.now()), [], 'inside the window: no stall');

    clock.advance(1); // t=5000
    const stalled = await detector.collect(clock.now());
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0].kind, 'process.stalled');
    assert.equal(stalled[0].taskId, 'T-1');
    assert.equal(stalled[0].processId, 'proc-1');
    assert.equal(stalled[0].timestamp, 5000);
    assert.deepEqual(stalled[0].payload, { lastProgressMs: 0, timeoutMs: 5000 }, 'two-field progress payload only');

    clock.advance(1000);
    assert.deepEqual(await detector.collect(clock.now()), [], 'one stall per episode');

    // A fresh progress cursor re-arms: the next stall is earned again.
    adapter.push(baseEvent({
      kind: 'process.heartbeat',
      processId: 'proc-1',
      correlationToken: 'T-1',
      timestamp: 6000,
      payload: { lastProgressMs: 6000, timeoutMs: 5000 },
    }));
    clock.advance(0); // t=6000 (pull window is 0ms)
    const fresh = await detector.collect(clock.now());
    assert.deepEqual(fresh.map((e) => e.kind), ['process.heartbeat']);
    clock.advance(5000); // t=11000
    const again = await detector.collect(clock.now());
    assert.deepEqual(again.map((e) => e.kind), ['process.stalled'], 'a new episode earns a new stall');
    assert.deepEqual(again[0].payload, { lastProgressMs: 6000, timeoutMs: 5000 });
  });

  it('a frozen cursor does not re-arm the stall marker (heartbeat churn is not progress)', async () => {
    const { detector, adapter, clock } = makeDetector();
    const frozen = baseEvent({
      kind: 'process.heartbeat',
      processId: 'proc-1',
      correlationToken: 'T-1',
      payload: { lastProgressMs: 0, timeoutMs: 5000 },
    });
    adapter.push(frozen);
    await detector.collect(clock.now()); // t=0
    clock.advance(5000);
    const stalled = await detector.collect(clock.now());
    assert.deepEqual(stalled.map((e) => e.kind), ['process.stalled']);

    // Heartbeats keep arriving with the SAME frozen cursor: the kind rises
    // again, but the stall marker must not be cleared by a stalled heartbeat.
    adapter.push({ ...frozen, timestamp: 5500 });
    clock.advance(500);
    assert.deepEqual((await detector.collect(clock.now())).map((e) => e.kind), ['process.heartbeat']);
    clock.advance(10000); // t=15500, cursor still 0
    assert.deepEqual(await detector.collect(clock.now()), [], 'still the same stall episode');
  });

  it('uses the configured stallTimeoutMs when an event carries no timeoutMs', async () => {
    const { detector, adapter, clock } = makeDetector({ stallTimeoutMs: 3000 });
    adapter.push(baseEvent({
      kind: 'process.started',
      processId: 'proc-1',
      correlationToken: 'T-1',
      payload: { lastProgressMs: 0 },
    }));
    await detector.collect(clock.now());
    clock.advance(2999);
    assert.deepEqual(await detector.collect(clock.now()), []);
    clock.advance(1);
    const stalled = await detector.collect(clock.now());
    assert.equal(stalled[0].kind, 'process.stalled');
    assert.deepEqual(stalled[0].payload, { lastProgressMs: 0, timeoutMs: 3000 });
  });

  it('a terminal kind clears the episode, so no stall is reported afterwards', async () => {
    const { detector, adapter, clock } = makeDetector({ stallTimeoutMs: 1000 });
    adapter.push(baseEvent({
      kind: 'process.heartbeat',
      processId: 'proc-1',
      correlationToken: 'T-1',
      payload: { lastProgressMs: 0, timeoutMs: 1000 },
    }));
    adapter.push(baseEvent({ kind: 'process.completed', processId: 'proc-1', correlationToken: 'T-1', timestamp: 100 }));
    await detector.collect(clock.now());
    clock.advance(60000);
    assert.deepEqual(await detector.collect(clock.now()), [], 'the completed process is not a stall');
  });
});

describe('ProcessDetector bounds and safe-fail', () => {
  it('pulls the adapter at most once per heartbeatIntervalMs', async () => {
    const { detector, adapter, clock } = makeDetector({ heartbeatIntervalMs: 30000 });
    await detector.collect(clock.now()); // t=0 → pull 1
    clock.advance(1000);
    await detector.collect(clock.now()); // within window → no pull
    clock.advance(1000);
    await detector.collect(clock.now());
    assert.equal(adapter.pulls.length, 1, 'no tight probe loop');
    clock.advance(28000); // t=30000
    await detector.collect(clock.now());
    assert.equal(adapter.pulls.length, 2, 'the next window pulls again');
    assert.equal(detector.pullCount, 2);
  });

  it('rejects an invalid observation with a warn and never emits it', async () => {
    const { detector, adapter, clock, warnings } = makeDetector();
    adapter.push(baseEvent({ kind: 'process.paused', processId: 'proc-1', correlationToken: 'T-1' }));
    adapter.push(baseEvent({ schemaVersion: 1, processId: 'proc-1', correlationToken: 'T-1' }));
    adapter.push(baseEvent({ processId: 'proc-1', correlationToken: 'T-1', timestamp: 'soon' }));
    assert.deepEqual(await detector.collect(clock.now()), []);
    assert.equal(detector.dropped.length, 3);
    assert.match(warnings.join('\n'), /kind must be one of/);
    assert.match(warnings.join('\n'), /schemaVersion must be 2/);
    assert.match(warnings.join('\n'), /timestamp/);
  });

  it('a throwing adapter is caught and warns (never breaks the tick loop)', async () => {
    const adapter = new FakeProcessStreamAdapter({ failMessage: 'stream down' });
    const { detector, clock, warnings } = makeDetector({ adapter });
    assert.deepEqual(await detector.collect(clock.now()), []);
    assert.match(warnings.join('\n'), /stream down/);
  });

  it('never uses real timers: two collects at the same instant are deterministic', async () => {
    const { detector, adapter, clock } = makeDetector();
    adapter.push(baseEvent({ processId: 'proc-1', correlationToken: 'T-1' }));
    const atFixedTime = await detector.collect(0);
    assert.equal(atFixedTime.length, 1);
    // The clock never advanced: nothing was scheduled, nothing is pending.
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(clock.fired.length, 0);
  });
});

describe('ProcessDetector — full fixture replay', () => {
  it('the v2 fixture exercises all six kinds, dedups repeats and drops the unresolvable process', async () => {
    const fixture = loadProcessFixture();
    assert.equal(fixture.schemaVersion, 2);
    const adapter = FakeProcessStreamAdapter.fromFixture(fixture);
    const { detector, clock, warnings } = makeDetector({ adapter });

    const emitted = await detector.collect(clock.now());
    const kinds = emitted.map((e) => e.kind);
    assert.deepEqual(
      [...new Set(kinds)].sort(),
      [...PROCESS_KINDS].sort(),
      'the fixture stream covers exactly the six canonical kinds',
    );
    // 11 observations in, the duplicate start (proc-beta) is deduped and the
    // unresolvable proc-ghost event is dropped: 9 emissions.
    assert.equal(emitted.length, 9);
    assert.equal(detector.dropped.length, 1);
    assert.equal(detector.dropped[0].processId, fixture.unresolvableProcessId);
    assert.equal(warnings.length, 1);

    // Both association paths are represented and every emitted event is bound
    // to a task id (an unassociated event is never emitted).
    assert.equal(emitted.filter((e) => e.associationSource === 'correlationToken').length, 3);
    assert.equal(emitted.filter((e) => e.associationSource === 'adapter').length, 6);
    for (const event of emitted) {
      assert.equal(typeof event.taskId, 'string');
      assert.ok(event.taskId.length > 0);
      assert.equal(event.schemaVersion, 2);
    }
    // proc-beta restarts after process.failed/process.exited: the restart is a
    // fresh rising edge, and the terminal kinds cleared its episode state.
    const betaRestart = emitted.filter((e) => e.processId === 'proc-beta' && e.kind === 'process.started');
    assert.equal(betaRestart.length, 2);
  });
});

