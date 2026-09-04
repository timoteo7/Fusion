/**
 * FNXC:EvolutionPipeline 2026-09-04-03:55:
 * KB-001 Step 7 tests: the apply gate. Coverage:
 *   1. Refuses when artifact.approval.status === "not-requested" (no approval at all).
 *   2. Refuses when artifact.approval.status === "pending".
 *   3. Refuses when artifact.approval.status === "rejected".
 *   4. Refuses when artifact.approval.status === "approved" but no request id.
 *   5. Refuses when backing approval request is missing.
 *   6. Refuses when backing approval request is in a non-approved status.
 *   7. Refuses when trial.decision is `revert` or `rejected` (only `keep` may apply).
 *   8. Refuses when the live writer throws.
 *   9. Applies when all gates pass; records the redacted artifact in the live writer;
 *      marks the backing request completed; stamps `appliedAt` only on the audit row.
 *  10. Audit row: ids-only metadata — never the proposed diff, never the change summary.
 *  11. Redaction: secrets in the proposedDiff/event.summary are stripped before the live writer sees them.
 *  12. ApprovalRequestStoreLike is the only contract needed — no real DB required.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEvolutionApplyGate,
  refusingLiveWriter,
  recordingLiveWriter,
  type ApprovalRequestStoreLike,
} from "../agents/evolution-apply-gate.js";
import { computeEvolutionCandidateChecksum, type EvolutionArtifact } from "../agents/evolution-types.js";
import type { ApprovalRequest, ApprovalRequestActorSnapshot } from "../types.js";

function makeArtifact(overrides: Partial<EvolutionArtifact> = {}): EvolutionArtifact {
  const candidate = {
    changeType: "instructions" as const,
    target: "agent-x/instructions.md",
    changeSummary: "tighten retry policy",
    proposedDiff: "--- a\n+++ b\n@@\n-old\n+new\n",
    checksum: "",
  };
  candidate.checksum = computeEvolutionCandidateChecksum(candidate);
  const now = "2026-09-04T12:00:00.000Z";
  return {
    id: `evolution-artifact-${candidate.checksum.slice(0, 8)}`,
    version: 1,
    agentId: "agent-x",
    createdAt: now,
    trigger: "manual",
    event: { summary: "test", taskIds: [] },
    evidence: { signals: [] },
    hypothesis: "hypothesis",
    candidate,
    trial: {
      baselineRun: { command: "none", passed: true, metrics: { accuracy: 0.9 } },
      candidateRun: { command: "none", passed: true, metrics: { accuracy: 0.92 } },
      decisions: ["all-gate-checks-pass", "primary-metric-beats-baseline", "no-new-failures"],
      decision: "keep",
      rationale: "test",
    },
    approval: { status: "approved", approvalRequestId: "appr-1", decidedBy: "alice", decidedAt: now },
    ...overrides,
  };
}

function makeApprovalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const now = "2026-09-04T12:00:00.000Z";
  const requester: ApprovalRequestActorSnapshot = { actorId: "system", actorType: "operator", actorName: "system" };
  return {
    id: "appr-1",
    status: "approved",
    requester,
    targetAction: {
      category: "agent_provisioning",
      action: "apply_evolution",
      summary: "apply evolution artifact",
      resourceType: "evolution_artifact",
      resourceId: "evolution-artifact-test",
    },
    requestedAt: now,
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("createEvolutionApplyGate", () => {
  let auditRows: unknown[] = [];
  let written: EvolutionArtifact[] = [];
  let store: ApprovalRequestStoreLike;
  let getMock: ReturnType<typeof vi.fn>;
  let markCompletedMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    auditRows = [];
    written = [];
    markCompletedMock = vi.fn(async (id: string) => makeApprovalRequest({ id, status: "approved" }));
    getMock = vi.fn(async (id: string) => makeApprovalRequest({ id, status: "approved" }));
    store = {
      get: getMock,
      decide: vi.fn(async (id, status, input) => makeApprovalRequest({ id, status: status === "approved" ? "approved" : "denied" })),
      markCompleted: markCompletedMock,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses when approval.status is not-requested", async () => {
    const artifact = makeArtifact({ approval: { status: "not-requested" } });
    const gate = createEvolutionApplyGate({
      approvalStore: store,
      liveWriter: recordingLiveWriter(written),
      auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } },
    });
    const result = await gate.applyArtifact(artifact);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("approval-not-requested");
    expect(written).toHaveLength(0);
    expect(markCompletedMock).not.toHaveBeenCalled();
  });

  it("refuses when approval.status is pending", async () => {
    const artifact = makeArtifact({ approval: { status: "pending", approvalRequestId: "appr-1" } });
    const gate = createEvolutionApplyGate({
      approvalStore: store,
      liveWriter: recordingLiveWriter(written),
      auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } },
    });
    const result = await gate.applyArtifact(artifact);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("approval-pending");
    expect(written).toHaveLength(0);
  });

  it("refuses when approval.status is rejected", async () => {
    const artifact = makeArtifact({ approval: { status: "rejected", approvalRequestId: "appr-1" } });
    const gate = createEvolutionApplyGate({
      approvalStore: store,
      liveWriter: recordingLiveWriter(written),
      auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } },
    });
    const result = await gate.applyArtifact(artifact);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("approval-rejected");
  });

  it("refuses when approval.status is approved but no request id", async () => {
    const artifact = makeArtifact({ approval: { status: "approved" } });
    const gate = createEvolutionApplyGate({
      approvalStore: store,
      liveWriter: recordingLiveWriter(written),
      auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } },
    });
    const result = await gate.applyArtifact(artifact);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("approval-request-missing");
    expect(written).toHaveLength(0);
  });

  it("refuses when the backing approval request is missing", async () => {
    getMock.mockResolvedValueOnce(null);
    const artifact = makeArtifact();
    const gate = createEvolutionApplyGate({
      approvalStore: store,
      liveWriter: recordingLiveWriter(written),
      auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } },
    });
    const result = await gate.applyArtifact(artifact);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("approval-request-mismatched");
    expect(written).toHaveLength(0);
  });

  it("refuses when the backing approval request is not in approved status", async () => {
    getMock.mockResolvedValueOnce(makeApprovalRequest({ status: "denied" }));
    const artifact = makeArtifact();
    const gate = createEvolutionApplyGate({
      approvalStore: store,
      liveWriter: recordingLiveWriter(written),
      auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } },
    });
    const result = await gate.applyArtifact(artifact);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("approval-request-mismatched");
  });

  it("refuses when trial decision is revert", async () => {
    const artifact = makeArtifact({ trial: { ...makeArtifact().trial, decision: "revert" } });
    const gate = createEvolutionApplyGate({
      approvalStore: store,
      liveWriter: recordingLiveWriter(written),
      auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } },
    });
    const result = await gate.applyArtifact(artifact);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("trial-not-keep");
    expect(written).toHaveLength(0);
  });

  it("refuses when trial decision is rejected", async () => {
    const artifact = makeArtifact({ trial: { ...makeArtifact().trial, decision: "rejected" } });
    const gate = createEvolutionApplyGate({
      approvalStore: store,
      liveWriter: recordingLiveWriter(written),
      auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } },
    });
    const result = await gate.applyArtifact(artifact);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("trial-not-keep");
  });

  it("refuses when the live writer throws", async () => {
    const artifact = makeArtifact();
    const throwing = vi.fn(async () => { throw new Error("disk full"); });
    const gate = createEvolutionApplyGate({
      approvalStore: store,
      liveWriter: throwing,
      auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } },
    });
    const result = await gate.applyArtifact(artifact);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.reason).toBe("live-write-threw");
    expect(markCompletedMock).not.toHaveBeenCalled();
  });

  it("applies when all gates pass: writer receives redacted artifact, request is completed", async () => {
    const artifact = makeArtifact({
      event: { summary: "AKIAIOSFODNN7EXAMPLE leaked in summary", taskIds: [] },
      candidate: {
        changeType: "instructions",
        target: "agent-x/instructions.md",
        changeSummary: "fake-secret-do-not-leak",
        proposedDiff: "AKIAIOSFODNN7EXAMPLE diff",
        checksum: "",
      },
    });
    artifact.candidate.checksum = computeEvolutionCandidateChecksum(artifact.candidate);

    const gate = createEvolutionApplyGate({
      approvalStore: store,
      liveWriter: recordingLiveWriter(written),
      auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } },
    });
    const result = await gate.applyArtifact(artifact);
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.artifactId).toBe(artifact.id);
      expect(typeof result.appliedAt).toBe("string");
    }
    expect(written).toHaveLength(1);
    const writtenArtifact = written[0]!;
    // Redaction: no AWS key in the written artifact
    const serialized = JSON.stringify(writtenArtifact);
    expect(serialized).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
    // The rest of the artifact survives
    expect(writtenArtifact.id).toBe(artifact.id);
    expect(writtenArtifact.candidate.target).toBe("agent-x/instructions.md");
    // The request was completed
    expect(markCompletedMock).toHaveBeenCalledWith(
      "appr-1",
      expect.objectContaining({ actor: expect.any(Object), note: expect.stringContaining("applied artifact=") }),
    );
  });

  it("audit row metadata is ids-only — never the proposed diff, never the change summary", async () => {
    const artifact = makeArtifact();
    const gate = createEvolutionApplyGate({
      approvalStore: store,
      liveWriter: recordingLiveWriter(written),
      auditHost: { recordRunAuditEvent: (r) => { auditRows.push(r); return r; } },
    });
    await gate.applyArtifact(artifact);
    expect(auditRows.length).toBeGreaterThan(0);
    const lastRow = auditRows[auditRows.length - 1] as Record<string, unknown>;
    const serialized = JSON.stringify(lastRow);
    expect(serialized).toMatch(/agent-x/);
    expect(serialized).toMatch(/artifact/);
    expect(serialized).toMatch(/evolution-artifact-/);
    // No candidate prose / diff body
    expect(serialized).not.toMatch(/tighten retry policy/);
    expect(serialized).not.toMatch(/proposedDiff/);
  });

  it("refusingLiveWriter throws — confirms the test seam prevents accidental live writes", async () => {
    const writer = refusingLiveWriter();
    await expect(writer(makeArtifact())).rejects.toThrow(/refusingLiveWriter/);
  });
});
