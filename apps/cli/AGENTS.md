# Barestash CLI Development Guide

## Purpose

This guide applies to the Barestash CLI package. The CLI is the primary
interface for receiving webhooks, stashing incoming requests, and streaming
events to CLI users, scripts, and AI agents.

Keep CLI behavior aligned with the Barestash CLI design specification and
backend specification:

- `requirements/barestash-cli-design.spec.md`
- `requirements/barestash-backend.spec.md`

## Scope

These instructions apply to all files under `apps/cli/` unless a more specific
`AGENTS.md` exists deeper in the tree.

Use this guide when changing command parsing, endpoint selection,
authentication, API client behavior, output formatting, streaming behavior,
tests, fixtures, or package-level documentation for the CLI.

## CLI design principles

- Prefer predictable resource/action commands: `barestash {resource} {action}`.
- Optimize the default experience for humans using terminal-friendly output.
- Require explicit opt-in for machine-readable output, such as `--json`, except
  where a command-specific streaming contract requires machine output.
- Preserve raw request semantics from the backend. Do not invent client-side
  transformations that conflict with backend contracts.
- Make automation and AI-agent usage reliable: stable flags, stable JSON fields,
  and clean stdout/stderr separation.
- If behavior is unclear, do not create a new CLI contract silently. Update the
  relevant spec first, or leave a clear TODO that points to the spec decision
  needed.
- Keep the executable entry in `src/barestash.ts` and the named `runCli()` API
  in `src/cli.ts`. Do not introduce source `index.*` files or re-export
  facades.

## Command naming rules

Primary documented commands must use the resource/action form. The primary
command surface includes:

```text
barestash auth login
barestash endpoints create
barestash endpoints secrets create
barestash events list
barestash events latest
barestash events show
barestash events tail
barestash events stream
barestash tokens create
```

Do not introduce short top-level aliases such as `barestash tail` or
`barestash stream` as primary documented commands unless
`requirements/barestash-cli-design.spec.md` is updated first. Short aliases may
only be added after the design contract explicitly allows them.

When adding or renaming commands, check both CLI and backend specs for resource
names, endpoint semantics, authentication behavior, and output expectations.

## Output format rules

- Human-readable output is the default.
- Machine-readable output must be explicitly requested with a flag such as
  `--json`, or required by command-specific streaming behavior.
- JSON output should be stable, structured, and suitable for scripts and AI
  agents.
- Keep diagnostic logs, progress messages, and human guidance on stderr when
  stdout is reserved for structured data.
- `barestash events stream` must write only JSON Lines / NDJSON records to
  stdout so scripts and AI agents can consume it safely.
- `barestash events tail` may use human-friendly output by default, but any
  machine-readable mode must remain explicit and stable.

## Authentication and configuration expectations

Default endpoint resolution order is:

1. `--endpoint`
2. `BARESTASH_ENDPOINT`
3. Local CLI config
4. Actionable error explaining how to provide an endpoint

Local CLI config for a default endpoint is a deferred contract, not current
behavior, until the implementation lands. Current code resolves only
`--endpoint` and `BARESTASH_ENDPOINT`, and `--set-default` is explicitly not
implemented. Do not write tests or user docs that assume stored default
endpoints work before implementing that feature.

Token discovery order is:

1. `--with-token` where applicable
2. `BARESTASH_TOKEN`
3. Stored credentials

`barestash tokens create` requires an authenticated CLI session or scoped PAT
with `tokens:write`. Legacy bootstrap environment variables must not be read or
forwarded.

Temporary endpoints must not require authentication for read operations when the
endpoint is explicitly provided with `--endpoint`.

Private endpoint read operations require authentication.

Authentication and local configuration behavior must match
`requirements/barestash-cli-design.spec.md` and must not contradict
`requirements/barestash-backend.spec.md`.

## Error handling expectations

- CLI errors must be actionable and explain the next step when possible.
- Map backend error codes to user-friendly CLI messages without hiding important
  details.
- Preserve useful non-sensitive context such as endpoint ID, event ID, HTTP
  status, and backend error code.
- For machine-readable error modes, keep output structured and stable.
- Do not print stack traces for expected user or API errors unless an explicit
  debug mode requests them.

## Security rules

- Redact sensitive headers in CLI output and logs.
- Never log raw token values, endpoint secrets, `Authorization`, cookies, or
  `x-barestash-secret`.
- Never display `x-barestash-secret` in event output.
- Body content is not redacted by default by the CLI. Treat commands that
  display body content carefully and test them explicitly.
- Keep secrets out of snapshots, fixtures, debug logs, and error messages.
- If adding new sensitive fields or headers, update redaction tests in the same
  change.

## Testing and validation expectations

Cover these behaviors with tests when they are implemented or changed:

- Command parsing
- Endpoint resolution
- Token discovery
- JSON output
- JSONL stream output
- Redaction behavior
- Temporary endpoint unauthenticated reads
- Private endpoint authentication errors
- API error mapping

Prefer package-level test commands when working only in `apps/cli/`, and run
repository-level checks when changes can affect shared contracts. Use existing
package scripts or `just` targets before introducing new commands.

## Documentation update expectations

When adding or changing CLI behavior, update the appropriate source of truth in
the same change:

- CLI command contracts: `requirements/barestash-cli-design.spec.md`
- Backend/API behavior: `requirements/barestash-backend.spec.md`
- Technical operations or topology: `docs/`
- User-facing overview and usage: `README.md`

If the implementation, README, requirements, docs, or this guide disagree, do
not silently choose one. State the mismatch and resolve the source of truth
before normalizing behavior.
