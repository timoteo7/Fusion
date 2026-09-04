// notifier.js — the Notifier interface, dedup logic, delivery backoff and the
// real HTTP/Cli implementations.
//
// A Notifier is a delivery sink. Around it, the bridge deduplicates by
// (correlationId, kind) within HBRIDGE_DEDUP_WINDOW_MS and applies bounded
// delivery backoff. A down integration hook fails safe: it records an alert and
// stops boxing (bounded retries), never a tight loop.

import { buildCorrelationKey } from '../correlator.js';

// The abstract contract. Concrete notifiers return { ok, retries }. They never
// loop; a persistent delivery failure resolves { ok:false, retries } after a
// bounded number of attempts.
//
//   notify(notification) -> Promise<{ ok: boolean, retries: number, skipped? }>
//   close() -> void   (optional; release pooled sockets/handles)
export class AbstractNotifier {
  // eslint-disable-next-line no-unused-vars
  async notify(notification) {
    throw new Error('Notifier.notify not implemented');
  }
  // eslint-disable-next-line no-unused-vars
  close() {}
}

// Compute the dedup key for a notification: (correlationKey, kind). Returns a
// string, or null when the notification cannot be keyed safely at all.
export function notificationKey(notification) {
  const base = buildCorrelationKey({
    taskId: notification.taskId,
    executorId: notification.executorId,
    paneId: notification.paneId,
    kind: notification.kind,
  });
  if (!base) {
    return null;
  }
  return base;
}

// An in-memory dedup gate keyed by the notification key, honoring a time window.
// `seenUntil(key)` returns whether `key` was emitted within the window.
export class DedupGate {
  constructor({ windowMs = 5000, clock = null } = {}) {
    this.windowMs = windowMs;
    this.clock = clock || { now: () => Date.now() };
    this.lastEmitted = new Map(); // key -> ts
  }

  // Record that `key` was just emitted and return true (it was newly allowed).
  // If the key was emitted within the window, return false (deduped).
  mark(key) {
    if (this.seen(key)) {
      return false;
    }
    this.lastEmitted.set(key, this.clock.now());
    return true;
  }

  seen(key) {
    const last = this.lastEmitted.get(key);
    if (last === undefined) {
      return false;
    }
    const now = this.clock.now();
    if (now - last >= this.windowMs) {
      // Window has elapsed; treat as unseen and refresh on next mark.
      this.lastEmitted.delete(key);
      return false;
    }
    return true;
  }

  size() {
    return this.lastEmitted.size;
  }
}

// Bounded delivery backoff controller. It computes the jitter-free (or jittered)
// wait for a given attempt, capped at maxMs, and enforces a max attempt count so
// a down integration cannot retry indefinitely.
export class DeliveryBackoff {
  constructor({ baseMs = 500, maxMs = 30000, maxAttempts = 5, jitter = 0 } = {}) {
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.maxAttempts = maxAttempts;
    this.jitter = jitter;
  }

  waitForAttempt(attempt) {
    if (attempt >= this.maxAttempts) {
      return -1; // retries exhausted
    }
    // Exponential: base * 2^attempt, capped.
    const raw = Math.min(this.baseMs * 2 ** attempt, this.maxMs);
    if (this.jitter > 0) {
      return Math.round(raw * (1 + Math.random() * this.jitter));
    }
    return raw;
  }
}

// A notifier wrapper that deduplicates by (correlationId, kind) within the
// window and applies bounded delivery backoff. Injecting a clock lets tests
// advance time deterministically for dedup windows; injecting `waitFn` lets
// tests drive backoff waiting without real sleeps or dangling timers.
export class DedupNotifier {
  constructor({
    delegate,
    dedupWindowMs = 5000,
    clock = null,
    backoff = null,
    logger = null,
    waitFn = null,
  } = {}) {
    this.delegate = delegate;
    this.gate = new DedupGate({ windowMs: dedupWindowMs, clock });
    this.backoff = backoff || new DeliveryBackoff();
    this.clock = clock || { now: () => Date.now() };
    this.logger = logger;
    this.waitFn = waitFn || ((ms) => sleep(ms));
    this.attempts = 0;
  }

  async notify(notification) {
    const key = notificationKey(notification);
    if (key === null) {
      // Cannot correlate safely: still attempt delivery but flag it.
      if (this.logger) {
        this.logger.warn('notification_unkeyable', {}, { notification });
      }
    } else if (!this.gate.mark(key)) {
      // Deduped within window.
      return { ok: true, retries: this.attempts, deduped: true };
    }

    let ok = false;
    let attempt = 0;
    // Deliver with bounded backoff: maxAttempts total attempts (attempt 0 first).
    for (;;) {
      const wait = this.backoff.waitForAttempt(attempt);
      if (wait < 0) {
        break;
      }
      let delivered = false;
      try {
        const res = await this.delegate.notify(notification);
        delivered = Boolean(res && res.ok);
      } catch {
        delivered = false;
      }
      attempt += 1;
      this.attempts = attempt;
      if (delivered) {
        ok = true;
        break;
      }
      if (attempt >= this.backoff.maxAttempts) {
        break;
      }
      await this.waitFn(wait);
    }
    return { ok, retries: attempt, attempt };
  }

  close() {
    if (this.delegate && typeof this.delegate.close === 'function') {
      this.delegate.close();
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Post a JSON body to HBRIDGE_INTEGRATION_HOOK_URL (Hermes). Safe-fail: a
// network/HTTP error resolves { ok:false } (never throws to a tight loop).
export class HttpNotifier {
  constructor({ hookUrl = '', fetchImpl = null, timeout = 2000, headers = null } = {}) {
    this.hookUrl = hookUrl;
    this.fetchImpl = fetchImpl || ((url, opts) => globalThis.fetch(url, opts));
    this.timeout = timeout;
    this.headers = headers || { 'content-type': 'application/json' };
  }

  async notify(notification) {
    if (!this.hookUrl) {
      return { ok: false, retries: 1, skipped: true };
    }
    try {
      const res = await this.fetchImpl(this.hookUrl, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(notification),
      });
      return { ok: res.ok, retries: 0 };
    } catch {
      return { ok: false, retries: 0 };
    }
  }
}

// Dispatch a notification by invoking a CLI command (or a provided executor).
// The command is configurable; it is spawned bounded and never loops.
export class CliNotifier {
  constructor({ command = [], spawnImpl = null, timeout = 2000 } = {}) {
    this.command = command;
    this.timeout = timeout;
    this.spawnImpl = spawnImpl;
  }

  async notify(notification) {
    if (!this.command || this.command.length === 0) {
      return { ok: false, retries: 1, skipped: true };
    }
    try {
      const { runCaptured } = await import('./herdr-client.js');
      const result = await runCaptured({
        cmd: this.command[0],
        args: this.command.slice(1),
        timeout: this.timeout,
        spawnImpl: this.spawnImpl,
      });
      return { ok: Boolean(result && result.ok), retries: 0 };
    } catch {
      return { ok: false, retries: 0 };
    }
  }
}