import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { guardStructuralDenylist } from "../self-improve/structural-denylist-guard.js";
import { SELF_IMPROVE_RUN_AUDIT_EVENTS } from "../self-improve/self-improve-run-audit.js";
import { CORE_RUN_AUDIT_EMIT_TIMEOUT_MS, type RunAuditSinkHost } from "../run-audit/emit-bounded-run-audit.js";
import type { RunAuditEventInput } from "../types/audit/run-audit.js";
import type { StructuralDenylistCategory } from "../self-improve/structural-denylist.js";

/*
FNXC:SelfImproveStructuralDenylistGuard 2026-09-30-12:10:
The central claim of this module is negative — the gate callback is NEVER invoked on a denylist hit —
so the tests are built around a `vi.fn()` gate whose call count is asserted to be exactly zero. A test
that only checked the returned `rejected: true` flag would pass against an implementation that
computed the verdict, returned it, and called the gate anyway, which is the exact bug the guard
exists to prevent. Every one of the five categories therefore gets its own zero-call assertion, and
the four named gate files get a combined one.

FNXC:SelfImproveStructuralDenylistGuard 2026-09-30-12:10:
The hostile-sink block uses FAKE TIMERS and crosses the seam's own CORE_RUN_AUDIT_EMIT_TIMEOUT_MS
rather than waiting on a real clock. A never-settling sink must not be able to delay or soften a
refusal, and the only honest way to prove that is to let the seam's time-box actually expire on a
controlled clock. Each mode (absent, throwing, rejecting, never-settling, late-settling) still
yields `rejected: true` with zero gate calls, which is the load-bearing half of the telemetry-is-not-
load-bearing contract: the refusal is decided by the pure classifier before the emit is attempted.

FNXC:SelfImproveStructuralDenylistGuard 2026-09-30-12:10:
The escape-hatch ratchet scans the two new source files for bypass identifiers and environment reads
as CODE CONSTRUCTS, not prose. It is deliberately a source scan of the guard's own contract surface
(a "no bypass" invariant is structural, and asserting the absence of a construct is a real guard),
while the FNXC comments in those files that MENTION the word "bypass" are stripped first so the
ratchet cannot be satisfied or defeated by documentation. A future "just for experiments" flag, env
var, or settings key fails here rather than quietly reopening the hole.
*/

const SELF_IMPROVE_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "self-improve");
const GUARD_PATH = join(SELF_IMPROVE_SRC, "structural-denylist-guard.ts");
const CLASSIFIER_PATH = join(SELF_IMPROVE_SRC, "structural-denylist.ts");

/**
 * Strip block and line comments so a scan asserts CODE CONSTRUCTS only.
 *
 * Without this the FNXC blocks in these very files — which legitimately discuss the absence of a
 * bypass — would both satisfy and defeat the ratchet depending on wording. Comments are
 * documentation; the invariant this guards is about what the module can do.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

/** The protected paths that must each abort the gate, one per category. */
const CATEGORY_REPRESENTATIVES: [StructuralDenylistCategory, string][] = [
  ["quarantine", "scripts/lib/test-quarantine.json"],
  ["gate", "scripts/boot-smoke.mjs"],
  ["ratchets", "scripts/check-workspace-package-graph.mjs"],
  ["release", "scripts/release.mjs"],
  ["self-patching", "packages/core/src/self-improve/ledger-schema.ts"],
];

