/*
FNXC:ReviewItemIdentity 2026-09-29-10:40:
PostgreSQL twin of review-item-identity.test.ts.

The repo's SQLite `new TaskStore(root)` path was deleted (FNXC:SqliteFinalRemoval / VAL-REMOVAL-005),
so the backend-agnostic core store test and this explicit PG twin both run against an isolated
PostgreSQL database via the shared harness. What the twin adds over the core test is the
backend-mode store path (`store.backendMode` true — `reviewState` persisted as `jsonb` rather than
a JSON column), proving the node-id-derived review key round-trips identically on both
serialization paths. Auto-skipped without PostgreSQL via `pgDescribe`.
*/
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { buildPrCommentReviewItemId } from "../../types/task/task-review.js";

const pgTest = pgDescribe;

const NODE_ID_A = "IC_kwDOT5Q-Ec8AAAABXrfTmw";
const NODE_ID_B = "IC_kwDOT5Q-Ec8AAAABXrfTmz";

pgTest("TaskStore review item identity round-trip (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_review_identity_pg",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("preserves node-id-derived review keys and keeps two comments distinct", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "node-id review keys", column: "in-review" });

    const keyA = buildPrCommentReviewItemId(NODE_ID_A);
    const keyB = buildPrCommentReviewItemId(NODE_ID_B);
    expect(keyA).not.toBe(keyB);

    await store.updateTask(task.id, {
      reviewState: {
        source: "github-pr",
        items: [
          {
            id: keyA,
            body: "First reviewer feedback",
            author: { login: "reviewer1" },
            createdAt: "2024-01-01T00:00:00.000Z",
            source: "github-pr",
          },
          {
            id: keyB,
            body: "Second reviewer feedback",
            author: { login: "reviewer2" },
            createdAt: "2024-01-02T00:00:00.000Z",
            source: "github-pr",
          },
        ],
        addressing: [],
      },
    });

    const reloaded = await store.getTask(task.id);
    const items = reloaded.reviewState?.items ?? [];

    expect(items.map((item) => item.id)).toEqual([keyA, keyB]);
    expect(items.map((item) => item.body)).toEqual([
      "First reviewer feedback",
      "Second reviewer feedback",
    ]);
  });
});