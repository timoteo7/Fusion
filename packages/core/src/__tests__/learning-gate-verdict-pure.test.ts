import { describe, expect, it } from "vitest";
import {
  LEARNING_GATE_PRECEDENCE_OUTCOMES,
  LEARNING_GATE_VERDICTS,
  type LearningGatePrecedenceOutcome,
  type LearningGatePrimarySignals,
  type LearningGateVerdict,
  type LearningGateVerdictInput,
} from "../types/self-improve/learning-gate-verdict.js";
import {
  buildLearningGateVerdictId,
  computeLearningGateVerdictFingerprint,
  isLearningGateVerdict,
  resolveLearningGateVerdict,
} from "../self-improve/learning-gate-verdict-types.js";

/*
FNXC:SelfImproveGateVerdict 2026-09-30-12:40:
These tests pin the parts of the verdict contract that are pure enough to prove without a
database: the two closed enums, the total resolution function (every primary/canary combination),
the fingerprint's determinism, and the derived verdict id that makes a re-record idempotent. These
are the decision points where a silent regression would corrupt WHICH experiments the loop keeps —
the "primary gate always wins" rule is the whole point of the feature, and a drift here would
quietly let a replay canary overturn a decisive primary gate. The PostgreSQL suite proves the
persisted shape; this one proves the rules.

FNXC:SelfImproveGateVerdict 2026-09-30-12:40:
The nine-combination test is deliberately EXHAUSTIVE over the 3x3 verdict grid plus the absent
canary, generated from the enums rather than hand-listed, so adding a fourth verdict to either enum
makes this test fail until its new combinations are reasoned about — the same reason a hand-written
list of nine would silently keep passing.
*/

const signals = (overrides: Partial<LearningGatePrimarySignals> = {}): LearningGatePrimarySignals => ({
  buildOk: true,
  lintOk: true,
  typecheckOk: true,
  gateOk: true,
  affectedTestsOk: true,
  testCountDelta: 0,
  costBudgetInvariantOk: true,
  corpusVersion: "corpus-v1",
  seed: 42,
  ...overrides,
});

const input = (overrides: Partial<LearningGateVerdictInput> = {}): LearningGateVerdictInput => ({
  experimentId: "exp-1",
  baselineId: "baseline-1",
  primarySignals: signals(),
  ...overrides,
});

describe("learning gate verdict enums", () => {
  it("accepts exactly the three fixed verdicts", () => {
    // Closed on purpose: a free label in the verdict column would be an unbounded vocabulary no
    // later gate could count, and the bounded run-audit row (ids/counts/fixed outcomes only) could
    // not mirror it.
    expect([...LEARNING_GATE_VERDICTS]).toEqual(["keep", "reverse", "inconclusive"]);
  });

  it("accepts exactly the four fixed precedence outcomes", () => {
    expect([...LEARNING_GATE_PRECEDENCE_OUTCOMES]).toEqual([
      "canary-absent",
      "agreed",
      "primary-prevailed",
      "primary-abstained",
    ]);
  });

  it("rejects anything outside the verdict enum", () => {
    for (const value of ["", "KEEP", "merged", null, undefined, 1, {}]) {
      expect(isLearningGateVerdict(value)).toBe(false);
    }
  });

  it("accepts every member of the enum and narrows the type", () => {
    for (const verdict of LEARNING_GATE_VERDICTS) {
      expect(isLearningGateVerdict(verdict)).toBe(true);
    }
    // A type predicate, so a narrowed value is assignable to the exported union without a cast —
    // this is what lets a later gate build a verdict by hand.
    const narrowed: LearningGateVerdict | undefined = "reverse";
    expect(isLearningGateVerdict(narrowed) ? narrowed : undefined).toBe("reverse");
  });
});

