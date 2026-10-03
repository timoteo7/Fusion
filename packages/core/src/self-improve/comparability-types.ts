/*
FNXC:SelfImproveComparability 2026-09-30-19:55:
These are the ONLY types that decide what "these two replay runs can be compared" MEANS. A replay
experiment keeps a cached baseline from a prior pass and measures a fresh candidate now; the entire
value of the delta between them rests on both sides having been produced the same way. This contract
is stated once, here, so the pure guard (`comparability-guard.js`), the telemetry façade
(`self-improve-run-audit.js`), and the later corpus-metric/replay-runner work cannot each invent their
own notion of "comparable" and drift — the same single-declaration discipline the cost-budget
(`cost-budget-types.js`) and revert-reason vocabularies already follow.

FNXC:SelfImproveComparability 2026-09-30-19:55:
A COMPARISON IS REFUSED BEFORE ANY METRIC IS COMPUTED. There is deliberately no "how far apart" field
here and no partial-delta escape hatch: if the manifest, seed, engine, or config differ, the correct
answer is to produce NO number at all. A delta between two differently-measured runs is a number with
no meaning, and a meaningless number that renders as a plausible delta is strictly more dangerous than
no number — it survives a human glance and enters a keep-or-revert decision. The guard therefore
computes a metric on the comparable path only; the refusal path exists precisely to make that the
default when the inputs are not provably the same.

FNXC:SelfImproveComparability 2026-09-30-19:55:
THE FOUR DIMENSIONS ARE A CLOSED SET IN A FIXED ORDER. A replay result can be invalid because the
corpus manifest was edited, the seed was re-rolled, the engine build changed, or the resolved config
changed — and those are the only four ways, because they are the only four inputs that determine what
a replay pass measures. The set is closed (an unknown dimension name is not a new dimension, it is a
caller error) so a crafted or misspelled name cannot widen what the guard compares or what the audit
row records. The ORDER is fixed (manifest, seed, engine, config) for two reasons: it is the order in
which a reader most naturally diagnoses a mismatch (what was measured, then how it was sampled, then
by what, then under what settings), and it makes the `diverged` list a deterministic, reproducible
report rather than an order that depends on object-key iteration.

FNXC:SelfImproveComparability 2026-09-30-19:55:
Every refusal reason is a FIXED ENUM, never prose. "These two runs cannot be compared" is only
actionable if it says WHICH dimension diverged, and that fact is exactly the ordered `diverged` list of
dimension names. A sentence would be a second, always-growing vocabulary that no one can count;
`diverged` is a small closed list of dimension names that groups by cause at a glance. The one
non-dimension refusal, `not-a-run`, exists because a half-populated identity is not a measurement at
all and must not be trusted on its own reported values — the mirror of the sibling
`inconsistent-run` refusal in the cost-budget guard.

FNXC:SelfImproveComparability 2026-09-30-19:55:
An identity's `fingerprint` is a `sha256:` digest of the canonical serialization of its four dimension
values — NOT of the caller's object, whose property insertion order is not a fact worth hashing, and
NOT of anything read at comparison time. Two identities whose fingerprints agree were produced the
same way; that agreement is the whole premise the guard is allowed to build a comparison on. This
module stays free of I/O, store imports, engine imports, and clock reads: the fingerprint is computed
by the guard from the identity's own values, so the same identity always yields the same fingerprint
on any host, which is what makes a cached baseline comparable to a candidate measured later or
elsewhere.
*/

/**
 * The four fixed dimensions a replay comparison requires to match, in fixed evaluation/report order.
 *
 * A `manifest` is the versioned corpus definition (which tasks, in which order, at which weights); a
 * `seed` is the sampling seed the pass ran under; an `engine` is the engine build that executed it;
 * a `config` is the resolved configuration the pass ran with. These are the only inputs that
 * determine WHAT a replay pass measures, so they are the only things that must match for a delta to
 * mean anything.
 */
export type ComparabilityDimension = "manifest" | "seed" | "engine" | "config";

/**
 * Every comparability dimension, in fixed order: manifest, seed, engine, config.
 *
 * The guard compares dimensions in exactly this sequence and reports `diverged` as a subsequence of
 * it, so the order is part of the contract rather than an implementation detail.
 */
export const COMPARABILITY_DIMENSIONS: readonly ComparabilityDimension[] = [
  "manifest",
  "seed",
  "engine",
  "config",
];

/** True when `value` is one of the four comparability dimensions. Guards callers naming a dimension from outside. */
export function isComparabilityDimension(value: unknown): value is ComparabilityDimension {
  return typeof value === "string" && (COMPARABILITY_DIMENSIONS as readonly string[]).includes(value);
}

