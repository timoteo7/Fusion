/*
FNXC:Identity 2026-08-12-01:20 (U18/KTD2 Stage C — the executor's run carrier, post-U4 peel):

The executor holds ~500 mutating store call sites but the acting agent is almost never a value in
scope at the call site, so U18 could not be satisfied here by appending an argument 500 times. The
carrier already existed: `currentRunContexts` is written once per execution run (`runImplementation`
sets it with the run's synthetic id and the assigned agent, and clears it in the outer `finally`) and
is reachable from every peeled module through its `getRunContextFor` dep. What was missing is that
`getRunContextFor` is PARTIAL — it returns `undefined` off a live run, which type-checks only against
U18's deprecated overload and therefore attributes nothing.

`runContextForTotal` is the TOTAL form and is what every mutating store call in `executor/` now
passes. The two forms stay separate deliberately: `getRunContextFor` still answers "is there a live
run?" for the ~20 places that read `?.runId` / `?.agentId` as a liveness probe, and collapsing them
would turn those probes into unconditional truths.

The fallback is DERIVED, not a marker. `"executor"` is not invented here: it is the exact `agentId`
the same code path already stamps on its own run context and run-audit rows (`task.assignedAgentId
?? "executor"`), so a write made by this lane outside a live run is genuinely the executor lane's —
the same reasoning that let Stage B use `"merger"`, `"triage"` and `"planner-overseer"` as real
actors. Substituting the unattributed marker would have been LESS honest, not more: it would claim no
actor is knowable for a write the executor demonstrably made.

`fallbackAgentId` exists for the frames that hold a task whose `assignedAgentId` is more specific
than the lane label; pass it wherever it is free, never guess. Never pass an agent id that names the
SUBJECT of the write (an assignee, a checkout target) — that inverts the attribution.

This lives in its own module rather than on the class because U4 peeled the executor into ~240 free
functions that receive `getRunContextFor` as a dep; a class method would not be reachable from them.
*/
import { mutationContextForAgent, type RunMutationContext } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";

/**
 * FNXC:Identity 2026-08-12-01:20 (U18/KTD2 Stage C):
 * The executor lane's own agent id. Pre-existing value, not a new one — the run implementation
 * already stamps `task.assignedAgentId ?? "executor"` on its run context and its run-audit rows.
 * Named here so the lane label used for attribution and the one used for auditing cannot drift.
 */
export const EXECUTOR_LANE_AGENT_ID = "executor";

/** The TOTAL run context for a task: the live run when there is one, the executor lane otherwise. */
export function runContextForTotal(
  getRunContextFor: ((taskId: string) => EngineRunContext | RunMutationContext | undefined) | undefined,
  taskId: string,
  fallbackAgentId?: string | null,
): RunMutationContext {
  const live = getRunContextFor?.(taskId);
  if (live && typeof (live as RunMutationContext).actor === "object" && (live as RunMutationContext).actor) {
    return live as RunMutationContext;
  }
  if (live?.agentId) return mutationContextForAgent(live.agentId, live.runId);
  return mutationContextForAgent(fallbackAgentId ?? EXECUTOR_LANE_AGENT_ID);
}
