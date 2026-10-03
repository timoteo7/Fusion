import { describe, expect, it } from "vitest";
import {
  loadReplayCorpusManifest,
  resolveReplayCorpusOrder,
  fingerprintReplayCorpusManifest,
} from "../self-improve/replay-corpus-manifest.js";
import {
  REPLAY_CORPUS_MANIFEST_VERSION,
  REPLAY_CORPUS_MANIFEST_VERSIONS,
  REPLAY_CORPUS_ORDERS,
  REPLAY_CORPUS_MANIFEST_REJECTION_REASONS,
  isReplayCorpusOrder,
  isReplayCorpusManifestRejectionReason,
  type ReplayCorpusManifest,
} from "../types/self-improve/replay-corpus-manifest.js";
import { MOCK_PROVIDER_ID } from "../ai/mock-provider-constants.js";
import * as publicCore from "@fusion/core";

/*
FNXC:SelfImproveReplayCorpusManifest 2026-09-30-19:35:
The suite's subject is REPRODUCIBILITY BY DECLARATION: the same corpus, declared twice, must resolve
to the same ordered task list and the same fingerprint, and a corpus whose declaration disagrees
with itself (different seed, different order, different task set) must NOT share a fingerprint with
its twin. Everything else here is the load-time refusal contract: a malformed document is refused
with a NAMED reason before any task would run, and the validator is total and non-mutating.

FNXC:SelfImproveReplayCorpusManifest 2026-09-30-19:35:
Fingerprint assertions check the `sha256:` PREFIX and DIGEST STABILITY, never a hand-computed hash. A
literal expected digest would make this suite fail for the wrong reason if the canonical
serialization were deliberately revised later, and would teach a reader that the hash string is the
contract — when the contract is really "the fingerprint changes iff a comparability fact changes".
The two directions that matter are pinned instead: identical corpus => identical digest, any change
to version/corpusId/seed/provider/order/task-set => different digest.

FNXC:SelfImproveReplayCorpusManifest 2026-09-30-19:35:
MUTATION IS ASSERTED DIRECTLY, not indirectly. The spec's guarantee is that a loaded manifest is a
SNAPSHOT: neither re-sorting the caller's own array nor mutating the resolved result may retroactively
change what the manifest or its fingerprint mean. A test that only compared two loads would pass even
if both aliased the same array, so the two aliasing cases are pinned explicitly.
*/

function manifestDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: REPLAY_CORPUS_MANIFEST_VERSION,
    corpusId: "corpus-replay-v1",
    taskIds: ["FN-016", "FN-018", "FN-019"],
    seed: "seed-42",
    provider: MOCK_PROVIDER_ID,
    order: "lexicographic",
    reproducibility: {
      deterministicSeed: true,
      stableOrder: true,
      mockProviderOnly: true,
    },
    ...overrides,
  };
}

function loadOk(raw: unknown): ReplayCorpusManifest {
  const result = loadReplayCorpusManifest(raw);
  if (!result.ok) {
    throw new Error(`expected a valid manifest, got refusal "${result.reason}"`);
  }
  return result.manifest;
}

function loadReason(raw: unknown): string {
  const result = loadReplayCorpusManifest(raw);
  if (result.ok) {
    throw new Error("expected a refusal, got a loaded manifest");
  }
  return result.reason;
}

