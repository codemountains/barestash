# Barestash Backend Specification

## Status

Draft for MVP implementation.

This document defines the backend design for Barestash. CLI command design is maintained separately in `barestash-cli-design.spec.md`. Identity, authentication, authorization, CLI sessions, and Personal Access Token behavior are defined in `barestash-authentication-authorization.spec.md`, which is the source of truth for those topics.

## Product Summary

Barestash is a headless stash for incoming requests.

```text
Receive webhooks
    ↓
Stash raw requests
    ↓
Stream events to CLI or AI agents
```

The backend must prioritize:

- preserving raw request bodies
- simple external webhook intake
- lightweight event metadata queries
- real-time event delivery via SSE
- CLI-first and agent-friendly API behavior
- minimal dashboard dependency

---

## 1. MVP Backend Stack

The MVP backend stack is:

```text
Cloudflare Workers
+ Hono / TypeScript
+ Durable Objects
+ D1
+ R2
+ MCP endpoint /mcp
+ CLI clients
```

### Component Responsibilities

| Component | Responsibility |
| --- | --- |
| Cloudflare Workers | HTTP routing, ingest, REST API, auth, MCP endpoint |
| Hono / TypeScript | Application framework and route composition |
| Durable Objects | Endpoint-scoped live stream coordination, subscriber management, fan-out |
| D1 | Metadata, endpoint records, token records, event index, cursor source of truth |
| R2 | Raw request body and raw request envelope storage |
| MCP `/mcp` | Agent-facing tool endpoint |
| CLI | Human and machine client surface |

---

## 2. Non-Goals for MVP

The MVP does not include:

- provider-specific webhook signature verification
- dashboard-first inspection workflows
- full-text search over request bodies
- parsed JSON body storage in D1
- request body preview storage in D1
- request body summary storage in D1
- replay endpoint
- endpoint deletion for temporary endpoints
- manual event deletion or purge APIs
- body truncation on ingest
- body-level analytics
- WebSocket support

SSE is the primary real-time delivery mechanism.

---

## 3. Domains and URL Design

### Ingest URL

Webhook ingestion uses the ingest subdomain:

```text
https://ingest.{domain}/{endpoint_id}
https://ingest.{domain}/{endpoint_id}/{*path}
```

### API URL

The REST API is versioned under `/v1`.

```text
https://api.{domain}/v1
```

If the deployment uses a single hostname, `/v1` may be served from the same Worker host.

### MCP URL

The MCP endpoint is exposed at:

```text
https://api.{domain}/mcp
```

If the deployment uses a single hostname, `/mcp` may be served from the same Worker host.

---

## 4. Endpoint Model

Barestash has two endpoint modes:

```text
private
temporary
```

### 4.1 Private Endpoints

Private endpoints are authenticated endpoints tied to an account.

Properties:

- receiving requests is public by URL
- reading events requires authentication
- optional `x-barestash-secret` verification is supported
- endpoint secret rotation is supported
- endpoint TTL is 7 days
- max stored events is 1000; further ingest returns HTTP 429
- manual deletion is supported before automatic expiry cleanup
- expiry cleanup automatically deletes the endpoint, its events, endpoint secrets, and raw request objects

### 4.2 Temporary Endpoints

Temporary endpoints are short-lived public-by-URL endpoints.

Properties:

```text
TTL: 24 hours
Max stored events: 100
Read access: public-by-URL
Delete API: not supported
Expiry cleanup: automatic
```

Anyone who knows the temporary `endpoint_id` can read:

```text
GET /v1/endpoints/{endpoint_id}/events
GET /v1/events/{event_id}
GET /v1/events/{event_id}/body
GET /v1/endpoints/{endpoint_id}/events/stream
```

Temporary endpoints must not be used for sensitive production webhooks.

### Temporary Event Limit Behavior

When a temporary endpoint already has 100 stored events, further ingest requests must be rejected.

```text
HTTP 429 Too Many Requests
```

The backend must not silently evict older temporary events in the MVP.

---

## 5. Event Storage Model

### Required Storage And Live-Stream Bindings

The deployed Worker must have its persistent storage and live-stream bindings
configured:

- `DB` for D1 metadata storage
- `REQUEST_BODIES` for R2 raw request storage
- `ENDPOINT_STREAMS` for endpoint-scoped Durable Object coordination

The production application must fail closed on the first HTTP request when
any binding is missing. It must return a structured `internal_error`
response and emit a configuration diagnostic that identifies the missing
binding names without logging request data or credentials.

In-memory repositories are test adapters only. Application-level tests that
construct the application without Wrangler bindings must use the test
composition root, `createTestApiApp()`. The production composition root must
never import or select in-memory storage implicitly.

### Core Decision

Barestash stores event metadata in D1 and raw request bodies in R2.

```text
D1: event metadata / indexes / cursors
R2: raw body bytes / request envelope
```

D1 must not be treated as canonical storage for request bodies.

### Canonical Body

The canonical body is always the raw byte sequence stored in R2.

