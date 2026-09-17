#!/usr/bin/env node
/*
FNXC:PRQueueDiscovery 2026-09-17-11:10:
FUSI-001 (mission "Greptile 5/5 nos PRs de timoteo7") needs one authoritative, regenerable inventory of every open PR authored by `timoteo7`, because the mission is continuous: PRs opened during the mission, or PRs that fall back below target, must enter scope automatically on the next regeneration. A hand-maintained list cannot do that, so the queue is rebuilt from scratch on every run and is never edited by hand.

The snapshot is the durable interface for FUSI-002 (Greptile score extraction), FUSI-003 (unresolved bot-thread extraction), FUSI-004 (effort ranking) and for the operator, so it ships a machine-readable `queue.json` and a human-readable `queue.md`. Its field names and enum values are a versioned contract (documented verbatim in `scripts/pr-queue/README.md`): additive fields keep `schema_version: 1`, breaking changes bump it.

Completeness is proven, not assumed. Three independent discovery paths (`gh search prs`, `gh search issues 'is:pr'`, per-repository `gh pr list` extended with carry-over repositories from the previous snapshot) are reconciled id-by-id, and every candidate is re-verified through `gh pr view` — it must still be OPEN and authored by `timoteo7`, otherwise it is recorded in `reconciliation.rejected_by_state_check` instead of disappearing. A PR that no Greptile review has touched yet is labelled with the literal `aguardando primeira revisão` and stays tracked (`tracking_awaiting_review`), so a later score below 5 or a new bot comment pulls it into scope on the next run with no manual re-listing. `--strict` converts silent loss into a loud failure (exit 2).

The tool is read-only by construction: every `gh` interaction is a read (`search`, `list`, `view`, `api` GET). It has no code path that posts a comment, triggers a review, resolves a thread, or touches a PR branch. It also never writes inside the repository: the default output directory is HOME-anchored (`~/.fusion/pr-queue/`) so sibling tasks and the operator read the same queue, and `--out <dir>` redirects it for throwaway runs.

FNXC:PRQueueDiscovery 2026-09-17-11:10:
`queue_hash` is a SHA-256 over the canonical JSON of the `prs` array only, so it is reproducible and lets downstream tasks detect real state changes without being confused by `generated_at`. Canonical means: array ordered by `repo` ascending then `number` ascending, every object's keys sorted ascending recursively, and no run-level values inside. Volatile run metadata (fetch timestamps, path error strings, `search_total_count`) lives outside `prs`, therefore a re-fetch of unchanged GitHub state reproduces a byte-identical hash while any real change (score, resolved thread, check conclusion, branch or draft flip, size) moves it.

FNXC:PRQueueDiscovery 2026-09-17-11:10:
Bot vs human is a hard boundary for the mission: bot threads may be resolved autonomously, human threads never may. Classification therefore uses the GraphQL author type (`author.__typename == "Bot"`) as the primary evidence and reports which evidence decided each thread through `classification_basis` (`author_type`, or `login_fallback` when the API exposed no type). Only when no type is available does the login fallback run, and it errs toward "human" unless the login carries positive bot evidence (known review-bot login, `[bot]` marker, `-bot` suffix), so an unknown human reviewer can never be auto-resolved by accident. Human threads are recorded under `threads.unresolved_human` with the literal `human_policy: "never-auto-resolve"` and never appear in `unresolved_bot`.
*/
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SCHEMA_VERSION = 1;
export const QUEUE_AUTHOR = "timoteo7";
/** Literal marker the FUSI-001 acceptance criteria require for PRs with no Greptile review yet. */
export const AWAITING_FIRST_REVIEW = "aguardando primeira revisão";
export const DEFAULT_OUT_DIR = join(homedir(), ".fusion", "pr-queue");
export const TARGET_SCORE = 5;
export const HUMAN_POLICY = "never-auto-resolve";
export const GREPTILE_CHECK_NAME = "Greptile Review";
export const DEFAULT_LIMIT = 1000;

/** Process exit codes: the loop distinguishes "clean", "incomplete", "GitHub broke" and "operator typo". */
export const EXIT = { ok: 0, strict: 2, gh: 3, usage: 4 };

/**
 * Per-repository blocking-check override. `Runfusion/Fusion`'s merge gate is the thin, trusted CI set (Lint, Typecheck, Build, Gate — see `AGENTS.md`), so a failing non-blocking check such as `Desktop packaging` must not mark a PR as blocking-red. Repositories without an override fall back to `all_failing_checks_as_candidates`, or to the repository's branch protection when the API answers.
 */
export const REPO_BLOCKING_CHECKS = {
  "Runfusion/Fusion": ["Lint", "Typecheck", "Build", "Gate"],
};

/** Greptile posts its score as `Confidence Score: 4/5` (bold markers vary). */
const GREPTILE_SCORE_RE = /Confidence Score\**\s*:?\s*\**\s*(\d(?:\.\d+)?)\s*\/\s*5/i;
/** Markdown links only: the anchor text is a review title, so the SHA must come from the URL path. */
const MARKDOWN_LINK_RE = /\[[^\]]*\]\(\s*(<?)([^)\s>]+)\1\s*\)/g;
const COMMIT_IN_URL_RE = /commit\/([0-9a-f]{7,40})/i;

/**
 * Known review-bot logins. Anything unlisted still classifies as a bot through the login fallback when it carries the GitHub bot marker (`[bot]` suffix) or a `-bot` suffix, because the mission scopes "bots de revisão (Greptile e quaisquer outros bots que comentarem)": new bots must be caught without a code change.
 */
const KNOWN_BOT_LOGINS = new Set([
  "greptile-apps",
  "coderabbitai",
  "chatgpt-codex-connector",
  "codecov",
  "github-actions",
  "github-advanced-security",
  "dependabot",
  "renovate",
  "copilot-pull-request-reviewer",
  "sonarcloud",
  "snyk-bot",
  "devin-ai-integration",
  "cursor",
]);

