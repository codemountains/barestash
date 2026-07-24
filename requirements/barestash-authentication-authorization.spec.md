# Barestash Authentication and Authorization Specification

## Status

Implemented for the public OSS application as of July 2026.

The current source code and tests are the source of truth for implementation
status. This specification remains the source of truth for required behavior.

This document defines identity, authentication, authorization, CLI sessions, and Personal Access Token behavior for Barestash.

Related documents:

- `barestash.spec.md` defines the product concept and positioning.
- `barestash-backend.spec.md` defines backend, storage, endpoint, event, and MCP behavior.
- `barestash-cli-design.spec.md` defines the CLI command surface and user-facing behavior.

When authentication or authorization behavior conflicts with an older requirement in another document, this specification is the source of truth.

## Product Summary

Barestash is a headless stash for incoming requests.

```text
Receive webhooks
    ↓
Stash raw requests
    ↓
Stream events to CLI or AI agents
```

Authentication and authorization must preserve the following product properties:

- temporary endpoints remain usable without registration
- private endpoints require authenticated access
- CLI login works in local, SSH, container, and remote development environments
- CI jobs, scripts, AI agents, and MCP clients can authenticate non-interactively
- credentials are revocable, scoped, and never stored in plaintext by the backend
- users can sign in with GitHub or Google
- the primary product flow does not depend on a dashboard

---

## 1. Goals

The MVP must support:

- GitHub sign-in
- Google sign-in
- Better Auth for browser authentication and sessions
- automatic account creation on first sign-in
- Barestash-managed Device Authorization Flow for interactive CLI login
- short-lived CLI access tokens
- rotating CLI refresh tokens
- Personal Access Tokens for non-interactive clients
- user-selectable Personal Access Token scopes
- immediate token and session revocation
- private endpoint ownership checks
- temporary endpoint public-by-URL access
- consistent REST, SSE, CLI, and MCP authorization

---

## 2. Non-Goals for MVP

The MVP does not include:

- email and password authentication
- password reset flows
- passkeys
- multi-factor authentication managed directly by Barestash
- enterprise SAML or SCIM
- organization or workspace membership
- role-based team access control
- automatic identity linking by email address
- delegated third-party OAuth clients
- a general-purpose OAuth authorization server
- OAuth 2.1 authorization for Remote MCP clients
- fine-grained endpoint-specific Personal Access Token restrictions

---

## 3. Authentication and Authorization Boundaries

Authentication answers:

```text
Who is making this request?
```

Authorization answers:

```text
What may this authenticated principal do?
```

### Authentication responsibilities

- authenticate a browser user through GitHub or Google
- resolve or create the corresponding Barestash account
- authenticate CLI access tokens
- authenticate Personal Access Tokens
- validate refresh tokens during rotation
- validate Better Auth browser sessions

### Authorization responsibilities

- validate required scopes
- enforce private endpoint ownership
- allow public-by-URL access to temporary endpoints
- prevent one account from accessing another account's private resources
- apply the same access rules to REST, SSE, CLI, and MCP operations

---

## 4. Authentication Architecture

The MVP uses three authentication surfaces.

```text
Browser authentication
  └─ app.{domain} browser worker
     └─ GitHub / Google through Better Auth

Interactive CLI authentication
  └─ Barestash Device Authorization Flow
     └─ short-lived access token
     └─ rotating refresh token

Non-interactive authentication
  └─ Personal Access Token
     └─ CI / scripts / AI agents / MCP
```

### Component responsibilities

| Component | Responsibility |
| --- | --- |
| `app.{domain}` browser worker | Better Auth routes, provider callbacks, browser sessions, and Device Authorization approval UI |
| API worker | Device Authorization and token APIs, account status, REST, SSE, and MCP |
| Better Auth | GitHub and Google OAuth, browser sessions, OAuth callbacks, CSRF protection |
| Barestash auth service | Device Authorization Flow, CLI sessions, access tokens, refresh tokens, Personal Access Tokens, current-account status |
| D1 | Accounts, identities, sessions, authorizations, token metadata, revocation state |
| Cloudflare Secrets | Token hashing pepper and OAuth provider secrets |
| CLI credential store | Raw access and refresh tokens for the local CLI session, and stored PATs from `auth login --with-token` |
| Authorization middleware | Scope and resource ownership enforcement |

Better Auth confirms the browser user's identity. Barestash decides which CLI, API, SSE, and MCP operations that account may perform.

The browser application is an independent Cloudflare Worker deployed at
`app.{domain}`. It shares the Barestash D1 database and auth-domain contracts
with the API worker, but its Better Auth adapter tables have a separately
deployable migration boundary owned by the browser application.

---

## 5. Identity Providers

The MVP supports:

```text
GitHub
Google
```

Users do not explicitly register before signing in.

```text
first successful sign-in
  → create Barestash account and provider identity

subsequent successful sign-in
  → resolve existing provider identity and account
```

The CLI command remains:

```bash
barestash auth login
```

There is no separate `auth signup` command.

Barestash must identify provider identities using stable provider-issued identifiers.

```text
GitHub: immutable GitHub user ID
Google: OpenID Connect `sub`
```

Email addresses must not be used as the primary identity key.

---

## 6. Account and Identity Model

A Barestash account may have one or more linked provider identities.

```text
account
  ├─ GitHub identity
  └─ Google identity
```

### Account schema

```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  primary_email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  status TEXT NOT NULL, -- active | disabled
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### Identity schema

```sql
CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL, -- github | google
  provider_subject TEXT NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  UNIQUE(provider, provider_subject),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);
