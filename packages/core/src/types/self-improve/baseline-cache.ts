/*
FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
A cached baseline is only reusable when it was measured under the SAME inputs the current run would
use. This file is the contract for that identity: `BaselineFingerprintInput` is the explicit set of
inputs the fingerprint covers, and `BaselineCacheDecision` is the closed reuse/rebuild answer derived
from comparing a cached fingerprint against a requested one.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
The decision vocabulary is a CLOSED enum, not a free `reason` string. "Reuse this baseline" and "rebuild
it" are the only two answers, and there are exactly three reasons — nothing cached, the same
measurement inputs, or different measurement inputs. An operator reading the status read model must be
able to COUNT these (how many comparisons were refused as incomparable), which is only meaningful if
the reason is one of a fixed set rather than prose. A caller can neither invent a fourth outcome nor
mistype one: both `action` and `reason` are validated by `resolveBaselineCache` and by the database
CHECKs on the persisted row.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
The `BaselineCacheStatus` shape is deliberately the WHOLE operator answer to "can I trust this
comparison?". It carries the fingerprint that was requested, the fingerprint the cache actually held,
the action, the reason, and whether a cached entry existed at all. `fn_selfimprove_status` (shipped in
FUSI-034) renders exactly this object; nothing here is a CLI concern, so the read model stays pure data.
*/

/**
 * The measurement inputs a cached baseline's identity is derived from.
 *
 * Every field participates in the fingerprint, so a change to ANY one of them must invalidate the
 * cache. `seed` accepts a numeric string because a manifest may carry it as text; it is normalized to
 * an integer before hashing so `"42"` and `42` are the same measurement and cannot silently produce
 * two different baselines for one seed.
 */
export interface BaselineFingerprintInput {
  /** Version of the replay-corpus manifest. `manifestVersion: "v2"` is a different corpus than `"v1"`. */
  manifestVersion: string;
  /** Git sha of the engine build that produced the measurement. */
  engineSha: string;
  /** Hash of the measurement configuration (ordering, corpus contents, provider). */
  configHash: string;
  /** Random seed pinning the measurement's non-determinism. Normalized to an integer. */
  seed: number | string;
}

/** The cache actions. Total: a resolution is always exactly one of these. */
export const BASELINE_CACHE_ACTIONS = ["reuse", "rebuild"] as const;

/** One of the two cache actions. */
export type BaselineCacheAction = (typeof BASELINE_CACHE_ACTIONS)[number];

/**
 * Why a resolution reached its action. A closed enum so "why was my comparison refused?" is countable.
 *
 * - `no-cached-baseline` — nothing was cached for this baseline key, so there is nothing to reuse.
 * - `fingerprint-matched` — the cached entry was measured under exactly these inputs; reuse it.
 * - `fingerprint-diverged` — the cached entry exists but was measured under DIFFERENT inputs; the
 *   comparison is refused and the baseline is rebuilt, because reusing it would silently compare a
 *   candidate against an incomparable measurement.
 */
export const BASELINE_CACHE_REASONS = [
  "no-cached-baseline",
  "fingerprint-matched",
  "fingerprint-diverged",
] as const;

/** One of the three fixed reasons a cache resolution was reached. */
export type BaselineCacheReason = (typeof BASELINE_CACHE_REASONS)[number];

/** The pure reuse/rebuild decision over a cached and a requested fingerprint. */
export interface BaselineCacheDecision {
  /** Reuse the cached baseline as-is, or rebuild it from the current inputs. */
  action: BaselineCacheAction;
  /** The fixed reason that produced `action`. */
  reason: BaselineCacheReason;
}

/**
 * The operator-facing read model: the complete answer to "may this comparison use the cached
 * baseline, and why?". This is the object `fn_selfimprove_status` renders.
 */
export interface BaselineCacheStatus extends BaselineCacheDecision {
  /** The baseline key this status is about. */
  baselineKey: string;
  /** The fingerprint the current inputs requested. */
  inputFingerprint: string;
  /** The fingerprint the cached entry actually carried, or `null` when nothing was cached. */
  cachedFingerprint: string | null;
  /** Whether a cached baseline existed for this key at all. */
  present: boolean;
}

/** True when `value` is one of the two cache actions. Guards a hand-built decision. */
export function isBaselineCacheAction(value: unknown): value is BaselineCacheAction {
  return typeof value === "string" && (BASELINE_CACHE_ACTIONS as readonly string[]).includes(value);
}

/** True when `value` is one of the three cache reasons. Guards a hand-built decision. */
export function isBaselineCacheReason(value: unknown): value is BaselineCacheReason {
  return typeof value === "string" && (BASELINE_CACHE_REASONS as readonly string[]).includes(value);
}
