import { emitSelfImproveDenylistRejected } from "./self-improve-run-audit.js";
import {
  classifyStructuralDenylist,
  type StructuralDenylistCategory,
} from "./structural-denylist.js";
import type { RunAuditSinkHost } from "../run-audit/emit-bounded-run-audit.js";

/*
FNXC:SelfImproveStructuralDenylistGuard 2026-09-30-11:55:
This module is the FLOOR under the self-improvement primary gate, and it is deliberately shaped so
that reaching the gate REQUIRES passing through it. A learning experiment may change product
behavior; what it may not do is rewrite the equipment that judges it. The moment an experiment can
edit the merge gate's own allow-list, the policy checks, the flaky-test ledger, the release
machinery, or the self-patching code, the verdict it is judged by stops being evidence — so the
diff is classified and refused BEFORE the gate callback is reached, and the callback is simply never
invoked.

FNXC:SelfImproveStructuralDenylistGuard 2026-09-30-11:55:
There is exactly ONE place a gate callback is invoked: the single `await gate()` call site at the
bottom of `guardStructuralDenylist`, marked `THE ONE INVOCATION SITE`. This module has no class and
no `runGate` method — it is one exported async function, and that lone call is what makes the
invocation site auditable by reading the module top to bottom. `guardStructuralDenylist` is the sole
entry: it classifies the FULL changed-path set first, and only a clean or empty classification
reaches that call. A caller therefore cannot obtain a gate run without the classification having
happened first, because the only way to ask for a gate run is to go through this entry. Adding a
second exported function that accepts or calls a gate callback would recreate the bypass this module
exists to close, so the module exports exactly one function.

FNXC:SelfImproveStructuralDenylistGuard 2026-09-30-11:55:
`rejected: true` is a HARD refusal a caller cannot ignore. It is not a warning, not a flag on an
otherwise-normal result, and not a value a caller may re-check and override: on a hit the entry
returns before reaching the invocation site, so there is no gate verdict for the caller to prefer
over the refusal. The primary gate MUST treat a `rejected` result as terminal. That contract is
enforced by the reachability test in `structural-denylist-guard.test.ts`, which drives a caller that
honors the return value and proves it cannot proceed past a refusal.

FNXC:SelfImproveStructuralDenylistGuard 2026-09-30-11:55:
There is NO bypass. This module deliberately accepts no `bypass`, `force`, `skipDenylist`, or
`override` parameter, reads no environment variable, consults no settings key, and honors no
per-task or per-agent override. A guard that its own subject could switch off is a suggestion, and
the whole value of this floor is that the thing standing on it cannot lift it. The escape-hatch
ratchet in the test suite scans this file and the classifier for exactly those identifiers and env
reads, so a future "just for experiments" flag fails the suite rather than quietly reopening the
hole.

FNXC:SelfImproveStructuralDenylistGuard 2026-09-30-11:55:
A refusal is recorded through the bounded run-audit seam, and a hostile sink changes nothing about
the refusal. The audit emit is best-effort telemetry: absent, throwing, rejecting, hung, and
late-settling sinks all still produce `rejected: true` with zero gate invocations. The refusal is a
deterministic function of the diff, decided by the pure classifier BEFORE the emit is even
attempted, so telemetry can never soften, delay, or reverse a stop. The guard does not await the
emit before returning — the caller gets its refusal immediately and the audit row lands if it lands.
*/

/** The verdict of one guard invocation. */
export interface StructuralDenylistGuardResult {
  /**
   * True when the gate callback was invoked. False on a denylist hit — the callback is never
   * reached, so there is no gate verdict at all, only the refusal below.
   */
  executed: boolean;
  /**
   * True when the diff was refused for touching a protected category. A hard refusal: a caller
   * that honors this result cannot proceed, because no gate ran.
   */
  rejected: boolean;
  /** The immutable categories the diff was refused under, in classifier order. */
  categories: StructuralDenylistCategory[];
  /** Number of protected files per refused category. */
  counts: Partial<Record<StructuralDenylistCategory, number>>;
  /** Total number of protected files across all refused categories. */
  fileCount: number;
  /** The gate's own verdict, present only when `executed` is true. */
  gateResult?: unknown;
}

/** The gate callback's own return value, passed through untouched. */
export type GateCallback<T> = () => T | Promise<T>;

/** Dependencies of the guard: the audit sink to record refusals on. */
export interface StructuralDenylistGuardOptions {
  /**
   * Structural audit sink for the refusal row. Optional: a caller with no store still gets a
   * working guard, and the refusal simply goes unrecorded (see the hostile-sink FNXC block).
   */
  host?: RunAuditSinkHost;
  /** Optional correlation fields, forwarded to the audit façade when present. */
  proposalId?: string;
  projectId?: string;
  agentId?: string;
  runId?: string;
}

/**
 * The structural denylist guard: classify the diff, then run the gate only if it is clean.
 *
 * This is the module's SINGLE entry point and the only place a gate callback is invoked. Call it with
 * the FULL changed-path set of the candidate and the gate you would have run; on a denylist hit it
 * returns `rejected: true` and `executed: false` WITHOUT calling the gate, and on a clean or empty
 * diff it calls the gate exactly once and returns its result.
 *
 * On a rejection the returned promise resolves WITHOUT awaiting the gate: the audit emit is fired
 * (best-effort, see the hostile-sink FNXC block) but deliberately not awaited, so a caller obtains
 * its refusal without waiting on telemetry. On a clean diff the promise resolves to the gate's own
 * result.
 */
export async function guardStructuralDenylist<T>(
  changedPaths: readonly string[],
  gate: GateCallback<T>,
  options: StructuralDenylistGuardOptions = {},
): Promise<StructuralDenylistGuardResult> {
  const verdict = classifyStructuralDenylist(changedPaths);

  if (verdict.rejected) {
    // Fire-and-forget the refusal row. Deliberately NOT awaited: the refusal is already decided by
    // the pure classifier above, and a slow or hostile audit sink must not delay or block it.
    void emitSelfImproveDenylistRejected({
      host: options.host,
      categories: verdict.categories,
      counts: verdict.counts,
      fileCount: verdict.fileCount,
      ...(options.proposalId ? { proposalId: options.proposalId } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.agentId ? { agentId: options.agentId } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
    });
    // HARD STOP. The invocation site below is not reached, so the gate never executes and no gate
    // verdict exists for a caller to weigh against this refusal.
    return {
      executed: false,
      rejected: true,
      categories: verdict.categories,
      counts: verdict.counts,
      fileCount: verdict.fileCount,
    };
  }

  // Clean or empty diff — THE ONE INVOCATION SITE. `grep -n "gate()" ` on this module returns this
  // line and nothing else, which is the audit path for the single-invocation invariant.
  const gateResult = await gate();
  return {
    executed: true,
    rejected: false,
    categories: [],
    counts: {},
    fileCount: 0,
    gateResult,
  };
}