```

Better Auth uses its own adapter tables. A browser-account mapping resolves a
Better Auth user to a Barestash domain account without treating either record as
the other:

```sql
CREATE TABLE better_auth_account_mappings (
  id TEXT PRIMARY KEY,
  better_auth_user_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY (account_id) REFERENCES accounts(id)
);
```

The Better Auth adapter tables and the Barestash auth-domain tables must remain
in separate migration boundaries so the browser worker can deploy its adapter
schema independently. The domain model must preserve the separation between
Barestash accounts, provider identities, browser accounts, and browser-account
mappings.

A disabled account must not create or refresh CLI sessions, use tokens, access private resources, or approve Device Authorization requests.

---

## 7. Identity Linking

Barestash must not automatically merge GitHub and Google identities solely because their email addresses match.

The MVP may defer identity linking entirely.

A future linking flow must require:

1. an already authenticated Barestash account
2. explicit user intent to link another provider
3. successful authentication with the second provider
4. confirmation that the provider identity is not already linked to another account

---

## 8. Browser Authentication

Browser authentication uses Better Auth with GitHub and Google.

The browser authentication surface is served by the independent `app.{domain}`
worker. OAuth provider access and refresh tokens are not Barestash credentials
and must be removed before Better Auth adapter persistence. D1 may retain stable
provider identity and profile fields needed for account resolution, but it must
not contain GitHub or Google access or refresh tokens.

Browser sessions are used for:

- Device Authorization approval
- Device Authorization denial
- future account settings
- future session and token management UI

Browser session cookies must be configured with:

```text
Secure
HttpOnly
SameSite=Lax or stricter where compatible
```

Production cookies must not be issued over insecure HTTP.

The browser sign-in surface should provide:

```text
Sign in to Barestash

[ Continue with GitHub ]
[ Continue with Google ]
```

Open redirects must not be allowed.

---

## 9. Interactive CLI Authentication

Interactive CLI login uses a Barestash-managed Device Authorization Flow.

The CLI does not directly run GitHub or Google Device Flow.

```text
CLI
  ↓ Barestash Device Authorization Flow
Barestash
  ↓ Better Auth browser sign-in
GitHub / Google
```

This supports local terminals, SSH sessions, containers, remote development environments, and headless hosts.

### CLI user experience

```console
$ barestash auth login

Open this URL in your browser:

  https://app.example.com/device

Enter this one-time code:

  JKLM-PQRS

Waiting for authorization...

✓ Authenticated as user@example.com
```

The CLI should open `verification_uri_complete` automatically when possible, while always printing the verification URL and user code.

---

## 10. Device Authorization API

Recommended endpoints:

```http
POST /v1/auth/device/authorizations
POST /v1/auth/device/token

GET  /device
POST /device/approve
POST /device/deny
```

### Create Device Authorization

```http
POST /v1/auth/device/authorizations
Content-Type: application/json
```

When the browser approval Worker is not deployed, the API must not advertise a
verification URI. Device Authorization creation returns HTTP `503` with
`device_authorization_unavailable`; other API surfaces remain available.

Example request:

```json
{
  "client_name": "barestash-cli",
  "client_version": "0.1.0",
  "device_name": "kazuno-macbook",
  "requested_scopes": [
    "endpoints:read",
    "endpoints:write",
    "events:read",
    "tokens:read",
    "tokens:write",
    "mcp:use"
  ]
}
```

Example response:

```json
{
  "device_code": "bst_device_...",
  "user_code": "JKLM-PQRS",
  "verification_uri": "https://app.example.com/device",
  "verification_uri_complete": "https://app.example.com/device?code=JKLM-PQRS",
  "expires_in": 600,
  "interval": 5
}
```

### Poll Device Token

```http
POST /v1/auth/device/token
Content-Type: application/json
```

```json
{
  "device_code": "bst_device_..."
}
```

Pending response:

```json
{
  "error": {
    "code": "authorization_pending",
    "message": "Authorization is still pending."
  }
}
```

Approved response:

```json
{
  "access_token": "bst_access_...",
  "refresh_token": "bst_refresh_...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token_expires_in": 7776000,
  "scopes": [
    "endpoints:read",
    "endpoints:write",
    "events:read",
    "tokens:read",
    "tokens:write",
    "mcp:use"
  ]
}
```

### Scope grant rules

- `requested_scopes` must contain only supported scope names. Unknown or unsupported scopes must be rejected when the Device Authorization is created, before a user code is issued.
- Approval grants exactly the requested scopes. The resulting CLI session and its access tokens receive `requested_scopes`, no more and no less.
- The approval page must display the same scopes that will be granted.
- The approved token response includes the granted `scopes` so the CLI can display them without an extra request.

---

## 11. Device Authorization State

### Device Authorization Schema

```sql
CREATE TABLE device_authorizations (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code_hash TEXT NOT NULL UNIQUE,
  account_id TEXT,
  client_name TEXT NOT NULL,
  client_version TEXT,
  device_name TEXT,
  status TEXT NOT NULL,
  requested_scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  poll_interval_seconds INTEGER NOT NULL,
  last_polled_at TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  denied_at TEXT,
  consumed_at TEXT,

  FOREIGN KEY (account_id) REFERENCES accounts(id)
);
```

Supported states:

```text
pending
approved
denied
consumed
expired
```

### State transitions

```text
pending
  ├─ approve → approved
  ├─ deny    → denied
  └─ timeout → expired

approved
  └─ successful token exchange → consumed
```

A Device Authorization must be single-use.

```text
user_code
  human-readable lookup and approval code

device_code
  high-entropy secret held by the CLI
