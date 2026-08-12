/**
 * FNXC:CodeOrganization 2026-08-10-04:05:
 * Shared sweep budgets peeled from self-healing.ts (U5 / wave19 Slice B).
 */
export const PHANTOM_EXECUTOR_BINDING_AGE_MULTIPLIER = 3;

/**
 * FNXC:PlanningEvacuation 2026-07-25-23:20:
 * Pre-execution worktree sweep waits a month of complete inactivity before reclaiming.
 */
export const PRE_EXECUTION_WORKTREE_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

export const MAX_STARVATION_DROPS = 3;
