/**
 * Task comments / activity-log / prompt-section rewriting helpers.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Extracted from the monolithic packages/core/src/store.ts (U5 decomposition).
 * Pure behavior-invariant move: function bodies are byte-identical to their
 * pre-extraction form. The mutable activity-log limit state is encapsulated
 * here; store.ts re-imports the helpers and the test-only override seam.
 */
import type { TaskLogEntry } from "../types.js";
import { buildBootstrapPrompt } from "../mesh/mesh-task-replication.js";

const DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT = 1_000;
const DEFAULT_TASK_ACTIVITY_LOG_OUTCOME_LIMIT = 4_000;
const DEFAULT_TASK_ACTIVITY_LOG_ACTION_LIMIT = 4_000;

let taskActivityLogEntryLimit = DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT;
let taskActivityLogOutcomeLimit = DEFAULT_TASK_ACTIVITY_LOG_OUTCOME_LIMIT;
let taskActivityLogActionLimit = DEFAULT_TASK_ACTIVITY_LOG_ACTION_LIMIT;

export function getTaskActivityLogEntryLimit(): number {
  return taskActivityLogEntryLimit;
}

/**
 * Test-only seam for overriding task activity log retention/truncation limits.
 * Must not be used by production code. Tests overriding limits must restore
 * defaults in afterEach/afterAll by passing null.
 */
export function __setTaskActivityLogLimitsForTesting(
  overrides: { entryLimit?: number; outcomeLimit?: number; actionLimit?: number } | null,
): void {
  if (
    overrides == null
    || (overrides.entryLimit == null && overrides.outcomeLimit == null && overrides.actionLimit == null)
  ) {
    taskActivityLogEntryLimit = DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT;
    taskActivityLogOutcomeLimit = DEFAULT_TASK_ACTIVITY_LOG_OUTCOME_LIMIT;
    taskActivityLogActionLimit = DEFAULT_TASK_ACTIVITY_LOG_ACTION_LIMIT;
    return;
  }

  if (overrides.entryLimit != null) {
    if (!Number.isInteger(overrides.entryLimit) || overrides.entryLimit < 1) {
      throw new Error("Task activity log entryLimit must be an integer >= 1");
    }
    taskActivityLogEntryLimit = overrides.entryLimit;
  }

  if (overrides.outcomeLimit != null) {
    if (!Number.isInteger(overrides.outcomeLimit) || overrides.outcomeLimit < 1) {
      throw new Error("Task activity log outcomeLimit must be an integer >= 1");
    }
    taskActivityLogOutcomeLimit = overrides.outcomeLimit;
  }

  if (overrides.actionLimit != null) {
    if (!Number.isInteger(overrides.actionLimit) || overrides.actionLimit < 1) {
      throw new Error("Task activity log actionLimit must be an integer >= 1");
    }
    taskActivityLogActionLimit = overrides.actionLimit;
  }
}

/*
FNXC:TaskLogStructureAwareTruncation 2026-09-28-08:21:
A failed merge must say why it failed. Head-only truncation of a command outcome
crops exactly the line that explains the failure, so a card that holds finished,
approved work can sit parked with its real blocker unreadable: 74 near-identical
`warning: skipped previously applied commit <sha>` lines consumed the whole 4,000
character budget and the trailing `Could not apply <sha>...` was never persisted.
A wall of near-identical skip warnings must never stand in for the reason.

The policy is one shared compactor for both fields, so `action` and `outcome`
cannot drift into disagreeing about what matters:

  1. Within the limit, the text is returned byte-identical — no marker, no
     re-wrapping, no added newline. Ordinary logging is untouched.
  2. A run of >= 3 consecutive lines that share a shape (same prefix, differing
     only in a varying token such as a commit sha) collapses to one counted line
     carrying the count plus the first and last varying tokens.
  3. Text that reads as a command failure keeps a head summary AND the tail,
     because for git and test runners the reason is the last thing printed. The
     marker set deliberately spans every command class that routes through the
     activity log — git (`fatal:`, `error:`, `CONFLICT`, `Could not apply`,
     `Command failed`, `hint:`) and test runners (failing-spec line, per-case
     failure line, assertion diff, `AssertionError`, stack tail, non-zero
     summary) — because a git-only list leaves a vitest summary just as blind.
  4. Anything dropped is named by a greppable marker, and re-compacting an
     already-compacted entry is a no-op, so `compactTaskActivityLog` re-applying
     this on the workflow-definition read path cannot truncate twice.

The invariant: after compaction, a failure diagnostic that was present in the
input is still present in the output. It is asserted as a property, not an offset.
*/

