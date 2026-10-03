/*
FNXC:BarrelDuplicateExports 2026-09-30-16:46:
COVERAGE FOR THE BARREL DUPLICATE-EXPORT GATE, PINNED ONE ASSERTION AT A TIME.

Each case below exists because the guard has a specific way of silently going GREEN while broken,
and a green-because-broken ratchet is worse than no gate: it converts "nothing is wrong" into a
claim the merge gate now depends on. The two that matter most are

  - `modifiers` is `undefined` for `ExportDeclaration` in TypeScript 5.9.3, so keying on it finds
    zero exports and reports a clean tree forever. The "clean barrel" cases therefore assert the
    finder SEES the exports, not merely that it returns no duplicates — an empty list proves nothing
    on its own, because a parser that read nothing returns exactly the same empty list.
  - an UNREADABLE barrel must fail rather than pass. "The guard could not check it" must never read
    as "the guard checked it and found nothing".

The gate wiring cases assert that the validator is actually reachable from both the merge gate and
pretest, so the file cannot sit in the repo as a dead check.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findDuplicateExports,
  listBarrelFiles,
  main,
  scanBarrels,
} from "../check-barrel-duplicate-exports.mjs";

// This test lives at scripts/__tests__/, so the repo root is two levels up.
// Uses fileURLToPath (not the bare `URL` global) because eslint.config.mjs does not declare `URL`
// in the Node-globals list for scripts/**/*.mjs, so a bare `new URL(...)` trips no-undef.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("a clean named re-export list reports NO duplicates", () => {
  const source = [
    'export { emitBoundedRunAudit } from "./run-audit/emit-bounded-run-audit.js";',
    'export { TaskStore } from "./task-store.js";',
    'export type { Task } from "./types.js";',
  ].join("\n");
  assert.deepEqual(findDuplicateExports(source, "clean.ts"), []);
});

test("the SAME name re-exported twice is reported — the exact reported defect", () => {
  const source = [
    'export { emitBoundedRunAudit } from "./run-audit/emit-bounded-run-audit.js";',
    'export { emitBoundedRunAudit } from "./other-emitter.js";',
  ].join("\n");
  assert.deepEqual(findDuplicateExports(source, "dup.ts"), [
    { name: "emitBoundedRunAudit", count: 2, file: "dup.ts" },
  ]);
});

test("an aliased re-export collides on the EXPORTED name, not the source name", () => {
  // `as` renames are the easiest duplicate to miss: the source identifiers differ, so a naive
  // walk keyed on the module specifier or the local name would call this clean.
  const source = [
    'export { a as emitBoundedRunAudit } from "./a.js";',
    'export { b as emitBoundedRunAudit } from "./b.js";',
  ].join("\n");
  assert.deepEqual(findDuplicateExports(source, "alias.ts"), [
    { name: "emitBoundedRunAudit", count: 2, file: "alias.ts" },
  ]);
});

test("a barrel of only `export * from` does not crash and reports nothing (excluded by design)", () => {
  const source = ['export * from "./a.js";', 'export * from "./b.js";'].join("\n");
  assert.deepEqual(findDuplicateExports(source, "star.ts"), []);
});

test("`export * from` mixed with explicit exports only reports the EXPLICIT duplicate", () => {
  const source = [
    'export * from "./a.js";',
    'export * from "./b.js";',
    'export { K } from "./k.js";',
    'export { K } from "./k-other.js";',
  ].join("\n");
  assert.deepEqual(findDuplicateExports(source, "mixed.ts"), [{ name: "K", count: 2, file: "mixed.ts" }]);
});

test("a duplicated TYPE-only export list is reported — same TS2300 build break", () => {
  const source = [
    'export type { Reading } from "./readings.js";',
    'export type { Reading } from "./other.js";',
  ].join("\n");
  assert.deepEqual(findDuplicateExports(source, "types.ts"), [
    { name: "Reading", count: 2, file: "types.ts" },
  ]);
});

test("exported const declarations participate in duplicate detection", () => {
  const source = ["export const K = 1;", "export const K = 2;"].join("\n");
  assert.deepEqual(findDuplicateExports(source, "const.ts"), [{ name: "K", count: 2, file: "const.ts" }]);
});

test("a duplicated exported const AND an explicit re-export of the same name both report", () => {
  const source = [
    "export const K = 1;",
    'export { K } from "./k.js";',
    'export { K } from "./k2.js";',
  ].join("\n");
  assert.deepEqual(findDuplicateExports(source, "declaration-and-reexport.ts"), [
    { name: "K", count: 3, file: "declaration-and-reexport.ts" },
  ]);
});

test("a duplicated exported class is reported", () => {
  const source = ["export class C {}", "export class C {}"].join("\n");
  assert.deepEqual(findDuplicateExports(source, "class.ts"), [{ name: "C", count: 2, file: "class.ts" }]);
});

test("a duplicated exported function is reported", () => {
  const source = ["export function f() {}", "export function f() {}"].join("\n");
  assert.deepEqual(findDuplicateExports(source, "fn.ts"), [{ name: "f", count: 2, file: "fn.ts" }]);
});

test("an empty barrel reports nothing and does not throw", () => {
  assert.deepEqual(findDuplicateExports("", "empty.ts"), []);
  assert.deepEqual(findDuplicateExports('// nothing exported yet\n', "comment-only.ts"), []);
});

test("a NON-exported declaration repeated is NOT a duplicate export", () => {
  const source = ["const local = 1;", "const local = 2;"].join("\n");
  assert.deepEqual(findDuplicateExports(source, "local.ts"), []);
});

