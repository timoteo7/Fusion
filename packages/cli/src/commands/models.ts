import {
  addToggleConfiguredProviders,
  discoverConfiguredProviders,
  THINKING_LEVELS,
  type CustomProvider,
  type ThinkingLevel,
} from "@fusion/core";
import { createFusionAuthStorage, createFusionModelRegistry, refreshFusionModelRegistry } from "@fusion/engine";
import { wrapAuthStorageWithApiKeyProviders } from "./provider-auth.js";
import { getPackageManagerAgentDir } from "./auth-paths.js";
import { createReadOnlyProviderSettingsView } from "./provider-settings.js";

/*
FNXC:ModelCatalogCli 2026-09-30-19:25:
FUSI-024: the headless read surface for the model catalog.

Before this command the ONLY way to see the catalog was the dashboard's authenticated
`GET /api/models`, so a headless install could not answer the one question an operator or a script
actually has: "does the catalog I declared match the one I can really use?" The command therefore
runs with no dashboard process and no bearer token, and it opens no store and starts no server.

Three rules are load-bearing and each is a correctness requirement, not a style choice:

1. THE GATE IS SHARED, NOT REIMPLEMENTED. The provider filter is `discoverConfiguredProviders` +
   `addToggleConfiguredProviders` imported from `@fusion/core` — the same functions the dashboard
   route calls. A list advertising an unconnected provider is worse than no list, and a second
   implementation would drift silently. `--all` is the explicit opt-out, not the default.

2. NEVER PRINT CREDENTIAL MATERIAL. The command prints only model-catalog facts (provider, model
   id, name, context window, capability, price). It reads credentials solely to answer "is this
   provider connected?" and never renders a key, a token, or an auth-file body. The table has no
   column that could hold one.

3. NEVER FABRICATE A PRICE. A registry row without a cost prints "n/a" in the table and `null` in
   JSON. Substituting `0` would render an unknown price as a free model, which is a different and
   materially wrong claim. The cost values themselves are copied verbatim — USD per 1,000,000
   tokens — and never rescaled.

Cost units: USD per 1,000,000 tokens, matching pi-ai's ModelCost.
*/

// ── Types ────────────────────────────────────────────────────────────────────

/** Per-model price in USD per 1,000,000 tokens; `null` means no price is known. */
export interface ModelCostView {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: ModelCostView[];
}

/** One catalog row as published by the CLI. */
export interface ModelCatalogRow {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  supportedThinkingLevels?: readonly ThinkingLevel[];
  /** `null` means "no price known" — never a fabricated `0`. */
  cost: ModelCostView | null;
}

