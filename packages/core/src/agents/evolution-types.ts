/**
 * FNXC:EvolutionPipeline 2026-09-03-09:00:
 * KB-001 (Safe, Testable Self-Improvement MVP): evolution domain types and the artifact
 * redaction helper. This file holds the normalized signal/candidate/trial/artifact shapes that
 * the evolution stores, services, adapters and CLI all share. Free-text fields are the only
 * fields that ever carry human/agent prose, so redaction is centralized here to guarantee no
 * secret reaches a stored artifact, a log line, or run-audit metadata.
 */
import { createHash } from "node:crypto";
import { redactSecrets } from "../secrets/redact-secrets.js";

/** Normalized outcome of a single execution/review/human signal. */
export type EvolutionSignalOutcome = "success" | "failure" | "skipped";

/** Provenance of a signal — where the observation originated. */
export type EvolutionSignalSource = "execution" | "review" | "human";

/** Fixed enum for a review verdict (never free prose). */
export type EvolutionReviewVerdict = "approved" | "rejected" | "revision-requested";

/** Fixed enum labels for a failure category. Never write bare error prose here. */
export type EvolutionFailureCategory =
  | "test-failure"
  | "lint-failure"
  | "build-failure"
  | "typecheck-failure"
  | "merge-failure"
  | "tool-error"
  | "timeout"
  | "unknown";

/** The kind of thing a candidate evolution changes on the live agent. */
export type EvolutionChangeType = "instructions" | "skill" | "config";

/** A single normalized observation about one task/agent execution or review. */
export interface EvolutionSignal {
  id: string;
  agentId: string;
  /** Task that produced the signal, when one exists. */
  taskId?: string;
  timestamp: string;
  outcome: EvolutionSignalOutcome;
  /** Normalized quality score in [0,1]. Omitted (never zeroed) when unavailable. */
  qualityScore?: number;
  /** Review verdict when a review/rating exists. */
  reviewVerdict?: EvolutionReviewVerdict;
  /** Token cost when token usage is available. */
  costTokens?: number;
  /** Execution duration in ms. Omitted when unavailable. */
  durationMs?: number;
  /** Fixed-enum failure category label when the outcome is a failure. */
  failureCategory?: EvolutionFailureCategory;
  /** Free-text human feedback (redacted on write). */
  humanFeedback?: string;
  source: EvolutionSignalSource;
}

