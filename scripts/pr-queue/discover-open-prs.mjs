#!/usr/bin/env node
/*
FNXC:PRQueue 2026-09-17-09:20:
FUSI-001 (mission "Greptile 5/5 nos PRs de timoteo7") needs one authoritative,
regenerable inventory of every open PR authored by `timoteo7` across the
organization, because the mission is continuous: PRs opened during the mission
or PRs that fall back below target must enter scope automatically on the next
regeneration. A hand-maintained list cannot do that, so the queue is rebuilt
from scratch on every run.

The snapshot is the input for the downstream tasks (FUSI-002 Greptile score
extraction, FUSI-003 unresolved bot-thread extraction, FUSI-004 effort
ranking) and for the operator view, so it ships both a machine-readable
`queue.json` and a human-readable `queue.md`.

Completeness is proven, not assumed: three independent discovery paths
(`gh search prs`, `gh search issues 'is:pr'`, per-repo `gh pr list`) are
reconciled against each other, and every candidate is re-verified through
`gh pr view` (must still be OPEN and authored by `timoteo7`). A PR that no
Greptile review has touched yet is labelled with the literal
`aguardando primeira revisão` and stays tracked, so a later score below 5 or a
new bot comment pulls it into scope on the next run with no manual re-listing.
`--strict` converts silent loss into a loud failure (exit 1) instead of
dropping an eligible PR quietly.

The tool is read-only by construction: it only ever runs `gh ... view/list/
search/api` reads; it never posts a comment, never triggers a review, never
resolves a thread, and never touches a PR branch.

FNXC:PRQueue 2026-09-17-09:20:
Re-running with unchanged GitHub state must yield a byte-identical
`queueHash`, so the hash is computed over a canonical projection that excludes
volatile fields (fetch timestamps, index-lag `foundBy` sets, comment
created/updated timestamps). A changed score, a newly resolved thread, a
changed check conclusion, or a branch/draft flip all move the hash; a mere
re-fetch does not.
*/

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const QUEUE_SCHEMA = "pr-queue/1";
export const QUEUE_AUTHOR = "timoteo7";
/** Literal marker required by the FUSI-001 acceptance criteria for PRs with no Greptile review yet. */
export const AWAITING_FIRST_REVIEW = "aguardando primeira revisão";
export const DEFAULT_OUT_DIR = join(homedir(), ".fusion", "pr-queue");

/** Greptile score phrases observed in the wild: `Confidence Score: 4/5`, `**Confidence Score**: 5/5`. */
const GREPTILE_SCORE_RE = /Confidence Score\**\s*:?\s*\**\s*(\d(?:\.\d+)?)\s*\/\s*5/i;

/**
 * Known review-bot logins. Anything not listed still classifies as a bot when
 * it carries the GitHub bot marker (`[bot]` suffix) or a `-bot` suffix, because
 * the mission scopes "bots de revisão (Greptile e quaisquer outros bots que
 * comentarem)": new bots must be caught without a code change.
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

/**
 * FNXC:PRQueue 2026-09-17-09:20:
 * Bot vs human is a hard boundary for the mission: bot threads may be resolved
 * autonomously, human threads never may. Classification therefore errs toward
 * "bot" only on positive evidence (known login, `[bot]` marker, `-bot` suffix)
 * and treats everything else as human, so an unknown human reviewer can never
 * be auto-resolved by accident.
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
 * Extract the Greptile confidence score (0–5) from a review/comment body.
 * @param {string | null | undefined} text
 * @returns {number | null} score, or null when the body carries no score
 */
export function parseGreptileScore(text) {
  if (!text) return null;
  const match = GREPTILE_SCORE_RE.exec(String(text));
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value < 0 || value > 5) return null;
  return value;
}

/**
 * Classify a `statusCheckRollup` array into an aggregate CI state plus the
 * names still failing / pending. `gh` returns either CheckRun shape
 * (`name`/`status`/`conclusion`) or StatusContext shape (`context`/`state`).
 * @param {Array<Record<string, unknown>> | null | undefined} rollup
 * @returns {{state: "pass" | "fail" | "pending" | "none", total: number, failing: string[], pending: string[]}}
 */
