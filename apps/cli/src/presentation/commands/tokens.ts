import {
  AUTHORIZATION_SCOPES,
  type AuthorizationScope,
} from "@barestash/shared/auth";
import { Command, Option } from "commander";

import {
  createToken,
  listTokens,
  resolveTokenCreateRequest,
  revokeToken,
} from "../../application/tokens.js";
import type { AppDeps } from "../../container.js";
import { printJson } from "../output/json.js";
import { handleCliResult } from "../output/result.js";
import { printTokenCreated, printTokenList } from "../output/tokens.js";

/** @public */
export function registerTokenCommands(program: Command, deps: AppDeps): void {
  const tokens = new Command("tokens").description("Manage API tokens");

  tokens
    .command("create")
    .description("Issue a Personal Access Token")
    .option("--name <name>", "assign a human-readable name")
    .addOption(
      new Option("--scope <scope>", "add a token scope")
        .choices([...AUTHORIZATION_SCOPES])
        .argParser((value, previous: string[] = []) => [...previous, value])
        .default([]),
    )
    .addOption(
      new Option("--preset <preset>", "use a scope preset").choices([
        "read-only",
        "full-access",
      ]),
    )
    .option(
      "--expires-in <duration>",
      "set expiration, such as 30d, 90d, or 1y",
    )
    .option("--no-expiration", "create a token that does not expire")
    .option("--json", "print JSON output")
    .action(
      async (commandOptions: {
        name?: string;
        scope?: AuthorizationScope[];
        preset?: "read-only" | "full-access";
        expiresIn?: string;
        noExpiration?: boolean;
        json?: boolean;
      }) => {
        const tokenOptions = {
          name: commandOptions.name,
          scopes: commandOptions.scope,
          preset: commandOptions.preset,
          expiresIn: commandOptions.expiresIn,
          noExpiration: commandOptions.noExpiration,
        };
        const resolved = resolveTokenCreateRequest(tokenOptions);

        if (resolved.kind === "ok" && commandOptions.json !== true) {
          deps.io.stderr(`Scopes: ${resolved.value.scopes.join(" ")}`);
          if (resolved.value.expires_in === null) {
            deps.io.stderr(
              "Warning: this token will not expire automatically.",
            );
          }
        }

        const result = await createToken(deps.authDeps, tokenOptions);
        const value = handleCliResult(result, deps.io);

        if (value === null) {
          deps.state.exitCode = 1;
          return;
        }

        if (commandOptions.json === true) {
          printJson(deps.io, value);
        } else {
          printTokenCreated(deps.io, value);
        }

        deps.state.exitCode = 0;
      },
    );

  tokens
    .command("list")
    .description("List API tokens")
    .option("--all", "include revoked tokens")
    .option("--json", "print JSON output")
    .action(async (commandOptions: { all?: boolean; json?: boolean }) => {
      const result = await listTokens(
        deps.authDeps,
        commandOptions.all === true,
      );
      const value = handleCliResult(result, deps.io);

      if (value === null) {
        deps.state.exitCode = 1;
        return;
      }

      if (commandOptions.json === true) {
        printJson(deps.io, value);
      } else {
        printTokenList(deps.io, value.tokens);
      }

      deps.state.exitCode = 0;
    });

  tokens
    .command("revoke")
    .description("Revoke an API token")
    .argument("<token-id>")
    .option("--yes", "revoke without prompting")
    .action(async (tokenId: string, commandOptions: { yes?: boolean }) => {
      const result = await revokeToken(
        {
          ...deps.authDeps,
          confirmer: deps.confirmer,
        },
        tokenId,
        commandOptions.yes === true,
      );
      const value = handleCliResult(result, deps.io);

      if (value === null) {
        deps.state.exitCode = 1;
        return;
      }

      deps.io.stdout(`Revoked token: ${value.token.id}`);
      deps.state.exitCode = 0;
    });

  program.addCommand(tokens);
}
