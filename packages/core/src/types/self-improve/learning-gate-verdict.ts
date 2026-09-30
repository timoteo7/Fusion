/*
FNXC:SelfImproveGateVerdict 2026-09-30-12:40:
The self-improvement loop decides EVERY experiment with a deterministic primary gate, and only
falls back to the versioned replay canary for the cases the gate itself is silent about. This
module owns the vocabulary both inputs speak. The reason it lives in its own file, beside
`learning-proposal.ts` and not inside the gate implementation, is that three later surfaces — the
durable record, the store accessor, and the run-audit façade — all read these types, and a gate
implementation that also declared them would make "what can a verdict BE" a question each consumer
answers differently.

FNXC:SelfImproveGateVerdict 2026-09-30-12:40:
`LearningGateVerdict` is a CLOSED enum, not a free label, and its three members are the complete
decision space of the loop. `keep` means the candidate stands; `reverse` means it must be rolled
back; `inconclusive` is NOT a soft `keep` — it is the honest "the primary gate had nothing to say"
verdict, and it is what lets the canary contribute at all. Collapsing it into a nullable `keep` (or
letting a caller write arbitrary text) would make "the gate abstained" indistinguishable from "the
gate approved", which is exactly the confusion the replay canary exists to resolve. It mirrors the
`learning_gate_verdicts_resolved_verdict_check` CHECK constraint exactly.

FNXC:SelfImproveGateVerdict 2026-09-30-12:40:
`LearningGatePrecedenceOutcome` is the SECOND closed enum, and it is what makes the precedence rule
auditable rather than merely implemented. A resolved verdict alone cannot say WHY it was chosen: a
`keep` produced by a decisive primary gate and a `keep` produced by an agreeing canary are the same
answer but very different evidence. The outcome records which rule actually decided — `canary-absent`
(nothing to defer to), `agreed` (both said the same), `primary-prevailed` (they conflicted and the
primary won), `primary-abstained` (the primary was inconclusive and the canary decided). It mirrors
the `learning_gate_verdicts_precedence_outcome_check` CHECK.

FNXC:SelfImproveGateVerdict 2026-09-30-12:40:
The PRIMARY SIGNALS are a closed input type, not an open bag of measurements. The primary gate is
required to be reproducible: the same candidate against the same corpus with the same seed must
return the same signals, and a fingerprint over exactly these fields is what lets a re-run be proven
identical rather than asserted. Modelling the signals as a named type — with `buildOk`, `lintOk`,
`typecheckOk`, `gateOk`, `affectedTestsOk` and their booleans plus the test-count delta, the
cost-budget invariant, the corpus version and the seed — is what keeps a later gate implementation
from quietly adding a signal the fingerprint does not cover, which would make two runs with
different evidence look identical.

FNXC:SelfImproveGateVerdict 2026-09-30-12:40:
The COST-BUDGET invariant and the TEST-COUNT DELTA are carried as their own typed fields rather than
folded into the pass/fail booleans. A cost-budget invariant and a test-count delta are not the same
kind of evidence as "lint passed": the booleans are a deterministic pass/fail, whereas the delta and
the invariant are measured quantities whose thresholds the gate applies. Keeping them first-class
means the fingerprint covers them, and a reader of a persisted verdict can see what was actually
measured without re-running the gate.

FNXC:SelfImproveGateVerdict 2026-09-30-12:40:
`canaryVerdict` is OPTIONAL (`LearningGateVerdict | null`) on the persisted record, but on the
resolved record it is always present (it equals the primary's when absent). Modeling the input as
`canaryVerdict?: LearningGateVerdict | null` on `LearningGateVerdictInput` — where an absent or
null canary is the "no canary" case — keeps the resolution function total over both shapes instead of
requiring a caller to invent a canary verdict to say "there wasn't one".
*/

/**
 * The resolved verdict of a learning experiment. Closed enum mirroring the
 * `learning_gate_verdicts_resolved_verdict_check` CHECK.
 *
 * `inconclusive` is an honest abstention, not a weak approval: it is the state in which the
 * deterministic primary gate had nothing decisive to say and the replay canary's verdict, if any,
 * supplies the decision.
 */
export type LearningGateVerdict = "keep" | "reverse" | "inconclusive";

/** Every legal verdict, in the order the database CHECK lists them. */
export const LEARNING_GATE_VERDICTS: readonly LearningGateVerdict[] = ["keep", "reverse", "inconclusive"];

/**
 * Which rule produced the resolved verdict. Mirrors the
 * `learning_gate_verdicts_precedence_outcome_check` CHECK.
 *
 * - `canary-absent`   — there was no canary; the primary gate decided on its own.
 * - `agreed`          — both inputs said the same thing.
 * - `primary-prevailed` — both were decisive and disagreed; the PRIMARY gate won (the canary
 *                        never overturns a decisive primary).
 * - `primary-abstained` — the primary was `inconclusive`; the canary's decisive verdict decided.
 */
export type LearningGatePrecedenceOutcome =
  | "canary-absent"
  | "agreed"
  | "primary-prevailed"
  | "primary-abstained";

/** Every legal precedence outcome, in the order the database CHECK lists them. */
export const LEARNING_GATE_PRECEDENCE_OUTCOMES: readonly LearningGatePrecedenceOutcome[] = [
  "canary-absent",
  "agreed",
  "primary-prevailed",
  "primary-abstained",
];

/**
 * The closed set of deterministic signals the primary gate produces. Every field is covered by the
 * verdict fingerprint, so two runs of the primary gate are provably identical (or provably not)
 * from the persisted record alone.
 *
 * This is a CLOSED input the primary-gate feature (FUSI-016/017/018) POPULATES; it does not
 * compute any of these signals here. The `corpusVersion` and `seed` pin the replay corpus the
 * signals were computed against, which is what makes "same inputs" a checkable claim.
 */
export interface LearningGatePrimarySignals {
  /** Build succeeded. */
  buildOk: boolean;
  /** Lint passed. */
  lintOk: boolean;
  /** Typecheck passed. */
  typecheckOk: boolean;
  /** The curated merge gate passed. */
  gateOk: boolean;
  /** The affected-tests lane passed. */
  affectedTestsOk: boolean;
  /** Change in the collected test count (new passing − removed) the candidate produced. */
  testCountDelta: number;
  /** The cost-budget invariant (corpus, ordering and seed all fixed) held. */
  costBudgetInvariantOk: boolean;
  /** Version of the replay corpus the signals were computed against. */
  corpusVersion: string;
  /** Fixed random seed the corpus was sampled with. */
  seed: number;
}

/**
 * A primary gate's signals together with the experiment/baseline identity they were computed for.
 * `canaryVerdict` is the replay canary's verdict, when one exists; absent/null means "no canary".
 */
export interface LearningGateVerdictInput {
  /** The experiment the verdict is about. Required, non-blank. */
  experimentId: string;
  /** The baseline the experiment is compared against. Required, non-blank. */
  baselineId: string;
  /** The primary gate's deterministic signals for this candidate. */
  primarySignals: LearningGatePrimarySignals;
  /** The replay canary's verdict, when a canary ran. Absent/null = no canary. */
  canaryVerdict?: LearningGateVerdict | null;
}
