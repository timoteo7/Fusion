// correlator.test.js — correlation key stability, malformed-key rejection and
// round-trip parsing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCorrelationKey,
  validateCorrelation,
  parseCorrelationKey,
  EVENT_KINDS,
} from '../src/correlator.js';

test('buildCorrelationKey is stable for the same tuple', () => {
  const tuple = { taskId: 'T-1', executorId: 'E-1', paneId: 'P-1', kind: 'progress' };
  const a = buildCorrelationKey(tuple);
  const b = buildCorrelationKey(tuple);
  assert.equal(a, b);
  assert.equal(a, 'T-1|E-1|P-1|progress');
});

test('buildCorrelationKey differs when any dimension or kind differs', () => {
  const base = { taskId: 'T-1', executorId: 'E-1', paneId: 'P-1', kind: 'start' };
  assert.notEqual(buildCorrelationKey(base), buildCorrelationKey({ ...base, kind: 'completed' }));
  assert.notEqual(buildCorrelationKey(base), buildCorrelationKey({ ...base, taskId: 'T-2' }));
  assert.notEqual(buildCorrelationKey(base), buildCorrelationKey({ ...base, paneId: 'P-9' }));
});

test('buildCorrelationKey collapses missing dimensions to "unknown"', () => {
  const a = buildCorrelationKey({ taskId: 'T-1', kind: 'start' });
  assert.equal(a, 'T-1|unknown|unknown|start');
  const b = buildCorrelationKey({ paneId: 'P-5', kind: 'blocked' });
  assert.equal(b, 'unknown|unknown|P-5|blocked');
});

test('buildCorrelationKey rejects a missing/empty kind', () => {
  assert.equal(buildCorrelationKey({ taskId: 'T-1', executorId: 'E-1', paneId: 'P-1' }), null);
  assert.equal(buildCorrelationKey({ taskId: 'T-1', executorId: 'E-1', paneId: 'P-1', kind: '' }), null);
});

test('validateCorrelation rejects empty kind and empty tuple', () => {
  assert.equal(validateCorrelation({ taskId: 'T-1', executorId: 'E-1', paneId: 'P-1' }).ok, false);
  assert.equal(validateCorrelation({ taskId: '', executorId: '', paneId: '', kind: 'start' }).ok, false);
});

test('validateCorrelation accepts a fully-specified tuple', () => {
  const res = validateCorrelation({ taskId: 'T-1', executorId: 'E-1', paneId: 'P-1', kind: 'start' });
  assert.equal(res.ok, true);
});

test('parseCorrelationKey round-trips the tuple', () => {
  const key = buildCorrelationKey({ taskId: 'T-1', executorId: 'E-1', paneId: 'P-1', kind: 'progress' });
  const parsed = parseCorrelationKey(key);
  assert.deepEqual(parsed, { taskId: 'T-1', executorId: 'E-1', paneId: 'P-1', kind: 'progress' });
});

test('parseCorrelationKey rejects malformed keys', () => {
  assert.equal(parseCorrelationKey('only-two|parts'), null);
  assert.equal(parseCorrelationKey('T|E|P|k|extra'), null);
  assert.equal(parseCorrelationKey(null), null);
});

test('EVENT_KINDS includes every meaningful state the bridge tracks', () => {
  for (const kind of ['start', 'progress', 'blocked', 'error', 'stalled', 'completed']) {
    assert.ok(EVENT_KINDS.indexOf(kind) !== -1, `expected kind ${kind} in EVENT_KINDS`);
  }
});