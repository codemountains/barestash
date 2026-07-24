import { Command } from "commander";

import {
  createEndpointSecret,
  createPrivateEndpoint,
  createTemporaryEndpoint,
  deleteEndpoint,
  listEndpointSecrets,
  listEndpoints,
  revokeEndpointSecret,
  showEndpoint,
} from "../../application/endpoints.js";
import type { AppDeps } from "../../container.js";
import { selectedEndpointId } from "../../domain/endpoint-selection.js";
import {
  printEndpointCreated,
  printEndpointDetail,
  printEndpointList,
  printEndpointSecretCreated,
  printEndpointSecretList,
  printEndpointSecretRevoked,
} from "../output/endpoints.js";
import { printNoEndpointSelected } from "../output/errors.js";
import { printJson } from "../output/json.js";
import { handleCliResult } from "../output/result.js";

/** @public */
export function registerEndpointCommands(
  program: Command,
  deps: AppDeps,
): void {
  const endpoints = new Command("endpoints").description(
    "Manage webhook endpoints",
  );

  endpoints
    .command("create")
    .description("Create an endpoint")
    .option("--private", "create a private endpoint")
    .option("--temporary", "create a temporary endpoint")
    .option("--name <name>", "assign a human-readable name")
    .option(
      "--set-default",
      "set the created endpoint as the CLI default endpoint",
    )
    .option("--json", "print JSON output")
    .action(
      async (commandOptions: {
        private?: boolean;
        temporary?: boolean;
        name?: string;
        setDefault?: boolean;
        json?: boolean;
      }) => {
        if (
          commandOptions.private === true &&
          commandOptions.temporary === true
        ) {
          deps.io.stderr("Choose either --private or --temporary, not both.");
          deps.state.exitCode = 1;
          return;
        }

        if (commandOptions.setDefault === true) {
          deps.io.stderr("Setting a default endpoint is not implemented yet.");
          deps.state.exitCode = 1;
          return;
        }

        const result =
          commandOptions.temporary === true
            ? await createTemporaryEndpoint(deps.authDeps, commandOptions.name)
            : await createPrivateEndpoint(deps.authDeps, commandOptions.name);

        const value = handleCliResult(result, deps.io);

        if (value === null) {
          deps.state.exitCode = 1;
          return;
        }

        if (commandOptions.json === true) {
          printJson(deps.io, value);
        } else {
          printEndpointCreated(deps.io, value.endpoint);
        }

        deps.state.exitCode = 0;
      },
    );

  endpoints
    .command("list")
    .description("List endpoints")
    .option("--json", "print JSON output")
    .action(async (commandOptions: { json?: boolean }) => {
      const result = await listEndpoints(deps.authDeps);
      const value = handleCliResult(result, deps.io);

      if (value === null) {
        deps.state.exitCode = 1;
        return;
      }

      if (commandOptions.json === true) {
        printJson(deps.io, value);
      } else {
        printEndpointList(deps.io, value.endpoints);
      }

      deps.state.exitCode = 0;
    });

  endpoints
    .command("show")
    .description("Show endpoint details")
    .argument("<endpoint-id>")
    .option("--json", "print JSON output")
    .action(async (endpointId: string, commandOptions: { json?: boolean }) => {
      const result = await showEndpoint(deps.authDeps, endpointId);
      const value = handleCliResult(result, deps.io);

      if (value === null) {
        deps.state.exitCode = 1;
        return;
      }

      if (commandOptions.json === true) {
        printJson(deps.io, value);
      } else {
        printEndpointDetail(deps.io, value.endpoint);
      }

      deps.state.exitCode = 0;
    });

  endpoints
    .command("delete")
    .description("Delete an endpoint")
    .argument("<endpoint-id>")
    .option("--yes", "delete without prompting")
    .action(async (endpointId: string, commandOptions: { yes?: boolean }) => {
      const result = await deleteEndpoint(
        {
          ...deps.authDeps,
          confirmer: deps.confirmer,
        },
        endpointId,
        commandOptions.yes === true,
      );
      const value = handleCliResult(result, deps.io);

      if (value === null) {
        deps.state.exitCode = 1;
        return;
      }

      deps.io.stdout(`Deleted endpoint: ${value.endpoint.id}`);
      deps.io.stdout(`Deleted events: ${value.deleted_events}`);
      deps.io.stdout(`Deleted body objects: ${value.deleted_body_objects}`);
      deps.state.exitCode = 0;
    });

  const secrets = new Command("secrets").description(
    "Manage endpoint ingest secrets",
  );

  secrets
    .command("create")
    .description("Create an endpoint ingest secret")
    .option("--endpoint <endpoint-id>", "target endpoint")
    .option("--json", "print JSON output")
    .action(async (commandOptions: { endpoint?: string; json?: boolean }) => {
      const endpointId = selectedEndpointId(commandOptions.endpoint, deps.env);

      if (endpointId === null) {
        printNoEndpointSelected(deps.io);
        deps.state.exitCode = 1;
        return;
      }

      const result = await createEndpointSecret(deps.authDeps, endpointId);
      const value = handleCliResult(result, deps.io);

      if (value === null) {
        deps.state.exitCode = 1;
        return;
      }

      if (commandOptions.json === true) {
        printJson(deps.io, value);
      } else {
        printEndpointSecretCreated(deps.io, value);
      }

      deps.state.exitCode = 0;
    });

  secrets
    .command("list")
    .description("List endpoint ingest secrets")
    .option("--endpoint <endpoint-id>", "target endpoint")
    .option("--json", "print JSON output")
    .action(async (commandOptions: { endpoint?: string; json?: boolean }) => {
      const endpointId = selectedEndpointId(commandOptions.endpoint, deps.env);

      if (endpointId === null) {
        printNoEndpointSelected(deps.io);
        deps.state.exitCode = 1;
        return;
      }

      const result = await listEndpointSecrets(deps.authDeps, endpointId);
      const value = handleCliResult(result, deps.io);

      if (value === null) {
        deps.state.exitCode = 1;
        return;
      }

      if (commandOptions.json === true) {
        printJson(deps.io, value);
      } else {
        printEndpointSecretList(deps.io, value.endpoint_secrets);
      }

      deps.state.exitCode = 0;
    });

  secrets
    .command("revoke")
    .description("Revoke an endpoint ingest secret")
    .argument("<secret-id>")
    .option("--endpoint <endpoint-id>", "target endpoint")
    .option("--yes", "revoke without prompting")
    .action(
      async (
        secretId: string,
        commandOptions: { endpoint?: string; yes?: boolean },
      ) => {
        const endpointId = selectedEndpointId(
          commandOptions.endpoint,
          deps.env,
        );

        if (endpointId === null) {
          printNoEndpointSelected(deps.io);
          deps.state.exitCode = 1;
          return;
        }

        const result = await revokeEndpointSecret(
          {
            ...deps.authDeps,
            confirmer: deps.confirmer,
          },
          endpointId,
          secretId,
          commandOptions.yes === true,
        );
        const value = handleCliResult(result, deps.io);

        if (value === null) {
          deps.state.exitCode = 1;
          return;
        }

        printEndpointSecretRevoked(deps.io, value);
        deps.state.exitCode = 0;
      },
    );

  endpoints.addCommand(secrets);

  program.addCommand(endpoints);
}
