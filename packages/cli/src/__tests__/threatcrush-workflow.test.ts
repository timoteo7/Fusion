import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspaceRoot = join(import.meta.dirname!, "..", "..", "..", "..");

/*
FNXC:ThreatCrushWorkflowTest 2026-09-29-11:29:
A workflow edit that leaves a guard unreachable has fixed nothing, and a test that
only reads the YAML cannot tell a working gate from a broken one. So this suite
executes the real `Scan` step body under bash with a contract-faithful
`threatcrush` stub on PATH and asserts on the step's exit code and its
`status=` output — never on the workflow's text. The stub is the acceptance
gate: it returns exit 1 only when a `--fail-on` threshold was actually received,
so on the pre-fix workflow (empty FAIL_ON) the findings case reports `clean` and
this suite goes red. A stub that exits 1 unconditionally would pass both before
and after the fix, which is exactly the "assert a string is present" weakness
this card exists to remove.

FNXC:ThreatCrushWorkflowTest 2026-09-29-11:29:
Path-only fixtures must use mkdtemp rather than a literal /tmp/... name. ThreatCrush
flags predictable temp paths (CWE-377) even when the tests never create them.
*/

type StubOptions = {
  /** Severity the stubbed scan "finds" in the tree. */
  findingSeverity?: string;
  /** Overrides the default, mimicking the workflow env. */
  failOnOverride?: string;
};

/*
Contract-faithful stub for @profullstack/threatcrush@0.11.0.
  rank():  info=0 low=1 medium=2 high=3 critical=4  (SEVERITY_ORDER)
  - Always writes SARIF on the scan path: the real CLI emits it at
    dist/index.js:11954 *before* setting process.exitCode=1 at :11958-11966,
    so a findings run still leaves a non-empty SARIF and the workflow's
    `if [ ! -s threatcrush.sarif ]` guard passes. A stub that wrote SARIF only
    on the clean path would let that guard fire first and every case would
    report `status=error` — measuring the guard, not the gate.
  - Exit 1 ONLY when a --fail-on threshold was received and the finding
    severity meets it (Math.min over requested ranks => the threshold is a
    floor). Absent --fail-on the floor stays 99, no finding meets it, and the
    step correctly reports `status=clean` — the pre-fix behaviour.
  - An unknown severity exits 2 and writes no SARIF, matching the measured CLI
    behaviour on a bad threshold (exit 2, no SARIF). This ordering matters: a
    stub that wrote SARIF first on every path would turn that case into
    `status=findings` and hide the distinction.
*/
const STUB = `#!/usr/bin/env bash
rank() { case "$1" in
  info) echo 0 ;; low) echo 1 ;; medium) echo 2 ;; high) echo 3 ;;
  critical) echo 4 ;; *) echo -1 ;;
esac; }
out=""; prev=""; values=""
for a in "$@"; do
  if [ "$prev" = "--output" ]; then out="$a"; fi
  if [ "$prev" = "--fail-on" ]; then values="$values$a,"; fi
  prev="$a"
done
printf '%s\\n' "$*" >> "\${STUB_ARGV_FILE:?}"
floor=99
IFS=,
for v in $values; do
  r=$(rank "$v")
  if [ "$r" -lt 0 ]; then exit 2; fi
  if [ "$r" -lt "$floor" ]; then floor=$r; fi
done
printf '{"version":"2.1.0","runs":[{"results":[]}]}' > "$out"
if [ "$(rank "\${STUB_FINDING_SEVERITY:-high}")" -ge "$floor" ]; then exit 1; fi
exit 0
`;

function loadScanStep(): { run: string; env: Record<string, string> } {
  const content = readFileSync(join(workspaceRoot, ".github", "workflows", "threatcrush-scan.yml"), "utf8");
  const doc = parse(content) as any;
  const steps = doc.jobs.scan.steps as any[];
  const scan = steps.find((step) => step.id === "scan");
  if (!scan) throw new Error("threatcrush-scan.yml has no step with id: scan");
  return { run: scan.run as string, env: (scan.env ?? {}) as Record<string, string> };
}

type StepResult = { status: string; exitCode: number; argv: string };

