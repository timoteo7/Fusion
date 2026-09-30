/*
FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
These are the ONLY types that decide what the secondary ruler's four corpus metrics MEAN. The
self-improvement loop's canary is a second ruler behind the primary gate: before a change is kept, the
replay canary asks whether the same corpus still succeeds as often, needs as much rework, costs as
much, and runs as slowly. That question is only answerable if both the baseline pass and the candidate
pass were measured by the SAME fixed definitions — so the definitions are stated once, here, next to
the cost lane they delegate to (`cost-budget-types.ts`), and the measurement seam
(`corpus-metrics-measure.ts`) cannot invent its own notion of a "run".

FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
FOUR METRICS, EACH WITH A FIXED DEFINITION, because the secondary ruler is only trustworthy if two
evaluations of one corpus agree. SUCCESS is a recorded terminal boolean per task (did the task reach a
terminal success?), REWORK is a summed recorded engine-written counter, COST and LATENCY are delegated
to the shipped cost measurement rather than re-derived. Every one of these is a COUNT over recorded
observations or a straight arithmetic combination of counts — never a ratio of opinions, never a model
judgment, never a score the loop itself assigns. If a metric's definition could change between two
evaluations of the same corpus, the ruler would disagree with itself and the whole keep/revert-by-
canary decision becomes unreproducible.

FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
REWORK IS A SUMMED COUNTER, NOT A SUBJECTIVE JUDGMENT. This is the load-bearing definitional choice.
The engine already persists a verifiable rework counter — `workflow_run_step_instances.reworkCount`,
incremented by the foreach graph's `kind: "rework"` edge and already summed per task and run by
`AgentSelfImproveService` in `packages/engine/src/agents/agent-reflection.ts`. Reading that recorded
number gives "redone more" a definition that is a plain fact read from what the engine already writes,
so two readers of the same run always get the same rework number. Deriving rework from log prose, or
scoring it, would make the same run measure differently for two readers and would turn a reproducible
ruler into a subjective one. The counter here is a pure record: this module sums it, it does not
produce it.

FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
COST AND LATENCY ARE DELEGATED, NOT FORKED. Cost and latency are the shipped cost lane's job — it
already fixes the token convention (input + output + cacheWrite, cache reads excluded), the three
axes, the canonical ordering, and the fingerprint. This feature does not restate them. A corpus must
have exactly ONE notion of "a run": if the corpus metrics re-derived cost with a slightly different
token rule or a different ordering, the canary could report a corpus as cheaper while the primary
gate's cost-budget arm reported the same replay as over budget, and neither verdict would be
explainable. `toCostObservations` is the single projection seam that hands the recorded cost fields to
`measureCostRun`, so the two dimensions live in exactly one place.

FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
DETERMINISM IS BY RECORDED OBSERVATION, NEVER BY CLOCK — the same invariant the cost lane holds, and
for the same reason. A `CorpusMetricObservation` is a RECORD of a measurement that already happened.
The measurement module reads no clock, opens no store, imports no engine, and starts no process;
success, rework, tokens, steps, and wall-clock all arrive already captured on the observation. That is
what makes two evaluations of one corpus byte-identical. `seed` and `corpusId` travel WITH each
observation (not as parameters of the measurement) for the reason the cost lane gives: a corpus
cannot be silently re-run under a different seed or a different task set between the baseline pass and
the candidate pass, and per-observation identity makes that detectable instead of averaged away.

FNXC:SelfImproveCorpusMetrics 2026-09-30-18:56:
GROUPING IS BY TASK, AND DUPLICATES COLLAPSE VISIBLY. A corpus is a set of tasks; the four metrics are
"grouped by task". When the same task appears more than once in a recorded set, its occurrences
collapse into ONE `CorpusMetricTaskEntry` whose numeric fields SUM, whose `succeeded` flag is true only
when EVERY occurrence succeeded (so a partially-successful duplicate cannot read as a clean success),
and whose `occurrences` and `duplicateTaskIds` stay visible. Keeping the duplicate ids and the
occurrence count in the result is deliberate: grouping is a measurement convenience, not a licence to
hide that a corpus measured some task twice. A contaminated run stays visible in the record instead
of collapsing into a clean-looking total.
*/

import type { CostObservation } from "./cost-budget-types.js";

/**
 * One task's recorded outcome, rework, and cost within a corpus replay.
 *
 * A RECORD of a measurement that already happened, not a request to measure. Nothing in this module
 * reads a clock, a store, or a process to produce one — the producing lane (the replay canary) owns
 * that, and the secondary ruler compares only these records.
 */
export interface CorpusMetricObservation {
  /** Durable id of the task this observation is about. Also the grouping and ordering key. */
  taskId: string;
  /** Whether this task run reached a terminal success. Recorded by the producer, never inferred here. */
  succeeded: boolean;
  /**
   * The engine's recorded rework counter for this task — `workflow_run_step_instances.reworkCount`
   * summed over the task's step instances. A VERIFIABLE count read from what the engine already
   * writes; this module sums it and never scores it.
   */
  reworkCount: number;
  /** Token cost under the platform convention, carried verbatim from the cost lane. */
  tokens: number;
  /** Discrete execution steps the task took, carried verbatim from the cost lane. */
  steps: number;
  /** Wall-clock duration in milliseconds, captured once by the producer and carried verbatim. */
  wallClockMs: number;
  /** Seed the producing run used. Recorded per-observation so a re-seeded run cannot be compared. */
  seed: string;
  /** Identity of the task set this observation belongs to. Recorded per-observation for the same reason. */
  corpusId: string;
}

