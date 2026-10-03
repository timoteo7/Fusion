/*
FNXC:SelfImproveCostBudget 2026-09-30-13:45:
These are the ONLY types that decide what a cost measurement IS. The self-improvement primary gate
must be able to answer "did this candidate change make the same corpus more expensive?" — and that
question is only answerable if both sides of the comparison were measured the same way. These types
are stated once, here, so the measurement seam (`cost-budget-measure.js`), the verdict seam
(`cost-budget-guard.js`), and the telemetry façade (`self-improve-run-audit.js`) cannot each invent
their own notion of a "run" and drift.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
DETERMINISM IS BY RECORDED OBSERVATION, NEVER BY CLOCK. This is the load-bearing invariant of the
whole feature. A measurement is a pure function of the observations handed to it: it reads no clock,
opens no store, imports no engine, and starts no process. That is what makes a verdict reproducible —
running the guard twice over the same recorded observations returns byte-identical totals, deltas, and
fingerprint. A measurement that sampled `Date.now()` at read time could differ between two runs of the
SAME corpus and would make "the candidate is over budget" an unreproducible claim; wall-clock belongs
in the RECORD (an observation's `wallClockMs`, captured once by whatever ran the task), never in the
MEASUREMENT. The deterministic gate is worthless if two evaluations of one commit can disagree.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
A `CostObservation` is deliberately dumb data: one task, one measurement, plus the identity of the
run it came from. The loop does not measure tasks yet (that is the later replay-corpus slice), so this
shape is the CONTRACT that producer will satisfy — which is exactly why it must be a pure record and
not a reader. `seed` and `corpusId` travel WITH each observation rather than being a parameter of the
measurement, so a corpus cannot be silently re-run under a different seed or a different task set
between the baseline pass and the candidate pass.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
The token convention mirrors `getTokenBudgetUsage` in `packages/engine/src/concurrency/
token-budget-enforcer.ts` EXACTLY: input + output + cacheWrite, with cache READS excluded. This is a
deliberate choice, not an oversight. The cost guard answers "is this change more expensive than the
budget the loop already enforces?", and that budget deliberately ignores cache reads (a cache hit
saves input tokens without the task getting cheaper to run). If this guard counted cache reads, a
change that made caching MORE effective would be reported as more expensive — the guard would reward
the opposite of the improvement.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
Three axes, not one. A candidate can be token-neutral while getting materially slower (more tool
round-trips, more wall-clock) or cheaper in tokens while taking more steps (smaller context, more
retries). Collapsing these into one scalar would let an expensive-on-one-axis change hide behind a
cheap-on-another. Each axis is evaluated and reported independently, and ANY one exceeding its slack
fails the run — the axes do not trade off against each other.
*/

/**
 * One task's recorded cost within a run.
 *
 * This is a RECORD of a measurement that already happened, not a request to measure. Nothing in this
 * module reads a clock, a store, or a process to produce one — the producing lane owns that, and the
 * deterministic gate compares only these records.
 */
export interface CostObservation {
  /** Durable id of the task this observation is about. Also the ordering key for a run. */
  taskId: string;
  /** Token cost under the platform convention: input + output + cacheWrite; cache reads excluded. */
  tokens: number;
  /** Number of discrete execution steps the task took (model/tool round-trips, as the producer counts them). */
  steps: number;
  /** Wall-clock duration in milliseconds, captured once by the producer and carried here verbatim. */
  wallClockMs: number;
  /** Seed the producing run used. Recorded per-observation so a re-seeded run cannot be compared. */
  seed: string;
  /** Identity of the task set this observation belongs to. Recorded per-observation for the same reason. */
  corpusId: string;
}

/** The three independently-evaluated cost axes, in fixed evaluation order. */
export type CostAxis = "tokens" | "steps" | "wallClockMs";

/** Every cost axis, in fixed evaluation order. The guard evaluates them in exactly this sequence. */
export const COST_AXES: readonly CostAxis[] = ["tokens", "steps", "wallClockMs"];

/** True when `value` is one of the three cost axes. Guards callers naming an axis from outside. */
export function isCostAxis(value: unknown): value is CostAxis {
  return typeof value === "string" && (COST_AXES as readonly string[]).includes(value);
}

/**
 * Totals for one run over one corpus.
 *
 * `fingerprint` is a `sha256:` digest of the run's MEASURED CONTENT in canonical order — not of the
 * caller's input object, whose property insertion order is not a fact worth hashing. Two runs whose
 * totals and fingerprints agree were measured over the same tasks in the same order under the same
 * seed; that agreement is what the comparability guard checks before it will compute a delta at all.
 */
export interface CostTotals {
  /**
   * Whether every observation in this run agreed about WHICH corpus it belongs to.
   *
   * This is recorded at measurement time, not re-derived later, because the evidence is destroyed by
   * summing: once a mixed set has been collapsed into one total, the second corpus id is gone and no
   * downstream layer can tell a coherent run from a contaminated one. Recording the verdict as part
   * of the run is what keeps the guard's `inconsistent-run` refusal reachable at all.
   */
  consistentCorpus: boolean;
  /** Whether every observation in this run agreed about the seed it used. Same rationale as above. */
  consistentSeed: boolean;
  /** Identity of the task set measured. Mirrors every observation's `corpusId`. */
  corpusId: string;
  /** Seed the run used. Mirrors every observation's `seed`. */
  seed: string;
  /** Number of observations summed. A count, so an empty corpus is distinguishable from a zero-cost one. */
  taskCount: number;
  /** Summed token cost across the corpus. */
  tokens: number;
  /** Summed step count across the corpus. */
  steps: number;
  /** Summed wall-clock milliseconds across the corpus. */
  wallClockMs: number;
  /** The ordering the totals were summed in, so a fingerprint is verifiable against a known sequence. */
  orderedTaskIds: readonly string[];
  /** `sha256:<hex>` digest of the canonical measurement content. */
  fingerprint: string;
}

