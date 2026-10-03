import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { superviseSpawn } from "@fusion/core";
import {
  PRIMARY_GATE_STEP_IDS,
  type AffectedTestScope,
  type PrimaryGateStep,
  type PrimaryGateStepId,
  type PrimaryGateStepOutcome,
  type PrimaryGateVerdict,
} from "@fusion/core";
import { resolveAffectedTestScope } from "./affected-test-scope.js";

const execFileAsync = promisify(execFile);

/*
FNXC:SelfImprovePrimaryGateVerdict 2026-09-30-09:20:
FUSI-016's verdict assembly is the DETERMINISTIC core of the primary gate: it turns per-step
outcomes plus the resolved affected-test scope into one boolean verdict bound to a reproducible
fingerprint. It is PURE — no clock, no filesystem, no environment — so two runs of the same
candidate over the same corpus produce byte-identical verdicts, and the gate's "reproducible" claim
is a structural property rather than a hope.

FNXC:SelfImprovePrimaryGateVerdict 2026-09-30-09:20:
The fingerprint content-addresses EXACTLY the inputs that can change a verdict and nothing else:
sorted step ids, each step's pass/fail BOOLEAN, the sorted affected-test file list, and the candidate
sha. It deliberately excludes the richer per-step outcome (timed-out vs failed), wall-clock
duration, and any log text, so a verdict is identified by WHAT it decided, not by how the decision
was reached. Two runs that reach the same decision share a fingerprint even if one step timed out
and the other failed — which is correct, because the downstream keep/revert cares about the
boolean, not the diagnosis. A default-code-unit `.sort()` is used (never `localeCompare`) so the
ordering is locale-independent and identical on every machine.
*/

/** Inputs to the pure verdict assembly. No clock, no environment, no I/O. */
export interface PrimaryGateVerdictInput {
  /** Candidate commit sha the verdict is computed against. */
  candidateSha: string;
  /** The resolved affected-test scope this run used. */
  affectedScope: AffectedTestScope;
  /** Per-step outcome, keyed by step id. A missing step is treated as unreadable (fail-closed). */
  stepOutcomes: Partial<Record<PrimaryGateStepId, PrimaryGateStepOutcome>>;
}

/** Derive the per-step pass/fail boolean: only the `passed` outcome passes; all else fails closed. */
function stepPassed(outcome: PrimaryGateStepOutcome | undefined): boolean {
  return outcome === "passed";
}

/**
 * Build the content-addressed fingerprint of a verdict's inputs.
 *
 * Only verdict-changing, deterministic inputs are hashed. The per-step entries are reduced to
 * their boolean so the fingerprint identifies the DECISION, and a `JSON.stringify` of a fixed-shape
 * object with a pre-sorted array avoids any dependence on object-key insertion or locale collation.
 */
function computeFingerprint(input: PrimaryGateVerdictInput, stepBooleans: Record<string, boolean>): string {
  const affectedTestFiles =
    input.affectedScope.kind === "resolved" ? [...input.affectedScope.testFiles].sort() : [];

  const recipe = {
    version: 1,
    candidateSha: input.candidateSha,
    // Sorted step ids, each paired with its boolean — a stable, locale-independent ordering.
    steps: PRIMARY_GATE_STEP_IDS.map((id) => [id, stepBooleans[id]]).sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    ),
    affectedTestFiles,
  };

  return createHash("sha256").update(JSON.stringify(recipe)).digest("hex");
}

/**
 * Assemble the deterministic primary-gate verdict.
 *
 * `passed` is DERIVED: it is true only when every one of the five steps is `passed`. A step with a
 * missing outcome is recorded as `unreadable` (fail-closed) rather than being skipped, so an
 * incomplete run can never masquerade as a pass. `failedStepCount` and `affectedTestCount` are
 * precomputed for the run-audit metadata (ids/counts/outcomes-only).
 */
