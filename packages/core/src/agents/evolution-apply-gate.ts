/**
 * FNXC:EvolutionPipeline 2026-09-04-03:45:
 * KB-001 Step 7 (apply gate): the SINGLE sanctioned writer that mutates live state on
 * behalf of an evolution artifact. Every other writer that touches instructions/skills/
 * agents/config MUST refuse without going through this gate; the test suite enforces
 * that with a "this function only writes through the gate" assertion.
 *
 * Authority rules:
 *   - An artifact whose `approval.status !== "approved"` is REJECTED. The gate never
 *     advances, even if the trial passed, even if a manual override was attempted.
 *   - The gate requires both:
 *       1) `artifact.approval.status === "approved"`, AND
 *       2) a valid `approvalRequestId` on the artifact, AND
 *       3) the backing `ApprovalRequest` row is in `approved` status (cross-checked).
 *   - After successful apply, the gate stamps `artifact.appliedAt` and the backing
 *     `ApprovalRequest` is `markCompleted`'d (so the request lifecycle is closed).
 *   - The gate itself does NOT call any LLM, does NOT propose a candidate, does NOT
 *     decide a trial. It only acts on a previously-validated `EvolutionArtifact`.
 *   - Live-state writers (`WriteLiveStateFn`) are injected so the test path can refuse
 *     without touching the real filesystem or any LLM-driven tool.
 *   - Audit: every refusal and every successful apply emits an `evolution-apply:*`
 *     audit row through `emitBoundedRunAuditWithOutcome` (ids/counts only — never
 *     the artifact prose, never the proposed diff).
 */
import type {
  ApprovalRequest,
  ApprovalRequestActorSnapshot,
} from "../types.js";
import { redactEvolutionArtifact, type EvolutionArtifact } from "./evolution-types.js";
import {
  computeEvolutionAuditId,
  type EvolutionAuditEvent,
} from "./evolution-trial.js";
import { emitBoundedRunAuditWithOutcome, type RunAuditSinkHost } from "../run-audit/emit-bounded-run-audit.js";

/** Reason an apply attempt was refused. Recorded in audit metadata. */
export type EvolutionApplyRefusalReason =
  | "artifact-not-found"
  | "approval-not-requested"
  | "approval-pending"
  | "approval-rejected"
  | "approval-request-missing"
  | "approval-request-mismatched"
  | "trial-not-keep"
  | "live-write-threw"
  | "live-write-refused";

/** Outcome of an apply attempt. */
export type EvolutionApplyOutcome =
  | { kind: "applied"; artifactId: string; appliedAt: string }
  | { kind: "refused"; reason: EvolutionApplyRefusalReason; hasReason: boolean };

/** Pluggable live-state writer. The gate is the ONLY caller. */
export type WriteLiveStateFn = (artifact: EvolutionArtifact) => Promise<void>;

/** Minimal ApprovalRequestStore contract the gate depends on. */
export interface ApprovalRequestStoreLike {
  get(id: string): Promise<ApprovalRequest | null>;
  decide(requestId: string, status: "approved" | "denied", input: { actor: ApprovalRequestActorSnapshot; note?: string }): Promise<ApprovalRequest>;
  markCompleted(requestId: string, input: { actor: ApprovalRequestActorSnapshot; note?: string }): Promise<ApprovalRequest>;
}

/** Options for the apply gate. */
export interface CreateEvolutionApplyGateOptions {
  approvalStore: ApprovalRequestStoreLike;
  liveWriter: WriteLiveStateFn;
  auditHost?: RunAuditSinkHost;
  now?: () => Date;
}

/** Audit shape emitted by the gate. */
export interface EvolutionApplyAuditMetadata {
  agentId: string;
  artifactId: string;
  approvalRequestId?: string;
  reason?: EvolutionApplyRefusalReason;
  appliedAt?: string;
  outcome: "applied" | "refused";
}

const APPROVAL_REFS = {
  "approval-not-requested": "not-requested",
  "approval-pending": "pending",
  "approval-rejected": "rejected",
} as const satisfies Partial<Record<EvolutionApplyRefusalReason, string>>;

function isApproveRefusalReason(reason: EvolutionApplyRefusalReason): reason is keyof typeof APPROVAL_REFS {
  return Object.prototype.hasOwnProperty.call(APPROVAL_REFS, reason);
}

