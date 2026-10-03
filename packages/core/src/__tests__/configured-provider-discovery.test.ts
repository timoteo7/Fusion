import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addToggleConfiguredProviders,
  discoverConfiguredProviders,
  type ConfiguredProviderAuthStorageLike,
  type ConfiguredProviderToggleFlags,
} from "../ai/configured-provider-discovery.js";

/*
FNXC:ConfiguredProviderDiscovery 2026-09-30-19:10:
FUSI-024 coverage for the shared configured-provider gate. Two things are being pinned:

1. Discovery's credential sources, one case per source. A hidden `home` is injected so no test ever
   reads the developer's real ~/.fusion or ~/.pi — the legacy path scan is the reason `home` is a
   parameter in the first place.
2. The toggle/custom-provider additions, asserted SEPARATELY from discovery. Keeping them apart
   matters: a caller that only wants "what have I authenticated?" must not inherit CLI-toggled
   providers, so the additive helper's output is checked on its own.

No case asserts anything about a secret's VALUE — the raw-credential predicate must be a shape
test, and a test that read the key back would be a place for a leak to hide.
*/

const tempHomes: string[] = [];

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "fusi-024-home-"));
  tempHomes.push(home);
  return home;
}

/** Write a Fusion-primary auth.json under the given home. */
async function writeFusionAuth(home: string, contents: Record<string, unknown>): Promise<void> {
  const dir = join(home, ".fusion", "agent");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "auth.json"), JSON.stringify(contents), "utf-8");
}

/** Write a legacy .pi/auth.json under the given home. */
async function writeLegacyPiAuth(home: string, contents: Record<string, unknown>): Promise<void> {
  const dir = join(home, ".pi");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "auth.json"), JSON.stringify(contents), "utf-8");
}

/** Write a Fusion-primary models.json under the given home. */
async function writeFusionModels(home: string, contents: unknown): Promise<void> {
  const dir = join(home, ".fusion", "agent");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "models.json"), JSON.stringify(contents), "utf-8");
}

afterEach(async () => {
  for (const home of tempHomes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
  delete process.env.ANTHROPIC_API_KEY;
});

describe("discoverConfiguredProviders", () => {
  it("returns an empty set when no credentials exist anywhere", async () => {
    const home = await makeHome();
    expect(await discoverConfiguredProviders(undefined, home)).toEqual(new Set());
  });

  it("advertises an auth-storage OAuth provider that reports usable auth", async () => {
    const home = await makeHome();
    const authStorage: ConfiguredProviderAuthStorageLike = {
      getOAuthProviders: () => [{ id: "github-copilot" }],
      hasAuth: (provider) => provider === "github-copilot",
    };

    const providers = await discoverConfiguredProviders(authStorage, home);

    expect(providers).toContain("github-copilot");
  });

  it("does not advertise an auth-storage OAuth provider that reports no usable auth", async () => {
    const home = await makeHome();
    const authStorage: ConfiguredProviderAuthStorageLike = {
      getOAuthProviders: () => [{ id: "github-copilot" }],
      hasAuth: () => false,
    };

    const providers = await discoverConfiguredProviders(authStorage, home);

    expect(providers).not.toContain("github-copilot");
  });

  it("advertises the direct anthropic provider for a raw anthropic API-key credential", async () => {
    const home = await makeHome();
    const authStorage: ConfiguredProviderAuthStorageLike = {
      getApiKeyProviders: () => [{ id: "anthropic" }],
      get: () => ({ type: "api_key", key: "sk-ant-test-value" }),
    };

    const providers = await discoverConfiguredProviders(authStorage, home);

    expect(providers).toContain("anthropic");
    // The subscription id is an auth/usage credential id, never its own advertised row.
    expect(providers).not.toContain("anthropic-subscription");
  });

  it("advertises anthropic from hasAuth alone (subscription/legacy OAuth executes on the built-in provider)", async () => {
    const home = await makeHome();
    const authStorage: ConfiguredProviderAuthStorageLike = {
      hasAuth: (provider) => provider === "anthropic-subscription",
    };

    const providers = await discoverConfiguredProviders(authStorage, home);

    expect(providers).toContain("anthropic");
    expect(providers).not.toContain("anthropic-subscription");
  });

  it("advertises anthropic for a legacy .pi auth.json anthropic-subscription row", async () => {
    const home = await makeHome();
    await writeLegacyPiAuth(home, { "anthropic-subscription": { type: "oauth", access: "token" } });

    const providers = await discoverConfiguredProviders(undefined, home);

    expect(providers).toContain("anthropic");
    expect(providers).not.toContain("anthropic-subscription");
  });

  it("advertises anthropic for a raw API key in auth.json but not for an unrecognized credential type", async () => {
    const rawKeyHome = await makeHome();
    await writeFusionAuth(rawKeyHome, { anthropic: { type: "api_key", key: "sk-ant-test" } });
    expect(await discoverConfiguredProviders(undefined, rawKeyHome)).toContain("anthropic");

    const bogusHome = await makeHome();
    await writeFusionAuth(bogusHome, { anthropic: { type: "not-a-real-credential-type" } });
    expect(await discoverConfiguredProviders(undefined, bogusHome)).not.toContain("anthropic");
  });

  it("advertises a models.json provider that carries an inline api key, and skips one that does not", async () => {
    const home = await makeHome();
    await writeFusionModels(home, {
      providers: {
        "my-custom-provider": { apiKey: "secret-value" },
        "unconfigured-provider": { baseUrl: "https://example.test" },
      },
    });

    const providers = await discoverConfiguredProviders(undefined, home);

    expect(providers).toContain("my-custom-provider");
    expect(providers).not.toContain("unconfigured-provider");
  });

  it("advertises anthropic when ANTHROPIC_API_KEY is set in the environment", async () => {
    const home = await makeHome();
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";

    const providers = await discoverConfiguredProviders(undefined, home);

    expect(providers).toContain("anthropic");
  });

  it("degrades to an empty set when an auth file is present but malformed", async () => {
    const home = await makeHome();
    const dir = join(home, ".fusion", "agent");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "auth.json"), "{ not json", "utf-8");

    expect(await discoverConfiguredProviders(undefined, home)).toEqual(new Set());
  });

  it("tolerates a partially-implemented auth storage instead of throwing", async () => {
    const home = await makeHome();
    // Every member is optional; discovery must read "no credential", not blow up.
    expect(await discoverConfiguredProviders({}, home)).toEqual(new Set());
  });
});

