# Agent Development Guide

This file is the entry point for coding agents working in `barestash`.
Use English for reasoning, explanations, plans, and final responses unless the user explicitly asks for another language. Keep technical identifiers, commands, API names, branch names, and PR titles exact.

## Read First

Consult these files according to the task:

- Product scope, MVP, and positioning: `requirements/barestash.spec.md`
- Identity, authentication, authorization, sessions, and Personal Access Tokens: `requirements/barestash-authentication-authorization.spec.md`
- CLI command design and endpoint/event/token command workflows: `requirements/barestash-cli-design.spec.md`
- Technical documentation ownership: `docs/README.md`
- Shared agent guardrails: `.agents/skills/references/coding-guardrails.md`
- Repository-specific workflows: `.agents/skills/`
- Codex subagent definitions: `.codex/agents/`

If `README.md`, `requirements/`, `docs/`, `AGENTS.md`, `.agents/skills/`, and the implementation disagree, do not silently choose one source. State the mismatch and resolve the direction before normalizing it.

## Product Stage

- Barestash is a pre-release product. Implementations that follow or update product specifications may include breaking changes.
- When a change breaks CLI commands, API contracts, event schemas, auth/token behavior, or local config, update the relevant source-of-truth documents and tests in the same change.

## Agent Rules

- Before work, run `git status --short --branch` and avoid damaging existing uncommitted changes.
- Never revert changes that may have been made by the user. Work with them when relevant.
- Keep changes scoped to the task. Avoid unrelated refactors, format churn, and metadata churn.
- Do not perform actions that affect external services, remote state, production data, tokens, secrets, or persistent storage without explicit user instruction.
- When the implementation stack, database, cloud provider, or deployment topology is undecided, do not invent requirements or document assumptions as source of truth.
- After changing code, configuration, scripts, or runtime behavior, the parent agent should request a `code-reviewer` subagent review. Address the feedback or document why it was not addressed in the final response or PR description.
- After changes, follow the verification guidance in `.agents/skills/references/coding-guardrails.md`. Report executed checks, skipped checks, and residual risk in the final response or PR description.

## Module Boundaries

- Do not add source `index.*` files or barrel modules. Import the module that
  owns a symbol instead of introducing an aggregate facade.
- Use `feature.ts` as a module's public entry and `feature/` for its private
  implementation when a module needs multiple files. Only the entry may import
  its private implementation; private files must not import the owning entry.
- Prefer named exports. Default exports are limited to Worker runtime entries
  and Vitest configuration.
- Do not re-export imported symbols. Define public symbols in their owning
  same-name entry file.
- Mark exports that are intentionally consumed from outside their directory
  with `@public`. Unmarked exports remain package-visible under Biome's
  `noPrivateImports` policy.
- Import `@barestash/shared` only through the explicit subpaths declared in
  `packages/shared/package.json`; the package has no root export.
- Keep the corresponding Biome rules green when changing module layout or
  exports.

## Repo Skills

Repository-specific workflows live in `.agents/skills/`. Codex subagents live in `.codex/agents/`.

| Skill | Codex subagent | Purpose |
| --- | --- | --- |
| `tdd-implement` | `tdd-implementer` | Test-first workflow for code, config, script, and runtime behavior changes |
| `code-review` | `code-reviewer` | Correctness, security, data contract, verification, and operational risk review |
| `docs-staleness-review` | `docs-staleness-reviewer` | Drift review for README, requirements, docs, agent workflows, and implementation |
| `grill-me` | none | General skill for stress-testing plans and design decisions through questions |

Use `$tdd-implement` by default for `implement`, `fix`, and `refactor` tasks that change code behavior.
Do not use `$tdd-implement` for prose-only documentation edits to `requirements/`, `docs/`, `AGENTS.md`, `README`, or similar files.

## Documentation Ownership

- Product concept, scope, MVP, positioning, and design principles: `requirements/barestash.spec.md`
- Identity, authentication, authorization, sessions, token security, and scope behavior: `requirements/barestash-authentication-authorization.spec.md`
- CLI commands, output formats, endpoint selection, credential discovery UX, and error presentation: `requirements/barestash-cli-design.spec.md`
- Technical design, operations, topology, and runbooks: `docs/`
- Project overview: `README.md`
- Agent workflows, review workflows, and verification guardrails: `.agents/skills/` and `.codex/agents/`

When adding a new command, script, runtime, deployment, storage layer, or API surface, update the relevant source of truth in the same change.

## Cursor Cloud specific instructions

The canonical dev environment is Nix + direnv, and it is already provisioned in the Cloud VM. Standard commands (`just install`, `just check`, `just test`, `just dev-api`, `just dev-cli`, `just barestash ...`) are documented in `README.md`; the notes below only cover non-obvious Cloud caveats.

- Nix was installed via the Determinate installer with `--init none` (no systemd). The Nix daemon is therefore not a boot service; it is auto-started from `~/.bashrc` on the first interactive login shell (guarded by the daemon socket). In a fresh interactive shell, `nix` and `direnv` are on `PATH` and `direnv` auto-loads the flake dev shell (node 24, pnpm, just) when you `cd` into the repo.
- If a `nix`/`direnv` command fails with `cannot connect to socket at '/nix/var/nix/daemon-socket/socket'`, the daemon is not running. Start it once with: `sudo /nix/var/nix/profiles/default/bin/nix-daemon &`.
- For non-interactive/scripted runs (which do not source `~/.bashrc`), invoke tools through the dev shell explicitly, e.g. `direnv exec /workspace just check` or `nix --extra-experimental-features "nix-command flakes" develop --command just check`.
- The startup update script runs `pnpm install --frozen-lockfile` (equivalent to `just install`) using the VM's pre-installed pnpm (node 22). This only refreshes dependencies; the produced `node_modules` is compatible with the node-24 Nix toolchain used to run and test the code.
- `apps/api` runs on `wrangler dev` at `http://localhost:8787`. `just dev-api` applies local D1 migrations and starts Wrangler with D1/R2/Durable Object bindings persisted under `apps/api/.wrangler/state`; captured endpoint/event metadata and raw bodies survive process restarts when that state directory is reused. Durable Objects provide local endpoint-scoped stream coordination but are not the source of truth for event history or cursors. Run `just reset-api-state` to delete that directory and reset local backend state. The CLI defaults to `BARESTASH_API_URL=http://localhost:8787`.
- Temporary endpoints are public-read (no auth). Private endpoints require token-authenticated reads and may use endpoint ingest secrets, so the simplest local end-to-end smoke test still uses `barestash endpoints create --temporary` plus a webhook POST to the ingest URL.
