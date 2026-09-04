// watchdog.js — the liveness watchdog.
//
// The defining rule: "real progress" is a discrete state/event change (a task's
// state or seq signature moving), NEVER a log line. A task can generate an
// unbounded stream of log lines while making no real progress; that is exactly
// the "real stall" this watchdog must report once its window elapses.
//
// The Watchdog is clock-injected so tests advance time deterministically. It
// records when a task last made REAL progress and answers isStalled after the
// configured window. Log volume is tracked only as context and never resets the
// stall timer.

export class Watchdog {
  constructor({ watchDogTimeoutMs = 60000, clock = null } = {}) {
    this.timeout = watchDogTimeoutMs;
    this.clock = clock || { now: () => Date.now() };
    // taskId -> last discrete-change timestamp (real progress).
    this.progress = new Map();
    // taskId -> last log line timestamp (context only; NOT progress).
    this.logAt = new Map();
    // taskId -> current signature (state+seq) see diffing helper.
    this.signatures = new Map();
  }

  now() {
    return this.clock.now();
  }

  // Credit a discrete state/event change as REAL progress. This is the only
  // thing that resets the stall window.
  recordProgress(taskId, now = this.now()) {
    this.progress.set(taskId, now);
  }

  // Record a log line as context. Deliberately does NOT update `progress`, so
  // mere log churn never masks a stall.
  observeLogLine(taskId, now = this.now()) {
    this.logAt.set(taskId, now);
  }

  lastProgressAt(taskId) {
    return this.progress.has(taskId) ? this.progress.get(taskId) : null;
  }

  lastLogAt(taskId) {
    return this.logAt.has(taskId) ? this.logAt.get(taskId) : null;
  }

  hasProgress(taskId) {
    return this.progress.has(taskId);
  }

  // True when the task has made no real progress within watchDogTimeoutMs.
  isStalled(taskId, now = this.now()) {
    const last = this.progress.get(taskId);
    if (last === undefined) {
      // Never observed a task: treat as not stalled (no baseline to compare).
      return false;
    }
    return now - last >= this.timeout;
  }

  // Milliseconds since the task last made real progress (0 if never seen).
  stallElapsed(taskId, now = this.now()) {
    const last = this.progress.get(taskId);
    if (last === undefined) {
      return 0;
    }
    return Math.max(0, now - last);
  }

  // How far a stall still has to go before it trips (0 when already stalled).
  remainingStall(taskId, now = this.now()) {
    const elapsed = this.stallElapsed(taskId, now);
    return Math.max(0, this.timeout - elapsed);
  }

  // Forget a task (e.g. when it completes or its pane is orphaned).
  clear(taskId) {
    this.progress.delete(taskId);
    this.logAt.delete(taskId);
    this.signatures.delete(taskId);
  }

  // Record the current discrete signature (state+seq) for a task. Returns true
  // when the signature CHANGED from the previous one — i.e. real progress. The
  // calling layer should call recordProgress() when it sees a change.
  diffSignature(taskId, signature) {
    const prev = this.signatures.get(taskId);
    this.signatures.set(taskId, signature);
    return prev === undefined || prev !== signature;
  }

  // Convenience: record signature and, if it changed, credit progress. Returns
  // whether this was a discrete change (real progress).
  observeSignature(taskId, signature, now = this.now()) {
    const changed = this.diffSignature(taskId, signature);
    if (changed) {
      this.recordProgress(taskId, now);
    }
    return changed;
  }
}

// Build a Watchdog from a loaded config (reads watchDogTimeoutMs).
export function createWatchdog(config, clock) {
  return new Watchdog({ watchDogTimeoutMs: config.watchDogTimeoutMs, clock });
}

// Determine whether a task is a real stall: no discrete change within the
// window, even when logs are actively flowing. Pure helper for tests/reports.
export function isRealStall({
  watchdog,
  taskId,
  signature,
  logLines = 0,
  now = null,
}) {
  const t = now === null ? watchdog.now() : now;
  // A log line is observed (context) but is explicitly NOT progress.
  if (logLines > 0) {
    watchdog.observeLogLine(taskId, t);
  }
  watchdog.observeSignature(taskId, signature, t);
  // Whether the signature moved recently is what counts.
  return watchdog.isStalled(taskId, t);
}