import type { EndpointId } from "@barestash/shared/ids";
import { describe, expect, it } from "vitest";
import type {
  EndpointSecretRepository,
  EventRepository,
  RequestBodyStore,
} from "../domain/ports.js";
import {
  deletePrivateEndpointData,
  RequestBodyObjectDeleteError,
} from "./delete-private-endpoint-data.js";

const endpointId = "ep_private" as EndpointId;

type EventRecord = {
  sequence: number;
  bodyR2Key: string;
  requestR2Key: string;
};

class EventRepositoryStub
  implements
    Pick<
      EventRepository,
      "listEventObjectKeysForEndpoint" | "deleteEventsForEndpoint"
    >
{
  readonly events: EventRecord[] = [];

  async listEventObjectKeysForEndpoint(
    id: EndpointId,
    options: { limit: number; afterSequence?: number },
  ) {
    if (id !== endpointId) {
      return [];
    }

    return this.events
      .filter((event) => event.sequence > (options.afterSequence ?? 0))
      .slice(0, options.limit)
      .map((event) => ({
        sequence: event.sequence,
        bodyR2Key: event.bodyR2Key,
        requestR2Key: event.requestR2Key,
      }));
  }

  async deleteEventsForEndpoint(id: EndpointId): Promise<number> {
    const before = this.events.length;
    const remaining = id === endpointId ? [] : this.events;
    this.events.length = 0;
    this.events.push(...remaining);

    return before - remaining.length;
  }
}

class EndpointSecretRepositoryStub
  implements Pick<EndpointSecretRepository, "deleteEndpointSecrets">
{
  readonly deletedEndpointIds: EndpointId[] = [];

  async deleteEndpointSecrets(id: EndpointId): Promise<void> {
    this.deletedEndpointIds.push(id);
  }
}

class RequestBodyStoreStub implements Pick<RequestBodyStore, "deleteMany"> {
  readonly objects = new Set<string>();
  readonly deleteManyBatches: string[][] = [];
  failNextDeleteMany = false;

  addObject(key: string): void {
    this.objects.add(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (this.failNextDeleteMany) {
      this.failNextDeleteMany = false;
      throw new Error("R2 delete failed");
    }

    this.deleteManyBatches.push(keys);

    for (const key of keys) {
      this.objects.delete(key);
    }
  }
}

describe("deletePrivateEndpointData", () => {
  it("deletes R2 objects, D1 events, endpoint secrets, and the endpoint record", async () => {
    const eventRepository = new EventRepositoryStub();
    const endpointSecretRepository = new EndpointSecretRepositoryStub();
    const requestBodyStore = new RequestBodyStoreStub();
    let endpointDeleted = false;

    eventRepository.events.push({
      sequence: 1,
      bodyR2Key: "events/ep_private/2026/07/09/evt_1/body.raw",
      requestR2Key: "events/ep_private/2026/07/09/evt_1/request.json",
    });
    requestBodyStore.addObject("events/ep_private/2026/07/09/evt_1/body.raw");
    requestBodyStore.addObject(
      "events/ep_private/2026/07/09/evt_1/request.json",
    );

    const result = await deletePrivateEndpointData({
      endpointId,
      eventRepository,
      endpointSecretRepository,
      requestBodyStore,
      deleteEndpointRecord: async () => {
        endpointDeleted = true;
        return true;
      },
    });

    expect(result).toEqual({
      deleted_events: 1,
      deleted_body_objects: 2,
      endpoint_deleted: true,
    });
    expect(endpointDeleted).toBe(true);
    expect(endpointSecretRepository.deletedEndpointIds).toEqual([endpointId]);
    expect(eventRepository.events).toEqual([]);
    expect(requestBodyStore.objects.size).toBe(0);
  });

  it("paginates R2 object deletion across event key pages and delete batches", async () => {
    const eventRepository = new EventRepositoryStub();
    const endpointSecretRepository = new EndpointSecretRepositoryStub();
    const requestBodyStore = new RequestBodyStoreStub();

    for (let index = 1; index <= 26; index += 1) {
      const bodyKey = `events/ep_private/2026/07/09/evt_${index}/body.raw`;
      const requestKey = `events/ep_private/2026/07/09/evt_${index}/request.json`;
      eventRepository.events.push({
        sequence: index,
        bodyR2Key: bodyKey,
        requestR2Key: requestKey,
      });
      requestBodyStore.addObject(bodyKey);
      requestBodyStore.addObject(requestKey);
    }

    const result = await deletePrivateEndpointData({
      endpointId,
      eventRepository,
      endpointSecretRepository,
      requestBodyStore,
      deleteEndpointRecord: async () => true,
    });

    expect(result).toEqual({
      deleted_events: 26,
      deleted_body_objects: 52,
      endpoint_deleted: true,
    });
    expect(
      requestBodyStore.deleteManyBatches.map((batch) => batch.length),
    ).toEqual([25, 25, 2]);
  });

  it("does not delete D1 metadata when R2 deletion fails", async () => {
    const eventRepository = new EventRepositoryStub();
    const endpointSecretRepository = new EndpointSecretRepositoryStub();
    const requestBodyStore = new RequestBodyStoreStub();
    let endpointDeleted = false;

    eventRepository.events.push({
      sequence: 1,
      bodyR2Key: "events/ep_private/2026/07/09/evt_1/body.raw",
      requestR2Key: "events/ep_private/2026/07/09/evt_1/request.json",
    });
    requestBodyStore.addObject("events/ep_private/2026/07/09/evt_1/body.raw");
    requestBodyStore.addObject(
      "events/ep_private/2026/07/09/evt_1/request.json",
    );
    requestBodyStore.failNextDeleteMany = true;

    await expect(
      deletePrivateEndpointData({
        endpointId,
        eventRepository,
        endpointSecretRepository,
        requestBodyStore,
        deleteEndpointRecord: async () => {
          endpointDeleted = true;
          return true;
        },
      }),
    ).rejects.toBeInstanceOf(RequestBodyObjectDeleteError);

    expect(endpointDeleted).toBe(false);
    expect(endpointSecretRepository.deletedEndpointIds).toEqual([]);
    expect(eventRepository.events).toHaveLength(1);
  });
});