describe("learning gate verdict precedence resolution", () => {
  it("resolves the absent canary to the primary's own verdict", () => {
    for (const primary of LEARNING_GATE_VERDICTS) {
      for (const canary of [undefined, null] as const) {
        expect(resolveLearningGateVerdict(primary, canary)).toEqual({
          resolvedVerdict: primary,
          primaryVerdict: primary,
          canaryVerdict: null,
          precedenceOutcome: "canary-absent",
        });
      }
    }
  });

  it("reports agreement when the primary and canary say the same thing", () => {
    for (const verdict of LEARNING_GATE_VERDICTS) {
      expect(resolveLearningGateVerdict(verdict, verdict)).toEqual({
        resolvedVerdict: verdict,
        primaryVerdict: verdict,
        canaryVerdict: verdict,
        precedenceOutcome: "agreed",
      });
    }
  });

  it("lets the canary decide ONLY when the primary abstained", () => {
    // The primary abstained and the canary was decisive: the canary's verdict stands.
    for (const canary of ["keep", "reverse"] as const) {
      expect(resolveLearningGateVerdict("inconclusive", canary)).toEqual({
        resolvedVerdict: canary,
        primaryVerdict: "inconclusive",
        canaryVerdict: canary,
        precedenceOutcome: "primary-abstained",
      });
    }
    // The primary abstained and so did the canary: still inconclusive, not upgraded into a decision.
    expect(resolveLearningGateVerdict("inconclusive", "inconclusive")).toEqual({
      resolvedVerdict: "inconclusive",
      primaryVerdict: "inconclusive",
      canaryVerdict: "inconclusive",
      precedenceOutcome: "agreed",
    });
  });

  it("gives the PRIMARY gate the verdict whenever both are decisive and disagree", () => {
    // Both orderings of a keep/reverse conflict, asserted explicitly because "the primary wins" is
    // the load-bearing requirement of this feature: the canary must never overturn a decisive
    // primary gate in either direction.
    expect(resolveLearningGateVerdict("reverse", "keep")).toEqual({
      resolvedVerdict: "reverse",
      primaryVerdict: "reverse",
      canaryVerdict: "keep",
      precedenceOutcome: "primary-prevailed",
    });
    expect(resolveLearningGateVerdict("keep", "reverse")).toEqual({
      resolvedVerdict: "keep",
      primaryVerdict: "keep",
      canaryVerdict: "reverse",
      precedenceOutcome: "primary-prevailed",
    });
  });

  it("resolves EVERY primary/canary combination to exactly one verdict and outcome", () => {
    // Generated from the enums so a future fourth verdict makes this fail until its combinations
    // are reasoned about. The expected outcome is derived by an INDEPENDENT restatement of the
    // rule (not by calling the implementation), so this is a real check and not a tautology.
    const expected = (primary: LearningGateVerdict, canary: LearningGateVerdict | null) => {
      if (canary === null) return { verdict: primary, outcome: "canary-absent" as LearningGatePrecedenceOutcome };
      if (primary === canary) return { verdict: canary, outcome: "agreed" as LearningGatePrecedenceOutcome };
      if (primary === "inconclusive") return { verdict: canary, outcome: "primary-abstained" as LearningGatePrecedenceOutcome };
      return { verdict: primary, outcome: "primary-prevailed" as LearningGatePrecedenceOutcome };
    };
    for (const primary of LEARNING_GATE_VERDICTS) {
      for (const canary of [...LEARNING_GATE_VERDICTS, null] as const) {
        const want = expected(primary, canary);
        const got = resolveLearningGateVerdict(primary, canary);
        expect(got, `primary=${primary} canary=${canary}`).toEqual({
          resolvedVerdict: want.verdict,
          primaryVerdict: primary,
          canaryVerdict: canary,
          precedenceOutcome: want.outcome,
        });
      }
    }
  });

  it("refuses a verdict or canary outside the closed enum", () => {
    expect(() => resolveLearningGateVerdict("maybe" as never)).toThrow(/Unknown learning gate verdict/);
    expect(() => resolveLearningGateVerdict("keep", "maybe" as never)).toThrow(/Unknown learning gate canary verdict/);
  });
});

