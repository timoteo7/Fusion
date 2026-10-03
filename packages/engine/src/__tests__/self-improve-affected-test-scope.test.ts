import { describe, expect, it } from "vitest";
import { resolveAffectedTestScope } from "../self-improve/affected-test-scope.js";

/*
FNXC:SelfImproveAffectedTestScope 2026-09-30-09:15:
Behavioral coverage for the gate's affected-test resolver. Each case below is one of the five
guarantees the primary gate depends on: per-file scoping (never full-workspace), deleted test paths
yield no live entry, an empty diff is an explicit state, a vitest config change fans out to its
package, and a single-file diff never resolves to every test in the repo. These assert OBSERVABLE
resolution results, never source text.
*/

// A two-package inventory. Keeping it tiny and explicit is the point: a resolver that returned
// "all tests" would immediately be visible here as an over-broad list.
const PACKAGE_NAME_BY_DIR = new Map<string, string>([
  ["packages/engine", "@fusion/engine"],
  ["packages/core", "@fusion/core"],
]);

const ENGINE_TESTS = [
  "packages/engine/src/__tests__/alpha.test.ts",
  "packages/engine/src/__tests__/beta.test.ts",
] as const;

const CORE_TESTS = ["packages/core/src/__tests__/gamma.test.ts"] as const;

function listLiveTestFiles(packageName: string): readonly string[] {
  if (packageName === "@fusion/engine") return ENGINE_TESTS;
  if (packageName === "@fusion/core") return CORE_TESTS;
  return [];
}

describe("resolveAffectedTestScope", () => {
  it("resolves an engine source change to only engine tests", () => {
    const scope = resolveAffectedTestScope({
      changedFiles: ["packages/engine/src/self-improve/primary-gate.ts"],
      packageNameByDir: PACKAGE_NAME_BY_DIR,
      listLiveTestFiles,
    });

    expect(scope).toEqual({
      kind: "resolved",
      testFiles: [...ENGINE_TESTS].sort(),
      packages: ["@fusion/engine"],
    });
  });

  it("never returns every test in the workspace for a one-file diff", () => {
    const scope = resolveAffectedTestScope({
      changedFiles: ["packages/core/src/self-improve/ledger-schema.ts"],
      packageNameByDir: PACKAGE_NAME_BY_DIR,
      listLiveTestFiles,
    });

    // A one-file diff must not fan out across packages.
    expect(scope).toEqual({
      kind: "resolved",
      testFiles: [...CORE_TESTS],
      packages: ["@fusion/core"],
    });
    // The engine tests must NOT appear even though they exist in the same repo.
    if (scope.kind === "resolved") {
      expect(scope.testFiles).not.toContain("packages/engine/src/__tests__/alpha.test.ts");
    }
  });

  it("yields no live entry for a deleted test path instead of handing it to Vitest", () => {
    // "deleted.test.ts" is in the diff but is NOT in the live inventory — it was deleted.
    const scope = resolveAffectedTestScope({
      changedFiles: ["packages/engine/src/__tests__/deleted.test.ts"],
      packageNameByDir: PACKAGE_NAME_BY_DIR,
      listLiveTestFiles,
    });

    // The deleted file is not a live test, and since a test-path change does not pull the whole
    // package (it IS the test), the resolved set stays empty rather than naming a nonexistent file.
    expect(scope).toEqual({ kind: "empty" });
  });

  it("keeps a modified (still-live) test path in the resolved set", () => {
    const scope = resolveAffectedTestScope({
      changedFiles: ["packages/engine/src/__tests__/alpha.test.ts"],
      packageNameByDir: PACKAGE_NAME_BY_DIR,
      listLiveTestFiles,
    });

    expect(scope).toEqual({
      kind: "resolved",
      testFiles: ["packages/engine/src/__tests__/alpha.test.ts"],
      packages: ["@fusion/engine"],
    });
  });

  it("returns an explicit empty state for an empty diff", () => {
    const scope = resolveAffectedTestScope({
      changedFiles: [],
      packageNameByDir: PACKAGE_NAME_BY_DIR,
      listLiveTestFiles,
    });

    expect(scope).toEqual({ kind: "empty" });
  });

  it("fans a changed vitest config out to its package's tests", () => {
    const scope = resolveAffectedTestScope({
      changedFiles: ["packages/engine/vitest.config.ts"],
      packageNameByDir: PACKAGE_NAME_BY_DIR,
      listLiveTestFiles,
    });

    expect(scope).toEqual({
      kind: "resolved",
      testFiles: [...ENGINE_TESTS].sort(),
      packages: ["@fusion/engine"],
    });
  });

  it("classifies a shared test-infrastructure change as shared-infra, not a full run", () => {
    const scope = resolveAffectedTestScope({
      changedFiles: ["vitest.workspace.ts"],
      packageNameByDir: PACKAGE_NAME_BY_DIR,
      listLiveTestFiles,
    });

    expect(scope).toEqual({
      kind: "shared-infra",
      reason: "shared-test-infrastructure-changed",
    });
    // A shared-infra scope must never carry a resolved list that could be mistaken for full-suite.
    expect(scope).not.toHaveProperty("testFiles");
  });

  it("does not trip shared-infra for a root markdown or changeset edit", () => {
    const scope = resolveAffectedTestScope({
      changedFiles: ["README.md", ".changeset/quiet-hamster.md"],
      packageNameByDir: PACKAGE_NAME_BY_DIR,
      listLiveTestFiles,
    });

    // These resolve to no package and no tests — an explicit empty, never a shared-infra full run.
    expect(scope).toEqual({ kind: "empty" });
  });
});
