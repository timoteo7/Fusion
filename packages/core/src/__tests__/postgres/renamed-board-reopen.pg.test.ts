/*
FNXC:WorkflowLifecycleColumns 2026-07-30-08:45 (Phase C convergence — E2E evidence):

THE STORE PATH, not the hook in isolation. `default-workflow-hooks.ts`'s reopen effects
are unit-covered in `reopen-semantics-by-role.test.ts`, but that proves nothing about
whether `moves.ts` actually HANDS the hooks the moving task's resolved lifecycle columns.
If it passes `undefined`, every one of those unit cases still passes (the no-basis
fallback) while the real board silently keeps the old behavior. So this drives a real
PostgreSQL store, a real `moveTask`, and a workflow whose columns carry the standard
traits under NON-default names.

WHAT IT WOULD HAVE CAUGHT: a card bounced out of the renamed review lane kept its
`passed` review result, because the clear was gated on the literal `in-review`/`todo`.
`getTaskMergeBlocker` reads that array, so the card could re-enter review and merge with
its re-review never run.

FNXC:LifecycleContainment 2026-09-26-00:00 (FUSI-036): since FN-207 that hazard is
prevented TWICE over, and this file now pins both halves. The role-resolved clear still
runs wherever a bounce is allowed at all (the `moveSource: "user"` cases), AND an
automatic bounce out of a review lane into a hold lane is refused outright by the F2
rank rule — so the shape that made the hazard reachable cannot be created by a machine.
Neither half subsumes the other: drop the guard and the stale-result case goes red; drop
the clear and the user-sourced case goes red.

The flag-ON path is the one under test — `isWorkflowColumnsCompatibilityFlagEnabled`
reads the RAW experimental flag, so without enabling it this suite would exercise the
legacy inline branch (which is deliberately left name-based as the parity reference) and
prove nothing.
*/
import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { WorkflowIr } from "../../workflows/workflow-ir-types.js";
import { getTaskMergeBlocker } from "../../merge/task-merge.js";

