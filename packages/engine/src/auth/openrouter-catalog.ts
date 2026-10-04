import type { ModelRegistry, ProviderConfig } from "@earendil-works/pi-coding-agent";

export const OPENROUTER_PUBLIC_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const OPENROUTER_CATALOG_TIMEOUT_MS = 15_000;
export const OPENROUTER_CATALOG_TTL_MS = 5 * 60_000;
export type OpenRouterCatalogModel = NonNullable<ProviderConfig["models"]>[number];

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function cost(value: unknown, optional = false): number | undefined {
  if (value === undefined && optional) return 0;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && Number.isFinite(parsed * 1_000_000)
    ? parsed * 1_000_000 : undefined;
}

/** Public metadata is untrusted. Never guess output limits or capabilities from names. */
export function toOpenRouterCatalogModels(json: unknown): OpenRouterCatalogModel[] {
  const data = record(json)?.data;
  if (!Array.isArray(data)) throw new Error("Invalid OpenRouter public model catalog");
  const models: OpenRouterCatalogModel[] = [];
  const ids = new Set<string>();
  for (const item of data) {
    const model = record(item);
    const architecture = record(model?.architecture);
    const pricing = record(model?.pricing);
    const maxTokens = record(model?.top_provider)?.max_completion_tokens;
    const parameters = model?.supported_parameters;
    const modalities = architecture?.input_modalities;
    const inputCost = cost(pricing?.prompt);
    const outputCost = cost(pricing?.completion);
    const cacheRead = cost(pricing?.input_cache_read, true);
    const cacheWrite = cost(pricing?.input_cache_write, true);
    if (!model || typeof model.id !== "string" || !model.id.trim() || ids.has(model.id)
      || !positiveInteger(model.context_length) || !positiveInteger(maxTokens)
      || !Array.isArray(parameters) || !parameters.every((value) => typeof value === "string")
      || !Array.isArray(modalities) || !modalities.includes("text")
      || !modalities.every((value) => typeof value === "string")
      || inputCost === undefined || outputCost === undefined || cacheRead === undefined || cacheWrite === undefined) continue;
    ids.add(model.id);
    const reasoning = parameters.includes("reasoning") || parameters.includes("reasoning_effort") || parameters.includes("include_reasoning");
    const reasoningMetadata = record(model.reasoning);
    const efforts = reasoningMetadata?.supported_efforts;
    const thinkingLevelMap: OpenRouterCatalogModel["thinkingLevelMap"] = {};
    if (reasoning && reasoningMetadata?.mandatory === true) thinkingLevelMap.off = null;
    if (reasoning && Array.isArray(efforts) && efforts.every((effort) => typeof effort === "string")) {
      const levels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
      const supported = levels.filter((level) => efforts.includes(level));
      for (const level of levels) {
        const mapped = supported.find((candidate) => levels.indexOf(candidate) >= levels.indexOf(level)) ?? supported.at(-1);
        if (mapped) thinkingLevelMap[level] = mapped;
      }
    }
    models.push({
      id: model.id,
      name: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning,
      ...(Object.keys(thinkingLevelMap).length ? { thinkingLevelMap } : {}),
      input: modalities.includes("image") ? ["text", "image"] : ["text"],
      cost: { input: inputCost, output: outputCost, cacheRead, cacheWrite },
      contextWindow: model.context_length,
      maxTokens,
    });
  }
  return models;
}

// Successful public metadata is reusable across independent per-session runtimes.
// One fetch owner controls cancellation. Keep ownership until even an abort-ignoring
// fetch settles; a timeout cannot launch overlapping work or publish late metadata.
let cached: OpenRouterCatalogModel[] | undefined;
let cachedAt = 0;
const confirmedMissing = new Map<string, number>();
let pendingLookups = new Set<string>();
let inFlight: Promise<OpenRouterCatalogModel[]> | undefined;

export function getOpenRouterCatalog(modelId?: string): Promise<OpenRouterCatalogModel[]> {
  const now = Date.now();
  for (const [id, confirmedAt] of confirmedMissing) {
    if (now - confirmedAt >= OPENROUTER_CATALOG_TTL_MS) confirmedMissing.delete(id);
  }
  if (cached && Date.now() - cachedAt < OPENROUTER_CATALOG_TTL_MS
    && (!modelId || cached.some((model) => model.id === modelId) || confirmedMissing.has(modelId))) return Promise.resolve(cached);
  if (inFlight) {
    if (modelId) pendingLookups.add(modelId);
    return inFlight;
  }
  const lookups = new Set(modelId ? [modelId] : []);
  pendingLookups = lookups;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("OpenRouter public model catalog discovery timed out"));
    }, OPENROUTER_CATALOG_TIMEOUT_MS);
  });
  const underlying = Promise.resolve().then(async () => {
    const response = await fetch(OPENROUTER_PUBLIC_MODELS_URL, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error("OpenRouter public model catalog discovery failed");
    const models = toOpenRouterCatalogModels(await response.json());
    if (!timedOut && models.length > 0) {
      cached = models;
      cachedAt = Date.now();
      // A refresh for another missing selection must not erase earlier misses
      // or extend their TTL. Remove expired/newly-published ids, then add only
      // newly confirmed misses owned by this request.
      for (const [id, confirmedAt] of confirmedMissing) {
        if (cachedAt - confirmedAt >= OPENROUTER_CATALOG_TTL_MS || models.some((model) => model.id === id)) confirmedMissing.delete(id);
      }
      for (const id of lookups) {
        if (!models.some((model) => model.id === id) && !confirmedMissing.has(id)) confirmedMissing.set(id, cachedAt);
      }
    }
    return models;
  });
  const bounded = Promise.race([underlying, timeout]).catch(() => {
    // Do not expose transport errors: they can include request/config details.
    throw new Error(timedOut ? "OpenRouter public model catalog discovery timed out" : "OpenRouter public model catalog discovery failed");
  }).finally(() => clearTimeout(timer));
  inFlight = bounded;
  void underlying.then(() => { if (inFlight === bounded) inFlight = undefined; }, () => { if (inFlight === bounded) inFlight = undefined; });
  return bounded;
}

