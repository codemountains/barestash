import type { EndpointId, EventId } from "@barestash/shared/ids";
import { describe, expect, it } from "vitest";
import type { StoredEndpoint } from "../domain/endpoint.js";
import type {
  CleanupEndpointRepository,
  CleanupEventRepository,
  CleanupRequestBodyStore,
} from "../domain/ports.js";
import { runRetentionCleanup } from "./cleanup.js";

const now = new Date("2026-07-10T12:00:00.000Z");

function temporaryEndpoint(id: EndpointId): StoredEndpoint {
  return {
    id,
    name: null,
    mode: "temporary",
    status: "active",
    public_read: true,
    event_count: 1,
    event_limit: 100,
    expires_at: "2026-07-09T11:59:59.999Z",
    created_at: "2026-07-08T12:00:00.000Z",
    updated_at: "2026-07-08T12:00:00.000Z",
  };
}

class CleanupEndpointRepositoryStub implements CleanupEndpointRepository {
  readonly expiredTemporaryEndpoints = new Map<EndpointId, StoredEndpoint>();
  readonly expiredPrivateEndpoints = new Map<EndpointId, StoredEndpoint>();
  reconciledPrivateEndpointEventCounts = 0;

  async listExpiredTemporaryEndpoints(
    _now: Date,
    options: { limit: number },
  ): Promise<StoredEndpoint[]> {
    return Array.from(this.expiredTemporaryEndpoints.values()).slice(
      0,
      options.limit,
    );
  }

  async deleteTemporaryEndpoint(endpointId: EndpointId): Promise<boolean> {
    return this.expiredTemporaryEndpoints.delete(endpointId);
  }

  async listExpiredPrivateEndpoints(
    _now: Date,
    options: { limit: number },
  ): Promise<StoredEndpoint[]> {
    return Array.from(this.expiredPrivateEndpoints.values()).slice(
      0,
      options.limit,
    );
  }

  async deletePrivateEndpoint(endpointId: EndpointId): Promise<boolean> {
    return this.expiredPrivateEndpoints.delete(endpointId);
  }

  async reconcilePrivateEndpointEventCounts(): Promise<void> {
    this.reconciledPrivateEndpointEventCounts += 1;
  }
}

class CleanupEndpointSecretRepositoryStub {
  readonly deletedEndpointIds: EndpointId[] = [];

  async deleteEndpointSecrets(endpointId: EndpointId): Promise<void> {
    this.deletedEndpointIds.push(endpointId);
  }
}

type CleanupEventRecord = {
  sequence: number;
  id: EventId;
  endpointId: EndpointId;
  receivedAt: string;
  mode: "private" | "temporary";
  bodyR2Key: string;
  requestR2Key: string;
};

class CleanupEventRepositoryStub implements CleanupEventRepository {
  readonly events: CleanupEventRecord[] = [];

  async listEventObjectKeysForEndpoint(
    endpointId: EndpointId,
    options: { limit: number; afterSequence?: number },
  ) {
    return this.events
      .filter(
        (event) =>
          event.endpointId === endpointId &&
          event.sequence > (options.afterSequence ?? 0),
      )
      .slice(0, options.limit)
      .map((event) => ({
        sequence: event.sequence,
        bodyR2Key: event.bodyR2Key,
        requestR2Key: event.requestR2Key,
      }));
  }

  async deleteEventsForEndpoint(endpointId: EndpointId): Promise<number> {
    const before = this.events.length;
    const remaining = this.events.filter(
      (event) => event.endpointId !== endpointId,
    );
    this.events.length = 0;
    this.events.push(...remaining);

    return before - remaining.length;
  }

  async listExpiredPrivateEventObjectKeys(
    cutoff: Date,
    options: { limit: number; afterSequence?: number },
  ) {
    return this.events
      .filter(
        (event) =>
          event.mode === "private" &&
          event.sequence > (options.afterSequence ?? 0) &&
          Date.parse(event.receivedAt) < cutoff.getTime(),
      )
      .slice(0, options.limit)
      .map((event) => ({
        sequence: event.sequence,
        eventId: event.id,
        endpointId: event.endpointId,
        bodyR2Key: event.bodyR2Key,
        requestR2Key: event.requestR2Key,
      }));
  }

