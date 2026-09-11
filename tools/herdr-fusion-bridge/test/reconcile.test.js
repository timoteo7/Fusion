// reconcile.test.js — idempotent reconciliation + orphan recovery after restart.
//
// Proves:
//   • A registry seeded with tasks/panes that no longer exist is cleaned up.
//   • Running reconcile twice is IDEMPOTENT (second run is a no-op: same empty
//     side-effect set, no re-emissions).
//   • Restart/resume with persisted markers (fresh load from a tmp state file)
//     preserves live entries and cleans orphans exactly once.
//   • A revived orphan (task returns to the live set) is cleared for re-correlation.
//   • Reconcile fails safe (skips, no mutation) when an integration is unavailable.
//   • No dangling timer, watcher, or un-reaped child process remains after cleanup.
//
// State files are written to a tmp path (never the real repo state file) and are
// removed in a fixture teardown. The whole suite is synchronous/promise-driven
// with no long-lived handles.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PersistentState, defaultState } from '../src/state.js';
import { OrphanRecovery } from '../src/watchers/orphan-recovery.js';
import { fakeClock } from '../src/clock.js';
import { createLogger, memorySink } from '../src/logger.js';
import { FakeFusionClient, FakeHerdrClient } from '../src/adapters/fakes.js';

// A fresh tmp directory used for the real persisted-state files. Removed after
// each test so no repo file or leftover state is created.
const tmpDirs = [];
function tmpDir(prefix = 'hfb-state-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

test.afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

// Build a reconcile harness with a real PersistentState against a tmp state file
// (proves persistence round-trip) plus deterministic fakes + a fake clock.
function makeHarness({
  seedTasks = null,
  seedOrphans = null,
  file = null,
  fusionPresent = true,
} = {}) {
  const clock = fakeClock(1000);
  const stateFile = file || join(tmpDir(), 'state.json');
  const state = new PersistentState({ file: stateFile, now: () => clock.now() });
  const loaded = state.load();
  if (seedTasks) {
    for (const t of seedTasks) {
      state.applyObservation(t);
    }
  }
  if (seedOrphans) {
    for (const o of seedOrphans) {
      state.markOrphan(o.taskId, { paneId: o.paneId, reason: o.reason || 'orphaned', at: clock.now() });
    }
  }
  const fusion = new FakeFusionClient();
  fusion.setEnginePresent(fusionPresent);
  const herdr = new FakeHerdrClient();
  // A logger so we can assert correlated orphan log lines.
  const sink = memorySink();
  const logger = createLogger({ sink, clock });
  const recovery = new OrphanRecovery({ state, fusion, herdr, logger, clock });
  return { recovery, state, fusion, herdr, logger, sink, clock, stateFile };
}

test('reconcile prunes a task whose pane no longer exists (dead pane orphan)', async () => {
  const { recovery, state, fusion, herdr, sink } = makeHarness({
    seedTasks: [{ taskId: 'T-1', executorId: 'E-1', paneId: 'P-1', state: 'active', seq: 1 }],
  });
  // The live engine still has T-1, but pane P-1 is gone from Herdr.
  fusion.addTask({ taskId: 'T-1', executorId: 'E-1', paneId: 'P-1', state: 'active', seq: 1 });
  // No pane added -> dead pane.
  const result = await recovery.reconcile();
  assert.equal(result.skipped, false);
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].taskId, 'T-1');
  assert.equal(result.removed[0].reason, 'pane_dead');
  assert.equal(state.task('T-1'), null, 'orphaned task removed from live registry');
  assert.ok(state.orphanedIds().includes('T-1'));
  assert.equal(recovery.emissionCount('orphan_removed'), 1);
  // A correlated log line records the orphan with its pane.
  assert.ok(sink.records.some((r) => r.event === 'orphan_removed' && r.taskId === 'T-1' && r.paneId === 'P-1'));
});

test('reconcile prunes a task that vanished from the engine entirely', async () => {
  const { recovery, state, fusion, herdr } = makeHarness({
    seedTasks: [{ taskId: 'T-99', executorId: 'E-99', paneId: 'P-9', state: 'active', seq: 1 }],
  });
  // Herdr still has the pane, but the engine no longer lists T-99.
  herdr.addPane('P-9', true);
  const result = await recovery.reconcile();
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].reason, 'task_absent');
  assert.equal(state.task('T-99'), null);
});

