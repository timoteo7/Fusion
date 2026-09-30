import { createHash } from "node:crypto";

/*
FNXC:SelfImproveTestCountDelta 2026-09-30-12:39:
The test-count delta guard is the MEASURING rule of the primary gate (FUSI-016), and this module is
the only place that decides what a test run MEANS for coverage. It is pure: it receives two already
captured snapshots and returns a boolean verdict with a fixed-enum reason list. It never runs
vitest, never spawns a process, never reads the filesystem, never persists a baseline, and never
emits run-audit. Those belong to the gate runner that CONSUMES this verdict.

FNXC:SelfImproveTestCountDelta 2026-09-30-12:39:
The guard exists because a fully green run proves the tests that RAN passed — it says nothing about
the tests that were deleted, commented out, or flipped to `.skip` to make the run green. A
coverage-destroying change is therefore invisible to build/lint/typecheck/gate/affected-tests, all
of which are green in exactly the case that matters. Counting the inventory and comparing it to a
recorded baseline closes that hole: removal and skip are regressions in their own right, checked
independently of whether the remaining tests passed.

FNXC:SelfImproveTestCountDelta 2026-09-30-12:39:
`TestCountDeltaReason` is a CLOSED enum, never prose, for the same reason
`LearningRevertReason`/`LearningProposalState` are: this verdict is consumed by a bounded run-audit
row and a persisted ledger event whose metadata is ids/counts/fixed outcomes only. A free-text
reason would make "why was this reverted?" unclassifiable and would widen the audit surface. The
consumer maps these three values onto its own storage; this module never widens them.

FNXC:SelfImproveTestCountDelta 2026-09-30-12:39:
Non-executed tests are counted from the PER-ASSERTION `status`, never from the aggregate
`numPendingTests` / `numTodoTests` counters. Those aggregates also count tests that were merely
queued or still running, so a slow-but-healthy run inflates them; deriving the count from
`assertionResults[].status` makes "skipped" mean exactly "collected and deliberately not executed".
A consequence worth stating: `total` here is the number of COLLECTED assertions, so a file that
failed to collect contributes nothing to any count and is invisible to this guard. Collection
failures are the gate runner's `affected-tests` signal, not a coverage-delta concern.

FNXC:SelfImproveTestCountDelta 2026-09-30-12:39:
The fingerprint is CLOCK-FREE and ORDER-FREE by construction. It hashes a canonical serialization of
the counts plus the inventory ids sorted with a total order, and it deliberately EXCLUDES
`startTime`, `endTime`, and `duration` from the reporter payload — a wall-clock field would make the
fingerprint of an identical test run differ on every invocation and destroy the gate's core promise
that the same candidate at the same manifest+seed yields an identical verdict and fingerprint.
`sha256:<hex>` mirrors the existing core convention in task-document-concurrency.ts.

FNXC:SelfImproveTestCountDelta 2026-09-30-12:39:
Removal is exempt ONLY for files actually present in the quarantine ledger. This is a deliberate
escape hatch, not a weakening: the quarantine deletion ratchet (AGENTS.md "Flaky tests are
quarantined on sight") DELETES a quarantined test file 14 days after `quarantinedAt` by design. A
count-delta guard with no exemption would fail every one of those sanctioned deletions, and the two
mechanisms would deadlock — a ratcheted file could never be deleted because deleting it would fail
the gate. The exemption is keyed on the ledger listing that exact file, so a developer cannot widen
`ok` by claiming a quarantine for an unrelated removal: an unlisted file still yields `test-removed`.
This mirrors the deadlock `scripts/check-test-inventory.mjs` documents in its `--diff` help text.

FNXC:SelfImproveTestCountDelta 2026-09-30-13:05:
The quarantine exemption must net BOTH rules that a file deletion trips, not just `test-removed`.
Deleting a quarantined file removes its inventory ids AND lowers the collected-assertion count, so
narrowing only the removal reason still left `test-count-regressed` firing and `ok` false — the
ratchet would still deadlock, contradicting the note above. This is the same netting
`check-test-inventory.mjs` prescribes for its `--diff` ("diff against 'snapshot minus quarantined
entries'"): a quarantined file's assertions are subtracted from the count comparison, not merely
excused from the removal reason. `totalDelta` therefore reports the quarantine-EXEMPTED collected
delta, so the number a consumer reads always explains the verdict it was given. `skippedDelta` is
deliberately NOT netted: the ratchet deletes a whole file, which creates no new skips, so netting it
would change a rule the exemption never needed to touch.

FNXC:SelfImproveTestCountDelta 2026-09-30-13:05:
The ledger stores REPO-RELATIVE paths (`scripts/lib/test-quarantine.json`, validated against real
files by `check-quarantine-ledger.mjs`) while vitest's JSON reporter typically records
`testResults[].name` as an ABSOLUTE path. Comparing the two verbatim never matches, so the
exemption would silently never apply in production — the deadlock would persist behind a guard
that appears to have an escape hatch. This module stays pure (no filesystem reads), so it cannot
derive the repo root itself; the caller passes `repoRoot` and this module strips that prefix, and
where no root is supplied it still matches a repo-relative ledger entry as a path-boundary SUFFIX of
an absolute id. Matching is boundary-anchored on a `/`, so an entry for `beta.test.ts` can never
exempt `/x/y/alpha.test.ts`, and a repo-relative id is matched by exact equality only.

FNXC:SelfImproveTestCountDelta 2026-09-30-12:39:
The skip rule is a DIRECTIONAL count, not a per-id flip. `test-skipped` fires when the candidate's
non-executed total exceeds the baseline's, which catches a `.skip` conversion regardless of whether
the total count happens to stay flat. It does NOT fire when a baseline test was already skipped and
remains skipped, so the guard cannot be tripped by pre-existing skips; only a NEW non-executed
assertion is a regression.
*/

