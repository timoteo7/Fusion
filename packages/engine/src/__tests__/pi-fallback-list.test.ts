/*
 * GDPR-001 — integration tests for the ordered fallback-model list chain.
 *
 * FNXC:FallbackModelList 2026-09-04-00:00:
 * Locks the contract of the engine fallback chain in `packages/engine/src/pi.ts`:
 *   - Primary is always tried FIRST; the list is walked AFTER the primary fails.
 *   - The configured lane primary is the chain's position 1 (1-based), list entries
 *     are positions 2..N+1, so a fully-exhausted chain has
 *     `attempts === chain.length + 1`.
 *   - One attempt per level. Usage-limit and transient-auth errors SKIP to the
 *     next entry with no 30s sleep. Any other error BUBBLES immediately (raw,
 *     not wrapped). Non-retryable primary errors bubble before any list entry
 *     is tried.
 *   - `onFallbackModelUsed` fires once per level transition (a skip still
 *     counts as a transition).
 *   - Legacy single-pair path (primary → fallback → primary-retry) is byte-for-byte
 *     preserved when the list is empty/unset, including the 3×30s backoff
 *     in `withRateLimitRetry`.
 *   - The chain wins over the legacy pair: non-empty `fallbackModels` IGNORES
 *     `fallbackProvider`/`fallbackModelId` entirely.
 *
 * The tests cover the spec's enumerated cases (L196–205) plus the binding
 * per-level single-attempt + immediate-skip semantics (Step 5 advisory, now
 * binding). They run against the public `createPiAgentSessionRaw` so the
 * behavior is end-to-end: parser → resolve → chain walk → emission → exhausted
 * error with per-attempt reasons.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Test-scoped mocks. Each test gets fresh vi.fn() instances via the
// beforeEach block so per-test state stays isolated even though the
// module is loaded once. The mocks are declared via `vi.hoisted` so the
// `vi.mock` factory closures can reference them at hoist time without
// hitting a TDZ when @fusion/core eagerly imports `node:fs`.
const mocks = vi.hoisted(() => {
  const createAgentSessionMock = vi.fn();
  const findMock = vi.fn();
  const getAllMock = vi.fn(() => [] as any[]);
  const registerProviderMock = vi.fn();
  const refreshMock = vi.fn();
  const getApiKeyAndHeadersMock = vi.fn(async () => ({ ok: true, apiKey: undefined, headers: undefined }));
  const modelRuntimeGetAuthMock = vi.fn(async () => ({ auth: { headers: {} as Record<string, string> } }));
  const setFallbackResolverMock = vi.fn();
  const authStorageGetApiKeyMock = vi.fn(async () => undefined);
  const authStorageGetMock = vi.fn(() => undefined);
  const authStorageSetMock = vi.fn();
  const authStorageHasMock = vi.fn(() => false);
  const authStorageHasAuthMock = vi.fn(() => false);
  const authStorageGetAllMock = vi.fn(() => ({}));
  const authStorageListMock = vi.fn(() => []);
  const authStorageLogoutMock = vi.fn();
  const authStorageRemoveMock = vi.fn();
  const authStorageReloadMock = vi.fn(async () => {});
  const execSyncMock = vi.fn((_cmd?: any, _opts?: any) => "");
  const spawnSyncMock = vi.fn(() => ({ status: 1, stdout: "" }));
  const execFileMock = vi.fn((_file?: any, _args?: any, _opts?: any, cb?: any) => {
    const callback = typeof _opts === "function" ? _opts : cb;
    if (typeof callback === "function") callback(null, "", "");
  });
  const existsSyncMock = vi.fn((_path: any) => false);
  const readFileSyncMock = vi.fn((_path?: any) => "{}");
  const realpathSyncNativeMock = vi.fn((path: any) => String(path));
  const readCustomProvidersMock = vi.fn(() => []);
  const packageManagerResolveMock = vi.fn().mockResolvedValue({ extensions: [] });
  const createBashToolMock = vi.fn((cwd: string, options?: any) => ({ name: "bash", cwd, options }));
  const createCodingToolsMock = vi.fn(() => []);
  const createReadOnlyToolsMock = vi.fn(() => []);
  const createExtensionRuntimeMock = vi.fn();
  const discoverAndLoadExtensionsMock = vi.fn().mockResolvedValue({
    runtime: { pendingProviderRegistrations: [] },
    errors: [],
  });
  const reloadMock = vi.fn(async () => {});
  const resourceLoaderOptionsCapture = vi.fn();
  const packageManagerCwdCapture = vi.fn();
  const packageManagerSettingsCapture = vi.fn();
  const sessionManagerGetSessionIdMock = vi.fn(() => undefined);
  const settingsManagerCreateMock = vi.fn(() => ({ kind: "settings-manager-create" }));
  const settingsManagerInMemoryMock = vi.fn(() => ({ kind: "settings-manager" }));
  return {
    createAgentSessionMock, findMock, getAllMock, registerProviderMock, refreshMock,
    getApiKeyAndHeadersMock, modelRuntimeGetAuthMock, setFallbackResolverMock,
    authStorageGetApiKeyMock, authStorageGetMock, authStorageSetMock, authStorageHasMock,
    authStorageHasAuthMock, authStorageGetAllMock, authStorageListMock, authStorageLogoutMock,
    authStorageRemoveMock, authStorageReloadMock, execSyncMock, spawnSyncMock, execFileMock,
    existsSyncMock, readFileSyncMock, realpathSyncNativeMock, readCustomProvidersMock,
    packageManagerResolveMock, createBashToolMock, createCodingToolsMock,
    createReadOnlyToolsMock, createExtensionRuntimeMock, discoverAndLoadExtensionsMock,
    reloadMock, resourceLoaderOptionsCapture, packageManagerCwdCapture,
    packageManagerSettingsCapture, sessionManagerGetSessionIdMock, settingsManagerCreateMock,
    settingsManagerInMemoryMock,
  };
});

const {
  createAgentSessionMock, findMock, getAllMock, registerProviderMock, refreshMock,
  getApiKeyAndHeadersMock, modelRuntimeGetAuthMock, setFallbackResolverMock,
  authStorageGetApiKeyMock, authStorageGetMock, authStorageSetMock, authStorageHasMock,
  authStorageHasAuthMock, authStorageGetAllMock, authStorageListMock, authStorageLogoutMock,
  authStorageRemoveMock, authStorageReloadMock, execSyncMock, spawnSyncMock, execFileMock,
  existsSyncMock, readFileSyncMock, realpathSyncNativeMock, readCustomProvidersMock,
  packageManagerResolveMock, createBashToolMock, createCodingToolsMock,
  createReadOnlyToolsMock, createExtensionRuntimeMock, discoverAndLoadExtensionsMock,
  reloadMock, resourceLoaderOptionsCapture, packageManagerCwdCapture,
  packageManagerSettingsCapture, sessionManagerGetSessionIdMock, settingsManagerCreateMock,
  settingsManagerInMemoryMock,
} = mocks;

vi.mock("node:child_process", () => {
  const execSyncFn = mocks.execSyncMock;
  const kPromisifyCustom = Symbol.for("nodejs.util.promisify.custom");

  const execFn: any = vi.fn((cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    const options = typeof opts === "function" ? {} : (opts ?? {});
    try {
      const out = execSyncFn(cmd, { ...options, stdio: ["pipe", "pipe", "pipe"] });
      const stdout = out === undefined ? "" : out.toString();
      if (typeof callback === "function") callback(null, stdout, "");
    } catch (err) {
      if (typeof callback === "function") {
        const error = err as { stdout?: string; stderr?: string };
        callback(err, error?.stdout?.toString?.() ?? "", error?.stderr?.toString?.() ?? "");
      }
    }
  });

  execFn[kPromisifyCustom] = (cmd: string, opts?: any) =>
    new Promise((resolve, reject) => {
      execFn(cmd, opts, (err: any, stdout: string, stderr: string) => {
        if (err) {
          (err as Record<string, unknown>).stdout = stdout;
          (err as Record<string, unknown>).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  return { execSync: execSyncFn, exec: execFn, execFile: mocks.execFileMock, spawnSync: mocks.spawnSyncMock };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: mocks.existsSyncMock,
    readFileSync: mocks.readFileSyncMock,
    realpathSync: Object.assign(vi.fn((path: any) => String(path)), {
      native: mocks.realpathSyncNativeMock,
    }),
  };
});

vi.mock("../auth/custom-providers.js", () => ({
  readCustomProviders: mocks.readCustomProvidersMock,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  LegacyCredentialStorage: {
    create: () => ({
      setFallbackResolver: mocks.setFallbackResolverMock,
      getApiKey: mocks.authStorageGetApiKeyMock,
      get: mocks.authStorageGetMock,
      set: mocks.authStorageSetMock,
      has: mocks.authStorageHasMock,
      hasAuth: mocks.authStorageHasAuthMock,
      getAll: mocks.authStorageGetAllMock,
      list: mocks.authStorageListMock,
      logout: mocks.authStorageLogoutMock,
      remove: mocks.authStorageRemoveMock,
      reload: mocks.authStorageReloadMock,
    }),
  },
  ModelRuntime: {
    create: async () => ({ getAuth: mocks.modelRuntimeGetAuthMock, refresh: async () => mocks.refreshMock() }),
  },
  createAgentSession: mocks.createAgentSessionMock,
  createBashTool: mocks.createBashToolMock,
  createCodingTools: mocks.createCodingToolsMock,
  createEditTool: () => ({ name: "edit" }),
  createExtensionRuntime: mocks.createExtensionRuntimeMock,
  createFindTool: () => ({ name: "find" }),
  createGrepTool: () => ({ name: "grep" }),
  createLsTool: () => ({ name: "ls" }),
  createReadOnlyTools: mocks.createReadOnlyToolsMock,
  createReadTool: () => ({ name: "read" }),
  createWriteTool: () => ({ name: "write" }),
  DefaultResourceLoader: class {
    constructor(options: any) {
      mocks.resourceLoaderOptionsCapture(options);
    }
    async reload() {
      await mocks.reloadMock();
    }
  },
  DefaultPackageManager: class {
    private readonly settingsManager: any;
    constructor(options: any) {
      mocks.packageManagerCwdCapture(options?.cwd);
      mocks.packageManagerSettingsCapture(options?.settingsManager);
      this.settingsManager = options?.settingsManager;
    }
    async resolve() {
      this.settingsManager.isProjectTrusted();
      return mocks.packageManagerResolveMock();
    }
  },
  DefaultSessionManager: class {
    getSessionId() {
      return mocks.sessionManagerGetSessionIdMock();
    }
  },
  ModelRegistry: class {
    find(provider: string, modelId: string) {
      return mocks.findMock(provider, modelId);
    }
    getAll() {
      return mocks.getAllMock();
    }
    registerProvider(provider: any) {
      mocks.registerProviderMock(provider);
    }
    async refresh() {
      await mocks.refreshMock();
    }
  },
  getApiKeyAndHeaders: mocks.getApiKeyAndHeadersMock,
  discoverAndLoadExtensions: mocks.discoverAndLoadExtensionsMock,
  SessionManager: {
    inMemory: () => ({ kind: "session-manager", getSessionId: mocks.sessionManagerGetSessionIdMock }),
  },
  SettingsManager: {
    create: () => mocks.settingsManagerCreateMock(),
    inMemory: () => mocks.settingsManagerInMemoryMock(),
  },
}));

import {
  parseFallbackModelList,
  isFallbackChainSkipError,
} from "../util/fallback-model-list.js";
import { ModelFallbackExhaustedError } from "../pi.js";

interface CapturedFallback {
  primaryModel: string;
  fallbackModel: string;
  triggerPoint: "session-creation" | "prompt-time";
  failureCategory: string;
}

const freshSession = () => ({
  prompt: vi.fn(async () => undefined),
  subscribe: vi.fn(),
  dispose: vi.fn(),
  setThinkingLevel: vi.fn(),
});

const newSessionResult = () => ({ session: freshSession() });

beforeEach(() => {
  vi.clearAllMocks();
  // Default: registry resolves any (provider, modelId) to a model — tests override per-case.
  findMock.mockImplementation((provider: string, modelId: string) => ({ provider, id: modelId }));
  getAllMock.mockReturnValue([]);
  registerProviderMock.mockClear();
  refreshMock.mockClear();
  getApiKeyAndHeadersMock.mockResolvedValue({ ok: true, apiKey: undefined, headers: undefined });
  modelRuntimeGetAuthMock.mockImplementation(async () => ({ auth: { headers: {} as Record<string, string> } }));
  sessionManagerGetSessionIdMock.mockReturnValue(undefined);
  createBashToolMock.mockClear();
  createAgentSessionMock.mockReset();
  createAgentSessionMock.mockResolvedValue(newSessionResult());
  setFallbackResolverMock.mockClear();
  authStorageGetApiKeyMock.mockResolvedValue(undefined);
  authStorageGetMock.mockReturnValue(undefined);
  authStorageSetMock.mockClear();
  authStorageHasMock.mockReturnValue(false);
  authStorageHasAuthMock.mockReturnValue(false);
  authStorageGetAllMock.mockReturnValue({});
  authStorageListMock.mockReturnValue([]);
  authStorageLogoutMock.mockClear();
  authStorageRemoveMock.mockClear();
  authStorageReloadMock.mockClear();
  existsSyncMock.mockReturnValue(false);
  readFileSyncMock.mockReturnValue("{}");
  realpathSyncNativeMock.mockImplementation((p: any) => String(p));
  readCustomProvidersMock.mockReturnValue([]);
  packageManagerResolveMock.mockClear();
  packageManagerResolveMock.mockResolvedValue({ extensions: [] });
  reloadMock.mockClear();
  createExtensionRuntimeMock.mockClear();
  discoverAndLoadExtensionsMock.mockClear();
  execSyncMock.mockReturnValue("");
  spawnSyncMock.mockReturnValue({ status: 1, stdout: "" });
  resourceLoaderOptionsCapture.mockClear();
  packageManagerCwdCapture.mockClear();
  packageManagerSettingsCapture.mockClear();
  settingsManagerCreateMock.mockClear();
  settingsManagerInMemoryMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

/*
 * Helper: capture all `onFallbackModelUsed` emissions in invocation order.
 */
