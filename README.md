# Barestash

## Development Environment

Barestash uses Nix flakes with direnv and nix-direnv for the local development
environment.

Prerequisites:

- Nix with flakes support
- direnv with a shell hook enabled
- nix-direnv

Initial setup:

```bash
direnv allow
just install
```

Manual shell entry:

```bash
nix develop
```

Checks:

```bash
just ci
just ci-full
just fix
just nix-check
```

Individual recipes are also available:

```bash
just format
just lint
just check
just test
just test-e2e
just coverage
just typecheck
just worker-build
just nix-fmt
```

Local development commands:

```bash
just barestash --help
just dev-api
just dev-api-fresh
just dev-web
just dev-cli
just reset-api-state
just d1-query "SELECT id, mode FROM endpoints LIMIT 5;"
just r2-get events/ep_.../2026/07/10/evt_.../body.raw
```

`just dev-api` starts the API Worker with Wrangler local D1/R2/Durable Object
bindings persisted under `apps/api/.wrangler/state`. `just dev-web` starts the
browser-authentication Worker at `http://localhost:8788` and shares that local
D1 state. Copy each package's `.dev.vars.example` to `.dev.vars` first and use
the same local credential pepper for both Workers. Run `just reset-api-state`
to delete the directory and reset local D1, R2, Durable Object, Better Auth
adapter-table, and browser-session state. See
[`docs/local-cloudflare-development.md`](docs/local-cloudflare-development.md)
for local secret setup, migration, and inspection commands.

This repository contains the Worker source, Wrangler bundle inputs, migrations,
and local development configuration needed to build and run Barestash.

Use `just` recipes as the canonical project command surface. Recipes may wrap
pnpm scripts internally, but day-to-day command examples should prefer `just`.

Codex local environment configuration lives in
`.codex/environments/environment.toml`. Its setup script runs `just install`,
and its configured actions enter the Nix dev shell before running the same
`just` recipes shown above.

Search recipes:

```bash
rg -n "temporary endpoint|private endpoint|events stream" requirements docs
rg -n "new Hono|app\\.get|app\\.post|/v1|/api/auth" apps/api apps/web packages
rg -n "runCli|barestash|auth|endpoints|events|tokens" apps/cli packages
rg -n "describe\\(|it\\(" apps packages
rg -n "authorization|cookie|x-barestash-secret|token|secret" apps packages requirements docs
```

Format Nix files with:

```bash
just nix-fmt
```

Update the pinned Nix inputs with:

```bash
nix flake update
just nix-check
```

If flakes are not enabled globally for manual `nix` commands, run them with:

```bash
nix --extra-experimental-features "nix-command flakes" develop
```

## Security

To report a vulnerability privately, see [`SECURITY.md`](SECURITY.md).
Do not open public GitHub issues for security reports.

## License

This project is licensed under the [MIT license](LICENSE).
