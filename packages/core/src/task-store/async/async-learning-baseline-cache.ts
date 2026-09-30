import { and, eq } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import {
  buildBaselineCacheStatus,
  computeBaselineFingerprint,
  isBaselineFingerprint,
} from "../../self-improve/baseline-fingerprint.js";
import type {
  BaselineCacheStatus,
  BaselineFingerprintInput,
} from "../../types/self-improve/baseline-cache.js";

/*
FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
The baseline cache is a CACHE, so its write is an UPSERT rather than an append. `writeBaselineCache`
uses `onConflictDoUpdate` keyed on (project_id, baseline_key), which gives three distinct behaviors
from ONE statement: an identical re-store is a no-op update, a changed fingerprint REPLACES the entry
in place (forcing the rebuild the resolver asked for), and a first measurement inserts. An append-only
insert would either duplicate rows per key or throw on the second measurement, neither of which
expresses "the newest entry is the only valid one".

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
`created_at` is NOT in the DO UPDATE SET list, so it is preserved across replacements: it answers
"when was this baseline first measured" while `updated_at` answers "when was it last re-measured". A
forced rebuild must be distinguishable from the original measurement, and collapsing the two columns
would erase exactly that distinction.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
The fingerprint STORED is the one derived from the input components in the same call, not one the
caller supplies verbatim. If a caller could pass a fingerprint that disagreed with the components it
also passed, the row could claim an identity its own columns contradict, and the reuse decision made
later would be trusting a value the database could have caught. Deriving it here means the persisted
identity is always self-consistent with the persisted inputs.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
This is an `AsyncDataLayer` accessor, deliberately NOT a `TaskStore` method. The durable-write
inventory guard classifies every public `TaskStore` method, and a self-improvement measurement cache
has no business widening that surface: the store is the task lifecycle's collaborator, and a cache
lives beneath it. Keeping the accessor layer-scoped leaves that inventory untouched.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
Both readers are PROJECT-SCOPED — always filtered on project_id, never addressed by baseline key
alone. A baseline key belonging to another project is simply absent here, exactly as a foreign
proposal id is for the ledger readers, which is what makes "reuse the cached baseline" unable to cross
a project boundary.
*/

function requireProjectId(layer: AsyncDataLayer): string {
  if (!layer.projectId) throw new Error("A baseline cache entry requires AsyncDataLayer.projectId");
  return layer.projectId;
}

function requireBaselineKey(baselineKey: string): string {
  const trimmed = baselineKey?.trim();
  if (!trimmed) throw new Error("A baseline cache entry requires a non-blank baselineKey");
  return trimmed;
}

type BaselineCacheRow = typeof schema.project.learningBaselineCache.$inferSelect;

/** The cached baseline as read back, with its measurement identity and opaque payload. */
export type LearningBaselineCacheRecord = {
  baselineKey: string;
  manifestVersion: string;
  engineSha: string;
  configHash: string;
  seed: number;
  inputFingerprint: string;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
};

