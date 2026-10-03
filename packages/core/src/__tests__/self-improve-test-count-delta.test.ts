import { describe, expect, it } from "vitest";
import {
  buildTestCountSnapshot,
  createTestCountBaseline,
  evaluateTestCountDelta,
  fingerprintSnapshot,
} from "../self-improve/test-count-delta.js";
import type { VitestJsonReport } from "../self-improve/test-count-delta.js";

/*
FNXC:SelfImproveTestCountDelta 2026-09-30-12:39:
These tests pin the verdict contract the primary gate consumes, driven entirely through the public
exports. They assert on RETURNED values only — never on source text, comments, or file contents — so
a refactor that keeps the behavior cannot break them and a comment rewrite cannot "fix" them.

Every fixture here goes through the real `buildTestCountSnapshot` from a vitest-JSON-shaped payload
rather than hand-rolling a `TestCountSnapshot`, so the tests also cover the snapshot derivation: that
non-executed counts come from per-assertion `status` and that the inventory id is `name::fullName`.
The one exception is the pure-add case, which adds a new file and is therefore most naturally built
by appending a file to a report fixture.
*/

const FILE_A = "packages/core/src/__tests__/alpha.test.ts";
const FILE_B = "packages/core/src/__tests__/beta.test.ts";
/** A stand-in absolute repo root, so path normalization is exercised without touching the disk. */
const REPO_ROOT = "/home/z690/ai_solutions/Fusion";

/** Build a vitest-JSON-shaped report from `[file, [ [fullName, status], ... ]]` pairs. */
const report = (files: [string, [string, string][]][]): VitestJsonReport => ({
  testResults: files.map(([name, assertions]) => ({
    name,
    assertionResults: assertions.map(([fullName, status]) => ({ fullName, status })),
  })),
});

const baselineReport = report([
  [FILE_A, [
    ["alpha > one", "passed"],
    ["alpha > two", "passed"],
    ["alpha > three", "passed"],
  ]],
]);

const candidateOf = (r: VitestJsonReport) => buildTestCountSnapshot(r);

