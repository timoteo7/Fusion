import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import * as schema from "../../postgres/schema/index.js";
import {
  readBaselineCache,
  readBaselineCacheStatus,
  writeBaselineCache,
} from "../../task-store/async/async-learning-baseline-cache.js";
import { computeBaselineFingerprint } from "../../self-improve/baseline-fingerprint.js";
import type { BaselineFingerprintInput } from "../../types/self-improve/baseline-cache.js";

/*
FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
This exercises the PERSISTED cache through the real accessor, on a real database, because a
pure-helper test can never show that migration 0090 actually creates
`project.learning_baseline_cache` with the shape the accessor writes, nor that the database CHECKs
reject a drifted fingerprint. The pure identity contract lives in
`self-improve-baseline-fingerprint-pure.test.ts`; this suite proves the DURABLE half.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
The idempotence and replacement behaviors are the load-bearing assertions and are asserted by ROW
COUNT, not just by "the read-back value equals what I wrote". "Identical re-store stays one row" is
the property that separates a cache from an append-only trail; a test that only read back the newest
value would pass even if a second row had been appended. The replacement case then asserts both that
the row count stayed at one AND that the fingerprint and payload changed, so "replaced" cannot be
satisfied by a write that silently no-opped.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
`created_at` surviving a replacement is asserted explicitly. That column is what makes a forced
rebuild distinguishable from the original measurement; if a future edit added it to the DO UPDATE SET
list, "when was this first measured" would silently become "when was this last measured" and the
distinction this table exists to preserve would be lost with no functional failure to warn about it.

FNXC:SelfImproveBaselineCache 2026-09-30-18:53:
The CHECK rejections are matched on the CONSTRAINT NAME read through the `cause` chain rather than
the error message, because Drizzle wraps every driver failure in a DrizzleQueryError whose own
message is only `Failed query: <sql>`. This mirrors the 0089 gate-verdict pg suite so the two
self-improvement tables are verified the same way.
*/

const BASELINE_KEY = "baseline-1";
const CONFIG_HASH = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const MEASURED_AT = "2026-09-30T12:00:00.000Z";
const REBUILT_AT = "2026-09-30T13:00:00.000Z";

const fingerprintInput = (overrides: Partial<BaselineFingerprintInput> = {}): BaselineFingerprintInput => ({
  manifestVersion: "corpus-v1",
  engineSha: "abc1234",
  configHash: CONFIG_HASH,
  seed: 42,
  ...overrides,
});

