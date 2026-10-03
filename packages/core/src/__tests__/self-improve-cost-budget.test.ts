import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { measureCostRun } from "../self-improve/cost-budget-measure.js";
import { evaluateCostBudget } from "../self-improve/cost-budget-guard.js";
import {
  SELF_IMPROVE_AUDIT_AGENT_ID,
  SELF_IMPROVE_RUN_AUDIT_EVENTS,
  emitSelfImproveCostBudgetEvaluated,
} from "../self-improve/self-improve-run-audit.js";
import { CORE_RUN_AUDIT_EMIT_TIMEOUT_MS, type RunAuditSinkHost } from "../run-audit/emit-bounded-run-audit.js";
import type { RunAuditEventInput } from "../types/audit/run-audit.js";
import * as publicCore from "@fusion/core";
import {
  COST_AXES,
  COST_BUDGET_REASONS,
  isCostAxis,
  isCostBudgetReason,
  type CostObservation,
} from "../self-improve/cost-budget-types.js";

/*
FNXC:SelfImproveCostBudget 2026-09-30-13:45:
The measurement suite's whole subject is DETERMINISM, and determinism has exactly one honest test: feed
the same SET of facts in two different ORDERS and prove the totals AND the fingerprint are
byte-identical. Every other assertion here is a corollary (the axes sum, the fingerprint changes when
a number changes) or a boundary (the empty corpus is legal and reports zero rather than throwing).

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
The fingerprint assertions check the `sha256:` PREFIX and a STABLE DIGEST, never that it equals some
hand-computed hash. A literal expected digest would make this suite fail for the wrong reason if the
canonical serialization were ever deliberately revised — and would teach a future reader that the hash
is the contract, when the contract is really "the fingerprint changes iff the measured content
changes". The two directions that matter are pinned instead: same content => same digest, changed
content => different digest.
*/

const CORPUS = "corpus-replay-v1";
const SEED = "seed-42";

function observation(overrides: Partial<CostObservation> & { taskId: string }): CostObservation {
  return {
    tokens: 100,
    steps: 2,
    wallClockMs: 1_000,
    seed: SEED,
    corpusId: CORPUS,
    ...overrides,
  };
}