/** Check conclusions that mean the check is red. */
const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
  "STALE",
]);
/** Status values that mean the check has not settled yet. */
const PENDING_STATUSES = new Set(["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "EXPECTED", "REQUESTED"]);

/** Fields every PR row must carry; a row missing one is an incomplete-queue finding, never a silent drop. */
const REQUIRED_PR_FIELDS = ["id", "repo", "number", "branch", "greptile", "threads", "ci"];

/** A `gh` invocation failed: the run must abort loudly instead of writing a partial snapshot. */
export class GhError extends Error {
  constructor(message, { args = [], status = null, stderr = null } = {}) {
    super(message);
    this.name = "GhError";
    this.args = args;
    this.status = status;
    this.stderr = stderr;
  }
}

/** @param {string | null | undefined} login */
export function isGreptileLogin(login) {
  return typeof login === "string" && /^greptile/i.test(login);
}

/**
 * FNXC:PRQueueDiscovery 2026-09-17-11:10:
 * The mission resolves "bot" only on positive evidence (known login, `[bot]` marker, `-bot` suffix) and treats everything else as human, so an unknown reviewer can never be auto-resolved. Used as the `login_fallback` branch of `classifyThread`, never as the primary signal.
 * @param {string | null | undefined} login
 * @returns {boolean}
 */
export function isBotAuthor(login) {
  if (!login) return false;
  const normalized = String(login).toLowerCase();
  if (KNOWN_BOT_LOGINS.has(normalized)) return true;
  if (normalized.endsWith("[bot]")) return true;
  return normalized.endsWith("-bot");
}

/**
 * Parse the 10-character commit SHA out of a `Last reviewed commit` link. The anchor text is Greptile's review title (often a merge-commit subject full of HTML entities) and the URL path is lower-cased, so only markdown link *URLs* are searched, case-insensitively.
 * @param {string | null | undefined} body
 * @returns {string | null}
 */
export function parseReviewedCommit(body) {
  if (!body) return null;
  for (const match of String(body).matchAll(MARKDOWN_LINK_RE)) {
    const url = match[2];
    const commit = COMMIT_IN_URL_RE.exec(url);
    if (commit) return commit[1].slice(0, 10);
  }
  const bare = COMMIT_IN_URL_RE.exec(String(body));
  return bare ? bare[1].slice(0, 10) : null;
}

/**
 * Extract the Greptile confidence score and the reviewed commit from a comment/review body.
 * @param {string | null | undefined} body
 * @returns {{score: number, reviewed_commit: string | null} | null} `null` when the body carries no usable score
 */
export function parseGreptileScore(body) {
  if (!body) return null;
  const match = GREPTILE_SCORE_RE.exec(String(body));
  if (!match) return null;
  const score = Number.parseFloat(match[1]);
  if (!Number.isFinite(score) || score < 0 || score > 5) return null;
  return { score, reviewed_commit: parseReviewedCommit(body) };
}

/**
 * @param {Record<string, any> | null | undefined} check raw `statusCheckRollup` entry
 * @returns {{name: string, status: string | null, conclusion: string | null, failing: boolean, pending: boolean}}
 */
export function classifyCheckRun(check) {
  // `name` is copied verbatim (non-ASCII check names such as `E2E — kill-switch de tokens` must survive). StatusContext entries carry `context`/`state` instead of `name`/`conclusion`.
  const name = String(check?.name ?? check?.context ?? "unknown");
  const status = check?.status == null ? null : String(check.status);
  const conclusion = check?.conclusion == null ? (check?.state == null ? null : String(check.state)) : String(check.conclusion);
  const pending = PENDING_STATUSES.has((status ?? "").toUpperCase()) || PENDING_STATUSES.has((conclusion ?? "").toUpperCase());
  const failing = !pending && FAILING_CONCLUSIONS.has((conclusion ?? "").toUpperCase());
  return { name, status, conclusion, failing, pending };
}

/**
 * Classify one GraphQL review thread. `kind` is `bot` only on type evidence or positive login evidence; everything else is `human`.
 * @param {Record<string, any>} node
 * @returns {{id: string, path: string | null, author: string | null, author_type: string | null, is_outdated: boolean, classification_basis: "author_type" | "login_fallback", kind: "bot" | "human"}}
 */
export function classifyThread(node) {
  const first = node?.comments?.nodes?.[0] ?? null;
  const author = first?.author?.login ?? null;
  const authorType = first?.author?.__typename ?? null;
  let kind;
  let classificationBasis;
  if (authorType === "Bot" || authorType === "User") {
    kind = authorType === "Bot" ? "bot" : "human";
    classificationBasis = "author_type";
  } else {
    kind = isBotAuthor(author) ? "bot" : "human";
    classificationBasis = "login_fallback";
  }
  return {
    id: String(node?.id ?? ""),
    path: node?.path ?? null,
    author,
    author_type: authorType,
    is_outdated: Boolean(node?.isOutdated),
    classification_basis: classificationBasis,
    kind,
  };
}

/**
 * Summarize `reviewThreads` into the contract's `threads` block. An unresolved thread with `isOutdated: true` is still unresolved work, so it stays. Human threads are separated and labelled, never mixed into the bot bucket.
 * @param {Array<Record<string, any>> | null | undefined} nodes
 */
export function summarizeThreads(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const unresolved_bot = [];
  const unresolved_human = [];
  let resolved = 0;
  for (const node of list) {
    if (node?.isResolved) {
      resolved += 1;
      continue;
    }
    const thread = classifyThread(node);
    const entry = {
      id: thread.id,
      path: thread.path,
      author: thread.author,
      author_type: thread.author_type,
      is_outdated: thread.is_outdated,
      classification_basis: thread.classification_basis,
    };
    (thread.kind === "bot" ? unresolved_bot : unresolved_human).push(entry);
  }
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  unresolved_bot.sort(byId);
  unresolved_human.sort(byId);
  return { total: list.length, resolved, unresolved_bot, unresolved_human, human_policy: HUMAN_POLICY };
}

/**
 * Derive the contract's `ci` block.
 *
 * FNXC:PRQueueDiscovery 2026-09-17-11:10:
 * The mission's target is "checks bloqueantes de CI verdes", not "every check green": `blocking_ci_failing` is computed against the repository's blocking set (branch protection when readable, the documented `Runfusion/Fusion` override of Lint/Typecheck/Build/Gate otherwise) while `failing_checks` still lists every red check for the operator. `blocking_checks_source` records the evidence actually used, because the token currently gets 404 for branch protection on every repository and the override is a documented substitute, not a measurement. A PR with zero check runs is `unknown`, never `green`, so an unreported CI state can never be mistaken for a passing one.
 *
 * @param {Array<Record<string, any>> | null | undefined} checks raw `statusCheckRollup`
 * @param {{repoOverride?: string[] | null, branchProtection?: {available: boolean, requiredChecks?: string[]} | null}} [context]
 */
export function deriveCiState(checks, { repoOverride = null, branchProtection = null } = {}) {
  const classified = (Array.isArray(checks) ? checks : []).map(classifyCheckRun);
  const failing_checks = classified
    .filter((check) => check.failing)
    .map(({ name, status, conclusion }) => ({ name, status, conclusion }));
  const pending_checks = classified
    .filter((check) => check.pending)
    .map(({ name, status, conclusion }) => ({ name, status, conclusion }));
  const checks_total = classified.length;

  let state = "green";
  if (checks_total === 0) state = "unknown";
  else if (failing_checks.length > 0) state = "failing";
  else if (pending_checks.length > 0) state = "pending";

  let blocking_basis;
  let blocking_checks_source;
  let blockingNames = null;
  if (Array.isArray(repoOverride) && repoOverride.length > 0) {
    blocking_basis = "repo_override";
    blocking_checks_source = "repo_override_table";
    blockingNames = repoOverride;
  } else if (branchProtection?.available && Array.isArray(branchProtection.requiredChecks) && branchProtection.requiredChecks.length > 0) {
    blocking_basis = "all_failing_checks_as_candidates";
    blocking_checks_source = "branch_protection";
    blockingNames = branchProtection.requiredChecks;
  } else {
    blocking_basis = "all_failing_checks_as_candidates";
    blocking_checks_source = "derived";
  }
  const blockingSet = blockingNames ? new Set(blockingNames) : null;
  const blocking_ci_failing = failing_checks.some((check) => !blockingSet || blockingSet.has(check.name));

  return { state, blocking_ci_failing, blocking_basis, blocking_checks_source, failing_checks, pending_checks, checks_total };
}

/**
 * Select the most recently updated Greptile signal for one PR.
 *
 * FNXC:PRQueueDiscovery 2026-09-17-11:10:
 * The mission collects results "da fonte mais recentemente atualizada": Greptile posts several re-reviews per PR, and its verdict arrives either as an issue comment or as a review body, so the newest *scored* source of the two wins, with an exact tie going to the issue comment (where the primary verdict is posted). Greptile's Step 3 scenario table fixes both directions explicitly — a newer comment beats an older review body, and a newer review body beats an older scored comment — while the fallback still holds when comments carry no parseable score. `score_source` records the provenance so the loop knows where the number came from. `signal`/`triggerable` exist because "no Greptile signal at all" (`not_detected`) must never be mistaken for "review pending" — 6 of the enumerated PRs live in repositories where Greptile is not installed, and triggering a review there would be spam.
 *
 * @param {{comments?: any[], reviews?: any[], checks?: any[], headOid?: string | null}} input
 */
export function selectGreptileState({ comments = [], reviews = [], checks = [], headOid = null } = {}) {
  const loginOf = (entry) => entry?.user?.login ?? entry?.author?.login ?? null;
  const bodyOf = (entry) => entry?.body ?? "";
  const stampOf = (entry) => Date.parse(entry?.updated_at ?? entry?.updatedAt ?? entry?.submitted_at ?? entry?.submittedAt ?? 0) || 0;
  const isoOf = (entry) => entry?.updated_at ?? entry?.updatedAt ?? entry?.submitted_at ?? entry?.submittedAt ?? entry?.created_at ?? entry?.createdAt ?? null;
  const newestFirst = (a, b) => stampOf(b) - stampOf(a);

  const greptileComments = (Array.isArray(comments) ? comments : []).filter((c) => isGreptileLogin(loginOf(c)));
  const greptileReviews = (Array.isArray(reviews) ? reviews : []).filter((r) => isGreptileLogin(loginOf(r)));
  const checkState = (Array.isArray(checks) ? checks : [])
    .map(classifyCheckRun)
    .find((check) => check.name === GREPTILE_CHECK_NAME) ?? null;

  const signal = checkState !== null || greptileComments.length > 0 || greptileReviews.length > 0 ? "present" : "absent";
  const scoredComment = greptileComments
    .slice()
    .sort(newestFirst)
    .map((comment) => ({ entry: comment, parsed: parseGreptileScore(bodyOf(comment)) }))
    .find((candidate) => candidate.parsed !== null);
  const scoredReview = greptileReviews
    .slice()
    .sort(newestFirst)
    .map((review) => ({ entry: review, parsed: parseGreptileScore(bodyOf(review)) }))
    .find((candidate) => candidate.parsed !== null);

  // The newest scored source wins; on an exact tie the issue comment wins.
  const winner = scoredComment && scoredReview
    ? (stampOf(scoredReview.entry) > stampOf(scoredComment.entry) ? scoredReview : scoredComment)
    : (scoredComment ?? scoredReview ?? null);

  let status = "not_detected";
  let score = null;
  let score_source = null;
  let score_updated_at = null;
  let reviewed_commit = null;
  if (winner) {
    const fromComment = winner === scoredComment;
    status = "scored";
    score = winner.parsed.score;
    score_source = fromComment ? "issue_comment" : "review";
    score_updated_at = isoOf(winner.entry);
    reviewed_commit = winner.parsed.reviewed_commit
      ?? (fromComment
        ? (winner.entry?.commit_id ?? null)
        : (winner.entry?.commit_id ? String(winner.entry.commit_id).slice(0, 10) : null));
  } else if (signal === "present") {
    status = "awaiting_first_review";
  }

  const headSha = typeof headOid === "string" && headOid.length >= 10 ? headOid.slice(0, 10) : null;
  const score_stale = Boolean(reviewed_commit && headSha && reviewed_commit !== headSha);

  return {
    status,
    status_label: status === "scored" ? `${score}/5` : AWAITING_FIRST_REVIEW,
    score,
    score_source,
    score_updated_at,
    reviewed_commit,
    score_stale,
    signal,
    check_state: checkState ? { name: checkState.name, status: checkState.status, conclusion: checkState.conclusion } : null,
    idle: checkState ? !(checkState.status !== "COMPLETED") : null,
    triggerable: signal === "present",
  };
}

/**
 * Classify a PR row into the mission's scope vocabulary.
 *
 * FNXC:PRQueueDiscovery 2026-09-17-11:10:
 * A PR is `in_scope` when it has a Greptile score below the 5/5 target, at least one unresolved bot thread, or a failing blocking check. A PR with no Greptile score yet is `tracking_awaiting_review` with `awaiting_first_greptile_review` — the milestone requires it to stay tracked so that a later `< 5` score or a new bot comment pulls it in automatically, with no manual re-listing. Everything else is `compliant`.
 * @param {Record<string, any>} pr
 */
export function classifyScope(pr) {
  const reasons = [];
  const score = pr?.greptile?.score ?? null;
  if (score !== null && score < TARGET_SCORE) reasons.push("greptile_score_below_target");
  if ((pr?.threads?.unresolved_bot?.length ?? 0) > 0) reasons.push("unresolved_bot_threads");
  if (pr?.ci?.blocking_ci_failing === true) reasons.push("blocking_checks_failing");
  if (reasons.length > 0) return { scope: "in_scope", scope_reasons: reasons };
  if (pr?.greptile?.status !== "scored") {
    return { scope: "tracking_awaiting_review", scope_reasons: ["awaiting_first_greptile_review"] };
  }
  return { scope: "compliant", scope_reasons: [] };
}

const prSortKey = (pr) => `${pr.repo}#${String(pr.number).padStart(10, "0")}`;
const sortPrs = (prs) => [...prs].sort((a, b) => (prSortKey(a) < prSortKey(b) ? -1 : 1));

/** Recursively sort object keys so `JSON.stringify` is canonical regardless of construction order. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

/**
 * SHA-256 over the canonical JSON of the `prs` array only (ordered by repo then number, keys sorted recursively, no run-level values). Downstream tasks compare hashes to detect a real state change; `generated_at` and fetch metadata are deliberately outside the projection.
 * @param {Array<Record<string, any>>} prs
 * @returns {string} `sha256:<hex>`
 */
export function canonicalQueueHash(prs) {
  const canonical = JSON.stringify(canonicalize(sortPrs(prs)));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Reconcile the discovery paths into the contract's `reconciliation` block.
 *
 * FNXC:PRQueueDiscovery 2026-09-17-11:10:
 * The mission's first acceptance criterion is "zero PRs abertos de timoteo7 perdidos", so completeness is decided on id sets, never on counts: `reconciled` requires that the union of the search paths equals the verified set, that every PR the search path returned survived the state check, and that no path missed an id the others saw. `search_total_count` stays information-only because the GitHub search index lags (a PR appeared between two recon passes minutes apart); disagreements surface as id lists and notes, which `--strict` turns into a loud failure instead of a silently smaller queue.
 *
 * @param {{searchIds?: string[], searchIssuesIds?: string[], repoUnionIds?: string[], verifiedIds?: string[], rejected?: Array<{id: string}>, carryOverRepositories?: string[], searchTotalCount?: number | null, notes?: string[]}} input
 */
export function reconcile({
  searchIds = [],
  searchIssuesIds = [],
  repoUnionIds = [],
  verifiedIds = [],
  rejected = [],
  carryOverRepositories = [],
  searchTotalCount = null,
  notes = [],
} = {}) {
  const uniqSorted = (ids) => [...new Set(ids)].sort();
  const pathA = uniqSorted(searchIds);
  const pathB = uniqSorted([...repoUnionIds, ...searchIssuesIds]);
  const verified = uniqSorted(verifiedIds);
  const rejectedIds = uniqSorted(rejected.map((entry) => (typeof entry === "string" ? entry : entry.id)));
  const rejectedSet = new Set(rejectedIds);
  const setA = new Set(pathA);
  const setB = new Set(pathB);
  const setVerified = new Set(verified);

  const expected = uniqSorted([...setA, ...setB].filter((id) => !rejectedSet.has(id)));
  const missing_from_search = uniqSorted([...setB, ...setVerified].filter((id) => !setA.has(id)));
  const missing_from_repo_union = uniqSorted(pathA.filter((id) => !setB.has(id)));
  const missing_from_verified = uniqSorted(expected.filter((id) => !setVerified.has(id)));
  const unexpected_verified = uniqSorted(verified.filter((id) => !expected.includes(id)));
  const pathASurvived = pathA.filter((id) => !rejectedSet.has(id)).every((id) => setVerified.has(id));
  const reconciled =
    missing_from_search.length === 0 &&
    missing_from_repo_union.length === 0 &&
    missing_from_verified.length === 0 &&
    unexpected_verified.length === 0 &&
    pathASurvived;

  return {
    reconciled,
    search_total_count: searchTotalCount,
    search_ids: pathA,
    search_issues_ids: pathB.filter((id) => !setA.has(id) && !uniqSorted(repoUnionIds).includes(id)),
    repo_union_ids: uniqSorted(repoUnionIds),
    verified_open_ids: verified,
    missing_from_search,
    missing_from_repo_union,
    missing_from_verified,
    unexpected_verified,
    rejected_by_state_check: rejected.map((entry) =>
      typeof entry === "string" ? { id: entry, state: null, author: null } : { id: entry.id, state: entry.state ?? null, author: entry.author ?? null },
    ),
    carry_over_repositories: uniqSorted(carryOverRepositories),
    notes,
  };
}

/**
 * FNXC:PRQueueDiscovery 2026-09-17-11:10:
 * The `gh` runner is the single seam for every GitHub interaction: the CLI uses `spawnSync` (no shell, so no argument interpolation), tests inject a fake executor and get the whole discovery/extraction pipeline with fixtures, no network and no credentials. `runGh` throws a typed `GhError` carrying the failing argv, which is what lets the CLI abort with exit code 3 and name the exact command instead of writing a partial snapshot.
 * @param {{exec?: (ghPath: string, args: string[], options: Record<string, any>) => {status?: number | null, stdout?: string, stderr?: string, error?: Error}, ghPath?: string}} [options]
 */
export function createGhRunner({ exec = spawnSync, ghPath = "gh" } = {}) {
  const runGh = (args, { json = false } = {}) => {
    const result = exec(ghPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result?.error) {
      throw new GhError(`gh ${args.join(" ")} failed to run: ${result.error.message}`, { args, status: null, stderr: null });
    }
    const status = result?.status ?? 1;
    if (status !== 0) {
      const stderr = String(result?.stderr ?? "").trim();
      throw new GhError(`gh ${args.join(" ")} exited ${status}${stderr ? `: ${stderr}` : ""}`, { args, status, stderr });
    }
    const stdout = String(result?.stdout ?? "");
    if (!json) return stdout;
    const trimmed = stdout.trim();
    return trimmed === "" ? null : JSON.parse(trimmed);
  };

  const protection = new Map();
  return {
    runGh,
    json: (args) => runGh(args, { json: true }),
    text: (args) => runGh(args),
    ghVersion: () => String(runGh(["--version"])).split("\n")[0].trim(),
    searchPrs: (limit) =>
      runGh(
        [
          "search", "prs", "--author", QUEUE_AUTHOR, "--state", "open", "--limit", String(limit),
          "--json", "number,repository,title,url,isDraft",
        ],
        { json: true },
      ).map((pr) => ({ repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url })),
    searchIssues: (limit) =>
      runGh(
        [
          "search", "issues", "--author", QUEUE_AUTHOR, "--state", "open", "is:pr", "--limit", String(limit),
          "--json", "number,repository,title,url,isPullRequest",
        ],
        { json: true },
      )
        .filter((item) => item.isPullRequest)
        .map((pr) => ({ repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url })),
    prList: (repo, limit) =>
      runGh(
        ["pr", "list", "--repo", repo, "--author", QUEUE_AUTHOR, "--state", "open", "--limit", String(limit), "--json", "number,title,url,isDraft"],
        { json: true },
      ).map((pr) => ({ repo, number: pr.number, title: pr.title, url: pr.url })),
    prState: (repo, number) => runGh(["pr", "view", String(number), "--repo", repo, "--json", "state,author"], { json: true }),
    prView: (repo, number) =>
      runGh(
        [
          "pr", "view", String(number), "--repo", repo, "--json",
          "headRefName,headRefOid,baseRefName,isDraft,isCrossRepository,headRepositoryOwner,headRepository,mergeStateStatus,reviewDecision,labels,createdAt,updatedAt,additions,deletions,changedFiles,statusCheckRollup,state,author,url,title",
        ],
        { json: true },
      ),
    issueComments: (repo, number) => runGh(["api", "--paginate", `repos/${repo}/issues/${number}/comments`], { json: true }) ?? [],
    pullReviews: (repo, number) => runGh(["api", "--paginate", `repos/${repo}/pulls/${number}/reviews`], { json: true }) ?? [],
    reviewThreads: (repo, number) => {
      const [owner, name] = repo.split("/");
      // `author{__typename}` is the primary bot/human evidence; `login` alone is the fallback.
      const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated path comments(first:20){nodes{author{login __typename} createdAt}}}}}}}`;
      const data = runGh(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`], { json: true });
      return data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    },
    /**
     * Best-effort branch-protection probe, one attempt per repository, cached for the run and never fatal: the available token receives 404 for every repository, and the contract requires recording the evidence actually used rather than failing the run.
     */
    branchProtection: (repo, branch) => {
      if (protection.has(repo)) return protection.get(repo);
      let value = { available: false, requiredChecks: [] };
      try {
        const data = runGh(["api", `repos/${repo}/branches/${branch}/protection`], { json: true });
        value = { available: true, requiredChecks: data?.required_status_checks?.contexts ?? [] };
      } catch {
        value = { available: false, requiredChecks: [] };
      }
      protection.set(repo, value);
      return value;
    },
    /** `gh api /search/issues` total, recorded as information only (the index lags). */
    searchTotalCount: () => {
      const raw = runGh(["api", "/search/issues?q=author:timoteo7+is:pr+is:open&per_page=1", "--jq", ".total_count"]);
      const value = Number.parseInt(String(raw).trim(), 10);
      return Number.isFinite(value) ? value : null;
    },
  };
}

