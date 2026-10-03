#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkCliRuntimeRouting } from "./lib/cli-runtime-routing-check.mjs";

/*
FNXC:CliRuntimeRouting 2026-09-30-20:05:
FUSI-024 moved provider admission out of the dashboard route into the shared core gate, so the
`add` call sites this guard traces now live in packages/core/src/ai/configured-provider-discovery.ts.
The route is still read (it is where the gate is invoked). From the core module we take ONLY the
`addToggleConfiguredProviders` body — the catalog-admission block. The credential-discovery sets in
the same file (`oauthProviders`, `apiKeyProviders`, `anonymousProviders`, ...) are deliberately NOT
catalog admission and are excluded by that scoping; including them would flag signal-set inserts as
unrecognised gate forms.
*/
const route = "packages/dashboard/src/routes/register-model-routes.ts";
const coreGate = "packages/core/src/ai/configured-provider-discovery.ts";
const cachesDir = "packages/dashboard/src";
const census = "packages/engine/src/agents/cli-provider-routing.ts";

/** Extract the body of the exported addToggleConfiguredProviders function, braces balanced. */
function extractAdmissionBlock(source) {
  const start = source.indexOf("export function addToggleConfiguredProviders");
  if (start === -1) return "";
  // The body brace is the first `{` AFTER the parameter list's closing `)`. A plain
  // indexOf("{") would land on a `= {}` default parameter instead, truncating the block.
  const paramEnd = source.indexOf(")", start);
  const open = source.indexOf("{", paramEnd);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

try {
  const constantSources = readdirSync(cachesDir)
    .filter((name) => name.endsWith("model-cache.ts"))
    .map((name) => readFileSync(join(cachesDir, name), "utf8"));
  const routeSource = readFileSync(route, "utf8");
  const admissionSource = `${routeSource}\n${extractAdmissionBlock(readFileSync(coreGate, "utf8"))}`;
  const violations = checkCliRuntimeRouting({
    routeSource,
    admissionSource,
    censusSource: readFileSync(census, "utf8"),
    constantSources,
  });
  if (violations.length) {
    console.error("check-cli-runtime-routing: FAILED\n" + violations.map((item) => `- ${item}`).join("\n"));
    process.exit(1);
  }
  console.log("check-cli-runtime-routing: ok");
} catch (error) {
  console.error(`check-cli-runtime-routing: could not inspect required source: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