/** Command-failure shapes that put the reason at the END of the output. */
const TASK_LOG_FAILURE_MARKERS: RegExp[] = [
  /(^|\n)\s*fatal:/i,
  /(^|\n)\s*error:/i,
  /(^|\n)\s*hint:/i,
  /\bCONFLICT\b/,
  /\bCould not apply\b/,
  /\bCommand failed\b/i,
  /\bAssertionError\b/,
  /(^|\n)\s*(?:FAIL|FAILED|✗|×|❯)\b/m,
  /\bTest Files?\b.*\bfailed\b/i,
  /\bTests?\b.*\bfailed\b/i,
  /\bexpected\b.*\bto (?:be|equal|contain|match)\b/i,
  /\bELIFECYCLE\b/,
  /\bfailed with exit code\b/i,
];

/** Matches the trailing drop-marker this module appends, so re-compaction is a no-op. */
const TASK_LOG_COMPACTION_MARKER_RE =
  /\n\.\.\. (?:outcome|action) (?:truncated to|compacted)[^\n]*\.\.\.$/;

/** Longest verbatim run of one shape that may be collapsed into a single counted line. */
const TASK_LOG_COLLAPSE_MIN_RUN = 3;

/** Fraction of the limit kept from the head when a failure tail is retained. */
const TASK_LOG_FAILURE_HEAD_FRACTION = 0.4;

function looksLikeCommandFailure(text: string): boolean {
  return TASK_LOG_FAILURE_MARKERS.some((re) => re.test(text));
}

/**
 * Shape of a log line, with the varying token normalized away. `warning: skipped
 * previously applied commit <sha>` collapses onto one shape regardless of which
 * sha it names, which is what makes the run *near*-identical rather than
 * verbatim-identical. Verbatim-identical lines share a shape by definition, so
 * they collapse through the same path.
 */
function lineShape(line: string): { shape: string; prefix: string; varying: string } {
  const match = line.match(/^(.*?)(\S+)(\s*)$/);
  if (!match) return { shape: line, prefix: line, varying: line };
  const [, head = "", token = "", tail = ""] = match;
  // Only treat the trailing token as varying when it looks like an identifier
  // (a sha, a path, a number) — never when it is ordinary prose punctuation.
  const isIdentifierLike = /^[0-9a-f]{7,}$|^\d+$|^[./~]|[/:]/.test(token);
  if (!isIdentifierLike) return { shape: line, prefix: line, varying: line };
  return { shape: `${head}\u0000${tail}`, prefix: head, varying: token };
}

/**
 * Collapse runs of >= 3 consecutive near-identical lines into one counted line
 * carrying the run length and the first/last varying tokens, so a reader learns
 * "74 skipped commits" instead of counting 74 lines.
 */
function collapseRepeatedLineRuns(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const { shape, prefix, varying } = lineShape(line);
    let j = i + 1;
    while (j < lines.length) {
      const candidate = lines[j] ?? "";
      const { shape: nextShape } = lineShape(candidate);
      // Only the shape must match. A run of VERBATIM-identical lines shares a
      // shape by definition, so it collapses through this same path — the
      // near-identical and the exactly-identical cases are one case.
      if (nextShape !== shape) break;
      j += 1;
    }
    const runLength = j - i;
    if (runLength >= TASK_LOG_COLLAPSE_MIN_RUN && prefix !== varying) {
      const lastVarying = lineShape(lines[j - 1] ?? "").varying;
      out.push(`${prefix}... ${runLength} similar lines (first ${varying}, last ${lastVarying})`);
    } else {
      for (let k = i; k < j; k += 1) out.push(lines[k] ?? "");
    }
    i = j;
  }
  return out.join("\n");
}

