# Workspaces (Multi-Repository Projects)

## Overview

A workspace is one Fusion project whose root is **not** a Git repository and whose direct child directories are Git repositories. Use it when one task regularly changes several repositories that must be reviewed and landed together. Use separate Fusion projects when the repositories have independent task queues, settings, or lifecycle ownership.

| Concern | Single-repository project | Workspace project |
| --- | --- | --- |
| Project root | Git repository | Browse-only non-Git parent directory |
| Task checkout | One root worktree | One on-demand worktree per configured sub-repository |
| Landing | One merge | Per-repository, non-atomic land loop |
| Recovery | Single merge recovery | Per-repository landing proof and partial-land recovery |

## Setup and detection

You can register a workspace from three surfaces:

- In the **Setup Wizard**, choose **Use Existing Directory**. Fusion calls `POST /api/projects/detect-workspace` while you select the directory and pre-checks **Workspace mode (multi-repo)** when it finds candidates. The checkbox applies only to an existing directory.
- The project registration API accepts `workspaceMode`. An explicit `true` requests detection; an omitted value also permits automatic detection. The detection endpoint returns `{ repos, isWorkspace }`.
- The interactive CLI project resolver detects candidates, asks you to confirm workspace mode, initializes the store, then writes the workspace configuration.

`detectWorkspaceRepos` scans only direct children of the selected root. It excludes `node_modules`, `.fusion`, `.git`, and `.pi`; a child must have a `.git` marker and pass a real Git work-tree probe. Nested repositories are not discovered. When workspace configuration is present, `ensureGitRepositoryForProjectPath` intentionally skips `git init` at the root: do not create a root repository just to make workspace mode work.

## The workspace config file

Fusion records members in:

```text
<workspace-root>/.fusion/workspace.json
```

For example:

```json
{
  "repos": ["api", "web"]
}
```

Each `repos` entry is relative to the workspace root and must stay inside it. Absolute paths, `..` escapes, empty values, and non-string values are rejected or filtered when `loadWorkspaceConfig` reads the file. Keep member repositories as direct children so they remain discoverable and easy to operate.

The configuration file makes the root a workspace at repository-initialization time. The automatic path writes the `workspaceMode` setting before `workspace.json`, preventing a partially written configuration from making the next registration incorrectly treat the root as a workspace.

## The workspaceMode setting

`workspaceMode` is a project-scoped boolean. Its default is unset, which is disabled: when enabled, the project root is treated as a workspace containing multiple Git sub-repositories; tasks run per sub-repository and Fusion does not create a root Git repository. You can set it during existing-directory registration through the Setup Wizard.

An explicit `workspaceMode: false` in `.fusion/config.json` prevents `ensureGitRepositoryForProjectPath` from automatically detecting and re-enabling workspace mode. The setting is not itself the member list: the workspace-config writers are registration, repository initialization, and the interactive CLI flow. If you change the setting and need to create, remove, or refresh `.fusion/workspace.json`, re-register the project or manage that file deliberately; toggling alone may not create or remove it.

## How a workspace task executes

A workspace task starts with its session current directory at the browse-only, non-Git root. Fusion does not acquire a root worktree and leaves the task's singular `worktree` field unset. Before editing a member repository, the agent calls:

```text
fn_acquire_repo_worktree
```

The tool accepts only a configured repository name and returns an isolated, task-specific worktree path in that sub-repository. Work only in that returned path. Each member uses its own branch and its own repository branch resolution; Fusion will not commit using a non-task branch.

Fusion adds acquired member paths to the task's active-worktree set, so liveness and ownership checks see the root plus every active member worktree. A live remembered worktree is reused across a resumed task or executor restart. If another task is acquiring the same member, the tool returns a temporary busy error asking the agent to retry `fn_acquire_repo_worktree` shortly; acquire a different member or retry rather than editing the original repository checkout.

## Review and verification

Fusion captures changes per acquired sub-repository, not from the non-Git root. Modified file paths are repository-prefixed, such as `api/src/server.ts`, and each member is diffed against its own base. Per-repository branch attribution, contamination, and worktree-invariant checks apply to those member worktrees. Review and verification should therefore identify the member repository alongside every changed path and command result.

## Merging: the per-repo land loop

`landWorkspaceTask` processes configured/acquired repositories in a deterministic per-repository loop. Each repository lands on **its own local integration ref**; a shared workspace integration branch is not used. This means the operation is non-atomic: an earlier repository can land before a later repository fails.

The CLI command `fn task merge` reports each repository as `landed`, `empty`, or `failed`, and exits non-zero for a partial land. Fusion finalizes the task to `done` only after every member has either landed or has no changes to land. A partial result remains recoverable and must be treated as an operator-visible state, not as one atomic merge.

