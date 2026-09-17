// fake-process-stream.js — a deterministic process-stream adapter for tests.
//
// No timers, no randomness, no I/O beyond reading the fixture: the test pushes
// the exact observations the next pull must return and declares the
// associations the resolver must answer, so every assertion in the v2 suite is
// reproducible. Every pull and every resolver call is recorded, so a test can
// assert boundedness (one pull per window, one resolver call per event that
// carries no correlationToken).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ProcessStreamAdapter } from '../../src/process-stream-adapter.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Load the v2 fixture (schemaVersion 2, six kinds, duplicates, an unresolvable
// process, both association paths).
export function loadProcessFixture(name = 'process-events.json') {
  return JSON.parse(readFileSync(join(HERE, '..', 'fixtures', name), 'utf8'));
}

export class FakeProcessStreamAdapter extends ProcessStreamAdapter {
  constructor({ associations = null, queue = [], failMessage = null } = {}) {
    super();
    this.associations = new Map(Object.entries(associations || {}));
    this.queue = [...queue];
    this.failMessage = failMessage;
    this.pulls = []; // every collect(now) call, in order
    this.lookups = []; // every getTaskForProcess(pid) call, in order
  }

  // Queue observations for the next pull(s).
  push(...events) {
    this.queue.push(...events);
    return this;
  }

  pushAll(events) {
    this.queue.push(...events);
    return this;
  }

  addAssociation(processId, taskId) {
    this.associations.set(processId, taskId);
    return this;
  }

  removeAssociation(processId) {
    this.associations.delete(processId);
    return this;
  }

  // Drain everything queued: one pull = one tick's worth of observations.
  async collect(now) {
    this.pulls.push(now);
    if (this.failMessage) {
      throw new Error(this.failMessage);
    }
    const batch = this.queue;
    this.queue = [];
    return batch;
  }

  async getTaskForProcess(processId) {
    this.lookups.push(processId);
    return this.associations.has(processId) ? this.associations.get(processId) : null;
  }

  // The fixture-driven adapter: the fixture's `processes` table is the resolver
  // and its `stream` is the queued observation script.
  static fromFixture(fixture = loadProcessFixture()) {
    return new FakeProcessStreamAdapter({
      associations: fixture.processes,
      queue: fixture.stream,
    });
  }
}
