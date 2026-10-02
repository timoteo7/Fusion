/**
 * FNXC:TaskLogStructureAwareTruncation 2026-09-28-08:40:
 *
 * A failed merge must say why it failed. Before this suite, task-log truncation
 * kept only the HEAD of an outcome, so a `git rebase` that printed 74 near-
 * identical `warning: skipped previously applied commit <sha>` lines spent the
 * whole 4,000-character budget on them and the trailing `Could not apply
 * <sha>...` — the actual reason — was never persisted. The card was
 * permanently undiagnosable from its own log, and the untruncated `action`
 * field simultaneously carried the same 5 KB of duplicated stderr.
 *
 * The invariant under test is a PROPERTY, not an offset: if the input contained
 * a failure diagnostic, the diagnostic survives compaction. Each case is checked
 * by asserting the diagnostic is still present, so the tests stay valid as the
 * budget or the compaction shape changes.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __setTaskActivityLogLimitsForTesting,
  compactTaskActivityLog,
  truncateTaskLogAction,
  truncateTaskLogOutcome,
} from "../task-store/comments.js";

/** Deterministic unique shas so a collapse assertion is stable across runs. */
function sha(index: number): string {
  const body = index.toString(16).padStart(8, "0");
  return `${body}1f3c9d7a`.slice(0, 9);
}

/**
 * The real shape measured on FUSI-030: a rebase whose first ~4,000 characters are
 * skip warnings and whose fatal line is last.
 */
function rebaseFailureOutcome(warningCount = 74): string {
  const warnings = Array.from({ length: warningCount }, (_, i) => `warning: skipped previously applied commit ${sha(i)}`);
  return [
    "Command failed: git rebase 'c3895941659139b4a0b6aeae12897c4b4ae6781f'",
    ...warnings,
    "Rebasing (1/118)",
    "error: could not apply 7f51f79f2... test: restore workflow and lifecycle gate fixtures (#3557)",
    "CONFLICT (content): Merge conflict in packages/core/src/task-store/comments.ts",
    'hint: "git add/rm <conflicted_files>", then run "git rebase --continue".',
    "Could not apply 7f51f79f2... # test: restore workflow and lifecycle gate fixtures (#3557)",
  ].join("\n");
}

/** The other class measured on the same card: a vitest summary, reason at the tail. */
function testRunnerFailureOutcome(): string {
  const filler = Array.from({ length: 120 }, (_, i) => `Read the specification section ${i} and confirmed the plan was internally consistent.`);
  return [
    ...filler,
    "FAIL  src/__tests__/lifecycle-move-reason-census.test.ts > census > counts every backward move",
    "AssertionError: expected 52 to be 53 // Object.is equality",
    "    at src/__tests__/lifecycle-move-reason-census.test.ts:118:24",
    " Test Files  1 failed (119 passed)",
    "      Tests  1 failed | 1,204 passed (1,205)",
  ].join("\n");
}

afterEach(() => {
  __setTaskActivityLogLimitsForTesting(null);
});

