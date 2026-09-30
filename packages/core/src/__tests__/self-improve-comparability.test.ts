import { describe, expect, it } from "vitest";
import { evaluateComparability } from "../self-improve/comparability-guard.js";
import {
  SELF_IMPROVE_AUDIT_AGENT_ID,
  SELF_IMPROVE_RUN_AUDIT_EVENTS,
  emitSelfImproveComparabilityRefused,
} from "../self-improve/self-improve-run-audit.js";
import type { RunAuditSinkHost } from "../run-audit/emit-bounded-run-audit.js";
import type { RunAuditEventInput } from "../types/audit/run-audit.js";
import {
  COMPARABILITY_DIMENSIONS,
  COMPARABILITY_REFUSAL_REASONS,
  COMPARABILITY_VERDICT_VALUES,
  isComparabilityDimension,
  isComparabilityRefusalReason,
  isComparabilityVerdictValue,
  type ComparabilityDimension,
  type ComparabilityIdentity,
  type ComparabilityVerdict,
} from "../self-improve/comparability-types.js";
import * as publicCore from "@fusion/core";

/*
FNXC:SelfImproveComparability 2026-09-30-19:55:
The unit suite's whole subject is the REFUSAL-BEFORE-COMPARISON invariant, and determinism has exactly
one honest test: the same identity pair judged twice must be deep-equal — including the recomputed
fingerprints and both echoed identities — because a cached baseline is only comparable if re-judging
it is reproducible. Every other assertion is either a per-dimension boundary (each of the four refuses
on its own, naming itself) or a structural guard on the closed vocabularies.

FNXC:SelfImproveComparability 2026-09-30-19:55:
The `diverged` list is asserted to be a SUBSEQUENCE of the fixed {@link COMPARABILITY_DIMENSIONS}
order, not merely a set: the whole point of fixing the order is that the reported cause is
deterministic, so a test that only checked membership would pass on a guard that reported dimensions
in a caller-dependent order. The multi-divergence case asserts the exact ordered list so the order
itself is pinned.
*/

const IDENTITY: ComparabilityIdentity = {
  manifest: "manifest-v1:abc123",
  seed: "seed-42",
  engine: "engine-build-0001",
  config: "config-digest-xyz789",
  fingerprint: "", // filled by the guard from the four values
};

/** Capture every event a façade writes to an in-memory structural sink. */
function captureHost(): { events: RunAuditEventInput[]; host: RunAuditSinkHost } {
  const events: RunAuditEventInput[] = [];
  return { events, host: { recordRunAuditEvent: (event: RunAuditEventInput) => { events.push(event); } } };
}

/** An identity with one dimension replaced, to isolate a single-dimension divergence. */
function identityWith(overrides: Partial<ComparabilityIdentity>): ComparabilityIdentity {
  return { ...IDENTITY, ...overrides };
}