/**
 * Shared structure-aware compactor for both persisted log fields.
 *
 * `field` names the field only for the drop-marker text; both fields share one
 * policy so they can never disagree about which part of a command's output
 * carries the reason.
 */
function compactTaskLogField(text: string, limit: number, field: "outcome" | "action"): string {
  // (1) Within budget: byte-identical, so ordinary logging cannot regress.
  if (text.length <= limit) return text;
  // (4) Already compacted: re-application must be a no-op.
  if (TASK_LOG_COMPACTION_MARKER_RE.test(text)) return text;

  // (2) Collapse near-identical runs first — this is what lets a git rebase's
  // skip warnings stop crowding the budget in the first place.
  const collapsed = collapseRepeatedLineRuns(text);
  if (collapsed.length <= limit) {
    return collapsed === text
      ? truncateTaskLogFieldTail(text, limit, field)
      : `${collapsed}\n... ${field} compacted: repeated lines collapsed, ${text.length} characters reduced to ${collapsed.length} ...`;
  }

  // (3) Command failure: keep a head summary AND the tail, because the reason
  // is the last thing a command prints.
  if (looksLikeCommandFailure(text)) {
    const collapsedFailure = looksLikeCommandFailure(collapsed) ? collapsed : text;
    return retainFailureTail(collapsedFailure, limit, field, text.length);
  }

  return truncateTaskLogFieldTail(text, limit, field);
}

/** Plain head cut, preserving the historical marker shape so no reader breaks. */
function truncateTaskLogFieldTail(text: string, limit: number, field: "outcome" | "action"): string {
  return `${text.slice(0, limit)}\n... ${field} truncated to ${limit} characters ...`;
}

/**
 * Failure-aware retention: a head summary (enough to name the command) plus the
 * tail (where `fatal:`, `CONFLICT`, `Could not apply` and test-runner assertion
 * diffs live).
 *
 * The tail is aligned BACKWARD to a line boundary, never forward. Aligning
 * forward walks past the start of the final diagnostic line and drops its
 * leading words — which is how a small cap can still lose the reason it was
 * supposed to preserve. The final line is always retained whole; the head takes
 * whatever budget is left over, and may be empty rather than displace it.
 */
function retainFailureTail(text: string, limit: number, field: "outcome" | "action", originalLength: number): string {
  const marker = `\n... ${field} compacted: head and failure tail kept, ${originalLength} characters reduced ...`;
  const budget = Math.max(1, limit - marker.length);
  const lastLineStart = text.lastIndexOf("\n") + 1;
  const preferredTailStart = Math.max(0, text.length - Math.floor(budget * (1 - TASK_LOG_FAILURE_HEAD_FRACTION)));
  // Normally the aligned start is well before the last line, so the tail spans
  // the whole diagnostic block. When the final line alone is longer than the
  // tail budget, backing up to `lastLineStart` keeps that line whole rather than
  // splitting it — the reason outranks the head.
  const tailStart = Math.min(alignToLineStartBackwards(text, preferredTailStart), lastLineStart);
  const tail = text.slice(tailStart);
  const headBudget = budget - tail.length - 1;
  if (headBudget <= 0) return `${marker}\n${tail}`;
  return `${text.slice(0, headBudget)}${marker}\n${tail}`;
}

/** Move a cut point back to just after the previous newline so no line is split. */
function alignToLineStartBackwards(text: string, index: number): number {
  if (index <= 0) return 0;
  const previousBreak = text.lastIndexOf("\n", index - 1);
  return previousBreak === -1 ? 0 : previousBreak + 1;
}

function truncateTaskLogOutcome(outcome: string | undefined): string | undefined {
  if (!outcome) return outcome;
  return compactTaskLogField(outcome, taskActivityLogOutcomeLimit, "outcome");
}

export { truncateTaskLogOutcome };