/** Build a deterministic checksum for a candidate payload (order-independent). */
export function computeEvolutionCandidateChecksum(candidate: EvolutionCandidate): string {
  const canonical = canonicalizeCandidate(candidate);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Canonical candidate payload used for checksum + drift guard. Generated ids and
 * timestamps are deliberately excluded so the checksum is stable across re-publishes
 * and only changes when the actual proposed change changes.
 */
export function canonicalizeCandidate(candidate: EvolutionCandidate): Record<string, unknown> {
  return {
    changeType: candidate.changeType,
    target: candidate.target,
    changeSummary: candidate.changeSummary,
    proposedDiff: candidate.proposedDiff,
  };
}

/** A candidate change to the agent's instructions/skill/config — never auto-applied. */
export interface EvolutionCandidate {
  changeType: EvolutionChangeType;
  target: string;
  changeSummary: string;
  proposedDiff: string;
  /** sha256 of canonicalizeCandidate(this); set by the service, used by the drift guard. */
  checksum: string;
}

/** Optional evidence imported from Hermes (read-only, bounded). */
export interface HermesEvidence {
  sessionsCount: number;
  evaluationsCount: number;
  skillsImported: number;
  memoryItemsImported: number;
  applicableInsights: string[];
}

/** Optional evidence observed from Herdr panes/sessions (read-only, bounded). */
export interface HerdrEvidence {
  panes: number;
  sessions: number;
  activeCommands: number;
  durationMs: number;
}

/** Evidence bundle attached to an evolution artifact. */
export interface EvolutionEvidence {
  /** Signal ids that informed this artifact. */
  signals: string[];
  hermes?: HermesEvidence;
  herdr?: HerdrEvidence;
}

/** One metric observed from a baseline or candidate command run. */
export interface EvolutionRunMetrics {
  [metric: string]: number;
}

/** A single baseline/candidate command invocation result. */
export interface EvolutionRun {
  command: string;
  passed: boolean;
  metrics: EvolutionRunMetrics;
}

/** A set of explicit criteria that together decide keep vs revert. */
export type EvolutionDecisionCriterion =
  | "all-gate-checks-pass"
  | "primary-metric-beats-baseline"
  | "no-new-failures";

/** Outcome enum for an evolution trial decision. */
export type EvolutionDecision = "keep" | "revert" | "rejected";

/** Tracked, deterministic trial decision for a candidate vs a baseline. */
export interface EvolutionTrial {
  baselineRun: EvolutionRun;
  candidateRun: EvolutionRun;
  /** Criteria that were satisfied by the candidate run. */
  decisions: EvolutionDecisionCriterion[];
  decision: EvolutionDecision;
  rationale: string;
}

/** Approval lifecycle state on an artifact. */
export type EvolutionApprovalStatus =
  | "not-requested"
  | "pending"
  | "approved"
  | "rejected";

/** Human-approval state tracked on the artifact. */
export interface EvolutionApproval {
  status: EvolutionApprovalStatus;
  /** ApprovalRequestStore record that backs this artifact's approval. */
  approvalRequestId?: string;
  decidedBy?: string;
  decidedAt?: string;
}

/** The versioned reflection/evolution record that persists the whole loop. */
export interface EvolutionArtifact {
  id: string;
  /** Monotonic per-agent artifact version. */
  version: number;
  agentId: string;
  createdAt: string;
  trigger: EvolutionTrigger;
  event: {
    summary: string;
    taskIds: string[];
  };
  evidence: EvolutionEvidence;
  hypothesis: string;
  candidate: EvolutionCandidate;
  trial: EvolutionTrial;
  approval: EvolutionApproval;
  /** Set when the artifact is published (visible to operators). */
  publishedAt?: string;
  /** Set ONLY by the apply gate after a recorded human approval. */
  appliedAt?: string;
}

/** Trigger that started an evolution cycle/artifact. */
export type EvolutionTrigger = "periodic" | "manual" | "post-task";

/**
 * FNXC:EvolutionPipeline 2026-09-03-09:00:
 * KB-001 requires every free-text artifact field to pass through `redactSecrets` so secrets
 * can never reach a stored artifact, a log line, or run-audit metadata. Returns a NEW artifact
 * with redacted text; ids, checksums, versions, and timestamps are left intact. Missing
 * optional fields stay absent (never fabricated). Fields that are already ids/counts/enums are
 * intentionally not rewritten.
 */
export function redactEvolutionArtifact(artifact: EvolutionArtifact): EvolutionArtifact {
  return {
    ...artifact,
    event: {
      ...artifact.event,
      summary: redactSecrets(artifact.event.summary),
      taskIds: [...artifact.event.taskIds],
    },
    evidence: {
      ...artifact.evidence,
      signals: [...artifact.evidence.signals],
      ...(artifact.evidence.hermes
        ? {
            hermes: {
              ...artifact.evidence.hermes,
              applicableInsights: artifact.evidence.hermes.applicableInsights.map((i) => redactSecrets(i)),
            },
          }
        : {}),
      ...(artifact.evidence.herdr ? { herdr: { ...artifact.evidence.herdr } } : {}),
    },
    hypothesis: redactSecrets(artifact.hypothesis),
    candidate: {
      ...artifact.candidate,
      changeSummary: redactSecrets(artifact.candidate.changeSummary),
      proposedDiff: redactSecrets(artifact.candidate.proposedDiff),
    },
    trial: {
      ...artifact.trial,
      baselineRun: { ...artifact.trial.baselineRun, command: redactSecrets(artifact.trial.baselineRun.command) },
      candidateRun: { ...artifact.trial.candidateRun, command: redactSecrets(artifact.trial.candidateRun.command) },
      decisions: [...artifact.trial.decisions],
      rationale: redactSecrets(artifact.trial.rationale),
    },
    approval: { ...artifact.approval },
  };
}