pgDescribe("self-improvement learning baseline cache (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_selfimprove_baseline",
    projectId: "self-improve-baseline-test",
  });

  beforeAll(async () => {
    await h.beforeAll();
    await applySchemaBaseline(h.adminDb());
  });
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });
  afterAll(h.afterAll);

  const projectId = () => h.layer().projectId!;

  const countRows = (baselineKey: string) =>
    h.adminDb()
      .select()
      .from(schema.project.learningBaselineCache)
      .where(and(
        eq(schema.project.learningBaselineCache.projectId, projectId()),
        eq(schema.project.learningBaselineCache.baselineKey, baselineKey),
      ));

  /**
   * Reject a write on the named CHECK, matching on the CONSTRAINT NAME through the `cause` chain.
   * Drizzle wraps driver failures, so the constraint name never appears in the outer message.
   */
  const rejectsOnCheck = async (write: Promise<unknown>, constraint: string) => {
    const error = await write.then(() => null, (e: unknown) => e);
    expect(error, `expected the insert to be rejected by ${constraint}`).toBeTruthy();

    const chain: string[] = [];
    for (let current: unknown = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
      chain.push(String((current as { message?: unknown }).message ?? ""));
    }
    expect(chain.join("\n"), `no error in the cause chain cited ${constraint}`).toContain(constraint);
  };

  it("round-trips the cached baseline with the fingerprint derived from its own components", async () => {
    const payload = { testCount: 412, corpusDurationMs: 90_000 };
    const written = await writeBaselineCache(h.layer(), {
      baselineKey: BASELINE_KEY,
      ...fingerprintInput(),
      payload,
      measuredAt: MEASURED_AT,
    });

    const read = await readBaselineCache(h.layer(), BASELINE_KEY);

    expect(read).not.toBeNull();
    expect(read).toMatchObject({
      baselineKey: BASELINE_KEY,
      manifestVersion: "corpus-v1",
      engineSha: "abc1234",
      configHash: CONFIG_HASH,
      seed: 42,
      payload,
      createdAt: MEASURED_AT,
      updatedAt: MEASURED_AT,
    });
    // The persisted fingerprint is the DERIVED one, so the row's identity provably matches the
    // components stored beside it rather than a hand-written string that merely looks like a digest.
    expect(read!.inputFingerprint).toBe(computeBaselineFingerprint(fingerprintInput()));
    expect(written.inputFingerprint).toBe(read!.inputFingerprint);
  });

  it("returns null for an uncached key — the no-cached-baseline data state", async () => {
    expect(await readBaselineCache(h.layer(), "never-measured")).toBeNull();
  });

  it("is idempotent for an identical re-store: one row, unchanged", async () => {
    const payload = { testCount: 412 };
    await writeBaselineCache(h.layer(), { baselineKey: BASELINE_KEY, ...fingerprintInput(), payload, measuredAt: MEASURED_AT });
    await writeBaselineCache(h.layer(), { baselineKey: BASELINE_KEY, ...fingerprintInput(), payload, measuredAt: REBUILT_AT });

    const rows = await countRows(BASELINE_KEY);
    // ROW COUNT, not just the value: a cache that appended would hold two entries with no "current".
    expect(rows).toHaveLength(1);
    expect(rows[0]!.updatedAt).toBe(REBUILT_AT);
  });

  it("replaces in place when the fingerprint diverges, and preserves created_at", async () => {
    await writeBaselineCache(h.layer(), {
      baselineKey: BASELINE_KEY,
      ...fingerprintInput(),
      payload: { testCount: 412 },
      measuredAt: MEASURED_AT,
    });
    const original = await readBaselineCache(h.layer(), BASELINE_KEY);

    // Only the engine sha moves — one component of the four.
    const rebuilt = await writeBaselineCache(h.layer(), {
      baselineKey: BASELINE_KEY,
      ...fingerprintInput({ engineSha: "def5678" }),
      payload: { testCount: 418 },
      measuredAt: REBUILT_AT,
    });

    const rows = await countRows(BASELINE_KEY);
    // Replacement, not append AND not a silent no-op: still one row, but a different fingerprint
    // and a different payload, with the original measurement time preserved.
    expect(rows).toHaveLength(1);
    expect(rebuilt.inputFingerprint).toBe(computeBaselineFingerprint(fingerprintInput({ engineSha: "def5678" })));
    expect(rebuilt.inputFingerprint).not.toBe(original!.inputFingerprint);
    expect(rows[0]!.payload).toEqual({ testCount: 418 });
    expect(rows[0]!.createdAt).toBe(MEASURED_AT);
    expect(rows[0]!.updatedAt).toBe(REBUILT_AT);
  });

  it("keeps baseline keys independent of each other", async () => {
    await writeBaselineCache(h.layer(), { baselineKey: "baseline-a", ...fingerprintInput(), payload: { n: 1 }, measuredAt: MEASURED_AT });
    await writeBaselineCache(h.layer(), { baselineKey: "baseline-b", ...fingerprintInput({ seed: 7 }), payload: { n: 2 }, measuredAt: MEASURED_AT });

    expect(await readBaselineCache(h.layer(), "baseline-a")).toMatchObject({ payload: { n: 1 }, seed: 42 });
    expect(await readBaselineCache(h.layer(), "baseline-b")).toMatchObject({ payload: { n: 2 }, seed: 7 });
  });

  it("rejects a blank baseline key and a malformed fingerprint at the database", async () => {
    // Blank key: rejected by the accessor before it reaches the database, and by the CHECK if it does.
    await expect(writeBaselineCache(h.layer(), { baselineKey: "  ", ...fingerprintInput(), payload: {} }))
      .rejects.toThrow(/baselineKey/);

    // A bare-hex digest (0089's shape) is NOT the canonical `sha256:<hex>` shape this table accepts.
    const malformed = "a".repeat(64);
    await rejectsOnCheck(
      h.adminDb().insert(schema.project.learningBaselineCache).values({
        projectId: projectId(),
        baselineKey: "baseline-bad-fingerprint",
        manifestVersion: "corpus-v1",
        engineSha: "abc1234",
        configHash: CONFIG_HASH,
        seed: 42,
        inputFingerprint: malformed,
        payload: {},
        createdAt: MEASURED_AT,
        updatedAt: MEASURED_AT,
      }),
      "learning_baseline_cache_fingerprint_check",
    );

    // A blank key that bypasses the accessor is rejected by the key CHECK.
    await rejectsOnCheck(
      h.adminDb().insert(schema.project.learningBaselineCache).values({
        projectId: projectId(),
        baselineKey: "   ",
        manifestVersion: "corpus-v1",
        engineSha: "abc1234",
        configHash: CONFIG_HASH,
        seed: 42,
        inputFingerprint: computeBaselineFingerprint(fingerprintInput()),
        payload: {},
        createdAt: MEASURED_AT,
        updatedAt: MEASURED_AT,
      }),
      "learning_baseline_cache_key_check",
    );
  });

  it("reports reuse for a matching fingerprint, rebuild+diverged for a changed one, and rebuild+absent when uncached", async () => {
    // No cached baseline yet.
    const absent = await readBaselineCacheStatus(h.layer(), { baselineKey: BASELINE_KEY, fingerprintInput: fingerprintInput() });
    expect(absent).toMatchObject({ baselineKey: BASELINE_KEY, present: false, action: "rebuild", reason: "no-cached-baseline" });

    await writeBaselineCache(h.layer(), { baselineKey: BASELINE_KEY, ...fingerprintInput(), payload: { n: 1 }, measuredAt: MEASURED_AT });

    // Matching fingerprint → reuse, no re-execution required of the caller.
    const matching = await readBaselineCacheStatus(h.layer(), { baselineKey: BASELINE_KEY, fingerprintInput: fingerprintInput() });
    expect(matching).toMatchObject({
      present: true,
      action: "reuse",
      reason: "fingerprint-matched",
      inputFingerprint: computeBaselineFingerprint(fingerprintInput()),
    });

    // Each single-component change forces a rebuild, so a comparison is never silently made against
    // a baseline measured under different inputs.
    for (const changed of [
      fingerprintInput({ manifestVersion: "corpus-v2" }),
      fingerprintInput({ engineSha: "def5678" }),
      fingerprintInput({ configHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222" }),
      fingerprintInput({ seed: 43 }),
    ]) {
      const diverged = await readBaselineCacheStatus(h.layer(), { baselineKey: BASELINE_KEY, fingerprintInput: changed });
      expect(diverged).toMatchObject({ present: true, action: "rebuild", reason: "fingerprint-diverged" });
      expect(diverged.cachedFingerprint).toBe(computeBaselineFingerprint(fingerprintInput()));
      expect(diverged.inputFingerprint).toBe(computeBaselineFingerprint(changed));
    }
  });

  it("is project-scoped: another project's baseline key is simply absent", async () => {
    await writeBaselineCache(h.layer(), { baselineKey: BASELINE_KEY, ...fingerprintInput(), payload: { n: 1 }, measuredAt: MEASURED_AT });
    // Rows written under a different project_id must not be visible through this project-scoped read.
    const foreign = await h.adminDb().insert(schema.project.learningBaselineCache).values({
      projectId: "some-other-project",
      baselineKey: BASELINE_KEY,
      manifestVersion: "corpus-v1",
      engineSha: "abc1234",
      configHash: CONFIG_HASH,
      seed: 42,
      inputFingerprint: computeBaselineFingerprint(fingerprintInput()),
      payload: { n: 99 },
      createdAt: MEASURED_AT,
      updatedAt: MEASURED_AT,
    }).onConflictDoNothing().returning();

    // The foreign insert only lands when the harness's admin connection can bypass RLS; either way,
    // the PROJECT-SCOPED accessor must never return it.
    if (foreign.length > 0) {
      const read = await readBaselineCache(h.layer(), BASELINE_KEY);
      expect(read!.payload).toEqual({ n: 1 });
    }
  });
});