/**
 * Extract the contract row for one candidate. Returns `{eligible: false, rejected}` when the PR is no longer OPEN or is no longer authored by the mission's author, so the caller records it in `rejected_by_state_check` instead of dropping it silently.
 * @param {ReturnType<typeof createGhRunner>} runner
 * @param {{repo: string, number: number}} candidate
 */
export function extractPrState(runner, candidate) {
  const { repo, number } = candidate;
  const [owner, name] = repo.split("/");
  const stateCheck = runner.prState(repo, number);
  const state = String(stateCheck?.state ?? "").toUpperCase();
  const author = stateCheck?.author?.login ?? null;
  if (state !== "OPEN" || author !== QUEUE_AUTHOR) {
    return { eligible: false, rejected: { id: `${repo}#${number}`, state: state || null, author } };
  }

  const view = runner.prView(repo, number) ?? {};
  const head_oid = view.headRefOid ?? null;
  const greptile = selectGreptileState({
    comments: runner.issueComments(repo, number),
    reviews: runner.pullReviews(repo, number),
    checks: view.statusCheckRollup,
    headOid: head_oid,
  });
  const threads = summarizeThreads(runner.reviewThreads(repo, number));
  const base_ref = view.baseRefName ?? null;
  const ci = deriveCiState(view.statusCheckRollup, {
    repoOverride: REPO_BLOCKING_CHECKS[repo] ?? null,
    branchProtection: base_ref ? runner.branchProtection(repo, base_ref) : null,
  });

  const row = {
    id: `${repo}#${number}`,
    repo,
    owner,
    name,
    number,
    title: view.title ?? null,
    url: view.url ?? null,
    state: state || null,
    is_draft: Boolean(view.isDraft),
    is_cross_repository: Boolean(view.isCrossRepository),
    head_repo_owner: view.headRepositoryOwner?.login ?? null,
    head_repo_name: view.headRepository?.name ?? null,
    branch: view.headRefName ?? null,
    base_ref,
    head_oid,
    created_at: view.createdAt ?? null,
    updated_at: view.updatedAt ?? null,
    review_decision: view.reviewDecision ?? null,
    merge_state_status: view.mergeStateStatus ?? "UNKNOWN",
    size: { additions: view.additions ?? null, deletions: view.deletions ?? null, changed_files: view.changedFiles ?? null },
    greptile,
    threads,
    ci,
  };
  const { scope, scope_reasons } = classifyScope(row);
  return { eligible: true, pr: { ...row, scope, scope_reasons } };
}

