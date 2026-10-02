/*
FNXC:AmbientColumnMove 2026-10-02-02:40:
FUSI-072. `fn_task_column_move` is the one column move an ambient (no-task) heartbeat agent receives. It
is forward-only BY CONSTRUCTION, and this suite is where that claim is discharged — the precondition is
a single admitted (from, to) pair, so every other combination must refuse and leave the card alone.

THE DIFFERENTIAL IS THE POINT. Every case runs against BOTH vocabularies from the one shared builder
(`_workflow-vocabulary-fixture.ts`), which differ ONLY in their four column ids (`in-review`/`done` vs
`checking`/`shipped`). A tool that resolved its destination with the literal `"done"` would pass the
DEFAULT case and silently no-op on the renamed board — the exact failure two FNXC notes in this repo
record. The RENAMED run is therefore not belt-and-braces; it is the assertion that actually tests the
change.

EVERY REFUSAL ASSERTS THE CARD DID NOT MOVE. A refusal message is cheap; a refusal that nonetheless
mutated the column is the bug. Each case therefore checks the recorded column after the call.

THE CONTAINMENT SHAPE IS PINNED, NOT JUST DESCRIBED. `moveSource: "engine"` without an explicit
`bypassGuards: false` silently DISABLES core lifecycle containment, because the bypass flag is derived
from the source (`task-store-helpers.ts:156-158`). Nothing about the move's observable outcome differs
between the two call shapes, so only an assertion on the call arguments can hold this line.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { TransitionRejectionError } from "@fusion/core";
import { createTaskColumnMoveTool } from "../agent-tools.js";
import { DEFAULT_VOCAB, RENAMED_VOCAB, lifecycleIr, type Vocabulary } from "./_workflow-vocabulary-fixture.js";

function card(id: string, column: string): Task {
  return {
    id,
    title: `card ${id}`,
    description: "title",
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  } as Task;
}

interface Fixture {
  readonly store: TaskStore;
  readonly moveTask: ReturnType<typeof vi.fn>;
  readonly logEntry: ReturnType<typeof vi.fn>;
  readonly task: Task;
}

/**
 * A store that resolves a REAL workflow IR, so the tool reads the vocabulary under test rather than
 * failing soft. A soft failure would make the renamed run indistinguishable from the default one and
 * the differential meaningless — the fixture lesson this repo has already paid for.
 */
function fixture(vocab: Vocabulary, task: Task, workflowOverrides?: { ir?: WorkflowIr }): Fixture {
  const ir = workflowOverrides?.ir ?? lifecycleIr(vocab, "column-move-lifecycle");
  const moveTask = vi.fn().mockResolvedValue(task);
  const logEntry = vi.fn().mockResolvedValue(task);
  const store = {
    getTask: vi.fn().mockResolvedValue(task),
    moveTask,
    logEntry,
    getTaskWorkflowSelectionAsync: async () => ({ workflowId: "column-move-lifecycle", stepIds: [] }),
    getTaskWorkflowSelection: () => ({ workflowId: "column-move-lifecycle", stepIds: [] }),
    getWorkflowDefinition: async (id: string) => (id === "column-move-lifecycle" ? { ir } : undefined),
  } as unknown as TaskStore;
  return { store, moveTask, logEntry, task };
}

const VOCABULARIES: ReadonlyArray<readonly [string, Vocabulary]> = [
  ["DEFAULT", DEFAULT_VOCAB],
  ["RENAMED", RENAMED_VOCAB],
];

const run = (store: TaskStore, params: unknown) =>
  createTaskColumnMoveTool(store).execute("call-1", params as never);