```text
canonical body = R2 body.raw
```

This is true for all body types:

- JSON
- text
- form-urlencoded
- multipart
- binary
- empty body
- invalid UTF-8
- invalid JSON

### D1 Does Not Store Body Content

D1 does not store:

- `body_json`
- parsed JSON body
- text body
- form body
- multipart body
- binary body
- body preview
- body summary
- `body_kind`
- `body_parse_status`

D1 stores only metadata necessary to locate and verify the raw body.

Required D1 body metadata:

```text
body_size
body_sha256
body_r2_key
request_r2_key
```

---

## 6. R2 Object Layout

Each event stores at least two R2 objects:

```text
events/{endpoint_id}/{yyyy}/{mm}/{dd}/{event_id}/body.raw
events/{endpoint_id}/{yyyy}/{mm}/{dd}/{event_id}/request.json
```

Example:

```text
events/ep_01JABC/2026/07/05/evt_01JDEF/body.raw
events/ep_01JABC/2026/07/05/evt_01JDEF/request.json
```

### `body.raw`

`body.raw` stores the request body exactly as received.

Rules:

- stores raw bytes
- no JSON parsing is required
- no UTF-8 decoding is required
- no preview is generated
- no redaction is applied to body bytes
- empty body may be stored as a zero-byte object or represented by metadata with `body_size = 0`

### `request.json`

`request.json` stores the request envelope that should not live fully in D1.

Example:

```json
{
  "event_id": "evt_01JDEF",
  "endpoint_id": "ep_01JABC",
  "received_at": "2026-07-05T12:04:32.000Z",
  "method": "POST",
  "ingest_path": "/ep_01JABC/webhook/stripe",
  "request_path": "/webhook/stripe",
  "query": {
    "debug": "true"
  },
  "headers": {
    "content-type": "application/json",
    "user-agent": "Stripe/1.0",
    "stripe-signature": "t=...,v1=..."
  },
  "body": {
    "r2_key": "events/ep_01JABC/2026/07/05/evt_01JDEF/body.raw",
    "size": 8400,
    "sha256": "..."
  }
}
```

`request.json` may contain sensitive provider headers, but it must not contain Barestash internal credential headers such as `x-barestash-secret` or `x-barestash-bootstrap-token`.

---

## 7. Header Storage Policy

Headers are split into three categories:

1. D1 allowlist headers
2. sensitive headers stored only in R2
3. Barestash internal credential headers, which are not persisted

### 7.1 D1 Allowlist Headers

Only the following headers are stored in D1:

```text
content-type
content-length
user-agent
x-request-id
x-correlation-id
x-github-event
x-gitlab-event
x-shopify-topic
```

Header names must be normalized to lowercase before storage.

D1 should store allowlist headers as JSON:

```json
{
  "content-type": "application/json",
  "user-agent": "GitHub-Hookshot/...",
  "x-github-event": "push"
}
```

### 7.2 Sensitive Header Denylist

The following headers must not be stored in D1:

```text
authorization
proxy-authorization
cookie
set-cookie
x-api-key
x-auth-token
x-access-token
x-barestash-secret
x-barestash-bootstrap-token
stripe-signature
x-hub-signature
x-hub-signature-256
x-slack-signature
x-shopify-hmac-sha256
```

All denylist headers except Barestash internal credential headers, including `x-barestash-secret` and `x-barestash-bootstrap-token`, may be stored in R2 `request.json` for raw request preservation.

### 7.3 `x-barestash-secret` Handling

`x-barestash-secret` is used only for Barestash-managed ingest secret verification.

Rules:

- it is read during ingest
- it is compared against hashed endpoint secrets
- it is not stored in D1
- it is not stored in R2
- it is not returned by API
- it is not shown by CLI

D1 may store non-sensitive verification metadata:

```text
secret_verification_status = not_configured | matched
matched_secret_id = nullable secret id
```

Failed secret verification does not create an event.

### 7.4 API and CLI Header Display

API and CLI responses must not expose raw sensitive header values by default.

When displaying headers, sensitive headers should be redacted:

```text
authorization: [REDACTED]
stripe-signature: [REDACTED]
x-slack-signature: [REDACTED]
```

The MVP does not provide an API or CLI option to return raw sensitive header values.

---

## 8. Ingest Secret Verification

Barestash does not provide provider-specific signature verification in MVP.

Not supported in MVP:

- Stripe signature verification
- GitHub HMAC verification
- Slack signing secret verification
- Shopify HMAC verification
- GitLab token verification

Barestash provides only an optional endpoint-level ingest secret using:

```text
x-barestash-secret: <secret>
```

### Private Endpoint Behavior

For private endpoints:

```text
if no active endpoint secret exists:
  accept request without x-barestash-secret

if one or more active endpoint secrets exist:
  require x-barestash-secret
  accept only if it matches an active secret hash
```

Verification must check every active secret, even after an earlier candidate
matches. Each hash comparison remains timing-safe, and request-level work does
not reveal which active secret matched through an early-exit timing difference.
Only the matched secret record receives a `last_used_at` update.

