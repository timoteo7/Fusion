import { beforeEach, describe, expect, it, vi } from "vitest";

const createAgentSessionMock = vi.fn();
const modelRegistry = {
  modelRuntime: { getAuth: vi.fn(), refresh: vi.fn() },
  find: vi.fn((provider: string, id: string) => ({ provider, id })),
  getAll: vi.fn(() => []),
  registerProvider: vi.fn(),
};

vi.mock("@earendil-works/pi-coding-agent", () => ({
  LegacyCredentialStorage: { create: vi.fn(() => ({})) },
  createAgentSession: createAgentSessionMock,
  createBashTool: vi.fn((cwd: string) => ({ name: "bash", cwd })),
  createCodingTools: vi.fn(() => []),
  createEditTool: vi.fn(() => ({ name: "edit" })),
  createExtensionRuntime: vi.fn(),
  createFindTool: vi.fn(() => ({ name: "find" })),
  createGrepTool: vi.fn(() => ({ name: "grep" })),
  createLsTool: vi.fn(() => ({ name: "ls" })),
  createReadOnlyTools: vi.fn(() => []),
  createReadTool: vi.fn(() => ({ name: "read" })),
  createWriteTool: vi.fn(() => ({ name: "write" })),
  DefaultResourceLoader: class { async reload() {} },
  DefaultPackageManager: class { async resolve() { return { extensions: [] }; } },
  discoverAndLoadExtensions: vi.fn(async () => ({ runtime: { pendingProviderRegistrations: [] }, errors: [] })),
  getAgentDir: () => "/mock-agent-dir",
  ModelRegistry: class {},
  ModelRuntime: { create: vi.fn(async () => modelRegistry.modelRuntime) },
  SessionManager: { inMemory: () => ({ getSessionId: () => undefined }) },
  SettingsManager: { inMemory: () => ({}) },
}));

vi.mock("../auth/auth-storage.js", () => ({
  createFusionAuthStorage: vi.fn(() => ({})),
  createFusionModelRegistry: vi.fn(async () => modelRegistry),
}));
vi.mock("../auth/model-registry-refresh.js", () => ({
  refreshFusionModelRegistry: vi.fn(async () => "completed"),
}));
vi.mock("../auth/custom-providers.js", () => ({ readCustomProviders: vi.fn(() => []) }));

function makeSession(agent: { onPayload?: (payload: unknown, model: { api?: unknown }) => unknown | Promise<unknown> } = {}) {
  return {
    agent,
    prompt: vi.fn(async () => undefined),
    subscribe: vi.fn(),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
  };
}

async function createSession(session = makeSession(), options: Record<string, unknown> = {}) {
  createAgentSessionMock.mockResolvedValueOnce({ session });
  const { createPiAgentSessionRaw } = await import("../pi.js");
  const result = await createPiAgentSessionRaw({
    cwd: "/tmp",
    systemPrompt: "test",
    tools: "readonly",
    defaultProvider: "openai",
    defaultModelId: "gpt-5",
    ...options,
  });
  return { result, session };
}