/**
 * Bounded counterpart for `action`. Only the embedded command payload is ever
 * compacted: the leading sentence is preserved verbatim so prefix matchers such
 * as `IN_REVIEW_STALL_LOG_REGEX` keep matching.
 */
function truncateTaskLogAction(action: string): string {
  if (!action || action.length <= taskActivityLogActionLimit) return action;
  if (TASK_LOG_COMPACTION_MARKER_RE.test(action)) return action;
  return compactTaskLogField(action, taskActivityLogActionLimit, "action");
}

export { truncateTaskLogAction };

export function compactTaskActivityLog(entries: TaskLogEntry[]): TaskLogEntry[] {
  const recentEntries = entries.slice(-taskActivityLogEntryLimit);
  return recentEntries.map((entry) => ({
    ...entry,
    action: truncateTaskLogAction(entry.action),
    outcome: truncateTaskLogOutcome(entry.outcome),
  }));
}

/**
 * Detect whether a PROMPT.md body is the auto-generated bootstrap stub
 * (`# heading\n\n<description>\n`) that `createTask` writes for triage tasks,
 * versus a real specification produced by triage or planning.
 *
 * Detection is wrapper-shape-exact: the on-disk content is compared against
 * the exact bytes `createTask` would have written for the *pre-update*
 * title/description. Earlier heuristic detectors (size caps, `##` header
 * presence, `**Created:**` / `**Size:**` markers) misfired on imported issue
 * bodies that contain `## Repro`, `**Created:** ...`, etc. — those are real
 * stubs but look like real specs to a content-inspecting check. By matching
 * against the wrapper produced from the previous title/description, we are
 * robust to anything the description itself contains.
 */
export function isBootstrapPromptStub(
  content: string,
  taskId: string,
  preUpdateTitle: string | undefined,
  preUpdateDescription: string,
): boolean {
  return content === buildBootstrapPrompt(taskId, preUpdateTitle, preUpdateDescription);
}

/**
 * Replace just the leading `# ...` heading line of a PROMPT.md body, leaving
 * every other section untouched. Used when a metadata edit (title or
 * description change) needs to keep the displayed heading in sync without
 * disturbing the rest of a real specification.
 *
 * If the file does not start with a `#` heading, it is returned verbatim —
 * the caller has no clean place to splice the heading and the spec's content
 * is more important to preserve than the displayed title (task.json is the
 * canonical source for title/description anyway).
 */
export function rewriteHeadingLine(content: string, newHeading: string): string {
  const match = content.match(/^#[^\n]*\n?/);
  if (!match) {
    return content;
  }
  const trailingNewline = match[0].endsWith("\n") ? "\n" : "";
  return `# ${newHeading}${trailingNewline}${content.slice(match[0].length)}`;
}

/**
 * Replace the body of the `## Mission` section with `newDescription`, leaving
 * every other section untouched. Used to propagate `task.description` edits
 * into a real spec without disturbing custom sections (Review Level, Frontend
 * UX Criteria, File Scope, Acceptance Criteria, etc.) that a section-whitelist
 * regen would silently drop.
 *
 * Returns the original content unchanged if there is no `## Mission` section.
 */
export function rewriteMissionSection(content: string, newDescription: string): string {
  const missionMatch = content.match(/^##\s+Mission\s*$/m);
  if (!missionMatch || missionMatch.index === undefined) {
    return content;
  }
  const headerEnd = missionMatch.index + missionMatch[0].length;
  const rest = content.slice(headerEnd);
  // Find the next `## ` heading (start of next section). The match position is
  // relative to `rest`, so we re-anchor to the absolute offset.
  const nextHeading = rest.search(/\n##\s/);
  const sectionEndAbsolute = nextHeading === -1 ? content.length : headerEnd + nextHeading;
  const before = content.slice(0, headerEnd);
  const after = content.slice(sectionEndAbsolute);
  // Reconstruct: header line + blank line + new description + blank line +
  // trailing content (which begins with the newline before the next heading).
  return `${before}\n\n${newDescription}\n${after}`;
}
