/*
FNXC:SelfImproveLearningLedger 2026-09-29-02:38:
The self-improvement loop keeps a DEDICATED proposal+evidence record rather than reusing
Memory/Evals/Skills prose. Memory, Evals and Skills remain the narrative surfaces a proposal
refers to; the structured decision substrate (origin, confidence, prior value, expiry, evidence
refs, state) is its own append-only record, so a proposal's decision is auditable even when the
narrative surface it cites is later rewritten, re-scored, or archived.

FNXC:SelfImproveLearningLedger 2026-09-29-02:38:
`priorValue` is denormalized point-in-time evidence rather than a join, because the loop's
revert decision needs the value a proposal HELD before it was applied, and that value stops being
derivable the moment the next application overwrites `value`. Every new application therefore
versions confidence AND value together, so a proposal can never silently change weight without
its own history recording the change.

FNXC:SelfImproveLearningLedger 2026-09-29-02:38:
`expiresAt` is part of the record contract rather than a run-audit concern because a stale
confidence must never outlive its evidence. The expiry guard is enforced in one place
(`canApplyProposal` in self-improve/ledger-schema.ts) so the later gate/apply features cannot
each decide for themselves what "expired" means.

FNXC:SelfImproveLearningLedger 2026-09-29-02:38:
This is the substrate for the rest of the self-improvement work: FUSI-010 adds the store
write/list methods, FUSI-011 the revert transitions, FUSI-012 the run-audit emission, and
FUSI-013 the operator narrative. Those siblings all read this contract; changing a field here is
a breaking change for them, so widen deliberately rather than incidentally.
*/

/** Lifecycle state of a learning proposal. `expired` is a terminal staleness marker, not a revert. */
export type LearningProposalState = "proposed" | "applied" | "reverted" | "expired";

/**
 * Product surface a proposal acts on. Entry order is the mission's data-layer-first ordering:
 * settings-like surfaces (evals, skills) are mutated before engine code is ever self-patched.
 */
export type LearningProposalTarget = "memory" | "evals" | "skills";

/** Evidence locator: a pointer to the observation that justifies the proposal, not the prose itself. */
export interface LearningProposalEvidenceRef {
  /** Owning surface the evidence came from (e.g. `evals`, `skills`, `memory`). */
  surface: string;
  /** Stable identifier within that surface (a run id, rule id, record id). */
  ref: string;
  /** Optional ISO-8601 instant the evidence was observed; drives freshness when present. */
  observedAt?: string | null;
}

/**
 * The durable proposal+evidence record. One row per (project, proposal) pair; re-application
 * versions the record in place rather than appending a new identity, so the ledger keeps exactly
 * one live entry per proposal plus the value it previously held.
 */
export interface LearningProposal {
  proposalId: string;
  target: LearningProposalTarget;
  /**
   * Where the suggestion came from, e.g. `"eval-failure"`, `"manual"`, `"memory-decay"`.
   * Free-form and human-readable; run-audit never records it.
   */
  origin: string;
  /** Confidence in the proposal, bounded to 0..1. Re-versioned on every new application. */
  confidence: number;
  /** Value the proposal currently asserts. Re-versioned on every new application. */
  value: number;
  /** Value held immediately before the current `value`; null before the first application. */
  priorValue: number | null;
  /** ISO-8601 instant after which the value is stale and may not be applied without reevaluation. */
  expiresAt: string | null;
  evidenceRefs: LearningProposalEvidenceRef[];
  state: LearningProposalState;
  /** Monotonic application counter, starting at 1; incremented by every new application. */
  version: number;
  /** ISO-8601 instant the proposal was first recorded. */
  createdAt: string;
}
