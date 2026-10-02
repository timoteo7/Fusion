/**
 * FNXC:CodeOrganization 2026-07-21-12:00:
 * Task review and PR-review surface types peeled from types.ts.
 */

/*
FNXC:ReviewItemIdentity 2026-10-02-04:00:
A PR COMMENT HAS TWO IDENTITIES AND THIS FILE OWNS THE SEPARATION.

The `gh` CLI transport (`gh pr view --json comments`) returns a GraphQL NODE id — `IC_kwDOT5Q-Ec8AAAABXrfTmw`
— while the REST transport returns a numeric id (`5884072859`). The historical `parseInt(c.id, 10)`
in both readers produced `NaN` for every node id, and `gh-comment-${id}` collapsed to the constant
`gh-comment-NaN` for every comment on every pull request. `PrCommentHandler.upsertReviewItem` then
found that one constant key already present and overwrote it, so two reviewers raising different
findings were recorded as one finding and the earlier body was destroyed.

WHAT MAKES THIS FILE THE HOME. The dashboard and the engine each carried a private copy of the same
`gh` payload interface and the same `parseInt`, and that duplication is precisely what let the twin
defect exist unnoticed in two places. One definition, imported statically by both, cannot drift.

IDENTITY AND ORDER ARE DIFFERENT JOBS, so this returns a PAIR, never a scalar:

  - `key` is the IDENTITY role. Opaque, stable across processes, distinct per comment. It is only
    ever compared for EQUALITY (`findIndex(item => item.id === itemId)`), so it is allowed to be a
    string that sorts in an arbitrary order.
  - `sequence` is the ORDER role. A total order that increases with real-world creation time. The
    monitor compares with `>` and reduces with `Math.max`, so it must be a NUMBER.

Collapsing the two is the defect this file prevents. A string in the ordering role produces BOTH
failure modes at once: lexicographic comparison silently drops genuinely-new comments whose ids sort
below the watermark, and `Math.max(...)` over strings is `NaN`, which is falsy, so the newness guard
falls through to the all-comments branch on every poll and re-delivers the whole comment set forever.

WHERE THE SEQUENCE COMES FROM (measured, not assumed — `gh pr view --json comments` on a top-level
PR comment has keys author, authorAssociation, body, createdAt, id, includesCreatedEdit, isMinimized,
minimizedReason, reactionGroups, url, viewerDidAuthor): there is NO `databaseId` and NO `updatedAt`.
So on the CLI transport the only monotonic value available is `createdAt`. On the REST transport the
numeric id is itself monotonic and is strictly better, so it wins there.

SAME-SECOND TIE-BREAK. `createdAt` has one-second resolution, so two comments posted in the same
second tie. Payload position is NOT a usable tie-break — the next poll may return them in a different
order, which would move the watermark between polls and re-introduce both drop and re-delivery. The
tie-break therefore folds the opaque key into the fractional part via a fixed-width hash, making the
pair (timestamp, key-hash) a total order that is identical on every call, in every process.
*/

export type PrCommentIdentityKey = string;
export type PrCommentIdentitySequence = number;

/** Thrown when a transport hands us an id we cannot turn into a real identity. Never coerced. */
export class PrCommentIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrCommentIdentityError";
  }
}

export interface PrCommentIdentityInput {
  /** Raw `id` from the transport: numeric (REST) or a GraphQL node id (`gh` CLI). */
  id?: string | number | null;
  /** ISO timestamp. The ORDER source on the `gh` transport, which carries no numeric id. */
  createdAt?: string | null;
}

export interface PrCommentIdentity {
  /** IDENTITY role — compare only for equality. Opaque and stable. */
  key: PrCommentIdentityKey;
  /** ORDER role — compare with `>` and reduce with `Math.max`. Monotonic in creation time. */
  sequence: PrCommentIdentitySequence;
}

/** Numeric ids round-trip exactly; this is the whole point of the REST path. */
function isNumericCommentId(raw: string): boolean {
  return /^\d+$/.test(raw);
}

/**
 * FNV-1a over the opaque key, mapped into [0, 1). Used ONLY as a same-second tie-break, so hash
 * quality is irrelevant — it needs to be deterministic and collision-free enough that two comments
 * in one second do not tie. Deterministic across processes because it is pure string math.
 */
