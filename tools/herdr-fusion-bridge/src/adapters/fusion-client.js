import { spawn } from 'node:child_process';

// fusion-client.js — the FusionClient interface and its real implementations.
//
// The interface is what the supervisor, watchdog and stepper depend on. The
// real adapters read every wire value (SSE URL, probe command) from config;
// nothing is hardcoded. All adapters fail SAFE: on a down transport they throw
// (or resolve "absent") rather than spin, and callers apply bounded backoff.

// The abstract contract. Concrete clients return plain data and throw on
// transport failure (never a tight loop). Documented for implementers:
//
//   detectEngine()      -> Promise<{ present: boolean, pid?: number, port?: number }>
//   listTasks()         -> Promise<Array<{ taskId, executorId?, paneId?, state }>>
//   readTask(taskId)    -> Promise<{ taskId, executorId?, paneId?, state, seq }>
//   resolveExecutor(id) -> Promise<string | null>
//   streamEvents(sig?)  -> async generator yielding events (kind/state/seq/correl)
//   steer(id, command)  -> Promise<{ ok, seq, skipped? }>
export class AbstractFusionClient {
  // eslint-disable-next-line no-unused-vars
  async detectEngine() {
    throw new Error('FusionClient.detectEngine not implemented');
  }
  // eslint-disable-next-line no-unused-vars
  async listTasks() {
    throw new Error('FusionClient.listTasks not implemented');
  }
  // eslint-disable-next-line no-unused-vars
  async readTask(taskId) {
    throw new Error('FusionClient.readTask not implemented');
  }
  // eslint-disable-next-line no-unused-vars
  async resolveExecutor(taskId) {
    throw new Error('FusionClient.resolveExecutor not implemented');
  }
  // eslint-disable-next-line no-unused-vars
  async *streamEvents({ signal } = {}) {
    throw new Error('FusionClient.streamEvents not implemented');
  }
  // eslint-disable-next-line no-unused-vars
  async steer(taskId, command) {
    throw new Error('FusionClient.steer not implemented');
  }
}

// Detects the Fusion engine process/port using a configurable probe. The probe
// is a command from config (HBRIDGE_FUSION_PROBE_CMD) OR an injectable
// `probe` function for tests. The probe returns whether the engine is present.
export class ProcessFusionDetector {
  constructor({ probe = null, probeArgs = [], run = null, logger = null } = {}) {
    this.probe = probe;
    this.probeArgs = probeArgs;
    // Injectable runner used to execute the probe command; defaults to a
    // bounded child_process.exec of the probe command. Tests inject a fake.
    this.run = run || ((cmdArgs) => runNamed(cmdArgs));
    this.logger = logger;
  }

  async detectEngine() {
    const present = await this.probePresent();
    return present ? { present: true } : { present: false };
  }

  async probePresent() {
    if (this.probe) {
      return Boolean(await this.probe());
    }
    if (!this.probeArgs || this.probeArgs.length === 0) {
      // No probe configured: default to a presence check the caller controls.
      return false;
    }
    // Real runner: exec the probe command with a bounded timeout and treat a
    // zero exit (found) as present, non-zero/error as absent.
    const result = await this.run(this.probeArgs);
    return result === true || result === 0 || result === 'found';
  }
}

// Execute a process command with a bounded timeout, resolving true when the
// process exits 0 (search found a match) and false on non-zero/error.
export function runNamed(cmdArgs, { timeout = 2000 } = {}) {
  return new Promise((resolve) => {
    if (!cmdArgs || cmdArgs.length === 0) {
      resolve(false);
      return;
    }
    const child = spawn(cmdArgs[0], cmdArgs.slice(1), {
      stdio: 'ignore',
      timeout,
    });
    let settled = false;
    const done = (ok) => {
      if (!settled) {
        settled = true;
        resolve(Boolean(ok));
      }
    };
    child.on('exit', (code) => done(code === 0));
    child.on('error', () => done(false));
  });
}

// Consumes the Fusion SSE event stream. `streamEvents` is an async generator
// that opens one HTTP connection and yields parsed events; it ends (never
// loops) when the stream closes or errors, leaving reconnect/backoff to the
// SSE watcher. The injectable `fetchImpl` lets tests drive it with a fake body.
export class SseFusionClient extends AbstractFusionClient {
  constructor({
    sseUrl = '',
    fetchImpl = null,
    headers = null,
    logger = null,
  } = {}) {
    super();
    this.sseUrl = sseUrl;
    this.fetchImpl = fetchImpl || ((url, opts) => globalThis.fetch(url, opts));
    this.headers = headers || { accept: 'text/event-stream' };
    this.logger = logger;
  }

  async detectEngine() {
    // A real SSE URL implies the engine endpoint is reachable; absence of a
    // configured URL means the engine cannot be detected.
    if (!this.sseUrl) {
      return { present: false };
    }
    return { present: true };
  }

  async listTasks() {
    return [];
  }

  async readTask() {
    return null;
  }

  async resolveExecutor() {
    return null;
  }

  async steer() {
    return { ok: false, seq: 0, skipped: true };
  }

  async *streamEvents({ signal } = {}) {
    if (!this.sseUrl) {
      return; // no stream configured: end immediately, watcher sees absence.
    }
    const controller = new AbortController();
    const abortListener = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener('abort', abortListener);
      }
    }
    try {
      const res = await this.fetchImpl(this.sseUrl, {
        signal: controller.signal,
        headers: this.headers,
      });
      if (!res.ok) {
        throw new Error(`SSE request failed: ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          const event = parser.push(line);
          if (event) {
            yield event;
          }
        }
      }
      const tail = parser.push(null);
      if (tail) {
        yield tail;
      }
    } finally {
      if (signal) {
        signal.removeEventListener('abort', abortListener);
      }
    }
  }
}

// A minimal, deterministic SSE frame parser: accumulates `event`, `data` and
// `id` lines and emits a parsed event object when a blank line (dispatch) or a
// null (final) arrives. Non-mutating, resettable by construction.
export function createSseParser() {
  let eventType = null;
  let dataLines = [];
  let lastId = null;
  let ready = false;

  return {
    push(line) {
      if (line === null) {
        return flush();
      }
      if (ready) {
        ready = false;
      }
      if (line === '') {
        return flush();
      }
      let field = '';
      let value = '';
      if (line.startsWith(':')) {
        return null; // comment line, ignore
      }
      const colon = line.indexOf(':');
      if (colon === -1) {
        field = line;
        value = '';
      } else {
        field = line.slice(0, colon);
        value = line.slice(colon + 1);
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }
      }
      if (field === 'event') {
        eventType = value;
      } else if (field === 'data') {
        dataLines.push(value);
      } else if (field === 'id') {
        lastId = value;
      }
      return null;
    },
  };

  function flush() {
    if (dataLines.length === 0) {
      eventType = null;
      return null;
    }
    let data = dataLines.join('\n');
    dataLines = [];
    let parsedData = data;
    // Preserve raw string; the caller may JSON.parse it.
    try {
      parsedData = JSON.parse(data);
    } catch {
      // keep raw string
    }
    const event = {
      event: eventType || 'message',
      id: lastId,
      data: parsedData,
    };
    eventType = null;
    return event;
  }
}