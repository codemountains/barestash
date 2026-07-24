# Security Policy

This document describes how to report security vulnerabilities in Barestash
and what maintainers will do after receiving a report.

Barestash is a pre-release product. Security expectations may change as
releases and support windows are defined. Prefer the latest `main` commit
(or the newest published release, when releases exist) when validating
issues.

## Supported Versions

| Version | Supported |
| --- | --- |
| Latest `main` | Yes |
| Latest published release (when available) | Yes |
| Older commits or releases | No |

Until a stable release series exists, security fixes land on `main` and are
included in the next release. Older snapshots are not backported by default.

## Reporting a Vulnerability

**Do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Please report vulnerabilities privately using GitHub private vulnerability
reporting:

[https://github.com/codemountains/barestash/security/advisories/new](https://github.com/codemountains/barestash/security/advisories/new)

If that form is unavailable, contact a repository maintainer through a
private channel and ask how to submit the report. If you must reach
maintainers first without a private channel, send only a non-sensitive note
that you need to file a private security report. Do not open a public GitHub
issue for the vulnerability itself, and do not include exploit details,
credentials, or private payload contents outside private reporting.

When reporting, include as much of the following as you can:

- Affected version, tag, or commit SHA
- Description of the issue and why it is security-sensitive
- Steps to reproduce, or a minimal proof of concept
- Potential impact (for example unauthorized access to private endpoint
  events, token theft, or privilege escalation)
- Any suggested mitigation or fix, if known

Redact live Personal Access Tokens, session credentials, and endpoint ingest
secrets unless the private reporting channel expressly requests them. Prefer
redacting endpoint IDs/URLs and real captured payloads for privacy.

## Response Process

After receiving a private report, maintainers will:

1. Acknowledge the report.
2. Assess whether the report is a vulnerability, needs more information, or
   is out of scope.
3. Work on a fix for confirmed issues and coordinate disclosure timing with
   the reporter when practical.
4. Publish a GitHub Security Advisory for validated, fixed issues when
   appropriate.

There is currently **no bug bounty program**.

## Disclosure Policy

We prefer coordinated disclosure:

- Please keep vulnerability details private until a fix is available or we
  agree on a disclosure plan.
- After a fix is released, we may publish a GitHub Security Advisory and
  request a CVE when that is warranted.
- We credit reporters in advisories or release notes unless anonymity is
  requested.

## Scope

### In scope

Security issues in this repository that affect Barestash confidentiality,
integrity, or authorization boundaries, including:

- Authentication or authorization bypasses for private-endpoint **reads**,
  account APIs, token APIs, session handling, or management operations
- Bypass of a **required** private-endpoint ingest secret after one has been
  configured
- Disclosure or theft of Personal Access Tokens, refresh tokens, CLI session
  credentials, or endpoint ingest secrets
- Cross-account or cross-endpoint access to another account's private events
  or raw request bodies
- Privilege escalation through token scopes, device authorization, or
  identity linking
- Injection or remote code execution reachable through Barestash APIs, CLI
  command parsing of untrusted input, or ingest handling within the
  project's trust boundaries
- Enumeration or guessing of temporary endpoint IDs that lets an attacker
  discover or read endpoints they were not given

### Out of scope

The following are generally **not** treated as Barestash vulnerabilities:

- Issues that depend only on compromised maintainer machines, CI secrets,
  or attacker-writable local developer environments
- Social engineering of maintainers or users
- Denial-of-service without a specific, durable amplification or
  authentication bypass
- Vulnerabilities solely in third-party dependencies, unless Barestash usage
  introduces an additional, project-specific exposure that needs a Barestash
  advisory
- Misconfigurations that deliberately weaken security, such as exposing
  local `wrangler` state, tokens, or private endpoint credentials
- Expected **temporary** endpoint behavior: public-by-URL ingest and read
  access when the `endpoint_id` is already known
- Expected **private** endpoint ingest behavior: URL-reachable webhook
  receiving without authentication when no active ingest secret is configured
  (authenticated access is required for private-endpoint reads and
  management)

If you are unsure whether something is in scope, report it privately anyway.

## Preferred Hardening

When integrating or operating Barestash:

- Prefer private endpoints and scoped Personal Access Tokens for
  non-public workloads
- Configure an active ingest secret (`x-barestash-secret`) on private
  endpoints that must reject unauthenticated webhook ingest
- Rotate or revoke leaked tokens and endpoint ingest secrets promptly
- Treat temporary endpoint ingest URLs and public-by-URL event access as
  untrusted capability URLs / shared surfaces
- Keep local CLI credentials, Wrangler state, and captured payloads out of
  public repositories and logs
