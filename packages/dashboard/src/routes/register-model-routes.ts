import { mergeSupplementalAnthropicModels, mergeSupplementalOpenAiCodexModels, resolvePlanningSettingsModel, toExecutionModelProviderId, ANTHROPIC_API_KEY_PROVIDER_ID, ANTHROPIC_PROVIDER_ID, ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, THINKING_LEVELS, type ThinkingLevel, addToggleConfiguredProviders, discoverConfiguredProviders } from "@fusion/core";
import type { CustomProvider } from "@fusion/core";
import { ApiError } from "../api-error.js";
import { getCursorPickerModels } from "../cursor-model-cache.js";
import { getGrokPickerModels } from "../grok-model-cache.js";
import { getAntigravityPickerModels } from "../antigravity-model-cache.js";
import { getClaudePickerModels } from "../claude-model-cache.js";
import { getOmpPickerModels } from "../omp-model-cache.js";
import { getHermesPickerModels } from "../hermes-model-cache.js";
import {
  invalidateModelRegistryRefreshCache,
  refreshModelRegistryForRequest,
} from "../model-registry-refresh-cache.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { AuthStorageLike, ModelCostLike, ModelRegistryModelLike } from "../routes.js";
import type { ApiRouteRegistrar } from "./types.js";

type ProviderCredential = { type?: unknown } | null | undefined;

/*
FNXC:ConfiguredProviderDiscovery 2026-09-30-19:10:
FUSI-024 moved the gate's private `toModelProviderId` into core, where `discoverConfiguredProviders`
applies it to auth-storage API-key provider ids. The per-credential instance projection below is
route-local (it is a /api/models concern, not a discovery one), so it keeps a local alias to the
same core primitive rather than restating the mapping.
*/
function toModelProviderId(providerId: string): string {
  return toExecutionModelProviderId(providerId);
}

/**
 * Return the models which today's configured-provider gate would advertise for a
 * concrete credential kind. `undefined` means that the existing gate has no
 * per-instance distinction for this provider, so callers must not invent one.
 */
function getAdvertisedModelIdsForCredential(
  providerId: string,
  credential: ProviderCredential,
  models: Array<{ provider: string; id: string }>,
  apiKeyProviderIds: Set<string>,
  oauthProviderIds: Set<string>,
): Set<string> | undefined {
  const modelProviderId = toModelProviderId(providerId);
  const providerModels = new Set(models.filter(model => model.provider === modelProviderId).map(model => model.id));
  if (providerModels.size === 0) return new Set();

  // Direct Anthropic intentionally accepts both of its existing auth kinds.
  if (modelProviderId === ANTHROPIC_PROVIDER_ID) {
    return credential?.type === "api_key" || credential?.type === "oauth" ? providerModels : new Set();
  }
  if (apiKeyProviderIds.has(providerId)) {
    return credential?.type === "api_key" ? providerModels : new Set();
  }
  if (oauthProviderIds.has(providerId)) {
    return credential?.type === "oauth" ? providerModels : new Set();
  }
  return undefined;
}

/*
FNXC:ProviderAuth 2026-08-01-08:39:
Expose instance availability beside the catalog rather than copying every model per credential. Reuse the existing API-key/OAuth configured-provider gate to derive only real default-versus-instance deltas; an arbitrary stored field or a network probe would fabricate availability data.
*/
/*
FNXC:ModelThinkingCapabilities 2026-08-18-23:38:
Pi's model registry is the source of truth for model-bound thinking controls. The pinned SDK helper implements the documented reasoning=false and thinkingLevelMap tristate rules; the structural fallback keeps this route compatible with registry facades and older SDKs without inferring capabilities from provider or model names.
*/
function deriveSupportedThinkingLevels(model: ModelRegistryModelLike): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  /*
  FNXC:ModelCatalog 2026-09-02-22:06:
  Pi 0.84.4 catalogs Muse Spark on vercel-ai-gateway without a thinking-level map. Preserve
  the model row and expose an empty capability list so picker consumers never have to infer
  support from an omitted field or provider-specific fallback.
  */
  if (!model.thinkingLevelMap || typeof model.thinkingLevelMap !== "object") return [];

  try {
    const supported = getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0]);
    return supported.filter((level): level is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(level));
  } catch {
    return THINKING_LEVELS.filter((level) => {
      const mapped = model.thinkingLevelMap?.[level];
      if (mapped === null) return false;
      return level !== "xhigh" && level !== "max" ? true : typeof mapped === "string";
    });
  }
}

