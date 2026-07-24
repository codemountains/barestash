---
name: tdd-implement
description: Implement, fix, or refactor Barestash code with a test-driven workflow as the default. Use for feature work, bug fixes, refactors, and regression-test additions that change code, tests, configuration, scripts, or runtime behavior. Do not use for documentation-only changes to requirements, docs, AGENTS.md, README, or other prose-only files.
---

# TDD Implement

## Overview

Barestash implementation, fixes, and refactors should use focused test-first work by default. First inspect requirements, docs, and existing code to define the expected behavior and failure mode. Then add or update a test, confirm it fails for the intended reason, and make the smallest production change needed to pass.

Shared guardrails live in `../references/coding-guardrails.md`.

## Out Of Scope

These changes do not require TDD or failing tests:

- Documentation-only edits to `requirements/`, `docs/`, `AGENTS.md`, `README`, or other prose-only files
- Typo fixes, link fixes, or wording updates that do not change runtime behavior
- Docs review or docs update work that belongs in `$docs-staleness-review` or a normal documentation workflow

When code and docs change in the same task, use this skill for the code change and treat docs updates as accompanying changes. Write tests for code, config, or script behavior first, not for prose edits.

## Inputs and Outputs

Inputs:

- User request describing the behavior to implement or fix.
- Relevant requirements, docs, existing code, test files, and configuration.
- Test runner, scripts, and manual validation workflow discovered from the repository.

Outputs:

- When the stack supports tests, a narrow code change backed by a focused failing-then-passing test.
- Verification results listing focused checks, broader repository checks, and skipped checks.
- Manual validation that could not be run locally or remotely, plus residual risk.

## Workflow

1. Inspect the repository before choosing tools.
   - Run `git status --short --branch` and avoid damaging unrelated user changes.
   - Read relevant `README.md`, `requirements/`, `docs/`, nearby implementation, existing tests, and configuration.
   - Check whether the change affects manifests, scripts, CI config, environment examples, or runtime configuration.

2. Define the narrow behavior under test.
   - Before editing, briefly define expected behavior, inputs, outputs, failure mode, and acceptance criteria.
   - Prefer focused unit tests for deterministic logic.
   - When external services, remote state, or persistent storage are involved, choose the smallest boundary that can be validated with fixtures, local adapters, contract tests, or validation commands.

3. Write the failing test first.
   - Add or update a test that represents the requested behavior.
   - Run the focused test and confirm it fails for the intended reason.
   - If the test already passes before implementation, check whether the behavior already exists and report that result when appropriate.

4. Implement the necessary and sufficient production change.
   - Follow the product boundary, data/API contracts, and security rules in `../references/coding-guardrails.md`.
   - If public APIs, CLI command behavior, event schema, auth/token behavior, environment variables, or runtime commands change, check documentation impact at the same time.

5. Refactor only after green.
   - Re-run the focused test and confirm it passes.
   - Limit refactors to the changed area or necessary local duplication.
   - Avoid unrelated cleanup, metadata churn, broad renames, and unrequested abstractions.

6. Run verification.
   - Run focused checks for the changed component.
   - Select commands from repository manifests, scripts, test runners, and CI config according to the change scope.
   - Report commands that could not be run and the remaining risk.

## Test Targets

Prioritize focused tests according to the change type:

- Request intake: preservation of method, path, query, headers, body, content type, size, and timestamp.
- Event model: event metadata, request metadata, JSON / JSONL response shape, cursor behavior, and ordering behavior.
- CLI behavior: resource/action commands, human output, machine-readable output, exit status, and actionable error messages.
- Auth and token behavior: token discovery precedence, one-time secret display, revocation, and local config handling.
- Streaming behavior: polling / SSE contract, reconnect / cursor behavior, duplicate prevention, and output under backpressure.
- Security: secret redaction, raw payload exposure control, private endpoint access, and confirmation for unsafe mutations.

## Trigger Evaluation

Typical trigger phrases:

- "implement this"
- "fix this bug"
- "refactor this"
- "implement with TDD"
- "write a failing test first"
- "use red-green-refactor"
- "add a regression test and fix it"

Typical non-trigger phrases:

- "update the docs"
- "fix the README"
- "write requirements"
- "edit the documentation wording"