describe("comparability contract (closed vocabularies and fixed order)", () => {
  it("declares exactly the four fixed dimensions in order: manifest, seed, engine, config", () => {
    expect(COMPARABILITY_DIMENSIONS).toEqual(["manifest", "seed", "engine", "config"]);
  });

  it("accepts each dimension and rejects an unknown string in the type guard", () => {
    for (const dimension of COMPARABILITY_DIMENSIONS) {
      expect(isComparabilityDimension(dimension)).toBe(true);
    }
    expect(isComparabilityDimension("model")).toBe(false);
    expect(isComparabilityDimension(42)).toBe(false);
    expect(isComparabilityDimension(null)).toBe(false);
  });

  it("exposes a closed refusal vocabulary and verdict vocabulary", () => {
    expect(COMPARABILITY_REFUSAL_REASONS).toEqual(["divergent-identity", "not-a-run"]);
    expect(COMPARABILITY_VERDICT_VALUES).toEqual(["comparable", "not-comparable"]);
    expect(isComparabilityRefusalReason("divergent-identity")).toBe(true);
    expect(isComparabilityRefusalReason("something-else")).toBe(false);
    expect(isComparabilityVerdictValue("comparable")).toBe(true);
    expect(isComparabilityVerdictValue("maybe")).toBe(false);
  });

  it("keeps the module free of I/O, store imports, and clock reads (pure data contract)", () => {
    // The contract module must not reach for node:crypto, a store, or a clock — the fingerprint is
    // derived by the guard from the identity's own values. A newly added import of any of these
    // would break determinism without failing a behavior test, so the source shape is pinned here.
    // (A code-construct guard, not a prose assertion — the contract IS the import boundary.)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const source = require("node:fs").readFileSync(
      new URL("../self-improve/comparability-types.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']node:crypto["']/);
    expect(source).not.toMatch(/from\s+["'].*store/);
    expect(source).not.toMatch(/Date\.now|new Date\(/);
  });
});

describe("evaluateComparability (pure guard: refuses before comparing)", () => {
  it("returns comparable and deep-equals for two identical identities", () => {
    const verdict = evaluateComparability({ baseline: IDENTITY, candidate: IDENTITY });
    expect(verdict.verdict).toBe("comparable");
    expect(verdict.reason).toBeUndefined();
    expect(verdict.diverged).toBeUndefined();
    // Both identities are echoed back with a computed fingerprint so a caller can record what was judged.
    expect(verdict.baseline.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verdict.candidate.fingerprint).toBe(verdict.baseline.fingerprint);
  });

  it.each(COMPARABILITY_DIMENSIONS)("refuses naming exactly the %s dimension when it alone diverges", (dimension) => {
    const candidate = identityWith({ [dimension]: "diverged-value" } as Partial<ComparabilityIdentity>);
    const verdict = evaluateComparability({ baseline: IDENTITY, candidate });
    expect(verdict.verdict).toBe("not-comparable");
    expect(verdict.reason).toBe("divergent-identity");
    expect(verdict.diverged).toEqual([dimension]);
    // A refusal computes no metric: the verdict carries identities and the named cause, nothing else.
    expect(Object.keys(verdict).sort()).toEqual(["baseline", "candidate", "diverged", "reason", "verdict"]);
  });

  it("refuses naming EVERY diverged dimension in the fixed order", () => {
    const candidate = identityWith({
      config: "other-config",
      seed: "seed-99",
      manifest: "manifest-v2:def456",
    });
    const verdict = evaluateComparability({ baseline: IDENTITY, candidate });
    expect(verdict.verdict).toBe("not-comparable");
    expect(verdict.reason).toBe("divergent-identity");
    // engine is unchanged, so it is absent; the rest appear in the fixed manifest, seed, ..., config order.
    expect(verdict.diverged).toEqual(["manifest", "seed", "config"]);
  });

  it("always reports diverged as a subsequence of the fixed dimension order", () => {
    // Try every non-empty subset of the four dimensions and assert the reported list is always a
    // subsequence of the fixed order — the determinism of the reported cause is part of the contract.
    const all: ComparabilityDimension[] = ["manifest", "seed", "engine", "config"];
    for (let mask = 1; mask < 1 << all.length; mask++) {
      const changed: Partial<ComparabilityIdentity> = {};
      for (let i = 0; i < all.length; i++) {
        if (mask & (1 << i)) changed[all[i]] = "changed";
      }
      const verdict = evaluateComparability({ baseline: IDENTITY, candidate: identityWith(changed) });
      expect(verdict.verdict).toBe("not-comparable");
      // The reported list must be a subsequence of the fixed order, and must equal the changed set in
      // that order.
      let cursor = 0;
      for (const dimension of verdict.diverged!) {
        const at = COMPARABILITY_DIMENSIONS.indexOf(dimension);
        expect(at).toBeGreaterThanOrEqual(cursor);
        cursor = at + 1;
      }
      expect([...verdict.diverged!].sort()).toEqual(Object.keys(changed).sort());
    }
  });

  it("refuses a half-populated placeholder identity as not-a-run rather than trusting it", () => {
    const placeholder: ComparabilityIdentity = { ...IDENTITY, manifest: "" };
    const byBaseline = evaluateComparability({ baseline: placeholder, candidate: IDENTITY });
    expect(byBaseline.verdict).toBe("not-comparable");
    expect(byBaseline.reason).toBe("not-a-run");
    expect(byBaseline.diverged).toEqual([]);

    const byCandidate = evaluateComparability({ baseline: IDENTITY, candidate: placeholder });
    expect(byCandidate.verdict).toBe("not-comparable");
    expect(byCandidate.reason).toBe("not-a-run");
  });

  it("is pure: the same pair judged twice gives deep-equal verdicts including echoes and fingerprint", () => {
    const candidate = identityWith({ engine: "engine-build-0002" });
    const first = evaluateComparability({ baseline: IDENTITY, candidate });
    const second = evaluateComparability({ baseline: IDENTITY, candidate });
    expect(second).toEqual(first);
    // The echoed identities are snapshots, not shared references: mutating one verdict cannot affect
    // another, which is what "pure" means for a value a caller may hold.
    expect(first.baseline).not.toBe(second.baseline);
  });

  it("changes the fingerprint when any single dimension value changes", () => {
    const base = evaluateComparability({ baseline: IDENTITY, candidate: IDENTITY });
    const baseFingerprint = base.baseline.fingerprint;
    for (const dimension of COMPARABILITY_DIMENSIONS) {
      const changed = evaluateComparability({
        baseline: identityWith({ [dimension]: "different" } as Partial<ComparabilityIdentity>),
        candidate: IDENTITY,
      });
      expect(changed.baseline.fingerprint).not.toBe(baseFingerprint);
    }
  });
});

describe("emitSelfImproveComparabilityRefused (closed metadata list, fixed outcome only)", () => {
  it("records exactly the closed field set and nothing else", async () => {
    const { events, host } = captureHost();
    const candidate = identityWith({ seed: "seed-99" });
    const verdict = evaluateComparability({ baseline: IDENTITY, candidate });

    await emitSelfImproveComparabilityRefused({
      host,
      baseline: verdict.baseline,
      candidate: verdict.candidate,
      diverged: verdict.diverged,
      outcome: verdict.reason!,
      proposalId: "FUSI-032",
      projectId: "self-improve-comparability",
    });

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.mutationType).toBe(SELF_IMPROVE_RUN_AUDIT_EVENTS.comparabilityRefused);
    expect(event.mutationType).toBe("selfimprove:comparability-refused");
    expect(event.domain).toBe("database");
    expect(event.agentId).toBe(SELF_IMPROVE_AUDIT_AGENT_ID);
    // A replay comparison belongs to no task column.
    expect(event.taskId).toBeUndefined();
    expect(Object.keys(event.metadata!).sort()).toEqual(
      [
        "baselineConfig",
        "baselineEngine",
        "baselineManifest",
        "baselineSeed",
        "candidateConfig",
        "candidateEngine",
        "candidateManifest",
        "candidateSeed",
        "diverged",
        "divergedCount",
        "outcome",
        "projectId",
        "proposalId",
      ].sort(),
    );
    expect(event.metadata).toMatchObject({
      outcome: "divergent-identity",
      diverged: ["seed"],
      divergedCount: 1,
      proposalId: "FUSI-032",
    });
  });

  it("omits proposalId and projectId from the row when the caller has none", async () => {
    const { events, host } = captureHost();
    await emitSelfImproveComparabilityRefused({
      host,
      baseline: IDENTITY,
      candidate: IDENTITY,
      outcome: "not-a-run",
    });
    const keys = Object.keys(events[0].metadata!);
    expect(keys).not.toContain("proposalId");
    expect(keys).not.toContain("projectId");
    // A refusal with no proposal to attribute uses a fixed sentinel target, not a borrowed id.
    expect(events[0].target).toBe("replay-comparability");
    expect(events[0].runId).toBe("selfimprove-comparability");
  });

  it("records multiple diverged dimensions in the fixed order with no prose in the payload", async () => {
    const { events, host } = captureHost();
    const candidate = identityWith({ config: "other", manifest: "other", engine: "other" });
    const verdict = evaluateComparability({ baseline: IDENTITY, candidate });

    await emitSelfImproveComparabilityRefused({
      host,
      baseline: verdict.baseline,
      candidate: verdict.candidate,
      diverged: verdict.diverged,
      outcome: verdict.reason!,
    });

    const metadata = events[0].metadata!;
    // The named cause is the ordered enum list — manifest, then engine, then config, never the order
    // the caller's object happened to enumerate them.
    expect(metadata.diverged).toEqual(["manifest", "engine", "config"]);
    expect(metadata.divergedCount).toBe(3);
    // No metadata value is prose, and no value is a multi-line string.
    for (const value of Object.values(metadata)) {
      if (typeof value === "string") {
        expect(value).not.toContain("\n");
        expect(value).not.toContain(" ");
      }
    }
  });

  it("normalizes the recorded diverged list to the fixed order regardless of caller order", async () => {
    const { events, host } = captureHost();
    await emitSelfImproveComparabilityRefused({
      host,
      baseline: IDENTITY,
      candidate: IDENTITY,
      // A caller supplying the dimensions in a different order still records them canonically.
      diverged: ["config", "manifest"] as ComparabilityDimension[],
      outcome: "divergent-identity",
    });
    expect(events[0].metadata!.diverged).toEqual(["manifest", "config"]);
  });

  it("drops a crafted unknown dimension name rather than recording it", async () => {
    const { events, host } = captureHost();
    await emitSelfImproveComparabilityRefused({
      host,
      baseline: IDENTITY,
      candidate: IDENTITY,
      // A caller smuggling an unrecognized name through a cast must not widen the recorded cause list.
      diverged: ["manifest", "model", "attacker-controlled"] as ComparabilityDimension[],
      outcome: "divergent-identity",
    });
    expect(events[0].metadata!.diverged).toEqual(["manifest"]);
    expect(JSON.stringify(events[0])).not.toContain("attacker-controlled");
    expect(JSON.stringify(events[0])).not.toContain("model");
  });
});

describe("public core barrel (comparability surface is re-exported)", () => {
  it("re-exports the guard, constants, and guards from @fusion/core", () => {
    expect(typeof publicCore.evaluateComparability).toBe("function");
    expect(publicCore.COMPARABILITY_DIMENSIONS).toEqual(["manifest", "seed", "engine", "config"]);
    expect(publicCore.COMPARABILITY_REFUSAL_REASONS).toEqual(["divergent-identity", "not-a-run"]);
    expect(publicCore.isComparabilityDimension("manifest")).toBe(true);
    expect(publicCore.isComparabilityRefusalReason("not-a-run")).toBe(true);
    expect(publicCore.isComparabilityVerdictValue("comparable")).toBe(true);
    expect(typeof publicCore.emitSelfImproveComparabilityRefused).toBe("function");
    expect(publicCore.SELF_IMPROVE_RUN_AUDIT_EVENTS.comparabilityRefused).toBe(
      "selfimprove:comparability-refused",
    );
  });
});

// Keep the type imports referenced so the compile-time surface of the contract is exercised.
export type { ComparabilityVerdict };
