/*
FNXC:SelfImproveStructuralDenylist 2026-09-30-11:35:
The self-improvement loop must never be able to rewrite the equipment that measures it. An
experiment may change product behavior; what it may NOT do is touch the merge gate, the policy
checks, the flaky-test ledger, the release machinery, or the self-patching code itself. This module
is the FLOOR under the primary gate: a pure function from one changed path to at most one of five
immutable categories, or `null` for a path nothing protects.

FNXC:SelfImproveStructuralDenylist 2026-09-30-11:35:
The five categories are CLOSED, not configurable. `gate` (everything the merge gate's verdict
depends on), `ratchets` (the static policy validators and the lint config), `quarantine` (the
flaky-test ledger), `release` (the release script, changesets, and changelogs), and
`self-patching` (the self-improve ledger and the engine experiment directory that applies
proposals). An open-ended list would be a list someone extends to make a rejection go away, which
is the exact failure this guard exists to prevent: the floor is only worth having if it cannot be
edited by the thing standing on it.

FNXC:SelfImproveStructuralDenylist 2026-09-30-11:35:
FIRST-MATCH-WINS, and the order is quarantine → gate → ratchets → release → self-patching. A path
can plausibly be reached by more than one predicate — every package's `vitest.config.ts` carries
quarantine `exclude` lines, so a quarantine reader is both a quarantine artifact and a vitest
config — and a classifier that could answer both "gate" and "ratchets" for one file would make the
rejection reason, the per-category count, and the audit row depend on evaluation order. Quarantine
leads because its two files are narrow and its ownership is unambiguous: the ledger that decides
which failing tests are allowed to be ignored must be answerable as "quarantine" every time.

FNXC:SelfImproveStructuralDenylist 2026-09-30-11:35:
The GATE family is not only the scripts it RUNS — it is also the MANIFESTS that define it. The
four launcher bodies (`test:gate` / `test:gate:static` / `smoke:boot` / `verify:fast`) live in the
root `package.json`, and `run-static-gate-checks.mjs` resolves the blocking-validator membership
from that manifest AT RUNTIME via `JSON.parse(readFileSync(manifestPath)).scripts["test:gate:static"]`
(`scripts/run-static-gate-checks.mjs:55-56`). `packages/core/package.json` is the same story one level
down: its `test:unit-gate` and `test:pg-gate` bodies hold the LITERAL merge-blocking file lists for two
of the three lanes the root `test:gate` spawns, which the repo already treats as gate-critical in
`no-hardcoded-lifecycle-columns.test.ts` and `migration-wiring-integrity.test.ts`. Protecting only
the TARGETS those bodies point at leaves the loader unprotected: an experiment that deletes validators
from `test:gate:static`, or un-lists a blocking test file from `test:unit-gate`, touches NO denylisted
path at all — the removed `check-*.mjs` files are unmodified — and the gate runs with a silently
narrowed verdict. So `package.json` and the `packages/<pkg>/package.json` family are gate members.
They are protected by SHAPE rather than by inspecting their bodies, because the classifier is pure:
it reads a path string and nothing else, and a purity-preserving way to know "does this manifest
define a gate body" is impossible. Over-refusing a manifest edit (a dependency bump in
`packages/core/package.json` is refused) is the correct conservative answer — the floor may be wider
than the need, never narrower.

FNXC:SelfImproveStructuralDenylist 2026-09-30-11:35:
The GATE category is a DERIVED FAMILY, never a hand list, and the derivation is the reason
`run-static-gate-checks.mjs` has its own entry. The merge gate is not one file: it is
`test:gate` → `run-static-gate-checks.mjs` (which itself reads the `test:gate:static` body from the
manifest at runtime) plus the four launchers `test:gate` / `test:gate:static` / `smoke:boot` /
`verify:fast`, plus the `engine-core` project that actually decides the gate verdict — its
`globalSetup` teardown, its `resolve.alias` to the reduced `index.gate.ts` barrel, and the
`build-engine-core-gate-bundle.mjs` that pre-bundles that barrel, plus the `vitest.config.ts` family
whose `engine-core` membership allow-list IS the gate. Three named regressions motivate deriving
instead of listing: `run-static-gate-checks.mjs` is `test:gate`'s FIRST command yet does not match
`check-*.mjs`; `boot-smoke.mjs` is merge-blocking at `pr-checks.yml:300` yet is not a check either;
and drift in `index.gate.ts` has already broken Plan Review and 72 gate cases. A hand list catches
none of those, and the census test in `structural-denylist-pure.test.ts` re-derives the same set so
the suite fails whenever a gate-authoritative file becomes unprotected.

FNXC:SelfImproveStructuralDenylist 2026-09-30-11:35:
This module is PURE: no `fs`, no clock, no I/O, no environment read, no store. It is a function of
the path string alone, which is what makes the refusal REPRODUCIBLE — the same commit classified
twice against the same corpus yields the same category and the same fingerprint with no dependency
on when or where it ran. A classifier that consulted the filesystem or a clock could return a
different verdict for an identical diff on a different machine, and a gate whose own floor moves
under it is not a floor. Path normalization (leading `./`, leading `/`, repeated and trailing `/`) is
therefore done here, once, so a caller cannot make the same file classify differently by formatting
it differently.

FNXC:SelfImproveStructuralDenylist 2026-09-30-11:35:
The batch classifier returns per-category COUNTS, never a path list. `counts` answers "how many
files were hit in this category" and `fileCount` answers "how many protected files were touched" —
both are the numbers an operator needs to understand a stop, and both are what the run-audit row is
allowed to record. A list of paths would be the diff itself, which run-audit must never carry.
`fileCount` is the count of PROTECTED files, not of the input: a diff touching ten product files and
one gate file is a one-file rejection.
*/

