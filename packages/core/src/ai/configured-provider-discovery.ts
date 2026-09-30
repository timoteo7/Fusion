import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { customProviderRegistryKey } from "./custom-provider-key.js";
import { ANTHROPIC_PROVIDER_ID, toExecutionModelProviderId } from "./anthropic-models.js";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "../provider-instance.js";
import type { CustomProvider } from "../types.js";

/*
FNXC:ConfiguredProviderDiscovery 2026-09-30-19:10:
FUSI-024. The configured-provider gate is the single most important correctness rule in the model
catalog: a list advertising providers the operator has never connected is worse than no list at
all. It used to live privately inside the dashboard's `GET /api/models` handler, which made the
catalog unreadable outside an authenticated HTTP route.

This module is that gate, extracted ONCE so every read surface derives the same provider set from
the same code. The dashboard route and the headless `fn models` CLI both import these two
functions; neither re-implements discovery, and neither may re-derive the toggle or
custom-provider additions on its own. A parity test pins both surfaces to this implementation.

Deliberate constraints, so this stays a leaf module that any surface may import:
  - Depends only on other core constants plus `node:fs`/`node:os`/`node:path`. No dashboard,
    engine, or pi-ai imports, which would invert the dependency direction and drag a heavy
    runtime into core.
  - The auth-storage parameter is a MINIMAL structural interface declared below, not a concrete
    class. Both the dashboard's `AuthStorageLike` and the engine's `FusionAuthStorage` satisfy it
    structurally, so neither package needs to import the other.
  - `home` is injectable because the legacy `~/.pi` and `~/.fusion` path scans otherwise make this
    function untestable without reading the developer's real home directory.
*/

/**
 * FNXC:ConfiguredProviderDiscovery 2026-09-30-19:10:
 * Minimal structural view of pi's AuthStorage used by provider discovery. Every member is
 * optional so a partially-implemented or legacy store still satisfies it — discovery treats a
 * missing member as "no credential of that kind", never as an error.
 */
export interface ConfiguredProviderAuthStorageLike {
  reload?(): void;
  getOAuthProviders?(): Array<{ id: string; name?: string }>;
  hasAuth?(provider: string): boolean;
  getApiKeyProviders?(): Array<{ id: string; name?: string }>;
  hasApiKey?(provider: string): boolean;
  /** Resolves a stored credential; only its `type` discriminator is read, never its secret. */
  get?(provider: string): { type?: unknown; key?: unknown } | null | undefined;
}

/**
 * Toggle-derived and settings-derived additions applied on top of credential discovery.
 *
 * FNXC:ConfiguredProviderDiscovery 2026-09-30-19:10:
 * A CLI runtime (claude/droid/llama/cursor/grok/antigravity/omp) is "connected" purely by its
 * settings toggle — it has no auth.json or models.json credential. The provider id literals below
 * are load-bearing: they must stay byte-identical to the dashboard's `*_PICKER_PROVIDER_ID`
 * constants and to the ids the catalog rows themselves carry, or a connected CLI provider would be
 * discovered and then immediately filtered out of its own catalog.
 *
 * `hermesRowsAdded` is the one non-toggle signal: Hermes has no settings toggle, so profile
 * presence (did discovery actually contribute rows?) IS the signal.
 */
export interface ConfiguredProviderToggleFlags {
  useClaudeCli?: boolean;
  useDroidCli?: boolean;
  useLlamaCpp?: boolean;
  useCursorCli?: boolean;
  useGrokCli?: boolean;
  useAntigravityCli?: boolean;
  useOmpCli?: boolean;
  /** FN-7636: only allow-list "hermes" when Hermes discovery actually contributed rows. */
  hermesRowsAdded?: boolean;
}

/**
 * A raw Anthropic API-key credential as stored by auth storage: `{ type: "api_key", key: "sk-…" }`.
 *
 * FNXC:ConfiguredProviderDiscovery 2026-09-30-19:10:
 * Only the presence and shape of the key is inspected. The key's VALUE is never read into any
 * returned data structure, logged, or persisted — this predicate is a boolean test on a shape.
 */
function isRawAnthropicApiKeyCredential(credential: unknown): boolean {
  return Boolean(
    credential
      && typeof credential === "object"
      && (credential as { type?: unknown; key?: unknown }).type === "api_key"
      && typeof (credential as { key?: unknown }).key === "string"
      && (credential as { key: string }).key.length > 0,
  );
}