```

Recommended values:

```text
Device Authorization lifetime: 10 minutes
Polling interval: 5 seconds
```

Recommended user code format:

```text
XXXX-XXXX
```

- 8 characters drawn from an unambiguous uppercase alphabet of about 20 characters, excluding easily confused characters such as `0`, `O`, `1`, `I`, and `L`.
- This yields roughly 34 bits of entropy, which combined with the 10 minute lifetime, single-use transition, and user code rate limits keeps brute-force attempts impractical.
- The hyphen is display formatting. Lookup should normalize case and ignore separators.

---

## 12. Device Approval

The browser approval page must display:

- authenticated account
- client name
- device name when provided
- requested scopes
- one-time user code
- expiration information

Approval requires:

- a valid Better Auth browser session
- a pending, unexpired user code
- explicit user confirmation
- an atomic transition from `pending` to `approved`

`POST /device/approve` and `POST /device/deny` are cookie-authenticated state-changing endpoints and must require a CSRF token. SameSite cookie settings are defense in depth, not the primary CSRF protection for these endpoints.

A disabled account must not approve a Device Authorization.

---

## 13. CLI Session Model

One successful `barestash auth login` creates one CLI session.

### CLI Session Schema

```sql
CREATE TABLE cli_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_name TEXT,
  client_version TEXT,
  status TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  compromised_at TEXT,

  FOREIGN KEY (account_id) REFERENCES accounts(id)
);
```

Supported states:

```text
active
revoked
compromised
expired
```

Recommended expiration:

```text
Idle expiration: 30 days since the last successful refresh
Absolute expiration: 90 days since Device Authorization approval
```

The absolute expiration must not be extended by refresh operations. After expiration, the user must run `barestash auth login` again.

---

## 14. CLI Access Tokens

CLI API requests use short-lived bearer access tokens.

```http
Authorization: Bearer bst_access_...
```

Recommended lifetime:

```text
1 hour
```

Recommended format:

```text
bst_access_<token-id>_<secret>
```

### Token string grammar

All Barestash bearer token strings share the grammar:

```text
bst_<type>_<token-id>_<secret>
```

- `<type>` is `access`, `refresh`, or `pat`.
- `<token-id>` and `<secret>` contain only alphanumeric characters and never contain underscores, so splitting the raw token on underscores is unambiguous.
- `<token-id>` is the credential's record identifier without any type prefix. Clients reconstruct API resource ids such as `tok_<token-id>` when needed.

### Access Token Schema

```sql
CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,

  FOREIGN KEY (session_id) REFERENCES cli_sessions(id)
);
```

Access tokens do not carry their own scopes. Scope resolution during verification reads `cli_sessions.scopes_json` for CLI access tokens and `personal_access_tokens.scopes_json` for PATs, so the session is the single source of truth for interactive scopes.

The MVP uses opaque access tokens rather than JWTs to support immediate revocation, session-level revocation, immediate scope enforcement, and shared verification infrastructure with Personal Access Tokens.

---

## 15. CLI Refresh Tokens

Refresh tokens are used only to obtain new CLI access and refresh tokens. They must not be accepted as bearer credentials for normal REST, SSE, or MCP requests.

Recommended format:

```text
bst_refresh_<token-id>_<secret>
```

### Refresh Token Schema

```sql
CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_family_id TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_token_id TEXT,
  replaced_by_token_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,

  FOREIGN KEY (session_id) REFERENCES cli_sessions(id)
);
```

Supported states:

```text
active
used
revoked
expired
```

Refresh tokens rotate on every successful refresh.

```text
Refresh Token A
  ↓ successful refresh
Access Token B + Refresh Token B
  ↓
Refresh Token A becomes used
```

All refresh tokens derived from the same login belong to one token family.

---

## 16. Refresh API

```http
POST /v1/auth/token/refresh
Content-Type: application/json
```

Request:

```json
{
  "grant_type": "refresh_token",
  "refresh_token": "bst_refresh_..."
}
```

Response:

```json
{
  "access_token": "bst_access_new_...",
  "refresh_token": "bst_refresh_new_...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token_expires_in": 7776000
}
```

A successful refresh must atomically:

1. verify the current refresh token
2. verify the account and CLI session are active
3. verify idle and absolute session expiration
4. mark the old refresh token as `used`
5. create a new access token
6. create a new refresh token in the same family
7. update session activity and idle expiration
8. return the new raw token values once

---

## 17. Refresh Token Reuse Detection

Presenting a previously used refresh token indicates token theft or a client concurrency error.

The backend must:

1. mark the CLI session as `compromised`
2. revoke all access tokens for the session
3. revoke all refresh tokens in the token family
4. reject further refresh attempts
5. require a new Device Authorization Flow

Error example:

```json
{
  "error": {
    "code": "refresh_token_reuse_detected",
    "message": "The CLI session has been revoked. Sign in again."
  }
}
```

---

## 18. Concurrent Refresh Handling

Multiple CLI processes may share one credential store. To prevent valid concurrent processes from reusing the same refresh token, the CLI must use an inter-process credential lock.

```text
1. acquire credential lock
2. reload credentials
3. check whether refresh is still required
4. refresh if required
5. atomically replace stored credentials
6. release lock
```

The MVP server remains strict and does not provide a reuse grace period.

---

## 19. CLI Token Refresh Behavior

The CLI should proactively refresh when:

```text
access_token_expires_at - current_time <= 5 minutes
```

The CLI may also refresh once after receiving `401 access_token_expired`, then retry the original request once.

If refresh rotation succeeds but the rotated credential cannot be persisted,
the CLI must make a best-effort request with the new access token to revoke the
CLI session, clear the stale local credential, and surface the persistence
failure. This prevents an active remote session from becoming unmanageable
after its previous refresh token has been consumed.

The CLI must not automatically retry authentication for:

```text
invalid_token
token_revoked
personal_access_token_expired
session_revoked
session_expired
refresh_token_expired
refresh_token_reuse_detected
insufficient_scope
```

`access_token_expired` applies only to short-lived CLI access tokens and may trigger one refresh attempt. `personal_access_token_expired` applies only to Personal Access Tokens. Personal Access Tokens are not refreshable, so the CLI must not attempt refresh when it receives that code.

---

## 20. Personal Access Tokens

Personal Access Tokens are non-interactive credentials for:

- CI jobs
- scripts
- automation
- AI agents
- MCP clients
- headless processes

They are not refreshable.

```bash
export BARESTASH_TOKEN=bst_pat_...
barestash events stream
```

Recommended format:

```text
bst_pat_<token-id>_<secret>
```

The `<token-id>` and `<secret>` segments follow the shared token string grammar: alphanumeric only, no underscores. This lets the CLI resolve the PAT id from a stored raw token without calling the API.

### Personal Access Token Schema

```sql
CREATE TABLE personal_access_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,

  UNIQUE(account_id, id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);
