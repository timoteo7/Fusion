import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import {
  buildBashContainmentDenialMessage,
  evaluateBashContainment,
  normalizeBashCommandForContainment,
} from "../bash-containment.js";
import { wrapToolsWithBashContainment } from "../pi.js";

/*
FNXC:BashContainment 2026-07-26-14:00:
Regression tests for the unconditional privilege-escalation floor. The
incident chain was bash reading ~/.fusion/settings.json (daemon token) and
curling the approvals API to self-approve. Expectations are HARDCODED —
never derived from the rule table under test.
*/

describe("evaluateBashContainment — denies the escalation chain", () => {
  it("denies reading the global fusion settings file", () => {
    const verdict = evaluateBashContainment("cat ~/.fusion/settings.json");
    expect(verdict.allowed).toBe(false);
    expect(verdict.rule).toBe("fusion-global-dir");
  });

  it("denies quote-split spellings", () => {
    expect(evaluateBashContainment("cat ~/.fus''ion/settings.json").allowed).toBe(false);
    expect(evaluateBashContainment('cat "~/.fusion/settings.json"').allowed).toBe(false);
  });

  it("denies $HOME and ${HOME} spellings", () => {
    expect(evaluateBashContainment("cat $HOME/.fusion/settings.json").allowed).toBe(false);
    expect(evaluateBashContainment('cat "${HOME}/.fusion/settings.json"').allowed).toBe(false);
  });

  it("denies the literal home directory spelling", () => {
    expect(evaluateBashContainment(`cat ${homedir()}/.fusion/settings.json`).allowed).toBe(false);
  });

  it("denies other users' fusion dirs", () => {
    expect(evaluateBashContainment("cat /Users/someone/.fusion/settings.json").allowed).toBe(false);
    expect(evaluateBashContainment("cat /home/ci/.fusion/settings.json").allowed).toBe(false);
  });

  it("denies relative .fusion/settings.json reads", () => {
    expect(evaluateBashContainment("cd ~ && cat .fusion/settings.json").allowed).toBe(false);
  });

  it("denies daemon token env references", () => {
    expect(evaluateBashContainment("echo $FUSION_DAEMON_TOKEN").allowed).toBe(false);
    expect(evaluateBashContainment("env | grep -i daemonToken").allowed).toBe(false);
  });

  it("denies credential store reads", () => {
    expect(evaluateBashContainment("cat ~/.ssh/id_ed25519").allowed).toBe(false);
    expect(evaluateBashContainment("cat $HOME/.aws/credentials").allowed).toBe(false);
    expect(evaluateBashContainment("cat ~/.netrc").allowed).toBe(false);
    expect(evaluateBashContainment("cat ~/.npmrc").allowed).toBe(false);
    expect(evaluateBashContainment("cat ~/.config/gh/hosts.yml").allowed).toBe(false);
  });


  it("denies shell calls to the approvals API", () => {
    expect(
      evaluateBashContainment('curl -X POST http://localhost:4040/api/approvals/apr-123/decision -d \'{"decision":"approve"}\'').allowed,
    ).toBe(false);
    expect(evaluateBashContainment("curl 'http://127.0.0.1:9000/api/tasks?fn_token=abc'").allowed).toBe(false);
  });

  // PR-open rules are owner-scoped (FUSION_PR_OPEN_ALLOW_OWNERS).
  // The default (env var unset) denies every gh pr create / PR API call,
  // so the agent is forbidden from opening PRs against company/other
  // repos. When the env var allows the explicit owner, the same command
  // is permitted. Owner is detected from --repo, --head, or github.com URLs.
  it("denies gh pr create when FUSION_PR_OPEN_ALLOW_OWNERS is unset (default deny)", () => {
    expect(evaluateBashContainment("gh pr create --base homolog --head fusion/gdpr-072 --title x").allowed).toBe(false);
    expect(evaluateBashContainment("gh pr create --draft --base develop --repo bradoctech/gdprev-v2").allowed).toBe(false);
    expect(evaluateBashContainment("gh pr create-pr --base main --repo timoteo7/sandbox").allowed).toBe(false);
    expect(evaluateBashContainment("hub pull-request -b homolog").allowed).toBe(false);
  });

  it("denies the GitHub PR REST API for non-allow-listed owners (default deny)", () => {
    expect(
      evaluateBashContainment("gh api repos/bradoctech/gdprev-v2/pulls -f title=x -f head=foo -f base=homolog").allowed,
    ).toBe(false);
    expect(
      evaluateBashContainment("curl -X POST https://api.github.com/repos/bradoctech/gdprev-v2/pulls -d '{}'").allowed,
    ).toBe(false);
  });

  it("permits gh pr create when the target owner is in FUSION_PR_OPEN_ALLOW_OWNERS", () => {
    process.env.FUSION_PR_OPEN_ALLOW_OWNERS = "timoteo7";
    try {
      const allowed = evaluateBashContainment("gh pr create --base main --head feat/x --title y --repo timoteo7/sandbox");
      expect(allowed.allowed).toBe(true);

      // Owner appears in --head as `owner:branch`; also matched.
      const headForm = evaluateBashContainment("gh pr create --base homolog --head timoteo7:fix/typo --title t");
      expect(headForm.allowed).toBe(true);

      // Same command, different owner — still denied (fail closed).
      const otherOwner = evaluateBashContainment("gh pr create --base main --head bradoctech:feat --title t");
      expect(otherOwner.allowed).toBe(false);
      expect(otherOwner.rule).toBe("company-pr-open");

      // GitHub API URL form is also allow-listed by owner.
      const api = evaluateBashContainment("curl -X POST https://api.github.com/repos/timoteo7/sandbox/pulls -d {}");
      expect(api.allowed).toBe(true);
    } finally {
      delete process.env.FUSION_PR_OPEN_ALLOW_OWNERS;
    }
  });
});

