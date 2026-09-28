import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runSkillsGet } from "../skills.js";
import { COMPUTER_USE_GUIDE_HEADINGS } from "../computer/guide.js";

const execFile = promisify(execFileCallback);
const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const builtCli = join(cliRoot, "bin.mjs");

describe("fn skills get", () => {
  it("prints the in-process computer-use guide", async () => {
    let output = "";
    await expect(runSkillsGet(["computer-use"], { stdout: (x) => { output += x; } })).resolves.toBe(0);
    for (const heading of COMPUTER_USE_GUIDE_HEADINGS) expect(output).toContain(heading);
  });

  it("rejects unknown and missing names with known skills", async () => {
    let errors = "";
    await expect(runSkillsGet(["nope"], { stderr: (x) => { errors += x; } })).resolves.toBe(1);
    expect(errors).toContain("computer-use");
    await expect(runSkillsGet([], { stderr: () => undefined })).resolves.toBe(1);
  });

  it("renders without a guide file or PATH lookup", async () => {
    /*
     * FNXC:ComputerUseSkill 2026-08-11-07:43:
     * Rendering in this process, with no guide markdown in cwd and no PATH, makes this guide belong
     * to the exact binary that will execute computer commands instead of a stale file or other fn.
     */
    const cwd = mkdtempSync(join(tmpdir(), "fn-skills-get-empty-"));
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    let output = "";
    try {
      process.chdir(cwd);
      process.env.PATH = "";
      await expect(runSkillsGet(["computer-use"], { stdout: (text) => { output += text; } })).resolves.toBe(0);
    } finally {
      process.chdir(originalCwd);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(cwd, { recursive: true, force: true });
    }
    for (const heading of COMPUTER_USE_GUIDE_HEADINGS) expect(output).toContain(heading);
  });

  it("keeps the get branch free of markdown, network, and child-process sources", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) => readFile(join(cliRoot, "src", "commands", "skills.ts"), "utf8"));
    const branch = source.slice(source.indexOf("export async function runSkillsGet"));
    expect(branch).not.toMatch(/\b(?:readFile|readFileSync|fetch|spawn|exec)\s*\(/);
  });

  it("prints a guide and version from the same built CLI entry point", async () => {
    /*
    FNXC:SkillsGet 2026-09-28-07:30 (FUSI-035):
    Run the three cold CLI spawns CONCURRENTLY. Each spawn of the built entry point costs ~1.9-2.2s
    on this host, so awaiting them back to back needed ~6.0s against Vitest's default 5s per-test
    budget and timed out 3/3 (the 2026-09-25 main Full Suite census recorded this as a runtime-Error).
    No individual subprocess exceeds the budget — the serial composition did. The three calls are
    independent (guide and --version share no state; the unknown-skill call is its own process), so
    Promise.all collapses the body to roughly the slowest single spawn. Do NOT "fix" this with a
    per-test timeout argument or a `testTimeout` bump: that is appeasement, and the measured fix is
    concurrency. If a future environment cannot fit the concurrent form in 5s, reduce the number of
    subprocesses instead of raising the ceiling.
    */
    const spawn = (args: string[]) =>
      execFile(process.execPath, [builtCli, ...args], { cwd: cliRoot })
        .then((value) => ({ value }), (error) => ({ error }));
    const [guideOutcome, versionOutcome, unknownOutcome] = await Promise.all([
      spawn(["skills", "get", "computer-use"]),
      spawn(["--version"]),
      spawn(["skills", "get", "definitely-not-a-skill"]),
    ]);

    // Unwrap with the same assertions the serial form made, unchanged in strength.
    if ("error" in guideOutcome) throw guideOutcome.error;
    if ("error" in versionOutcome) throw versionOutcome.error;
    const guide = guideOutcome.value;
    const version = versionOutcome.value;
    for (const heading of COMPUTER_USE_GUIDE_HEADINGS) expect(guide.stdout).toContain(heading);
    expect(guide.stdout).toContain(`# Fusion computer-use guide (v${version.stdout.trim()})`);

    expect("error" in unknownOutcome).toBe(true);
    const unknownError = (unknownOutcome as { error: { code?: number; stderr?: string } }).error;
    expect(unknownError.code).toBe(1);
    expect(unknownError.stderr).toContain("computer-use");
  });
});
