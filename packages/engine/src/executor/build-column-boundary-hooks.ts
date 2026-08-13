/**
 * FNXC:CodeOrganization 2026-08-03-18:00:
 * buildColumnBoundaryHooks peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowColumnBoundary 2026-07-27-16:40 (PR #2475 review, P2):
 * Wiring lives in createExecutorColumnBoundaryHooks; this only threads Executor
 * state (in-flight graph-move marker + logger).
 */
import type { Task, TaskStore } from "@fusion/core";
import type { WorkflowColumnBoundaryHooks } from "../workflows/workflow-graph-task-runner.js";
import { createExecutorColumnBoundaryHooks } from "../workflow-column-boundary-hooks.js";
import { executorLog } from "../logger.js";
import { runContextForTotal } from "./run-context-for.js";
import type { EngineRunContext } from "../util/run-audit.js";

export type BuildColumnBoundaryHooksDeps = {
  /* FNXC:Identity 2026-08-12-01:20 (U18 Stage C): the live per-task run behind the boundary move. */
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  store: TaskStore;
  workflowLifecycleMovesInFlight: Set<string>;
};

export function buildColumnBoundaryHooks(
  deps: BuildColumnBoundaryHooksDeps,
  task: Pick<Task, "id">,
  workflowRunId?: string,
): WorkflowColumnBoundaryHooks {
  return createExecutorColumnBoundaryHooks({
    store: deps.store,
    /* FNXC:Identity 2026-08-12-01:20 (U18/KTD2 Stage C): the live per-task run when this boundary is built inside one, and the executor lane otherwise — a boundary built outside a run is still a write this lane made, so it is attributed rather than marked. */
    runContext: runContextForTotal(deps.getRunContextFor, task.id),
    task,
    workflowRunId,
    markMoveInFlight: (taskId) => deps.workflowLifecycleMovesInFlight.add(taskId),
    clearMoveInFlight: (taskId) => deps.workflowLifecycleMovesInFlight.delete(taskId),
    onWarn: (message, detail) => {
      executorLog.debug(`[workflow-column-boundary] ${task.id}: ${message} ${JSON.stringify(detail)}`);
    },
  });
}
