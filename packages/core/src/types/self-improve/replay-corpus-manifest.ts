/*
FNXC:SelfImproveReplayCorpusManifest 2026-09-30-19:35:
FUSI-030 declares the corpus CONTRACT: the versioned document that states which task ids a replay
corpus covers, in which order, under which seed, with which provider. The primary gate and the
cost-budget comparability guard (FUSI-018) already consume `corpusId`, `seed`, and a canonical
ordering and already refuse to compare two runs that disagree on any of them — but until now those
facts lived only as arguments the caller happened to pass. Nothing on disk declared them, so "the
same corpus" was an unverifiable claim: two runs could differ in task set, order, or seed and still
be presented as a comparison. This module is the single declaration of those facts so the later
baseline cache (FUSI-031) and comparability guard (FUSI-032) can key on a recorded identity instead
of on a caller's memory.

FNXC:SelfImproveReplayCorpusManifest 2026-09-30-19:35:
THE PROVIDER IS A SINGLE LITERAL, NOT A UNION WITH A RESTRICTION. `provider` is typed as
`typeof MOCK_PROVIDER_ID` — exactly one member — so there is no union arm through which a real
provider id can be written at all. This is deliberately stronger than `provider: ProviderId` plus a
runtime check: a union type plus a validator is a convention that a future edit can quietly relax,
whereas a single-member literal makes a non-mock provider UNREPRESENTABLE, and the compiler rejects
the next person who tries. The mock provider is not a default or a fallback here; it is the only
provider a replay corpus is allowed to run under, because a corpus run must be reproducible and a
real model call would make both the cost measurement and the gate verdict irreproducible.

FNXC:SelfImproveReplayCorpusManifest 2026-09-30-19:35:
VERSION IS DATA, NOT A BOOLEAN FLAG. `version` is a `number` compared against the accepted
`REPLAY_CORPUS_MANIFEST_VERSIONS` array, not a `legacy?: boolean`. A boolean admits exactly two
histories; a version admits N and says which one a document was written against. A corpus document
that outlives the code that reads it must be able to say "I am version 1" and be REJECTED by a v2
loader rather than silently half-interpreted — the load-time refusal is the whole point. The
current version is also a named constant so a producer never hand-writes the number.

This module declares types and closed vocabularies only. It performs no I/O, reads no clock, and
imports nothing but the shared mock-provider literal, so a document's meaning cannot drift between
the layer that declares it and the layer that validates it.
*/

import { MOCK_PROVIDER_ID } from "../../ai/mock-provider-constants.js";

/**
 * The manifest schema version this build writes and the one it understands.
 *
 * Kept as a literal `const` (not a plain `number`) so `ReplayCorpusManifestVersion` is the exact
 * set of accepted values at the type level; a document whose version is not in the accepted array
 * cannot typecheck as a manifest before the runtime validator ever sees it.
 */
export const REPLAY_CORPUS_MANIFEST_VERSION = 1 as const;

/** Every manifest schema version this build accepts. A document at any other version is refused. */
export const REPLAY_CORPUS_MANIFEST_VERSIONS: readonly number[] = [REPLAY_CORPUS_MANIFEST_VERSION];

/** One of the accepted manifest schema versions. */
export type ReplayCorpusManifestVersion = typeof REPLAY_CORPUS_MANIFEST_VERSION;

/**
 * How the declared `taskIds` are turned into the canonical order a corpus run executes in.
 *
 * - `lexicographic` — sort by task id. The order is a function of the SET, so a document whose ids
 *   were assembled in a different sequence still measures the same corpus. This is what makes two
 *   runs comparable when they were built by different code paths.
 * - `manifest` — keep the declared order. The order is part of the corpus's identity, so a
 *   reordered document is a DIFFERENT corpus, and its fingerprint changes with it.
 *
 * The choice is recorded rather than assumed because both are legitimate: a corpus whose order is
 * meaningful (a replay of a specific sequence) needs `manifest`, while one that merely wants a
 * stable set of tasks needs `lexicographic` to survive reshuffling.
 */
export const REPLAY_CORPUS_ORDERS = ["lexicographic", "manifest"] as const;

/** One of the two canonical-ordering modes. */
export type ReplayCorpusOrder = (typeof REPLAY_CORPUS_ORDERS)[number];

/** True when `value` is a legal ordering mode. Guards callers naming a mode from outside. */
export function isReplayCorpusOrder(value: unknown): value is ReplayCorpusOrder {
  return typeof value === "string" && (REPLAY_CORPUS_ORDERS as readonly string[]).includes(value);
}

