import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  STRUCTURAL_DENYLIST_CATEGORIES,
  isStructuralDenylistCategory,
  classifyStructuralDenylistPath,
  classifyStructuralDenylist,
} from "../self-improve/structural-denylist.js";

/*
FNXC:SelfImproveStructuralDenylist 2026-09-30-12:05:
The census test is the load-bearing half of this module. A hand-maintained list of gate-authoritative
files rots silently: the merge gate is not one script but a launcher plus the validators it reads plus
the vitest project that decides the verdict, and each time one of those moves or a new validator
lands, a list stops matching reality with nothing failing. So this suite RE-DERIVES the protected set
from the repository — the four gate script bodies from the root manifest, one nested level for the
validators `run-static-gate-checks.mjs` reads out of `test:gate:static` at runtime, and the
`engine-core` globalSetup/resolve.alias targets in `packages/engine/vitest.config.ts` — and asserts
that every derived path classifies to a non-null category. A new gate-authoritative file that nobody
protected therefore fails HERE, at the moment it lands, rather than being discovered the first time
an experiment edits it.

FNXC:SelfImproveStructuralDenylist 2026-09-30-12:05:
Four derived files are pinned individually because they are precisely the ones a plausible classifier
gets wrong. `run-static-gate-checks.mjs` is `test:gate`'s FIRST command yet does not match a
`check-*.mjs` glob; `boot-smoke.mjs` is merge-blocking at `pr-checks.yml:300` yet is not a check
either; `verify-fast.mjs` is one of the four launchers; and `index.gate.ts` is the reduced barrel
whose drift has already broken Plan Review and 72 gate cases. The first three would survive a
naive `check-*` matcher, and the fourth survives any matcher that only thinks in terms of scripts.
*/

// src/__tests__ -> src -> core -> packages -> repo root
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The four root-manifest scripts whose execution constitutes the merge gate and its siblings. */
const GATE_SCRIPTS = ["test:gate", "test:gate:static", "smoke:boot", "verify:fast"] as const;

/** Read a repo-relative file's contents. */
function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("structural denylist category enum", () => {
  it("is the five immutable categories in first-match-wins order", () => {
    expect([...STRUCTURAL_DENYLIST_CATEGORIES]).toEqual([
      "quarantine",
      "gate",
      "ratchets",
      "release",
      "self-patching",
    ]);
  });

  it("recognises exactly its own members", () => {
    for (const category of STRUCTURAL_DENYLIST_CATEGORIES) {
      expect(isStructuralDenylistCategory(category)).toBe(true);
    }
    expect(isStructuralDenylistCategory("not-a-category")).toBe(false);
    expect(isStructuralDenylistCategory(undefined)).toBe(false);
    expect(isStructuralDenylistCategory(7)).toBe(false);
  });
});

