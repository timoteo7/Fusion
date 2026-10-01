import type {
  LearningProposal,
  LearningProposalEvidenceRef,
  LearningProposalState,
  LearningProposalTarget,
} from "../types/self-improve/learning-proposal.js";
import type { LearningRevertReason } from "./self-improve-run-audit.js";

/*
FNXC:SelfImproveLearningLedger 2026-09-29-15:15:
The event trail is APPEND-ONLY. An application and its reversal are separate immutable rows rather
than columns mutated on the proposal, because the loop's revert decision must be answerable from
the trail itself: if the proposal row were overwritten on every application, the value it held
before the experiment would be gone the moment it was needed. Nothing in this module may
UPDATE or DELETE a `learning_ledger_events` row — a correction is a new event, never an edit.

FNXC:SelfImproveLearningLedger 2026-09-29-15:15:
`kind` is deliberately a THREE-value subset of `LearningProposalState`. `expired` is a staleness
marker a reevaluation writes onto the proposal row, not a transition in the experiment trail: no
application was made and none is being cancelled, so there is no event to append. Keeping the two
enums distinct stops an expiry from being read as a revert by the later gate.
*/

/** One immutable transition in the learning trail. Mirrors the `learning_ledger_events_kind_check` CHECK. */
export type LearningLedgerEventKind = "proposed" | "applied" | "reverted";

/** An append-only learning-ledger event. Immutable once written; corrections append a new row. */
export interface LearningLedgerEvent {
  eventId: string;
  proposalId: string;
  target: LearningProposalTarget;
  kind: LearningLedgerEventKind;
  /**
   * For `kind: "reverted"`, the `applied` event this reversal cancels. Required by the database
   * for a reversal and always absent otherwise.
   */
  revertsEventId?: string | null;
  /**
   * For `kind: "reverted"`, WHY the application was backed out, as a member of the fixed
   * revert-reason enum. Required by the database for a reversal and always absent otherwise.
   */
  revertReason?: LearningRevertReason | null;
  evidenceRefs: LearningProposalEvidenceRef[];
  /** ISO-8601 instant the transition happened; the ordering key for the trail. */
  occurredAt: string;
  createdAt: string;
}

/**
 * A proposal as it reads NOW: FUSI-009's durable record plus the trail that produced its current
 * state.
 *
 * `derivedState` is recomputed from the proposal's LATEST event rather than trusted from the
 * proposal row, so a listing answers "what is in effect right now" from the append-only source of
 * truth. The proposal's own `state` column is retained as `declaredState` so a divergence between
 * the two is visible to the operator instead of being silently hidden. `events` is the full trail
 * for this proposal, oldest first.
 */
export interface LearningProposalWithState extends LearningProposal {
  /** State derived from the latest event in this proposal's trail. */
  derivedState: LearningProposalState;
  /** The proposal row's own `state` column, for divergence comparison against `derivedState`. */
  declaredState: LearningProposalState;
  /** Full event trail for this proposal, oldest first. */
  events: LearningLedgerEvent[];
}

/** Result page from a learning-ledger listing. Mirrors the patchnode feed pagination shape. */
export interface LearningLedgerPage {
  proposals: LearningProposalWithState[];
  totalEntries: number;
  hasMore: boolean;
}

/**
 * Filter for a learning-ledger listing.
 *
 * Every field is optional and independent: `target` narrows to one product surface, `state` to
 * proposals whose DERIVED state matches, and `from`/`to` bound the window by the proposal's latest
 * event instant. `limit` is clamped to 1..200 and `offset` floored at 0 by the accessor, so a
 * caller cannot request an unbounded page.
 */
export interface LearningLedgerQuery {
  target?: LearningProposalTarget;
  state?: LearningProposalState;
  /** Inclusive lower bound on the latest event's `occurredAt` (ISO-8601). */
  from?: string;
  /** Inclusive upper bound on the latest event's `occurredAt` (ISO-8601). */
  to?: string;
  limit?: number;
  offset?: number;
}