/**
 * How much a candidate run may exceed the baseline run before the axis fails.
 *
 * Slack is PER AXIS and in the SAME UNIT as the axis it guards: `tokens` and `steps` are absolute
 * counts, `wallClockMs` is milliseconds. Slack is an ABSOLUTE allowance, not a ratio, because the
 * loop's operator-facing question is "how much more may this spend" — a percentage would make the
 * allowance move with the corpus size and silently widen the budget every time the corpus grows.
 */
export interface CostBudgetSlack {
  /** Absolute token allowance above the baseline's measured total. */
  tokens: number;
  /** Absolute step allowance above the baseline's measured total. */
  steps: number;
  /** Absolute millisecond allowance above the baseline's measured total. */
  wallClockMs: number;
}

/**
 * Why a run was refused a verdict.
 *
 * A CLOSED enum, not prose. The comparability refusals are the four ways two runs can differ in a way
 * that makes their subtraction meaningless; a budget failure names the axis and both measured numbers
 * in {@link CostBudgetFailure} instead. Refusing is deliberately not a failure: "these two runs cannot
 * be compared" and "the candidate spent too much" are different operator questions, and collapsing
 * them would let a mismatch masquerade as a passing or failing verdict.
 */
export type CostBudgetReason =
  /** Baseline and candidate measured a different set of tasks. */
  | "corpus-mismatch"
  /** Baseline and candidate ran under different seeds, so at least one input order differed. */
  | "seed-mismatch"
  /** The two runs summed the same tasks in a different order, so the totals are not comparable. */
  | "ordering-mismatch"
  /** One side's observations do not agree with each other (mixed corpus id, seed, or a duplicate task). */
  | "inconsistent-run";

/** Every legal refusal reason. Mirrors {@link CostBudgetReason} so callers can count classes. */
export const COST_BUDGET_REASONS: readonly CostBudgetReason[] = [
  "corpus-mismatch",
  "seed-mismatch",
  "ordering-mismatch",
  "inconsistent-run",
];

/** True when `value` is a legal comparability refusal reason. Guards callers naming a reason by hand. */
export function isCostBudgetReason(value: unknown): value is CostBudgetReason {
  return typeof value === "string" && (COST_BUDGET_REASONS as readonly string[]).includes(value);
}

/**
 * One axis that exceeded its slack.
 *
 * BOTH measured numbers travel with the refusal. A budget verdict that reported only "over budget"
 * would leave the operator to re-derive which side moved and by how much — and in the failure case the
 * measurement is the expensive part, so demanding a re-run to explain a refusal is exactly the wrong
 * trade. `axis` names which of the three moved; the two totals say what it became versus what it was.
 */
export interface CostBudgetFailure {
  /** The axis that exceeded its allowance. */
  axis: CostAxis;
  /** Measured total on the baseline side. */
  baselineValue: number;
  /** Measured total on the candidate side. */
  candidateValue: number;
  /** Signed delta (`candidateValue - baselineValue`). Positive means the candidate cost more. */
  delta: number;
  /** The allowance that was exceeded, in the axis's own unit. */
  slack: number;
}

/** Per-axis deltas over a comparable pair of runs. Present only when a verdict was computed. */
export interface CostBudgetDeltas {
  tokens: number;
  steps: number;
  wallClockMs: number;
}

/**
 * The result of comparing a candidate run against a baseline run.
 *
 * Exactly one of three shapes, discriminated by `verdict`:
 * - `not-comparable` — the two runs were not measured the same way; no delta was computed at all.
 * - `within-budget` / `over-budget` — a delta exists. `over-budget` always carries at least one entry
 *   in `failures`, naming every axis that exceeded its allowance with both measured numbers.
 *
 * The refusal is checked BEFORE any subtraction: a delta between two differently-measured runs is a
 * number with no meaning, and reporting one would be worse than reporting nothing.
 */
export interface CostBudgetVerdict {
  /** The deterministic answer. */
  verdict: CostBudgetVerdictValue;
  /** Why the run was refused, when `verdict` is `not-comparable`. Absent otherwise. */
  reason?: CostBudgetReason;
  /** Per-axis deltas. Absent when the runs were not comparable. */
  deltas?: CostBudgetDeltas;
  /**
   * Every axis that exceeded its allowance, in {@link COST_AXES} order. Present (possibly empty) only
   * when `verdict` is `within-budget` or `over-budget`. More than one entry means several axes moved.
   */
  failures?: CostBudgetFailure[];
  /** Baseline totals the verdict was computed against. Always present, so a verdict names its own inputs. */
  baseline: CostTotals;
  /** Candidate totals the verdict was computed against. Always present, even on refusal. */
  candidate: CostTotals;
}

/** The three deterministic verdicts. `not-comparable` is a refusal, not a fourth budget outcome. */
export type CostBudgetVerdictValue = "within-budget" | "over-budget" | "not-comparable";

/** Every legal verdict value, in reporting order. */
export const COST_BUDGET_VERDICT_VALUES: readonly CostBudgetVerdictValue[] = [
  "within-budget",
  "over-budget",
  "not-comparable",
];

/** True when `value` is a legal verdict. Guards callers naming a verdict by hand. */
export function isCostBudgetVerdictValue(value: unknown): value is CostBudgetVerdictValue {
  return typeof value === "string" && (COST_BUDGET_VERDICT_VALUES as readonly string[]).includes(value);
}
