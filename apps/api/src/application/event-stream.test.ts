import type { EventStreamPayload } from "@barestash/shared/events";
import type { EndpointId, EventId } from "@barestash/shared/ids";
import { describe, expect, it, vi } from "vitest";
import { type EventListRecord, MAX_BODY_SIZE_BYTES } from "../domain/event.js";
import type {
  EventRepository,
  EventStreamCoordinator,
  EventStreamSubscription,
  RequestBodyStore,
} from "../domain/ports.js";
import { InMemoryAuthDomainRepository } from "../infrastructure/in-memory/auth-domain-repository.js";
import {
  fixedNow,
  makeTemporaryEndpointRepository,
} from "../testing/helpers.js";
import { openEventStream } from "./event-stream.js";

const endpointId = "ep_01JDEF" as EndpointId;

function makeCatchUpEvent(index: number, bodySize = 1): EventListRecord {
  const id = `evt_catchup_${index}` as EventId;

  return {
    id,
    endpoint_id: endpointId,
    received_at: `2026-07-05T12:00:${String(index).padStart(2, "0")}.000Z`,
    method: "POST",
    request_path: `/catch-up/${index}`,
    query_json: "{}",
    allowlist_headers_json: '{"content-type":"text/plain"}',
    body_size: bodySize,
    body_sha256: `sha256-${index}`,
    body_r2_key: `${id}/body.raw`,
    request_r2_key: `${id}/request.json`,
  };
}

function makeEventRepository(events: EventListRecord[]): EventRepository {
  return {
    async countEventsForEndpoint() {
      return events.length;
    },
    async createEvent() {
      throw new Error("not used");
    },
    async listEventsForEndpoint() {
      return events;
    },
    async findEvent() {
      return null;
    },
    async listEventObjectKeysForEndpoint() {
      return [];
    },
    async deleteEventsForEndpoint() {
      return 0;
    },
  };
}

class ControlledCatchUpBodyStore implements RequestBodyStore {
  readonly startedEventIds = new Set<EventId>();
  activeReads = 0;
  maxActiveReads = 0;
  missingKey: string | null = null;
  readonly #releasedEventIds = new Set<EventId>();
  readonly #releaseResolvers = new Map<EventId, (() => void)[]>();

  async put(): Promise<void> {
    throw new Error("not used");
  }

  async get(key: string): Promise<Uint8Array | null> {
    const eventId = key.slice(0, key.indexOf("/")) as EventId;
    this.startedEventIds.add(eventId);
    this.activeReads += 1;
    this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);

    try {
      if (!this.#releasedEventIds.has(eventId)) {
        await new Promise<void>((resolve) => {
          const resolvers = this.#releaseResolvers.get(eventId) ?? [];
          resolvers.push(resolve);
          this.#releaseResolvers.set(eventId, resolvers);
        });
      }

      if (key === this.missingKey) {
        return null;
      }

      if (key.endsWith("/request.json")) {
        return new TextEncoder().encode(
          JSON.stringify({
            request_path: `/catch-up/${eventId}`,
            query: {},
            headers: {
              "content-type": "text/plain",
            },
          }),
        );
      }

      return new TextEncoder().encode(eventId);
    } finally {
      this.activeReads -= 1;
    }
  }

  async delete(): Promise<void> {
    throw new Error("not used");
  }

  async deleteMany(): Promise<void> {
    throw new Error("not used");
  }

  release(eventId: EventId): void {
    this.#releasedEventIds.add(eventId);

    for (const resolve of this.#releaseResolvers.get(eventId) ?? []) {
      resolve();
    }

    this.#releaseResolvers.delete(eventId);
  }
}

function makeStreamCoordinator() {
  const sentPayloads: EventStreamPayload[] = [];
  const flushBuffered = vi.fn();
  const cancel = vi.fn();
  const subscription: EventStreamSubscription = {
    stream: new ReadableStream<Uint8Array>(),
    send(payload) {
      sentPayloads.push(payload);
    },
    flushBuffered,
    cancel,
  };
  const coordinator: EventStreamCoordinator = {
    async subscribe() {
      return subscription;
    },
    async getSubscriberPresence() {
      return { hasSubscribers: true, maxSubscriberSequence: 1 };
    },
    async publish() {},
  };

  return {
    coordinator,
    sentPayloads,
    flushBuffered,
    cancel,
  };
}

