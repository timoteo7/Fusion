// fakes.js — deterministic fakes for the three adapters plus a FakeTransport
// that records every call/emission (spins, reconnects, notifications). These
// are what make the whole behavioral contract provable without the live host.

// FakeTransport records every interaction a component has with an integration
// so a test can assert boundedness (no infinite pings, no unbounded reconnects)
// and exact notification counts/sequences.
export class FakeTransport {
  constructor() {
    this.calls = [];
    this.type = 'fake';
  }

  nextId() {
    return this.calls.length + 1;
  }

  record(kind, payload = {}) {
    this.calls.push({ seq: this.nextId(), kind, ...payload });
    return this.calls.length;
  }

  count(kind) {
    return this.calls.filter((c) => c.kind === kind).length;
  }

  // Convenience: total number of recorded events.
  total() {
    return this.calls.length;
  }

  static for(kind) {
    return new FakeTransport(kind);
  }
}

// ---------------------------------------------------------------------------
// Fake Fusion
// ---------------------------------------------------------------------------

// Deterministic Fusion client. The test controls engine presence, task list,
// task states, and the SSE event queue via public setter methods. Every call is
// recorded on the transport so tests can assert bounded probe/steer counts.
export class FakeFusionClient {
  constructor({ transport = null } = {}) {
    this.transport = transport || new FakeTransport();
    this.enginePresent = false;
    this.tasks = []; // [{ taskId, executorId?, paneId?, state }]
    this.states = new Map(); // taskId -> current state string
    this.eventQueue = []; // events to yield from streamEvents
    this.steerLog = []; // [{ taskId, command, seq }]
    this.seq = 1;
    this.sseEnded = false;
  }

  setEnginePresent(present) {
    this.enginePresent = Boolean(present);
  }

  addTask(task) {
    this.tasks.push(task);
    if (task.state) {
      this.states.set(task.taskId, task.state);
    }
  }

  setState(taskId, state) {
    this.states.set(taskId, state);
  }

  setCurrentState(taskId, state) {
    this.states.set(taskId, state);
  }

  queueEvent(event) {
    this.eventQueue.push(event);
  }

  async detectEngine() {
    this.transport.record('detectEngine', { present: this.enginePresent });
    return { present: this.enginePresent };
  }

  async listTasks() {
    this.transport.record('listTasks', { count: this.tasks.length });
    return this.tasks.map((t) => ({ ...t, state: this.states.get(t.taskId) || t.state }));
  }

  async readTask(taskId) {
    this.transport.record('readTask', { taskId });
    const task = this.tasks.find((t) => t.taskId === taskId);
    if (!task) {
      return null;
    }
    return { ...task, state: this.states.get(taskId) || task.state };
  }

  async resolveExecutor(taskId) {
    this.transport.record('resolveExecutor', { taskId });
    const task = this.tasks.find((t) => t.taskId === taskId);
    return task ? task.executorId || null : null;
  }

  async *streamEvents({ signal } = {}) {
    this.transport.record('streamEvents', { count: this.eventQueue.length });
    while (this.eventQueue.length > 0 && !(signal && signal.aborted)) {
      yield this.eventQueue.shift();
    }
  }

  async steer(taskId, command) {
    const seq = this.seq++;
    this.steerLog.push({ taskId, command, seq });
    this.transport.record('steer', { taskId, command, seq });
    if (!this.enginePresent) {
      return { ok: false, seq, skipped: true };
    }
    return { ok: true, seq, skipped: false };
  }
}

// ---------------------------------------------------------------------------
// Fake Herdr
// ---------------------------------------------------------------------------

// Deterministic Herdr client. The test controls the pane list and per-pane
// logs. Every call is recorded so tests can assert no orphaned/spun lookups.
export class FakeHerdrClient {
  constructor({ transport = null } = {}) {
    this.transport = transport || new FakeTransport();
    this.panes = []; // [{ paneId, alive }]
    this.logs = new Map(); // paneId -> [line,...]
    this.paneByTask = new Map(); // taskId -> paneId
    this.paneByExecutor = new Map(); // executorId -> paneId
  }

  addPane(paneId, alive = true) {
    this.panes.push({ paneId, alive });
    if (!this.logs.has(paneId)) {
      this.logs.set(paneId, []);
    }
  }

  removePane(paneId) {
    this.panes = this.panes.filter((p) => p.paneId !== paneId);
    this.logs.delete(paneId);
  }

  setPaneLogs(paneId, lines) {
    this.logs.set(paneId, lines);
  }

  mapPane(taskId, executorId, paneId) {
    if (taskId) {
      this.paneByTask.set(taskId, paneId);
    }
    if (executorId) {
      this.paneByExecutor.set(executorId, paneId);
    }
  }

  async listPanes() {
    this.transport.record('listPanes', { count: this.panes.length });
    return this.panes.map((p) => ({ ...p }));
  }

  async resolvePane(taskId, executorId) {
    this.transport.record('resolvePane', { taskId, executorId });
    if (taskId && this.paneByTask.has(taskId)) {
      return this.paneByTask.get(taskId);
    }
    if (executorId && this.paneByExecutor.has(executorId)) {
      return this.paneByExecutor.get(executorId);
    }
    return null;
  }

  async logsForPane(paneId) {
    this.transport.record('logsForPane', { paneId });
    return this.logs.get(paneId) || [];
  }

  async isPaneAlive(paneId) {
    this.transport.record('isPaneAlive', { paneId });
    const pane = this.panes.find((p) => p.paneId === paneId);
    return Boolean(pane && pane.alive !== false);
  }
}

// ---------------------------------------------------------------------------
// Fake Notifier
// ---------------------------------------------------------------------------

// Deterministic notifier that records every notification it is asked to send
// and can be configured to fail delivery (for safe-fail tests).
export class FakeNotifier {
  constructor({ transport = null, fail = false, failCount = -1 } = {}) {
    this.transport = transport || new FakeTransport();
    this.notifications = [];
    this.fail = fail;
    this.failCount = failCount;
    this.failed = 0;
  }

  async notify(notification) {
    this.transport.record('notify', { kind: notification.kind, taskId: notification.taskId });
    if (this.fail && (this.failCount === -1 || this.failed < this.failCount)) {
      this.failed += 1;
      return { ok: false, retries: 1 };
    }
    this.notifications.push({ ...notification });
    return { ok: true, deduped: false, retries: 0 };
  }

  count(kind) {
    if (kind === undefined) {
      return this.notifications.length;
    }
    return this.notifications.filter((n) => n.kind === kind).length;
  }

  clear() {
    this.notifications = [];
  }

  // Interface parity with AbstractNotifier: track close() so shutdown tests can
  // prove the delegate is released exactly once.
  close() {
    this.closeCount = (this.closeCount || 0) + 1;
    return undefined;
  }
}