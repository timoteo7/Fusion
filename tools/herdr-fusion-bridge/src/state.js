// state.js — persisted reconcile state for the bridge.
//
// The bridge persists the correlation map (task → executor/pane/state) plus an
// orphan registry to a JSON state file so that after a restart it can reconcile
// idempotently and recover orphaned panes. Persistence uses an injectable
// fs/store so unit tests can run against an in-memory store with no real disk
// IO; the default implementation writes atomically (tmp + rename) to avoid
// corrupting the state file on a crash mid-write.

import { buildCorrelationKey } from './correlator.js';

export function defaultState() {
  return {
    schemaVersion: 1,
    seq: 0,
    lastReconciledAt: 0,
    tasks: {}, // taskId -> { executorId, paneId, state, seq }
    associations: {}, // correlationKey -> paneId
    orphaned: {}, // taskId -> { paneId, reason, orphanedAt }
    // Last-emitted markers keyed by correlation id (e.g. 'T-1|E-1|P-1|blocked'),
    // carrying { kind, at } so notification/steering dedup SURVIVES a restart
    // without re-emitting a state already delivered before shutdown.
    markers: {}, // correlationKey -> { kind, at }
  };
}

// Build the task record stored for a task from an observation.
export function packageTask(obs) {
  return {
    executorId: obs.executorId || null,
    paneId: obs.paneId || null,
    state: obs.state || null,
    seq: obs.seq || 0,
    updatedAt: obs.updatedAt || 0,
  };
}

// A minimal atomic fs store (tmp + rename). Injectable for tests.
export class FsStore {
  constructor({ file, readFileSync = null, writeFileSync = null, renameSync = null } = {}) {
    this.file = file;
    // Lazily import node:fs only when instantiated (keeps the module side
    // effect-free for the interface layer).
    const fs = defaultFs();
    this.readFileSync = readFileSync || ((path) => fs.readFileSync(path, 'utf8'));
    this.writeFileSync = writeFileSync || ((path, data) => fs.writeFileSync(path, data, 'utf8'));
    this.renameSync = renameSync || ((a, b) => fs.renameSync(a, b));
  }

  read() {
    try {
      const text = this.readFileSync(this.file);
      return text ? JSON.parse(text) : null;
    } catch {
      return null; // missing or unparseable -> treat as absent (fresh start)
    }
  }

  write(data) {
    const tmp = `${this.file}.tmp`;
    this.writeFileSync(tmp, JSON.stringify(data, null, 2));
    this.renameSync(tmp, this.file);
  }
}

let _fs = null;
function defaultFs() {
  if (_fs === null) {
    // eslint-disable-next-line global-require
    _fs = requireFs();
  }
  return _fs;
}
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
function requireFs() {
  return { readFileSync, writeFileSync, renameSync };
}

// The persisted state machine: load, apply observations idempotently, save
// atomically, and support orphan marking/removal.
export class PersistentState {
  constructor({ file = 'herdr-fusion-bridge-state.json', store = null, now = null } = {}) {
    this.file = file;
    this.store = store || new FsStore({ file });
    this.now = now || (() => Date.now());
    this.data = defaultState();
  }

  load() {
    const raw = this.store.read();
    if (!raw) {
      this.data = defaultState();
      return this.data;
    }
    const base = defaultState();
    // Merge over defaults so new fields default cleanly (schema evolution).
    this.data = {
      ...base,
      ...raw,
      tasks: raw.tasks || {},
      associations: raw.associations || {},
      orphaned: raw.orphaned || {},
      markers: raw.markers || {},
    };
    return this.data;
  }

  // Record a last-emitted marker for a correlation key (e.g. the last kind the
  // notifier delivered or the last command it steered). Idempotent; returns true
  // when the marker actually changed so dedup state survives a restart.
  setMarker(key, { kind, at = this.now() } = {}) {
    if (!key) {
      return false;
    }
    const prev = this.data.markers[key];
    if (prev && prev.kind === kind) {
      return false;
    }
    this.data.markers[key] = { kind, at };
    this.data.seq += 1;
    return true;
  }

  getMarker(key) {
    return key ? this.data.markers[key] || null : null;
  }

  // Drop markers whose correlation key is no longer relevant (e.g. the task was
  // orphaned or cleared). Returns the count removed.
  clearMarkersFor(taskId) {
    const prefix = `${taskId}|`;
    let removed = 0;
    for (const key of Object.keys(this.data.markers)) {
      if (key.startsWith(prefix) || key === taskId) {
        delete this.data.markers[key];
        removed += 1;
      }
    }
    return removed;
  }

  save() {
    this.data.lastReconciledAt = this.now();
    this.store.write(this.data);
  }

  reset() {
    this.data = defaultState();
    return this.data;
  }

  // Apply a live observation to the persisted state. Returns true when the
  // persisted task/association actually changed (a no-op for repeat observations
  // — idempotent reconcile).
  applyObservation(obs) {
    const taskId = obs.taskId;
    if (!taskId) {
      return false;
    }
    const sig = packageTask(obs);
    const prev = this.data.tasks[taskId];
    let changed = false;
    if (!prev || JSON.stringify(prev) !== JSON.stringify(sig)) {
      this.data.tasks[taskId] = sig;
      changed = true;
    }
    const key = buildCorrelationKey(obs);
    if (key && obs.paneId) {
      if (this.data.associations[key] !== obs.paneId) {
        this.data.associations[key] = obs.paneId;
        changed = true;
      }
    }
    if (changed) {
      this.data.seq += 1;
    }
    return changed;
  }

  // Mark a task as orphaned (pane/executor died) and drop its live association.
  // Idempotent: a task already marked orphaned is left untouched.
  markOrphan(taskId, { paneId = null, reason = 'orphaned', at = null } = {}) {
    if (this.data.orphaned[taskId]) {
      return false;
    }
    this.data.orphaned[taskId] = {
      paneId,
      reason,
      orphanedAt: at || this.now(),
    };
    delete this.data.tasks[taskId];
    const keys = Object.keys(this.data.associations).filter(
      (k) => k.startsWith(`${taskId}|`),
    );
    for (const key of keys) {
      delete this.data.associations[key];
    }
    this.data.seq += 1;
    return true;
  }

  // Remove a task entirely (e.g. after it completes cleanly). Idempotent.
  removeTask(taskId) {
    if (!(taskId in this.data.tasks) && !(taskId in this.data.orphaned)) {
      return false;
    }
    delete this.data.tasks[taskId];
    delete this.data.orphaned[taskId];
    const keys = Object.keys(this.data.associations).filter(
      (k) => k.startsWith(`${taskId}|`),
    );
    for (const key of keys) {
      delete this.data.associations[key];
    }
    this.data.seq += 1;
    return true;
  }

  task(taskId) {
    return this.data.tasks[taskId] || null;
  }

  taskIds() {
    return Object.keys(this.data.tasks);
  }

  orphanedIds() {
    return Object.keys(this.data.orphaned);
  }

  tasksCount() {
    return Object.keys(this.data.tasks).length;
  }

  orphanedCount() {
    return Object.keys(this.data.orphaned).length;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }
}