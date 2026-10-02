/*
FNXC:NoCommitReviewCard 2026-09-26-15:59:
Reproduction of the FUSI-005..FUSI-008 wedge: a report-only card that committed nothing reached
In Review with no branch and no worktree on disk, and was auto-disposed `failed` after three
identical `no-worktree-no-merge-confirmed` stalls.

These tests pin the CONTRACT, not one card:
1. A card with no branch, no owned commit, and no worktree classifies as
   `no-changes-finalized` and must be finalized as a no-op, because there is provably nothing
   to merge.
2. The neighbouring case that already works (branch exists, already landed, worktree present)
   must keep finalizing.
3. The merge gate's fail-closed answer for unreadable Git evidence must be UNCHANGED, so the
   guarantee that real content never merges without approval is not bought with this fix.
*/
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { getInReviewStallReason, getTaskMergeBlocker } from "@fusion/core";
import { captureMergeContentDescriptor } from "../../merge/merge-content-capture.js";
import { SelfHealingManager } from "../../self-healing.js";

function git(dir: string, cmd: string): string {
  return execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
}

function makeStore(task: Task, settings: Partial<Settings> = {}, events: unknown[] = []): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const mergedSettings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    mergeStrategy: "direct",
    directMergeCommitStrategy: "auto",
    includeTaskIdInCommit: false,
    commitAuthorEnabled: false,
    useAiMergeCommitSummary: false,
    mergeIntegrationWorktree: "cwd-main" as const,
    ...settings,
  } as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => mergedSettings),
    getTask: vi.fn(async () => task),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => (column ? [task].filter((t) => t.column === column) : [task])),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => Object.assign(task, updates)),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      task.column = column;
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => mergedSettings),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    recordRunAuditEvent: vi.fn(async (event: unknown) => {
      events.push(event);
    }),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    archiveTaskAndCleanup: vi.fn(async () => ({})),
    mergeTask: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => ""),
  }) as unknown as TaskStore & EventEmitter;
}

function initRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, "git init -b main");
  git(dir, 'git config user.email "test@example.com"');
  git(dir, 'git config user.name "Test"');
  writeFileSync(join(dir, "README.md"), "init\n");
  git(dir, "git add README.md && git commit -m 'init'");
  return dir;
}

function reviewCard(dir: string, overrides: Partial<Task>): Task {
  return {
    id: "FUSI-005",
    title: "read-only report",
    description: "d",
    column: "in-review",
    branch: "fusion/fusi-005",
    baseBranch: "main",
    baseCommitSha: git(dir, "git rev-parse main"),
    modifiedFiles: [],
    paused: false,
    status: undefined,
    mergeDetails: { mergeTargetBranch: "main", mergeTargetSource: "settings" },
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe("in-review card that produced no commit (real git)", () => {
  it("finalizes a card whose branch, worktree, and owned commit are all absent", async () => {
    const dir = initRepo("fusi-005-no-commit-");
    try {
      const task = reviewCard(dir, {});
      const store = makeStore(task);
      const manager = new SelfHealingManager(store, { rootDir: dir });

      const finalized = await manager.finalizeNoOpReviewTasks();

      expect(finalized).toBe(1);
      expect(task.column).toBe("done");
      expect(task.mergeDetails).toEqual(expect.objectContaining({
        mergeConfirmed: true,
        noOpMerge: true,
        noOpReason: "verification-only finalize: no branch and no owned commits",
      }));
      // The reported symptom: this card used to be auto-disposed `failed` by the third
      // identical `no-worktree-no-merge-confirmed` stall. Finalizing it must end that signal.
      expect(getInReviewStallReason(task, { reviewColumns: new Set(["in-review"]) })?.code)
        .not.toBe("no-worktree-no-merge-confirmed");
      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps finalizing the neighbouring case: branch exists, is already landed, worktree present", async () => {
    const dir = initRepo("fusi-005-landed-branch-");
    try {
      git(dir, "git checkout -b fusion/fusi-005");
      git(dir, "git checkout main");
      const task = reviewCard(dir, { worktree: `${dir}/.worktrees/fusi-005` });
      const store = makeStore(task);
      const manager = new SelfHealingManager(store, { rootDir: dir });

      const finalized = await manager.finalizeNoOpReviewTasks();

      expect(finalized).toBe(1);
      expect(task.column).toBe("done");
      expect(task.mergeDetails).toEqual(expect.objectContaining({
        mergeConfirmed: true,
        noOpMerge: true,
      }));
      manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("does not loosen the merge gate: unreadable Git evidence still fails closed", async () => {
    const dir = initRepo("fusi-005-gate-");
    try {
      // Same card, but the branch DOES exist with an unapproved change on it. The no-op
      // classifier must not read this as "nothing to merge", and the merge door must still
      // refuse a content approval it cannot prove.
      git(dir, "git checkout -b fusion/fusi-005");
      writeFileSync(join(dir, "report.md"), "unreviewed\n");
      git(dir, "git add report.md && git commit -m 'docs: report'");
      git(dir, "git checkout main");

      const task = reviewCard(dir, {
        workflowStepResults: [{
          workflowStepId: "code-review",
          status: "passed",
          verdict: "APPROVE",
          reviewKind: "code",
          reviewInputFingerprint: "stale-fingerprint",
        }] as Task["workflowStepResults"],
      });
      const settings = await makeStore(task).getSettings();
      const mergeContent = await captureMergeContentDescriptor(task, { workspaceRootDir: dir, settings: settings as unknown as Record<string, unknown> });

      expect(mergeContent).toEqual({ kind: "singular", diff: { state: "unavailable", reason: "missing-worktree-or-base" } });
      expect(getTaskMergeBlocker(task, {
        reviewColumns: new Set(["in-review"]),
        requiredPreMergeStepIds: new Set(["code-review"]),
        mergeContent,
      })).toBe("task has no provable approval for the content being merged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
