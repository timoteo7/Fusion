/*
FNXC:SelfImprovePrimaryGate 2026-09-30-09:05:
FUSI-016 defines the DATA CONTRACT of the deterministic primary gate — the boolean verdict that
decides whether a self-improvement experiment candidate is kept or reverted. This module is the
single, pure declaration of what a gate run IS: the five step ids, the per-step outcome vocabulary,
and the verdict shape. It performs no I/O and imports nothing, so both the engine-side executor
and any later consumer (FUSI-017 test-count delta, FUSI-018 cost budget, FUSI-019 denylist,
FUSI-020 persisted verdict) depend on ONE definition of the verdict shape rather than each
re-deriving it.

FNXC:SelfImprovePrimaryGate 2026-09-30-09:05:
The verdict is deliberately BOOLEAN per step, not a score. The gate's entire purpose is a
deterministic yes/no an operator can trust, and any "mostly passing" aggregate would smuggle back
the judgment the gate exists to remove. Every step must pass for the overall verdict to pass; a
single failing step is enough to reject. This is encoded in `passed` being derived, not authored.

FNXC:SelfImprovePrimaryGate 2026-09-30-09:05:
`PrimaryGateFingerprint` is content-addressed over EXACTLY the inputs that can change a verdict
(sorted step ids, per-step booleans, sorted affected-test files, candidate sha). It deliberately
excludes wall-clock, durations, log text, and any locale-dependent ordering: two runs of the same
candidate over the same corpus MUST produce the same fingerprint so the gate is reproducible and
"revert" decisions are auditable. The recipe lives in the engine assembly (Step 2); this module
only owns the type so the shape has a single declaration.
*/

/**
 * The five deterministic checks a candidate must pass. Fixed and ordered: the array order here is
 * the canonical gate order, and the fingerprint sorts these ids so ordering never leaks into it.
 */
export const PRIMARY_GATE_STEP_IDS = ["build", "lint", "typecheck", "gate", "affected-tests"] as const;

/** One of the five primary-gate steps. */
export type PrimaryGateStepId = (typeof PRIMARY_GATE_STEP_IDS)[number];

/**
 * Per-step result vocabulary.
 *
 * - `passed` / `failed` are the two behavioral verdicts.
 * - `timed-out` and `unreadable` are INFRA outcomes, recorded distinctly from a behavioral failure
 *   so a hung or unreadable step is never silently conflated with "the candidate is good". Both
 *   count as NOT passing — the gate fails closed on them (see `PrimaryGateStep.passed`), because
 *   an unreadable step is missing evidence, and missing evidence must not approve a candidate.
 */
export type PrimaryGateStepOutcome = "passed" | "failed" | "timed-out" | "unreadable";

/**
 * One step's result. `passed` is a derived convenience boolean: true ONLY for the `passed` outcome.
 * Every other outcome — including the two infra outcomes — is not-passing, so a timed-out or
 * unreadable step fails the whole gate closed.
 */
export interface PrimaryGateStep {
  /** Which of the five checks this is. */
  id: PrimaryGateStepId;
  /** Behavioral or infra result for this step. */
  outcome: PrimaryGateStepOutcome;
  /** Convenience flag: true iff `outcome === "passed"`. */
  passed: boolean;
}

/**
 * The scope of tests the gate will run, resolved from the candidate's changed files.
 *
 * - `resolved` — at least one affected test file was found; the gate runs exactly these.
 * - `empty` — the diff named no test-relevant change, so there is nothing to run. This is an
 *   EXPLICIT state, not a silent pass: callers decide policy, they do not infer a pass from an
 *   absent list.
 * - `shared-infra` — the diff touched shared build/test infrastructure (root config, a test
 *   harness script, etc.), so per-file resolution is not sound. The gate treats this as needing the
 *   merge gate (the `gate` step) to carry coverage, and it is surfaced distinctly rather than
 *   being silently widened to a whole-workspace run.
 */
export type AffectedTestScope =
  | { kind: "resolved"; testFiles: string[]; packages: string[] }
  | { kind: "empty" }
  | { kind: "shared-infra"; reason: string };

/**
 * The complete, deterministic verdict of one primary-gate run.
 *
 * `fingerprint` content-addresses the decision (see the module FNXC). `steps` is the full five-step
 * record so an operator can see WHICH check failed without re-running. `failedStepCount` and
 * `affectedTestCount` are precomputed counts for the run-audit metadata (ids/counts/outcomes-only).
 */
export interface PrimaryGateVerdict {
  /** False when ANY step failed or was infra-unavailable. Derived; never authored. */
  passed: boolean;
  /** Content-addressed identity of this verdict's inputs. */
  fingerprint: string;
  /** The candidate commit sha the verdict was computed against. */
  candidateSha: string;
  /** The five per-step results, in canonical step order. */
  steps: PrimaryGateStep[];
  /** How many steps did not pass. Precomputed for run-audit. */
  failedStepCount: number;
  /** How many affected test files were resolved (0 for empty/shared-infra). */
  affectedTestCount: number;
  /** The resolved affected-test scope this verdict was computed against. */
  affectedScope: AffectedTestScope;
}
