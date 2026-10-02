/**
 * FNXC:CodeOrganization 2026-08-03-21:25:
 * scheduleWorkflowRerun peeled from TaskExecutor (U4).
 * Immediate bounce + delayed watchdog retry when workflow rerun handoff stalls.
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): the INVERSE of the guard above — this one
 * SKIPS a card that is still executing. Note the direction: with the literal on a renamed board it
 * never matched, so a rerun could fire on a card mid-execution. A mechanical sweep of every
 * `!== "in-progress"` would fix the refusals and leave this admission in place.
 */
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";

export type WorkflowRerunWatchdogDeps = {
  store: TaskStore;
  workflowRerunWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
  workflowRerunWatchdogMs: number;
  clearWorkflowRerunWatchdog: (taskId: string) => void;
  performWorkflowRerunBounce: (
    taskId: string,
    worktreePath: string,
    preserveResumeState: boolean,
    persistWorktreePath?: boolean,
  ) => Promise<"bounced" | "skipped-pending" | "deferred-paused" | "deferred-capacity" | "refused-no-remediation">;
  getExecutionPauseLabel: () => Promise<string | null>;
  resolveResumeLanes: (taskId: string) => Promise<{ wip: string }>;
};

export function scheduleWorkflowRerun(
  deps: WorkflowRerunWatchdogDeps,
  taskId: string,
  worktreePath: string,
  successMessage: string,
  preserveResumeState: boolean = true,
  /*
  FNXC:ExternalExecutionCheckout 2026-08-09-22:43:
  When false, bounce must not write the operator external path into task.worktree.
  */
  persistWorktreePath: boolean = true,
): void {
  deps.clearWorkflowRerunWatchdog(taskId);

  setTimeout(async () => {
    try {
      const outcome = await deps.performWorkflowRerunBounce(taskId, worktreePath, preserveResumeState, persistWorktreePath);
      if (outcome === "bounced") {
        executorLog.log(successMessage);
      } else if (outcome === "skipped-pending") {
        executorLog.warn(`${taskId}: rerun bounce skipped — another bounce already in flight`);
      } else if (outcome === "deferred-capacity") {
        /*
        FNXC:ReviewBounceCapacityHandOff 2026-10-02-00:20:
        This deferral is DURABLE, not dropped: `performWorkflowRerunBounce` recorded a capacity wait
        (the same durable continuation shape the graph's own capacity-suspend uses), which the due-drain
        resumes once a slot frees. Before FUSI-068 this line promised "retrying later" with nothing
        behind it and the card stranded forever.
        */
        executorLog.log(`${taskId}: rerun bounce deferred while the WIP lane is at capacity — durable wait recorded`);
      } else {
        executorLog.log(`${taskId}: rerun bounce deferred while pause is active`);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`${taskId}: failed to schedule rerun bounce: ${errorMessage}`);
    }
  }, 0);

  const watchdog = setTimeout(async () => {
    deps.workflowRerunWatchdogs.delete(taskId);

    const pauseLabel = await deps.getExecutionPauseLabel();
    if (pauseLabel) {
      executorLog.log(`${taskId}: workflow rerun watchdog skipped — ${pauseLabel} active`);
      return;
    }

    let currentTask: Task | null = null;
    try {
      currentTask = await deps.store.getTask(taskId);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${taskId}: workflow rerun watchdog could not read latest task state: ${errorMessage}`);
      return;
    }

    if (!currentTask || currentTask.paused
      || currentTask.column === (await deps.resolveResumeLanes(taskId)).wip) {
      return;
    }

    executorLog.warn(
      `${taskId}: workflow rerun watchdog fired after ${deps.workflowRerunWatchdogMs / 1000}s ` +
      `— task is still ${currentTask.column}; retrying handoff once`,
    );
    await deps.store.logEntry(
      taskId,
      `Watchdog: workflow rerun handoff stalled for ${deps.workflowRerunWatchdogMs / 1000}s ` +
      `(still ${currentTask.column}) — retrying once`,
    ).catch(() => undefined);

    try {
      const outcome = await deps.performWorkflowRerunBounce(taskId, worktreePath, preserveResumeState, persistWorktreePath);
      if (outcome === "bounced") {
        executorLog.warn(`${taskId}: workflow rerun watchdog retry succeeded`);
      } else if (outcome === "skipped-pending") {
        // The original bounce is still mid-flight, which means *it* is the
        // one that's hung — not us. Log honestly so operators don't see a
        // false "succeeded" message while the task is actually stranded.
        executorLog.error(
          `${taskId}: workflow rerun watchdog retry skipped — original bounce still in flight after ${deps.workflowRerunWatchdogMs / 1000}s; task may be stuck`,
        );
        await deps.store.logEntry(
          taskId,
          `Workflow rerun watchdog retry skipped — original bounce still in flight after ${deps.workflowRerunWatchdogMs / 1000}s; task may be stuck`,
        ).catch(() => undefined);
      } else if (outcome === "deferred-capacity") {
        /*
        FNXC:ReviewBounceCapacityHandOff 2026-10-02-00:20:
        A second deferral is NOT terminal. The bounce re-recorded its durable capacity wait on this
        attempt too (idempotent via the active-continuation guard), and the watchdog's own map entry
        being deleted here no longer matters: delivery no longer depends on this process-local timer.
        */
        executorLog.log(`${taskId}: workflow rerun watchdog retry deferred while the WIP lane is at capacity — durable wait still armed`);
        await deps.store.logEntry(
          taskId,
          "Workflow rerun watchdog retry deferred — WIP lane at capacity; durable wait remains armed and resumes when a slot frees",
        ).catch(() => undefined);
      } else if (outcome === "refused-no-remediation") {
        executorLog.warn(`${taskId}: workflow rerun watchdog retry refused because no remediation work is pending`);
        await deps.store.logEntry(
          taskId,
          "Workflow rerun watchdog stopped — no pending remediation work",
          "The hand-off was refused rather than deferred; create remediation work before requesting another review-to-WIP move.",
        ).catch(() => undefined);
      } else {
        executorLog.log(`${taskId}: workflow rerun watchdog retry deferred while pause is active`);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`${taskId}: workflow rerun watchdog retry failed: ${errorMessage}`);
    }
  }, deps.workflowRerunWatchdogMs);

  deps.workflowRerunWatchdogs.set(taskId, watchdog);
}
