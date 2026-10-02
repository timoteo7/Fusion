/*
FNXC:ReviewItemIdentity 2026-09-29-10:40:
A PR comment's review-item key is an IDENTITY, and the `gh` CLI transport hands us a GraphQL node id
(`IC_kwDOT5Q-Ec8AAAABXrfTmw`), not the REST numeric id. The historical `parseInt(c.id, 10)` therefore
returned `NaN`, and the key `gh-comment-${id}` collapsed to the constant `gh-comment-NaN` for every
comment on every PR — so distinct reviewer comments overwrote one another (last writer wins) in
`PrCommentHandler.upsertReviewItem`.

These tests pin the shared resolver's contract, not the repro:
1. a node id yields a stable, DISTINCT, non-NaN key (two comments never share a key),
2. a REST numeric id still resolves to itself (the already-correct sites must stay correct),
3. an unresolvable id THROWS rather than yielding NaN or a shared sentinel,
4. the sequence is monotonic and independent of the opaque id's text (same-second tie-break is
   deterministic and payload-position-independent),
5. the key survives the store round-trip unchanged on the real store backend.

Criterion: asserting "the key is a string" is theatre. Every assertion here distinguishes two comments.
*/
import { describe, expect, it } from "vitest";
import {
  resolvePrCommentIdentity,
  buildPrCommentReviewItemId,
  PrCommentIdentityError,
} from "../types/task/task-review.js";
import {
  pgDescribe,
  createTaskStoreForTest,
  type PgTestHarness,
} from "../__test-utils__/pg-test-harness.js";

const NODE_ID_A = "IC_kwDOT5Q-Ec8AAAABXrfTmw";
const NODE_ID_B = "IC_kwDOT5Q-Ec8AAAABXrfTmz";