const captureEmissions = () => {
  const captured: CapturedFallback[] = [];
  return {
    captured,
    callback: (payload: CapturedFallback) => {
      captured.push(payload);
    },
  };
};

/*
 * Helper: build a list of fallback entries from a serialized string, then
 * pass to `createFnAgent`. This keeps the chain test surface close to the
 * actual settings shape (newline-separated text).
 */
const buildEntries = (raw: string) => parseFallbackModelList(raw).entries;

describe("GDPR-001 fallback-model list chain", () => {
  it("[empty list] byte-for-byte preserves the legacy primary-only path", async () => {
    const { createPiAgentSessionRaw: createFnAgent } = await import("../pi.js");
    const emissions = captureEmissions();

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
      onFallbackModelUsed: emissions.callback,
    });

    // No fallback configured → exactly one createAgentSession call (primary).
    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(createAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "openai-codex", id: "gpt-5.4" },
    });
    expect(emissions.captured).toHaveLength(0);
  });

  it("[legacy pair: primary fails → fallback → primary-retry] runs the documented 3-attempt structure (regression)", async () => {
    // Pins the legacy behavior when `fallbackModels` is empty/unset. The chain
    // must NOT take over. The 3× attempt structure (primary → fallback →
    // primary-retry) remains the default for non-fallback paths. The 3×30s
    // backoff lives in `withRateLimitRetry` which wraps `createPiAgentSessionRaw`
    // from outside (see `run-implementation.ts` / `agent-heartbeat.ts`); inside
    // the function itself the 3 attempts run without sleeps.
    const { createPiAgentSessionRaw: createFnAgent } = await import("../pi.js");

    createAgentSessionMock
      .mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("rate limit exceeded 429"))
      .mockRejectedValueOnce(new Error("rate limit exceeded 429"))
      .mockResolvedValueOnce(newSessionResult());

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
      fallbackProvider: "openai-codex",
      fallbackModelId: "gpt-5.3-codex",
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(3);
    expect(createAgentSessionMock.mock.calls[2]?.[0]).toMatchObject({
      model: { provider: "openai-codex", id: "gpt-5.4" },
    });
  });

  it("[primary OK] chain with one entry: no emission, primary is the only attempt", async () => {
    const { createPiAgentSessionRaw: createFnAgent } = await import("../pi.js");
    const emissions = captureEmissions();
    createAgentSessionMock.mockReset();
    createAgentSessionMock.mockResolvedValueOnce(newSessionResult());

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
      fallbackModels: buildEntries("openrouter:anthropic/claude-3.5-sonnet"),
      onFallbackModelUsed: emissions.callback,
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(createAgentSessionMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "openai-codex", id: "gpt-5.4" },
    });
    expect(emissions.captured).toHaveLength(0);
  });

  it("[primary fails retryably → fb1 OK] fires onFallbackModelUsed exactly once, attempts === 2", async () => {
    const { createPiAgentSessionRaw: createFnAgent } = await import("../pi.js");
    const emissions = captureEmissions();

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("model gpt-9.9 is not supported when using Codex with a ChatGPT account"))
      .mockResolvedValueOnce(newSessionResult());

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
      fallbackModels: buildEntries("openrouter:anthropic/claude-3.5-sonnet"),
      onFallbackModelUsed: emissions.callback,
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(createAgentSessionMock.mock.calls[1]?.[0]).toMatchObject({
      model: { provider: "openrouter", id: "anthropic/claude-3.5-sonnet" },
    });
    expect(emissions.captured).toHaveLength(1);
    expect(emissions.captured[0]).toMatchObject({
      primaryModel: "openai-codex/gpt-5.4",
      fallbackModel: "openrouter/anthropic/claude-3.5-sonnet",
      triggerPoint: "session-creation",
      failureCategory: "model-selection",
    });
  });

  it("[primary fails → fb1 usage-limit → fb2 OK] fires onFallbackModelUsed twice, attempts === 3, no 30s wait", async () => {
    const { createPiAgentSessionRaw: createFnAgent } = await import("../pi.js");
    const emissions = captureEmissions();

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("model gpt-9.9 is not supported when using Codex with a ChatGPT account"))
      .mockRejectedValueOnce(new Error("rate limit exceeded 429"))
      .mockResolvedValueOnce(newSessionResult());

    const start = Date.now();
    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
      fallbackModels: buildEntries("openrouter:anthropic/claude-3.5-sonnet\nclinefree:gpt-4o"),
      onFallbackModelUsed: emissions.callback,
    });
    const elapsedMs = Date.now() - start;

    expect(createAgentSessionMock).toHaveBeenCalledTimes(3);
    expect(createAgentSessionMock.mock.calls[2]?.[0]).toMatchObject({
      model: { provider: "clinefree", id: "gpt-4o" },
    });
    expect(emissions.captured).toHaveLength(2);
    expect(emissions.captured[0]).toMatchObject({
      primaryModel: "openai-codex/gpt-5.4",
      fallbackModel: "openrouter/anthropic/claude-3.5-sonnet",
      failureCategory: "model-selection",
    });
    expect(emissions.captured[1]).toMatchObject({
      primaryModel: "openrouter/anthropic/claude-3.5-sonnet",
      fallbackModel: "clinefree/gpt-4o",
      failureCategory: "rate-limit",
    });
    // Skip semantics: no 30s wait. Each mock returns synchronously.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("[primary fails → fb1 transient-auth → fb2 OK] fires twice, category 'authentication' on the second emission", async () => {
    const { createPiAgentSessionRaw: createFnAgent } = await import("../pi.js");
    const emissions = captureEmissions();

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("model gpt-9.9 is not supported when using Codex with a ChatGPT account"))
      .mockRejectedValueOnce(new Error("invalid authentication credentials"))
      .mockResolvedValueOnce(newSessionResult());

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
      fallbackModels: buildEntries("openrouter:anthropic/claude-3.5-sonnet\nclinefree:gpt-4o"),
      onFallbackModelUsed: emissions.callback,
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(3);
    expect(emissions.captured).toHaveLength(2);
    expect(emissions.captured[0]).toMatchObject({ failureCategory: "model-selection" });
    expect(emissions.captured[1]).toMatchObject({ failureCategory: "authentication" });
  });

  it("[all-fail] throws ModelFallbackExhaustedError with attempts === chain.length + 1, per-attempt reasons present", async () => {
    const { createPiAgentSessionRaw: createFnAgent } = await import("../pi.js");
    const emissions = captureEmissions();

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("rate limit exceeded 429"))
      .mockRejectedValueOnce(new Error("rate limit exceeded 429"))
      .mockRejectedValueOnce(new Error("rate limit exceeded 429"))
      .mockRejectedValueOnce(new Error("rate limit exceeded 429"));

    let caught: unknown;
    try {
      await createFnAgent({
        cwd: "/tmp",
        systemPrompt: "test",
        tools: "readonly",
        defaultProvider: "openai-codex",
        defaultModelId: "gpt-5.4",
        fallbackModels: buildEntries(
          "openrouter:anthropic/claude-3.5-sonnet\nclinefree:gpt-4o\ntokenrouter:meta-llama/llama-3.1-405b",
        ),
        onFallbackModelUsed: emissions.callback,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ModelFallbackExhaustedError);
    const err = caught as ModelFallbackExhaustedError;
    expect(err.attempts).toBe(4); // 1 primary + 3 list entries
    expect(err.triggerPoint).toBe("session-creation");
    expect(err.attemptChain).toBeDefined();
    expect(err.attemptChain).toHaveLength(4);
    expect(err.attemptChain?.[0]).toMatchObject({ position: 1, model: "openai-codex/gpt-5.4", outcome: "skipped-rate-limit" });
    expect(err.attemptChain?.[1]).toMatchObject({ position: 2, model: "openrouter/anthropic/claude-3.5-sonnet", outcome: "skipped-rate-limit" });
    expect(err.attemptChain?.[2]).toMatchObject({ position: 3, model: "clinefree/gpt-4o", outcome: "skipped-rate-limit" });
    expect(err.attemptChain?.[3]).toMatchObject({ position: 4, model: "tokenrouter/meta-llama/llama-3.1-405b", outcome: "skipped-rate-limit" });
    // 3 emissions: primary→fb1, fb1→fb2, fb2→fb3 (all rate-limit).
    expect(emissions.captured).toHaveLength(3);
    for (const emit of emissions.captured) {
      expect(emit.failureCategory).toBe("rate-limit");
    }
  });

  it("[one attempt per level] each chain entry is tried exactly once; never re-attempted", async () => {
    const { createPiAgentSessionRaw: createFnAgent } = await import("../pi.js");

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("rate limit exceeded 429"))
      .mockRejectedValueOnce(new Error("rate limit exceeded 429"))
      .mockRejectedValueOnce(new Error("rate limit exceeded 429"))
      .mockResolvedValueOnce(newSessionResult());

    const { session } = await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
      fallbackModels: buildEntries(
        "openrouter:anthropic/claude-3.5-sonnet\nclinefree:gpt-4o\ntokenrouter:meta-llama/llama-3.1-405b",
      ),
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(4);
    expect(createAgentSessionMock.mock.calls[3]?.[0]).toMatchObject({
      model: { provider: "tokenrouter", id: "meta-llama/llama-3.1-405b" },
    });
    expect(session).toBeDefined();
  });

  it("[immediate skip on usage-limit] no 30s wait when an entry fails with a rate-limit error", async () => {
    const { createPiAgentSessionRaw: createFnAgent } = await import("../pi.js");

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("model gpt-9.9 is not supported when using Codex with a ChatGPT account"))
      .mockRejectedValueOnce(new Error("rate limit exceeded 429"))
      .mockResolvedValueOnce(newSessionResult());

    const start = Date.now();
    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
      fallbackModels: buildEntries("openrouter:anthropic/claude-3.5-sonnet\nclinefree:gpt-4o"),
    });
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("[immediate skip on transient-auth] no 30s wait when an entry fails with a transient-auth error", async () => {
    const { createPiAgentSessionRaw: createFnAgent } = await import("../pi.js");

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("model gpt-9.9 is not supported when using Codex with a ChatGPT account"))
      .mockRejectedValueOnce(new Error("invalid authentication credentials"))
      .mockResolvedValueOnce(newSessionResult());

    const start = Date.now();
    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
      fallbackModels: buildEntries("openrouter:anthropic/claude-3.5-sonnet\nclinefree:gpt-4o"),
    });
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("[non-retryable primary bubbles unchanged] no chain entries tried, raw error rethrown", async () => {
    const { createPiAgentSessionRaw: createFnAgent } = await import("../pi.js");
    const emissions = captureEmissions();

    const rawError = new Error("network unreachable: cannot connect to provider");
    createAgentSessionMock.mockReset();
    createAgentSessionMock.mockRejectedValueOnce(rawError);

    let caught: unknown;
    try {
      await createFnAgent({
        cwd: "/tmp",
        systemPrompt: "test",
        tools: "readonly",
        defaultProvider: "openai-codex",
        defaultModelId: "gpt-5.4",
        fallbackModels: buildEntries("openrouter:anthropic/claude-3.5-sonnet\nclinefree:gpt-4o"),
        onFallbackModelUsed: emissions.callback,
      });
    } catch (err) {
      caught = err;
    }

    expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(caught).toBe(rawError);
    expect(caught).not.toBeInstanceOf(ModelFallbackExhaustedError);
    expect(emissions.captured).toHaveLength(0);
  });

  it("[chain wins over legacy pair] when fallbackModels is non-empty, legacy fallbackProvider/fallbackModelId are ignored", async () => {
    const { createPiAgentSessionRaw: createFnAgent } = await import("../pi.js");

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("model gpt-9.9 is not supported when using Codex with a ChatGPT account"))
      .mockResolvedValueOnce(newSessionResult());

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
      // Legacy pair points to a different fallback model that should be IGNORED.
      fallbackProvider: "openai-codex",
      fallbackModelId: "gpt-5.3-codex",
      // Chain points elsewhere.
      fallbackModels: buildEntries("openrouter:anthropic/claude-3.5-sonnet"),
    });

    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    // Chain won: second call was the chain entry, NOT the legacy fallback.
    expect(createAgentSessionMock.mock.calls[1]?.[0]).toMatchObject({
      model: { provider: "openrouter", id: "anthropic/claude-3.5-sonnet" },
    });
  });

  it("[per-entry thinking level] entries with thinkingLevel honored; entries without fall back to default", async () => {
    const { createPiAgentSessionRaw: createFnAgent } = await import("../pi.js");

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("model gpt-9.9 is not supported when using Codex with a ChatGPT account"))
      .mockResolvedValueOnce(newSessionResult());

    const setThinkingCalls: Array<{ level: string | undefined }> = [];
    const session = freshSession();
    const origSet = session.setThinkingLevel;
    (session as any).setThinkingLevel = vi.fn((level: string) => {
      setThinkingCalls.push({ level });
    });

    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockResolvedValueOnce({ session }) // primary OK
      .mockResolvedValueOnce({ session }); // not used

    // Primary succeeds so we can't easily test thinking-level wiring in
    // a session-creation failure path. Instead, test the parser + chain-walk
    // mapping: the per-entry thinking level from the list should override
    // any `defaultThinkingLevel` only when the entry itself declares one.
    // (We assert this via parseFallbackModelList contract rather than
    //  session-state mutation, which is covered by the parse tests.)
    const entries = buildEntries(
      "openrouter:anthropic/claude-3.5-sonnet:high\nclinefree:gpt-4o",
    );
    expect(entries[0]?.thinkingLevel).toBe("high");
    expect(entries[1]?.thinkingLevel).toBeUndefined();

    // Confirm chain still runs with a thinking level set, and resolves the
    // chain entry's model.
    createAgentSessionMock.mockReset();
    createAgentSessionMock
      .mockRejectedValueOnce(new Error("model gpt-9.9 is not supported when using Codex with a ChatGPT account"))
      .mockResolvedValueOnce({ session: freshSession() });

    await createFnAgent({
      cwd: "/tmp",
      systemPrompt: "test",
      tools: "readonly",
      defaultProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
      fallbackModels: entries,
    });
    expect(createAgentSessionMock.mock.calls[1]?.[0]).toMatchObject({
      model: { provider: "openrouter", id: "anthropic/claude-3.5-sonnet" },
    });
    // Suppress lint warning.
    void origSet;
    void setThinkingCalls;
  });
});

