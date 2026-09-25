import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  AgentStore,
  ApprovalRequestStore,
  EvolutionStore,
  createEvolutionApplyGate,
  type EvolutionApplyOutcome,
  type RunChecksFn,
  type TaskStore,
  type WriteLiveStateFn,
} from "@fusion/core";
import {
  createHermesAdapter,
  createHerdrAdapter,
  EvolutionCycle,
  type HermesAdapter,
  type HerdrAdapter,
  type RunEvolutionCycleResult,
} from "@fusion/engine";
import { resolveProjectStore, type ResolvedProjectStoreOwner } from "../project-resolver.js";

const execAsync = promisify(exec);

/**
 * FNXC:EvolutionTrialChecks 2026-09-25-10:40:
 * An operator-invoked trial must not hang forever on a wedged verification command.
 * Bounded like the engine's own verification runner; on timeout the check reports a
 * failure rather than blocking the CLI.
 */
const PROJECT_VERIFICATION_TIMEOUT_MS = 900_000;

export interface EvolutionRunGate {
  applyArtifact(artifact: import("@fusion/core").EvolutionArtifact): Promise<EvolutionApplyOutcome>;
}

export interface EvolutionRunOptions {
  /** Project root. Required for a real run; ignored by an injected cycle in unit tests. */
  rootDir?: string;
  cwd?: string;
  projectName?: string;
  agentId?: string;
  /** Explicitly opt into the existing apply gate. The default is dry-run. */
  apply?: boolean;
  json?: boolean;
  store?: EvolutionStore;
  taskStore?: TaskStore;
  approvalStore?: ApprovalRequestStore;
  agentStore?: Pick<AgentStore, "getAgent" | "listAgents" | "init" | "writeBundleFile">;
  runChecks?: RunChecksFn;
  hermesAdapter?: HermesAdapter;
  herdrAdapter?: HerdrAdapter;
  liveWriter?: WriteLiveStateFn;
  runCycle?: (context: {
    agentId: string;
    store: EvolutionStore;
    approvalStore?: ApprovalRequestStore;
    agentStore?: EvolutionRunOptions["agentStore"];
    taskStore?: TaskStore;
  }) => Promise<RunEvolutionCycleResult>;
  gate?: EvolutionRunGate;
  log?: (message: string) => void;
  now?: () => Date;
}

export interface EvolutionRunResult {
  status: "ran" | "skipped" | "refused";
  reason?: string;
  artifact?: import("@fusion/core").EvolutionArtifact;
  trial?: import("@fusion/core").EvolutionTrial;
  approvalRequestId?: string;
  apply?: EvolutionApplyOutcome;
  lastCycleAt?: string;
}

/**
 * Run exactly one operator-invoked evolution cycle. The command is deliberately
 * dry-run by default: it may append a redacted artifact and create a pending
 * ApprovalRequest, but it never invokes a live-state writer unless `apply` is
 * explicitly true and the existing apply gate accepts the artifact.
 */
