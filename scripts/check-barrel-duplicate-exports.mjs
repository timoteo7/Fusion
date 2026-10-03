#!/usr/bin/env node
/*
FNXC:BarrelDuplicateExports 2026-09-30-16:46:
NO PACKAGE BARREL MAY EXPORT THE SAME NAME TWICE.

MOTIVATING DEFECT: `emitBoundedRunAudit` was exported twice from BOTH public entry points —
`packages/core/src/index.ts` and `packages/core/src/index.gate.ts` — so `pnpm build` failed with
TypeScript TS2300 "Duplicate identifier 'emitBoundedRunAudit'". TypeScript is the ONLY thing that
catches this, and it catches it at build time, not at review time. The hand-fix was correct but left
nothing behind, so the same mistake could be reintroduced by any future edit to a 3,200-line barrel
and would again be discovered only when a build fails.

WHY A STANDING GUARD: TS2300 is a compile error, so it cannot silently pass a gate — but it also
cannot be found by a reviewer reading a diff, because the second export looks exactly like the first
one and both are individually correct. This check makes the class of mistake fail in SECONDS, naming
the offending symbol, instead of at the end of a full build.

SCOPE — EXPLICIT named re-exports and exported declarations only:
  - `export { name } from "..."` / `export { a as name }` (including `export type { ... }` lists)
  - `export const|let|var`, `export class`, `export function`, `export enum` in the barrel itself

DELIBERATELY OUT OF SCOPE — `export * from` transitivity:
33 star exports exist across the 8 package barrels today. A name can collide through two star
re-exports only when the two source modules both export it, and proving that requires a RESOLVED
program plus a symbol table rather than a per-file statement walk. Approximating it would false-fire
on legitimate existing star re-exports, and a gate that cries wolf on its first run is a gate whose
readers learn to skip it. The motivating defect is the explicit shape, so the explicit shape is what
is checked.

ANTI-VACUITY: `main()` refuses to report success when it scanned zero barrels or read zero explicit
exports, so a broken file glob or a parser regression fails the gate instead of silently passing.
An UNREADABLE barrel is a failure, not a skip: "the guard could not check it" must never read as
"the guard checked it and found nothing".
*/
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

/** Barrel files are `packages/<pkg>/src/index*.ts`. */
function isBarrelFileName(fileName) {
  return /^index[^/\\]*\.ts$/.test(fileName);
}

/**
 * List every package barrel, sorted for deterministic diagnostics.
 * A package without a readable `src/` is simply not a package with a barrel.
 *
 * @returns {{ filePath: string, absPath: string }[]}
 */
export function listBarrelFiles(repoRoot = REPO_ROOT) {
  const packagesDir = join(repoRoot, "packages");
  let entries;
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const barrels = [];
  for (const entry of entries.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const srcDir = join(packagesDir, entry.name, "src");
    let files;
    try {
      files = readdirSync(srcDir);
    } catch {
      continue;
    }
    for (const fileName of files.filter(isBarrelFileName).sort()) {
      barrels.push({
        filePath: `packages/${entry.name}/src/${fileName}`,
        absPath: join(srcDir, fileName),
      });
    }
  }
  return barrels;
}

/**
 * Record one exported name occurrence.
 * @param {Map<string, number>} counts
 * @param {string} name
 */
function record(counts, name) {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

/**
 * Walk one barrel's top-level statements and count every explicitly exported name.
 *
 * FNXC:BarrelDuplicateExports 2026-09-30-16:46:
 * KEY ON STATEMENT KIND, NOT `node.modifiers`. In this repo's TypeScript (5.9.3) `modifiers` is
 * `undefined` for every `ExportDeclaration`, so a `st.modifiers?.some(isExportKeyword)` filter finds
 * ZERO exports and reports a clean tree forever — a gate that is green precisely when it is broken.
 * Measured: `ts.isExportDeclaration(st)` + `ts.isNamedExports(st.exportClause)` finds all of them.
 * `modifiers` IS correct for Variable/Class/Function/Enum declarations, so it is used there.
 *
 * @param {import("typescript").SourceFile} sourceFile
 * @returns {Map<string, number>} exported name -> occurrence count
 */
function countExportedNames(sourceFile) {
  const counts = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      // `export * from "..."` has a null exportClause and carries no name — skip without crashing.
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) record(counts, element.name.text);
      }
      continue;
    }
    const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (!isExported) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) record(counts, declaration.name.text);
      }
    } else if (
      (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      record(counts, statement.name.text);
    }
  }
  return counts;
}

/**
 * Pure duplicate-finder: exported names occurring more than once in one barrel.
 * Type-only export lists participate, because `export type { X }` twice is the same TS2300 class of
 * build break as a duplicate value export.
 *
 * @param {string} sourceText
 * @param {string} [fileLabel] used only in diagnostics/tests
 * @returns {{ name: string, count: number, file: string }[]} sorted by count desc, then name
 */
export function findDuplicateExports(sourceText, fileLabel = "<inline>") {
  const sourceFile = ts.createSourceFile(fileLabel, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const counts = countExportedNames(sourceFile);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({ name, count, file: fileLabel }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Scan every barrel. An unreadable barrel is a failure — never a silent pass.
 *
 * @returns {{ duplicates: { name: string, count: number, file: string }[], unreadable: string[], scannedFiles: number, scannedExports: number }}
 */
export function scanBarrels(repoRoot = REPO_ROOT) {
  const barrels = listBarrelFiles(repoRoot);
  const duplicates = [];
  const unreadable = [];
  let scannedExports = 0;
  for (const barrel of barrels) {
    let text;
    try {
      text = readFileSync(barrel.absPath, "utf8");
    } catch {
      unreadable.push(barrel.filePath);
      continue;
    }
    scannedExports += countExportedNames(
      ts.createSourceFile(barrel.filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    ).size;
    duplicates.push(...findDuplicateExports(text, barrel.filePath));
  }
  return { duplicates, unreadable, scannedFiles: barrels.length, scannedExports };
}

export function main(repoRoot = REPO_ROOT) {
  const { duplicates, unreadable, scannedFiles, scannedExports } = scanBarrels(repoRoot);

  if (scannedFiles === 0 || scannedExports === 0) {
    console.error(
      `[check-barrel-duplicate-exports] scanned ${scannedFiles} barrel(s) and found ${scannedExports} explicit export(s) — refusing to report success on an empty scan.`,
    );
    return 1;
  }

  if (unreadable.length > 0) {
    console.error(
      `[check-barrel-duplicate-exports] could not read ${unreadable.length} barrel(s); an unchecked barrel is not a clean barrel:`,
    );
    for (const file of unreadable) console.error(`  unreadable: ${file}`);
  }

  if (duplicates.length > 0) {
    console.error(
      `[check-barrel-duplicate-exports] found ${duplicates.length} duplicated export name(s) across ${scannedFiles} barrel(s):`,
    );
    for (const duplicate of duplicates) {
      console.error(`  ${duplicate.file}: '${duplicate.name}' is exported ${duplicate.count} times`);
    }
    console.error(
      "TypeScript reports this as TS2300 'Duplicate identifier' and `pnpm build` fails. Remove the redundant export.",
    );
    return 1;
  }

  if (unreadable.length > 0) return 1;

  console.log(
    `[check-barrel-duplicate-exports] ${scannedExports} explicit export(s) across ${scannedFiles} barrel(s), no duplicated names.`,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}