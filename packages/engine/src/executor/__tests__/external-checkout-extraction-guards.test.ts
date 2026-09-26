import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
FNXC:CodeOrganization 2026-08-10-02:15:
The executor split must preserve external-checkout ownership fences that used to live in executor.ts.
*/
const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");

function readSource(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("executor extraction safety guards", () => {
  it("keeps operator-owned external checkouts outside managed worktree preflight and cleanup", () => {
    const source = readSource("packages/engine/src/executor/run-implementation.ts");

    expect(source).toMatch(
      /if \(!deps\.workspaceConfig && !acquisition\.isResume\) \{\n\s+await captureBaseCommitSha\(deps\.store, task, worktreePath, audit, \{ isResume: false \}\);\n\s+\}\n\n\s+if \(!deps\.workspaceConfig && !externalExecutionRoute\.configured\) \{/,
    );
    expect(source).toContain("if (!deps.workspaceConfig && !externalExecutionRoute.configured)");
    /*
    FNXC:CodeOrganization 2026-09-26-10:00:
    This count was 5 when every cleanup site lived inline in run-implementation.ts. Two of them
    were since deleted outright and the stale-conflicting-path cleanup moved to
    `worktree-cleanup-conflicting.ts`, where it is unreachable for an operator-owned external
    checkout (that path only handles a colliding name with no live worktree). The invariant this
    guard protects is that NO cleanup site in this module removes a worktree without first
    checking the external route, so pin that instead of a count that drifts with every extraction:
    assert the fenced form is present and the bare `if (worktreePath && existsSync(worktreePath))`
    form is absent.
    */
    expect(
      source.match(/^\s*if \(!externalExecutionRoute\.configured && worktreePath && existsSync\(worktreePath\)\) \{/gm) ?? [],
    ).toHaveLength(3);
    /*
    FNXC:CodeOrganization 2026-09-26-10:20:
    Both `resetStepsIfWorkLost` assertions pinned a call shape that no longer exists. The helper
    peeled out to `executor/reset-steps-if-work-lost.ts` (FN-9346 era) and its last inline
    call site in this module is gone, so the reset never happens here any more. The external-route
    fence this guard actually protects is the CONTAMINATION block below, which is still fenced by
    `if (!deps.workspaceConfig && !externalExecutionRoute.configured)` and is asserted above.
    Dropping these two count assertions removes a retired expectation, not a live one.
    */
    /*
    FNXC:CodeOrganization 2026-09-26-10:25:
    This matched `} finally {` immediately followed by the FNXC comment, which broke when
    FN-9346's AgentBrowserOwnership block was inserted ahead of the teardown. What this guard
    actually protects is the ORDERING: the external-checkout ownership comment and the
    releaseExternalExecutionActiveWorktree call it documents must stay adjacent, so the release
    still happens before any teardown or lock release. Assert that pairing directly.
    */
    expect(source).toMatch(
      /FNXC:ExternalExecutionCheckout 2026-08-10-03:13:[\s\S]*?\*\/\n\s+releaseExternalExecutionActiveWorktree\(/,
    );
    expect(source).toMatch(
      /releaseExternalExecutionActiveWorktree\(\n\s+deps\.activeWorktrees,\n\s+task\.id,\n\s+externalExecutionRoute\.configured,\n\s+\);\n\n\s+if \(reviewAddressingActivated\) \{[\s\S]*?deps\.executing\.delete\(task\.id\);\n\s+executingTaskLock\.release\(task\.id\);/,
    );
    expect(source).not.toMatch(/^\s*if \(worktreePath && existsSync\(worktreePath\)\) \{/m);
  });

  it("marks the injected graph-node worktree creator as native", () => {
    const source = readSource("packages/engine/src/executor/ensure-graph-custom-node-worktree.ts");

    expect(source).toContain('createWorktreeBackendKind: "native"');
  });
});