/**
 * Run the discovery paths and collect their id sets.
 *
 * FNXC:PRQueueDiscovery 2026-09-17-11:10:
 * Path B enumerates the union of (repositories the search paths returned) ∪ (repositories carried over from the previous snapshot), because a repository can drop out of the search index entirely between runs and path B is the mitigation for that lag. A `gh pr list` failure for one repository is a recorded note and never aborts the run (the id sets are what decide completeness); a search failure is fatal because a whole enumeration path is then unknown.
 * @param {ReturnType<typeof createGhRunner>} runner
 * @param {{limit: number, previousSnapshot?: Record<string, any> | null}} input
 */
export function discoverCandidates(runner, { limit, previousSnapshot = null } = {}) {
  const notes = [];
  const searchPrs = runner.searchPrs(limit);
  const pathA = searchPrs.map((pr) => ({ ...pr, foundBy: ["search-prs"] }));
  let searchIssues = [];
  try {
    searchIssues = runner.searchIssues(limit).map((pr) => ({ ...pr, foundBy: ["search-issues"] }));
  } catch (error) {
    notes.push(`search-issues path failed and was skipped: ${error.message}`);
  }
  const previousPrs = Array.isArray(previousSnapshot?.prs) ? previousSnapshot.prs : [];
  const previousRepos = [...new Set(previousPrs.map((pr) => pr.repo).filter(Boolean))].sort();
  const searchRepos = [...new Set([...pathA, ...searchIssues].map((pr) => pr.repo))].sort();
  const carryOverRepositories = previousRepos.filter((repo) => !searchRepos.includes(repo));
  const repos = [...new Set([...searchRepos, ...previousRepos])].sort();
  if (carryOverRepositories.length > 0) {
    notes.push(`carry-over repositories enumerated through path B: ${carryOverRepositories.join(", ")}`);
  }

  const repoListItems = [];
  const repoListErrors = new Map();
  const repoResults = {
    "search-prs": { count: pathA.length, error: null, truncated: pathA.length >= limit },
    "search-issues": { count: searchIssues.length, error: null, truncated: searchIssues.length >= limit },
    "repo-list": { count: 0, error: null, truncated: false },
  };
  if (repoResults["search-prs"].truncated) {
    notes.push(`search-prs returned the requested ${limit} rows; results may be truncated (raise --limit)`);
  }
  for (const repo of repos) {
    try {
      const items = runner.prList(repo, limit).map((pr) => ({ ...pr, foundBy: ["repo-list"] }));
      if (items.length >= limit) notes.push(`repo-list:${repo} returned the requested ${limit} rows; results may be truncated`);
      repoListItems.push(...items);
    } catch (error) {
      repoListErrors.set(repo, error.message);
      notes.push(`repo-list:${repo} failed and was recorded instead of aborting: ${error.message}`);
    }
  }
  repoResults["repo-list"].count = repoListItems.length;
  repoResults["repo-list"].error = repoListErrors.size > 0 ? [...repoListErrors.values()].join("; ") : null;

  const index = new Map();
  for (const item of [...pathA, ...searchIssues, ...repoListItems]) {
    const key = `${item.repo}#${item.number}`;
    const entry = index.get(key) ?? { repo: item.repo, number: item.number, foundBy: [] };
    if (!entry.foundBy.includes(item.foundBy[0])) entry.foundBy.push(item.foundBy[0]);
    index.set(key, entry);
  }
  const candidates = [...index.values()]
    .map((candidate) => ({ ...candidate, foundBy: [...candidate.foundBy].sort() }))
    .sort((a, b) => (prSortKey(a) < prSortKey(b) ? -1 : 1));

  let searchTotalCount = null;
  try {
    searchTotalCount = runner.searchTotalCount();
  } catch (error) {
    notes.push(`search total_count unavailable: ${error.message}`);
  }

  return {
    candidates,
    paths: repoResults,
    repos,
    carryOverRepositories,
    searchIds: pathA.map((pr) => `${pr.repo}#${pr.number}`),
    searchIssuesIds: searchIssues.map((pr) => `${pr.repo}#${pr.number}`),
    repoUnionIds: repoListItems.map((pr) => `${pr.repo}#${pr.number}`),
    searchTotalCount,
    notes,
  };
}