async function startCatchUp(
  events: EventListRecord[],
  requestBodyStore: RequestBodyStore,
  streamCoordinator: EventStreamCoordinator,
): Promise<void> {
  const result = await openEventStream({
    endpointRepository: makeTemporaryEndpointRepository(),
    tokenRepository: new InMemoryAuthDomainRepository(),
    eventRepository: makeEventRepository(events),
    requestBodyStore,
    streamCoordinator,
    now: fixedNow,
    authorizationHeader: null,
    endpointId,
    lastEventIdHeader: "evt_cursor",
  });

  expect(result.kind).toBe("ok");
}

describe("openEventStream catch-up", () => {
  it("loads catch-up payloads with bounded concurrency and sends them in canonical order", async () => {
    const events = Array.from({ length: 8 }, (_, index) =>
      makeCatchUpEvent(index + 1),
    );
    const bodyStore = new ControlledCatchUpBodyStore();
    const stream = makeStreamCoordinator();

    await startCatchUp(events, bodyStore, stream.coordinator);

    await vi.waitFor(
      () => {
        expect(bodyStore.startedEventIds).toEqual(
          new Set(events.slice(0, 3).map((event) => event.id)),
        );
      },
      { timeout: 200 },
    );

    expect(bodyStore.maxActiveReads).toBe(6);

    for (const event of events.slice(1, 3).reverse()) {
      bodyStore.release(event.id);
    }

    expect(stream.sentPayloads).toEqual([]);

    bodyStore.release(events[0].id);

    await vi.waitFor(() => {
      expect(stream.sentPayloads.map((payload) => payload.id)).toEqual(
        events.slice(0, 3).map((event) => event.id),
      );
      expect(bodyStore.startedEventIds).toEqual(
        new Set(events.slice(0, 6).map((event) => event.id)),
      );
    });

    for (const event of events.slice(3, 6).reverse()) {
      bodyStore.release(event.id);
    }

    await vi.waitFor(() => {
      expect(stream.sentPayloads.map((payload) => payload.id)).toEqual(
        events.slice(0, 6).map((event) => event.id),
      );
      expect(bodyStore.startedEventIds).toEqual(
        new Set(events.map((event) => event.id)),
      );
    });

    bodyStore.release(events[7].id);
    bodyStore.release(events[6].id);

    await vi.waitFor(() => {
      expect(stream.sentPayloads.map((payload) => payload.id)).toEqual(
        events.map((event) => event.id),
      );
      expect(stream.flushBuffered).toHaveBeenCalledOnce();
    });

    expect(bodyStore.maxActiveReads).toBeLessThanOrEqual(6);
    expect(stream.cancel).not.toHaveBeenCalled();
  });

  it("limits maximum-sized bodies that may be materialized concurrently", async () => {
    const events = Array.from({ length: 3 }, (_, index) =>
      makeCatchUpEvent(index + 1, MAX_BODY_SIZE_BYTES),
    );
    const bodyStore = new ControlledCatchUpBodyStore();
    const stream = makeStreamCoordinator();

    await startCatchUp(events, bodyStore, stream.coordinator);

    await vi.waitFor(() => {
      expect(bodyStore.startedEventIds).toEqual(
        new Set(events.slice(0, 2).map((event) => event.id)),
      );
    });

    bodyStore.release(events[0].id);

    await vi.waitFor(() => {
      expect(stream.sentPayloads.map((payload) => payload.id)).toEqual([
        events[0].id,
      ]);
      expect(bodyStore.startedEventIds).toEqual(
        new Set(events.map((event) => event.id)),
      );
    });

    bodyStore.release(events[2].id);
    bodyStore.release(events[1].id);

    await vi.waitFor(() => {
      expect(stream.sentPayloads.map((payload) => payload.id)).toEqual(
        events.map((event) => event.id),
      );
      expect(stream.flushBuffered).toHaveBeenCalledOnce();
    });

    expect(bodyStore.maxActiveReads).toBeLessThanOrEqual(4);
    expect(stream.cancel).not.toHaveBeenCalled();
  });

  it("cancels without flushing the live buffer when a catch-up payload cannot be loaded", async () => {
    const events = [makeCatchUpEvent(1), makeCatchUpEvent(2)];
    const bodyStore = new ControlledCatchUpBodyStore();
    bodyStore.missingKey = events[1].body_r2_key;
    const stream = makeStreamCoordinator();

    await startCatchUp(events, bodyStore, stream.coordinator);

    bodyStore.release(events[1].id);

    await vi.waitFor(() => {
      expect(stream.cancel).toHaveBeenCalledOnce();
    });

    expect(stream.flushBuffered).not.toHaveBeenCalled();
    bodyStore.release(events[0].id);
  });
});