/** The four corpus metrics the secondary ruler needs, in fixed reporting order. */
export type CorpusMetricName = "success" | "rework" | "cost" | "latency";

/** Every corpus metric, in fixed order. The canary evaluates them in exactly this sequence. */
export const CORPUS_METRIC_NAMES: readonly CorpusMetricName[] = ["success", "rework", "cost", "latency"];

/** True when `value` is one of the four corpus metrics. Guards callers naming a metric from outside. */
export function isCorpusMetricName(value: unknown): value is CorpusMetricName {
  return typeof value === "string" && (CORPUS_METRIC_NAMES as readonly string[]).includes(value);
}

/**
 * Project the cost fields of each corpus observation onto a cost-lane observation.
 *
 * This is the SINGLE seam by which cost and latency reach the measurement. `measureCorpusMetrics`
 * calls it and hands the result to the shipped `measureCostRun`, so the corpus's cost and latency
 * totals are, by construction, the cost lane's totals over the same observations — never a
 * parallel definition that could drift. Success and rework are ignored here because the cost lane
 * neither knows nor needs them.
 */
export function toCostObservations(observations: readonly CorpusMetricObservation[]): CostObservation[] {
  return observations.map((observation) => ({
    taskId: observation.taskId,
    tokens: observation.tokens,
    steps: observation.steps,
    wallClockMs: observation.wallClockMs,
    seed: observation.seed,
    corpusId: observation.corpusId,
  }));
}

/**
 * One task's grouped entry within the per-task rollup.
 *
 * Produced by collapsing every observation of one `taskId`: numeric fields SUM, `succeeded` is true
 * only when every occurrence succeeded, and `occurrences`/`duplicateTaskIds` keep a task that was
 * measured more than once visible in the record.
 */
export interface CorpusMetricTaskEntry {
  /** The task this entry groups. Unique within a measurement — one entry per distinct task id. */
  taskId: string;
  /** True only when EVERY occurrence of this task succeeded. */
  succeeded: boolean;
  /** Summed recorded rework counter across this task's occurrences. */
  reworkCount: number;
  /** Summed token cost across this task's occurrences. */
  tokens: number;
  /** Summed step count across this task's occurrences. */
  steps: number;
  /** Summed wall-clock milliseconds across this task's occurrences. */
  wallClockMs: number;
  /** How many observations collapsed into this entry. 1 for a clean, non-duplicated corpus. */
  occurrences: number;
  /** Always `[taskId]` when this task was measured more than once, `[]` otherwise. */
  duplicateTaskIds: readonly string[];
}

/**
 * The four metrics, plus the counts and flags that make them checkable, over one corpus replay.
 *
 * `fingerprint` is a `sha256:` digest of the measurement's MEASURED CONTENT in canonical order — not
 * of the caller's input object. Two evaluations whose metrics and fingerprints agree were computed
 * from the same per-task observations in the same order under the same seed and corpus; that
 * agreement is what makes the canary reproducible.
 */
export interface CorpusMetrics {
  /** Whether every observation agreed about WHICH corpus it belongs to. Recorded, not re-derived. */
  consistentCorpus: boolean;
  /** Whether every observation agreed about the seed it used. Recorded for the same reason. */
  consistentSeed: boolean;
  /**
   * Whether every `reworkCount` was a usable non-negative integer.
   *
   * Recorded at measurement time WITH the offending ids rather than thrown, so one bad counter marks
   * the metrics `valid: false` and names the task instead of crashing a replay that otherwise ran.
   * Summing destroys the evidence of WHICH observation was invalid, so it is captured here, at the
   * only point the individual observations still exist.
   */
  valid: boolean;
  /** Task ids whose `reworkCount` was not a usable non-negative integer. Empty when `valid` is true. */
  invalidReworkTaskIds: readonly string[];
  /** Identity of the task set measured. Mirrors every observation's `corpusId`. */
  corpusId: string;
  /** Seed the run used. Mirrors every observation's `seed`. */
  seed: string;
  /** Number of observations summed. Distinct from `taskCount` when a task was measured more than once. */
  observationCount: number;
  /** Number of DISTINCT tasks (one per grouping entry). A count, so an empty corpus stays legible. */
  taskCount: number;
  /** Number of observations whose `succeeded` was true. */
  succeededTaskCount: number;
  /**
   * `succeededTaskCount / taskCount`, over the DISTINCT tasks — matching the cost lane's counting
   * basis so both rulers divide by the same denominator. Zero for an empty corpus (which stays legal).
   */
  successRate: number;
  /** Summed recorded rework counter over the whole corpus. */
  reworkTotal: number;
  /** Every distinct task id, in canonical `taskId` order. Also the grouping entries' order. */
  orderedTaskIds: readonly string[];
  /** Per-task rollup in canonical `taskId` order, one entry per distinct task id. */
  tasks: readonly CorpusMetricTaskEntry[];
  /**
   * Delegated cost totals for this corpus. This is `measureCostRun`'s own output over the projected
   * observations, so the corpus's cost and latency ARE the cost lane's numbers by construction.
   */
  cost: {
    tokens: number;
    steps: number;
    wallClockMs: number;
  };
  /** `sha256:<hex>` digest of the canonical measurement content. */
  fingerprint: string;
}