This constant-work behavior is intentional for secret rotation. An early-exit
optimization may be reconsidered only when production measurements show that
active-secret verification is a material ingest hot-path cost and the resulting
timing disclosure is explicitly accepted.

### Temporary Endpoint Behavior

Temporary endpoints do not require `x-barestash-secret` in MVP.

### Secret Storage

Endpoint secrets must be stored as hashes.

The raw secret is shown once at creation or rotation time and cannot be recovered later.

### Secret Rotation

Secret rotation supports multiple active secrets during a transition period.

Recommended flow:

```text
1. Create a new active secret
2. Keep old and new secrets active temporarily
3. Update external webhook provider configuration
4. Revoke old secret
```

Secret records should include:

```text
id
endpoint_id
secret_hash
status: active | revoked
created_at
last_used_at
revoked_at
```

---

## 9. Payload Size Limit

Barestash defines a product-level maximum request body size:

```text
max_body_size = 10MB
```

This is separate from Cloudflare platform limits.

### Over Limit Behavior

If the request body exceeds 10MB:

```text
HTTP 413 Payload Too Large
```

Rules:

- no event is created
- no D1 metadata is inserted
- no R2 body object is stored
- no stream notification is sent

If `content-length` is greater than 10MB, the request may be rejected before reading the body.

If `content-length` is missing or inaccurate, the backend must enforce the limit while reading the body.

---

## 10. Ingest Path Handling

The ingest route accepts endpoint subpaths:

```text
POST /{endpoint_id}
POST /{endpoint_id}/{*path}
```

For an incoming request:

```text
POST https://ingest.example.com/ep_abc/github/push?foo=bar
```

The backend stores:

```text
endpoint_id  = ep_abc
ingest_path  = /ep_abc/github/push
request_path = /github/push
query_json   = {"foo":"bar"}
```

`request_path` excludes the endpoint ID and represents the path intended by the webhook sender.

---

## 11. Ingest Response

Successful ingest returns:

```http
HTTP/1.1 204 No Content
x-barestash-event-id: evt_01JDEF
x-barestash-endpoint-id: ep_01JABC
```

The response body must be empty.

### Error Responses

| Condition | Status | Event Created |
| --- | ---: | ---: |
| Endpoint not found | 404 | No |
| Endpoint expired | 410 | No |
| Payload too large | 413 | No |
| Missing required `x-barestash-secret` | 401 | No |
| Invalid `x-barestash-secret` | 401 | No |
| Event limit exceeded | 429 | No |
| R2 write failure | 500 | No |
| D1 insert failure | 500 | No, R2 cleanup attempted |

---

## 12. Ingest Processing Flow

The ingest flow is:

```text
1. Receive request at https://ingest.{domain}/{endpoint_id}/{*path}
2. Resolve endpoint from D1
3. Reject if endpoint does not exist or is inactive
4. Reject if endpoint is expired
5. Reject if endpoint has reached its configured stored event limit
6. Verify optional x-barestash-secret if configured
7. Enforce max_body_size = 10MB
8. Read raw body bytes
9. Generate event_id
10. Calculate body_sha256
11. Store body.raw in R2
12. Store request.json in R2, excluding Barestash internal credential headers
13. Insert event metadata into D1
14. Notify endpoint Durable Object
15. Return 204 No Content with event headers
```

### R2 Before D1

R2 storage must complete before D1 event metadata is inserted.

This ensures D1 does not point to a missing body object under normal operation.

### D1 Failure After R2 Success

If D1 insert fails after R2 writes succeeded:

```text
1. Worker attempts best-effort deletion of R2 objects
2. If deletion fails, orphan objects may remain
3. Scheduled cleanup later removes orphan objects
```

---

## 13. Orphan Cleanup

R2 orphan cleanup uses a Scheduled Worker.

The cleanup process should:

- scan candidate R2 event prefixes
- detect objects without corresponding D1 event rows
- delete orphan `body.raw` and `request.json`
- ignore recently created objects within a safety window
- log cleanup counts

Recommended safety window:

```text
orphan_cleanup_min_age = 1 hour
```

Durable Objects are not responsible for global orphan cleanup.

---

## 14. Event Identity and Ordering

IDs should be time-sortable.

Recommended ID format:

```text
endpoint: ep_ + ULID
event:    evt_ + ULID
token:    tok_ + 24-character alphanumeric random id
secret:   sec_ + random id
```

Token record ids use a 24-character alphanumeric suffix. Validation must reject ids that contain underscores, hyphens, or incorrect lengths when accepting new API input or embedding ids in bearer token strings. Stored token rows created before this grammar change may still use the previous 24-character suffix alphabet (`A-Za-z0-9_-`); read paths must continue to accept those ids without failing authentication or listing.

Event IDs should remain time-sortable for display and correlation, but cursor ordering must not depend on event ID lexicographic order alone.

