import type { EventStreamPayload } from "@barestash/shared/events";
import type { EventId } from "@barestash/shared/ids";
import { sseMessage } from "@barestash/shared/sse";
import { apiApp } from "./app.js";
import {
  CleanupR2DeleteError,
  runRetentionCleanup,
} from "./application/cleanup.js";
import type { Bindings } from "./container.js";
import { D1EndpointRepository } from "./infrastructure/d1/endpoint-repository.js";
import { D1EndpointSecretRepository } from "./infrastructure/d1/endpoint-secret-repository.js";
import { D1EventRepository } from "./infrastructure/d1/event-repository.js";
import { R2RequestBodyStore } from "./infrastructure/r2/request-body-store.js";

type EndpointStreamSubscriber = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  deliveredIds: Set<EventId>;
  subscriberSequence: number;
};

/** @public */
export class EndpointStream implements DurableObject {
  readonly #subscribers = new Set<EndpointStreamSubscriber>();
  readonly #encoder = new TextEncoder();
  #maxSubscriberSequence = 0;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/subscribe") {
      const object = this;
      const subscribers = this.#subscribers;
      let streamController: ReadableStreamDefaultController<Uint8Array> | null =
        null;
      const subscriber: EndpointStreamSubscriber = {
        controller:
          null as unknown as ReadableStreamDefaultController<Uint8Array>,
        deliveredIds: new Set<EventId>(),
        subscriberSequence: 0,
      };

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            subscriber.controller = controller;
            object.#maxSubscriberSequence += 1;
            subscriber.subscriberSequence = object.#maxSubscriberSequence;
            subscribers.add(subscriber);
          },
          cancel() {
            if (streamController !== null) {
              subscribers.delete(subscriber);
            }
          },
        }),
        {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        },
      );
    }

    if (request.method === "GET" && url.pathname === "/subscribers") {
      return Response.json({
        hasSubscribers: this.#subscribers.size > 0,
        maxSubscriberSequence: this.#maxSubscriberSequence,
      });
    }

    if (request.method === "POST" && url.pathname === "/publish") {
      const payload = (await request.json()) as EventStreamPayload;
      const message = this.#encoder.encode(sseMessage(payload));
      const maxSubscriberSequence = Number(
        url.searchParams.get("maxSubscriberSequence") ??
          Number.POSITIVE_INFINITY,
      );

      for (const subscriber of this.#subscribers) {
        if (subscriber.subscriberSequence > maxSubscriberSequence) {
          continue;
        }

        if (subscriber.deliveredIds.has(payload.id)) {
          continue;
        }

        subscriber.deliveredIds.add(payload.id);
        subscriber.controller.enqueue(message);
      }

      return new Response(null, {
        status: 204,
      });
    }

    return new Response("Not found", {
      status: 404,
    });
  }
}

const worker = {
  fetch: apiApp.fetch,
  async scheduled(controller, env) {
    if (env.DB === undefined || env.REQUEST_BODIES === undefined) {
      console.log(
        JSON.stringify({
          event: "barestash.cleanup.skipped",
          reason: "persistent_bindings_missing",
        }),
      );
      return;
    }

    try {
      const summary = await runRetentionCleanup({
        endpointRepository: new D1EndpointRepository(env.DB),
        endpointSecretRepository: new D1EndpointSecretRepository(env.DB),
        eventRepository: new D1EventRepository(env.DB),
        requestBodyStore: new R2RequestBodyStore(env.REQUEST_BODIES),
        now: new Date(controller.scheduledTime),
      });

      console.log(
        JSON.stringify({
          event: "barestash.cleanup.completed",
          ...summary,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "barestash.cleanup.failed",
          message:
            error instanceof CleanupR2DeleteError
              ? error.message
              : "Cleanup failed.",
        }),
      );
      throw error;
    }
  },
} satisfies ExportedHandler<Bindings>;

export default worker;
