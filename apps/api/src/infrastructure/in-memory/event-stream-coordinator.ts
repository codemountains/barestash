import type { EventStreamPayload } from "@barestash/shared/events";
import type { EndpointId, EventId } from "@barestash/shared/ids";
import { sseMessage } from "@barestash/shared/sse";

import type {
  EventStreamCoordinator,
  EventStreamSubscription,
} from "../../domain/ports.js";

/** @public */
export class InMemoryEventStreamCoordinator implements EventStreamCoordinator {
  readonly #subscribers = new Map<
    EndpointId,
    Set<{
      controller: ReadableStreamDefaultController<Uint8Array>;
      deliveredIds: Set<EventId>;
      bufferPublishedEvents: boolean;
      bufferedPayloads: EventStreamPayload[];
      subscriberSequence: number;
    }>
  >();
  readonly #maxSubscriberSequences = new Map<EndpointId, number>();
  readonly #encoder = new TextEncoder();

  async subscribe(
    endpointId: EndpointId,
    options: {
      bufferPublishedEvents?: boolean;
      maxDurationMilliseconds?: number;
    } = {},
  ): Promise<EventStreamSubscription> {
    const subscribers = this.#subscribers;
    const maxSubscriberSequences = this.#maxSubscriberSequences;
    const encoder = this.#encoder;
    let durationTimer: ReturnType<typeof setTimeout> | undefined;
    const subscriber: {
      controller: ReadableStreamDefaultController<Uint8Array> | null;
      deliveredIds: Set<EventId>;
      bufferPublishedEvents: boolean;
      bufferedPayloads: EventStreamPayload[];
      subscriberSequence: number;
    } = {
      controller: null,
      deliveredIds: new Set<EventId>(),
      bufferPublishedEvents: options.bufferPublishedEvents === true,
      bufferedPayloads: [],
      subscriberSequence: 0,
    };

    const removeSubscriber = () => {
      const endpointSubscribers = subscribers.get(endpointId);

      if (endpointSubscribers === undefined) {
        return;
      }

      for (const candidate of endpointSubscribers) {
        if (candidate.controller === subscriber.controller) {
          endpointSubscribers.delete(candidate);
          break;
        }
      }

      if (endpointSubscribers.size === 0) {
        subscribers.delete(endpointId);
      }
    };

    const closeSubscription = () => {
      if (durationTimer !== undefined) {
        clearTimeout(durationTimer);
        durationTimer = undefined;
      }

      removeSubscriber();

      try {
        subscriber.controller?.close();
      } catch {
        // The client may already have closed the stream.
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        subscriber.controller = controller;
        subscriber.subscriberSequence =
          (maxSubscriberSequences.get(endpointId) ?? 0) + 1;
        maxSubscriberSequences.set(endpointId, subscriber.subscriberSequence);

        const endpointSubscribers =
          subscribers.get(endpointId) ??
          new Set<{
            controller: ReadableStreamDefaultController<Uint8Array>;
            deliveredIds: Set<EventId>;
            bufferPublishedEvents: boolean;
            bufferedPayloads: EventStreamPayload[];
            subscriberSequence: number;
          }>();
        endpointSubscribers.add({
          controller,
          deliveredIds: subscriber.deliveredIds,
          bufferPublishedEvents: subscriber.bufferPublishedEvents,
          bufferedPayloads: subscriber.bufferedPayloads,
          subscriberSequence: subscriber.subscriberSequence,
        });
        subscribers.set(endpointId, endpointSubscribers);

        if (options.maxDurationMilliseconds !== undefined) {
          durationTimer = setTimeout(
            closeSubscription,
            options.maxDurationMilliseconds,
          );
        }
      },
      cancel() {
        closeSubscription();
      },
    });

    return {
      stream,
      send: (payload) => {
        if (
          subscriber.controller !== null &&
          !subscriber.deliveredIds.has(payload.id)
        ) {
          subscriber.deliveredIds.add(payload.id);
          subscriber.controller.enqueue(encoder.encode(sseMessage(payload)));
        }
      },
      flushBuffered: () => {
        subscriber.bufferPublishedEvents = false;

        const endpointSubscribers = subscribers.get(endpointId);

        if (endpointSubscribers !== undefined) {
          for (const candidate of endpointSubscribers) {
            if (candidate.controller === subscriber.controller) {
              candidate.bufferPublishedEvents = false;
              break;
            }
          }
        }

        for (const payload of subscriber.bufferedPayloads) {
          if (
            subscriber.controller !== null &&
            !subscriber.deliveredIds.has(payload.id)
          ) {
            subscriber.deliveredIds.add(payload.id);
            subscriber.controller.enqueue(encoder.encode(sseMessage(payload)));
          }
        }

        subscriber.bufferedPayloads.length = 0;
      },
      cancel: async () => {
        closeSubscription();
      },
    };
  }

  async getSubscriberPresence(endpointId: EndpointId) {
    return {
      hasSubscribers: (this.#subscribers.get(endpointId)?.size ?? 0) > 0,
      maxSubscriberSequence: this.#maxSubscriberSequences.get(endpointId) ?? 0,
    };
  }

  async publish(
    endpointId: EndpointId,
    payload: EventStreamPayload,
    options: {
      maxSubscriberSequence?: number;
    } = {},
  ): Promise<void> {
    const endpointSubscribers = this.#subscribers.get(endpointId);

    if (endpointSubscribers === undefined) {
      return;
    }

    const message = this.#encoder.encode(sseMessage(payload));

    for (const subscriber of endpointSubscribers) {
      if (
        options.maxSubscriberSequence !== undefined &&
        subscriber.subscriberSequence > options.maxSubscriberSequence
      ) {
        continue;
      }

      if (subscriber.bufferPublishedEvents) {
        subscriber.bufferedPayloads.push(payload);
        continue;
      }

      if (!subscriber.deliveredIds.has(payload.id)) {
        subscriber.deliveredIds.add(payload.id);
        subscriber.controller.enqueue(message);
      }
    }
  }
}
