import type { AffectedTestScope } from "@fusion/core";

/*
FNXC:SelfImproveAffectedTestScope 2026-09-30-09:10:
FUSI-016 resolves the set of tests the primary gate will run for a candidate diff. The rule is
absolute: a whole-workspace run is STRUCTURALLY UNREACHABLE from this module. There is no parameter,
flag, or fallback here that can widen the result to every test in the repo — the type system plus
the per-file resolution make "run everything" unrepresentable. This mirrors `scripts/test-changed.mjs`'s
`resolveAffectedPackages` (the repo's own changed-only resolver) so the gate's notion of "affected"
matches what `pnpm test` already treats as affected; two different notions of affected would make the
gate's verdict disagree with the suite a human runs.

FNXC:SelfImproveAffectedTestScope 2026-09-30-09:10:
The function is PURE and filesystem-free. It takes the changed file list and a LIVE TEST INVENTORY
(injected) rather than reading the tree itself, so it is deterministic and unit-testable, and so the
caller controls how the inventory is captured. Two properties depend on the inventory being the
source of truth rather than the diff:

  - A test path that appears in the diff but is NOT in the live inventory was DELETED by the
    candidate. It is dropped instead of being handed to Vitest, because a deleted file cannot run
    and naming it would produce a spurious gate failure that has nothing to do with the candidate's
    merit.
  - A vitest CONFIG change fans out to that package's live tests, because a config change alters
    what/how every test in the package runs, not one file.
*/

/** A `.test.*` / `.spec.*` file, identified by its repo-relative POSIX path. */
function isTestFilePath(file: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/.test(file);
}

/** A vitest config file, whose change must fan out to its whole package. */
function isVitestConfigPath(file: string): boolean {
  return /(^|\/)vitest(\.workspace)?\.(config\.)?[cm]?[jt]s$/.test(file);
}

/*
FNXC:SelfImproveSharedInfra 2026-09-30-09:10:
Mirror of `scripts/test-changed.mjs`'s `isSharedInfraChange` / `isTestIrrelevantRootPath`. A change to
root build/test infrastructure (workspace manifest, root vitest workspace, shared test harness
scripts) means per-file resolution is not sound — the blast radius is the whole repo's test
behavior. We surface that as an EXPLICIT `shared-infra` scope so the gate's policy can decide (the
`gate`/merge-gate step carries coverage), rather than silently widening to a full run, which this
module must never do.
*/
const SHARED_INFRA_EXACT_PATHS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".changeset/config.json",
  "vitest.workspace.ts",
  "eslint.config.mjs",
  "tsconfig.base.json",
  "scripts/test-with-lock.mjs",
  "scripts/test-changed.mjs",
]);

/** Root files that change nothing executable and must NOT trip shared-infra. */
function isTestIrrelevantRootPath(file: string): boolean {
  if (file.startsWith(".fusion/")) return true;
  if (/^\.changeset\/[^/]+\.md$/.test(file)) return true;
  if (!file.includes("/") && file.toLowerCase().endsWith(".md")) return true;
  if (file === "scripts/lib/test-quarantine.json") return true;
  return ["README", "CHANGELOG.md", "LICENSE", "LICENSE.md"].includes(file);
}

function isSharedInfraChange(changedFiles: string[]): boolean {
  return changedFiles.some((file) => {
    if (SHARED_INFRA_EXACT_PATHS.has(file)) return true;
    if (file.startsWith(".github/workflows/") || file.startsWith("scripts/test-") || file.startsWith("scripts/check-test-")) {
      return true;
    }
    if (isTestIrrelevantRootPath(file)) return false;
    if ((file.startsWith("packages/") || file.startsWith("plugins/")) && /vitest|test/.test(file.split("/").pop() ?? "")) {
      return false;
    }
    if (!file.startsWith("packages/") && !file.startsWith("plugins/") && !file.startsWith("docs/")) return true;
    return false;
  });
}

/** Options controlling affected-test resolution. */
export interface AffectedTestScopeInput {
  /** Repo-relative POSIX paths changed by the candidate (may include added/modified/deleted). */
  changedFiles: readonly string[];
  /** Map of package dir (e.g. "packages/core" or "core") → package name (e.g. "@fusion/core"). */
  packageNameByDir: ReadonlyMap<string, string>;
  /**
   * Returns the live test files (repo-relative POSIX paths) for a package, or an empty list when
   * the package has none. The caller captures this from the candidate tree; keeping it injected
   * makes resolution pure and lets the gate treat the inventory — not the diff — as truth about
   * which tests still exist.
   */
  listLiveTestFiles: (packageName: string) => readonly string[];
}

/** Resolve the exact set of tests the gate runs for a candidate diff. Never widens to full-suite. */
export function resolveAffectedTestScope(input: AffectedTestScopeInput): AffectedTestScope {
  const { changedFiles, packageNameByDir, listLiveTestFiles } = input;

  if (changedFiles.length === 0) return { kind: "empty" };
  if (isSharedInfraChange([...changedFiles])) {
    return { kind: "shared-infra", reason: "shared-test-infrastructure-changed" };
  }

  // Longest package dir first so "packages/foo/bar" wins over "packages/foo".
  const packageDirs = [...packageNameByDir.keys()]
    .filter((dir) => dir.includes("/"))
    .sort((a, b) => b.length - a.length);

  const resolvePackageName = (file: string): string | null => {
    for (const dir of packageDirs) {
      if (file === dir || file.startsWith(`${dir}/`)) {
        return packageNameByDir.get(dir) ?? null;
      }
    }
    if (file.startsWith("packages/")) {
      const [, dir] = file.split("/");
      return packageNameByDir.get(dir) ?? packageNameByDir.get(`packages/${dir}`) ?? null;
    }
    return null;
  };

  const testFiles = new Set<string>();
  const packages = new Set<string>();

  for (const file of changedFiles) {
    // A directly-changed test file counts only if it is still live (skips deleted paths).
    if (isTestFilePath(file)) {
      const pkg = resolvePackageName(file);
      if (pkg && listLiveTestFiles(pkg).includes(file)) {
        testFiles.add(file);
        packages.add(pkg);
      }
      continue;
    }

    // A changed vitest config fans out to that package's live tests.
    const pkg = resolvePackageName(file);
    if (!pkg) continue;
    packages.add(pkg);

    if (isVitestConfigPath(file)) {
      for (const test of listLiveTestFiles(pkg)) testFiles.add(test);
    } else {
      /*
      FNXC:SelfImproveAffectedTestScope 2026-09-30-09:10:
      A non-test source change inside a package pulls in THAT PACKAGE's live tests — the blast
      radius of a source edit is the package that owns it. Crucially this stays per-package: a
      one-file diff in one package resolves to that package's tests, never every test in the
      workspace, because the loop only ever consults the single package the changed file belongs to.
      */
      for (const test of listLiveTestFiles(pkg)) testFiles.add(test);
    }
  }

  if (testFiles.size === 0) {
    return { kind: "empty" };
  }

  const sortedFiles = [...testFiles].sort();
  return {
    kind: "resolved",
    testFiles: sortedFiles,
    packages: [...packages].sort(),
  };
}
