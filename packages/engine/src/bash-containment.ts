import { homedir } from "node:os";

/*
FNXC:BashContainment 2026-07-26-12:40:
Security incident follow-up: an agent's real escalation chain was
`bash("cat ~/.fusion/settings.json")` (agents run as the same OS user, so the
0600 file holding `daemonToken` is readable) → find its own pending approval
request → `curl` the approvals decision API to approve itself. Fixing the
decision route alone is insufficient while bash can read the token.

This module is a PRIVILEGE-ESCALATION FLOOR, not a permission preference:
it holds UNCONDITIONALLY at every permission preset including the default
`unrestricted`. Ordinary bash permission gating stays policy-driven (see
agent-action-gate.ts); this floor only denies the narrow set of commands
that let an agent escalate its OWN privileges:
  1. reads of the Fusion global config / daemon token (~/.fusion, any
     .fusion/settings.json spelling, FUSION_DAEMON_TOKEN / daemonToken refs),
  2. reads of common same-user credential stores (~/.ssh, ~/.aws, ~/.netrc,
     ~/.npmrc, ~/.config/gh, ~/.docker/config.json, ~/.gnupg, ~/.kube),
  3. self-directed calls to the approvals API (/api/approvals, fn_token=).

HONESTY / LIMITATIONS (do not oversell this): matching happens on a
normalized copy of the command STRING (quotes/backslashes stripped, $HOME and
the literal home directory folded to ~, lowercased). That defeats the trivial
bypasses (`cat ~/.fus''ion/settings.json`, `"$HOME"/.fusion`, absolute home
paths) but NOT determined indirection: base64-built paths, variable
concatenation (a=fus; b=ion; cat ~/.$a$b/...), glob spelling (~/.f*sion),
symlinks created first, python/node one-liners, or reading via a spawned
interpreter. String inspection of shell cannot be sound. This floor raises
the cost of the KNOWN escalation chain and creates an audit-visible denial;
real containment requires OS-level isolation (separate user / sandbox),
which is out of scope here. Deny messages are deliberately explicit so a
probing agent's attempts are visible in session logs.
*/

export interface BashContainmentVerdict {
  allowed: boolean;
  /** Stable rule id for logs/tests when denied. */
  rule?: string;
  /** Human-readable denial reason (safe to surface to the agent). */
  reason?: string;
}

/*
FNXC:BashContainment 2026-09-04:
PR-open rules are owner-scoped. `gh pr create` (and the API equivalents)
are denied for every owner by default; an operator can allow their OWN
repos by setting the env var FUSION_PR_OPEN_ALLOW_OWNERS to a comma
separated list of GitHub owners (e.g. "timoteo7"). PRs targeting an
allowed owner pass the containment floor; everything else is denied with
an explicit, audit-visible reason. Matching happens on the same normalized
command string as the other rules (quotes stripped, lowercased), so
`--repo OWNER/REPO`, `--head OWNER:branch`, and github.com URLs are all
inspected. When no owner can be determined in the command (bare `gh pr
create` inside a repo checkout), the command is treated as targeting the
checkout's origin owner when determinable via `gh repo view`-free static
parsing of .git/config; otherwise it is denied (fail closed).
*/
const PR_OPEN_ALLOW_OWNERS_ENV = "FUSION_PR_OPEN_ALLOW_OWNERS";

/** Lazy read: allow-listed owners are resolved per call so operators can toggle the env at runtime and tests can alternate. */
function prOpenAllowedOwners(): string[] {
  return (process.env[PR_OPEN_ALLOW_OWNERS_ENV] ?? "")
    .split(",")
    .map((owner) => owner.trim().toLowerCase())
    .filter(Boolean);
}

function isPrOpenAllowedForOwner(owner: string | undefined): boolean {
  return owner !== undefined && prOpenAllowedOwners().includes(owner.toLowerCase());
}

/** Extract the owner segment from `--repo o/r`, `--head o:b`, `repos/o/r` (gh api), or a github.com URL in the command. */
function extractPrTargetOwner(normalizedCommand: string): string | undefined {
  const repoMatch = normalizedCommand.match(/(?:--repo[= ])([a-z0-9_.-]+)\/[a-z0-9_.-]+/);
  if (repoMatch) return repoMatch[1];
  const headMatch = normalizedCommand.match(/(?:--head[= ])([a-z0-9_.-]+):[a-z0-9_./-]+/);
  if (headMatch) return headMatch[1];
  const apiPathMatch = normalizedCommand.match(/\brepos\/([a-z0-9_.-]+)\/[a-z0-9_.-]+\/pulls\b/);
  if (apiPathMatch) return apiPathMatch[1];
  const urlMatch = normalizedCommand.match(/github\.com\/repos\/([a-z0-9_.-]+)\/[a-z0-9_.-]+/);
  if (urlMatch) return urlMatch[1];
  const apiUrlMatch = normalizedCommand.match(/github\.com\/([a-z0-9_.-]+)\/[a-z0-9_.-]+/);
  if (apiUrlMatch) return apiUrlMatch[1];
  return undefined;
}

interface ContainmentRule {
  id: string;
  pattern: RegExp;
  reason: string;
}

