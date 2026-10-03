import { createHash } from "node:crypto";
import { MOCK_PROVIDER_ID } from "../ai/mock-provider-constants.js";
import {
  REPLAY_CORPUS_MANIFEST_VERSIONS,
  isReplayCorpusOrder,
  type ReplayCorpusManifest,
  type ReplayCorpusManifestRejectionReason,
  type ReplayCorpusReproducibility,
} from "../types/self-improve/replay-corpus-manifest.js";

/*
FNXC:SelfImproveReplayCorpusManifest 2026-09-30-19:35:
This module is the LOAD PATH for a replay corpus: it turns an untrusted document into either a
validated manifest or a named refusal. It deliberately imports nothing but `node:crypto`, the shared
mock-provider literal, and its own type module — no clock, no store, no provider client, no engine.
That import list is the cheapest possible guard against the two mistakes that would destroy this
feature's value: sampling `Date.now()` (which would make two runs of one corpus disagree) and
reaching a provider (which would make a "reproducible" measurement depend on a real model's
availability and pricing).

FNXC:SelfImproveReplayCorpusManifest 2026-09-30-19:35:
A MALFORMED DOCUMENT IS REFUSED, NEVER THROWN. `loadReplayCorpusManifest` returns a result object
rather than raising, because the caller of a load is a gate deciding whether to MEASURE — and a
throw would force every caller to wrap the load in a try/catch just to learn which of eight named
defects it hit. A named reason is also what keeps a refusal reportable: the value that triggered it
may be a task id, and echoing an arbitrary caller-supplied string into an operator surface is how
log-injection and accidental-secret-leak bugs start. The `field` names WHICH field was at fault; it
never carries the value.

FNXC:SelfImproveReplayCorpusManifest 2026-09-30-19:35:
UNKNOWN FIELDS ARE REFUSED (`unknown-field`), not ignored. A permissive reader that silently drops
an unrecognized key will happily accept a document written for a FUTURE version — a v2 document
missing its v2-only meaning would load as a valid v1 corpus, and the corpus would then be measured
as something it is not. Refusing the unknown key is what makes the version field load-bearing rather
than decorative, and it turns "this document was written by a newer build" into a clear refusal
instead of a silent misreading.

FNXC:SelfImproveReplayCorpusManifest 2026-09-30-19:35:
THE LOADED MANIFEST COPIES, IT NEVER ALIASES. `taskIds` and the `reproducibility` block are rebuilt
as new objects, so a caller that mutates its own document afterwards cannot retroactively change a
corpus it has already loaded. A measurement whose inputs the caller can still mutate after the fact
is not a measurement.

FNXC:SelfImproveReplayCorpusManifest 2026-09-30-19:35:
THE FINGERPRINT COVERS EXACTLY THE FACTS THAT MAKE TWO RUNS COMPARABLE: version, corpusId, seed,
provider, order, and the RESOLVED ordered task ids. It hashes a canonical object in FIXED key order
rather than the manifest as written, so property insertion order and key spelling cannot move the
digest — mirroring `fingerprintCostRun`. It deliberately EXCLUDES any timestamp, duration, or wall
clock: none of those is a fact about the corpus, and including one would make an identical corpus
fingerprint differently on every load and defeat the point of a content address. Re-seeding the
manifest, re-ordering it, or changing a single task id changes the digest, which is exactly what lets
the comparability guard detect a mismatch instead of comparing two different corpora as one.

FNXC:SelfImproveReplayCorpusManifest 2026-09-30-19:35:
`resolveReplayCorpusOrder` is the SINGLE definition of canonical order, and the fingerprint hashes
its output rather than the raw `taskIds`. That coupling is what makes the two modes distinguishable
by construction: under `lexicographic` a shuffled document resolves to the same order and therefore
the same fingerprint (same corpus, differently written), while under `manifest` the shuffle changes
the resolved order and therefore the fingerprint (the order was part of the identity all along).
*/

/** Every top-level field a manifest document may carry. Anything else is refused as `unknown-field`. */
const MANIFEST_FIELDS: readonly string[] = [
  "version",
  "corpusId",
  "taskIds",
  "seed",
  "provider",
  "order",
  "reproducibility",
];

/** Every field of the `reproducibility` block. Anything else is refused as `unknown-field`. */
const REPRODUCIBILITY_FIELDS: readonly string[] = [
  "deterministicSeed",
  "stableOrder",
  "mockProviderOnly",
];

/**
 * The result of loading a document.
 *
 * Exactly one of two shapes, discriminated by `ok`. A refusal carries the named reason and the
 * field at fault — never the offending value, so a document can be reported on without echoing
 * caller-supplied text into an operator surface.
 */
export type ReplayCorpusManifestLoadResult =
  | { ok: true; manifest: ReplayCorpusManifest }
  | { ok: false; reason: ReplayCorpusManifestRejectionReason; field?: string };

/** Build a refusal. One factory so every refusal path produces the same shape. */
function refuse(
  reason: ReplayCorpusManifestRejectionReason,
  field?: string,
): ReplayCorpusManifestLoadResult {
  return field === undefined ? { ok: false, reason } : { ok: false, reason, field };
}

