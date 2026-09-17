/**
 * FNXC:PRQueueDiscovery 2026-09-17-11:10:
 * FUSI-001's completeness claim ("zero PRs abertos de timoteo7 perdidos") is proven by reconciliation between three discovery paths plus `gh pr view` re-verification, and its snapshot is a versioned contract consumed by FUSI-002/003/004. These tests therefore exercise the pure classifiers/parsers and the whole discovery → extraction → reconciliation → rendering pipeline through the injected `gh` runner seam, fully offline: fixtures are hand-built from the documented shapes (never captured live payloads replayed as truth), every filesystem write goes to a `mkdtempSync` directory, and the `$HOME`-anchored default output directory is never touched.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AWAITING_FIRST_REVIEW,
  buildQueue,
  buildSnapshot,
  canonicalQueueHash,
  classifyCheckRun,
  classifyScope,
  classifyThread,
  createGhRunner,
  deriveCiState,
  evaluateStrictGate,
  extractPrState,
  isBotAuthor,
  main,
  missingPrFields,
  parseGreptileScore,
  parseReviewedCommit,
  reconcile,
  renderMarkdown,
  selectGreptileState,
  summarizeThreads,
  writeSnapshot,
} from "../pr-queue/discover-open-prs.mjs";

const BOT_AUTHOR = { login: "coderabbitai", __typename: "Bot" };
const HUMAN_AUTHOR = { login: "teknium1", __typename: "User" };

test("parseGreptileScore reads the score and only the URL path of the reviewed-commit link", () => {
  assert.deepEqual(parseGreptileScore("Confidence Score: 4/5"), { score: 4, reviewed_commit: null });
  assert.deepEqual(parseGreptileScore("**Confidence Score**: 5/5"), { score: 5, reviewed_commit: null });
  assert.deepEqual(parseGreptileScore("Confidence Score: 4.5/5"), { score: 4.5, reviewed_commit: null });
  assert.deepEqual(parseGreptileScore("confidence score: 3 / 5"), { score: 3, reviewed_commit: null });

  // The anchor text is Greptile's review title (HTML entities and all) and the URL path is lower-cased: the SHA must come from the URL.
  const body = [
    "Confidence Score: 4/5",
    "",
    "[fix(engine): attr&#39;bute &amp; escapes](https://github.com/runfusion/fusion/commit/EC1E77020BDC97BBFA61ECA676BE511FA52FE4C1)",
  ].join("\n");
  assert.deepEqual(parseGreptileScore(body), { score: 4, reviewed_commit: "EC1E77020B".slice(0, 10) });
});

test("parseGreptileScore rejects bodies without a usable score", () => {
  assert.equal(parseGreptileScore(""), null);
  assert.equal(parseGreptileScore(null), null);
  assert.equal(parseGreptileScore("No score here, just prose about a 4/5 tradeoff"), null);
  assert.equal(parseGreptileScore("Confidence Score: 7/5"), null);
});

test("parseReviewedCommit ignores the anchor text and reads bare URLs too", () => {
  assert.equal(parseReviewedCommit("[merge subject &amp; entities](https://github.com/o/r/commit/aaaaaaaabbbb)"), "aaaaaaaabb");
  assert.equal(parseReviewedCommit("see https://github.com/o/r/commit/0123456789abcdef"), "0123456789");
  assert.equal(parseReviewedCommit("Confidence Score: 5/5"), null);
  assert.equal(parseReviewedCommit(null), null);
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

test("classifyThread prefers the GraphQL author type and falls back to the login", () => {
  const bot = classifyThread({
    id: "T1",
    isResolved: false,
    isOutdated: false,
    path: "a.ts",
    comments: { nodes: [{ author: BOT_AUTHOR }] },
  });
  assert.equal(bot.kind, "bot");
  assert.equal(bot.author_type, "Bot");
  assert.equal(bot.classification_basis, "author_type");
  assert.equal(bot.author, "coderabbitai");

  const human = classifyThread({ id: "T2", path: "b.ts", comments: { nodes: [{ author: HUMAN_AUTHOR }] } });
  assert.equal(human.kind, "human");
  assert.equal(human.classification_basis, "author_type");

  // No `__typename` in the payload: the login fallback decides and says so.
  const fallbackBot = classifyThread({ id: "T3", path: "c.ts", comments: { nodes: [{ author: { login: "chatgpt-codex-connector" } }] } });
  assert.equal(fallbackBot.kind, "bot");
  assert.equal(fallbackBot.author_type, null);
  assert.equal(fallbackBot.classification_basis, "login_fallback");
});

test("summarizeThreads keeps resolved counts, separates humans and never loses outdated bot threads", () => {
  const threads = [
    { id: "T1", isResolved: false, isOutdated: false, path: "a.ts", comments: { nodes: [{ author: BOT_AUTHOR }] } },
    { id: "T2", isResolved: true, isOutdated: false, path: "b.ts", comments: { nodes: [{ author: BOT_AUTHOR }] } },
    { id: "T3", isResolved: false, isOutdated: true, path: "c.ts", comments: { nodes: [{ author: HUMAN_AUTHOR }] } },
    { id: "T4", isResolved: false, isOutdated: false, path: "d.ts", comments: { nodes: [{ author: { login: "chatgpt-codex-connector", __typename: "Bot" } }] } },
  ];
  const summary = summarizeThreads(threads);
  assert.equal(summary.total, 4);
  assert.equal(summary.resolved, 1);
  assert.deepEqual(summary.unresolved_bot.map((thread) => thread.id), ["T1", "T4"]);
  assert.deepEqual(summary.unresolved_human.map((thread) => thread.id), ["T3"]);
  assert.equal(summary.unresolved_human[0].is_outdated, true);
  assert.equal(summary.human_policy, "never-auto-resolve");

  assert.deepEqual(summarizeThreads({ nodes: [] }), {
    total: 0,
    resolved: 0,
    unresolved_bot: [],
    unresolved_human: [],
    human_policy: "never-auto-resolve",
  });
});

test("classifyCheckRun copies names and conclusions verbatim", () => {
  const check = classifyCheckRun({ name: "E2E — kill-switch de tokens", status: "COMPLETED", conclusion: "FAILURE" });
  assert.equal(check.name, "E2E — kill-switch de tokens");
  assert.equal(check.conclusion, "FAILURE");
  assert.equal(check.failing, true);
  assert.equal(check.pending, false);
});

test("deriveCiState reports unknown for zero checks and honours the blocking basis", () => {
  const empty = deriveCiState([]);
  assert.equal(empty.state, "unknown");
  assert.equal(empty.checks_total, 0);
  assert.equal(empty.blocking_ci_failing, false);
  assert.equal(empty.blocking_checks_source, "derived");

  const fusionOverride = ["Lint", "Typecheck", "Build", "Gate"];
  const desktopOnly = deriveCiState([{ name: "Desktop packaging", status: "COMPLETED", conclusion: "FAILURE" }], { repoOverride: fusionOverride });
  assert.equal(desktopOnly.state, "failing");
  assert.equal(desktopOnly.blocking_ci_failing, false);
  assert.equal(desktopOnly.blocking_basis, "repo_override");
  assert.equal(desktopOnly.blocking_checks_source, "repo_override_table");
  assert.deepEqual(desktopOnly.failing_checks, [{ name: "Desktop packaging", status: "COMPLETED", conclusion: "FAILURE" }]);

  const lintRed = deriveCiState([{ name: "Lint", status: "COMPLETED", conclusion: "FAILURE" }], { repoOverride: fusionOverride });
  assert.equal(lintRed.blocking_ci_failing, true);

  const protection = deriveCiState([{ name: "Lint", status: "COMPLETED", conclusion: "FAILURE" }], {
    branchProtection: { available: true, requiredChecks: ["Lint"] },
  });
  assert.equal(protection.blocking_checks_source, "branch_protection");
  assert.equal(protection.blocking_basis, "all_failing_checks_as_candidates");
  assert.equal(protection.blocking_ci_failing, true);

  const pending = deriveCiState([{ name: "CodeRabbit", status: "IN_PROGRESS", conclusion: null }]);
  assert.equal(pending.state, "pending");
  assert.equal(pending.blocking_ci_failing, false);
});

test("classifyScope uses the fixed reason vocabulary and keeps awaiting PRs tracked", () => {
  const awaiting = classifyScope({ greptile: { status: "awaiting_first_review", score: null }, threads: { unresolved_bot: [] }, ci: { blocking_ci_failing: false } });
  assert.deepEqual(awaiting, { scope: "tracking_awaiting_review", scope_reasons: ["awaiting_first_greptile_review"] });

  const notDetected = classifyScope({ greptile: { status: "not_detected", score: null }, threads: { unresolved_bot: [] }, ci: { blocking_ci_failing: false } });
  assert.equal(notDetected.scope, "tracking_awaiting_review");

  const belowTarget = classifyScope({ greptile: { status: "scored", score: 4 }, threads: { unresolved_bot: [] }, ci: { blocking_ci_failing: false } });
  assert.deepEqual(belowTarget, { scope: "in_scope", scope_reasons: ["greptile_score_below_target"] });

  const botThreads = classifyScope({
    greptile: { status: "scored", score: 5 },
    threads: { unresolved_bot: [{ id: "T1" }] },
    ci: { blocking_ci_failing: true },
  });
  assert.deepEqual(botThreads.scope_reasons, ["unresolved_bot_threads", "blocking_checks_failing"]);

  const compliant = classifyScope({ greptile: { status: "scored", score: 5 }, threads: { unresolved_bot: [] }, ci: { blocking_ci_failing: false } });
  assert.deepEqual(compliant, { scope: "compliant", scope_reasons: [] });
});

test("selectGreptileState labels PRs with no Greptile review literally", () => {
  const state = selectGreptileState({
    comments: [{ id: "C1", author: { login: "igorpadovan" }, body: "looks good", created_at: "2026-09-01T00:00:00Z" }],
    reviews: [],
    checks: [{ name: "CI", conclusion: "SUCCESS" }],
  });
  assert.equal(state.status, "not_detected");
  assert.equal(state.status_label, AWAITING_FIRST_REVIEW);
  assert.equal(state.score, null);
  assert.equal(state.signal, "absent");
  assert.equal(state.triggerable, false);
  assert.equal(state.idle, null);
  assert.equal(state.check_state, null);
});

test("selectGreptileState takes the most recently updated score source and records provenance", () => {
  // Step 3 row 1: a newer issue comment beat an older review body, and the newest comment beat an older one.
  const commentWins = selectGreptileState({
    comments: [
      { id: "OLD", user: { login: "greptile-apps" }, body: "Confidence Score: 2/5", created_at: "2026-09-01T00:00:00Z" },
      { id: "NEW", user: { login: "greptile-apps" }, body: "Confidence Score: 4/5", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z" },
    ],
    reviews: [{ user: { login: "greptile-apps" }, body: "Confidence Score: 5/5", submitted_at: "2026-09-01T12:00:00Z" }],
    checks: [{ name: "Greptile Review", status: "COMPLETED", conclusion: "SUCCESS" }],
    headOid: "ec1e77020bdc97bbfa61eca676be511fa52fe4c1",
  });
  assert.equal(commentWins.status, "scored");
  assert.equal(commentWins.score, 4);
  assert.equal(commentWins.score_source, "issue_comment");
  assert.equal(commentWins.score_updated_at, "2026-09-02T00:00:00Z");
  assert.equal(commentWins.status_label, "4/5");
  assert.equal(commentWins.check_state.status, "COMPLETED");
  assert.equal(commentWins.idle, true);
  assert.equal(commentWins.signal, "present");
  assert.equal(commentWins.triggerable, true);

  // Step 3 row 2: a newer review body beat an older scored comment.
  const reviewWins = selectGreptileState({
    comments: [{ id: "OLD", user: { login: "greptile-apps" }, body: "Confidence Score: 4/5", created_at: "2026-09-01T00:00:00Z" }],
    reviews: [
      { user: { login: "greptile-apps" }, body: "re-review", submitted_at: "2026-09-02T00:00:00Z", commit_id: "bbbbbbbbbbbbbbbb" },
      { user: { login: "greptile-apps" }, body: "Confidence Score: 5/5", submitted_at: "2026-09-03T00:00:00Z", commit_id: "cccccccccccccccc" },
    ],
    checks: [{ name: "Greptile Review", status: "IN_PROGRESS", conclusion: null }],
    headOid: "cccccccccccccccc0000",
  });
  assert.equal(reviewWins.status, "scored");
  assert.equal(reviewWins.score, 5);
  assert.equal(reviewWins.score_source, "review");
  assert.equal(reviewWins.score_updated_at, "2026-09-03T00:00:00Z");
  assert.equal(reviewWins.reviewed_commit, "cccccccccc");
  assert.equal(reviewWins.score_stale, false);
  assert.equal(reviewWins.idle, false);

  // No source carries a parseable score: the newest scored review is still the fallback when a comment exists but does not score.
  const fallback = selectGreptileState({
    comments: [{ id: "OLD", user: { login: "greptile-apps" }, body: "Reviewing your changes…", created_at: "2026-09-01T00:00:00Z" }],
    reviews: [{ user: { login: "greptile-apps" }, body: "Confidence Score: 5/5", submitted_at: "2026-09-04T00:00:00Z" }],
    headOid: "dddddddddddddddd0000",
  });
  assert.equal(fallback.score, 5);
  assert.equal(fallback.score_source, "review");
});

test("selectGreptileState detects staleness only when both commits are known", () => {
  const stale = selectGreptileState({
    comments: [{ id: "C", user: { login: "greptile-apps" }, body: "Confidence Score: 5/5\n[reviewed](https://github.com/o/r/commit/5555aaaaaa)", updated_at: "2026-09-02T00:00:00Z" }],
    headOid: "9999bbbbbbbbbbbb",
  });
  assert.equal(stale.reviewed_commit, "5555aaaaaa");
  assert.equal(stale.score_stale, true);

  const unknown = selectGreptileState({
    comments: [{ id: "C", user: { login: "greptile-apps" }, body: "Confidence Score: 5/5", updated_at: "2026-09-02T00:00:00Z" }],
    headOid: null,
  });
  assert.equal(unknown.reviewed_commit, null);
  assert.equal(unknown.score_stale, false);

  // A Greptile signal without a parseable score is "awaiting first review", never "not detected".
  const awaiting = selectGreptileState({ comments: [{ id: "C", user: { login: "greptile-apps" }, body: "Reviewing…", updated_at: "2026-09-02T00:00:00Z" }] });
  assert.equal(awaiting.status, "awaiting_first_review");
  assert.equal(awaiting.status_label, AWAITING_FIRST_REVIEW);
  assert.equal(awaiting.score, null);
  assert.equal(awaiting.signal, "present");
  assert.equal(awaiting.triggerable, true);
  assert.equal(awaiting.idle, null);
});

test("canonicalQueueHash is stable across run metadata and sensitive to real state", () => {
  const prs = [
    { repo: "o/r", number: 2, branch: "b2", is_draft: false, size: { additions: 1, deletions: 0, changed_files: 1 }, greptile: { status: "scored", score: 5 }, threads: { unresolved_bot: [] }, ci: { state: "green", failing_checks: [] } },
    { repo: "o/r", number: 1, branch: "b1", is_draft: false, size: { additions: 1, deletions: 0, changed_files: 1 }, greptile: { status: "scored", score: 4 }, threads: { unresolved_bot: [] }, ci: { state: "green", failing_checks: [] } },
  ];
  const hash = canonicalQueueHash(prs);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hash, canonicalQueueHash([...prs].reverse()), "key order and array order must not matter");

  const withBotThread = structuredClone(prs);
  withBotThread[1].threads.unresolved_bot.push({ id: "T1" });
  assert.notEqual(hash, canonicalQueueHash(withBotThread));

  const withComment = structuredClone(prs);
  withComment[1].greptile.comment_ids = ["IC_kw"];
  assert.notEqual(hash, canonicalQueueHash(withComment));
});

test("reconcile decides completeness on id sets and reports every loss", () => {
  const agree = reconcile({
    searchIds: ["o/r#1", "o/r#2", "o/r#3"],
    repoUnionIds: ["o/r#1", "o/r#2", "o/r#3"],
    verifiedIds: ["o/r#1", "o/r#2", "o/r#3"],
    searchTotalCount: 3,
  });
  assert.equal(agree.reconciled, true);
  assert.deepEqual(agree.missing_from_search, []);
  assert.deepEqual(agree.verified_open_ids, ["o/r#1", "o/r#2", "o/r#3"]);

  // A PR only the per-repository listing knows about is a loud failure, not a silently smaller queue.
  const lagging = reconcile({
    searchIds: ["o/r#1", "o/r#2", "o/r#3"],
    repoUnionIds: ["o/r#1", "o/r#2", "o/r#3", "acme/widgets#7"],
    verifiedIds: ["o/r#1", "o/r#2", "o/r#3", "acme/widgets#7"],
  });
  assert.deepEqual(lagging.missing_from_search, ["acme/widgets#7"]);
  assert.equal(lagging.reconciled, false);

  const rejectedOnly = reconcile({
    searchIds: ["o/r#1", "o/r#2"],
    repoUnionIds: ["o/r#1", "o/r#2"],
    verifiedIds: ["o/r#1"],
    rejected: [{ id: "o/r#2", state: "CLOSED", author: "timoteo7" }],
  });
  assert.equal(rejectedOnly.reconciled, true, "a PR closed mid-run is a recorded rejection, not a loss");
  assert.deepEqual(rejectedOnly.rejected_by_state_check, [{ id: "o/r#2", state: "CLOSED", author: "timoteo7" }]);

  const droppedBySearch = reconcile({ searchIds: ["o/r#1"], repoUnionIds: [], verifiedIds: [] });
  assert.deepEqual(droppedBySearch.missing_from_repo_union, ["o/r#1"]);
  assert.deepEqual(droppedBySearch.missing_from_verified, ["o/r#1"]);
  assert.equal(droppedBySearch.reconciled, false);

  // A repository the search index dropped is still enumerated through path B, and the miss stays visible instead of quietly shrinking the queue.
  const carryOver = reconcile({ searchIds: [], repoUnionIds: ["acme/widgets#1"], verifiedIds: ["acme/widgets#1"], carryOverRepositories: ["acme/widgets"] });
  assert.deepEqual(carryOver.carry_over_repositories, ["acme/widgets"]);
  assert.deepEqual(carryOver.missing_from_search, ["acme/widgets#1"]);
  assert.equal(carryOver.reconciled, false);
});

test("buildSnapshot implements the versioned contract shape and totals", () => {
  const snapshot = buildSnapshot({
    prs: [
      contractRow({ number: 1 }),
      contractRow({ number: 2, unresolved_bot: 0, greptile: { status: "scored", status_label: "5/5", score: 5 }, scope: "compliant" }),
    ],
    reconciliation: reconcile({ searchIds: ["o/r#1", "o/r#2"], repoUnionIds: ["o/r#1", "o/r#2"], verifiedIds: ["o/r#1", "o/r#2"] }),
    discovery: { paths: { "search-prs": { count: 2, error: null } }, repos: ["o/r"] },
  });
  assert.deepEqual(Object.keys(snapshot), ["schema_version", "generated_at", "author", "queue_hash", "totals", "reconciliation", "discovery", "prs"]);
  assert.equal(snapshot.schema_version, 1);
  assert.match(snapshot.queue_hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(snapshot.totals, {
    prs: 2,
    in_scope: 1,
    tracking_awaiting_review: 0,
    compliant: 1,
    unresolved_bot_threads: 1,
    failing_blocking_checks: 0,
  });
  assert.deepEqual(snapshot.prs.map((pr) => pr.id), ["o/r#1", "o/r#2"], "rows are ordered by repo then number");
});

test("missingPrFields names the fields a consumer would read", () => {
  const row = contractRow({ number: 1 });
  assert.deepEqual(missingPrFields(row), []);
  assert.deepEqual(missingPrFields({ ...row, branch: null }), ["branch"]);
  assert.deepEqual(missingPrFields({ ...row, greptile: null, ci: null }), ["greptile", "ci"]);
});

test("renderMarkdown surfaces the awaiting marker, thread evidence and human policy", () => {
  const snapshot = buildSnapshot({
    prs: [
      contractRow({
        number: 1,
        unresolved_bot: 2,
        greptile: { status: "scored", status_label: "4/5", score: 4 },
        scope: "in_scope",
        scope_reasons: ["greptile_score_below_target", "unresolved_bot_threads"],
        failing_checks: [{ name: "E2E — kill-switch de tokens", status: "COMPLETED", conclusion: "FAILURE" }],
      }),
      buildPrRow({ number: 2, unresolved_bot: 0, greptile: { status: "not_detected", status_label: AWAITING_FIRST_REVIEW, score: null } }),
    ],
    reconciliation: reconcile({ searchIds: ["o/r#1"], repoUnionIds: ["o/r#1"], verifiedIds: ["o/r#1", "o/r#2"], notes: ["a recorded note"] }),
  });
  const md = renderMarkdown(snapshot);
  assert.match(md, new RegExp(AWAITING_FIRST_REVIEW));
  assert.match(md, /o\/r#1 · `a\.ts` · greptile-apps · `T1`/);
  assert.match(md, /o\/r#1 · `b\.ts` · coderabbitai · `T2`/);
  assert.match(md, /never-auto-resolve/);
  assert.match(md, /human thread, never auto-resolved/);
  assert.match(md, /E2E — kill-switch de tokens/);
  assert.match(md, /in_scope \[greptile_score_below_target, unresolved_bot_threads\]/);
  assert.match(md, /a recorded note/);
  assert.match(md, /node scripts\/pr-queue\/discover-open-prs\.mjs/);
});

/** `gh pr view` payload fixture (the full field list the contract's extraction requests). */
function fakePrView(number, overrides = {}) {
  return {
    number,
    title: `PR ${number}`,
    state: "OPEN",
    url: `https://github.com/o/r/pull/${number}`,
    headRefName: `branch-${number}`,
    headRefOid: "ec1e77020bdc97bbfa61eca676be511fa52fe4c1",
    baseRefName: "main",
    isDraft: false,
    isCrossRepository: true,
    headRepositoryOwner: { login: "timoteo7" },
    headRepository: { name: "r" },
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    labels: [{ name: "bug" }],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    additions: 498,
    deletions: 10,
    changedFiles: 17,
    statusCheckRollup: [{ name: "Lint", status: "COMPLETED", conclusion: "SUCCESS" }],
    author: { login: "timoteo7" },
    ...overrides,
  };
}