describe("resolvePrCommentIdentity", () => {
  it("resolves a REST numeric id to itself for both key and sequence", () => {
    const resolved = resolvePrCommentIdentity({ id: "5884072859", createdAt: "2024-01-02T00:00:00Z" });

    // The key keeps its numeric type so the public `PrComment.id` contract on the REST path is
    // unchanged by this fix; both roles resolve to the same real id.
    expect(resolved.key).toBe(5884072859);
    expect(resolved.sequence).toBe(5884072859);
  });

  it("resolves a numeric-string id to the same numeric key and sequence", () => {
    const resolved = resolvePrCommentIdentity({ id: "100", createdAt: "2024-01-02T00:00:00Z" });

    expect(resolved.key).toBe(100);
    expect(resolved.sequence).toBe(100);
  });

  it("gives a GraphQL node id a stable key that is neither NaN nor shared", () => {
    const a = resolvePrCommentIdentity({ id: NODE_ID_A, createdAt: "2024-01-02T00:00:00Z" });
    const b = resolvePrCommentIdentity({ id: NODE_ID_B, createdAt: "2024-01-02T00:00:00Z" });

    expect(a.key).not.toBe("NaN");
    expect(b.key).not.toBe("NaN");
    expect(a.key).not.toBe(b.key);
    // A node id must never be handed back raw as a "number".
    expect(Number.isNaN(Number(a.key))).toBe(true);
  });

  it("is deterministic: the same node id resolves to the same key across calls", () => {
    const first = resolvePrCommentIdentity({ id: NODE_ID_A, createdAt: "2024-01-02T00:00:00Z" });
    const second = resolvePrCommentIdentity({ id: NODE_ID_A, createdAt: "2024-01-02T00:00:00Z" });

    expect(first.key).toBe(second.key);
    expect(first.sequence).toBe(second.sequence);
  });

  it("throws a named error for an unresolvable id instead of returning NaN or a sentinel", () => {
    expect(() => resolvePrCommentIdentity({ id: "", createdAt: "2024-01-02T00:00:00Z" })).toThrow(PrCommentIdentityError);
    expect(() => resolvePrCommentIdentity({ id: "   ", createdAt: "2024-01-02T00:00:00Z" })).toThrow(PrCommentIdentityError);
    expect(() => resolvePrCommentIdentity({ id: undefined, createdAt: "2024-01-02T00:00:00Z" })).toThrow(PrCommentIdentityError);
  });

  it("never coerces an unresolvable id to 0 or a shared sentinel", () => {
    let caught: unknown;
    try {
      resolvePrCommentIdentity({ id: "", createdAt: "2024-01-02T00:00:00Z" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PrCommentIdentityError);
    expect(String(caught)).not.toContain("0");
  });

  it("derives the sequence from createdAt for a node id, not from the id text", () => {
    // `IC_aaa…` sorts BEFORE `IC_kwD…` lexicographically, so a text-derived sequence would order
    // these backwards. The createdAt-derived sequence must reflect creation order instead.
    const earlier = resolvePrCommentIdentity({ id: "IC_aaa0000000000", createdAt: "2024-01-01T00:00:00Z" });
    const later = resolvePrCommentIdentity({ id: NODE_ID_B, createdAt: "2024-01-02T00:00:00Z" });

    expect(earlier.sequence).toBeLessThan(later.sequence);
  });

  it("breaks same-second ties deterministically and independently of payload order", () => {
    const a = resolvePrCommentIdentity({ id: NODE_ID_A, createdAt: "2024-01-01T00:00:00Z" });
    const b = resolvePrCommentIdentity({ id: NODE_ID_B, createdAt: "2024-01-01T00:00:00Z" });

    // Same createdAt, different ids: the pair must order consistently in both directions.
    const forward = a.sequence < b.sequence;
    const reversed = b.sequence < a.sequence;
    expect(forward).not.toBe(reversed);
    expect(a.sequence).not.toBe(b.sequence);
  });
});

describe("buildPrCommentReviewItemId", () => {
  it("builds distinct gh-comment keys for two distinct node ids", () => {
    const idA = buildPrCommentReviewItemId(NODE_ID_A);
    const idB = buildPrCommentReviewItemId(NODE_ID_B);

    expect(idA).not.toBe(idB);
    expect(idA).not.toContain("NaN");
    expect(idB).not.toContain("NaN");
  });

  it("builds the historical key shape for a REST numeric id", () => {
    expect(buildPrCommentReviewItemId("5884072859")).toBe("gh-comment-5884072859");
    expect(buildPrCommentReviewItemId(5884072859)).toBe("gh-comment-5884072859");
  });
});

pgDescribe("TaskStore review item identity round-trip", () => {
  let harness: PgTestHarness | null = null;

  async function makeHarness(): Promise<PgTestHarness> {
    harness = await createTaskStoreForTest({ prefix: "fusion_review_identity" });
    return harness;
  }

  async function teardown(): Promise<void> {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  }

  it("round-trips a node-id-derived review key unchanged and keeps two comments distinct", async () => {
    const h = await makeHarness();
    try {
      const store = h.store;
      const created = await store.createTask({
        description: "node-id review keys",
        column: "in-review",
      });

      const keyA = buildPrCommentReviewItemId(NODE_ID_A);
      const keyB = buildPrCommentReviewItemId(NODE_ID_B);
      expect(keyA).not.toBe(keyB);

      const items = [
        {
          id: keyA,
          githubCommentId: undefined,
          body: "First reviewer feedback",
          author: { login: "reviewer1" },
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          htmlUrl: "https://github.com/owner/repo/pull/42#issuecomment-1",
          source: "github-pr" as const,
        },
        {
          id: keyB,
          githubCommentId: undefined,
          body: "Second reviewer feedback",
          author: { login: "reviewer2" },
          createdAt: "2024-01-02T00:00:00.000Z",
          updatedAt: "2024-01-02T00:00:00.000Z",
          htmlUrl: "https://github.com/owner/repo/pull/42#issuecomment-2",
          source: "github-pr" as const,
        },
      ];

      await store.updateTask(created.id, {
        reviewState: { source: "github-pr", items, addressing: [] },
      });

      const reloaded = await store.getTask(created.id);
      const reloadedItems = reloaded.reviewState?.items ?? [];

      // Both keys survive the store verbatim — the identity is not mangled on the way in or out.
      expect(reloadedItems.map((item) => item.id)).toEqual([keyA, keyB]);
      expect(reloadedItems.map((item) => item.body)).toEqual([
        "First reviewer feedback",
        "Second reviewer feedback",
      ]);
    } finally {
      await teardown();
    }
  });
});