function toModelProviderId(providerId: string): string {
  return toExecutionModelProviderId(providerId);
}

function addAuthStorageConfiguredProviders(
  authStorage: ConfiguredProviderAuthStorageLike | undefined,
  providers: Set<string>,
): void {
  if (!authStorage) {
    return;
  }

  try {
    authStorage.reload?.();
  } catch {
    // Ignore unreadable auth storage and fall back to persisted files below.
  }

  for (const provider of authStorage.getOAuthProviders?.() ?? []) {
    const providerId = provider.id;
    if (providerId === ANTHROPIC_PROVIDER_ID || providerId === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
      continue;
    }
    if (authStorage.hasAuth?.(providerId)) {
      providers.add(providerId);
    }
  }

  for (const provider of authStorage.getApiKeyProviders?.() ?? []) {
    const storedCredential = authStorage.get?.(provider.id);
    if (authStorage.hasApiKey?.(provider.id) || isRawAnthropicApiKeyCredential(storedCredential)) {
      providers.add(toModelProviderId(provider.id));
    }
  }

  /*
  FNXC:ProviderAuth 2026-07-01-15:10:
  Advertise the direct `anthropic` provider whenever auth storage reports usable anthropic auth — raw API key, subscription OAuth, legacy OAuth, or fallback. Restored v0.51.0 behavior (issue #1857): a subscription/OAuth token executes on the built-in `anthropic` provider via pi-ai's Claude Code impersonation, so OAuth-only users must be able to pick Claude models. `hasAuth("anthropic")` already unifies these sources.
  */
  if (authStorage.hasAuth?.(ANTHROPIC_PROVIDER_ID) || authStorage.hasAuth?.(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID)) {
    providers.add(ANTHROPIC_PROVIDER_ID);
  }
}

/**
 * Discover the providers this installation has actually connected, from credentials only.
 *
 * FNXC:ConfiguredProviderDiscovery 2026-09-30-19:10:
 * Sources, in order: injected auth storage (OAuth / API-key / `hasAuth`), the three Fusion + legacy
 * `.pi` `auth.json` paths, the `ANTHROPIC_API_KEY` environment variable, and the three
 * Fusion + legacy `.pi` `models.json` paths carrying an inline API key.
 *
 * The result is credentials only. Toggle- and custom-provider-derived ids are layered on top by
 * {@link addToggleConfiguredProviders}, so a caller that only wants "what have I authenticated?"
 * cannot accidentally inherit CLI-toggled providers.
 *
 * @param home Home directory to scan. Injectable so tests never read the real `~/.pi`.
 */