describe("structural denylist path classification", () => {
  it.each([
    ["quarantine", "scripts/lib/test-quarantine.json"],
    ["gate", "scripts/run-static-gate-checks.mjs"],
    ["gate", "scripts/build-engine-core-gate-bundle.mjs"],
    ["gate", "scripts/boot-smoke.mjs"],
    ["gate", "scripts/verify-fast.mjs"],
    ["gate", "packages/core/src/index.gate.ts"],
    ["gate", "packages/core/src/__test-utils__/vitest-teardown.ts"],
    ["gate", "packages/engine/vitest.config.ts"],
    ["gate", "packages/core/vitest.config.ts"],
    // P0: the manifest LOADER, not just the scripts it runs. `run-static-gate-checks.mjs` reads the
    // blocking-validator inventory out of the root manifest at runtime, so an edit to
    // `test:gate:static` there narrows the gate while touching no `check-*.mjs`.
    ["gate", "package.json"],
    ["gate", "packages/core/package.json"],
    ["gate", "packages/engine/package.json"],
    // P0: the whole per-package `vitest*.config.ts` family. `vitest.pg.config.ts` is the `--config`
    // `test:pg-gate` invokes and it `mergeConfig`s the protected base, so include/exclude or
    // hookTimeout edits there reweight one third of the gate.
    ["gate", "packages/core/vitest.pg.config.ts"],
    ["gate", "packages/cli/vitest.build-exe.config.ts"],
    ["ratchets", "scripts/check-workspace-package-graph.mjs"],
    ["ratchets", "scripts/check-workspace-package-graph.mjs"],
    ["ratchets", "eslint.config.mjs"],
    ["release", "scripts/release.mjs"],
    ["release", ".changeset/some-change.md"],
    ["release", ".changeset/config.json"],
    ["release", "CHANGELOG.md"],
    ["release", "packages/core/CHANGELOG.md"],
    ["self-patching", "packages/core/src/self-improve/structural-denylist.ts"],
    ["self-patching", "packages/core/src/self-improve/ledger-schema.ts"],
    ["self-patching", "packages/engine/src/experiment/git-policy.ts"],
  ])("classifies %s for %s", (expected, path) => {
    expect(classifyStructuralDenylistPath(path)).toBe(expected);
  });

  it.each([
    "packages/dashboard/app/App.tsx",
    "packages/engine/src/executor/executor.ts",
    "docs/architecture.md",
    "README.md",
    "packages/core/src/task-store/store.ts",
    // A script that is neither a check nor a gate launcher is not protected.
    "scripts/run-pipeline-smoke.mjs",
    // A manifest-shaped path that is NOT a package manifest stays unprotected: protecting every
    // JSON file would refuse the task documents and fixtures an experiment legitimately changes.
    "packages/core/package.json.bak",
    "package-lock.json",
    "docs/architecture.md",
  ])("returns null for the unprotected path %s", (path) => {
    expect(classifyStructuralDenylistPath(path)).toBeNull();
  });

  it("classifies a non-existent package vitest config by shape, not by disk presence", () => {
    expect(existsSync(join(REPO_ROOT, "packages/not-a-real-package/vitest.config.ts"))).toBe(false);
    expect(classifyStructuralDenylistPath("packages/not-a-real-package/vitest.config.ts")).toBe("gate");
  });

  it("does not treat a nested vitest config as the package-level one", () => {
    expect(classifyStructuralDenylistPath("packages/core/nested/vitest.config.ts")).toBeNull();
  });

  it("protects the gate manifests themselves, not only the scripts they run", () => {
    // An edit to root `test:gate:static` removes validators from the blocking policy without
    // modifying any `check-*.mjs`, so a classifier that protected only the validator files would run
    // the gate on a diff that quietly deleted merge-blocking checks.
    expect(classifyStructuralDenylistPath("package.json")).toBe("gate");
    // `packages/core/package.json` holds the literal merge-blocking file lists for `test:unit-gate`
    // and `test:pg-gate`, two of the three lanes the root `test:gate` spawns.
    expect(classifyStructuralDenylistPath("packages/core/package.json")).toBe("gate");
    // A non-existent manifest is protected by shape, like every other derived family here.
    expect(classifyStructuralDenylistPath("packages/not-a-real-package/package.json")).toBe("gate");
  });

  it("protects every per-package vitest config shape, not only vitest.config.ts", () => {
    expect(classifyStructuralDenylistPath("packages/core/vitest.pg.config.ts")).toBe("gate");
    expect(classifyStructuralDenylistPath("packages/cli/vitest.build-exe.config.ts")).toBe("gate");
    expect(classifyStructuralDenylistPath("packages/not-a-real-package/vitest.anything.config.ts")).toBe("gate");
    // Still not a config-shaped file, and still not inside a package.
    expect(classifyStructuralDenylistPath("packages/core/vitest.config.tsx")).toBeNull();
    expect(classifyStructuralDenylistPath("scripts/vitest.config.ts")).toBeNull();
  });

  it("agrees across leading-dot-slash, absolute, and trailing-slash normalizations", () => {
    const canonical = "packages/core/src/index.gate.ts";
    expect(classifyStructuralDenylistPath(canonical)).toBe("gate");
    expect(classifyStructuralDenylistPath(`./${canonical}`)).toBe("gate");
    expect(classifyStructuralDenylistPath(`/${canonical}`)).toBe("gate");
    expect(classifyStructuralDenylistPath(`./${canonical}/`)).toBe("gate");
    expect(classifyStructuralDenylistPath(`packages/core/src/self-improve/`)).toBe("self-patching");
  });

  it("lets quarantine win over every other category for the flaky-test ledger", () => {
    // The ledger is read by every vitest config, so a looser ordering would let the gate family
    // claim it. The ledger is the one file that decides which failures are tolerated, so its
    // category must be answerable as "quarantine" every time.
    expect(classifyStructuralDenylistPath("scripts/lib/test-quarantine.json")).toBe("quarantine");
  });

  it("returns the same category for the same path on repeated calls", () => {
    const first = classifyStructuralDenylistPath("scripts/boot-smoke.mjs");
    const second = classifyStructuralDenylistPath("scripts/boot-smoke.mjs");
    expect(first).toBe(second);
    expect(first).toBe("gate");
  });
});

