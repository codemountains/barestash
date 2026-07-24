import { Command } from "commander";

import { streamEvents } from "../../application/event-stream.js";
import {
  fetchEventBody,
  fetchEventDetail,
  listEvents,
  showEvent,
  showLatestEvent,
  tailEvents,
} from "../../application/events.js";
import type { AppDeps } from "../../container.js";
import { parsePollInterval } from "../../domain/duration.js";
import { selectedEndpointId } from "../../domain/endpoint-selection.js";
import { EventStreamConnectionError } from "../../infrastructure/sse.js";
import {
  printNoEndpointSelected,
  printStreamReadError,
} from "../output/errors.js";
import {
  printEventBody,
  printEventDetail,
  printEventHeaders,
  printEventList,
  printEventSummary,
  printEventSummaryHeader,
  redactEventDetailForDisplay,
} from "../output/events.js";
import { printJson, printJsonLine } from "../output/json.js";
import { handleCliResult } from "../output/result.js";

async function printTailEvent(
  deps: AppDeps,
  eventId: string,
  includeHeaders: boolean,
  includeBody: boolean,
): Promise<number> {
  if (!includeHeaders && !includeBody) {
    return 0;
  }

  const detailResult = await fetchEventDetail(deps.authDeps, eventId);

  if (detailResult.kind !== "ok") {
    handleCliResult(detailResult, deps.io);
    return 1;
  }

  if (includeHeaders) {
    printEventHeaders(deps.io, detailResult.value);
  }

  if (includeBody) {
    const bodyResult = await fetchEventBody(deps.authDeps, detailResult.value);

    if (bodyResult.kind !== "ok") {
      handleCliResult(bodyResult, deps.io);
      return 1;
    }

    printEventBody(deps.io, bodyResult.value);
  }

  return 0;
}

