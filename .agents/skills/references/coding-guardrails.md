# Barestash Coding Guardrails

These guardrails are shared by Barestash coding agents, reviewers, and implementers. If `README.md`, `requirements/`, `docs/`, `AGENTS.md`, and the implementation disagree, do not silently choose one source. State the mismatch and resolve the direction before normalizing it.

## Source Of Truth

1. `requirements/barestash.spec.md`: product concept, scope, MVP, positioning, and design principles
2. `requirements/barestash-authentication-authorization.spec.md`: identity, authentication, authorization, sessions, token security, scopes, and revocation
3. `requirements/barestash-cli-design.spec.md`: CLI commands, endpoint and event workflows, credential discovery UX, output, and error presentation
4. `docs/README.md`: technical documentation ownership
5. `README.md`: project overview
6. Current implementation: code, tests, configuration, scripts, and runtime assets
7. `.agents/skills/` and `.codex/agents/`: agent workflows, review workflows, and verification guidance

## Product Boundary

- Barestash is a headless request stash that receives incoming HTTP requests and webhooks, stores raw requests, and makes events available to CLI, API, SSE, and AI-agent consumers.
- Prioritize CLI-first, API-first, and agent-readable workflows over dashboard-first workflows.
- The MVP centers on endpoint creation, incoming request intake, raw request storage, event streaming, and latest/specific event fetches.
- Do not make Barestash provider-specific. It should handle generic HTTP requests from Stripe, GitHub, Slack, CMS products, custom systems, and similar sources.
- Do not assume a language, database, cloud provider, deployment topology, or UI framework until the requirements or implementation establish one.

## Architecture

- Prefer a headless core. A UI may exist, but it must not become required for the primary workflow unless requirements change.
- API, CLI, and streaming interfaces should share the same product contract.
- Keep endpoint, event, token, auth, and local config responsibilities distinct.
- Preserve raw requests while also providing consumer-friendly event shapes.
- Choose the smallest implementation boundary that satisfies requirements and command design. Avoid broad rewrites and premature abstractions.

## Data And API Contracts

- Preserve incoming request method, path, query, headers, body, timestamp, content type, request size, source metadata, and delivery context as faithfully as practical.
- Treat `events stream` as a machine-consumer and AI-agent surface that emits JSON Lines / NDJSON.
- Do not mix human-readable output with machine-readable output. JSON and JSONL must follow explicit flags or command contracts.
- Keep endpoint selection precedence, token discovery precedence, and local config paths aligned with command design.
- Token secrets should be shown only at creation time. They must not appear in list/status output, logs, or errors.
- Raw payloads and headers may contain secrets. Minimize exposure in logs, tracing, error responses, test fixtures, and documentation examples.

## Security And Artifacts

- Do not commit `.env`, tokens, credentials, private endpoints, captured raw payloads, or user data.
- Do not leak secrets or excessive raw request data in logs, errors, or telemetry.
- For endpoint deletion, token revocation, event deletion, storage cleanup, and remote mutation, confirm user-visible impact before implementing or executing the action.
- Do not commit generated artifacts, caches, coverage output, large fixtures, or captured request samples unless they are intentionally reviewed and necessary.

## Verification

Discover and run verification commands that actually exist in the repository.

- If manifests, package manager config, test files, scripts, or CI config exist, use them to choose focused checks and broader checks.
- For code, config, or script behavior changes, add or update focused tests first whenever the stack supports tests.
- For documentation-only changes, check links, paths, source-of-truth references, stale references, and language policy.
- If the repository has no relevant runnable command, state that fact and the unverified risk in the final response or PR description.
- If a check cannot be run, report the reason, any substitute validation, and residual risk in the final response or PR description.

## Baseline Workflow

- Before work, run `git status --short --branch` and avoid damaging existing uncommitted changes.
- Never revert changes that may have been made by the user. Work with them when relevant.
- Before implementation, inspect the source of truth and relevant code, tests, and configuration.
- Keep changes scoped to the task. Avoid unrelated refactors, format churn, and metadata churn.
- Create branches or pull requests only when the user asks.

## Commit And Pull Request

- Before committing, review `git diff` and ensure unrelated changes are not included.
- Prefer Conventional Commits for commit messages.
- Do not add unnecessary source or tool prefixes to PR titles, such as `[codex]`, unless the user explicitly asks for one.
- PR descriptions should include context, changes, verification results, and unverified risk.
- If requirements, docs, APIs, CLI commands, event schemas, or auth/token behavior changed, mention the affected files or contracts.
- When updating an existing PR, push to the same PR rather than creating a new one.

Recommended branch naming:

```text
feature/<short-topic>
fix/<short-topic>
docs/<short-topic>
chore/<short-topic>
```

## Documentation Ownership

- Product concept, scope, MVP, positioning, and design principles: `requirements/barestash.spec.md`
- Identity, authentication, authorization, sessions, token security, scopes, and revocation: `requirements/barestash-authentication-authorization.spec.md`
- CLI commands, endpoints, events, credential discovery UX, output, and error presentation: `requirements/barestash-cli-design.spec.md`
- Technical design, operations, topology, and runbooks: `docs/`
- Project overview: `README.md`
- Coding-agent workflows, review workflows, and verification guardrails: `.agents/skills/` and `.codex/agents/`