D1 event rows should use a monotonic insertion sequence as the canonical ordering for event history and cursor queries. This prevents polling consumers from missing events when multiple generated ULIDs share the same millisecond timestamp and their random suffixes sort out of capture order.

The initial D1 schema creates `events` with `sequence INTEGER PRIMARY KEY AUTOINCREMENT` from the start. All new rows must use this monotonic sequence for cursor ordering.

D1 is the source of truth for event history and cursor queries.

---

## 15. Durable Objects Design

Durable Objects are used for endpoint-scoped stream coordination.

### Responsibilities

Durable Objects handle:

- endpoint-specific SSE subscriber management
- live event fan-out
- connection lifecycle management
- heartbeat delivery
- reconnect coordination
- catch-up handoff using D1 cursors

### Non-Responsibilities

Durable Objects do not own:

- canonical event history
- canonical cursor storage
- raw request body storage
- retention cleanup
- token management
- endpoint metadata

### Source of Truth

```text
D1 = event history and cursor source of truth
R2 = raw body and request envelope source of truth
Durable Object = live coordination layer
```

### Stream Flow

```text
Ingest Worker
  ↓ saves body.raw/request.json to R2
  ↓ inserts metadata to D1
  ↓ notifies Durable Object for endpoint
Durable Object
  ↓ loads event payload if needed
  ↓ sends to active SSE subscribers
```

### Reconnect and Catch-Up

SSE clients may reconnect with `Last-Event-ID`.

```http
GET /v1/endpoints/ep_01JABC/events/stream
Last-Event-ID: evt_01JDEF
```

The backend should catch up from D1:

```sql
SELECT
  id,
  endpoint_id,
  received_at,
  method,
  request_path,
  query_json,
  allowlist_headers_json,
  body_size,
  body_sha256,
  body_r2_key,
  request_r2_key
FROM events
WHERE endpoint_id = ?
  AND sequence > (
    SELECT sequence FROM events WHERE endpoint_id = ? AND id = ?
  )
ORDER BY sequence ASC
LIMIT ?;
```

After catch-up, the connection is attached to the live Durable Object stream.

### DO Storage

MVP should avoid depending on Durable Object persistent storage for event cursors.

Durable Object in-memory state may be used for active subscriber state only.

---

## 16. REST API Surface

The REST API is versioned under `/v1`.

### Endpoint APIs

```http
POST   /v1/endpoints
GET    /v1/endpoints
GET    /v1/endpoints/{endpoint_id}
DELETE /v1/endpoints/{endpoint_id}
```

Notes:

- private endpoint creation requires authentication
- temporary endpoint creation may be unauthenticated if supported by product flow
- endpoint list access requires authentication and must not anonymously enumerate temporary endpoint IDs
- temporary endpoint detail access by `endpoint_id` may be public-by-URL
- private endpoint deletion deletes the endpoint and all associated events from D1 and R2
- temporary endpoint deletion is not supported in MVP

### Endpoint Secret APIs

```http
POST   /v1/endpoints/{endpoint_id}/secrets
GET    /v1/endpoints/{endpoint_id}/secrets
DELETE /v1/endpoints/{endpoint_id}/secrets/{secret_id}
```

Notes:

- secret values are shown once on creation
- list responses never include raw secret values
- delete/revoke marks the secret as revoked

### Event APIs

```http
GET /v1/endpoints/{endpoint_id}/events
GET /v1/events/{event_id}
GET /v1/events/{event_id}/body
GET /v1/endpoints/{endpoint_id}/events/stream
```

Event delete APIs are not supported. Events may be removed only by endpoint deletion or scheduled retention cleanup.

### Authentication and Token APIs

```http
POST /v1/auth/device/authorizations
POST /v1/auth/device/token
POST /v1/auth/token/refresh
POST /v1/auth/sessions/current/revoke

GET  /v1/account

POST   /v1/tokens
GET    /v1/tokens
DELETE /v1/tokens/{token_id}
```

Notes:

- Request/response contracts, scope rules, and session behavior for these endpoints are defined in `barestash-authentication-authorization.spec.md`.
- `POST /v1/tokens` requires an `Idempotency-Key` header and enforces that requested scopes are a subset of the caller's grants.
- `DELETE /v1/tokens/{token_id}` is idempotent. Self-revocation of the authenticated PAT is exempt from `tokens:write`.
- `GET /v1/account` requires no scope and returns the current account and credential status.

---

## 17. Event API Behavior

### `GET /v1/endpoints/{endpoint_id}/events`

Returns event metadata only.

Query parameters:

```text
limit
before
after
```

Response example:

```json
{
  "events": [
    {
      "id": "evt_01JDEF",
      "endpoint_id": "ep_01JABC",
      "received_at": "2026-07-05T12:04:32.000Z",
      "method": "POST",
      "request_path": "/webhook/stripe",
      "query": {},
      "headers": {
        "content-type": "application/json",
        "user-agent": "Stripe/1.0"
      },
      "body": {
        "size": 8400,
        "sha256": "...",
        "available": true
      }
    }
  ]
}
```