describe("task log structure-aware truncation — invariant", () => {
  it("keeps a rebase failure's reason readable when the input is over the cap", () => {
    const outcome = rebaseFailureOutcome();
    expect(outcome.length).toBeGreaterThan(4_000);

    const compacted = truncateTaskLogOutcome(outcome);

    // The invariant: the diagnostic survives. Not an offset — a presence check.
    expect(compacted ?? "").toContain("Could not apply 7f51f79f2");
    expect(compacted ?? "").toContain("CONFLICT (content): Merge conflict in packages/core/src/task-store/comments.ts");
    // The command that failed is still named, from the head.
    expect(compacted ?? "").toContain("git rebase");
    // The repeated noise collapses to a counted line rather than 74 lines.
    expect(compacted).toMatch(/74 similar lines \(first /);
  });

  it("collapses the near-identical warning run to a count with first and last sha", () => {
    const compacted = truncateTaskLogOutcome(rebaseFailureOutcome());
    const collapsedLine = (compacted ?? "").split("\n").find((line) => line.includes("similar lines"));
    expect(collapsedLine).toBeDefined();
    expect(collapsedLine).toContain("74");
    expect(collapsedLine).toContain(sha(0));
    expect(collapsedLine).toContain(sha(73));
    // 74 near-identical lines must not survive as 74 lines.
    expect((compacted ?? "").split("\n").filter((line) => line.includes("skipped previously applied commit"))).toHaveLength(1);
  });

  it("keeps a test-runner failure's reason readable (the other measured class)", () => {
    const outcome = testRunnerFailureOutcome();
    expect(outcome.length).toBeGreaterThan(4_000);

    const compacted = truncateTaskLogOutcome(outcome);

    expect(compacted).toContain("AssertionError: expected 52 to be 53");
    expect(compacted).toContain("lifecycle-move-reason-census.test.ts");
    expect(compacted).toContain("Test Files  1 failed");
  });

  it("still applies the plain head cut, with the historical marker, to ordinary over-cap prose", () => {
    const prose = `${Array.from({ length: 300 }, (_, i) => `Observation number ${i} about the plan.`).join("\n")}`;
    const compacted = truncateTaskLogOutcome(prose);
    expect(compacted).toContain("... outcome truncated to 4000 characters ...");
  });
});

describe("task log structure-aware truncation — control", () => {
  it("passes a short ordinary outcome through byte-identical", () => {
    const short = "Plan Review completed";
    const result = truncateTaskLogOutcome(short);
    expect(result).toBe(short);
    expect(result).not.toContain("truncated");
    expect(result).not.toContain("compacted");
    // No re-wrapping, no added newline.
    expect(result?.length).toBe(short.length);
    expect(result).not.toMatch(/\n/);
  });

  it("passes a 120-character git status line through byte-identical", () => {
    const status = `On branch fusion/fusi-047\nYour branch is up to date with 'origin/fusion/fusi-047'.\nnothing to commit, working tree clean`;
    expect(status.length).toBeLessThan(200);
    expect(truncateTaskLogOutcome(status)).toBe(status);
  });

  it("keeps undefined as undefined", () => {
    expect(truncateTaskLogOutcome(undefined)).toBeUndefined();
  });

  it("passes a short action through byte-identical", () => {
    const action = "In-review stall surfaced [merge-retries-exhausted]: Auto-merge retries exhausted (3/3) without confirmed merge";
    expect(truncateTaskLogAction(action)).toBe(action);
  });
});

describe("task log structure-aware truncation — small injected cap", () => {
  it("holds the invariant at a 200-character cap, not just at 4,000", () => {
    __setTaskActivityLogLimitsForTesting({ outcomeLimit: 200 });
    const compacted = truncateTaskLogOutcome(rebaseFailureOutcome());
    expect(compacted).toContain("Could not apply 7f51f79f2");
  });

  it("rejects a non-integer or sub-1 actionLimit rather than silently accepting it", () => {
    expect(() => __setTaskActivityLogLimitsForTesting({ actionLimit: 0 })).toThrow(/actionLimit/);
    expect(() => __setTaskActivityLogLimitsForTesting({ actionLimit: 1.5 })).toThrow(/actionLimit/);
  });
});

describe("task log structure-aware truncation — idempotence", () => {
  it("does not re-truncate or double-collapse an already-compacted entry", () => {
    // `compactTaskActivityLog` re-applies the same compaction on the
    // workflow-definition read path, so this must be a no-op.
    const once = truncateTaskLogOutcome(rebaseFailureOutcome()) ?? "";
    const twice = truncateTaskLogOutcome(once);
    expect(twice).toBe(once);
    expect((twice ?? "").split("\n").filter((line) => line.includes("similar lines"))).toHaveLength(1);
  });

  it("is idempotent through compactTaskActivityLog, and bounds the action field too", () => {
    const entries = [{
      timestamp: "2026-09-26T00:25:08.976Z",
      action: `Manual-merge failed: ${rebaseFailureOutcome()}`,
      outcome: `Error\n${rebaseFailureOutcome()}`,
    }];
    const once = compactTaskActivityLog(entries);
    const twice = compactTaskActivityLog(once);
    expect(twice).toEqual(once);
    expect(once[0]?.action).toContain("Could not apply 7f51f79f2");
    expect(once[0]?.outcome).toContain("Could not apply 7f51f79f2");
  });
});

describe("task log structure-aware truncation — action field", () => {
  it("keeps the leading sentence verbatim and bounds the payload", () => {
    const action = `Manual-merge failed: ${rebaseFailureOutcome()}`;
    const compacted = truncateTaskLogAction(action);
    expect(compacted.startsWith("Manual-merge failed: ")).toBe(true);
    expect(compacted).toContain("Could not apply 7f51f79f2");
    expect(compacted.length).toBeLessThan(action.length);
  });

  it("keeps the in-review-stall prefix matcher working on a re-shaped action", () => {
    // Mirrors IN_REVIEW_STALL_LOG_REGEX in packages/dashboard/app/utils.
    const regex = /^In-review stall surfaced \[([^\]]+)\]/;
    const longStall = `In-review stall surfaced [merge-retries-exhausted]: ${Array.from({ length: 200 }, (_, i) => `detail ${i}`).join(" ")}`;
    const compacted = truncateTaskLogAction(longStall);
    const match = compacted.match(regex);
    expect(match?.[1]).toBe("merge-retries-exhausted");
  });

  it("collapses a genuinely verbatim-identical run too", () => {
    // 120 identical lines so the input actually exceeds the cap; the run is
    // byte-for-byte the same, which is the same case as "near"-identical.
    const verbatim = Array.from({ length: 120 }, () => "warning: skipped previously applied commit deadbeefcafe").join("\n");
    expect(verbatim.length).toBeGreaterThan(4_000);
    const compacted = truncateTaskLogOutcome(verbatim);
    expect(compacted).toMatch(/120 similar lines \(first deadbeefcafe, last deadbeefcafe\)/);
  });
});