/**
 * Assemble the contract snapshot: versioned header, totals, reconciliation block, and PR rows ordered by (repo, number) so the artifact is diffable across runs.
 */
export function buildSnapshot({
  author = QUEUE_AUTHOR,
  prs = [],
  reconciliation = null,
  discovery = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const ordered = sortPrs(prs);
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    author,
    queue_hash: canonicalQueueHash(ordered),
    totals: {
      prs: ordered.length,
      in_scope: ordered.filter((pr) => pr.scope === "in_scope").length,
      tracking_awaiting_review: ordered.filter((pr) => pr.scope === "tracking_awaiting_review").length,
      compliant: ordered.filter((pr) => pr.scope === "compliant").length,
      unresolved_bot_threads: ordered.reduce((total, pr) => total + pr.threads.unresolved_bot.length, 0),
      failing_blocking_checks: ordered.filter((pr) => pr.ci.blocking_ci_failing).length,
    },
    reconciliation,
    discovery,
    prs: ordered,
  };
}

/** Missing required fields for one PR row, so `--strict` and the operator see exactly which row is unusable. */
export function missingPrFields(pr) {
  return REQUIRED_PR_FIELDS.filter((field) => pr?.[field] === undefined || pr?.[field] === null || pr?.[field] === "");
}

/**
 * Run the full pipeline: discover, re-verify every candidate, extract per-PR state, reconcile.
 * @param {{gh: ReturnType<typeof createGhRunner>, limit?: number, previousSnapshot?: Record<string, any> | null, only?: string | null, startedAt?: string, generatedAt?: string}} input
 */
