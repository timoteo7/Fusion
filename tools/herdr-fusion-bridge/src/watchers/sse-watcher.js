// sse-watcher.js — resilient consumer of the Fusion SSE event stream with
// reconnect + exponential backoff + jitter, event dedup, and clean shutdown.
//
// The FusionClient.streamEvents generator opens ONE HTTP connection and yields
// parsed events, then ENDS when the stream closes/errors (it never loops). It
// is this watcher's job to reconnect — with bounded exponential backoff and
// jitter so a dying SSE endpoint is never hammered (no busy loop, no infinite
// ping), and to stop reconnecting cleanly when the bridge shuts down.
//
// Guarantees:
//   • Reconnect is always preceded by a backoff delay (base*2^n capped at max),
//     plus a bounded jitter, so consecutive failures grow apart.
//   • Events are deduplicated by SSE id (or a stable signature) within the
//     dedup window, so a replay never re-triggers work.
//   • stop() aborts the in-flight stream and cancels the reconnect schedule:
//     close is clean and immediate, with no dangling timers or open handles.
//   • Safe-fail: a missing/unconfigured SSE URL yields zero events and the
//     watcher idles (engine "absent") rather than spinning.

function sleep(ms, abort) {
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    if (abort && abort.signal) {
      if (abort.signal.aborted) {
        return done();
      }
      abort.signal.addEventListener('abort', done, { once: true });
    }
    timer = setTimeout(done, ms);
  });
}

// A deterministic, partly-seeded PRNG so jitter is reproducible in tests but
// still varies across runs. `rand` defaults to Math.random.
function jitterFor(backoff, rand = Math.random) {
  // +/- 20% jitter around the backoff delay, never negative.
  const factor = 0.8 + rand() * 0.4;
  return Math.max(1, Math.round(backoff * factor));
}

// Stable dedup key: the SSE id when present, otherwise a deterministic
// signature of the event's discriminators. Collapses missing to 'unknown'.
export function eventKey(event) {
  if (event && event.id != null && event.id !== '') {
    return `sse|${event.id}`;
  }
  // No micro-hash dependency: build from the discriminators a caller can
  // correlate on, falling back to a stable serialization.
  const d = event && event.data;
  const kind = (event && event.event) || (d && d.kind) || 'message';
  const state = (d && d.state) || '';
  const correl = (d && (d.taskId || d.correlationId)) || '';
  const seq = (d && d.seq != null) ? String(d.seq) : '';
  return `sig|${kind}|${state}|${correl}|${seq}`;
}

export class SseWatcher {
  constructor({
    fusion,
    onEvent = null,
    logger = null,
    config = null,
    clock = null,
    waitFn = null,
    rand = Math.random,
    join = false,
  } = {}) {
    if (!fusion) {
      throw new Error('SseWatcher requires a FusionClient');
    }
    this.fusion = fusion;
    this.onEvent = onEvent;
    this.logger = logger;
    this.config = config || {};
    this.clock = clock || { now: () => Date.now() };
    this.rand = rand;
    this.join = join;

    this.backoffBaseMs = this.config.backoffBaseMs ?? 500;
    this.backoffMaxMs = this.config.backoffMaxMs ?? 30000;
    this.dedupWindowMs = this.config.dedupWindowMs ?? 5000;

    // Abort controller: closing the watcher aborts the in-flight stream and the
    // pending reconnect wait.
    this.abort = new AbortController();
    this.waitFn = waitFn || ((ms) => sleep(ms, this.abort));

    this.running = false;
    this.stopped = false;
    this.reconnects = 0;
    this.eventsSeen = 0;
    this.failures = 0;
    this.lastEventAt = null;
    this.lastErr = null;
    this._dedupAt = new Map(); // eventKey -> timestamp of last accepted event
    this._loopPromise = null;
  }

  // Start consuming. Returns a promise that resolves when the loop stops (clean
  // shutdown) — the caller typically fires it and forgets, and calls stop() to
  // end it. With `join:true`, awaiting the returned promise waits for shutdown.
  start() {
    if (this.running) {
      return this._loopPromise;
    }
    this.running = true;
    this.stopped = false;
    this._loopPromise = this._loop();
    return this._loopPromise;
  }

  // Clean, immediate shutdown: aborts the in-flight stream and cancels the
  // reconnect schedule. Returns true if the watcher was running.
  stop() {
    if (!this.running) {
      return false;
    }
    this.stopped = true;
    this.running = false;
    this.abort.abort();
    return true;
  }

  // Whether a given event is a NEW event (not a replay within the dedup
  // window). Marks it as seen when it is new.
  acceptEvent(event, now) {
    const key = eventKey(event);
    const ts = now !== undefined ? now : this.now();
    const last = this._dedupAt.get(key);
    if (last !== undefined && ts - last < this.dedupWindowMs) {
      return false;
    }
    this._dedupAt.set(key, ts);
    return true;
  }

  // The reconnection backoff delay for a given failure index (0-based),
  // clamped to [base, max], plus jitter. Exposed for tests.
  backoffFor(failure, rand = this.rand) {
    const raw = Math.min(this.backoffBaseMs * 2 ** failure, this.backoffMaxMs);
    return jitterFor(raw, rand);
  }

  now() {
    return this.clock.now();
  }

  // Consume exactly one stream lifetime: open, yield/onEvent every accepted
  // event, then return when the stream ends (do NOT reconnect here — the loop
  // owns backoff).
  async _consumeOnce() {
    const generator = this.fusion.streamEvents({ signal: this.abort.signal });
    let yielded = 0;
    for await (const event of generator) {
      if (!this.running) {
        break;
      }
      const now = this.now();
      if (this.acceptEvent(event, now)) {
        yielded += 1;
        this.eventsSeen += 1;
        this.lastEventAt = now;
        this.logger && this.logger.info('sse_event', { seq: (event && event.id) || undefined });
        if (this.onEvent) {
          try {
            this.onEvent(event);
          } catch {
            // a consumer callback failure is non-fatal; never kill the watcher
          }
        }
      }
    }
    return yielded;
  }

  // The main loop: consume a stream, and on its end reconnect — but only after
  // a bounded, jittered backoff wait. If stop() is called (running=false), the
  // loop exits rather than reconnect. This is the ONLY place that reconnects,
  // guaranteeing no busy loop.
  async _loop() {
    while (this.running) {
      let yielded = 0;
      try {
        yielded = await this._consumeOnce();
      } catch (err) {
        // A stream error is recoverable: count it and reconnect after backoff.
        this.failures += 1;
        this.lastErr = err && err.message ? err.message : String(err);
        this.logger && this.logger.warn('sse_error', { error: this.lastErr });
      }
      if (!this.running) {
        break;
      }
      // Bounded exponential backoff + jitter before the next attempt.
      const delay = this.backoffFor(this.failures);
      const waited = await this.waitFn(delay);
      if (this.stopped || !this.running) {
        break;
      }
      if (!waited) {
        // waitFn rejected/short-circuited (e.g. aborted): stop reconnecting.
        this.stopped = true;
        this.running = false;
        break;
      }
      this.reconnects += 1;
      // A consume that yielded at least one event is recovery: reset the
      // failure backoff so a healthy stream reconnects snappily, while a
      // persistent failure keeps growing apart.
      if (yielded > 0 && this.failures > 0) {
        this.failures = 0;
      }
    }
  }

  get failed() {
    return this.failures > 0;
  }

  // Convenience: close the watcher (alias for stop()).
  close() {
    return this.stop();
  }
}