/** Minimal pi model shape the CLI reads. Kept structural so a fake registry satisfies it. */
export interface ModelCatalogModelLike {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  cost?: ModelCostView;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

/** Minimal registry surface the CLI reads. */
export interface ModelCatalogRegistryLike {
  getAvailable(): ModelCatalogModelLike[];
}

/**
 * FNXC:ModelCatalogCli 2026-09-30-19:25:
 * The credential surface is passed in already wrapped by the caller, exactly as the dashboard
 * wraps it. Injecting it (rather than constructing it here) keeps this module free of engine
 * imports, which is what makes the command unit-testable against a fake.
 */
export interface ModelCatalogAuthStorageLike {
  reload?(): void;
  getOAuthProviders?(): Array<{ id: string; name?: string }>;
  hasAuth?(provider: string): boolean;
  getApiKeyProviders?(): Array<{ id: string; name?: string }>;
  hasApiKey?(provider: string): boolean;
  get?(provider: string): { type?: unknown; key?: unknown } | null | undefined;
}

export interface ModelCatalogToggles {
  useClaudeCli?: boolean;
  useDroidCli?: boolean;
  useLlamaCpp?: boolean;
  useCursorCli?: boolean;
  useGrokCli?: boolean;
  useAntigravityCli?: boolean;
  useOmpCli?: boolean;
}

export interface ModelsListOptions {
  json?: boolean;
  provider?: string;
  /** Bypass the configured-provider gate and list every provider the registry knows. */
  all?: boolean;
}

/**
 * FNXC:ModelCatalogCli 2026-09-30-19:25:
 * Everything the command touches is injected through this seam. The production path fills it from
 * the engine factories; a test fills it with fakes. The command itself contains no I/O beyond the
 * console it is handed, which is why the provider-gate, filtering, and formatting behavior can all
 * be asserted without a registry, a home directory, or a network.
 */
export interface ModelCatalogDeps {
  authStorage: ModelCatalogAuthStorageLike | undefined;
  registry: ModelCatalogRegistryLike;
  toggles: ModelCatalogToggles;
  customProviders: CustomProvider[];
  /** Home directory scanned by credential discovery. */
  home?: string;
  /** Set when Hermes discovery contributed rows; the one non-toggle signal in the gate. */
  hermesRowsAdded?: boolean;
  log?: (line: string) => void;
  /** Reported when the registry could not be read. The command degrades to an empty list. */
  registryError?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function deriveThinkingLevels(model: ModelCatalogModelLike): readonly ThinkingLevel[] | undefined {
  if (!model.thinkingLevelMap || typeof model.thinkingLevelMap !== "object") return undefined;
  // A model whose thinkingLevelMap marks a level `null` does not support it. An absent map would
  // mean "capability unknown", which is why an absent map returns undefined rather than every level.
  return THINKING_LEVELS.filter((level) => model.thinkingLevelMap![level] !== null);
}

function toCatalogRow(model: ModelCatalogModelLike): ModelCatalogRow {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    supportedThinkingLevels: deriveThinkingLevels(model),
    // Copy verbatim, never rescale. A row with no price keeps `null`, never 0.
    cost: model.cost ?? null,
  };
}

const RESET = "\x1b[0m";
const GRAY = "\x1b[90m";
const BOLD = "\x1b[1m";

function formatPrice(cost: ModelCostView | null): string {
  // "n/a" is the honest rendering of an unknown price. "$0.00" would claim the model is free.
  if (!cost) return "n/a";
  const fmt = (n: number): string => (Number.isFinite(n) ? `$${n.toFixed(2)}` : "n/a");
  return `${fmt(cost.input)}/${fmt(cost.output)}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function renderTable(rows: ModelCatalogRow[]): string {
  const headers = ["PROVIDER", "MODEL ID", "NAME", "CONTEXT", "REASONING", "THINKING", "COST IN/OUT (per 1M)"];
  const body = rows.map((row) => [
    row.provider,
    row.id,
    row.name,
    row.contextWindow > 0 ? String(row.contextWindow) : "n/a",
    row.reasoning ? "yes" : "no",
    row.supportedThinkingLevels ? row.supportedThinkingLevels.join(",") || "none" : "n/a",
    formatPrice(row.cost),
  ]);
  const widths = headers.map((header, i) => Math.max(header.length, ...body.map((cells) => (cells[i] ?? "").length)));
  const line = (cells: string[]): string =>
    cells.map((cell, i) => pad(cell, widths[i]!)).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

async function readRows(deps: ModelCatalogDeps): Promise<ModelCatalogRow[]> {
  if (deps.registryError) return [];
  try {
    return deps.registry.getAvailable().map(toCatalogRow);
  } catch (error: unknown) {
    // A hostile registry must degrade to an empty catalog with a message, never an unhandled
    // rejection: a read-only inspection command has no reason to fail the shell over a registry.
    deps.log?.(`Warning: could not read the model registry: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function selectRows(deps: ModelCatalogDeps, options: ModelsListOptions): Promise<ModelCatalogRow[]> {
  const rows = await readRows(deps);
  let filtered = rows;

  if (!options.all) {
    // The SAME gate the dashboard route applies. See rule 1 in the file header.
    const configured = addToggleConfiguredProviders(
      await discoverConfiguredProviders(deps.authStorage, deps.home),
      { ...deps.toggles, hermesRowsAdded: deps.hermesRowsAdded },
      deps.customProviders,
    );
    filtered = filtered.filter((row) => configured.has(row.provider));
  }

  if (options.provider) {
    filtered = filtered.filter((row) => row.provider === options.provider);
  }

  return filtered;
}

// ── Commands ─────────────────────────────────────────────────────────────────

/**
 * `fn models list` (bare `fn models` is the same command).
 *
 * FNXC:ModelCatalogCli 2026-09-30-19:25:
 * Read-only: opens no store, writes nothing, starts no server, and touches no credential value.
 */
export async function runModelsList(options: ModelsListOptions, deps: ModelCatalogDeps): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const rows = await selectRows(deps, options);

  if (options.json) {
    // A stable machine envelope: `models` is always present and always an array, so a consumer can
    // iterate without a null check even when nothing is configured.
    log(JSON.stringify({ models: rows }, null, 2));
    return;
  }

  if (rows.length === 0) {
    log(options.provider
      ? `No models available for provider "${options.provider}".`
      : "No models available. Connect a provider (fn auth login) or enable a provider toggle in Settings.");
    return;
  }

  log(renderTable(rows));
}

// ── Providers ────────────────────────────────────────────────────────────────

export interface ModelsProvidersOptions {
  json?: boolean;
}

/**
 * `fn models providers` — the connected-provider set, and how many models each exposes.
 *
 * FNXC:ModelCatalogCli 2026-09-30-19:25:
 * Reports the gate's own view, so an operator can see exactly WHY a provider is or is not listed
 * and diagnose a "why is my model missing" question without starting the dashboard.
 */
export async function runModelsProviders(options: ModelsProvidersOptions, deps: ModelCatalogDeps): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));

  // The credential-derived set on its own, before toggles: this is the "did I authenticate?" view.
  const discovered = await discoverConfiguredProviders(deps.authStorage, deps.home);
  const configured = addToggleConfiguredProviders(
    new Set(discovered),
    { ...deps.toggles, hermesRowsAdded: deps.hermesRowsAdded },
    deps.customProviders,
  );
  const rows = await readRows(deps);

  const providers = [...configured].sort().map((provider) => {
    const modelCount = rows.filter((row) => row.provider === provider).length;
    return {
      provider,
      configured: true,
      source: discovered.has(provider) ? "credential" : "toggle",
      modelCount,
    };
  });

  if (options.json) {
    log(JSON.stringify({ providers }, null, 2));
    return;
  }

  if (providers.length === 0) {
    log("No providers configured. Run `fn auth login` to connect one.");
    return;
  }

  const headers = ["PROVIDER", "SOURCE", "MODELS"];
  const body = providers.map((p) => [p.provider, p.source, p.modelCount === 0 ? "0 (none in catalog)" : String(p.modelCount)]);
  const widths = headers.map((header, i) => Math.max(header.length, ...body.map((cells) => (cells[i] ?? "").length)));
  const line = (cells: string[]): string => cells.map((cell, i) => pad(cell, widths[i]!)).join("  ").trimEnd();

  log([
    `${BOLD}Configured providers${RESET}`,
    line(headers),
    line(widths.map((w) => "-".repeat(w))),
    ...body.map(line),
    "",
    `${GRAY}Providers are listed from your credentials and enabled provider toggles. Use --all on \`fn models list\` to include every provider in the catalog.${RESET}`,
  ].join("\n"));
}