export function classifyChecks(rollup) {
  const checks = Array.isArray(rollup) ? rollup : [];
  const failing = [];
  const pending = [];
  for (const check of checks) {
    const name = String(check?.name ?? check?.context ?? "unknown");
    const status = String(check?.status ?? "").toUpperCase();
    const conclusion = String(check?.conclusion ?? check?.state ?? "").toUpperCase();
    if (PENDING_STATUSES.has(status) || PENDING_STATUSES.has(conclusion)) {
      pending.push(name);
      continue;
    }
    if (FAILING_CONCLUSIONS.has(conclusion)) {
      failing.push(name);
    }
  }
  failing.sort();
  pending.sort();
  let state = "pass";
  if (checks.length === 0) state = "none";
  else if (failing.length > 0) state = "fail";
  else if (pending.length > 0) state = "pending";
  return { state, total: checks.length, failing, pending };
}

/**
 * Split unresolved review threads into bot and human buckets. Resolved threads
 * are dropped; outdated-but-unresolved threads are kept because they are still
 * open work for the mission.
 * @param {Array<Record<string, any>>} threads raw GraphQL reviewThreads nodes
 * @returns {{botThreads: Array<{id: string, path: string | null, author: string | null, isOutdated: boolean}>, humanThreads: Array<{id: string, path: string | null, author: string | null, isOutdated: boolean}>}}
 */
export function splitThreads(threads) {
  const botThreads = [];
  const humanThreads = [];
  for (const thread of Array.isArray(threads) ? threads : []) {
    if (!thread || thread.isResolved) continue;
    const comments = Array.isArray(thread.comments?.nodes) ? thread.comments.nodes : [];
    const author = comments[0]?.author?.login ?? null;
    const entry = {
      id: String(thread.id ?? ""),
      path: thread.path ?? null,
      author,
      isOutdated: Boolean(thread.isOutdated),
    };
    (isBotAuthor(author) ? botThreads : humanThreads).push(entry);
  }
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  botThreads.sort(byId);
  humanThreads.sort(byId);
  return { botThreads, humanThreads };
}

/**
 * Select the most recently updated Greptile signal for one PR: the score comes
 * from Greptile's summary comment (the only place it is posted), the reviewed
 * commit from its latest review, and the check-run state from the
 * `Greptile Review` check.
 *
 * FNXC:PRQueue 2026-09-17-09:20:
 * The mission requires collecting results "da fonte mais recentemente
 * atualizada": Greptile may post several re-reviews, so the newest message
 * wins (updatedAt then createdAt) instead of the first or last array element.
 * @param {{comments?: any[], reviews?: any[], checks?: any[]}} input
 */
export function selectGreptileState({ comments = [], reviews = [], checks = [] } = {}) {
  const greptileMessages = [
    ...comments.filter((c) => c?.author?.login === "greptile-apps"),
    ...reviews.filter((r) => r?.author?.login === "greptile-apps"),
  ];
  const stamp = (m) => Date.parse(m?.updatedAt ?? m?.createdAt ?? 0) || 0;
  const latest = greptileMessages.sort((a, b) => stamp(b) - stamp(a))[0] ?? null;
  const scoreFromMessages = latest ? parseGreptileScore(latest.body) : null;
  const score = scoreFromMessages ?? greptileMessages.map((m) => parseGreptileScore(m.body)).find((s) => s !== null) ?? null;

  const greptileReviews = reviews.filter((r) => r?.author?.login === "greptile-apps" && r?.commit?.oid);
  const byReviewDate = greptileReviews.sort(
    (a, b) => (Date.parse(b.submittedAt ?? 0) || 0) - (Date.parse(a.submittedAt ?? 0) || 0),
  );
  const reviewedCommit = byReviewDate[0]?.commit?.oid ?? null;

  const check = checks.find((c) => (c?.name ?? c?.context) === "Greptile Review");
  const checkState = check ? String(check.conclusion ?? check.state ?? "unknown") : null;

  if (score === null) {
    return {
      status: AWAITING_FIRST_REVIEW,
      score: null,
      scoreRaw: null,
      reviewedCommit,
      checkState,
      source: latest ? { kind: "greptile-message", id: latest.id ?? null, at: latest.updatedAt ?? latest.createdAt ?? null } : null,
    };
  }
  return {
    status: "scored",
    score,
    scoreRaw: `${score}/5`,
    reviewedCommit,
    checkState,
    source: latest ? { kind: "greptile-message", id: latest.id ?? null, at: latest.updatedAt ?? latest.createdAt ?? null } : null,
  };
}

/**
 * Reconcile the three discovery paths into one candidate list.
 * @param {Record<string, Array<{repo: string, number: number, title?: string}>>} pathResults
 * @returns {{candidates: Array<{repo: string, number: number, foundBy: string[]}>, discrepancies: Array<{repo: string, number: number, missingFrom: string[]}>}}
 */
