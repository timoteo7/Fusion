// bridge.js — the Supervisor: the event- and liveness-driven coordination loop.
//
// Responsibilities:
//   • Engine detection, bounded and re-spaced (never a tight probe loop).
//   • Task → executor → pane correlation each tick.
//   • Safe-fail: a down integration is caught and cooled down, never a crash
//     and never a busy re-probe every tick.
//   • Event emission (log + notify) for start/progress/blocked/error/stalled/
//     completed/engine_absent, with dedup delegated to the DedupNotifier.
//
// The Supervisor is agnostic to the clock it receives — the fake clock lets
// tests advance time deterministically with no real sleeps. It never launches a
// long-running process; `start()` schedules ticks via the clock's setInterval.

import { buildCorrelationKey } from './correlator.js';

export class Supervisor {
  constructor({
    fusion,
    herdr,
    notifier,
    logger,
    config,
    clock = null,
  } = {}) {
    this.fusion = fusion;
    this.herdr = herdr;
    this.notifier = notifier;
    this.logger = logger;
    this.config = config;
    this.clock = clock || { now: () => Date.now() };
    this.now = () => this.clock.now();

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
    const result = { tick: this.tickCount, engine: null, tasks: 0, events: [], skipped: false };

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
    return events;
  }

  // -------------------------------------------------------------------------
  // Event emission + transport cooldown
  // -------------------------------------------------------------------------

  emit(kind, obs, result, { now = this.now(), note = '' } = {}) {
    const payload = {
      kind,
      ts: now,
      taskId: obs ? obs.taskId : null,
      executorId: obs ? obs.executorId : null,
      paneId: obs ? obs.paneId : null,
      note,
    };
    this.logger.info(kind, payload);
    if (this.notifier) {
      // The DedupNotifier handles dedup. We wrap in try/catch so a notifier
      // failure never bubbles into the tick loop (safe-fail).
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