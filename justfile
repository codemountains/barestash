set shell := ["sh", "-eu", "-c"]
set default-list
set minimum-version := "1.55.0"

api_wrangler_state := "apps/api/.wrangler/state"

import 'just/cloudflare.just'

[doc('Install workspace dependencies with a frozen lockfile')]
[group('setup')]
install:
    pnpm install --frozen-lockfile

[doc('Run typecheck, biome, markdownlint, and unit tests')]
[group('quality')]
check:
    pnpm check

[doc('Auto-fix formatting and markdown issues')]
[group('quality')]
fix: format lint-md-fix

[doc('Format source files with Biome')]
[group('quality')]
format:
    pnpm format

[doc('Lint source files with Biome')]
[group('quality')]
lint:
    pnpm lint

[doc('Lint markdown files')]
[group('quality')]
lint-md:
    pnpm lint:md

[doc('Auto-fix markdown lint issues')]
[group('quality')]
lint-md-fix:
    pnpm lint:md:fix

[doc('Run unit tests')]
[group('quality')]
test:
    pnpm test

[doc('Run CLI/API smoke e2e tests')]
[group('quality')]
test-e2e:
    pnpm test:e2e

[doc('Run unit tests with coverage reporting')]
[group('quality')]
coverage:
    pnpm test:coverage

[doc('Run TypeScript type checks across the workspace')]
[group('quality')]
typecheck:
    pnpm typecheck

[doc('Validate API and web Worker bundles with Wrangler')]
[group('quality')]
worker-build:
    WRANGLER_WRITE_LOGS=false pnpm exec wrangler deploy --config apps/api/wrangler.toml --env="" --dry-run
    WRANGLER_WRITE_LOGS=false pnpm exec wrangler deploy --config apps/web/wrangler.toml --env="" --dry-run

[doc('Verify justfile formatting')]
[group('quality')]
[private]
_check-justfile:
    just --fmt --check

[doc('Mirror the main CI check job locally')]
[group('quality')]
ci: _check-justfile worker-build check coverage

[doc('Full pre-push gate: CI checks plus smoke e2e')]
[group('quality')]
ci-full: ci test-e2e

[doc('Run the barestash CLI')]
[group('cli')]
[positional-arguments]
barestash *args:
    @if [ -t 0 ]; then bash -m -c 'node --import tsx apps/cli/src/barestash.ts "$@"' -- "$@"; else node --import tsx apps/cli/src/barestash.ts "$@"; fi

[doc('Start the API dev server with persisted local Cloudflare state')]
[group('dev')]
dev-api:
    pnpm dev:api

[doc('Start the browser authentication dev server with shared local D1 state')]
[group('dev')]
dev-web:
    pnpm --filter @barestash/web dev

[doc('Start the CLI dev watcher')]
[group('dev')]
dev-cli:
    pnpm dev:cli

[confirm('Delete local Cloudflare state under apps/api/.wrangler/state?')]
[doc('Delete persisted local D1, R2, and Durable Object state')]
[group('dev')]
reset-api-state:
    rm -rf {{ api_wrangler_state }}
    printf 'Removed %s\n' {{ api_wrangler_state }}

[doc('Reset local API state and start the dev server')]
[group('dev')]
dev-api-fresh: reset-api-state dev-api

[doc('Run flake checks (nix-quality, dev-shell-python, etc.)')]
[group('nix')]
nix-check:
    nix flake check

[doc('Format flake.nix and other Nix files')]
[group('nix')]
nix-fmt:
    nix fmt