/*
FNXC:BashContainment 2026-07-26-12:40:
Rules match the NORMALIZED command (see normalizeCommand). Home-anchored
patterns use `~/.<dir>` because normalization folds $HOME/${HOME}/absolute
home spellings to `~`. `/users/<name>/` and `/home/<name>/` cover OTHER
users' homes which normalization cannot fold.
*/
const RULES: readonly ContainmentRule[] = [
  {
    id: "fusion-global-dir",
    pattern: /(?:~|\/users\/[^/\s]+|\/home\/[^/\s]+)\/\.fusion\b/,
    reason: "access to the global Fusion directory (daemon token / global settings) is not permitted from agent sessions",
  },
  {
    id: "fusion-settings-file",
    pattern: /\.fusion\/settings\.json/,
    reason: "access to Fusion settings.json is not permitted from agent sessions",
  },
  {
    id: "fusion-daemon-token",
    pattern: /fusion_daemon_token|fusion_dashboard_token|daemontoken/,
    reason: "referencing the Fusion daemon token is not permitted from agent sessions",
  },
  {
    id: "credential-store",
    pattern: /(?:~|\/users\/[^/\s]+|\/home\/[^/\s]+)\/(?:\.ssh|\.aws|\.netrc|\.npmrc|\.gnupg|\.kube|\.config\/gh|\.docker\/config\.json)\b/,
    reason: "access to user credential stores is not permitted from agent sessions",
  },
  {
    id: "approvals-api",
    pattern: /\/api\/approvals|fn_token=/,
    reason: "calling the Fusion approvals API from a shell is not permitted from agent sessions (approvals are decided by the operator)",
  },
  {
    id: "company-pr-open",
    pattern: /\bgh\s+pr\s+(?:create|create-pr)\b|\bhub\s+pull-request\b/,
    reason:
      "opening a GitHub PR is not permitted from agent sessions unless the target owner is in FUSION_PR_OPEN_ALLOW_OWNERS — PRs for company/other owners are opened by the operator only",
  },
  {
    id: "company-pr-open-api",
    pattern: /\bgh\s+api\s+[^;&|`$]*?\/pulls\b|\bcurl\b[^;&|`$]*?api\.github\.com[^;&|`$]*?\/pulls\b/,
    reason:
      "calling the GitHub PR API from a shell is not permitted from agent sessions unless the target owner is in FUSION_PR_OPEN_ALLOW_OWNERS — PRs for company/other owners are opened by the operator only",
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HOME_DIR = homedir();
const HOME_PATTERN = new RegExp(escapeRegExp(HOME_DIR), "gi");

/**
 * FNXC:BashContainment 2026-07-26-12:40:
 * Normalization defeats quote-splitting and $HOME spellings only. Keep this
 * pure and dependency-free so it is trivially unit-testable.
 */
export function normalizeBashCommandForContainment(command: string): string {
  let normalized = command.replace(/["'\\]/g, "");
  normalized = normalized.replace(/\$\{home\}/gi, "~").replace(/\$home\b/gi, "~");
  if (HOME_DIR && HOME_DIR !== "/") {
    normalized = normalized.replace(HOME_PATTERN, "~");
  }
  return normalized.toLowerCase();
}

/** Evaluate the unconditional containment floor for one bash command string. */
export function evaluateBashContainment(command: string): BashContainmentVerdict {
  if (typeof command !== "string" || command.trim() === "") {
    return { allowed: true };
  }
  const normalized = normalizeBashCommandForContainment(command);
  for (const rule of RULES) {
    if (!rule.pattern.test(normalized)) continue;
    // FNXC:BashContainment 2026-09-04:
    // PR-open rules are owner-scoped: an operator can allow their own
    // repos via FUSION_PR_OPEN_ALLOW_OWNERS. When the command references
    // an explicit owner (--repo, --head, or github.com URL) and that owner
    // is allow-listed, the command is permitted. Fail closed when the
    // owner cannot be determined.
    if (rule.id === "company-pr-open" || rule.id === "company-pr-open-api") {
      const owner = extractPrTargetOwner(normalized);
      if (isPrOpenAllowedForOwner(owner)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        rule: rule.id,
        reason:
          rule.id === "company-pr-open"
            ? `opening a GitHub PR for ${owner ?? "an unknown owner"} is not permitted from agent sessions — only operators may open PRs against non-allow-listed owners (FUSION_PR_OPEN_ALLOW_OWNERS)`
            : `calling the GitHub PR API for ${owner ?? "an unknown owner"} is not permitted from agent sessions — only operators may target non-allow-listed owners (FUSION_PR_OPEN_ALLOW_OWNERS)`,
      };
    }
    return { allowed: false, rule: rule.id, reason: rule.reason };
  }
  return { allowed: true };
}

/** Stable message shown to the agent on denial. */
export function buildBashContainmentDenialMessage(verdict: BashContainmentVerdict): string {
  return (
    `Command blocked by Fusion privilege-escalation containment (${verdict.rule ?? "containment"}): ` +
    `${verdict.reason ?? "not permitted"}. This boundary applies at every permission preset; ` +
    `do not attempt to work around it — ask the operator instead.`
  );
}
