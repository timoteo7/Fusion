/*
FNXC:LifecycleColumnCensus 2026-08-13-21:50:
Mailbox folder tabs reuse the word `archived`. FN-9014's `activeTab === "archived"` comparisons
are folder switches, not board-column guards. Pin the receiver so the lifecycle ratchet cannot
block unrelated PRs the way it blocked wave20 after rebasing onto that mailbox change.
*/
import test from "node:test";
import assert from "node:assert/strict";

import { findComparisons } from "../lib/lifecycle-column-census-ast.mjs";

test("activeTab archived comparisons stay out of the column backlog", () => {
  const findings = findComparisons(
    "MailboxView.tsx",
    'if (activeTab === "archived") loadArchivedInbox();',
  );

  assert.deepEqual(
    findings.map(({ columnId, receiver, kind }) => ({ columnId, receiver, kind })),
    [{ columnId: "archived", receiver: "activeTab", kind: "role" }],
  );
});