/** Fixture PR row for pure-unit tests (mirrors the contract shape). */
function buildPrRow({
  number = 1,
  greptile = { status: "scored", status_label: "4/5", score: 4 },
  unresolved_bot = 1,
  scope = "in_scope",
  scope_reasons = ["greptile_score_below_target"],
  failing_checks = [],
} = {}) {
  const bots = [
    { id: "T1", path: "a.ts", author: "greptile-apps", author_type: "Bot", is_outdated: false, classification_basis: "author_type" },
    { id: "T2", path: "b.ts", author: "coderabbitai", author_type: "Bot", is_outdated: true, classification_basis: "author_type" },
  ].slice(0, unresolved_bot);
  return {
    id: `o/r#${number}`,
    repo: "o/r",
    owner: "o",
    name: "r",
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    state: "OPEN",
    is_draft: false,
    is_cross_repository: true,
    head_repo_owner: "timoteo7",
    head_repo_name: "r",
    branch: `branch-${number}`,
    base_ref: "main",
    head_oid: "ec1e77020bdc97bbfa61eca676be511fa52fe4c1",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    review_decision: "REVIEW_REQUIRED",
    merge_state_status: "BLOCKED",
    size: { additions: 498, deletions: 10, changed_files: 17 },
    greptile,
    threads: {
      total: unresolved_bot,
      resolved: 0,
      unresolved_bot: bots,
      unresolved_human: [{ id: "H1", path: "h.ts", author: "teknium1", author_type: "User", is_outdated: false, classification_basis: "author_type" }],
      human_policy: "never-auto-resolve",
    },
    ci: { state: "green", blocking_ci_failing: false, blocking_basis: "repo_override", blocking_checks_source: "repo_override_table", failing_checks, pending_checks: [], checks_total: 4 },
    scope,
    scope_reasons,
  };
}