test("results are ordered by count desc, then name — deterministic diagnostics", () => {
  const source = [
    "export const bbb = 1;",
    "export const bbb = 2;",
    "export const bbb = 3;",
    'export { aaa } from "./a.js";',
    'export { aaa } from "./b.js";',
  ].join("\n");
  assert.deepEqual(findDuplicateExports(source, "order.ts"), [
    { name: "bbb", count: 3, file: "order.ts" },
    { name: "aaa", count: 2, file: "order.ts" },
  ]);
});

test("the REAL barrels are listed and are currently free of duplicates", () => {
  const barrels = listBarrelFiles(REPO_ROOT);
  const paths = barrels.map((b) => b.filePath);
  for (const expected of [
    "packages/core/src/index.ts",
    "packages/core/src/index.gate.ts",
    "packages/engine/src/index.ts",
    "packages/dashboard/src/index.ts",
    "packages/desktop/src/index.ts",
    "packages/i18n/src/index.ts",
    "packages/mobile/src/index.ts",
    "packages/plugin-sdk/src/index.ts",
  ]) {
    assert.ok(paths.includes(expected), `expected barrel to be scanned: ${expected}`);
  }
  const result = scanBarrels(REPO_ROOT);
  assert.deepEqual(result.duplicates, []);
  assert.deepEqual(result.unreadable, []);
  // ANTI-VACUITY: "no duplicates" is only meaningful if the walk actually read the exports.
  assert.ok(result.scannedFiles >= 8, `expected at least 8 barrels, saw ${result.scannedFiles}`);
  assert.ok(result.scannedExports > 1000, `expected a real export census, saw ${result.scannedExports}`);
});

test("the finder SEES exports — proving 'no duplicates' is not an empty parse", () => {
  // The regression that would make this gate permanently green: keying on `st.modifiers`, which is
  // `undefined` for every ExportDeclaration in TypeScript 5.9.3, yields zero exports and therefore
  // zero duplicates for ANY input. These two cases pin that the finder reads names at all.
  const single = ['export { onlyOneName } from "./a.js";'].join("\n");
  assert.deepEqual(findDuplicateExports(single, "one.ts"), []);
  // Prove the parse by showing the same name twice IS seen — i.e. the walker is not blind.
  const doubled = [
    'export { onlyOneName } from "./a.js";',
    'export { onlyOneName } from "./b.js";',
  ].join("\n");
  assert.equal(findDuplicateExports(doubled, "two.ts").length, 1);
});

test("a root with NO barrels refuses to report success rather than passing an empty scan", () => {
  // "I checked nothing" and "everything is fine" are different answers. A broken glob or a parser
  // regression that yields zero barrels must FAIL, not report a clean tree forever.
  const emptyRoot = mkdtempSync(join(tmpdir(), "barrel-empty-"));
  assert.equal(scanBarrels(emptyRoot).scannedFiles, 0);
  assert.equal(main(emptyRoot), 1);
});

test("an UNREADABLE barrel FAILS rather than counting as clean", () => {
  // A barrel that exists but cannot be read is the dangerous case: the file is still LISTED, so a
  // check that skipped unreadable files would report "scanned N barrels, no duplicates" while one
  // of those N was never actually inspected. Use a directory named index.ts — readFileSync fails
  // with EISDIR on every platform, with no permission-flag dependency (tests may run as root).
  const root = mkdtempSync(join(tmpdir(), "barrel-unreadable-"));
  mkdirSync(join(root, "packages", "broken", "src", "index.ts"), { recursive: true });
  const result = scanBarrels(root);
  assert.equal(result.unreadable.length, 1, "the unreadable barrel must be reported, not skipped");
  assert.equal(main(root), 1);
});

test("a synthetic root containing ONLY the reported defect fails main()", () => {
  // End-to-end through the scanner, not just the pure function: proves the wiring from
  // listBarrelFiles -> readFileSync -> findDuplicateExports -> nonzero exit actually fires.
  const root = mkdtempSync(join(tmpdir(), "barrel-dup-"));
  mkdirSync(join(root, "packages", "core", "src"), { recursive: true });
  writeFileSync(
    join(root, "packages", "core", "src", "index.ts"),
    [
      'export { emitBoundedRunAudit } from "./run-audit/emit-bounded-run-audit.js";',
      'export { emitBoundedRunAudit } from "./other.js";',
      'export * from "./ok.js";',
    ].join("\n"),
  );
  const result = scanBarrels(root);
  assert.deepEqual(result.duplicates, [
    { name: "emitBoundedRunAudit", count: 2, file: "packages/core/src/index.ts" },
  ]);
  assert.equal(main(root), 1);
});

test("main() returns 0 on the real, clean tree", () => {
  assert.equal(main(), 0);
});

test("the validator is wired into BOTH test:gate:static and pretest", () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  for (const key of ["test:gate:static", "pretest", "pretest:full"]) {
    assert.ok(
      typeof manifest.scripts[key] === "string" && manifest.scripts[key].includes("check-barrel-duplicate-exports.mjs"),
      `${key} must run check-barrel-duplicate-exports.mjs`,
    );
  }
  // run-static-gate-checks.mjs only reads the LEADING contiguous `node scripts/check-*.mjs` chain,
  // so a check placed after any other command shape would be silently ignored by the merge gate.
  const leading = manifest.scripts["test:gate:static"].split("&&").map((c) => c.trim());
  const gateChecks = [];
  for (const command of leading) {
    const match = /^node\s+(scripts\/check-[\w-]+\.mjs)$/.exec(command);
    if (!match) break;
    gateChecks.push(match[1]);
  }
  assert.ok(
    gateChecks.includes("scripts/check-barrel-duplicate-exports.mjs"),
    "the validator must sit inside the leading contiguous static-gate chain",
  );
  assert.equal(manifest.scripts["check:barrel-duplicate-exports"], "node scripts/check-barrel-duplicate-exports.mjs");
});