# @barestash/cli

**A headless stash for incoming requests.**

Receive webhooks, stash raw HTTP requests, and stream events to your terminal, scripts, or AI agents.

```text
External service → Barestash endpoint → Raw request stashed → CLI / JSONL stream
```

## Install

```bash
npm install -g @barestash/cli
```

Requires Node.js 20 or later.

## Quick start

Create a temporary endpoint (no authentication required), watch for events, and send a test webhook:

```bash
# Create a temporary endpoint
barestash endpoints create --temporary

# Watch incoming events (use the endpoint ID from the previous command)
barestash events tail --endpoint ep_abc123

# In another terminal, send a test request to the webhook URL
curl -X POST https://ingest.example.com/ep_abc123/test \
  -H 'content-type: application/json' \
  -d '{"hello":"world"}'
```

For private endpoints and long-lived workflows, authenticate with a scoped
Personal Access Token (PAT) first. See
[Setting up authentication](#setting-up-authentication).

## Command structure

Commands follow a resource/action model:

```text
barestash {resource} {action}
```

Resources: `auth`, `endpoints`, `events`, `tokens`

```bash
barestash --help
barestash events --help
```

## Common workflows

### Watch events in the terminal

```bash
barestash events tail --endpoint ep_abc123
barestash events tail --endpoint ep_abc123 --last 10 --headers --body
```

Press `Ctrl+C` to stop watching. The command exits successfully without an
additional message.

### Stream events as JSON Lines for scripts and agents

`barestash events stream` writes one JSON object per line to stdout. Pipe it into your tools:

```bash
barestash events stream --endpoint ep_abc123 | jq .
```

Press `Ctrl+C` to stop streaming. The command exits successfully without
adding a non-JSONL line to stdout or a diagnostic to stderr.

### Inspect the latest captured request

```bash
barestash events latest --endpoint ep_abc123
barestash events show evt_01JDEF
```

### Manage private endpoints

```bash
barestash endpoints create --name github-dev
barestash endpoints list
barestash endpoints show ep_abc123
barestash endpoints secrets create --endpoint ep_abc123
```

## Commands

### Auth commands

| Command | Description |
| --- | --- |
| `barestash auth login` | Sign in through Barestash Device Authorization |
| `barestash auth login --with-token` | Validate and store a PAT from stdin |
| `barestash auth logout` | Remove locally stored credentials |
| `barestash auth logout --revoke` | Log out and revoke the current token |
| `barestash auth status` | Show authentication status (`--json` for machine output) |

Interactive login prints a one-time code, opens the approval page when possible,
and polls at the interval selected by the API. The resulting one-hour access
token is refreshed automatically from the rotating CLI session.

```bash
barestash auth login
echo "$BARESTASH_TOKEN" | barestash auth login --with-token
```

Credentials use the OS credential store by default (Keychain, Credential
Manager, or Secret Service). If it is unavailable, the CLI warns and falls back
to a plaintext credential file protected with restrictive user-only
permissions. Pass `--insecure-storage` to select that plaintext file explicitly.

### Tokens

| Command | Description |
| --- | --- |
| `barestash tokens create` | Issue a scoped PAT (`--name`, `--scope`, `--preset`, `--expires-in`, `--no-expiration`, `--json`) |
| `barestash tokens list` | List token metadata (`--all`, `--json`) |
| `barestash tokens revoke <token-id>` | Revoke a token (`--yes`) |

PAT secrets are shown once at creation time. Save them immediately. The default
scope preset is full access and the default expiration is 90 days. Use
`--preset read-only`, repeat `--scope`, or explicitly opt into
`--no-expiration` as needed.

### Endpoints

| Command | Description |
| --- | --- |
| `barestash endpoints create` | Create an endpoint (`--private`, `--temporary`, `--name`, `--json`) |
| `barestash endpoints list` | List your endpoints (`--json`) |
| `barestash endpoints show <endpoint-id>` | Show endpoint details (`--json`) |
| `barestash endpoints delete <endpoint-id>` | Delete a private endpoint (`--yes`) |
| `barestash endpoints secrets create` | Create an ingest secret (`--endpoint`, `--json`) |
| `barestash endpoints secrets list` | List ingest secrets (`--endpoint`, `--json`) |
| `barestash endpoints secrets revoke <secret-id>` | Revoke an ingest secret (`--endpoint`, `--yes`) |

#### Endpoint modes

| Mode | TTL | Max events | Auth to create | Auth to read |
| --- | --- | --- | --- | --- |
| Private (default) | 7 days | 1000 | Required | Required |
| Temporary (`--temporary`) | 24 hours | 100 | Not required | Not required when `--endpoint` is set |

Temporary endpoints are for short-term, non-sensitive debugging. Private endpoints support ingest secret verification via the `x-barestash-secret` header.

### Events

| Command | Description |
| --- | --- |
| `barestash events list` | List recent events (`--endpoint`, `--limit`, `--json`) |
| `barestash events latest` | Show the most recent event (`--endpoint`, `--json`) |
| `barestash events show <event-id>` | Show event details (`--json`) |
| `barestash events tail` | Follow new events (`--endpoint`, `--last`, `--headers`, `--body`, `--poll-interval`) |
| `barestash events stream` | Stream events as JSON Lines (`--endpoint`) |

Sensitive headers such as `Authorization` and `stripe-signature` are shown as `[REDACTED]` in CLI output.

## Setting up authentication

### Token discovery order

1. `BARESTASH_TOKEN` environment variable
2. Credentials stored by `barestash auth login` or
   `barestash auth login --with-token`

### Interactive and non-interactive setup

```bash
# Interactive CLI session
barestash auth login

# Store the token locally
export BARESTASH_TOKEN=bst_pat_...
echo "$BARESTASH_TOKEN" | barestash auth login --with-token

# Issue additional tokens for CI or agents
barestash tokens create \
  --name ci-github \
  --scope endpoints:read \
  --scope events:read \
  --expires-in 90d
```

Temporary endpoints do not require authentication when you pass `--endpoint` explicitly.

## Configuration

### Environment variables

| Variable | Description |
| --- | --- |
| `BARESTASH_API_URL` | Barestash API base URL (default: `http://localhost:8787`). Must use `http:` or `https:` without embedded credentials. Private and link-local addresses are rejected unless you pass `--allow-insecure-api-url` or set `BARESTASH_ALLOW_INSECURE_API_URL=1`. |
| `BARESTASH_ALLOW_INSECURE_API_URL` | Allow private or link-local `BARESTASH_API_URL` values. Equivalent to the global `--allow-insecure-api-url` flag. |
| `BARESTASH_TOKEN` | Scoped PAT or CLI access token for authenticated commands |
| `BARESTASH_ENDPOINT` | Default endpoint ID for event commands |
| `BARESTASH_CONFIG_FILE` | Override path to the local config file |

### Endpoint selection

Event commands resolve the target endpoint in this order:

1. `--endpoint <endpoint-id>` flag
2. `BARESTASH_ENDPOINT` environment variable

If no endpoint is selected, the CLI prints an actionable error.

### Local configuration and credentials

Non-secret configuration is stored in an OS-appropriate config directory:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/barestash/config.json` |
| Linux | `~/.config/barestash/config.json` |
| Windows | `%APPDATA%\barestash\config.json` |

Override with `BARESTASH_CONFIG_FILE` or `XDG_CONFIG_HOME`.

Secret credentials are stored in the OS credential store. Plaintext fallback
uses `credentials.json` beside the config file with mode `0600` on Unix-like
systems and a user-only ACL on Windows. Credential refresh and replacement use
a sibling lock file so multiple CLI processes cannot rotate the same refresh
token concurrently.

### API URL security

`BARESTASH_API_URL` controls where the CLI sends authenticated API requests.
Treat it like a secret-handling surface:

- Invalid schemes, embedded credentials, and private/link-local addresses are
  rejected before any authenticated request.
- Redirects are capped and re-validated so a compromised API cannot bounce the
  CLI toward metadata or internal-network hosts.
- The resolved API host is logged to stderr on first use.
- Use `--allow-insecure-api-url` only when you intentionally target a private
  API host on your network.

## Output formats

- Human-readable output is the default for interactive use.
- Pass `--json` for structured output suitable for scripts.
- `barestash events stream` always writes JSON Lines (NDJSON) to stdout for machine consumers.

Keep stdout reserved for structured data. Diagnostic messages go to stderr.

## Links

- Repository: [github.com/codemountains/barestash](https://github.com/codemountains/barestash)
- CLI design specification: [requirements/barestash-cli-design.spec.md](https://github.com/codemountains/barestash/blob/main/requirements/barestash-cli-design.spec.md)
