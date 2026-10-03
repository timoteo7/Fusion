import { describe, expect, it } from "vitest";
import type { PrimaryGateStepId, PrimaryGateStepOutcome } from "@fusion/core";
import {
  assemblePrimaryGateVerdict,
  runPrimaryGate,
  type PrimaryGateStepRequest,
} from "../self-improve/primary-gate.js";

/*
FNXC:SelfImprovePrimaryGateVerdict 2026-09-30-09:25:
Behavioral coverage for the pure verdict assembly. The contract the whole gate rests on is
REPRODUCIBILITY and FAIL-CLOSED: the same candidate over the same corpus must yield the same verdict
and fingerprint, flipping any single step boolean must change the fingerprint, any failing or
unreadable step must fail the verdict, and running the same candidate twice must return
deep-equal verdicts carrying one fingerprint. These assert observable verdicts, never source text.
*/

const ALL_PASS: Record<PrimaryGateStepId, PrimaryGateStepOutcome> = {
  build: "passed",
  lint: "passed",
  typecheck: "passed",
  gate: "passed",
  "affected-tests": "passed",
};

const SCOPE = {
  kind: "resolved" as const,
  testFiles: ["packages/engine/src/__tests__/alpha.test.ts", "packages/core/src/__tests__/gamma.test.ts"],
  packages: ["@fusion/core", "@fusion/engine"],
};