/** One assertion as emitted by vitest's JSON reporter, narrowed to the fields this guard reads. */
export interface VitestJsonAssertion {
  /** Fully-qualified assertion name, e.g. `"suite > case"`. */
  fullName: string;
  /** Per-assertion outcome. Non-executed members are the skip/todo/pending/disabled statuses. */
  status?: string;
}

/** One test FILE's results, narrowed to the fields this guard reads. */
export interface VitestJsonTestFile {
  /** Repo-relative or absolute path of the test file, as the reporter recorded it. */
  name: string;
  assertionResults?: VitestJsonAssertion[];
}

/**
 * The shape of a vitest JSON reporter payload, narrowed to what this guard reads.
 *
 * The aggregate `num*` counters are declared but deliberately never read (see the FNXC note above);
 * they are listed so a caller can pass a real reporter payload through unaltered.
 */
export interface VitestJsonReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  testResults?: VitestJsonTestFile[];
}

/** A test status that means "collected, but deliberately NOT executed". */
export type TestCountNonExecutedStatus = "skipped" | "todo" | "disabled" | "pending";

/** Every status that means the assertion did not run. Mirrors vitest's `Status` union. */
export const TEST_COUNT_NON_EXECUTED_STATUSES: readonly TestCountNonExecutedStatus[] = [
  "skipped",
  "todo",
  "disabled",
  "pending",
];

/** One recorded test run, normalized into the counts the guard compares. */
export interface TestCountSnapshot {
  /** Assertions collected, executed or not. Never derived from `numTotalTests`. */
  total: number;
  /** Assertions whose per-assertion status is `passed`. */
  passed: number;
  /** Assertions whose per-assertion status is `failed`. */
  failed: number;
  /** Assertions deliberately not executed (skipped/todo/disabled/pending), by status. */
  nonExecuted: Readonly<Record<TestCountNonExecutedStatus, number>>;
  /** Sorted, de-duplicated inventory ids of the EXECUTED assertions only. */
  executedIds: readonly string[];
  /** Sorted, de-duplicated inventory ids of the NON-EXECUTED assertions only. */
  nonExecutedIds: readonly string[];
}

/**
 * Every inventory id a snapshot knows about, executed or not.
 *
 * "Missing from the candidate" is measured against this union, not against `executedIds` alone: a
 * test flipped to `.skip` is still PRESENT in the candidate, it simply moved from one array to the
 * other. Measuring removal against the union is what keeps `test-removed` (the test is gone) and
 * `test-skipped` (the test is there but no longer runs) disjoint instead of double-reporting every
 * skip as both.
 */
function inventoryIds(snapshot: TestCountSnapshot | null | undefined): Set<string> {
  return new Set([...(snapshot?.executedIds ?? []), ...(snapshot?.nonExecutedIds ?? [])]);
}

/** A recorded baseline: the snapshot plus its reproducible fingerprint. */
export interface TestCountBaseline {
  snapshot: TestCountSnapshot;
  /** `sha256:<hex>` over the snapshot's counts and sorted ids. Clock-free. */
  fingerprint: string;
}

/** Why a candidate run regressed against its baseline. A closed enum; never prose. */
export type TestCountDeltaReason =
  /** The candidate collected fewer assertions than the baseline did, net of quarantine-listed files. */
  | "test-count-regressed"
  /** A baseline inventory id is absent from the candidate, net of quarantine exemptions. */
  | "test-removed"
  /** The candidate's non-executed count EXCEEDS the baseline's, i.e. a newly disabled test. */
  | "test-skipped";

