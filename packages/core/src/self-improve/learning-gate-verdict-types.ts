import { createHash } from "node:crypto";
import {
  LEARNING_GATE_VERDICTS,
  type LearningGatePrecedenceOutcome,
  type LearningGateVerdict,
  type LearningGateVerdictInput,
} from "../types/self-improve/learning-gate-verdict.js";

/*
FNXC:SelfImproveGateVerdict 2026-09-30-12:40:
This is the ONLY place that decides what a learning experiment's KEEP/REVERSE verdict MEANS. The
resolution function, the fingerprint, and the derived verdict id live here, pure and database-free,
mirroring `learning-revert-types.ts`, so the durable record, the store accessor, and the run-audit
façade all read the same definition instead of each re-deriving "who won?" and drifting.

FNXC:SelfImproveGateVerdict 2026-09-30-12:40:
The precedence rule — the PRIMARY gate prevails over the replay canary in ANY conflict — is enforced
here and nowhere else. The resolution function is TOTAL over the 3x3 combination space of {primary,
canary} x {keep, reverse, inconclusive} plus the absent-canary case, so every combination maps to
exactly one (verdict, outcome) pair with no caller branching:
  - canary absent            -> the primary's verdict, `canary-absent`
  - primary == canary        -> that verdict, `agreed`
  - primary inconclusive      -> a decisive canary decides, `primary-abstained` (a canary that is
                                ALSO inconclusive leaves the verdict inconclusive)
  - both decisive, disagree   -> the PRIMARY's verdict, `primary-prevailed`
The invariant this encodes: the canary can ONLY contribute where the primary abstained. A decisive
primary is never overturned, which is why `primary-prevailed` can only ever resolve to the primary's
own verdict — the branch is not an "if primary is keep then keep else canary" rule that a future
edit could flip, it is structurally the primary.

FNXC:SelfImproveGateVerdict 2026-09-30-12:40:
`computeLearningGateVerdictFingerprint` is a deterministic `sha256` over a CANONICAL, order-stable
field string of the experiment id, the baseline id, every primary signal, the corpus version, and
the seed. It is what lets "the same candidate against the same corpus with the same seed yields the
same verdict" be PROVEN from the persisted record rather than assumed. Every field is joined with a
`\u0000` (NUL) separator and a fixed `key=value` order, so no field's content can ever be mistaken
for a different field boundary (a plain space/pipe separator would let `corpusVersion:"a b"` collide
with a two-field split). The fingerprint covers the PRIMARY SIGNALS, not the canary or the resolved
verdict, because it identifies the INPUT EXPERIMENT; the canary and the resolution are outputs of
that experiment and are recorded separately.

FNXC:SelfImproveGateVerdict 2026-09-30-12:40:
The fingerprint REFUSES a blank experiment or baseline id. A verdict that cannot name which
experiment or baseline it judged is unattributable — it would answer "what did the gate say?" with
no "about what?", which is the same reason `buildLearningRevertEventId` refuses a blank applied id.
Throwing here (rather than defaulting) keeps a caller from silently recording an unattributable
verdict.

FNXC:SelfImproveGateVerdict 2026-09-30-12:40:
`buildLearningGateVerdictId` is the IDEMPOTENCY mechanism, stated once here. The verdict id is
DERIVED from the experiment id, the baseline id, and the input fingerprint — not generated fresh per
attempt. That single choice collapses a repeated (or concurrent) recording of the SAME judgment into
one row: the second insert collides on the (project_id, verdict_id) primary key and the accessor's
`onConflictDoNothing` returns no row. A uuid-per-attempt would append N indistinguishable verdicts
and the trail could no longer answer "was this exact judgment recorded, and how many times"
honestly. Deriving from the fingerprint (not just the experiment) means two DIFFERENT judgments
about the same experiment/baseline pair — e.g. after the corpus version or seed changed — are
recorded as two distinct, individually auditable verdicts rather than one silently overwriting the
other.
*/

/** True when `value` is one of the fixed verdicts. Guards callers building a verdict by hand. */
export function isLearningGateVerdict(value: unknown): value is LearningGateVerdict {
  return typeof value === "string" && (LEARNING_GATE_VERDICTS as readonly string[]).includes(value);
}

/**
 * The outcome of applying the primary-gate-over-canary precedence rule to one pair of inputs.
 * Carries the resolved verdict plus the outcome explaining which rule decided it.
 */
export interface LearningGateVerdictResolution {
  /** The verdict that stands: keep, roll back, or the honest abstention. */
  resolvedVerdict: LearningGateVerdict;
  /** The primary gate's own verdict, verbatim. */
  primaryVerdict: LearningGateVerdict;
  /** The canary's verdict, or `null` when no canary ran. */
  canaryVerdict: LearningGateVerdict | null;
  /** Which rule produced `resolvedVerdict`. */
  precedenceOutcome: LearningGatePrecedenceOutcome;
}

/**
 * Apply the precedence rule to the primary and canary verdicts, returning the resolved verdict and
 * the fixed outcome that explains which rule won.
 *
 * This is the ONE pure function every combination funnels through — see the FNXC block above for
 * the exhaustive truth table. It is total: it never throws for any pair of valid verdicts, and an
 * absent/null canary is a first-class case (not an error).
 */
