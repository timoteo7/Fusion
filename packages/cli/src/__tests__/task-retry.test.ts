/**
 * FNXC:PostgresCutover 2026-07-04-00:00:
 * Migrated from the legacy SQLite `new TaskStore(tmpDir)` harness to the
 * PostgreSQL extension harness. `runTaskRetry` resolves its store through the
 * CLI command path (`project-context.resolveProject`), which is independent of
 * the extension store cache the harness injects — so `resolveProject` is
 * redirected to the harness's PG-backed store, and the full retry lifecycle
 * (moveTask / updateTask / getTask / logEntry) runs against real PostgreSQL
 * state instead of the removed SQLite runtime.
 *
 * FNXC:CliTests 2026-07-16-08:45:
 * FN-8102 repairs stale retry scaffolding left after the PG migration: every
 * lifecycle seed and verification read must use the initialized harness store,
 * rather than the removed `createStore()` helper.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createPgExtensionHarness } from "./pg-extension-harness.js";

// `runTaskRetry` resolves its store via resolveProject() (commands/task.ts →
// project-context.ts), a separate cache from the extension store the harness
// injects. Redirect resolveProject to the harness PG store so the command path
// and the seeded task share one isolated PostgreSQL database.
const resolveProjectMock = vi.hoisted(() => vi.fn());
const closeProjectStoreMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../project-context.js", () => ({
  resolveProject: resolveProjectMock,
  // FNXC:CliTests 2026-07-16-08:47: FN-8102 keeps command-finally cleanup
  // awaitable while the PG harness retains ownership of the test store lifecycle.
  closeProjectStore: closeProjectStoreMock,
}));

import { runTaskRetry } from "../commands/task.js";

const pgTest = pgDescribe;

pgTest("runTaskRetry", () => {
  const h = createPgExtensionHarness("fn-task-retry");

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    resolveProjectMock.mockResolvedValue({
      store: h.store(),
      projectId: h.rootDir(),
      projectPath: h.rootDir(),
      projectName: "test",
      isRegistered: false,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resolveProjectMock.mockReset();
    closeProjectStoreMock.mockClear();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("retries merge-active missing-worktree session failures by clearing phantom metadata", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "missing worktree merge-active task",
      description: "test",
      column: "todo",
    });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "merging",
      error: "Refusing to start coding agent in missing worktree: /tmp/fusion-missing-worktree",
      worktree: "/tmp/fusion-missing-worktree",
      branch: `fusion/${task.id}`,
      // FNXC:CliTests 2026-08-23-16:14: FN-107 requires branchWriteOrigin provenance on every branch write; this engine-simulated fixture predates that guard.
      branchWriteOrigin: "engine" as const,
      sessionFile: "/tmp/fusion-session.json",
      steps: [{ name: "implemented", status: "done" }, { name: "fix", status: "pending" }],
      worktreeSessionRetryCount: 3,
      mergeRetries: 3,
    });

    await runTaskRetry(task.id);

    const verificationStore = h.store();
    const updated = await verificationStore.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeUndefined();
    expect(updated.error).toBeUndefined();
    expect(updated.worktree).toBeUndefined();
    expect(updated.branch).toBeUndefined();
    expect(updated.sessionFile).toBeUndefined();
    expect(updated.worktreeSessionRetryCount).toBe(0);
    expect(updated.mergeRetries).toBe(0);
    expect(updated.steps?.[0]?.status).toBe("done");
  });

  it("rejects unrelated merge-active tasks without the missing-worktree signature", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "ordinary merge", description: "test", column: "todo" });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "merging",
      error: "ordinary merge still running",
      steps: [{ name: "implemented", status: "done" }],
    });

    await expect(runTaskRetry(task.id)).rejects.toThrow(/not in a retryable state/);
  });

  /*
   * FNXC:MergeRetryAdmission CI drift fix (b4cddcbd9 lane):
   * This fixture is a MERGE failure, not an execution failure: every step is done and
   * mergeRetries has already been spent. FN-9317 ("recover stalled in-review merges")
   * made that shape retry IN PLACE — clear status/error/auto-pause, reset mergeRetries,
   * and keep the card in its review column so the approved work is not re-run.
   *
   * The `todo` assertion below is pre-FN-9317 drift from FN-6173, which briefly sent CLI
   * merge retries back to todo; FN-9317 reverted that in commands/task.ts. The product is
   * correct here, and every sibling surface already asserts the in-place behavior for this
   * same shape: src/commands/__tests__/task.test.ts asserts `moveTask` is NOT called and the
   * "in-review merge retry, mergeRetries reset" log; src/__tests__/extension.test.ts asserts
   * `details.newColumn === "in-review"`; the dashboard route classifies it identically.
   *
   * The auto-pause clear this test exists to pin (FN-5937) is asserted unchanged below, and
   * the deadlock auto-pause on a path that DOES re-queue is covered by the execution-failure
   * case added directly after this one.
   */
  it("clears the deadlock auto-pause on an in-review merge retry without re-queueing the card", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "deadlock-paused task",
      description: "test",
      column: "todo",
    });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "failed",
      error: "merge deadlock",
      paused: true,
      pausedReason: "in-review-stall-deadlock",
      steps: [{ name: "implemented", status: "done" }],
      mergeRetries: 4,
    });

    await runTaskRetry(task.id);

    const updated = await store.getTask(task.id);
    // Merge retry restarts merge in review; it must not rebound a fully executed card.
    expect(updated.column).toBe("in-review");
    expect(updated.status).toBeFalsy();
    expect(updated.error).toBeFalsy();
    expect(updated.paused).toBeFalsy();
    expect(updated.pausedReason).toBeFalsy();
    expect(updated.mergeRetries).toBe(0);
  });

  /*
   * FNXC:MergeRetryAdmission CI drift fix: the re-queue half of the deadlock auto-pause
   * contract. An in-review card with unfinished steps is an EXECUTION failure, so retry
   * re-queues it to the board's hold column with progress preserved. Mirrors the
   * execution-failed deadlock case already asserted in src/__tests__/extension.test.ts.
   */
  it("clears the deadlock auto-pause and re-queues an execution-failed in-review task", async () => {
    const store = h.store();
    const task = await store.createTask({
      title: "deadlock-paused execution-failed task",
      description: "test",
      column: "todo",
    });
    await store.updateTask(task.id, {
      steps: [
        { name: "implemented", status: "done" },
        { name: "fix", status: "pending" },
      ],
    });
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.updateTask(task.id, {
      status: "failed",
      error: "executor stalled after deadlock pause",
      paused: true,
      pausedReason: "in-review-stall-deadlock",
      mergeRetries: 0,
    });

    await runTaskRetry(task.id);

    const updated = await store.getTask(task.id);
    expect(updated.column).toBe("todo");
    expect(updated.status).toBeFalsy();
    expect(updated.error).toBeFalsy();
    expect(updated.paused).toBeFalsy();
    expect(updated.pausedReason).toBeFalsy();
    // Execution retry preserves step progress rather than resetting merge bookkeeping.
    expect(updated.steps?.[0]?.status).toBe("done");
    expect(updated.steps?.[1]?.status).toBe("pending");
  });
});