/** Every legal delta reason, in evaluation order. */
export const TEST_COUNT_DELTA_REASONS: readonly TestCountDeltaReason[] = [
  "test-count-regressed",
  "test-removed",
  "test-skipped",
];

/** True when `value` is one of the fixed delta reasons. Guards callers building a verdict by hand. */
export function isTestCountDeltaReason(value: unknown): value is TestCountDeltaReason {
  return typeof value === "string" && (TEST_COUNT_DELTA_REASONS as readonly string[]).includes(value);
}

/** One entry of the quarantine ledger (`scripts/lib/test-quarantine.json`). */
export interface TestCountQuarantineEntry {
  file: string;
  quarantinedAt?: string;
  reason?: string;
}

/** The verdict of comparing a candidate run against its baseline. */
export interface TestCountDeltaVerdict {
  /** True only when `reasons` is empty. */
  ok: boolean;
  /** The fired reasons, in `TEST_COUNT_DELTA_REASONS` order. Empty when `ok`. */
  reasons: readonly TestCountDeltaReason[];
  /** Baseline executed ids absent from the candidate, net of quarantine exemptions. */
  removedCount: number;
  /** Candidate executed ids absent from the baseline (a pure addition). */
  addedCount: number;
  /** `candidate.nonExecutedTotal - baseline.nonExecutedTotal`. Negative means fewer were skipped. */
  skippedDelta: number;
  /**
   * `candidate.total - baseline.total`, computed NET of quarantine-listed files on both sides.
   * Negative is a collected-count regression and the reason `test-count-regressed` fires; a
   * quarantine-exempted deletion reports `0` here, consistent with the verdict it produced.
   */
  totalDelta: number;
  /** The candidate snapshot's fingerprint. Identical inputs always yield an identical value. */
  fingerprint: string;
}

/** True when a per-assertion `status` means "collected, but deliberately not executed". */
function isNonExecutedStatus(status: string | undefined): status is TestCountNonExecutedStatus {
  return (
    typeof status === "string" &&
    (TEST_COUNT_NON_EXECUTED_STATUSES as readonly string[]).includes(status)
  );
}

/** Total assertions deliberately not executed, across every non-executed status. */
function nonExecutedTotal(snapshot: TestCountSnapshot): number {
  return TEST_COUNT_NON_EXECUTED_STATUSES.reduce(
    (sum, status) => sum + (snapshot.nonExecuted[status] || 0),
    0,
  );
}

/**
 * Derive the inventory id of one assertion.
 *
 * `name + "::" + fullName` mirrors the `testId` construction in `scripts/check-test-inventory.mjs`
 * so the two harnesses agree on what identifies a test. The file path is normalized to forward
 * slashes so an id captured on one platform matches one captured on another.
 */
function assertionId(file: string, fullName: string): string {
  return `${file.replace(/\\/g, "/")}::${fullName}`;
}

/**
 * Build a normalized snapshot from a vitest JSON reporter payload.
 *
 * Deterministic and clock-free: the aggregate `num*` counters are ignored, every count is derived
 * from `testResults[].assertionResults[].status`, and both id arrays are sorted and de-duplicated so
 * reporter ordering cannot change the result. Never throws — a payload with no `testResults` (a
 * no-test run, a failed collection) yields an all-zero snapshot rather than crashing the gate.
 */
export function buildTestCountSnapshot(report: VitestJsonReport | null | undefined): TestCountSnapshot {
  const files = Array.isArray(report?.testResults) ? report.testResults : [];
  const executed = new Set<string>();
  const nonExecuted = new Set<string>();
  const byStatus: Record<TestCountNonExecutedStatus, number> = {
    skipped: 0,
    todo: 0,
    disabled: 0,
    pending: 0,
  };
  let passed = 0;
  let failed = 0;

  for (const file of files) {
    const fileName = typeof file?.name === "string" ? file.name : "";
    const assertions = Array.isArray(file?.assertionResults) ? file.assertionResults : [];
    for (const assertion of assertions) {
      const fullName = typeof assertion?.fullName === "string" ? assertion.fullName : "";
      // An assertion with no name cannot be identified, so it cannot be diffed. Count it in the
      // totals (it is real collected work) but give it no inventory id, which keeps the id arrays a
      // faithful record of what the guard can actually compare.
      if (fileName && fullName) {
        const id = assertionId(fileName, fullName);
        if (isNonExecutedStatus(assertion.status)) {
          byStatus[assertion.status] += 1;
          nonExecuted.add(id);
        } else if (assertion.status === "failed") {
          failed += 1;
          executed.add(id);
        } else {
          passed += 1;
          executed.add(id);
        }
      } else if (isNonExecutedStatus(assertion?.status)) {
        byStatus[assertion.status] += 1;
      } else if (assertion?.status === "failed") {
        failed += 1;
      } else {
        passed += 1;
      }
    }
  }

  const executedIds = [...executed].sort();
  const nonExecutedIds = [...nonExecuted].sort();
  let skippedTotal = 0;
  for (const status of TEST_COUNT_NON_EXECUTED_STATUSES) skippedTotal += byStatus[status];
  return {
    // `total` is the number of COLLECTED assertions, so it moves only when collection moves. A
    // passed->skipped flip keeps it flat (caught by the skipped-delta rule) while a deleted test
    // lowers it (caught by the count rule). See the FNXC note on non-executed counting.
    total: passed + failed + skippedTotal,
    passed,
    failed,
    nonExecuted: byStatus,
    executedIds,
    nonExecutedIds,
  };
}

