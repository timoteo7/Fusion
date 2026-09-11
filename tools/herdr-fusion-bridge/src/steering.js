// steering.js — safe steering/heartbeat channel from Hermes → Fusion.
//
// The Stepper is the ONLY entry point that dispatches a command to the Fusion
// engine, and it enforces the safety invariant: it is gated on engine presence
// before it ever asks Fusion to act. When the engine is absent it emits a
// `steer_skipped` alert and returns a skipped outcome — it never dispatches (or
// infinitely retries) a command against a dead engine.
//
// Guarantees:
//   • Safe-gate: no dispatch unless the engine is present (no-op + steer_skipped).
//   • Monotonic seq: every dispatch/outcome is stamped with a strictly
//     increasing sequence number (falling back to the client's own seq when the
//     client emits one).
//   • Dedup: identical (taskId, command) within HBRIDGE_DEDUP_WINDOW_MS is
//     emitted as exactly one dispatch.
//   • Bounded retries: a failed dispatch retries at most maxAttempts times with
//     exponential backoff, then fails safe — never an infinite loop.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Stable dedup key for a steering command. `kind` is folded in so the same
// command name can never collide across transport kinds.
export function steerKey(taskId, command, kind = 'steer') {
  return `steer|${kind}|${String(taskId)}|${String(command)}`;
}

// A safe, engine-gated steering controller.
//
//   fusion      — FusionClient (must expose detectEngine() and steer()).
//   notifier    — optional Notifier used to emit steer_skipped/steered alerts.
//   logger      — optional structured logger.
//   config      — config object (dedupWindowMs, backoffBaseMs, backoffMaxMs,
//                 seqBase) or null for defaults.
//   clock       — injectable clock (fake for tests); real Date.now default.
//   waitFn      — injectable backoff waiter (tests inject a no-op).
//   engineGate  — optional () => Promise<boolean> OR ()=> boolean returning
//                 whether the engine is present. When omitted, the controller
//                 calls fusion.detectEngine() once per steer (bounded — a steer
//                 is a discrete operator action, never a loop).
//   maxAttempts — hard bound on delivery attempts (default 3).
export class SteeringController {
  constructor({
    fusion,
    notifier = null,
    logger = null,
    config = null,
    clock = null,
    waitFn = null,
    engineGate = null,
    maxAttempts = 3,
  } = {}) {
    if (!fusion) {
      throw new Error('SteeringController requires a FusionClient');
    }
    this.fusion = fusion;
    this.notifier = notifier;
    this.logger = logger;
    this.config = config || {};
    this.clock = clock || { now: () => Date.now() };
    this.waitFn = waitFn || sleep;
    this.engineGate = engineGate;
    this.maxAttempts = maxAttempts;

    this.dedupWindowMs = this.config.dedupWindowMs ?? 5000;
    this.backoffBaseMs = this.config.backoffBaseMs ?? 500;
    this.backoffMaxMs = this.config.backoffMaxMs ?? 30000;

    // Monotonic sequence: starts at seqBase (default 0) and increments once per
    // dispatched/attempted action. The fusion client's own seq wins when it is
    // present (some engines stamp their own monotonic sequence).
    this.seq = this.config.seqBase || 0;

    // Dedup bookkeeping: steerKey -> last dispatch/outcome timestamp.
    this.lastActionAt = new Map();
    // Correlated audit log: every outcome, keyed by task/command/seq.
    this.steerLog = [];
    this.dispatchCount = 0;
  }

  now() {
    return this.clock.now();
  }

  // Whether the engine is present. Bounded: a discrete steer consults the gate
  // (or one detectEngine) exactly once; it never probes in a loop.
  async enginePresent() {
    if (this.engineGate) {
      return Boolean(await this.engineGate());
    }
    try {
      const res = await this.fusion.detectEngine();
      return Boolean(res && res.present);
    } catch {
      return false;
    }
  }