const contractRow = buildPrRow;

test("extractPrState collects the contract row from gh pr view, comments, reviews and GraphQL", () => {
  const comments = [
    { id: "IC1", user: { login: "greptile-apps", type: "Bot" }, body: "Confidence Score: 4/5\n[reviewed](https://github.com/o/r/commit/ec1e77020bdc)", created_at: "2026-09-10T00:00:00Z" },
    { id: "IC2", user: { login: "timoteo7", type: "User" }, body: "thanks", created_at: "2026-09-11T00:00:00Z" },
  ];
  // Wire the per-PR payloads explicitly: comments, reviews and threads are addressed by repo+number.
  const ghWithPayloads = createGhRunner({
    exec: (ghPath, args) => {
      const ok = (stdout) => ({ status: 0, stdout: JSON.stringify(stdout), stderr: "" });
      if (args[0] === "pr" && args[1] === "view") {
        const jsonArg = args[args.indexOf("--json") + 1];
        if (jsonArg === "state,author") return ok({ state: "OPEN", author: { login: "timoteo7" } });
        return ok(fakePrView(11));
      }
      if (args[0] === "api" && args[1] === "--paginate" && args[2].endsWith("/comments")) return ok(comments);
      if (args[0] === "api" && args[1] === "--paginate" && args[2].endsWith("/reviews")) return ok([]);
      if (args[0] === "api" && args[1] === "graphql") {
        return ok({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    { id: "T1", isResolved: false, isOutdated: false, path: "a.ts", comments: { nodes: [{ author: { login: "greptile-apps", __typename: "Bot" } }] } },
                    { id: "T2", isResolved: true, isOutdated: false, path: "b.ts", comments: { nodes: [{ author: { login: "coderabbitai", __typename: "Bot" } }] } },
                    { id: "T3", isResolved: false, isOutdated: false, path: "c.ts", comments: { nodes: [{ author: { login: "teknium1", __typename: "User" } }] } },
                  ],
                },
              },
            },
          },
        });
      }
      if (args[0] === "api" && String(args[1]).includes("/branches/")) return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
    },
  });

  const { eligible, pr } = extractPrState(ghWithPayloads, { repo: "o/r", number: 11 });
  assert.equal(eligible, true);
  assert.equal(pr.id, "o/r#11");
  assert.equal(pr.state, "OPEN");
  assert.equal(pr.is_draft, false);
  assert.equal(pr.is_cross_repository, true);
  assert.equal(pr.head_repo_owner, "timoteo7");
  assert.equal(pr.head_repo_name, "r");
  assert.equal(pr.branch, "branch-11");
  assert.equal(pr.base_ref, "main");
  assert.equal(pr.head_oid, "ec1e77020bdc97bbfa61eca676be511fa52fe4c1");
  assert.deepEqual(pr.size, { additions: 498, deletions: 10, changed_files: 17 });
  assert.equal(pr.merge_state_status, "BLOCKED");
  assert.equal(pr.review_decision, "REVIEW_REQUIRED");
  assert.equal(pr.greptile.status, "scored");
  assert.equal(pr.greptile.score, 4);
  assert.equal(pr.greptile.score_source, "issue_comment");
  assert.equal(pr.greptile.score_updated_at, "2026-09-10T00:00:00Z");
  assert.equal(pr.greptile.reviewed_commit, "ec1e77020b");
  assert.equal(pr.greptile.score_stale, false);
  assert.equal(pr.greptile.signal, "present", "a Greptile-authored comment is itself a Greptile signal, even with no Greptile check run on the PR");
  assert.equal(pr.greptile.idle, null);
  assert.deepEqual(pr.threads.unresolved_bot.map((thread) => thread.id), ["T1"]);
  assert.deepEqual(pr.threads.unresolved_human.map((thread) => thread.id), ["T3"]);
  assert.equal(pr.threads.total, 3);
  assert.equal(pr.threads.resolved, 1);
  assert.equal(pr.threads.human_policy, "never-auto-resolve");
  assert.deepEqual(pr.scope_reasons, ["greptile_score_below_target", "unresolved_bot_threads"], "the same row is both scored below target and carrying an unresolved bot thread");

  // A PR whose state check fails re-verification is a recorded rejection, never a dropped candidate.
  const rejected = extractPrState(scriptedGh({ views: { 12: fakePrView(12, { state: "CLOSED" }) } }), { repo: "o/r", number: 12 });
  assert.equal(rejected.eligible, false);
  assert.deepEqual(rejected.rejected, { id: "o/r#12", state: "CLOSED", author: "timoteo7" });
});

