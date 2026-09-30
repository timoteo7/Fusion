import { createHash } from "node:crypto";
import {
  BASELINE_CACHE_REASONS,
  isBaselineCacheAction,
  isBaselineCacheReason,
  type BaselineCacheDecision,
  type BaselineCacheStatus,
  type BaselineFingerprintInput,
} from "../types/self-improve/baseline-cache.js";

/*
FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
`computeBaselineFingerprint` and `resolveBaselineCache` are the ONLY two places that decide what a
cached baseline's identity IS and whether it may be reused. Both are pure and database-free — this
module imports only `node:crypto` and its own types — so the accessor, the status read model, and the
run-audit façade all read one definition instead of each re-deriving "may I reuse this?" and drifting.
A cache that reuses on a different rule than the one status reports is precisely the silent
incomparability this feature exists to prevent.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
The fingerprint is a deterministic `sha256` over a CANONICAL, order-stable field string of the four
measurement inputs: manifest version, engine sha, config hash, and seed. That is what turns "the
cached baseline was measured under the same corpus, build, config, and seed" from an assumption into
a PROVABLE property of the persisted record. Fields are joined with a NUL (`\u0000`) separator in a
fixed `key=value` order, so no field's content can ever be mistaken for a different field boundary — a
plain space or pipe separator would let `configHash:"a b"` collide with a two-field split. The digest
carries the `sha256:` prefix already used by `cost-budget-measure.ts` and `test-count-delta.ts`, which
keeps a fingerprint distinguishable from any other hash-shaped value in the audit trail.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
The fingerprint REFUSES a blank manifest version, engine sha, or config hash. A baseline that cannot
name which corpus, build, and configuration produced it is unattributable, and reusing such an entry
is exactly the incomparable comparison this feature forbids. Throwing — rather than substituting a
default — keeps a caller from caching a measurement under a placeholder identity that later matches
another placeholder.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
The seed is NORMALIZED to an integer before hashing, because a manifest may carry it as the text
`"42"` while a runtime passes the number `42`. Hashing the raw string would mint two different
fingerprints for one seed and therefore rebuild the baseline on every alternate call path — a cache
that never hits. Unlike `learning-gate-verdict-types.ts`, which falls back to `0` for an unparseable
seed, a NON-NUMERIC seed is REFUSED here: silently hashing `NaN` as `0` would attribute a measurement
to a seed it was not run with, which is the same unattributability the blank-field refusal prevents.
Zero is a legitimate seed and is preserved, not treated as absent.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
`resolveBaselineCache` is TOTAL over its three inputs and never throws for a well-formed request: no
cached fingerprint rebuilds under `no-cached-baseline`, an equal fingerprint reuses under
`fingerprint-matched`, and any other value rebuilds under `fingerprint-diverged`. The signature takes
`cachedFingerprint: string | null` rather than a whole cache entry so the decision is a pure function
of two strings — the accessor decides how to FETCH, this module decides what the answer MEANS. The
`requestedFingerprint` is refused if it is not one of the two accepted digest shapes, so a caller
cannot pass an arbitrary string and have it treated as a real measurement identity.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
`buildBaselineCacheStatus` is the pure PROJECTION of the same decision into the operator read model.
It lives beside the resolver rather than in the accessor so "what status reports" is provable without
a database, while `readBaselineCacheStatus` in the accessor composes it with the real read. `present`
is derived from the cached fingerprint rather than accepted as a separate boolean, so the read model
can never claim a baseline exists while also reporting `no-cached-baseline` — the two are the same
fact stated twice, and deriving one from the other removes the possibility of disagreement.
*/

/** Matches `sha256:<64 hex>` — the same digest shape `cost-budget-measure.ts` produces. */
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** True when `value` is a well-formed `sha256:<hex>` fingerprint. */
export function isBaselineFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

/** Trim a required identity field, refusing blank values so a fingerprint is always attributable. */
function requireNonBlank(value: string, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`A baseline fingerprint requires a non-blank ${field}`);
  return trimmed;
}

/**
 * Normalize a seed to an integer, refusing a non-numeric seed.
 *
 * `Math.trunc` makes `42.7` and `42` the same seed (the fractional part cannot affect a seeded
 * measurement), and the string form is coerced so a manifest's `"42"` matches a runtime's `42`. A
 * `NaN`/`Infinity` result is refused rather than hashed as `0`, because that would attribute the
 * measurement to a seed it was not run with.
 */
function normalizeSeed(seed: number | string): number {
  const parsed = Math.trunc(Number(seed));
  if (!Number.isFinite(parsed)) {
    throw new Error("A baseline fingerprint requires a numeric seed");
  }
  return parsed;
}

