# Barestash API / Backend Development Guide

## Purpose

The API / backend package is the core Barestash component for the product loop:
receive webhook requests, stash raw requests, and stream events to CLI users, API
clients, SSE consumers, MCP tools, and AI agents.

Backend behavior must stay aligned with `requirements/barestash-backend.spec.md`
and `requirements/barestash-cli-design.spec.md`. If behavior is unclear, do not
invent a new backend or API contract; update the relevant spec first or leave an
explicit TODO that names the unresolved contract question.

## Scope

These instructions apply to all files under `apps/api/`.

The MVP backend stack and responsibilities are:

- Cloudflare Workers: HTTP routing, ingest, REST API, auth, and the MCP endpoint.
- Hono / TypeScript: application framework and route composition.
- Durable Objects: endpoint-scoped SSE subscriber coordination and fan-out.
- D1: endpoint records, event metadata, token records, and cursor source of
  truth.
- R2: raw body bytes and raw request envelope storage.

## Backend design principles

- Preserve raw requests by default. Do not parse, normalize, truncate, summarize,
  or redact body bytes before canonical storage.
- Keep D1 as metadata and cursor storage. Keep R2 as canonical raw request
  storage.
- Keep Durable Objects as live coordination only; they are not canonical event
  history.
- Prefer small, explicit route handlers composed through Hono rather than hidden
  cross-route behavior.
- Treat CLI, REST, SSE, MCP, and AI-agent access as views over the same stored
  event contract.
- Keep MVP MCP behavior small and consistent with CLI/API behavior.
- Keep the Worker runtime entry in `src/worker.ts`; keep Hono composition and
  `createApiApp()` in `src/app.ts`. Do not introduce source `index.*` files or
  re-export facades.

## Routing and API surface

Ingest routes must follow the backend and CLI specs:

- Ingest: `https://ingest.{domain}/{endpoint_id}`
- Ingest with path suffix: `https://ingest.{domain}/{endpoint_id}/{*path}`
- REST API root: `/v1`
- MCP endpoint: `/mcp`

The event API surface includes:

- `POST /v1/endpoints`
- `GET /v1/endpoints`
- `GET /v1/endpoints/{endpoint_id}`
- `DELETE /v1/endpoints/{endpoint_id}`
- `POST /v1/endpoints/{endpoint_id}/secrets`
- `GET /v1/endpoints/{endpoint_id}/secrets`
- `DELETE /v1/endpoints/{endpoint_id}/secrets/{secret_id}`
- `GET /v1/endpoints/{endpoint_id}/events`
- `GET /v1/events/{event_id}`
- `GET /v1/events/{event_id}/body`
- `GET /v1/endpoints/{endpoint_id}/events/stream`
- `GET /v1/account`
- `POST /v1/auth/device/authorizations`
- `POST /v1/auth/device/token`
- `POST /v1/tokens`
- `GET /v1/tokens`
- `DELETE /v1/tokens/{token_id}`

Recommended MVP MCP tools under `/mcp` are:

- `list_endpoints`
- `create_endpoint`
- `list_events`
- `get_event`
- `get_event_body`

## Ingest behavior

- Successful ingest returns `204 No Content` with an empty response body.
- Successful ingest must include these response headers:
  - `x-barestash-event-id`
  - `x-barestash-endpoint-id`
- The product-level request body limit is `10MB`, separate from platform limits.
- If a request body exceeds `10MB`, do not create an event; return
  `413 Payload Too Large`.
- Enforce the size limit before or while reading the body. Do not read unbounded
  request bodies.
- Ingest must support endpoint path suffixes and store both the endpoint ID and
  original ingest path metadata.
- Temporary endpoints have a 24h TTL, public-by-URL reads, and at most 100 stored
  events.
- When a temporary endpoint reaches 100 stored events, reject additional ingest
  with `429 Too Many Requests`. Do not silently evict older events in the MVP.
- Temporary endpoint deletion via API is unsupported in the MVP.
- Private endpoints have a 7-day TTL, require authenticated reads, support
  optional ingest secret verification, and store at most 1000 events.

## Storage rules

- The canonical raw body storage location is R2 `body.raw`.
- Do not store body content in D1.
- Never store these body-derived values in D1:
  - parsed JSON body
  - text body
  - form body
  - multipart body
  - binary body
  - body preview
  - body summary
- D1 stores only metadata needed to reference and verify body storage:
  - `body_size`
  - `body_sha256`
  - `body_r2_key`
  - `request_r2_key`
- R2 object layout must be:
  - `events/{endpoint_id}/{yyyy}/{mm}/{dd}/{event_id}/body.raw`
  - `events/{endpoint_id}/{yyyy}/{mm}/{dd}/{event_id}/request.json`
- Complete R2 writes before inserting D1 event metadata.
- If the D1 insert fails after R2 writes succeed, attempt best-effort cleanup of
  orphaned R2 objects.
