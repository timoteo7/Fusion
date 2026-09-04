// logger.test.js — structured JSON logger emits correlation fields, defaults
// missing ones to "unknown", and the in-memory sink lets tests assert on the
// exact records emitted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, memorySink, UNKNOWN } from '../src/logger.js';

test('logger emits full correlation fields when present', () => {
  const sink = memorySink();
  const logger = createLogger({ sink });
  logger.info('progress', { taskId: 'T-1', executorId: 'E-1', paneId: 'P-1' });
  const rec = sink.records[0];
  assert.equal(rec.event, 'progress');
  assert.equal(rec.taskId, 'T-1');
  assert.equal(rec.executorId, 'E-1');
  assert.equal(rec.paneId, 'P-1');
  assert.equal(typeof rec.ts, 'number');
});

test('logger fills missing correlation fields with "unknown"', () => {
  const sink = memorySink();
  const logger = createLogger({ sink });
  logger.warn('stalled', { taskId: 'T-9' });
  const rec = sink.records[0];
  assert.equal(rec.taskId, 'T-9');
  assert.equal(rec.executorId, UNKNOWN);
  assert.equal(rec.paneId, UNKNOWN);
});

test('logger includes extra fields on the record', () => {
  const sink = memorySink();
  const logger = createLogger({ sink });
  logger.info('completed', { taskId: 'T-2', paneId: 'P-2' }, { seq: 42 });
  const rec = sink.records[0];
  assert.equal(rec.seq, 42);
  assert.equal(rec.taskId, 'T-2');
});

test('memorySink.clear empties records', () => {
  const sink = memorySink();
  const logger = createLogger({ sink });
  logger.info('start', { taskId: 'T-3' });
  assert.equal(sink.records.length, 1);
  sink.clear();
  assert.equal(sink.records.length, 0);
});

test('logger default sink writes JSON lines to the provided stream', () => {
  let out = '';
  const stream = { write: (s) => (out += s) };
  const logger = createLogger({ stream });
  logger.info('start', { taskId: 'T-4', paneId: 'P-4' });
  const parsed = JSON.parse(out.trim().split('\n')[0]);
  assert.equal(parsed.event, 'start');
  assert.equal(parsed.taskId, 'T-4');
});