function getProviderInstances(
  authStorage: AuthStorageLike | undefined,
  advertisedProviders: Iterable<string>,
  models: Array<{ provider: string; id: string }>,
): Record<string, { instances: Array<{ id: string; isDefault: boolean; unavailableModelIds?: string[] }> }> | undefined {
  if (!authStorage?.listInstances) return undefined;
  const result: Record<string, { instances: Array<{ id: string; isDefault: boolean; unavailableModelIds?: string[] }> }> = {};
  const apiKeyProviderIds = new Set((authStorage.getApiKeyProviders?.() ?? []).map(provider => provider.id));
  const oauthProviderIds = new Set((authStorage.getOAuthProviders?.() ?? []).map(provider => provider.id));
  const providerIds = new Set([...advertisedProviders, ...models.map(model => model.provider)]);
  for (const modelProviderId of providerIds) {
    const providerId = modelProviderId === ANTHROPIC_PROVIDER_ID ? ANTHROPIC_PROVIDER_ID : modelProviderId;
    try {
      const defaultRef = authStorage.getDefaultInstance?.(providerId);
      const refs = authStorage.listInstances(providerId);
      if (refs.length === 0) continue;
      const defaultCredential = defaultRef && authStorage.getInstance?.(defaultRef);
      const defaultModelIds = getAdvertisedModelIdsForCredential(
        providerId, defaultCredential, models, apiKeyProviderIds, oauthProviderIds,
      );
      const instances = refs.map(ref => {
        const instanceModelIds = getAdvertisedModelIdsForCredential(
          providerId, authStorage.getInstance?.(ref), models, apiKeyProviderIds, oauthProviderIds,
        );
        const unavailableModelIds = defaultModelIds && instanceModelIds
          ? [...defaultModelIds].filter(modelId => !instanceModelIds.has(modelId))
          : [];
        return {
          id: ref.instanceId,
          isDefault: defaultRef?.instanceId === ref.instanceId,
          ...(unavailableModelIds.length > 0 ? { unavailableModelIds } : {}),
        };
      });
      result[modelProviderId] = { instances };
    } catch {
      // A corrupt provider entry must not make the shared model catalog unavailable.
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export const registerModelRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, options, store, runtimeLogger } = ctx;

  /*
  FNXC:BuiltInModelRefresh 2026-08-18-23:05:
  The Authentication action is an explicit operator refresh for the shared built-in catalog. Invalidate only this registry generation, then reuse the existing bounded single-flight seam so a hung or stale refresh retains its last good rows and cannot overlap provider reloads.
  */
  router.post("/models/refresh", async (_req, res) => {
    if (!options?.modelRegistry) {
      res.json({ outcome: "failed", error: "Model registry unavailable" });
      return;
    }

    invalidateModelRegistryRefreshCache(options.modelRegistry);
    const outcome = await refreshModelRegistryForRequest(options.modelRegistry);
    res.json(outcome === "failed"
      ? { outcome, error: "Model catalog refresh failed; showing the last available models." }
      : { outcome });
  });

  router.get("/models", async (_req, res) => {
    // Get favoriteProviders/favoriteModels and default model from global settings.
    let favoriteProviders: string[] = [];
    let favoriteModels: string[] = [];
    let defaultProvider: string | undefined;
    let defaultModelId: string | undefined;
    let useClaudeCli = false;
    let useDroidCli = false;
    let useLlamaCpp = false;
    let useCursorCli = false;
    let cursorCliBinaryPath: string | undefined;
    let useGrokCli = false;
    let grokCliBinaryPath: string | undefined;
    let useAntigravityCli = false;
    let antigravityCliBinaryPath: string | undefined;
    let useOmpCli = false;
    let ompCliBinaryPath: string | undefined;
    let resolvedPlanningProvider: string | undefined;
    let resolvedPlanningModelId: string | undefined;
    let customProviders: CustomProvider[] = [];
    if (store) {
      try {
        const globalStore = store.getGlobalSettingsStore();
        const globalSettings = await globalStore.getSettings();
        favoriteProviders = globalSettings.favoriteProviders ?? [];
        favoriteModels = globalSettings.favoriteModels ?? [];
        defaultProvider = globalSettings.defaultProvider;
        defaultModelId = globalSettings.defaultModelId;
        useClaudeCli = globalSettings.useClaudeCli === true;
        useDroidCli = globalSettings.useDroidCli === true;
        useLlamaCpp = globalSettings.useLlamaCpp === true;
        useCursorCli = (globalSettings as Record<string, unknown>).useCursorCli === true;
        /*
        FNXC:CursorCli 2026-07-08-00:20:
        FN-7699 (follow-up to FN-7696): the machine-local `cursorCliBinaryPath`
        operator override must apply to model-picker discovery too, not just
        the auth/probe/status paths (register-auth-routes.ts's
        normalizeCursorCliBinaryPath). Mirror the same trim/blank->undefined
        normalization here so a blank/unset override preserves PATH
        auto-detection byte-for-byte, and a set override threads through to
        getCursorPickerModels below so discovery spawns the exact same
        cursor-agent executable the settings card already validated.
        */
        const rawCursorCliBinaryPath = (globalSettings as Record<string, unknown>).cursorCliBinaryPath;
        cursorCliBinaryPath =
          typeof rawCursorCliBinaryPath === "string" ? rawCursorCliBinaryPath.trim() || undefined : undefined;
        useGrokCli = (globalSettings as Record<string, unknown>).useGrokCli === true;
        useAntigravityCli = (globalSettings as Record<string, unknown>).useAntigravityCli === true;
        const rawAntigravityCliBinaryPath = (globalSettings as Record<string, unknown>).antigravityCliBinaryPath;
        antigravityCliBinaryPath = typeof rawAntigravityCliBinaryPath === "string" ? rawAntigravityCliBinaryPath.trim() || undefined : undefined;
        /*
        FNXC:GrokCli 2026-07-08-00:20:
        FN-7705: mirror the cursorCliBinaryPath override handling above so a
        machine-local grokCliBinaryPath override applies to model-picker
        discovery, not just the auth/probe/status paths.
        */
        const rawGrokCliBinaryPath = (globalSettings as Record<string, unknown>).grokCliBinaryPath;
        grokCliBinaryPath =
          typeof rawGrokCliBinaryPath === "string" ? rawGrokCliBinaryPath.trim() || undefined : undefined;
        /*
        FNXC:OmpAcp 2026-07-13-22:50:
        useOmpCli toggle + ompCliBinaryPath override for model-picker discovery (mirrors Grok).
        */
        useOmpCli = (globalSettings as Record<string, unknown>).useOmpCli === true;
        const rawOmpCliBinaryPath = (globalSettings as Record<string, unknown>).ompCliBinaryPath;
        ompCliBinaryPath =
          typeof rawOmpCliBinaryPath === "string" ? rawOmpCliBinaryPath.trim() || undefined : undefined;
        customProviders = globalSettings.customProviders ?? [];

        const mergedSettings = await store.getSettingsFast();
        const resolvedPlanningModel = resolvePlanningSettingsModel(mergedSettings);
        resolvedPlanningProvider = resolvedPlanningModel.provider;
        resolvedPlanningModelId = resolvedPlanningModel.modelId;
      } catch {
        // Silently ignore settings errors - just return empty favorites/default model
      }
    }

    const defaultModelResponse =
      defaultProvider && defaultModelId
        ? { defaultProvider, defaultModelId }
        : {};
    const resolvedPlanningModelResponse =
      resolvedPlanningProvider && resolvedPlanningModelId
        ? {
            resolvedPlanningProvider,
            resolvedPlanningModelId,
          }
        : {};

    // Always return 200 with empty array instead of 404 when no models available.
    // This ensures the frontend can handle empty states gracefully.
    if (!options?.modelRegistry) {
      res.json({
        models: [],
        favoriteProviders,
        favoriteModels,
        ...defaultModelResponse,
        ...resolvedPlanningModelResponse,
      });
      return;
    }

    try {
      const refreshOutcome = await refreshModelRegistryForRequest(options.modelRegistry);
      if (["timed_out", "failed", "stale_in_flight", "negative_cached"].includes(refreshOutcome)) {
        runtimeLogger.child("models").warn(`Model registry refresh outcome: ${refreshOutcome}; serving retained catalog`);
      }
      /*
      FNXC:ModelCatalog 2026-08-12-01:00:
      FN-8902 bounds and caches only the refresh operation. Supplemental merges and
      dedupe remain unconditional per request because refresh can replace provider
      rows; cached, failed, or timed-out paths must return the same live catalog shape.
      */
      if (options.modelRegistry.registerProvider) {
        mergeSupplementalAnthropicModels(options.modelRegistry as Parameters<typeof mergeSupplementalAnthropicModels>[0], (message) => runtimeLogger.child("models").warn(message));
        /*
         * FNXC:ModelCatalog 2026-07-09-12:30:
         * FN-7745: additively merge the GPT-5.6 codenamed OpenAI Codex variants
         * (gpt-5.6-luna/sol/terra), mirroring the mergeSupplementalAnthropicModels call
         * above. Strictly additive/dedupe-safe — an existing pinned-catalog row for any
         * of the three ids always wins, no row is displaced or duplicated.
         */
        mergeSupplementalOpenAiCodexModels(options.modelRegistry as unknown as Parameters<typeof mergeSupplementalOpenAiCodexModels>[0], (message) => runtimeLogger.child("models").warn(message));
      }
      let models: Array<{
        provider: string;
        id: string;
        name: string;
        reasoning: boolean;
        contextWindow: number;
        supportedThinkingLevels?: ThinkingLevel[];
        /*
        FNXC:ModelCatalog 2026-09-30-18:45:
        Every published catalog row carries `cost` so price is readable wherever the catalog is
        consumed (this route and the `fn models` CLI surface). Registry rows copy pi's price
        verbatim (USD per 1M tokens, never rescaled); picker rows injected below have no price
        and are normalized to `null` — "price unknown" is a real state and must stay distinct
        from a genuinely free `0`, so a missing cost is never substituted with `0`.

        `cost` is optional on this intermediate array because the CLI-picker rows merged below
        are pushed before the final normalization map; the map that runs just before the response
        guarantees the key is present on every published row.
        */
        cost?: ModelCostLike | null;
      }> = options.modelRegistry.getAvailable().map((m) => {
        const supportedThinkingLevels = deriveSupportedThinkingLevels(m);
        return {
          provider: m.provider,
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          contextWindow: m.contextWindow,
          supportedThinkingLevels,
          cost: m.cost ?? null,
        };
      });

      /*
      FNXC:ProviderAuth 2026-08-15-20:57:
      A registry/plugin may emit a credential-card row despite Fusion never registering it as an execution provider. Drop Anthropic auth ids rather than normalizing catalog rows: only the built-in `anthropic` row is selectable and can safely reach pi-ai.
      */
      models = models.filter((model) => model.provider !== ANTHROPIC_SUBSCRIPTION_PROVIDER_ID && model.provider !== ANTHROPIC_API_KEY_PROVIDER_ID);

      /*
       * FNXC:ModelCatalog 2026-07-01-12:02:
       * Model visibility is provider-surface-specific: Claude CLI can advertise its own `pi-claude-cli/claude-sonnet-5` row while direct Anthropic must only show Sonnet 5 when the upstream registry returns it. Dedupe after refresh/supplemental merges so overlapping live and supplemental catalogs expose one selectable row without reintroducing static direct-Anthropic advertisement.
       */
      const seenModelKeys = new Set<string>();
      models = models.filter((model) => {
        const key = `${model.provider}/${model.id}`;
        if (seenModelKeys.has(key)) return false;
        seenModelKeys.add(key);
        return true;
      });

      // The vendored pi-claude-cli extension registers its provider as
      // "pi-claude-cli" (distinct from "anthropic") whenever it loads.
      // When the toggle is OFF, hide those entries from pickers so users
      // don't see CLI-routed models they haven't opted into. When ON,
      // surface everything so the CLI-routed entries appear alongside any
      // direct provider auth the user has connected.
      if (!useClaudeCli) {
        models = models.filter((m) => m.provider !== "pi-claude-cli");
      }
      if (!useDroidCli) {
        models = models.filter((m) => m.provider !== "droid-cli");
      }
      if (!useLlamaCpp) {
        models = models.filter((m) => m.provider !== "llama-server");
      }
      if (!useCursorCli) {
        models = models.filter((m) => m.provider !== "cursor-cli");
      }
      if (!useGrokCli) {
        models = models.filter((m) => m.provider !== "grok-cli");
      }
      if (!useOmpCli) {
        models = models.filter((m) => m.provider !== "omp-cli");
      }

      /*
      FNXC:ModelCatalog 2026-07-07-09:05:
      FN-7636 (deferred item 1 of FN-7630/GitHub #1931): additively surface
      Hermes-configured models (`hermes profile list`) under the stable
      "hermes" provider id so picker selections route to the Hermes runtime
      (HERMES_RUNTIME_ID). Fetched through getHermesPickerModels, which is
      backed by a short-TTL, single-flight cache — this call NEVER spawns the
      `hermes` CLI per request, and NEVER throws (a missing/failed binary
      degrades to []). Hermes rows are merged respecting the existing
      seenModelKeys provider/id dedup so an existing row always wins over a
      colliding Hermes row — this is purely additive and must never displace,
      overwrite, or filter out an existing row.
      */
      const hermesModels = await getHermesPickerModels();
      // Track "configured" by profile presence, not by how many rows survived
      // the seenModelKeys dedup: even when every Hermes-derived id collides
      // with an already-present row (existing row wins, see FN-7636 Surface
      // Enumeration), the user still has Hermes profiles configured, so the
      // "hermes" provider must remain selectable below.
      const hermesRowsAdded = hermesModels.length > 0;
      for (const hermesModel of hermesModels) {
        const key = `${hermesModel.provider}/${hermesModel.id}`;
        if (seenModelKeys.has(key)) continue;
        seenModelKeys.add(key);
        models.push(hermesModel);
      }

      /*
      FNXC:ModelCatalog 2026-07-08-00:05:
      FN-7696: additively surface Cursor CLI-discovered models
      (`cursor-agent models --json`, with text/`model list` fallbacks) under
      the stable "cursor-cli" provider id, mirroring the FN-7636 Hermes merge
      above. Unlike Hermes (whose profile presence IS the enable signal),
      Cursor has its own settings toggle (useCursorCli) — the toggle IS the
      signal here, so discovery is only attempted when useCursorCli is true.
      Fetched through getCursorPickerModels, backed by a short-TTL,
      single-flight cache keyed by binary path — this call NEVER spawns
      cursor-agent per request, and NEVER throws (a missing/failed/
      unavailable binary degrades to []). Cursor rows are merged respecting
      the existing seenModelKeys provider/id dedup so an existing row always
      wins over a colliding Cursor row — purely additive, must never
      displace, overwrite, or filter out an existing row.

      FNXC:CursorCli 2026-07-08-00:20:
      FN-7699: thread the normalized cursorCliBinaryPath operator override
      (see the globalSettings read block above) into getCursorPickerModels so
      discovery spawns the exact same machine-local cursor-agent executable
      already validated by the auth/probe/status paths. Blank/undefined
      preserves PATH auto-detection unchanged; the cache is keyed per
      resolved binary path so the override participates correctly in
      TTL/single-flight caching.
      */
      if (useCursorCli) {
        // getCursorPickerModels never throws by contract (see
        // cursor-model-cache.ts), but this try/catch is a defensive belt so
        // a Cursor discovery failure can never reject the /models handler or
        // drop existing rows — degrade to zero Cursor rows instead.
        try {
          const cursorModels = await getCursorPickerModels({ binaryPath: cursorCliBinaryPath });
          for (const cursorModel of cursorModels) {
            const key = `${cursorModel.provider}/${cursorModel.id}`;
            if (seenModelKeys.has(key)) continue;
            seenModelKeys.add(key);
            models.push(cursorModel);
          }
        } catch (cursorErr: unknown) {
          const message = cursorErr instanceof Error ? cursorErr.message : String(cursorErr);
          runtimeLogger.child("models").warn(`Failed to load cursor-cli models: ${message}`);
        }
      }

      /*
      FNXC:GrokCli 2026-07-08-00:05:
      FN-7705: additively surface Grok CLI-discovered models (`grok models`)
      under the stable "grok-cli" provider id, mirroring the cursor-cli merge
      above. Grok has its own settings toggle (useGrokCli) — the toggle IS the
      signal here, so discovery is only attempted when useGrokCli is true.
      Fetched through getGrokPickerModels, backed by a short-TTL, single-flight
      cache keyed by binary path — this call NEVER spawns grok per request, and
      NEVER throws (a missing/failed/unavailable binary degrades to []). Grok
      rows are merged respecting the existing seenModelKeys provider/id dedup
      so an existing row always wins over a colliding Grok row — purely
      additive, must never displace, overwrite, or filter out an existing row.
      */
      if (useClaudeCli) {
        try {
          for (const model of await getClaudePickerModels()) {
            const key = `${model.provider}/${model.id}`;
            if (!seenModelKeys.has(key)) { seenModelKeys.add(key); models.push(model); }
          }
        } catch (error: unknown) { runtimeLogger.child("models").warn(`Failed to load claude-cli models: ${error instanceof Error ? error.message : String(error)}`); }
      }

      if (useGrokCli) {
        // getGrokPickerModels never throws by contract (see
        // grok-model-cache.ts), but this try/catch is a defensive belt so a
        // Grok discovery failure can never reject the /models handler or drop
        // existing rows — degrade to zero Grok rows instead.
        try {
          const grokModels = await getGrokPickerModels({ binaryPath: grokCliBinaryPath });
          for (const grokModel of grokModels) {
            const key = `${grokModel.provider}/${grokModel.id}`;
            if (seenModelKeys.has(key)) continue;
            seenModelKeys.add(key);
            models.push(grokModel);
          }
        } catch (grokErr: unknown) {
          const message = grokErr instanceof Error ? grokErr.message : String(grokErr);
          runtimeLogger.child("models").warn(`Failed to load grok-cli models: ${message}`);
        }
      }

      if (useAntigravityCli) {
        try {
          for (const model of await getAntigravityPickerModels({ binaryPath: antigravityCliBinaryPath })) {
            const key = `${model.provider}/${model.id}`;
            if (!seenModelKeys.has(key)) { seenModelKeys.add(key); models.push(model); }
          }
        } catch { /* Antigravity discovery failure must preserve every other provider row. */ }
      }

      /*
      FNXC:OmpAcp 2026-07-13-22:50:
      Surface omp models under omp-cli when useOmpCli is on (additive; never displace existing rows).
      */
      if (useOmpCli) {
        try {
          const ompModels = await getOmpPickerModels({ binaryPath: ompCliBinaryPath });
          for (const ompModel of ompModels) {
            const key = `${ompModel.provider}/${ompModel.id}`;
            if (seenModelKeys.has(key)) continue;
            seenModelKeys.add(key);
            models.push(ompModel);
          }
        } catch (ompErr: unknown) {
          const message = ompErr instanceof Error ? ompErr.message : String(ompErr);
          runtimeLogger.child("models").warn(`Failed to load omp-cli models: ${message}`);
        }
      }

      // Filter to only providers the user has explicitly configured in Fusion.
      // getAvailable() checks supplemental credential stores (Codex CLI,
      // Claude Code, env vars) which surface providers the user may not
      // have set up in Fusion. We restrict to providers with credentials
      // in Fusion's own auth stores (primary + legacy .pi + models.json),
      // plus any providers enabled via settings toggles (Claude CLI, etc.).
      /*
      FNXC:ModelCatalog 2026-07-07-08:00:
      FN-7630 (GitHub #1931): the Hermes Runtime plugin must be strictly additive
      — connecting/activating or disconnecting it must never narrow this
      configuredProviders allow-set. This block only ever ADDS provider ids
      (auth-storage-derived, CLI-toggle-derived, and customProviders-derived); it
      never removes an entry based on any runtime-plugin connection state, and no
      Hermes-specific branch exists here by design. customProviders' registry keys
      are added unconditionally (regardless of whether Hermes is loaded/connected)
      so a connected Hermes runtime can never deactivate independently-configured
      custom Fusion providers/models. See register-model-routes-hermes-additive.test.ts.
      */
      /*
      FNXC:ConfiguredProviderDiscovery 2026-09-30-19:10:
      FUSI-024: discovery and the toggle/custom-provider additions are now the shared core
      functions, so this route and the headless `fn models` CLI cannot drift apart. The behavior
      is unchanged — the provider-id literals and every conditional below moved verbatim into
      `addToggleConfiguredProviders`, whose FNXC comments carry the original per-toggle rationale.
      */
      const configuredProviders = addToggleConfiguredProviders(
        await discoverConfiguredProviders(options?.authStorage),
        {
          useClaudeCli,
          useDroidCli,
          useLlamaCpp,
          useCursorCli,
          useGrokCli,
          useAntigravityCli,
          useOmpCli,
          hermesRowsAdded,
        },
        customProviders,
      );
      models = models.filter((m) => configuredProviders.has(m.provider));
      /*
      FNXC:ModelCatalog 2026-09-30-18:45:
      Normalize the price of every published row in one place. Registry rows already carry a
      verbatim `cost`; the CLI-picker rows merged above (hermes/cursor/claude/grok/antigravity/omp)
      have none, so they are published as an explicit `null` — "price unknown" stays
      distinguishable from a genuinely free `0` and from a real rate. Consumers can therefore
      trust that a `cost` key is always present on a row.
      */
      models = models.map((m) => ({ ...m, cost: m.cost ?? null }));
      const providerInstances = getProviderInstances(options?.authStorage, configuredProviders, models);

      res.json({
        models,
        favoriteProviders,
        favoriteModels,
        ...defaultModelResponse,
        ...resolvedPlanningModelResponse,
        ...(providerInstances ? { providerInstances } : {}),
      });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      runtimeLogger.child("models").warn(`Failed to load models: ${message}`);
      res.json({
        models: [],
        favoriteProviders,
        favoriteModels,
        ...defaultModelResponse,
        ...resolvedPlanningModelResponse,
      });
    }
  });
};
