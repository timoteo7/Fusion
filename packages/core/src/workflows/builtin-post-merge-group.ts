import type { WorkflowIrNode } from "./workflow-ir-types.js";

/*
FNXC:WorkflowPostMerge 2026-06-26-09:00:
Factory for a POST-MERGE optional-group node — the graph-native execution mechanism
for post-merge workflow steps (U7 spike). Mirrors `codeReviewOptionalGroupNode` /
`browserVerificationOptionalGroupNode`, but the produced node carries
`config.phase: "post-merge"` so the graph executor:
  1. runs it only AFTER a successful merge (when wired off the merge region and the
     `graphNativePostMerge` flag is on), and
  2. records its WorkflowStepResult with `phase: "post-merge"` + emits `[post-merge]`
     logs. Advisory post-merge failures are non-blocking; explicit gate-mode
     verification failures block final graph success after merge proof.

FNXC:WorkflowPostMerge 2026-06-29-12:22:
Full task built-ins need an explicit default-off post-merge verification node so
post-merge audit/verification policy can live in workflow definitions instead of
merger-only fallback code. The group node id is the STABLE per-task enable key
(`enabledWorkflowSteps`), and the inner template node carries a DISTINCT id
(`${id}-step`) — a template node id may not collide with the group/top-level node id
(optional-group validation).
*/

export const POST_MERGE_VERIFICATION_GROUP_ID = "post-merge-verification";

const LEGACY_CODING_DEFAULT_OPTIONAL_GROUP_IDS = ["plan-review", "code-review"] as const;
const BUILTIN_CODING_WORKFLOW_IDS = new Set([
  "builtin:coding",
  "builtin:legacy-coding",
  "builtin:stepwise-coding",
]);

/**
 * FNXC:PostMergeFullSuiteEvidence 2026-09-23-05:41:
 * Upgrade the historical built-in coding default with the post-merge
 * delivery-evidence group. Only the exact former default is changed; every other
 * optional-step configuration retains its recorded shape.
 *
 * FNXC:PostMergeAdvisoryDemotion 2026-09-29-14:57:
 * FUSI-064 makes the enabled post-merge group an ADVISORY observation, not a hard completion
 * gate. The group is still seeded here so every merge-capable built-in records a post-merge
 * verdict for the audit trail, but its `gateMode` is `advisory`, so it can no longer refuse
 * finalization (neither in the graph executor nor via `getRequiredPostMergeEvidenceBlocker`,
 * both of which key on `gateMode === "gate"`). A landed card finalizes on merge confirmation
 * alone; the Full Suite remains the advisory signal the repository documents it to be.
 */
export function upgradeLegacyCodingPostMergeVerificationStepIds(
  workflowId: string,
  stepIds: readonly string[],
): string[] | undefined {
  if (!BUILTIN_CODING_WORKFLOW_IDS.has(workflowId)
    || stepIds.length !== LEGACY_CODING_DEFAULT_OPTIONAL_GROUP_IDS.length
    || !LEGACY_CODING_DEFAULT_OPTIONAL_GROUP_IDS.every((id) => stepIds.includes(id))) {
    return undefined;
  }

  /*
  FNXC:PostMergeFullSuiteEvidence 2026-09-23-05:41:
  The former two-review default predates the post-landing evidence group.
  Migrate only that exact inherited profile when it is next authoritatively resolved, preserving
  intentional optional-step configurations.
  FNXC:PostMergeAdvisoryDemotion 2026-09-29-14:57:
  FUSI-064 demoted the group from gate to advisory, so this upgrade no longer withholds
  completion; it only ensures the advisory post-merge observation runs and is recorded.
  */
  return [...LEGACY_CODING_DEFAULT_OPTIONAL_GROUP_IDS, POST_MERGE_VERIFICATION_GROUP_ID];
}

