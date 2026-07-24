---
name: docs-staleness-review
description: Review Barestash documentation for stale, contradictory, or drifting guidance. Use when the user asks to review docs, prevent documentation rot, check docs against requirements or implementation, update stale docs, or verify consistency across README, requirements, docs, code, scripts, agent workflows, and AGENTS.md.
---

# Docs Staleness Review

## Overview

Review Barestash documentation as a consistency gate across requirements, implementation, configuration, scripts, and agent workflows. Find stale guidance, contradictions, scope drift, missing boundaries, missing verification guidance, and code-doc drift before they mislead implementers, reviewers, or operators.

Shared guardrails live in `../references/coding-guardrails.md`.

## Inputs and Outputs

Inputs:

- Documentation file, PR, branch, or repository area to review.
- Related `README.md`, requirements, docs, `AGENTS.md` guidance, implementation files, configuration, scripts, and tests.
- User-provided scope, such as full-doc review, PR-doc review, or targeted stale-doc check.

Outputs:

- Actionable staleness findings ordered by severity, with file and line references whenever possible.
- Impact for each stale, contradictory, or incomplete doc statement.
- Minimal recommended documentation updates and remaining review limits.

## Review Workflow

1. Identify the documentation surface.
   - Determine whether the task is a full-doc review, PR-doc review, or targeted stale-doc check.
   - Read relevant requirements, docs, config, scripts, tests, and changed implementation.
   - Even for doc-only changes, check whether accepted behavior, data contracts, operator workflows, or coding-agent workflows are affected.

2. Check requirement consistency.
   - Check consistency with the product boundary: headless request stash, raw request preservation, and CLI / API / SSE / AI-agent workflows.
   - Check that dashboard-first, provider-specific, inspection-only, and undecided-stack assumptions are not presented as current scope.

3. Check technical consistency.
   - Check whether endpoint, event, token, auth, local config, and streaming descriptions match the current repository.
   - Check whether public API, CLI command behavior, environment variables, event schema, and auth/token behavior match the implementation.
   - Check that unimplemented runtime, storage, deployment, or provider details are not documented as existing behavior.

4. Check freshness against implementation.
   - Compare commands, file paths, environment variables, APIs, and generated artifact names against the current repository.
   - Check that command guidance in docs matches actual manifests, scripts, configuration, and CI.
   - Check that implementation directories, configuration files, runtime assets, and test files match the current repository.
   - Flag cases where code adds user-visible behavior, data contracts, operator-visible workflows, environment variables, or manual validation steps without corresponding docs updates.

5. Check verification guidance.
   - Check that docs distinguish automated checks, manual validation, and external side effects.
   - Check that verification guidance matches manifests, scripts, test runners, and CI config that actually exist in the repository.
   - Check that destructive or external actions such as remote mutation, token revocation, endpoint deletion, event deletion, and storage cleanup are handled carefully.

6. Check documentation ownership, links, and language.
   - Check that links between `README.md`, `requirements/`, `docs/`, and `AGENTS.md` resolve and point to the correct source of truth.
   - Repository docs should use English by default unless the user explicitly requests another language. Keep technical terms, commands, file paths, env vars, API paths, package names, and provider names exact.

## Output Format

Start with actionable findings ordered by severity. Each finding should include:

- File and line reference when possible
- Why the current text is stale, contradictory, or incomplete
- Impact on implementers, reviewers, or operators
- Minimal recommended documentation update

After findings, include open questions or assumptions, then a brief summary. If there are no issues, say so clearly and list remaining review limits.

## Freshness Guardrails

- Prefer the smallest doc edits that restore truth over broad rewrites.
- Do not normalize speculative future work into current requirements, architecture, data contracts, or operating instructions.
- Keep command guidance aligned with manifests, scripts, test runners, and CI config that actually exist in the repository.
- Do not leave deploy, destroy, secret, state, or generated artifact handling ambiguous.
- Use English documentation unless the user explicitly asks for another language.

## Trigger Evaluation

Typical trigger phrases:

- "review these docs for staleness"
- "check requirements and docs for contradictions"
- "check for missing docs updates after this implementation change"
- "check consistency between AGENTS.md and README"
- "check consistency between agent workflow and requirements"
