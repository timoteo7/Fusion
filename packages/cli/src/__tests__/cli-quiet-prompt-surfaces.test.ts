import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cliRoot = join(import.meta.dirname, "..");
const exemptSources = new Set([join(cliRoot, "commands", "chat.ts")]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.name === "__tests__") return [];
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("CLI quiet prompt and result source contracts", () => {
  it("does not construct a non-exempt readline prompt with gated stdout", () => {
    for (const path of sourceFiles(cliRoot)) {
      if (exemptSources.has(path)) continue;
      const source = readFileSync(path, "utf8");
      if (!source.includes("createInterface")) continue;
      /*
      FNXC:CliTests 2026-08-23-16:50:
      MEASURE THE PROMPT, NOT THE FILE. A whole-file search for `output: process.stdout` convicts any
      module that merely mentions `createInterface` somewhere — `commands/mcp-memory-server.ts` builds
      an input-only readline over stdin and separately writes JSON-RPC RESPONSES to `process.stdout`,
      which is its transport and not a prompt. Inspect each `createInterface({ ... })` argument object
      instead, so the invariant (no readline prompt writes to gated stdout) still fails on a real one.
      */
      const interfaceOptions = source.match(/createInterface\(\s*\{[^}]*\}/g) ?? [];
      for (const options of interfaceOptions) {
        expect(options, path).not.toMatch(/output:\s*process\.stdout/);
      }
    }
  });

  it("keeps all audited result writers attached to the output seam", () => {
    /*
    FNXC:CliTests 2026-09-28-07:10 (FUSI-035):
    The audited list is curated, not scanned, so every entry must be a file that still exists.
    `research.ts` was removed with the fn research CLI in 74ffa19ef, and `readFileSync` on a deleted
    path fails at runtime (ENOENT) before either contract regex is ever evaluated — which is what the
    2026-09-25 main Full Suite census recorded for this case. Drop the retired entry; never convert the
    loop into a directory scan, because the curated list IS the audit boundary. A file deleted from
    packages/cli/src/commands must be dropped here in the same commit that deletes it.
    */
    for (const file of ["task.ts", "org-import.ts", "workflow.ts", "experiment-finalize.ts", "update.ts"]) {
      const source = readFileSync(join(cliRoot, "commands", file), "utf8");
      expect(source, file).toMatch(/import\s*\{[^}]*\bresult\b[^}]*\}\s*from\s*["']\.\.\/output\.js["']/);
      expect(source, file).toMatch(/(?:result|outputResult)\(/);
    }
  });
});
