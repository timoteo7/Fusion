import { describe, expect, it } from "vitest";
import type { WorkflowIrNode } from "@fusion/core";
import { workflowNodeRequiresWorktree } from "../workflows/workflow-node-execution-needs.js";

function node(overrides: Partial<WorkflowIrNode> = {}): WorkflowIrNode {
  return { id: "node", kind: "prompt", ...overrides };
}

describe("workflowNodeRequiresWorktree", () => {
  it.each([
    ["coding tool mode", node({ config: { toolMode: "coding" } })],
    ["script node", node({ kind: "script" })],
    ["named script", node({ config: { scriptName: "validate" } })],
    ["CLI command", node({ config: { executor: "cli", cliCommand: "pnpm lint" } })],
    ["CLI agent", node({ config: { executor: "cli-agent" } })],
  ])("requires a worktree for %s", (_name, workflowNode) => {
    expect(workflowNodeRequiresWorktree(workflowNode)).toBe(true);
  });

  /*
  FNXC:WorkflowNodeNeeds 2026-09-25-19:40:
  Inline-fix write capability is classified by STRUCTURE, never by display name. A node qualifies
  through `reviewCanFixInline`, `reviewKind: "code"`, or a code-review / browser-verification
  optional-group id — never through a human label in `config.name`.

  The two name-based rows below were RETIRED, and removing them is the point of this edit: they
  asserted that naming a node "Code Review" makes it write-capable, which is exactly the
  label-coupling `workflowNodeRequiresWorktree` was changed to eliminate. A renamed gate must not
  change its execution needs, and a deterministic gate must not be made write-capable by its title.
  Their replacement, below, proves the stronger property: a bare node stays read-only no matter what
  it is called, and only the structural signal promotes it.
  */
  it.each([
    ["explicit inline fix config", node({ config: { reviewCanFixInline: true } }), undefined],
    ["code reviewKind", node({ config: { reviewKind: "code" } }), undefined],
    ["code review optional group", node(), "code-review"],
    ["browser verification optional group", node(), "browser-verification"],
  ])("requires a worktree for inline fixes from %s", (_name, workflowNode, optionalGroupId) => {
    expect(workflowNodeRequiresWorktree(workflowNode, { optionalGroupId })).toBe(true);
  });

  /*
  The complementary half of the invariant: a display name alone grants NOTHING. These nodes carry no
  structural review signal, so a reviewer reading them as write-capable would be misled by the label
  — which is precisely the coupling that was removed. A deterministic verification gate is the
  motivating case: it has no mutation path at all, and classifying it write-capable by title made the
  review seal refuse it on every post-approval replay.
  */
  it.each([
    ["a Code Review LABEL alone", node({ id: "review", config: { name: "Code Review" } })],
    ["a Browser Verification LABEL alone", node({ id: "verify", config: { name: "Browser Verification" } })],
    ["a deterministic verification gate", node({
      config: { name: "Code Review", workflowAction: "deterministic-verification", reviewCanFixInline: true },
    })],
  ])("does not grant a worktree from %s", (_name, workflowNode) => {
    expect(workflowNodeRequiresWorktree(workflowNode)).toBe(false);
  });

  it("keeps inline-fix reviews read-only when disabled", () => {
    expect(workflowNodeRequiresWorktree(node({ config: { name: "Code Review" } }), { reviewerInlineFixes: false })).toBe(false);
    expect(workflowNodeRequiresWorktree(node(), {
      optionalGroupId: "code-review",
      reviewerInlineFixes: false,
    })).toBe(false);
  });

  it.each([
    node({ id: "plan-review-step", config: { name: "Code Review" } }),
    node({ config: { name: "Plan Review" } }),
    node(),
  ])("keeps Plan Review read-only", (workflowNode) => {
    expect(workflowNodeRequiresWorktree(workflowNode, {
      optionalGroupId: workflowNode.id === "node" ? "plan-review" : undefined,
    })).toBe(false);
  });
});