/** True when `value` is a plain object (not null, not an array) that can carry manifest fields. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the `reproducibility` block, or return the refusal that describes its defect.
 *
 * The three flags are REQUIRED rather than defaulted: a document that omits `mockProviderOnly` is
 * not a corpus that happens to use the mock provider, it is a document that never made the promise,
 * and defaulting it would manufacture the guarantee the whole reproducibility claim rests on.
 */
function loadReproducibility(
  raw: unknown,
): { ok: true; value: ReplayCorpusReproducibility } | { ok: false; result: ReplayCorpusManifestLoadResult } {
  if (!isPlainObject(raw)) return { ok: false, result: refuse("missing-field", "reproducibility") };

  for (const key of Object.keys(raw)) {
    if (!REPRODUCIBILITY_FIELDS.includes(key)) {
      return { ok: false, result: refuse("unknown-field", `reproducibility.${key}`) };
    }
  }
  for (const key of REPRODUCIBILITY_FIELDS) {
    if (typeof raw[key] !== "boolean") {
      return { ok: false, result: refuse("missing-field", `reproducibility.${key}`) };
    }
  }

  return {
    ok: true,
    value: {
      deterministicSeed: raw.deterministicSeed as boolean,
      stableOrder: raw.stableOrder as boolean,
      mockProviderOnly: raw.mockProviderOnly as boolean,
    },
  };
}

/**
 * Load and validate a replay-corpus manifest document.
 *
 * Pure and total: it never throws and never returns a partially-built manifest. Checks run in a
 * fixed order — shape, unknown fields, version, then the required scalars, then the corpus contents
 * — so a document with several defects always reports the same reason for the same document, which
 * is what makes a refusal reproducible in its own right.
 *
 * The returned `manifest` is a NEW object with COPIED `taskIds` and `reproducibility`: the caller's
 * document is read but never aliased into the result.
 */
export function loadReplayCorpusManifest(raw: unknown): ReplayCorpusManifestLoadResult {
  if (!isPlainObject(raw)) return refuse("missing-field");

  // Unknown top-level keys are refused BEFORE the version is read, so a document written for a
  // newer schema is caught by the field check rather than by a version comparison that a future
  // build might widen.
  for (const key of Object.keys(raw)) {
    if (!MANIFEST_FIELDS.includes(key)) return refuse("unknown-field", key);
  }

  const version = raw.version;
  if (typeof version !== "number" || !REPLAY_CORPUS_MANIFEST_VERSIONS.includes(version)) {
    return refuse("unsupported-version", "version");
  }

  if (typeof raw.corpusId !== "string" || raw.corpusId.length === 0) {
    return refuse("missing-field", "corpusId");
  }
  if (typeof raw.seed !== "string") return refuse("missing-field", "seed");

  // The provider check precedes the order check so a document that would reach a real model reports
  // that defect first; both are refusals, so the ordering only fixes the NAME a multi-defect
  // document receives, deterministically.
  if (raw.provider !== MOCK_PROVIDER_ID) return refuse("provider-not-mock", "provider");
  if (!isReplayCorpusOrder(raw.order)) return refuse("unsupported-order", "order");

  if (!Array.isArray(raw.taskIds)) return refuse("missing-field", "taskIds");
  if (raw.taskIds.length === 0) return refuse("empty-corpus", "taskIds");

  const seen = new Set<string>();
  for (const taskId of raw.taskIds) {
    if (typeof taskId !== "string" || taskId.length === 0) return refuse("empty-task-id", "taskIds");
    if (seen.has(taskId)) return refuse("duplicate-task-id", "taskIds");
    seen.add(taskId);
  }

  const reproducibility = loadReproducibility(raw.reproducibility);
  if (!reproducibility.ok) return reproducibility.result;

  return {
    ok: true,
    manifest: {
      version: version as ReplayCorpusManifest["version"],
      corpusId: raw.corpusId,
      // Copied: the loaded manifest must not alias the caller's array.
      taskIds: [...(raw.taskIds as string[])],
      seed: raw.seed,
      provider: MOCK_PROVIDER_ID,
      order: raw.order,
      reproducibility: reproducibility.value,
    },
  };
}

/**
 * Resolve a manifest's canonical execution order.
 *
 * Returns a FRESH array and never mutates the manifest. Under `lexicographic` the result depends
 * only on the SET of ids, so a document whose ids were shuffled still resolves to the same corpus;
 * under `manifest` the declared order is the canonical one, so a shuffle is a different corpus.
 */
export function resolveReplayCorpusOrder(manifest: ReplayCorpusManifest): string[] {
  const declared = [...manifest.taskIds];
  if (manifest.order === "lexicographic") {
    // Total order: a task id can never tie with another, so no stable-sort tiebreak is needed.
    return declared.sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
  }
  return declared;
}

/** `sha256:<hex>` over the canonical manifest facts. Fixed key order; no clock, no timestamps. */
export function fingerprintReplayCorpusManifest(manifest: ReplayCorpusManifest): string {
  const canonical = JSON.stringify({
    version: manifest.version,
    corpusId: manifest.corpusId,
    seed: manifest.seed,
    provider: manifest.provider,
    order: manifest.order,
    orderedTaskIds: resolveReplayCorpusOrder(manifest),
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
