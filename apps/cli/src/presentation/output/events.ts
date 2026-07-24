import type { EventDetail, EventMetadata } from "@barestash/shared/events";
import { redactHeadersForDisplay } from "@barestash/shared/headers";

import type { CliIo } from "../../domain/ports.js";
import { bodyLines, eventContentType, formatBytes } from "./format.js";

/** @public */
export function redactEventDetailForDisplay(event: EventDetail): EventDetail {
  return {
    ...event,
    request: {
      ...event.request,
      headers: redactHeadersForDisplay(event.request.headers),
    },
  };
}

/** @public */
export function printEventList(io: CliIo, events: EventMetadata[]): void {
  if (events.length === 0) {
    io.stdout("No events received yet.");
    return;
  }

  io.stdout(
    "ID              METHOD  PATH              CONTENT-TYPE       SIZE    RECEIVED",
  );

  for (const event of events) {
    io.stdout(
      `${event.id}  ${event.method}  ${event.request_path}  ${eventContentType(event)}  ${formatBytes(event.body.size)}  ${event.received_at}`,
    );
  }
}

/** @public */
export function printEventSummaryHeader(io: CliIo): void {
  io.stdout(
    "RECEIVED                   METHOD PATH            SIZE CONTENT-TYPE     EVENT",
  );
}

/** @public */
export function printEventSummary(io: CliIo, event: EventMetadata): void {
  io.stdout(
    `[${event.received_at}] ${event.method} ${event.request_path} ${formatBytes(event.body.size)} ${eventContentType(event)} ${event.id}`,
  );
}

/** @public */
export function printEventDetail(
  io: CliIo,
  event: EventDetail,
  body: unknown,
): void {
  const redactedEvent = redactEventDetailForDisplay(event);

  io.stdout(`Event: ${redactedEvent.id}`);
  io.stdout(`Endpoint: ${redactedEvent.endpoint_id}`);
  io.stdout("");
  io.stdout("Request:");
  io.stdout(`  Method:       ${redactedEvent.request.method}`);
  io.stdout(`  Path:         ${redactedEvent.request.request_path}`);
  io.stdout(`  Received:     ${redactedEvent.received_at}`);
  io.stdout(`  Content-Type: ${eventContentType(redactedEvent)}`);
  io.stdout(`  Size:         ${formatBytes(redactedEvent.request.body.size)}`);
  io.stdout("");
  io.stdout("Headers:");

  for (const [name, value] of Object.entries(redactedEvent.request.headers)) {
    io.stdout(`  ${name}: ${value}`);
  }

  io.stdout("");
  io.stdout("Body:");

  for (const line of bodyLines(body)) {
    io.stdout(line);
  }
}

/** @public */
export function printEventHeaders(io: CliIo, event: EventDetail): void {
  const headers = redactHeadersForDisplay(event.request.headers);

  io.stdout("");
  io.stdout("Headers:");

  for (const [name, value] of Object.entries(headers)) {
    io.stdout(`  ${name}: ${value}`);
  }
}

/** @public */
export function printEventBody(io: CliIo, body: unknown): void {
  io.stdout("");
  io.stdout("Body:");

  for (const line of bodyLines(body)) {
    io.stdout(line);
  }
}
