import { Command } from "commander";

import type { AppDeps } from "../container.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerEndpointCommands } from "./commands/endpoints.js";
import { registerEventCommands } from "./commands/events.js";
import { registerTokenCommands } from "./commands/tokens.js";

const helpText = [
  "Usage: barestash {resource} {action}",
  "",
  "Resources: auth, endpoints, events, tokens",
  "",
  "Run `barestash --help` to show this message.",
].join("\n");

/** @public */
export function createProgram(deps: AppDeps): Command {
  const program = new Command()
    .name("barestash")
    .description("Headless request stash CLI")
    .version("0.0.0")
    .helpOption("--help, -h", "show help")
    .configureHelp({
      formatHelp: () => `${helpText}\n`,
    })
    .configureOutput({
      writeOut: (value) => deps.io.stdout(value.trimEnd()),
      writeErr: (value) => deps.io.stderr(value.trimEnd()),
    })
    .exitOverride();

  registerAuthCommands(program, deps);
  registerTokenCommands(program, deps);
  registerEndpointCommands(program, deps);
  registerEventCommands(program, deps);

  return program;
}

/** @public */
export function isCommanderHandledCommand(
  command: string | undefined,
): boolean {
  return (
    command === "auth" ||
    command === "endpoints" ||
    command === "events" ||
    command === "tokens" ||
    command === "--help" ||
    command === "-h" ||
    command === "--version" ||
    command === "-V"
  );
}

/** @public */
export function isKnownEventsAction(args: string[]): boolean {
  const eventsCommands = ["list", "latest", "show", "tail", "stream"];
  const eventsHelpTargets = ["--help", "-h"];
  const eventsAction = args[1];
  const eventsHelpTarget = args[2];
  const hasExtraEventsHelpTarget = args[3] !== undefined;

  return (
    eventsAction === undefined ||
    eventsCommands.includes(eventsAction) ||
    eventsHelpTargets.includes(eventsAction) ||
    (eventsAction === "help" &&
      !hasExtraEventsHelpTarget &&
      (eventsHelpTarget === undefined ||
        eventsCommands.includes(eventsHelpTarget)))
  );
}