/** @public */
export function registerEventCommands(program: Command, deps: AppDeps): void {
  const events = new Command("events")
    .description("Read captured events")
    .configureOutput({
      writeOut: (value) => deps.io.stdout(value.trimEnd()),
      writeErr: (value) => deps.io.stderr(value.trimEnd()),
    })
    .exitOverride();

  events
    .command("list")
    .description("List received events")
    .option("--endpoint <endpoint-id>", "specify an endpoint")
    .option("--limit <count>", "number of events to fetch", (value) =>
      Number(value),
    )
    .option("--json", "print JSON output")
    .action(
      async (commandOptions: {
        endpoint?: string;
        limit?: number;
        json?: boolean;
      }) => {
        const endpointId = selectedEndpointId(
          commandOptions.endpoint,
          deps.env,
        );

        if (endpointId === null) {
          printNoEndpointSelected(deps.io);
          deps.state.exitCode = 1;
          return;
        }

        const result = await listEvents(
          deps.authDeps,
          endpointId,
          commandOptions.limit,
        );
        const value = handleCliResult(result, deps.io);

        if (value === null) {
          deps.state.exitCode = 1;
          return;
        }

        if (commandOptions.json === true) {
          printJson(deps.io, { events: value });
        } else {
          printEventList(deps.io, value);
        }

        deps.state.exitCode = 0;
      },
    );

  events
    .command("latest")
    .description("Show the most recently received event")
    .option("--endpoint <endpoint-id>", "specify an endpoint")
    .option("--json", "print JSON output")
    .action(async (commandOptions: { endpoint?: string; json?: boolean }) => {
      const endpointId = selectedEndpointId(commandOptions.endpoint, deps.env);

      if (endpointId === null) {
        printNoEndpointSelected(deps.io);
        deps.state.exitCode = 1;
        return;
      }

      const result = await showLatestEvent(deps.authDeps, endpointId);

      if (result.kind === "ok" && result.value.event === null) {
        if (commandOptions.json === true) {
          printJson(deps.io, { event: null, body: null });
        } else {
          deps.io.stdout("No events received yet.");
        }

        deps.state.exitCode = 0;
        return;
      }

      const value = handleCliResult(result, deps.io);

      if (value === null || value.event === null) {
        deps.state.exitCode = 1;
        return;
      }

      if (commandOptions.json === true) {
        printJson(deps.io, {
          event: redactEventDetailForDisplay(value.event),
          body: value.body,
        });
      } else {
        printEventDetail(deps.io, value.event, value.body);
      }

      deps.state.exitCode = 0;
    });

  events
    .command("show")
    .description("Show event details")
    .argument("<event-id>")
    .option("--json", "print JSON output")
    .action(async (eventId: string, commandOptions: { json?: boolean }) => {
      const result = await showEvent(deps.authDeps, eventId);
      const value = handleCliResult(result, deps.io);

      if (value === null) {
        deps.state.exitCode = 1;
        return;
      }

      if (commandOptions.json === true) {
        printJson(deps.io, {
          event: redactEventDetailForDisplay(value.event),
          body: value.body,
        });
      } else {
        printEventDetail(deps.io, value.event, value.body);
      }

      deps.state.exitCode = 0;
    });

  events
    .command("tail")
    .description("Follow incoming events")
    .option("--endpoint <endpoint-id>", "specify an endpoint")
    .option("--last <count>", "show last N events before watching")
    .option("--headers", "include headers in output")
    .option("--body", "include body in output")
    .option(
      "--poll-interval <duration>",
      "poll interval such as 500ms, 2s, or 1m",
      "2s",
    )
    .action(
      async (commandOptions: {
        endpoint?: string;
        last?: string;
        headers?: boolean;
        body?: boolean;
        pollInterval?: string;
      }) => {
        const endpointId = selectedEndpointId(
          commandOptions.endpoint,
          deps.env,
        );

        if (endpointId === null) {
          printNoEndpointSelected(deps.io);
          deps.state.exitCode = 1;
          return;
        }

        let pollInterval: number;

        try {
          pollInterval = parsePollInterval(commandOptions.pollInterval ?? "2s");
        } catch (error) {
          deps.io.stderr(
            error instanceof Error ? error.message : "Invalid poll interval.",
          );
          deps.state.exitCode = 1;
          return;
        }

        const last =
          commandOptions.last === undefined ? 0 : Number(commandOptions.last);

        if (!Number.isInteger(last) || last < 0) {
          deps.io.stderr("--last must be a non-negative integer.");
          deps.state.exitCode = 1;
          return;
        }

        deps.io.stdout(`Watching endpoint: ${endpointId}`);
        deps.io.stdout("");
        printEventSummaryHeader(deps.io);

        const result = await tailEvents(
          {
            ...deps.authDeps,
            sleeper: deps.sleeper,
            maxTailPolls: deps.options.maxTailPolls,
            onTailEvent: async (event) => {
              printEventSummary(deps.io, event);

              return printTailEvent(
                deps,
                event.id,
                commandOptions.headers === true,
                commandOptions.body === true,
              );
            },
          },
          endpointId,
          {
            last,
            pollInterval,
          },
        );

        if (result.kind === "done") {
          deps.state.exitCode = result.exitCode;
          return;
        }

        handleCliResult(result, deps.io);
        deps.state.exitCode = 1;
      },
    );

  events
    .command("stream")
    .description("Stream incoming events as JSONL")
    .option("--endpoint <endpoint-id>", "specify an endpoint")
    .action(async (commandOptions: { endpoint?: string }) => {
      const endpointId = selectedEndpointId(commandOptions.endpoint, deps.env);

      if (endpointId === null) {
        printNoEndpointSelected(deps.io);
        deps.state.exitCode = 1;
        return;
      }

      try {
        const result = await streamEvents(
          {
            ...deps.authDeps,
            signal: deps.options.signal,
            sleeper: deps.sleeper,
            maxStreamReconnects: deps.options.maxStreamReconnects,
            onPayload: (payload) => {
              printJsonLine(deps.io, payload);
            },
          },
          endpointId,
        );

        if (result.kind !== "ok") {
          handleCliResult(result, deps.io);
          deps.state.exitCode = 1;
          return;
        }

        deps.state.exitCode = 0;
      } catch (error) {
        if (error instanceof EventStreamConnectionError) {
          printStreamReadError(deps.io, error);
          deps.state.exitCode = 1;
          return;
        }

        throw error;
      }
    });

  program.addCommand(events);
}
