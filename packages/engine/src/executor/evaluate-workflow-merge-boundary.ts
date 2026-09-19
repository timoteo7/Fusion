/**
 * FNXC:CodeOrganization 2026-08-03-17:00:
 * evaluateWorkflowMergeBoundary + getWorkflowMergeImplementationProofFailure peeled (U4).
 *
 * Graph merge admission: node-result presence/terminality, foreach coverage, and
 * skip-bypass taint / implementation-proof failures.
 */
import type { TaskDetail, TaskStore, WorkflowIr, WorkflowStepResult as CoreWorkflowStepResult } from "@fusion/core";
import { evaluateForeachMergeProof, evaluateSkipBypassTaint, resolveWorkflowIrForTask } from "@fusion/core";

export type EvaluateWorkflowMergeBoundaryDeps = {
  store: TaskStore;
  loadMergeBoundaryInstances: (taskId: string, runId?: string) => Promise<Array<{ foreachNodeId: string; stepIndex: number; pinnedStepCount: number }>>;
};

export type WorkflowMergeBoundaryProof = {
  resolved: boolean;
  hasRelevantNodeResult: boolean;
  allResultsTerminal: boolean;
  coverageComplete: boolean;
  hasLiveStepImplementationProof: boolean;
  hasForeachStepExecute: boolean;
  missingInstanceIds: string[];
  nonTerminalResult?: CoreWorkflowStepResult;
  complete: boolean;
};

/**
 * FNXC:WorkflowMerge 2026-09-19-03:58:
 * Resultados pre-merge podem vir de passos opcionais habilitados (source="optional-group"); a prova
 * de fronteira deve enxerga-los, senao tarefas com reviews aprovados ficam presas em
 * merge-boundary-unproven.
 *
 * Pre-merge results are produced by TWO graph runtimes: `node` (graph-authored node progress) and
 * `optional-group` (an enabled optional step such as the builtin Plan Review / Code Review groups).
 * Both are graph-native evidence that the graph ran, so the proof must accept both. Measured on a
 * live card (project proj_9ef728e7cc084681) whose only two workflowStepResults were
 * `phase="pre-merge"`, `status="passed"`, `source="optional-group"` (plan-review, code-review) with
 * enabledWorkflowSteps ["plan-review","code-review"]: this filter dropped them, the failure reported
 * `no-node-result`, and the card was parked at `merge-boundary-unproven — operator action required`.
 *
 * Nothing else is loosened: a non-pre-merge (e.g. post-merge) result stays out of the proof, and
 * terminality (`allResultsTerminal`) plus foreach instance coverage stay mandatory. Legacy compiled
 * workflow-step results carry no `source` and are deliberately not graph-native evidence.
 */
export function isGraphNativePreMergeResult(result: CoreWorkflowStepResult): boolean {
  return (result.source === "node" || result.source === "optional-group")
    && (result.phase ?? "pre-merge") === "pre-merge";
}

