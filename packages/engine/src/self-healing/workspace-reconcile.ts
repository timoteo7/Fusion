/**
 * FNXC:CodeOrganization 2026-08-10-04:05:
 * Workspace reconcilers peeled from SelfHealingManager (U5 / wave19 Slice B).
 *
 * FNXC:Workspace 2026-06-22-09:30 / 2026-06-22-14:10:
 * Partial-land re-enqueue, phantom land-lease reclaim, pre-execution worktree release,
 * and orphaned per-repo worktree cleanup. Bounded, no temp-root walks.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Task, TaskStore } from "@fusion/core";
import {
  REVIEW_ROLES,
  allowsAutoMergeProcessing,
  columnsWithFlag,
  isWorkspaceTask,
  resolveProjectColumnsForRoles,
  resolveWorkflowIrForTaskWithProvenance,
} from "@fusion/core";
import { createLogger } from "../logger.js";
import { ACTIVE_MERGE_STATUSES } from "../merge/merge-active-status.js";
import { isRepoLanded } from "../merge/workspace-land-predicate.js";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import { STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS } from "../healing/self-healing-constants.js";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { createRunAuditor, generateSyntheticRunId, type RunAuditor } from "../util/run-audit.js";
import { execAsync, shellQuote } from "../self-healing-git-evidence.js";
import { isWorkspaceOwnerLive, isWorkspaceTaskLive } from "./workspace-liveness.js";
import {
  MAX_STARVATION_DROPS,
  PHANTOM_EXECUTOR_BINDING_AGE_MULTIPLIER,
  PRE_EXECUTION_WORKTREE_MAX_IDLE_MS,
} from "./sweep-constants.js";

const log = createLogger("self-healing");

export type WorkspaceReconcileHost = {
  store: TaskStore;
  options: {
    rootDir: string;
    getActiveMergeTaskId?: () => string | null;
    isMergePending?: (taskId: string) => boolean;
    isTaskActive?: (taskId: string) => boolean;
    enqueueMerge?: (taskId: string) => boolean;
    releasePreExecutionWorktree?: (taskId: string, reason: string) => Promise<boolean>;
  };
  workspacePartialLandDrops: Map<string, number>;
  orphanWorktreeRemovalFailures: Map<string, number>;
  repoBranchExists: (repoRootDir: string, branch: string) => Promise<boolean>;
};

async function emitWorkspacePartialLandNoAction(
  host: WorkspaceReconcileHost,
  task: Task,
  reason: "auto-merge-off" | "user-paused" | "live-worktree" | "merge-pending",
  livePaths: string[],
): Promise<void> {
  try {
    await createRunAuditor(host.store, {
      runId: generateSyntheticRunId("self-healing-workspace-partial-land-no-action", task.id),
      agentId: "self-healing",
      taskId: task.id,
      taskLineageId: task.lineageId,
      phase: "reconcile-workspace-partial-land",
    }).database({
      type: "task:reconcile-workspace-partial-land-no-action",
      target: task.id,
      metadata: { taskId: task.id, reason, livePaths },
    });
  } catch (err: unknown) {
    log.warn(`reconcileWorkspacePartialLands: audit emit failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function enqueueWorkspaceMergeBounded(
  host: WorkspaceReconcileHost,
  task: Task,
  auditor: RunAuditor,
  input: { landedRepos: string[]; unlandedRepos: string[]; reason: string; successLog: string },
): Promise<boolean> {
  const enqueueMerge = host.options.enqueueMerge;
  if (!enqueueMerge) {
    host.workspacePartialLandDrops.delete(task.id);
    await host.store.logEntry(task.id, `${input.successLog} (enqueue not wired — deferred to next sweep)`);
    await auditor.database({
      type: "task:reconcile-workspace-partial-land",
      target: task.id,
      metadata: { taskId: task.id, landedRepos: input.landedRepos, unlandedRepos: input.unlandedRepos, failedRepos: [], action: "re-enqueue-noop", reason: input.reason },
    }).catch(() => undefined);
    return false;
  }

  const queued = enqueueMerge(task.id);
  if (queued) {
    host.workspacePartialLandDrops.delete(task.id);
    await host.store.logEntry(task.id, input.successLog);
    await auditor.database({
      type: "task:reconcile-workspace-partial-land",
      target: task.id,
      metadata: { taskId: task.id, landedRepos: input.landedRepos, unlandedRepos: input.unlandedRepos, failedRepos: [], action: "re-enqueue", reason: input.reason },
    }).catch(() => undefined);
    return false;
  }

  const drops = (host.workspacePartialLandDrops.get(task.id) ?? 0) + 1;
  host.workspacePartialLandDrops.set(task.id, drops);
  log.warn(`reconcileWorkspacePartialLands: enqueue dropped for ${task.id} (${drops}/${MAX_STARVATION_DROPS}); merge queue rejected re-enqueue`);
  if (drops >= MAX_STARVATION_DROPS) {
    const error = `Workspace partial-land starvation: ${MAX_STARVATION_DROPS} consecutive enqueue attempts were dropped by the merge queue; task requires manual intervention.`;
    await host.store.updateTask(task.id, { status: "failed", error });
    await host.store.logEntry(task.id, error);
    host.workspacePartialLandDrops.delete(task.id);
    await auditor.database({
      type: "task:reconcile-workspace-partial-land",
      target: task.id,
      metadata: { taskId: task.id, landedRepos: input.landedRepos, unlandedRepos: input.unlandedRepos, failedRepos: [], action: "park-failed", reason: "enqueue-starvation" },
    }).catch(() => undefined);
    return true;
  }
  await auditor.database({
    type: "task:reconcile-workspace-partial-land",
    target: task.id,
    metadata: { taskId: task.id, landedRepos: input.landedRepos, unlandedRepos: input.unlandedRepos, failedRepos: [], action: "re-enqueue-dropped", reason: input.reason, drops },
  }).catch(() => undefined);
  return false;
}

export async function reconcileWorkspacePartialLands(host: WorkspaceReconcileHost): Promise<number> {
  try {
    const settings = await host.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return 0;

    const activeMergeTaskId = host.options.getActiveMergeTaskId?.() ?? null;
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-21:40:
    Workspace tasks live in the review lane while per-repo lands are incomplete.
    */
    const wsPartialColumns = await resolveProjectColumnsForRoles(host.store, REVIEW_ROLES);
    const wsPartialById = new Map<string, Task>();
    for (const column of wsPartialColumns) {
      for (const entry of await host.store.listTasks({ column, slim: true })) wsPartialById.set(entry.id, entry);
    }
    const tasks = [...wsPartialById.values()];
    const wsPartialLanes = new Map<string, Set<string>>();
    for (const entry of tasks) {
      try {
        const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(host.store, entry.id);
        wsPartialLanes.set(
          entry.id,
          source === "default"
            ? new Set(wsPartialColumns)
            : new Set(REVIEW_ROLES.flatMap((role) => [...columnsWithFlag(ir, role)])),
        );
      } catch {
        wsPartialLanes.set(entry.id, new Set(wsPartialColumns));
      }
    }
    const candidates = tasks.filter((task) =>
      (wsPartialLanes.get(task.id) ?? wsPartialColumns).has(task.column) &&
      isWorkspaceTask(task) &&
      task.mergeDetails?.mergeConfirmed !== true &&
      !(task.status && ACTIVE_MERGE_STATUSES.has(task.status)),
    );
    const candidateIds = new Set(candidates.map((t) => t.id));
    for (const taskId of [...host.workspacePartialLandDrops.keys()]) {
      if (!candidateIds.has(taskId)) host.workspacePartialLandDrops.delete(taskId);
    }

    if (candidates.length === 0) return 0;

    let recovered = 0;
    for (const task of candidates) {
      try {
        if (!allowsAutoMergeProcessing(task, settings)) {
          await emitWorkspacePartialLandNoAction(host, task, "auto-merge-off", []);
          continue;
        }
        if (task.userPaused || task.paused) {
          await emitWorkspacePartialLandNoAction(host, task, "user-paused", []);
          continue;
        }
        const liveness = isWorkspaceTaskLive(task, host.options.isTaskActive);
        if (liveness.live) {
          await emitWorkspacePartialLandNoAction(host, task, "live-worktree", liveness.livePaths);
          continue;
        }
        if (activeMergeTaskId && activeMergeTaskId === task.id) {
          await emitWorkspacePartialLandNoAction(host, task, "live-worktree", liveness.livePaths);
          continue;
        }
        /*
        FNXC:Workspace 2026-06-22-16:40:
        GUARD 5 — task is anywhere in the in-memory merge pipeline.
        */
        if (host.options.isMergePending?.(task.id) === true) {
          await emitWorkspacePartialLandNoAction(host, task, "merge-pending", liveness.livePaths);
          continue;
        }

        const workspaceWorktrees = task.workspaceWorktrees ?? {};
        const repoKeys = Object.keys(workspaceWorktrees);
        const landedRepos: string[] = [];
        const unlandedRepos: string[] = [];
        const unrecoverableRepos: string[] = [];
        for (const repoRel of repoKeys) {
          const entry = workspaceWorktrees[repoRel];
          const repoRootDir = join(host.options.rootDir, repoRel);
          let integrationBranch: string;
          try {
            integrationBranch = await resolveIntegrationBranch(
              repoRootDir,
              { ...settings, integrationBranch: undefined, baseBranch: undefined },
            );
          } catch {
            unlandedRepos.push(repoRel);
            continue;
          }
          if (await isRepoLanded(repoRootDir, integrationBranch, entry.landedSha, task.id, entry.branch)) {
            landedRepos.push(repoRel);
            continue;
          }
          const branchPresent = entry.branch
            ? await host.repoBranchExists(repoRootDir, entry.branch)
            : false;
          if (!branchPresent) {
            unrecoverableRepos.push(repoRel);
          } else {
            unlandedRepos.push(repoRel);
          }
        }

        const auditor = createRunAuditor(host.store, {
          runId: generateSyntheticRunId("self-healing-workspace-partial-land", task.id),
          agentId: "self-healing",
          taskId: task.id,
          taskLineageId: task.lineageId,
          phase: "reconcile-workspace-partial-land",
        });

        if (unrecoverableRepos.length > 0) {
          const error = `Workspace partial-land unrecoverable: sub-repo(s) ${unrecoverableRepos.join(", ")} have no fusion/${task.id.toLowerCase()} branch and no landedSha — manual intervention required.`;
          await host.store.updateTask(task.id, { status: "failed", error });
          await host.store.logEntry(task.id, error);
          await auditor.database({
            type: "task:reconcile-workspace-partial-land",
            target: task.id,
            metadata: { taskId: task.id, landedRepos, unlandedRepos, failedRepos: unrecoverableRepos, action: "park-failed", reason: "branch-gone-and-unlanded" },
          }).catch(() => undefined);
          log.warn(`reconcileWorkspacePartialLands: parked ${task.id} failed (unrecoverable repos: ${unrecoverableRepos.join(", ")})`);
          recovered++;
          continue;
        }

        if (unlandedRepos.length === 0) {
          await enqueueWorkspaceMergeBounded(host, task, auditor, {
            landedRepos,
            unlandedRepos: [],
            reason: "all-landed-not-finalized",
            successLog: "Auto-recovered (workspace): all sub-repos landed but task not finalized — re-enqueued finalize-once",
          });
          recovered++;
          continue;
        }

        await enqueueWorkspaceMergeBounded(host, task, auditor, {
          landedRepos,
          unlandedRepos,
          reason: landedRepos.length > 0 ? "partial-land" : "zero-land",
          successLog: `Auto-recovered (workspace): re-enqueued partial land (${landedRepos.length} landed, ${unlandedRepos.length} pending)`,
        });
        recovered++;
      } catch (err: unknown) {
        log.error(`reconcileWorkspacePartialLands: failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (recovered > 0) log.log(`reconcileWorkspacePartialLands: recovered ${recovered} workspace task(s)`);
    return recovered;
  } catch (err: unknown) {
    log.error(`reconcileWorkspacePartialLands sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

export async function reclaimPhantomWorkspaceLandLeases(host: WorkspaceReconcileHost): Promise<number> {
  try {
    const settings = await host.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return 0;

    const entries = activeSessionRegistry.entriesByKind("workspace-repo-land");
    if (entries.length === 0) return 0;

    const leaseOwnerCompleteColumns = await resolveProjectColumnsForRoles(host.store, ["complete"]);
    const graceMs = settings.taskStuckTimeoutMs ?? STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS;
    const staleFloorMs = graceMs * PHANTOM_EXECUTOR_BINDING_AGE_MULTIPLIER;
    const activeMergeTaskId = host.options.getActiveMergeTaskId?.() ?? null;
    const now = Date.now();

    let reclaimed = 0;
    for (const entry of entries) {
      try {
        const ageMs = now - entry.registeredAt;
        if (ageMs < staleFloorMs) continue;
        if (activeMergeTaskId && activeMergeTaskId === entry.taskId) continue;
        if (executingTaskLock.has(entry.taskId) || host.options.isTaskActive?.(entry.taskId) === true) continue;
        if (host.options.isMergePending?.(entry.taskId) === true) continue;

        const owner = await host.store.getTask(entry.taskId).catch(() => null);
        const ownerColumn = owner?.column ?? "deleted";
        if (isWorkspaceOwnerLive(owner, leaseOwnerCompleteColumns)) continue;

        activeSessionRegistry.unregisterPath(entry.path);
        await createRunAuditor(host.store, {
          runId: generateSyntheticRunId("self-healing-phantom-workspace-land-lease", entry.taskId),
          agentId: "self-healing",
          taskId: entry.taskId,
          phase: "reclaim-phantom-workspace-land-lease",
        }).database({
          type: "task:reclaim-phantom-workspace-land-lease",
          target: entry.taskId,
          metadata: { taskId: entry.taskId, path: entry.path, kind: entry.kind, registeredAt: entry.registeredAt, ageMs, staleBindingAgeFloorMs: staleFloorMs, ownerColumn },
        }).catch(() => undefined);
        log.warn(`reclaimPhantomWorkspaceLandLeases: reclaimed leaked land lease on ${entry.path} (owner ${entry.taskId}, age ${ageMs}ms)`);
        reclaimed++;
      } catch (err: unknown) {
        log.error(`reclaimPhantomWorkspaceLandLeases: failed for ${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (reclaimed > 0) log.log(`reclaimPhantomWorkspaceLandLeases: reclaimed ${reclaimed} leaked lease(s)`);
    return reclaimed;
  } catch (err: unknown) {
    log.error(`reclaimPhantomWorkspaceLandLeases sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

export async function reconcilePreExecutionWorktrees(host: WorkspaceReconcileHost): Promise<number> {
  try {
    const release = host.options.releasePreExecutionWorktree;
    if (!release) return 0;
    const settings = await host.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return 0;

    const now = Date.now();
    const preExecLiveColumns = await resolveProjectColumnsForRoles(
      host.store,
      ["intake", "hold", "countsTowardWip", ...REVIEW_ROLES, "complete"],
    );
    const parked = await host.store.listTasks({ slim: true });
    const candidates = parked.filter((task) => {
      if (!task.worktree || task.deletedAt) return false;
      if (task.firstExecutionAt || task.executionStartedAt) return false;
      if (preExecLiveColumns.has(task.column)) return false;
      if (task.paused || task.userPaused) return false;
      if (task.status != null) return false;
      if (task.blockedBy || task.overlapBlockedBy || task.nextRecoveryAt) return false;
      const lastTouchedMs = Math.max(
        Date.parse(task.columnMovedAt ?? "") || 0,
        Date.parse(task.updatedAt ?? "") || 0,
      );
      if (!lastTouchedMs) return false;
      return now - lastTouchedMs >= PRE_EXECUTION_WORKTREE_MAX_IDLE_MS;
    });
    if (candidates.length === 0) return 0;

    let released = 0;
    for (const task of candidates) {
      try {
        if (await release(task.id, `parked pre-execution in '${task.column}'`)) released++;
      } catch (err: unknown) {
        log.warn(`reconcilePreExecutionWorktrees: release failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (released > 0) log.log(`reconcilePreExecutionWorktrees: released ${released} pre-execution worktree(s)`);
    return released;
  } catch (err: unknown) {
    log.error(`reconcilePreExecutionWorktrees sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

export async function reconcileOrphanedWorkspaceWorktrees(host: WorkspaceReconcileHost): Promise<number> {
  try {
    const settings = await host.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return 0;

    const wsDoneColumns = await resolveProjectColumnsForRoles(host.store, ["complete"]);
    const wsDoneById = new Map<string, Task>();
    for (const column of wsDoneColumns) {
      for (const entry of await host.store.listTasks({ column, slim: true })) wsDoneById.set(entry.id, entry);
    }
    const candidates = [...wsDoneById.values()].filter((task) => isWorkspaceTask(task));
    if (candidates.length === 0) return 0;

    let cleaned = 0;
    for (const task of candidates) {
      const workspaceWorktrees = task.workspaceWorktrees ?? {};
      for (const repoRel of Object.keys(workspaceWorktrees)) {
        const worktreePath = workspaceWorktrees[repoRel]?.worktreePath;
        if (!worktreePath) continue;
        if (activeSessionRegistry.isPathActive(worktreePath)) continue;
        if (!existsSync(worktreePath)) {
          host.orphanWorktreeRemovalFailures.delete(worktreePath);
          continue;
        }
        if ((host.orphanWorktreeRemovalFailures.get(worktreePath) ?? 0) >= MAX_STARVATION_DROPS) {
          continue;
        }

        const repoRootDir = join(host.options.rootDir, repoRel);
        let success = false;
        /*
        FNXC:CodeOrganization 2026-08-13-03:33:
        Run-audit metadata stays ids/counts/outcomes-only. Git remove failures use a closed
        outcome code here; the unbounded git error stays in the operator log only.
        */
        let outcome: "removed" | "git-remove-failed" = "removed";
        let failureDetail = "";
        try {
          await execAsync(`git worktree remove --force ${shellQuote(worktreePath)}`, {
            cwd: repoRootDir,
            timeout: 120_000,
          });
          success = true;
        } catch (err: unknown) {
          outcome = "git-remove-failed";
          failureDetail = err instanceof Error ? err.message : String(err);
        }
        try {
          await createRunAuditor(host.store, {
            runId: generateSyntheticRunId("self-healing-orphaned-workspace-worktree", task.id),
            agentId: "self-healing",
            taskId: task.id,
            taskLineageId: task.lineageId,
            phase: "reconcile-orphaned-workspace-worktree",
          }).database({
            type: "task:reconcile-orphaned-workspace-worktree",
            target: task.id,
            metadata: { taskId: task.id, repo: repoRel, worktreePath, success, reason: outcome },
          });
        } catch { /* audit best-effort */ }
        if (success) {
          host.orphanWorktreeRemovalFailures.delete(worktreePath);
          log.log(`reconcileOrphanedWorkspaceWorktrees: removed ${worktreePath} (task ${task.id}, repo ${repoRel})`);
          cleaned++;
        } else {
          const failures = (host.orphanWorktreeRemovalFailures.get(worktreePath) ?? 0) + 1;
          host.orphanWorktreeRemovalFailures.set(worktreePath, failures);
          log.warn(`reconcileOrphanedWorkspaceWorktrees: ${outcome}${failureDetail ? `: ${failureDetail}` : ""} for ${worktreePath} (task ${task.id}, repo ${repoRel}) [${failures}/${MAX_STARVATION_DROPS}]${failures >= MAX_STARVATION_DROPS ? " — giving up; manual cleanup required" : ""}`);
        }
      }
    }
    if (cleaned > 0) log.log(`reconcileOrphanedWorkspaceWorktrees: removed ${cleaned} orphaned per-repo worktree(s)`);
    return cleaned;
  } catch (err: unknown) {
    log.error(`reconcileOrphanedWorkspaceWorktrees sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
