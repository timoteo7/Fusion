import { describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import { isRetryableModelSelectionError, promptWithFallback } from "../pi.js";
import { isContextLimitError } from "../errors/context-limit-detector.js";

function makeSession(reasons: string[], options: { promptError?: Error; abortError?: Error; completionAfterAbort?: boolean } = {}) {
  const listeners = new Set<AgentSessionEventListener>();
  let aborted = false;
  let turns = 0;
  const emit = (event: AgentSessionEvent) => {
    for (const listener of listeners) listener(event);
  };
  const session = {
    subscribe: vi.fn((listener: AgentSessionEventListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    steer: vi.fn(async (_text: string) => {}),
    abort: vi.fn(async () => {
      aborted = true;
      if (options.abortError) throw options.abortError;
    }),
    prompt: vi.fn(async (_prompt: string, _options?: unknown) => {
      for (const stopReason of reasons) {
        if (aborted) break;
        turns++;
        emit({ type: "message_end", message: { role: "assistant", stopReason, content: [] } } as AgentSessionEvent);
        // Allow native async steering/abort to settle between assistant turns.
        await Promise.resolve();
      }
      if (options.completionAfterAbort) {
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } } as AgentSessionEvent);
      }
      if (options.promptError) throw options.promptError;
    }),
    compact: vi.fn(),
  };
  return { session, asSession: session as unknown as AgentSession, listeners, turns: () => turns, emit };
}

