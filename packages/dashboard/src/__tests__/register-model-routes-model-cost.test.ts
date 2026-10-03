/*
FNXC:ModelCatalog 2026-09-30-18:45:
FUSI-024 regression coverage: every `/api/models` row must carry a `cost` field so per-model
pricing is readable wherever the catalog is published (this route and the `fn models` CLI).
Registry rows copy pi's price verbatim — USD per 1,000,000 tokens, never rescaled, with
request-wide `tiers` preserved. CLI-picker rows carry no price and must be published as an
explicit `null`, because "price unknown" is a real state that must stay distinguishable from a
genuinely free `0` rate. A missing `modelRegistry` must still return `models: []` without
throwing, and an unpriced registry row is normalized to `null` rather than a fabricated `0`.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";

vi.mock("../runtime-provider-probes.js", () => ({
  listHermesProviderProfiles: vi.fn(),
}));

import { listHermesProviderProfiles } from "../runtime-provider-probes.js";
import { registerModelRoutes } from "../routes/register-model-routes.js";
import { __resetHermesPickerModelsCacheForTests } from "../hermes-model-cache.js";

const mockedList = vi.mocked(listHermesProviderProfiles);

afterEach(() => {
  vi.clearAllMocks();
  __resetHermesPickerModelsCacheForTests();
});

type CatalogRow = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number; inputTokensAbove: number }> } | null;
  supportedThinkingLevels?: string[];
};

function createRouterHarness(models: CatalogRow[], settings: Record<string, unknown> = {}) {
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
    post: vi.fn(),
  } as unknown as Router;

  const store = {
    getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue(settings) }),
    getSettingsFast: vi.fn().mockResolvedValue(settings),
  };

  const modelRegistry = {
    refresh: vi.fn(async () => undefined),
    getAvailable: vi.fn(() => models),
  };

  const runtimeLogger = { child: vi.fn(() => ({ warn: vi.fn() })) };

  // FNXC:ModelCatalog 2026-09-30-18:45: advertise every provider present in the fixture as
  // api-key configured so the configured-provider gate is satisfied without touching real auth
  // storage or the developer's home directory.
  const authStorage = {
    reload: vi.fn(),
    getOAuthProviders: vi.fn(() => []),
    getApiKeyProviders: vi.fn(() => Array.from(new Set(models.map(({ provider }) => provider))).map((id) => ({ id }))),
    get: vi.fn(() => ({ type: "api_key", key: "test-key" })),
    hasApiKey: vi.fn(() => true),
  };

  registerModelRoutes({
    router,
    store: store as never,
    runtimeLogger: runtimeLogger as never,
    options: { modelRegistry: modelRegistry as never, authStorage: authStorage as never },
  } as never);

  return getHandlers.get("/models")!;
}

async function fetchModels(models: CatalogRow[], settings: Record<string, unknown> = {}): Promise<Array<CatalogRow & { cost: unknown }>> {
  const handler = createRouterHarness(models, settings);
  const json = vi.fn();
  await handler({}, { json });
  const response = json.mock.calls[0]![0] as { models: Array<CatalogRow & { cost: unknown }> };
  return response.models;
}

describe("/api/models carries a per-model cost", () => {
  it("copies the registry's four price numbers onto the row verbatim (USD per 1M, never rescaled)", async () => {
    const models = await fetchModels([
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        reasoning: true,
        contextWindow: 200_000,
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
    ]);

    expect(models).toHaveLength(1);
    expect(models[0]!.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });

  it("publishes an explicit null cost for a CLI-picker row that has no price", async () => {
    // A Hermes profile surfaces a picker row through the CLI-probe boundary. Picker rows are
    // built by the dashboard's *-model-cache modules and carry no price at all, so this is the
    // "no price known" row family that must publish `cost: null` rather than a fabricated 0.
    mockedList.mockResolvedValue([{ name: "default", model: "MiniMax-M3", isDefault: true }]);

    const models = await fetchModels([
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        reasoning: true,
        contextWindow: 200_000,
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
    ]);

    const hermesRow = models.find((m) => m.provider === "hermes");
    expect(hermesRow, "expected the Hermes picker to contribute a row").toBeDefined();
    // The key is present and explicitly null — not absent, and not a fabricated 0.
    expect(hermesRow).toHaveProperty("cost");
    expect(hermesRow!.cost).toBeNull();
    expect(hermesRow!.cost).not.toBe(0);

    // The registry-sourced row keeps its real price alongside the unpriced picker row.
    const registryRow = models.find((m) => m.provider === "anthropic")!;
    expect(registryRow.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });

  it("preserves request-wide pricing tiers on a tiered model", async () => {
    const models = await fetchModels([
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        reasoning: true,
        contextWindow: 200_000,
        cost: {
          input: 3,
          output: 15,
          cacheRead: 0.3,
          cacheWrite: 3.75,
          tiers: [
            { input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5, inputTokensAbove: 200_000 },
          ],
        },
      },
    ]);

    const cost = models[0]!.cost as { tiers?: unknown[] };
    expect(Array.isArray(cost.tiers)).toBe(true);
    expect(cost.tiers).toHaveLength(1);
  });

  it("normalizes a registry row that has no price to null rather than a fabricated 0", async () => {
    const models = await fetchModels([
      { provider: "anthropic", id: "mystery-model", name: "Mystery", reasoning: false, contextWindow: 8_000 },
    ]);

    expect(models[0]!.cost).toBeNull();
    // A fabricated free price would be indistinguishable from a real $0 rate; assert it is not 0.
    expect(models[0]!.cost).not.toBe(0);
  });

  it("returns models: [] without throwing when no modelRegistry is configured", async () => {
    const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
    const router = {
      get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
        getHandlers.set(path, handler);
      }),
      post: vi.fn(),
    } as unknown as Router;

    registerModelRoutes({
      router,
      store: {
        getGlobalSettingsStore: () => ({ getSettings: vi.fn().mockResolvedValue({}) }),
        getSettingsFast: vi.fn().mockResolvedValue({}),
      } as never,
      runtimeLogger: { child: vi.fn(() => ({ warn: vi.fn() })) } as never,
      options: {},
    } as never);

    const json = vi.fn();
    await getHandlers.get("/models")!({}, { json });

    expect((json.mock.calls[0]![0] as { models: unknown[] }).models).toEqual([]);
  });
});
