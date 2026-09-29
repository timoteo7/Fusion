import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { PLAN_REVIEW_GROUP_ID } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExecSync,
  resetExecutorMocks,
} from "./executor-test-helpers.js";
import {
  WORKFLOW_STEP_NOTES_REPAIR_PROMPT,
  workflowStepVerdictNoNotesNotice,
} from "../executor/workflow-step-verdict.js";
import {
  buildWorkspaceReviewOutcome,
  toWorkspaceRepoReviewResult,
  WORKSPACE_REPO_REVIEW_NO_NOTES_NOTICE,
} from "../executor/run-graph-custom-node.js";
import { reviewWorkspacePerRepo } from "../executor/workspace-review-per-repo.js";

function baseTask() {
  const now = new Date().toISOString();
  return {
    id: "FN-240-TEST",
    title: "Repair reviewer notes",
    description: "Repair reviewer notes",
    column: "in-progress" as const,
    worktree: "/tmp/fn-240-wt",
    branch: "fusion/fn-240-test",
    baseCommitSha: "abc123",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" as const }],
    currentStep: 0,
    log: [],
    createdAt: now,
    updatedAt: now,
  };
}

/*
FNXC:ReviewGateIdentity 2026-09-26-06:35:
A review gate's identity is its optional GROUP id, not the inner template step id. The executor
resolves `effectiveWorkflowStepId = optionalGroupId ?? workflowStep.id.replace(/^graph:/, "")`
(execute-workflow-step.ts:262) and uses it for both the run-audit `workflowStepId` (:1275) and the
prior-record reuse lookup `findReusableReviewResult` (:620, matching on `result.workflowStepId`).
Because `optionalGroupId` is present, the group id wins. These fixtures and assertions were still
keyed to the inner step id ("code-review-step" / "plan-review-step"), which is the pre-group shape.
The group id is the shipped contract, so the ASSERTMENT and the persisted FIXTURE ROW are realigned
to it — the product is not changed. `CODE_REVIEW_GROUP_ID` is deliberately not imported: unlike
PLAN_REVIEW_GROUP_ID it is not re-exported from @fusion/core, and the code-review group id is
already carried by this fixture's own `optionalGroupId`, which is the field the product reads.
`CODE_REVIEW_GROUP_ID` is therefore mirrored here as a local constant rather than imported:
@fusion/core does not re-export it from its barrel, and this keeps the fixture's gate id a single
named value that the run-audit assertion below references instead of repeating a string literal.
*/
const CODE_REVIEW_GROUP_ID = "code-review";

function reviewStep(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: "graph:code-review-step",
    name: "Code Review",
    description: "",
    mode: "prompt" as const,
    phase: "pre-merge" as const,
    gateMode: "gate" as const,
    prompt: "Review the implementation.",
    toolMode: "readonly" as const,
    optionalGroupId: CODE_REVIEW_GROUP_ID,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

type Reply = string | Error | "never";

function installSessions(repliesBySession: Reply[][]) {
  const sessions: Array<{ prompt: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
  mockedCreateFnAgent.mockImplementation(async () => {
    const replies = repliesBySession[sessions.length] ?? repliesBySession.at(-1) ?? [];
    const listeners: Array<(event: any) => void> = [];
    let promptIndex = 0;
    const prompt = vi.fn(async () => {
      const reply = replies[promptIndex++];
      if (reply === "never") return new Promise<void>(() => {});
      if (reply instanceof Error) throw reply;
      if (typeof reply === "string") {
        for (const listener of listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: reply,
            },
          });
        }
      }
    });
    const session = {
      state: {},
      subscribe: (listener: (event: any) => void) => {
        listeners.push(listener);
        return () => {};
      },
      prompt,
      dispose: vi.fn(),
    };
    sessions.push(session);
    return { session } as any;
  });
  return sessions;
}

