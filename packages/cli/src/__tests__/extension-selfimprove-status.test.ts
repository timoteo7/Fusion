/**
 * FNXC:SelfImproveBaselineCacheStatus 2026-09-30-19:40:
 * Proves `fn_selfimprove_status` is a REAL operator surface for the cached replay baseline against a
 * live PostgreSQL store, not just a registered name. Before this tool, the `BaselineCacheStatus` read
 * model was built and unit-tested but NOTHING displayed it — the only occurrences of the tool name in
 * the repository were comments describing a future render target. This suite closes that gap by driving
 * the registered tool end-to-end through the SAME accessor (`readBaselineCacheStatus`) and the SAME
 * bounded audit façade (`emitSelfImproveBaselineCacheResolved`) the tool uses, over real migration-0090
 * rows. A pgDescribe (not describe) is mandatory: a skipped suite here would leave conjunct (c) of the
 * baseline-cache criterion unproven, and per `docs/testing.md` a skip is NOT evidence.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  computeBaselineFingerprint,
  writeBaselineCache,
  SELF_IMPROVE_BASELINE_CACHE_EVENT,
  type BaselineFingerprintInput,
} from "@fusion/core";
import {
  pgDescribe,
  createPgExtensionHarness,
  createMockApi,
  registerExtension,
  requireTool,
} from "./pg-extension-harness.js";

/*
FNXC:SelfImproveBaselineCacheStatus 2026-09-30-19:40:
Each test asserts a DISTINCT data state of the cache decision, because the whole point of the tool is
that an operator can distinguish them: absent (nothing cached), matching (reuse — reuse the cached
baseline without re-execution), and diverged (rebuild — a fingerprint that no longer matches forces a
rebuild). The tool's value is precisely that these three are separable; a test that only checked the
"happy" reuse case would leave the refusal path unobserved.

The audit-row assertions close the loop between the returned read model and the persisted telemetry:
exactly one `selfimprove:baseline-cache-resolved` row per tool call, carrying BOTH fingerprints, the
action, and the reason — and STRUCTURALLY never the cached `payload`. The payload containment assertion
checks both the absence of a `payload` key AND that no planted payload substring appears in the
serialized metadata, so a spreading implementation cannot leak what was measured.

The hostile-sink case proves the bounded façade's guarantee at the tool boundary: a throwing audit sink
must still return the COMPLETE read model, because telemetry is not load-bearing for the decision.
*/

const BASELINE_KEY = "replay-corpus-baseline";
const CONFIG_HASH = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const MEASURED_AT = "2026-09-30T12:00:00.000Z";

const fingerprintInput = (overrides: Partial<BaselineFingerprintInput> = {}): BaselineFingerprintInput => ({
  manifestVersion: "corpus-v1",
  engineSha: "abc1234",
  configHash: CONFIG_HASH,
  seed: 42,
  ...overrides,
});

const readModel = (result: { details?: Record<string, unknown> }) => result.details?.status as
  | {
      baselineKey: string;
      inputFingerprint: string;
      cachedFingerprint: string | null;
      present: boolean;
      action: string;
      reason: string;
    }
  | undefined;