describe("structural denylist guard: refusal happens before any gate execution", () => {
  it.each(CATEGORY_REPRESENTATIVES)("refuses a %s diff with zero gate calls", async (category, path) => {
    const gate = vi.fn(() => ({ verdict: "gate-passed" }));
    const result = await guardStructuralDenylist([path], gate);

    expect(gate).not.toHaveBeenCalled();
    expect(result.executed).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.categories).toEqual([category]);
    expect(result.counts).toEqual({ [category]: 1 });
    expect(result.fileCount).toBe(1);
    // No gate verdict exists at all: a caller has nothing to weigh against the refusal.
    expect(result.gateResult).toBeUndefined();
  });

  it.each([
    "scripts/run-static-gate-checks.mjs",
    "packages/core/src/index.gate.ts",
    "scripts/boot-smoke.mjs",
    "scripts/verify-fast.mjs",
    // P0 named regression: the gate's own MEMBERSHIP lives in these files, so an edit that removes a
    // validator from `test:gate:static`, un-lists a blocking test from `test:unit-gate`, or
    // reweights `test:pg-gate`'s config narrows the verdict without modifying any script the gate
    // runs. Refusing only the targets leaves the loader wide open.
    "package.json",
    "packages/core/package.json",
    "packages/core/vitest.pg.config.ts",
  ])("never runs the gate for the named gate file %s", async (path) => {
    const gate = vi.fn(() => ({ verdict: "gate-passed" }));
    const result = await guardStructuralDenylist([path], gate);

    expect(gate).not.toHaveBeenCalled();
    expect(result.rejected).toBe(true);
    expect(result.categories).toContain("gate");
  });

  it("refuses the exact manifest-and-config diff that rewrites the gate's own membership", async () => {
    // The reviewer's reproduction, verbatim: this diff touches NO validator script and NO gate
    // launcher, yet each file defines what the gate runs. Classifying it as clean and invoking the
    // gate once is the P0.
    const gate = vi.fn(() => ({ verdict: "gate-passed" }));
    const result = await guardStructuralDenylist(
      ["package.json", "packages/core/package.json", "packages/core/vitest.pg.config.ts"],
      gate,
    );

    expect(gate).not.toHaveBeenCalled();
    expect(result.executed).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.categories).toEqual(["gate"]);
    expect(result.counts).toEqual({ gate: 3 });
    expect(result.fileCount).toBe(3);
  });

  it("invokes the gate exactly once for a clean diff", async () => {
    const gate = vi.fn(() => ({ verdict: "gate-passed" }));
    const result = await guardStructuralDenylist(["packages/dashboard/app/App.tsx", "docs/a.md"], gate);

    expect(gate).toHaveBeenCalledTimes(1);
    expect(result.executed).toBe(true);
    expect(result.rejected).toBe(false);
    expect(result.gateResult).toEqual({ verdict: "gate-passed" });
  });

  it("invokes the gate exactly once for an empty diff", async () => {
    const gate = vi.fn(() => ({ verdict: "gate-passed" }));
    const result = await guardStructuralDenylist([], gate);

    expect(gate).toHaveBeenCalledTimes(1);
    expect(result.executed).toBe(true);
    expect(result.rejected).toBe(false);
  });

  it("awaits an async gate and passes its resolution through", async () => {
    const gate = vi.fn(async () => {
      await Promise.resolve();
      return { verdict: "async-passed" };
    });
    const result = await guardStructuralDenylist(["docs/a.md"], gate);

    expect(gate).toHaveBeenCalledTimes(1);
    expect(result.gateResult).toEqual({ verdict: "async-passed" });
  });

  it("reports first-match-wins categories whose counts sum to fileCount", async () => {
    const gate = vi.fn(() => ({ verdict: "gate-passed" }));
    const result = await guardStructuralDenylist(
      [
        "packages/dashboard/app/App.tsx",
        "scripts/lib/test-quarantine.json",
        "scripts/boot-smoke.mjs",
        "scripts/verify-fast.mjs",
        "scripts/check-workspace-package-graph.mjs",
        "eslint.config.mjs",
      ],
      gate,
    );

    expect(gate).not.toHaveBeenCalled();
    expect(result.categories).toEqual(["quarantine", "gate", "ratchets"]);
    const summed = Object.values(result.counts).reduce((total, n) => total + (n ?? 0), 0);
    expect(summed).toBe(result.fileCount);
    // Five protected files across three categories; the sixth input path is a product file and
    // contributes nothing, which is what "count protected files, not diff size" means.
    expect(result.fileCount).toBe(5);
    expect(result.counts).toEqual({ quarantine: 1, gate: 2, ratchets: 2 });
  });
});

describe("structural denylist guard: a refusal is a hard stop a caller cannot ignore", () => {
  it("cannot be proceeded past by a caller that honors the return value", async () => {
    const gate = vi.fn(() => ({ verdict: "gate-passed" }));
    let proceededToMerge = false;

    // Drive the contract the primary gate must implement: honor `rejected` and stop.
    const result = await guardStructuralDenylist(["scripts/boot-smoke.mjs"], gate);
    if (!result.rejected) {
      proceededToMerge = true;
    }

    expect(proceededToMerge).toBe(false);
    expect(gate).not.toHaveBeenCalled();
    // And there is no gate verdict a caller could have preferred anyway.
    expect(result.gateResult).toBeUndefined();
  });

  it("invokes the gate from exactly one place in the module source", () => {
    const source = stripComments(readFileSync(GUARD_PATH, "utf8"));
    // The callback is stored once (`gate`) and invoked at exactly one call site. Counting the
    // invocations of the local `gate` identifier is what proves there is no second path to a gate
    // run that skips classification.
    const invocations = source.match(/\bawait gate\(\)/g) ?? [];
    expect(invocations).toHaveLength(1);
    // A second gate-accepting export would be the bypass this module forbids.
    const exportedFunctions = source.match(/export\s+(?:async\s+)?function\s+\w+/g) ?? [];
    expect(exportedFunctions).toHaveLength(1);
  });
});