export type OpenRouterHydrationPolicy = Pick<OpenRouterCatalogModel, "baseUrl" | "compat" | "headers">;

/** Read only OpenRouter policy fields; credentials never enter catalog discovery. */
export function openRouterHydrationPolicy(settings: unknown, modelsJson: unknown): OpenRouterHydrationPolicy {
  const globalSettings = record(settings);
  const configured = record(record(record(modelsJson)?.providers)?.openrouter);
  const policy: OpenRouterHydrationPolicy = {};
  if (typeof configured?.baseUrl === "string") policy.baseUrl = configured.baseUrl;
  const preferences = record(globalSettings?.openrouterProviderPreferences);
  const routing: Record<string, unknown> = {};
  for (const key of ["order", "ignore", "only"] as const) {
    const value = preferences?.[key];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) routing[key] = [...value];
  }
  for (const key of ["allow_fallbacks", "require_parameters"] as const) {
    if (typeof preferences?.[key] === "boolean") routing[key] = preferences[key];
  }
  if (["price", "throughput", "latency"].includes(String(preferences?.sort))) routing.sort = preferences?.sort;
  const configuredCompat = record(configured?.compat);
  if (Object.keys(routing).length || configuredCompat) {
    policy.compat = { ...(Object.keys(routing).length ? { openRouterRouting: routing } : {}), ...configuredCompat } as OpenRouterCatalogModel["compat"];
  }
  const attribution = record(globalSettings?.openrouterAppAttribution);
  const headers: Record<string, string> = {};
  for (const [field, header] of [["referer", "HTTP-Referer"], ["title", "X-Title"]] as const) {
    const value = attribution?.[field];
    if (typeof value === "string" && value && !/[\r\n]/.test(value)) headers[header] = value;
  }
  if (Object.keys(headers).length) policy.headers = headers;
  return policy;
}

/** Add only an exact public row; never replace provider auth or endpoint policy. */
export async function hydrateOpenRouterModel(modelRegistry: ModelRegistry, modelId: string, policy: OpenRouterHydrationPolicy = {}) {
  const exact = modelRegistry.find("openrouter", modelId);
  if (exact) return exact;
  // A native override owns its provider implementation, not just a model list.
  if (modelRegistry.getRegisteredNativeProvider?.("openrouter")) return undefined;
  const previous = modelRegistry.getRegisteredProviderConfig?.("openrouter");
  const providerBaseUrl = previous?.baseUrl ?? policy.baseUrl ?? modelRegistry.getProvider?.("openrouter")?.baseUrl;
  if (providerBaseUrl && providerBaseUrl.replace(/\/+$/, "") !== "https://openrouter.ai/api/v1") return undefined;
  const catalogModel = (await getOpenRouterCatalog(modelId)).find((entry) => entry.id === modelId);
  const registered = modelRegistry.find("openrouter", modelId);
  if (registered) return registered;
  if (!catalogModel) return undefined;
  const existingModels = modelRegistry.getAll().filter((entry) => entry.provider === "openrouter");
  const definitions = previous?.models ?? [];
  // Older registrations store provider-wide routing compat. SDK 0.86.1 only
  // consumes compat on model definitions; preserve that policy on the new row.
  const providerCompat = (previous as (ProviderConfig & { compat?: OpenRouterCatalogModel["compat"] }) | undefined)?.compat;
  // SDK replaces models, but merges undefined top-level fields. Retain original
  // definitions (request headers included) ahead of already-composed rows.
  modelRegistry.registerProvider("openrouter", {
    models: [
      ...definitions,
      ...existingModels.filter((entry) => !definitions.some((definition) => definition.id === entry.id)),
      {
        ...catalogModel, baseUrl: providerBaseUrl ?? catalogModel.baseUrl,
        ...(policy.compat || providerCompat ? { compat: { ...policy.compat, ...providerCompat } } : {}),
        ...(policy.headers ? { headers: policy.headers } : {}),
      },
    ],
  });
  return modelRegistry.find("openrouter", modelId);
}