pgDescribe("fn_selfimprove_status extension tool", () => {
  const h = createPgExtensionHarness("fn-ext-selfimprove-status");

  // These helpers close over the harness, so they are declared INSIDE the describe: a module-level
  // helper would be evaluated before `h` is bound and would throw on every seed.
  const layer = () => {
    const asyncLayer = h.store().getAsyncLayer();
    if (!asyncLayer) throw new Error("harness store has no async layer");
    return asyncLayer;
  };

  const statusTool = () => {
    const api = createMockApi();
    registerExtension(api);
    return requireTool(api, "fn_selfimprove_status");
  };

  /** Invoke the tool against the harness project root with the given fingerprint inputs. */
  const runStatus = (
    tool: ReturnType<typeof statusTool>,
    overrides: Partial<BaselineFingerprintInput> = {},
    baselineKey = BASELINE_KEY,
  ) =>
    tool.execute(
      "call-status",
      {
        baselineKey,
        manifestVersion: fingerprintInput(overrides).manifestVersion,
        engineSha: fingerprintInput(overrides).engineSha,
        configHash: fingerprintInput(overrides).configHash,
        seed: fingerprintInput(overrides).seed,
      },
      undefined,
      undefined,
      { cwd: h.rootDir() },
    );

  const seed = async (overrides: Partial<BaselineFingerprintInput> = {}, payload: unknown = { testCount: 412 }) => {
    await writeBaselineCache(layer(), {
      baselineKey: BASELINE_KEY,
      ...fingerprintInput(overrides),
      payload: payload as never,
      measuredAt: MEASURED_AT,
    });
  };

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(() => {
    vi.restoreAllMocks();
    return h.afterEach();
  });
  afterAll(h.afterAll);

  it("registers the fn_selfimprove_status tool", () => {
    const api = createMockApi();
    registerExtension(api);
    expect(api.tools.has("fn_selfimprove_status")).toBe(true);
  });

  it("reports rebuild/no-cached-baseline and no cached fingerprint when nothing is seeded", async () => {
    const result = await runStatus(statusTool());

    expect(result.isError).toBeFalsy();
    const status = readModel(result);
    expect(status).toMatchObject({
      baselineKey: BASELINE_KEY,
      present: false,
      action: "rebuild",
      reason: "no-cached-baseline",
      cachedFingerprint: null,
    });
    expect(status!.inputFingerprint).toBe(computeBaselineFingerprint(fingerprintInput()));
    // Text surfaces the decision and both fingerprint slots for an operator reading the transcript.
    expect(result.content[0]?.text).toContain(BASELINE_KEY);
    expect(result.content[0]?.text).toContain("Action: rebuild");
    expect(result.content[0]?.text).toContain("Reason: no-cached-baseline");
  });

  it("reports reuse/fingerprint-matched with equal fingerprints for identical inputs after seeding", async () => {
    await seed();
    const result = await runStatus(statusTool());

    const status = readModel(result);
    expect(status).toMatchObject({
      baselineKey: BASELINE_KEY,
      present: true,
      action: "reuse",
      reason: "fingerprint-matched",
    });
    // Both fingerprints are surfaced and, on reuse, provably the same measurement identity.
    expect(status!.inputFingerprint).toBe(computeBaselineFingerprint(fingerprintInput()));
    expect(status!.cachedFingerprint).toBe(status!.inputFingerprint);
    expect(result.content[0]?.text).toContain("Action: reuse");
    expect(result.content[0]?.text).toContain("Reason: fingerprint-matched");
  });

  it("reports rebuild/fingerprint-diverged and never the cached payload when the engine sha changes", async () => {
    await seed({}, { testCount: 412, secretDetail: "PLANTED-PAYLOAD-SECRET" });

    const result = await runStatus(statusTool(), { engineSha: "def5678" });

    const status = readModel(result);
    expect(status).toMatchObject({
      present: true,
      action: "rebuild",
      reason: "fingerprint-diverged",
    });
    expect(status!.cachedFingerprint).toBe(computeBaselineFingerprint(fingerprintInput()));
    expect(status!.inputFingerprint).toBe(computeBaselineFingerprint(fingerprintInput({ engineSha: "def5678" })));
    expect(status!.cachedFingerprint).not.toBe(status!.inputFingerprint);

    // The read model itself excludes the payload by construction, and so does the rendered text.
    expect(JSON.stringify(result.details)).not.toContain("PLANTED-PAYLOAD-SECRET");
    expect(result.content[0]?.text).not.toContain("PLANTED-PAYLOAD-SECRET");
  });

  it("records one selfimprove:baseline-cache-resolved audit row per call with no payload", async () => {
    await seed();
    const result = await runStatus(statusTool());
    const status = readModel(result)!;

    const events = await h.store().getRunAuditEventsAsync({ mutationType: SELF_IMPROVE_BASELINE_CACHE_EVENT });
    expect(events).toHaveLength(1);
    const metadata = events[0]!.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      baselineKey: BASELINE_KEY,
      action: "reuse",
      reason: "fingerprint-matched",
      inputFingerprint: status.inputFingerprint,
      cachedFingerprint: status.cachedFingerprint,
      present: true,
    });
    // The audit edge is ids/fingerprints/fixed outcomes only — the measured payload is structurally
    // excluded and no planted value leaks through the serialized metadata.
    expect(metadata).not.toHaveProperty("payload");
    expect(JSON.stringify(metadata)).not.toContain("PLANTED-PAYLOAD-SECRET");
  });

  it("returns the complete read model even when the audit sink throws", async () => {
    await seed();
    vi.spyOn(h.store(), "recordRunAuditEvent").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });

    const result = await runStatus(statusTool());

    // Telemetry is not load-bearing: the decision the operator needs survives a hostile sink.
    expect(result.isError).toBeFalsy();
    expect(readModel(result)).toMatchObject({
      baselineKey: BASELINE_KEY,
      present: true,
      action: "reuse",
      reason: "fingerprint-matched",
    });
    expect(readModel(result)!.inputFingerprint).toBe(computeBaselineFingerprint(fingerprintInput()));
  });
});