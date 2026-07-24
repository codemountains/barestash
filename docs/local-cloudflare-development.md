# Local Cloudflare Development

Use Wrangler's local Cloudflare-compatible runtime for API, ingest, and browser
authentication debugging. The local Workers exercise the same storage boundaries
as the MVP backend:

- D1 stores endpoint records, endpoint secrets, token metadata, event metadata,
  and cursor/query state.
- R2 stores canonical raw request bodies and request envelopes.
- Durable Objects coordinate endpoint-scoped live stream subscribers.
- Rate Limiting bindings exercise the application quotas defined for the
  runtime.
- Better Auth adapter tables and browser sessions share D1 with the API's
  Barestash auth-domain tables, while retaining a separate migration ledger.

Wrangler supplies the required `DB`, `REQUEST_BODIES`, and `ENDPOINT_STREAMS`
bindings for this workflow. Starting the Worker through another entry point
without those bindings fails closed with a structured 500 response. In-memory
storage is available only to application-level tests through the test-only
`createTestApiApp()` composition root.

Wrangler simulates Rate Limiting bindings locally. Requests without
`CF-Connecting-IP`, including direct application-level requests, share the
`unknown` client bucket. Focused tests inject deterministic limiter adapters;
the smoke suite exercises the real Wrangler binding configuration below the
configured thresholds.

## Start The API

From the repository root, copy both local secret templates before starting
either Worker:

```bash
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/web/.dev.vars.example apps/web/.dev.vars
```

Replace the placeholders and set `BARESTASH_CREDENTIAL_PEPPER` to the same
local-only value in both files. The files are ignored by Git and are loaded by
Wrangler only for local development. Do not commit them or reuse them for a
hosted environment. Then start the API:

```bash
just dev-api
```

The API package runs local D1 migrations first, then starts Wrangler with
persisted Miniflare state:

```bash
CI=1 wrangler d1 migrations apply barestash --local --persist-to .wrangler/state --config wrangler.toml
wrangler dev --config wrangler.toml --persist-to .wrangler/state
```

Local state is stored under `apps/api/.wrangler/state`, which is ignored by Git.
Restarting `just dev-api` with the same state directory keeps local D1 and R2
data available across process restarts. Durable Objects still provide local
endpoint-scoped stream coordination, but they are not the source of truth for
event history or cursors. Run `just reset-api-state` to delete that directory
and reset local D1, R2, and Durable Object state.

If D1 migration files change in a way that is not compatible with the existing
local migration history, reset local state before starting the API again:

```bash
just dev-api-fresh
```

Or run the steps separately:

```bash
just reset-api-state
just dev-api
```

## Start The Browser Authentication Worker

The browser Worker shares the API's persisted local D1 state. Start the API at
least once so its auth-domain migrations are present, then use another terminal
for the browser Worker:

```bash
just dev-api
just dev-web
```

`just dev-web` runs the Web Worker's Tailwind CSS 4 + daisyUI 5 stylesheet and
browser TypeScript asset build through Wrangler's custom build hook. Changes
under `apps/web/src/worker/presentation/` or `apps/web/src/browser/` rebuild the
generated files under `apps/web/public/assets/`; those build outputs are
intentionally ignored by Git and do not require a separate CSS watcher. Run
`pnpm --filter @barestash/web build:assets` to build them without starting the
Worker.

`apps/web/.dev.vars` supplies the shared credential pepper,
`BETTER_AUTH_SECRET`, and GitHub and Google OAuth client credentials.
`BETTER_AUTH_SECRET` must contain at least 32 random characters. The browser
Worker applies its Better Auth adapter migration to the same local D1 using the
separate `web_d1_migrations` ledger, uses Wrangler's local
`OAUTH_RATE_LIMITER` binding for OAuth sign-in initiation, then listens at
`http://localhost:8788`.

To verify both authentication color schemes independently of the operating
system setting, add `?theme=light` or `?theme=dark` to any browser-facing page:

```text
http://localhost:8788/?theme=light
http://localhost:8788/device?theme=dark
```

An omitted or unsupported `theme` value leaves the OS color-scheme preference
in control.

For a local GitHub OAuth App, configure the callback URL as:

```text
http://localhost:8788/api/auth/callback/github
```

For a local Google OAuth client, configure the authorized redirect URI as:

```text
http://localhost:8788/api/auth/callback/google
```

