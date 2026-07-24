---
name: code-review
description: Review Barestash code changes for correctness, architecture fit, security, data handling, tests, documentation impact, and operational risk. Use when the user asks for code review, PR review, owner review, maintainer review, final approval review, risk-focused review, or pre-commit review in this repository.
---

# Code Review

## Overview

Review Barestash changes as a coding agent or maintainer. Prioritize correctness, architecture fit, data handling, security, verification, and operational risk. Prefer findings about real bugs, regressions, scope drift, missing verification, and docs drift over style preferences.

Shared guardrails live in `../references/coding-guardrails.md`.

## Inputs and Outputs

Inputs:

- Diff, branch, PR, commit, or files to review.
- Relevant requirements, docs, tests, and verification evidence.
- User-provided review scope, severity bar, or specific concerns.

Outputs:

- Findings first, ordered by severity, with file and line references whenever possible.
- Open questions or assumptions that affect review confidence.
- Brief summary and remaining test / manual verification gaps.

## Review Workflow

1. Establish the review target.
   - Inspect changed files, diff, PR context, and user-provided scope.
   - Before reading `git diff` or PR diff, treat existing uncommitted changes as user changes and keep unrelated changes out of the review scope.
   - Inspect relevant requirements, docs, tests, and configuration before judging behavior.

2. Review correctness and architecture fit.
   - Check whether the implementation matches requested behavior, requirements, and acceptance criteria.
   - Check that endpoint, event, token, auth, local config, and streaming responsibilities are not mixed together inappropriately.
   - Check that CLI command contracts, event shape, auth/token precedence, and environment variable contracts are not broken.

3. Review security and data handling.
   - Check that raw HTTP request preservation is not weakened.
   - Check that raw payloads, headers, tokens, credentials, and private endpoints are not leaked through commits, logs, or error responses.
   - Check secret redaction, access control, unsafe mutation confirmation, and excessive raw data exposure.

4. Review tests and verification.
   - Expect focused tests for request preservation, event shape, CLI output, auth/token behavior, streaming behavior, and parameter validation.
   - For config, scripts, and runtime wiring changes, expect equivalent validation using commands that exist in the repository.
   - Check whether executed and skipped checks match the risk of the change.

5. Review documentation impact.
   - If public APIs, CLI command behavior, event schema, auth/token behavior, environment variables, or runtime commands changed, check whether README / requirements / docs need updates.
   - Even for docs-only changes, check for drift from implementation, config, and scripts.

6. Review maintainability and scope.
   - Flag broad refactors, new frameworks, and premature abstractions that exceed the requested boundary.
   - Check whether error handling, idempotency, partial failure handling, and observability match the risk of request intake, event delivery, and CLI workflows.
   - Only make style comments when they affect correctness, maintenance, readability, or future defect risk.

## Output Format

Start with findings, ordered by severity. Use file and line references whenever possible.

Use this structure:

- Findings
- Open Questions or Assumptions
- Brief Summary

If there are no blocking findings, say so clearly. Include remaining test / manual verification gaps when relevant.

## Severity Guidance

- Blocker: likely broken core behavior, credential or token leak, data loss, private endpoint exposure, unsafe remote mutation, or impossible validation path.
- High: requirements mismatch, raw request corruption risk, auth/token regression, streaming contract breakage, missing tests for risky deterministic logic, or docs and implementation conflict that misleads users.
- Medium: maintainability, observability, verification, performance, or scope drift gaps that could cause near-term failure.
- Low: clarity, small cleanup, or minor docs/test improvements that matter but should not block merge on their own.

Do not pad the review with non-actionable comments. Tie each finding to a concrete failure mode and the smallest useful fix.

## Trigger Evaluation

Typical trigger phrases:

- "review this PR"
- "review this diff as owner"
- "check for bugs / risks before merge"
- "review whether this fits the architecture"
- "do a pre-commit review"
