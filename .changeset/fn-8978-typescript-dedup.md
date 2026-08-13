---
"@runfusion/fusion": patch
---

summary: Clean up the published CLI manifest so TypeScript is declared once as a runtime dependency.
category: internal
dev: Removed the duplicate `typescript` devDependencies entry from packages/cli/package.json (the runtime `dependencies` entry required by the tsup `external` list is unchanged) and regenerated pnpm-lock.yaml.