/**
 * The identity of one replay pass: exactly one fixed value per dimension, plus a content fingerprint.
 *
 * This is a self-contained RECORD, not a reader: the later replay-corpus work populates it from the
 * manifest it builds, but nothing here reads a manifest, a store, or a clock. Each dimension holds a
 * value whose EQUALITY is the whole point — the manifest's own fingerprint, the seed string, the
 * engine build id, and a digest of the resolved config. Two identities are comparable only when all
 * four agree.
 */
export interface ComparabilityIdentity {
  /** Fingerprint of the versioned corpus manifest the pass measured. */
  manifest: string;
  /** Seed the pass sampled under. */
  seed: string;
  /** Engine build that executed the pass. */
  engine: string;
  /** Digest of the resolved configuration the pass ran with. */
  config: string;
  /**
   * `sha256:<hex>` digest of the canonical serialization of the four dimension values above.
   *
   * Derived from this identity's own content, never read from the environment, so the same four values
   * always produce the same fingerprint regardless of when or where the identity was built.
   */
  fingerprint: string;
}

/**
 * Why a comparison was refused, as a CLOSED enum.
 *
 * `divergent-identity` means the two identities were compared and at least one fixed dimension
 * differed; the ordered `diverged` list on the verdict names exactly which. `not-a-run` means one side
 * is a half-populated placeholder rather than a real measurement, so there is nothing to compare and
 * its own reported values are not trustworthy. There is no third reason and no prose variant: every
 * refusal is one of these, so a refusal is countable by class.
 */
export type ComparabilityRefusalReason = "divergent-identity" | "not-a-run";

/** Every legal refusal reason, in reporting order. Mirrors {@link ComparabilityRefusalReason} so callers can count classes. */
export const COMPARABILITY_REFUSAL_REASONS: readonly ComparabilityRefusalReason[] = [
  "divergent-identity",
  "not-a-run",
];

/** True when `value` is a legal comparability refusal reason. Guards callers naming a reason by hand. */
export function isComparabilityRefusalReason(value: unknown): value is ComparabilityRefusalReason {
  return typeof value === "string" && (COMPARABILITY_REFUSAL_REASONS as readonly string[]).includes(value);
}

/**
 * The deterministic answer to "can these two replay passes be compared?".
 *
 * Exactly one of three shapes, discriminated by `verdict`:
 * - `not-comparable` — the comparison was refused. `diverged` names every fixed dimension that
 *   differed, in {@link COMPARABILITY_DIMENSIONS} order, and is empty only for a `not-a-run` refusal.
 * - `comparable` — all four dimensions matched; a metric may be computed downstream. `diverged` is
 *   then necessarily empty.
 *
 * The refusal is decided BEFORE any metric: no delta, score, or comparison value is produced on the
 * refusal path, so the caller cannot accidentally render a meaningless number.
 */
export interface ComparabilityVerdict {
  /** The deterministic answer. */
  verdict: ComparabilityVerdictValue;
  /** Why the comparison was refused, when `verdict` is `not-comparable`. Absent otherwise. */
  reason?: ComparabilityRefusalReason;
  /**
   * Every fixed dimension that differed between the two identities, in
   * {@link COMPARABILITY_DIMENSIONS} order. Present (possibly empty) only when `verdict` is
   * `not-comparable`; empty for a `not-a-run` refusal and for every `comparable` verdict. This ordered
   * enum list IS the named cause — no separate reason sentence accompanies it.
   */
  diverged?: ComparabilityDimension[];
  /** Baseline identity the comparison was made against. Always present, so a verdict names its own inputs. */
  baseline: ComparabilityIdentity;
  /** Candidate identity under evaluation. Always present, even on refusal. */
  candidate: ComparabilityIdentity;
}

/** The two deterministic verdicts. `not-comparable` is a refusal, not a third "pass" state. */
export type ComparabilityVerdictValue = "comparable" | "not-comparable";

/** Every legal verdict value, in reporting order. */
export const COMPARABILITY_VERDICT_VALUES: readonly ComparabilityVerdictValue[] = [
  "comparable",
  "not-comparable",
];

/** True when `value` is a legal comparability verdict. Guards callers naming a verdict by hand. */
export function isComparabilityVerdictValue(value: unknown): value is ComparabilityVerdictValue {
  return typeof value === "string" && (COMPARABILITY_VERDICT_VALUES as readonly string[]).includes(value);
}
