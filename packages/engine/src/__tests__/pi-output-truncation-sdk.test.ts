import { describe, expect, it, vi } from "vitest";
import { Type, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, createExtensionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { promptWithOutputTruncationGuard } from "../pi-output-truncation.js";

const resourceLoader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "Keep required headings and verification gates.",
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

async function createScriptedSession(reasons: Array<"length" | "toolUse" | "stop">, loader = resourceLoader) {
  const faux = fauxProvider({ tokensPerSecond: 0 });
  faux.setResponses(reasons.map((stopReason) => fauxAssistantMessage(
    stopReason === "stop" ? "complete" : fauxToolCall("publish_plan", { text: "partial" }),
    { stopReason },
  )));
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "published" }], details: {} }));
  const { session } = await createAgentSession({
    cwd: process.cwd(), modelRuntime, model: faux.getModel(), resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    tools: ["publish_plan"],
    customTools: [{ name: "publish_plan", label: "Publish", description: "Publish plan", parameters: Type.Object({ text: Type.String() }), execute }],
  });
  return { session, faux, execute };
}

describe("Pi SDK internal truncated-tool loop", () => {
  it("stops repeated native length turns inside one prompt without executing partial tools", async () => {
    const { session, faux, execute } = await createScriptedSession(["length", "length", "length", "stop"]);
    const prompt = vi.spyOn(session, "prompt");
    const steer = vi.spyOn(session, "steer");
    try {
      await expect(promptWithOutputTruncationGuard(session, () => session.prompt("publish plan"))).rejects.toThrow(/output.*limit.*3/i);
      await session.waitForIdle();
      expect(faux.state.callCount).toBe(3);
      expect(session.messages.filter((message) => message.role === "assistant" && message.stopReason === "length")).toHaveLength(3);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(steer).toHaveBeenCalledTimes(2);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it("owns a delayed native turn_end past the old abort deadline before caller failure and teardown", async () => {
    let releaseHook!: () => void;
    let enterHook!: () => void;
    const hookBlocked = new Promise<void>((resolve) => { releaseHook = resolve; });
    const hookEntered = new Promise<void>((resolve) => { enterHook = resolve; });
    let turns = 0;
    let sideEffects = 0;
    let writesAfterTeardown = 0;
    let teardownReturned = false;
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(), agentDir: process.cwd(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.on("turn_end", async () => {
          turns++;
          if (turns === 3) {
            enterHook();
            await hookBlocked;
            sideEffects++;
            if (teardownReturned) writesAfterTeardown++;
          }
        });
      }],
    });
    await loader.reload();
    const { session, faux, execute } = await createScriptedSession(["length", "length", "length", "stop"], loader);
    let promptSettled = false;
    let callerFailed = false;
    vi.useFakeTimers();
    const result = promptWithOutputTruncationGuard(session, () => session.prompt("publish plan").finally(() => {
      promptSettled = true;
    })).catch((error: unknown) => {
      callerFailed = true;
      return error;
    }).finally(() => {
      session.dispose();
      teardownReturned = true;
    });
    try {
      await hookEntered;
      await vi.advanceTimersByTimeAsync(1_500);
      expect(faux.state.callCount).toBe(3);
      expect(execute).not.toHaveBeenCalled();
      expect(session.isIdle).toBe(false);
      expect(promptSettled).toBe(false);
      expect(callerFailed).toBe(false);
      expect(teardownReturned).toBe(false);
      expect(sideEffects).toBe(0);
      releaseHook();
      expect(await result).toMatchObject({ message: expect.stringMatching(/output.*limit.*3/i) });
      expect(promptSettled).toBe(true);
      expect(session.isIdle).toBe(true);
      expect(callerFailed).toBe(true);
      expect(teardownReturned).toBe(true);
      expect(sideEffects).toBe(1);
      expect(writesAfterTeardown).toBe(0);
      expect(faux.state.callCount).toBe(3);
      expect(session.messages.filter((message) => message.role === "assistant" && message.stopReason === "length")).toHaveLength(3);
      expect(execute).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseHook();
      await result;
      await session.waitForIdle();
      session.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps the partial-tool refusal but permits a complete tool retry and normal stop", async () => {
    const { session, faux, execute } = await createScriptedSession(["length", "toolUse", "stop"]);
    try {
      await expect(promptWithOutputTruncationGuard(session, () => session.prompt("publish plan"))).resolves.toBeUndefined();
      expect(faux.state.callCount).toBe(3);
      expect(execute).toHaveBeenCalledTimes(1);
      const refused = session.messages.filter((message) => message.role === "toolResult" && message.isError);
      expect(refused).toHaveLength(1);
    } finally {
      session.dispose();
    }
  });
});
