import type { LearningProposalEvidenceRef, LearningProposalTarget } from "../types/self-improve/learning-proposal.js";
import type { LearningLedgerEvent } from "./ledger-events.js";

/*
FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
These are the ONLY places that decide what a learning revert MEANS. The reason enum, the
occurrence-key derivation, and the result union live here, pure and database-free, so the
deterministic gate (a later feature) and the operator surface (a later feature) read the same
definition instead of each re-deriving "what counts as reverted" and drifting.

FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
`LearningRevertReason` is a CLOSED enum, not prose. An append-only ledger that accepted free text
here would become an unbounded narrative surface no later gate could filter or count, and the
bounded run-audit row (ids/counts/fixed-outcomes only) could not mirror it. The enum keeps "why was
this undone?" classifiable and keeps the ledger and its telemetry from ever disagreeing. Mirrors the
`learning_ledger_events_revert_reason_check` CHECK constraint exactly.

FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
`buildLearningRevertEventId` is the IDEMPOTENCY mechanism, stated once here. A reversal's event id
is DERIVED from the id of the application it cancels, not generated fresh per attempt. That single
choice is what collapses a repeated (or concurrent) revert of the same application into one row:
the second insert collides on the (project_id, event_id) primary key and the accessor's
`onConflictDoNothing` returns no row, which it reports as `already-reverted`. A uuid-per-attempt
would instead append N indistinguishable reversals and the trail would no longer answer "was this
reverted, and how many times" honestly.

FNXC:SelfImproveLearningRevertSemantics 2026-09-29-15:45:
The revert is an APPEND, never an update. There is intentionally no "mark the proposal reverted"
helper here and no code path that writes the proposal row or the application row. A correction is a
new event; the trail is the proof. This mirrors the patchnode precedent, where a cancellation is its
own row naming the delivery it cancels rather than a status flip on the delivery.
*/

/** Why an applied learning change was backed out. Mirrors the `learning_ledger_events_revert_reason_check` CHECK. */
export type LearningRevertReason =
  /** The deterministic primary gate rejected the experiment and the change was rolled back. */
  | "gate-rejected"
  /** An operator explicitly vetoed this learning change. */
  | "operator-veto"
  /** A later, better-evidenced proposal superseded this one. */
  | "superseded"
  /** The applied value reached its `expiresAt` and was withdrawn before reevaluation. */
  | "expired"
  /** An operator or surface backed it out for a reason outside the other classes. */
  | "manual";

/** Every legal revert reason, in the order the database CHECK lists them. */
export const LEARNING_REVERT_REASONS: readonly LearningRevertReason[] = [
  "gate-rejected",
  "operator-veto",
  "superseded",
  "expired",
  "manual",
];

/** True when `value` is one of the fixed revert reasons. Guards callers building a reversal by hand. */
export function isLearningRevertReason(value: unknown): value is LearningRevertReason {
  return typeof value === "string" && (LEARNING_REVERT_REASONS as readonly string[]).includes(value);
}

/**
 * Derive the deterministic event id of a reversal that cancels `appliedEventId`.
 *
 * Stable across retries by construction: the same application always yields the same reversal id,
 * which is what makes the insert's `onConflictDoNothing` the idempotency boundary. The `:reverted`
 * suffix is appended to a value the caller controls, so a blank application id is refused rather
 * than silently producing a reversal named `:reverted` that pairs with nothing.
 */
export function buildLearningRevertEventId(appliedEventId: string): string {
  const trimmed = appliedEventId?.trim();
  if (!trimmed) throw new Error("A learning reversal requires the event id of the application it cancels");
  return `${trimmed}:reverted`;
}

/**
 * Outcome of a revert attempt.
 *
 * `not-applied` and `already-reverted` are NOT failures: they are the two ways a revert is a
 * no-op. `not-applied` means there is no un-reverted application to cancel, so nothing was written.
 * `already-reverted` means this exact application was cancelled before, so the trail is unchanged.
 * Only `reverted` appended a row.
 */
export type LearningRevertOutcome = "reverted" | "already-reverted" | "not-applied";

/**
 * The result of reverting a learning application.
 *
 * `restoredValue` is the proposal's `priorValue` VERBATIM — the value held immediately before the
 * application being cancelled. The surface that owns the Memory/Evals/Skills target writes it back;
 * this layer deliberately stores no value, because M1 mutates no product surface and a generic value
 * store would be a second source of truth for the value the trail already records. `null` is a
 * legitimate restored value (nothing was held before the first application) and is distinct from an
 * absent result.
 */
export interface LearningRevertResult {
  outcome: LearningRevertOutcome;
  /** Proposal the reversal belongs to. */
  proposalId: string;
  /**
   * Product surface the proposal acts on. Absent only for `not-applied` against a proposal that
   * does not exist in this project (including a proposalId belonging to another project): a
   * proposal that was never found has no target, and inventing one would report a surface the
   * ledger knows nothing about.
   */
  target?: LearningProposalTarget;
  /** The `applied` event this revert cancelled or would cancel. Empty only when none was located. */
  appliedEventId: string;
  /** Event id of the appended reversal; equal to `buildLearningRevertEventId(appliedEventId)` when an application was located. */
  revertEventId: string;
  /** The value to restore, verbatim from the proposal's `priorValue`. `null` when no proposal was found. */
  restoredValue: number | null;
  /** Present only for `outcome: "reverted"`; the reversal event actually appended. */
  event?: LearningLedgerEvent;
  /** Present only for `outcome: "reverted"`. Absent for the two no-op outcomes. */
  reason?: LearningRevertReason;
  /** Evidence locators copied onto the reversal event, when the caller supplied them. */
  evidenceRefs?: LearningProposalEvidenceRef[];
}

/** Input for a revert attempt. */
export interface LearningRevertInput {
  /** Proposal whose application is being cancelled. Never addressed by id alone at the store seam. */
  proposalId: string;
  /** The `applied` event to cancel. Omit to cancel the latest un-reverted application. */
  appliedEventId?: string;
  /**
   * Fence for the application lookup. A retried revert passes the instant of the reversal it is
   * retrying, so it re-affirms the ORIGINAL application instead of a later re-application; a
   * genuine new revert omits it and pairs with the latest.
   */
  noLaterThan?: string;
  /** Why the change is being backed out. Required; a reversal with no reason is unauditable. */
  reason: LearningRevertReason;
  /** ISO-8601 instant the reversal happened; defaults to now. */
  occurredAt?: string;
  /** Optional evidence locators recorded alongside the reversal. */
  evidenceRefs?: LearningProposalEvidenceRef[];
}