export async function discoverConfiguredProviders(
  authStorage?: ConfiguredProviderAuthStorageLike,
  home: string = process.env.HOME || process.env.USERPROFILE || homedir(),
): Promise<Set<string>> {
  const providers = new Set<string>();

  addAuthStorageConfiguredProviders(authStorage, providers);

  // Fusion primary + legacy .pi auth files
  const authPaths = [
    join(home, ".fusion", "agent", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
    join(home, ".pi", "auth.json"),
  ];

  for (const authPath of authPaths) {
    try {
      await access(authPath);
      const parsed = JSON.parse(await readFile(authPath, "utf-8")) as Record<string, unknown>;
      for (const [key, credential] of Object.entries(parsed)) {
        if (key === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) {
          // A separated subscription OAuth row makes the direct `anthropic` provider usable.
          providers.add(ANTHROPIC_PROVIDER_ID);
          continue;
        }
        if (key !== ANTHROPIC_PROVIDER_ID) {
          providers.add(key);
          continue;
        }
        // Raw API key OR OAuth (legacy subscription) both configure the direct `anthropic` provider.
        const credType = credential && typeof credential === "object"
          ? (credential as { type?: unknown }).type
          : undefined;
        if (credType === "api_key" || credType === "oauth") {
          providers.add(key);
        }
      }
    } catch {
      // Ignore missing or invalid auth files
    }
  }

  /*
  FNXC:ProviderAuth 2026-07-01-15:10:
  Anthropic's three surfaces in discovery (restored v0.51.0 behavior, issue #1857): the direct `anthropic` provider is advertised for raw API-key auth (auth.json `type: api_key`, models.json apiKey, `ANTHROPIC_API_KEY`) AND for subscription/legacy OAuth (which executes on the built-in `anthropic` provider via pi-ai's Claude Code impersonation to /v1). `anthropic-subscription` is an auth/usage credential id, never its own picker row. Claude CLI models appear as `pi-claude-cli` only when the CLI picker toggle is enabled.

  FNXC:ModelCatalog 2026-07-01-13:41:
  `/api/models` must follow the same connected-state source as Settings/auth status when ServerOptions.authStorage is injected. Use auth storage first for OAuth/API-key surfaces, then fall back to legacy files/env so v0.50-style local API-key discovery still works.
  */
  if (process.env.ANTHROPIC_API_KEY) {
    providers.add(ANTHROPIC_PROVIDER_ID);
  }

  // Check models.json for providers with inline API keys
  const modelsPaths = [
    join(home, ".fusion", "agent", "models.json"),
    join(home, ".pi", "agent", "models.json"),
    join(home, ".pi", "models.json"),
  ];
  for (const modelsPath of modelsPaths) {
    try {
      await access(modelsPath);
      const parsed = JSON.parse(await readFile(modelsPath, "utf-8")) as {
        providers?: Record<string, { apiKey?: string }>;
      };
      const provs = parsed?.providers;
      if (provs) {
        for (const [providerId, config] of Object.entries(provs)) {
          if (config.apiKey) {
            providers.add(providerId);
          }
        }
      }
    } catch {
      // Ignore missing or invalid models.json
    }
  }

  return providers;
}

/**
 * Add the CLI-toggle-derived and custom-provider ids to a discovered set, in place.
 *
 * FNXC:ConfiguredProviderDiscovery 2026-09-30-19:10:
 * Strictly additive by design (FN-7630, GitHub #1931): this never REMOVES an id, and it has no
 * Hermes-specific branch beyond the `hermesRowsAdded` signal. Connecting or disconnecting a
 * runtime plugin must therefore be unable to narrow a provider set that discovery already
 * established, and an independently-configured custom provider can never be deactivated by a
 * plugin's connection state.
 *
 * Mutating and returning the same Set keeps call sites as a single expression:
 * `const configured = addToggleConfiguredProviders(await discoverConfiguredProviders(...), flags)`.
 */
export function addToggleConfiguredProviders(
  providers: Set<string>,
  flags: ConfiguredProviderToggleFlags = {},
  customProviders: readonly CustomProvider[] = [],
): Set<string> {
  if (flags.useClaudeCli) {
    // FNXC:ModelCatalog 2026-07-09: the vendored pi-claude-cli extension registers its provider
    // under BOTH ids — `pi-claude-cli` (its raw registry provider) and `claude-cli` (the dashboard
    // picker id) — so both must be allow-listed or one of the two row families is filtered away.
    providers.add("pi-claude-cli");
    providers.add("claude-cli");
  }
  if (flags.useDroidCli) providers.add("droid-cli");
  if (flags.useLlamaCpp) providers.add("llama-server");
  // FNXC:ModelCatalog 2026-07-08-00:05 (FN-7696): allow-list "cursor-cli" through the final filter
  // whenever the toggle is on — independent of any auth.json/models.json entry and independent of
  // whether discovery actually contributed rows. Cursor's own toggle IS the signal, not row
  // presence. This closes the previously-missing configuredProviders.add("cursor-cli") gap that
  // silently dropped Cursor rows even when the plugin surfaced them.
  if (flags.useCursorCli) providers.add("cursor-cli");
  // FNXC:GrokCli 2026-07-08-00:05 (FN-7705): allow-list "grok-cli", mirroring cursor-cli above.
  if (flags.useGrokCli) providers.add("grok-cli");
  if (flags.useAntigravityCli) providers.add("antigravity-cli");
  // FNXC:OmpAcp 2026-07-13-22:50: allow-list omp-cli when toggle is on.
  if (flags.useOmpCli) providers.add("omp-cli");
  // FNXC:ModelCatalog 2026-07-07-09:05 (FN-7636): only allow-list "hermes" when Hermes rows were
  // actually contributed, mirroring the other toggle pattern (Hermes has no settings toggle —
  // profile presence IS the signal).
  if (flags.hermesRowsAdded) providers.add("hermes");
  // Custom providers are configured in Fusion's global settings rather than the auth.json /
  // models.json stores, so add their registry keys explicitly.
  for (const provider of customProviders) {
    providers.add(customProviderRegistryKey(provider, [...customProviders]));
  }
  return providers;
}