export async function runEvolutionRun(options: EvolutionRunOptions = {}): Promise<EvolutionRunResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  let projectOwner: ResolvedProjectStoreOwner | undefined;
  let taskStore = options.taskStore;
  let store = options.store;
  let agentStore = options.agentStore;
  let approvalStore = options.approvalStore;

  try {
    if (!taskStore && !options.runCycle) {
      projectOwner = await resolveProjectStore({ project: options.projectName, cwd: options.cwd });
      taskStore = projectOwner.store;
    }
    const rootDir = options.rootDir ?? taskStore?.getRootDir();
    if (!rootDir && !options.runCycle) {
      return { status: "refused", reason: "project root is required" };
    }

    if (!store) {
      store = new EvolutionStore({ rootDir: rootDir! });
      await store.init();
    }

    if (!agentStore && taskStore) {
      const layer = taskStore.getAsyncLayer();
      if (layer) {
        const created = new AgentStore({
          rootDir: taskStore.getFusionDir(),
          asyncLayer: layer,
        });
        await created.init();
        agentStore = created;
      }
    }

    if (!approvalStore && taskStore?.getAsyncLayer()) {
      approvalStore = new ApprovalRequestStore(null, { asyncLayer: taskStore.getAsyncLayer()! });
    }

    const agentId = options.agentId?.trim() || await resolveAgentId(agentStore);
    if (!agentId) {
      return { status: "refused", reason: "agentId is required ( pass --agent-id )" };
    }

    const cycleResult = options.runCycle
      ? await options.runCycle({ agentId, store, approvalStore, agentStore, taskStore })
      : await runProductionCycle({
          agentId,
          store,
          taskStore,
          agentStore,
          approvalStore,
          runChecks: options.runChecks,
          hermesAdapter: options.hermesAdapter,
          herdrAdapter: options.herdrAdapter,
          now: options.now,
        });

    if (cycleResult.outcome === "skipped") {
      log(`Evolution cycle skipped (${cycleResult.reason}).`);
      return {
        status: "skipped",
        reason: cycleResult.reason,
        ...(cycleResult.lastCycleAt ? { lastCycleAt: cycleResult.lastCycleAt } : {}),
      };
    }
    if (cycleResult.outcome === "refused") {
      log(`Evolution cycle refused: ${cycleResult.reason}.`);
      return { status: "refused", reason: cycleResult.reason };
    }

    const artifact = cycleResult.artifact;
    log(`Evolution cycle completed in ${options.apply ? "apply review" : "dry-run"} mode (${artifact.trial.decision}).`);

    if (!options.apply) {
      return {
        status: "ran",
        artifact,
        trial: cycleResult.trial.trial,
        ...(cycleResult.approvalRequestId ? { approvalRequestId: cycleResult.approvalRequestId } : {}),
      };
    }

    const gate = options.gate ?? buildApplyGate({
      approvalStore,
      liveWriter: options.liveWriter,
      auditHost: taskStore,
    });
    if (!gate) {
      log("Apply was not performed: the approval store is unavailable.");
      return {
        status: "ran",
        artifact,
        trial: cycleResult.trial.trial,
        ...(cycleResult.approvalRequestId ? { approvalRequestId: cycleResult.approvalRequestId } : {}),
      };
    }
    const apply = await gate.applyArtifact(artifact);
    log(apply.kind === "applied" ? "Evolution artifact applied." : `Evolution apply refused (${apply.reason}).`);
    return {
      status: "ran",
      artifact,
      trial: cycleResult.trial.trial,
      ...(cycleResult.approvalRequestId ? { approvalRequestId: cycleResult.approvalRequestId } : {}),
      apply,
    };
  } finally {
    await projectOwner?.close();
  }
}

async function resolveAgentId(agentStore: EvolutionRunOptions["agentStore"]): Promise<string | undefined> {
  if (!agentStore) return undefined;
  const agents = await agentStore.listAgents({ includeEphemeral: false });
  return agents[0]?.id;
}