The response must not include body content.

### `GET /v1/events/{event_id}`

Returns event metadata and redacted header view.

Response example:

```json
{
  "id": "evt_01JDEF",
  "endpoint_id": "ep_01JABC",
  "received_at": "2026-07-05T12:04:32.000Z",
  "request": {
    "method": "POST",
    "ingest_path": "/ep_01JABC/webhook/stripe",
    "request_path": "/webhook/stripe",
    "query": {},
    "headers": {
      "content-type": "application/json",
      "user-agent": "Stripe/1.0",
      "stripe-signature": "[REDACTED]"
    },
    "body": {
      "size": 8400,
      "sha256": "...",
      "available": true,
      "url": "/v1/events/evt_01JDEF/body"
    }
  }
}
```

The response must not include body content.

### `GET /v1/events/{event_id}/body`

Returns the raw body bytes from R2.

Rules:

- preserves raw bytes
- uses stored `content-type` when available
- does not parse JSON
- does not pretty print
- does not redact body content

CLI is responsible for JSON pretty printing based on content type and decoded bytes.

---

## 18. Events Stream API

### Endpoint

```http
GET /v1/endpoints/{endpoint_id}/events/stream
```

### Access Control

```text
private endpoint: authenticated access required
temporary endpoint: public-by-URL access
```

### Transport

SSE is the primary stream transport.

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

### Event Format

Each SSE message contains one JSON object.

The stream payload must always include the body as base64-encoded raw bytes.

```http
id: evt_01JDEF
event: event
data: {"id":"evt_01JDEF",...}
```

Payload example:

```json
{
  "id": "evt_01JDEF",
  "endpoint_id": "ep_01JABC",
  "received_at": "2026-07-05T12:04:32.000Z",
  "request": {
    "method": "POST",
    "path": "/webhook/stripe",
    "query": {},
    "headers": {
      "content-type": "application/json",
      "user-agent": "Stripe/1.0"
    },
    "body_size": 8400,
    "body_sha256": "..."
  },
  "body": {
    "encoding": "base64",
    "data": "eyJpZCI6ImV2dF8uLi4iLCJ0eXBlIjoiY2hlY2tvdXQuc2Vzc2lvbi5jb21wbGV0ZWQifQ=="
  }
}
```

### Body Encoding

The body is always encoded as:

```text
encoding = base64
```

This applies to:

- JSON
- text
- form-urlencoded
- multipart
- binary
- empty body

Clients must decode base64 to reconstruct raw body bytes.

### Stream Size Consideration

Because `max_body_size = 10MB`, a single stream event may contain a large base64 payload.

Base64 expands data by approximately one third. A 10MB raw body may produce an approximately 13.3MB encoded body.

### Metadata-Only Mode

The MVP stream includes body by default and should preserve the option to add a future metadata-only stream mode.

Suggested future CLI/API option:

```text
metadata_only=true
```

or CLI:

```bash
barestash events stream --metadata-only
```

This is not required for MVP unless implementation pressure requires it.

---

## 19. CLI Interaction Notes

CLI behavior is specified separately, but backend behavior must support the following patterns.

### `events tail`

`events tail` consumes event metadata.

Backend interaction:

```text
GET /v1/endpoints/{endpoint_id}/events?after={cursor}
```

The response does not include body content.

### `events tail --body`

`events tail --body` fetches body per event.

Backend interaction:

```text
GET /v1/endpoints/{endpoint_id}/events?after={cursor}
GET /v1/events/{event_id}/body
```

CLI responsibilities:

- decode body bytes
- pretty print JSON when appropriate
- display binary/multipart as content type and body size only

### `events stream`

`events stream` consumes SSE and outputs JSONL/NDJSON.

The backend stream includes base64 body data. CLI may transform SSE messages into JSONL lines.

---

## 20. Authentication and Authorization

Identity, authentication, session, and token behavior is defined in `barestash-authentication-authorization.spec.md`, which is the source of truth when it conflicts with this document.

### Authentication surfaces

```text
Browser authentication
  └─ GitHub / Google through Better Auth

Interactive CLI authentication
  └─ Barestash Device Authorization Flow
     └─ short-lived access token + rotating refresh token

Non-interactive authentication
  └─ Personal Access Token (CI / scripts / AI agents / MCP)
```

Bearer credentials follow the shared token string grammar:

```text
bst_access_<token-id>_<secret>
bst_refresh_<token-id>_<secret>
bst_pat_<token-id>_<secret>
```

`<token-id>` and `<secret>` are alphanumeric only, so splitting on underscores is unambiguous.

Token storage rules:

- store token hash only (HMAC-SHA-256 with a server pepper from Cloudflare Secrets)
- show raw token once at creation
- never return raw token in list/show responses
- support revocation
- track `last_used_at`

Authorization is scope-based (`endpoints:read`, `endpoints:write`, `events:read`, `tokens:read`, `tokens:write`, `mcp:use`). Scope definitions and the PAT scope subset rule are defined in `barestash-authentication-authorization.spec.md`.