export function buildQueue({ gh, limit = DEFAULT_LIMIT, previousSnapshot = null, only = null, startedAt = new Date().toISOString(), generatedAt } = {}) {
  const discovery = discoverCandidates(gh, { limit, previousSnapshot });
  const rejected = [];
  const incomplete = [];
  const prs = [];
  for (const candidate of discovery.candidates) {
    const id = `${candidate.repo}#${candidate.number}`;
    if (only && id !== only) continue;
    const { eligible, rejected: rejection, pr } = extractPrState(gh, candidate);
    if (!eligible) {
      rejected.push(rejection);
      continue;
    }
    const missing = missingPrFields(pr);
    if (missing.length > 0) incomplete.push({ id, missing });
    prs.push(pr);
  }

  const notes = [...discovery.notes];
  if (discovery.searchTotalCount !== null && discovery.searchTotalCount !== discovery.candidates.length) {
    notes.push(
      `search index reports ${discovery.searchTotalCount} open PR(s) by ${QUEUE_AUTHOR} while ${discovery.candidates.length} were enumerated (index lag is expected; id sets decide completeness)`,
    );
  }
  if (only) notes.push(`--only ${only}: per-PR extraction was restricted to this PR; reconciliation still covers every candidate`);

  const reconciliation = reconcile({
    searchIds: discovery.searchIds,
    searchIssuesIds: discovery.searchIssuesIds,
    repoUnionIds: discovery.repoUnionIds,
    verifiedIds: prs.map((pr) => pr.id),
    rejected,
    carryOverRepositories: discovery.carryOverRepositories,
    searchTotalCount: discovery.searchTotalCount,
    notes,
  });
  const snapshot = buildSnapshot({
    prs,
    reconciliation,
    discovery: { paths: discovery.paths, repos: discovery.repos },
    generatedAt: generatedAt ?? new Date().toISOString(),
  });
  return {
    snapshot,
    incomplete,
    rejected,
    lastRun: {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      gh_version: safeGhVersion(gh),
      author: QUEUE_AUTHOR,
      queue_hash: snapshot.queue_hash,
      counts: { ...snapshot.totals, rejected_by_state_check: rejected.length, incomplete_rows: incomplete.length },
      reconciliation: {
        reconciled: reconciliation.reconciled,
        search_total_count: reconciliation.search_total_count,
        missing_from_search: reconciliation.missing_from_search,
        missing_from_repo_union: reconciliation.missing_from_repo_union,
        rejected_by_state_check: reconciliation.rejected_by_state_check,
      },
      notes,
    },
  };
}

function safeGhVersion(gh) {
  try {
    return gh.ghVersion();
  } catch {
    return null;
  }
}

/**
 * `--strict` gate: fails on an unreconciled queue, on a discovery path error, on a PR row missing a required field, and on a PR that disappeared since the previous snapshot without being recorded as rejected. Returns the human-readable failures instead of throwing, so the CLI can print all of them.
 * @param {Record<string, any>} snapshot
 * @param {{previousSnapshot?: Record<string, any> | null}} [options]
 */