- `GET /v1/events/{event_id}/body` returns raw body bytes from R2. It must not
  parse JSON, pretty print, or redact body content. Use the stored content type
  when available.

## Header and secret handling

- Normalize header names to lowercase.
- Store only allowlist headers in D1.
- Do not store sensitive headers in D1.
- API responses must render sensitive headers as `[REDACTED]`.
- `x-barestash-secret` and `x-barestash-bootstrap-token` must not be stored
  in D1 or R2.

D1 header allowlist:

- `content-type`
- `content-length`
- `user-agent`
- `x-request-id`
- `x-correlation-id`
- `x-github-event`
- `x-gitlab-event`
- `x-shopify-topic`

Sensitive header denylist includes at least:

- `authorization`
- `proxy-authorization`
- `cookie`
- `set-cookie`
- `x-api-key`
- `x-auth-token`
- `x-access-token`
- `x-barestash-secret`
- `x-barestash-bootstrap-token`
- `stripe-signature`
- `x-hub-signature`
- `x-hub-signature-256`
- `x-slack-signature`
- `x-shopify-hmac-sha256`

`x-barestash-secret` rules:

- Use only for optional ingest secret verification on private endpoints.
- If a private endpoint has no active endpoint secret, accept ingest without
  `x-barestash-secret`.
- If a private endpoint has an active endpoint secret, require
  `x-barestash-secret`.
- If the provided secret does not match, do not create an event; return `401`.
- Store raw endpoint secrets only as hashes. Never store, return, or log raw
  secret values.
- Temporary endpoints do not require `x-barestash-secret` in the MVP.

## Authentication and authorization

- Private endpoint read APIs require `Authorization: Bearer <token>`.
- Temporary endpoint read APIs do not require authentication.
- CLI access tokens and scoped Personal Access Tokens authenticate through the
  common bearer principal path.
- Raw token values are stored as hashes and shown only once at creation.
- Raw Device Authorization device and user codes are stored only as HMAC
  hashes. Device token exchange is single-use and grants exactly the approved
  requested scopes.
- Token list/show responses must never include raw token values.
- A caller must not be able to read private endpoint events, bodies, streams, or
  secrets without authorization.

## Event streaming rules

- SSE endpoint: `GET /v1/endpoints/{endpoint_id}/events/stream`
- Transport: `text/event-stream`
- Each SSE message contains one JSON object.
- SSE payloads include base64-encoded raw body bytes.
- Reconnect must support `Last-Event-ID`.
- D1 is the source of truth for catch-up and cursor queries.
- Durable Objects are only the live subscriber coordination and fan-out layer;
  they are not canonical event history.

## Error handling expectations

Use a consistent JSON error response shape:

```json
{
  "error": {
    "code": "payload_too_large",
    "message": "Request body exceeds the 10MB limit."
  }
}
```

Handle at least these error codes:

- `endpoint_not_found`
- `endpoint_expired`
- `not_authenticated`
- `not_authorized`
- `missing_ingest_secret`
- `invalid_ingest_secret`
- `payload_too_large`
- `event_limit_exceeded`
- `rate_limit_exceeded`
- `rate_limit_unavailable`
- `event_not_found`
- `body_not_found`
- `r2_write_failed`
- `d1_write_failed`
- `internal_error`

## Security rules

Never log:

- raw request body
- raw `Authorization`
- raw cookies
- raw `x-barestash-secret`
- raw `x-barestash-bootstrap-token`
- raw token values
- raw endpoint secret values

Logs may include endpoint ID, event ID, method, request path, body size, status
code, and error code.

Rate Limiting bindings are required in deployed environments. Keep exact
policy, key, and quota behavior aligned with
`requirements/barestash-backend.spec.md` and operational guidance in
`docs/rate-limiting.md`.

## Testing and validation expectations

Prefer existing package scripts or `just` targets. For backend code changes, run
focused tests first, then broader checks when practical.

Tests should cover:

- ingest routing with endpoint path suffix
- private endpoint authentication
- temporary endpoint public reads
- payload size limit
- raw body storage in R2
- D1 metadata insert
- R2-before-D1 behavior
- header allowlist / denylist behavior
- `x-barestash-secret` verification
- `x-barestash-secret` non-persistence
- redacted API responses
- event list / show / body endpoints
- SSE stream payload shape
- `Last-Event-ID` catch-up behavior
- endpoint event limits (temporary 100, private 1000)
- API error response shape and codes

## Documentation update expectations

- Keep implementation behavior aligned with
  `requirements/barestash-backend.spec.md` and
  `requirements/barestash-cli-design.spec.md`.
- When adding or changing a backend/API contract, update the relevant source of
  truth in the same change.
- If a behavior is intentionally deferred or unclear, leave a concise TODO that
  points to the spec section or unresolved decision.
- Do not document speculative runtime, storage, deployment, or provider behavior
  as implemented behavior.