/**
 * Why a manifest document was refused at load.
 *
 * A CLOSED enum, not prose, and deliberately distinct from "the corpus is bad": every one of these
 * is a REFUSAL TO MEASURE, reported before any task runs, so a malformed corpus can never produce a
 * half-completed run whose numbers look comparable to a good one. Each reason names the class of
 * defect rather than the value that triggered it — the offending value may be a task id, and task
 * ids are not operator-facing error text.
 */
export type ReplayCorpusManifestRejectionReason =
  /** `version` is absent or outside {@link REPLAY_CORPUS_MANIFEST_VERSIONS}. */
  | "unsupported-version"
  /** A required top-level field is absent or of the wrong type. */
  | "missing-field"
  /** `taskIds` is empty: a corpus with no tasks has nothing to replay or measure. */
  | "empty-corpus"
  /** The same task id appears twice, so a re-run could measure one task under two identities. */
  | "duplicate-task-id"
  /** A task id is an empty or non-string value, which could not address a task. */
  | "empty-task-id"
  /** `provider` is not the mock provider. A corpus run must never reach a real model. */
  | "provider-not-mock"
  /** `order` is not one of {@link REPLAY_CORPUS_ORDERS}. */
  | "unsupported-order"
  /** The document carries a top-level field this version does not define. */
  | "unknown-field";

/** Every legal rejection reason, in the order the validator checks them. Mirrors the union. */
export const REPLAY_CORPUS_MANIFEST_REJECTION_REASONS: readonly ReplayCorpusManifestRejectionReason[] = [
  "unsupported-version",
  "missing-field",
  "empty-corpus",
  "duplicate-task-id",
  "empty-task-id",
  "provider-not-mock",
  "unsupported-order",
  "unknown-field",
];

/** True when `value` is a legal load rejection reason. Guards callers naming a reason by hand. */
export function isReplayCorpusManifestRejectionReason(
  value: unknown,
): value is ReplayCorpusManifestRejectionReason {
  return (
    typeof value === "string" &&
    (REPLAY_CORPUS_MANIFEST_REJECTION_REASONS as readonly string[]).includes(value)
  );
}

/**
 * The reproducibility rules a corpus run commits to.
 *
 * This block is part of the manifest rather than an implicit property of the code, because the
 * three flags below are the operator-facing answer to "may these two runs be compared?". They are
 * declarations the corpus makes about ITSELF, and they are recorded so a later reader can see what
 * was promised without inferring intent from the numbers.
 *
 * - `deterministicSeed` — the same seed yields the same per-task inputs, so a run is repeatable.
 * - `stableOrder` — the resolved task order is fixed by the manifest and does not vary between runs.
 * - `mockProviderOnly` — no real model is reachable, so token counts are a property of the corpus
 *   and not of a provider's pricing or availability.
 */
export interface ReplayCorpusReproducibility {
  /** The seed fully determines each task's input, so re-running the corpus reproduces it. */
  deterministicSeed: boolean;
  /** The canonical task order is fixed by this manifest and is identical on every run. */
  stableOrder: boolean;
  /** Only the mock provider is reachable from this corpus, so no real model call is possible. */
  mockProviderOnly: boolean;
}

/**
 * The versioned declaration of one replay corpus.
 *
 * Pure data. It is what a corpus IS, not how to run one: nothing here executes a task, opens a
 * store, or reaches a provider. The `seed`, `order`, and `provider` fields are exactly the facts
 * the cost-budget comparability guard already refuses on (`seed-mismatch`, `ordering-mismatch`),
 * stated once in a document so those refusals can be decided from a recorded identity rather than
 * from whatever a caller passed.
 */
export interface ReplayCorpusManifest {
  /** Schema version this document was written against; must be in {@link REPLAY_CORPUS_MANIFEST_VERSIONS}. */
  version: ReplayCorpusManifestVersion;
  /**
   * Identity of the task set. Travels with every measurement of this corpus so a run cannot be
   * silently relabelled between the baseline pass and the candidate pass.
   */
  corpusId: string;
  /**
   * The task ids this corpus covers, in DECLARED order. Under `lexicographic` the declared order is
   * not the canonical one; under `manifest` it is. Either way the ids are the same set.
   */
  taskIds: readonly string[];
  /** Seed the run uses. Recorded here so a re-seeded corpus is a different corpus. */
  seed: string;
  /** The only provider a corpus run may use. Typed as the mock literal, so no other value compiles. */
  provider: typeof MOCK_PROVIDER_ID;
  /** How {@link ReplayCorpusManifest.taskIds} becomes the canonical execution order. */
  order: ReplayCorpusOrder;
  /** The reproducibility rules this corpus commits to. */
  reproducibility: ReplayCorpusReproducibility;
}
