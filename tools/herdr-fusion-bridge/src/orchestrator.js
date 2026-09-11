// orchestrator.js — the Bridge: wires the supervisor, SSE watcher, steering
// controller, liveness watchdog, and persisted state into ONE supervised unit
// with a single clean start()/stop() lifecycle.
//
// Design invariants:
//   • stop() is idempotent and releases every handle it owns: supervisor tick
//     interval, SSE stream + reconnect schedule, notifier delegate. After
//     stop() the process has no live timers and no un-reaped children.
//   • Steering is wired through the supervisor's CACHED engine presence (the
//     tick loop owns detection), so a steer never re-probes a down engine.
//   • The watchdog treats only DISCRETE state/seq changes as progress; log
//     lines observed from SSE flow into the log channel and never reset the
//     stall window.
//   • PersistentState is loaded at construction and saved on stop() and after
//     every reconcile, so dedup markers survive a restart.

import { Supervisor } from './bridge.js';
import { createWatchdog } from './watchdog.js';
import { PersistentState } from './state.js';
import { OrphanRecovery } from './watchers/orphan-recovery.js';
import { SseWatcher } from './watchers/sse-watcher.js';
import { SteeringController } from './steering.js';
import { buildCorrelationKey } from './correlator.js';

// Build the live parts for a config. Real adapters are env-configurable; tests
// inject fakes via `parts`. This factory exists so the CLI and the tests share
// EXACTLY the same wiring (the shutdown test proves the production lifecycle).
export function createBridge({
  config,
  fusion,
  herdr,
  notifier = null,
  logger = null,
  clock = null,
  state = null,
  store = null,
  sseWatcher = null,
  supervisor = null,
  stepper = null,
  waitFn = null,
} = {}) {
  if (!config) {
    throw new Error('createBridge requires a config');
  }
  if (!fusion) {
    throw new Error('createBridge requires a FusionClient');
  }
  if (!herdr) {
    throw new Error('createBridge requires a HerdrClient');
  }

  const theState =
    state ||
    new PersistentState({
      file: config.stateFile,
      store: store || undefined,
    });
  theState.load();

  const sup =
    supervisor ||
    new Supervisor({ fusion, herdr, notifier, logger, config, clock });

  const theStepper =
    stepper ||
    new SteeringController({
      fusion,
      notifier,
      logger,
      config,
      clock,
      waitFn,
      // Gate steering on the supervisor's cached engine presence: the tick
      // loop owns bounded detection, so a steer never re-probes a dead engine.
      engineGate: () => sup.enginePresent,
    });

  const watchdog = createWatchdog(config, clock);

  const watcher =
    sseWatcher ||
    new SseWatcher({
      fusion,
      logger,
      config,
      clock,
      onEvent: (event) => {
        // Feed the bridge: a discrete state change credits real progress; log
        // chatter is observed as context ONLY (never liveness-bearing).
        const d = event && event.data ? event.data : {};
        const taskId = d.taskId || null;
        if (taskId) {
          const signature = `${d.state || ''}|${d.seq != null ? d.seq : ''}`;
          if (watchdog.observeSignature(taskId, signature)) {
            sup.recordProgress && sup.recordProgress(taskId);
          }
          if (d.logLine) {
            watchdog.observeLogLine(taskId);
          }
          theState.applyObservation({
            taskId,
            executorId: d.executorId || null,
            paneId: d.paneId || null,
            state: d.state || null,
            seq: d.seq || 0,
          });
        }
      },
    });

  const recovery = new OrphanRecovery({ state: theState, fusion, herdr, logger, clock });

  return new Bridge({
    config,
    fusion,
    herdr,
    notifier,
    logger,
    clock,
    state: theState,
    supervisor: sup,
    sseWatcher: watcher,
    stepper: theStepper,
    watchdog,
    orphanRecovery: recovery,
  });
}

export class Bridge {
  constructor({
    config,
    fusion,
    herdr,
    notifier = null,
    logger = null,
    clock = null,
    state = null,
    supervisor = null,
    sseWatcher = null,
    stepper = null,
    watchdog = null,
    orphanRecovery = null,
  } = {}) {
    this.config = config;
    this.fusion = fusion;
    this.herdr = herdr;
    this.notifier = notifier;
    this.logger = logger;
    this.clock = clock || { now: () => Date.now() };
    this.state = state;
    this.supervisor = supervisor;
    this.sseWatcher = sseWatcher;
    this.stepper = stepper;
    this.watchdog = watchdog;
    this.orphanRecovery = orphanRecovery;
    this.started = false;
    this.stoppedAt = null;
  }

  // Start supervision: supervisor tick loop + SSE watcher. Idempotent.
  start() {
    if (this.started) {
      return false;
    }
    this.started = true;
    if (this.supervisor) {
      this.supervisor.start();
    }
    if (this.sseWatcher) {
      this.sseWatcher.start();
    }
    return true;
  }

  // Clean shutdown: stop every part in reverse dependency order, persist state,
  // and release the notifier delegate. Idempotent; returns the count of parts
  // that were actually stopped (0 on a repeat call).
  stop() {
    let stopped = 0;
    if (!this.started) {
      return 0;
    }
    this.started = false;
    this.stoppedAt = this.clock.now();
    if (this.sseWatcher && this.sseWatcher.stop()) {
      stopped += 1;
    }
    if (this.supervisor && this.supervisor.stop()) {
      stopped += 1;
    }
    if (this.state) {
      try {
        this.state.save();
      } catch {
        // A failed state save never blocks shutdown.
      }
    }
    if (this.notifier && typeof this.notifier.close === 'function') {
      this.notifier.close();
    }
    return stopped;
  }

  // A single bounded reconcile pass, gated on engine presence (safe-fail: when
  // the engine is absent, reconcile is SKIPPED rather than orphaning everything).
  async reconcileOnce() {
    const engine = await this.supervisor.ensureEnginePresence(this.clock.now());
    if (!engine.present) {
      const result = {
        skipped: true,
        reason: 'engine_absent',
        at: this.clock.now(),
      };
      this.logger && this.logger.warn('reconcile_skipped', {}, { reason: 'engine_absent' });
      return result;
    }
    return this.orphanRecovery.reconcile({ now: this.clock.now() });
  }

  // Steer with the full safety stack (engine gate, dedup, bounded retries).
  steer(taskId, command, opts = {}) {
    return this.stepper.steer(taskId, command, opts);
  }

  heartbeat(taskId) {
    return this.stepper.heartbeat(taskId);
  }

  // A status snapshot for the CLI: registry + correlation state, read-only.
  status() {
    const data = this.state ? this.state.snapshot() : null;
    return {
      started: this.started,
      enginePresent: this.supervisor ? this.supervisor.enginePresent : null,
      stateFile: this.config ? this.config.stateFile : null,
      tasks: data ? data.tasks : null,
      associations: data ? data.associations : null,
      orphaned: data ? data.orphaned : null,
      orphanedCount: data ? Object.keys(data.orphaned || {}).length : 0,
      seq: data ? data.seq : 0,
      lastReconciledAt: data ? data.lastReconciledAt : 0,
      markers: data ? Object.keys(data.markers || {}).length : 0,
    };
  }
}
