// orphan-recovery.js — idempotent reconciliation + orphan recovery after a
// restart.
//
// reconcile() recomputes the DESIRED set from the live adapters (the Fusion
// task list and the Herdr pane list) and prunes any persisted registry entry
// whose task or pane/watcher no longer exists. It is IDEMPOTENT: running it
// twice yields exactly the same side-effect set (verified by an emission
// counter). It never leaves a dangling timer, watcher, or child process — the
// module is a pure synchronous state pass with no handles of its own, so the
// only mutation is on the injected PersistentState.
//
// Reconcile is a pure pass; the caller is responsible for gating it on engine
// presence (safe-fail: when the Fusion engine is absent, reconcile must not
// run, because the "desired set" would be empty and it would wrongly orphan
// every known task). The `engine` guard is enforced by the platform gating this
// module and is asserted by the bridge/CLI underneath it.

export class OrphanRecovery {
  constructor({ state, fusion, herdr, logger = null, clock = null } = {}) {
    if (!state) {
      throw new Error('OrphanRecovery requires a PersistentState');
    }
    if (!fusion) {
      throw new Error('OrphanRecovery requires a FusionClient');
    }
    if (!herdr) {
      throw new Error('OrphanRecovery requires a HerdrClient');
    }
    this.state = state;
    this.fusion = fusion;
    this.herdr = herdr;
    this.logger = logger;
    this.clock = clock || { now: () => Date.now() };
    this.nowMs = () => this.clock.now();

    // Observability: every emit that a reconcile run actually produced. Tests
    // assert the SECOND run is a no-op (same empty side-effect set).
    this.emissions = [];
    this.reconcileRuns = 0;
    this.lastResult = null;
  }

  // Recompute the desired set and prune orphans. Returns
  //   { run, at, activeTasks, livePanes, liveCount, removed: [...], revived: [...] }
  // where `removed` are the entries this run actually orphaned and `revived`
  // are previously-orphaned tasks that re-appeared in the live set. Both are
  // empty on an idempotent replay.
  async reconcile({ now = this.nowMs() } = {}) {
    this.reconcileRuns += 1;
    const run = this.reconcileRuns;
    const removed = [];
    const revived = [];
    // taskIds orphaned by THIS run. The revive pass below must never revive an
    // entry that this very run just orphaned (a present-but-dead-pane task is
    // orphaned now, not revived); only entries orphaned by a PREVIOUS reconcile
    // run are eligible to be revived when they return to the live set.
    const justOrphaned = new Set();

    // 1. Desired set from the live adapters. Any failure here is a safe-fail:
    //    resolve to an empty desired set is WRONG (it would orphan everything),
    //    so instead we bail without mutating and let the caller cool down.
    let tasks;
    let panes;
    try {
      tasks = await this.fusion.listTasks();
      panes = await this.herdr.listPanes();
    } catch (err) {
      const result = {
        run,
        at: now,
        activeTasks: [],
        livePanes: [],
        liveCount: 0,
        removed,
        revived,
        error: String(err && err.message ? err.message : err),
        skipped: true,
      };
      this.lastResult = result;
      if (this.logger) {
        this.logger.warn('reconcile_skipped', { error: result.error, reason: 'integration unavailable' });
      }
      return result;
    }

    const activeTaskIds = new Set(tasks.map((t) => t.taskId).filter(Boolean));
    const livePanes = new Set(
      (panes || []).filter((p) => p && p.alive !== false).map((p) => p.paneId).filter(Boolean),
    );

    // 2. Prune known tasks that are orphans: the task vanished from the engine,
    //    or its pane no longer exists / is dead.
    for (const taskId of this.state.taskIds()) {
      const task = this.state.task(taskId);
      const stillPresent = activeTaskIds.has(taskId);
      const paneId = task ? task.paneId : null;
      const paneAlive = paneId ? livePanes.has(paneId) : true;
      if (stillPresent && paneAlive) {
        continue;
      }
      const reason = !stillPresent ? 'task_absent' : 'pane_dead';
      const changed = this.state.markOrphan(taskId, { paneId, reason, at: now });
      if (changed) {
        justOrphaned.add(taskId);
        this.emissions.push({ kind: 'orphan_removed', taskId, paneId, reason, at: now });
        removed.push({ taskId, paneId, reason });
        this.logger && this.logger.warn('orphan_removed', { taskId, paneId, reason });
      }
      // When already orphaned (idempotent replay), markOrphan returns false and
      // nothing is re-emitted — the run is a no-op for this entry.
    }

    // 3. Rebuild: a previously-orphaned task that is present again in the live
    //    set AND whose pane is actually alive again is revived so the supervisor
    //    re-correlates it (associations are rebuilt on the next tick, not here).
    //    A task that is present but whose pane is STILL dead is NOT revived — it
    //    stays orphaned (idempotent; this is what keeps a second reconcile from
    //    flipping a pane_dead orphan back to live).
    for (const taskId of this.state.orphanedIds()) {
      if (!activeTaskIds.has(taskId)) {
        continue;
      }
      if (justOrphaned.has(taskId)) {
        continue;
      }
      const orphanMeta = this.state.data.orphaned[taskId];
      const paneBack = orphanMeta && orphanMeta.paneId && livePanes.has(orphanMeta.paneId);
      if (!paneBack) {
        continue;
      }
      const changed = this.state.removeTask(taskId);
      if (changed) {
        this.emissions.push({ kind: 'orphan_revived', taskId, at: now });
        revived.push({ taskId });
        this.logger && this.logger.info('orphan_revived', { taskId });
      }
    }

    const result = {
      run,
      at: now,
      activeTasks: [...activeTaskIds],
      livePanes: [...livePanes],
      liveCount: activeTaskIds.size,
      removed,
      revived,
      skipped: false,
    };
    if (this.state.save) {
      this.state.save();
    }
    this.lastResult = result;
    return result;
  }

  // The emissions a reconcile run produced. Any caller that needs a persisted
  // marker should rely on the state (markOrphan/removeTask) rather than this
  // in-memory log; emissionCount is the idempotency-check observability hook.
  emissionCount(kind = 'orphan_removed') {
    return this.emissions.filter((e) => e.kind === kind).length;
  }

  // Convenience for tests / CLI status.
  orphanCount() {
    return this.state.orphanedCount();
  }
}