describe("structural denylist batch classification", () => {
  it("is not rejected for an empty changed-path list", () => {
    expect(classifyStructuralDenylist([])).toEqual({
      rejected: false,
      categories: [],
      counts: {},
      fileCount: 0,
    });
  });

  it("is not rejected when every changed path is a product path", () => {
    const verdict = classifyStructuralDenylist([
      "packages/dashboard/app/App.tsx",
      "docs/architecture.md",
    ]);
    expect(verdict.rejected).toBe(false);
    expect(verdict.fileCount).toBe(0);
  });

  it("counts a duplicated protected path once", () => {
    const verdict = classifyStructuralDenylist([
      "scripts/check-workspace-package-graph.mjs",
      "scripts/check-workspace-package-graph.mjs",
      "./scripts/check-workspace-package-graph.mjs",
    ]);
    expect(verdict.rejected).toBe(true);
    expect(verdict.categories).toEqual(["ratchets"]);
    expect(verdict.counts).toEqual({ ratchets: 1 });
    expect(verdict.fileCount).toBe(1);
  });

  it("reports every category a multi-category diff touches, in enum order", () => {
    const verdict = classifyStructuralDenylist([
      "scripts/release.mjs",
      "eslint.config.mjs",
      "scripts/boot-smoke.mjs",
      "scripts/lib/test-quarantine.json",
      "packages/core/src/self-improve/ledger-schema.ts",
      "packages/dashboard/app/App.tsx",
    ]);
    expect(verdict.rejected).toBe(true);
    expect(verdict.categories).toEqual([
      "quarantine",
      "gate",
      "ratchets",
      "release",
      "self-patching",
    ]);
    expect(verdict.fileCount).toBe(5);
  });

  it("sums per-category counts to the total file count", () => {
    const verdict = classifyStructuralDenylist([
      "scripts/boot-smoke.mjs",
      "scripts/verify-fast.mjs",
      "packages/core/src/index.gate.ts",
      "scripts/check-workspace-package-graph.mjs",
    ]);
    const summed = Object.values(verdict.counts).reduce((total, n) => total + (n ?? 0), 0);
    expect(summed).toBe(verdict.fileCount);
    expect(verdict.counts).toEqual({ gate: 3, ratchets: 1 });
  });

  it("counts only protected files, not the size of the whole diff", () => {
    const verdict = classifyStructuralDenylist([
      "packages/dashboard/app/a.tsx",
      "packages/dashboard/app/b.tsx",
      "packages/dashboard/app/c.tsx",
      "scripts/boot-smoke.mjs",
    ]);
    expect(verdict.fileCount).toBe(1);
  });

  it("returns the identical verdict for two identical calls", () => {
    const paths = ["scripts/boot-smoke.mjs", "scripts/check-workspace-package-graph.mjs"];
    expect(classifyStructuralDenylist(paths)).toEqual(classifyStructuralDenylist(paths));
  });
});

