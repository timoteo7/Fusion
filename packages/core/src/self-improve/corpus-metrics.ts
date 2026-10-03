import { createHash } from "node:crypto";
import { measureCostRun } from "./cost-budget-measure.js";
import {
  CORPUS_METRIC_NAMES,
  toCostObservations,
  type CorpusMetricObservation,
  type CorpusMetricTaskEntry,
  type CorpusMetrics,
} from "./corpus-metrics-types.js";

/*
FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
`measureCorpusMetrics` is the only place a corpus replay becomes the four numbers the secondary ruler
decides on. It is a PURE function of the observations handed to it: no clock, no store, no engine
import, no environment read, no randomness. Everything about reproducibility rests here, so the module
imports only `node:crypto`, the shipped cost measurement, and its own types — a future edit that
reached for `Date.now()` or a store reader would be visible in the import list, which is the cheapest
guard against the one mistake that would silently destroy the feature's value.

FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
COST AND LATENCY ARE OBTAINED BY CALLING `measureCostRun`, never by summing the same fields here.
This is the single line that keeps one notion of "a run" in the system. Re-deriving the totals locally
would look equivalent and be a latent second definition: the corpus's cost could then disagree with the
primary gate's cost-budget arm over the identical replay, and an operator handed two contradictory
numbers for the same run would have no way to tell which ruler was wrong. Delegating means the canary's
cost verdict and the gate's cost-budget verdict are, by construction, the same arithmetic.

FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
ORDERING IS CANONICALIZED BY SORT, and grouping happens on that sorted list, so a duplicate task's
occurrences are guaranteed to be ADJACENT before they are collapsed. Grouping an unsorted list would
make the fold's result depend on interleaving — the same set measured in two orders could produce two
different `occurrences` splits, which is exactly the non-determinism the sort exists to remove.

FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
DUPLICATES COLLAPSE TO ONE ENTRY BY SUMMING, WITH A CONSERVATIVE SUCCESS FLAG. When a task is measured
more than once the numeric fields add (the corpus really did spend that many tokens and really did
accumulate that much rework), but `succeeded` is true only when EVERY occurrence succeeded. A duplicate
where one attempt failed must not read as a clean success just because another attempt passed — a
canary that flattered a flaky task into "succeeded" would hide exactly the instability it exists to
catch. The occurrence count and the duplicate ids are both retained so the collapse is auditable
rather than silent.

FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
INVALID COUNTERS SET A FLAG AND NAME THE IDS INSTEAD OF THROWING. The measurement REPORTS; the guard
DECIDES. A `reworkCount` that is negative, fractional, NaN, or otherwise unusable means the producer
wrote a bad record — that is a defect to surface, not a reason to abort a replay that otherwise
completed. Throwing would turn one bad row into a lost evaluation with no evidence of what was wrong;
recording `valid: false` plus the offending ids keeps the failure visible AND lets a caller decide
whether to refuse. Summing destroys which observation was bad, so the ids are captured here, at the
only point the individual observations still exist.

FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
THE EMPTY CORPUS IS LEGAL. It reports zero for every metric, an empty task list, and a success rate of
zero rather than throwing or producing NaN. Refusing it here would push "was there anything to measure?"
into an exception, where a caller would have to catch to learn a fact it could read off `taskCount`. A
corpus that has not yet been populated is a normal state for the canary before its first replay.

FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
THE FINGERPRINT COVERS THE GROUPING, NOT JUST THE GRAND TOTALS. Two contaminated corpora can sum to the
same tokens and the same rework as one clean corpus — for example a run that measured one task twice
versus a run that measured two distinct tasks with identical numbers. If only the sums were hashed
those two would collide, and a mixed run could be cached as the clean baseline it impersonates. So the
digest covers the per-task entries (including `occurrences` and `duplicateTaskIds`), the task and
observation counts, the success counts and rate, the validity flags, and the delegated cost totals.
*/

/** Canonical ordering for a corpus's observations. Total: a task id can never tie with another. */
function compareByTaskId(left: CorpusMetricObservation, right: CorpusMetricObservation): number {
  if (left.taskId === right.taskId) return 0;
  return left.taskId < right.taskId ? -1 : 1;
}

/**
 * A rework counter is usable only if it is a finite, whole, non-negative count.
 *
 * The check is deliberate rather than a `>= 0` test: a fractional or NaN counter means the producer
 * wrote a bad record, and letting it into a sum would produce a total that looks like a measurement
 * while being arithmetic noise. Rejecting it into the validity flag keeps the corpus's other metrics
 * reportable and names the task that has to be fixed.
 */
