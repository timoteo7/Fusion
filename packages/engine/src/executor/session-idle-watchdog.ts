/**
 * FNXC:SessionIdleWatchdog 2026-09-23-23:32:
 * SOURCE: the FUSI-021/022 wedge — a step session runs 400+ tool calls and NEVER calls `fn_task_done`
 * (start-stop bursts, 4h idle). The existing completed-task-watchdog covers "finished but stuck AFTER fn_task_done";
 * this covers the inverse: "NEVER calls fn_task_done". Bounded recovery: abort the runaway session and fail the
 * step with a clear error instead of spinning for hours. Rule: never let a session explore unbounded.
 */
import type { Task } from "@fusion/core";

export const SESSION_MAX_TOOL_CALLS = 250;
export const SESSION_MAX_IDLE_MS = 30 * 60_000;

export type SessionActivity = { toolCalls: number; lastActivityAt: number };

export function shouldAbortRunawaySession(
  activity: SessionActivity | undefined,
  now: number = Date.now(),
): null | "tool-budget-exceeded" | "idle-timeout" {
  if (!activity) return null;
  if (activity.toolCalls > SESSION_MAX_TOOL_CALLS) return "tool-budget-exceeded";
  if (now - activity.lastActivityAt > SESSION_MAX_IDLE_MS) return "idle-timeout";
  return null;
}

export function runawaySessionError(task: Task, reason: "tool-budget-exceeded" | "idle-timeout"): string {
  return reason === "tool-budget-exceeded"
    ? `RUNAWAY_SESSION: ${task.id} exceeded ${SESSION_MAX_TOOL_CALLS} tool calls without calling fn_task_done — aborting (call fn_task_done, or fn_task_done(outcome="blocked") if stuck)`
    : `RUNAWAY_SESSION: ${task.id} idle ${Math.round(SESSION_MAX_IDLE_MS / 60000)}min without fn_task_done — aborting`;
}
