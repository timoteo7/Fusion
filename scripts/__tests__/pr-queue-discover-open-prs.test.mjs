/**
 * FNXC:PRQueue 2026-09-17-09:20:
 * FUSI-001's completeness claim ("zero PRs abertos de timoteo7 perdidos") is
 * proven by reconciliation between three discovery paths plus `gh pr view`
 * re-verification, so these tests are fixture-driven: they exercise the pure
 * classifiers and the whole discovery/reconciliation pipeline through the
 * injected `gh` runner seam, with no network and no real GitHub state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AWAITING_FIRST_REVIEW,
  buildQueue,
  buildSnapshot,
  classifyChecks,
  computeQueueHash,
  createGhRunner,
  isBotAuthor,
  parseGreptileScore,
  reconcileCandidates,
  renderMarkdown,
  selectGreptileState,
  splitThreads,
} from "../pr-queue/discover-open-prs.mjs";

test("parseGreptileScore accepts the formats Greptile posts", () => {
  assert.equal(parseGreptileScore("Confidence Score: 4/5"), 4);
  assert.equal(parseGreptileScore("**Confidence Score**: 5/5"), 5);
  assert.equal(parseGreptileScore("Confidence Score: 4.5/5"), 4.5);
  assert.equal(parseGreptileScore("confidence score: 3 / 5"), 3);
});

test("parseGreptileScore rejects bodies without a usable score", () => {
  assert.equal(parseGreptileScore(""), null);
  assert.equal(parseGreptileScore(null), null);
  assert.equal(parseGreptileScore("No score here, just prose about a 4/5 tradeoff"), null);
  assert.equal(parseGreptileScore("Confidence Score: 7/5"), null);
});

test("isBotAuthor only classifies on positive bot evidence", () => {
  assert.equal(isBotAuthor("greptile-apps"), true);
  assert.equal(isBotAuthor("coderabbitai"), true);
  assert.equal(isBotAuthor("dependabot[bot]"), true);
  assert.equal(isBotAuthor("some-review-bot"), true);
  assert.equal(isBotAuthor("timoteo7"), false);
  assert.equal(isBotAuthor("igorpadovan"), false);
  assert.equal(isBotAuthor(null), false);
});

test("classifyChecks aggregates rollup into pass/fail/pending/none", () => {
  assert.deepEqual(classifyChecks([]), { state: "none", total: 0, failing: [], pending: [] });
  assert.deepEqual(
    classifyChecks([
      { name: "Build", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Lint", status: "COMPLETED", conclusion: "FAILURE" },
    ]),
    { state: "fail", total: 2, failing: ["Lint"], pending: [] },
  );
  assert.deepEqual(
    classifyChecks([
      { name: "Build", status: "IN_PROGRESS", conclusion: null },
      { context: "codecov", state: "PENDING" },
    ]),
    { state: "pending", total: 2, failing: [], pending: ["Build", "codecov"] },
  );
  assert.deepEqual(
    classifyChecks([{ context: "codecov", state: "SUCCESS" }]),
    { state: "pass", total: 1, failing: [], pending: [] },
  );
});

test("splitThreads separates bot from human and drops resolved threads", () => {
  const threads = [
    { id: "T1", isResolved: false, isOutdated: false, path: "a.ts", comments: { nodes: [{ author: { login: "greptile-apps" } }] } },
    { id: "T2", isResolved: true, isOutdated: false, path: "b.ts", comments: { nodes: [{ author: { login: "coderabbitai" } }] } },
    { id: "T3", isResolved: false, isOutdated: true, path: "c.ts", comments: { nodes: [{ author: { login: "teknium1" } }] } },
    { id: "T4", isResolved: false, isOutdated: false, path: "d.ts", comments: { nodes: [{ author: { login: "coderabbitai" } }] } },
  ];
  const { botThreads, humanThreads } = splitThreads(threads);
  assert.deepEqual(botThreads.map((t) => t.id), ["T1", "T4"]);
  assert.deepEqual(humanThreads.map((t) => t.id), ["T3"]);
  assert.equal(humanThreads[0].isOutdated, true);
});

test("selectGreptileState labels PRs with no Greptile review literally", () => {
  const state = selectGreptileState({
    comments: [{ id: "C1", author: { login: "igorpadovan" }, body: "looks good", createdAt: "2026-09-01T00:00:00Z" }],
    reviews: [],
    checks: [{ name: "CI", conclusion: "SUCCESS" }],
  });
  assert.equal(state.status, AWAITING_FIRST_REVIEW);
  assert.equal(state.score, null);
  assert.equal(state.reviewedCommit, null);
});

test("selectGreptileState prefers the most recently updated Greptile message", () => {
  const state = selectGreptileState({
    comments: [
      { id: "OLD", author: { login: "greptile-apps" }, body: "Confidence Score: 2/5", createdAt: "2026-09-01T00:00:00Z" },
      {
        id: "NEW",
        author: { login: "greptile-apps" },
        body: "Confidence Score: 5/5",
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-02T00:00:00Z",
      },
    ],
    reviews: [
      { author: { login: "greptile-apps" }, submittedAt: "2026-09-01T10:00:00Z", commit: { oid: "aaa111" } },
      { author: { login: "greptile-apps" }, submittedAt: "2026-09-02T10:00:00Z", commit: { oid: "bbb222" } },
    ],
    checks: [{ name: "Greptile Review", conclusion: "SUCCESS" }],
  });
  assert.equal(state.status, "scored");
  assert.equal(state.score, 5);
  assert.equal(state.scoreRaw, "5/5");
  assert.equal(state.reviewedCommit, "bbb222");
  assert.equal(state.checkState, "SUCCESS");
  assert.equal(state.source.id, "NEW");
});

test("reconcileCandidates unions the three paths and reports discrepancies", () => {
  const { candidates, discrepancies } = reconcileCandidates({
    "search-prs": [{ repo: "o/r", number: 2 }],
    "search-issues": [{ repo: "o/r", number: 2 }, { repo: "o/r", number: 1 }],
    "repo-list": [{ repo: "o/r", number: 2 }],
  });
  assert.deepEqual(candidates.map((c) => c.number), [1, 2]);
  assert.deepEqual(candidates[1].foundBy, ["repo-list", "search-issues", "search-prs"]);
  assert.deepEqual(discrepancies, [{ repo: "o/r", number: 1, missingFrom: ["repo-list", "search-prs"] }]);
});

function fixturePr(overrides = {}) {
  return {
    repo: "o/r",
    number: 1,
    title: "t",
    url: "https://example.test/pull/1",
    branch: "b",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    foundBy: ["repo-list", "search-issues", "search-prs"],
    greptile: { status: AWAITING_FIRST_REVIEW, score: null, scoreRaw: null, reviewedCommit: null, checkState: null, source: null },
    threads: { botThreads: [], humanThreads: [] },
    ci: { state: "pass", total: 1, failing: [], pending: [] },
    ...overrides,
  };
}

test("computeQueueHash is stable across volatile changes and sensitive to state", () => {
  const base = buildSnapshot({ prs: [fixturePr()], generatedAt: "2026-09-17T00:00:00Z" });
  const refetched = buildSnapshot({ prs: [fixturePr()], generatedAt: "2026-09-17T06:00:00Z" });
  assert.equal(base.queueHash, refetched.queueHash);

  const reordered = buildSnapshot({ prs: [fixturePr({ number: 9 }), fixturePr({ number: 1 })] });
  const ordered = buildSnapshot({ prs: [fixturePr({ number: 1 }), fixturePr({ number: 9 })] });
  assert.equal(reordered.queueHash, ordered.queueHash);

  const resolvedThread = buildSnapshot({
    prs: [
      fixturePr({
        threads: { botThreads: [{ id: "T1", path: "a.ts", author: "greptile-apps", isOutdated: false }], humanThreads: [] },
      }),
    ],
  });
  assert.notEqual(base.queueHash, resolvedThread.queueHash);

  const scored = buildSnapshot({
    prs: [fixturePr({ greptile: { status: "scored", score: 4, scoreRaw: "4/5", reviewedCommit: "abc", checkState: "SUCCESS", source: null } })],
  });
  assert.notEqual(base.queueHash, scored.queueHash);
});

test("buildSnapshot orders PRs by repo then number", () => {
  const snapshot = buildSnapshot({
    prs: [fixturePr({ repo: "b/r", number: 1 }), fixturePr({ repo: "a/r", number: 9 }), fixturePr({ repo: "a/r", number: 2 })],
  });
  assert.deepEqual(snapshot.prs.map((p) => `${p.repo}#${p.number}`), ["a/r#2", "a/r#9", "b/r#1"]);
  assert.match(snapshot.queueHash, /^sha256:[0-9a-f]{64}$/);
});

test("renderMarkdown surfaces the awaiting marker and unresolved bot threads", () => {
  const snapshot = buildSnapshot({
    prs: [
      fixturePr({
        greptile: { status: "scored", score: 4, scoreRaw: "4/5", reviewedCommit: "abc", checkState: "SUCCESS", source: null },
        threads: { botThreads: [{ id: "T1", path: "a.ts", author: "greptile-apps", isOutdated: false }], humanThreads: [] },
      }),
      fixturePr({ number: 2 }),
    ],
  });
  const md = renderMarkdown(snapshot);
  assert.match(md, new RegExp(AWAITING_FIRST_REVIEW));
  assert.match(md, /o\/r#1 · `a\.ts` · greptile-apps · `T1`/);
  assert.match(md, /## Unresolved bot threads \(1\)/);
});

/**
 * Fake `gh` executor: dispatches on argv so the pipeline under test sees the
 * same JSON shapes the real CLI returns.
 */