```

The raw token must be shown only once at creation time.

---

## 21. Personal Access Token API

```http
POST   /v1/tokens
GET    /v1/tokens
DELETE /v1/tokens/{token_id}
```

Example creation request:

```json
{
  "name": "github-actions",
  "scopes": [
    "endpoints:read",
    "events:read"
  ],
  "expires_in": 7776000
}
```

`expires_in` is an integer number of seconds, consistent with the Device Authorization and refresh APIs.

- Omitting `expires_in` applies the default expiration (90 days).
- `"expires_in": null` explicitly requests a non-expiring token.
- Human-readable durations such as `90d` are a CLI input convenience. The CLI converts them to seconds before calling the API.

Example response:

```json
{
  "id": "tok_abc123",
  "name": "github-actions",
  "token": "bst_pat_...",
  "scopes": [
    "endpoints:read",
    "events:read"
  ],
  "expires_at": "2026-10-09T12:00:00.000Z",
  "created_at": "2026-07-11T12:00:00.000Z"
}
```

The `token` field must not appear in list responses. Revocation must be idempotent.

### Idempotent creation

`POST /v1/tokens` requires an `Idempotency-Key` header so network retries cannot mint duplicate tokens.

```http
POST /v1/tokens
Idempotency-Key: 6f6b2f2e-6d1c-4b1a-9d0e-2f6a3c4b5d6e
```

Rules:

- The client generates a unique key per logical creation attempt. The CLI generates a fresh key for each `barestash tokens create` invocation and reuses it only for its own internal retries.
- Retrying with the same key and an identical request body must not create a second token.
- Because the backend never stores raw tokens, a replayed request cannot return the raw token again. The replay response returns the created token's metadata without the `token` field. If the client never received the secret, it must revoke the token and create a new one with a new key.
- Reusing a key with a different request body must be rejected.
- Keys are scoped to the authenticated account. A retention window of 24 hours is recommended.

Idempotency records persist only request and credential metadata, never the raw
token:

```sql
CREATE TABLE pat_idempotency_records (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  token_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,

  UNIQUE(account_id, idempotency_key),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (account_id, token_id)
    REFERENCES personal_access_tokens(account_id, id)
);
```

### Self-revocation

`DELETE /v1/tokens/{token_id}` requires `tokens:write`, with one exception: when `{token_id}` identifies the Personal Access Token used to authenticate the request itself, the request must succeed regardless of the token's scopes.

Self-revocation only reduces privilege, so it must not require `tokens:write`. This keeps read-only PATs able to revoke themselves, for example during `barestash auth logout --revoke`.

### Scope subset enforcement

`POST /v1/tokens` requires `tokens:write` and must also enforce that every requested scope is already granted to the authenticated principal.

```text
requested_scopes ⊆ principal.scopes
```

Rules:

- A principal may mint a PAT only with scopes it already holds.
- `tokens:write` authorizes creation and revocation. It does not authorize requesting scopes the caller lacks.
- If any requested scope is outside the caller's grants, the backend must reject the request with `insufficient_scope` and must not create a token.
- Interactive CLI sessions that hold the standard CLI scope set can mint any MVP PAT scope, including broader automation tokens.
- Narrow PATs used by CI or agents cannot escalate by minting tokens with additional scopes.

There is no separate privileged minting API in the MVP. Broader PAT creation is available only through a principal that already holds those scopes, typically an interactive CLI session approved with the standard CLI scope set.

Unknown or unsupported scope names must be rejected.

---

## 22. Authorization Scopes

The MVP supports:

```text
endpoints:read
endpoints:write

events:read

tokens:read
tokens:write

mcp:use
```

| Scope | Permitted operations |
| --- | --- |
| `endpoints:read` | List and inspect owned private endpoints |
| `endpoints:write` | Create, update, delete, and manage secrets for owned private endpoints |
| `events:read` | List events, inspect metadata, read raw bodies, and consume SSE for authorized endpoints |
| `tokens:read` | List Personal Access Token metadata |
| `tokens:write` | Create and revoke Personal Access Tokens whose scopes are a subset of the caller's grants |
| `mcp:use` | Invoke MCP, subject to each tool's resource scope |

`events:read` includes access to raw event bodies and must be treated as sensitive.

`tokens:write` never grants scope escalation. A caller with only `tokens:write` may create or revoke PATs, but may request only scopes it already holds (for that caller, only `tokens:write` itself).

Self-revocation of the authenticated PAT is exempt from `tokens:write` as defined in the Personal Access Token API section.

MCP examples:

```text
list_endpoints
  → mcp:use + endpoints:read

create_endpoint
  → mcp:use + endpoints:write

list_events
  → mcp:use + events:read

get_event_body
  → mcp:use + events:read
```

Interactive CLI sessions receive exactly the scopes requested at Device Authorization creation and confirmed on the approval page.

`GET /v1/account` requires no scope. Any valid credential may read its own account and credential status.

The standard CLI scope set is the default set the CLI requests during `barestash auth login`:

```text
endpoints:read
endpoints:write
events:read
tokens:read
tokens:write
mcp:use
```

---

## 23. Personal Access Token Scope UX

Scope selection is included in the MVP.

```bash
barestash tokens create \
  --name github-actions \
  --scope endpoints:read \
  --scope events:read \
  --expires-in 90d
```

The CLI should also provide presets:

```text
read-only
full-access
custom
```

Recommended presets:

```text
read-only:
  endpoints:read
  events:read
  mcp:use

full-access:
  endpoints:read
  endpoints:write
  events:read
  tokens:read
  tokens:write
  mcp:use
