// bridge.js — the Supervisor: the event- and liveness-driven coordination loop.
//
// Responsibilities:
//   • Engine detection, bounded and re-spaced (never a tight probe loop).
//   • Task → executor → pane correlation each tick.
//   • Safe-fail: a down integration is caught and cooled down, never a crash
//     and never a busy re-probe every tick.
//   • Event emission (log + notify) for start/progress/blocked/error/stalled/
//     completed/engine_absent, with dedup delegated to the DedupNotifier.
//   • v2 process observations: when a ProcessDetector is wired, the same tick
//     also pulls the process stream and merges its rising-edge, task-associated
//     process events into `result.processEvents` (never into `result.events`,
//     so the v1 task-event stream stays byte-compatible).
//
// The Supervisor is agnostic to the clock it receives — the fake clock lets
// tests advance time deterministically with no real sleeps. It never launches a
// long-running process; `start()` schedules ticks via the clock's setInterval.

import { buildCorrelationKey } from './correlator.js';
import { taskSignature } from './watchdog.js';

export class Supervisor {
  constructor({
    fusion,
    herdr,
    notifier,
    logger,
    config,
    clock = null,
    watchdog = null,
    processDetector = null,
    processEvents = null,
  } = {}) {
    this.fusion = fusion;
    this.herdr = herdr;
    this.notifier = notifier;
    this.logger = logger;
    this.config = config;
    this.clock = clock || { now: () => Date.now() };
    this.now = () => this.clock.now();
    // Optional liveness watchdog: when present, _tickOnce runs a bounded stall
    // scan (step 4) that consults Watchdog.isStalled and emits one deduplicated
    // `stalled` notification per (task, real-stall episode). The poll path
    // also feeds its own observations into the watchdog so SSE outages do
    // not blind stall detection. Optional for backward compatibility with
    // existing call sites and tests that do not need stall reporting.
    this.watchdog = watchdog;
    // Optional v2 process detection: when present, _tickOnce pulls the process
    // stream (step 5) and merges its rising-edge process events. `processEvents`
    // is the stream sink they are published to (see ProcessEventStream in
    // src/adapters/notifier.js). Both are optional, so every pre-v2
    // construction behaves exactly as before.
    this.processDetector = processDetector;
    this.processEvents = processEvents;

    this.running = false;
    this.timer = null; // the tick interval handle

    // Engine detection state.
    this.enginePresent = false;
    this.lastEngineCheckAt = -Infinity;
    this.engineCheckInterval = this.config.engineRecheckMs;

    // Transport cooldown: if an integration throws, we skip re-probing until
    // this timestamp. Prevents busy-looping a down transport.
    this.transportCooldownUntil = -Infinity;
    this.transportCooldownMs = this.config.watchDogTimeoutMs;

    // Correlation state persisted across ticks.
    this.knownTasks = new Map(); // taskId -> last observed {executorId,paneId,state,seq}
    this.knownAssociations = new Map(); // correlationKey -> paneId

    this.lastTickResult = null;
    this.tickCount = 0;
    // Single-tick gag: at most ONE tick in flight. A tick that arrives while
    // the previous one still runs is skipped and logged `tick_skipped` — it
    // never stacks concurrent reconciles (no busy-loop amplification).
    this._tickInFlight = false;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.timer = this.clock.setInterval(() => {
      // Never let a tick throw out of the interval; safe-fail inside.
      this.tick().catch((err) => {
        this.logger.error('tick_unhandled', {}, { error: String(err && err.message ? err.message : err) });
      });
    }, this.config.tickIntervalMs);
  }

  stop() {
    if (!this.running) {
      return false;
    }
    this.running = false;
    if (this.timer) {
      this.clock.clearInterval(this.timer);
      this.timer = null;
    }
    return true;
  }

