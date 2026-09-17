// process-detector.js — the v2 process detector.
//
// The pipeline is deliberately one-directional: PULL -> VALIDATE -> ASSOCIATE
// -> RISING-EDGE EMIT -> STALL SCAN. Two guarantees define the module:
//
//   • RISING EDGE ONLY. A process event is emitted when the process's kind
//     CHANGES (or when an episode restarts after a terminal kind), never on a
//     repeat of the same kind. A repeated observation is still TRACKED — a
//     heartbeat carries the progress cursor the stall scan needs — but it is
//     not re-emitted, so a chatty process stream cannot turn into a chatty
//     notification stream.
//   • ASSOCIATION BEFORE EMISSION. An event is emitted only once it is bound
//     to the Fusion task it serves. Precedence: the event's own
//     correlationToken, then the adapter's getTaskForProcess(pid), then DROP
//     with console.warn. A dropped event is never emitted and never delivered
//     as a notification.
//
// Stall detection mirrors the v1 watchdog's philosophy: a heartbeat proves the
// process is ALIVE, but only an advancing progress cursor proves it is making
// REAL progress. When the cursor stays older than the process's stall window
// the detector synthesizes one `process.stalled` per episode (the marker is
// cleared when the cursor advances, and a terminal kind clears the episode).
//
// The detector NEVER uses real timers. It takes an injectable `now` clock and
// is driven by the Supervisor's tick, so tests advance a fake clock and get
// deterministic output with no sleeps.

import {
  PROCESS_SCHEMA_VERSION,
  isTerminalProcessKind,
  normalizeProcessId,
  validateProcessEvent,
} from './process-events.js';
import { NullProcessStreamAdapter } from './process-stream-adapter.js';

// Defaults, documented in the README: the pull cadence of the process stream
// and the stall window used when an event carries no timeoutMs of its own.
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
export const DEFAULT_STALL_TIMEOUT_MS = 120000;

// A process's identity for dedup: (processId, kind). null and '' processIds
// deliberately collapse into the same bucket, so they produce an IDENTICAL
// signature and dedup against each other.
export function processSignature({ processId, kind } = {}) {
  return `${normalizeProcessId(processId)}|${kind || ''}`;
}

function readProgress(observation, previous, fallbackTimeoutMs) {
  const payload = observation && observation.payload ? observation.payload : null;
  const prevCursor = previous ? previous.lastProgressMs : null;
  const prevTimeout = previous ? previous.timeoutMs : null;
  const cursor =
    payload && typeof payload.lastProgressMs === 'number' ? payload.lastProgressMs : prevCursor;
  // The stall window an event declares wins; otherwise the window the process
  // was already tracked with; otherwise the detector default.
  const timeout =
    payload && typeof payload.timeoutMs === 'number'
      ? payload.timeoutMs
      : typeof prevTimeout === 'number'
        ? prevTimeout
        : fallbackTimeoutMs;
  return { lastProgressMs: cursor, timeoutMs: timeout };
}

export class ProcessDetector {
  constructor({
    adapter = null,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    now = null,
    logger = null,
    warn = null,
  } = {}) {
    this.adapter = adapter || new NullProcessStreamAdapter();
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.stallTimeoutMs = stallTimeoutMs;
    this.clock = { now: typeof now === 'function' ? now : () => Date.now() };
    this.logger = logger;
    // Drop/validation warnings reach the operator's console by default; tests
    // inject a recorder so the drop contract is assertable.
    this.warn = typeof warn === 'function' ? warn : (...args) => console.warn(...args);

    // processId -> last EMITTED kind. This is the rising-edge gate, and it is
    // deliberately NOT cleared by terminal kinds: a repeated terminal kind must
    // stay deduped.
    this.lastKind = new Map();
    // processId -> { taskId, lastProgressMs, timeoutMs, stallReported } — the
    // episode state terminal kinds clear so a later process.started re-arms.
    this.state = new Map();
    // Observability: how often the stream was pulled, and every dropped
    // observation (a dropped event is never emitted).
    this.pullCount = 0;
    this.lastPullAt = -Infinity;
    this.dropped = [];
  }

  /**
   * Pull the process stream and return this tick's rising-edge, task-associated
   * process events. Bounded: at most one adapter pull per heartbeatIntervalMs
   * (never a tight probe loop), and the stall scan walks only tracked
   * processes. Safe-fail: a throwing adapter is caught and warns — it never
   * breaks the tick loop.
   */
  async collect(now = this.clock.now()) {
    const emitted = [];
    if (now - this.lastPullAt < this.heartbeatIntervalMs) {
      // Within the pull window: keep the last observations, do not re-probe.
      return emitted;
    }
    this.lastPullAt = now;
    this.pullCount += 1;

    let observations;
    try {
      observations = await this.adapter.collect(now);
    } catch (err) {
      this.warn('[hfb] process stream collect failed', err && err.message ? err.message : String(err));
      return emitted;
    }
    if (!Array.isArray(observations)) {
      return emitted;
    }

    for (const observation of observations) {
      // Sequential by design: association is per observation and the order of
      // a process's own events must be preserved.
      // eslint-disable-next-line no-await-in-loop
      const event = await this.observe(observation, now);
      if (event) {
        emitted.push(event);
      }
    }
    for (const event of this.scanStalls(now)) {
      emitted.push(event);
    }
    return emitted;
  }

