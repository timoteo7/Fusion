import {
  COST_AXES,
  type CostAxis,
  type CostBudgetDeltas,
  type CostBudgetFailure,
  type CostBudgetSlack,
  type CostBudgetVerdict,
  type CostObservation,
  type CostTotals,
} from "./cost-budget-types.js";
import { measureCostRun } from "./cost-budget-measure.js";

/*
FNXC:SelfImproveCostBudget 2026-09-30-13:45:
THE COMPARABILITY REFUSAL OUTRANKS THE BUDGET VERDICT. Two runs are only comparable when they measured
the same tasks, under the same seed, in the same canonical order. When they did not, this guard
returns `not-comparable` and computes NO delta — it does not report a number and does not fail. This
ordering is deliberate and is the feature's core safety property: a delta between two differently
measured runs is a number with no meaning, so computing one would let an obviously invalid comparison
pass a gate while still producing a plausible-looking figure nobody would question. Refusing is also
distinguishable from failing, which matters to an operator: "these two runs cannot be compared, fix
the harness" is a different instruction from "the candidate spent more than allowed".

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
Each axis is judged INDEPENDENTLY and evaluated in the fixed {@link COST_AXES} order. Any single
exceeding axis fails the run, and `failures` names EVERY exceeded axis rather than the first one — an
operator seeing only the first would fix it and immediately be handed the second. There is no
aggregate score and no offsetting between axes: a candidate that is faster and far more expensive is
over budget, because the token budget the loop already enforces
(`getTokenBudgetUsage`) is the one being protected.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
A failure carries BOTH measured totals plus the signed delta and the allowance that was exceeded. The
measurement is the expensive part of an evaluation, so a refusal that made the operator re-run it just
to learn what happened would be the wrong trade; and `delta` is stated so the reading does not depend
on the reader performing the subtraction.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
A run whose observations DISAGREE WITH EACH OTHER (a mixed corpus id, a mixed seed, or the same task
appearing twice) is refused as `inconsistent-run` rather than being trusted on its own reported
identity. That check is why `measureCostRun` takes `corpusId`/`seed` from the observations instead of
from a caller-supplied argument: a producer that collects a mixed set cannot launder it into a
confidently-labeled run. This is the only place a refusal reason is about ONE side rather than the
pair, and it is checked on both sides.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
The guard accepts either raw observations or already-measured totals for each side, because the
caller's two natural shapes differ: a baseline is usually cached {@link CostTotals} from a prior run,
while a candidate is usually fresh observations being measured now. Both paths converge on
{@link measureCostRun}, so a cached total and a freshly measured one are provably the same shape and
cannot be compared in two subtly different ways.
*/

/** One side of a comparison: either raw observations or an already-measured run. */
export type CostRunInput = readonly CostObservation[] | CostTotals;

/** Input to one cost-budget evaluation. */
export interface CostBudgetInput {
  /** The run the candidate is measured against. */
  baseline: CostRunInput;
  /** The run under evaluation. */
  candidate: CostRunInput;
  /** Per-axis absolute allowance the candidate may exceed the baseline by. */
  slack: CostBudgetSlack;
}

/** True when `value` is already-measured totals rather than a raw observation list. */
function isCostTotals(value: CostRunInput): value is CostTotals {
  return !Array.isArray(value);
}

/** Normalize either accepted input shape to measured totals. */
function toTotals(run: CostRunInput): CostTotals {
  return isCostTotals(run) ? run : measureCostRun(run);
}

/**
 * Refuse a run whose observations disagree with each other.
 *
 * A single measured run reports one corpus and one seed; that claim is only meaningful if every
 * observation in it agrees. The agreement verdict was recorded AT MEASUREMENT TIME
 * (`consistentCorpus`/`consistentSeed`) because summing destroys the evidence — by the time totals
 * exist, the second corpus id is gone, and a guard claiming to detect contamination would have
 * nothing left to detect it by. The duplicate check is kept here because it is about the task list
 * rather than the run identity, and the two together are the complete definition of "one coherent
 * run": every observation named the same corpus, named the same seed, and named a DIFFERENT task.
 */
function inconsistentRunReason(run: CostTotals): boolean {
  if (!run.consistentCorpus || !run.consistentSeed) return true;
  // taskCount is derived from the ordered id list, so a duplicate task id (the same task measured
  // twice in one run) is visible as a list shorter than the set of ids it claims to count.
  if (new Set(run.orderedTaskIds).size !== run.taskCount) return true;
  return false;
}

/** Signed difference for one axis. */
function axisDelta(baseline: CostTotals, candidate: CostTotals, axis: CostAxis): number {
  return candidate[axis] - baseline[axis];
}

/** Read a run's value for an axis. Typed through the axis so a new axis cannot be forgotten here. */
function axisValue(run: CostTotals, axis: CostAxis): number {
  return run[axis];
}

/**
 * Compare a candidate run against a baseline and answer whether it stayed inside its cost budget.
 *
 * Pure: the same inputs always produce a deep-equal verdict, including the same `baseline`/`candidate`
 * totals echoed back, so a caller can record exactly what was judged without re-deriving it.
 */
export function evaluateCostBudget(input: CostBudgetInput): CostBudgetVerdict {
  const baseline = toTotals(input.baseline);
  const candidate = toTotals(input.candidate);

  // A refusal never computes a delta, so both shapes share one construction path.
  const refuse = (reason: CostBudgetVerdict["reason"]): CostBudgetVerdict => ({
    verdict: "not-comparable",
    reason,
    baseline,
    candidate,
  });

  // Precedence 1 — either side's own observations must agree with the run they claim to be.
  if (inconsistentRunReason(baseline)) return refuse("inconsistent-run");
  if (inconsistentRunReason(candidate)) return refuse("inconsistent-run");

  // Precedence 2 — the same tasks on both sides.
  if (baseline.corpusId !== candidate.corpusId) return refuse("corpus-mismatch");

  // Precedence 3 — the same seed on both sides, so neither side's input order could have differed.
  if (baseline.seed !== candidate.seed) return refuse("seed-mismatch");

  // Precedence 4 — the same canonical order. Task-set and seed equality do NOT imply order equality:
  // two runs over the same tasks with the same seed can still have summed them differently, and a
  // per-task comparison downstream would then be reading mismatched rows.
  const sameOrder =
    baseline.orderedTaskIds.length === candidate.orderedTaskIds.length &&
    baseline.orderedTaskIds.every((taskId, index) => taskId === candidate.orderedTaskIds[index]);
  if (!sameOrder) return refuse("ordering-mismatch");

  const deltas: CostBudgetDeltas = {
    tokens: axisDelta(baseline, candidate, "tokens"),
    steps: axisDelta(baseline, candidate, "steps"),
    wallClockMs: axisDelta(baseline, candidate, "wallClockMs"),
  };

  const failures: CostBudgetFailure[] = [];
  for (const axis of COST_AXES) {
    const delta = deltas[axis];
    const allowance = input.slack[axis];
    if (delta > allowance) {
      failures.push({
        axis,
        baselineValue: axisValue(baseline, axis),
        candidateValue: axisValue(candidate, axis),
        delta,
        slack: allowance,
      });
    }
  }

  return {
    verdict: failures.length > 0 ? "over-budget" : "within-budget",
    deltas,
    failures,
    baseline,
    candidate,
  };
}