function keyTieBreakFraction(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    // 32-bit FNV prime multiply, kept in uint32 via Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * Resolve one transport comment into its IDENTITY and its ORDER.
 *
 * THROWS `PrCommentIdentityError` when the id is missing, blank, or unresolvable. It must never
 * return `NaN` and must never return a shared sentinel: substituting `0` or `"unknown"` reproduces
 * the exact constant-identity collapse this function exists to end, only under a quieter name.
 */
export function resolvePrCommentIdentity(input: PrCommentIdentityInput): PrCommentIdentity {
  const raw = typeof input.id === "number" ? String(input.id) : (input.id ?? "").trim();

  if (raw.length === 0) {
    throw new PrCommentIdentityError(
      "Cannot resolve a PR comment identity: the transport supplied no id. Refusing to invent one.",
    );
  }

  // REST transport (and any numeric string): the id is real, monotonic, and the better sequence.
  if (isNumericCommentId(raw)) {
    const numeric = Number.parseInt(raw, 10);
    return { key: raw, sequence: numeric };
  }

  // `gh` CLI transport: a GraphQL node id. It is opaque, so it is only ever the identity key.
  const key = raw;

  if (isNumericCommentId(input.createdAt?.trim() ?? "")) {
    // Defensive only: a numeric-string createdAt would mean an epoch-second timestamp, not ISO.
    throw new PrCommentIdentityError(
      `Cannot resolve a PR comment sequence: createdAt "${input.createdAt}" is not an ISO timestamp.`,
    );
  }

  const createdAtMs = input.createdAt ? Date.parse(input.createdAt) : Number.NaN;
  if (!Number.isFinite(createdAtMs)) {
    throw new PrCommentIdentityError(
      `Cannot resolve a PR comment sequence for id "${key}": no usable createdAt on the transport, ` +
        "so newness would have to be decided by the opaque id, which is not ordered by time.",
    );
  }

  // Whole seconds + a deterministic same-second tie-break, so the pair is a total order that is
  // identical on every call and in every process. Math.floor drops the sub-second fraction so the
  // timestamp ordering stays authoritative and the hash only separates genuine ties.
  const sequence = Math.floor(createdAtMs / 1000) + keyTieBreakFraction(key);

  return { key, sequence };
}

/**
 * The review-item key for a PR comment: `` `gh-comment-${id}` ``, preserved verbatim from the
 * historical shape so already-correct REST-fed rows (e.g. `gh-comment-5884072859`) keep their exact
 * key across this fix. A node id is used as-is — the key is opaque, so nothing downstream needs it
 * to be numeric, and hashing it would churn keys that are already correct.
 */
export function buildPrCommentReviewItemId(id: string | number): string {
  const raw = typeof id === "number" ? String(id) : id.trim();
  if (raw.length === 0) {
    throw new PrCommentIdentityError("Cannot build a PR comment review item id from an empty id.");
  }
  return `gh-comment-${raw}`;
}

export type TaskReviewMode = "pull-request" | "direct";
export type TaskReviewSource = "github-pr" | "reviewer-agent";
export type TaskReviewDecision = "approved" | "changes-requested" | "commented" | "pending";
/*
 * FNXC:PlanReviewNoOp 2026-08-09-01:17:
 * The Review data projection must retain the Plan-Review-only close verdict as audit evidence;
 * consumers render it as a terminal review decision rather than converting it into a revision.
 */
export type TaskReviewVerdict = "APPROVE" | "APPROVE_WITH_NOTES" | "REVISE" | "RETHINK" | "UNAVAILABLE" | "CLOSE_NO_OP";
export type TaskReviewerType = "plan" | "code";
export type TaskReviewItemStatus = "queued" | "in-progress" | "addressed" | "failed";
export type TaskReviewFindingSeverity = "low" | "medium" | "high" | "critical";
export type TaskReviewFindingResolution = "open" | "resolved-in-review" | "superseded" | "dispute-upheld";

export interface LegacyTaskReviewItem {
  id: string;
  source: TaskReviewSource;
  status: TaskReviewItemStatus;
  summary: string;
  body?: string;
  filePath?: string;
  line?: number;
  commentUrl?: string;
  reviewer?: string;
  createdAt: string;
  updatedAt: string;
  addressedAt?: string;
  failedReason?: string;
}

export interface TaskReview {
  mode: TaskReviewMode;
  source: TaskReviewSource;
  decision: TaskReviewDecision;
  summary?: string;
  latestRefreshAt?: string;
  selectedItemIds?: string[];
  items: LegacyTaskReviewItem[];
}

export type PrCheckState =
  | "success"
  | "pending"
  | "failure"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "skipped"
  | "stale"
  | "startup_failure";

export interface PrCheckStatus {
  name: string;
  required: boolean;
  state: PrCheckState;
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface TaskReviewAuthor {
  login: string;
}

export interface PrTaskReviewSummaryReviewer {
  login: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";
  submittedAt?: string;
}

export interface PrTaskReviewSummary {
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  reviewers: PrTaskReviewSummaryReviewer[];
  blockingReasons: string[];
  checks: PrCheckStatus[];
}

export interface TaskReviewStateItem {
  id: string;
  threadId?: string;
  /*
  FNXC:ReviewItemIdentity 2026-10-02-04:00:
  WIDENED FROM `number` TO `string | number`, DELIBERATELY.

  This field is only populated truthfully when the transport supplied a REAL numeric comment id —
  the REST path does, so it carries `5884072859`. The `gh` CLI path supplies an opaque GraphQL node
  id instead, which is not a number, and the two honest options were to widen the type or to stop
  populating the field and let the `?? item.id` fallback in `syncPrReviewsToTask` carry the identity.

  This widens rather than unpopulates because the node id IS the platform's stable identifier and
  discarding it would throw away information the dedup key needs. What is forbidden here — and is the
  defect this change exists to close — is COERCING it: `Number(nodeId)` yields NaN and `|| 0` yields a
  constant, and either one reproduces the `gh-comment-NaN` collapse one level down, where
  `syncPrReviewsToTask`'s `String(item.githubCommentId ?? item.id)` and the comment dedup key both
  read this field. `undefined` means "this transport gave us no numeric id" and is not a fallback to
  0. Sources that already carry real numeric ids are unaffected and must keep their numbers.
  */
  githubCommentId?: string | number;
  path?: string;
  line?: number;
  diffSide?: string;
  body: string;
  author: TaskReviewAuthor;
  createdAt: string;
  updatedAt?: string;
  state?: string;
  htmlUrl?: string;
  isResolved?: boolean;
  source?: TaskReviewSource;
  reviewType?: TaskReviewerType;
  verdict?: TaskReviewVerdict;
  step?: number;
  summary?: string;
  severity?: TaskReviewFindingSeverity;
  resolution?: TaskReviewFindingResolution;
}

export type ReviewAddressingStatus = "queued" | "in-progress" | "addressed" | "failed";

export interface ReviewAddressingSnapshot {
  itemId: string;
  sourceMode: "pull-request" | "reviewer-agent";
  source: "pr-review" | "reviewer-agent";
  summary: string;
  body: string;
  authorLogin?: string;
  filePath?: string;
  lineNumber?: number;
  severity?: TaskReviewFindingSeverity;
  resolution?: TaskReviewFindingResolution;
  threadId?: string;
  url?: string;
}

export interface ReviewAddressingRecord {
  itemId: string;
  status: ReviewAddressingStatus;
  selectedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  stale?: boolean;
  snapshot?: ReviewAddressingSnapshot;
}

export interface ReviewerTaskReviewSummary {
  verdict?: TaskReviewVerdict;
  reviewType?: TaskReviewerType;
  summary?: string;
}

export type TaskReviewRefreshSource = "manual" | "auto" | "initial-load";
export type TaskReviewRefreshStatus = "idle" | "refreshing" | "ready" | "error";

export interface TaskReviewState {
  source: "pull-request" | "reviewer-agent";
  lastRefreshedAt?: string;
  refreshSource?: TaskReviewRefreshSource;
  refreshStatus?: TaskReviewRefreshStatus;
  refreshError?: string;
  summary?: PrTaskReviewSummary | ReviewerTaskReviewSummary;
  items: TaskReviewStateItem[];
  addressing: ReviewAddressingRecord[];
}

export interface TaskReviewSummary {
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  reviewers?: PrTaskReviewSummaryReviewer[];
  blockingReasons?: string[];
  checks?: PrCheckStatus[];
  verdict?: TaskReviewVerdict;
  reviewType?: TaskReviewerType;
  summary?: string;
}

export interface TaskReviewDataItem {
  itemId: string;
  sourceMode: "pull-request" | "reviewer-agent";
  title: string;
  body: string;
  author: string;
  createdAt: string | null;
  updatedAt: string | null;
  url?: string;
  filePath?: string;
  line?: number;
  severity?: TaskReviewFindingSeverity;
  resolution?: TaskReviewFindingResolution;
  threadId?: string;
  reviewState?: string | null;
  /** Machine-readable reviewer verdict when the source supplied one. */
  verdict?: TaskReviewVerdict;
  /** Review lane that produced the item when known. */
  reviewType?: TaskReviewerType;
  isResolved?: boolean;
  progressStatus?: "queued" | "in-progress" | "addressed" | "failed" | null;
}

export type TaskReviewItem = TaskReviewDataItem;

export interface TaskReviewData {
  mode: "pull-request" | "reviewer-agent";
  refreshable: boolean;
  fetchedAt: string | null;
  summary: TaskReviewSummary | null;
  items: TaskReviewItem[];
}
