import { describe, expect, it } from "vitest";
import { measureCorpusMetrics } from "../self-improve/corpus-metrics.js";
import {
  CORPUS_METRIC_NAMES,
  isCorpusMetricName,
  toCostObservations,
  type CorpusMetricObservation,
} from "../self-improve/corpus-metrics-types.js";
import { measureCostRun } from "../self-improve/cost-budget-measure.js";
import * as publicCore from "@fusion/core";

/*
FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
The measurement suite's whole subject is DETERMINISM, and determinism has exactly one honest test:
feed the same SET of facts in two different ORDERS and prove the metrics AND the fingerprint are
byte-identical. Every other assertion is a corollary (the rates compute, the fingerprint changes when
a number changes) or a boundary (the empty corpus is legal and reports zero rather than throwing).

FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
The fingerprint assertions check the `sha256:` PREFIX and a STABLE DIGEST, never that it equals some
hand-computed hash. A literal expected digest would make this suite fail for the wrong reason if the
canonical serialization were ever deliberately revised — and would teach a future reader that the hash
is the contract, when the contract is really "the fingerprint changes iff the measured content
changes". The two directions that matter are pinned instead: same content => same digest, changed
content => different digest.

FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
"REWORK IS A COUNTED FACT" is asserted as arithmetic — a corpus whose per-task rework entries sum to
the reported total — because that is the claim the spec makes: two readers of the same recorded run
always get the same rework number. There is no "reasonable rework" or "acceptable churn" case in this
file on purpose; a score with a tolerance band would reintroduce exactly the subjectivity the counter
removes.
*/

const CORPUS = "corpus-replay-v1";
const SEED = "seed-42";

function observation(
  overrides: Partial<CorpusMetricObservation> & { taskId: string },
): CorpusMetricObservation {
  return {
    succeeded: true,
    reworkCount: 0,
    tokens: 100,
    steps: 2,
    wallClockMs: 1_000,
    seed: SEED,
    corpusId: CORPUS,
    ...overrides,
  };
}