### Scoped PAT Issuance

`POST /v1/tokens` requires an authenticated CLI session or scoped PAT with
`tokens:write`. Bootstrap authentication is unavailable in every environment.
The retired `x-barestash-bootstrap-token` header remains on the sensitive-header
denylist only so it can never be persisted or logged; it does not authenticate
a request.

The MVP uses account-scoped ownership for tokens and private endpoints. Workspace/team modeling is deferred.

### API Authentication

Private endpoint APIs require a bearer credential (CLI access token or Personal Access Token):

```http
Authorization: Bearer <token>
```

Refresh tokens must not be accepted as bearer credentials for REST, SSE, or MCP requests.

Temporary endpoint read APIs do not require authentication.

Every HTTP request to the MCP endpoint requires a valid bearer credential
(CLI access token or Personal Access Token), in all environments:

```http
Authorization: Bearer <token>
```

MCP transport authentication is enforced before HTTP method dispatch and
JSON-RPC body processing. Missing, malformed, invalid, and revoked credentials
return HTTP 401 with the standard `not_authenticated` REST error body and:

```http
WWW-Authenticate: Bearer
```

This transport requirement does not change the REST authentication policy for
temporary endpoints.

### Private Endpoint Authorization

An authenticated principal may access a private endpoint only when the principal has the required scope, the endpoint belongs to the principal's account, and the account and credential are active.

Authorization must not rely on endpoint IDs being difficult to guess.

Workspace/team modeling may be added later.

### MCP Authorization

Each MCP tool must enforce both `mcp:use` and its resource-specific scope (for example, `list_events` requires `mcp:use` and `events:read`).

---

## 21. MCP Endpoint Scope

The MCP endpoint is available at:

```http
/mcp
```

MVP MCP capabilities should be small and aligned with CLI/API behavior.

MVP uses MCP Streamable HTTP transport for request/response tool calls over:

```http
POST /mcp
```

All `/mcp` methods require transport authentication. Authenticated unsupported
methods continue to return HTTP 405. MCP clients must authenticate even when
creating a temporary endpoint or accessing a public-by-URL temporary endpoint.
Temporary endpoints created through MCP remain unowned and public-by-URL after
creation, matching temporary endpoints created through REST.

Long-running server-to-client MCP streaming, including `GET /mcp` SSE and
event notifications, is out of scope for the MVP.

Recommended tools:

```text
list_endpoints
create_endpoint
list_events
get_event
get_event_body
```

### MCP Body Handling

`get_event_body` should return body bytes as base64 or a structured content response appropriate for MCP clients.

The backend must not parse or pretty print JSON for MCP by default.

### MCP Stream Handling

Long-running event stream support is not required for MVP MCP.

Agents can use `list_events` and `get_event_body`, or consume the SSE API directly.

---

## 22. D1 Schema Draft

This section reflects the initial D1 migration in `apps/api/migrations/0001_initial_schema.sql`.

### `endpoints`

```sql
CREATE TABLE endpoints (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  name TEXT,
  mode TEXT NOT NULL, -- private | temporary
  status TEXT NOT NULL, -- active | disabled | expired
  public_read INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  event_limit INTEGER, -- set by application at row creation per endpoint mode
  expires_at TEXT NOT NULL, -- set by application at row creation per endpoint mode
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_endpoints_mode_status_expires
ON endpoints(mode, status, expires_at);
```

### `endpoint_secrets`

```sql
CREATE TABLE endpoint_secrets (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL, -- active | revoked
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (endpoint_id) REFERENCES endpoints(id)
);

CREATE INDEX idx_endpoint_secrets_endpoint_status_created
ON endpoint_secrets(endpoint_id, status, created_at DESC);

CREATE UNIQUE INDEX idx_endpoint_secrets_secret_hash
ON endpoint_secrets(secret_hash);
```

### `events`

```sql
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  endpoint_id TEXT NOT NULL,
  received_at TEXT NOT NULL,

  method TEXT NOT NULL,
  ingest_path TEXT NOT NULL,
  request_path TEXT NOT NULL,
  query_json TEXT NOT NULL,
  allowlist_headers_json TEXT NOT NULL,
  sensitive_header_names_json TEXT NOT NULL,

  content_type TEXT,
  content_length INTEGER,
  user_agent TEXT,

  body_size INTEGER NOT NULL,
  body_sha256 TEXT NOT NULL,
  body_r2_key TEXT NOT NULL,
  request_r2_key TEXT NOT NULL,

  secret_verification_status TEXT NOT NULL, -- not_configured | matched
  matched_secret_id TEXT,

  created_at TEXT NOT NULL,
  FOREIGN KEY (endpoint_id) REFERENCES endpoints(id)
);
```

Recommended indexes:

```sql
CREATE INDEX idx_events_endpoint_received
ON events(endpoint_id, received_at DESC);

CREATE INDEX idx_events_endpoint_sequence
ON events(endpoint_id, sequence);
```