describe.skipIf(process.platform === "win32")("ThreatCrush scan step (executed)", () => {
  let tmpRoot: string;
  let binDir: string;
  let body: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "fusion-threatcrush-workflow-"));
    binDir = join(tmpRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const stubPath = join(binDir, "threatcrush");
    writeFileSync(stubPath, STUB, { mode: 0o755 });
    chmodSync(stubPath, 0o755);
    body = loadScanStep().run;
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Runs the real step body with the stub first on PATH, in a throwaway cwd
  // (the body writes threatcrush.sarif relative to cwd), and returns the
  // step's exit code, its `status=` output, and the stub's received argv.
  function runScan({ findingSeverity = "high", failOnOverride }: StubOptions = {}): StepResult {
    const workDir = join(tmpRoot, `run-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workDir, { recursive: true });
    const bodyPath = join(workDir, "body.sh");
    writeFileSync(bodyPath, body);

    const argvFile = join(workDir, "argv.txt");
    const outputFile = join(workDir, "github_output");
    writeFileSync(outputFile, "");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      NATIVE: "true",
      GITHUB_OUTPUT: outputFile,
      STUB_ARGV_FILE: argvFile,
      STUB_FINDING_SEVERITY: findingSeverity,
    };
    if (failOnOverride !== undefined) env.FAIL_ON_OVERRIDE = failOnOverride;
    else delete env.FAIL_ON_OVERRIDE;

    // bash --noprofile --norc -eo pipefail, body from a file (not -c) so it
    // stays byte-identical to the workflow and is not re-quoted by the parent.
    const proc = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", bodyPath], {
      cwd: workDir,
      env,
      encoding: "utf8",
    });

    const outputs = readFileSync(outputFile, "utf8");
    const statusMatch = /^status=(.*)$/m.exec(outputs);
    const argv = readFileSync(argvFile, "utf8");
    rmSync(workDir, { recursive: true, force: true });

    return { status: statusMatch ? statusMatch[1].trim() : "", exitCode: proc.status ?? -1, argv };
  }

  it("fails with status=findings on a HIGH finding and passes the high threshold (the arm that was dead)", () => {
    const result = runScan({ findingSeverity: "high" });
    expect(result.status).toBe("findings");
    expect(result.exitCode).not.toBe(0);
    expect(result.argv).toContain("--fail-on high");
  });

  it("stays clean on a MEDIUM-only tree (the CWE-377 documentation class)", () => {
    const result = runScan({ findingSeverity: "medium" });
    expect(result.status).toBe("clean");
    expect(result.exitCode).toBe(0);
  });

  it("honours a `medium` override — the override is additive, not ignored", () => {
    const result = runScan({ findingSeverity: "high", failOnOverride: "medium" });
    expect(result.status).toBe("findings");
    expect(result.exitCode).not.toBe(0);
    expect(result.argv).toContain("--fail-on medium");
  });

  it("resolves a blank override to the default `high` (fail-closed default)", () => {
    const result = runScan({ findingSeverity: "high", failOnOverride: "" });
    expect(result.status).toBe("findings");
    expect(result.argv).toContain("--fail-on high");
  });

  it("resolves a whitespace-only override to `high`, not to an unknown severity", () => {
    // ${VAR:-high} alone would pass `--fail-on "  "` here, which the CLI rejects
    // (exit 2, no SARIF) => status=error. The trim keeps this fail-closed.
    const result = runScan({ findingSeverity: "high", failOnOverride: "  " });
    expect(result.status).toBe("findings");
    expect(result.argv).toContain("--fail-on high");
  });

  it("reports status=error for a broken scan (stub writes no SARIF), distinct from findings", () => {
    // A typo'd threshold makes the stub exit 2 without writing SARIF, tripping
    // the workflow's `if [ ! -s threatcrush.sarif ]` guard. That is a broken
    // scan, not a finding, and the two must not be conflated.
    const result = runScan({ findingSeverity: "high", failOnOverride: "hgh" });
    expect(result.status).toBe("error");
    expect(result.exitCode).not.toBe(0);
  });

  it("treats the threshold as a floor, not a list (high,medium behaves as medium)", () => {
    // The CLI/converter take the MIN rank across the requested severities, so
    // `high,medium` is equivalent to `medium` and a MEDIUM finding trips it. This
    // pins that an operator passing a list cannot get "only these severities".
    const multi = runScan({ findingSeverity: "medium", failOnOverride: "high,medium" });
    expect(multi.status).toBe("findings");
    expect(multi.exitCode).not.toBe(0);

    // And a single `high` floor still fails on a CRITICAL finding (>= the floor).
    const critical = runScan({ findingSeverity: "critical" });
    expect(critical.status).toBe("findings");
    expect(critical.exitCode).not.toBe(0);
  });
});

describe("ThreatCrush scan step (structural)", () => {
  it("resolves the threshold through a defaulted shell expansion, not a bare literal", () => {
    // Platform-independent guard for the invariant the executed block above
    // covers on POSIX: a re-break to a bare `FAIL_ON=""` literal removes the
    // default, and the `${FAIL_ON:-high}` expansion is what fails closed.
    const { run } = loadScanStep();
    expect(run).toMatch(/FAIL_ON="\$\{FAIL_ON:-high\}"/);
  });

  it("sources the optional override from a repository variable through env, not shell interpolation", () => {
    const { run, env } = loadScanStep();
    // The override must arrive as an env var (template-injection shape avoided)
    // and be named in the body via the env reference, not inlined.
    expect(env.FAIL_ON_OVERRIDE).toContain("vars.THREATCRUSH_FAIL_ON");
    expect(run).toContain("${FAIL_ON_OVERRIDE}");
  });
});