The browser Worker provides GitHub and Google sign-in plus the Device
Authorization UI at `http://localhost:8788/device`. The API Worker exposes Device Authorization
creation and polling at `/v1/auth/device/authorizations` and
`/v1/auth/device/token`. Both Workers must use the same
`BARESTASH_CREDENTIAL_PEPPER` because the API stores only the HMAC of device
and user codes while the browser Worker performs user-code lookup.

When `verification_uri_complete` is opened without an existing browser
session, the browser Worker resumes the approval after OAuth sign-in using a
short-lived encrypted HttpOnly continuation cookie. It does not place the raw
user code in Better Auth OAuth state or D1.

With both Workers running and both local OAuth providers configured, exercise
the complete interactive CLI path with:

```bash
BARESTASH_API_URL=http://localhost:8787 just barestash auth login \
  --allow-insecure-api-url
```

The CLI opens the local browser Worker, stores the resulting access and refresh
tokens in the OS credential store, and refreshes the one-hour access token when
five minutes or less remain. Use `auth logout --revoke` to revoke the current
CLI session before removing the local credential.

`just reset-api-state` also deletes the shared local D1 state, so it removes
Better Auth adapter records and browser sessions in addition to API/R2/Durable
Object state. Restart both Workers after a reset.

## Capture A Local Event

In another terminal, create a temporary endpoint against the local API:

```bash
just barestash endpoints create --temporary --json
```

Post to the returned local webhook path:

```bash
curl -i \
  -X POST "http://localhost:8787/ep_.../local-test?source=docs" \
  -H "content-type: application/json" \
  --data '{"ok":true}'
```

Then verify through the CLI:

```bash
just barestash events list --endpoint ep_... --json
just barestash events latest --endpoint ep_... --json
just barestash events tail --endpoint ep_... --last 1 --body
just barestash events stream --endpoint ep_...
```

Stop either monitoring command with `Ctrl+C`. Both commands exit successfully,
and the `just barestash` recipe does not report the interruption as a recipe
failure.

## Smoke E2E Test

Run the CLI/API smoke test from the repository root:

```bash
just test-e2e
```

The test starts its own Wrangler dev server on an available local port with an
isolated persistence directory under the system temp folder. It does not reuse
`apps/api/.wrangler/state`, so developer-local API data does not affect the
result. Smoke CLI invocations also isolate auth by clearing ambient
`BARESTASH_TOKEN` and endpoint env vars and pointing
`BARESTASH_CONFIG_FILE` at an empty smoke config path.

The smoke suite applies the real D1 migrations, inserts a synthetic owner PAT
hash directly into its isolated local database, starts one isolated Wrangler
process, and then runs scenarios through the real `barestash` CLI entrypoint.
The raw seed PAT exists only in the test process and is never passed as Worker
configuration:

1. create → ingest → `barestash events latest --json`
2. create → ingest → `barestash events list --json` and
   `barestash events show --json`
3. create → ingest → `barestash events tail` for historical and live events
4. create → `barestash events stream` → live ingest → JSONL assertion
5. authenticated `tokens create` → private endpoint + ingest secret → REST,
   SSE, and MCP reads → PAT revocation and rejected reuse

The smoke suite does not execute third-party GitHub or Google OAuth. Browser
authentication is covered by focused Web Worker tests and requires local OAuth
credentials only when exercised manually.

## Inspect Local D1

Run a local D1 query from the repository root:

```bash
just d1-query "SELECT id, mode, status, event_count FROM endpoints;"
```

List recent event metadata and the R2 object keys that hold the raw body and
request envelope:

```bash
just d1-query "SELECT id, endpoint_id, body_r2_key, request_r2_key FROM events ORDER BY sequence DESC LIMIT 5;"
```

D1 should not contain request body content. Use `body_r2_key` and
`request_r2_key` to inspect canonical R2 objects instead.

## Inspect Local R2

Use an object key returned from the D1 event metadata query:

```bash
just r2-get events/ep_.../2026/07/10/evt_.../body.raw
```

Inspect the stored request envelope the same way:

```bash
just r2-get events/ep_.../2026/07/10/evt_.../request.json
```

R2 object keys must keep the MVP layout:

```text
events/{endpoint_id}/{yyyy}/{mm}/{dd}/{event_id}/body.raw
events/{endpoint_id}/{yyyy}/{mm}/{dd}/{event_id}/request.json
```