export function assemblePrimaryGateVerdict(input: PrimaryGateVerdictInput): PrimaryGateVerdict {
  const stepBooleans: Record<string, boolean> = {};
  const steps: PrimaryGateStep[] = PRIMARY_GATE_STEP_IDS.map((id) => {
    // A missing outcome is unreadable evidence, not a skip: fail closed.
    const outcome: PrimaryGateStepOutcome = input.stepOutcomes[id] ?? "unreadable";
    const passed = stepPassed(outcome);
    stepBooleans[id] = passed;
    return { id, outcome, passed };
  });

  const passed = steps.every((step) => step.passed);
  const failedStepCount = steps.filter((step) => !step.passed).length;
  const affectedTestCount = input.affectedScope.kind === "resolved" ? input.affectedScope.testFiles.length : 0;

  return {
    passed,
    fingerprint: computeFingerprint(input, stepBooleans),
    candidateSha: input.candidateSha,
    steps,
    failedStepCount,
    affectedTestCount,
    affectedScope: input.affectedScope,
  };
}

// ── Sandbox executor ──────────────────────────────────────────────────────────────

/*
FNXC:SelfImprovePrimaryGateExecutor 2026-09-30-09:30:
FUSI-016's executor runs the five gate steps in a SANDBOXED, isolated environment that is never the
live engine. Every child process is spawned with `cwd` bound to the caller-supplied `sandboxDir` (a
disposable experiment worktree), under the `superviseSpawn` parent-death supervisor from
`@fusion/core`, with the mock/test-mode env (`FUSION_TEST_MODE=1`) so no real AI provider is ever
contacted. The LIVE engine is never restarted, reloaded, or borrowed: it has its own cwd, DB,
project and port (4040 is reserved and untouched here), and the patched engine runs as a standalone
process against its own copies. That isolation is the whole safety premise of the mission — a
self-improvement experiment must be able to fail as loudly and as destructively as it likes without
endangering the running system.

FNXC:SelfImprovePrimaryGateExecutor 2026-09-30-09:30:
The executor takes NO full-suite parameter. There is no flag, option, or code path that can widen a
run to the whole workspace test suite — the only test command it can build is a per-file
`vitest run <resolved files>` derived from the affected-test scope, which itself is structurally
per-file (see affected-test-scope.ts). "Run everything" is unrepresentable, not merely discouraged.
This mirrors the standing rule that verification is scoped to changed files and never uses
allowFullSuite.

FNXC:SelfImprovePrimaryGateExecutor 2026-09-30-09:30:
A step that throws, times out, or cannot be spawned is recorded as a FAIL-CLOSED outcome
(`unreadable` / `timed-out`) and the run continues to the next step — it is never allowed to
propagate as an unhandled rejection or to abort the whole gate. The reason is asymmetry of
authority: the gate is the deciding ruler for whether a self-patching change is kept, so a step it
could not measure must count as NOT-passing, never as a skip. The verdict is still assembled from
the complete five-step record so the operator can see exactly which check was unmeasurable.

FNXC:SelfImprovePrimaryGateExecutor 2026-09-30-09:30:
Git capture (the changed-file list that seeds the affected-test scope) is explicitly BOUNDED with a
max buffer and a timeout, mirroring `review-diff-fingerprint.ts`. A pathologically large or hung
`git diff` yields a named, fail-closed `unreadable` reason rather than an unbounded buffer or a
wedge. An unreadable changed-file list does not silently become "no changes" (which would look
like a clean pass); it fails the affected-tests step closed.
*/

/** Bounded git capture for the changed-file list, mirroring review-diff-fingerprint's bounds. */
export const PRIMARY_GATE_GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
export const PRIMARY_GATE_GIT_TIMEOUT_MS = 120_000;

/** Default per-step wallclock budget. Bounds a single gate command without wedging the run. */
export const PRIMARY_GATE_STEP_TIMEOUT_MS = 900_000;

