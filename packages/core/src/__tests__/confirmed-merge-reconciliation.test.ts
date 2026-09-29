import { describe, expect, it } from "vitest";
import { getPostMergeFinalizeBlocker, getRequiredPostMergeEvidenceBlocker, planConfirmedMergeChecklistReconciliation } from "../merge/confirmed-merge-reconciliation.js";
import { postMergeOptionalGroupNode } from "../workflows/builtin-post-merge-group.js";

describe("confirmed merge reconciliation", () => {
  it("does not re-run stale review or checklist gates after a confirmed merge", () => {
    expect(getPostMergeFinalizeBlocker({ status: "merging", error: undefined })).toBeUndefined();
    expect(planConfirmedMergeChecklistReconciliation({
      steps: [{ name: "Implementation", status: "pending" }, { name: "Done", status: "done" }],
      workflowStepResults: [{ workflowStepId: "code-review", workflowStepName: "Code Review", status: "pending" }],
    })).toEqual({ skippedStepIndexes: [0], reconciledWorkflowStepIds: ["code-review"] });
  });

  it("does not let a finalizer-inflicted failed status wedge proven-landed work", () => {
    expect(getPostMergeFinalizeBlocker({
      status: "failed",
      error: "Cannot move FN-221 to 'done': Forbidden lifecycle path F3…",
    })).toBeUndefined();
  });

  it("retains independent task blockers", () => {
    expect(getPostMergeFinalizeBlocker({ status: "awaiting-approval", error: "operator action" }))
      .toBe("task is marked 'awaiting-approval': operator action");
  });

  it.each([
    "awaiting-inspection",
    "awaiting-user-review",
    "planning",
    "specifying",
    "needs-replan",
    "mission-validation",
    "stuck-killed",
  ])("keeps the %s post-merge blocker", (status) => {
    expect(getPostMergeFinalizeBlocker({ status, error: undefined }))
      .toBe(`task is marked '${status}'`);
  });
});

describe("required post-merge evidence", () => {
  /*
  FNXC:PostMergeAdvisoryDemotion 2026-09-29-14:57:
  FUSI-064 demoted the built-in post-merge verification from a hard completion gate to an advisory
  observation. `getRequiredPostMergeEvidenceBlocker` still collects gate-mode post-merge groups —
  that is its unchanged contract — but the built-in `builtin:coding` workflow no longer supplies
  one, so a card with a confirmed merge and no successful Full Suite can now reach completion. The
  two describes below pin BOTH halves: the new built-in truth (advisory => never blocks) and the
  preserved function contract (a genuinely gate-mode post-merge group still blocks). The blocking
  coverage uses a custom IR carrying a `gateMode: "gate"` post-merge group so it keeps exercising
  the real function rather than deleting the contract.
  */

  // A workflow whose post-merge group is explicitly gate-mode, to preserve the function's blocking contract.
  const gateModeStore = {
    getTaskWorkflowSelection: () => ({
      workflowId: "WF-GATE",
      stepIds: ["post-merge-verification"],
    }),
    getWorkflowDefinition: async () => ({
      ir: {
        version: "v2",
        name: "gate-post-merge",
        columns: [
          { id: "review", name: "Review", traits: [] },
          { id: "done", name: "Done", traits: [] },
        ],
        nodes: [
          postMergeOptionalGroupNode({
            id: "post-merge-verification",
            name: "Post-merge verification",
            column: "done",
            prompt: "gate-mode post-merge",
            gateMode: "gate",
            defaultOn: true,
          }),
        ],
        edges: [],
      },
    }),
  };

  it.each([
    [undefined, "has not reported"],
    [{ status: "pending" }, "is not approved"],
    [{ status: "skipped" }, "is not approved"],
    [{ status: "failed", verdict: "REVISE" }, "is not approved"],
  ])("blocks enabled gate evidence that %s", async (result, expected) => {
    await expect(getRequiredPostMergeEvidenceBlocker(gateModeStore as never, {
      id: "FN-PM",
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: result ? [{ workflowStepId: "post-merge-verification", ...result }] : [],
    } as never)).resolves.toContain(expected);
  });

  it("accepts durable approval and preserves explicit disablement for a gate-mode group", async () => {
    await expect(getRequiredPostMergeEvidenceBlocker(gateModeStore as never, {
      id: "FN-PM",
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [{ workflowStepId: "post-merge-verification", status: "passed", verdict: "APPROVE_WITH_NOTES" }],
    } as never)).resolves.toBeUndefined();
    await expect(getRequiredPostMergeEvidenceBlocker(gateModeStore as never, {
      id: "FN-PM-disabled",
      enabledWorkflowSteps: [],
      workflowStepResults: [],
    } as never)).resolves.toBeUndefined();
  });
});

describe("built-in coding post-merge verification is advisory (FUSI-064)", () => {
  /*
  FNXC:PostMergeAdvisoryDemotion 2026-09-29-14:57:
  The Symptom Verification contract for FUSI-064: a card whose work merged cleanly, with a
  post-merge result that is absent or REVISE (the shape a red/never-green Full Suite produces),
  must still be able to reach completion because the built-in post-merge verification is an
  advisory observation, not a hard gate. This pins the demotion against the REAL built-in
  workflow so a future re-promotion to `gateMode: "gate"` (or a re-added "must refuse approval
  until Full Suite evidence" prompt) fails here.
  */
  const store = {
    getTaskWorkflowSelection: () => ({
      workflowId: "builtin:coding",
      stepIds: ["post-merge-verification"],
    }),
  };

  it.each([
    ["absent", []],
    ["pending", [{ workflowStepId: "post-merge-verification", status: "pending" as const }]],
    ["failed-REVISE", [{ workflowStepId: "post-merge-verification", status: "failed" as const, verdict: "REVISE" as const }]],
    ["advisory_failure", [{ workflowStepId: "post-merge-verification", status: "advisory_failure" as const, verdict: "REVISE" as const }]],
  ])("does not block completion on builtin:coding when the post-merge result is %s", async (_label, workflowStepResults) => {
    await expect(getRequiredPostMergeEvidenceBlocker(store as never, {
      id: "FN-PM",
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults,
    } as never)).resolves.toBeUndefined();
  });
});

/*
FNXC:ConfirmedMergeFinalization 2026-09-01-05:51:
This planner runs on the merge-CONFIRMED fast path — the work has already landed. A row that reaches
it without `steps` (an older row, a partial projection) used to throw "Cannot read properties of
undefined (reading 'map')", which the merge loop's catch absorbed, so the landed task simply never
finalized and never emitted task:merged. Asserting the type does not make the row real.
*/
describe("planConfirmedMergeChecklistReconciliation with an incomplete row", () => {
  it("does not throw when the row carries no steps, so a landed merge still finalizes", () => {
    expect(() =>
      planConfirmedMergeChecklistReconciliation({ workflowStepResults: [] } as never),
    ).not.toThrow();
    expect(
      planConfirmedMergeChecklistReconciliation({ workflowStepResults: [] } as never),
    ).toEqual({ skippedStepIndexes: [], reconciledWorkflowStepIds: [] });
  });

  it("still reconciles pending workflow step results when steps are absent", () => {
    expect(
      planConfirmedMergeChecklistReconciliation({
        workflowStepResults: [{ workflowStepId: "code-review", status: "pending" }],
      } as never),
    ).toEqual({ skippedStepIndexes: [], reconciledWorkflowStepIds: ["code-review"] });
  });
});