describe("measureCostRun — pure deterministic measurement (FUSI-018)", () => {
  it("sums every axis across the corpus", () => {
    const totals = measureCostRun([
      observation({ taskId: "t-a", tokens: 100, steps: 2, wallClockMs: 1_000 }),
      observation({ taskId: "t-b", tokens: 250, steps: 5, wallClockMs: 4_500 }),
      observation({ taskId: "t-c", tokens: 40, steps: 1, wallClockMs: 250 }),
    ]);

    expect(totals.tokens).toBe(390);
    expect(totals.steps).toBe(8);
    expect(totals.wallClockMs).toBe(5_750);
    expect(totals.taskCount).toBe(3);
    expect(totals.corpusId).toBe(CORPUS);
    expect(totals.seed).toBe(SEED);
  });

  it("produces identical totals and fingerprint from shuffled insertion order", () => {
    const observations = [
      observation({ taskId: "t-d", tokens: 12, steps: 3, wallClockMs: 90 }),
      observation({ taskId: "t-a", tokens: 340, steps: 6, wallClockMs: 7_100 }),
      observation({ taskId: "t-c", tokens: 5, steps: 1, wallClockMs: 15 }),
      observation({ taskId: "t-b", tokens: 99, steps: 4, wallClockMs: 1_000 }),
    ];
    const shuffled = [observations[2], observations[0], observations[3], observations[1]];

    const first = measureCostRun(observations);
    const second = measureCostRun(shuffled);

    expect(second).toEqual(first);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("orders by taskId rather than by arrival, so the canonical order is reported", () => {
    const totals = measureCostRun([
      observation({ taskId: "t-z" }),
      observation({ taskId: "t-a" }),
      observation({ taskId: "t-m" }),
    ]);

    expect(totals.orderedTaskIds).toEqual(["t-a", "t-m", "t-z"]);
  });

  it("changes the fingerprint when any measured number changes", () => {
    const base = measureCostRun([observation({ taskId: "t-a", tokens: 100 })]);
    const tokensChanged = measureCostRun([observation({ taskId: "t-a", tokens: 101 })]);
    const stepsChanged = measureCostRun([observation({ taskId: "t-a", steps: 3 })]);
    const wallClockChanged = measureCostRun([observation({ taskId: "t-a", wallClockMs: 1_001 })]);

    expect(tokensChanged.fingerprint).not.toBe(base.fingerprint);
    expect(stepsChanged.fingerprint).not.toBe(base.fingerprint);
    expect(wallClockChanged.fingerprint).not.toBe(base.fingerprint);
  });

  it("changes the fingerprint when the corpus identity, the seed, or the task set changes", () => {
    const base = measureCostRun([observation({ taskId: "t-a" })]);

    expect(measureCostRun([observation({ taskId: "t-a", corpusId: "other-corpus" })]).fingerprint).not.toBe(base.fingerprint);
    expect(measureCostRun([observation({ taskId: "t-a", seed: "seed-43" })]).fingerprint).not.toBe(base.fingerprint);
    expect(
      measureCostRun([observation({ taskId: "t-a" }), observation({ taskId: "t-b" })]).fingerprint,
    ).not.toBe(base.fingerprint);
  });

  it("treats the empty corpus as a legal zero-cost run rather than throwing", () => {
    const totals = measureCostRun([]);

    expect(totals.taskCount).toBe(0);
    expect(totals.tokens).toBe(0);
    expect(totals.steps).toBe(0);
    expect(totals.wallClockMs).toBe(0);
    expect(totals.orderedTaskIds).toEqual([]);
    expect(totals.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("two empty runs fingerprint identically", () => {
    expect(measureCostRun([]).fingerprint).toBe(measureCostRun([]).fingerprint);
  });

  it("does not mutate the caller's observations or alias its ordering", () => {
    const observations = [observation({ taskId: "t-b" }), observation({ taskId: "t-a" })];
    const snapshot = JSON.parse(JSON.stringify(observations));

    const totals = measureCostRun(observations);

    expect(observations).toEqual(snapshot);
    expect(totals.orderedTaskIds).toEqual(["t-a", "t-b"]);
  });

  it("recognizes exactly the three cost axes", () => {
    expect([...COST_AXES]).toEqual(["tokens", "steps", "wallClockMs"]);
    for (const axis of COST_AXES) expect(isCostAxis(axis)).toBe(true);
    expect(isCostAxis("latency")).toBe(false);
    expect(isCostAxis(undefined)).toBe(false);
  });
});

/*
FNXC:SelfImproveCostBudget 2026-09-30-13:45:
The guard suite pins the two properties the primary gate depends on and which regress independently:
a refusal is NOT a failure (no delta is computed at all, and the reason is one of the four fixed
values), and a failure always carries BOTH measured numbers, so an operator never has to re-run an
evaluation just to learn what happened. Each axis is exercised on its own so a per-axis bug in the
evaluation loop cannot hide behind another axis moving.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
The NEGATIVE CONTROL is deliberate. "Fails on token slope" is paired with "the same slope stays within
budget when slack covers it", differing only in the allowance number. Without that pair a guard that
always answered `over-budget` would satisfy every failure assertion — the suite would pin the SHAPE of
the answer without pinning that the answer was ever derived from the measurements.
*/

describe("evaluateCostBudget — comparability guard and slack verdict (FUSI-018)", () => {
  it("fails with both measured numbers when the token slope exceeds slack", () => {
    const verdict = evaluateCostBudget({
      baseline: [observation({ taskId: "t-a", tokens: 100 }), observation({ taskId: "t-b", tokens: 200 })],
      candidate: [observation({ taskId: "t-a", tokens: 140 }), observation({ taskId: "t-b", tokens: 280 })],
      slack: { tokens: 10, steps: 10, wallClockMs: 10 },
    });

    expect(verdict.verdict).toBe("over-budget");
    expect(verdict.failures).toHaveLength(1);
    const failure = verdict.failures?.[0];
    expect(failure?.axis).toBe("tokens");
    expect(failure?.baselineValue).toBe(300);
    expect(failure?.candidateValue).toBe(420);
    expect(failure?.delta).toBe(120);
    expect(failure?.slack).toBe(10);
    expect(verdict.deltas).toEqual({ tokens: 120, steps: 0, wallClockMs: 0 });
  });

  it("negative control: the same slope stays within budget when slack covers it", () => {
    const verdict = evaluateCostBudget({
      baseline: [observation({ taskId: "t-a", tokens: 140 - 40 }), observation({ taskId: "t-b", tokens: 280 - 80 })],
      candidate: [observation({ taskId: "t-a", tokens: 140 }), observation({ taskId: "t-b", tokens: 280 })],
      slack: { tokens: 120, steps: 10, wallClockMs: 10 },
    });

    expect(verdict.verdict).toBe("within-budget");
    expect(verdict.failures).toEqual([]);
    expect(verdict.deltas?.tokens).toBe(120);
  });

  it("fails each axis independently", () => {
    const tokenOnly = evaluateCostBudget({
      baseline: [observation({ taskId: "t-a", tokens: 100, steps: 5, wallClockMs: 1_000 })],
      candidate: [observation({ taskId: "t-a", tokens: 500, steps: 5, wallClockMs: 1_000 })],
      slack: { tokens: 0, steps: 0, wallClockMs: 0 },
    });
    expect(tokenOnly.failures?.map((f) => f.axis)).toEqual(["tokens"]);

    const stepOnly = evaluateCostBudget({
      baseline: [observation({ taskId: "t-a", tokens: 100, steps: 5, wallClockMs: 1_000 })],
      candidate: [observation({ taskId: "t-a", tokens: 100, steps: 9, wallClockMs: 1_000 })],
      slack: { tokens: 0, steps: 0, wallClockMs: 0 },
    });
    expect(stepOnly.failures?.map((f) => f.axis)).toEqual(["steps"]);

    const clockOnly = evaluateCostBudget({
      baseline: [observation({ taskId: "t-a", tokens: 100, steps: 5, wallClockMs: 1_000 })],
      candidate: [observation({ taskId: "t-a", tokens: 100, steps: 5, wallClockMs: 9_000 })],
      slack: { tokens: 0, steps: 0, wallClockMs: 0 },
    });
    expect(clockOnly.failures?.map((f) => f.axis)).toEqual(["wallClockMs"]);
  });

  it("records that a run's observations agreed about corpus and seed", () => {
    const coherent = measureCostRun([observation({ taskId: "t-a" }), observation({ taskId: "t-b" })]);
    expect(coherent.consistentCorpus).toBe(true);
    expect(coherent.consistentSeed).toBe(true);

    const mixedCorpus = measureCostRun([observation({ taskId: "t-a" }), observation({ taskId: "t-b", corpusId: "other" })]);
    expect(mixedCorpus.consistentCorpus).toBe(false);

    const mixedSeed = measureCostRun([observation({ taskId: "t-a" }), observation({ taskId: "t-b", seed: "other-seed" })]);
    expect(mixedSeed.consistentSeed).toBe(false);
  });

  it("a contaminated run cannot collide with a clean run that totaled the same", () => {
    const clean = measureCostRun([observation({ taskId: "t-a" })]);
    // The contaminated run reports the same corpus, seed, task and totals as `clean`, and differs
    // only in having been assembled from two corpus ids. Its fingerprint must still differ, or a
    // mixed run could be mistaken for — and cached as — the clean run it impersonates.
    const contaminated = measureCostRun([
      observation({ taskId: "t-a", tokens: 0 }),
      observation({ taskId: "t-a", tokens: 100, corpusId: "other" }),
    ]);

    expect(contaminated.corpusId).toBe(clean.corpusId);
    expect(contaminated.seed).toBe(clean.seed);
    expect(contaminated.tokens).toBe(clean.tokens);
    expect(contaminated.fingerprint).not.toBe(clean.fingerprint);
  });

  it("names every exceeded axis rather than only the first", () => {
    const verdict = evaluateCostBudget({
      baseline: [observation({ taskId: "t-a", tokens: 10, steps: 2, wallClockMs: 100 })],
      candidate: [observation({ taskId: "t-a", tokens: 90, steps: 7, wallClockMs: 900 })],
      slack: { tokens: 0, steps: 0, wallClockMs: 0 },
    });

    expect(verdict.verdict).toBe("over-budget");
    expect(verdict.failures?.map((f) => f.axis)).toEqual(["tokens", "steps", "wallClockMs"]);
  });

  it("refuses without computing a delta when the corpus differs", () => {
    const verdict = evaluateCostBudget({
      baseline: [observation({ taskId: "t-a", corpusId: "corpus-a" })],
      candidate: [observation({ taskId: "t-a", corpusId: "corpus-b", tokens: 999 })],
      slack: { tokens: 0, steps: 0, wallClockMs: 0 },
    });

    expect(verdict.verdict).toBe("not-comparable");
    expect(verdict.reason).toBe("corpus-mismatch");
    expect(verdict.deltas).toBeUndefined();
    expect(verdict.failures).toBeUndefined();
  });

  it("refuses without computing a delta when the seed differs", () => {
    const verdict = evaluateCostBudget({
      baseline: [observation({ taskId: "t-a", seed: "seed-1" })],
      candidate: [observation({ taskId: "t-a", seed: "seed-2", tokens: 999 })],
      slack: { tokens: 0, steps: 0, wallClockMs: 0 },
    });

    expect(verdict.verdict).toBe("not-comparable");
    expect(verdict.reason).toBe("seed-mismatch");
    expect(verdict.deltas).toBeUndefined();
  });

  it("refuses a same-seed pair whose canonical orders differ", () => {
    // Both sides report the same corpus and seed, but the baseline measured two tasks and the
    // candidate measured one. Task-set and seed identity alone do NOT imply order identity, and the
    // totals must be refused rather than subtracted.
    const baseline = measureCostRun([observation({ taskId: "t-a" }), observation({ taskId: "t-b" })]);

    const verdict = evaluateCostBudget({
      baseline,
      candidate: [observation({ taskId: "t-a" })],
      slack: { tokens: 0, steps: 0, wallClockMs: 0 },
    });

    expect(verdict.verdict).toBe("not-comparable");
    expect(verdict.reason).toBe("ordering-mismatch");
    expect(verdict.deltas).toBeUndefined();
  });

  it("refuses a run whose own observations disagree about the seed they used", () => {
    const mixed = measureCostRun([
      observation({ taskId: "t-a", seed: "seed-1" }),
      observation({ taskId: "t-b", seed: "seed-2" }),
    ]);

    const verdict = evaluateCostBudget({
      baseline: [observation({ taskId: "t-a", seed: "seed-1" })],
      candidate: mixed,
      slack: { tokens: 0, steps: 0, wallClockMs: 0 },
    });

    expect(verdict.verdict).toBe("not-comparable");
    expect(verdict.reason).toBe("inconsistent-run");
  });

  it("refuses a run that measured the same task twice", () => {
    const duplicated = measureCostRun([
      observation({ taskId: "t-a" }),
      observation({ taskId: "t-a" }),
    ]);

    const verdict = evaluateCostBudget({
      baseline: [observation({ taskId: "t-a" })],
      candidate: duplicated,
      slack: { tokens: 0, steps: 0, wallClockMs: 0 },
    });

    expect(verdict.verdict).toBe("not-comparable");
    expect(verdict.reason).toBe("inconsistent-run");
  });

  it("refuses a run whose own observations disagree with the identity it reports", () => {
    const mixed = measureCostRun([
      observation({ taskId: "t-a" }),
      observation({ taskId: "t-b", corpusId: "corpus-other" }),
    ]);

    const verdict = evaluateCostBudget({
      baseline: [observation({ taskId: "t-a" })],
      candidate: mixed,
      slack: { tokens: 0, steps: 0, wallClockMs: 0 },
    });

    expect(verdict.verdict).toBe("not-comparable");
    expect(verdict.reason).toBe("inconsistent-run");
    expect(verdict.deltas).toBeUndefined();
  });

  it("comparability refusal outranks an over-budget candidate", () => {
    // The candidate is BOTH incomparable and enormously over budget on every axis. The refusal must
    // win, so an invalid comparison can never be reported as a measured failure.
    const verdict = evaluateCostBudget({
      baseline: [observation({ taskId: "t-a", corpusId: "corpus-a", tokens: 1 })],
      candidate: [observation({ taskId: "t-a", corpusId: "corpus-b", tokens: 10_000, steps: 900, wallClockMs: 10_000_000 })],
      slack: { tokens: 0, steps: 0, wallClockMs: 0 },
    });

    expect(verdict.verdict).toBe("not-comparable");
    expect(verdict.reason).toBe("corpus-mismatch");
  });

  it("treats two empty runs as comparable and within budget", () => {
    const verdict = evaluateCostBudget({ baseline: [], candidate: [], slack: { tokens: 0, steps: 0, wallClockMs: 0 } });

    expect(verdict.verdict).toBe("within-budget");
    expect(verdict.deltas).toEqual({ tokens: 0, steps: 0, wallClockMs: 0 });
    expect(verdict.baseline.fingerprint).toBe(verdict.candidate.fingerprint);
  });

  it("judges a zero-cost single-task baseline without special-casing it", () => {
    const zero = observation({ taskId: "t-a", tokens: 0, steps: 0, wallClockMs: 0 });

    const identical = evaluateCostBudget({ baseline: [zero], candidate: [zero], slack: { tokens: 0, steps: 0, wallClockMs: 0 } });
    expect(identical.verdict).toBe("within-budget");

    const singleTask = evaluateCostBudget({
      baseline: [zero],
      candidate: [observation({ taskId: "t-a", tokens: 1, steps: 1, wallClockMs: 1 })],
      slack: { tokens: 1, steps: 1, wallClockMs: 1 },
    });
    expect(singleTask.verdict).toBe("within-budget");
    expect(singleTask.deltas).toEqual({ tokens: 1, steps: 1, wallClockMs: 1 });
  });

  it("is deterministic across two identical calls", () => {
    const input = {
      baseline: [observation({ taskId: "t-b", tokens: 30 }), observation({ taskId: "t-a", tokens: 20 })],
      candidate: [observation({ taskId: "t-a", tokens: 90 }), observation({ taskId: "t-b", tokens: 30 })],
      slack: { tokens: 5, steps: 5, wallClockMs: 5 },
    };

    expect(evaluateCostBudget(input)).toEqual(evaluateCostBudget(input));
  });

  it("is deterministic across shuffled input on both sides", () => {
    const baseline = [observation({ taskId: "t-a", tokens: 20 }), observation({ taskId: "t-b", tokens: 30 })];
    const candidate = [observation({ taskId: "t-a", tokens: 90 }), observation({ taskId: "t-b", tokens: 30 })];
    const slack = { tokens: 5, steps: 5, wallClockMs: 5 };

    const forward = evaluateCostBudget({ baseline, candidate, slack });
    const reversed = evaluateCostBudget({
      baseline: [...baseline].reverse(),
      candidate: [...candidate].reverse(),
      slack,
    });

    expect(reversed).toEqual(forward);
    expect(reversed.verdict).toBe("over-budget");
  });

  it("accepts an already-measured baseline alongside raw candidate observations", () => {
    const baseline = measureCostRun([observation({ taskId: "t-a", tokens: 100 })]);
    const verdict = evaluateCostBudget({
      baseline,
      candidate: [observation({ taskId: "t-a", tokens: 100 })],
      slack: { tokens: 0, steps: 0, wallClockMs: 0 },
    });

    expect(verdict.verdict).toBe("within-budget");
    expect(verdict.baseline.fingerprint).toBe(verdict.candidate.fingerprint);
  });

  it("always echoes the baseline and candidate totals it judged, refusal included", () => {
    const verdict = evaluateCostBudget({
      baseline: [observation({ taskId: "t-a", tokens: 100 })],
      candidate: [observation({ taskId: "t-a", tokens: 100, corpusId: "corpus-b" })],
      slack: { tokens: 0, steps: 0, wallClockMs: 0 },
    });

    expect(verdict.baseline.corpusId).toBe(CORPUS);
    expect(verdict.candidate.corpusId).toBe("corpus-b");
    expect(verdict.baseline.taskCount).toBe(1);
    expect(verdict.candidate.taskCount).toBe(1);
  });

  it("names every legal refusal reason and no others", () => {
    expect([...COST_BUDGET_REASONS]).toEqual([
      "corpus-mismatch",
      "seed-mismatch",
      "ordering-mismatch",
      "inconsistent-run",
    ]);
    for (const reason of COST_BUDGET_REASONS) expect(isCostBudgetReason(reason)).toBe(true);
    expect(isCostBudgetReason("budget-exceeded")).toBe(false);
  });
});

/*
FNXC:SelfImproveCostBudget 2026-09-30-13:45:
The emission suite proves the two properties the run-audit edge must hold for the cost guard. First,
the CLOSED metadata: each outcome's recorded keys are asserted exactly, and the measured cost numbers
are asserted ABSENT — because `{ ...baseline }` would have been the natural one-token implementation
and it would have dumped every future `CostTotals` field straight into the audit trail.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
Second, sink independence is proven behaviorally, through all six sink modes with fake timers rather
than by pointing at the bounded seam's existence. The never-settling and late-settling modes are the
ones that matter: they cross `CORE_RUN_AUDIT_EMIT_TIMEOUT_MS` deterministically and prove the verdict
the caller holds is identical regardless of whether the row ever landed.
*/

const COST_PROJECT_ID = "cost-budget-project";
const COST_PROPOSAL_ID = "p-cost-1";
const COST_TARGET = "memory" as const;
const COST_OCCURRED_AT = "2026-09-30T02:00:00.000Z";
const COST_PLANTED = "PLANTED-PROSE-must-never-reach-run-audit";

type CapturedSink = { events: RunAuditEventInput[]; host: RunAuditSinkHost };

function healthyCostSink(): CapturedSink {
  const events: RunAuditEventInput[] = [];
  return { events, host: { recordRunAuditEvent: (event: RunAuditEventInput) => { events.push(event); } } };
}
function absentCostSink(): CapturedSink { return { events: [], host: {} }; }
function throwingCostSink(): CapturedSink {
  return { events: [], host: { recordRunAuditEvent: () => { throw new Error(COST_PLANTED); } } };
}
function rejectingCostSink(): CapturedSink {
  return { events: [], host: { recordRunAuditEvent: () => Promise.reject(new Error(COST_PLANTED)) } };
}
function neverSettlingCostSink(): CapturedSink {
  return { events: [], host: { recordRunAuditEvent: () => new Promise<never>(() => { /* never settles */ }) } };
}
function lateSettlingCostSink(): CapturedSink {
  const events: RunAuditEventInput[] = [];
  return {
    events,
    host: {
      recordRunAuditEvent: (event: RunAuditEventInput) =>
        new Promise<void>((resolve) => {
          setTimeout(() => { events.push(event); resolve(); }, CORE_RUN_AUDIT_EMIT_TIMEOUT_MS + 10);
        }),
    },
  };
}

const COST_SINK_MODES = [
  ["absent", absentCostSink],
  ["throwing", throwingCostSink],
  ["rejecting", rejectingCostSink],
  ["never-settling", neverSettlingCostSink],
  ["late-settling", lateSettlingCostSink],
  ["healthy", healthyCostSink],
] as const;

function costAuditInput(host: RunAuditSinkHost) {
  return {
    host,
    proposalId: COST_PROPOSAL_ID,
    target: COST_TARGET,
    baseline: measureCostRun([observation({ taskId: "t-a", tokens: 100 })]),
    candidate: measureCostRun([observation({ taskId: "t-a", tokens: 400 })]),
    projectId: COST_PROJECT_ID,
    timestamp: COST_OCCURRED_AT,
  };
}

describe("emitSelfImproveCostBudgetEvaluated — closed metadata (FUSI-018)", () => {
  it("records the closed field list for an over-budget verdict", async () => {
    const sink = healthyCostSink();
    await emitSelfImproveCostBudgetEvaluated({ ...costAuditInput(sink.host), outcome: "over-budget", exceededAxes: ["tokens"] });

    expect(sink.events).toHaveLength(1);
    const metadata = sink.events[0].metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      "baselineCorpusId",
      "baselineFingerprint",
      "baselineSeed",
      "baselineTaskCount",
      "candidateCorpusId",
      "candidateFingerprint",
      "candidateSeed",
      "candidateTaskCount",
      "exceededAxes",
      "outcome",
      "projectId",
      "proposalId",
      "target",
    ]);
    expect(metadata.outcome).toBe("over-budget");
    expect(metadata.exceededAxes).toEqual(["tokens"]);
    expect(metadata.baselineTaskCount).toBe(1);
  });

  it("records the refusal reason and omits axes when nothing was comparable", async () => {
    const sink = healthyCostSink();
    await emitSelfImproveCostBudgetEvaluated({
      ...costAuditInput(sink.host),
      candidate: measureCostRun([observation({ taskId: "t-a", corpusId: "corpus-other" })]),
      outcome: "not-comparable",
      reason: "corpus-mismatch",
    });

    const metadata = sink.events[0].metadata as Record<string, unknown>;
    expect(metadata.reason).toBe("corpus-mismatch");
    expect(metadata).not.toHaveProperty("exceededAxes");
  });

  it("omits both reason and exceeded axes for a within-budget verdict", async () => {
    const sink = healthyCostSink();
    await emitSelfImproveCostBudgetEvaluated({ ...costAuditInput(sink.host), outcome: "within-budget" });

    const metadata = sink.events[0].metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("reason");
    expect(metadata).not.toHaveProperty("exceededAxes");
  });

  it("never records the measured cost numbers or any caller-supplied narrative", async () => {
    const sink = healthyCostSink();
    const contaminated = {
      ...costAuditInput(sink.host),
      outcome: "over-budget" as const,
      exceededAxes: ["tokens" as const],
      // Planted extra fields a growing input type could introduce. None may reach the trail.
      rationale: COST_PLANTED,
      origin: COST_PLANTED,
      diff: COST_PLANTED,
      baseline: { ...costAuditInput(sink.host).baseline, notes: COST_PLANTED },
    };
    await emitSelfImproveCostBudgetEvaluated(contaminated);

    const event = sink.events[0];
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(COST_PLANTED);
    expect(Object.keys(event.metadata as Record<string, unknown>)).not.toContain("notes");

    const metadata = event.metadata as Record<string, unknown>;
    // The measured numbers are deliberately NOT audited — only identities and counts.
    expect(metadata).not.toHaveProperty("tokens");
    expect(metadata).not.toHaveProperty("steps");
    expect(metadata).not.toHaveProperty("wallClockMs");
    expect(metadata).not.toHaveProperty("orderedTaskIds");
  });

  it("filters an unrecognized axis out of the recorded exceeded list", async () => {
    const sink = healthyCostSink();
    await emitSelfImproveCostBudgetEvaluated({
      ...costAuditInput(sink.host),
      outcome: "over-budget",
      exceededAxes: ["tokens", "gpuSeconds" as never],
    });

    expect((sink.events[0].metadata as Record<string, unknown>).exceededAxes).toEqual(["tokens"]);
  });

  it("uses the fixed principal and the stable proposal lineage run id", async () => {
    const sink = healthyCostSink();
    await emitSelfImproveCostBudgetEvaluated({ ...costAuditInput(sink.host), outcome: "within-budget" });

    const event = sink.events[0];
    expect(event.agentId).toBe(SELF_IMPROVE_AUDIT_AGENT_ID);
    expect(event.runId).toBe(`selfimprove-${COST_PROPOSAL_ID}`);
    expect(event.target).toBe(COST_PROPOSAL_ID);
    expect(event.mutationType).toBe(SELF_IMPROVE_RUN_AUDIT_EVENTS.costBudgetEvaluated);
  });

  it("carries the fingerprints a later reader needs to re-derive the comparison", async () => {
    const sink = healthyCostSink();
    const input = costAuditInput(sink.host);
    await emitSelfImproveCostBudgetEvaluated({ ...input, outcome: "within-budget" });

    const metadata = sink.events[0].metadata as Record<string, unknown>;
    expect(metadata.baselineFingerprint).toBe(input.baseline.fingerprint);
    expect(metadata.candidateFingerprint).toBe(input.candidate.fingerprint);
  });
});

describe("emitSelfImproveCostBudgetEvaluated — sink independence (FUSI-018)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // The never-settling and late-settling modes release the façade only when the seam's own timeout
  // fires, and that timeout is a real setTimeout. Under fake timers it runs only when the clock is
  // advanced, so every mode advances past it before awaiting. For the immediately-resolving modes
  // (absent/throwing/rejecting/healthy) this is a no-op; for the hung modes it is what proves the
  // seam's time-box actually releases the façade rather than hanging the caller.
  const settle = async (promise: Promise<void>) => {
    await vi.advanceTimersByTimeAsync(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS + 5);
    await expect(promise).resolves.toBeUndefined();
  };

  it("leaves the caller's verdict identical across every sink mode", async () => {
    const input = evaluateCostBudget({
      baseline: [observation({ taskId: "t-a", tokens: 100 })],
      candidate: [observation({ taskId: "t-a", tokens: 400 })],
      slack: { tokens: 0, steps: 0, wallClockMs: 0 },
    });

    for (const [mode, makeSink] of COST_SINK_MODES) {
      const sink = makeSink();
      const emitted = emitSelfImproveCostBudgetEvaluated({
        ...costAuditInput(sink.host),
        outcome: input.verdict,
        exceededAxes: input.failures?.map((f) => f.axis),
      });
      await settle(emitted);
      // The verdict the caller holds is unchanged by the sink: recomputing it is a pure function of
      // the recorded observations, so it cannot have depended on whether the row landed.
      expect(input.verdict, `${mode} must not alter the verdict`).toBe("over-budget");
    }
  });

  it("records the row exactly once on a healthy sink and never on a hostile one", async () => {
    const healthy = healthyCostSink();
    await settle(emitSelfImproveCostBudgetEvaluated({ ...costAuditInput(healthy.host), outcome: "within-budget" }));
    expect(healthy.events).toHaveLength(1);

    for (const makeSink of [absentCostSink, throwingCostSink, rejectingCostSink, neverSettlingCostSink, lateSettlingCostSink]) {
      const sink = makeSink();
      await settle(emitSelfImproveCostBudgetEvaluated({ ...costAuditInput(sink.host), outcome: "within-budget" }));
      expect(sink.events).toHaveLength(0);
    }
  });

  it("releases a never-settling sink within the seam timeout rather than waiting on it", async () => {
    const sink = neverSettlingCostSink();
    const started = Date.now();
    await settle(emitSelfImproveCostBudgetEvaluated({ ...costAuditInput(sink.host), outcome: "within-budget" }));
    // The hung sink is released by the seam's own time-box, so the awaited promise settles at or
    // before the timeout rather than hanging on a sink that never resolves.
    expect(Date.now() - started).toBeLessThanOrEqual(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS + 5);
  });
});

/*
FNXC:SelfImproveCostBudget 2026-09-30-13:45:
The public-surface test resolves the guard through the PACKAGE entry rather than the internal file
path. An export added to `src/index.ts` but forgotten in `index.gate.ts` — the mirror the bundled CLI
resolves — would still pass a suite that imported the deep path, so the only version of this assertion
worth having is one that goes through the public surface a real consumer uses.
*/
describe("cost-budget guard is reachable from the public @fusion/core surface (FUSI-018)", () => {
  it("exports the measurement and guard entry points", () => {
    expect(typeof publicCore.measureCostRun).toBe("function");
    expect(typeof publicCore.evaluateCostBudget).toBe("function");
  });

  it("exports the closed enums and the event constant", () => {
    expect([...publicCore.COST_AXES]).toEqual(["tokens", "steps", "wallClockMs"]);
    expect(publicCore.COST_BUDGET_REASONS).toHaveLength(4);
    expect(publicCore.COST_BUDGET_VERDICT_VALUES).toHaveLength(3);
    expect(publicCore.SELF_IMPROVE_RUN_AUDIT_EVENTS.costBudgetEvaluated).toBe("selfimprove:cost-budget-evaluated");
  });

  it("exports the audit façade", () => {
    expect(typeof publicCore.emitSelfImproveCostBudgetEvaluated).toBe("function");
  });

  it("produces the same verdict through the public entry point as through the internal one", () => {
    const publicVerdict = publicCore.evaluateCostBudget({
      baseline: [{ taskId: "t-a", tokens: 100, steps: 2, wallClockMs: 500, seed: SEED, corpusId: CORPUS }],
      candidate: [{ taskId: "t-a", tokens: 400, steps: 2, wallClockMs: 500, seed: SEED, corpusId: CORPUS }],
      slack: { tokens: 0, steps: 0, wallClockMs: 0 },
    });

    expect(publicVerdict.verdict).toBe("over-budget");
    expect(publicVerdict.failures?.[0]?.axis).toBe("tokens");
  });

  it("fingerprints a run identically through the public entry point", () => {
    const observations = [observation({ taskId: "t-b" }), observation({ taskId: "t-a" })];
    expect(publicCore.measureCostRun(observations).fingerprint).toBe(measureCostRun(observations).fingerprint);
  });
});