async function runReview(
  replies: Reply[],
  overrides: Record<string, unknown> = {},
  audit?: { sink?: (input: unknown) => unknown; context?: Record<string, unknown> },
) {
  const store = createMockStore();
  if (audit?.sink) (store as any).recordRunAuditEvent = audit.sink;
  const sessions = installSessions([replies]);
  const executor = new TaskExecutor(store as any, "/tmp/test", {
    agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
  } as any);
  if (audit?.context) vi.spyOn(executor as any, "getRunContextFor").mockReturnValue(audit.context);
  const outcome = await (executor as any).executeWorkflowStep(
    baseTask(),
    reviewStep(overrides),
    "/tmp/fn-240-wt",
    { workflowStepTimeoutMs: 60_000 },
    undefined,
  );
  return { outcome, sessions, store };
}

describe("workflow-step verdict note repair", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExecSync.mockImplementation(() => Buffer.from(""));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("repairs empty notes once on the same session without changing the verdict", async () => {
    const note = "Read PROMPT.md and the cited files; scope and verification are adequate.";
    const { outcome, sessions } = await runReview([
      '{"verdict":"APPROVE","notes":"","findings":[]}',
      JSON.stringify({ notes: note }),
    ]);

    expect(outcome).toMatchObject({ verdict: "APPROVE", notes: note, output: note });
    expect(outcome.notes).not.toContain("without a rationale");
    expect(outcome).not.toHaveProperty("notesMissing");
    expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
    expect(sessions[0].prompt).toHaveBeenCalledTimes(2);
    expect(sessions[0].prompt.mock.calls[1][0]).toBe(WORKFLOW_STEP_NOTES_REPAIR_PROMPT("APPROVE"));
  });

  it.each([
    ["absent", undefined],
    ["throwing", vi.fn(() => { throw new Error("audit throw"); })],
    ["rejecting", vi.fn(() => Promise.reject(new Error("audit reject")))],
    ["hanging", vi.fn(() => new Promise<void>(() => {}))],
  ])("keeps repaired review outcomes unchanged with an %s run-audit sink", async (_sinkKind, sink) => {
    vi.useFakeTimers();
    const note = "I checked the scoped implementation and its focused tests; both satisfy the task.";
    const pending = runReview([
      '{"verdict":"APPROVE","notes":""}',
      JSON.stringify({ notes: note }),
    ], {}, {
      sink,
      context: { taskId: baseTask().id, agentId: "reviewer", runId: "run-fn-241", phase: "execute" },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    const { outcome } = await pending;

    expect(outcome).toMatchObject({ success: true, verdict: "APPROVE", notes: note, output: note });
    /*
    FNXC:ReviewGateIdentity 2026-09-26-06:35: matcher TIGHTENED, not weakened. It previously expected
    a bare top-level `ObjectContaining` and asserted nothing about the agent/domain identity, so it
    matched almost any call. It now pins the full event shape the emitter actually produces
    (execute-workflow-step.ts:1266-1279) — agentId, runId, domain, mutationType, target, taskId — plus
    every metadata field, and keys `workflowStepId` on the GATE id the product resolves. The
    fail-soft subject is unchanged and still asserted first: these sinks must not alter the outcome.
    */
    if (sink) expect(sink).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "reviewer",
      runId: "run-fn-241",
      domain: "database",
      mutationType: "task:review-notes-repaired",
      target: baseTask().id,
      taskId: baseTask().id,
      metadata: expect.objectContaining({
        taskId: baseTask().id,
        workflowStepId: CODE_REVIEW_GROUP_ID,
        verdict: "APPROVE",
        outcome: "repaired",
      }),
    }));
  });

  it("fails soft when the repair remains empty", async () => {
    const { outcome, sessions } = await runReview([
      '{"verdict":"APPROVE","notes":""}',
      '{"verdict":"APPROVE","notes":""}',
    ]);
    const notice = workflowStepVerdictNoNotesNotice("APPROVE", "empty");
    expect(outcome).toMatchObject({ verdict: "APPROVE", notes: notice, output: notice, notesMissing: true });
    expect(sessions[0].prompt).toHaveBeenCalledTimes(2);
  });

  it("fails soft when the repair rejects", async () => {
    const { outcome, sessions } = await runReview([
      '{"verdict":"APPROVE","notes":""}',
      new Error("repair unavailable"),
    ]);
    const notice = workflowStepVerdictNoNotesNotice("APPROVE", "failed-soft");
    expect(outcome).toMatchObject({ verdict: "APPROVE", notes: notice, output: notice, notesMissing: true });
    expect(sessions[0].prompt).toHaveBeenCalledTimes(2);
  });

  it("fails soft when the bounded repair times out", async () => {
    vi.useFakeTimers();
    const pending = runReview([
      '{"verdict":"APPROVE","notes":""}',
      "never",
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    const { outcome, sessions } = await pending;
    const notice = workflowStepVerdictNoNotesNotice("APPROVE", "timed-out");
    expect(outcome).toMatchObject({ verdict: "APPROVE", notes: notice, output: notice, notesMissing: true });
    expect(sessions[0].prompt).toHaveBeenCalledTimes(2);
  });

  it("does not repair when reviewer prose supplies the note", async () => {
    const prose = "I inspected the implementation and its focused tests; both satisfy the task.";
    const { outcome, sessions } = await runReview([`${prose}\n{"verdict":"APPROVE","notes":""}`]);
    expect(outcome).toMatchObject({ verdict: "APPROVE", notes: prose, output: prose });
    expect(outcome.notes).not.toContain("without a rationale");
    expect(sessions[0].prompt).toHaveBeenCalledOnce();
  });

  it("does not repair CLOSE_NO_OP", async () => {
    const { outcome, sessions } = await runReview(
      ['{"verdict":"CLOSE_NO_OP","notes":""}'],
      { id: "graph:plan-review-step", name: "Plan Review", optionalGroupId: "plan-review" },
    );
    expect(outcome).toMatchObject({ verdict: "CLOSE_NO_OP", notes: "", output: "" });
    expect(outcome.notes).not.toContain("without a rationale");
    expect(sessions[0].prompt).toHaveBeenCalledOnce();
  });

  it("keeps the original verdict when the repair reply names another verdict", async () => {
    const note = "I checked the scoped diff and targeted tests; both are complete.";
    const { outcome } = await runReview([
      '{"verdict":"APPROVE","notes":""}',
      JSON.stringify({ verdict: "REVISE", notes: note }),
    ]);
    expect(outcome).toMatchObject({ verdict: "APPROVE", notes: note, output: note, success: true });
    expect(outcome.notes).not.toContain("without a rationale");
  });

  it("narrates an unchanged legacy review whose persisted output and notes are empty", async () => {
    const subject = baseTask() as any;
    const store = createMockStore();
    store.getTask.mockResolvedValue(subject);
    const sessions = installSessions([['{"verdict":"APPROVE","notes":"Reviewed the plan and found it ready."}']]);
    const executor = new TaskExecutor(store as any, "/tmp/test", {
      agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
    } as any);
    vi.spyOn(executor as any, "readTaskArtifact").mockResolvedValue("# Approved plan\n\nImplement the task.\n");
    const step = reviewStep({
      id: "graph:plan-review-step",
      name: "Plan Review",
      optionalGroupId: PLAN_REVIEW_GROUP_ID,
      reviewKind: "plan",
    });

    const first = await (executor as any).executeWorkflowStep(subject, step, subject.worktree, {});
    /*
    FNXC:ReviewGateIdentity 2026-09-26-06:35: the persisted prior record is keyed by the GATE id
    (PLAN_REVIEW_GROUP_ID), because that is what `findReusableReviewResult` matches on
    (execute-workflow-step.ts:134, called with sameGateStepId at :620). Keyed to the inner step id
    ("plan-review-step") the record is not found at all, a SECOND review dispatch runs, and the
    "reused-empty" notice this test exists to cover is never reached. With the gate id the record
    matches, and because the fixture genuinely persists notes:"" and output:"",
    `storedReusedNotes` is "" so the notice IS produced (execute-workflow-step.ts:640-641) — the
    behaviour under test, reached through the product's real reuse path.
    */
    subject.workflowStepResults = [{
      workflowStepId: PLAN_REVIEW_GROUP_ID,
      workflowStepName: "Plan Review",
      phase: "pre-merge",
      status: "passed",
      verdict: "APPROVE",
      output: "",
      notes: "",
      reviewInputFingerprint: first.reviewInputFingerprint,
      startedAt: "2026-08-28T22:00:00.000Z",
      completedAt: "2026-08-28T22:01:00.000Z",
    }];

    const reused = await (executor as any).executeWorkflowStep(subject, step, subject.worktree, {});
    const notice = workflowStepVerdictNoNotesNotice("APPROVE", "reused-empty");
    expect(reused).toMatchObject({ verdict: "APPROVE", notes: notice, output: notice });
    expect(sessions).toHaveLength(1);
    expect(mockedCreateFnAgent).toHaveBeenCalledOnce();
  });

  it("repairs each workspace repository in its own session and preserves aggregate notes", async () => {
    const task = {
      ...baseTask(),
      repositoryScope: { state: "confirmed", revision: 3, repositories: ["repo-a", "repo-b"] },
      workspaceWorktrees: {
        "repo-a": { worktreePath: "/workspace/repo-a", baseCommitSha: "base-a" },
        "repo-b": { worktreePath: "/workspace/repo-b", baseCommitSha: "base-b" },
      },
    } as any;
    const noteA = "I checked repository A's scoped diff and tests; both are correct.";
    const noteB = "I checked repository B's scoped diff and tests; both are correct.";
    const store = createMockStore();
    store.getTask.mockResolvedValue(task);
    const sessions = installSessions([
      ['{"verdict":"APPROVE","notes":""}', JSON.stringify({ notes: noteA })],
      ['{"verdict":"APPROVE","notes":""}', JSON.stringify({ notes: noteB })],
    ]);
    const executor = new TaskExecutor(store as any, "/workspace", {
      agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
    } as any);

    const aggregate = await reviewWorkspacePerRepo(task, async (cwd) => toWorkspaceRepoReviewResult(
      await (executor as any).executeWorkflowStep(task, reviewStep(), cwd, { workflowStepTimeoutMs: 60_000 }, undefined),
    ), {
      workspaceRepos: ["repo-a", "repo-b"],
      workspaceRootDir: "/workspace",
      captureModifiedFiles: async () => ["src/changed.ts"],
    });

    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.prompt.mock.calls.length === 2)).toBe(true);
    expect(aggregate.review).toContain(`### [repo-a] APPROVE\n${noteA}`);
    expect(aggregate.review).toContain(`### [repo-b] APPROVE\n${noteB}`);
    expect(buildWorkspaceReviewOutcome(aggregate)).toMatchObject({ notes: aggregate.review, output: aggregate.review });
  });

  it("narrates one workspace repository whose repair fails soft without hiding its peer note", async () => {
    const task = {
      ...baseTask(),
      repositoryScope: { state: "confirmed", revision: 4, repositories: ["repo-a", "repo-b"] },
      workspaceWorktrees: {
        "repo-a": { worktreePath: "/workspace/repo-a", baseCommitSha: "base-a" },
        "repo-b": { worktreePath: "/workspace/repo-b", baseCommitSha: "base-b" },
      },
    } as any;
    const peerNote = "I checked repository B's scoped diff and tests; both are correct.";
    const store = createMockStore();
    store.getTask.mockResolvedValue(task);
    const sessions = installSessions([
      ['{"verdict":"APPROVE","notes":""}', '{"notes":""}'],
      ['{"verdict":"APPROVE","notes":""}', JSON.stringify({ notes: peerNote })],
    ]);
    const executor = new TaskExecutor(store as any, "/workspace", {
      agentStore: { getAgent: vi.fn().mockResolvedValue(null), createAgent: vi.fn() },
    } as any);

    const aggregate = await reviewWorkspacePerRepo(task, async (cwd) => toWorkspaceRepoReviewResult(
      await (executor as any).executeWorkflowStep(task, reviewStep(), cwd, { workflowStepTimeoutMs: 60_000 }, undefined),
    ), {
      workspaceRepos: ["repo-a", "repo-b"],
      workspaceRootDir: "/workspace",
      captureModifiedFiles: async () => ["src/changed.ts"],
    });

    const notice = workflowStepVerdictNoNotesNotice("APPROVE", "empty");
    expect(sessions).toHaveLength(2);
    expect(aggregate.review).toContain(`### [repo-a] APPROVE\n${notice}`);
    expect(aggregate.review).not.toContain(WORKSPACE_REPO_REVIEW_NO_NOTES_NOTICE);
    expect(aggregate.review).toContain(`### [repo-b] APPROVE\n${peerNote}`);
    expect(aggregate.review.match(/without a rationale/g)).toHaveLength(1);
  });
});
