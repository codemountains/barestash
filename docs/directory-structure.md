# Directory Structure

This document defines the intended directory structure for the Barestash MVP
implementation.

Barestash is an All TypeScript project. The backend uses Hono on Cloudflare
Workers, with Durable Objects, D1, and R2 as defined in
[`../requirements/barestash-backend.spec.md`](../requirements/barestash-backend.spec.md).

This document is a project convention for implementation work. It describes the
target MVP structure, not only the files that exist today.

## Source Of Truth

- Product concept, scope, and MVP boundaries:
  [`../requirements/barestash.spec.md`](../requirements/barestash.spec.md)
- CLI command design, output behavior, auth, tokens, endpoints, and events:
  [`../requirements/barestash-cli-design.spec.md`](../requirements/barestash-cli-design.spec.md)
- Identity, browser authentication, authorization, sessions, and token security:
  [`../requirements/barestash-authentication-authorization.spec.md`](../requirements/barestash-authentication-authorization.spec.md)
- Backend design, storage model, ingest flow, REST/SSE API, auth, and MCP scope:
  [`../requirements/barestash-backend.spec.md`](../requirements/barestash-backend.spec.md)
- Technical documentation ownership:
  [`README.md`](README.md)

If this document conflicts with the requirements, resolve the requirements first
and update this document afterward.

## Root Layout

```text
.
├── apps/
│   ├── api/
│   ├── cli/
│   └── web/
├── packages/
│   └── shared/
├── docs/
├── requirements/
├── .agents/
├── .codex/
├── pnpm-workspace.yaml
├── package.json
├── flake.nix
└── flake.lock
```

## Top-Level Directories

| Path | Responsibility |
| --- | --- |
| `apps/api/` | Hono Cloudflare Worker backend for ingest, REST API, SSE, Durable Objects, D1/R2 access, scheduled cleanup, and MCP. |
| `apps/cli/` | TypeScript CLI for `auth`, `endpoints`, `events`, and `tokens` commands. |
| `apps/web/` | Independent Hono Cloudflare Worker at `app.{domain}` for Better Auth routes, GitHub/Google OAuth callbacks, browser sessions, and browser-to-domain-account provisioning. |
| `packages/shared/` | Shared API contracts and cross-runtime TypeScript utilities used by `apps/api`, `apps/cli`, and `apps/web`. |
| `docs/` | Technical design, operations, topology, runbooks, and implementation conventions. |
| `requirements/` | Product behavior, MVP scope, backend requirements, and CLI requirements. |
| `.agents/` | Repository-specific agent skills and guardrails. |
| `.codex/` | Codex subagent definitions and local agent configuration. |

The project should use pnpm workspaces for TypeScript package management.

## Module Boundary Convention

Source modules use explicit, same-name entry files rather than barrels:

- Do not create source `index.*` files or aggregate re-export modules.
- Use `feature.ts` as the public entry and `feature/` for private implementation
  files when a feature needs more than one file.
- Only `feature.ts` may import `feature/*`; private implementation files must not
  import their owning entry.
- Import symbols from the file or package subpath that owns them. Do not
  re-export imported symbols as compatibility aliases.
- Use named exports. Default exports are limited to Cloudflare Worker runtime
  entries and Vitest configuration files.
- Mark exports intentionally consumed from outside their directory with
  `@public`. Biome treats other exports as package-visible.

Biome enforces `noBarrelFile`, `noDefaultExport`, `noExportedImports`, and
`noPrivateImports`. Source filenames and one-directional module ownership remain
documented review constraints.

## API App

`apps/api/` owns the Cloudflare Workers backend.

```text
apps/api/
├── src/
│   ├── worker.ts
│   ├── app.ts
│   ├── container.ts
│   ├── domain/
│   ├── application/
│   ├── presentation/
│   ├── infrastructure/
│   └── testing/
├── migrations/
├── cutovers/
├── wrangler.toml
└── package.json
```

Responsibilities:

- Compose the Hono app in `src/app.ts` and the Cloudflare Worker runtime,
  scheduled cleanup handler, and `EndpointStream` Durable Object in
  `src/worker.ts`.
- Serve versioned REST API routes under `/v1`.
- Serve ingest routes for `/{endpoint_id}` and `/{endpoint_id}/{*path}`.
- Serve SSE event streams for endpoint subscribers.
- Keep idempotent post-deploy data cutover finalizers in `cutovers/`; schema
  migrations that must run before Worker deployment remain in `migrations/`.
- Expose the MVP MCP endpoint under `/mcp`.
- Coordinate live event fan-out through Durable Objects.
- Store event metadata and indexes in D1.
- Store raw request bodies and request envelopes in R2.
- Keep Worker runtime code, D1 migration and cutover files, and local Wrangler
  setup inside `apps/api/`.

Internal layout uses a four-layer architecture:

| Layer | Path | Responsibility |
| --- | --- | --- |
| Presentation | `src/presentation/` | Hono route modules, request parsing, and HTTP response mapping. |
| Application | `src/application/` | Use-case orchestration for auth, tokens, endpoints, events, ingest, and SSE. |
| Domain | `src/domain/` | Core models, repository ports, and pure domain helpers. |
| Infrastructure | `src/infrastructure/` | D1/R2/Durable Object production adapters, in-memory test adapters, and event-stream coordination. |

Supporting files:

| Path | Responsibility |
| --- | --- |
| `src/worker.ts` | Cloudflare Worker fetch/scheduled entry and `EndpointStream` Durable Object export. |
| `src/app.ts` | `createApiApp()` and route registration. |
| `src/container.ts` | Cloudflare binding and explicitly injected dependency resolution. |
| `src/testing/` | Test-only application composition, shared fixtures, and fakes used by route tests. |

Suggested presentation route layout:

```text
apps/api/src/presentation/routes/
├── health.ts
├── device-authorization.ts
├── tokens.ts
├── endpoints.ts
├── events.ts          # event list/detail/body routes and SSE stream route
└── ingest.ts
```

Suggested infrastructure layout:

```text
apps/api/src/infrastructure/
├── in-memory/          # one repository/store/coordinator per named file
├── d1/                 # one repository per named file
├── r2/
│   └── request-body-store.ts
└── durable-objects/
    └── event-stream-coordinator.ts
```

Durable Objects are a live coordination layer only. D1 remains the source of
truth for event history and cursors. R2 remains the source of truth for raw body
bytes and request envelopes.

## Browser App

`apps/web/` owns the independent browser-authentication Worker deployed at
`app.{domain}`. It supports GitHub and Google sign-in and the Device
Authorization approval/denial UI.

```text
apps/web/
├── public/assets/       # generated CSS and browser JavaScript (not committed)
├── src/
│   ├── browser/          # browser-only TypeScript compiled to static assets
│   └── worker/           # Cloudflare Worker source
│       ├── worker.ts
│       ├── app.tsx
│       ├── auth/
│       ├── application/
│       ├── infrastructure/d1/
│       └── presentation/
├── migrations/
├── tsconfig.browser.json
├── wrangler.toml
└── package.json
```

Responsibilities:

- Serve the GitHub/Google sign-in page and the Better Auth callback/session
  endpoints under `/api/auth/*`; OAuth initiation is exposed only through
  `POST /sign-in/:provider` for the supported providers.
- Render the browser sign-in and Device Authorization flow with Hono JSX,
  Tailwind CSS 4, and daisyUI 5. Wrangler's custom build compiles the
  presentation stylesheet and browser-only TypeScript into ignored
  `public/assets/` output before local development and deployment; static
  assets bypass the Worker while authentication routes remain Worker-first.
- Restrict OAuth callback destinations to the fixed app origin and the `/` or
  `/device` paths without query or fragment data; do not allow open redirects
  or raw user codes in Better Auth state.
- Rate limit OAuth initiation by client IP and fail closed when the binding is
  unavailable.
- Resolve normalized one-time user codes only by HMAC hash, require a Better
  Auth session for approval and denial, and protect both state changes with a
  signed CSRF token bound to the browser session, Device Authorization, and
  expiry.
- Resume `verification_uri_complete` after OAuth with a short-lived encrypted,
  HttpOnly continuation cookie; raw user codes do not enter Better Auth state
  or backend persistence.
- Store Better Auth adapter schema in `apps/web/migrations/`, with a distinct
  migration ledger from Barestash auth-domain migrations in
  `apps/api/migrations/`, even though both Workers share D1.
- Resolve and provision Barestash `accounts`, `identities`, and
  `better_auth_account_mappings` from a stable provider-issued subject. Never
  use email equality for implicit account linking.
- Strip OAuth access, refresh, and ID tokens before Better Auth account records
  are persisted. Provider profile fields needed for account resolution remain
  available without being Barestash credentials.
- Disable Better Auth account linking until the Barestash identity-linking flow
  is implemented; the direct `link-social` and `unlink-account` routes remain
  unavailable as part of that boundary.
- Provision the domain account before persisting a browser session. If D1
  partially creates a Better Auth user without an account, compensate
  immediately; a later sign-in may remove a user older than 60 seconds only
  when a single conditional D1 statement confirms that it still has neither an
  account nor a session.

The browser app uses the same four-layer direction as the API: presentation for
HTTP/UI concerns, application for provisioning orchestration, domain-shaped
ports and records at the application boundary, and D1 adapters under
`src/worker/infrastructure/d1/`.

## CLI App

`apps/cli/` owns the TypeScript command-line client.

```text
apps/cli/
├── src/
│   ├── barestash.ts
│   ├── cli.ts
│   ├── container.ts
│   ├── domain/
│   ├── application/
│   ├── infrastructure/
│   ├── presentation/
│   └── testing/
└── package.json
```

Responsibilities:

- Implement the documented `barestash {resource} {action}` command shape.
- Keep the executable entry and lazy process bootstrap in `src/barestash.ts`;
  define the named `runCli()` API in `src/cli.ts`.
- Keep local credential, token, endpoint, and environment-variable resolution in
  the domain and infrastructure layers.
- Keep table, JSON, and JSONL formatting in `src/presentation/output/`.
- Keep machine-readable output separate from human-readable output.
- Avoid duplicating API contract types that belong in `packages/shared/`.

Internal layout uses a four-layer architecture:

| Layer | Path | Responsibility |
| --- | --- | --- |
| Presentation | `src/presentation/` | Commander program wiring, command registration, and terminal output mapping. |
| Application | `src/application/` | Use-case orchestration for auth, tokens, endpoints, events, and SSE streaming. |
| Domain | `src/domain/` | CLI config model, endpoint selection rules, body transformation, and port types. |
| Infrastructure | `src/infrastructure/` | Fetch API client, local config file store, terminal I/O, and SSE wire helpers. |

Supporting files:

| Path | Responsibility |
| --- | --- |
| `src/barestash.ts` | Executable entry that lazily loads process integration. |
| `src/cli.ts` | `runCli()` composition root and exit-code handling. |
| `src/container.ts` | Dependency resolution and test overrides (`CliOptions`). |
| `src/testing/` | Shared test fixtures and fakes used by command tests. |

Suggested presentation layout:

```text
apps/cli/src/presentation/
├── program.ts
├── commands/
│   ├── auth.ts
│   ├── endpoints.ts
│   ├── events.ts
│   └── tokens.ts
└── output/
    ├── endpoints.ts
    ├── events.ts
    ├── tokens.ts
    ├── errors.ts
    ├── json.ts
    └── format.ts
```

Suggested infrastructure layout:

```text
apps/cli/src/infrastructure/
├── api/
├── config/
├── credentials/
├── browser.ts
├── terminal.ts
└── sse.ts
```

## Shared Package

`packages/shared/` owns code that is genuinely shared by the API, CLI, and
browser Worker.

```text
packages/shared/
├── src/
│   ├── auth.ts
│   ├── auth-audit.ts
│   ├── bearer-tokens.ts
│   ├── endpoint-secrets.ts
│   ├── endpoints.ts
│   ├── errors.ts
│   ├── events.ts
│   ├── headers.ts
│   ├── http.ts
│   ├── ids.ts
│   ├── limits.ts
│   ├── personal-access-tokens.ts
│   └── sse.ts
└── package.json
```

Each file is published only through its matching package subpath (for example,
`@barestash/shared/events`). `@barestash/shared` has no root export. Shared
modules use named exports and contain the declaration they publish rather than
re-exporting it from another file.

Use this package for:

- API request and response contracts.
- Event metadata and stream payload types.
- Error code types that mirror backend API error responses.
- ID helpers and ID prefix conventions.
- Header redaction helpers and shared sensitive-header policy.
- Small serialization helpers needed by API, CLI, and browser Worker code.

Do not use `packages/shared/` as a general utility dump. Runtime-specific code,
Cloudflare bindings, CLI terminal formatting, local config paths, storage
repositories, and route handlers should stay in the app that owns them.

## Tests

Place tests close to the code they verify.

```text
apps/api/src/presentation/routes/ingest.test.ts
apps/api/src/presentation/routes/events.test.ts
apps/api/src/testing/helpers.ts
apps/cli/src/presentation/commands/events.test.ts
apps/cli/src/presentation/commands/event-stream.test.ts
apps/cli/src/infrastructure/api/client.test.ts
apps/cli/src/testing/helpers.ts
apps/web/src/browser/device-code.test.ts
apps/web/src/worker/app.test.ts
apps/web/src/worker/application/provision-account.test.ts
apps/web/src/worker/infrastructure/d1/account-provisioning-repository.test.ts
packages/shared/src/headers.test.ts
packages/shared/src/ids.test.ts
packages/shared/src/contracts.test.ts
packages/shared/src/errors.test.ts
```

Use top-level test directories only when a test intentionally spans packages or
requires a full integration fixture. Prefer package-local tests for normal unit
and behavior coverage.

## Placement Rules

- Put each Cloudflare Worker's runtime code, owned D1 migration files, and
  `wrangler.toml` local-development concerns under that Worker app
  (`apps/api/` or `apps/web/`). Keep the API and Better Auth migration ledgers
  separate even when they target the same D1 database.
- Put terminal interaction, CLI command parsing, output rendering, and local CLI
  configuration under `apps/cli/`.
- Put only stable cross-app contracts and small shared helpers under
  `packages/shared/`.
- Put product behavior and acceptance criteria in `requirements/`, not `docs/`.
- Put implementation conventions, topology, operations, and runbooks in `docs/`.
- Keep examples free of real tokens, endpoint secrets, private endpoint IDs, and
  captured webhook payloads.
