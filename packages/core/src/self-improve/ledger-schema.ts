import type {
  LearningProposal,
  LearningProposalEvidenceRef,
  LearningProposalState,
  LearningProposalTarget,
} from "../types/self-improve/learning-proposal.js";

/*
FNXC:SelfImproveLearningLedger 2026-09-29-02:38:
These are the ONLY places that decide what a proposal's confidence, value, or expiry MEAN. The
later gate and apply features (FUSI-010/011/012) read them instead of re-deriving the rules, so
"expired" and "versioned" cannot drift into two different meanings across the loop.

FNXC:SelfImproveLearningLedger 2026-09-29-02:38:
Invariant 1 — an expired value is never applied without reevaluation. `canApplyProposal` returns
false the moment `expiresAt` is at or before `now`, even though the same `now` would otherwise
permit application. Reevaluation produces a NEW record with a fresh `expiresAt` and bumped
`version`, which is why the guard is a read-time predicate rather than a mutation: nothing can
apply a stale value and later re-derive that it was fresh.

FNXC:SelfImproveLearningLedger 2026-09-29-02:38:
Invariant 2 — confidence and value are versioned together on every new application. Moving the
old `value` into `priorValue` is what makes the revert decision possible: reverting restores the
value the proposal held BEFORE the experiment, not a hardcoded zero. The two move in one function
so a caller cannot bump `version` while leaving `priorValue` stale.
*/

/** The four states a proposal may hold. Mirrors the `learning_proposals_state_check` CHECK constraint. */
export const LEARNING_PROPOSAL_STATES: readonly LearningProposalState[] = [
  "proposed",
  "applied",
  "reverted",
  "expired",
];

/** The surfaces a proposal may act on. Mirrors the loop's data-layer-first mutation ordering. */
export const LEARNING_PROPOSAL_TARGETS: readonly LearningProposalTarget[] = ["memory", "evals", "skills"];

/** True when `value` is one of the four contract states. Guards callers building a record by hand. */
export function isLearningProposalState(value: unknown): value is LearningProposalState {
  return typeof value === "string" && (LEARNING_PROPOSAL_STATES as readonly string[]).includes(value);
}

/**
 * Bound a confidence or value input to the 0..1 contract range.
 *
 * Non-finite and unparseable input falls back to `fallback` rather than throwing, because a
 * malformed learning signal must not crash the loop that is trying to measure it; the ledger's job
 * is to keep recording, with the bad value collapsed to a safe bound.
 */
export function normalizeConfidence(value: unknown, fallback = 0): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return normalizeConfidence(fallback, 0);
  if (numeric < 0) return 0;
  if (numeric > 1) return 1;
  return numeric;
}

/**
 * A proposal is expired once its deadline has been reached.
 *
 * The comparison is inclusive at the boundary (`>=`): a deadline is the last instant the value is
 * still fresh, so `now === expiresAt` is already stale. A proposal with no deadline never expires;
 * it stays applicable until a reevaluation replaces it.
 */
export function isProposalExpired(proposal: LearningProposal, now: string | Date): boolean {
  if (!proposal.expiresAt) return false;
  const expiresAt = Date.parse(proposal.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  const current = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(current)) return false;
  return current >= expiresAt;
}

/**
 * Whether `proposal` may be applied at `now`.
 *
 * False for an expired proposal — reevaluation is required first, and reevaluation is what
 * produces the replacement record this function then accepts. Also false for a proposal already
 * reverted, since its value was rolled back and re-applying it would resurrect withdrawn evidence.
 */
export function canApplyProposal(proposal: LearningProposal, now: string | Date): boolean {
  if (isProposalExpired(proposal, now)) return false;
  return proposal.state !== "reverted";
}

/**
 * Produce the next version of a proposal after a new application.
 *
 * Returns a new record: `version` increments, the previously-asserted `value` becomes
 * `priorValue`, and confidence/value move together. The input is never mutated, so a caller that
 * still holds the pre-application record keeps the evidence it applied.
 */
export function applyProposalVersioning(
  proposal: LearningProposal,
  nextValue: number,
  nextConfidence: number,
  now: string | Date,
): LearningProposal {
  const appliedAt = now instanceof Date ? now.toISOString() : now.trim();
  return {
    ...proposal,
    value: normalizeConfidence(nextValue),
    confidence: normalizeConfidence(nextConfidence, proposal.confidence),
    priorValue: proposal.value,
    version: proposal.version + 1,
    state: "applied",
    createdAt: proposal.createdAt || appliedAt,
    expiresAt: proposal.expiresAt,
  };
}

/** Build a fresh, unsapplied proposal record with normalized confidence and evidence. */
export function createLearningProposal(input: {
  proposalId: string;
  target: LearningProposalTarget;
  origin: string;
  confidence: number;
  value: number;
  expiresAt?: string | null;
  evidenceRefs?: LearningProposalEvidenceRef[];
  now: string | Date;
}): LearningProposal {
  const createdAt = input.now instanceof Date ? input.now.toISOString() : input.now.trim();
  return {
    proposalId: input.proposalId.trim(),
    target: input.target,
    origin: input.origin,
    confidence: normalizeConfidence(input.confidence),
    value: normalizeConfidence(input.value),
    priorValue: null,
    expiresAt: input.expiresAt ?? null,
    evidenceRefs: input.evidenceRefs ?? [],
    state: "proposed",
    version: 1,
    createdAt,
  };
}