function fakeGh({ searchPrs, searchIssues, repoList, views, threads }) {
  return createGhRunner({
    exec: (args) => {
      const [group, command] = args;
      if (group === "search" && command === "prs") return JSON.stringify(searchPrs);
      if (group === "search" && command === "issues") return JSON.stringify(searchIssues);
      if (group === "pr" && command === "list") {
        const repo = args[args.indexOf("--repo") + 1];
        return JSON.stringify(repoList[repo] ?? []);
      }
      if (group === "pr" && command === "view") {
        const number = Number(args[2]);
        return JSON.stringify(views[number]);
      }
      if (group === "api" && command === "graphql") {
        const number = Number(args[args.indexOf("-F") + 1].split("=")[1]);
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads[number] ?? [] } } } } });
      }
      throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
    },
  });
}

test("buildQueue discovery reconciles three paths and collects per-PR state", () => {
  const greptileComment = {
    id: "IC1",
    author: { login: "greptile-apps" },
    body: "**Confidence Score**: 4/5",
    createdAt: "2026-09-10T00:00:00Z",
  };
  const gh = fakeGh({
    searchPrs: [
      { number: 11, repository: { nameWithOwner: "o/r" }, title: "scored PR", url: "u11" },
      { number: 12, repository: { nameWithOwner: "o/r" }, title: "fresh PR", url: "u12" },
    ],
    searchIssues: [
      { number: 11, repository: { nameWithOwner: "o/r" }, title: "scored PR", url: "u11", isPullRequest: true },
      { number: 12, repository: { nameWithOwner: "o/r" }, title: "fresh PR", url: "u12", isPullRequest: true },
      { number: 99, repository: { nameWithOwner: "o/r" }, title: "plain issue", url: "u99", isPullRequest: false },
    ],
    repoList: {
      "o/r": [
        { number: 11, title: "scored PR", url: "u11", headRefName: "b11", isDraft: false },
        { number: 12, title: "fresh PR", url: "u12", headRefName: "b12", isDraft: false },
      ],
    },
    views: {
      11: {
        number: 11,
        title: "scored PR",
        state: "OPEN",
        url: "u11",
        headRefName: "b11",
        isDraft: false,
        mergeStateStatus: "BLOCKED",
        author: { login: "timoteo7" },
        comments: [greptileComment, { id: "C2", author: { login: "timoteo7" }, body: "thanks", createdAt: "2026-09-11T00:00:00Z" }],
        reviews: [{ author: { login: "greptile-apps" }, submittedAt: "2026-09-10T01:00:00Z", commit: { oid: "commit11" } }],
        statusCheckRollup: [
          { name: "Lint", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "Greptile Review", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      },
      12: {
        number: 12,
        title: "fresh PR",
        state: "OPEN",
        url: "u12",
        headRefName: "b12",
        isDraft: true,
        mergeStateStatus: "UNKNOWN",
        author: { login: "timoteo7" },
        comments: [],
        reviews: [],
        statusCheckRollup: [{ name: "Gate", status: "COMPLETED", conclusion: "FAILURE" }],
      },
    },
    threads: {
      11: [
        { id: "T1", isResolved: false, isOutdated: false, path: "a.ts", comments: { nodes: [{ author: { login: "greptile-apps" } }] } },
        { id: "T2", isResolved: true, isOutdated: false, path: "b.ts", comments: { nodes: [{ author: { login: "coderabbitai" } }] } },
      ],
      12: [],
    },
  });

  const { snapshot, problems } = buildQueue({ gh, limit: 100 });
  assert.equal(problems, 0);
  assert.deepEqual(snapshot.prs.map((p) => p.number), [11, 12]);

  const scored = snapshot.prs[0];
  assert.equal(scored.greptile.status, "scored");
  assert.equal(scored.greptile.score, 4);
  assert.equal(scored.greptile.reviewedCommit, "commit11");
  assert.equal(scored.greptile.checkState, "SUCCESS");
  assert.equal(scored.mergeStateStatus, "BLOCKED");
  assert.deepEqual(scored.threads.botThreads.map((t) => t.id), ["T1"]);
  assert.deepEqual(scored.ci, { state: "pass", total: 2, failing: [], pending: [] });

  const fresh = snapshot.prs[1];
  assert.equal(fresh.greptile.status, AWAITING_FIRST_REVIEW);
  assert.deepEqual(fresh.ci, { state: "fail", total: 1, failing: ["Gate"], pending: [] });

  // The `isPullRequest: false` search hit must never become a candidate.
  assert.equal(snapshot.prs.some((p) => p.number === 99), false);
  assert.deepEqual(snapshot.discovery.paths, {
    "search-prs": { count: 2, error: null },
    "search-issues": { count: 2, error: null },
    "repo-list": { count: 2, error: null },
  });
});

test("buildQueue reports a candidate that fails gh pr view re-verification", () => {
  const gh = fakeGh({
    searchPrs: [{ number: 21, repository: { nameWithOwner: "o/r" }, title: "closed", url: "u21" }],
    searchIssues: [{ number: 21, repository: { nameWithOwner: "o/r" }, title: "closed", url: "u21", isPullRequest: true }],
    repoList: { "o/r": [{ number: 21, title: "closed", url: "u21", headRefName: "b21", isDraft: false }] },
    views: {
      21: {
        number: 21,
        title: "closed",
        state: "CLOSED",
        url: "u21",
        headRefName: "b21",
        isDraft: false,
        mergeStateStatus: "UNKNOWN",
        author: { login: "timoteo7" },
        comments: [],
        reviews: [],
        statusCheckRollup: [],
      },
    },
    threads: { 21: [] },
  });

  const { snapshot, ineligible, problems } = buildQueue({ gh });
  assert.deepEqual(ineligible, ["o/r#21"]);
  assert.equal(problems, 1);
  assert.equal(snapshot.prs.length, 0);
  assert.deepEqual(snapshot.discovery.ineligible, ["o/r#21"]);
});
