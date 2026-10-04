import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bunnyCatalog } from "./fixtures/openrouter-bunny.js";

beforeEach(() => vi.resetModules());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("OpenRouter authoritative public metadata", () => {
  it("uses exact output cap and parameter-based reasoning, not name or context", async () => {
    const { toOpenRouterCatalogModels } = await import("../auth/openrouter-catalog.js");
    expect(toOpenRouterCatalogModels(bunnyCatalog)[0]).toMatchObject({
      api: "openai-completions", reasoning: true, maxTokens: 524_288,
      contextWindow: 1_000_000, input: ["text", "image"],
      thinkingLevelMap: { off: null, minimal: "low" },
    });
    const nonReasoning = structuredClone(bunnyCatalog);
    nonReasoning.data[0].name = "Thinking Reasoner R1";
    nonReasoning.data[0].supported_parameters = ["tools"];
    expect(toOpenRouterCatalogModels(nonReasoning)[0].reasoning).toBe(false);
  });

  it.each([undefined, null, 0, -1, NaN, Infinity, "524288", 1.5])("rejects output cap %s rather than deriving it from context", async (cap) => {
    const { toOpenRouterCatalogModels } = await import("../auth/openrouter-catalog.js");
    const malformed = structuredClone(bunnyCatalog) as any;
    malformed.data[0].top_provider.max_completion_tokens = cap;
    expect(toOpenRouterCatalogModels(malformed)).toEqual([]);
  });

  it.each(["context_length", "architecture", "pricing", "supported_parameters"])("rejects malformed %s", async (field) => {
    const { toOpenRouterCatalogModels } = await import("../auth/openrouter-catalog.js");
    const malformed = structuredClone(bunnyCatalog) as any;
    malformed.data[0][field] = null;
    expect(toOpenRouterCatalogModels(malformed)).toEqual([]);
  });

  it("shares one request and reuses public metadata offline across callers", async () => {
    const { getOpenRouterCatalog } = await import("../auth/openrouter-catalog.js");
    let release!: (response: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const first = getOpenRouterCatalog();
    const second = getOpenRouterCatalog();
    expect(first).toBe(second);
    await Promise.resolve();
    release({ ok: true, json: async () => bunnyCatalog });
    const models = await first;
    expect(await second).toEqual(models);
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await getOpenRouterCatalog()).toEqual(models);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  });

  it("bounds a hung request, owns abort and suppresses late publication/overlapping retry", async () => {
    vi.useFakeTimers();
    const { getOpenRouterCatalog, OPENROUTER_CATALOG_TIMEOUT_MS } = await import("../auth/openrouter-catalog.js");
    let release!: (response: unknown) => void;
    const fetchMock = vi.fn((_url: string, _options: RequestInit) => new Promise((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = getOpenRouterCatalog().catch((error: unknown) => error);
    await Promise.resolve();
    const signal = fetchMock.mock.calls[0][1].signal;
    await vi.advanceTimersByTimeAsync(OPENROUTER_CATALOG_TIMEOUT_MS);
    expect(await pending).toMatchObject({ message: expect.stringContaining("timed out") });
    expect(signal?.aborted).toBe(true);
    await expect(getOpenRouterCatalog()).rejects.toThrow("timed out");
    expect(fetchMock).toHaveBeenCalledOnce();
    release({ ok: true, json: async () => bunnyCatalog });
    await vi.runAllTimersAsync();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    expect(await getOpenRouterCatalog()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });


  it("refreshes expired metadata and discovers a new selected id once without a stampede", async () => {
    vi.useFakeTimers();
    const { getOpenRouterCatalog, OPENROUTER_CATALOG_TTL_MS } = await import("../auth/openrouter-catalog.js");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => bunnyCatalog });
    vi.stubGlobal("fetch", fetchMock);
    await getOpenRouterCatalog("stealth/space-bunny-alpha");
    await getOpenRouterCatalog("stealth/space-bunny-alpha");
    expect(fetchMock).toHaveBeenCalledOnce();
    const newCatalog = structuredClone(bunnyCatalog);
    newCatalog.data.push({ ...newCatalog.data[0], id: "stealth/newly-published-model" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => newCatalog });
    const [first, second] = await Promise.all([getOpenRouterCatalog("stealth/newly-published-model"), getOpenRouterCatalog("stealth/newly-published-model")]);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "stealth/newly-published-model")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await getOpenRouterCatalog("still-missing");
    await getOpenRouterCatalog("still-missing");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(OPENROUTER_CATALOG_TTL_MS);
    await Promise.all([getOpenRouterCatalog("stealth/space-bunny-alpha"), getOpenRouterCatalog("stealth/space-bunny-alpha")]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retains alternating confirmed missing ids within TTL, removes newly present ids, and clears misses on expiry", async () => {
    vi.useFakeTimers();
    const { getOpenRouterCatalog, OPENROUTER_CATALOG_TTL_MS } = await import("../auth/openrouter-catalog.js");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => bunnyCatalog });
    vi.stubGlobal("fetch", fetchMock);
    await getOpenRouterCatalog("stealth/space-bunny-alpha");
    await getOpenRouterCatalog("missing-A");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await getOpenRouterCatalog("missing-B");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await getOpenRouterCatalog("missing-A");
    await getOpenRouterCatalog("missing-B");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const published = structuredClone(bunnyCatalog);
    published.data.push({ ...published.data[0], id: "missing-A" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => published });
    await getOpenRouterCatalog("missing-C");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((await getOpenRouterCatalog("missing-A")).some((model) => model.id === "missing-A")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // If the published id disappears later, its earlier negative must not
    // suppress a fresh discovery while other confirmed misses remain cached.
    fetchMock.mockResolvedValue({ ok: true, json: async () => bunnyCatalog });
    await getOpenRouterCatalog("missing-D");
    await getOpenRouterCatalog("missing-A");
    expect(fetchMock).toHaveBeenCalledTimes(6);
    await getOpenRouterCatalog("missing-B");
    expect(fetchMock).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(OPENROUTER_CATALOG_TTL_MS);
    await getOpenRouterCatalog("missing-B");
    expect(fetchMock).toHaveBeenCalledTimes(7);
    await getOpenRouterCatalog("missing-B");
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("fences effective registered endpoint overrides even when the provider reports its static official endpoint", async () => {
    const { hydrateOpenRouterModel } = await import("../auth/openrouter-catalog.js");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const registry = {
      find: () => undefined,
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => ({ baseUrl: "https://custom.example.test/v1" }),
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
    };
    expect(await hydrateOpenRouterModel(registry as any, "stealth/space-bunny-alpha")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allowlists explicit settings routing/attribution and models.json policy without copying auth", async () => {
    const { openRouterHydrationPolicy } = await import("../auth/openrouter-catalog.js");
    expect(openRouterHydrationPolicy({}, {})).toEqual({});
    expect(openRouterHydrationPolicy({ openrouterAppAttribution: { referer: "https://app.example.test", title: "My app" }, openrouterProviderPreferences: { only: ["settings-route"], allow_fallbacks: false }, unrelated: "ignored" }, { providers: { openrouter: { apiKey: "DO-NOT-COPY", baseUrl: "https://custom.example.test/v1", compat: { openRouterRouting: { only: ["models-route"] } } } } })).toEqual({
      baseUrl: "https://custom.example.test/v1", headers: { "HTTP-Referer": "https://app.example.test", "X-Title": "My app" },
      compat: { openRouterRouting: { only: ["models-route"] } },
    });
  });

  it("handles fetch failure without exposing details and retries after settlement", async () => {
    const { getOpenRouterCatalog } = await import("../auth/openrouter-catalog.js");
    const fetchMock = vi.fn().mockRejectedValue(new Error("private config details"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getOpenRouterCatalog()).rejects.toThrow(/^OpenRouter public model catalog discovery failed$/);
    fetchMock.mockResolvedValue({ ok: false });
    await expect(getOpenRouterCatalog()).rejects.toThrow("discovery failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
