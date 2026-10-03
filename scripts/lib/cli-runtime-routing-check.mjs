/*
FNXC:CliRuntimeRouting 2026-08-15-13:51:
The dashboard owns picker admission and engine deliberately cannot import it.
Parse the explicit `<set>.add(...)` forms instead, so a new selectable provider
cannot become executable only through pi by accident.
Unrecognised syntax is a violation: this guard must fail closed, not quietly
skip a catalog form it no longer understands.

FNXC:CliRuntimeRouting 2026-09-30-20:05:
FUSI-024 moved provider admission out of the dashboard route into the shared core gate
(`discoverConfiguredProviders` / `addToggleConfiguredProviders`), so the toggle/custom-provider
`add` call sites now live in packages/core/src/ai/configured-provider-discovery.ts and the
picker-id constants it references live in the dashboard model-cache modules. This guard now reads
BOTH the route and that core module; the set name it recognizes is not pinned to
`configuredProviders` (that binding was an artifact of where the code used to live), and every
`add(...)` expression it cannot classify is still a fail-closed violation.
*/

// Admit `<identifier>.add(<expr>)` for the set names the catalog admission gate uses. The set is
// the local `providers` in `addToggleConfiguredProviders`; the credential-discovery sets
// (`oauthProviders`, `apiKeyProviders`, `anonymousProviders`, ...) are NOT catalog admission and
// are excluded by scoping the scan to the admission block (see extractAdmissionBlock below).
const ADD = /\b(?:configuredProviders|providers)\.add\(([^\n;]+)\)/g;
const STRING = /^\s*["']([^"']+)["']\s*$/;
const PICKER = /^\s*([A-Z][A-Z0-9_]*_PICKER_PROVIDER_ID)\s*$/;
const DYNAMIC = /^\s*customProviderRegistryKey\(/;

function censusEntries(source) {
  const entries = [];
  const object = /\{\s*providerId:\s*["']([^"']+)["']([\s\S]*?)\}/g;
  for (const match of source.matchAll(object)) {
    const body = match[2];
    const value = (name) => new RegExp(`${name}:\\s*["']([^"']+)["']`).exec(body)?.[1];
    entries.push({
      providerId: match[1],
      classification: value("classification"),
      autoDerive: value("autoDerive"),
      guardNotApplicable: value("guardNotApplicable"),
      onExplicitHint: value("onExplicitHint"),
      hasBuilder: /missingRuntimeError\s*:/.test(body),
      externalFailFastOwner: value("externalFailFastOwner"),
    });
  }
  return entries;
}

function constantsFromSources(sources) {
  const constants = new Map();
  for (const source of sources) {
    for (const match of source.matchAll(/export const ([A-Z][A-Z0-9_]*_PICKER_PROVIDER_ID)\s*=\s*["']([^"']+)["']\s+as const/g)) {
      constants.set(match[1], match[2]);
    }
  }
  return constants;
}

/**
 * @param {{routeSource:string,censusSource:string,constantSources?:string[],admissionSource?:string}} input
 *   `admissionSource` is the source the gate's `add(...)` call sites are scanned in. It defaults to
 *   `routeSource` so a caller that only knows the route keeps working; the production caller passes
 *   the route PLUS the extracted core admission block (see check-cli-runtime-routing.mjs).
 */
export function checkCliRuntimeRouting(input) {
  const violations = [];
  const constants = constantsFromSources(input.constantSources ?? []);
  const admitted = new Set();
  let calls = 0;
  // FNXC:CliRuntimeRouting 2026-09-30-20:05: FUSI-024 moved the toggle/custom-provider `add` sites
  // into the shared core gate. `admissionSource` is the CONCATENATION of the dashboard route and
  // that core module, so the guard still sees every admission call site wherever it now lives.
  for (const match of (input.admissionSource ?? input.routeSource).matchAll(ADD)) {
    calls += 1;
    const expression = match[1].trim();
    const literal = STRING.exec(expression)?.[1];
    if (literal) { admitted.add(literal); continue; }
    const name = PICKER.exec(expression)?.[1];
    if (name) {
      const provider = constants.get(name);
      if (!provider) violations.push(`could not resolve ${name} to a picker provider string literal`);
      else admitted.add(provider);
      continue;
    }
    if (DYNAMIC.test(expression)) continue;
    violations.push(`unrecognised provider-gate add expression: ${expression}`);
  }
  if (calls === 0) violations.push("zero provider-gate add call sites found");

  const census = censusEntries(input.censusSource);
  if (census.length === 0) violations.push("CLI provider routing census is empty or unparseable");
  const byProvider = new Map(census.map((entry) => [entry.providerId, entry]));
  for (const provider of admitted) {
    if (!byProvider.has(provider)) violations.push(`admitted provider ${provider} has no CLI routing census entry (valid classifications: registry-native, runtime-routed, non-cli, withheld-unsupported)`);
  }
  for (const entry of census) {
    if (!admitted.has(entry.providerId) && entry.classification !== "withheld-unsupported") violations.push(`stale census entry ${entry.providerId} is no longer admitted by the catalog`);
    for (const field of ["autoDerive", "guardNotApplicable", "onExplicitHint"]) {
      if (!entry[field]) violations.push(`census entry ${entry.providerId} is missing ${field} policy`);
    }
    const policies = [entry.autoDerive, entry.guardNotApplicable, entry.onExplicitHint];
    if (policies.includes("fail-fast") && !entry.hasBuilder && !entry.externalFailFastOwner) {
      violations.push(`fail-fast census entry ${entry.providerId} has neither an error builder nor externalFailFastOwner`);
    }
  }
  return violations;
}