```

The CLI must display the final resolved scopes before issuing a token in interactive mode.

The CLI must not submit requested scopes that exceed the current credential's grants. If the backend rejects creation with `insufficient_scope`, the CLI must surface that the requested scopes are broader than the authenticated principal allows.

Creating a `full-access` PAT therefore requires an authenticated principal that already holds the full-access scope set, such as an interactive CLI session.

---

## 24. Personal Access Token Expiration

Recommended options:

```text
30 days
90 days
1 year
no expiration
```

The default is 90 days.

Creating a non-expiring token requires an explicit option:

```bash
barestash tokens create --no-expiration
```

`--no-expiration` maps to `"expires_in": null` in the creation request.

The CLI should warn that the token will not expire automatically.

When an expired Personal Access Token is presented as a bearer credential, the backend must reject the request with `personal_access_token_expired`. It must not use `access_token_expired`, `token_revoked`, `invalid_token`, or `not_authenticated` for this case.

CLI handling:

- `barestash auth status` and `barestash auth login --with-token` must surface that the PAT has expired and that the user should create a new token with `barestash tokens create`.
- `barestash auth logout --revoke` treats `personal_access_token_expired` as confirmed remote success for a stored PAT, as defined in the logout section.
- Other commands must fail with an actionable expired-token message and must not attempt refresh.

---

## 25. Credential Hashing and Storage

The backend must never store raw access tokens, refresh tokens, Personal Access Tokens, device codes, or user codes.

Recommended hashing:

```text
HMAC-SHA-256(server pepper, raw token secret)
```

The pepper must be stored as a Cloudflare Secret.

Token records should be located using the public token ID and authenticated by comparing the derived secret hash in constant time.

Provider OAuth client secrets and the Better Auth secret must also use Cloudflare Secrets and must never be stored in D1 or committed to the repository.

---

## 26. CLI Credential Storage

The CLI should store interactive access and refresh tokens, and Personal Access Tokens stored by `barestash auth login --with-token`, in the operating system credential store when available.

| Platform | Preferred storage |
| --- | --- |
| macOS | Keychain |
| Windows | Credential Manager |
| Linux | Secret Service / libsecret |

Non-secret metadata may be stored in the Barestash config file.

The CLI follows GitHub CLI-style fallback behavior:

1. use the operating system credential store by default
2. if credential-store persistence fails, warn clearly and fall back to a local plaintext file only when restrictive permissions can be enforced
3. when `--insecure-storage` is specified, intentionally bypass the credential store, warn that plaintext storage is being used, and write the same restrictive local file

```text
Unix-like systems: mode 0600
```

The CLI must not log raw credentials.

The warning must identify where the plaintext credential was stored. A failed
keyring attempt must not silently discard a successfully authenticated session.

---

## 27. Authentication Precedence in the CLI

Recommended precedence:

1. explicit token supplied through `--with-token` where supported
2. `BARESTASH_TOKEN`
3. the stored credential (interactive CLI session or stored Personal Access Token)

### Stored credential model

The CLI keeps at most one stored credential per machine user configuration.

- A successful `barestash auth login` stores the interactive CLI session credentials and replaces any existing stored credential.
- A successful `barestash auth login --with-token` stores the provided Personal Access Token and replaces any existing stored credential.
- Replacement is local only. It does not revoke the replaced credential remotely. When replacing stored interactive session credentials, the CLI should warn and mention `barestash auth logout --revoke` as the way to revoke the previous session first.

A Personal Access Token supplied through `BARESTASH_TOKEN` must be used directly and must not be converted into a refreshable CLI session.

`barestash auth login --with-token` stores a Personal Access Token for CLI use but does not create a `cli_session` or refresh token.

---

## 28. Current Account API

Bearer-authenticated clients need a current-principal endpoint that works for both CLI access tokens and Personal Access Tokens.

```http
GET /v1/account
Authorization: Bearer <cli_access_token | personal_access_token>
```

No scope is required. Any valid CLI access token or Personal Access Token may call this endpoint, because the response only describes the calling principal itself.

Example response for an interactive CLI access token:

```json
{
  "account": {
    "id": "acc_abc123",
    "primary_email": "user@example.com"
  },
  "credential": {
    "type": "cli_access_token",
    "id": "atk_abc123",
    "session_id": "cls_abc123",
    "scopes": [
      "endpoints:read",
      "endpoints:write",
      "events:read",
      "tokens:read",
      "tokens:write",
      "mcp:use"
    ],
    "expires_at": "2026-07-11T13:00:00.000Z"
  }
}
```

Example response for a Personal Access Token:

```json
{
  "account": {
    "id": "acc_abc123",
    "primary_email": "user@example.com"
  },
  "credential": {
    "type": "personal_access_token",
    "id": "tok_abc123",
    "scopes": [
      "endpoints:read",
      "events:read"
    ],
    "expires_at": "2026-10-09T12:00:00.000Z"
  }
}
```

Rules:

- `GET /v1/account` is the source of truth for live authentication status.
- The response carries no `account.status` field. A disabled account is rejected during authentication with the `account_disabled` error, so a successful response always implies an active account.
- For Personal Access Tokens without expiration, `credential.expires_at` must be `null`.
- `credential.session_id` is present only for CLI access tokens tied to a `cli_session`.
- The response must not include raw secrets, refresh tokens, or browser session cookies.
- `barestash auth status` must call `GET /v1/account` and must not rely on `GET /v1/tokens` to infer the current principal.
- `barestash auth login --with-token` must validate the provided PAT by calling `GET /v1/account` before storing it.
- Device token exchange may optionally include account summary fields for immediate CLI display, but subsequent status checks must still use `GET /v1/account` so revocation and account disablement are visible.

`GET /v1/tokens` remains the PAT listing API and must not be used as a substitute for current-account status.

---

## 29. Private Endpoint Authorization

Private endpoints belong directly to one account in the MVP.

An authenticated principal may access a private endpoint only when:

1. the principal has the required scope
2. the endpoint belongs to the principal's account
3. the account and credential are active

```text
validate bearer credential
  ↓