  async deleteEventsByIds(
    eventIds: EventId[],
  ): Promise<{ eventId: EventId; endpointId: EndpointId }[]> {
    const eventIdSet = new Set(eventIds);
    const deleted = this.events
      .filter((event) => eventIdSet.has(event.id))
      .map((event) => ({ eventId: event.id, endpointId: event.endpointId }));
    const remaining = this.events.filter((event) => !eventIdSet.has(event.id));
    this.events.length = 0;
    this.events.push(...remaining);

    return deleted;
  }

  async eventExists(eventId: EventId): Promise<boolean> {
    return this.events.some((event) => event.id === eventId);
  }
}

class CleanupRequestBodyStoreStub implements CleanupRequestBodyStore {
  readonly objects = new Map<string, { value: Uint8Array; uploaded: Date }>();
  readonly deleteManyBatches: string[][] = [];
  failNextDeleteMany = false;

  setObject(key: string, uploaded: Date): void {
    this.objects.set(key, { value: new Uint8Array(), uploaded });
  }

  async put(key: string, value: Uint8Array | string): Promise<void> {
    this.objects.set(key, {
      value:
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      uploaded: now,
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.value ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
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

  async listObjects(options: {
    prefix: string;
    cursor?: string;
    limit: number;
  }) {
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    const matching = Array.from(this.objects.entries())
      .filter(([key]) => key.startsWith(options.prefix))
      .sort(([left], [right]) => left.localeCompare(right));
    const page = matching.slice(start, start + options.limit);
    const next = start + page.length;
    const objects = page.map(([key, object]) => ({
      key,
      uploaded: object.uploaded,
    }));

    if (next < matching.length) {
      return {
        objects,
        truncated: true as const,
        cursor: String(next),
      };
    }

    return {
      objects,
      truncated: false as const,
    };
  }
}

describe("runRetentionCleanup", () => {
  it("deletes expired temporary endpoints, their events, and their R2 objects", async () => {
    const endpointRepository = new CleanupEndpointRepositoryStub();
    const eventRepository = new CleanupEventRepositoryStub();
    const requestBodyStore = new CleanupRequestBodyStoreStub();
    const endpointSecretRepository = new CleanupEndpointSecretRepositoryStub();
    const endpointId = "ep_expired" as EndpointId;

    endpointRepository.expiredTemporaryEndpoints.set(
      endpointId,
      temporaryEndpoint(endpointId),
    );
    eventRepository.events.push({
      sequence: 1,
      id: "evt_temp_old" as EventId,
      endpointId,
      receivedAt: "2026-07-09T10:00:00.000Z",
      mode: "temporary",
      bodyR2Key: "events/ep_expired/2026/07/09/evt_temp_old/body.raw",
      requestR2Key: "events/ep_expired/2026/07/09/evt_temp_old/request.json",
    });
    requestBodyStore.setObject(
      "events/ep_expired/2026/07/09/evt_temp_old/body.raw",
      new Date("2026-07-09T10:00:00.000Z"),
    );
    requestBodyStore.setObject(
      "events/ep_expired/2026/07/09/evt_temp_old/request.json",
      new Date("2026-07-09T10:00:00.000Z"),
    );

    const summary = await runRetentionCleanup({
      endpointRepository,
      endpointSecretRepository,
      eventRepository,
      requestBodyStore,
      now,
    });

    expect(summary).toEqual(
      expect.objectContaining({
        expired_temporary_endpoints_deleted: 1,
        temporary_events_deleted: 1,
        expired_private_endpoints_deleted: 0,
        expired_private_endpoint_events_deleted: 0,
        private_events_deleted: 0,
        orphan_objects_deleted: 0,
        r2_objects_deleted: 2,
      }),
    );
    expect(endpointRepository.expiredTemporaryEndpoints.has(endpointId)).toBe(
      false,
    );
    expect(eventRepository.events).toEqual([]);
    expect(Array.from(requestBodyStore.objects.keys())).toEqual([]);
  });

  it("deletes expired private endpoints, their events, secrets, and R2 objects", async () => {
    const endpointRepository = new CleanupEndpointRepositoryStub();
    const eventRepository = new CleanupEventRepositoryStub();
    const requestBodyStore = new CleanupRequestBodyStoreStub();
    const endpointSecretRepository = new CleanupEndpointSecretRepositoryStub();
    const endpointId = "ep_private_expired" as EndpointId;

    endpointRepository.expiredPrivateEndpoints.set(endpointId, {
      id: endpointId,
      name: null,
      mode: "private",
      status: "active",
      public_read: false,
      event_count: 1,
      event_limit: 1000,
      expires_at: "2026-07-10T11:59:59.999Z",
      created_at: "2026-07-03T12:00:00.000Z",
      updated_at: "2026-07-03T12:00:00.000Z",
    });
    eventRepository.events.push({
      sequence: 1,
      id: "evt_private_expired" as EventId,
      endpointId,
      receivedAt: "2026-07-09T10:00:00.000Z",
      mode: "private",
      bodyR2Key:
        "events/ep_private_expired/2026/07/09/evt_private_expired/body.raw",
      requestR2Key:
        "events/ep_private_expired/2026/07/09/evt_private_expired/request.json",
    });
    requestBodyStore.setObject(
      "events/ep_private_expired/2026/07/09/evt_private_expired/body.raw",
      new Date("2026-07-09T10:00:00.000Z"),
    );
    requestBodyStore.setObject(
      "events/ep_private_expired/2026/07/09/evt_private_expired/request.json",
      new Date("2026-07-09T10:00:00.000Z"),
    );

    const summary = await runRetentionCleanup({
      endpointRepository,
      endpointSecretRepository,
      eventRepository,
      requestBodyStore,
      now,
    });

    expect(summary).toEqual(
      expect.objectContaining({
        expired_private_endpoints_deleted: 1,
        expired_private_endpoint_events_deleted: 1,
        private_events_deleted: 0,
        r2_objects_deleted: 2,
      }),
    );
    expect(endpointRepository.expiredPrivateEndpoints.has(endpointId)).toBe(
      false,
    );
    expect(endpointSecretRepository.deletedEndpointIds).toEqual([endpointId]);
    expect(eventRepository.events).toEqual([]);
    expect(Array.from(requestBodyStore.objects.keys())).toEqual([]);
  });

  it("deletes only private events older than the 7-day retention period", async () => {
    const endpointRepository = new CleanupEndpointRepositoryStub();
    const eventRepository = new CleanupEventRepositoryStub();
    const requestBodyStore = new CleanupRequestBodyStoreStub();
    const endpointSecretRepository = new CleanupEndpointSecretRepositoryStub();

    eventRepository.events.push(
      {
        sequence: 1,
        id: "evt_private_old" as EventId,
        endpointId: "ep_private" as EndpointId,
        receivedAt: "2026-07-03T11:59:59.999Z",
        mode: "private",
        bodyR2Key: "events/ep_private/2026/07/03/evt_private_old/body.raw",
        requestR2Key:
          "events/ep_private/2026/07/03/evt_private_old/request.json",
      },
      {
        sequence: 2,
        id: "evt_private_recent" as EventId,
        endpointId: "ep_private" as EndpointId,
        receivedAt: "2026-07-03T12:00:00.000Z",
        mode: "private",
        bodyR2Key: "events/ep_private/2026/07/03/evt_private_recent/body.raw",
        requestR2Key:
          "events/ep_private/2026/07/03/evt_private_recent/request.json",
      },
    );
    for (const event of eventRepository.events) {
      requestBodyStore.setObject(event.bodyR2Key, new Date(event.receivedAt));
      requestBodyStore.setObject(
        event.requestR2Key,
        new Date(event.receivedAt),
      );
    }

    const summary = await runRetentionCleanup({
      endpointRepository,
      endpointSecretRepository,
      eventRepository,
      requestBodyStore,
      now,
    });

    expect(summary.private_events_deleted).toBe(1);
    expect(summary.r2_objects_deleted).toBe(2);
    expect(eventRepository.events.map((event) => event.id)).toEqual([
      "evt_private_recent",
    ]);
    expect(endpointRepository.reconciledPrivateEndpointEventCounts).toBe(1);
    expect(Array.from(requestBodyStore.objects.keys()).sort()).toEqual([
      "events/ep_private/2026/07/03/evt_private_recent/body.raw",
      "events/ep_private/2026/07/03/evt_private_recent/request.json",
    ]);
  });

  it("reconciles private endpoint event counts even when no retention events remain", async () => {
    const endpointRepository = new CleanupEndpointRepositoryStub();
    const eventRepository = new CleanupEventRepositoryStub();
    const requestBodyStore = new CleanupRequestBodyStoreStub();
    const endpointSecretRepository = new CleanupEndpointSecretRepositoryStub();

    const summary = await runRetentionCleanup({
      endpointRepository,
      endpointSecretRepository,
      eventRepository,
      requestBodyStore,
      now,
    });

    expect(summary.private_events_deleted).toBe(0);
    expect(endpointRepository.reconciledPrivateEndpointEventCounts).toBe(1);
  });

  it("deletes old orphan body.raw and request.json R2 objects without reading their values", async () => {
    const endpointRepository = new CleanupEndpointRepositoryStub();
    const eventRepository = new CleanupEventRepositoryStub();
    const requestBodyStore = new CleanupRequestBodyStoreStub();
    const endpointSecretRepository = new CleanupEndpointSecretRepositoryStub();

    requestBodyStore.setObject(
      "events/ep_orphan/2026/07/10/evt_orphan/body.raw",
      new Date("2026-07-10T10:59:59.999Z"),
    );
    requestBodyStore.setObject(
      "events/ep_orphan/2026/07/10/evt_orphan/request.json",
      new Date("2026-07-10T10:59:59.999Z"),
    );
    requestBodyStore.setObject(
      "events/ep_recent/2026/07/10/evt_recent/body.raw",
      new Date("2026-07-10T11:30:00.000Z"),
    );
    requestBodyStore.setObject(
      "events/ep_misc/2026/07/10/evt_misc/debug.txt",
      new Date("2026-07-10T10:00:00.000Z"),
    );

    const summary = await runRetentionCleanup({
      endpointRepository,
      endpointSecretRepository,
      eventRepository,
      requestBodyStore,
      now,
    });

    expect(summary.orphan_objects_deleted).toBe(2);
    expect(summary.r2_objects_deleted).toBe(2);
    expect(Array.from(requestBodyStore.objects.keys()).sort()).toEqual([
      "events/ep_misc/2026/07/10/evt_misc/debug.txt",
      "events/ep_recent/2026/07/10/evt_recent/body.raw",
    ]);
  });

  it("does not skip orphan R2 objects when cleanup spans multiple list pages", async () => {
    const endpointRepository = new CleanupEndpointRepositoryStub();
    const eventRepository = new CleanupEventRepositoryStub();
    const requestBodyStore = new CleanupRequestBodyStoreStub();
    const endpointSecretRepository = new CleanupEndpointSecretRepositoryStub();

    for (let index = 0; index < 1001; index += 1) {
      requestBodyStore.setObject(
        `events/ep_orphan/2026/07/10/evt_orphan_${index}/body.raw`,
        new Date("2026-07-10T10:00:00.000Z"),
      );
    }

    const summary = await runRetentionCleanup({
      endpointRepository,
      endpointSecretRepository,
      eventRepository,
      requestBodyStore,
      now,
    });

    expect(summary.orphan_objects_deleted).toBe(1001);
    expect(requestBodyStore.objects.size).toBe(0);
  });

  it("keeps D1 metadata retryable when R2 deletion fails", async () => {
    const endpointRepository = new CleanupEndpointRepositoryStub();
    const eventRepository = new CleanupEventRepositoryStub();
    const requestBodyStore = new CleanupRequestBodyStoreStub();
    const endpointSecretRepository = new CleanupEndpointSecretRepositoryStub();

    eventRepository.events.push({
      sequence: 1,
      id: "evt_private_old" as EventId,
      endpointId: "ep_private" as EndpointId,
      receivedAt: "2026-07-03T11:59:59.999Z",
      mode: "private",
      bodyR2Key: "events/ep_private/2026/07/03/evt_private_old/body.raw",
      requestR2Key: "events/ep_private/2026/07/03/evt_private_old/request.json",
    });
    requestBodyStore.setObject(
      "events/ep_private/2026/07/03/evt_private_old/body.raw",
      new Date("2026-07-03T11:59:59.999Z"),
    );
    requestBodyStore.setObject(
      "events/ep_private/2026/07/03/evt_private_old/request.json",
      new Date("2026-07-03T11:59:59.999Z"),
    );
    requestBodyStore.failNextDeleteMany = true;

    await expect(
      runRetentionCleanup({
        endpointRepository,
        endpointSecretRepository,
        eventRepository,
        requestBodyStore,
        now,
      }),
    ).rejects.toThrow("Failed to delete request body objects.");

    expect(eventRepository.events.map((event) => event.id)).toEqual([
      "evt_private_old",
    ]);
    expect(endpointRepository.reconciledPrivateEndpointEventCounts).toBe(0);
  });
});