  // Steer a task with the safety guarantees. `force` bypasses dedup (used by
  // heartbeat variants that must always be observed) but never bypasses the
  // engine gate.
  async steer(taskId, command, { force = false } = {}) {
    const now = this.now();
    const key = steerKey(taskId, command);

    // 1. Deduplicate identical commands within the window (unless forced).
    const last = this.lastActionAt.get(key);
    if (!force && last !== undefined && now - last < this.dedupWindowMs) {
      const outcome = { ok: false, skipped: true, deduped: true, seq: null, taskId, command, at: now };
      this.steerLog.push(outcome);
      this.logger && this.logger.warn('steer_deduped', { taskId }, { command });
      return outcome;
    }

    // 2. Safe-gate on engine presence: never dispatch to a dead engine.
    const present = await this.enginePresent();
    if (!present) {
      const seq = this.nextSeq();
      const outcome = { ok: false, skipped: true, seq, taskId, command, at: now, reason: 'engine_absent' };
      this.lastActionAt.set(key, now);
      this.steerLog.push(outcome);
      this.logger && this.logger.warn('steer_skipped', { taskId }, { command, reason: 'engine_absent' });
      this.notify('steer_skipped', { taskId, command, seq, reason: 'engine_absent' });
      return outcome;
    }

    // 3. Dispatch with bounded retries + exponential backoff. A persistent
    //    failure fails safe after maxAttempts — never an infinite loop.
    let ok = false;
    let attempt = 0;
    let dispatched = null;
    for (;;) {
      const wait = attempt >= this.maxAttempts
        ? -1
        : Math.min(this.backoffBaseMs * 2 ** attempt, this.backoffMaxMs);
      if (wait < 0) {
        break;
      }
      try {
        dispatched = await this.fusion.steer(taskId, command);
        if (dispatched && dispatched.ok) {
          ok = true;
          break;
        }
      } catch {
        dispatched = null;
      }
      attempt += 1;
      if (attempt >= this.maxAttempts) {
        break;
      }
      await this.waitFn(wait);
    }

    // Monotonic seq: prefer the client's seq when it stamps one; otherwise use
    // our own counter so the audit trail is always ordered and unique.
    const seq = dispatched && dispatched.seq ? dispatched.seq : this.nextSeq();
    const outcome = {
      ok,
      skipped: !ok,
      seq,
      taskId,
      command,
      at: now,
      attempts: attempt,
    };
    this.lastActionAt.set(key, now);
    this.dispatchCount += 1;
    this.steerLog.push(outcome);
    if (ok) {
      this.logger && this.logger.info('steered', { taskId }, { command, seq, attempts: attempt });
      this.notify('steered', { taskId, command, seq, attempts: attempt });
    } else {
      this.logger && this.logger.error('steer_failed', { taskId }, { command, seq, attempts: attempt });
      this.notify('steer_failed', { taskId, command, seq, attempts: attempt });
    }
    return outcome;
  }

  // A lightweight heartbeat command variant with the same guarantees. It
  // requests the engine to acknowledge liveness (a no-op command), deduped like
  // any other command.
  async heartbeat(taskId, { force = false } = {}) {
    return this.steer(taskId, 'heartbeat', { force });
  }

  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  // Deliver an alert notification, non-blocking and evergreen (never bubbles a
  // notifier failure into the steering path).
  notify(kind, fields) {
    if (!this.notifier) {
      return;
    }
    const notification = { kind, at: this.now(), ...fields };
    try {
      this.notifier.notify(notification).catch(() => {});
    } catch {
      // notifier failure is non-fatal for steering
    }
  }
}

// Convenience: a default backoff waiter that advances a fake clock instead of
// sleeping (used by tests to drive backoff instantly with no real timers).
export function fakeWaitFn(clock, sleepMs = 0) {
  return async (ms) => {
    if (sleepMs > 0) {
      clock.advance(sleepMs);
    } else {
      // Advance the fake clock to cover the requested backoff window so any
      // clock-sensitive gate (dedup window) sees the elapsed time.
      clock.advance(ms);
    }
  };
}