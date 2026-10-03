import { createHash } from "node:crypto";
import { COST_AXES, type CostObservation, type CostTotals } from "./cost-budget-types.js";

/*
FNXC:SelfImproveCostBudget 2026-09-30-13:45:
`measureCostRun` is the only place a cost run becomes numbers. It is a PURE function of the
observations handed to it: no clock, no store, no engine import, no environment read, no randomness.
Everything about reproducibility rests here, so the module deliberately imports nothing but
`node:crypto` and its own types — a future edit that reaches for `Date.now()` or a store reader would
be visible in the import list, which is the cheapest possible guard against the one mistake that
would silently destroy the feature's entire value.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
Ordering is CANONICALIZED BY SORT, not by input position. The caller may collect observations from a
database cursor, an array, a Map, or a replay manifest whose iteration order is itself an artifact of
how it was built. Sorting by `taskId` makes the totals a function of the SET of observations rather
than of the order they arrived in, which is what lets a shuffled input produce a byte-identical
fingerprint. Two runs that merely arrived in different orders are still the same run.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
The fingerprint hashes the CANONICAL serialization, never the raw input. It covers the corpus id, the
seed, the task count, the ordered task ids, and all three measured totals — the complete set of facts
that makes two runs comparable. Hashing the caller's objects instead would make the digest a function
of property insertion order, of key spelling, and of whatever incidental fields a producer attached,
none of which are measured facts. Because a run's own measurement is part of its fingerprint, a run
whose numbers changed cannot collide with the run it replaced.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
`corpusId` and `seed` are TAKEN FROM THE OBSERVATIONS, not passed in as parameters. This makes a
mis-seeded or wrong-corpus run detectable rather than silently mislabeled: if a producer collects a
mixed set, the inconsistency is visible to the caller instead of being averaged away by an
authoritative-looking argument the caller supplied from memory. A run whose observations disagree
with each other still produces totals (the guard is the layer that REFUSES to compare such a run) —
measurement reports, the guard decides.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
Summing DESTROYS the evidence of a mixed corpus, so the measurement records `consistentCorpus` /
`consistentSeed` as measured facts rather than leaving them to be re-derived downstream. Once a
mixed set has been collapsed into one total, the second corpus id no longer exists anywhere and a
later layer genuinely cannot tell a coherent run from a contaminated one — a guard that claimed to
detect contamination but had nothing left to detect it would refuse for the wrong reason, and
worse, would look correct. Both flags are derived here, at the only point where the individual
observations are still available. They are part of the fingerprint: a run that was internally
contaminated must not be able to collide with a clean run that happened to total the same.

FNXC:SelfImproveCostBudget 2026-09-30-13:45:
The empty corpus is legal and its totals are all zero, with `taskCount: 0`. Refusing it here would
push the "is there anything to compare?" question into a throw, where a caller would have to catch an
exception to learn a fact it could simply read off `taskCount`. Two empty runs are trivially
comparable and must be trivially within budget, and that falls out of the arithmetic rather than
requiring a special case.
*/

/** Canonical ordering for a run's observations. Total: a task id can never tie with another. */
function compareByTaskId(left: CostObservation, right: CostObservation): number {
  if (left.taskId === right.taskId) return 0;
  return left.taskId < right.taskId ? -1 : 1;
}

/**
 * Sum a run's observations into comparable totals.
 *
 * Pure and total: any array of observations produces a {@link CostTotals}, including an empty array.
 * The observations are read but never mutated, and the returned `orderedTaskIds` is a fresh array —
 * the caller's input ordering is not aliased into the result, so a caller that re-sorts its own array
 * afterwards cannot retroactively change what this run measured.
 */
export function measureCostRun(observations: readonly CostObservation[]): CostTotals {
  const ordered = [...observations].sort(compareByTaskId);

  let tokens = 0;
  let steps = 0;
  let wallClockMs = 0;
  for (const observation of ordered) {
    tokens += observation.tokens;
    steps += observation.steps;
    wallClockMs += observation.wallClockMs;
  }

  const orderedTaskIds = ordered.map((observation) => observation.taskId);
  // An empty run has no observation to speak for it, so its corpus identity is the empty string
  // rather than an invented placeholder. Two empty runs still fingerprint identically, which is the
  // property that matters, and no caller can mistake the empty string for a named corpus.
  const corpusId = ordered[0]?.corpusId ?? "";
  const seed = ordered[0]?.seed ?? "";

  // Agreement is judged over the WHOLE run, and the FIRST observation's identity is the one reported
  // below — so a contaminated run is labeled with its first member's corpus and simultaneously
  // marked inconsistent, rather than being reported as a coherent run of some third corpus.
  const consistentCorpus = ordered.every((observation) => observation.corpusId === corpusId);
  const consistentSeed = ordered.every((observation) => observation.seed === seed);

  return {
    consistentCorpus,
    consistentSeed,
    corpusId,
    seed,
    taskCount: ordered.length,
    tokens,
    steps,
    wallClockMs,
    orderedTaskIds,
    fingerprint: fingerprintCostRun({
      consistentCorpus,
      consistentSeed,
      corpusId,
      seed,
      taskCount: ordered.length,
      orderedTaskIds,
      tokens,
      steps,
      wallClockMs,
    }),
  };
}

/** The canonical payload a cost fingerprint is computed over. Every field is a measured fact. */
function fingerprintCostRun(run: Omit<CostTotals, "fingerprint">): string {
  const canonical = JSON.stringify({
    consistentCorpus: run.consistentCorpus,
    consistentSeed: run.consistentSeed,
    corpusId: run.corpusId,
    seed: run.seed,
    taskCount: run.taskCount,
    orderedTaskIds: [...run.orderedTaskIds],
    axes: COST_AXES.map((axis) => [axis, run[axis]]),
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
