/*
FNXC:StoreDoubleWriteContractGuard 2026-09-25-15:05:

THE INVARIANT. A test store double that drives merge finalization must satisfy the same two write
contracts the product depends on, or the fixture silently exercises a different system than the one
in production:

  1. `moveTaskIf` is a PREDICATE-FENCED terminal move. The product calls it at
     `merge/auto-merge-finalization.ts` and only advances the card when the predicate it passes
     returns true. A double that moves unconditionally approves work the product would refuse; a
     double that omits the method throws a TypeError mid-finalization and abandons a landed card.
  2. `updateTaskAtomic` is a FENCED REDUCER write. The product reads the live row inside the mutator
     and persists the returned patch. A double that ignores the mutator's patch records nothing
     while the product believes it did.

THE SECOND FAILURE MODE IS THE ONE THAT HIDES. Where the product reads a compare-and-set RESULT
rather than calling a missing method — `completeValidatorRunIfStillRunning` in
`missions/mission-execution-loop.ts` proceeds only when the store reports `completionApplied === true`
— a double returning the bare row leaves that field undefined, every downstream persisted effect is
skipped, and the only symptom is an assertion reading `expected undefined to be defined`. That shape
produced the FUSI-031 `assertion-other` family: 136 cases across 83 files on main push #3158.

WHY THE AST, NOT A REGEX. A textual scan cannot tell a seam's body from a comment quoting one, and
the first draft of this guard produced false positives on files whose seams were already correct —
which trains authors to ignore a guard. This walks TypeScript nodes exactly as
`_merge-durable-write-callsites.ts` does for the durable-write inventory: it finds the object
property, resolves the arrow function it initialises, and checks the CALL and BRANCH nodes inside.
It asserts CODE CONSTRUCTS, never comment prose or date stamps, per
`scripts/check-no-comment-assertions-in-tests.mjs`.

A file that legitimately needs neither seam carries a `store-double-exempt:` marker naming the
concrete reason. A bare marker with no reason fails here rather than passing silently.
*/
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ENGINE_SRC = fileURLToPath(new URL("..", import.meta.url));

/** The product seam a fixture must model to drive terminal merge finalization. */
const FINALIZATION_ENTRY = "finalizeProvenAutoMergeTask";

/** Predicate-fenced terminal move: the product's conditional lane advance. */
const PREDICATE_FENCED_MOVE = "moveTaskIf";

/** Fenced reducer write: the product's post-move atomic reconciliation. */
const ATOMIC_REDUCER_WRITE = "updateTaskAtomic";

/** A double that models neither seam must say why, in these words, with a reason. */
const EXEMPTION_MARKER = "store-double-exempt:";

type SeamDefect = { seam: string; defect: string };

type TestFile = { relative: string; source: string; tree: ts.SourceFile };

function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      collectTestFiles(absolute, out);
      continue;
    }
    if (/\.test\.ts$/.test(entry)) out.push(absolute);
  }
  return out;
}

function readTestFiles(): TestFile[] {
  return collectTestFiles(ENGINE_SRC).map((absolute) => {
    const source = readFileSync(absolute, "utf8");
    return {
      relative: relative(ENGINE_SRC, absolute).split(sep).join("/"),
      source,
      tree: ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    };
  });
}

/** The arrow/function expression a `name: vi.fn(impl)` property initialises, or that a
 * `store.name = vi.fn(impl)` statement assigns. Both spellings are in active use. */
function seamImplementation(tree: ts.SourceFile, seam: string): ts.ArrowFunction | ts.FunctionExpression | undefined {
  let found: ts.ArrowFunction | ts.FunctionExpression | undefined;
  const unwrap = (expression: ts.Expression): void => {
    let init: ts.Expression = expression;
    // Unwrap `vi.fn(impl)` down to the implementation it wraps. `vi.fn` is a property
    // access (`vi` . `fn`), NOT a bare identifier, so both shapes must be recognised.
    if (ts.isCallExpression(init)
      && (ts.isIdentifier(init.expression) || ts.isPropertyAccessExpression(init.expression))) {
      const impl = init.arguments[0];
      if (impl && (ts.isArrowFunction(impl) || ts.isFunctionExpression(impl))) init = impl;
    }
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) found = init;
  };
  const names = (left: ts.Node): boolean => {
    if (ts.isPropertyAssignment(left)) return ts.isIdentifier(left.name) && left.name.text === seam;
    if (ts.isPropertyAccessExpression(left)) return left.name.text === seam;
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAssignment(node) && names(node)) {
      unwrap(node.initializer);
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && names(node.left)) {
      unwrap(node.right);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** Names of every identifier the implementation invokes as a call. */
function calledIdentifiers(fn: ts.ArrowFunction | ts.FunctionExpression): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) names.add(node.expression.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return names;
}

/** Every parameter name declared by the implementation, positionally. */
function parameterNames(fn: ts.ArrowFunction | ts.FunctionExpression): string[] {
  return fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : p.name.getText(fn)));
}

/** True when the body contains a conditional whose test consults `name`. */
function branchesOn(fn: ts.ArrowFunction | ts.FunctionExpression, name: string): boolean {
  let found = false;
  const test = (node: ts.Node): boolean => {
    let hit = false;
    const inner = (child: ts.Node): void => {
      if (hit) return;
      if (ts.isIdentifier(child) && child.text === name) hit = true;
      else ts.forEachChild(child, inner);
    };
    inner(node);
    return hit;
  };
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIfStatement(node) && test(node.expression)) found = true;
    else if (ts.isConditionalExpression(node) && test(node.condition)) found = true;
    else if (ts.isReturnStatement(node) && node.expression && test(node.expression)) found = true;
    else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken
      && ts.isCallExpression(node.operand) && ts.isIdentifier(node.operand.expression)
      && node.operand.expression.text === name) found = true;
    else ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return found;
}