/** The five immutable categories a changed path can be refused under. Closed by design. */
export type StructuralDenylistCategory =
  /** Anything the merge gate's verdict depends on: its four launchers, the bundle builder, the gate barrel, the engine-core teardown, and the `vitest.config.ts` membership family. */
  | "gate"
  /** The static policy validators (`check-*.mjs`) and the lint configuration. */
  | "ratchets"
  /** The flaky-test quarantine ledger and its schema. */
  | "quarantine"
  /** The release script, the changeset directory, and the changelogs. */
  | "release"
  /** The self-improvement ledger and the engine experiment machinery that applies proposals. */
  | "self-patching";

/**
 * Every legal category, in FIRST-MATCH-WINS evaluation order.
 *
 * The order is part of the contract, not an implementation detail: `classifyStructuralDenylistPath`
 * returns the first category whose spec matches, so a path reachable by two specs resolves to the
 * one listed earlier. Quarantine leads so the flaky-test ledger is always answerable as
 * "quarantine" even though its consumers are also vitest configs.
 */
export const STRUCTURAL_DENYLIST_CATEGORIES: readonly StructuralDenylistCategory[] = [
  "quarantine",
  "gate",
  "ratchets",
  "release",
  "self-patching",
];

/** True when `value` is one of the five fixed categories. */
export function isStructuralDenylistCategory(value: unknown): value is StructuralDenylistCategory {
  return typeof value === "string" && (STRUCTURAL_DENYLIST_CATEGORIES as readonly string[]).includes(value);
}

/**
 * One category's membership rule, expressed as data so all five are read together.
 *
 * `paths` are exact repo-relative paths. `prefixes` match a whole directory subtree: a rule
 * `packages/core/src/self-improve` covers that directory and everything beneath it. `patterns` are
 * the shape rules — the `check-*.mjs` validator family, the `package.json` manifest family, and the
 * per-package `vitest*.config.ts` family — all of which are derived families rather than enumerated
 * files.
 */
interface StructuralDenylistSpec {
  category: StructuralDenylistCategory;
  paths?: readonly string[];
  prefixes?: readonly string[];
  patterns?: readonly RegExp[];
}

/**
 * The five specs, in evaluation order. Quarantine first, then gate, ratchets, release,
 * self-patching — see the first-match-wins FNXC block for why.
 */
