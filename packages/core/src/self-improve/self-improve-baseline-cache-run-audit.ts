import type { RunAuditEventInput } from "../types/audit/run-audit.js";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "../run-audit/emit-bounded-run-audit.js";
import {
  BASELINE_CACHE_REASONS,
  isBaselineCacheAction,
  isBaselineCacheReason,
  type BaselineCacheAction,
  type BaselineCacheReason,
  type BaselineCacheStatus,
} from "../types/self-improve/baseline-cache.js";

/*
FNXC:SelfImproveBaselineCacheRunAudit 2026-09-30-18:53:
`selfimprove:baseline-cache-resolved` records that the loop resolved a baseline cache to reuse or
rebuild. This module is the SOLE writer of that mutation type, matching the single-writer contract in
`self-improve-run-audit.ts` that every `selfimprove:*` row is produced by exactly one façade. A cache
decision recorded by one code path and an audit row produced by another is the divergence this
contract exists to prevent: "the baseline was rebuilt but no audit row names it" is exactly the
un-debuggable state that would let a silently-incomparable comparison go unnoticed.

FNXC:SelfImproveBaselineCacheRunAudit 2026-09-30-18:53:
It is a NEW event type, not a reuse of a ledger transition. A cache resolution mutates no proposal
state and has no `kind` in the `learning_ledger_events_kind_check` CHECK — it records a DECISION the
measurement layer reached, like `selfimprove:cost-budget-evaluated` and `selfimprove:gate-run`. It
therefore lives in run-audit only and must never be appended to the ledger trail.

FNXC:SelfImproveBaselineCacheRunAudit 2026-09-30-18:53:
Metadata is ids/counts/fixed outcomes ONLY: the baseline key, the requested and cached fingerprints
(both content-addressed digests, not prose), the action, the fixed reason, and an optional project id.
The baseline PAYLOAD is STRUCTURALLY excluded — it is an opaque measured blob that may contain
corpus contents, counts, or command output, and none of that belongs in the queryable audit edge. The
payload's entire role is to be reused under the fingerprint, so what must be observable is WHICH
fingerprint is in play, never WHAT was measured. The metadata is built from an explicit closed field
list and NEVER spreads the status object, so a future field added to `BaselineCacheStatus` cannot
silently widen what run-audit records.

FNXC:SelfImproveBaselineCacheRunAudit 2026-09-30-18:53:
Telemetry is NOT load-bearing. The façade routes through the FN-9177 bounded core seam and returns
its promise so a caller MAY await it, but it never throws, rejects, or requires the row to land. An
absent, throwing, rejecting, never-settling, or late-settling sink changes what is OBSERVED and
nothing about whether the baseline was reused or rebuilt — the decision the caller already holds. That
is the invariant that lets a learning experiment reuse a cached baseline on its deterministic identity
rather than on whether telemetry was healthy.

FNXC:SelfImproveBaselineCacheRunAudit 2026-09-30-18:53:
The one thing this façade DOES refuse — loudly and synchronously — is a status whose action/reason pair
is outside the closed vocabulary. That is a CALLER programming error, not a sink-health condition, and
it is deliberately distinguished from the seam's tolerance: emitting a `reuse`/`fingerprint-diverged`
combination the pure resolver would never produce would put an outcome in the audit trail that no
decision actually reached. The "never throws" contract above covers the SINK; this guards the INPUT.
*/

/** The run-audit mutation type this module is the sole writer of. */
export const SELF_IMPROVE_BASELINE_CACHE_EVENT = "selfimprove:baseline-cache-resolved" as const;

/** Fixed agent id recorded when a caller does not name one. */
export const SELF_IMPROVE_BASELINE_CACHE_AGENT_ID = "selfimprove";

/** Shared input for a `selfimprove:baseline-cache-resolved` emission. */
export interface SelfImproveBaselineCacheInput {
  /** Any object exposing the minimal `recordRunAuditEvent` seam (`TaskStore` satisfies it structurally). */
  host: RunAuditSinkHost;
  /** The read model being recorded: baseline key, both fingerprints, the action, and the reason. */
  status: BaselineCacheStatus;
  /** Project-scoped audit correlation id, when the caller tracks one. */
  projectId?: string;
  /** Actor recorded as the resolving agent. Defaults to the fixed system principal. */
  agentId?: string;
  /**
   * Run that performed the resolution. Optional: defaults to a stable id derived from the baseline
   * key so repeated resolutions of one baseline correlate under a single run id.
   */
  runId?: string;
  /** ISO-8601 instant override. Defaults to now. */
  timestamp?: string;
}

/**
 * Validate the status before it becomes telemetry.
 *
 * The action/reason pair is checked against the closed enums so a hand-built or drifted status cannot
 * record an outcome outside the vocabulary the resolver produces. This is the façade's own assertion,
 * not a re-derivation: it never computes the action from the fingerprints, because the pure resolver
 * already decided them and this layer's only job is to report that decision faithfully.
 */
function assertClosedOutcome(action: BaselineCacheAction, reason: BaselineCacheReason): void {
  if (!isBaselineCacheAction(action) || !isBaselineCacheReason(reason)) {
    throw new Error("A baseline cache audit row requires a known action/reason pair");
  }
}

/**
 * Record that a baseline cache resolved to reuse or rebuild.
 *
 * Emits `selfimprove:baseline-cache-resolved` with ids/fixed outcomes only. The returned promise
 * resolves regardless of sink health; a hostile sink never alters the resolution the caller holds.
 */
export function emitSelfImproveBaselineCacheResolved(input: SelfImproveBaselineCacheInput): Promise<void> {
  const { host, status } = input;
  assertClosedOutcome(status.action, status.reason);

  const event: RunAuditEventInput = {
    // A baseline cache entry is not a task and belongs to no task column; the run-audit seam's
    // optional taskId is deliberately left undefined rather than borrowed for the baseline key.
    taskId: undefined,
    agentId: input.agentId ?? SELF_IMPROVE_BASELINE_CACHE_AGENT_ID,
    runId: input.runId ?? `selfimprove-baseline-${status.baselineKey}`,
    domain: "database",
    mutationType: SELF_IMPROVE_BASELINE_CACHE_EVENT,
    target: status.baselineKey,
    ...(input.timestamp ? { timestamp: input.timestamp } : {}),
    metadata: {
      baselineKey: status.baselineKey,
      action: status.action,
      reason: status.reason,
      inputFingerprint: status.inputFingerprint,
      // Null exactly when nothing was cached, which `no-cached-baseline` already names.
      cachedFingerprint: status.cachedFingerprint,
      present: status.present,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
  };
  return emitBoundedRunAudit(host, event);
}

export { BASELINE_CACHE_REASONS };