/*
FNXC:PostMergeAdvisoryDemotion 2026-09-29-14:57:
FUSI-064 reconciled the post-merge completion contract with the project's own CI policy. The Full
Suite tier is documented in three places as a non-blocking, advisory post-merge signal
(docs/testing.md, the .github/workflows/full-suite.yml header, and the thin-trusted-merge-gate
pattern), so it can no longer be the hard precondition the completion gate demands. This prompt
therefore treats the landed Full Suite result as RECORDED ADVISORY CONTEXT, never as a reason to
refuse approval: a red or absent Full Suite run must not hold a cleanly merged card open. The
prompt still REVISEs for genuine integration problems (merge-proof absence, mismatched merged
diff, integration-only regressions), which is the signal this check exists to provide. The
demotion is implemented by the node's `gateMode: "advisory"` (see
`postMergeVerificationOptionalGroupNode`), which is what actually makes the verdict non-blocking
in the graph executor and in `getRequiredPostMergeEvidenceBlocker`.
*/
const POST_MERGE_VERIFICATION_PROMPT = `You are a post-merge verification reviewer. Verify that the task's merged result is safe after integration.

## Review focus
1. Confirm the task has merge proof or already-on-main proof before treating the workflow as complete.
2. Check the final merged diff and task summary for obvious mismatches, missing verification evidence, or integration-only regressions.
3. If configured test/build commands are available in the task context, inspect their latest result or explain why no post-merge command was applicable.

## Post-landing Full Suite (advisory)
The Full Suite and Pipeline smoke tiers are non-blocking post-merge signals, not a merge stopper. If a Full Suite push-to-main run at or after the landed SHA is available, record it as advisory context in your notes: the run ID and run SHA, the Pipeline smoke and Test shard 1/4, 2/4, 3/4, and 4/4 conclusions, and the timing artifacts test-timings-shard-1, test-timings-shard-2, test-timings-shard-3, and test-timings-shard-4. A red or absent Full Suite run is information only and MUST NOT by itself cause a REVISE or withhold approval: this task's completion does not depend on a green Full Suite. Judge the integrated result on its own merits.

## Output Requirements
- APPROVE: post-merge verification is acceptable.
- APPROVE_WITH_NOTES: completion may proceed with non-blocking notes, including any recorded Full Suite observations.
- REVISE: the merged result has a concrete post-merge problem; include it and the needed follow-up. Do NOT return REVISE solely because a Full Suite run is red, absent, or partial.
- \`notes\` MUST contain one to three non-empty sentences naming what was checked and why the verdict was reached. An empty \`notes\` string is a protocol violation.
- Final output: output exactly one trailing JSON object on the final line (no markdown fences, no surrounding prose):
{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}`;

export interface PostMergeOptionalGroupSpec {
  /** Stable per-task enable key + group node id. */
  id: string;
  /** Display name (toggle/editor surfaces + recorded `workflowStepName`). */
  name: string;
  /** Column the group node sits in (typically a post-merge/`done` column). */
  column: string;
  /** Agent prompt for the inner post-merge step. */
  prompt: string;
  /** Optional short description for the inner node. */
  description?: string;
  /** Inner step tool access; defaults to "readonly". */
  toolMode?: "readonly" | "coding";
  /** Gate semantics; defaults to "advisory" (post-merge failures are non-blocking). */
  gateMode?: "advisory" | "gate";
  /** Seed the per-task enable toggle for new tasks; defaults to false (opt-in). */
  defaultOn?: boolean;
}

/**
 * Build a post-merge `optional-group` node. The node config is marked
 * `phase: "post-merge"` so the graph executor's optional-group recording path keys
 * the result phase + log prefix off it.
 */
export function postMergeOptionalGroupNode(spec: PostMergeOptionalGroupSpec): WorkflowIrNode {
  return {
    id: spec.id,
    kind: "optional-group",
    column: spec.column,
    config: {
      name: spec.name,
      phase: "post-merge",
      defaultOn: spec.defaultOn ?? false,
      template: {
        nodes: [
          {
            id: `${spec.id}-step`,
            kind: "prompt",
            config: {
              name: spec.name,
              ...(spec.description !== undefined ? { description: spec.description } : {}),
              prompt: spec.prompt,
              toolMode: spec.toolMode ?? "readonly",
              gateMode: spec.gateMode ?? "advisory",
            },
          },
        ],
        edges: [],
      },
    },
  };
}

export function postMergeVerificationOptionalGroupNode(column = "done"): WorkflowIrNode {
  return postMergeOptionalGroupNode({
    id: POST_MERGE_VERIFICATION_GROUP_ID,
    name: "Post-merge verification",
    column,
    prompt: POST_MERGE_VERIFICATION_PROMPT,
    description: "Verify the integrated result after merge proof before final completion",
    /*
    FNXC:PostMergeAdvisoryDemotion 2026-09-29-14:57:
    FUSI-064 demoted the built-in post-merge verification from a hard completion gate to an
    advisory observation. The repository documents the Full Suite tier as a non-blocking
    post-merge signal, so requiring its lane-conclusion SUCCESS as the sole hard precondition
    for completion contradicted the project's own stated policy and left a cleanly merged card
    unable to finalize. `gateMode: "advisory"` is the single change that actually removes the
    block: both the graph executor (which only treats an enabled `gateMode === "gate"` post-merge
    group as a required follow-up) and `getRequiredPostMergeEvidenceBlocker` (which collects only
    `gateMode === "gate"` groups) key on this value. The node still runs and records a
    `phase: "post-merge"` verdict, so a landed card finalizes on merge confirmation alone while
    keeping the post-merge audit record.
    */
    gateMode: "advisory",
    /*
    FNXC:PostMergeFullSuiteEvidence 2026-09-23-05:04:
    Keep the post-merge verification seeded for merge-capable built-ins so the integrated result
    still receives an observed verdict after merge proof.
    */
    defaultOn: true,
  });
}