/** True when the body assigns, merges, or spreads a value into a live row. */
function persistsPatch(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // `Object.assign(row, patch)` is a PROPERTY ACCESS call, not a bare identifier call.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = node.expression.expression;
      const member = node.expression.name.text;
      if (ts.isIdentifier(owner) && member === "assign" && owner.text === "Object") found = true;
      else if (["applyPatch", "assignPatch", "updateTask", "save", "patch"].includes(member)) found = true;
    }
    if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) found = true;
    // A rest-parameter double indexes its own arguments (`args[2]`); a property write
    // through that element access is the patch being persisted.
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
      && node.argumentExpression && ts.isNumericLiteral(node.argumentExpression)) found = true;
    if (found) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return found;
}

/** The defect list for one seam: empty when the double models the product's contract. */
function inspectSeam(tree: ts.SourceFile, seam: string): SeamDefect[] {
  const impl = seamImplementation(tree, seam);
  if (!impl) return [{ seam, defect: `does not implement ${seam}` }];
  const params = parameterNames(impl);
  const calls = calledIdentifiers(impl);
  // A rest-parameter double (`(...args) => ...`) receives the same contract positionally and
  // recovers the callback from `args[n]`. Resolve that binding so the check below is the
  // same predicate-fencing question, not a different one about parameter syntax.
  const rest = impl.parameters.find((p) => p.dotDotDotToken);
  const callbackAt = (index: number): string | undefined => {
    if (rest && ts.isIdentifier(rest.name)) return undefined; // handled by the indexed path
    return params[index];
  };
  const indexedCallback = (index: number): string | undefined => {
    if (!rest || !ts.isIdentifier(rest.name)) return undefined;
    const binding = rest.name.text;
    let recovered: string | undefined;
    const visit = (node: ts.Node): void => {
      if (recovered) return;
      // `const predicate = args[2] as (...)` — recover the local the callback is bound to.
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        let target: ts.Node = node.initializer;
        if (ts.isAsExpression(target)) target = target.expression;
        if (ts.isElementAccessExpression(target) && ts.isIdentifier(target.expression)
          && target.expression.text === binding && target.argumentExpression
          && ts.isNumericLiteral(target.argumentExpression)
          && target.argumentExpression.text === String(index)) {
          recovered = node.name.text;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(impl, visit);
    return recovered;
  };
  if (seam === PREDICATE_FENCED_MOVE) {
    // The product's contract: the third argument is a predicate, it is INVOKED, and the
    // implementation's own verdict is gated on the result.
    const predicate = rest ? indexedCallback(2) : callbackAt(2);
    if (!predicate) return [{ seam, defect: `${seam} takes no predicate argument` }];
    if (!calls.has(predicate)) {
      return [{ seam, defect: `${seam} never invokes its ${predicate} predicate` }];
    }
    if (!branchesOn(impl, predicate)) {
      return [{ seam, defect: `${seam} invokes ${predicate} but does not branch on the verdict` }];
    }
    return [];
  }
  // Atomic reducer: the second argument is a mutator, and the patch it returns is persisted.
  const mutator = rest ? indexedCallback(1) : callbackAt(1);
  if (!mutator) return [{ seam, defect: `${seam} takes no mutator argument` }];
  if (!calls.has(mutator)) {
    return [{ seam, defect: `${seam} never invokes its ${mutator} mutator` }];
  }
  if (!persistsPatch(impl)) {
    return [{ seam, defect: `${seam} discards the patch ${mutator} returns` }];
  }
  return [];
}

const files = readTestFiles();
const finalizationFixtures = files.filter((file) => file.source.includes(FINALIZATION_ENTRY));

describe("merge finalization store doubles model the product's write contracts", () => {
  it("finds the finalization fixtures it is meant to police", () => {
    // A silently-empty scan would make every assertion below vacuously true.
    expect(finalizationFixtures.length).toBeGreaterThan(0);
  });

  it.each(finalizationFixtures.map((file) => [file.relative, file] as const))(
    "%s models the predicate-fenced terminal move and the atomic reducer write",
    (_name, file) => {
      if (file.source.includes(EXEMPTION_MARKER)) {
        const marker = file.source.slice(file.source.indexOf(EXEMPTION_MARKER));
        const reason = marker.split("\n")[0]!.replace(EXEMPTION_MARKER, "").trim();
        expect(reason.length, `${file.relative} carries a bare ${EXEMPTION_MARKER} with no reason`).toBeGreaterThan(0);
        return;
      }
      const defects = [
        ...inspectSeam(file.tree, PREDICATE_FENCED_MOVE),
        ...inspectSeam(file.tree, ATOMIC_REDUCER_WRITE),
      ];
      expect(
        defects.map((d) => d.defect),
        `${file.relative} drives ${FINALIZATION_ENTRY} but its store double does not model the `
        + `product's write contracts. A missing seam throws mid-finalization and abandons a landed `
        + `card; a seam that ignores its predicate or mutator records work the product never `
        + `performed. Add the seam, or record a ${EXEMPTION_MARKER} comment naming the reason.`,
      ).toEqual([]);
    },
  );
});