const STRUCTURAL_DENYLIST_SPECS: readonly StructuralDenylistSpec[] = [
  {
    /*
    FNXC:SelfImproveStructuralDenylist 2026-09-30-11:35:
    Quarantine owns exactly two files and nothing else. The ledger is the one artifact that decides
    which failing tests are allowed to keep failing, so an experiment that could edit it could
    silence the very signal the loop is measured against — the ledger leads the order precisely
    because it is also read by every `vitest.config.ts`, which the gate family would otherwise
    claim first.
    */
    category: "quarantine",
    paths: ["scripts/lib/test-quarantine.json", "scripts/lib/test-quarantine.schema.json"],
  },
  {
    /*
    FNXC:SelfImproveStructuralDenylist 2026-09-30-11:35:
    The gate family, in the six groups the merge gate actually resolves through: the four launcher
    scripts in the root manifest, the MANIFESTS that define those launchers plus the per-package
    gate bodies they spawn, the bundle builder that `engine-core` wires in via `globalSetup`,
    the reduced core barrel that project aliases `@fusion/core` to, the teardown it registers as
    its root `globalSetup`, and the `vitest*.config.ts` family whose `engine-core` allow-list decides
    which suites are merge-blocking. `run-static-gate-checks.mjs` is named explicitly because it is
    `test:gate`'s first command yet is not a `check-*.mjs`, and `boot-smoke.mjs` because it is
    merge-blocking at `pr-checks.yml:300`; neither would be caught by a `check-*` glob. The category
    is exactly what the census in the test suite re-derives from the repository, so an added
    gate-authoritative file is either caught here or fails that suite.

    FNXC:SelfImproveStructuralDenylist 2026-09-30-11:35:
    The manifest pattern covers the root `package.json` and the `packages/<pkg>/package.json` family.
    Both are loaders, not targets: `run-static-gate-checks.mjs` reads the validator inventory out of
    the root manifest at runtime, and `packages/core/package.json` carries the literal blocking file
    lists for `test:unit-gate` and `test:pg-gate`. An experiment that edits either one can narrow the
    gate's own membership while touching no file the other categories claim.

    FNXC:SelfImproveStructuralDenylist 2026-09-30-11:35:
    The vitest pattern is the whole `vitest*.config.ts` family per package, not just `vitest.config.ts`.
    `packages/core/vitest.pg.config.ts` is the `--config` that `test:pg-gate` invokes and it
    `mergeConfig`s the protected base config, so overriding include/exclude or hookTimeout there
    silently reweights one third of the merge gate. `packages/cli/vitest.build-exe.config.ts` is the
    `--config` for `test:build-exe`. Matching the SHAPE means a future `vitest.something.config.ts`
    is gate-protected the day it lands rather than the day someone remembers to enumerate it.
    */
    category: "gate",
    paths: [
      "scripts/run-static-gate-checks.mjs",
      "scripts/build-engine-core-gate-bundle.mjs",
      "scripts/boot-smoke.mjs",
      "scripts/verify-fast.mjs",
      "packages/core/src/index.gate.ts",
      "packages/core/src/__test-utils__/vitest-teardown.ts",
    ],
    patterns: [
      /^package\.json$/,
      /^packages\/[^/]+\/package\.json$/,
      /^packages\/[^/]+\/vitest[^/]*\.config\.ts$/,
    ],
  },
  {
    /*
    FNXC:SelfImproveStructuralDenylist 2026-09-30-11:35:
    Ratchets are the standing policy validators and the lint config: the `check-*.mjs` family as a
    SHAPE (so a new validator is protected the day it lands rather than the day someone remembers
    to add it) plus `eslint.config.mjs`, which governs the same architectural boundaries in-process
    that the `check-*.mjs` scripts enforce out-of-process.
    */
    category: "ratchets",
    patterns: [/^scripts\/check-[^/]*\.mjs$/],
    paths: ["eslint.config.mjs"],
  },
  {
    /*
    FNXC:SelfImproveStructuralDenylist 2026-09-30-11:35:
    Release covers the three ways a version becomes real: the release script itself, the changeset
    directory that feeds it, and every changelog it rewrites. Editing any of them lets an experiment
    ship under a version that claims more than the gate verified — which is the one outcome the
    whole ledger exists to make impossible.
    */
    category: "release",
    paths: ["scripts/release.mjs"],
    prefixes: [".changeset"],
    patterns: [/^CHANGELOG\.md$/, /^(?:packages|plugins)\/[^/]+\/CHANGELOG\.md$/],
  },
  {
    /*
    FNXC:SelfImproveStructuralDenylist 2026-09-30-11:35:
    Self-patching covers the code that would apply the change as well as the ledger that records it.
    An experiment that can edit `packages/core/src/self-improve/` can rewrite its own verdict; one
    that can edit `packages/engine/src/experiment/` can rewrite the branch-and-revert machinery that
    isolates it. Both are inside the blast radius of the very loop they serve, so both are refused.
    */
    category: "self-patching",
    prefixes: ["packages/core/src/self-improve", "packages/engine/src/experiment"],
  },
];