describe("learning gate verdict fingerprint", () => {
  it("is byte-identical for the same inputs across repeated computations", () => {
    const a = computeLearningGateVerdictFingerprint(input());
    const b = computeLearningGateVerdictFingerprint(input());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when ANY covered primary signal changes", () => {
    const base = computeLearningGateVerdictFingerprint(input());
    // Every field the fingerprint claims to cover is perturbed in turn; if any of these did NOT
    // change the fingerprint, two genuinely different gate runs would look identical and the
    // "same inputs yield the same verdict" property would be vacuous.
    const perturbations: LearningGateVerdictInput[] = [
      input({ experimentId: "exp-2" }),
      input({ baselineId: "baseline-2" }),
      input({ primarySignals: signals({ buildOk: false }) }),
      input({ primarySignals: signals({ lintOk: false }) }),
      input({ primarySignals: signals({ typecheckOk: false }) }),
      input({ primarySignals: signals({ gateOk: false }) }),
      input({ primarySignals: signals({ affectedTestsOk: false }) }),
      input({ primarySignals: signals({ testCountDelta: 1 }) }),
      input({ primarySignals: signals({ costBudgetInvariantOk: false }) }),
      input({ primarySignals: signals({ corpusVersion: "corpus-v2" }) }),
      input({ primarySignals: signals({ seed: 43 }) }),
    ];
    for (const perturbed of perturbations) {
      expect(computeLearningGateVerdictFingerprint(perturbed), JSON.stringify(perturbed.primarySignals)).not.toBe(base);
    }
  });

  it("does NOT depend on the canary, because it identifies the input experiment", () => {
    // The canary is an OUTPUT of the experiment, not an input signal; folding it in would make the
    // fingerprint of "the same candidate" differ based on which canary happened to run.
    const withoutCanary = computeLearningGateVerdictFingerprint(input());
    const withCanary = computeLearningGateVerdictFingerprint(input({ canaryVerdict: "reverse" }));
    expect(withCanary).toBe(withoutCanary);
  });

  it("refuses a blank experiment, baseline, or corpus version", () => {
    for (const bad of ["", "   "]) {
      expect(() => computeLearningGateVerdictFingerprint(input({ experimentId: bad }))).toThrow(/non-blank experimentId/);
      expect(() => computeLearningGateVerdictFingerprint(input({ baselineId: bad }))).toThrow(/non-blank baselineId/);
      expect(() => computeLearningGateVerdictFingerprint(input({ primarySignals: signals({ corpusVersion: bad }) }))).toThrow(/non-blank primarySignals.corpusVersion/);
    }
  });
});

describe("learning gate verdict id derivation", () => {
  it("derives a stable id from experiment + baseline + fingerprint", () => {
    const fingerprint = computeLearningGateVerdictFingerprint(input());
    const id = buildLearningGateVerdictId("exp-1", "baseline-1", fingerprint);
    // Same three inputs, same id — this is what makes a repeated recording collide on the primary
    // key and collapse to one row instead of appending indistinguishable duplicates.
    expect(buildLearningGateVerdictId("exp-1", "baseline-1", fingerprint)).toBe(id);
    expect(id).toBe(`exp-1:baseline-1:${fingerprint}:gate`);
  });

  it("derives a DIFFERENT id for a different judgment about the same experiment", () => {
    // Because the fingerprint is part of the derivation, a later judgment (new corpus version) is
    // recorded as its own verdict rather than overwriting the earlier one.
    const v1 = buildLearningGateVerdictId("exp-1", "baseline-1", computeLearningGateVerdictFingerprint(input()));
    const v2 = buildLearningGateVerdictId("exp-1", "baseline-1", computeLearningGateVerdictFingerprint(input({ primarySignals: signals({ corpusVersion: "corpus-v2" }) })));
    expect(v2).not.toBe(v1);
  });

  it("refuses blank experiment, baseline, or fingerprint", () => {
    const fingerprint = computeLearningGateVerdictFingerprint(input());
    expect(() => buildLearningGateVerdictId("", "baseline-1", fingerprint)).toThrow(/non-blank experimentId/);
    expect(() => buildLearningGateVerdictId("exp-1", "", fingerprint)).toThrow(/non-blank baselineId/);
    expect(() => buildLearningGateVerdictId("exp-1", "baseline-1", "")).toThrow(/non-blank inputFingerprint/);
  });
});
