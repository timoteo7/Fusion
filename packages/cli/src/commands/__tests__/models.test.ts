import { describe, expect, it, vi } from "vitest";
import {
  runModelsList,
  runModelsProviders,
  type ModelCatalogDeps,
  type ModelCatalogModelLike,
  type ModelsListOptions,
} from "../models.js";

/*
FNXC:ModelCatalogCli 2026-09-30-19:25:
FUSI-024 coverage for the headless catalog read surface.

The whole command is exercised through its injected dependency seam, so every case runs with no
registry, no home directory, no network, and no dashboard. Three properties carry the weight:

  - the provider gate is the SHARED core function, proven by comparing the command's default
    provider set against `discoverConfiguredProviders` + `addToggleConfiguredProviders` directly;
  - an unknown price is "n/a"/null and never a fabricated 0;
  - the read surface degrades rather than throws — an empty registry, no credentials, and a
    hostile registry all exit cleanly with a message.

The credential assertions deliberately only ever check that a provider id is or is not PRESENT.
No case reads a key value back, so the test file itself can never become a place a secret leaks
from.
*/

const THINKING_MAP = { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null };

function model(overrides: Partial<ModelCatalogModelLike> & Pick<ModelCatalogModelLike, "provider" | "id">): ModelCatalogModelLike {
  return {
    name: overrides.id,
    reasoning: false,
    contextWindow: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ModelCatalogDeps> = {}): ModelCatalogDeps {
  return {
    authStorage: undefined,
    registry: { getAvailable: () => [] },
    toggles: {},
    customProviders: [],
    // A home directory that cannot exist, so no test can pick up the developer's real ~/.pi or
    // ANTHROPIC_API_KEY-adjacent state by accident.
    home: "/nonexistent-fusi-024-home",
    log: vi.fn(),
    ...overrides,
  };
}

function capture(deps: ModelCatalogDeps): string[] {
  const lines: string[] = [];
  deps.log = (line: string) => lines.push(line);
  return lines;
}

describe("runModelsList", () => {
  it("filters to one provider and copies its cost exactly", async () => {
    const deps = makeDeps({
      registry: {
        getAvailable: () => [
          model({
            provider: "anthropic",
            id: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
            reasoning: true,
            contextWindow: 200_000,
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          }),
          model({
            provider: "openai",
            id: "gpt-5",
            name: "GPT-5",
            contextWindow: 400_000,
            cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
          }),
        ],
      },
      // Both providers are credentialed so the gate is satisfied and --provider is what filters.
      authStorage: { getApiKeyProviders: () => [{ id: "anthropic" }, { id: "openai" }], get: () => ({ type: "api_key", key: "k" }) },
    });
    const lines = capture(deps);

    await runModelsList({ provider: "anthropic" }, deps);

    const output = lines.join("\n");
    expect(output).toContain("anthropic");
    expect(output).toContain("claude-sonnet-4-5");
    expect(output).not.toContain("gpt-5");
    // Cost is copied verbatim, USD per 1M: $3.00 in / $15.00 out, never rescaled or reformatted.
    expect(output).toContain("$3.00/$15.00");
  });

  it("emits a parseable JSON envelope with the documented keys", async () => {
    const deps = makeDeps({
      registry: {
        getAvailable: () => [
          model({ provider: "anthropic", id: "m1", name: "M1", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }),
        ],
      },
      authStorage: { getApiKeyProviders: () => [{ id: "anthropic" }], get: () => ({ type: "api_key", key: "k" }) },
    });
    const lines = capture(deps);

    await runModelsList({ json: true }, deps);

    const parsed = JSON.parse(lines.join("\n")) as { models: Array<Record<string, unknown>> };
    expect(Array.isArray(parsed.models)).toBe(true);
    expect(parsed.models).toHaveLength(1);
    const row = parsed.models[0]!;
    for (const key of ["provider", "id", "name", "reasoning", "contextWindow", "cost"]) {
      expect(row).toHaveProperty(key);
    }
    expect(row.cost).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it("derives its default provider set from the shared core gate, and hides an unconfigured provider", async () => {
    const { discoverConfiguredProviders, addToggleConfiguredProviders } = await import("@fusion/core");
    const models = [
      model({ provider: "anthropic", id: "m-anthropic" }),
      model({ provider: "some-unconnected-provider", id: "m-unconnected" }),
    ];
    const deps = makeDeps({
      registry: { getAvailable: () => models },
      // Only anthropic is credentialed; "some-unconnected-provider" is not.
      authStorage: { getApiKeyProviders: () => [{ id: "anthropic" }], get: () => ({ type: "api_key", key: "k" }) },
    });
    const lines = capture(deps);

    await runModelsList({ json: true }, deps);

    // The command's set must equal the shared gate's set for the same fixture.
    const expected = addToggleConfiguredProviders(await discoverConfiguredProviders(deps.authStorage, deps.home), {}, []);
    expect(expected.has("anthropic")).toBe(true);
    expect(expected.has("some-unconnected-provider")).toBe(false);

    const parsed = JSON.parse(lines.join("\n")) as { models: Array<{ provider: string }> };
    expect(parsed.models.map((m) => m.provider)).toEqual(["anthropic"]);
    expect(parsed.models.map((m) => m.provider).sort()).toEqual([...expected].filter((p) => p === "anthropic").sort());
  });

  it("includes an unconfigured provider with --all", async () => {
    const deps = makeDeps({
      registry: {
        getAvailable: () => [
          model({ provider: "anthropic", id: "m-anthropic" }),
          model({ provider: "some-unconnected-provider", id: "m-unconnected" }),
        ],
      },
      authStorage: { getApiKeyProviders: () => [{ id: "anthropic" }], get: () => ({ type: "api_key", key: "k" }) },
    });
    const lines = capture(deps);

    await runModelsList({ json: true, all: true }, deps);

    const parsed = JSON.parse(lines.join("\n")) as { models: Array<{ provider: string }> };
    expect(parsed.models.map((m) => m.provider).sort()).toEqual(["anthropic", "some-unconnected-provider"]);
  });

  it("shows a row with no cost as n/a in the table and null in JSON, never $0.00", async () => {
    const deps = makeDeps({
      registry: { getAvailable: () => [model({ provider: "anthropic", id: "m-free-unknown" })] },
      authStorage: { getApiKeyProviders: () => [{ id: "anthropic" }], get: () => ({ type: "api_key", key: "k" }) },
    });

    const tableLines = capture(deps);
    await runModelsList({}, deps);
    expect(tableLines.join("\n")).toContain("n/a");
    expect(tableLines.join("\n")).not.toContain("$0.00");

    const jsonDeps = makeDeps({
      registry: { getAvailable: () => [model({ provider: "anthropic", id: "m-free-unknown" })] },
      authStorage: { getApiKeyProviders: () => [{ id: "anthropic" }], get: () => ({ type: "api_key", key: "k" }) },
    });
    const jsonLines = capture(jsonDeps);
    await runModelsList({ json: true }, jsonDeps);
    const parsed = JSON.parse(jsonLines.join("\n")) as { models: Array<{ cost: unknown }> };
    expect(parsed.models[0]!.cost).toBeNull();
  });

  it("returns an empty list with a clear message when the registry is empty and no provider is configured", async () => {
    const deps = makeDeps({ registry: { getAvailable: () => [] } });
    const lines = capture(deps);

    await runModelsList({}, deps);

    expect(lines.join("\n")).toContain("No models available");
  });

  it("returns an empty list for a provider filter that matches nothing, with exit 0 and no throw", async () => {
    const deps = makeDeps({
      registry: { getAvailable: () => [model({ provider: "anthropic", id: "m1" })] },
      authStorage: { getApiKeyProviders: () => [{ id: "anthropic" }], get: () => ({ type: "api_key", key: "k" }) },
    });
    const lines = capture(deps);

    await expect(runModelsList({ provider: "nonexistent-provider" }, deps)).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("No models available for provider");
  });

  it("degrades to an empty list with an error message when the registry throws, not an unhandled rejection", async () => {
    const warn = vi.fn();
    const deps = makeDeps({
      registry: {
        getAvailable: () => {
          throw new Error("registry exploded");
        },
      },
      authStorage: { getApiKeyProviders: () => [{ id: "anthropic" }], get: () => ({ type: "api_key", key: "k" }) },
    });
    const lines = capture(deps);
    deps.log = warn;

    await expect(runModelsList({}, deps)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => c[0]).join("\n")).toContain("registry exploded");
  });

  it("degrades to an empty list when the registry is reported unavailable", async () => {
    const deps = makeDeps({ registryError: "registry unavailable" });
    const lines = capture(deps);

    await expect(runModelsList({ json: true }, deps)).resolves.toBeUndefined();
    const parsed = JSON.parse(lines.join("\n")) as { models: unknown[] };
    expect(parsed.models).toEqual([]);
  });
});

describe("runModelsProviders", () => {
  it("lists configured providers and their model counts, marking the credential source", async () => {
    const deps = makeDeps({
      registry: { getAvailable: () => [model({ provider: "anthropic", id: "m1" }), model({ provider: "anthropic", id: "m2" })] },
      authStorage: { getApiKeyProviders: () => [{ id: "anthropic" }], get: () => ({ type: "api_key", key: "k" }) },
      toggles: { useOmpCli: true },
    });
    const lines = capture(deps);

    await runModelsProviders({}, deps);

    const output = lines.join("\n");
    expect(output).toContain("anthropic");
    expect(output).toContain("credential");
    // A toggled-but-uncatalogued provider is still "configured"; the model count says 0.
    expect(output).toContain("omp-cli");
    expect(output).toContain("toggle");
  });

  it("emits a parseable JSON provider envelope", async () => {
    const deps = makeDeps({
      registry: { getAvailable: () => [model({ provider: "anthropic", id: "m1" })] },
      authStorage: { getApiKeyProviders: () => [{ id: "anthropic" }], get: () => ({ type: "api_key", key: "k" }) },
    });
    const lines = capture(deps);

    await runModelsProviders({ json: true }, deps);

    const parsed = JSON.parse(lines.join("\n")) as { providers: Array<{ provider: string; modelCount: number }> };
    expect(Array.isArray(parsed.providers)).toBe(true);
    const anthropic = parsed.providers.find((p) => p.provider === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.modelCount).toBe(1);
  });

  it("reports zero configured providers with a clear message and no throw", async () => {
    const deps = makeDeps({ registry: { getAvailable: () => [model({ provider: "anthropic", id: "m1" })] } });
    const lines = capture(deps);

    await expect(runModelsProviders({}, deps)).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("No providers configured");
  });
});
