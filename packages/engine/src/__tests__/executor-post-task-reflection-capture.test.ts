import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

/**
 * FNXC:AgentReflection 2026-07-04-00:00:
 * FN-7528: `signalTaskComplete` is the single seam every executor completion call site routes
 * through. These tests assert the deterministic, non-LLM post-task performance capture fires
 * exactly once per completion (guarded by reflectionService/settings.reflectionEnabled/assigned
 * agent id) and never blocks completion when capture fails.
 */
describe("TaskExecutor post-task reflection capture (FN-7528)", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  function makeTask(overrides: Record<string, unknown> = {}) {
    return {
      id: "FN-7528",
      description: "Test task",
      column: "in-review",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      assignedAgentId: "agent-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    } as any;
  }

  it("invokes reflectionService.captureTaskPerformance once when reflectionEnabled and an agent is assigned", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      reflectionEnabled: true,
    });

    const captureTaskPerformance = vi.fn().mockResolvedValue(null);
    const executor = new TaskExecutor(store as any, "/tmp/test", {
      reflectionService: { captureTaskPerformance } as any,
    });

    const task = makeTask();
    (executor as any).signalTaskComplete(task);
    // Fire-and-forget: flush the microtask queue.
    await new Promise((resolve) => setImmediate(resolve));

    expect(captureTaskPerformance).toHaveBeenCalledTimes(1);
    expect(captureTaskPerformance).toHaveBeenCalledWith("agent-1", "FN-7528");
  });

  it("does not capture a second time for the same task", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ reflectionEnabled: true });

    const captureTaskPerformance = vi.fn().mockResolvedValue(null);
    const executor = new TaskExecutor(store as any, "/tmp/test", {
      reflectionService: { captureTaskPerformance } as any,
    });

    const task = makeTask();
    (executor as any).signalTaskComplete(task);
    (executor as any).signalTaskComplete(task);
    await new Promise((resolve) => setImmediate(resolve));

    expect(captureTaskPerformance).toHaveBeenCalledTimes(1);
  });

  it("skips capture when settings.reflectionEnabled is false", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ reflectionEnabled: false });

    const captureTaskPerformance = vi.fn().mockResolvedValue(null);
    const executor = new TaskExecutor(store as any, "/tmp/test", {
      reflectionService: { captureTaskPerformance } as any,
    });

    (executor as any).signalTaskComplete(makeTask());
    await new Promise((resolve) => setImmediate(resolve));

    expect(captureTaskPerformance).not.toHaveBeenCalled();
  });

  it("skips capture when no agent is assigned", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ reflectionEnabled: true });

    const captureTaskPerformance = vi.fn().mockResolvedValue(null);
    const executor = new TaskExecutor(store as any, "/tmp/test", {
      reflectionService: { captureTaskPerformance } as any,
    });

    (executor as any).signalTaskComplete(makeTask({ assignedAgentId: undefined }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(captureTaskPerformance).not.toHaveBeenCalled();
  });

  it("never blocks or fails completion when capture throws (best-effort)", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ reflectionEnabled: true });

    const captureTaskPerformance = vi.fn().mockRejectedValue(new Error("capture failed"));
    const onComplete = vi.fn();
    const executor = new TaskExecutor(store as any, "/tmp/test", {
      reflectionService: { captureTaskPerformance } as any,
      onComplete,
    });

    expect(() => (executor as any).signalTaskComplete(makeTask())).not.toThrow();
    expect(onComplete).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(captureTaskPerformance).toHaveBeenCalledTimes(1);
  });

  it("still forwards to the configured onComplete callback", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ reflectionEnabled: true });

    const onComplete = vi.fn();
    const executor = new TaskExecutor(store as any, "/tmp/test", { onComplete });

    const task = makeTask();
    (executor as any).signalTaskComplete(task);

    expect(onComplete).toHaveBeenCalledWith(task);
  });

  /**
   * FNXC:EvolutionSignalCapture 2026-09-25-10:00:
   * GDPR-075 finalization seam proof. A real executor completion callback must
   * create one redacted signal while the configured onComplete callback remains
   * synchronous and unaffected.
   */
  it("captures one redacted Evolution signal from production finalization", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ reflectionEnabled: false, memoryEnabled: false });
    const createSignal = vi.fn(async (input) => ({
      id: "evolution-signal-1",
      timestamp: "2026-09-25T09:00:00.000Z",
      ...input,
    }));
    const executor = new TaskExecutor(store as any, "/tmp/test", {
      agentStore: { getAgent: vi.fn(async () => ({ id: "agent-1", name: "coder" })) } as any,
      evolutionStore: { createSignal },
      onComplete: vi.fn(),
    });
    (executor as any).taskStartTimes.set("task-1", 250);

    (executor as any).signalTaskComplete(makeTask({
      id: "task-1",
      description: "Never persist this prompt",
      status: "in-progress",
      column: "todo",
      tokenUsage: { inputTokens: 5, outputTokens: 3 },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(createSignal).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-1",
      taskId: "task-1",
      outcome: "success",
      source: "execution",
      costTokens: 8,
    }));
    expect(JSON.stringify(createSignal.mock.calls)).not.toContain("Never persist");
  });

  /**
   * FNXC:EvolutionSignalCapture 2026-09-25-10:20:
   * Regression: the completion seam deletes its taskStartTimes entry synchronously,
   * right after signalTaskComplete returns. A capture that read the start time after
   * `await agentStore.getAgent(...)` therefore always resolved to undefined and every
   * production signal silently lost durationMs. Assert the wiring produces a real
   * duration, which fails if the read moves back behind the await.
   */
  it("carries the real task duration into the production signal", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ reflectionEnabled: false, memoryEnabled: false });
    const createSignal = vi.fn(async (input) => ({
      id: "evolution-signal-2",
      timestamp: "2026-09-25T09:00:00.000Z",
      ...input,
    }));
    const executor = new TaskExecutor(store as any, "/tmp/test", {
      agentStore: { getAgent: vi.fn(async () => ({ id: "agent-1", name: "coder" })) } as any,
      evolutionStore: { createSignal },
      onComplete: vi.fn(),
    });
    // Start time far enough in the past that the projected duration is unmistakable.
    (executor as any).taskStartTimes.set("task-duration", Date.now() - 90_000);

    (executor as any).signalTaskComplete(makeTask({
      id: "task-duration",
      status: "in-progress",
      column: "todo",
    }));
    await new Promise((resolve) => setImmediate(resolve));

    const captured = createSignal.mock.calls[0]?.[0] as { durationMs?: number } | undefined;
    expect(captured?.durationMs).toBeGreaterThan(89_000);
  });

  it("retains completion when Evolution signal projection fails", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({ reflectionEnabled: false, memoryEnabled: false });
    const onComplete = vi.fn();
    const executor = new TaskExecutor(store as any, "/tmp/test", {
      agentStore: { getAgent: vi.fn(async () => null) } as any,
      evolutionStore: { createSignal: vi.fn(async () => { throw new Error("disk unavailable"); }) },
      onComplete,
    });

    (executor as any).signalTaskComplete(makeTask({ id: "task-2" }));

    expect(onComplete).toHaveBeenCalledOnce();
  });
});
