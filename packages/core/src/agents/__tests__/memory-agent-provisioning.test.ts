import { describe, expect, it, vi } from "vitest";
import { AgentStore } from "../agent-store.js";
import { BUILTIN_MEMORY_AGENT_FALLBACK_NAME, BUILTIN_MEMORY_AGENT_NAME, BUILTIN_MEMORY_AGENT_PROVENANCE_KEY } from "../memory-agent-defaults.js";
import type { Agent } from "../../types/agents/agents.js";

const agent = (name: string, metadata: Record<string, unknown> = {}): Agent => ({ id: name.toLowerCase().replaceAll(/[^a-z]/g, ""), name, role: "custom", roles: ["custom"], state: "idle", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", metadata, runtimeConfig: { enabled: true } } as Agent);
function fakeStore(agents: Agent[]) {
  const store = new AgentStore({ rootDir: process.cwd() }); const self = store as unknown as Record<string, unknown>;
  self.listAgents = vi.fn(async () => agents);
  self.findAgentByName = vi.fn(async (name: string) => agents.find((item) => item.name === name) ?? null);
  self.createAgent = vi.fn(async (input: { name: string }) => { const created = agent(input.name, { [BUILTIN_MEMORY_AGENT_PROVENANCE_KEY]: true }); agents.push(created); return created; });
  self.writeAgent = vi.fn(async () => undefined);
  return store as AgentStore & { createAgent: ReturnType<typeof vi.fn>; writeAgent: ReturnType<typeof vi.fn> };
}

describe("Memory Keeper provisioning", () => {
  it("creates exactly one custom, heartbeat-enabled owner", async () => {
    const store = fakeStore([]); const first = await store.provisionBuiltinMemoryAgent(); const second = await store.provisionBuiltinMemoryAgent();
    expect(first?.id).toBe(second?.id); expect(store.createAgent).toHaveBeenCalledTimes(1);
    expect(store.createAgent).toHaveBeenCalledWith(expect.objectContaining({ name: BUILTIN_MEMORY_AGENT_NAME, roles: ["custom"], runtimeConfig: expect.objectContaining({ enabled: true, autoClaimRelevantTasks: false, heartbeatIntervalMs: 3_600_000 }) }), undefined);
  });
  it("does not adopt an operator agent with the canonical name", async () => {
    const operator = agent(BUILTIN_MEMORY_AGENT_NAME); const store = fakeStore([operator]);
    await store.provisionBuiltinMemoryAgent();
    expect(operator.name).toBe(BUILTIN_MEMORY_AGENT_NAME); expect(store.createAgent).toHaveBeenCalledWith(expect.objectContaining({ name: BUILTIN_MEMORY_AGENT_FALLBACK_NAME }), undefined);
  });
  it("degrades safely when both reserved names are occupied", async () => {
    const store = fakeStore([agent(BUILTIN_MEMORY_AGENT_NAME), agent(BUILTIN_MEMORY_AGENT_FALLBACK_NAME)]);
    await expect(store.provisionBuiltinMemoryAgent()).resolves.toBeNull(); expect(store.createAgent).not.toHaveBeenCalled();
  });
});