describe("Pi live-prompt output truncation", () => {
  it("bounds repeated length events inside one prompt instead of waiting for prompt to return", async () => {
    const fake = makeSession(["length", "length", "length", "length"]);
    await expect(promptWithFallback(fake.asSession, "plan")).rejects.toThrow(/output.*limit.*3/i);
    expect(fake.turns()).toBe(3);
    expect(fake.session.prompt).toHaveBeenCalledTimes(1);
    expect(fake.session.abort).toHaveBeenCalledTimes(1);
    expect(fake.session.compact).not.toHaveBeenCalled();
    expect(fake.listeners.size).toBe(0);
  });

  it("steers smaller complete outputs without dropping headings or gate evidence and permits convergence", async () => {
    const fake = makeSession(["length", "length", "stop"]);
    const prompt = "## Steps\n### Step 1: implement\nKeep required verification gates";
    await expect(promptWithFallback(fake.asSession, prompt)).resolves.toBeUndefined();
    expect(fake.session.prompt).toHaveBeenCalledWith(prompt);
    expect(fake.session.steer).toHaveBeenCalledTimes(2);
    expect(fake.session.steer.mock.calls[0][0]).toMatch(/smaller.*complete/i);
    expect(fake.session.steer.mock.calls[0][0]).toContain("### Step");
    expect(fake.session.steer.mock.calls[0][0]).toMatch(/gate.*evidence/i);
    expect(fake.session.abort).not.toHaveBeenCalled();
    expect(fake.listeners.size).toBe(0);
  });

  it("does not report a final truncated text response as success", async () => {
    const fake = makeSession(["length"]);
    await expect(promptWithFallback(fake.asSession, "plan")).rejects.toThrow(/output.*limit/i);
    expect(fake.listeners.size).toBe(0);
  });

  it("does not reset the cumulative bound after an intervening complete tool turn", async () => {
    const fake = makeSession(["length", "toolUse", "length", "toolUse", "length", "stop"]);
    await expect(promptWithFallback(fake.asSession, "plan")).rejects.toThrow(/output.*limit/i);
    expect(fake.turns()).toBe(5);
    expect(fake.session.abort).toHaveBeenCalledTimes(1);
  });

  it("preserves exhaustion if abort races a completed response or rejects", async () => {
    const fake = makeSession(["length", "length", "length"], {
      abortError: new Error("abort failed"), completionAfterAbort: true,
    });
    await expect(promptWithFallback(fake.asSession, "plan")).rejects.toThrow(/output.*limit/i);
    expect(fake.listeners.size).toBe(0);
  });

  it("leaves ordinary responses and options unchanged", async () => {
    const fake = makeSession(["toolUse", "stop"]);
    const options = { images: [] };
    await expect(promptWithFallback(fake.asSession, "plan", options)).resolves.toBeUndefined();
    expect(fake.session.prompt).toHaveBeenCalledWith("plan", options);
    expect(fake.session.abort).not.toHaveBeenCalled();
    expect(fake.session.steer).not.toHaveBeenCalled();
    expect(fake.listeners.size).toBe(0);
  });

  it("unsubscribes on prompt errors and does not respond to later events", async () => {
    const fake = makeSession([], { promptError: new Error("ordinary failure") });
    await expect(promptWithFallback(fake.asSession, "plan")).rejects.toThrow("ordinary failure");
    fake.emit({ type: "message_end", message: { role: "assistant", stopReason: "length", content: [] } } as AgentSessionEvent);
    expect(fake.listeners.size).toBe(0);
    expect(fake.session.steer).not.toHaveBeenCalled();
    expect(fake.session.abort).not.toHaveBeenCalled();
  });

  it("keeps actual guard errors out of context and model-fallback retry classifiers", async () => {
    const fake = makeSession(["length", "length", "length"]);
    const error = await promptWithFallback(fake.asSession, "plan").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(isContextLimitError(message)).toBe(false);
    expect(isRetryableModelSelectionError(message)).toBe(false);
  });

  it("fails closed when native steering rejects", async () => {
    const fake = makeSession(["length", "length", "length", "length"]);
    fake.session.steer.mockRejectedValue(new Error("steer rejected"));
    await expect(promptWithFallback(fake.asSession, "plan")).rejects.toThrow(/output.*limit/i);
    expect(fake.session.abort).toHaveBeenCalledTimes(1);
    expect(fake.listeners.size).toBe(0);
  });

  it("owns a delayed prompt even when abort rejects and preserves exhaustion over late prompt rejection", async () => {
    const fake = makeSession([]);
    let finishPrompt!: () => void;
    const promptBlocked = new Promise<void>((resolve) => { finishPrompt = resolve; });
    let promptSettled = false;
    fake.session.abort.mockRejectedValue(new Error("abort rejected"));
    fake.session.prompt.mockImplementation(async () => {
      for (let i = 0; i < 3; i++) {
        fake.emit({ type: "message_end", message: { role: "assistant", stopReason: "length", content: [] } } as AgentSessionEvent);
      }
      await promptBlocked;
      promptSettled = true;
      throw new Error("maximum context length is 4096 tokens");
    });
    let returned = false;
    vi.useFakeTimers();
    const result = promptWithFallback(fake.asSession, "plan").catch((error: unknown) => {
      returned = true;
      return error;
    });
    try {
      await vi.advanceTimersByTimeAsync(1_500);
      expect(fake.session.abort).toHaveBeenCalledTimes(1);
      expect(returned).toBe(false);
      expect(promptSettled).toBe(false);
      expect(fake.listeners.size).toBe(1);
      finishPrompt();
      const error = await result;
      expect(error).toMatchObject({ message: expect.stringMatching(/output.*limit.*3/i) });
      expect(promptSettled).toBe(true);
      expect(isContextLimitError((error as Error).message)).toBe(false);
      expect(isRetryableModelSelectionError((error as Error).message)).toBe(false);
      expect(fake.session.prompt).toHaveBeenCalledTimes(1);
      expect(fake.session.compact).not.toHaveBeenCalled();
      expect(fake.listeners.size).toBe(0);
    } finally {
      finishPrompt();
      await result;
      vi.useRealTimers();
    }
  });

  it("drains native abort before returning an actionable guard failure", async () => {
    const fake = makeSession(["length", "length", "length"]);
    let finishAbort!: () => void;
    const abortDrain = new Promise<void>((resolve) => { finishAbort = resolve; });
    fake.session.abort.mockImplementation(() => abortDrain);
    let returned = false;
    const result = promptWithFallback(fake.asSession, "plan").catch((error: unknown) => {
      returned = true;
      return error;
    });
    // Flush the finite prompt/event chain; abort deliberately stays pending.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(fake.session.abort).toHaveBeenCalledTimes(1);
    expect(returned).toBe(false);
    finishAbort();
    expect(await result).toBeInstanceOf(Error);
    expect(fake.listeners.size).toBe(0);
  });

  it("keeps a delayed abort drain owned past the old timeout even after the prompt settles", async () => {
    let finishAbort!: () => void;
    const abortBlocked = new Promise<void>((resolve) => { finishAbort = resolve; });
    const fake = makeSession(["length", "length", "length"]);
    fake.session.abort.mockImplementation(() => abortBlocked);
    let returned = false;
    vi.useFakeTimers();
    const result = promptWithFallback(fake.asSession, "plan").catch((error: unknown) => {
      returned = true;
      return error;
    });
    try {
      await vi.advanceTimersByTimeAsync(1_500);
      expect(fake.session.abort).toHaveBeenCalledTimes(1);
      expect(returned).toBe(false);
      expect(fake.listeners.size).toBe(1);
      finishAbort();
      const error = await result;
      expect(error).toMatchObject({ message: expect.stringMatching(/output.*limit.*3/i) });
      expect(isContextLimitError((error as Error).message)).toBe(false);
      expect(isRetryableModelSelectionError((error as Error).message)).toBe(false);
      expect(fake.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finishAbort();
      await result;
      vi.useRealTimers();
    }
  });

  it("owns delayed steering hooks and retains their failure after the prompt settles", async () => {
    const fake = makeSession(["length", "stop"]);
    let failSteer!: () => void;
    const steeringBlocked = new Promise<void>((_resolve, reject) => {
      failSteer = () => reject(new Error("steering hook rejected"));
    });
    fake.session.steer.mockImplementation(() => steeringBlocked);
    let returned = false;
    vi.useFakeTimers();
    const result = promptWithFallback(fake.asSession, "plan").then(() => {
      returned = true;
    }, (error: unknown) => {
      returned = true;
      return error;
    });
    try {
      await vi.advanceTimersByTimeAsync(1_500);
      expect(fake.session.steer).toHaveBeenCalledTimes(1);
      expect(returned).toBe(false);
      expect(fake.listeners.size).toBe(1);
      failSteer();
      expect(await result).toMatchObject({ message: expect.stringMatching(/output.*limit.*1/i) });
      expect(fake.session.abort).toHaveBeenCalledTimes(1);
      expect(fake.listeners.size).toBe(0);
    } finally {
      failSteer();
      await result;
      vi.useRealTimers();
    }
  });

  it("does not let a prompt error racing exhaustion reopen context recovery", async () => {
    const fake = makeSession(["length", "length", "length"], {
      promptError: new Error("maximum context length is 4096 tokens"),
    });
    await expect(promptWithFallback(fake.asSession, "plan")).rejects.toThrow(/output.*limit.*3/i);
    expect(fake.session.compact).not.toHaveBeenCalled();
    expect(fake.session.prompt).toHaveBeenCalledTimes(1);
  });

  it("preserves prompt execution for adapters without subscribe", async () => {
    const fake = makeSession(["stop"]);
    const adapter = { ...fake.session, subscribe: undefined };
    await expect(promptWithFallback(adapter as unknown as AgentSession, "plan")).resolves.toBeUndefined();
    expect(fake.session.prompt).toHaveBeenCalledWith("plan");
    expect(fake.session.abort).not.toHaveBeenCalled();
  });

  it("preserves normal success when an adapter subscribe does not return a disposer", async () => {
    const fake = makeSession(["stop"]);
    const adapter = { ...fake.session, subscribe: (listener: AgentSessionEventListener) => { fake.listeners.add(listener); } };
    await expect(promptWithFallback(adapter as unknown as AgentSession, "plan")).resolves.toBeUndefined();
    fake.emit({ type: "message_end", message: { role: "assistant", stopReason: "length", content: [] } } as AgentSessionEvent);
    expect(fake.session.steer).not.toHaveBeenCalled();
    expect(fake.session.abort).not.toHaveBeenCalled();
  });

  it("preserves the original prompt error when an adapter subscribe has no disposer", async () => {
    const fake = makeSession([], { promptError: new Error("original prompt failure") });
    const adapter = { ...fake.session, subscribe: (listener: AgentSessionEventListener) => { fake.listeners.add(listener); } };
    await expect(promptWithFallback(adapter as unknown as AgentSession, "plan")).rejects.toThrow("original prompt failure");
  });
});
