# docs

`docs/` holds technical documentation that explains how to build and operate the system.

Product requirements live in [`../requirements/`](../requirements/).

## Ownership

- Technical design, operations, topology, runbooks, and related infrastructure documentation live here.
- Product behavior and in/out of scope live in [`../requirements/`](../requirements/).

## Documents

| File | Description |
| --- | --- |
| [`directory-structure.md`](directory-structure.md) | Intended MVP TypeScript monorepo layout, including API, browser Worker, CLI, shared package boundaries, and test placement |
| [`local-cloudflare-development.md`](local-cloudflare-development.md) | Local Wrangler workflow using persisted D1, R2, Durable Object, and browser-authentication state |
| [`rate-limiting.md`](rate-limiting.md) | Worker rate-limit policy, monitoring, alerting, tuning, and WAF responsibility |

See [requirements/](../requirements/) for product specifications.
See [`../AGENTS.md`](../AGENTS.md) and [`../.agents/skills/`](../.agents/skills/) for coding agent workflows and guardrails.

## Development Commands

Use `just` recipes as the canonical command surface:

```bash
just install
just ci
just ci-full
just test-e2e
just typecheck
just barestash --help
just dev-api
just dev-api-fresh
just dev-web
just worker-build
just dev-cli
just reset-api-state
just d1-query "SELECT id, mode FROM endpoints LIMIT 5;"
```

Recipes may wrap pnpm scripts internally, but documentation and automation
should prefer the `just` command surface unless a lower-level pnpm command is
being tested directly.

Codex local environment configuration lives in
[`../.codex/environments/environment.toml`](../.codex/environments/environment.toml).
Its setup script runs `just install`, and its configured actions enter the Nix
dev shell before running the same `just` recipes listed above.

## Search Recipes

```bash
rg -n "temporary endpoint|private endpoint|events stream" requirements docs
rg -n "new Hono|app\\.get|app\\.post|/v1|/api/auth" apps/api apps/web packages
rg -n "runCli|barestash|auth|endpoints|events|tokens" apps/cli packages
rg -n "describe\\(|it\\(" apps packages
rg -n "authorization|cookie|x-barestash-secret|token|secret" apps packages requirements docs
```