// ── Production wiring ────────────────────────────────────────────────────────

/*
FNXC:ModelCatalogCli 2026-09-30-19:25:
FUSI-024: build the real dependency seam for `fn models`.

Registry construction is NOT re-implemented here. The command uses the same engine factories the
onboarding path already uses — `createFusionAuthStorage` + `createFusionModelRegistry` + the bounded
`refreshFusionModelRegistry` — so a catalog built by the CLI and one built by the dashboard come from
the same registry code. The refresh is bounded exactly as the request path bounds it, so a hung
catalog fetch degrades to the retained rows rather than hanging the terminal.

The credential surface is wrapped with `wrapAuthStorageWithApiKeyProviders`, the same wrapper the
dashboard and `fn onboard` use. That wrapper is what supplies `getApiKeyProviders`/`hasApiKey` for
discovery, and it is what keeps the CLI's connected-provider view identical to the dashboard's.

Toggle flags and custom providers come from the user's GLOBAL settings through the read-only
settings view, so the command needs no store, no daemon, and no bearer token.
*/
export async function createModelCatalogDeps(cwd: string = process.cwd()): Promise<ModelCatalogDeps> {
  const authStorage = createFusionAuthStorage();

  const agentDir = getPackageManagerAgentDir();
  let toggles: ModelCatalogToggles = {};
  let customProviders: CustomProvider[] = [];
  try {
    const view = createReadOnlyProviderSettingsView(cwd, agentDir);
    const settings = view.getGlobalSettings() as Record<string, unknown>;
    toggles = {
      useClaudeCli: settings.useClaudeCli === true,
      useDroidCli: settings.useDroidCli === true,
      useLlamaCpp: settings.useLlamaCpp === true,
      useCursorCli: settings.useCursorCli === true,
      useGrokCli: settings.useGrokCli === true,
      useAntigravityCli: settings.useAntigravityCli === true,
      useOmpCli: settings.useOmpCli === true,
    };
    if (Array.isArray(settings.customProviders)) {
      customProviders = settings.customProviders as CustomProvider[];
    }
  } catch {
    // Unreadable settings must not break a read-only inspection command; fall back to no toggles.
  }

  const registry = await createFusionModelRegistry(authStorage);
  let registryError: string | undefined;
  try {
    await refreshFusionModelRegistry(registry as unknown as Parameters<typeof refreshFusionModelRegistry>[0]);
  } catch (error: unknown) {
    // A failed or timed-out refresh still leaves whatever rows the registry already holds; record the
    // reason so the command can report it instead of silently presenting a stale catalog as fresh.
    registryError = error instanceof Error ? error.message : String(error);
  }

  // Wrap AFTER the registry exists, mirroring `fn onboard`: the wrapper layers the api-key provider
  // surface (getApiKeyProviders/hasApiKey) on top of the file-backed storage, and discovery reads
  // through that wrapped view — the same one the dashboard reads through.
  const providerAuth = wrapAuthStorageWithApiKeyProviders(authStorage, registry as unknown as Parameters<typeof wrapAuthStorageWithApiKeyProviders>[1]);

  return {
    authStorage: providerAuth,
    registry: registry as unknown as ModelCatalogRegistryLike,
    toggles,
    customProviders,
    log: (line: string) => console.log(line),
    registryError,
  };
}
