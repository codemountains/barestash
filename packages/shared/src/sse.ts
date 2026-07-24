import type { EventStreamPayload } from "./events.js";
import { type EventId, isEventId } from "./ids.js";

/** @public */
export function sseMessage(payload: EventStreamPayload): string {
  return `id: ${payload.id}\nevent: event\ndata: ${JSON.stringify(payload)}\n\n`;
}

function normalizeSseLine(rawLine: string): string {
  return rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
}

/** @public */
export function sseMessageId(message: string): EventId | null {
  for (const rawLine of message.split("\n")) {
    const line = normalizeSseLine(rawLine);

    if (line.startsWith("id:")) {
      const value = line.slice("id:".length).trimStart();

      return isEventId(value) ? value : null;
    }
  }

  return null;
}

/** @public */
export function parseSseMessage(message: string): {
  id: string | null;
  data: string | null;
} {
  let id: string | null = null;
  const dataLines: string[] = [];

  for (const rawLine of message.split("\n")) {
    const line = normalizeSseLine(rawLine);

    if (line.startsWith("id:")) {
      id = line.slice("id:".length).trimStart();
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  return {
    id,
    data: dataLines.length === 0 ? null : dataLines.join("\n"),
  };
}

/** @public */
export function findSseMessageSeparator(
  buffer: string,
): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/.exec(buffer);

  return match === null
    ? null
    : { index: match.index, length: match[0].length };
}

/** @public */
export function enqueueDedupedSseMessage(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  deliveredIds: Set<EventId>,
  message: string,
): void {
  const eventId = sseMessageId(message);

  if (eventId !== null) {
    if (deliveredIds.has(eventId)) {
      return;
    }

    deliveredIds.add(eventId);
  }

  controller.enqueue(encoder.encode(message));
}
