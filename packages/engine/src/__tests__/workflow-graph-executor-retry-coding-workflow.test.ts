import { describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "@fusion/core";
import type { TaskDetail, WorkflowIr } from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflows/workflow-graph-executor.js";

const task = { id: "FN-6051" } as TaskDetail;

function settingsOn() {
  return { experimentalFeatures: { workflowGraphExecutor: true } };
}

describe("WorkflowGraphExecutor built-in coding workflow retries", () => {
  it("retries the execute node on exception then succeeds", async () => {
    let executeCalls = 0;
    const prompt = vi.fn<WorkflowNodeHandler>(async (node) => {
      if (node.id === "execute") {
        executeCalls += 1;
        if (executeCalls === 1) throw new Error("transient execute failure");
      }
      return { outcome: "success" };
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run(task, settingsOn(), BUILTIN_CODING_WORKFLOW_IR);

    expect(result.outcome).toBe("success");
    expect(executeCalls).toBe(2);
    expect(result.context["node:execute:outcome"]).toBe("success");
    /*
     * FNXC:WorkflowGraphTests 2026-06-29-13:50, corrected 2026-09-25-17:20:
     * Retry coverage must pin the post-cutover builtin:coding node order. The default path routes
     * planning through the plan-review group before execute, runs the code-review template before
     * review and the collapsed legacy merge seam, and then expands the post-merge gate.
     *
     * The earlier note here said this path "bypasses default-off browser/post-merge groups at the
     * group node". That was true when post-merge verification was `defaultOn: false`; FN-9369 made
     * it `defaultOn: true` (`builtin-post-merge-group.ts`), so it now expands like plan-review and
     * code-review do. Only `browser-verification` is still bypassed at its group node.
     */
    expect(result.visitedNodeIds).toEqual([
      "start",
      "planning",
      "plan-review",
      "plan-review::plan-review-step",
      "execute",
      "browser-verification",
      /* FNXC:WorkflowIR 2026-08-23-22:20: the built-in coding IR wires completion-summary BEFORE
         code-review; this topology list still encoded the pre-reorder order. */
      "completion-summary",
      "code-review",
      "code-review::code-review-step",
      "review",
      "merge",
      "post-merge-verification",
      // FNXC:PostMergeGroupShape 2026-09-25-17:20: the post-merge group is `defaultOn: true`, so
      // like plan-review and code-review above it expands and visits its inner step node. The
      // former `not.toContain` assertion for this node asserted a default-OFF bypass that no
      // longer exists; keeping it would contradict the trace this case pins.
      "post-merge-verification::post-merge-verification-step",
    ]);
    expect(result.visitedNodeIds).not.toContain("workflow-step");
    // browser-verification is still default-OFF, so it alone is bypassed at its group node.
    expect(result.visitedNodeIds).not.toContain("browser-verification::browser-verification-step");
  });

  it("exhausts execute node retries and routes failure to end", async () => {
    let executeCalls = 0;
    const prompt = vi.fn<WorkflowNodeHandler>(async (node) => {
      if (node.id === "execute") {
        executeCalls += 1;
        throw new Error("persistent execute failure");
      }
      return { outcome: "success" };
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run(task, settingsOn(), BUILTIN_CODING_WORKFLOW_IR);

    expect(executeCalls).toBe(2);
    expect(result.context["node:execute:outcome"]).toBe("failure");
    expect(result.context["node:execute:value"]).toBe("exception");
    expect(result.context["node:execute:error"]).toBe("persistent execute failure");
    expect(result.outcome).toBe("failure");
    expect(BUILTIN_CODING_WORKFLOW_IR.edges).toContainEqual({ from: "execute", to: "end", condition: "failure" });
    expect(result.visitedNodeIds).toEqual([
      "start",
      "planning",
      "plan-review",
      "plan-review::plan-review-step",
      "execute",
    ]);
    expect(result.visitedNodeIds).not.toContain("browser-verification");
  });

  it("does not retry when the execute node returns a clean failure outcome", async () => {
    let executeCalls = 0;
    const prompt = vi.fn<WorkflowNodeHandler>(async (node) => {
      if (node.id === "execute") {
        executeCalls += 1;
        return { outcome: "failure", value: "clean-failure" };
      }
      return { outcome: "success" };
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run(task, settingsOn(), BUILTIN_CODING_WORKFLOW_IR);

    expect(executeCalls).toBe(1);
    expect(result.context["node:execute:outcome"]).toBe("failure");
    expect(result.context["node:execute:value"]).toBe("clean-failure");
    expect(result.context["node:execute:error"]).toBeUndefined();
    expect(result.outcome).toBe("failure");
    expect(BUILTIN_CODING_WORKFLOW_IR.edges).toContainEqual({ from: "execute", to: "end", condition: "failure" });
    expect(result.visitedNodeIds).toEqual([
      "start",
      "planning",
      "plan-review",
      "plan-review::plan-review-step",
      "execute",
    ]);
  });

  it("uses the executor default retry count for a review node without maxRetries config", async () => {
    let reviewCalls = 0;
    const prompt = vi.fn<WorkflowNodeHandler>(async (node) => {
      if (node.id === "review") {
        reviewCalls += 1;
        throw new Error("review seam failed");
      }
      return { outcome: "success" };
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run(task, settingsOn(), BUILTIN_CODING_WORKFLOW_IR);

    expect(reviewCalls).toBe(2);
    expect(result.context["node:review:outcome"]).toBe("failure");
    expect(result.context["node:review:value"]).toBe("exception");
    expect(result.context["node:review:error"]).toBe("review seam failed");
    expect(result.outcome).toBe("failure");
    // FNXC:WorkflowGraphTests 2026-06-29-13:50: Review retry coverage follows the current builtin:coding success path through plan-review, bypassed browser verification, default-on code-review, completion summary, then review; a review failure stops before merge/post-merge traversal.
    expect(result.visitedNodeIds).toEqual([
      "start",
      "planning",
      "plan-review",
      "plan-review::plan-review-step",
      "execute",
      "browser-verification",
      /* FNXC:WorkflowIR 2026-08-23-22:20: the built-in coding IR wires completion-summary BEFORE
         code-review; this topology list still encoded the pre-reorder order. */
      "completion-summary",
      "code-review",
      "code-review::code-review-step",
      "review",
    ]);
  });

  it("respects a per-node maxRetries override", async () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "custom-retry-override",
      nodes: [
        { id: "start", kind: "start" },
        { id: "custom", kind: "prompt", config: { maxRetries: 4 } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "custom" },
        { from: "custom", to: "end", condition: "success" },
      ],
    };
    let calls = 0;
    const prompt = vi.fn<WorkflowNodeHandler>(async () => {
      calls += 1;
      if (calls < 4) throw new Error(`temporary failure ${calls}`);
      return { outcome: "success" };
    });
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt },
      maxRetriesPerNode: 2,
    });

    const result = await executor.run(task, settingsOn(), ir);

    expect(calls).toBe(4);
    expect(result.outcome).toBe("success");
    expect(result.context["node:custom:outcome"]).toBe("success");
    expect(result.context["node:custom:error"]).toBeUndefined();
  });
});