async function runProductionCycle(input: {
  agentId: string;
  store: EvolutionStore;
  taskStore?: TaskStore;
  agentStore?: EvolutionRunOptions["agentStore"];
  approvalStore?: ApprovalRequestStore;
  runChecks?: RunChecksFn;
  hermesAdapter?: HermesAdapter;
  herdrAdapter?: HerdrAdapter;
  now?: () => Date;
}): Promise<RunEvolutionCycleResult> {
  const runChecks = input.runChecks ?? await createSettingsRunChecks(input.taskStore);
  const cycle = new EvolutionCycle({
    store: input.store,
    runChecks,
    auditHost: input.taskStore ? { recordRunAuditEvent: (event: unknown) => input.taskStore!.recordRunAuditEvent(event as never) } : null,
    ...(input.hermesAdapter ? { hermesAdapter: input.hermesAdapter } : {}),
    ...(input.herdrAdapter ? { herdrAdapter: input.herdrAdapter } : {}),
    ...(input.approvalStore ? { approvalStore: input.approvalStore } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  return cycle.runCycle({ agentId: input.agentId, trigger: "manual" });
}

/**
 * FNXC:EvolutionTrialChecks 2026-09-25-10:40:
 * A production cycle whose checker always reports `passed: false` can never produce a
 * `keep` trial, so the operator approval surface and the apply gate were unreachable
 * outside tests. Resolve the operator's own project verification command
 * (`settings.testCommand`) and run it as the trial check.
 *
 * The command string is an operator-authored setting; the run's OUTPUT is reduced to
 * booleans and byte/exit counts and is never persisted as prose, so this adds no new
 * secret-bearing surface. When no command is configured the refusing check is kept and
 * says so explicitly — an absent configuration must be visible in the artifact instead
 * of masquerading as a failing trial of a real command.
 */
async function createSettingsRunChecks(taskStore: TaskStore | undefined): Promise<RunChecksFn> {
  const command = await resolveProjectVerificationCommand(taskStore);
  const rootDir = taskStore?.getRootDir();
  if (!command || !rootDir) {
    return refusingChecks;
  }
  return async () => {
    const startedAt = Date.now();
    // Build one metrics object per branch with an identical key set:
    // EvolutionRunMetrics has a `[metric: string]: number` index signature, so a branch
    // that omits a key the other defines infers `undefined` for it and fails the type.
    const buildMetrics = (outputBytes: number, exitCode: number): Record<string, number> => ({
      durationMs: Date.now() - startedAt,
      outputBytes,
      exitCode,
    });
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: rootDir,
        timeout: PROJECT_VERIFICATION_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });
      return {
        command,
        passed: true,
        metrics: buildMetrics(Buffer.byteLength(stdout) + Buffer.byteLength(stderr), 0),
      };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: unknown };
      return {
        command,
        passed: false,
        metrics: buildMetrics(
          Buffer.byteLength(failure.stdout ?? "") + Buffer.byteLength(failure.stderr ?? ""),
          typeof failure.code === "number" ? failure.code : 1,
        ),
      };
    }
  };
}

async function resolveProjectVerificationCommand(taskStore: TaskStore | undefined): Promise<string | undefined> {
  try {
    const settings = await taskStore?.getSettings();
    const configured = settings?.testCommand?.trim();
    return configured ? configured : undefined;
  } catch {
    // An unreadable settings store is a configuration problem, not a crash: the
    // refusing check reports it in the artifact.
    return undefined;
  }
}

function buildApplyGate(input: {
  approvalStore?: ApprovalRequestStore;
  liveWriter?: WriteLiveStateFn;
  auditHost?: TaskStore;
}): EvolutionRunGate | undefined {
  if (!input.approvalStore) return undefined;
  return createEvolutionApplyGate({
    approvalStore: input.approvalStore,
    liveWriter: input.liveWriter ?? refusingLiveWriter,
    ...(input.auditHost ? { auditHost: { recordRunAuditEvent: (event: unknown) => input.auditHost!.recordRunAuditEvent(event as never) } } : {}),
  });
}

async function refusingChecks(): Promise<import("@fusion/core").EvolutionRun> {
  return {
    command: "evolution dry-run (no project verification command configured)",
    passed: false,
    metrics: {},
  };
}

async function refusingLiveWriter(): Promise<void> {
  throw new Error("No Evolution live-state writer is configured; approval alone cannot mutate state.");
}

/** Convert the operator-facing result to a compact JSON-friendly payload. */
export function formatEvolutionRunResult(result: EvolutionRunResult): Record<string, unknown> {
  return {
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.artifact ? { artifact: result.artifact } : {}),
    ...(result.trial ? { trial: result.trial } : {}),
    ...(result.approvalRequestId ? { approvalRequestId: result.approvalRequestId } : {}),
    ...(result.apply ? { apply: result.apply } : {}),
    ...(result.lastCycleAt ? { lastCycleAt: result.lastCycleAt } : {}),
  };
}

export { createHermesAdapter, createHerdrAdapter };