describe("structural denylist census: every gate-authoritative path is protected", () => {
  /**
   * Re-derive the gate-authoritative set the way the guard's category claims to cover it: the four
   * root-manifest gate bodies, one nested level for the validators `run-static-gate-checks.mjs`
   * reads from `test:gate:static` at runtime, the engine-core globalSetup/alias targets, and — the
   * half a target-only derivation misses — the MANIFESTS and sibling vitest configs that those bodies
   * resolve through.
   *
   * The manifest derivation is deliberately done the way the gate resolves it at runtime: read
   * `test:gate` out of the root manifest, find every `pnpm --filter <pkg>` it spawns, and pull that
   * package's manifest in. That is exactly the chain by which `test:unit-gate`/`test:pg-gate` decide
   * two thirds of the gate verdict, so a body that loses a blocking file from its list is a
   * gate-membership edit that a validator-script sweep cannot see.
   */
  function deriveGateAuthoritativePaths(): string[] {
    const manifest = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    const derived = new Set<string>();

    // Level 1: every scripts/...mjs token inside the four gate script bodies.
    for (const name of GATE_SCRIPTS) {
      const body = manifest.scripts[name] ?? "";
      for (const match of body.matchAll(/scripts\/[A-Za-z0-9._-]+\.mjs/g)) derived.add(match[0]);
    }

    // Level 2 (nested): run-static-gate-checks.mjs resolves the contiguous validators out of the
    // manifest at runtime rather than hardcoding them, so the nested level IS the static body.
    // Already covered above, but the on-disk sweep below proves nothing was missed either way.
    for (const entry of readdirSync(join(REPO_ROOT, "scripts"))) {
      if (/^check-.*\.mjs$/.test(entry)) derived.add(`scripts/${entry}`);
    }

    // The engine-core project decides the gate verdict; its globalSetup and resolve.alias targets
    // are gate-authoritative regardless of whether they are scripts.
    derived.add("packages/core/src/index.gate.ts");
    derived.add("packages/core/src/__test-utils__/vitest-teardown.ts");
    derived.add("scripts/build-engine-core-gate-bundle.mjs");

    // Every package's vitest config carries the engine-core membership allow-list, and every SIBLING
    // vitest config is a gate `--config` that can override its protected base via mergeConfig.
    for (const entry of readdirSync(join(REPO_ROOT, "packages"))) {
      const packageDir = join(REPO_ROOT, "packages", entry);
      if (!existsSync(packageDir)) continue;
      for (const file of readdirSync(packageDir)) {
        if (/^vitest.*\.config\.ts$/.test(file)) derived.add(`packages/${entry}/${file}`);
      }
    }

    // The manifest LOADER is gate-authoritative too. The root manifest holds the four launcher
    // bodies, and `run-static-gate-checks.mjs` reads the blocking-validator inventory out of it at
    // runtime — so narrowing that body deletes merge-blocking checks without editing any
    // `check-*.mjs`. Then follow each `--filter <pkg>` the root gate spawns down to that package's
    // own manifest, whose `test:*gate*` bodies carry the literal blocking file lists.
    derived.add("package.json");
    for (const match of (manifest.scripts["test:gate"] ?? "").matchAll(/--filter\s+([@\w./-]+)/g)) {
      const pkg = match[1]!.split("/").pop()!;
      const pkgManifest = `packages/${pkg}/package.json`;
      if (existsSync(join(REPO_ROOT, pkgManifest))) derived.add(pkgManifest);
    }

    return [...derived].sort();
  }

  it("derives a non-empty gate-authoritative set", () => {
    expect(deriveGateAuthoritativePaths().length).toBeGreaterThan(10);
  });

  it("derives the gate manifests, so a membership-rewriting diff cannot pass vacuously", () => {
    // Regression guard for the P0 blind spot: a derivation that only ever yielded scripts and
    // vitest configs passed while `package.json` and `packages/core/package.json` — the files that
    // HOLD the gate bodies — were unprotected. These three must be derived, not assumed.
    const derived = deriveGateAuthoritativePaths();
    expect(derived).toContain("package.json");
    expect(derived).toContain("packages/core/package.json");
    expect(derived).toContain("packages/engine/package.json");
    // And the sibling pg/build-exe configs that a target-only vitest.config.ts sweep would miss.
    expect(derived).toContain("packages/core/vitest.pg.config.ts");
  });

  it("protects every gate-authoritative path the repository resolves", () => {
    const unprotected = deriveGateAuthoritativePaths().filter(
      (path) => classifyStructuralDenylistPath(path) === null,
    );
    expect(unprotected).toEqual([]);
  });

  it.each([
    ["scripts/run-static-gate-checks.mjs", "gate"],
    ["packages/core/src/index.gate.ts", "gate"],
    ["scripts/boot-smoke.mjs", "gate"],
    ["scripts/verify-fast.mjs", "gate"],
    ["package.json", "gate"],
    ["packages/core/vitest.pg.config.ts", "gate"],
  ])("pins %s to the gate category", (path, expected) => {
    expect(classifyStructuralDenylistPath(path)).toBe(expected);
  });
});
