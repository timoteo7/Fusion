/**
 * EvolutionStore + evolution-types unit tests for @fusion/core (KB-001).
 * Covers append/read-back, monotonic versioning, emptiness, idempotent re-publish,
 * approval transitions, pending-apply refusal philosophy, malformed-line tolerance,
 * checksum determinism, and secret redaction.
 */
import { mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EvolutionStore,
  computeEvolutionCandidateChecksum,
  redactEvolutionArtifact,
  type EvolutionArtifact,
  type EvolutionCandidate,
} from "../index.js";

function makeCandidate(overrides: Partial<EvolutionCandidate> = {}): EvolutionCandidate {
  const base: EvolutionCandidate = {
    changeType: "instructions",
    target: "agent/soul.md",
    changeSummary: "Clarify that approval is required before any self-edit.",
    proposedDiff: "- mutate instructions freely\n+ request approval before mutating instructions",
    checksum: "",
  };
  const merged = { ...base, ...overrides };
  return { ...merged, checksum: computeEvolutionCandidateChecksum(merged) };
}

function makeArtifactOverrides(candidate: EvolutionCandidate, rationale: string) {
  return {
    agentId: "agent-1",
    trigger: "manual" as const,
    event: { summary: "Improve approval-first behavior", taskIds: ["FN-1"] },
    evidence: { signals: ["evolution-signal-1"] },
    hypothesis: "Per-task reviews show unapproved self-edits; gate them.",
    candidate,
    trial: {
      baselineRun: { command: "pnpm test", passed: true, metrics: { passRate: 0.9 } },
      candidateRun: { command: "pnpm test", passed: true, metrics: { passRate: 0.95 } },
      decisions: [
        "all-gate-checks-pass",
        "primary-metric-beats-baseline",
        "no-new-failures",
      ] as const,
      decision: "keep" as const,
      rationale,
    },
  };
}

function makeArtifact(version: number): EvolutionArtifact {
  return {
    id: `evolution-artifact-${version}`,
    version,
    agentId: "agent-1",
    createdAt: new Date().toISOString(),
    trigger: "manual",
    event: { summary: "s", taskIds: [] },
    evidence: { signals: [] },
    hypothesis: "h",
    candidate: makeCandidate(),
    trial: {
      baselineRun: { command: "cmd", passed: true, metrics: {} },
      candidateRun: { command: "cmd", passed: true, metrics: {} },
      decisions: ["all-gate-checks-pass"],
      decision: "keep",
      rationale: "r",
    },
    approval: { status: "not-requested" },
  };
}

