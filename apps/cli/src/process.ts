import { runCli } from "./cli.js";
import type { CliOptions } from "./container.js";
import type { CliIo } from "./domain/ports.js";
import { parseGlobalCliOptions } from "./global-options.js";
import { isMonitoringCommand } from "./monitoring-command.js";

export type ProcessSignals = {
  once: (event: "SIGINT", listener: () => void) => unknown;
  removeListener: (event: "SIGINT", listener: () => void) => unknown;
};

export async function runCliProcess(
  args: string[],
  io: CliIo,
  options: CliOptions = {},
  signals: ProcessSignals = process,
): Promise<number> {
  const { commandArgs } = parseGlobalCliOptions(args);

  if (!isMonitoringCommand(commandArgs)) {
    return runCli(args, io, options);
  }

  const controller = new AbortController();
  const handleInterrupt = () => controller.abort();
  const signal =
    options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal]);
  const interruptibleIo: CliIo = {
    stdout: (line) => {
      if (!signal.aborted) {
        io.stdout(line);
      }
    },
    stderr: (line) => {
      if (!signal.aborted) {
        io.stderr(line);
      }
    },
  };

  signals.once("SIGINT", handleInterrupt);

  try {
    return await runCli(args, interruptibleIo, { ...options, signal });
  } finally {
    signals.removeListener("SIGINT", handleInterrupt);
  }
}
