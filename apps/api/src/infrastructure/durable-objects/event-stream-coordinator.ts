import type { EventStreamPayload } from "@barestash/shared/events";
import type { EndpointId, EventId } from "@barestash/shared/ids";
import {
  enqueueDedupedSseMessage,
  findSseMessageSeparator,
  sseMessage,
} from "@barestash/shared/sse";

import type {
  EventStreamCoordinator,
  EventStreamSubscription,
} from "../../domain/ports.js";

/** @public */
export class DurableObjectEventStreamCoordinator
  implements EventStreamCoordinator
{
  readonly #namespace: DurableObjectNamespace;

  constructor(namespace: DurableObjectNamespace) {
    this.#namespace = namespace;
  }

  async subscribe(
    endpointId: EndpointId,
    options: {
      bufferPublishedEvents?: boolean;
      maxDurationMilliseconds?: number;
    } = {},
  ): Promise<EventStreamSubscription> {
    const stub = this.#namespace.get(this.#namespace.idFromName(endpointId));
    const response = await stub.fetch("https://barestash.internal/subscribe");

    if (!response.ok || response.body === null) {
      throw new Error(
        "Endpoint stream Durable Object did not return a stream.",
      );
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    const deliveredIds = new Set<EventId>();
    const bufferedMessages: string[] = [];
    let bufferPublishedEvents = options.bufferPublishedEvents === true;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    let buffer = "";
    let durationTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const closeSubscription = async () => {
      if (closed) return;
      closed = true;

      if (durationTimer !== undefined) {
        clearTimeout(durationTimer);
        durationTimer = undefined;
      }

      try {
        streamController?.close();
      } catch {
        // The client may already have closed the stream.
      }

      await reader.cancel();
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;

        if (options.maxDurationMilliseconds !== undefined) {
          durationTimer = setTimeout(
            () => void closeSubscription(),
            options.maxDurationMilliseconds,
          );
        }

        void (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();

              if (done) {
                if (!closed && buffer.length > 0) {
                  enqueueDedupedSseMessage(
                    controller,
                    encoder,
                    deliveredIds,
                    buffer,
                  );
                }

                if (!closed) {
                  closed = true;
                  if (durationTimer !== undefined) {
                    clearTimeout(durationTimer);
                    durationTimer = undefined;
                  }
                  controller.close();
                }
                break;
              }

              buffer += decoder.decode(value, { stream: true });
              let separator = findSseMessageSeparator(buffer);

              while (separator !== null) {
                const messageBody = buffer.slice(0, separator.index);
                const delimiter = buffer.slice(
                  separator.index,
                  separator.index + separator.length,
                );
                buffer = buffer.slice(separator.index + separator.length);
                const framedMessage = `${messageBody}${delimiter}`;

                if (bufferPublishedEvents) {
                  bufferedMessages.push(framedMessage);
                } else {
                  enqueueDedupedSseMessage(
                    controller,
                    encoder,
                    deliveredIds,
                    framedMessage,
                  );
                }

                separator = findSseMessageSeparator(buffer);
              }
            }
          } catch (error) {
            if (!closed) {
              controller.error(error);
            }
          }
        })();
      },
      async cancel() {
        await closeSubscription();
      },
    });

    return {
      stream,
      send: (payload) => {
        if (streamController !== null && !deliveredIds.has(payload.id)) {
          deliveredIds.add(payload.id);
          streamController.enqueue(encoder.encode(sseMessage(payload)));
        }
      },
      flushBuffered: () => {
        bufferPublishedEvents = false;

        if (streamController === null) {
          bufferedMessages.length = 0;
          return;
        }

        for (const message of bufferedMessages) {
          enqueueDedupedSseMessage(
            streamController,
            encoder,
            deliveredIds,
            message,
          );
        }

        bufferedMessages.length = 0;
      },
      cancel: closeSubscription,
    };
  }

  async getSubscriberPresence(endpointId: EndpointId) {
    const stub = this.#namespace.get(this.#namespace.idFromName(endpointId));
    const response = await stub.fetch("https://barestash.internal/subscribers");

    if (!response.ok) {
      throw new Error(
        "Endpoint stream Durable Object did not return subscriber presence.",
      );
    }

    const result = (await response.json()) as {
      hasSubscribers?: unknown;
      maxSubscriberSequence?: unknown;
    };

    if (
      typeof result.hasSubscribers !== "boolean" ||
      !Number.isSafeInteger(result.maxSubscriberSequence) ||
      (result.maxSubscriberSequence as number) < 0
    ) {
      throw new Error(
        "Endpoint stream Durable Object returned invalid subscriber presence.",
      );
    }

    return {
      hasSubscribers: result.hasSubscribers,
      maxSubscriberSequence: result.maxSubscriberSequence as number,
    };
  }

  async publish(
    endpointId: EndpointId,
    payload: EventStreamPayload,
    options: {
      maxSubscriberSequence?: number;
    } = {},
  ): Promise<void> {
    const stub = this.#namespace.get(this.#namespace.idFromName(endpointId));
    const url = new URL("https://barestash.internal/publish");

    if (options.maxSubscriberSequence !== undefined) {
      url.searchParams.set(
        "maxSubscriberSequence",
        String(options.maxSubscriberSequence),
      );
    }

    await stub.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }
}