export function evaluateStrictGate(snapshot, { previousSnapshot = null, ignoreReconciliation = false } = {}) {
  const failures = [];
  if (!ignoreReconciliation && !snapshot?.reconciliation?.reconciled) {
    failures.push(
      `reconciliation.reconciled is false (missing_from_search=${JSON.stringify(snapshot?.reconciliation?.missing_from_search ?? [])}, missing_from_repo_union=${JSON.stringify(snapshot?.reconciliation?.missing_from_repo_union ?? [])}, missing_from_verified=${JSON.stringify(snapshot?.reconciliation?.missing_from_verified ?? [])})`,
    );
  }
  for (const [name, info] of Object.entries(snapshot?.discovery?.paths ?? {})) {
    if (info?.error) failures.push(`discovery path ${name} failed: ${info.error}`);
  }
  for (const pr of snapshot?.prs ?? []) {
    const missing = missingPrFields(pr);
    if (missing.length > 0) failures.push(`PR row ${pr.id ?? "(unknown)"} is missing required field(s): ${missing.join(", ")}`);
  }
  if (previousSnapshot) {
    // FNXC:PRQueueDiscovery 2026-09-17-11:31: A previous snapshot on disk may predate the id field (the pre-contract ad-hoc recon wrote only repo + number), and a live run against that legacy file produced ten phantom "PR undefined" failures. Normalize repo+number to the canonical id before the disappearance check; a row that resolves to neither stays a loud failure under --strict instead of being skipped silently.
    const previousRows = Array.isArray(previousSnapshot.prs) ? previousSnapshot.prs : [];
    const previousIds = previousRows
      .map((pr) => pr?.id ?? (pr?.repo && Number.isInteger(pr?.number) ? `${pr.repo}#${pr.number}` : null))
      .filter((id) => typeof id === "string" && id.length > 0);
    const currentIds = new Set((snapshot?.prs ?? []).map((pr) => pr.id));
    const rejectedIds = new Set((snapshot?.reconciliation?.rejected_by_state_check ?? []).map((entry) => entry.id));
    if (previousRows.length > previousIds.length) {
      failures.push(
        `${previousRows.length - previousIds.length} previous-snapshot row(s) carry neither id nor repo+number, so their disappearance cannot be checked`,
      );
    }
    for (const id of previousIds) {
      if (!currentIds.has(id) && !rejectedIds.has(id)) failures.push(`PR ${id} was in the previous snapshot and disappeared without a rejected_by_state_check entry`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Render the operator-facing view: header block (generated_at, totals, reconciliation result, exact regeneration command) plus, per PR, branch, Greptile score or the literal `aguardando primeira revisão`, unresolved bot threads with id/path/author, human threads flagged as never auto-resolved, CI state with failing/pending names, and the scope classification.
 */
export function renderMarkdown(snapshot) {
  const totals = snapshot.totals ?? {};
  const reconciliation = snapshot.reconciliation ?? {};
  const lines = [
    `# PR queue — open PRs authored by \`${snapshot.author}\``,
    "",
    `Generated: ${snapshot.generated_at}  ·  queue hash: \`${snapshot.queue_hash}\`  ·  schema_version: ${snapshot.schema_version}`,
    "",
    `Regenerate with: \`node scripts/pr-queue/discover-open-prs.mjs\` (writes \`~/.fusion/pr-queue/{queue.json,queue.md,last-run.json}\`)`,
    "",
    `Totals: ${totals.prs ?? 0} PR(s) · in scope ${totals.in_scope ?? 0} · tracking (awaiting review) ${totals.tracking_awaiting_review ?? 0} · compliant ${totals.compliant ?? 0} · unresolved bot threads ${totals.unresolved_bot_threads ?? 0} · PRs failing blocking checks ${totals.failing_blocking_checks ?? 0}`,
    "",
    `Reconciliation: reconciled=${reconciliation.reconciled} · search total_count=${reconciliation.search_total_count ?? "n/a"} · missing_from_search=${(reconciliation.missing_from_search ?? []).length} · missing_from_repo_union=${(reconciliation.missing_from_repo_union ?? []).length} · rejected_by_state_check=${(reconciliation.rejected_by_state_check ?? []).length} · carry-over repositories=${(reconciliation.carry_over_repositories ?? []).join(", ") || "none"}`,
    "",
    "| Repo | PR | Branch | Draft | Greptile | Bot threads | Human threads | CI | Scope |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const pr of snapshot.prs) {
    const greptile = pr.greptile.status === "scored" ? pr.greptile.status_label : AWAITING_FIRST_REVIEW;
    const ci = `${pr.ci.state}${pr.ci.failing_checks.length > 0 ? ` (failing: ${pr.ci.failing_checks.map((check) => check.name).join(", ")})` : ""}${pr.ci.pending_checks.length > 0 ? ` (pending: ${pr.ci.pending_checks.map((check) => check.name).join(", ")})` : ""}`;
    lines.push(
      `| ${pr.repo} | [#${pr.number}](${pr.url}) | \`${pr.branch ?? "(unknown)"}\` | ${pr.is_draft ? "yes" : "no"} | ${greptile} | ${pr.threads.unresolved_bot.length} | ${pr.threads.unresolved_human.length} | ${ci} | ${pr.scope}${pr.scope_reasons.length > 0 ? ` [${pr.scope_reasons.join(", ")}]` : ""} |`,
    );
  }

  const awaiting = snapshot.prs.filter((pr) => pr.greptile.status !== "scored");
  lines.push("", `## ${AWAITING_FIRST_REVIEW} (${awaiting.length})`, "");
  lines.push(
    awaiting.length === 0
      ? "Every PR has a Greptile review."
      : awaiting.map((pr) => `- ${pr.id} · Greptile ${pr.greptile.status}${pr.greptile.triggerable ? " (triggerable)" : " (no Greptile signal on this repository)"}`).join("\n"),
  );

  const openBot = snapshot.prs.flatMap((pr) => pr.threads.unresolved_bot.map((thread) => ({ pr, thread })));
  lines.push("", `## Unresolved bot threads (${openBot.length})`, "");
  lines.push(
    openBot.length === 0
      ? "None."
      : openBot
          .map(
            ({ pr, thread }) =>
              `- ${pr.id} · \`${thread.path ?? "(unknown path)"}\` · ${thread.author ?? "unknown"} · \`${thread.id}\` · classification_basis=${thread.classification_basis}${thread.is_outdated ? " · outdated" : ""}`,
          )
          .join("\n"),
  );

  const openHuman = snapshot.prs.flatMap((pr) => pr.threads.unresolved_human.map((thread) => ({ pr, thread })));
  lines.push("", `## Unresolved human threads (${openHuman.length}) — ${HUMAN_POLICY}`, "");
  lines.push(
    openHuman.length === 0
      ? "None."
      : openHuman
          .map(({ pr, thread }) => `- ${pr.id} · \`${thread.path ?? "(unknown path)"}\` · ${thread.author ?? "unknown"} · \`${thread.id}\` · human thread, never auto-resolved`)
          .join("\n"),
  );

  if (reconciliation.notes?.length > 0) {
    lines.push("", `## Notes (${reconciliation.notes.length})`, "");
    lines.push(reconciliation.notes.map((note) => `- ${note}`).join("\n"));
  }
  lines.push("");
  return lines.join("\n");
}

const DEFAULT_FS = { mkdirSync, writeFileSync, renameSync };

/**
 * Write the three runtime artifacts atomically (`<file>.tmp` + rename), so a reader never sees a half-written queue. Returns the absolute paths, which the CLI prints and the operator can quote.
 * @param {Record<string, any>} snapshot
 * @param {string} outDir
 * @param {{fs?: typeof DEFAULT_FS, lastRun?: Record<string, any> | null}} [options]
 */
export function writeSnapshot(snapshot, outDir, { fs = DEFAULT_FS, lastRun = null } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const write = (name, content) => {
    const target = join(outDir, name);
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, target);
    return target;
  };
  const queueJson = write("queue.json", `${JSON.stringify(snapshot, null, 2)}\n`);
  const queueMd = write("queue.md", renderMarkdown(snapshot));
  const lastRunPath = write("last-run.json", `${JSON.stringify(lastRun ?? {}, null, 2)}\n`);
  return { queueJson, queueMd, lastRun: lastRunPath };
}

/** Read a previous snapshot for carry-over; an unreadable file is a note, never a run failure. */
function readPreviousSnapshot(path) {
  try {
    if (!path || !existsSync(path)) return { snapshot: null, note: null };
    return { snapshot: JSON.parse(readFileSync(path, "utf8")), note: null };
  } catch (error) {
    return { snapshot: null, note: `previous snapshot at ${path} could not be read: ${error.message}` };
  }
}

const HELP = `Usage: node scripts/pr-queue/discover-open-prs.mjs [options]

Regenerates the authoritative queue of open PRs authored by ${QUEUE_AUTHOR}:
  <out>/queue.json     machine-readable snapshot (schema_version ${SCHEMA_VERSION}, queue_hash, per-PR state)
  <out>/queue.md       human-readable rendering
  <out>/last-run.json  run metadata (started/finished, counts, reconciliation, gh version)

Options:
  --out <dir>              output directory (default: ${DEFAULT_OUT_DIR})
  --limit <n>              per-gh-call page size (default: ${DEFAULT_LIMIT})
  --strict                 exit 2 on any completeness problem
  --json                   print the snapshot to stdout instead of writing files
  --summary                print the per-PR table
  --only <owner>/<name>#<n>  refresh a single PR (reconciliation still covers every candidate)
  --prev <path>            explicit carry-over snapshot (default: <out>/queue.json when present)
  --help                   show this help

Exit codes: 0 success, 2 strict-gate failure, 3 gh/GitHub failure, 4 invalid flags.
This tool is read-only: it never posts, resolves, or pushes anything.`;

function usageError(stderr, message) {
  stderr.write(`${message}\n\n${HELP}\n`);
  return EXIT.usage;
}

/**
 * CLI entry point. Exported with injectable streams, filesystem, `gh` runner and clock so tests drive the whole path (including exit codes) without network or filesystem writes.
 * @param {string[]} argv
 * @param {{gh?: ReturnType<typeof createGhRunner>, stdout?: {write: (chunk: string) => any}, stderr?: {write: (chunk: string) => any}, fs?: typeof DEFAULT_FS, outDir?: string, previousSnapshot?: Record<string, any> | null, now?: () => Date}} [options]
 */
export function main(argv, { gh = createGhRunner(), stdout = process.stdout, stderr = process.stderr, fs = DEFAULT_FS, outDir = null, previousSnapshot = undefined, now = () => new Date() } = {}) {
  const args = [...argv];
  const flagsWithValue = ["--out", "--limit", "--only", "--prev"];
  for (const arg of args) {
    if (arg.startsWith("-") && !["--strict", "--json", "--stdout", "--summary", "--help", "-h", ...flagsWithValue].includes(arg)) {
      return usageError(stderr, `unknown flag: ${arg}`);
    }
  }
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(`${HELP}\n`);
    return EXIT.ok;
  }
  const valueOf = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1] ?? null;
  };
  for (const flag of flagsWithValue) {
    if (args.includes(flag) && (valueOf(flag) === null || String(valueOf(flag)).startsWith("--"))) {
      return usageError(stderr, `${flag} requires a value`);
    }
  }
  const limitRaw = valueOf("--limit");
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number.parseInt(limitRaw, 10);
  if (!Number.isFinite(limit) || limit <= 0) return usageError(stderr, `--limit must be a positive integer (got ${limitRaw})`);
  const only = valueOf("--only");
  if (only !== null && !/^[^/\s]+\/[^#\s]+#\d+$/.test(only)) return usageError(stderr, `--only must look like owner/name#123 (got ${only})`);

  const targetDir = valueOf("--out") ?? outDir ?? DEFAULT_OUT_DIR;
  const startedAt = now().toISOString();
  let carryOver = previousSnapshot;
  const notes = [];
  if (carryOver === undefined) {
    const prevPath = valueOf("--prev") ?? join(targetDir, "queue.json");
    const read = readPreviousSnapshot(prevPath);
    carryOver = read.snapshot;
    if (read.note) notes.push(read.note);
  }

  try {
    const { snapshot, lastRun } = buildQueue({ gh, limit, previousSnapshot: carryOver, only, startedAt, generatedAt: now().toISOString() });
    if (notes.length > 0) snapshot.reconciliation.notes.push(...notes);
    const toStdout = args.includes("--json") || args.includes("--stdout");
    if (toStdout) {
      stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    } else {
      const paths = writeSnapshot(snapshot, targetDir, { fs, lastRun });
      stdout.write(
        `pr-queue: ${snapshot.totals.prs} open PR(s) · in scope ${snapshot.totals.in_scope} · tracking ${snapshot.totals.tracking_awaiting_review} · compliant ${snapshot.totals.compliant} → ${paths.queueJson} (${snapshot.queue_hash.slice(0, 19)}…)\n`,
      );
    }
    if (args.includes("--summary")) {
      stdout.write(
        snapshot.prs
          .map(
            (pr) =>
              `${pr.id} · ${pr.branch ?? "(unknown branch)"} · ${pr.greptile.status === "scored" ? pr.greptile.status_label : AWAITING_FIRST_REVIEW} · bot threads ${pr.threads.unresolved_bot.length} · CI ${pr.ci.state} · ${pr.scope}\n`,
          )
          .join(""),
      );
    }
    const gate = evaluateStrictGate(snapshot, { previousSnapshot: only ? null : carryOver, ignoreReconciliation: Boolean(only) });
    if (!gate.ok) {
      stderr.write(`pr-queue: ${gate.failures.length} completeness problem(s):\n${gate.failures.map((failure) => `  - ${failure}`).join("\n")}\n`);
      if (args.includes("--strict")) return EXIT.strict;
    }
    return EXIT.ok;
  } catch (error) {
    if (error instanceof GhError) {
      stderr.write(`pr-queue: ${error.message}\npr-queue: aborting without writing a partial snapshot (exit ${EXIT.gh})\n`);
      return EXIT.gh;
    }
    stderr.write(`pr-queue: unexpected failure: ${error?.stack ?? error}\n`);
    return EXIT.gh;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