export function reconcileCandidates(pathResults) {
  const names = Object.keys(pathResults);
  const index = new Map();
  for (const name of names) {
    for (const pr of pathResults[name] ?? []) {
      const key = `${pr.repo}#${pr.number}`;
      const entry = index.get(key) ?? { repo: pr.repo, number: pr.number, foundBy: [] };
      if (!entry.foundBy.includes(name)) entry.foundBy.push(name);
      index.set(key, entry);
    }
  }
  const sortKey = (c) => `${c.repo}#${String(c.number).padStart(8, "0")}`;
  const candidates = [...index.values()].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  for (const candidate of candidates) candidate.foundBy.sort();
  const discrepancies = candidates
    .filter((c) => c.foundBy.length < names.length)
    .map((c) => ({ repo: c.repo, number: c.number, missingFrom: names.filter((n) => !c.foundBy.includes(n)).sort() }));
  return { candidates, discrepancies };
}

/**
 * Canonical projection hashed for `queueHash`. Volatile fields — fetch
 * timestamps, index-lag `foundBy`, message dates — are excluded so an
 * unchanged GitHub state reproduces a byte-identical hash.
 */
function hashProjection(snapshot) {
  return {
    schema: snapshot.schema,
    author: snapshot.author,
    prs: snapshot.prs.map((pr) => ({
      repo: pr.repo,
      number: pr.number,
      branch: pr.branch,
      isDraft: pr.isDraft,
      mergeStateStatus: pr.mergeStateStatus,
      greptile: { status: pr.greptile.status, score: pr.greptile.score, reviewedCommit: pr.greptile.reviewedCommit },
      ci: { state: pr.ci.state, failing: pr.ci.failing, pending: pr.ci.pending, total: pr.ci.total },
      botThreadIds: pr.threads.botThreads.map((t) => t.id),
      humanThreadIds: pr.threads.humanThreads.map((t) => t.id),
    })),
  };
}

/**
 * @param {object} snapshot snapshot without `queueHash`
 * @returns {string} `sha256:<hex>`
 */