describe("assemblePrimaryGateVerdict", () => {
  it("returns passed:true only when all five steps pass", () => {
    const verdict = assemblePrimaryGateVerdict({
      candidateSha: "abc123",
      affectedScope: SCOPE,
      stepOutcomes: ALL_PASS,
    });

    expect(verdict.passed).toBe(true);
    expect(verdict.failedStepCount).toBe(0);
    expect(verdict.affectedTestCount).toBe(SCOPE.testFiles.length);
  });

  it("yields passed:false when any step fails", () => {
    const verdict = assemblePrimaryGateVerdict({
      candidateSha: "abc123",
      affectedScope: SCOPE,
      stepOutcomes: { ...ALL_PASS, typecheck: "failed" },
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.failedStepCount).toBe(1);
    const typecheck = verdict.steps.find((s) => s.id === "typecheck");
    expect(typecheck?.passed).toBe(false);
    expect(typecheck?.outcome).toBe("failed");
  });

  it("treats an unreadable step as a fail-closed failure, not a skip", () => {
    const verdict = assemblePrimaryGateVerdict({
      candidateSha: "abc123",
      affectedScope: SCOPE,
      // "gate" outcome missing entirely — unreadable evidence, not a pass.
      stepOutcomes: { build: "passed", lint: "passed", typecheck: "passed", "affected-tests": "passed" },
    });

    expect(verdict.passed).toBe(false);
    const gate = verdict.steps.find((s) => s.id === "gate");
    expect(gate?.outcome).toBe("unreadable");
    expect(gate?.passed).toBe(false);
  });

  it("treats a timed-out step as a fail-closed failure", () => {
    const verdict = assemblePrimaryGateVerdict({
      candidateSha: "abc123",
      affectedScope: SCOPE,
      stepOutcomes: { ...ALL_PASS, build: "timed-out" },
    });

    expect(verdict.passed).toBe(false);
    const build = verdict.steps.find((s) => s.id === "build");
    expect(build?.outcome).toBe("timed-out");
    expect(build?.passed).toBe(false);
  });

  it("produces an identical fingerprint for identical inputs", () => {
    const a = assemblePrimaryGateVerdict({ candidateSha: "abc123", affectedScope: SCOPE, stepOutcomes: ALL_PASS });
    const b = assemblePrimaryGateVerdict({ candidateSha: "abc123", affectedScope: SCOPE, stepOutcomes: ALL_PASS });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("changes the fingerprint when one step boolean flips", () => {
    const allPass = assemblePrimaryGateVerdict({ candidateSha: "abc123", affectedScope: SCOPE, stepOutcomes: ALL_PASS });
    const lintFails = assemblePrimaryGateVerdict({ candidateSha: "abc123", affectedScope: SCOPE, stepOutcomes: { ...ALL_PASS, lint: "failed" } });
    expect(lintFails.fingerprint).not.toBe(allPass.fingerprint);
  });

  it("changes the fingerprint when the candidate sha changes", () => {
    const a = assemblePrimaryGateVerdict({ candidateSha: "abc123", affectedScope: SCOPE, stepOutcomes: ALL_PASS });
    const b = assemblePrimaryGateVerdict({ candidateSha: "def456", affectedScope: SCOPE, stepOutcomes: ALL_PASS });
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("changes the fingerprint when the affected-test list changes", () => {
    const a = assemblePrimaryGateVerdict({ candidateSha: "abc123", affectedScope: SCOPE, stepOutcomes: ALL_PASS });
    const b = assemblePrimaryGateVerdict({
      candidateSha: "abc123",
      affectedScope: { ...SCOPE, testFiles: ["packages/engine/src/__tests__/alpha.test.ts"] },
      stepOutcomes: ALL_PASS,
    });
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it("is independent of affected-test input order (locale-independent sorting)", () => {
    const ordered = assemblePrimaryGateVerdict({
      candidateSha: "abc123",
      affectedScope: { kind: "resolved", testFiles: ["a.test.ts", "b.test.ts"], packages: ["p"] },
      stepOutcomes: ALL_PASS,
    });
    const reversed = assemblePrimaryGateVerdict({
      candidateSha: "abc123",
      affectedScope: { kind: "resolved", testFiles: ["b.test.ts", "a.test.ts"], packages: ["p"] },
      stepOutcomes: ALL_PASS,
    });
    expect(reversed.fingerprint).toBe(ordered.fingerprint);
  });

  it("returns deep-equal verdicts with one fingerprint for the same candidate run twice", () => {
    const first = assemblePrimaryGateVerdict({ candidateSha: "abc123", affectedScope: SCOPE, stepOutcomes: ALL_PASS });
    const second = assemblePrimaryGateVerdict({ candidateSha: "abc123", affectedScope: SCOPE, stepOutcomes: ALL_PASS });
    expect(second).toEqual(first);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("counts affected tests as zero for an empty or shared-infra scope", () => {
    const empty = assemblePrimaryGateVerdict({ candidateSha: "abc123", affectedScope: { kind: "empty" }, stepOutcomes: ALL_PASS });
    const shared = assemblePrimaryGateVerdict({
      candidateSha: "abc123",
      affectedScope: { kind: "shared-infra", reason: "shared-test-infrastructure-changed" },
      stepOutcomes: ALL_PASS,
    });
    expect(empty.affectedTestCount).toBe(0);
    expect(shared.affectedTestCount).toBe(0);
  });
});

/*
FNXC:SelfImprovePrimaryGateExecutor 2026-09-30-09:35:
Executor coverage. The three properties the mission names are asserted here as observable behavior:
an injected step failure makes the verdict reject; a runner that THROWS is recorded as a fail-closed
outcome and never becomes an unhandled rejection; and the live engine's cwd is never handed to a
child — every step receives exactly the sandbox directory. A fake runner captures the cwd each
request was given, so the isolation claim is proven by what the child would actually receive.
*/

const PKG_DIRS = new Map([["packages/engine", "@fusion/engine"]]);
const LIVE_TESTS = ["packages/engine/src/__tests__/alpha.test.ts"];

/** A runner that always passes, while recording the cwd/env of every request it receives. */
function recordingPassRunner(captured: PrimaryGateStepRequest[]): (r: PrimaryGateStepRequest) => Promise<PrimaryGateStepOutcome> {
  return async (request) => {
    captured.push(request);
    return "passed";
  };
}

const BASE_GATE_OPTS = {
  sandboxDir: "/sandbox/experiment-branch",
  baseRef: "main",
  candidateSha: "abc123",
  packageNameByDir: PKG_DIRS,
  listLiveTestFiles: (pkg: string) => (pkg === "@fusion/engine" ? LIVE_TESTS : []),
  changedFiles: ["packages/engine/src/self-improve/primary-gate.ts"],
};

describe("runPrimaryGate", () => {
  it("passes when every step passes, resolving affected tests to the sandbox cwd", async () => {
    const captured: PrimaryGateStepRequest[] = [];
    const verdict = await runPrimaryGate({ ...BASE_GATE_OPTS, runStep: recordingPassRunner(captured) });

    expect(verdict.passed).toBe(true);
    // Five steps ran, each with the sandbox cwd — never the live engine's cwd.
    expect(captured).toHaveLength(5);
    for (const request of captured) {
      expect(request.cwd).toBe("/sandbox/experiment-branch");
      expect(request.cwd).not.toBe(process.cwd());
    }
  });

  it("never hands the live engine cwd to a child", async () => {
    const captured: PrimaryGateStepRequest[] = [];
    await runPrimaryGate({ ...BASE_GATE_OPTS, runStep: recordingPassRunner(captured) });

    // Every step's cwd is exactly the sandbox dir. The live engine's process.cwd() is never used.
    expect(captured.every((r) => r.cwd === "/sandbox/experiment-branch")).toBe(true);
    expect(captured.some((r) => r.cwd === process.cwd())).toBe(false);
  });

  it("builds the affected-tests command from the resolved per-file scope, not a full suite", async () => {
    const captured: PrimaryGateStepRequest[] = [];
    await runPrimaryGate({ ...BASE_GATE_OPTS, runStep: recordingPassRunner(captured) });

    const affected = captured.find((r) => r.id === "affected-tests");
    expect(affected?.command).toContain("vitest run");
    expect(affected?.command).toContain("src/__tests__/alpha.test.ts");
    // A full-suite escalation token must never appear in the command.
    expect(affected?.command).not.toContain("test:full");
    expect(affected?.command).not.toContain("allowFullSuite");
  });

  /*
  FNXC:SelfImproveAffectedTestsCommand 2026-09-30-10:25:
  Regression guard for the REAL command shape. Vitest is a per-package dependency, so the affected
  lane MUST dispatch through the owning package (`pnpm --filter <pkg> exec vitest run`). A bare root
  `pnpm exec vitest` exits 254 here, which would make the step fail for every candidate that touches
  a live test and leave the gate able to answer only "revert". This asserts the dispatch form, and
  a multi-package scope, so the root-level form cannot come back unnoticed.
  */
  it("dispatches the affected-tests command through the owning package, not the sandbox root", async () => {
    const captured: PrimaryGateStepRequest[] = [];
    await runPrimaryGate({ ...BASE_GATE_OPTS, runStep: recordingPassRunner(captured) });

    const command = captured.find((r) => r.id === "affected-tests")?.command ?? "";
    // Package-scoped dispatch, with the test path relative to that package's vitest root.
    expect(command).toBe("pnpm --filter @fusion/engine exec vitest run src/__tests__/alpha.test.ts");
    // The root-level form is unrunnable in this workspace and must never be emitted.
    expect(command.startsWith("pnpm exec vitest")).toBe(false);
  });

  it("dispatches one package-scoped command per owning package for a cross-package diff", async () => {
    const captured: PrimaryGateStepRequest[] = [];
    await runPrimaryGate({
      ...BASE_GATE_OPTS,
      changedFiles: [
        "packages/engine/src/self-improve/primary-gate.ts",
        "packages/core/src/self-improve/ledger.ts",
      ],
      packageNameByDir: new Map([
        ["packages/engine", "@fusion/engine"],
        ["packages/core", "@fusion/core"],
      ]),
      listLiveTestFiles: (pkg: string) =>
        pkg === "@fusion/engine" ? LIVE_TESTS : ["packages/core/src/__tests__/gamma.test.ts"],
      runStep: recordingPassRunner(captured),
    });

    const command = captured.find((r) => r.id === "affected-tests")?.command ?? "";
    // Each package runs only its OWN tests, and the join is a shell AND so one failure fails the step.
    expect(command).toContain("pnpm --filter @fusion/core exec vitest run src/__tests__/gamma.test.ts");
    expect(command).toContain("pnpm --filter @fusion/engine exec vitest run src/__tests__/alpha.test.ts");
    expect(command).toContain(" && ");
    // Neither package may receive the other's tests. Scoped per `&&` segment, since the join itself
    // puts one package's clause on the same line as the other's.
    const segments = command.split(" && ");
    const coreSegment = segments.find((s) => s.includes("@fusion/core")) ?? "";
    const engineSegment = segments.find((s) => s.includes("@fusion/engine")) ?? "";
    expect(coreSegment).not.toContain("alpha.test.ts");
    expect(engineSegment).not.toContain("gamma.test.ts");
  });

  it("rejects the verdict when an injected step fails", async () => {
    const runStep = async (request: PrimaryGateStepRequest): Promise<PrimaryGateStepOutcome> =>
      request.id === "typecheck" ? "failed" : "passed";

    const verdict = await runPrimaryGate({ ...BASE_GATE_OPTS, runStep });
    expect(verdict.passed).toBe(false);
    expect(verdict.failedStepCount).toBe(1);
    expect(verdict.steps.find((s) => s.id === "typecheck")?.outcome).toBe("failed");
  });

  it("records a throwing runner as a fail-closed outcome without an unhandled rejection", async () => {
    // A runner that throws for `lint` but resolves for the rest. The throw must be caught and
    // recorded as `unreadable`, not propagate out of runPrimaryGate.
    const runStep = async (request: PrimaryGateStepRequest): Promise<PrimaryGateStepOutcome> => {
      if (request.id === "lint") throw new Error("runner exploded");
      return "passed";
    };

    const verdict = await runPrimaryGate({ ...BASE_GATE_OPTS, runStep });
    // The throw did not escape — we received a verdict.
    expect(verdict.passed).toBe(false);
    expect(verdict.steps.find((s) => s.id === "lint")?.outcome).toBe("unreadable");
  });

  it("fails the affected-tests step closed when the changed-file list is unreadable", async () => {
    // No changedFiles override and no real git in a temp sandbox: probeChangedFiles fails, and the
    // affected-tests step must be recorded `unreadable` (not a silent pass on "no changes").
    const runStep = recordingPassRunner([]);
    const verdict = await runPrimaryGate({
      ...BASE_GATE_OPTS,
      changedFiles: undefined,
      runStep,
    });

    // The git probe against a nonexistent sandbox ref is unavailable, so affected-tests fails closed.
    const affected = verdict.steps.find((s) => s.id === "affected-tests");
    expect(affected?.outcome).toBe("unreadable");
    expect(verdict.passed).toBe(false);
  });

  it("sets mock/test mode on every child env", async () => {
    const captured: PrimaryGateStepRequest[] = [];
    await runPrimaryGate({ ...BASE_GATE_OPTS, runStep: recordingPassRunner(captured) });

    for (const request of captured) {
      expect(request.env.FUSION_TEST_MODE).toBe("1");
      expect(request.env.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe("0");
    }
  });

  it("returns an explicit empty affected scope without running tests for an empty diff", async () => {
    const captured: PrimaryGateStepRequest[] = [];
    const verdict = await runPrimaryGate({
      ...BASE_GATE_OPTS,
      changedFiles: [],
      runStep: recordingPassRunner(captured),
    });

    expect(verdict.affectedScope).toEqual({ kind: "empty" });
    expect(verdict.affectedTestCount).toBe(0);
    // No affected-tests child was spawned (nothing resolved to run).
    expect(captured.some((r) => r.id === "affected-tests")).toBe(false);
  });
});
