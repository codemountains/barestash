# Rate Limiting Operations

Barestash uses Cloudflare Workers Rate Limiting bindings as application-level
abuse controls. The product contract and exact quotas are defined in
[`requirements/barestash-backend.spec.md`](../requirements/barestash-backend.spec.md)
and the browser OAuth surfaces are defined in
[`requirements/barestash-authentication-authorization.spec.md`](../requirements/barestash-authentication-authorization.spec.md).

## Runtime Bindings

The owning Worker requires these bindings locally and in every environment
where that Worker is deployed:

| Binding | Limit | Purpose |
| --- | ---: | --- |
| `ABUSE_IP_RATE_LIMITER` | 300/minute | Combined ingest, MCP, and write-attempt IP ceiling |
| `INGEST_ENDPOINT_RATE_LIMITER` | 120/minute | Per-endpoint ingest ceiling |
| `ENDPOINT_CREATION_RATE_LIMITER` | 5/minute | REST and MCP endpoint creation |
| `PAT_WRITE_RATE_LIMITER` | 10/minute | PAT creation and revocation by verified credential, otherwise client IP |
| `REFRESH_RATE_LIMITER` | 10/minute | CLI refresh token exchange by client IP |
| `DEVICE_CREATION_RATE_LIMITER` | 10/minute | Device Authorization creation by client IP |
| `DEVICE_POLL_RATE_LIMITER` | 120/minute | Device token polling by client IP; the five-second authorization interval is enforced separately |
| `MCP_RATE_LIMITER` | 60/minute | Authenticated MCP transport calls |
| `WRITE_RATE_LIMITER` | 30/minute | Other mutating REST calls |
| `SSE_RATE_LIMITER` | 30/minute | SSE connection starts |
| `OAUTH_RATE_LIMITER` | 10/minute | Browser Worker GitHub and Google sign-in initiation |
| `DEVICE_APPROVAL_RATE_LIMITER` | 10/minute | Browser user-code lookup, approval, and denial by client IP |

`apps/api/wrangler.toml` and `apps/web/wrangler.toml` define the local bindings
and local namespace identifiers. Each deployed environment must provide
compatible bindings with isolated counters.

The default Worker fails closed when any rate-limit binding is missing. A
binding call failure rejects only the protected request with
`rate_limit_unavailable` and HTTP 503; it is never silently allowed through.

## Monitoring And Alerts

Quota rejections and binding failures emit structured Worker logs:

```json
{"event":"barestash.rate_limit.exceeded","surface":"ingest_endpoint","method":"POST","path":"/ep_example/webhook","endpoint_id":"ep_example","status":429,"error_code":"rate_limit_exceeded"}
```

```json
{"event":"barestash.rate_limit.failed","surface":"mcp","method":"POST","path":"/mcp","status":503,"error_code":"rate_limit_unavailable"}
```

Logs intentionally omit client IPs, raw tokens, request bodies, and credential
headers. Invalid credentials never select a token bucket; they fall back to the
client-IP bucket, temporary SSE access always uses client IP, and browser OAuth
and Device Authorization surfaces use only client-IP keys. Browser events use
`surface: "oauth_sign_in"` or `surface: "device_approval"` and omit query data.
API authentication events use `surface: "pat_write"`, `surface: "refresh"`,
`surface: "device_creation"`, or `surface: "device_poll"`.

Authentication lifecycle logs use `barestash.auth.*` event names and a
whitelisted structured serializer. Alert on session-compromise and refresh-token
reuse events immediately. Operational logs may contain account, session, token,
authorization, and identity IDs plus provider names, but never raw tokens,
device/user codes, OAuth codes, cookies, or provider secrets.

Configure Workers Logs/Traces alerts with these initial rules:

- alert immediately on any `barestash.rate_limit.failed` or
  `barestash.configuration.invalid` event;
- alert on sustained `barestash.rate_limit.exceeded` growth by `surface`, using
  50 rejections in five minutes as the initial investigation threshold;
- correlate ingest rejections with D1 row growth, R2 storage growth, Worker
  errors, and request volume before changing a quota;
- review false positives for shared networks before lowering an IP-based limit.

Treat endpoint IDs as operational metadata. They may be logged for targeted
ingest/SSE investigation, but must not be combined with raw payload or secret
values.

## Tuning Workflow

Rate limits are public backend behavior. Change all of the following together:

1. the backend requirement policy table;
2. the owning local binding in `apps/api/wrangler.toml` or
   `apps/web/wrangler.toml`;
3. focused rate-limit tests and smoke verification;
4. this runbook and any alert thresholds affected by the change.

Run `just worker-build`, focused tests, and smoke verification. Rate Limit
bindings are simulated locally by Wrangler. Cloudflare counters are local to
each location and eventually consistent, so do not use them as exact global
accounting counters.

## WAF And Edge Protection

Workers rate limiting starts after a request reaches the Worker. Zone-level WAF
and edge rate-limiting rules provide an earlier protection layer. Configuration
of these rules is owned by the operator of each deployment.

For webhook hosts, prefer block or throttle actions for obvious abuse. Do not
use browser or JavaScript challenges unless every affected webhook provider is
known to support them.