resolve account_id and scopes
  ↓
validate required scope
  ↓
load endpoint
  ↓
verify endpoint.account_id == principal.account_id
  ↓
perform operation
```

Authorization must not rely on endpoint IDs being difficult to guess.

---

## 30. Temporary Endpoint Authorization

Temporary endpoints remain public-by-URL.

| Operation | Authentication required |
| --- | --- |
| Create temporary endpoint | No |
| Read temporary endpoint events | No |
| Read temporary event body | No |
| Consume temporary endpoint SSE | No |
| Delete temporary endpoint | Not supported |
| Manage temporary endpoint secrets | Not supported |

Temporary endpoints must not be attached to an account automatically after login. Converting a temporary endpoint into a private endpoint is not supported in the MVP.

Unauthenticated creation must be protected by IP rate limits, active endpoint limits, high-entropy endpoint IDs, TTL, event count limits, and received-byte limits.

---

## 31. Authorization Middleware

The backend should separate reusable authentication and authorization middleware.

```ts
authenticateAccessToken()
authenticatePersonalAccessToken()
authenticateBearerCredential()
requireAccount()
requireScope()
requireEndpointOwner()
requireRequestedScopesSubset()
```

`requireRequestedScopesSubset()` applies to `POST /v1/tokens` and rejects any requested scope not present on the authenticated principal.

```ts
type AuthPrincipal = {
  accountId: string;
  credential:
    | {
        type: "cli_access_token";
        id: string;
        sessionId: string;
        scopes: AuthorizationScope[];
        expiresAt: string;
      }
    | {
        type: "personal_access_token";
        id: string;
        scopes: AuthorizationScope[];
        expiresAt: string | null;
      };
};
```

Route handlers must not duplicate token parsing or ownership logic.

---

## 32. REST, SSE, and MCP Authorization

The same bearer authentication and authorization rules apply to REST, SSE, and MCP.

A private endpoint SSE stream must validate authorization before creating a subscriber connection.

The MVP should bound authenticated SSE connection duration so revoked credentials do not retain access indefinitely.

Recommended maximum duration:

```text
1 hour
```

The MVP MCP endpoint accepts Personal Access Tokens and valid CLI access tokens. Each MCP tool must enforce both `mcp:use` and its resource-specific scope.

---

## 33. Logout and Revocation

### Local logout

```bash
barestash auth logout
```

Local logout must clear all locally stored CLI authentication material for the current machine user configuration:

- stored interactive CLI access tokens
- stored interactive CLI refresh tokens
- stored Personal Access Tokens created by `barestash auth login --with-token`
- local session and authentication metadata

Rules:

- Do not revoke remote credentials during local logout.
- Do not clear or modify the `BARESTASH_TOKEN` environment variable. That value is owned by the calling shell or process environment.
- After local logout, subsequent CLI commands must not authenticate from previously stored credentials unless a new login occurs or `BARESTASH_TOKEN` / an explicit token is still provided.
- If either credential backend cannot be cleared, the CLI must atomically replace any remaining plaintext credential with a non-secret logout marker before reporting local logout success. While the marker exists, stored-credential resolution must not fall through to a potentially stale operating system credential.
- The logout marker is the only permitted exception to clearing local authentication metadata. It must contain no credential material and must be removed after a later successful credential-store cleanup or replaced as part of a subsequent successful login.

### CLI Session Revocation API

```http
POST /v1/auth/sessions/current/revoke
Authorization: Bearer <cli_access_token>
```

Rules:

- The caller authenticates with a valid access token belonging to the target session. Personal Access Tokens must be rejected for this endpoint.
- The backend revokes the CLI session, all access tokens for the session, and all refresh tokens for the session.
- The endpoint is idempotent when an authenticated request reaches the handler. Revoking an already revoked or expired session returns success.
- No request body is required, and the response must not include raw token values.

Because revocation invalidates the caller's access token, a retry that reuses the same token may fail authentication before the handler runs. Clients completing `barestash auth logout --revoke` must follow the revoke-retry rules below.

### Remote revocation with `--revoke`

```bash
barestash auth logout --revoke
```

Behavior depends on the locally resolved stored credential type:

| Stored credential | `--revoke` behavior |
| --- | --- |
| Interactive CLI session (access and refresh tokens) | Revoke the remote CLI session via `POST /v1/auth/sessions/current/revoke`, then remove local credentials |
| Stored Personal Access Token | Revoke that PAT via `DELETE /v1/tokens/{token_id}`, then remove local credentials |

Interactive CLI session revocation order:

```text
1. call POST /v1/auth/sessions/current/revoke
   (revokes the session and all access and refresh tokens for it)
2. after confirmed remote success, remove local credentials
```

Stored PAT revocation order:

```text
1. resolve the current PAT id locally from the stored token value
   (bst_pat_<token-id>_<secret>), or via GET /v1/account when needed
