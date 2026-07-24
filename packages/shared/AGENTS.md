# Shared Package Agent Guide

This file applies to `packages/shared/`.

Follow the repository root `AGENTS.md` first. This file adds package-specific
rules for shared contracts and cross-runtime utilities.

## Responsibility

`packages/shared/` owns stable TypeScript contracts and small pure helpers used
by both `apps/api` and `apps/cli`.

Use this package for:

- API request and response contract types.
- Endpoint, event, token, auth, and endpoint-secret response shapes.
- Event metadata and stream payload types.
- REST error code and error response contracts.
- ID prefixes, ID types, ID assertions, and ID generation helpers.
- Header redaction helpers and shared sensitive-header policy.
- Small serialization helpers required by both API and CLI.

Do not use this package as a general utility dump.

Do not put these concerns here:

- Hono routes, Cloudflare Worker bindings, D1, R2, Durable Objects, `wrangler`
  behavior, or scheduled cleanup.
- CLI command parsing, terminal output, local config paths, or credential-store
  behavior.
- API clients, repositories, storage adapters, route handlers, app containers,
  or test fixtures owned by one app.
- Runtime-specific code that only works in Node, Workers, or the terminal unless
  the contract explicitly requires it.

## Source Of Truth

Before changing shared contracts, check the relevant source:

- Product scope: `../../requirements/barestash.spec.md`
- CLI command and output contracts:
  `../../requirements/barestash-cli-design.spec.md`
- Backend/API behavior: `../../requirements/barestash-backend.spec.md`
- Directory and ownership rules: `../../docs/directory-structure.md`
- Shared coding guardrails:
  `../../.agents/skills/references/coding-guardrails.md`

If shared types disagree with requirements, docs, API code, or CLI code, do not
silently normalize one side. State the mismatch and update the correct source of
truth in the same change when appropriate.

## Contract Rules

Shared exports are part of the API/CLI boundary. Treat changes as contract
changes.

- Prefer explicit exported types over inferred cross-package shapes.
- Keep response and event payload names aligned with documented REST/SSE output.
- Do not duplicate shared contracts inside `apps/api` or `apps/cli`.
- Keep machine-readable shapes stable unless the requirements change.
- Preserve one-time secret behavior: token and endpoint secrets may appear in
  creation responses only, never in list/status shapes.
- Header and payload helpers must avoid exposing secrets by default.
- Publish each shared module through a same-name file and a matching explicit
  `package.json` subpath. Do not add a root export, `index.*`, barrel, or
  compatibility re-export.
- Import shared symbols from their owning subpath, such as
  `@barestash/shared/events` or `@barestash/shared/ids`.
- Use named exports and mark cross-package exports with `@public` so Biome can
  reject accidental imports of package-visible implementation details.
- Keep test fixtures local to tests or the owning app; do not publish test
  helpers from this package.

## Runtime Rules

Code in this package must stay portable across the API Worker and the CLI.

- Avoid Node-only APIs unless guarded and required by an explicit contract.
- Avoid Cloudflare-specific APIs in shared code.
- Avoid import-time side effects.
- Prefer pure functions and deterministic test seams.
- For randomness, use Web Crypto-compatible APIs or caller-provided test inputs.
- Keep dependencies minimal; do not add a dependency for small contract helpers
  without a clear cross-package benefit.

## Tests And Verification

Place tests next to the shared code they verify.

For changes in this package, run focused checks when available:

```sh
pnpm --filter @barestash/shared test
pnpm --filter @barestash/shared typecheck
```

If the change affects API or CLI behavior, also run the relevant app tests or the
repository-level check command.

Update tests for:

- New or changed exported contracts.
- ID prefixes, ID validation, and ID generation behavior.
- REST error codes and response shapes.
- Header filtering/redaction policy.
- Serialization helpers used by both API and CLI.

## Data Safety

Do not add real tokens, endpoint secrets, private endpoint IDs, captured webhook
payloads, or user data to tests, fixtures, docs, or examples.

Use synthetic examples only.