/** One step's execution request handed to the (injectable) step runner. */
export interface PrimaryGateStepRequest {
  /** Which of the five checks to run. */
  id: PrimaryGateStepId;
  /** The exact command line to execute. The runner MUST use `cwd` as the working directory. */
  command: string;
  /** The sandbox directory — the ONLY cwd a child may receive. Never the live engine's cwd. */
  cwd: string;
  /** Environment for the child, including the mock/test-mode flag. */
  env: NodeJS.ProcessEnv;
  /** Wallclock budget for this step. */
  timeoutMs: number;
}

/**
 * Executes one gate step and reports its outcome. Injectable so tests (and later policy) can
 * supply a deterministic runner; the default is the real supervised subprocess runner.
 * A runner MAY reject/throw — the executor records that as a fail-closed outcome, never a crash.
 */
export type PrimaryGateStepRunner = (request: PrimaryGateStepRequest) => Promise<PrimaryGateStepOutcome>;

function gitCaptureOptions(cwd: string) {
  return {
    cwd,
    encoding: "utf8" as const,
    maxBuffer: PRIMARY_GATE_GIT_MAX_BUFFER_BYTES,
    timeout: PRIMARY_GATE_GIT_TIMEOUT_MS,
  };
}

function isGitCaptureOverflow(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    (typeof candidate.message === "string" && candidate.message.includes("maxBuffer"))
  );
}

/** Probe the candidate's changed files vs the base ref. Named fail-closed reasons, never a pass. */
export type ChangedFilesProbe =
  | { state: "ok"; changedFiles: string[] }
  | { state: "unavailable"; reason: "git-changed-files-too-large" | "git-changed-files-failed" };

export async function probeChangedFiles(
  sandboxDir: string,
  baseRef: string,
): Promise<ChangedFilesProbe> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", "-z", `${baseRef}...HEAD`],
      gitCaptureOptions(sandboxDir),
    );
    const changedFiles = stdout.split("\0").filter(Boolean);
    return { state: "ok", changedFiles };
  } catch (error) {
    return {
      state: "unavailable",
      reason: isGitCaptureOverflow(error) ? "git-changed-files-too-large" : "git-changed-files-failed",
    };
  }
}

/*
FNXC:SelfImprovePrimaryGateExecutor 2026-09-30-09:30:
The default runner discards child output entirely (`stdio: ["ignore","ignore","ignore"]`). Gate
commands emit compiler errors, test failures, and diffs; retaining any of that in the gate result is
precisely the "paste the diff into telemetry" failure the run-audit contract forbids, and holding it
in memory for a long gate run is needless exposure. Only the exit signal becomes an outcome.
*/
export const defaultPrimaryGateStepRunner: PrimaryGateStepRunner = (request) =>
  new Promise<PrimaryGateStepOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: PrimaryGateStepOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    let supervised: ReturnType<typeof superviseSpawn>;
    try {
      supervised = superviseSpawn(request.command, [], {
        cwd: request.cwd,
        stdio: ["ignore", "ignore", "ignore"],
        env: request.env,
        shell: true,
        maxLifetimeMs: request.timeoutMs,
      });
    } catch {
      // Could not even spawn — fail closed, do not crash the gate.
      settle("unreadable");
      return;
    }

    // A lifetime kill (maxLifetimeMs) fires the supervisor's teardown; treat a signal death
    // (e.g. the lifetime kill) as timed-out and a non-zero exit as a behavioral failure.
    void supervised.waitExit().then(({ code, signal }) => {
      if (signal) settle("timed-out");
      else settle(code === 0 ? "passed" : "failed");
    });
  });