export async function evaluateWorkflowMergeBoundary(
  deps: EvaluateWorkflowMergeBoundaryDeps,
  task: TaskDetail,
  runId?: string,
): Promise<WorkflowMergeBoundaryProof> {
  const relevant = (task.workflowStepResults ?? []).filter(isGraphNativePreMergeResult);
  // FNXC:WorkflowMerge 2026-07-27-12:30: FN-8601 keeps required presence
  // independent from terminality: a failed node result proves execution occurred,
  // while allResultsTerminal separately rejects it at the merge boundary.
  const hasRelevantNodeResult = relevant.length > 0;
  const nonTerminalResult = relevant.find((result) => result.status !== "passed" && result.status !== "skipped");
  const allResultsTerminal = nonTerminalResult === undefined;
  let ir: WorkflowIr | undefined;
  try { ir = await resolveWorkflowIrForTask(deps.store, task.id); } catch { /* preserve legacy behavior for unresolved IRs */ }
  if (!ir) return { resolved: false, hasRelevantNodeResult, allResultsTerminal, coverageComplete: true, hasLiveStepImplementationProof: false, hasForeachStepExecute: false, missingInstanceIds: [], nonTerminalResult, complete: false };

  let persistedInstances: Array<{ foreachNodeId: string; stepIndex: number; pinnedStepCount: number }> = [];
  try { persistedInstances = await deps.loadMergeBoundaryInstances(task.id, runId); } catch { /* persistence is additive */ }
  const coverage = evaluateForeachMergeProof({ ir, steps: task.steps, workflowStepResults: task.workflowStepResults, persistedInstances });
  const coverageComplete = coverage.missingInstanceIds.length === 0;
  /*
  FNXC:WorkflowMerge 2026-08-20-00:50:
  FN-9157 accepts terminal live step-execute coverage as implementation proof for
  Review Level 0, whose explicit optional-group opt-out creates no node results.
  Require at least one expected instance and every identity to be live-step
  satisfied: zero parsed steps still need a node result, and any pending step
  remains incomplete.
  */
  const hasLiveStepImplementationProof = coverage.expectedInstanceIds.length > 0
    && coverage.expectedInstanceIds.every((id) => coverage.liveStepSatisfiedInstanceIds.includes(id));
  const complete = allResultsTerminal && coverageComplete && (hasRelevantNodeResult || hasLiveStepImplementationProof);
  return { resolved: true, hasRelevantNodeResult, allResultsTerminal, coverageComplete, hasLiveStepImplementationProof, hasForeachStepExecute: coverage.hasForeachStepExecute, missingInstanceIds: coverage.missingInstanceIds, nonTerminalResult, complete };
}

export type GetWorkflowMergeImplementationProofFailureDeps = {
  store: TaskStore;
  evaluateWorkflowMergeBoundary: (task: TaskDetail, runId?: string) => Promise<WorkflowMergeBoundaryProof>;
};

export async function getWorkflowMergeImplementationProofFailure(
  deps: GetWorkflowMergeImplementationProofFailureDeps,
  task: TaskDetail,
): Promise<string | undefined> {
  /*
  FNXC:Lifecycle 2026-07-16-21:40:
  FN-8141 — the graph merge boundary is another AUTO-promotion path. If the task is
  skip-bypass tainted (steps skipped after a bulk-step-completion refusal with no
  accepted fn_task_done), treat it as missing implementation proof so the merge is
  blocked with `implementation-incomplete` rather than laundered through a no-op merge.
  Runs before the noCommitsExpected exemption so a tainted task cannot slip past it.
  */
  const taint = evaluateSkipBypassTaint(task);
  if (taint.blocked) return "implementation did not run: steps were skipped after a bulk-step-completion refusal without an accepted fn_task_done";
  if (task.noCommitsExpected === true) return undefined;
  let ir: WorkflowIr | undefined;
  try { ir = await resolveWorkflowIrForTask(deps.store, task.id); } catch { ir = undefined; }
  if (!ir) return undefined;
  const usesParsedSteps = ir.nodes.some((node) => node.kind === "parse-steps");
  const usesExecuteSeam = ir.nodes.some((node) => node.kind === "prompt" && node.config?.seam === "execute");
  if (!usesParsedSteps && !usesExecuteSeam) return undefined;
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const hasTerminalParsedSteps = steps.length > 0 && steps.every((step) => step.status === "done" || step.status === "skipped");
  const hasModifiedFiles = (task.modifiedFiles?.length ?? 0) > 0;
  const proof = await deps.evaluateWorkflowMergeBoundary(task);
  const hasGraphNativeImplementationProof = proof.hasRelevantNodeResult && proof.allResultsTerminal && proof.coverageComplete;
  if (usesParsedSteps) {
    if (hasTerminalParsedSteps || hasGraphNativeImplementationProof) return undefined;
    return proof.hasForeachStepExecute && !proof.coverageComplete
      ? `implementation did not run: foreach step instances are incomplete (missing ${proof.missingInstanceIds.join(", ")})`
      : "implementation did not run: parsed coding steps are missing or incomplete";
  }
  if (usesExecuteSeam) return hasTerminalParsedSteps || hasModifiedFiles || hasGraphNativeImplementationProof ? undefined : "implementation did not run: execute seam has no completion proof";
  return undefined;
}
