import type { EventStreamPayload } from "@barestash/shared/events";
import {
  findSseMessageSeparator,
  parseSseMessage,
} from "@barestash/shared/sse";

/** @public */
export class EventStreamConnectionError extends Error {
  readonly lastEventId: string | null;

  constructor(lastEventId: string | null, cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "Event stream connection failed.",
    );
    this.lastEventId = lastEventId;
  }
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** @public */
export async function consumeEventStream(
  response: Response,
  onPayload: (payload: EventStreamPayload) => void,
  initialLastEventId: string | null,
  signal?: AbortSignal,
): Promise<string | null> {
  if (response.body === null) {
    throw new Error("Barestash API returned an empty event stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastEventId = initialLastEventId;
  const handleAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };

  if (isAborted(signal)) {
    await reader.cancel(signal?.reason).catch(() => {});
    reader.releaseLock();
    throw signal?.reason;
  }

  signal?.addEventListener("abort", handleAbort, { once: true });

  try {
    while (true) {
      let result:
        | { done: true; value?: undefined }
        | { done: false; value: Uint8Array };

      try {
        result = await reader.read();
      } catch (error) {
        if (isAborted(signal)) {
          throw signal?.reason;
        }

        throw new EventStreamConnectionError(lastEventId, error);
      }

      if (isAborted(signal)) {
        throw signal?.reason;
      }

      if (result.done) {
        break;
      }

      buffer += decoder.decode(result.value, { stream: true });
      let separator = findSseMessageSeparator(buffer);

      while (separator !== null) {
        const message = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);

        const parsed = parseSseMessage(message);

        if (parsed.id !== null && parsed.id.length > 0) {
          lastEventId = parsed.id;
        }

        if (parsed.data !== null) {
          const payload = JSON.parse(parsed.data) as EventStreamPayload;
          onPayload(payload);
        }

        separator = findSseMessageSeparator(buffer);
      }
    }
  } finally {
    signal?.removeEventListener("abort", handleAbort);
    reader.releaseLock();
  }

  buffer += decoder.decode();

  if (buffer.trim().length > 0) {
    throw new EventStreamConnectionError(
      lastEventId,
      new Error("Event stream closed with an incomplete SSE message."),
    );
  }

  return lastEventId;
}
