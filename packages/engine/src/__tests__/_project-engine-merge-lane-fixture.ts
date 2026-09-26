type MergeLaneState = {
  mergeQueue: string[];
  mergeActive: Set<string>;
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
  mergeRetryResetTaskIds: Set<string>;
  mergeEnqueueDeferredByRetryReset: Set<string>;
  workspaceBusyReenqueues: Map<string, number>;
  workspaceBusyReenqueueTimers: Set<ReturnType<typeof setTimeout>>;
  manualMergeResolvers: Map<string, unknown[]>;
  shuttingDown: boolean;
  startupGeneration: number;
  started: boolean;
};

/**
 * FNXC:MergeQueue 2026-08-09-06:22:
 * Object.create(ProjectEngine.prototype) runs no class field initializers, so a prototype-only
 * merge fake starts with every merge-lane field undefined. FN-8871 requires this fixture to include
 * capacity and PR-retry merge state, preventing production drain additions from drifting test fakes.
 */
export function seedMergeLaneState<T extends object>(
  engine: T,
  overrides: Partial<MergeLaneState> = {},
): T & MergeLaneState {
  const defaults: MergeLaneState = {
    mergeQueue: [],
    mergeActive: new Set(),
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
    /* FNXC:MergeRetryReset 2026-09-25-17:45: the merge-retry reset set. The drain reads
       `.has(task.id)` to short-circuit a task whose retry window was just reset, so a
       prototype fake without it answers `undefined` — falsy, as if no reset had happened.
       Empty is the production-equivalent default: a fresh engine has reset nothing. */
    mergeRetryResetTaskIds: new Set(),
    /* Same drain-read contract as the set above: the drain consults it when deciding whether a
       merge enqueue was already deferred by a retry reset. Empty is the production default. */
    mergeEnqueueDeferredByRetryReset: new Set(),
    workspaceBusyReenqueues: new Map(),
    workspaceBusyReenqueueTimers: new Set(),
    manualMergeResolvers: new Map(),
    shuttingDown: false,
    startupGeneration: 0,
    started: true,
  };

  return Object.assign(engine, defaults, overrides);
}
