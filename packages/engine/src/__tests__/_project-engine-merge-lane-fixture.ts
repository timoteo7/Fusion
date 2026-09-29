type MergeLaneState = {
  mergeQueue: string[];
  mergeActive: Set<string>;
  mergeRetryResetTaskIds: Set<string>;
  mergeEnqueueDeferredByRetryReset: Set<string>;
  capacityDeferredMergeTaskIds: Set<string>;
  capacityDeferredMergeReasons: Map<string, string>;
  capacityDeferredMerges: Map<string, unknown>;
  coordinatorAdmittedMergeTaskIds: Set<string>;
  pausedReviewTaskIds: Set<string>;
  mergeSweepHoldReasons: Map<string, string>;
  mergeRunning: boolean;
  mergeRunningSince: number;
  activeMergeSession: { dispose(): void } | null;
  activeMergeTaskId: string | null;
  activeMergeStartedAtMs: number | null;
  mergeBodyInFlight: Promise<unknown> | null;
  mergeAbortController: AbortController | null;
  mergeRetryTimer: ReturnType<typeof setTimeout> | null;
  prMergeRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
  workspaceBusyReenqueues: Map<string, number>;
  workspaceBusyReenqueueTimers: Set<ReturnType<typeof setTimeout>>;
  manualMergeResolvers: Map<string, unknown[]>;
  mergeBodySettleTimeoutMs: number;
  shuttingDown: boolean;
  startupGeneration: number;
  started: boolean;
};

/**
 * FNXC:MergeQueue 2026-08-09-06:22:
 * Object.create(ProjectEngine.prototype) runs no class field initializers, so a prototype-only
 * merge fake starts with every merge-lane field undefined. FN-8871 requires this fixture to include
 * capacity and PR-retry merge state, preventing production drain additions from drifting test fakes.
 *
 * FNXC:MergeQueue 2026-09-26-05:45:
 * The fixture fell behind production for the SECOND time (the first was FUSI-030's missing `getTask`
 * collaborator). FN-9317 (`706c15560` "recover stalled in-review merges") added `mergeRetryResetTaskIds`
 * and `mergeEnqueueDeferredByRetryReset` to ProjectEngine; this fixture never learned them, so
 * `internalEnqueueMerge` threw `TypeError: Cannot read properties of undefined (reading 'has')` at
 * project-engine.ts:3123 and 8 cases in merge-abort-clears-transient-status.test.ts went red with an
 * error that read like a production crash. The tell is that a TypeError from deep inside
 * project-engine.ts can only be a fake defect: a real engine always runs its field initializers.
 * `mergeBodySettleTimeoutMs` is seeded here too. It is declared at project-engine.ts:1015, OUTSIDE the
 * `// ── Auto-merge state ──` block that project-engine-merge-lane-fixture-drift.test.ts scans, so the
 * ratchet cannot see it — but `awaitPriorMergeBodySettle` reads it, and on an unseeded prototype fake
 * `setTimeout(fn, undefined)` collapses the 60s drain latch to ~1ms. The tests that reach it each
 * override it to 1 by hand, which is exactly the smell: every consumer patches around the gap instead
 * of the gap being closed. Seed it with its production default and leave those overrides alone.
 */
export function seedMergeLaneState<T extends object>(
  engine: T,
  overrides: Partial<MergeLaneState> = {},
): T & MergeLaneState {
  const defaults: MergeLaneState = {
    mergeQueue: [],
    mergeActive: new Set(),
    /* FNXC:MergeRetryAdmission 2026-09-26-05:45: the process-local fence between Chat's
       status-none reset and queue admission (FN-9317). Empty is the production-equivalent default —
       no reset is committing on a fresh engine. */
    mergeRetryResetTaskIds: new Set(),
    mergeEnqueueDeferredByRetryReset: new Set(),
    capacityDeferredMergeTaskIds: new Set(),
    capacityDeferredMergeReasons: new Map(),
    capacityDeferredMerges: new Map(),
    coordinatorAdmittedMergeTaskIds: new Set(),
    pausedReviewTaskIds: new Set(),
    /* FNXC:MergeAuthority 2026-08-23-21:40: the merge-sweep hold-reason log de-duplicator. Empty is
       the production-equivalent default — a fresh engine has held nothing yet. */
    mergeSweepHoldReasons: new Map(),
    mergeRunning: false,
    mergeRunningSince: 0,
    activeMergeSession: null,
    activeMergeTaskId: null,
    activeMergeStartedAtMs: null,
    mergeBodyInFlight: null,
    mergeAbortController: null,
    mergeRetryTimer: null,
    prMergeRetryTimers: new Map(),
    workspaceBusyReenqueues: new Map(),
    workspaceBusyReenqueueTimers: new Set(),
    manualMergeResolvers: new Map(),
    /* FNXC:MergeQueue 2026-09-26-05:45: the orphan-body drain latch, 60s in production
       (project-engine.ts:1015). Undefined on a prototype fake collapses it to ~1ms. */
    mergeBodySettleTimeoutMs: 60_000,
    shuttingDown: false,
    startupGeneration: 0,
    started: true,
  };

  return Object.assign(engine, defaults, overrides);
}