/** Standard lifecycle traits under non-default column names, with a reopen edge. */
function renamedBoardIr(): WorkflowIr {
  return {
    version: "v2",
    name: "test:renamed-board",
    columns: [
      { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
      {
        id: "queued",
        name: "Queued",
        traits: [{ trait: "hold", config: { release: "capacity" } }, { trait: "reset-on-entry" }],
      },
      {
        id: "building",
        name: "Building",
        traits: [
          { trait: "wip", config: { limitSetting: "maxConcurrent", countPending: true } },
          { trait: "abort-on-exit" },
          { trait: "timing" },
        ],
      },
      {
        id: "checking",
        name: "Checking",
        traits: [{ trait: "merge" }, { trait: "merge-blocker" }],
      },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
      /*
      FOURTH FIXTURE FINDING, and the one that actually matters for reading this file: the
      ARCHIVED column is not decoration. `resolveRoleColumns` returns undefined unless the
      workflow declares wip + review + complete + archived + a planning lane, and without
      it adjacency silently falls back to ORDER-DERIVED neighbours — under which
      `checking -> queued` is not a legal move at all ("Valid targets: building, shipped").
      So a renamed board only gets role-level transitions once its role set is complete;
      an incomplete one is treated as a genuinely custom shape, by design.
      */
      { id: "archive", name: "Archive", traits: [{ trait: "archived" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "backlog" },
      /*
      THIRD FIXTURE FINDING: a rework edge is legal only INTO a node marked
      `config.reworkRegion: true` (or inside a foreach template). So a workflow that wants
      a review bounce must declare its bounce TARGETS as rework-region heads — the shape is
      opt-in per node, not a property of the edge alone.
      */
      { id: "plan", kind: "prompt", column: "queued", config: { name: "Plan", prompt: "Specify.", reworkRegion: true } },
      { id: "build", kind: "prompt", column: "building", config: { name: "Build", prompt: "Do it.", reworkRegion: true } },
      { id: "check", kind: "prompt", column: "checking", config: { name: "Check", prompt: "Review it." } },
      /*
      FIXTURE NOTE, and it is the finding of a real rule rather than boilerplate: a column
      declaring `merge-blocker` must have a reachable merge-class node or `parseWorkflowIr`
      rejects the whole workflow ("the merge-blocker gate can never clear without one"). My
      first fixture omitted it and all three cases failed at workflow CREATION, not at the
      move — a failure that looks like the code under test and is not.
      */
      { id: "merge", kind: "merge-attempt", column: "checking", config: { capability: "task-merge" } },
      { id: "end", kind: "end", column: "shipped" },
      // No node in the archive column — the builtin coding IR declares its `archived`
      // column the same way, and adding one only made it an unreachable node.
    ],
    edges: [
      { from: "start", to: "plan" },
      { from: "plan", to: "build", condition: "success" },
      { from: "build", to: "check", condition: "success" },
      { from: "check", to: "merge", condition: "success" },
      { from: "merge", to: "end", condition: "success" },
      /*
      The reopen edges under test: a rejected check goes back to planning, and a renamed
      board is entitled to the same bounce the default lineage has.

      SECOND FIXTURE FINDING: these MUST be `kind: "rework"`. `validateNoIllegalCycles`
      exempts only rework edges from the acyclicity rule, so a plain back-edge rejects the
      whole workflow. Worth knowing before writing any reopen fixture — a bounce edge in
      this IR is a rework edge by definition, not an ordinary conditional one.
      */
      { from: "check", to: "plan", kind: "rework", condition: "failure" },
      { from: "check", to: "build", kind: "rework", condition: "retry" },
    ],
  } as WorkflowIr;
}

pgDescribe("a renamed board gets the same reopen effects as the default lineage", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_renamed_reopen" });
  beforeAll(harness.beforeAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  afterAll(harness.afterAll);

  beforeEach(async () => {
    await harness.store().updateGlobalSettings({ experimentalFeatures: { workflowColumns: true } });
  });

  /** Force a column directly so one move edge can be exercised in isolation. */
  async function forceColumn(taskId: string, column: string): Promise<void> {
    const store = harness.store();
    const layer = store.getAsyncLayer();
    if (!layer) throw new Error("expected async layer in backend mode");
    const { project } = await import("../../postgres/schema/index.js");
    await layer.db.update(project.tasks).set({ column }).where(eq(project.tasks.id, taskId));
  }

  async function seedCardInCheck(): Promise<{ store: ReturnType<typeof harness.store>; taskId: string }> {
    const store = harness.store();
    const def = await store.createWorkflowDefinition({ name: "Renamed Board", ir: renamedBoardIr() });
    const task = await store.createTask({ description: "renamed board card", workflowId: def.id });
    await store.updateTask(task.id, {
      status: "failed",
      error: "review rejected",
      branch: "fusion/renamed",
      // FNXC:BranchWriteProvenance 2026-08-23-15:55: a branch write requires an explicit origin
      // (normalizeCreateBranchProvenance / updateTaskUnlockedImpl). This fixture stands in for the
      // engine's own execution-time branch assignment, so it declares "engine".
      branchWriteOrigin: "engine",
      summary: "a summary from the failed attempt",
      workflowStepResults: [
        { workflowStepId: "code-review", status: "passed", completedAt: "2026-07-30T00:00:00.000Z" },
      ] as never,
    });
    await forceColumn(task.id, "checking");
    return { store, taskId: task.id };
  }

  it("REFUSES the engine-sourced bounce out of the renamed review lane, and the card stays merge-blocked", async () => {
    /*
    FNXC:LifecycleContainment 2026-09-26-00:00 (FUSI-036 — census family
    `lifecycle-transition-forbidden`, F2):

    THE REFUSAL IS THE HAZARD CONTROL, NOT A LOSS OF COVERAGE. This case is the
    first census row of its family: the store was asked to bounce `checking
    (review, rank 3) -> queued (hold, rank 1)` under `moveSource: "engine"` and
    expected to land. That is a rank gap of 2, so F2 fires, and the move supplies
    no `lifecycleReason` at all — so even the sanctioned-reason check would reject
    it independently. `AGENTS.md` allows a backward step out of review only via
    Code Review / verification / merge-fix REVISE, and only to WIP, never to a hold
    lane. The guard is right; the expectation was the regression.

    WHICH OF THE TWO HALVES OF THE ORIGINAL CASE IS ACTUALLY TRUE AFTER THE
    REFUSAL — the spec asked for this to be measured, not assumed, so it was:

      1. The reopen clear does NOT run on a refused move. `evaluateTransitionInvariants`
         throws at moves.ts:751, long before `applyDefaultWorkflowMoveEffects` at
         moves.ts:1052, so `workflowStepResults`, `branch`, `summary`, `status`,
         and `error` all survive. The assertions below inverted from "emptied" to
         "intact" for that reason, and are kept rather than deleted.

      2. The card is still MERGE-BLOCKED where it sits, and the hazard is
         unreachable anyway. `getTaskMergeBlocker` reads `workflowStepResults`, and
         the surviving `passed` result is what would let a card merge without a
         re-review — but only for a card sitting OUTSIDE the review lane. This one
         never left `checking`, so the result is in the lane it was earned in, and
         the card is blocked by its own `failed` status. The negative half is
         measured too, and it is the real proof: the same card, read as if it had
         moved AND had its status cleared, is merge-ELIGIBLE (`undefined`). That is
         the exact shape the reopen clear used to prevent, and it is now
         unreachable from an automatic path because the move that would create it
         is refused.

    A renamed review lane obeys the same rank rule as `in-review` because roles come
    from each column's own trait flags, not from column ids. That is the property
    this file exists to prove, and F2 firing on `checking` is now its proof.

    The guard is scoped, not blanket: the sibling case below moves the same card
    with `moveSource: "user"` and still lands, because
    `evaluateLifecycleDirectionPostcondition` returns `null` immediately for a
    non-engine, non-scheduler source. A human may still pull a card back to a hold
    lane; an automatic path may not.
    */
    const { store, taskId } = await seedCardInCheck();

    await expect(
      store.moveTask(taskId, "queued", { moveSource: "engine" }),
    ).rejects.toThrow(/Forbidden lifecycle path F2: 'checking' \(review\) → 'queued' \(hold\)/);

    // The card did not move, and the reopen clear never ran (half 1 above), so
    // every field the original case watched for clearing is still exactly as seeded.
    const held = await store.getTask(taskId);
    expect(held.column).toBe("checking");
    expect(held.workflowStepResults ?? []).toHaveLength(1);
    expect(held.branch ?? null).not.toBeNull();
    expect(held.summary ?? null).not.toBeNull();
    expect(held.status ?? null).not.toBeNull();
    expect(held.error ?? null).not.toBeNull();

    // The safety property, stated as an assertion (half 2 above). Resolved review
    // lanes, exactly as `moves.ts` hands them to the merge door, so this is the
    // board's own review identity and not the literal `in-review` fallback.
    const reviewColumns = new Set(["checking"]);
    expect(getTaskMergeBlocker(held as never, { reviewColumns })).toBeTruthy();

    // The negative control that makes the positive one mean something: the SAME
    // card with a stale `passed` result, read as though it had left the review lane
    // with its status cleared, is merge-eligible. That is the hazard the reopen
    // clear used to prevent by emptying `workflowStepResults`, and it is exactly
    // what the refusal now makes unreachable.
    const hazard = { ...held, column: "queued", status: undefined, error: undefined };
    expect(getTaskMergeBlocker(hazard as never, {
      skipColumnIdentityCheck: true,
      requiredPreMergeStepIds: new Set(),
    })).toBeUndefined();
  });

  /*
  The reopen-hook coverage the refused case can no longer carry, kept where the
  guard does not apply. `moveSource: "user"` returns `null` from the containment
  postcondition immediately, so the bounce lands and
  `applyReopenFieldClears` runs its role-resolved clear: the `passed` result,
  branch, summary, status, and error are all dropped. Without this case the file
  would pin the refusal but no longer prove the clear works anywhere — a guard that
  refuses everything would pass it.
  */
  it("still clears the stale review result on a user-sourced bounce into the renamed hold lane", async () => {
    const { store, taskId } = await seedCardInCheck();

    const moved = await store.moveTask(taskId, "queued", { moveSource: "user" });

    expect(moved.column).toBe("queued");
    // The safety assertion, on the path where a human is doing the pulling:
    // a surviving `passed` result satisfies getTaskMergeBlocker.
    expect(moved.workflowStepResults ?? []).toHaveLength(0);
    expect(moved.branch ?? null).toBeNull();
    expect(moved.summary ?? null).toBeNull();
    expect(moved.status ?? null).toBeNull();
    expect(moved.error ?? null).toBeNull();
  });

  it("parks a user-source bounce into the renamed hold lane", async () => {
    const { store, taskId } = await seedCardInCheck();

    const moved = await store.moveTask(taskId, "queued", { moveSource: "user" });

    expect(moved.userPaused).toBe(true);
  });

  it("does NOT strip results on a forward move within the renamed board", async () => {
    // The paired negative: "clears on every move" must not pass for "resolves the roles".
    const store = harness.store();
    const def = await store.createWorkflowDefinition({ name: "Renamed Fwd", ir: renamedBoardIr() });
    const task = await store.createTask({ description: "forward card", workflowId: def.id });
    await store.updateTask(task.id, {
      workflowStepResults: [{ workflowStepId: "code-review", status: "passed" }] as never,
    });
    await forceColumn(task.id, "queued");

    const moved = await store.moveTask(task.id, "building", { moveSource: "engine" });

    expect(moved.column).toBe("building");
    expect(moved.workflowStepResults ?? []).toHaveLength(1);
  });
});
