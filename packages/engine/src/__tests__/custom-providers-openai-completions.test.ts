import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { completeSimple } from "@earendil-works/pi-ai/compat";
/*
FNXC:Dependencies 2026-07-01-08:16:
The pi 0.80 SDK keeps compatibility helpers under ./compat and exposes provider internals through the documented ./api/* export map instead of the previous root-level openai-completions subpath.
*/
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { customProviderRegistryKey, type CustomProvider } from "@fusion/core";
import { createInMemoryModelRegistry, warmSharedModelRuntime } from "./_model-runtime-fixture.js";

function createSseResponse(): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hello from mock transport\"},\"finish_reason\":null}]}\n\n"));
      controller.enqueue(new TextEncoder().encode("data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n"));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}


beforeAll(async () => {
  await warmSharedModelRuntime();
});

describe("custom providers openai-completions regression", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("registers under slug key and completes a chat round-trip", async () => {
    const modelRegistry = await createInMemoryModelRegistry();
    const providers: CustomProvider[] = [{
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "My AI Provider",
      apiType: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKey: "CUSTOM_KEY",
      models: [{ id: "my-model", name: "My Model" }],
    }];

    const provider = providers[0]!;
    modelRegistry.registerProvider(customProviderRegistryKey(provider, providers), {
      baseUrl: provider.baseUrl,
      api: "openai-completions",
      apiKey: provider.apiKey,
      models: [{ id: "my-model", name: "My Model", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 }],
    });
    await modelRegistry.refresh();

    const registered = modelRegistry.getAll().find((model) => model.id === "my-model");
    expect(registered?.provider).toBe("my-ai-provider");

    vi.stubGlobal("fetch", vi.fn(async () => createSseResponse()));
    const model = modelRegistry.find("my-ai-provider", "my-model");
    const response = await completeSimple(model!, { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] });
    expect(response.role).toBe("assistant");
  });

  /*
  FNXC:TranscriptContextShape 2026-09-25-20:30:
  `TranscriptContext` no longer carries a `systemPrompt` field — it is `{ messages }` only (pi-ai
  `types.d.ts`), and the instruction is carried as a `system`-role MESSAGE. The two cases below
  passed `{ systemPrompt, messages: [] }`, so the instruction was dropped before `convertMessages`
  ever saw it and `params` came back empty: both rows were asserting on an API shape that no longer
  exists rather than on the role-selection behaviour they exist to pin.

  The behaviour under test is real and worth keeping — `instructionRole` is
  `model.reasoning && compat.supportsDeveloperRole ? "developer" : "system"` — so the instruction is
  now supplied the way the product actually supplies it, and both role outcomes are still proven.
  */
  const instructionContext = () => ({
    messages: [{ role: "system", content: "system instruction", timestamp: Date.now() }],
  }) as never;

  it("uses system role when reasoning model explicitly disables developer role compat", () => {
    const params = convertMessages(
      { provider: "openai", reasoning: true, input: ["text"] } as never,
      instructionContext(),
      { supportsDeveloperRole: false } as never,
    );
    expect(params[0]?.role).toBe("system");
  });

  it("emits developer role when compat allows it on reasoning models", () => {
    const params = convertMessages(
      { provider: "openai", reasoning: true, input: ["text"] } as never,
      instructionContext(),
      { supportsDeveloperRole: true } as never,
    );
    expect(params[0]?.role).toBe("developer");
  });
});