/**
 * The canonical, order-stable field string the baseline fingerprint is computed over.
 *
 * The four measurement inputs appear in a FIXED order joined by NUL. Order stability is required for
 * the digest to be reproducible across runs and processes; NUL separation is required for it to be
 * injective, so no field's content can be reinterpreted as a field boundary.
 */
function canonicalBaselineFieldString(input: BaselineFingerprintInput): string {
  const manifestVersion = requireNonBlank(input.manifestVersion, "manifestVersion");
  const engineSha = requireNonBlank(input.engineSha, "engineSha");
  const configHash = requireNonBlank(input.configHash, "configHash");

  const fields: string[] = [
    `manifestVersion=${manifestVersion}`,
    `engineSha=${engineSha}`,
    `configHash=${configHash}`,
    `seed=${normalizeSeed(input.seed)}`,
  ];
  return fields.join("\u0000");
}

/**
 * Compute the deterministic fingerprint of one set of baseline measurement inputs.
 *
 * Identical inputs always yield a byte-identical `sha256:<hex>` string, and any change to any of the
 * four components yields a different one. That is what makes "the cached baseline and the candidate
 * were measured under the same corpus, engine, config, and seed" a checkable property rather than a
 * claim.
 *
 * Refuses a blank manifest version, engine sha, or config hash, and a non-numeric seed.
 */
export function computeBaselineFingerprint(input: BaselineFingerprintInput): string {
  return `sha256:${createHash("sha256").update(canonicalBaselineFieldString(input), "utf8").digest("hex")}`;
}

/**
 * Decide whether a cached baseline may be reused for the requested inputs.
 *
 * Pure and total over its three cases: nothing cached rebuilds, an identical fingerprint reuses, and
 * a different one rebuilds. Returns the fixed `reason` alongside the action so the decision is
 * countable by an operator rather than only inferable from the action itself.
 *
 * Refuses a requested fingerprint that is not a well-formed `sha256:<hex>` digest, and a cached
 * fingerprint that is present but malformed — a drifted row is an error, not a cache miss, because
 * silently rebuilding over it would hide the drift.
 */
export function resolveBaselineCache(input: {
  /** The fingerprint the cached entry carries, or `null` when no entry is cached. */
  cachedFingerprint: string | null;
  /** The fingerprint the current inputs requested. */
  requestedFingerprint: string;
}): BaselineCacheDecision {
  const requested = requireNonBlank(input.requestedFingerprint, "requestedFingerprint");
  if (!isBaselineFingerprint(requested)) {
    throw new Error(`A baseline cache resolution requires a sha256:<hex> requestedFingerprint, got: ${requested}`);
  }

  if (input.cachedFingerprint == null) {
    return { action: "rebuild", reason: "no-cached-baseline" };
  }
  if (!isBaselineFingerprint(input.cachedFingerprint)) {
    throw new Error(
      `A cached baseline fingerprint is malformed, refusing to treat it as a cache miss: ${input.cachedFingerprint}`,
    );
  }

  return input.cachedFingerprint === requested
    ? { action: "reuse", reason: "fingerprint-matched" }
    : { action: "rebuild", reason: "fingerprint-diverged" };
}

/**
 * Project a resolution into the operator read model `fn_selfimprove_status` renders (shipped in FUSI-034).
 *
 * Pure, so the read model's shape is provable without a database; the accessor composes it with the
 * real read. `present` is DERIVED from the cached fingerprint, so a status can never claim a baseline
 * exists while simultaneously reporting `no-cached-baseline`.
 */
export function buildBaselineCacheStatus(input: {
  /** The baseline key the status is about. */
  baselineKey: string;
  /** The fingerprint the cached entry carries, or `null` when nothing is cached. */
  cachedFingerprint: string | null;
  /** The fingerprint the current inputs requested. */
  requestedFingerprint: string;
}): BaselineCacheStatus {
  const baselineKey = requireNonBlank(input.baselineKey, "baselineKey");
  const decision = resolveBaselineCache({
    cachedFingerprint: input.cachedFingerprint,
    requestedFingerprint: input.requestedFingerprint,
  });
  // Asserted, not merely assumed: this module is the sole producer of these values, so a future edit
  // that returns something outside the closed vocabulary fails here rather than reaching an operator.
  if (!isBaselineCacheAction(decision.action) || !isBaselineCacheReason(decision.reason)) {
    throw new Error("The baseline cache resolver produced an unknown action/reason pair");
  }
  return {
    baselineKey,
    inputFingerprint: requireNonBlank(input.requestedFingerprint, "requestedFingerprint"),
    cachedFingerprint: input.cachedFingerprint,
    present: input.cachedFingerprint != null,
    action: decision.action,
    reason: decision.reason,
  };
}

export { BASELINE_CACHE_REASONS };
