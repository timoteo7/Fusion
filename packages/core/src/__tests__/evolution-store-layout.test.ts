/**
 * FNXC:EvolutionStoreLayout 2026-09-25-12:10:
 * `EvolutionStore.forProject` is the only sanctioned way to build a store from a PROJECT root,
 * and it must place the data under `<projectRoot>/.fusion/evolution`.
 *
 * The defect it exists to prevent: the engine and the CLI built the store from the project root
 * (writing `<projectRoot>/evolution`) while the dashboard approval bridge read `getFusionDir()`
 * (`<projectRoot>/.fusion/evolution`). Those are different directories, so an operator's approval
 * never reached the artifact it was approving and the apply gate refused with `approval-pending`
 * forever, while every unit test stayed green because each side was tested against its own fake.
 *
 * These assertions are deliberately filesystem-backed with no injected store double: the whole
 * defect was a path disagreement, which a mocked store cannot express.
 */
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EvolutionStore,
  computeEvolutionCandidateChecksum,
  type AppendEvolutionArtifactInput,
  type EvolutionCandidate,
} from "../index.js";

function makeCandidate(): EvolutionCandidate {
  const merged: EvolutionCandidate = {
    changeType: "instructions",
    target: "agent/soul.md",
    changeSummary: "Clarify that approval is required before any self-edit.",
    proposedDiff: "- mutate instructions freely\n+ request approval before mutating instructions",
    checksum: "",
  };
  return { ...merged, checksum: computeEvolutionCandidateChecksum(merged) };
}

function makeArtifactInput(rationale: string): AppendEvolutionArtifactInput {
  return {
    agentId: "agent-1",
    trigger: "manual" as const,
    event: { summary: "Improve approval-first behavior", taskIds: ["FN-1"] },
    evidence: { signals: ["evolution-signal-1"] },
    hypothesis: "Per-task reviews show unapproved self-edits; gate them.",
    candidate: makeCandidate(),
    trial: {
      baselineRun: { command: "pnpm test", passed: true, metrics: { passRate: 0.9 } },
      candidateRun: { command: "pnpm test", passed: true, metrics: { passRate: 0.95 } },
      decisions: ["all-gate-checks-pass"] as const,
      decision: "keep" as const,
      rationale,
    },
  };
}

describe("EvolutionStore.forProject: single production layout owner", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), `evolution-layout-${randomUUID().slice(0, 6)}-`));
  });

  it("persists under projectRoot/.fusion/evolution and leaves projectRoot/evolution unused", async () => {
    const writer = EvolutionStore.forProject(projectRoot);
    await writer.init();
    const artifact = await writer.appendArtifact(makeArtifactInput("r1"));

    expect(existsSync(join(projectRoot, ".fusion", "evolution", "agent-1-evolution.jsonl"))).toBe(true);
    // The split-brain directory must stay absent: an artifact there is unreadable by the bridge.
    expect(existsSync(join(projectRoot, "evolution"))).toBe(false);

    // A second store instance (the dashboard bridge, in another process) sees the same artifact.
    const reader = EvolutionStore.forProject(projectRoot);
    await reader.init();
    const found = await reader.getArtifactByVersion("agent-1", artifact.version);
    expect(found?.id).toBe(artifact.id);
  });

  it("is the only construction under which a project-root writer and reader agree", async () => {
    const writer = EvolutionStore.forProject(projectRoot);
    await writer.init();
    const artifact = await writer.appendArtifact(makeArtifactInput("r1"));
    await writer.markApprovalState("agent-1", artifact.version, { status: "pending", approvalRequestId: "req-1" });

    // The regression: a store built from the PROJECT root, which is what the engine and the CLI
    // did before the fix, resolves a DIFFERENT directory and cannot approve what the cycle wrote.
    const projectRootStore = new EvolutionStore({ rootDir: projectRoot });
    await projectRootStore.init();
    expect(await projectRootStore.getArtifacts("agent-1", 10)).toEqual([]);
    expect(await projectRootStore.markApprovalState("agent-1", 1, { status: "approved" })).toBeNull();

    // The bridge's construction approves that same artifact, pending -> approved.
    const bridge = EvolutionStore.forProject(projectRoot);
    await bridge.init();
    const approved = await bridge.markApprovalState("agent-1", 1, {
      status: "approved",
      approvalRequestId: "req-1",
      decidedBy: "user",
    });
    expect(approved?.approval.status).toBe("approved");
  });
});