2. revoke that PAT via DELETE /v1/tokens/{token_id}
   (self-revocation succeeds regardless of the PAT's scopes)
3. after confirmed remote success, remove local credentials
```

### Revoke retry and idempotency

`barestash auth logout --revoke` must complete local credential removal even when the first remote revoke succeeds but the client never receives the success response.

During `--revoke` only, the CLI treats the following as **confirmed remote success** and proceeds to remove local credentials:

| Stored credential | Confirmed remote success |
| --- | --- |
| Interactive CLI session | Revocation endpoint returns success, or the stored access token receives `token_revoked`, `session_revoked`, or `session_expired` |
| Stored Personal Access Token | `DELETE /v1/tokens/{token_id}` returns success, or the stored PAT receives `token_revoked` or `personal_access_token_expired` |

Rules:

- These errors count as success only during `barestash auth logout --revoke`. They must not change normal command behavior for `token_revoked`, `personal_access_token_expired`, `session_revoked`, or `session_expired`.
- `not_authenticated`, `invalid_token`, network failures, and other unrelated errors are not success. The CLI should retry transient failures and surface persistent failures with an actionable message.
- If the stored credential is already unusable for reasons unrelated to a completed revoke (for example, compromise detection on another device), `--revoke` must still clear local credentials once the remote revoke attempt finishes or one of the success conditions above is met.

If no stored credential exists, `--revoke` must fail with an actionable error. A `BARESTASH_TOKEN` environment variable alone is not a stored credential for logout purposes.

Revocation endpoints must be idempotent when authenticated requests reach the handler. Client-side revoke-retry handling above completes logout when authentication fails because the credential was already revoked.

`barestash tokens revoke <token-id>` remains the admin-style command for revoking an arbitrary PAT by id and does not affect CLI sessions.

---

## 34. Rate Limiting and Abuse Protection

Rate limits must apply to:

- Device Authorization creation
- Device Token polling
- user code lookup
- approval and denial
- refresh token exchange
- OAuth sign-in initiation
- Personal Access Token creation and revocation

All quotas use a 60-second window and the same limits in local, staging, and
production environments:

| Surface | Key | Limit |
| --- | --- | ---: |
| OAuth sign-in initiation (GitHub or Google) | Client IP | 10/minute |
| Device Authorization creation | Client IP | 10/minute |
| Device Token polling | Client IP | 120/minute |
| User-code lookup, approval, and denial | Client IP | 10/minute |
| CLI refresh token exchange | Client IP | 10/minute |
| Personal Access Token creation and revocation | Verified credential ID, otherwise client IP | 10/minute |

PAT writes also pass through the shared 300/minute write-attempt IP ceiling
before the dedicated PAT quota. Dedicated OAuth, Device, refresh, and PAT
bindings must have distinct namespaces in each deployed environment.

Device Token polling must enforce the server-provided interval. Polling too frequently returns `slow_down` and may increase the required interval.

User code lookup must be protected against enumeration and brute force.

---

## 35. Audit and Logging

Authentication logs may include account ID, session ID, token ID, credential type, provider, event type, status code, error code, device name, and client version.

Authentication logs must not include raw tokens, raw device or user codes, OAuth authorization codes, provider secrets, or browser session cookies.

Structured authentication audit events use the `barestash.auth.` prefix:

```text
barestash.auth.account.created
barestash.auth.identity.created
barestash.auth.device_authorization.created
barestash.auth.device_authorization.approved
barestash.auth.device_authorization.denied
barestash.auth.cli_session.created
barestash.auth.cli_session.revoked
barestash.auth.cli_session.compromised
barestash.auth.access_token.refreshed
barestash.auth.refresh_token.reuse_detected
barestash.auth.personal_access_token.created
barestash.auth.personal_access_token.revoked
```

Each structured audit event uses an explicit allowlist. The serializer must
drop every property not listed for that event:

| Event | Allowed fields in addition to `event` |
| --- | --- |
| `account.created` | `account_id`, `provider` |
| `identity.created` | `account_id`, `identity_id`, `provider` |
| `device_authorization.created` | `device_authorization_id` |
| `device_authorization.approved`, `device_authorization.denied` | `account_id`, `device_authorization_id` |
| `cli_session.created` | `account_id`, `session_id`, `device_authorization_id` |
| `cli_session.revoked`, `cli_session.compromised` | `account_id`, `session_id` |
| `access_token.refreshed` | `account_id`, `session_id`, `access_token_id`, `refresh_token_id` |
| `refresh_token.reuse_detected` | `account_id`, `session_id`, `refresh_token_id` |
| `personal_access_token.created`, `personal_access_token.revoked` | `account_id`, `token_id` |

`provider` is the provider name (`github` or `google`), not a provider subject.
Raw and hashed credentials, codes, cookies, email addresses, provider subjects,
request bodies, and provider secrets are not allowed audit fields.

---

## 36. Error Response Shape

Authentication and authorization errors use the standard REST error shape.

```json
{
  "error": {
    "code": "insufficient_scope",
    "message": "This token does not have the required scope: events:read."
  }
}
```

Browser-facing routes (`/`, `/device`, `/device/approve`, `/device/deny`, and
`/sign-in/:provider`) may render an HTML error page when the request explicitly
accepts `text/html`. The same error must retain its documented HTTP status,
code, and message when the request does not accept HTML or explicitly accepts
`application/json`. Negotiated browser errors must send `Vary: Accept`, must
not be cached, and must not echo raw device or user codes. REST endpoints under
`/v1/*` and Better Auth endpoints under `/api/auth/*` continue to use their
documented machine-readable response contracts.

The same `insufficient_scope` code applies when `POST /v1/tokens` requests scopes outside the caller's grants. The message should identify at least one disallowed scope.

`personal_access_token_expired` is returned when a Personal Access Token's `expires_at` is in the past. It must not be used for CLI access or refresh tokens.

Recommended error codes:

```text
authorization_pending
authorization_denied
device_code_expired
device_code_consumed
device_authorization_unavailable
invalid_device_code
invalid_user_code
slow_down

not_authenticated
invalid_token
access_token_expired
token_revoked
personal_access_token_expired
insufficient_scope

refresh_token_expired
refresh_token_revoked
refresh_token_reuse_detected

session_expired
session_revoked
account_disabled
not_authorized

idempotency_key_required
idempotency_key_conflict
```

---

## 37. Security Requirements

The implementation must satisfy:

- OAuth and Better Auth secrets are stored only in Cloudflare Secrets
- raw Barestash tokens are never stored in D1
- token hashes use a server-side pepper
- token comparisons are constant time
- Device Authorizations are short-lived and single-use
- refresh tokens rotate on every successful use
- refresh token reuse revokes the full session family
- access tokens are short-lived
- Personal Access Tokens are scoped
- PAT creation enforces `requested_scopes ⊆ principal.scopes` and rejects escalation
- private endpoint authorization checks ownership, not URL secrecy
- user code endpoints are rate-limited
- device approval and denial endpoints require CSRF tokens
- redirect targets are validated
- browser sessions use secure cookie settings
- credentials are not written to logs
- token-creation responses are never cached

Token endpoints should include:

```http
Cache-Control: no-store
Pragma: no-cache
```

---

## 38. Better Auth Integration Boundaries

Better Auth is responsible for:

- GitHub OAuth
- Google OAuth
- browser session creation and validation
- OAuth callbacks
- provider account records
- browser sign-in CSRF protections

Barestash is responsible for:

- Device Authorization records and approval state
- CLI sessions
- CLI access and refresh tokens
- refresh rotation and reuse detection
- Personal Access Tokens
- scopes
- endpoint ownership authorization
- REST, SSE, and MCP authorization

Barestash must not expose Better Auth browser session tokens as CLI API credentials.

Better Auth runs only in the independent `app.{domain}` browser worker. Its
adapter tables are owned by that worker's migration boundary, while Barestash
auth-domain tables remain deployable with the API foundation. Provider access
and refresh tokens must be stripped before adapter persistence and must never be
written to D1 or logs.

A successful browser sign-in identifies the approving account but does not create a CLI session until the user explicitly approves the Device Authorization.

---

## 39. CLI Command Alignment

The intended command behavior is:

```bash
barestash auth login
barestash auth login --with-token
barestash auth logout
barestash auth logout --revoke
barestash auth status

barestash tokens create
barestash tokens list
barestash tokens revoke <token-id>
```

`barestash auth login` starts Device Authorization Flow, opens the browser when possible, polls using the server-provided interval, stores credentials securely, and reports account identity and session expiration.

`barestash auth login --with-token` validates the token with `GET /v1/account`, then stores that Personal Access Token without creating a refreshable CLI session.

`barestash auth status` must call `GET /v1/account` and display the account, credential type, expiration, scopes where applicable, and default endpoint.

`barestash auth logout` must clear stored interactive session credentials and stored PATs. `barestash auth logout --revoke` must revoke the remote credential that matches the stored credential type before clearing local state. If a revoke retry receives `token_revoked`, `personal_access_token_expired`, `session_revoked`, or `session_expired` for the stored credential, the CLI must treat that as confirmed remote success and still clear local credentials.

`barestash auth status` and `barestash auth login --with-token` must distinguish `personal_access_token_expired` from `token_revoked` and guide the user to create a new Personal Access Token.

---

## 40. Migration from Token-Only Authentication

The scoped-PAT cutover invalidates existing token-only credentials. New scoped
PATs are issued only to an authenticated CLI session or another scoped PAT with
`tokens:write`.

The auth-domain foundation migration intentionally preserves the existing
`tokens` table and running token-only path. `personal_access_tokens` is a
separate table and does not become authoritative until the scoped-PAT cutover.
The scoped-PAT cutover first prepares account ownership, deploys the common
principal Worker, and then runs an idempotent post-deploy finalizer that marks
legacy credentials revoked. The final authentication rollout removes all
bootstrap authentication configuration and code.

Target behavior:

```text
interactive human CLI use
  → Device Authorization Flow

automation and agent use
  → scoped Personal Access Token
```

Bootstrap authentication is unavailable in development, staging, and
production. The retired `x-barestash-bootstrap-token` header never authenticates
a request and remains classified as sensitive only so legacy senders cannot
cause it to be persisted or logged.

---

## 41. MVP Acceptance Criteria

The MVP is complete when it supports:

- GitHub and Google sign-in
- no automatic GitHub/Google identity linking based only on matching email
- automatic account creation on first sign-in
- Better Auth browser sessions
- Device Authorization creation, approval, denial, and polling
- short-lived opaque CLI access tokens
- rotating CLI refresh tokens
- refresh token reuse detection
- idle and absolute CLI session expiration
- secure CLI credential storage for interactive sessions and stored PATs
- proactive CLI token refresh
- local logout clearing stored interactive credentials and stored PATs
- current-session and current-PAT remote revocation through `auth logout --revoke`
- `GET /v1/account` for current principal status used by `auth status` and `auth login --with-token`
- Personal Access Token creation, scope selection, expiration, listing, and idempotent revocation
- PAT creation rejecting requested scopes outside the caller's grants
- private endpoint ownership enforcement
- temporary endpoint public-by-URL behavior
- REST, SSE, and MCP authorization
- structured authentication and authorization errors
- dedicated rate limits for OAuth, Device Flow, refresh, and PAT write endpoints
- bootstrap authentication unavailable in every environment
- no raw credential persistence or logging

---

## 42. Future Considerations

Potential future additions:

- an `account:read`-style scope if future account settings APIs expose more than the caller's own status
- explicit GitHub and Google identity linking
- account deletion and data export
- passkeys
- multi-factor authentication requirements
- workspace and team access control
- role-based authorization
- endpoint-specific Personal Access Token restrictions
- token usage audit UI
- browser-based session management
- Remote MCP OAuth 2.1
- delegated third-party clients
- authenticated SSE session revalidation

---

## 43. Final Design Summary

```text
GitHub / Google
       ↓
Better Auth
       ↓
Barestash account
       ↓
┌────────────────────────────────────┐
│ Browser session                    │
│ - Better Auth cookie               │
│ - Device Authorization approval    │
└────────────────────────────────────┘
       ↓
┌────────────────────────────────────┐
│ CLI Device Authorization Flow      │
│ - Device Authorization: 10 minutes │
│ - Access Token: 1 hour             │
│ - Refresh idle expiration: 30 days │
│ - Session absolute expiry: 90 days │
│ - Refresh token rotation           │
│ - Reuse detection                  │
└────────────────────────────────────┘
       ↓
Barestash CLI / REST / SSE / MCP

Separate non-interactive path:

Personal Access Token
- user-selected scopes
- user-selected expiration
- CI / scripts / AI agents / MCP
```
