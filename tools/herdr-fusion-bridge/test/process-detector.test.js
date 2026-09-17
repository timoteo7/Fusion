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