describe("fn_task_column_move completes a reviewed card and refuses everything else", () => {
  for (const [label, vocab] of VOCABULARIES) {
    it(`moves a ${label} review-lane card to the resolved complete column (${vocab.review} → ${vocab.complete})`, async () => {
      const task = card("FN-9201", vocab.review);
      const { store, moveTask, logEntry } = fixture(vocab, task);

      const result = await run(store, { task_id: "FN-9201", reason: "work is finished and reviewed" });

      expect(result.isError).toBeFalsy();
      expect(result.details).toMatchObject({
        taskId: "FN-9201",
        fromColumn: vocab.review,
        toColumn: vocab.complete,
      });

      // The destination comes from the workflow's complete TRAIT. On the RENAMED board the literal
      // "done" does not exist, so a literal-keyed tool could not produce this call at all.
      expect(moveTask).toHaveBeenCalledOnce();
      expect(moveTask.mock.calls[0]![1]).toBe(vocab.complete);

      // The audit line names the tool, so a later reader can tell an ambient move from an engine move.
      expect(logEntry).toHaveBeenCalledOnce();
      expect(String(logEntry.mock.calls[0]![1])).toContain("[source=fn_task_column_move]");
      expect(String(logEntry.mock.calls[0]![1])).toContain("work is finished and reviewed");
    });

    /*
    THE CONTAINMENT SHAPE. `moveSource: "engine"` is required (without it core skips containment for
    the move entirely) but it is NOT sufficient: `bypassGuards` is DERIVED from the source, so
    `moveSource: "engine"` alone resolves bypass to `true` and skips the policies we are asking for.
    Only this assertion holds the explicit `false` in place.
    */
    it(`pins the containment call shape for a ${label} review-lane move`, async () => {
      const task = card("FN-9202", vocab.review);
      const { store, moveTask } = fixture(vocab, task);

      await run(store, { task_id: "FN-9202", reason: "finished" });

      expect(moveTask).toHaveBeenCalledWith("FN-9202", vocab.complete, {
        moveSource: "engine",
        bypassGuards: false,
      });
    });

    it(`refuses a ${label} card that is not in the review lane, leaving the column unchanged`, async () => {
      const task = card("FN-9203", vocab.wip);
      const { store, moveTask } = fixture(vocab, task);

      const result = await run(store, { task_id: "FN-9203", reason: "finished" });

      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ rejection: "not-review-lane", column: vocab.wip });
      expect(moveTask).not.toHaveBeenCalled();
    });

    /*
    BACKWARD MOVES ARE STRUCTURALLY UNREACHABLE, not merely unlisted. Intake (rank 0) and the WIP lane
    are both backward from review, so asserting them here proves there is no parameter combination that
    targets them — the forward-only property comes from the admitted pair, not from a filter list.
    */
    it(`refuses a ${label} card already in the complete lane rather than re-completing it`, async () => {
      const task = card("FN-9204", vocab.complete);
      const { store, moveTask } = fixture(vocab, task);

      const result = await run(store, { task_id: "FN-9204", reason: "finished" });

      expect(result.isError).toBe(true);
      expect(moveTask).not.toHaveBeenCalled();
    });

    it(`refuses a ${label} card in intake, which no forward move may target`, async () => {
      const task = card("FN-9205", vocab.intake);
      const { store, moveTask } = fixture(vocab, task);

      const result = await run(store, { task_id: "FN-9205", reason: "finished" });

      expect(result.isError).toBe(true);
      expect(moveTask).not.toHaveBeenCalled();
    });

    it(`refuses a ${label} workflow that declares no complete column`, async () => {
      const task = card("FN-9206", vocab.review);
      // The complete column loses its trait: the workflow resolves cleanly and simply has no
      // destination. This is the "read, and the answer is none" state, distinct from "could not read".
      const ir = lifecycleIr(vocab, "column-move-lifecycle");
      const stripped = {
        ...ir,
        columns: (ir as { columns: Array<{ id: string; traits: unknown[] }> }).columns.map((c) =>
          c.id === vocab.complete ? { ...c, traits: [] } : c,
        ),
      } as unknown as WorkflowIr;
      const { store, moveTask } = fixture(vocab, task, { ir: stripped });

      const result = await run(store, { task_id: "FN-9206", reason: "finished" });

      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ rejection: "no-complete-column", column: vocab.review });
      expect(moveTask).not.toHaveBeenCalled();
    });

    it(`refuses a missing ${label} task_id without touching any card`, async () => {
      const task = card("FN-9207", vocab.review);
      const { store, moveTask } = fixture(vocab, task);

      const result = await run(store, { task_id: "   ", reason: "finished" });

      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({});
      expect(moveTask).not.toHaveBeenCalled();
    });

    /*
    CAPACITY. The destination being full is the destination's truth, not a transient error: the tool
    reports it and leaves the card where it was rather than retrying or quietly selecting another
    column. Retrying here would be the agent's own scheduling decision, which is exactly the authority
    this tool withholds.
    */
    it(`reports a ${label} capacity-exhausted destination without retrying or rerouting`, async () => {
      const task = card("FN-9208", vocab.review);
      const { store, moveTask, logEntry } = fixture(vocab, task);
      moveTask.mockRejectedValue(
        new TransitionRejectionError(
          { code: "capacity-exhausted", detail: "complete column is full" },
          "complete column is full",
        ),
      );

      const result = await run(store, { task_id: "FN-9208", reason: "finished" });

      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({
        rejection: "capacity-exhausted",
        column: vocab.review,
        toColumn: vocab.complete,
      });
      expect(moveTask).toHaveBeenCalledOnce();
      // No success log for a move that did not happen.
      expect(logEntry).not.toHaveBeenCalled();
    });
  }

  it("reports a task the store does not know", async () => {
    const task = card("FN-9209", DEFAULT_VOCAB.review);
    const { store, moveTask } = fixture(DEFAULT_VOCAB, task);
    (store.getTask as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const result = await run(store, { task_id: "FN-9999", reason: "finished" });

    expect(result.isError).toBe(true);
    expect(moveTask).not.toHaveBeenCalled();
  });
});