### Authentication tables

The authoritative schemas for `accounts`, `identities`, `device_authorizations`, `cli_sessions`, `access_tokens`, `refresh_tokens`, and `personal_access_tokens` are defined in `barestash-authentication-authorization.spec.md`.

### `tokens` (invalidated legacy table)

The pre-cutover implementation used a simplified `tokens` table. Migration
`0004_scoped_pat_cutover.sql` prepares domain-account ownership without copying
raw or hashed secrets into `personal_access_tokens`. After the common-principal
Worker is deployed, `0004_finalize_scoped_pat_cutover.sql` marks legacy rows
revoked. The table remains temporarily as a migration boundary and is not an
authentication source in the new Worker. Users reissue scoped PATs after an
interactive Device Authorization login or through an existing principal with
`tokens:write`.

```sql
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL, -- active | revoked
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE UNIQUE INDEX idx_tokens_token_hash
ON tokens(token_hash);

CREATE INDEX idx_tokens_account_status_created
ON tokens(account_id, status, created_at DESC);
```

---

## 23. Retention and Cleanup

### Temporary Endpoints

Temporary endpoints expire after:

```text
24 hours
```

After expiry:

- ingest returns `410 Gone`
- public read APIs should return `410 Gone` or `404 Not Found`
- stored events and R2 objects are eligible for cleanup

### Private Endpoints

Private endpoint TTL policy:

```text
endpoint TTL: 7 days
max stored events: 1000
paid tier retention: not offered in MVP (free tier only)
```

Canonical expiry source:

- `expires_at` is NOT NULL and set by the application at endpoint creation
  time for both temporary and private endpoints.
- Temporary endpoints set `expires_at` from
  `created_at + TEMPORARY_ENDPOINT_TTL_SECONDS`.
- Private endpoints set `expires_at` from
  `created_at + PRIVATE_ENDPOINT_TTL_SECONDS`.
- `expires_at` is the sole source of truth for endpoint expiry.
- List filtering, ingest expiry checks, scheduled cleanup, and API metadata must
  all use `expires_at` directly.

Manual event deletion or purge is not supported.

Events may be removed only by:

- deleting the parent endpoint before expiry
- scheduled cleanup of the expired parent endpoint after the 7-day TTL

When a private endpoint is deleted:

- the endpoint is deleted
- all associated events are deleted from D1
- all associated endpoint secrets are deleted from D1
- all associated R2 objects are deleted
- ingest for the deleted endpoint returns `404 Not Found` or `410 Gone`

Scheduled cleanup should delete expired private endpoints, associated events,
endpoint secrets, and R2 objects after the 7-day TTL.

### Cleanup Jobs

Scheduled cleanup should handle:

- expired temporary endpoints
- events under expired temporary endpoints
- expired private endpoints under the 7-day TTL policy
- events under expired private endpoints
- R2 bodies for deleted/expired events
- R2 objects for deleted private endpoints
- orphan R2 objects

---

## 24. Security Notes

Barestash stores sensitive incoming request data.

### Required Security Properties

- private endpoint reads require authentication
- temporary endpoints are explicitly public-by-URL
- raw body content is never logged
- Barestash internal credential headers such as `x-barestash-secret` and `x-barestash-bootstrap-token` are never persisted
- token and endpoint secret values are stored as hashes
- sensitive headers are not stored in D1
- sensitive headers are redacted in API/CLI responses
- body data returned by `/body` is raw and may contain secrets

### Rate Limiting And Abuse Controls

The Worker uses Cloudflare Rate Limiting bindings to protect expensive and
mutating surfaces. All policies use a 60-second window and the same limits in
local, staging, and production environments. Namespace IDs must be distinct
between environments so their counters are not shared.

| Policy | Surface | Key | Limit |
| --- | --- | --- | ---: |
| IP abuse | Ingest, all `/mcp` requests, and write authentication attempts combined | `CF-Connecting-IP` | 300/minute |
| Ingest endpoint | All ingest methods and paths | Endpoint ID | 120/minute |
| Endpoint creation | `POST /v1/endpoints` | `CF-Connecting-IP` | 5/minute |
| Endpoint creation | MCP `create_endpoint` | Authenticated token ID | 5/minute |
| PAT write | `POST /v1/tokens`, `DELETE /v1/tokens/{token_id}` | Verified credential ID, otherwise `CF-Connecting-IP` | 10/minute |
| Device creation | `POST /v1/auth/device/authorizations` | `CF-Connecting-IP` | 10/minute |
| Device polling | `POST /v1/auth/device/token` | `CF-Connecting-IP` | 120/minute |
| Refresh exchange | `POST /v1/auth/token/refresh` | `CF-Connecting-IP` | 10/minute |
| MCP transport | All `/mcp` methods | Authenticated token ID | 60/minute |
| Other writes | Endpoint deletion and endpoint secret creation/revocation | Verified token ID, otherwise client IP | 30/minute |
| SSE connection start | `GET /v1/endpoints/{endpoint_id}/events/stream` | Endpoint ID and client IP | 30/minute |