describe("evaluateBashContainment — normal work is unaffected", () => {
  const allowed = [
    "git status",
    "git commit -m 'feat: add thing'",
    "pnpm --filter @fusion/core exec vitest run src/__tests__/foo.test.ts",
    "pnpm install && pnpm build",
    "cat src/index.ts",
    "ls -la packages/",
    "curl https://registry.npmjs.org/react",
    "grep -rn approvals packages/dashboard/src",
    "node scripts/check-changesets.mjs",
    "cat .fusion/tasks/FN-1/PROMPT.md",
  ];
  for (const command of allowed) {
    it(`allows: ${command}`, () => {
      expect(evaluateBashContainment(command)).toEqual({ allowed: true });
    });
  }

  it("allows empty commands", () => {
    expect(evaluateBashContainment("")).toEqual({ allowed: true });
  });
});

describe("normalizeBashCommandForContainment", () => {
  it("strips quotes/backslashes, folds home spellings, lowercases", () => {
    expect(normalizeBashCommandForContainment("CAT '$HOME'/.FUS\\ION/x")).toBe("cat ~/.fusion/x");
  });
});

describe("wrapToolsWithBashContainment", () => {
  const makeBashTool = (execute: (...args: unknown[]) => Promise<unknown>) => ({
    name: "bash",
    label: "bash",
    description: "",
    parameters: {},
    execute,
  });

  it("blocks a denied command before the underlying tool runs", async () => {
    let executed = false;
    const [wrapped] = wrapToolsWithBashContainment([
      makeBashTool(async () => {
        executed = true;
        return { ok: true };
      }) as never,
    ]);
    const result = (await (wrapped.execute as (...args: unknown[]) => Promise<unknown>)(
      "call-1",
      { command: "cat ~/.fusion/settings.json" },
      undefined,
    )) as { isError?: boolean; error?: string };
    expect(executed).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain("privilege-escalation containment");
  });

  it("passes allowed commands through untouched", async () => {
    const [wrapped] = wrapToolsWithBashContainment([
      makeBashTool(async () => ({ ok: true, ran: true })) as never,
    ]);
    const result = (await (wrapped.execute as (...args: unknown[]) => Promise<unknown>)(
      "call-2",
      { command: "git status" },
      undefined,
    )) as { ran?: boolean };
    expect(result.ran).toBe(true);
  });

  it("does not wrap non-bash tools", () => {
    const readTool = { name: "read", label: "read", description: "", parameters: {}, execute: async () => ({}) };
    const [unwrapped] = wrapToolsWithBashContainment([readTool as never]);
    expect(unwrapped).toBe(readTool);
  });
});

describe("buildBashContainmentDenialMessage", () => {
  it("names the rule and tells the agent to ask the operator", () => {
    const message = buildBashContainmentDenialMessage({ allowed: false, rule: "approvals-api", reason: "nope" });
    expect(message).toContain("approvals-api");
    expect(message).toContain("ask the operator");
  });
});