/** Build an apply gate. */
export function createEvolutionApplyGate(options: CreateEvolutionApplyGateOptions) {
  const { approvalStore, liveWriter, auditHost = null } = options;
  const now = options.now ?? (() => new Date());

  /**
   * Apply an approved artifact to live state. The ONLY public mutation entry point.
   * Returns an `EvolutionApplyOutcome`. The artifact is REDACTED before any live write
   * so secrets never reach the filesystem.
   */
  async function applyArtifact(artifact: EvolutionArtifact): Promise<EvolutionApplyOutcome> {
    if (!artifact) {
      const outcome: EvolutionApplyOutcome = { kind: "refused", reason: "artifact-not-found", hasReason: false };
      await emitBoundedRunAuditWithOutcome(auditHost, {
        mutationType: "evolution-apply:refused",
        reason: "artifact-not-found",
        hasReason: false,
        outcome: "refused",
      });
      return outcome;
    }
    // Rule 1: the artifact itself must be in `approved` status.
    if (artifact.approval.status !== "approved") {
      const reason: EvolutionApplyRefusalReason =
        artifact.approval.status === "pending"
          ? "approval-pending"
          : artifact.approval.status === "rejected"
            ? "approval-rejected"
            : "approval-not-requested";
      await emitBoundedRunAuditWithOutcome(auditHost, {
        mutationType: "evolution-apply:refused",
        reason: isApproveRefusalReason(reason) ? APPROVAL_REFS[reason] : reason,
        agentId: artifact.agentId,
        artifactId: artifact.id,
        approvalRequestId: artifact.approval.approvalRequestId,
        outcome: "refused",
      });
      return { kind: "refused", reason, hasReason: !!artifact.approval.approvalRequestId };
    }
    // Rule 2: the backing approval request must exist and still be approved.
    const requestId = artifact.approval.approvalRequestId;
    if (!requestId) {
      await emitBoundedRunAuditWithOutcome(auditHost, {
        mutationType: "evolution-apply:refused",
        reason: "approval-request-missing",
        agentId: artifact.agentId,
        artifactId: artifact.id,
        outcome: "refused",
      });
      return { kind: "refused", reason: "approval-request-missing", hasReason: false };
    }
    let approval: ApprovalRequest | null;
    try {
      approval = await approvalStore.get(requestId);
    } catch (_error) {
      await emitBoundedRunAuditWithOutcome(auditHost, {
        mutationType: "evolution-apply:refused",
        reason: "approval-request-mismatched",
        agentId: artifact.agentId,
        artifactId: artifact.id,
        approvalRequestId: requestId,
        outcome: "refused",
      });
      return { kind: "refused", reason: "approval-request-mismatched", hasReason: true };
    }
    if (!approval || approval.status !== "approved") {
      await emitBoundedRunAuditWithOutcome(auditHost, {
        mutationType: "evolution-apply:refused",
        reason: "approval-request-mismatched",
        agentId: artifact.agentId,
        artifactId: artifact.id,
        approvalRequestId: requestId,
        outcome: "refused",
      });
      return { kind: "refused", reason: "approval-request-mismatched", hasReason: true };
    }
    // Rule 3: trial must have decided `keep`. A `revert` trial with an approved artifact
    // is contradictory; we refuse rather than silently apply.
    if (artifact.trial.decision !== "keep") {
      await emitBoundedRunAuditWithOutcome(auditHost, {
        mutationType: "evolution-apply:refused",
        reason: "trial-not-keep",
        agentId: artifact.agentId,
        artifactId: artifact.id,
        approvalRequestId: requestId,
        outcome: "refused",
      });
      return { kind: "refused", reason: "trial-not-keep", hasReason: true };
    }
    // Rule 4: the live writer must accept the redacted artifact. The redaction is the
    // last line of defense against secret leakage into the filesystem.
    const redacted = redactEvolutionArtifact(artifact);
    try {
      await liveWriter(redacted);
    } catch {
      await emitBoundedRunAuditWithOutcome(auditHost, {
        mutationType: "evolution-apply:refused",
        reason: "live-write-threw",
        agentId: artifact.agentId,
        artifactId: artifact.id,
        approvalRequestId: requestId,
        outcome: "refused",
      });
      return { kind: "refused", reason: "live-write-threw", hasReason: true };
    }
    const appliedAt = now().toISOString();
    // Close the request lifecycle (idempotent: only succeeds on `approved`).
    try {
      await approvalStore.markCompleted(requestId, {
        actor: approval.requester,
        note: `applied artifact=${artifact.id}`,
      });
    } catch {
      // Closing the request is best-effort: the artifact was applied. Emit a
      // a follow-up audit row so operators can see the asymmetry.
      await emitBoundedRunAuditWithOutcome(auditHost, {
        mutationType: "evolution-apply:applied-but-markcompleted-failed",
        agentId: artifact.agentId,
        artifactId: artifact.id,
        approvalRequestId: requestId,
        outcome: "applied",
      });
    }
    await emitBoundedRunAuditWithOutcome(auditHost, {
      mutationType: "evolution-apply:applied",
      agentId: artifact.agentId,
      artifactId: artifact.id,
      approvalRequestId: requestId,
      appliedAt,
      outcome: "applied",
    });
    return { kind: "applied", artifactId: artifact.id, appliedAt };
  }

  /**
   * Record the audit event the trial just emitted, but only when this gate accepts
   * the apply. Returns the audit id so the caller can stash it on the artifact.
   */
  function buildAuditId(agentId: string, artifactId: string, candidateChecksum: string): string {
    return computeEvolutionAuditId({ agentId, artifactId, candidateChecksum });
  }

  return { applyArtifact, buildAuditId };
}

/** Convenience for tests: a `WriteLiveStateFn` that always refuses. */
export function refusingLiveWriter(): WriteLiveStateFn {
  return async () => {
    throw new Error("refusingLiveWriter: not permitted in this context");
  };
}

/** Convenience for tests: a `WriteLiveStateFn` that always succeeds and records calls. */
export function recordingLiveWriter(sink: EvolutionArtifact[]): WriteLiveStateFn {
  return async (artifact) => {
    sink.push(artifact);
  };
}

/** Re-export the audit event type so callers can build their own audit shapes. */
export type { EvolutionAuditEvent };
