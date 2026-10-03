import { describe, expect, it } from "vitest";
import {
  PRIMARY_GATE_STEP_IDS,
  type AffectedTestScope,
  type PrimaryGateStep,
  type PrimaryGateStepId,
  type PrimaryGateStepOutcome,
  type PrimaryGateVerdict,
} from "../index.js";

/*
FNXC:SelfImprovePrimaryGate 2026-09-30-09:25:
Contract coverage for the primary-gate data types exported from the core barrel. The gate is the
deciding authority for every later self-improvement slice (test-count delta, cost budget, denylist,
persisted verdict), so its vocabulary is pinned here: the five step ids are exactly the deterministic
checks (build/lint/typecheck/gate/affected-tests), and the outcome union keeps behavioral verdicts
(passed/failed) distinct from infra outcomes (timed-out/unreadable) so a downstream consumer can
tell "the candidate failed" from "we could not read the evidence". These assert the exported VALUES
and their assignability, never source text or comments.
*/

describe("primary-gate data contract", () => {
  it("declares exactly the five deterministic step ids in canonical order", () => {
    expect(PRIMARY_GATE_STEP_IDS).toEqual(["build", "lint", "typecheck", "gate", "affected-tests"]);
  });

  it("models a per-step result as a step id plus a pass/fail boolean and an outcome", () => {
    const step: PrimaryGateStep = { id: "build", outcome: "failed", passed: false };
    expect(step.passed).toBe(false);
    expect(step.outcome).toBe("failed");
  });

  it("accepts the four outcome values, keeping infra outcomes distinct from behavioral failure", () => {
    const outcomes: PrimaryGateStepOutcome[] = ["passed", "failed", "timed-out", "unreadable"];
    expect(outcomes).toHaveLength(4);
    // "timed-out" and "unreadable" are infra; "passed"/"failed" are the behavioral verdicts.
    expect(outcomes.filter((o) => o === "timed-out" || o === "unreadable")).toEqual([
      "timed-out",
      "unreadable",
    ]);
  });

  it("models the affected-test scope as an explicit three-state union", () => {
    const resolved: AffectedTestScope = {
      kind: "resolved",
      testFiles: ["packages/engine/src/__tests__/a.test.ts"],
      packages: ["@fusion/engine"],
    };
    const empty: AffectedTestScope = { kind: "empty" };
    const shared: AffectedTestScope = { kind: "shared-infra", reason: "shared-test-infrastructure-changed" };

    expect(resolved.kind).toBe("resolved");
    expect(empty.kind).toBe("empty");
    expect(shared.kind).toBe("shared-infra");
  });

  it("models a verdict as boolean pass bound to a fingerprint, candidate sha, steps and counts", () => {
    const steps: PrimaryGateStep[] = PRIMARY_GATE_STEP_IDS.map((id) => ({
      id: id as PrimaryGateStepId,
      outcome: "passed",
      passed: true,
    }));
    const verdict: PrimaryGateVerdict = {
      passed: true,
      fingerprint: "a".repeat(64),
      candidateSha: "deadbeef",
      steps,
      failedStepCount: 0,
      affectedTestCount: 1,
      affectedScope: { kind: "resolved", testFiles: ["t.test.ts"], packages: ["p"] },
    };

    expect(verdict.passed).toBe(true);
    expect(verdict.failedStepCount).toBe(0);
    expect(verdict.steps).toHaveLength(5);
  });
});