/** Options for {@link runPrimaryGate}. */
export interface RunPrimaryGateOptions {
  /**
   * The isolated experiment worktree directory. This is the ONLY cwd handed to any child. It is
   * never the live engine's cwd — callers must pass the sandbox path, and the executor never falls
   * back to `process.cwd()`.
   */
  sandboxDir: string;
  /** Base ref (e.g. the main branch) the candidate is diffed against for affected-test scope. */
  baseRef: string;
  /** Candidate commit sha recorded in the verdict and fingerprint. */
  candidateSha: string;
  /** Package dir → package name map, used to resolve affected tests. */
  packageNameByDir: ReadonlyMap<string, string>;
  /** Returns the live test files for a package (the candidate tree is the source of truth). */
  listLiveTestFiles: (packageName: string) => readonly string[];
  /** Injectable step runner. Defaults to the real supervised subprocess runner. */
  runStep?: PrimaryGateStepRunner;
  /** Per-step wallclock budget. Defaults to {@link PRIMARY_GATE_STEP_TIMEOUT_MS}. */
  stepTimeoutMs?: number;
  /** Injectable changed-file override (skips the git probe). Primarily for deterministic tests. */
  changedFiles?: readonly string[];
  /** Extra env merged over the base mock-mode env for each child. */
  env?: NodeJS.ProcessEnv;
}

/** Build the child environment: mock/test mode on, plus corepack's interactive prompt disabled. */
function buildChildEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Force mock/test mode so the patch engine under test never contacts a real provider.
    FUSION_TEST_MODE: "1",
    // Corepack otherwise prompts interactively before fetching a pinned packageManager version,
    // hanging the non-TTY child until its hard timeout.
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    ...extra,
  };
}

/*
FNXC:SelfImproveAffectedTestsCommand 2026-09-30-10:20:
The `affected-tests` command MUST be dispatched PER PACKAGE (`pnpm --filter <pkg> exec vitest run
<files>`), never as a bare `pnpm exec vitest` from the sandbox root. Vitest is a per-package
dependency here — the workspace root declares no vitest dependency and ships no root vitest config,
so `pnpm exec vitest` at the root exits 254 with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command
"vitest" not found` (measured on this tree). That would make the step fail for EVERY candidate that
touches a live test, so the gate could only ever say "revert". Running through each owning
package's own `exec` also picks up that package's vitest config, setup files, and reporters, which a
root-level invocation cannot see. This mirrors the repo precedent in `scripts/test-changed.mjs`,
which drives the changed-only affected lane through `pnpm --filter <pkg> ... test <file>`.
*/
function buildAffectedTestsCommand(
  scope: AffectedTestScope,
  packageNameByDir: ReadonlyMap<string, string>,
): string | null {
  if (scope.kind !== "resolved" || scope.testFiles.length === 0) return null;

  // Owning package per file, resolved through the CALLER'S OWN dir→name map rather than by
  // reconstructing a dir from a package name: the resolver sourced these files from that very map,
  // so every file is guaranteed to match, and a package that does not live at "packages/<shortname>"
  // still resolves instead of being silently dropped (which would report a resolved scope as a pass).
  const dirToPackage = [...packageNameByDir.entries()]
    .filter(([dir]) => dir.includes("/"))
    // Longest dir first so a nested package dir wins over its parent.
    .sort((a, b) => b[0].length - a[0].length);

  const byPackage = new Map<string, string[]>();
  for (const file of scope.testFiles) {
    const owner = dirToPackage.find(([dir]) => file === dir || file.startsWith(`${dir}/`));
    if (!owner) continue; // No owning package dir — never hand it to Vitest.
    const [dir, pkg] = owner;
    // Each package's vitest root is the PACKAGE dir, so paths are passed package-relative.
    const relative = file.slice(dir.length + 1);
    if (!relative || relative.startsWith("..")) continue;
    const bucket = byPackage.get(pkg) ?? [];
    bucket.push(relative);
    byPackage.set(pkg, bucket);
  }

  if (byPackage.size === 0) return null;

  // Per-file invocation scoped to the resolved affected tests, one dispatch per owning package.
  // No full-suite, ever. The `&&` join means a failure in ANY package's tests fails the step.
  return [...byPackage.keys()]
    .sort()
    .map((pkg) => `pnpm --filter ${pkg} exec vitest run ${byPackage.get(pkg)!.sort().join(" ")}`)
    .join(" && ");
}