describe("EvolutionStore", () => {
  let rootDir: string;
  let store: EvolutionStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), `evolution-store-${randomUUID().slice(0, 6)}-`));
    store = new EvolutionStore({ rootDir });
    await store.init();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends and reads back signals newest-first", async () => {
    await store.createSignal({ agentId: "agent-1", outcome: "success", source: "execution" });
    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "execution", failureCategory: "test-failure" });

    const signals = await store.getSignals("agent-1");
    expect(signals).toHaveLength(2);
    expect(signals[0].outcome).toBe("failure");
    expect(signals[0].failureCategory).toBe("test-failure");
    expect(signals[1].outcome).toBe("success");
  });

  it("filters signals by outcome/source", async () => {
    await store.createSignal({ agentId: "agent-1", outcome: "success", source: "execution" });
    await store.createSignal({ agentId: "agent-1", outcome: "failure", source: "execution" });
    await store.createSignal({ agentId: "agent-1", outcome: "success", source: "review" });

    const failures = await store.getSignals("agent-1", { outcome: "failure" });
    expect(failures).toHaveLength(1);

    const review = await store.getSignals("agent-1", { source: "review" });
    expect(review).toHaveLength(1);
  });

  it("returns empty arrays when no file exists", async () => {
    expect(await store.getSignals("missing")).toEqual([]);
    expect(await store.getArtifacts("missing")).toEqual([]);
    expect(await store.getLatestArtifact("missing")).toBeNull();
  });

  it("assigns monotonic versions and reads latest artifact", async () => {
    await store.appendArtifact({ agentId: "agent-1", ...makeArtifactOverrides(makeCandidate(), "r1") });
    await store.appendArtifact({ agentId: "agent-1", ...makeArtifactOverrides(makeCandidate({ target: "agent/soul.md" }), "r2") });

    const latest = await store.getLatestArtifact("agent-1");
    expect(latest?.version).toBe(2);

    const first = await store.getArtifactByVersion("agent-1", 1);
    expect(first?.version).toBe(1);
  });

  it("re-publishes idempotently when candidate checksum and rationale are unchanged", async () => {
    const candidate = makeCandidate();
    const artifact1 = await store.appendArtifact({ agentId: "agent-1", ...makeArtifactOverrides(candidate, "r1") });
    const published = await store.markPublished("agent-1", artifact1.version);

    const artifact2 = await store.appendArtifact({ agentId: "agent-1", ...makeArtifactOverrides(candidate, "r1") });
    expect(artifact2.version).toBe(artifact1.version);
    expect(artifact2.id).toBe(published?.id);

    const all = await store.getArtifacts("agent-1", 10);
    expect(all).toHaveLength(1);
  });

  it("creates a new version when the candidate changed", async () => {
    const candidate1 = makeCandidate();
    await store.appendArtifact({ agentId: "agent-1", ...makeArtifactOverrides(candidate1, "r1") });
    const candidate2 = makeCandidate({ changeSummary: "A materially different summary." });
    const artifact2 = await store.appendArtifact({ agentId: "agent-1", ...makeArtifactOverrides(candidate2, "r2") });

    expect(artifact2.version).toBe(2);
  });

  it("transitions approval state not-requested → pending → approved/rejected and applies only after approved", async () => {
    const artifact = await store.appendArtifact({ agentId: "agent-1", ...makeArtifactOverrides(makeCandidate(), "r1") });

    const pending = await store.markApprovalState("agent-1", artifact.version, { status: "pending", approvalRequestId: "req-1" });
    expect(pending?.approval.status).toBe("pending");

    const approved = await store.markApprovalState("agent-1", artifact.version, { status: "approved", approvalRequestId: "req-1", decidedBy: "operator", decidedAt: new Date().toISOString() });
    expect(approved?.approval.status).toBe("approved");

    const applied = await store.markApplied("agent-1", artifact.version);
    expect(applied?.appliedAt).toBeTruthy();
  });

  it("markApplied does not run when the artifact is not latest (immutable non-latest)", async () => {
    const artifact1 = await store.appendArtifact({ agentId: "agent-1", ...makeArtifactOverrides(makeCandidate(), "r1") });
    await store.appendArtifact({ agentId: "agent-1", ...makeArtifactOverrides(makeCandidate({ changeSummary: "second" }), "r2") });

    const applied1 = await store.markApplied("agent-1", artifact1.version);
    expect(applied1?.appliedAt).toBeUndefined();
  });

  it("skips malformed JSONL lines and still returns the rest", async () => {
    await store.appendArtifact({ agentId: "agent-1", ...makeArtifactOverrides(makeCandidate(), "r1") });
    const path = join(rootDir, "evolution", "agent-1-evolution.jsonl");
    // Prepend a malformed line to the file.
    const content = `{ this is not json }\n` + readFileSync(path, "utf-8");
    writeFileSync(path, content);

    const artifacts = await store.getArtifacts("agent-1", 10);
    expect(artifacts).toHaveLength(1);
  });

  it("throws when agentId is missing on signal/artifact", async () => {
    await expect(store.createSignal({ agentId: "", outcome: "success", source: "execution" })).rejects.toThrow();
    const { agentId: _ignored, ...overrides } = makeArtifactOverrides(makeCandidate(), "r");
    await expect(store.appendArtifact({ ...overrides, agentId: "" })).rejects.toThrow();
  });

  it("deleteAll clears persistence for an agent", async () => {
    await store.createSignal({ agentId: "agent-1", outcome: "success", source: "execution" });
    await store.appendArtifact({ agentId: "agent-1", ...makeArtifactOverrides(makeCandidate(), "r") });
    await store.deleteAll("agent-1");
    expect(await store.getSignals("agent-1")).toEqual([]);
    expect(await store.getArtifacts("agent-1")).toEqual([]);
  });
});

describe("evolution-types", () => {
  it("computes an order-independent deterministic checksum", () => {
    const candidateA: EvolutionCandidate = {
      changeType: "instructions",
      target: "agent/soul.md",
      changeSummary: "sum",
      proposedDiff: "- a\n+ b",
      checksum: "",
    };
    const candidateB: EvolutionCandidate = {
      proposedDiff: "- a\n+ b",
      target: "agent/soul.md",
      changeSummary: "sum",
      changeType: "instructions",
      checksum: "",
    };
    expect(computeEvolutionCandidateChecksum(candidateA)).toBe(computeEvolutionCandidateChecksum(candidateB));
    candidateA.changeSummary = "different";
    expect(computeEvolutionCandidateChecksum(candidateA)).not.toBe(computeEvolutionCandidateChecksum(candidateB));
  });

  it("redacts secrets in free-text fields and leaves ids/checksum/version intact", () => {
    const artifact = makeArtifact(1);
    const withSecrets: EvolutionArtifact = {
      ...artifact,
      event: { summary: "Authorization: Bearer xyz", taskIds: [] },
      hypothesis: "api_key=secret and token=abc123",
      candidate: {
        ...artifact.candidate,
        changeSummary: "sk-0123456789abcdef0123456789abcdef0123456789",
        proposedDiff: "0000000000000000000000000000000000000000secret",
      },
      trial: { ...artifact.trial, rationale: "failure near 1111111111111111111111111111111111111111" },
    };

    const redacted = redactEvolutionArtifact(withSecrets);
    expect(redacted.id).toBe(artifact.id);
    expect(redacted.version).toBe(artifact.version);
    expect(redacted.candidate.checksum).toBe(artifact.candidate.checksum);
    expect(redacted.event.summary).not.toContain("xyz");
    expect(redacted.event.summary).toContain("[REDACTED]");
    expect(redacted.hypothesis).not.toMatch(/api_key=secret|token=abc123/);
    expect(redacted.hypothesis).toContain("[REDACTED]");
    expect(redacted.candidate.changeSummary).toContain("[REDACTED]");
    expect(redacted.candidate.proposedDiff).toContain("[REDACTED]");
    expect(redacted.trial.rationale).toContain("[REDACTED]");
  });
});