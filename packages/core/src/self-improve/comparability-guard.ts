import { createHash } from "node:crypto";
import {
  COMPARABILITY_DIMENSIONS,
  type ComparabilityDimension,
  type ComparabilityIdentity,
  type ComparabilityVerdict,
} from "./comparability-types.js";

/*
FNXC:SelfImproveComparability 2026-09-30-19:55:
THE GUARD REFUSES BEFORE IT COMPARES ANYTHING MEANINGFUL. It walks the four fixed dimensions in
{@link COMPARABILITY_DIMENSIONS} order, collects EVERY dimension whose value differs, and — the moment
at least one differs — returns `not-comparable` carrying that ordered list. It does not compute a
delta, a score, or a comparison value on this path, because a delta between two differently-produced
replay passes is a number with no meaning and a meaningless number is worse than none. Collecting
EVERY diverged dimension (not stopping at the first) is deliberate: an operator handed only the first
mismatch would fix it and be immediately handed the second, re-running the whole measurement each
time; the list answers "what must match" in one read.

FNXC:SelfImproveComparability 2026-09-30-19:55:
A HALF-POPULATED IDENTITY IS REFUSED AS `not-a-run`, NOT TRUSTED. A placeholder identity (an empty or
missing dimension value, as when no manifest has been built yet) is not a measurement, and its own
reported values are not evidence that a pass happened. Trusting it would let an unmeasured "baseline"
compare equal to a real candidate and produce a confident, meaningless `comparable` verdict. This
mirrors the sibling `inconsistent-run` refusal in the cost-budget guard, which likewise refuses a run
whose identity is not backed by a coherent measurement. The check runs on BOTH sides before any
dimension comparison, so a placeholder never gets to be "the side that agreed".

FNXC:SelfImproveComparability 2026-09-30-19:55:
IDENTITIES ARE FINGERPRINTED FROM THEIR OWN CONTENT, NEVER FROM THE ENVIRONMENT. The digest is a
`sha256:` over the canonical serialization of the four dimension values in the fixed
{@link COMPARABILITY_DIMENSIONS} order — no clock, no store, no engine import, no environment read,
no dependency on the caller's property insertion order. This mirrors `fingerprintCostRun`. The result
is that the same identity always yields the same fingerprint on any host, which is exactly what makes
a baseline cached on one pass comparable to a candidate measured later (or elsewhere): the fingerprint
is a fact about the four values, not about when anyone looked.
*/

/** Input to one comparability evaluation. */
export interface ComparabilityInput {
  /** The identity the candidate is compared against (usually a cached baseline). */
  baseline: ComparabilityIdentity;
  /** The identity under evaluation. */
  candidate: ComparabilityIdentity;
}

/**
 * The canonical payload an identity fingerprint is computed over. One entry per fixed dimension, in
 * {@link COMPARABILITY_DIMENSIONS} order, so the digest depends only on the four values and never on
 * the caller's property insertion order.
 */
function fingerprintIdentity(identity: ComparabilityIdentity): string {
  const canonical = JSON.stringify(
    COMPARABILITY_DIMENSIONS.map((dimension) => [dimension, identity[dimension]]),
  );
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * Fill an identity's fingerprint from its own four dimension values when the caller did not supply a
 * correct one. Recorded identities normally arrive pre-fingerprinted; recomputing here keeps the
 * verdict self-consistent when a caller hands over a raw value object, and it never reads anything
 * outside the identity, so it is deterministic.
 */
function withFingerprint(identity: ComparabilityIdentity): ComparabilityIdentity {
  return { ...identity, fingerprint: fingerprintIdentity(identity) };
}

/**
 * True when any fixed dimension holds an empty value, which makes this a placeholder rather than a
 * measured pass. A real measurement always has a non-empty manifest, seed, engine, and config; the
 * guard refuses to compare a half-populated side rather than trusting its reported values.
 */
function isPlaceholder(identity: ComparabilityIdentity): boolean {
  return COMPARABILITY_DIMENSIONS.some((dimension) => {
    const value = identity[dimension];
    return typeof value !== "string" || value.trim() === "";
  });
}

/** Read one dimension's value, typed through the dimension so a new dimension cannot be forgotten here. */
function dimensionValue(identity: ComparabilityIdentity, dimension: ComparabilityDimension): string {
  return identity[dimension];
}

/**
 * Compare a candidate replay identity against a baseline and answer whether the two were produced
 * comparably.
 *
 * Pure: the same input pair always produces a deep-equal verdict — including the recomputed
 * fingerprints and both identities echoed back — so a caller can record exactly what was judged
 * without re-deriving it, and re-running the guard never changes the answer. A refusal computes no
 * metric; only a `comparable` verdict authorizes one downstream.
 */
export function evaluateComparability(input: ComparabilityInput): ComparabilityVerdict {
  const baseline = withFingerprint(input.baseline);
  const candidate = withFingerprint(input.candidate);

  // A refusal never computes a comparison value, so both refusals share one construction path that
  // echoes both identities so a verdict always names its own inputs.
  const refuse = (reason: ComparabilityVerdict["reason"], diverged: ComparabilityDimension[]): ComparabilityVerdict => ({
    verdict: "not-comparable",
    reason,
    diverged,
    baseline,
    candidate,
  });

  // Precedence 1 — neither side may be a placeholder. A half-populated identity is not a measurement,
  // so it is refused on both sides BEFORE any dimension is compared.
  if (isPlaceholder(baseline) || isPlaceholder(candidate)) return refuse("not-a-run", []);

  // Precedence 2 — walk the four fixed dimensions in order, collecting EVERY divergence.
  const diverged: ComparabilityDimension[] = [];
  for (const dimension of COMPARABILITY_DIMENSIONS) {
    if (dimensionValue(baseline, dimension) !== dimensionValue(candidate, dimension)) {
      diverged.push(dimension);
    }
  }
  if (diverged.length > 0) return refuse("divergent-identity", diverged);

  // Only now, with all four dimensions proven equal, may a metric be computed downstream.
  return {
    verdict: "comparable",
    baseline,
    candidate,
  };
}
