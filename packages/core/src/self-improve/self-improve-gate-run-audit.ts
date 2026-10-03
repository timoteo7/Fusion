import type { RunAuditEventInput } from "../types/audit/run-audit.js";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "../run-audit/emit-bounded-run-audit.js";
import type { PrimaryGateVerdict } from "../types/self-improve/primary-gate.js";

/*
FNXC:SelfImproveGateRunAudit 2026-09-30-09:45:
FUSI-016 adds `selfimprove:gate-run`, the run-audit edge for the deterministic primary gate. Where the
three ledger façades (FUSI-012) record that a learning transition HAPPENED, this records that a
candidate was JUDGED: a boolean verdict bound to a reproducible fingerprint, plus the per-step
ids/booleans that produced it. It is a fourth event type, not a fourth writer of an existing one —
the single-writer rule in `self-improve-run-audit.ts` holds per-event, and this module is the sole
writer of `selfimprove:gate-run` exactly as that module is the sole writer of the three ledger
transitions. Do NOT emit `selfimprove:gate-run` from anywhere else; a verdict produced by one code
path and an audit row produced by another is the divergence this contract exists to prevent.

FNXC:SelfImproveGateRunAudit 2026-09-30-09:45:
Metadata is ids/counts/booleans ONLY: the candidate sha, the boolean verdict, each step's id paired
with its boolean, the failed-step count, the affected-test file count, and the run duration. The
verdict FINGERPRINT is a content hash, not prose, and is recorded so two identical runs are provably
identical. The code diff, each step's command line, and any compiler/test log output are STRUCTURALLY
excluded — the gate result is a yes/no, and the evidence behind it lives in the ledger and the
experiment worktree, not in the queryable audit edge. The metadata is built from an explicit closed
field list and NEVER spreads caller input, so adding an optional field to the input can never
silently widen what run-audit records.

FNXC:SelfImproveGateRunAudit 2026-09-30-09:45:
Telemetry is NOT load-bearing. The façade routes through the FN-9177 bounded core seam and returns
its promise so a caller MAY await it, but it never throws, rejects, or requires the row to land. An
absent, throwing, rejecting, never-settling, or late-settling sink changes what is OBSERVED and
nothing about the verdict the caller already holds. This is the invariant that lets a learning
experiment be judged on its deterministic gate verdict rather than on whether telemetry was healthy.
*/

/** The run-audit mutation type this module is the sole writer of. */
export const SELF_IMPROVE_GATE_RUN_EVENT = "selfimprove:gate-run" as const;

/** Fixed agent id recorded when a caller does not name one. */
export const SELF_IMPROVE_GATE_RUN_AGENT_ID = "selfimprove";

/** Shared input for a `selfimprove:gate-run` emission. */
export interface SelfImproveGateRunInput {
  /** Any object exposing the minimal `recordRunAuditEvent` seam (`TaskStore` satisfies it structurally). */
  host: RunAuditSinkHost;
  /** The deterministic verdict the gate produced. Recorded as ids/booleans, never as prose. */
  verdict: PrimaryGateVerdict;
  /** Project-scoped audit correlation id, when the caller tracks one. */
  projectId?: string;
  /** Actor recorded as the judging agent. Defaults to the fixed system principal. */
  agentId?: string;
  /**
   * Run that performed the gate. Optional: defaults to a stable id derived from the candidate sha so
   * repeated gate runs of the same candidate correlate under one run id.
   */
  runId?: string;
  /** ISO-8601 instant override. Defaults to now. */
  timestamp?: string;
}

/**
 * Build the closed metadata for a gate run.
 *
 * Each step contributes ONLY its id and its pass/fail boolean. The richer outcome vocabulary
 * (timed-out vs failed) is deliberately NOT recorded: two runs that reach the same boolean decision
 * share a fingerprint, and run-audit mirrors that decision-level identity. The per-step ids and
 * booleans are the ids/outcomes record; the affected-test count is a count; the duration is a
 * duration. Nothing here is free-form text.
 */
function buildGateRunMetadata(verdict: PrimaryGateVerdict, durationMs: number): Record<string, unknown> {
  return {
    candidateSha: verdict.candidateSha,
    passed: verdict.passed,
    fingerprint: verdict.fingerprint,
    // Sorted for a stable record; each entry is [stepId, boolean] — ids/outcomes only.
    steps: verdict.steps.map((step) => [step.id, step.passed]),
    failedStepCount: verdict.failedStepCount,
    affectedTestCount: verdict.affectedTestCount,
    affectedScopeKind: verdict.affectedScope.kind,
    durationMs,
  };
}

/**
 * Record that the primary gate judged a candidate.
 *
 * Emits `selfimprove:gate-run`. `durationMs` is a caller-measured wallclock number, recorded as a
 * count; the façade itself never reads a clock, keeping the emission a pure projection of the
 * already-assembled verdict. The returned promise resolves regardless of sink health.
 */
export function emitSelfImproveGateRun(
  input: SelfImproveGateRunInput & { durationMs: number },
): Promise<void> {
  const { host, verdict, durationMs } = input;
  const event: RunAuditEventInput = {
    // A gate run is not a task and belongs to no task column; the run-audit seam's optional taskId
    // is deliberately left undefined rather than borrowed.
    taskId: undefined,
    agentId: input.agentId ?? SELF_IMPROVE_GATE_RUN_AGENT_ID,
    runId: input.runId ?? `selfimprove-gate-${verdict.candidateSha}`,
    domain: "database",
    mutationType: SELF_IMPROVE_GATE_RUN_EVENT,
    target: verdict.candidateSha,
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    metadata: {
      ...buildGateRunMetadata(verdict, durationMs),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
  };
  return emitBoundedRunAudit(host, event);
}