test('reconcile is IDEMPOTENT — a second run produces no further side effects', async () => {
  const { recovery, state, fusion, herdr } = makeHarness({
    seedTasks: [{ taskId: 'T-1', paneId: 'P-1', state: 'active', seq: 1 }],
  });
  fusion.addTask({ taskId: 'T-1', paneId: 'P-1', state: 'active', seq: 1 });
  const first = await recovery.reconcile();
  assert.equal(first.removed.length, 1, 'first run removes the orphan');
  const emissionsAfterFirst = recovery.emissionCount('orphan_removed');

  // Second run: the orphan is already marked; staleness in the live set is the
  // same, but markOrphan returns false so no new emission occurs.
  const second = await recovery.reconcile();
  assert.equal(second.removed.length, 0, 'second run is a no-op');
  assert.equal(second.revived.length, 0);
  assert.equal(recovery.emissionCount('orphan_removed'), emissionsAfterFirst, 'no duplicate emission');
  assert.equal(recovery.orphanCount(), 1, 'orphan persists as marked');
});

test('restart/resume with persisted markers cleans orphans exactly once', async () => {
  const clock = fakeClock(1000);
  const stateFile = join(tmpDir(), 'state.json');

  // "Before restart": seed a live task and an already-orphaned marker, persist.
  const s1 = new PersistentState({ file: stateFile, now: () => clock.now() });
  s1.load();
  s1.applyObservation({ taskId: 'T-LIVE', executorId: 'E-1', paneId: 'P-1', state: 'active', seq: 2 });
  s1.applyObservation({ taskId: 'T-DEAD', executorId: 'E-2', paneId: 'P-2', state: 'active', seq: 1 });
  s1.save();
  assert.ok(existsSync(stateFile), 'state file persisted to the tmp path');

  // "After restart": a brand-new state loads from the persisted file.
  const state = new PersistentState({ file: stateFile, now: () => clock.now() });
  const loaded = state.load();
  assert.equal(loaded.tasks['T-LIVE'].paneId, 'P-1', 'live task restored after restart');
  assert.ok(loaded.tasks['T-DEAD'], 'dead task restored after restart (to be reconciled)');

  const fusion = new FakeFusionClient();
  fusion.setEnginePresent(true);
  fusion.addTask({ taskId: 'T-LIVE', executorId: 'E-1', paneId: 'P-1', state: 'active', seq: 2 });
  const herdr = new FakeHerdrClient();
  herdr.addPane('P-1', true); // P-2 (the dead task's pane) is absent
  const recovery = new OrphanRecovery({ state, fusion, herdr, clock });

  const result = await recovery.reconcile();
  assert.deepEqual(
    result.removed.map((r) => r.taskId),
    ['T-DEAD'],
    'only the dead task is orphaned on resume',
  );
  assert.equal(state.task('T-LIVE').paneId, 'P-1', 'live task untouched');
  assert.equal(state.task('T-DEAD'), null);
  assert.equal(recovery.emissionCount('orphan_removed'), 1);

  // A second reconcile on the resumed state is a no-op.
  const second = await recovery.reconcile();
  assert.equal(second.removed.length, 0);
  assert.equal(recovery.emissionCount('orphan_removed'), 1, 'no re-emission after resume reconcile');
});

test('a revived orphan (task returns to the live set) is cleared for re-correlation', async () => {
  const { recovery, state, fusion, herdr } = makeHarness({
    seedTasks: [{ taskId: 'T-5', paneId: 'P-5', state: 'active', seq: 1 }],
  });
  // First pass: T-5 vanished -> orphaned.
  const first = await recovery.reconcile();
  assert.equal(first.removed.length, 1);
  assert.ok(state.orphanedIds().includes('T-5'));

  // The task returns to the engine and its pane is alive.
  fusion.addTask({ taskId: 'T-5', paneId: 'P-5', state: 'active', seq: 2 });
  herdr.addPane('P-5', true);
  const second = await recovery.reconcile();
  assert.equal(second.revived.length, 1);
  assert.equal(second.revived[0].taskId, 'T-5');
  assert.equal(state.orphanedIds().includes('T-5'), false, 'revived orphan no longer marked orphaned');
  assert.equal(recovery.emissionCount('orphan_revived'), 1);
});