export function computeQueueHash(snapshot) {
  const canonical = JSON.stringify(hashProjection(snapshot));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Render the human-readable queue view. */
export function renderMarkdown(snapshot) {
  const lines = [
    `# PR queue — open PRs authored by \`${snapshot.author}\``,
    "",
    `Generated: ${snapshot.generatedAt}  ·  queue hash: \`${snapshot.queueHash}\`  ·  schema: \`${snapshot.schema}\``,
    "",
    `Discovery: ${snapshot.prs.length} open PR(s); paths ` +
      Object.entries(snapshot.discovery.paths)
        .map(([name, info]) => `${name}=${info.error ? "ERROR" : info.count}`)
        .join(", "),
    "",
    "| Repo | PR | Branch | Draft | Greptile | Score | Bot threads | Human threads | CI |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const pr of snapshot.prs) {
    const score = pr.greptile.status === AWAITING_FIRST_REVIEW ? AWAITING_FIRST_REVIEW : `${pr.greptile.score}/5`;
    lines.push(
      `| ${pr.repo} | [#${pr.number}](${pr.url}) | \`${pr.branch}\` | ${pr.isDraft ? "yes" : "no"} | ${pr.greptile.status} | ${score} | ` +
        `${pr.threads.botThreads.length} | ${pr.threads.humanThreads.length} | ${pr.ci.state}${pr.ci.failing.length ? ` (${pr.ci.failing.join(", ")})` : ""} |`,
    );
  }
  const awaiting = snapshot.prs.filter((pr) => pr.greptile.status === AWAITING_FIRST_REVIEW);
  lines.push("", `## ${AWAITING_FIRST_REVIEW} (${awaiting.length})`, "");
  lines.push(
    awaiting.length === 0
      ? "Every PR has a Greptile review."
      : awaiting.map((pr) => `- ${pr.repo}#${pr.number}`).join("\n"),
  );
  const openBot = snapshot.prs.flatMap((pr) =>
    pr.threads.botThreads.map((t) => ({ pr, t })),
  );
  lines.push("", `## Unresolved bot threads (${openBot.length})`, "");
  lines.push(
    openBot.length === 0
      ? "None."
      : openBot.map(({ pr, t }) => `- ${pr.repo}#${pr.number} · \`${t.path ?? "(unknown path)"}\` · ${t.author ?? "unknown"} · \`${t.id}\``).join("\n"),
  );
  if (snapshot.discovery.discrepancies.length > 0) {
    lines.push("", `## Discovery discrepancies (${snapshot.discovery.discrepancies.length})`, "");
    lines.push(
      snapshot.discovery.discrepancies
        .map((d) => `- ${d.repo}#${d.number} missing from: ${d.missingFrom.join(", ")}`)
        .join("\n"),
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Assemble the snapshot. PRs are ordered by (repo, number) so the artifact is
 * diffable across runs.
 */
export function buildSnapshot({
  author = QUEUE_AUTHOR,
  prs = [],
  discovery = { paths: {}, repos: [], discrepancies: [], errors: [], ineligible: [] },
  generatedAt = new Date().toISOString(),
}) {
  const ordered = [...prs].sort((a, b) =>
    a.repo === b.repo ? a.number - b.number : a.repo < b.repo ? -1 : 1,
  );
  const snapshot = {
    schema: QUEUE_SCHEMA,
    author,
    generatedAt,
    queueHash: "",
    discovery,
    prs: ordered,
  };
  snapshot.queueHash = computeQueueHash(snapshot);
  return snapshot;
}

/**
 * FNXC:PRQueue 2026-09-17-09:20:
 * The `gh` runner is a seam: the CLI uses `execFileSync`, tests inject a fake
 * executor so the whole discovery/reconciliation pipeline is exercisable with
 * fixtures and no network. All calls are read-only subcommands.
 */
export function createGhRunner({ exec } = {}) {
  const execute =
    exec ??
    ((args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const json = (args) => {
    const raw = execute([...args]);
    return raw === "" ? null : JSON.parse(raw);
  };
  return {
    json,
    text: (args) => execute([...args]),
    searchPrs: (limit) =>
      json([
        "search", "prs", "--author", QUEUE_AUTHOR, "--state", "open", "--limit", String(limit),
        "--json", "number,repository,title,url,isDraft,createdAt,updatedAt",
      ]).map((pr) => ({ repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url })),
    searchIssues: (limit) =>
      json([
        "search", "issues", "--author", QUEUE_AUTHOR, "--state", "open", "is:pr", "--limit", String(limit),
        "--json", "number,repository,title,url,isPullRequest",
      ])
        .filter((item) => item.isPullRequest)
        .map((pr) => ({ repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url })),
    prList: (repo, limit) =>
      json([
        "pr", "list", "--repo", repo, "--author", QUEUE_AUTHOR, "--state", "open", "--limit", String(limit),
        "--json", "number,title,headRefName,url,isDraft",
      ]).map((pr) => ({ repo, number: pr.number, title: pr.title, url: pr.url })),
    prView: (repo, number) =>
      json([
        "pr", "view", String(number), "--repo", repo,
        "--json", "number,title,state,url,headRefName,isDraft,mergeStateStatus,author,comments,reviews,statusCheckRollup",
      ]),
    reviewThreads: (repo, number) => {
      const [owner, name] = repo.split("/");
      const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated path comments(first:20){nodes{author{login} createdAt}}}}}}}`;
      const data = json([
        "api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`,
      ]);
      return data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    },
  };
}

/** Re-verify one candidate through `gh pr view` and collect its full state. */
function collectPrState(gh, candidate) {
  const view = gh.prView(candidate.repo, candidate.number);
  if (!view) throw new Error(`gh pr view returned nothing for ${candidate.repo}#${candidate.number}`);
  const eligible = String(view.state).toUpperCase() === "OPEN" && view.author?.login === QUEUE_AUTHOR;
  const threads = gh.reviewThreads(candidate.repo, candidate.number);
  const { botThreads, humanThreads } = splitThreads(threads);
  return {
    eligible,
    pr: {
      repo: candidate.repo,
      number: candidate.number,
      title: view.title,
      url: view.url,
      branch: view.headRefName,
      isDraft: Boolean(view.isDraft),
      mergeStateStatus: view.mergeStateStatus ?? "UNKNOWN",
      foundBy: candidate.foundBy,
      greptile: selectGreptileState({
        comments: view.comments ?? [],
        reviews: view.reviews ?? [],
        checks: view.statusCheckRollup ?? [],
      }),
      threads: { botThreads, humanThreads },
      ci: classifyChecks(view.statusCheckRollup),
    },
  };
}

