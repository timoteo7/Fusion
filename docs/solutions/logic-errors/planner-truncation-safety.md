---
category: logic-errors
module: "@fusion/engine"
date: 2026-10-03
problem_type: planner_recovery
component: planning
severity: high
applies_when:
  - "A planner repeatedly receives truncated tool arguments"
  - "A plan reaches review without parseable implementation steps"
tags:
  - planning
  - model-registry
  - output-truncation
---

# Planner truncation and incomplete plans

## Symptoms and cause

A requested model absent from the runtime registry used to inherit the first
model for its provider. Changing only its name and ID also copied unrelated
transport, output capacity, and reasoning metadata. A provider being known is
not evidence that those properties match an unknown model.

Pi correctly refuses tool calls from a response whose stop reason is `length`.
Repeated retries can still consume the entire planning session. A shorter draft
is not necessarily complete: a plan containing `STEPS_GO_HERE` and no executable
steps must not reach review or execution.

## Safeguards

- Registered model definitions stay first. Missing OpenRouter selections load
  exact, validated metadata from the official public catalog automatically.
  Context and output ceilings stay distinct. Reasoning comes from published
  capabilities, including mandatory reasoning and supported effort levels.
  Discovery is credential-free, bounded and single-flight. Successful metadata
  has a five-minute cache; late timed-out fetches cannot publish it.
- Custom endpoints, original model definitions, headers, credential routing and
  explicit OpenRouter routing policy are preserved. Unsupported selections still
  fail clearly, without borrowing another model's metadata.
- A missing optional fallback warns and is disabled for that session rather than
  blocking a valid primary. If neither primary nor fallback resolves, startup
  fails. Known configured fallbacks retain their behavior.
- Each live Pi prompt has a fixed budget of three truncated assistant responses.
  The first two request smaller, complete outputs without dropping required
  sections. Exhaustion requests abort and reports an error only after the native
  prompt and its callbacks settle. A final truncated response is never successful
  output. This bounds output retries, not the wall time of an extension that
  ignores cancellation; such a session must remain owned until it settles.
- Generated-plan validation checks the workflow's existing implementation-step
  requirement before handoff, using the same step-heading parser as execution.
  Explicit duplicate redirects and declared no-commit plans retain their
  existing exceptions. Invalid plans use the existing bounded planning-recovery
  policy; the execution parser and review gates remain unchanged.
- An invalid rewrite restores the prior complete plan through the existing
  authoritative writer and database mirror, only while the same planning
  generation and stage still own the task. Restoration does not authorize a
  handoff or bypass review.

## Operator action

OpenRouter models such as `stealth/space-bunny-alpha` do not require manual
registration when the official catalog supplies complete metadata. Custom
endpoints and other providers still need their exact supported definitions,
such as in `~/.fusion/agent/models.json`. An unknown-ID `modelOverrides` entry
alone does not add a model. Catalog capability is not an execution account's
availability or a request's actual output budget.

Do not guess an output budget from the context window, copy another model's
limits, lower `max_tokens` blindly, or bypass review to release an incomplete
plan. Correct metadata and smaller targeted edits address different problems.
Definitions take effect when a new session is created.