describe("addToggleConfiguredProviders", () => {
  it("adds nothing when no toggle is on", () => {
    const providers = addToggleConfiguredProviders(new Set(), {});
    expect(providers).toEqual(new Set());
  });

  it("adds exactly the toggle-derived ids for an all-on flags object", () => {
    const providers = addToggleConfiguredProviders(new Set(), {
      useClaudeCli: true,
      useDroidCli: true,
      useLlamaCpp: true,
      useCursorCli: true,
      useGrokCli: true,
      useAntigravityCli: true,
      useOmpCli: true,
      hermesRowsAdded: true,
    } satisfies ConfiguredProviderToggleFlags);

    expect([...providers].sort()).toEqual([
      "antigravity-cli",
      "claude-cli",
      "cursor-cli",
      "droid-cli",
      "grok-cli",
      "hermes",
      "llama-server",
      "omp-cli",
      "pi-claude-cli",
    ]);
  });

  it("adds both claude-cli ids together, since the toggle governs two provider ids", () => {
    const providers = addToggleConfiguredProviders(new Set(), { useClaudeCli: true });
    expect(providers.has("pi-claude-cli")).toBe(true);
    expect(providers.has("claude-cli")).toBe(true);
  });

  it("does not add hermes without the row signal, since Hermes has no settings toggle", () => {
    expect(addToggleConfiguredProviders(new Set(), { hermesRowsAdded: false }).has("hermes")).toBe(false);
    expect(addToggleConfiguredProviders(new Set(), { hermesRowsAdded: true }).has("hermes")).toBe(true);
  });

  it("is strictly additive: it never removes an id discovery already established", () => {
    const discovered = new Set(["anthropic", "openai"]);
    const result = addToggleConfiguredProviders(discovered, { useOmpCli: true });

    expect(result.has("anthropic")).toBe(true);
    expect(result.has("openai")).toBe(true);
    expect(result.has("omp-cli")).toBe(true);
  });

  it("adds each custom provider under its registry key", () => {
    const providers = addToggleConfiguredProviders(
      new Set(),
      {},
      [{ id: "cp-1", name: "My Local LLM", apiType: "openai-compatible", baseUrl: "http://localhost:1234/v1" }],
    );

    expect(providers.has("my-local-llm")).toBe(true);
  });

  it("disambiguates two custom providers that slugify to the same registry key", () => {
    const providers = addToggleConfiguredProviders(
      new Set(),
      {},
      [
        { id: "cp-1", name: "Local", apiType: "openai-compatible", baseUrl: "http://localhost:1234/v1" },
        { id: "cp-2", name: "Local", apiType: "openai-compatible", baseUrl: "http://localhost:5678/v1" },
      ],
    );

    // Matches customProviderRegistryKey's count-suffix rule rather than collapsing to one id.
    expect([...providers].sort()).toEqual(["local", "local-2"]);
  });
});
