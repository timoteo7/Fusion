import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunnyCatalog } from "./fixtures/openrouter-bunny.js";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => bunnyCatalog }));
});
afterEach(() => vi.unstubAllGlobals());

async function registry() {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  return { runtime, models: new ModelRegistry(runtime) };
}

describe("OpenRouter catalog with real SDK 0.86.1", () => {
  it("automatically adds Bunny to independent runtimes, retaining the full catalog and native session metadata", async () => {
    const { hydrateOpenRouterModel } = await import("../auth/openrouter-catalog.js");
    const { runtime, models } = await registry();
    const prior = models.getAll().filter((model) => model.provider === "openrouter");
    expect(models.find("openrouter", bunnyCatalog.data[0].id)).toBeUndefined();
    const model = await hydrateOpenRouterModel(models, bunnyCatalog.data[0].id);
    expect(model).toMatchObject({ id: bunnyCatalog.data[0].id, api: "openai-completions", reasoning: true, maxTokens: 524_288, contextWindow: 1_000_000 });
    expect(models.getAll().filter((entry) => entry.provider === "openrouter")).toHaveLength(prior.length + 1);
    expect(models.find("openrouter", prior[0].id)).toEqual(prior[0]);
    const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.cwd(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: process.cwd(), modelRuntime: runtime, model, resourceLoader: loader, tools: [], sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
    try {
      expect(session.model).toEqual(model);
      const second = await registry();
      vi.mocked(fetch).mockRejectedValue(new Error("offline"));
      expect(await hydrateOpenRouterModel(second.models, bunnyCatalog.data[0].id)).toEqual(model);
      expect(fetch).toHaveBeenCalledOnce();
    } finally { session.dispose(); }
  });

  it("preserves provider account auth/headers and explicit routing policy during additive registration", async () => {
    const { hydrateOpenRouterModel, openRouterHydrationPolicy } = await import("../auth/openrouter-catalog.js");
    const { runtime, models } = await registry();
    const original = models.getAll().find((model) => model.provider === "openrouter")!;
    const config = {
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "test-placeholder-only",
      headers: { "HTTP-Referer": "https://example.test", "X-Title": "Test app", "X-Account-Policy": "test" },
      compat: { openRouterRouting: { only: ["test-route"], allow_fallbacks: false } },
      models: [{ ...original, headers: { "X-Model-Policy": "test-model" }, compat: { openRouterRouting: { only: ["original-route"] } } }],
    };
    models.registerProvider("openrouter", config);
    const oldAuth = await runtime.getAuth(models.find("openrouter", original.id)!);
    const policy = openRouterHydrationPolicy({
      openrouterAppAttribution: { referer: "https://selected.example.test", title: "Selected app" },
      openrouterProviderPreferences: { only: ["settings-route"], allow_fallbacks: false },
    }, {});
    const bunny = await hydrateOpenRouterModel(models, bunnyCatalog.data[0].id, policy);
    expect(bunny?.compat).toEqual(config.compat);
    expect(models.find("openrouter", original.id)?.compat).toEqual(config.models[0].compat);
    expect(models.getRegisteredProviderConfig("openrouter")).toMatchObject({ apiKey: config.apiKey, headers: config.headers, baseUrl: config.baseUrl });
    const newAuth = await runtime.getAuth(bunny!);
    expect(newAuth?.auth).toMatchObject({ apiKey: config.apiKey, headers: { ...config.headers, ...policy.headers } });
    expect((await runtime.getAuth(models.find("openrouter", original.id)!))?.auth).toEqual(oldAuth?.auth);
    for (const reasoning of [undefined, "minimal", "xhigh"] as const) {
      let payload: any;
      const result = await runtime.completeSimple(bunny!, { messages: [{ role: "user", content: "Test request shape only", timestamp: 0 }] }, {
        ...(reasoning ? { reasoning } : {}),
        onPayload: (body) => { payload = body; throw new Error("Stop before provider request"); },
      });
      expect(result.stopReason).toBe("error");
      expect(payload.model).toBe(bunnyCatalog.data[0].id);
      expect(payload.provider).toEqual(config.compat.openRouterRouting);
      if (!reasoning) expect(payload).not.toHaveProperty("reasoning");
      else expect(payload.reasoning.effort).toBe(reasoning === "minimal" ? "low" : "xhigh");
    }
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("applies explicit settings routing and attribution to a discovered SDK model without changing account credentials", async () => {
    const { hydrateOpenRouterModel, openRouterHydrationPolicy } = await import("../auth/openrouter-catalog.js");
    const { runtime, models } = await registry();
    models.registerProvider("openrouter", { apiKey: "test-placeholder-only", headers: { "X-Account-Policy": "keep" } });
    const policy = openRouterHydrationPolicy({ openrouterProviderPreferences: { only: ["settings-route"], allow_fallbacks: false }, openrouterAppAttribution: { referer: "https://app.example.test", title: "My app" } }, {});
    const bunny = await hydrateOpenRouterModel(models, bunnyCatalog.data[0].id, policy);
    expect(bunny?.compat).toEqual(policy.compat);
    expect((await runtime.getAuth(bunny!))?.auth).toMatchObject({ apiKey: "test-placeholder-only", headers: { "X-Account-Policy": "keep", ...policy.headers } });
    let payload: any;
    await runtime.completeSimple(bunny!, { messages: [] }, { onPayload: (body) => { payload = body; throw new Error("Stop before provider request"); } });
    expect(payload.provider).toEqual({ only: ["settings-route"], allow_fallbacks: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not hydrate a missing id on a custom endpoint, but exact custom definitions stay first and offline", async () => {
    const { hydrateOpenRouterModel } = await import("../auth/openrouter-catalog.js");
    const { models } = await registry();
    const original = models.getAll().find((model) => model.provider === "openrouter")!;
    models.registerProvider("openrouter", { baseUrl: "https://custom.example.test/v1", models: [{ ...original, baseUrl: "https://custom.example.test/v1" }] });
    const exact = models.find("openrouter", original.id);
    const registration = vi.spyOn(models, "registerProvider");
    expect(await hydrateOpenRouterModel(models, original.id)).toStrictEqual(exact);
    expect(await hydrateOpenRouterModel(models, bunnyCatalog.data[0].id)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(models.find("openrouter", original.id)).toStrictEqual(exact);
    expect(registration).not.toHaveBeenCalled();
  });

  it("fences models.json custom endpoints through the real effective SDK provider without a catalog fetch", async () => {
    const { hydrateOpenRouterModel, openRouterHydrationPolicy } = await import("../auth/openrouter-catalog.js");
    const directory = mkdtempSync(join(tmpdir(), "fusion-openrouter-models-test-"));
    const configuration = { providers: { openrouter: { baseUrl: "https://models-json.example.test/v1", apiKey: "test-placeholder-only" } } };
    const modelsPath = join(directory, "models.json");
    writeFileSync(modelsPath, JSON.stringify(configuration));
    try {
      const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath, allowModelNetwork: false, refreshOnCreate: false });
      const models = new ModelRegistry(runtime);
      expect(models.getProvider("openrouter")?.baseUrl).toBe(configuration.providers.openrouter.baseUrl);
      expect(await hydrateOpenRouterModel(models, bunnyCatalog.data[0].id, openRouterHydrationPolicy({}, configuration))).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects a missing or malformed public row without touching the real provider registration", async () => {
    const { hydrateOpenRouterModel } = await import("../auth/openrouter-catalog.js");
    const { models } = await registry();
    const prior = models.getAll();
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ data: [{ ...bunnyCatalog.data[0], top_provider: {} }] }) } as Response);
    expect(await hydrateOpenRouterModel(models, bunnyCatalog.data[0].id)).toBeUndefined();
    expect(await hydrateOpenRouterModel(models, "not-in-public-catalog")).toBeUndefined();
    expect(models.getAll()).toEqual(prior);
    expect(models.getRegisteredProviderConfig("openrouter")).toBeUndefined();
  });
});
