import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { reviewStep } from "../execution/reviewer.js";
import * as worktreePool from "../worktree/worktree-pool.js";
import { createMockStore, mockedCreateFnAgent, mockedExecSync, resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:EngineTests 2026-09-26-07:05:
`TaskExecutor.execute` reserves the pinned worktree on the REAL filesystem before it constructs the
agent session, and that failure is caught into a terminal row rather than thrown — so a fictional root
never surfaces at the `execute()` call. It resurfaces later as `doneTool.execute` on `undefined`,
which reads like a missing tool when the tool was never handed over. The suite therefore runs against
a real writable root, and the mocked `git rev-parse --show-toplevel` derives from that same root so the
resolved toplevel cannot disagree with the reservation.

`node:fs` is mocked wholesale by executor-test-helpers, so temp roots come from `node:fs/promises`,
which is not mocked.
*/
let workRoot = "";
let worktreePath = "";

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "fusion-revise-verdict-guard-"));
  worktreePath = join(workRoot, ".worktrees", "swift-falcon");
  await mkdir(worktreePath, { recursive: true });
});

afterEach(async () => {
  if (workRoot) await rm(workRoot, { recursive: true, force: true });
  workRoot = "";
  worktreePath = "";
});

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-4851",
    title: "REVISE guard",
    description: "",
    column: "in-progress",
    worktree: worktreePath,
    branch: "fusion/fn-4851",
    baseCommitSha: "abc123",
    taskDoneRetryCount: 0,
    dependencies: [],
    steps: [{ name: "Step 1", status: "in-progress" as const }],
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function setup(overrides: Record<string, unknown> = {}) {
  const store = createMockStore();
  let task: any = createTask(overrides);
  let doneTool: any;

  store.getTask.mockImplementation(async () => ({ ...task, steps: task.steps.map((s: any) => ({ ...s })) }));
  store.moveTask.mockImplementation(async (_id: string, column: string) => {
    task = { ...task, column };
  });

  mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
    doneTool = customTools.find((tool: any) => tool.name === "fn_task_done") ?? doneTool;
    return { session: { prompt: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() } } as any;
  });

  const executor = new TaskExecutor(store as any, workRoot);
  await executor.execute(createTask() as any);

  return { store, doneTool };
}

describe("FN-4851 REVISE verdict task-done guard", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from(`${worktreePath}\n`);
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-4851\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      if (cmd.includes("rev-parse HEAD")) return Buffer.from("def456\n");
      return Buffer.from("");
    });
    vi.mocked(reviewStep).mockResolvedValue({
      verdict: "REVISE",
      summary: "Needs fixes",
      review: "Please fix issues",
    } as any);
  });

  it("ignores REVISE verdict on already done or skipped steps", async () => {
    const { doneTool } = await setup({
      steps: [{ name: "Step 1", status: "done" }, { name: "Step 2", status: "skipped" }],
    });

    const result = await doneTool.execute("done", { summary: "Implemented all requested changes." });

    expect(result.details.refusalClass).toBeUndefined();
    expect(result.content[0].text).toContain("Task marked complete");
  });
});