/**
 * Fingerprint a snapshot reproducibly.
 *
 * Hashes a canonical, explicitly ordered serialization of the counts and the sorted id arrays. The
 * reporter's `startTime`/`endTime`/`duration` never reach this function, so two runs of an unchanged
 * suite fingerprint identically — the property the gate's "same commit + same manifest + same seed →
 * same verdict and fingerprint" verification depends on.
 */
export function fingerprintSnapshot(snapshot: TestCountSnapshot): string {
  const canonical = JSON.stringify({
    total: snapshot.total,
    passed: snapshot.passed,
    failed: snapshot.failed,
    nonExecuted: {
      // Fixed key order, so the serialization cannot depend on object insertion order.
      skipped: snapshot.nonExecuted?.skipped ?? 0,
      todo: snapshot.nonExecuted?.todo ?? 0,
      disabled: snapshot.nonExecuted?.disabled ?? 0,
      pending: snapshot.nonExecuted?.pending ?? 0,
    },
    executedIds: [...(snapshot.executedIds ?? [])].sort(),
    nonExecutedIds: [...(snapshot.nonExecutedIds ?? [])].sort(),
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** Pair a snapshot with its fingerprint, producing a recordable baseline. */
export function createTestCountBaseline(snapshot: TestCountSnapshot): TestCountBaseline {
  return { snapshot, fingerprint: fingerprintSnapshot(snapshot) };
}

/** Separator-normalized, `./`-stripped form of a path, for stable comparison. */
function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Resolve a ledger or assertion path to a repo-relative key.
 *
 * When the caller supplies `repoRoot` the prefix is stripped so an absolute reporter path reduces
 * to the repo-relative key the ledger stores. With no root (or a path outside it) the normalized
 * path is returned unchanged, and matching falls back to the suffix rule below.
 */
function toRepoRelativeKey(value: string, repoRoot: string | undefined): string {
  const normalized = normalizePath(value);
  if (!repoRoot) return normalized;
  const root = normalizePath(repoRoot).replace(/\/+$/, "");
  if (root && (normalized === root || normalized.startsWith(`${root}/`))) {
    return normalized.slice(root.length).replace(/^\/+/, "");
  }
  return normalized;
}

/**
 * Build the quarantine predicate for a run.
 *
 * An assertion's file is exempt when its repo-relative key equals a ledger entry, or — for the
 * common case of an absolute reporter path with a repo-relative ledger and no `repoRoot` supplied —
 * when the key ENDS WITH `"/" + entry` on a path boundary. The boundary anchor is what keeps the
 * fallback from becoming a filename match: `beta.test.ts` cannot exempt `/x/y/alpha.test.ts`.
 */
function buildQuarantineMatcher(
  quarantinedFiles: readonly (string | TestCountQuarantineEntry)[] | undefined,
  repoRoot: string | undefined,
): (file: string) => boolean {
  const entries = (quarantinedFiles ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.file ?? ""))
    .map((file) => normalizePath(file).trim())
    .filter((file) => file.length > 0);
  if (entries.length === 0) return () => false;

  return (file: string): boolean => {
    const key = toRepoRelativeKey(file, repoRoot);
    for (const entry of entries) {
      if (key === entry) return true;
      if (key.endsWith(`/${entry}`)) return true;
    }
    return false;
  };
}

/** The file portion of an inventory id, i.e. everything before the `::` separator. */
function fileOfId(id: string): string {
  const separator = id.indexOf("::");
  return separator === -1 ? "" : id.slice(0, separator);
}

/**
 * Collected assertions in `snapshot` that belong to quarantine-listed files.
 *
 * Derived from the id arrays because every attributable assertion carries exactly one id. An
 * assertion the reporter recorded without a file or a name is counted in the snapshot totals but has
 * no id, so it can never be attributed to a ledger entry and correctly stays un-exempted.
 */
function quarantinedCollectedCount(
  snapshot: TestCountSnapshot | null | undefined,
  isQuarantinedFile: (file: string) => boolean,
): number {
  const ids = [...(snapshot?.executedIds ?? []), ...(snapshot?.nonExecutedIds ?? [])];
  let count = 0;
  for (const id of ids) {
    const file = fileOfId(id);
    if (file && isQuarantinedFile(file)) count += 1;
  }
  return count;
}

/**
 * Compare a candidate run against its baseline and return the gate's measuring verdict.
 *
 * Removal or skip is a regression even when `candidate.failed === 0` — the guard deliberately does
 * not consult the failure count, because a change that deletes or skips tests passes precisely when
 * everything remaining is green. Pure additions pass.
 *
 * The quarantine exemption covers BOTH rules a deletion trips. A quarantined file's assertions are
 * subtracted before the collected-count comparison AND excluded from `test-removed`, so a ledger-
 * sanctioned deletion yields `ok: true` rather than trading one failing reason for another; this is
 * the netting `scripts/check-test-inventory.mjs` prescribes for its own `--diff` guard. A file that
 * is not actually on the ledger gets no exemption on either rule, so the escape hatch cannot be
 * widened to an unrelated removal.
 *
 * The returned `fingerprint` is the candidate's own, so a consumer can record which run produced
 * the verdict. It is a pure function of the two snapshots: no clock, no ordering dependence, so
 * repeat evaluation of the same inputs returns an identical verdict and fingerprint.
 */
export function evaluateTestCountDelta(input: {
  baseline: TestCountBaseline;
  candidate: TestCountSnapshot;
  quarantinedFiles?: readonly (string | TestCountQuarantineEntry)[];
  /**
   * Optional repository root used to reduce absolute reporter paths to the repo-relative keys the
   * quarantine ledger stores. This module never reads the filesystem, so the caller supplies it;
   * when omitted, matching falls back to a path-boundary suffix comparison.
   */
  repoRoot?: string;
}): TestCountDeltaVerdict {
  const { baseline, candidate } = input;
  const isQuarantinedFile = buildQuarantineMatcher(input.quarantinedFiles, input.repoRoot);

  const baselineInventory = inventoryIds(baseline.snapshot);
  const candidateInventory = inventoryIds(candidate);
  const candidateExecuted = new Set(candidate?.executedIds ?? []);
  const allRemoved = [...baselineInventory].filter((id) => !candidateInventory.has(id)).sort();
  const removedIds = allRemoved.filter((id) => {
    const file = fileOfId(id);
    return !(file && isQuarantinedFile(file));
  });
  const addedCount = [...candidateExecuted].filter((id) => !baselineInventory.has(id)).length;

  const skippedDelta = nonExecutedTotal(candidate) - nonExecutedTotal(baseline.snapshot);
  // The count comparison is NET of quarantine exemptions, exactly as the removal comparison is.
  // Counting a quarantined file's assertions on the baseline side while the file is gone from the
  // candidate would fire `test-count-regressed` and re-create the ratchet deadlock the exemption
  // exists to prevent, so the reported delta always explains the verdict actually returned.
  const guardedBaselineTotal =
    (baseline.snapshot?.total ?? 0) - quarantinedCollectedCount(baseline.snapshot, isQuarantinedFile);
  const guardedCandidateTotal =
    (candidate?.total ?? 0) - quarantinedCollectedCount(candidate, isQuarantinedFile);
  const totalDelta = guardedCandidateTotal - guardedBaselineTotal;
  // The three rules stay disjoint by construction: a deleted test lowers `total` AND vanishes from
  // the inventory (count + removed); a skipped test keeps `total` flat and stays in the inventory
  // (skipped only); a pure add moves nothing negative. A candidate that gains a skip without losing
  // anything is caught by the skipped-delta rule alone.

  const reasons: TestCountDeltaReason[] = [];
  if (totalDelta < 0) reasons.push("test-count-regressed");
  if (removedIds.length > 0) reasons.push("test-removed");
  if (skippedDelta > 0) reasons.push("test-skipped");

  return {
    ok: reasons.length === 0,
    reasons,
    removedCount: removedIds.length,
    addedCount,
    skippedDelta,
    totalDelta,
    fingerprint: fingerprintSnapshot(candidate),
  };
}