test("buildQueue reconciles the paths, carries over repositories and counts totals", () => {
  const threads = {
    11: [{ id: "T1", isResolved: false, isOutdated: false, path: "a.ts", comments: { nodes: [{ author: { login: "greptile-apps", __typename: "Bot" } }] } }],
    12: [],
  };
  const gh = scriptedGh({
    searchPrs: [
      { number: 11, repository: { nameWithOwner: "o/r" }, title: "scored", url: "u11" },
      { number: 12, repository: { nameWithOwner: "o/r" }, title: "fresh", url: "u12" },
      { number: 7, repository: { nameWithOwner: "acme/widgets" }, title: "fork", url: "u7" },
    ],
    searchIssues: [
      { number: 11, repository: { nameWithOwner: "o/r" }, title: "scored", url: "u11", isPullRequest: true },
      { number: 12, repository: { nameWithOwner: "o/r" }, title: "fresh", url: "u12", isPullRequest: true },
      { number: 7, repository: { nameWithOwner: "acme/widgets" }, title: "fork", url: "u7", isPullRequest: true },
      { number: 99, repository: { nameWithOwner: "o/r" }, title: "plain issue", url: "u99", isPullRequest: false },
    ],
    repoList: {
      "o/r": [{ number: 11 }, { number: 12 }],
      "acme/widgets": [{ number: 7 }],
    },
    views: {
      11: fakePrView(11, {
        statusCheckRollup: [
          { name: "Lint", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "Greptile Review", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
      }),
      12: fakePrView(12, { isDraft: true, mergeStateStatus: "UNKNOWN", statusCheckRollup: [] }),
      7: fakePrView(7, { statusCheckRollup: [{ name: "Gate", status: "COMPLETED", conclusion: "FAILURE" }] }),
    },
    comments: {
      "o/r#11": [{ id: "IC1", user: { login: "greptile-apps", type: "Bot" }, body: "Confidence Score: 4/5", updated_at: "2026-09-10T00:00:00Z" }],
    },
    threads,
    totalCount: 3,
  });

  const { snapshot, incomplete, rejected, lastRun } = buildQueue({
    gh,
    limit: 100,
    previousSnapshot: { prs: [{ id: "acme/widgets#7", repo: "acme/widgets" }] },
    startedAt: "2026-09-17T10:00:00.000Z",
  });

  assert.deepEqual(snapshot.prs.map((pr) => pr.id), ["acme/widgets#7", "o/r#11", "o/r#12"]);
  assert.deepEqual(incomplete, []);
  assert.deepEqual(rejected, []);
  assert.equal(snapshot.reconciliation.reconciled, true);
  assert.deepEqual(snapshot.reconciliation.search_ids, ["acme/widgets#7", "o/r#11", "o/r#12"], "both search endpoints feed path A");
  assert.deepEqual(snapshot.reconciliation.carry_over_repositories, [], "a repository the search paths still cover needs no carry-over");
  assert.deepEqual(snapshot.reconciliation.verified_open_ids, ["acme/widgets#7", "o/r#11", "o/r#12"]);
  assert.equal(snapshot.reconciliation.search_total_count, 3);
  assert.equal(snapshot.prs.every((pr) => pr.number !== 99), true, "an `isPullRequest: false` search hit never becomes a candidate");

  const scored = snapshot.prs.find((pr) => pr.id === "o/r#11");
  assert.equal(scored.greptile.score, 4);
  assert.equal(scored.greptile.score_source, "issue_comment");
  assert.equal(scored.greptile.idle, true);
  assert.equal(scored.greptile.triggerable, true);
  assert.equal(scored.ci.state, "green");
  assert.deepEqual(scored.scope_reasons, ["greptile_score_below_target", "unresolved_bot_threads"]);

  const fresh = snapshot.prs.find((pr) => pr.id === "o/r#12");
  assert.equal(fresh.greptile.status, "not_detected");
  assert.equal(fresh.greptile.status_label, AWAITING_FIRST_REVIEW);
  assert.equal(fresh.ci.state, "unknown");
  assert.equal(fresh.scope, "tracking_awaiting_review");
  assert.equal(snapshot.totals.prs, 3);
  assert.equal(snapshot.totals.tracking_awaiting_review, 1);
  assert.equal(lastRun.counts.prs, 3);
  assert.equal(lastRun.reconciliation.reconciled, true);
  assert.equal(lastRun.gh_version, "gh version 2.45.0 (test)");
});

test("buildQueue enumerates a carry-over repository through path B and keeps the search miss visible", () => {
  const gh = scriptedGh({
    searchPrs: [],
    searchIssues: [],
    repoList: { "acme/widgets": [{ number: 7 }] },
    views: { 7: fakePrView(7) },
  });
  const { snapshot } = buildQueue({ gh, previousSnapshot: { prs: [{ id: "acme/widgets#7", repo: "acme/widgets" }] } });
  assert.deepEqual(snapshot.reconciliation.carry_over_repositories, ["acme/widgets"]);
  assert.deepEqual(snapshot.reconciliation.repo_union_ids, ["acme/widgets#7"]);
  assert.deepEqual(snapshot.reconciliation.verified_open_ids, ["acme/widgets#7"]);
  assert.deepEqual(snapshot.reconciliation.missing_from_search, ["acme/widgets#7"]);
  assert.equal(snapshot.reconciliation.reconciled, false, "the miss stays loud instead of quietly shrinking the queue");
  assert.deepEqual(snapshot.prs.map((pr) => pr.id), ["acme/widgets#7"]);
  assert.equal(snapshot.reconciliation.notes.some((note) => note.includes("carry-over repositories enumerated through path B")), true);
});

test("buildQueue records a per-repository listing failure as a note instead of aborting", () => {
  const gh = scriptedGh({
    searchPrs: [{ number: 11, repository: { nameWithOwner: "o/r" }, title: "scored", url: "u11" }],
    searchIssues: [],
    repoList: { "o/r": [{ number: 11 }] },
    repoListFailure: { "broken/repo": "repository not found" },
    views: { 11: fakePrView(11) },
  });
  // A repository only reachable through a failing listing never becomes a candidate, so the note is the only trace — and it must exist.
  const { snapshot } = buildQueue({ gh, previousSnapshot: { prs: [{ id: "broken/repo#4", repo: "broken/repo" }] } });
  assert.equal(snapshot.reconciliation.notes.some((note) => note.includes("broken/repo") && note.includes("recorded instead of aborting")), true);
  assert.deepEqual(snapshot.reconciliation.rejected_by_state_check, []);
});

test("buildQueue emits the truncation note when a path returns exactly the requested limit", () => {
  const gh = scriptedGh({
    searchPrs: [{ number: 11, repository: { nameWithOwner: "o/r" }, title: "t", url: "u11" }],
    searchIssues: [],
    repoList: { "o/r": [{ number: 11 }] },
    views: { 11: fakePrView(11) },
  });
  const { snapshot } = buildQueue({ gh, limit: 1, previousSnapshot: { prs: [] } });
  assert.equal(snapshot.reconciliation.notes.some((note) => note.includes("may be truncated")), true);
});

test("writeSnapshot writes the three artifacts atomically and --json writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-queue-test-"));
  try {
    const snapshot = buildSnapshot({ prs: [contractRow({ number: 1 })], reconciliation: reconcile({}) });
    const paths = writeSnapshot(snapshot, dir, { lastRun: { queue_hash: snapshot.queue_hash } });
    assert.equal(paths.queueJson, join(dir, "queue.json"));
    assert.equal(paths.queueMd, join(dir, "queue.md"));
    assert.equal(paths.lastRun, join(dir, "last-run.json"));
    assert.deepEqual(readdirSync(dir).sort(), ["last-run.json", "queue.json", "queue.md"]);

    const second = buildSnapshot({ prs: [contractRow({ number: 1 })], reconciliation: reconcile({}), generatedAt: "2026-09-17T12:00:00Z" });
    writeSnapshot(second, dir, { lastRun: {} });
    assert.equal(readdirSync(dir).some((name) => name.endsWith(".tmp")), false, "atomic writes leave no .tmp behind");
    const first = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    const reread = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    assert.deepEqual({ ...first, generated_at: null }, { ...reread, generated_at: null });

    const sink = captureStream();
    const emptyDir = mkdtempSync(join(tmpdir(), "pr-queue-json-"));
    try {
      const code = main(["--json"], { gh: scriptedGh({ searchPrs: [], searchIssues: [], repoList: {}, views: {} }), stdout: sink.stream, stderr: sink.stream, outDir: emptyDir });
      assert.equal(code, 0);
      assert.equal(readdirSync(emptyDir).length, 0, "--json writes no files");
      assert.equal(JSON.parse(sink.value).schema_version, 1);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * FNXC:PRQueueDiscovery 2026-09-17-11:10:
 * FUSI-001's acceptance criteria require `--strict` to fail loudly (exit 2) when a PR is missing from a discovery path or lacks required fields, require exit 3 with the failing `gh` arguments named and no partial snapshot when GitHub fails, and require exit 4 on an invalid flag. The negative controls below prove each code discriminates instead of being a constant.
 */
test("main exit codes: 0 clean, 2 strict-gate failure, 3 gh failure, 4 invalid flags", () => {
  const clean = scriptedGh({
    searchPrs: [{ number: 41, repository: { nameWithOwner: "o/r" }, title: "ok", url: "u41" }],
    searchIssues: [],
    repoList: { "o/r": [{ number: 41 }] },
    views: { 41: fakePrView(41) },
  });
  const closed = scriptedGh({
    searchPrs: [{ number: 42, repository: { nameWithOwner: "o/r" }, title: "closed", url: "u42" }],
    searchIssues: [],
    repoList: { "o/r": [{ number: 42 }] },
    views: { 42: fakePrView(42, { state: "CLOSED" }) },
  });
  const noBranch = scriptedGh({
    searchPrs: [{ number: 43, repository: { nameWithOwner: "o/r" }, title: "no branch", url: "u43" }],
    searchIssues: [],
    repoList: { "o/r": [{ number: 43 }] },
    views: { 43: fakePrView(43, { headRefName: null }) },
  });
  const onlyInRepoList = scriptedGh({
    searchPrs: [],
    searchIssues: [],
    repoList: { "o/r": [{ number: 44 }] },
    views: { 44: fakePrView(44) },
  });
  const broken = scriptedGh({ searchPrsFailure: "boom: repository not found" });

  const dir = mkdtempSync(join(tmpdir(), "pr-queue-exit-"));
  try {
    const run = (argv, gh, extra = {}) => {
      const out = captureStream();
      const err = captureStream();
      const code = main(argv, { gh, stdout: out.stream, stderr: err.stream, outDir: dir, ...extra });
      return { code, stdout: out.value, stderr: err.value };
    };
    // Path B only enumerates repositories it can name: path A's repositories plus the previous snapshot's carry-over.
    const carriedRepo = { previousSnapshot: { prs: [{ id: "o/r#44", repo: "o/r" }] } };
    assert.equal(run(["--json"], clean).code, 0);
    assert.equal(run(["--json", "--strict"], clean).code, 0);

    // A PR closed between enumeration and extraction is a recorded rejection, not a loss.
    assert.equal(run(["--json", "--strict"], closed).code, 0);

    // Negative control: a PR the search path missed while the per-repository listing found it fails only under --strict.
    assert.equal(run(["--json"], onlyInRepoList).code, 0);
    assert.equal(run(["--json", "--strict"], onlyInRepoList, carriedRepo).code, 2);
    assert.equal(run(["--strict"], onlyInRepoList, carriedRepo).stderr.includes("reconciliation.reconciled is false"), true);

    assert.equal(run(["--json", "--strict"], noBranch).code, 2);
    assert.equal(run(["--strict"], noBranch).stderr.includes("missing required field(s): branch"), true);

    const beforeAbort = readFileSync(join(dir, "queue.json"), "utf8");
    const aborted = run(["--strict"], broken);
    assert.equal(aborted.code, 3);
    assert.equal(aborted.stderr.includes("gh search prs"), true, "the failing gh argv is named");
    assert.equal(readFileSync(join(dir, "queue.json"), "utf8"), beforeAbort, "an aborted run leaves the previous snapshot untouched");

    const badFlag = run(["--nope"], clean);
    assert.equal(badFlag.code, 4);
    assert.equal(badFlag.stderr.includes("unknown flag"), true);
    assert.equal(readFileSync(join(dir, "queue.json"), "utf8"), beforeAbort);

    const badOnly = run(["--only", "not-a-pr"], clean);
    assert.equal(badOnly.code, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main --only refreshes one PR while reconciliation still covers every candidate", () => {
  const gh = scriptedGh({
    searchPrs: [
      { number: 11, repository: { nameWithOwner: "o/r" }, title: "a", url: "u11" },
      { number: 12, repository: { nameWithOwner: "o/r" }, title: "b", url: "u12" },
    ],
    searchIssues: [],
    repoList: { "o/r": [{ number: 11 }, { number: 12 }] },
    views: { 11: fakePrView(11), 12: fakePrView(12) },
  });
  const out = captureStream();
  const code = main(["--json", "--only", "o/r#12"], { gh, stdout: out.stream, stderr: captureStream().stream, previousSnapshot: { prs: [] } });
  assert.equal(code, 0);
  const snapshot = JSON.parse(out.value);
  assert.deepEqual(snapshot.prs.map((pr) => pr.id), ["o/r#12"]);
  assert.deepEqual(snapshot.reconciliation.verified_open_ids, ["o/r#12"], "only the refreshed PR is re-verified");
  assert.deepEqual(snapshot.reconciliation.missing_from_verified, ["o/r#11"], "the candidate left unrefreshed is reported instead of silently dropped");
  assert.equal(snapshot.reconciliation.reconciled, false, "--only cannot reconcile by construction, so the gate skips the comparison");
  assert.equal(snapshot.reconciliation.notes.some((note) => note.startsWith("--only")), true);
});

test("evaluateStrictGate detects a PR that vanished since the previous snapshot", () => {
  const snapshot = buildSnapshot({
    prs: [contractRow({ number: 1 })],
    reconciliation: reconcile({ searchIds: ["o/r#1"], repoUnionIds: ["o/r#1"], verifiedIds: ["o/r#1"] }),
    discovery: { paths: { "search-prs": { count: 1, error: null } } },
  });
  const gate = evaluateStrictGate(snapshot, { previousSnapshot: { prs: [{ id: "o/r#1" }, { id: "o/r#2" }] } });
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.failures, ["PR o/r#2 was in the previous snapshot and disappeared without a rejected_by_state_check entry"]);

  const clean = evaluateStrictGate(snapshot, { previousSnapshot: { prs: [{ id: "o/r#1" }] } });
  assert.deepEqual(clean, { ok: true, failures: [] });

  // A snapshot written before the id field existed (legacy repo+number rows) must not invent failures: the live canonical file was in that shape and reported ten phantom "PR undefined" problems.
  const legacy = evaluateStrictGate(snapshot, { previousSnapshot: { prs: [{ repo: "o/r", number: 1 }] } });
  assert.deepEqual(legacy, { ok: true, failures: [] }, "legacy repo+number rows are normalized to the canonical id");

  const legacyVanished = evaluateStrictGate(snapshot, { previousSnapshot: { prs: [{ repo: "o/r", number: 1 }, { repo: "o/r", number: 2 }] } });
  assert.deepEqual(legacyVanished.failures, ["PR o/r#2 was in the previous snapshot and disappeared without a rejected_by_state_check entry"]);

  const unreadable = evaluateStrictGate(snapshot, { previousSnapshot: { prs: [{ repo: "o/r" }] } });
  assert.equal(unreadable.ok, false, "a row that resolves to no id stays a loud failure rather than a silent skip");
  assert.match(unreadable.failures[0], /carry neither id nor repo\+number/);

  const withPathError = evaluateStrictGate({ ...snapshot, discovery: { paths: { "repo-list": { count: 0, error: "boom" } } } });
  assert.equal(withPathError.ok, false);
  assert.deepEqual(withPathError.failures, ["discovery path repo-list failed: boom"]);
});

test("main regenerates the same queue_hash when GitHub state is unchanged", () => {
  const gh = scriptedGh({
    searchPrs: [{ number: 11, repository: { nameWithOwner: "o/r" }, title: "a", url: "u11" }],
    searchIssues: [],
    repoList: { "o/r": [{ number: 11 }] },
    views: { 11: fakePrView(11) },
  });
  const dir = mkdtempSync(join(tmpdir(), "pr-queue-hash-"));
  try {
    const first = captureStream();
    const second = captureStream();
    assert.equal(main([], { gh, stdout: first.stream, stderr: first.stream, outDir: dir, now: () => new Date("2026-09-17T10:00:00Z") }), 0);
    const firstSnapshot = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    assert.equal(main([], { gh, stdout: second.stream, stderr: second.stream, outDir: dir, now: () => new Date("2026-09-17T11:30:00Z") }), 0);
    const secondSnapshot = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8"));
    assert.equal(firstSnapshot.generated_at, "2026-09-17T10:00:00.000Z");
    assert.equal(secondSnapshot.generated_at, "2026-09-17T11:30:00.000Z");
    assert.equal(firstSnapshot.queue_hash, secondSnapshot.queue_hash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function captureStream() {
  const state = { value: "" };
  return {
    stream: { write: (chunk) => { state.value += chunk; return true; } },
    get value() {
      return state.value;
    },
  };
}

/**
 * Fixture `gh` executor keyed on argv: served as the scripted double for the pipeline tests so every call site is explicit and an unexpected invocation fails loudly.
 */
function scriptedGh({ searchPrs = [], searchIssues = [], repoList = {}, repoListFailure = {}, searchPrsFailure = null, views = {}, comments = {}, reviews = {}, threads = {}, totalCount = null }) {
  return createGhRunner({
    exec: (ghPath, args) => {
      const ok = (payload) => ({ status: 0, stdout: JSON.stringify(payload), stderr: "" });
      const [group, command] = args;
      if (args[0] === "--version") return { status: 0, stdout: "gh version 2.45.0 (test)\n", stderr: "" };
      if (group === "search" && command === "prs") {
        if (searchPrsFailure) return { status: 1, stdout: "", stderr: searchPrsFailure };
        return ok(searchPrs);
      }
      if (group === "search" && command === "issues") return ok(searchIssues);
      if (group === "pr" && command === "list") {
        const repo = args[args.indexOf("--repo") + 1];
        if (repoListFailure[repo]) return { status: 1, stdout: "", stderr: repoListFailure[repo] };
        return ok(repoList[repo] ?? []);
      }
      if (group === "pr" && command === "view") {
        const number = Number(args[2]);
        const jsonArg = args[args.indexOf("--json") + 1];
        const view = views[number] ?? {};
        if (jsonArg === "state,author") return ok({ state: view.state ?? "OPEN", author: view.author ?? { login: "timoteo7" } });
        return ok(view);
      }
      if (group === "api" && command === "--paginate") {
        const path = args[2];
        const key = path.replace(/^repos\//, "").replace("/issues/", "#").replace("/pulls/", "#").replace(/\/(comments|reviews)$/, "");
        const payload = path.endsWith("/comments") ? comments[key] ?? [] : reviews[key] ?? [];
        return ok(payload);
      }
      if (group === "api" && command === "graphql") {
        const number = Number(String(args[args.indexOf("-F") + 1]).split("=")[1]);
        return ok({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads[number] ?? [] } } } } });
      }
      if (group === "api" && String(command).includes("/branches/")) {
        return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      }
      if (group === "api" && String(command).startsWith("/search/issues")) {
        return { status: 0, stdout: totalCount === null ? "0" : String(totalCount), stderr: "" };
      }
      throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
    },
  });
}