/** Fixed command for the four non-test steps, executed in the sandbox via pnpm. */
function buildFixedStepCommand(id: PrimaryGateStepId): string {
  switch (id) {
    case "build":
      return "pnpm build";
    case "lint":
      return "pnpm lint";
    case "typecheck":
      return "pnpm -r --filter=!@fusion/desktop --filter=!@fusion/mobile typecheck";
    case "gate":
      return "pnpm test:gate";
    default:
      // "affected-tests" is built from the resolved scope, never from this fixed map.
      throw new Error(`unhandled primary-gate step: ${id}`);
  }
}

/**
 * Run the deterministic primary gate over a candidate and return its verdict.
 *
 * The gate executes the four fixed steps plus the affected-tests step (when the diff resolves to
 * live tests), assembles the deterministic verdict, and returns it. This function never emits
 * run-audit itself — telemetry is the caller's (Step 4) concern, which keeps the verdict
 * reproducible and the audit edge separately testable against hostile sinks.
 */
export async function runPrimaryGate(options: RunPrimaryGateOptions): Promise<PrimaryGateVerdict> {
  const {
    sandboxDir,
    baseRef,
    candidateSha,
    packageNameByDir,
    listLiveTestFiles,
    runStep = defaultPrimaryGateStepRunner,
    stepTimeoutMs = PRIMARY_GATE_STEP_TIMEOUT_MS,
    env,
  } = options;

  const childEnv = buildChildEnv(env);

  // 1. Resolve the affected-test scope from the candidate's changed files.
  let affectedScope: AffectedTestScope;
  let changedFilesUnreadable = false;
  if (options.changedFiles) {
    affectedScope = resolveAffectedTestScope({
      changedFiles: options.changedFiles,
      packageNameByDir,
      listLiveTestFiles,
    });
  } else {
    const probe = await probeChangedFiles(sandboxDir, baseRef);
    if (probe.state === "ok") {
      affectedScope = resolveAffectedTestScope({
        changedFiles: probe.changedFiles,
        packageNameByDir,
        listLiveTestFiles,
      });
    } else {
      // Unreadable changed-file list: fail the affected-tests step closed rather than treating it
      // as "no changes" (which would look like a clean pass).
      changedFilesUnreadable = true;
      affectedScope = { kind: "empty" };
    }
  }

  const stepOutcomes: Partial<Record<PrimaryGateStepId, PrimaryGateStepOutcome>> = {};

  // 2. Run the four fixed steps, each in the sandbox under the supervisor, fail-closed on throw.
  for (const id of ["build", "lint", "typecheck", "gate"] as const) {
    const request: PrimaryGateStepRequest = {
      id,
      command: buildFixedStepCommand(id),
      cwd: sandboxDir,
      env: childEnv,
      timeoutMs: stepTimeoutMs,
    };
    try {
      stepOutcomes[id] = await runStep(request);
    } catch {
      // A throwing runner is recorded as a fail-closed outcome, never propagated.
      stepOutcomes[id] = "unreadable";
    }
  }

  // 3. Run the affected-tests step over the resolved scope (or fail closed if scope unreadable).
  if (changedFilesUnreadable) {
    stepOutcomes["affected-tests"] = "unreadable";
  } else {
    const affectedCommand = buildAffectedTestsCommand(affectedScope, packageNameByDir);
    if (affectedCommand === null) {
      // No affected tests resolved (empty/shared-infra) — nothing to fail. Recorded `passed` with
      // the explicit non-resolved scope preserved in the verdict.
      stepOutcomes["affected-tests"] = "passed";
    } else {
      const request: PrimaryGateStepRequest = {
        id: "affected-tests",
        command: affectedCommand,
        cwd: sandboxDir,
        env: childEnv,
        timeoutMs: stepTimeoutMs,
      };
      try {
        stepOutcomes["affected-tests"] = await runStep(request);
      } catch {
        stepOutcomes["affected-tests"] = "unreadable";
      }
    }
  }

  // 4. Assemble the deterministic verdict from the complete five-step record.
  return assemblePrimaryGateVerdict({ candidateSha, affectedScope, stepOutcomes });
}