/**
 * Normalize one changed path to its canonical repo-relative form.
 *
 * Strips a leading `./`, a leading `/`, any repeated separators, and a trailing `/`, so `./a`,
 * `/a`, and `a/` are the same file to this module. A leading `../` is NOT stripped: a path that
 * escapes the repository root is not a repo-relative path, and silently rewriting it to something
 * comparable would let an out-of-tree path dodge a category that would otherwise catch it. Such a
 * path simply matches nothing and is therefore unprotected — the guard's own caller is responsible
 * for never supplying one, and the census test pins every real repository path as protected.
 */
function normalizeChangedPath(pathname: string): string {
  const trimmed = pathname.trim();
  const withoutLeadingRoot = trimmed.replace(/^\/+/, "");
  const withoutDotSlash = withoutLeadingRoot.replace(/^(?:\.\/)+/, "");
  return withoutDotSlash.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

/** True when the normalized path is exactly `entry` or lives under `entry` as a directory. */
function matchesDirectory(normalized: string, entry: string): boolean {
  return normalized === entry || normalized.startsWith(`${entry}/`);
}

/**
 * Classify ONE changed path.
 *
 * Returns the first matching category, or `null` when nothing protects the path. A single string in
 * and a single category-or-`null` out is the whole contract: no I/O, no clock, no environment, so
 * the same input always yields the same output (see the purity FNXC block above).
 */
export function classifyStructuralDenylistPath(pathname: string): StructuralDenylistCategory | null {
  const normalized = normalizeChangedPath(pathname);
  if (!normalized) return null;

  for (const spec of STRUCTURAL_DENYLIST_SPECS) {
    if (spec.paths?.includes(normalized)) return spec.category;
    if (spec.prefixes?.some((prefix) => matchesDirectory(normalized, prefix))) return spec.category;
    if (spec.patterns?.some((pattern) => pattern.test(normalized))) return spec.category;
  }
  return null;
}

/**
 * The refusal decision for a whole changed-path set.
 *
 * `fileCount` counts PROTECTED files only, and `counts` is a per-category count — the numbers a
 * caller reports and the only shape run-audit may record. Neither is a path list: recording the
 * paths would put the diff itself into telemetry (see the FNXC block above).
 */
export interface StructuralDenylistVerdict {
  /** True when at least one changed path is protected. */
  rejected: boolean;
  /** Every category hit, in `STRUCTURAL_DENYLIST_CATEGORIES` order. Empty when `rejected` is false. */
  categories: StructuralDenylistCategory[];
  /** Number of protected files per hit category. Sums to `fileCount`. */
  counts: Partial<Record<StructuralDenylistCategory, number>>;
  /** Number of protected files across all categories. */
  fileCount: number;
}

/**
 * Classify a whole changed-path set into a refusal decision.
 *
 * A DUPLICATE path counts once: the same file appearing twice in a diff is one file, and counting
 * it twice would inflate both the reported count and the audit row without changing the verdict.
 * Deduplication happens on the normalized form, so `./a` and `a` are also one file.
 */
export function classifyStructuralDenylist(changedPaths: readonly string[]): StructuralDenylistVerdict {
  const perCategory = new Map<StructuralDenylistCategory, number>();

  for (const pathname of new Set(changedPaths.map(normalizeChangedPath))) {
    const category = classifyStructuralDenylistPath(pathname);
    if (!category) continue;
    perCategory.set(category, (perCategory.get(category) ?? 0) + 1);
  }

  const categories = STRUCTURAL_DENYLIST_CATEGORIES.filter((category) => perCategory.has(category));
  const counts: Partial<Record<StructuralDenylistCategory, number>> = {};
  for (const category of categories) counts[category] = perCategory.get(category) ?? 0;

  return {
    rejected: categories.length > 0,
    categories,
    counts,
    fileCount: categories.reduce((sum, category) => sum + (counts[category] ?? 0), 0),
  };
}