describe("replay corpus manifest (FUSI-030)", () => {
  describe("loading a valid manifest", () => {
    it("loads a well-formed document ok and preserves every declared fact", () => {
      const manifest = loadOk(manifestDocument());

      expect(manifest.version).toBe(REPLAY_CORPUS_MANIFEST_VERSION);
      expect(manifest.corpusId).toBe("corpus-replay-v1");
      expect(manifest.seed).toBe("seed-42");
      expect(manifest.provider).toBe(MOCK_PROVIDER_ID);
      expect(manifest.order).toBe("lexicographic");
      expect(manifest.reproducibility).toEqual({
        deterministicSeed: true,
        stableOrder: true,
        mockProviderOnly: true,
      });
    });

    it("accepts every version declared in the accepted-versions array", () => {
      for (const version of REPLAY_CORPUS_MANIFEST_VERSIONS) {
        const result = loadReplayCorpusManifest(manifestDocument({ version }));
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.manifest.version).toBe(version);
      }
    });
  });

  describe("reproducibility across two loads of the same declaration", () => {
    it("yields a byte-identical resolved order and an identical fingerprint", () => {
      const first = loadOk(manifestDocument());
      const second = loadOk(manifestDocument());

      const firstOrder = resolveReplayCorpusOrder(first);
      const secondOrder = resolveReplayCorpusOrder(second);

      expect(secondOrder).toEqual(firstOrder);
      expect(JSON.stringify(secondOrder)).toBe(JSON.stringify(firstOrder));
      expect(fingerprintReplayCorpusManifest(second)).toBe(fingerprintReplayCorpusManifest(first));
    });

    it("produces a well-formed sha256 fingerprint", () => {
      const manifest = loadOk(manifestDocument());
      expect(fingerprintReplayCorpusManifest(manifest)).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("resolves lexicographic order as a sorted list regardless of declared sequence", () => {
      const manifest = loadOk(manifestDocument({ taskIds: ["FN-019", "FN-016", "FN-018"] }));
      expect(resolveReplayCorpusOrder(manifest)).toEqual(["FN-016", "FN-018", "FN-019"]);
    });

    it("resolves manifest order as the declared sequence verbatim", () => {
      const manifest = loadOk(manifestDocument({
        taskIds: ["FN-019", "FN-016", "FN-018"],
        order: "manifest",
      }));
      expect(resolveReplayCorpusOrder(manifest)).toEqual(["FN-019", "FN-016", "FN-018"]);
    });
  });

  describe("a shuffled taskIds array is the same corpus only under lexicographic order", () => {
    it("yields the same order AND the same fingerprint under lexicographic", () => {
      const straight = loadOk(manifestDocument({ taskIds: ["FN-016", "FN-018", "FN-019"] }));
      const shuffled = loadOk(manifestDocument({ taskIds: ["FN-019", "FN-016", "FN-018"] }));

      expect(resolveReplayCorpusOrder(shuffled)).toEqual(resolveReplayCorpusOrder(straight));
      expect(fingerprintReplayCorpusManifest(shuffled)).toBe(fingerprintReplayCorpusManifest(straight));
    });

    it("yields a DIFFERENT fingerprint under manifest order", () => {
      const straight = loadOk(manifestDocument({
        taskIds: ["FN-016", "FN-018", "FN-019"],
        order: "manifest",
      }));
      const shuffled = loadOk(manifestDocument({
        taskIds: ["FN-019", "FN-016", "FN-018"],
        order: "manifest",
      }));

      expect(fingerprintReplayCorpusManifest(shuffled)).not.toBe(fingerprintReplayCorpusManifest(straight));
    });
  });

  describe("a changed comparability fact changes the fingerprint", () => {
    it("changes when only the seed changes", () => {
      const base = loadOk(manifestDocument({ seed: "seed-42" }));
      const reseeded = loadOk(manifestDocument({ seed: "seed-43" }));

      expect(fingerprintReplayCorpusManifest(reseeded)).not.toBe(fingerprintReplayCorpusManifest(base));
    });

    it("changes when the task set changes", () => {
      const base = loadOk(manifestDocument());
      const different = loadOk(manifestDocument({ taskIds: ["FN-016", "FN-018", "FN-020"] }));

      expect(fingerprintReplayCorpusManifest(different)).not.toBe(fingerprintReplayCorpusManifest(base));
    });

    it("changes when only the corpus id changes", () => {
      const base = loadOk(manifestDocument({ corpusId: "corpus-replay-v1" }));
      const different = loadOk(manifestDocument({ corpusId: "corpus-replay-v2" }));

      expect(fingerprintReplayCorpusManifest(different)).not.toBe(fingerprintReplayCorpusManifest(base));
    });

    it("changes when only the order mode changes", () => {
      const lexicographic = loadOk(manifestDocument({ order: "lexicographic" }));
      const declared = loadOk(manifestDocument({ order: "manifest" }));

      expect(fingerprintReplayCorpusManifest(declared)).not.toBe(
        fingerprintReplayCorpusManifest(lexicographic),
      );
    });
  });

  describe("load-time refusals", () => {
    it("refuses a version outside the accepted set with unsupported-version", () => {
      expect(loadReason(manifestDocument({ version: REPLAY_CORPUS_MANIFEST_VERSION + 1 }))).toBe(
        "unsupported-version",
      );
      expect(loadReason(manifestDocument({ version: 0 }))).toBe("unsupported-version");
    });

    it("refuses a missing or non-numeric version with unsupported-version", () => {
      expect(loadReason(manifestDocument({ version: undefined }))).toBe("unsupported-version");
      expect(loadReason(manifestDocument({ version: "1" }))).toBe("unsupported-version");
    });

    it("refuses an unknown top-level field with unknown-field", () => {
      expect(loadReason(manifestDocument({ extra: true }))).toBe("unknown-field");
    });

    it("refuses an unknown field inside the reproducibility block with unknown-field", () => {
      expect(
        loadReason(
          manifestDocument({
            reproducibility: {
              deterministicSeed: true,
              stableOrder: true,
              mockProviderOnly: true,
              somethingElse: true,
            },
          }),
        ),
      ).toBe("unknown-field");
    });

    it("refuses an empty taskIds array with empty-corpus", () => {
      expect(loadReason(manifestDocument({ taskIds: [] }))).toBe("empty-corpus");
    });

    it("refuses a duplicate task id with duplicate-task-id", () => {
      expect(loadReason(manifestDocument({ taskIds: ["FN-016", "FN-018", "FN-016"] }))).toBe(
        "duplicate-task-id",
      );
    });

    it("refuses an empty or non-string task id with empty-task-id", () => {
      expect(loadReason(manifestDocument({ taskIds: ["FN-016", ""] }))).toBe("empty-task-id");
      expect(loadReason(manifestDocument({ taskIds: ["FN-016", 17] }))).toBe("empty-task-id");
    });

    it("refuses a non-mock provider with provider-not-mock", () => {
      expect(loadReason(manifestDocument({ provider: "anthropic" }))).toBe("provider-not-mock");
      expect(loadReason(manifestDocument({ provider: undefined }))).toBe("provider-not-mock");
    });

    it("refuses an unknown order mode with unsupported-order", () => {
      expect(loadReason(manifestDocument({ order: "shuffled" }))).toBe("unsupported-order");
    });

    it("refuses a non-object document with missing-field rather than throwing", () => {
      expect(loadReason(null)).toBe("missing-field");
      expect(loadReason("corpus-replay-v1")).toBe("missing-field");
      expect(loadReason([1, 2, 3])).toBe("missing-field");
    });

    it("refuses a missing required scalar with missing-field", () => {
      expect(loadReason(manifestDocument({ corpusId: undefined }))).toBe("missing-field");
      expect(loadReason(manifestDocument({ seed: 7 }))).toBe("missing-field");
      expect(loadReason(manifestDocument({ taskIds: "FN-016" }))).toBe("missing-field");
    });

    it("refuses an incomplete reproducibility block with missing-field rather than defaulting it", () => {
      expect(
        loadReason(manifestDocument({ reproducibility: { deterministicSeed: true, stableOrder: true } })),
      ).toBe("missing-field");
      expect(loadReason(manifestDocument({ reproducibility: undefined }))).toBe("missing-field");
    });

    it("reports the offending FIELD without echoing the offending VALUE", () => {
      const result = loadReplayCorpusManifest(manifestDocument({ extra: "sensitive-value" }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.field).toBe("extra");
      expect(JSON.stringify(result)).not.toContain("sensitive-value");
    });
  });

  describe("the loaded manifest is a snapshot", () => {
    it("does not mutate the caller's document", () => {
      const document = manifestDocument();
      const before = JSON.stringify(document);
      loadOk(document);
      expect(JSON.stringify(document)).toBe(before);
    });

    it("does not alias the caller's taskIds array into the loaded manifest", () => {
      const document = manifestDocument();
      const manifest = loadOk(document);
      const taskIds = document.taskIds as string[];

      taskIds.push("FN-999");
      taskIds[0] = "MUTATED";

      expect(manifest.taskIds).toEqual(["FN-016", "FN-018", "FN-019"]);
    });

    it("returns a FRESH ordered array that mutating cannot feed back into the manifest", () => {
      const manifest = loadOk(manifestDocument());
      const ordered = resolveReplayCorpusOrder(manifest);

      ordered.push("FN-999");
      ordered[0] = "MUTATED";

      expect(manifest.taskIds).toEqual(["FN-016", "FN-018", "FN-019"]);
      expect(resolveReplayCorpusOrder(manifest)).toEqual(["FN-016", "FN-018", "FN-019"]);
    });

    it("is unaffected by a caller re-sorting its own array after the load", () => {
      const document = manifestDocument();
      const manifest = loadOk(document);
      const fingerprintAtLoad = fingerprintReplayCorpusManifest(manifest);

      (document.taskIds as string[]).sort((left, right) => (left < right ? 1 : -1));

      expect(resolveReplayCorpusOrder(manifest)).toEqual(["FN-016", "FN-018", "FN-019"]);
      expect(fingerprintReplayCorpusManifest(manifest)).toBe(fingerprintAtLoad);
    });
  });

  describe("closed vocabularies", () => {
    it("exposes exactly the two ordering modes", () => {
      expect([...REPLAY_CORPUS_ORDERS]).toEqual(["lexicographic", "manifest"]);
      expect(isReplayCorpusOrder("lexicographic")).toBe(true);
      expect(isReplayCorpusOrder("manifest")).toBe(true);
      expect(isReplayCorpusOrder("shuffled")).toBe(false);
      expect(isReplayCorpusOrder(undefined)).toBe(false);
    });

    it("exposes exactly the eight refusal reasons and guards them", () => {
      expect([...REPLAY_CORPUS_MANIFEST_REJECTION_REASONS]).toEqual([
        "unsupported-version",
        "missing-field",
        "empty-corpus",
        "duplicate-task-id",
        "empty-task-id",
        "provider-not-mock",
        "unsupported-order",
        "unknown-field",
      ]);
      for (const reason of REPLAY_CORPUS_MANIFEST_REJECTION_REASONS) {
        expect(isReplayCorpusManifestRejectionReason(reason)).toBe(true);
      }
      expect(isReplayCorpusManifestRejectionReason("not-a-reason")).toBe(false);
      expect(isReplayCorpusManifestRejectionReason(3)).toBe(false);
    });
  });

  describe("public surface", () => {
    it("exports the contract from the package root with value and type parity", () => {
      expect(publicCore.REPLAY_CORPUS_MANIFEST_VERSION).toBe(1);
      expect([...publicCore.REPLAY_CORPUS_MANIFEST_VERSIONS]).toEqual([1]);
      expect(typeof publicCore.loadReplayCorpusManifest).toBe("function");
      expect(typeof publicCore.resolveReplayCorpusOrder).toBe("function");
      expect(typeof publicCore.fingerprintReplayCorpusManifest).toBe("function");
      expect(publicCore.isReplayCorpusOrder("lexicographic")).toBe(true);
      expect(publicCore.isReplayCorpusManifestRejectionReason("empty-corpus")).toBe(true);

      const viaRoot = publicCore.loadReplayCorpusManifest(manifestDocument());
      expect(viaRoot.ok).toBe(true);
      if (!viaRoot.ok) return;
      expect(publicCore.fingerprintReplayCorpusManifest(viaRoot.manifest)).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });
});