function isUsableReworkCount(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Compute the four corpus metrics over a set of recorded per-task observations.
 *
 * Pure and total: any array of observations produces a {@link CorpusMetrics}, including an empty one.
 * Observations are read but never mutated, and every array in the result is freshly built, so a
 * caller that re-sorts or edits its own input afterwards cannot retroactively change what was measured.
 */
export function measureCorpusMetrics(observations: readonly CorpusMetricObservation[]): CorpusMetrics {
  const ordered = [...observations].sort(compareByTaskId);

  // Agreement is judged over the WHOLE run, and the FIRST observation's identity is the one reported,
  // so a contaminated run is labeled with its first member's corpus and simultaneously marked
  // inconsistent rather than reported as a coherent run of some third corpus. Mirrors the cost lane.
  const corpusId = ordered[0]?.corpusId ?? "";
  const seed = ordered[0]?.seed ?? "";
  const consistentCorpus = ordered.every((observation) => observation.corpusId === corpusId);
  const consistentSeed = ordered.every((observation) => observation.seed === seed);

  // Collapse duplicates of one task into a single entry. Safe because `ordered` is sorted, so every
  // observation sharing a task id is adjacent and the fold below sees each task exactly once.
  const tasks: CorpusMetricTaskEntry[] = [];
  const invalidReworkTaskIds: string[] = [];
  let succeededObservationCount = 0;

  for (let index = 0; index < ordered.length; ) {
    const taskId = ordered[index].taskId;

    let occurrences = 0;
    let succeeded = true;
    let reworkCount = 0;
    let tokens = 0;
    let steps = 0;
    let wallClockMs = 0;
    let invalidRework = false;

    while (index < ordered.length && ordered[index].taskId === taskId) {
      const observation = ordered[index];
      occurrences += 1;
      // Conservative across occurrences: one failure among duplicates must not read as a success.
      if (!observation.succeeded) succeeded = false;
      if (isUsableReworkCount(observation.reworkCount)) {
        reworkCount += observation.reworkCount;
      } else {
        invalidRework = true;
      }
      tokens += observation.tokens;
      steps += observation.steps;
      wallClockMs += observation.wallClockMs;
      index += 1;
    }

    if (succeeded) succeededObservationCount += 1;
    if (invalidRework) invalidReworkTaskIds.push(taskId);

    tasks.push({
      taskId,
      succeeded,
      reworkCount,
      tokens,
      steps,
      wallClockMs,
      occurrences,
      duplicateTaskIds: occurrences > 1 ? [taskId] : [],
    });
  }

  // Success is counted over DISTINCT TASKS, matching the cost lane's task-based counting basis so
  // both rulers divide by the same denominator. The empty corpus stays legal at zero rather than NaN.
  const succeededTaskCount = succeededObservationCount;
  const taskCount = tasks.length;
  const successRate = taskCount === 0 ? 0 : succeededTaskCount / taskCount;
  const reworkTotal = tasks.reduce((sum, entry) => sum + entry.reworkCount, 0);
  const orderedTaskIds = tasks.map((entry) => entry.taskId);

  // Cost and latency are the cost lane's numbers, not a parallel sum. This delegation is why the
  // corpus can be compared against the primary gate's cost-budget arm without re-deriving anything.
  const cost = measureCostRun(toCostObservations(ordered));

  return {
    consistentCorpus,
    consistentSeed,
    valid: invalidReworkTaskIds.length === 0,
    invalidReworkTaskIds,
    corpusId,
    seed,
    observationCount: ordered.length,
    taskCount,
    succeededTaskCount,
    successRate,
    reworkTotal,
    orderedTaskIds,
    tasks,
    cost: {
      tokens: cost.tokens,
      steps: cost.steps,
      wallClockMs: cost.wallClockMs,
    },
    fingerprint: fingerprintCorpusMetrics({
      consistentCorpus,
      consistentSeed,
      valid: invalidReworkTaskIds.length === 0,
      invalidReworkTaskIds,
      corpusId,
      seed,
      observationCount: ordered.length,
      taskCount,
      succeededTaskCount,
      successRate,
      reworkTotal,
      orderedTaskIds,
      tasks,
      cost,
    }),
  };
}

/** The canonical payload a corpus-metrics fingerprint is computed over. Every field is a measured fact. */
function fingerprintCorpusMetrics(run: {
  consistentCorpus: boolean;
  consistentSeed: boolean;
  valid: boolean;
  invalidReworkTaskIds: readonly string[];
  corpusId: string;
  seed: string;
  observationCount: number;
  taskCount: number;
  succeededTaskCount: number;
  successRate: number;
  reworkTotal: number;
  orderedTaskIds: readonly string[];
  tasks: readonly CorpusMetricTaskEntry[];
  cost: { tokens: number; steps: number; wallClockMs: number };
}): string {
  // The four metric names travel in the payload so a future edit that renames or reorders the metric
  // list cannot silently produce a digest that still matches an older, differently-named corpus.
  const canonical = JSON.stringify({
    metrics: CORPUS_METRIC_NAMES,
    consistentCorpus: run.consistentCorpus,
    consistentSeed: run.consistentSeed,
    valid: run.valid,
    invalidReworkTaskIds: [...run.invalidReworkTaskIds],
    corpusId: run.corpusId,
    seed: run.seed,
    observationCount: run.observationCount,
    taskCount: run.taskCount,
    succeededTaskCount: run.succeededTaskCount,
    successRate: run.successRate,
    reworkTotal: run.reworkTotal,
    orderedTaskIds: [...run.orderedTaskIds],
    tasks: run.tasks.map((entry) => ({
      taskId: entry.taskId,
      succeeded: entry.succeeded,
      reworkCount: entry.reworkCount,
      tokens: entry.tokens,
      steps: entry.steps,
      wallClockMs: entry.wallClockMs,
      occurrences: entry.occurrences,
      duplicateTaskIds: [...entry.duplicateTaskIds],
    })),
    cost: run.cost,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
