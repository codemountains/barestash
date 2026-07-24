# @barestash/api

Barestash API backend: a Cloudflare Worker that receives webhook requests, stashes raw request bodies, and serves events to CLI clients, REST consumers, SSE subscribers, and MCP tools.

## Stack

| Component | Role |
| --- | --- |
| [Cloudflare Workers](https://developers.cloudflare.com/workers/) | HTTP routing, ingest, REST API, auth, scheduled cleanup |
| [Hono](https://hono.dev/) | Application framework and route composition |
| [D1](https://developers.cloudflare.com/d1/) | Endpoint records, event metadata, token records, cursor source of truth |
| [R2](https://developers.cloudflare.com/r2/) | Canonical raw body bytes and request envelope storage |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/) | Endpoint-scoped live SSE subscriber coordination and fan-out |
| [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) | Per-IP, per-endpoint, and per-token abuse controls |

D1 stores metadata only. R2 stores canonical raw request data. Durable Objects coordinate live streams; they are not the source of truth for event history or cursors.

## Quick Start

From the repository root:

```bash
just dev-api
```

This applies local D1 migrations and starts Wrangler at `http://localhost:8787` with persisted Miniflare state under `apps/api/.wrangler/state`.

Reset local D1, R2, and Durable Object state:

```bash
just reset-api-state
```

For a full local capture workflow, see [`docs/local-cloudflare-development.md`](../../docs/local-cloudflare-development.md).

## Package Scripts

Run from the repository root with `pnpm --filter @barestash/api <script>`, or from `apps/api` with `pnpm <script>`:

| Script | Description |
| --- | --- |
| `dev` | Apply local D1 migrations, then start `wrangler dev` with persisted state |
| `db:migrate:local` | Apply D1 migrations to the local persistence directory |
| `test` | Run package tests with Vitest |
| `typecheck` | Run TypeScript type checking |

Repository-wide checks:

```bash
just check
just test
just typecheck
```

## HTTP Surface

| Route group | Path | Purpose |
| --- | --- | --- |
| Health | `/health` | Liveness check |
| Ingest | `/{endpoint_id}` and `/{endpoint_id}/{*path}` | Webhook intake |
| REST API | `/v1/...` | Device Authorization, current account, endpoints, events, scoped PATs, and secrets |
| SSE | `/v1/endpoints/{endpoint_id}/events/stream` | Real-time event delivery |
| MCP | `/mcp` | Agent-facing tools |

Local development serves ingest on the same Worker origin as the REST API.

Authoritative API contracts live in:

- [`requirements/barestash-backend.spec.md`](../../requirements/barestash-backend.spec.md)
- [`requirements/barestash-cli-design.spec.md`](../../requirements/barestash-cli-design.spec.md)

## Project Layout

```text
apps/api/
├── src/
│   ├── worker.ts             # Worker fetch/scheduled entry and Durable Object
│   ├── app.ts                # Hono app composition
│   ├── container.ts          # Bindings and dependency wiring
│   ├── domain/               # Models, ports, and pure helpers
│   ├── application/          # Auth, ingest, endpoints, events, tokens, cleanup
│   ├── presentation/         # Route handlers and HTTP mapping
│   ├── infrastructure/       # D1/R2/DO production and in-memory test adapters
│   └── testing/              # Test-only app composition and shared fixtures
├── migrations/               # D1 schema migrations
├── cutovers/                 # Idempotent post-deploy data cutover finalizers
├── wrangler.toml             # Worker bindings and local development config
└── package.json
```

Route modules live under `src/presentation/routes/`:

- `health.ts`
- `account.ts`
- `device-authorization.ts`
- `ingest.ts`
- `endpoints.ts`
- `events.ts`
- `tokens.ts`
- `mcp.ts`

## Local Configuration

`wrangler.toml` defines the Worker bindings used for local development and
Worker bundling:

- `DB` — D1 database `barestash`
- `REQUEST_BODIES` — R2 bucket `barestash-request-bodies`
- `ENDPOINT_STREAMS` — Durable Object class `EndpointStream`
- ten Rate Limiting bindings documented in
  [`docs/rate-limiting.md`](../../docs/rate-limiting.md)
- `BARESTASH_APP_ORIGIN` — optional browser Worker origin used to build Device
  Authorization verification URLs; creation returns
  `503 device_authorization_unavailable` when it is absent

`DB`, `REQUEST_BODIES`, `ENDPOINT_STREAMS`, `BARESTASH_CREDENTIAL_PEPPER`, and
all Rate Limiting bindings are required by the default Worker application. If
any required binding is missing, every HTTP route returns a structured 500
response and the Worker logs a `barestash.configuration.invalid` diagnostic
naming the missing bindings. The API does not fall back to volatile storage or
unthrottled request processing.

Local state persists under `.wrangler/state` (gitignored). Restarting `just dev-api` reuses that directory so captured endpoints, event metadata, and raw bodies survive process restarts.

If migration files change incompatibly with existing local history, reset state before restarting:

```bash
just dev-api-fresh
```

`wrangler.toml`, migrations, and cutover files provide the inputs for Worker
builds and deployment automation.

## Testing

Package tests use Vitest with in-memory repository adapters and focused route
coverage. Test applications use the test-only `createTestApiApp()` composition
root; the production `createApiApp()` remains fail-closed.

```bash
pnpm --filter @barestash/api test
```

When changing backend behavior, prefer focused package tests first, then broader repository checks with `just check`.

## Related Documentation

| Document | Description |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | Backend development guide for coding agents |
| [`docs/local-cloudflare-development.md`](../../docs/local-cloudflare-development.md) | Local Wrangler workflow, D1/R2 inspection, and smoke tests |
| [`docs/directory-structure.md`](../../docs/directory-structure.md) | Monorepo layout and layer responsibilities |
| [`docs/rate-limiting.md`](../../docs/rate-limiting.md) | Rate-limit operations, monitoring, and alerting |
| [`requirements/barestash-authentication-authorization.spec.md`](../../requirements/barestash-authentication-authorization.spec.md) | Principal, scoped PAT, and current-account contracts |
| [`requirements/barestash-backend.spec.md`](../../requirements/barestash-backend.spec.md) | Backend design, storage model, and API contracts |