describe("self-improve test-count delta guard", () => {
  describe("removal is a regression even when every remaining test passed", () => {
    it("rejects a candidate that deletes a test, with reason test-removed", () => {
      const baseline = createTestCountBaseline(candidateOf(baselineReport));
      // "alpha > three" deleted; the two survivors are green, so failed === 0.
      const candidate = candidateOf(
        report([[FILE_A, [["alpha > one", "passed"], ["alpha > two", "passed"]]]]),
      );
      expect(candidate.failed).toBe(0);

      const verdict = evaluateTestCountDelta({ baseline, candidate });
      expect(verdict.ok).toBe(false);
      expect(verdict.reasons).toContain("test-removed");
      expect(verdict.removedCount).toBe(1);
    });
  });

  describe("skip is a regression even when every remaining test passed", () => {
    it("rejects a candidate that flips a test to skipped, with reason test-skipped", () => {
      const baseline = createTestCountBaseline(candidateOf(baselineReport));
      // Same inventory (the test is still collected) but "alpha > three" no longer runs.
      const candidate = candidateOf(
        report([[FILE_A, [
          ["alpha > one", "passed"],
          ["alpha > two", "passed"],
          ["alpha > three", "skipped"],
        ]]]),
      );
      expect(candidate.failed).toBe(0);

      const verdict = evaluateTestCountDelta({ baseline, candidate });
      expect(verdict.ok).toBe(false);
      expect(verdict.reasons).toContain("test-skipped");
      expect(verdict.skippedDelta).toBe(1);
    });
  });

  describe("a collected-count drop is a regression", () => {
    it("rejects a candidate whose total is below the baseline with test-count-regressed", () => {
      const baseline = createTestCountBaseline(candidateOf(baselineReport));
      // Two of three collected (one lost) and the survivors pass.
      const candidate = candidateOf(
        report([[FILE_A, [["alpha > one", "passed"], ["alpha > two", "passed"]]]]),
      );
      expect(candidate.total).toBeLessThan(baseline.snapshot.total);

      const verdict = evaluateTestCountDelta({ baseline, candidate });
      expect(verdict.reasons).toContain("test-count-regressed");
      expect(verdict.totalDelta).toBeLessThan(0);
    });
  });

  describe("pure additions pass", () => {
    it("accepts a candidate that only adds tests", () => {
      const baseline = createTestCountBaseline(candidateOf(baselineReport));
      const candidate = candidateOf(
        report([
          [FILE_A, [
            ["alpha > one", "passed"],
            ["alpha > two", "passed"],
            ["alpha > three", "passed"],
          ]],
          [FILE_B, [["beta > only", "passed"]]],
        ]),
      );

      const verdict = evaluateTestCountDelta({ baseline, candidate });
      expect(verdict.ok).toBe(true);
      expect(verdict.reasons).toEqual([]);
      expect(verdict.addedCount).toBe(1);
    });

    it("accepts an unchanged candidate (baseline identical to candidate)", () => {
      const snapshot = candidateOf(baselineReport);
      const baseline = createTestCountBaseline(snapshot);
      const verdict = evaluateTestCountDelta({ baseline, candidate: snapshot });
      expect(verdict.ok).toBe(true);
      expect(verdict.reasons).toEqual([]);
      expect(verdict.removedCount).toBe(0);
    });
  });

  describe("quarantine exemption for the deletion ratchet", () => {
    it("exempts a removal whose file is listed in the quarantine ledger", () => {
      const baselineReportWithB = report([
        [FILE_A, [["alpha > one", "passed"], ["alpha > two", "passed"]]],
        [FILE_B, [["beta > doomed", "passed"]]],
      ]);
      const baseline = createTestCountBaseline(candidateOf(baselineReportWithB));
      // FILE_B is deleted outright — exactly what the 14-day ratchet does by design.
      const candidate = candidateOf(
        report([[FILE_A, [["alpha > one", "passed"], ["alpha > two", "passed"]]]]),
      );

      const withQuarantine = evaluateTestCountDelta({
        baseline,
        candidate,
        quarantinedFiles: [{ file: FILE_B, quarantinedAt: "2026-09-16", reason: "flake" }],
      });
      // The removal is exempt from BOTH `test-removed` and `test-count-regressed`, so a
      // ledger-sanctioned deletion passes outright rather than trading one failing reason for
      // another. This is the deletion-ratchet deadlock the exemption exists to prevent.
      expect(withQuarantine.ok).toBe(true);
      expect(withQuarantine.reasons).toEqual([]);
      expect(withQuarantine.removedCount).toBe(0);
      // The reported delta is net of the quarantined file, so the number explains the verdict.
      expect(withQuarantine.totalDelta).toBe(0);

      // Without the ledger entry the same deletion IS a regression — the exemption cannot be
      // widened to an unlisted file.
      const withoutQuarantine = evaluateTestCountDelta({ baseline, candidate });
      expect(withoutQuarantine.ok).toBe(false);
      expect(withoutQuarantine.reasons).toContain("test-removed");
      expect(withoutQuarantine.reasons).toContain("test-count-regressed");
    });

    it("matches a repo-relative ledger entry against an absolute reporter path", () => {
      // vitest's JSON reporter records `testResults[].name` as an absolute path, while the ledger
      // stores repo-relative paths. The exemption must survive that mismatch or it never applies
      // in production, re-creating the deadlock behind a guard that looks like it has an escape hatch.
      const absoluteB = `${REPO_ROOT}/${FILE_B}`;
      const absoluteA = `${REPO_ROOT}/${FILE_A}`;
      const baseline = createTestCountBaseline(
        candidateOf(report([
          [absoluteA, [["alpha > one", "passed"], ["alpha > two", "passed"]]],
          [absoluteB, [["beta > doomed", "passed"]]],
        ])),
      );
      const candidate = candidateOf(
        report([[absoluteA, [["alpha > one", "passed"], ["alpha > two", "passed"]]]]),
      );

      // Repo-relative ledger entry, no explicit repoRoot: resolved by the path-boundary fallback.
      const byFallback = evaluateTestCountDelta({
        baseline,
        candidate,
        quarantinedFiles: [{ file: FILE_B, quarantinedAt: "2026-09-16", reason: "flake" }],
      });
      expect(byFallback.ok).toBe(true);
      expect(byFallback.reasons).toEqual([]);

      // Same inputs with an explicit repoRoot: resolved by prefix-stripping to the ledger key.
      const byRepoRoot = evaluateTestCountDelta({
        baseline,
        candidate,
        repoRoot: REPO_ROOT,
        quarantinedFiles: [{ file: FILE_B, quarantinedAt: "2026-09-16", reason: "flake" }],
      });
      expect(byRepoRoot.ok).toBe(true);
      expect(byRepoRoot.reasons).toEqual([]);
    });

    it("does not let a boundary-suffix entry exempt an unrelated file", () => {
      // The fallback matches on a `/`-anchored suffix, so a bare basename entry can never match a
      // different file that happens to share it, and an unrelated file stays a regression.
      const baseline = createTestCountBaseline(
        candidateOf(report([
          [FILE_A, [["alpha > one", "passed"], ["alpha > two", "passed"]]],
          [FILE_B, [["beta > doomed", "passed"]]],
        ])),
      );
      const candidate = candidateOf(
        report([[FILE_A, [["alpha > one", "passed"], ["alpha > two", "passed"]]]]),
      );
      // Only alpha is on the ledger; the actual deletion is beta, which is unlisted.
      const verdict = evaluateTestCountDelta({
        baseline,
        candidate,
        quarantinedFiles: [{ file: FILE_A, quarantinedAt: "2026-09-16", reason: "flake" }],
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.reasons).toContain("test-removed");
    });
  });

  describe("determinism and fingerprint reproducibility", () => {
    it("returns an identical verdict AND fingerprint on repeat evaluation of the same inputs", () => {
      const baseline = createTestCountBaseline(candidateOf(baselineReport));
      const candidate = candidateOf(
        report([[FILE_A, [["alpha > one", "passed"], ["alpha > two", "passed"]]]]),
      );
      const first = evaluateTestCountDelta({ baseline, candidate });
      const second = evaluateTestCountDelta({ baseline, candidate });
      expect(second).toEqual(first);
      expect(second.fingerprint).toBe(first.fingerprint);
    });

    it("fingerprints the same snapshot identically regardless of assertion ordering", () => {
      const forward = candidateOf(
        report([[FILE_A, [["alpha > one", "passed"], ["alpha > two", "passed"]]]]),
      );
      const reversed = candidateOf(
        report([[FILE_A, [["alpha > two", "passed"], ["alpha > one", "passed"]]]]),
      );
      expect(fingerprintSnapshot(reversed)).toBe(fingerprintSnapshot(forward));
    });
  });

  describe("no-test / empty candidate is deterministic and does not throw", () => {
    it("handles an empty candidate against a non-empty baseline", () => {
      const baseline = createTestCountBaseline(candidateOf(baselineReport));
      const empty = candidateOf({ testResults: [] });
      expect(empty.total).toBe(0);

      const verdict = evaluateTestCountDelta({ baseline, candidate: empty });
      expect(verdict.ok).toBe(false);
      expect(verdict.reasons).toContain("test-count-regressed");
      expect(verdict.reasons).toContain("test-removed");
    });

    it("handles an empty baseline and empty candidate as a pass", () => {
      const empty = candidateOf({ testResults: [] });
      const baseline = createTestCountBaseline(empty);
      const verdict = evaluateTestCountDelta({ baseline, candidate: empty });
      expect(verdict.ok).toBe(true);
      expect(verdict.reasons).toEqual([]);
    });

    it("accepts a null/undefined report without throwing", () => {
      expect(() => buildTestCountSnapshot(null)).not.toThrow();
      expect(buildTestCountSnapshot(undefined).total).toBe(0);
    });
  });
});