  /**
   * Fold ONE observation into the tracked state and return the rising-edge
   * event to emit, or null when the observation is rejected, unresolvable, or a
   * repeat of the process's last emitted kind.
   */
  async observe(observation, now = this.clock.now()) {
    const check = validateProcessEvent(observation);
    if (!check.ok) {
      this.warn('[hfb] process event rejected:', check.reason);
      this.dropped.push({ kind: observation && observation.kind ? observation.kind : null, reason: check.reason });
      return null;
    }

    const pid = normalizeProcessId(observation.processId);
    const association = await this.associate(observation, pid);
    if (!association) {
      // Never associated => never emitted, and never tracked (nothing to attach
      // a stall to).
      this.warn(
        `[hfb] process event dropped: ${observation.kind} for process ${pid || '<unknown>'} resolved to no task`,
      );
      this.dropped.push({ kind: observation.kind, processId: pid, reason: 'unassociated' });
      return null;
    }

    const terminal = isTerminalProcessKind(observation.kind);
    const previous = this.state.get(pid) || null;
    const repeated = this.lastKind.get(pid) === observation.kind;
    const progress = readProgress(observation, previous, this.stallTimeoutMs);

    if (terminal) {
      // Terminal kinds end the episode: tracked state (progress cursor, stall
      // marker) is cleared so a later process.started re-arms as a fresh one.
      this.state.delete(pid);
    } else {
      // Only an ADVANCING cursor clears a reported stall: a repeated heartbeat
      // with a frozen cursor must not re-arm the stall marker, or a live but
      // stuck process would flap between heartbeat and stalled forever.
      const advanced =
        previous !== null &&
        previous.lastProgressMs !== null &&
        progress.lastProgressMs !== null &&
        progress.lastProgressMs > previous.lastProgressMs;
      this.state.set(pid, {
        taskId: association.taskId,
        lastProgressMs: progress.lastProgressMs,
        timeoutMs: progress.timeoutMs,
        stallReported: advanced ? false : Boolean(previous && previous.stallReported),
      });
    }

    if (repeated) {
      // Rise once per kind: the observation was tracked above, never re-emitted.
      return null;
    }
    this.lastKind.set(pid, observation.kind);
    return this.buildEvent(observation, association, now);
  }

  /**
   * Resolve the Fusion task an event belongs to. Precedence: the event's own
   * correlationToken, then the adapter's process-to-task resolver, then null
   * (the caller drops the event with a warn).
   */
  async associate(observation, pid) {
    const token = typeof observation.correlationToken === 'string' ? observation.correlationToken.trim() : '';
    if (token) {
      return { taskId: token, source: 'correlationToken' };
    }
    if (this.adapter && typeof this.adapter.getTaskForProcess === 'function') {
      let resolved = null;
      try {
        resolved = await this.adapter.getTaskForProcess(pid);
      } catch (err) {
        this.warn('[hfb] process association failed', err && err.message ? err.message : String(err));
        return null;
      }
      if (typeof resolved === 'string' && resolved.trim()) {
        return { taskId: resolved.trim(), source: 'adapter' };
      }
    }
    return null;
  }

  /**
   * Synthesize one `process.stalled` per stalled episode. A process is stalled
   * when its last REAL progress is older than its stall window (the event's own
   * timeoutMs when it carried one, else the configured stallTimeoutMs) — a
   * heartbeat arriving in between changes nothing while the cursor is frozen.
   */
  scanStalls(now = this.clock.now()) {
    const emitted = [];
    for (const [pid, tracked] of this.state) {
      if (tracked.lastProgressMs === null || tracked.lastProgressMs === undefined) {
        continue; // no progress baseline: nothing to compare against
      }
      const timeoutMs = typeof tracked.timeoutMs === 'number' ? tracked.timeoutMs : this.stallTimeoutMs;
      if (now - tracked.lastProgressMs < timeoutMs) {
        // Fresh enough: a later stall must be earned again, not inherited.
        tracked.stallReported = false;
        continue;
      }
      if (tracked.stallReported) {
        continue; // one stall per episode
      }
      tracked.stallReported = true;
      this.lastKind.set(pid, 'process.stalled');
      emitted.push(
        this.buildEvent(
          {
            schemaVersion: PROCESS_SCHEMA_VERSION,
            kind: 'process.stalled',
            processId: pid,
            timestamp: now,
            payload: { lastProgressMs: tracked.lastProgressMs, timeoutMs },
          },
          { taskId: tracked.taskId, source: 'stall-scan' },
          now,
        ),
      );
    }
    return emitted;
  }

  // Build the emitted v2 event: the observation's own fields plus the resolved
  // taskId. processId is normalized to a string (an unknown process id is ''),
  // and the payload — when present — stays the two-field progress payload.
  buildEvent(observation, association, now) {
    const event = {
      schemaVersion: PROCESS_SCHEMA_VERSION,
      kind: observation.kind,
      processId: normalizeProcessId(observation.processId),
      timestamp: typeof observation.timestamp === 'number' ? observation.timestamp : now,
      taskId: association.taskId,
      associationSource: association.source,
    };
    if (observation.correlationToken) {
      event.correlationToken = observation.correlationToken;
    }
    if (observation.payload) {
      event.payload = { ...observation.payload };
    }
    return event;
  }
}
