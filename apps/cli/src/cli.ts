import { CommanderError } from "commander";

import { CliApiErrorException } from "./application/result.js";
import { type CliOptions, createAppDeps } from "./container.js";
import type { CliIo } from "./domain/ports.js";
import { parseGlobalCliOptions } from "./global-options.js";
import { InvalidApiBaseUrlError } from "./infrastructure/api/api-url.js";
import { isMonitoringCommand } from "./monitoring-command.js";
import {
  printApiConnectivityError,
  printApiError,
} from "./presentation/output/errors.js";
import {
  createProgram,
  isCommanderHandledCommand,
  isKnownEventsAction,
} from "./presentation/program.js";

export async function runCli(
  args: string[],
  io: CliIo,
  options: CliOptions = {},
): Promise<number> {
  const { allowInsecureApiUrl, commandArgs } = parseGlobalCliOptions(args);
  const state = { exitCode: 0 };
  const deps = createAppDeps(
    io,
    {
      ...options,
      allowInsecureApiUrl: options.allowInsecureApiUrl ?? allowInsecureApiUrl,
    },
    state,
  );

  const program = createProgram(deps);

  if (commandArgs.length === 0) {
    program.outputHelp();
    return 0;
  }

  const [command] = commandArgs;

  if (!isCommanderHandledCommand(command)) {
    io.stderr(`Unknown command: ${args.join(" ")}`);
    io.stderr("Run `barestash --help` for usage.");
    return 1;
  }

  if (command === "events" && !isKnownEventsAction(commandArgs)) {
    io.stderr(`Unknown command: ${commandArgs.join(" ")}`);
    io.stderr("Run `barestash --help` for usage.");
    return 1;
  }

  try {
    await program.parseAsync(commandArgs, { from: "user" });

    if (options.signal?.aborted === true && isMonitoringCommand(commandArgs)) {
      return 0;
    }

    return state.exitCode;
  } catch (error) {
    if (options.signal?.aborted === true && isMonitoringCommand(commandArgs)) {
      return 0;
    }

    if (error instanceof CommanderError && error.code === "commander.version") {
      return 0;
    }

    if (
      error instanceof CommanderError &&
      (error.code === "commander.help" ||
        error.code === "commander.helpDisplayed")
    ) {
      return 0;
    }

    if (error instanceof CommanderError) {
      return 1;
    }

    if (error instanceof InvalidApiBaseUrlError) {
      io.stderr(error.message);
      return 1;
    }

    if (error instanceof CliApiErrorException) {
      printApiError(io, error.error);
      return 1;
    }

    printApiConnectivityError(io, error);
    return 1;
  }
}