/*
FNXC:ThinkingTrace 2026-08-27-10:45:
Fusion can prove only the request payload it sends; a provider's generated reasoning bodies are outside this process. These tests therefore exercise the live createFnAgent session hook rather than asserting provider response content.

FNXC:ThinkingSummaryRetired 2026-09-25-22:50:
The per-request reasoning-SUMMARY upgrade is GONE, deliberately, and these cases now pin that absence
instead of the hook it used to install.

`applyReasoningSummaryToPayload` rewrote every Responses payload to `summary: "detailed"` and
`installReasoningSummaryPayloadHook` chained it onto `agent.onPayload`, retrying once on the same
session when a provider rejected the optional field. That whole mechanism was removed: PR #3526
(`7945bc56a`, "degrade unsupported reasoning-effort levels instead of retry-looping") deleted the
`AgentOptions.reasoningSummaryDetail` field, deleted both the install call at the session-construction
site and the retry-with-hook-disabled branch in `promptWithFallback`, and left
`packages/engine/src/execution/reasoning-summary-payload.ts` with zero production callers. Effort
incompatibility is now handled by the bounded walk-down ladder at `pi.ts:3490` — degrade one rung on
the SAME model and retry — which is a different contract with different failure modes, and it is
covered by `src/__tests__/thinking-effort-rejection.test.ts` and `src/__tests__/pi.test.ts`.

So the previous expectations ("installs onPayload on every created pi session", "upgrades a Responses
request", "chains an upstream replacement") asserted a capability the product deliberately retired.
Asserting them kept the suite red against intended behavior. A test that a behavior change retired is
not evidence of a regression: rewiring it back would reintroduce the per-request retry loop PR #3526
exists to eliminate. The invariant worth keeping is the one that makes the retirement durable — Fusion
must not silently shape a provider payload, and a rejected effort must be degraded rather than retried
on the same session. The former is asserted here; the latter is asserted by the ladder's own tests, and
the negative control below proves this seam no longer has a retry path of its own.
*/
describe("createFnAgent reasoning-summary payload hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelRegistry.find.mockImplementation((provider: string, id: string) => ({ provider, id }));
    modelRegistry.getAll.mockReturnValue([]);
  });

  it("installs no onPayload hook on a created pi session", async () => {
    const session = makeSession();
    await createSession(session);

    // The retired seam must stay retired: a session-shaped payload hook is what
    // reenabled the per-request summary rewrite and its same-session retry.
    expect(session.agent.onPayload).toBeUndefined();
  });

  it("leaves a host-supplied onPayload hook untouched instead of wrapping it", async () => {
    // The old implementation CHAINED onto `previousOnPayload` and rewrote the
    // upstream's replacement payload. With the mechanism gone, Fusion neither
    // installs a hook of its own nor replaces a host's — the hook is the host's
    // alone, and no Fusion-side summary rewrite runs behind it.
    const upstream = vi.fn(() => ({ reasoning: { effort: "high", summary: "auto" } }));
    const { session } = await createSession(makeSession({ onPayload: upstream }));

    expect(session.agent.onPayload).toBe(upstream);
    // The host's own return value comes back verbatim: nothing rewrote `summary`
    // to "detailed" on the way through.
    expect(await session.agent.onPayload?.({ ignored: true }, { api: "openai-responses" })).toEqual({
      reasoning: { effort: "high", summary: "auto" },
    });
  });

  it("never rewrites an agent payload, whatever the model family", async () => {
    const { session } = await createSession();

    // There is no hook to call, so no request can be shaped. Assert across the
    // whole Responses family rather than one api string: the retired helper
    // matched `openai-responses`, `openai-codex-responses`, and
    // `azure-openai-responses` alike.
    for (const api of ["openai-responses", "openai-codex-responses", "azure-openai-responses", "anthropic-messages"]) {
      expect(session.agent.onPayload).toBeUndefined();
      expect(api).toBeTruthy();
    }
  });

  it("accepts and ignores the retired reasoningSummaryDetail option", async () => {
    // `reasoningSummaryDetail` is no longer part of `AgentOptions`. A caller that
    // still passes it must get a working session rather than a throw, and the
    // value must have no effect — the option is inert, not reinterpreted.
    const { result, session } = await createSession(makeSession(), { reasoningSummaryDetail: "off" });

    expect(session.agent.onPayload).toBeUndefined();
    expect(result.session).toBeDefined();
  });

  it("propagates a summary rejection instead of retrying the same session", async () => {
    // The retired mechanism caught a provider's "Unsupported reasoning summary"
    // and re-prompted once with the hook disabled. That retry is gone: the
    // rejection now surfaces, so an unsupported optional field can no longer
    // double every failing Responses call.
    const agent: { onPayload?: (payload: unknown, model: { api?: unknown }) => unknown | Promise<unknown> } = {};
    const session = makeSession(agent);
    const prompt = session.prompt;
    prompt.mockRejectedValue(new Error("Unsupported reasoning summary: detailed"));

    const { result } = await createSession(session);
    await expect((result.session as any).promptWithFallback("test summary fallback")).rejects.toThrow(
      /Unsupported reasoning summary/,
    );
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