  isRunning() {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // One work cycle
  // -------------------------------------------------------------------------

  async tick() {
    if (this._tickInFlight) {
      this.logger.warn('tick_skipped', {}, { reason: 'tick_in_flight' });
      const skipped = {
        tick: this.tickCount,
        engine: null,
        tasks: 0,
        events: [],
        processEvents: [],
        skipped: true,
        reason: 'tick_in_flight',
      };
      this.lastTickResult = skipped;
      return skipped;
    }
    this._tickInFlight = true;
    try {
      return await this._tickOnce();
    } finally {
      this._tickInFlight = false;
    }
  }

  async _tickOnce() {
    this.tickCount += 1;
    const now = this.now();
    const result = { tick: this.tickCount, engine: null, tasks: 0, events: [], processEvents: [], skipped: false };

    // 1. Engine detection, bounded and re-spaced.
    const engine = await this.ensureEnginePresence(now);
    result.engine = engine;
    if (!engine.present) {
      // No engine: emit engine_absent once (deduped) and skip work. We do not
      // re-detect until engineRecheckMs, so we never busy-loop a down engine.
      this.emit('engine_absent', { present: false }, result, { now });
      result.skipped = true;
      this.lastTickResult = result;
      return result;
    }

    // 2. Collect observations. Bounded: listTasks is one call; per-task lookups
    //    are bounded by the task count and guarded by a transport cooldown.
    let observations;
    try {
      observations = await this.collectObservations();
    } catch (err) {
      this.enterCooldown(now, err);
      result.skipped = true;
      result.error = String(err && err.message ? err.message : err);
      this.lastTickResult = result;
      return result;
    }
    result.tasks = observations.length;

    // 3. Reconcile observations against known state; emit transitions.
    for (const obs of observations) {
      const events = this.reconcileOne(obs, now);
      result.events.push(...events);
    }

    // 4. Bounded stall scan (only when a watchdog is wired). Consults
    //    Watchdog.isStalled(taskId, now) for each observation with a real
    //    progress baseline, skipping terminal-state tasks (which sit in a
    //    frozen terminal forever and are not stalls), and emits one
    //    deduplicated `stalled` notification per scan. The dedup window is
    //    owned by the DedupNotifier so a per-tick re-emit collapses to a
    //    single operator-visible notification per episode; a persisting
    //    stall re-emits after the window expires, and a discrete state/seq
    //    change (credited in step 3 via watchdog.observeSignature) re-arms
    //    the window so a fresh stall re-emits cleanly.
    if (this.watchdog) {
      for (const obs of observations) {
        if (!obs || !obs.taskId) continue;
        if (!this.watchdog.hasProgress(obs.taskId)) continue;
        if (isTerminalState(obs.state)) continue;
        if (!this.watchdog.isStalled(obs.taskId, now)) continue;
        const stallPayload = {
          lastProgressMs: this.watchdog.lastProgressAt(obs.taskId),
          timeoutMs: this.watchdog.timeout,
        };
        this.emit('stalled', obs, result, {
          now,
          note: `no real progress for ${this.watchdog.stallElapsed(obs.taskId, now)}ms`,
          payload: stallPayload,
        });
        result.events.push({ kind: 'stalled', taskId: obs.taskId });
      }
    }

    // 5. Process observations (v2). The detector pulls the process stream,
    //    validates and associates every observation, and returns the
    //    rising-edge process events for this same tick. They are merged into
    //    `result.processEvents` — never into `result.events`, so the v1
    //    task-event stream stays byte-compatible for existing consumers — and
    //    published to the processEvents stream and the notifier sink. Safe-fail:
    //    a detector that throws is logged, never propagated into the tick loop.
    if (this.processDetector) {
      try {
        const processEvents = await this.processDetector.collect(now);
        for (const event of processEvents) {
          result.processEvents.push(event);
          this.emitProcess(event, { now });
        }
      } catch (err) {
        this.logger.warn('process_stream_error', {}, {
          error: String(err && err.message ? err.message : err),
        });
      }
    }

    this.lastTickResult = result;
    return result;
  }

  // Ensure engine presence, honoring the recheck spacing so we never probe the
  // engine more than once every engineRecheckMs.
  async ensureEnginePresence(now) {
    if (now - this.lastEngineCheckAt < this.engineCheckInterval) {
      // Within the recheck window: keep the cached value (no extra probe).
      return { present: this.enginePresent, cached: true };
    }
    if (now < this.transportCooldownUntil) {
      // A transport is cooling down (recent failure): do not re-probe yet.
      return { present: this.enginePresent, cached: true, cool: true };
    }
    this.lastEngineCheckAt = now;
    let present = false;
    try {
      const res = await this.fusion.detectEngine();
      present = Boolean(res && res.present);
    } catch (err) {
      this.enterCooldown(now, err);
      return { present: this.enginePresent, cached: true, error: true };
    }
    this.enginePresent = present;
    return { present };
  }

  // Collect per-task observations (taskId, executorId, paneId, state). Bounded.
  async collectObservations() {
    const tasks = [];
    const list = await this.fusion.listTasks();
    for (const t of list) {
      if (!t || !t.taskId) {
        continue;
      }
      const taskId = t.taskId;
      let executorId = t.executorId || null;
      if (!executorId) {
        try {
          executorId = await this.fusion.resolveExecutor(taskId);
        } catch {
          executorId = null;
        }
      }
      let paneId = t.paneId || null;
      if (!paneId) {
        try {
          paneId = await this.herdr.resolvePane(taskId, executorId);
        } catch {
          paneId = null;
        }
      }
      tasks.push({
        taskId,
        executorId: executorId || null,
        paneId: paneId || null,
        state: t.state || null,
        seq: t.seq || 0,
      });
    }
    return tasks;
  }

  // Reconcile one observation against known state and emit transition events.
  reconcileOne(obs, now) {
    const events = [];
    const prev = this.knownTasks.get(obs.taskId);
    const key = buildCorrelationKey(obs);
    const associationChanged =
      !prev ||
      prev.paneId !== obs.paneId ||
      prev.executorId !== obs.executorId;

    if (!prev) {
      // New task observed: emit a start.
      this.emit('start', obs, null, { now, note: 'new task' });
      events.push({ kind: 'start', taskId: obs.taskId });
    } else if (associationChanged) {
      // The correlation changed: the executor/pane association is stale.
      this.emit('association_stale', obs, null, {
        now,
        note: `association changed from pane=${prev.paneId} to pane=${obs.paneId}`,
      });
      events.push({ kind: 'association_stale', taskId: obs.taskId });
    } else if (obs.state && obs.state !== prev.state) {
      // State transition: emit a state-change event.
      const kind = stateToKind(obs.state);
      this.emit(kind, obs, null, { now, note: `state ${prev.state} -> ${obs.state}` });
      events.push({ kind, taskId: obs.taskId, state: obs.state });
    }

    if (associationChanged || !prev) {
      this.knownAssociations.set(key, obs.paneId);
    }
    this.knownTasks.set(obs.taskId, { ...obs });

    // Feed the poll path's discrete signature into the watchdog. The shared
    // `taskSignature({state, seq})` helper is the single source of truth for
    // the (state, seq) pair the watchdog diffs, so a discrete change observed
    // on the poll path re-arms the stall window even when the SSE stream is
    // down. The diff returns true only on a genuine discrete change; identical
    // observations back-to-back never re-credit progress.
    if (this.watchdog) {
      this.watchdog.observeSignature(obs.taskId, taskSignature(obs), now);
    }

    return events;
  }

  // -------------------------------------------------------------------------
  // Event emission + transport cooldown
  // -------------------------------------------------------------------------

  emit(kind, obs, result, { now = this.now(), note = '', payload: extra = null } = {}) {
    const payload = {
      kind,
      ts: now,
      taskId: obs ? obs.taskId : null,
      executorId: obs ? obs.executorId : null,
      paneId: obs ? obs.paneId : null,
      note,
    };
    // Per-kind structured payload (e.g. stalled → {lastProgressMs, timeoutMs}).
    // The fixture in test/fixtures/events.json defines per-kind payload shapes;
    // the supervisor attaches them only when the caller supplies one, so
    // existing emissions are byte-for-byte unchanged.
    if (extra !== null && extra !== undefined) {
      payload.payload = extra;
    }
    this.logger.info(kind, payload);
    if (this.notifier) {
      // The DedupNotifier handles dedup. We wrap in try/catch so a notifier
      // failure never bubbles into the tick loop (safe-fail).
      this.notifier.notify(payload).catch(() => {});
    }
  }

  // Publish ONE v2 process event. The event goes to the processEvents stream
  // (when wired) and through the same notifier sink the v1 events use, with
  // `kind` set to the process kind (process.started … process.exited) and the
  // two-field progress payload carried through unchanged. Safe-fail exactly
  // like emit(): a throwing sink never bubbles into the tick loop.
  emitProcess(event, { now = this.now() } = {}) {
    const payload = {
      kind: event.kind,
      ts: now,
      schemaVersion: event.schemaVersion,
      taskId: event.taskId,
      processId: event.processId,
      note: `associated via ${event.associationSource || 'process stream'}`,
    };
    if (event.payload) {
      payload.payload = { ...event.payload };
    }
    this.logger.info(event.kind, payload);
    if (this.processEvents && typeof this.processEvents.publish === 'function') {
      this.processEvents.publish(event);
    }
    if (this.notifier) {
      this.notifier.notify(payload).catch(() => {});
    }
  }

  enterCooldown(now, err) {
    this.transportCooldownUntil = now + this.transportCooldownMs;
    this.logger.warn('transport_cooldown', {
      until: this.transportCooldownUntil,
      error: String(err && err.message ? err.message : err),
    });
  }

  inCooldown(now) {
    return now < this.transportCooldownUntil;
  }

  // Test/observability helpers.
  syncState() {
    return this.knownTasks;
  }

  correlationKey(obs) {
    return buildCorrelationKey(obs);
  }
}

// Map a Fusion task state string to an event kind. Blocked/error/completed map
// directly; anything else is generic progress.
export function stateToKind(state) {
  if (state === 'blocked') return 'blocked';
  if (state === 'error' || state === 'failed') return 'error';
  if (state === 'completed' || state === 'done') return 'completed';
  return 'progress';
}

// A terminal task state never emits a `stalled` notification even when the
// watchdog would otherwise trip on it. Terminal tasks sit in a frozen terminal
// forever and a stall signal would be a false positive. Blocked is NOT
// terminal: a task blocked longer than the timeout is genuinely stalled (the
// spec classifies blocked as a separate, legitimate event kind; the watchdog
// still trips for stuck blocked tasks).
export function isTerminalState(state) {
  if (!state) return false;
  return state === 'completed' || state === 'done' || state === 'error' || state === 'failed';
}