describe("structural denylist guard: the refusal is recorded in run-audit", () => {
  let captured: RunAuditEventInput[];

  beforeEach(() => {
    captured = [];
  });

  function host(): RunAuditSinkHost {
    return { recordRunAuditEvent: (input: RunAuditEventInput) => void captured.push(input) };
  }

  it("emits the refusal with categories and counts and no paths", async () => {
    await guardStructuralDenylist(["scripts/boot-smoke.mjs", "scripts/check-workspace-package-graph.mjs"], vi.fn(), {
      host: host(),
    });

    // The audit row is best-effort and not awaited by the guard, so let the microtask queue drain.
    await vi.waitFor(() => expect(captured.length).toBeGreaterThan(0));

    const event = captured[0]!;
    expect(event.mutationType).toBe(SELF_IMPROVE_RUN_AUDIT_EVENTS.denylistRejected);
    expect(event.metadata).toMatchObject({
      categories: ["gate", "ratchets"],
      categoryCount: 2,
      fileCount: 2,
      rejected: true,
    });

    // The diff itself must never reach telemetry.
    const serialized = JSON.stringify(event.metadata);
    expect(serialized).not.toContain("boot-smoke");
    expect(serialized).not.toContain("check-workspace-package-graph");
  });

  it("omits proposal id and target when the commit has no proposal yet", async () => {
    await guardStructuralDenylist(["scripts/release.mjs"], vi.fn(), { host: host() });
    await vi.waitFor(() => expect(captured.length).toBeGreaterThan(0));

    const metadata = captured[0]!.metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("proposalId");
    expect(metadata).not.toHaveProperty("target");
    expect(metadata.categories).toEqual(["release"]);
  });

  it("forwards proposal and project ids when the caller has them", async () => {
    await guardStructuralDenylist(["scripts/release.mjs"], vi.fn(), {
      host: host(),
      proposalId: "p-42",
      projectId: "proj-7",
    });
    await vi.waitFor(() => expect(captured.length).toBeGreaterThan(0));

    const metadata = captured[0]!.metadata as Record<string, unknown>;
    expect(metadata.proposalId).toBe("p-42");
    expect(metadata.projectId).toBe("proj-7");
  });

  it("records no audit row for a clean diff that ran the gate", async () => {
    await guardStructuralDenylist(["docs/a.md"], vi.fn(() => ({ ok: true })), { host: host() });
    await vi.waitFor(() => expect(true).toBe(true));
    expect(captured).toHaveLength(0);
  });
});

describe("structural denylist guard: a hostile audit sink cannot soften a refusal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["an absent sink", undefined],
    ["a synchronously throwing sink", () => {
      throw new Error("sink exploded");
    }],
    ["a rejecting sink", () => Promise.reject(new Error("sink rejected"))],
    ["a never-settling sink", () => new Promise<void>(() => {})],
  ])("still refuses with zero gate calls under %s", async (_label, recordRunAuditEvent) => {
    const gate = vi.fn(() => ({ verdict: "gate-passed" }));
    const result = await guardStructuralDenylist(["scripts/boot-smoke.mjs"], gate, {
      host: recordRunAuditEvent ? ({ recordRunAuditEvent } as RunAuditSinkHost) : undefined,
    });

    // Cross the seam's own time-box on the controlled clock so a hung sink cannot wait on real time.
    await vi.advanceTimersByTimeAsync(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS + 50);

    expect(result.rejected).toBe(true);
    expect(result.executed).toBe(false);
    expect(result.categories).toEqual(["gate"]);
    expect(gate).not.toHaveBeenCalled();
  });

  it("still refuses when a late-settling sink resolves only after the timeout", async () => {
    let resolveSink: (() => void) | undefined;
    const gate = vi.fn(() => ({ verdict: "gate-passed" }));
    const host: RunAuditSinkHost = {
      recordRunAuditEvent: () =>
        new Promise<void>((resolve) => {
          resolveSink = resolve;
        }),
    };

    const result = await guardStructuralDenylist(["scripts/boot-smoke.mjs"], gate, { host });
    await vi.advanceTimersByTimeAsync(CORE_RUN_AUDIT_EMIT_TIMEOUT_MS + 50);
    resolveSink?.();

    expect(result.rejected).toBe(true);
    expect(gate).not.toHaveBeenCalled();
  });
});

describe("structural denylist guard: no escape hatch exists", () => {
  it.each([GUARD_PATH, CLASSIFIER_PATH])("%s exposes no bypass identifier", (path) => {
    const code = stripComments(readFileSync(path, "utf8"));
    // Substring matching, NOT word boundaries: the realistic escape hatches are compound
    // identifiers like `bypassDenylist`, `forceRun`, or `skipProtected`, where a `\b` boundary
    // would find no match and the ratchet would wave the very flag it exists to catch straight
    // through. Case-insensitive so `BYPASS_` and `bypass` are both caught.
    for (const identifier of ["bypass", "force", "skipdenylist", "skipprotected", "allowprotected", "override", "nocheck"]) {
      expect(code.toLowerCase()).not.toContain(identifier);
    }
  });

  it.each([GUARD_PATH, CLASSIFIER_PATH])("%s reads no environment variable or setting", (path) => {
    const code = stripComments(readFileSync(path, "utf8"));
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/\bgetSetting\b/);
    expect(code).not.toMatch(/\bsettings\./);
  });
});