/** Run the three discovery paths and reconcile them. */
function discover(gh, { limit }) {
  const errors = [];
  const runPath = (name, fn) => {
    try {
      return { name, items: fn(), error: null };
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
      return { name, items: [], error: error.message };
    }
  };
  const searchPrs = runPath("search-prs", () => gh.searchPrs(limit));
  const searchIssues = runPath("search-issues", () => gh.searchIssues(limit));
  const repos = [...new Set([...searchPrs.items, ...searchIssues.items].map((pr) => pr.repo))].sort();
  const repoListings = new Map();
  for (const repo of repos) {
    const result = runPath(`repo-list:${repo}`, () => gh.prList(repo, limit));
    repoListings.set(repo, result);
  }
  const repoListItems = [...repoListings.values()].flatMap((r) => r.items);
  const pathResults = {
    "search-prs": searchPrs.items,
    "search-issues": searchIssues.items,
    "repo-list": repoListItems,
  };
  const { candidates, discrepancies } = reconcileCandidates(pathResults);
  const pathErrors = [searchPrs, searchIssues, ...repoListings.values()].filter((p) => p.error);
  return {
    candidates,
    discrepancies,
    errors: [...errors, ...pathErrors.map((p) => `${p.name}: ${p.error}`)],
    counts: {
      "search-prs": searchPrs.items.length,
      "search-issues": searchIssues.items.length,
      "repo-list": repoListItems.length,
    },
    pathErrors: Object.fromEntries(
      [searchPrs, searchIssues, ...repoListings.values()].map((p) => [p.name, p.error]),
    ),
    repos,
  };
}

/**
 * Run the full pipeline against a `gh` runner: discover through the three
 * paths, reconcile, re-verify every candidate through `gh pr view`, collect
 * per-PR state, and assemble the snapshot. Exported so tests can drive the
 * whole pipeline with a fake runner and fixtures.
 * @param {{gh: ReturnType<typeof createGhRunner>, limit?: number}} input
 */
export function buildQueue({ gh, limit = 200 }) {
  const discovery = discover(gh, { limit });
  const prs = [];
  const ineligible = [];
  for (const candidate of discovery.candidates) {
    const { eligible, pr } = collectPrState(gh, candidate);
    if (eligible) prs.push(pr);
    else ineligible.push(`${pr.repo}#${pr.number}`);
  }
  const snapshot = buildSnapshot({
    prs,
    discovery: {
      paths: Object.fromEntries(
        Object.entries(discovery.counts).map(([name, count]) => [
          name,
          { count, error: discovery.pathErrors[name] ?? null },
        ]),
      ),
      repos: discovery.repos,
      discrepancies: discovery.discrepancies,
      errors: discovery.errors,
      ineligible,
    },
  });
  return {
    snapshot,
    ineligible,
    problems: discovery.errors.length + discovery.discrepancies.length + ineligible.length,
  };
}

const HELP = `Usage: node scripts/pr-queue/discover-open-prs.mjs [options]

Regenerates the authoritative queue of open PRs authored by ${QUEUE_AUTHOR}:
  <out>/queue.json  machine-readable snapshot (queue hash, per-PR state)
  <out>/queue.md    human-readable rendering

Options:
  --out <dir>   output directory (default: ${DEFAULT_OUT_DIR})
  --limit <n>   per-gh-call page size (default: 200)
  --strict      exit 1 on any discovery error, path discrepancy, or ineligible candidate
  --stdout      print the JSON snapshot to stdout instead of writing files
  --help        show this help
`;

function main(argv) {
  const args = [...argv];
  const getFlag = (name, fallback) => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
  };
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const outDir = getFlag("--out", DEFAULT_OUT_DIR);
  const limit = Number.parseInt(getFlag("--limit", "200"), 10);
  const strict = args.includes("--strict");
  const toStdout = args.includes("--stdout");

  const gh = createGhRunner();
  const { snapshot, problems } = buildQueue({ gh, limit });

  if (toStdout) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  } else {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "queue.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
    writeFileSync(join(outDir, "queue.md"), renderMarkdown(snapshot));
    process.stdout.write(
      `pr-queue: ${snapshot.prs.length} open PR(s) → ${join(outDir, "queue.json")} (${snapshot.queueHash.slice(0, 19)}…)\n`,
    );
  }

  if (problems > 0) {
    process.stderr.write(
      `pr-queue: ${problems} problem(s): ${snapshot.discovery.errors.length} path error(s), ${snapshot.discovery.discrepancies.length} discrepancy(ies), ${snapshot.discovery.ineligible.length} ineligible candidate(s)\n`,
    );
    if (strict) return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