export function resolveLearningGateVerdict(
  primaryVerdict: LearningGateVerdict,
  canaryVerdict?: LearningGateVerdict | null,
): LearningGateVerdictResolution {
  if (!isLearningGateVerdict(primaryVerdict)) {
    throw new Error(`Unknown learning gate verdict: ${String(primaryVerdict)}`);
  }
  if (canaryVerdict != null && !isLearningGateVerdict(canaryVerdict)) {
    throw new Error(`Unknown learning gate canary verdict: ${String(canaryVerdict)}`);
  }

  if (canaryVerdict == null) {
    return {
      resolvedVerdict: primaryVerdict,
      primaryVerdict,
      canaryVerdict: null,
      precedenceOutcome: "canary-absent",
    };
  }

  if (primaryVerdict === canaryVerdict) {
    return {
      resolvedVerdict: primaryVerdict,
      primaryVerdict,
      canaryVerdict,
      precedenceOutcome: "agreed",
    };
  }

  if (primaryVerdict === "inconclusive") {
    // The primary abstained, so the canary decides. If the canary is ALSO inconclusive the
    // resolved verdict stays inconclusive (an abstention is not upgraded into a decision).
    return {
      resolvedVerdict: canaryVerdict,
      primaryVerdict,
      canaryVerdict,
      precedenceOutcome: "primary-abstained",
    };
  }

  // Both decisive and disagreeing: the PRIMARY gate prevails. The canary never overturns it.
  return {
    resolvedVerdict: primaryVerdict,
    primaryVerdict,
    canaryVerdict,
    precedenceOutcome: "primary-prevailed",
  };
}

/**
 * The canonical, order-stable field string the verdict fingerprint is computed over.
 *
 * NUL (`\u0000`) separates fields so no field's content can be confused with a field boundary. Every
 * primary signal is included, along with the corpus version and seed that pin the replay corpus, so
 * two runs of the gate are provably identical (or provably different) from the fingerprint alone.
 * Booleans are normalized to "true"/"false" and the test-count delta to its integer form so the
 * string is stable regardless of how the values were constructed.
 */
function canonicalFingerprintFieldString(input: LearningGateVerdictInput): string {
  const experimentId = requireNonBlank(input.experimentId, "experimentId");
  const baselineId = requireNonBlank(input.baselineId, "baselineId");
  const signals = input.primarySignals;
  if (!signals) throw new Error("A learning gate verdict fingerprint requires the primary signals");
  const corpusVersion = requireNonBlank(signals.corpusVersion, "primarySignals.corpusVersion");

  const fields: string[] = [
    `experimentId=${experimentId}`,
    `baselineId=${baselineId}`,
    `buildOk=${String(signals.buildOk)}`,
    `lintOk=${String(signals.lintOk)}`,
    `typecheckOk=${String(signals.typecheckOk)}`,
    `gateOk=${String(signals.gateOk)}`,
    `affectedTestsOk=${String(signals.affectedTestsOk)}`,
    `testCountDelta=${Math.trunc(Number(signals.testCountDelta) || 0)}`,
    `costBudgetInvariantOk=${String(signals.costBudgetInvariantOk)}`,
    `corpusVersion=${corpusVersion}`,
    `seed=${Math.trunc(Number(signals.seed) || 0)}`,
  ];
  return fields.join("\u0000");
}

/** Trim a required identity field, refusing blank/absent values so a verdict is always attributable. */
function requireNonBlank(value: string, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`A learning gate verdict requires a non-blank ${field}`);
  return trimmed;
}

/**
 * Compute the deterministic input fingerprint of a learning gate verdict.
 *
 * Identical inputs (experiment, baseline, all primary signals, corpus version, seed) always yield a
 * byte-identical `sha256` hex string; any change to any covered field yields a different one. This
 * is what makes "the same candidate against the same corpus with the same seed produces the same
 * verdict" a provable property of the persisted record rather than a claim.
 *
 * Refuses a blank experiment id, baseline id, or corpus version.
 */
export function computeLearningGateVerdictFingerprint(input: LearningGateVerdictInput): string {
  return createHash("sha256").update(canonicalFingerprintFieldString(input)).digest("hex");
}

/**
 * Derive the deterministic verdict id for one judgment of one experiment against one baseline.
 *
 * Stable across retries by construction: the same experiment + baseline + input fingerprint always
 * yields the same verdict id, which is what makes the insert's `onConflictDoNothing` the idempotency
 * boundary. Because the fingerprint is part of the derivation, two DIFFERENT judgments about the
 * same experiment/baseline pair (e.g. after a corpus-version or seed change) are recorded as two
 * distinct verdicts, each individually auditable, rather than one overwriting the other.
 *
 * The `:gate` suffix is appended to values the caller controls, so a blank experiment or baseline id
 * is refused rather than silently producing an id that pairs with nothing.
 */
export function buildLearningGateVerdictId(
  experimentId: string,
  baselineId: string,
  inputFingerprint: string,
): string {
  const experiment = requireNonBlank(experimentId, "experimentId");
  const baseline = requireNonBlank(baselineId, "baselineId");
  const fingerprint = requireNonBlank(inputFingerprint, "inputFingerprint");
  return `${experiment}:${baseline}:${fingerprint}:gate`;
}