Only `CF-Connecting-IP` is trusted as the client IP. `X-Forwarded-For` must not
be used as a fallback. Requests without `CF-Connecting-IP` share an `unknown`
bucket. Only a token that has been verified against the token repository may
select a token-ID bucket. Missing or invalid credentials use the client-IP
bucket, and temporary SSE access always uses the client IP. Raw tokens and IP
addresses must not be logged.

When a quota is exceeded, REST and transport-level MCP responses return:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
```

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Too many requests."
  }
}
```

MCP `create_endpoint` quota failures are tool errors with
`isError = true`, `code = rate_limit_exceeded`, and `status = 429`; the HTTP
transport response remains 200 for a valid JSON-RPC tool call.

Rate Limiting bindings are required runtime bindings. Missing bindings fail
closed through the global configuration guard. If a configured binding throws
during a quota check, the protected request returns HTTP 503 with
`rate_limit_unavailable` and `Retry-After: 60`.

Cloudflare Rate Limiting counters are per Cloudflare location, permissive, and
eventually consistent. They are abuse controls, not globally exact accounting
or billing counters. SSE rate limiting covers connection starts; a strict
concurrent subscriber cap is outside this MVP control.

### Logging

Application logs must not include:

- raw request body
- raw `Authorization`
- raw cookies
- raw `x-barestash-secret`
- raw `x-barestash-bootstrap-token`
- raw token values
- raw endpoint secret values

Logs may include:

- endpoint ID
- event ID
- request method
- request path
- body size
- status code
- error code

---

## 25. Error Response Shape

REST API errors should use a consistent JSON shape.

Example:

```json
{
  "error": {
    "code": "payload_too_large",
    "message": "Request body exceeds the 10MB limit."
  }
}
```

Recommended error codes:

```text
invalid_request
endpoint_not_found
endpoint_expired
not_authenticated
not_authorized
insufficient_scope
missing_ingest_secret
invalid_ingest_secret
payload_too_large
event_limit_exceeded
rate_limit_exceeded
rate_limit_unavailable
event_not_found
body_not_found
r2_write_failed
d1_write_failed
internal_error
```

Authentication and authorization error codes (for example `access_token_expired`, `personal_access_token_expired`, `token_revoked`, `session_expired`, `refresh_token_reuse_detected`, `idempotency_key_required`) use the same error shape and are defined in `barestash-authentication-authorization.spec.md`.

Ingest success still returns `204 No Content` without a JSON body.

---

## 26. Implementation Notes

### Request Body Reading

The backend must avoid reading unbounded request bodies.

Implementation should:

- reject early when `content-length > 10MB`
- enforce byte limit while reading if content length is absent
- calculate SHA-256 from raw bytes
- write exact raw bytes to R2

### Headers

Implementation should:

- normalize header names to lowercase
- store D1 allowlist only in `allowlist_headers_json`
- store denylist headers except Barestash internal credential headers in R2 `request.json`
- remove Barestash internal credential headers such as `x-barestash-secret` and `x-barestash-bootstrap-token` before creating `request.json`
- expose sensitive headers only as redacted values

### Stream Payload Construction

For live stream fan-out, the Durable Object may receive only the `event_id` and load D1/R2 data before broadcasting.

To avoid repeated R2 reads for multiple subscribers, the Durable Object may build one in-memory encoded payload per event and fan it out to active subscribers.

This in-memory payload is not canonical and does not need to survive Durable Object eviction.

---

## 27. MVP Acceptance Criteria

The MVP backend is considered complete when it supports:

- creating private endpoints
- creating temporary endpoints
- receiving webhook requests at `https://ingest.{domain}/{endpoint_id}/{*path}`
- enforcing `max_body_size = 10MB`
- storing raw bodies in R2
- storing request envelopes in R2
- storing event metadata in D1
- excluding Barestash internal credential headers from persistence
- storing only allowlist headers in D1
- returning `204 No Content` with event ID headers on successful ingest
- listing events via REST API
- reading event metadata via REST API
- reading raw event body via REST API
- streaming events via SSE with base64 body data
- supporting temporary endpoint public-by-URL reads
- supporting private endpoint authenticated reads
- supporting optional `x-barestash-secret` verification for private endpoints
- supporting secret rotation with multiple active secrets
- using Durable Objects for live subscriber fan-out
- using D1 as cursor source of truth
- running scheduled cleanup for expired temporary endpoints, expired private endpoints, and orphan R2 objects
- deleting all associated D1 and R2 data when a private endpoint is deleted
- exposing initial MCP tools under `/mcp`

---

## 28. Future Considerations

Potential future additions:

- metadata-only stream mode
- request replay
- provider-specific signature verification
- endpoint-level retention settings
- paid tier retention
- body search using external index
- parsed JSON query support
- redaction policies for response bodies
- dashboard UI
- workspace/team access control
- usage metering and quotas
- webhook response customization
- retry or forwarding targets
- MCP streaming support
