import type { PrComment } from "./pr-monitor.js";
import { resolvePrCommentIdentity } from "@fusion/core";
import { prMonitorLog } from "../logger.js";

/*
FNXC:ReviewItemIdentity 2026-10-02-04:00:
THE LIVE WRITER OF THE `gh-comment-NaN` ROW, AND THE TWIN OF THE DASHBOARD SITE.

`gh pr view --json comments` returns a GraphQL NODE id (`IC_kwDOT5Q-Ec8AAAABXrfTmw`), not the REST
numeric id. The historical `parseInt(c.id, 10)` therefore produced `NaN` for every comment, and the
downstream key `gh-comment-${comment.id}` collapsed to the constant `gh-comment-NaN` — so distinct
reviewer comments overwrote one another in `PrCommentHandler.upsertReviewItem`.

This site is the one that actually WROTE the live rows (PrMonitor -> fetchComments ->
`project-engine.ts:1332` -> `PrCommentHandler.handleNewComments`). The dashboard's `listPrComments`
has no production caller, so fixing only that twin is green on every test and changes nothing on the
board. Both move together, always — that duplication is what let the twin defect survive in two places.

Identity and order are SEPARATE here: `id` is the opaque identity key (resolved from the node id),
`sequence` is the monotonic ordering value the monitor compares with `>`. They are distinct fields for
distinct jobs; see `resolvePrCommentIdentity` in core for why conflating them is the defect.
*/
interface GhPrViewJson {
  comments: Array<{
    id: string;
    body: string;
    author: { login: string };
    createdAt: string;
    url: string;
  }>;
}

export interface FetchPrCommentsInput {
  owner: string;
  repo: string;
  prNumber: number;
  since?: string;
}

export interface PrMonitorGhClient {
  checkAuth(): Promise<boolean>;
  fetchComments(input: FetchPrCommentsInput): Promise<PrComment[]>;
}

/**
 * Default gh-backed implementation used in production runtime.
 */
export function createDefaultPrMonitorGhClient(): PrMonitorGhClient {
  return {
    async checkAuth(): Promise<boolean> {
      try {
        const { isGhAvailable, isGhAuthenticated } = await import("@fusion/core");
        return isGhAvailable() && isGhAuthenticated();
      } catch {
        return false;
      }
    },

    async fetchComments({ owner, repo, prNumber, since }: FetchPrCommentsInput): Promise<PrComment[]> {
      const { runGhJson } = await import("@fusion/core");
      const pr = runGhJson<GhPrViewJson>([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        `${owner}/${repo}`,
        "--json",
        "comments",
      ]);

      /*
      Identity and order are resolved together and kept on separate fields. `id` is the opaque key
      the handler uses to build `gh-comment-${id}`; `sequence` is the monotonic value the monitor
      compares with `>` and reduces with `Math.max`. A node id cannot serve the ORDER role: it sorts
      lexicographically, so a new comment could sort below the watermark and be silently dropped.
      A comment whose id AND createdAt are both unusable is skipped (logged, not coerced) rather than
      given a shared sentinel — inventing a value would reintroduce the collapse.
      */
      const resolved: Array<{ comment: PrComment; sequence: number }> = [];
      for (const c of pr.comments) {
        try {
          const { key, sequence } = resolvePrCommentIdentity({ id: c.id, createdAt: c.createdAt });
          resolved.push({
            sequence,
            comment: {
              id: key,
              sequence,
              body: c.body,
              user: { login: c.author.login },
              created_at: c.createdAt,
              html_url: c.url,
            },
          });
        } catch (err) {
          // Resilient monitoring must not wedge on one bad row; skip it and say so.
          const reason = err instanceof Error ? err.message : String(err);
          prMonitorLog.warn(`Skipping PR comment with unresolvable id: ${reason}`);
        }
      }

      let comments = resolved;

      if (since) {
        const sinceDate = new Date(since);
        comments = comments.filter((entry) => new Date(entry.comment.created_at) > sinceDate);
      }

      return comments.map((entry) => entry.comment);
    },
  };
}
