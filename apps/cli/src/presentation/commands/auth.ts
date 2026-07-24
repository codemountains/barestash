import { Command } from "commander";

import { authLogin, authLogout, authStatus } from "../../application/auth.js";
import type { AppDeps } from "../../container.js";
import { printJson } from "../output/json.js";
import { handleCliResult } from "../output/result.js";

/** @public */
export function registerAuthCommands(program: Command, deps: AppDeps): void {
  const auth = new Command("auth").description("Manage authentication");

  auth
    .command("login")
    .description("Authenticate the CLI")
    .option("--with-token", "read a token from stdin")
    .option("--insecure-storage", "store credentials in a 0600 plaintext file")
    .action(
      async (commandOptions: {
        withToken?: boolean;
        insecureStorage?: boolean;
      }) => {
        const result = await authLogin(
          {
            ...deps.authDeps,
            readStdin: () => deps.stdinReader.read(),
            sleep: (milliseconds) => deps.sleeper.sleep(milliseconds),
            openBrowser: (url) => deps.browserOpener.open(url),
            deviceName: deps.deviceName,
            onDeviceAuthorization: (authorization) => {
              deps.io.stderr("Open this URL in your browser:");
              deps.io.stderr("");
              deps.io.stderr(`  ${authorization.verification_uri}`);
              deps.io.stderr("");
              deps.io.stderr("Enter this one-time code:");
              deps.io.stderr("");
              deps.io.stderr(`  ${authorization.user_code}`);
              deps.io.stderr("");
              deps.io.stderr("Waiting for authorization...");
            },
          },
          {
            withToken: commandOptions.withToken === true,
            insecureStorage: commandOptions.insecureStorage === true,
          },
        );

        const value = handleCliResult(result, deps.io);

        if (value === null) {
          deps.state.exitCode = 1;
          return;
        }

        if (value.storage.storage === "plaintext") {
          const reason = value.storage.fallback
            ? "The OS credential store was unavailable; falling back to plaintext credential storage."
            : "Using plaintext credential storage because --insecure-storage was specified.";
          deps.io.stderr(reason);
          deps.io.stderr(`Credential file: ${value.storage.path}`);
        }
        if (value.replacedSession) {
          deps.io.stderr(
            "Replaced a stored CLI session locally. Run `barestash auth logout --revoke` before a future login to revoke the previous session remotely.",
          );
        }
        const { account, credential } = value.principal;
        const id =
          credential.type === "cli_access_token"
            ? credential.session_id
            : credential.id;
        deps.io.stdout(
          `Authenticated as ${account.primary_email ?? account.id} (${id})`,
        );
        if (value.sessionExpiresAt !== null) {
          deps.io.stdout(`Session expires: ${value.sessionExpiresAt}`);
        }
        deps.state.exitCode = 0;
      },
    );

  auth
    .command("status")
    .description("Show authentication status")
    .option("--json", "print JSON output")
    .action(async (commandOptions: { json?: boolean }) => {
      const result = await authStatus(deps.authDeps);

      if (result.kind === "ok" && !result.value.authenticated) {
        if (commandOptions.json === true) {
          printJson(deps.io, {
            authenticated: false,
            account: null,
            credential: null,
            default_endpoint: result.value.defaultEndpoint,
          });
        } else {
          deps.io.stdout("Not authenticated.");
        }

        deps.state.exitCode = 0;
        return;
      }
      const value = handleCliResult(result, deps.io);

      if (value === null || !value.authenticated) {
        deps.state.exitCode = 1;
        return;
      }

      if (commandOptions.json === true) {
        printJson(deps.io, {
          authenticated: true,
          ...value.principal,
          default_endpoint: value.defaultEndpoint,
        });
      } else {
        const { account, credential } = value.principal;
        deps.io.stdout(
          `Authenticated as ${account.primary_email ?? account.id}`,
        );
        deps.io.stdout(`Credential: ${credential.type} (${credential.id})`);
        deps.io.stdout(`Scopes: ${credential.scopes.join(" ")}`);
        deps.io.stdout(`Expires: ${credential.expires_at ?? "never"}`);
        deps.io.stdout(`Default endpoint: ${value.defaultEndpoint ?? "none"}`);
      }

      deps.state.exitCode = 0;
    });

  auth
    .command("logout")
    .description("Remove local authentication credentials")
    .option("--revoke", "revoke the current token")
    .action(async (commandOptions: { revoke?: boolean }) => {
      const result = await authLogout(
        deps.authDeps,
        commandOptions.revoke === true,
      );

      if (handleCliResult(result, deps.io) === null) {
        deps.state.exitCode = 1;
        return;
      }

      deps.io.stdout("Logged out.");
      deps.state.exitCode = 0;
    });

  program.addCommand(auth);
}
