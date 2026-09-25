// @vitest-environment node

/*
FNXC:EvolutionStoreLayout 2026-09-25-12:10:
Production-path proof that an operator approval actually reaches the artifact it approves.

The suite next door (register-approval-routes.test.ts) mocks `@fusion/core`, and its
FakeEvolutionStore ignores its constructor `rootDir` and returns a canned value. That is fine for
asserting the bridge's branching, but it is exactly why the split-brain layout shipped green: the
engine and the CLI constructed the store from the PROJECT root (`<projectRoot>/evolution`) while
this bridge read `getFusionDir()` (`<projectRoot>/.fusion/evolution`). Two different directories,
two green test suites, and an apply gate that could never pass its `approval-pending` check.

This file therefore runs the bridge against the REAL `EvolutionStore` over a REAL temp directory
and asserts the end-to-end transition: cycle writes artifact v1 as `pending` -> the operator
approves via POST /api/approvals/:id/decision -> the artifact on disk becomes `approved`. Only
`ApprovalRequestStore`/`AgentStore` are faked (they need an async layer); the evolution store is
not, so a path disagreement fails here instead of in production.
*/

import { mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";

import type { AppendEvolutionArtifactInput, TaskStore } from "@fusion/core";

const approvalState = vi.hoisted(() => ({
  requests: new Map<string, Record<string, unknown>>(),
  decide: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const { createCoreMock } = await import("../../test/mockCoreEngine.js");
  return createCoreMock(() => importOriginal<Record<string, unknown>>(), {
    // Only the layer-bound stores are faked. `EvolutionStore` is deliberately NOT overridden:
    // it must be the real one, rooted at a real directory, or this test proves nothing.
    ApprovalRequestStore: class FakeApprovalRequestStore {
      constructor(..._args: unknown[]) {}
      async get(id: string) { return approvalState.requests.get(id); }
      async decide(id: string, status: string, input: unknown) { return approvalState.decide(id, status, input); }
      async getAuditHistory() { return []; }
      async list() { return []; }
      async findLatestByDedupeKey() { return undefined; }
    },
    AgentStore: class FakeAgentStore {
      constructor(..._args: unknown[]) {}
      async init() {}
      async getAgent() { return undefined; }
      async updateAgentState() {}
      async updateAgent() {}
    },
  });
});

const { EvolutionStore } = await import("@fusion/core");
const { createApiRoutes } = await import("../../routes.js");
const { request: REQUEST } = await import("../../test-request.js");

const REQUEST_ID = "AR-EVO-1";
const AGENT_ID = "agent-1";

function makeArtifactInput(): AppendEvolutionArtifactInput {
  const candidate = {
    changeType: "instructions" as const,
    target: "agent/soul.md",
    changeSummary: "Clarify that approval is required before any self-edit.",
    proposedDiff: "- mutate freely\n+ request approval before mutating",
    checksum: "",
  };
  return {
    agentId: AGENT_ID,
    trigger: "manual",
    event: { summary: "Improve approval-first behavior", taskIds: ["GDPR-075"] },
    evidence: { signals: ["evolution-signal-1"] },
    hypothesis: "Per-task reviews show unapproved self-edits; gate them.",
    candidate: { ...candidate, checksum: "" },
    trial: {
      baselineRun: { command: "pnpm test", passed: true, metrics: { passRate: 0.9 } },
      candidateRun: { command: "pnpm test", passed: true, metrics: { passRate: 0.95 } },
      decisions: ["all-gate-checks-pass"],
      decision: "keep",
      rationale: "Candidate beats baseline on the primary metric.",
    },
  };
}

describe("POST /api/approvals/:id/decision — Evolution approval against a real store", () => {
  let projectRoot: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    approvalState.requests.clear();
    approvalState.decide.mockReset();
    // The store is shared across tests, so its audit spy must be reset explicitly or the
    // projection assertion would pass on a row recorded by an earlier test.
    vi.mocked(store.recordRunAuditEvent).mockClear();
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `fusion-evolution-bridge-${randomUUID().slice(0, 6)}-`));
    cleanup.push(dir);
    return dir;
  }

  /** Write a real artifact the way the cycle does: append, then mark it pending. */
  async function seedPendingArtifact(root: string) {
    const store = EvolutionStore.forProject(root);
    await store.init();
    const artifact = await store.appendArtifact(makeArtifactInput());
    const pending = await store.markApprovalState(AGENT_ID, artifact.version, {
      status: "pending",
      approvalRequestId: REQUEST_ID,
    });
    expect(pending?.approval.status).toBe("pending");
    return artifact;
  }

  function setEvolutionRequest(artifactVersion: number) {
    const request = {
      id: REQUEST_ID,
      status: "pending",
      requester: { actorId: `evolution:${AGENT_ID}`, actorType: "system", actorName: "Evolution cycle" },
      requestedAt: "2026-09-25T00:00:00.000Z",
      createdAt: "2026-09-25T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z",
      targetAction: {
        category: "task_agent_mutation",
        action: "apply",
        summary: `Apply reviewed evolution candidate for ${AGENT_ID}`,
        resourceType: "evolution-artifact",
        resourceId: "artifact-1",
        context: {
          source: "evolution-cycle",
          artifactId: "artifact-1",
          artifactVersion,
          agentId: AGENT_ID,
          trialDecision: "keep",
        },
      },
    };
    approvalState.requests.set(REQUEST_ID, request);
    approvalState.decide.mockImplementation(async (id: string, status: string) => ({
      ...request,
      id,
      status,
      decidedAt: "2026-09-25T00:00:01.000Z",
    }));
    return request;
  }

  function makeApp(store: TaskStore) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, {} as never));
    return app;
  }

  let currentRoot = "";
  function makeStore(): TaskStore {
    return {
      // The bridge resolves the PROJECT root and owns the `.fusion` layout itself, so the
      // fake must model a real TaskStore: rootDir is the project, fusionDir is root + ".fusion".
      getRootDir: vi.fn(() => currentRoot),
      getFusionDir: vi.fn(() => join(currentRoot, ".fusion")),
      getAsyncLayer: vi.fn(() => ({})),
      getSettings: vi.fn(async () => ({})),
      getTask: vi.fn(async () => { throw new Error("no task in this suite"); }),
      recordRunAuditEvent: vi.fn(async () => {}),
      getProjectScopedPluginMcpServers: vi.fn(async () => []),
    } as unknown as TaskStore;
  }

  function postDecision(app: Parameters<typeof REQUEST>[0], body: Record<string, unknown>) {
    return REQUEST(app, "POST", `/api/approvals/${REQUEST_ID}/decision`, JSON.stringify(body), {
      "content-type": "application/json",
    });
  }

  // One app and one store for the whole suite: `createApiRoutes` is expensive to build, and the
  // store reads its project root through `currentRoot`, which each test repoints at its own
  // temp directory. Rebuilding per test only multiplied startup cost against a fixed 15s budget.
  const store = makeStore();
  const app = makeApp(store);

  it("moves the real on-disk artifact from pending to approved", async () => {
    projectRoot = await makeProject();
    currentRoot = projectRoot;
    const artifact = await seedPendingArtifact(projectRoot);
    setEvolutionRequest(artifact.version);

    const res = await postDecision(app, { decision: "approve" });
    expect(res.status).toBe(200);

    // Read back through a FRESH store instance: the bridge ran in its own store, and only a
    // fresh read proves the transition was persisted where the apply gate will look for it.
    const reader = EvolutionStore.forProject(projectRoot);
    await reader.init();
    const persisted = await reader.getArtifactByVersion(AGENT_ID, artifact.version);
    expect(persisted?.approval).toMatchObject({
      status: "approved",
      approvalRequestId: REQUEST_ID,
      decidedBy: "user",
    });
    // The bridge records a bounded audit row for the projection.
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "evolution:approval-approved",
    }));
  });

  it("moves the real on-disk artifact to rejected when the operator denies", async () => {
    projectRoot = await makeProject();
    currentRoot = projectRoot;
    const artifact = await seedPendingArtifact(projectRoot);
    setEvolutionRequest(artifact.version);

    const res = await postDecision(app, { decision: "deny" });
    expect(res.status).toBe(200);

    const reader = EvolutionStore.forProject(projectRoot);
    await reader.init();
    const persisted = await reader.getArtifactByVersion(AGENT_ID, artifact.version);
    expect(persisted?.approval.status).toBe("rejected");
  });

  it("leaves the artifact pending when the cycle wrote it to a directory the bridge cannot address", async () => {
    // Guards the specific failure the fix removes: a writer pointed at the project root instead
    // of the `.fusion` data directory. The operator's decision is still recorded (the approval
    // row is authoritative and must never be lost), but the artifact is untouched — which is
    // exactly the state that made the apply gate refuse with `approval-pending` forever.
    projectRoot = await makeProject();
    currentRoot = projectRoot;
    const wrongStore = new EvolutionStore({ rootDir: projectRoot });
    await wrongStore.init();
    const orphan = await wrongStore.appendArtifact(makeArtifactInput());
    await wrongStore.markApprovalState(AGENT_ID, orphan.version, { status: "pending", approvalRequestId: REQUEST_ID });
    setEvolutionRequest(orphan.version);

    const res = await postDecision(app, { decision: "approve" });
    expect(res.status).toBe(200);

    const orphanReader = new EvolutionStore({ rootDir: projectRoot });
    await orphanReader.init();
    expect((await orphanReader.getArtifactByVersion(AGENT_ID, orphan.version))?.approval.status).toBe("pending");
  });
});