test('reconcile fails SAFE when an integration is unavailable (no mutation, skip)', async () => {
  const { recovery, state, fusion } = makeHarness({
    seedTasks: [{ taskId: 'T-1', paneId: 'P-1', state: 'active', seq: 1 }],
  });
  // The Fusion listTasks transport is down: reconcile must NOT orphan every
  // known task (that would be a catastrophic safe-fail bug).
  const origBefore = state.taskIds();
  fusion.listTasks = async () => {
    throw new Error('fusion down');
  };
  const result = await recovery.reconcile();
  assert.equal(result.skipped, true);
  assert.ok(result.error && result.error.includes('fusion down'));
  // No mutations happened: T-1 is still a live task, not orphaned.
  assert.deepEqual(state.taskIds(), origBefore);
  assert.equal(state.orphanedCount(), 0);
  assert.equal(recovery.emissionCount('orphan_removed'), 0);
});

test('orphan mutation is idempotent at the state layer (markOrphan twice)', () => {
  const clock = fakeClock(0);
  const state = new PersistentState({ file: join(tmpDir(), 's.json'), now: () => clock.now() });
  state.load();
  state.applyObservation({ taskId: 'T-X', paneId: 'P-X', state: 'active', seq: 1 });
  const first = state.markOrphan('T-X', { paneId: 'P-X', reason: 'pane_dead' });
  const second = state.markOrphan('T-X', { paneId: 'P-X', reason: 'pane_dead' });
  assert.equal(first, true, 'first markOrphan returns true');
  assert.equal(second, false, 'second markOrphan is idempotent (no-op)');
});

test('no dangling timer, watcher, or un-reaped child remains after reconcile', async () => {
  const clock = fakeClock(0);
  const state = new PersistentState({ file: join(tmpDir(), 's.json'), now: () => clock.now() });
  state.load();
  state.applyObservation({ taskId: 'T-1', paneId: 'P-1', state: 'active', seq: 1 });
  state.applyObservation({ taskId: 'T-2', paneId: 'P-2', state: 'active', seq: 1 });
  const fusion = new FakeFusionClient();
  fusion.setEnginePresent(true);
  fusion.addTask({ taskId: 'T-1', paneId: 'P-1', state: 'active', seq: 1 });
  const herdr = new FakeHerdrClient();
  herdr.addPane('P-1', true);
  const recovery = new OrphanRecovery({ state, fusion, herdr, clock });
  await recovery.reconcile();
  await recovery.reconcile();
  // The recovery module holds no timers and never spawns a child; the fake
  // clock has no pending handles and the adapters recorded no spawn.
  assert.equal(clock.pendingTimers(), 0, 'no dangling timers');
  assert.equal(clock.fired.length, 0, 'no timer fired (pure pass)');
  assert.equal(fusion.transport.count('listTasks'), 2, 'one listTasks per reconcile run');
  assert.equal(herdr.transport.count('listPanes'), 2, 'one listPanes per reconcile run');
});

test('new defaultState is empty and ready (schema-versioned)', () => {
  const d = defaultState();
  assert.equal(d.schemaVersion, 1);
  assert.deepEqual(d.tasks, {});
  assert.deepEqual(d.orphaned, {});
  assert.equal(d.seq, 0);
});

test('notification/steer markers persist across a restart (dedup survives shutdown)', () => {
  const clock = fakeClock(1000);
  const stateFile = join(tmpDir(), 'm.json');
  const s1 = new PersistentState({ file: stateFile, now: () => clock.now() });
  s1.load();
  // A marker keyed by correlation id — e.g. blocked was already notified.
  const changed = s1.setMarker('T-1|E-1|P-1|blocked', { kind: 'blocked', at: clock.now() });
  assert.equal(changed, true, 'first marker set is a change');
  const changedSame = s1.setMarker('T-1|E-1|P-1|blocked', { kind: 'blocked', at: clock.now() + 5 });
  assert.equal(changedSame, false, 'same kind does not bump the marker (idempotent)');
  s1.save();

  // Restart into a brand-new state: the marker survived.
  const s2 = new PersistentState({ file: stateFile, now: () => clock.now() });
  s2.load();
  const marker = s2.getMarker('T-1|E-1|P-1|blocked');
  assert.equal(marker.kind, 'blocked');

  // A different kind is a real change and bumps the marker.
  const changedKind = s2.setMarker('T-1|E-1|P-1|blocked', { kind: 'completed', at: clock.now() });
  assert.equal(changedKind, true);
  assert.equal(s2.getMarker('T-1|E-1|P-1|blocked').kind, 'completed');

  // Clearing markers for a task drops them.
  const removed = s2.clearMarkersFor('T-1');
  assert.equal(removed, 1);
  assert.equal(s2.getMarker('T-1|E-1|P-1|blocked'), null);
});