describe("measureCorpusMetrics — pure deterministic measurement (FUSI-033)", () => {
  it("computes the success rate and its counts over distinct tasks", () => {
    const metrics = measureCorpusMetrics([
      observation({ taskId: "t-a", succeeded: true }),
      observation({ taskId: "t-b", succeeded: false }),
      observation({ taskId: "t-c", succeeded: true }),
      observation({ taskId: "t-d", succeeded: true }),
    ]);

    expect(metrics.taskCount).toBe(4);
    expect(metrics.succeededTaskCount).toBe(3);
    expect(metrics.successRate).toBe(0.75);
    expect(metrics.corpusId).toBe(CORPUS);
    expect(metrics.seed).toBe(SEED);
  });

  it("sums the recorded rework counter into a total and per-task entries", () => {
    const metrics = measureCorpusMetrics([
      observation({ taskId: "t-a", reworkCount: 1 }),
      observation({ taskId: "t-b", reworkCount: 2 }),
      observation({ taskId: "t-c", reworkCount: 4 }),
    ]);

    // Rework is the SUM of the engine-written counter, so the per-task entries must add up to the
    // total — the whole point of "redone more" being a counted fact rather than a score.
    expect(metrics.reworkTotal).toBe(7);
    expect(metrics.tasks.map((entry) => entry.reworkCount)).toEqual([1, 2, 4]);
    expect(metrics.tasks.reduce((sum, entry) => sum + entry.reworkCount, 0)).toBe(metrics.reworkTotal);
  });

  it("treats the empty corpus as a legal zeroed replay rather than throwing", () => {
    const metrics = measureCorpusMetrics([]);

    expect(metrics.taskCount).toBe(0);
    expect(metrics.observationCount).toBe(0);
    expect(metrics.succeededTaskCount).toBe(0);
    expect(metrics.successRate).toBe(0);
    expect(metrics.reworkTotal).toBe(0);
    expect(metrics.orderedTaskIds).toEqual([]);
    expect(metrics.tasks).toEqual([]);
    expect(metrics.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("two empty corpora fingerprint identically", () => {
    expect(measureCorpusMetrics([]).fingerprint).toBe(measureCorpusMetrics([]).fingerprint);
  });

  it("groups per task with one entry per distinct id in canonical order", () => {
    const metrics = measureCorpusMetrics([
      observation({ taskId: "t-z" }),
      observation({ taskId: "t-m" }),
      observation({ taskId: "t-a" }),
    ]);

    expect(metrics.orderedTaskIds).toEqual(["t-a", "t-m", "t-z"]);
    expect(metrics.tasks.map((entry) => entry.taskId)).toEqual(["t-a", "t-m", "t-z"]);
    expect(metrics.taskCount).toBe(3);
    expect(metrics.observationCount).toBe(3);
    for (const entry of metrics.tasks) {
      expect(entry.occurrences).toBe(1);
      expect(entry.duplicateTaskIds).toEqual([]);
    }
  });

  it("collapses a duplicate task into one summed entry and reports the duplicate id", () => {
    const metrics = measureCorpusMetrics([
      observation({ taskId: "t-a", reworkCount: 1, tokens: 10, steps: 1, wallClockMs: 100 }),
      observation({ taskId: "t-a", reworkCount: 2, tokens: 20, steps: 2, wallClockMs: 200 }),
      observation({ taskId: "t-b", reworkCount: 3, tokens: 30, steps: 3, wallClockMs: 300 }),
    ]);

    const duplicated = metrics.tasks.find((entry) => entry.taskId === "t-a");
    expect(duplicated?.occurrences).toBe(2);
    expect(duplicated?.reworkCount).toBe(3);
    expect(duplicated?.tokens).toBe(30);
    expect(duplicated?.duplicateTaskIds).toEqual(["t-a"]);

    expect(metrics.taskCount).toBe(2);
    expect(metrics.observationCount).toBe(3);
    expect(metrics.reworkTotal).toBe(6);
  });

  it("marks a task succeeded only when EVERY duplicate occurrence succeeded", () => {
    const metrics = measureCorpusMetrics([
      observation({ taskId: "t-a", succeeded: true }),
      observation({ taskId: "t-a", succeeded: false }),
    ]);

    const duplicated = metrics.tasks.find((entry) => entry.taskId === "t-a");
    // A partial success must not read as clean success, or a flaky task would be flattered into a
    // pass by whichever attempt happened to go well.
    expect(duplicated?.succeeded).toBe(false);
    expect(metrics.succeededTaskCount).toBe(0);
    expect(metrics.successRate).toBe(0);
  });

  it("reports the four metrics as exactly the four fixed names", () => {
    expect([...CORPUS_METRIC_NAMES]).toEqual(["success", "rework", "cost", "latency"]);
    for (const metric of CORPUS_METRIC_NAMES) expect(isCorpusMetricName(metric)).toBe(true);
    expect(isCorpusMetricName("throughput")).toBe(false);
    expect(isCorpusMetricName(undefined)).toBe(false);
  });
});

describe("cost and latency are delegated to the shipped cost measurement (FUSI-033)", () => {
  it("deep-equals measureCostRun over the projected observations", () => {
    const observations = [
      observation({ taskId: "t-a", tokens: 100, steps: 2, wallClockMs: 1_000 }),
      observation({ taskId: "t-b", tokens: 250, steps: 5, wallClockMs: 4_500 }),
    ];
    const metrics = measureCorpusMetrics(observations);
    const costLane = measureCostRun(toCostObservations(observations));

    // The delegation is the contract: one notion of a run. Re-deriving cost here would let the
    // canary disagree with the primary gate's cost-budget arm over the identical replay.
    expect(metrics.cost).toEqual({
      tokens: costLane.tokens,
      steps: costLane.steps,
      wallClockMs: costLane.wallClockMs,
    });
    expect(metrics.cost).toEqual({ tokens: 350, steps: 7, wallClockMs: 5_500 });
  });

  it("projects only the cost-lane fields off each observation", () => {
    const projected = toCostObservations([observation({ taskId: "t-a", reworkCount: 5 })]);
    expect(projected).toEqual([
      { taskId: "t-a", tokens: 100, steps: 2, wallClockMs: 1_000, seed: SEED, corpusId: CORPUS },
    ]);
  });

  it("an empty corpus reports zeroed cost totals", () => {
    expect(measureCorpusMetrics([]).cost).toEqual({ tokens: 0, steps: 0, wallClockMs: 0 });
  });
});

describe("measureCorpusMetrics — fingerprint covers the measured content (FUSI-033)", () => {
  it("produces identical metrics and fingerprint from shuffled insertion order", () => {
    const observations = [
      observation({ taskId: "t-d", reworkCount: 4, tokens: 12, steps: 3, wallClockMs: 90 }),
      observation({ taskId: "t-a", reworkCount: 1, tokens: 340, steps: 6, wallClockMs: 7_100 }),
      observation({ taskId: "t-c", reworkCount: 3, tokens: 5, steps: 1, wallClockMs: 15 }),
      observation({ taskId: "t-b", reworkCount: 2, tokens: 99, steps: 4, wallClockMs: 1_000 }),
    ];
    const shuffled = [observations[2], observations[0], observations[3], observations[1]];

    const first = measureCorpusMetrics(observations);
    const second = measureCorpusMetrics(shuffled);

    expect(second).toEqual(first);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes the fingerprint when success changes", () => {
    const base = measureCorpusMetrics([observation({ taskId: "t-a", succeeded: true })]);
    const failed = measureCorpusMetrics([observation({ taskId: "t-a", succeeded: false })]);

    expect(failed.fingerprint).not.toBe(base.fingerprint);
    expect(failed.successRate).toBe(0);
    expect(base.successRate).toBe(1);
  });

  it("changes the fingerprint when rework changes", () => {
    const base = measureCorpusMetrics([observation({ taskId: "t-a", reworkCount: 1 })]);
    const more = measureCorpusMetrics([observation({ taskId: "t-a", reworkCount: 2 })]);

    expect(more.fingerprint).not.toBe(base.fingerprint);
  });

  it("changes the fingerprint when the task set changes", () => {
    const base = measureCorpusMetrics([observation({ taskId: "t-a" })]);
    const more = measureCorpusMetrics([observation({ taskId: "t-a" }), observation({ taskId: "t-b" })]);

    expect(more.fingerprint).not.toBe(base.fingerprint);
    expect(more.taskCount).toBe(2);
  });

  it("changes the fingerprint when the corpus id or the seed changes", () => {
    const base = measureCorpusMetrics([observation({ taskId: "t-a" })]);

    expect(measureCorpusMetrics([observation({ taskId: "t-a", corpusId: "other-corpus" })]).fingerprint).not.toBe(
      base.fingerprint,
    );
    expect(measureCorpusMetrics([observation({ taskId: "t-a", seed: "seed-43" })]).fingerprint).not.toBe(
      base.fingerprint,
    );
  });

  it("a contaminated run cannot collide with a clean run that totaled the same", () => {
    const clean = measureCorpusMetrics([observation({ taskId: "t-a", reworkCount: 5, tokens: 100 })]);
    // The contaminated run reports the same corpus, seed, task, rework and totals as `clean`, and
    // differs only in having assembled `t-a` from two corpus ids. Its fingerprint must still differ,
    // or a mixed run could be mistaken for — and cached as — the clean run it impersonates.
    const contaminated = measureCorpusMetrics([
      observation({ taskId: "t-a", reworkCount: 0, tokens: 0 }),
      observation({ taskId: "t-a", reworkCount: 5, tokens: 100, corpusId: "other-corpus" }),
    ]);

    expect(contaminated.corpusId).toBe(clean.corpusId);
    expect(contaminated.reworkTotal).toBe(clean.reworkTotal);
    expect(contaminated.cost.tokens).toBe(clean.cost.tokens);
    expect(contaminated.fingerprint).not.toBe(clean.fingerprint);
  });

  it("records a run whose own observations disagree about the seed they used", () => {
    const mixed = measureCorpusMetrics([
      observation({ taskId: "t-a", seed: "seed-1" }),
      observation({ taskId: "t-b", seed: "seed-2" }),
    ]);

    expect(mixed.consistentSeed).toBe(false);
    expect(mixed.seed).toBe("seed-1");
  });

  it("does not mutate the caller's observations or alias its ordering", () => {
    const observations = [observation({ taskId: "t-b" }), observation({ taskId: "t-a" })];
    const snapshot = JSON.parse(JSON.stringify(observations));

    const metrics = measureCorpusMetrics(observations);

    expect(observations).toEqual(snapshot);
    expect(metrics.orderedTaskIds).toEqual(["t-a", "t-b"]);
  });
});

describe("measureCorpusMetrics — invalid rework sets a flag instead of throwing (FUSI-033)", () => {
  it("marks the metrics invalid and names the offending task ids", () => {
    const metrics = measureCorpusMetrics([
      observation({ taskId: "t-a", reworkCount: 1 }),
      observation({ taskId: "t-b", reworkCount: -1 }),
      observation({ taskId: "t-c", reworkCount: 1.5 }),
    ]);

    // A bad producer record is a defect to surface, not a reason to abort a replay that otherwise ran.
    expect(metrics.valid).toBe(false);
    expect(metrics.invalidReworkTaskIds).toEqual(["t-b", "t-c"]);
    // The usable counters still report, so a caller can decide whether to refuse or proceed.
    expect(metrics.tasks.find((entry) => entry.taskId === "t-a")?.reworkCount).toBe(1);
    expect(metrics.reworkTotal).toBe(1);
  });

  it("a clean corpus reports valid with no offending ids", () => {
    const metrics = measureCorpusMetrics([observation({ taskId: "t-a", reworkCount: 0 })]);
    expect(metrics.valid).toBe(true);
    expect(metrics.invalidReworkTaskIds).toEqual([]);
  });

  it("an invalid run cannot collide with a valid run that totaled the same", () => {
    const valid = measureCorpusMetrics([observation({ taskId: "t-a", reworkCount: 1 })]);
    const invalid = measureCorpusMetrics([
      observation({ taskId: "t-a", reworkCount: 1 }),
      observation({ taskId: "t-a", reworkCount: -1 }),
    ]);

    expect(invalid.reworkTotal).toBe(valid.reworkTotal);
    expect(invalid.fingerprint).not.toBe(valid.fingerprint);
  });
});

/*
FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
The public-surface test resolves the measurement through the PACKAGE entry rather than the internal
file path. An export added to `src/index.ts` but forgotten in `index.gate.ts` — the mirror the
bundled CLI resolves — would still pass a suite that imported the deep path, so the only version of
this assertion worth having is one that goes through the public surface a real consumer uses.
*/
describe("corpus metrics are reachable from the public @fusion/core surface (FUSI-033)", () => {
  it("exports the measurement and the metric-name list", () => {
    expect(typeof publicCore.measureCorpusMetrics).toBe("function");
    expect([...publicCore.CORPUS_METRIC_NAMES]).toEqual(["success", "rework", "cost", "latency"]);
    expect(typeof publicCore.isCorpusMetricName).toBe("function");
    expect(typeof publicCore.toCostObservations).toBe("function");
  });

  it("produces the same fingerprint through the public entry point as through the internal one", () => {
    const observations = [observation({ taskId: "t-b" }), observation({ taskId: "t-a" })];
    expect(publicCore.measureCorpusMetrics(observations).fingerprint).toBe(
      measureCorpusMetrics(observations).fingerprint,
    );
  });
});
