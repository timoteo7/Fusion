import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { COMPUTER_COMMAND_SURFACE } from "../computer/contract.js";
const skill = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../skill/computer-use/SKILL.md"), "utf8");
describe("computer-use shipped skill", () => {
  it("has parseable frontmatter and keeps its anti-drift stub thin", () => {
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1];
    expect(parse(frontmatter ?? "")).toMatchObject({ name: "computer-use" });
    expect(skill).toContain("fn skills get computer-use");
    const commands = [...skill.matchAll(/fn computer ([a-z-]+)([^\n]*)/g)];
    expect(commands.map((x) => x[1])).toEqual(["capabilities", "permissions", "list-apps"]);
    for (const [, name, tail] of commands) {
      expect(COMPUTER_COMMAND_SURFACE[name as keyof typeof COMPUTER_COMMAND_SURFACE]).toBeDefined();
      expect(tail.replace(/`$/, "")).toBe(" --json");
    }
  });
});