## landedSha idempotency

After a repository's integration ref advances, Fusion persists that repository's `landedSha`. `isRepoLanded` first proves that recorded SHA is an ancestor of the repository integration ref. If the ref advanced but persistence was lost in that narrow window, `findProvenLandedCommit` can instead prove the task's `Fusion-Task-Id` trailer on the integration history.

On a re-run, a proven landed repository is skipped and its exact proven SHA is retained. This prevents a partial-land retry from creating a second squash commit for a repository that already landed.

## Partial-land recovery and self-healing

The non-atomic land loop has a partial-land window. The `task:reconcile-workspace-partial-land` self-healing sweep re-enqueues an eligible task so it can retry unlanded repositories while skipping proven ones. It takes no action when auto-merge is off, the user paused the task, or a live member worktree/merge owner proves work is still active.

If a member task branch is gone and Fusion has no recorded or otherwise proven `landedSha`, the sweep parks the task as failed with a manual-intervention-required error. Inspect the per-repository integration history and task logs, establish whether the missing work landed or must be recovered, then repair/retry the task only after the workspace is safe. Do not assume a partial land rolled back repositories that already landed.

Additional sweeps emit `task:reconcile-orphaned-workspace-worktree` when they remove a recorded dead member worktree and `task:reclaim-phantom-workspace-land-lease` when they reclaim a leaked member landing lease. Search run-audit records for these event IDs and `task:reconcile-workspace-partial-land` when diagnosing recovery.

## Reverting a workspace task

Workspace Git revert is all-or-nothing across member repositories: Fusion classifies every repository before committing. If every repository is clean or already reverted, the response has the shape:

```json
{
  "mode": "git",
  "clean": true,
  "workspace": { "repos": [{ "repo": "api", "classification": "clean" }] }
}
```

If one member conflicts, Fusion rolls every touched member back to its pre-call state and commits no member revert. The `granularity` field applies only to the single-repository Git path, not workspace tasks. For the complete task revert contract, see [Reverting Done/Archived tasks](./task-management.md#reverting-donearchived-tasks-git-path--ai-undo-fallback).

There is an important route/helper distinction when auto-merge is off. `revertWorkspaceTask` refuses the direct integration-branch path, but the task route uses `prepareWorkspaceRevertPrBranches` for a clean classification and opens one PR per repository, returning `mode: "pr"` with the member PR details. Under `auto` mode, a conflicting workspace Git revert can instead create an AI-undo task.

## Archiving and cleanup

Archiving a workspace task synchronously removes every recorded member worktree. Fusion holds a per-repository reservation through disposal and branch cleanup. A failed removal is quarantined so a later acquisition can reconcile the orphan; successful siblings are released. `archiveTask(..., { cleanup: false })` intentionally retains worktrees, while self-healing remains a backstop. For the task lifecycle details, see [Workspace worktree cleanup on archive](./task-management.md#workspace-worktree-cleanup-on-archive).

## Limitations and known sharp edges

- Landing is non-atomic. A later failure does not undo earlier local integration-ref advances; use task logs, per-repository history, and `landedSha` proof before retrying or manually recovering.
- The dashboard task detail does not currently expose a dedicated per-repository land-status view. Use `fn task merge` output, task logs, and run audit for the repository-level state.
- Exclusivity is per sub-repository. Two workspace tasks can work in different members concurrently, but cannot acquire or land the same member at the same time.
- Detection is intentionally shallow. A Git repository nested below a non-repository direct child is not a workspace member until you restructure or configure a valid direct-child entry.

## Troubleshooting

### A sub-repository was not detected

`detectWorkspaceRepos` only scans one level. Ensure the repository is a direct child, is not named `node_modules`, `.fusion`, `.git`, or `.pi`, has a `.git` marker, and succeeds as a real Git work tree. Remove or investigate a stray `.git` at the workspace root rather than initializing it: the root should remain non-Git.

### `fn_acquire_repo_worktree` reports busy

Another task is temporarily acquiring or landing that same member. Retry the tool shortly, or continue with a different configured member. Do not edit the shared repository checkout while waiting.

### A task is failed after partial land

A branch-gone member without landing proof requires manual intervention. Inspect every member's integration history and the task log; determine which work landed, restore or recreate any missing task branch as appropriate, and then retry only when repository state is consistent.

### Workspace mode appears to re-enable after being toggled off

Check `.fusion/config.json`: explicit `workspaceMode: false` is the guard that suppresses automatic detection. Also inspect `.fusion/workspace.json`; the setting and member configuration are separate artifacts. Re-register or update the configuration deliberately if the project was previously detected as a workspace.