const mapCacheRow = (row: BaselineCacheRow): LearningBaselineCacheRecord => ({
  baselineKey: row.baselineKey,
  manifestVersion: row.manifestVersion,
  engineSha: row.engineSha,
  configHash: row.configHash,
  seed: row.seed,
  inputFingerprint: row.inputFingerprint,
  payload: row.payload,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Input for caching one measured baseline. */
export interface WriteBaselineCacheInput extends BaselineFingerprintInput {
  /** The baseline key this measurement is cached under. */
  baselineKey: string;
  /** The opaque measured payload. Stored as-is; this accessor never interprets it. */
  payload: unknown;
  /** ISO-8601 instant recorded as the measurement time. Defaults to now. */
  measuredAt?: string;
}

/** The result of a `writeBaselineCache` call. */
export interface WriteBaselineCacheResult {
  baselineKey: string;
  /** The fingerprint derived from the input components and stored with the row. */
  inputFingerprint: string;
  /** The committed row, carrying the preserved `createdAt` and the refreshed `updatedAt`. */
  record: LearningBaselineCacheRecord;
}

/**
 * Read the cached baseline for one baseline key, or `null` when nothing is cached.
 *
 * Project-scoped. The returned record's `inputFingerprint` is what the caller feeds to
 * `resolveBaselineCache`; this function only fetches, it does not decide whether the entry may be
 * reused.
 */
export async function readBaselineCache(
  layer: AsyncDataLayer,
  baselineKey: string,
): Promise<LearningBaselineCacheRecord | null> {
  const projectId = requireProjectId(layer);
  const key = requireBaselineKey(baselineKey);
  const rows = await layer.db
    .select()
    .from(schema.project.learningBaselineCache)
    .where(and(
      eq(schema.project.learningBaselineCache.projectId, projectId),
      eq(schema.project.learningBaselineCache.baselineKey, key),
    ))
    .limit(1);
  return rows[0] ? mapCacheRow(rows[0]) : null;
}

/**
 * Cache one measured baseline, replacing any existing entry for the key.
 *
 * Idempotent for an identical re-store (the upsert matches the existing key) and in-place for a
 * changed fingerprint. The stored `inputFingerprint` is DERIVED from the input components rather than
 * accepted from the caller, so the persisted identity can never contradict the persisted inputs.
 *
 * Run-audit emission is NOT done here — the caller emits through the bounded façade — so a hostile
 * audit sink can never sit on the measurement write path.
 */
export async function writeBaselineCache(
  layer: AsyncDataLayer,
  input: WriteBaselineCacheInput,
): Promise<WriteBaselineCacheResult> {
  const projectId = requireProjectId(layer);
  const baselineKey = requireBaselineKey(input.baselineKey);
  const inputFingerprint = computeBaselineFingerprint(input);
  const measuredAt = input.measuredAt ?? new Date().toISOString();

  const rows = await layer.db
    .insert(schema.project.learningBaselineCache)
    .values({
      projectId,
      baselineKey,
      manifestVersion: input.manifestVersion.trim(),
      engineSha: input.engineSha.trim(),
      configHash: input.configHash.trim(),
      seed: Math.trunc(Number(input.seed)),
      inputFingerprint,
      payload: input.payload as never,
      createdAt: measuredAt,
      updatedAt: measuredAt,
    })
    .onConflictDoUpdate({
      target: [schema.project.learningBaselineCache.projectId, schema.project.learningBaselineCache.baselineKey],
      set: {
        manifestVersion: input.manifestVersion.trim(),
        engineSha: input.engineSha.trim(),
        configHash: input.configHash.trim(),
        seed: Math.trunc(Number(input.seed)),
        inputFingerprint,
        payload: input.payload as never,
        // created_at is deliberately absent: it records the FIRST measurement and survives rebuilds.
        updatedAt: measuredAt,
      },
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error(`Failed to cache the baseline for key ${baselineKey}`);
  return { baselineKey, inputFingerprint, record: mapCacheRow(row) };
}

/**
 * The operator status read model: may the cached baseline be reused, and why?
 *
 * Reads the cache, computes the fingerprint the CURRENT inputs request, and projects both through
 * the one pure resolver — so status can never report a reuse rule different from the one the cache is
 * governed by. This is the object `fn_selfimprove_status` renders.
 *
 * A cached entry whose stored fingerprint is malformed is reported as ABSENT rather than thrown on:
 * the read model's job is to answer "can I reuse this?", and an unusable entry means "no", which is
 * `rebuild`/`no-cached-baseline`. Silently rebuilding over it is the correct operator outcome here —
 * unlike the pure resolver, which refuses a malformed fingerprint so a caller cannot mistake a drifted
 * row for a cache hit.
 */
export async function readBaselineCacheStatus(
  layer: AsyncDataLayer,
  input: { baselineKey: string; fingerprintInput: BaselineFingerprintInput },
): Promise<BaselineCacheStatus> {
  const requestedFingerprint = computeBaselineFingerprint(input.fingerprintInput);
  const cached = await readBaselineCache(layer, input.baselineKey);
  const cachedFingerprint = cached && isBaselineFingerprint(cached.inputFingerprint)
    ? cached.inputFingerprint
    : null;
  return buildBaselineCacheStatus({
    baselineKey: input.baselineKey,
    cachedFingerprint,
    requestedFingerprint,
  });
}
