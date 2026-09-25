/**
 * FNXC:EvolutionSignalCapture 2026-09-25-10:00:
 * GDPR-075 requires every production task finalization to feed a privacy-safe
 * EvolutionSignal without mining prompts or making task completion depend on
 * best-effort telemetry. These tests pin the signal projection and at-most-once
 * behavior before the production hook is wired.
 */
import { describe, expect, it, vi } from "vitest";
import type { Agent, Task } from "@fusion/core";
import { createTaskEvolutionSignalCapture, type EvolutionSignalCaptureStore } from "../agents/evolution-signal-capture.js";

function task(overrides: Partial<Task> & { reviewVerdict?: string; humanFeedback?: string } = {}): Task {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Do not mine this prompt",
    description: "Bearer sk-test-secret-must-not-be-copied",
    column: "done",
    status: "in-progress",
    priority: 2,
    assignee: "coder",
    assignedAgentId: "agent-1",
    createdAt: "2026-09-25T09:00:00.000Z",
    updatedAt: "2026-09-25T09:00:01.000Z",
    tokenUsage: { inputTokens: 20, outputTokens: 8 },
    ...overrides,
  } as Task;
}

function agent(): Agent {
  return { id: "agent-1", name: "coder" } as Agent;
}

function store(): EvolutionSignalCaptureStore {
  return {
    createSignal: vi.fn(async (input) => ({
      id: "evolution-signal-1",
      timestamp: "2026-09-25T09:00:00.000Z",
      ...input,
    }) as never),
  };
}

describe("createTaskEvolutionSignalCapture", () => {
  it("projects a successful task run without prompt text or absent feedback", async () => {
    const capture = createTaskEvolutionSignalCapture({ store: store(), now: () => 1_000 });

    const result = await capture({
      task: task(),
      agent: agent(),
      startedAtMs: 250,
    });

    expect(result.signal).toMatchObject({
      agentId: "agent-1",
      taskId: "task-1",
      outcome: "success",
      costTokens: 28,
      durationMs: 750,
      source: "execution",
    });
    expect(result.signal).not.toHaveProperty("humanFeedback");
    expect(result.signal).not.toHaveProperty("qualityScore");
    expect(JSON.stringify(result.signal)).not.toContain("Do not mine");
    expect(JSON.stringify(result.signal)).not.toContain("sk-test-secret");
  });

  it("normalizes failed production finalization without persisting error prose", async () => {
    const result = await createTaskEvolutionSignalCapture({ store: store(), now: () => 2_000 })({
      task: task({ column: "in-review", status: "error", error: "token sk-secret failed" }),
      agent: agent(),
      startedAtMs: 500,
    });

    expect(result.signal).toMatchObject({
      outcome: "failure",
      failureCategory: "unknown",
      durationMs: 1_500,
    });
    expect(JSON.stringify(result.signal)).not.toContain("sk-secret");
    expect(JSON.stringify(result.signal)).not.toContain("failed");
  });

  it("forwards only explicit review-derived feedback and aggregates current task tokens", async () => {
    const result = await createTaskEvolutionSignalCapture({ store: store(), now: () => 3_000 })({
      task: task({ status: "review", reviewVerdict: "revision-requested", humanFeedback: "secret=abc123456" }),
      agent: agent(),
    });

    expect(result.signal).toMatchObject({
      outcome: "failure",
      reviewVerdict: "revision-requested",
      qualityScore: 0.5,
      humanFeedback: "secret=[REDACTED]",
      costTokens: 28,
      source: "review",
    });
  });

  it("deduplicates a finalization replay and only writes the first signal", async () => {
    const evolutionStore = store();
    const capture = createTaskEvolutionSignalCapture({ store: evolutionStore });
    const input = { task: task(), agent: agent(), startedAtMs: 10 };

    expect((await capture(input)).deduplicated).toBe(false);
    expect((await capture(input)).deduplicated).toBe(true);
    expect(evolutionStore.createSignal).toHaveBeenCalledTimes(1);
  });

  it("retains lifecycle completion when the bounded store write fails", async () => {
    const createSignal = vi.fn(async () => {
      throw new Error("disk unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      createTaskEvolutionSignalCapture({ store: { createSignal }, onError: (error) => warn(String(error)) })({
        task: task(),
        agent: agent(),
      }),
    ).resolves.toEqual({ signal: null, deduplicated: false });
    expect(warn).toHaveBeenCalledOnce();
  });
});