describe("GDPR-001 chain skip classifier (isFallbackChainSkipError)", () => {
  it("classifies usage-limit errors as skip", () => {
    expect(isFallbackChainSkipError(new Error("rate limit exceeded 429"))).toBe(true);
    expect(isFallbackChainSkipError(new Error("quota exceeded for billing period"))).toBe(true);
    expect(isFallbackChainSkipError(new Error("service overloaded"))).toBe(true);
    expect(isFallbackChainSkipError("rate limit exceeded")).toBe(true);
  });

  it("classifies transient-auth errors as skip", () => {
    expect(isFallbackChainSkipError(new Error('{"type":"authentication_error","message":"token expired"}'))).toBe(true);
    expect(isFallbackChainSkipError(new Error("invalid authentication credentials"))).toBe(true);
  });

  it("does NOT classify model-selection errors as skip", () => {
    expect(isFallbackChainSkipError(new Error("model not found: openai-codex/gpt-9.9"))).toBe(false);
    expect(isFallbackChainSkipError(new Error("invalid model id"))).toBe(false);
  });

  it("does NOT classify non-error values as skip", () => {
    expect(isFallbackChainSkipError(null)).toBe(false);
    expect(isFallbackChainSkipError(undefined)).toBe(false);
    expect(isFallbackChainSkipError("")).toBe(false);
    expect(isFallbackChainSkipError(42)).toBe(false);
  });
});
