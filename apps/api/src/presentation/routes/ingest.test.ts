import type { EndpointSecretCreateResponse } from "@barestash/shared/endpoint-secrets";
import type { EndpointId, EventId } from "@barestash/shared/ids";
import { describe, expect, it } from "vitest";
import { createApiApp } from "../../app.js";
import type {
  EndpointRepository,
  EndpointSecretRepository,
  EventRepository,
} from "../../domain/ports.js";
import { InMemoryAuthDomainRepository } from "../../infrastructure/in-memory/auth-domain-repository.js";
import { InMemoryEndpointRepository } from "../../infrastructure/in-memory/endpoint-repository.js";
import { InMemoryEventStreamCoordinator } from "../../infrastructure/in-memory/event-stream-coordinator.js";
import { createTestApiApp } from "../../testing/api-app.js";
import {
  FailingRequestBodyStore,
  fixedNow,
  hashCredentialForTest,
  makeTemporaryEndpointRepository,
  RecordingEventRepository,
  RecordingRequestBodyStore,
  seedTestPersonalAccessToken,
  sha256Hex,
  testTokenId,
  unusedEndpointEventSlots,
} from "../../testing/helpers.js";

describe("temporary endpoint ingest routes", () => {
  it("stores raw request bytes, request envelopes, and D1 event metadata before returning 204", async () => {
    const bodyBytes = new Uint8Array([0, 1, 2, 255]);
    const bodyStore = new RecordingRequestBodyStore();
    const eventRepository = new RecordingEventRepository();
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository,
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: () => "evt_01JXYZ",
    });

    const response = await app.request(
      "https://ingest.example.com/ep_01JDEF/webhook/stripe?debug=true&tag=a&tag=b",
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "user-agent": "Stripe/1.0",
          authorization: "Bearer raw-token",
          "stripe-signature": "t=raw,v1=raw",
          "x-barestash-bootstrap-token":
            "bootstrap-secret-for-local-staging-tests-ok",
          "x-barestash-secret": "endpoint-secret",
        },
        body: bodyBytes,
      },
    );

    const bodyR2Key = "events/ep_01JDEF/2026/07/05/evt_01JXYZ/body.raw";
    const requestR2Key = "events/ep_01JDEF/2026/07/05/evt_01JXYZ/request.json";

    expect(response.status).toBe(204);
    expect(response.headers.get("x-barestash-event-id")).toBe("evt_01JXYZ");
    expect(response.headers.get("x-barestash-endpoint-id")).toBe("ep_01JDEF");
    expect(await response.text()).toBe("");
    expect(bodyStore.puts).toEqual([bodyR2Key, requestR2Key]);
    expect(bodyStore.objects.get(bodyR2Key)).toEqual(bodyBytes);
    expect(eventRepository.events).toHaveLength(1);
    expect(eventRepository.events[0]).toEqual({
      id: "evt_01JXYZ",
      endpoint_id: "ep_01JDEF",
      received_at: "2026-07-05T12:00:00.000Z",
      method: "POST",
      ingest_path: "/ep_01JDEF/webhook/stripe",
      request_path: "/webhook/stripe",
      query_json: JSON.stringify({
        debug: "true",
        tag: ["a", "b"],
      }),
      allowlist_headers_json: JSON.stringify({
        "content-type": "application/octet-stream",
        "user-agent": "Stripe/1.0",
      }),
      sensitive_header_names_json: JSON.stringify([
        "authorization",
        "stripe-signature",
      ]),
      content_type: "application/octet-stream",
      content_length: null,
      user_agent: "Stripe/1.0",
      body_size: bodyBytes.byteLength,
      body_sha256: await sha256Hex(bodyBytes),
      body_r2_key: bodyR2Key,
      request_r2_key: requestR2Key,
      secret_verification_status: "not_configured",
      matched_secret_id: null,
      created_at: "2026-07-05T12:00:00.000Z",
    });

    const envelope = JSON.parse(bodyStore.text(requestR2Key)) as {
      headers: Record<string, string>;
      body: { r2_key: string; size: number; sha256: string };
      query: Record<string, string | string[]>;
    };
    expect(envelope).toMatchObject({
      event_id: "evt_01JXYZ",
      endpoint_id: "ep_01JDEF",
      received_at: "2026-07-05T12:00:00.000Z",
      method: "POST",
      ingest_path: "/ep_01JDEF/webhook/stripe",
      request_path: "/webhook/stripe",
      query: {
        debug: "true",
        tag: ["a", "b"],
      },
      body: {
        r2_key: bodyR2Key,
        size: bodyBytes.byteLength,
        sha256: await sha256Hex(bodyBytes),
      },
    });
    expect(envelope.headers).toEqual({
      authorization: "Bearer raw-token",
      "content-type": "application/octet-stream",
      "stripe-signature": "t=raw,v1=raw",
      "user-agent": "Stripe/1.0",
    });
    expect(envelope.headers).not.toHaveProperty("x-barestash-bootstrap-token");
    expect(envelope.headers).not.toHaveProperty("x-barestash-secret");
  });

  it("stores JSON, text, and empty bodies as raw bytes without parsing body content into D1", async () => {
    const bodyStore = new RecordingRequestBodyStore();
    const eventRepository = new RecordingEventRepository();
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository,
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: (() => {
        const ids: EventId[] = ["evt_json", "evt_text", "evt_empty"];

        return () => ids.shift() ?? "evt_extra";
      })(),
    });

    await app.request("https://ingest.example.com/ep_01JDEF/json", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: '{"ok":true}',
    });
    await app.request("https://ingest.example.com/ep_01JDEF/text", {
      method: "PUT",
      headers: {
        "content-type": "text/plain",
      },
      body: "hello",
    });
    await app.request("https://ingest.example.com/ep_01JDEF/empty", {
      method: "DELETE",
    });

    expect(
      bodyStore.text("events/ep_01JDEF/2026/07/05/evt_json/body.raw"),
    ).toBe('{"ok":true}');
    expect(
      bodyStore.text("events/ep_01JDEF/2026/07/05/evt_text/body.raw"),
    ).toBe("hello");
    expect(
      bodyStore.objects.get("events/ep_01JDEF/2026/07/05/evt_empty/body.raw"),
    ).toEqual(new Uint8Array());
    expect(eventRepository.events.map((event) => event.body_size)).toEqual([
      11, 5, 0,
    ]);
    expect(JSON.stringify(eventRepository.events)).not.toContain("hello");
    expect(JSON.stringify(eventRepository.events)).not.toContain('"ok"');
  });

  it("rejects missing, expired, oversized, and event-limit-exceeded ingest requests without storing objects", async () => {
    const bodyStore = new RecordingRequestBodyStore();

    const limitResponse = await createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository({
        event_count: 100,
      }),
      eventRepository: new RecordingEventRepository(),
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: () => "evt_limit",
    }).request("https://ingest.example.com/ep_01JDEF", {
      method: "POST",
      body: "over limit",
    });

    const expiredResponse = await createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository({
        expires_at: "2026-07-05T11:59:59.999Z",
      }),
      eventRepository: new RecordingEventRepository(),
      requestBodyStore: bodyStore,
      now: () => fixedNow,
    }).request("https://ingest.example.com/ep_01JDEF", {
      method: "POST",
      body: "expired",
    });

    const missingResponse = await createTestApiApp({
      endpointRepository: {
        ...unusedEndpointEventSlots,
        async createTemporaryEndpoint() {
          throw new Error("not used");
        },
        async listActiveTemporaryEndpoints() {
          return [];
        },
        async findEndpoint() {
          return null;
        },
      },
      eventRepository: new RecordingEventRepository(),
      requestBodyStore: bodyStore,
      now: () => fixedNow,
    }).request("https://ingest.example.com/ep_missing", {
      method: "POST",
      body: "missing",
    });

    const oversizedResponse = await createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository: new RecordingEventRepository(),
      requestBodyStore: bodyStore,
      now: () => fixedNow,
    }).request("https://ingest.example.com/ep_01JDEF", {
      method: "POST",
      headers: {
        "content-length": String(10 * 1024 * 1024 + 1),
      },
      body: "not read",
    });

    const oversizedReadResponse = await createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository: new RecordingEventRepository(),
      requestBodyStore: bodyStore,
      now: () => fixedNow,
    }).request("https://ingest.example.com/ep_01JDEF", {
      method: "POST",
      body: new Uint8Array(10 * 1024 * 1024 + 1),
    });

    expect(limitResponse.status).toBe(429);
    expect(await limitResponse.json()).toEqual({
      error: {
        code: "event_limit_exceeded",
        message: "Endpoint has reached the 100-event limit.",
      },
    });
    expect(expiredResponse.status).toBe(410);
    expect(await expiredResponse.json()).toEqual({
      error: {
        code: "endpoint_expired",
        message: "Endpoint expired: ep_01JDEF",
      },
    });
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({
      error: {
        code: "endpoint_not_found",
        message: "Endpoint not found: ep_missing",
      },
    });
    expect(oversizedResponse.status).toBe(413);
    expect(await oversizedResponse.json()).toEqual({
      error: {
        code: "payload_too_large",
        message: "Request body exceeds the 10MB limit.",
      },
    });
    expect(oversizedReadResponse.status).toBe(413);
    expect(await oversizedReadResponse.json()).toEqual({
      error: {
        code: "payload_too_large",
        message: "Request body exceeds the 10MB limit.",
      },
    });
    expect(bodyStore.puts).toEqual([]);
  });

  it("rejects private ingest at the 1000-event limit without storing objects", async () => {
    const bodyStore = new RecordingRequestBodyStore();
    const eventRepository = new RecordingEventRepository();
    const response = await createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository({
        id: "ep_private" as EndpointId,
        mode: "private",
        public_read: false,
        event_count: 1000,
        event_limit: 1000,
        expires_at: "2026-07-12T12:00:00.000Z",
      }),
      eventRepository,
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: () => "evt_private_limit",
    }).request("https://ingest.example.com/ep_private", {
      method: "POST",
      body: "over private limit",
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: {
        code: "event_limit_exceeded",
        message: "Endpoint has reached the 1000-event limit.",
      },
    });
    expect(bodyStore.puts).toEqual([]);
    expect(eventRepository.events).toEqual([]);
  });

  it("rejects over-limit private ingest before checking configured ingest secrets", async () => {
    const bodyStore = new RecordingRequestBodyStore();
    const eventRepository = new RecordingEventRepository();
    const response = await createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository({
        id: "ep_private" as EndpointId,
        mode: "private",
        public_read: false,
        event_count: 1000,
        event_limit: 1000,
        expires_at: "2026-07-12T12:00:00.000Z",
      }),
      endpointSecretRepository: {
        async createEndpointSecret() {
          throw new Error("not used");
        },
        async listEndpointSecrets() {
          return [];
        },
        async listActiveEndpointSecrets() {
          return [
            {
              id: "sec_active",
              endpoint_id: "ep_private" as EndpointId,
              secret_hash: "hash",
              status: "active",
              created_at: "2026-07-05T12:00:00.000Z",
              last_used_at: null,
              revoked_at: null,
            },
          ];
        },
        async updateEndpointSecretLastUsed() {
          throw new Error("not used");
        },
        async revokeEndpointSecret() {
          return null;
        },
        async deleteEndpointSecrets() {},
      } satisfies EndpointSecretRepository,
      eventRepository,
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: () => "evt_private_limit_with_secret",
    }).request("https://ingest.example.com/ep_private", {
      method: "POST",
      body: "over private limit",
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: {
        code: "event_limit_exceeded",
        message: "Endpoint has reached the 1000-event limit.",
      },
    });
    expect(bodyStore.puts).toEqual([]);
    expect(eventRepository.events).toEqual([]);
  });

  it("rejects private ingest when reservation runs after TTL expiry", async () => {
    let getNowCalls = 0;
    const bodyStore = new RecordingRequestBodyStore();
    const eventRepository = new RecordingEventRepository();
    const response = await createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository({
        id: "ep_private" as EndpointId,
        mode: "private",
        public_read: false,
        event_count: 0,
        event_limit: 1000,
        expires_at: "2026-07-05T12:00:00.000Z",
        created_at: "2026-06-28T12:00:00.000Z",
        updated_at: "2026-06-28T12:00:00.000Z",
      }),
      eventRepository,
      requestBodyStore: bodyStore,
      now: () => {
        getNowCalls += 1;

        return getNowCalls === 1
          ? new Date("2026-07-05T11:59:59.999Z")
          : new Date("2026-07-05T12:00:00.001Z");
      },
      generateEventId: () => "evt_private_ttl_stale_now",
    }).request("https://ingest.example.com/ep_private", {
      method: "POST",
      body: "stale now race",
    });

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: {
        code: "endpoint_expired",
        message: "Endpoint expired: ep_private",
      },
    });
    expect(bodyStore.puts).toEqual([]);
    expect(eventRepository.events).toEqual([]);
  });

  it("returns endpoint_expired when private slot reservation fails due to TTL expiry", async () => {
    let findCalls = 0;
    const endpointRepository = {
      ...makeTemporaryEndpointRepository({
        id: "ep_private" as EndpointId,
        mode: "private",
        public_read: false,
        event_count: 0,
        event_limit: 1000,
        expires_at: "2026-07-05T12:00:00.001Z",
      }),
      async findEndpoint(id: EndpointId) {
        findCalls += 1;

        if (findCalls === 1) {
          return {
            id,
            name: null,
            mode: "private" as const,
            status: "active" as const,
            public_read: false,
            event_count: 0,
            event_limit: 1000,
            expires_at: "2026-07-05T12:00:00.001Z",
            created_at: "2026-06-28T12:00:00.001Z",
            updated_at: "2026-06-28T12:00:00.001Z",
          };
        }

        return {
          id,
          name: null,
          mode: "private" as const,
          status: "active" as const,
          public_read: false,
          event_count: 0,
          event_limit: 1000,
          expires_at: "2026-07-05T12:00:00.000Z",
          created_at: "2026-06-28T12:00:00.000Z",
          updated_at: "2026-06-28T12:00:00.000Z",
        };
      },
      async reservePrivateEventSlot() {
        return false;
      },
    } satisfies EndpointRepository;
    const bodyStore = new RecordingRequestBodyStore();
    const eventRepository = new RecordingEventRepository();

    const response = await createTestApiApp({
      endpointRepository,
      eventRepository,
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: () => "evt_private_ttl_race",
    }).request("https://ingest.example.com/ep_private", {
      method: "POST",
      body: "ttl race",
    });

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: {
        code: "endpoint_expired",
        message: "Endpoint expired: ep_private",
      },
    });
    expect(bodyStore.puts).toEqual([]);
    expect(eventRepository.events).toEqual([]);
  });

  it("does not report private event limit when cleanup deletes the endpoint before reservation", async () => {
    let findCalls = 0;
    const endpointRepository = {
      ...makeTemporaryEndpointRepository({
        id: "ep_private" as EndpointId,
        mode: "private",
        public_read: false,
        event_count: 999,
        event_limit: 1000,
        expires_at: "2026-07-12T12:00:00.000Z",
      }),
      async findEndpoint(id: EndpointId) {
        findCalls += 1;

        if (findCalls === 1) {
          return {
            id,
            name: null,
            mode: "private" as const,
            status: "active" as const,
            public_read: false,
            event_count: 999,
            event_limit: 1000,
            expires_at: "2026-07-12T12:00:00.000Z",
            created_at: "2026-07-05T12:00:00.000Z",
            updated_at: "2026-07-05T12:00:00.000Z",
          };
        }

        return null;
      },
      async reservePrivateEventSlot() {
        return false;
      },
    } satisfies EndpointRepository;
    const bodyStore = new RecordingRequestBodyStore();
    const eventRepository = new RecordingEventRepository();

    const response = await createTestApiApp({
      endpointRepository,
      eventRepository,
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: () => "evt_private_deleted_race",
    }).request("https://ingest.example.com/ep_private", {
      method: "POST",
      body: "deleted race",
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "endpoint_not_found",
        message: "Endpoint not found: ep_private",
      },
    });
    expect(bodyStore.puts).toEqual([]);
    expect(eventRepository.events).toEqual([]);
  });

  it("fails ingest instead of writing D1 metadata when persistent DB is configured without R2", async () => {
    const eventRepository = new RecordingEventRepository();
    const allowRateLimiter = {
      async limit() {
        return { success: true };
      },
    };
    const app = createApiApp(
      {
        endpointRepository: makeTemporaryEndpointRepository(),
        eventRepository,
        streamCoordinator: new InMemoryEventStreamCoordinator(),
        now: () => fixedNow,
        generateEventId: () => "evt_missing_r2",
        rateLimiters: {
          ABUSE_IP_RATE_LIMITER: allowRateLimiter,
          INGEST_ENDPOINT_RATE_LIMITER: allowRateLimiter,
        },
      },
      { validateRuntimeBindings: false },
    );

    const response = await app.request(
      "https://ingest.example.com/ep_01JDEF",
      {
        method: "POST",
        body: "no r2 binding",
      },
      {
        DB: {} as D1Database,
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "r2_write_failed",
        message: "Failed to store request body.",
      },
    });
    expect(eventRepository.events).toEqual([]);
  });

  it("cleans up R2 objects when D1 event metadata insertion fails", async () => {
    const bodyStore = new RecordingRequestBodyStore();
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository: {
        async countEventsForEndpoint() {
          return 0;
        },
        async createEvent() {
          throw new Error("D1 insert failed");
        },
        async listEventsForEndpoint() {
          return [];
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
      },
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: () => "evt_cleanup",
    });

    const response = await app.request("https://ingest.example.com/ep_01JDEF", {
      method: "POST",
      body: "cleanup",
    });

    const bodyR2Key = "events/ep_01JDEF/2026/07/05/evt_cleanup/body.raw";
    const requestR2Key = "events/ep_01JDEF/2026/07/05/evt_cleanup/request.json";

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "d1_write_failed",
        message: "Failed to store event metadata.",
      },
    });
    expect(bodyStore.puts).toEqual([bodyR2Key, requestR2Key]);
    expect(bodyStore.deletes).toHaveLength(2);
    expect(bodyStore.deletes).toEqual(
      expect.arrayContaining([bodyR2Key, requestR2Key]),
    );
  });

  it("maps R2 write failures to r2_write_failed before inserting D1 metadata", async () => {
    const eventRepository = new RecordingEventRepository();
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository,
      requestBodyStore: {
        async put() {
          throw new Error("R2 write failed");
        },
        async get() {
          return null;
        },
        async delete() {},
        async deleteMany() {},
      },
      now: () => fixedNow,
      generateEventId: () => "evt_r2_failed",
    });

    const response = await app.request("https://ingest.example.com/ep_01JDEF", {
      method: "POST",
      body: "r2 failure",
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "r2_write_failed",
        message: "Failed to store request body.",
      },
    });
    expect(eventRepository.events).toEqual([]);
  });

  it("cleans up body.raw when request.json R2 storage fails", async () => {
    const eventRepository = new RecordingEventRepository();
    const bodyStore = new (class extends RecordingRequestBodyStore {
      async put(key: string, value: Uint8Array | string): Promise<void> {
        await super.put(key, value);

        if (key.endsWith("/request.json")) {
          throw new Error("request envelope write failed");
        }
      }
    })();
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository,
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: () => "evt_partial_r2",
    });

    const response = await app.request("https://ingest.example.com/ep_01JDEF", {
      method: "POST",
      body: "partial r2 failure",
    });

    const bodyR2Key = "events/ep_01JDEF/2026/07/05/evt_partial_r2/body.raw";

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "r2_write_failed",
        message: "Failed to store request body.",
      },
    });
    expect(bodyStore.deletes).toEqual([bodyR2Key]);
    expect(eventRepository.events).toEqual([]);
  });

  it("rolls back private endpoint event counts when ingest storage fails", async () => {
    const makePrivateRepository = () =>
      makeTemporaryEndpointRepository({
        mode: "private",
        public_read: false,
        event_limit: null,
        expires_at: "2026-07-12T12:00:00.000Z",
      });
    const failingEventRepository = {
      async countEventsForEndpoint() {
        return 0;
      },
      async createEvent() {
        throw new Error("D1 insert failed");
      },
      async listEventsForEndpoint() {
        return [];
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
    } satisfies EventRepository;

    const oversizedRepository = makePrivateRepository();
    const oversizedResponse = await createTestApiApp({
      endpointRepository: oversizedRepository,
      eventRepository: new RecordingEventRepository(),
      requestBodyStore: new RecordingRequestBodyStore(),
      now: () => fixedNow,
    }).request("https://ingest.example.com/ep_private", {
      method: "POST",
      headers: {
        "content-length": String(10 * 1024 * 1024 + 1),
      },
      body: "not read",
    });

    const r2FailureRepository = makePrivateRepository();
    const r2FailureResponse = await createTestApiApp({
      endpointRepository: r2FailureRepository,
      eventRepository: new RecordingEventRepository(),
      requestBodyStore: new FailingRequestBodyStore(),
      now: () => fixedNow,
    }).request("https://ingest.example.com/ep_private", {
      method: "POST",
      body: "r2 failure",
    });

    const d1FailureRepository = makePrivateRepository();
    const d1FailureResponse = await createTestApiApp({
      endpointRepository: d1FailureRepository,
      eventRepository: failingEventRepository,
      requestBodyStore: new RecordingRequestBodyStore(),
      now: () => fixedNow,
      generateEventId: () => "evt_private_failed",
    }).request("https://ingest.example.com/ep_private", {
      method: "POST",
      body: "d1 failure",
    });

    expect(oversizedResponse.status).toBe(413);
    expect(r2FailureResponse.status).toBe(500);
    expect(d1FailureResponse.status).toBe(500);
    await expect(
      oversizedRepository.findEndpoint("ep_private" as EndpointId),
    ).resolves.toEqual(expect.objectContaining({ event_count: 0 }));
    await expect(
      r2FailureRepository.findEndpoint("ep_private" as EndpointId),
    ).resolves.toEqual(expect.objectContaining({ event_count: 0 }));
    await expect(
      d1FailureRepository.findEndpoint("ep_private" as EndpointId),
    ).resolves.toEqual(expect.objectContaining({ event_count: 0 }));
  });

  it("releases reserved temporary capacity when body reading fails unexpectedly", async () => {
    let reserveCalls = 0;
    let releaseCalls = 0;
    const endpointRepository = {
      ...makeTemporaryEndpointRepository(),
      async reserveTemporaryEventSlot() {
        reserveCalls += 1;

        return true;
      },
      async releaseTemporaryEventSlot() {
        releaseCalls += 1;
      },
    } satisfies EndpointRepository;
    const app = createTestApiApp({
      endpointRepository,
      eventRepository: new RecordingEventRepository(),
      requestBodyStore: new RecordingRequestBodyStore(),
      now: () => fixedNow,
      generateEventId: () => "evt_body_read_failed",
    });
    const failingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("read failed"));
      },
    });
    const request = new Request("https://ingest.example.com/ep_01JDEF", {
      method: "POST",
      body: failingBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await app.request(request);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to read request body.",
      },
    });
    expect(reserveCalls).toBe(1);
    expect(releaseCalls).toBe(1);
  });

  it("verifies private endpoint ingest secrets only when active secrets exist", async () => {
    const endpointRepository = new InMemoryEndpointRepository();
    const eventRepository = new RecordingEventRepository();
    const bodyStore = new RecordingRequestBodyStore();
    let nextEventId = "evt_without_secret";
    const authDomainRepository = new InMemoryAuthDomainRepository();
    const token = await seedTestPersonalAccessToken(
      authDomainRepository,
      testTokenId("secretowner"),
      "secretowner",
    );
    const app = createTestApiApp({
      authDomainRepository,
      endpointRepository,
      eventRepository,
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEndpointId: () => "ep_private",
      generateEventId: () => nextEventId as EventId,
      generateSecretId: () => "sec_ingest",
      generateEndpointSecret: () => "endpoint-secret",
    });
    const authHeaders = { authorization: `Bearer ${token}` };

    await app.request("https://api.example.com/v1/endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({ mode: "private" }),
    });

    const acceptedWithoutSecret = await app.request(
      "https://ingest.example.com/ep_private/no-secret",
      {
        method: "POST",
        body: "accepted before secret setup",
      },
    );
    expect(acceptedWithoutSecret.status).toBe(204);
    expect(eventRepository.events[0]).toEqual(
      expect.objectContaining({
        id: "evt_without_secret",
        secret_verification_status: "not_configured",
        matched_secret_id: null,
      }),
    );

    const createSecretResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_private/secrets",
      { method: "POST", headers: authHeaders },
    );
    const createdSecret =
      (await createSecretResponse.json()) as EndpointSecretCreateResponse;
    expect(createdSecret.secret).toBe("endpoint-secret");

    const missingSecretResponse = await app.request(
      "https://ingest.example.com/ep_private/missing-secret",
      {
        method: "POST",
        body: "missing",
      },
    );
    expect(missingSecretResponse.status).toBe(401);
    expect(await missingSecretResponse.json()).toEqual({
      error: {
        code: "missing_ingest_secret",
        message: "Webhook rejected: missing x-barestash-secret.",
      },
    });

    const invalidSecretResponse = await app.request(
      "https://ingest.example.com/ep_private/invalid-secret",
      {
        method: "POST",
        headers: {
          "x-barestash-secret": "wrong-secret",
        },
        body: "invalid",
      },
    );
    expect(invalidSecretResponse.status).toBe(401);
    expect(await invalidSecretResponse.json()).toEqual({
      error: {
        code: "invalid_ingest_secret",
        message: "Webhook rejected: invalid x-barestash-secret.",
      },
    });

    nextEventId = "evt_matched_secret";
    const validSecretResponse = await app.request(
      "https://ingest.example.com/ep_private/valid-secret",
      {
        method: "POST",
        headers: {
          "x-barestash-secret": "endpoint-secret",
        },
        body: "valid",
      },
    );
    const requestR2Key =
      "events/ep_private/2026/07/05/evt_matched_secret/request.json";
    const envelope = JSON.parse(bodyStore.text(requestR2Key)) as {
      headers: Record<string, string>;
    };

    expect(validSecretResponse.status).toBe(204);
    expect(eventRepository.events).toHaveLength(2);
    expect(eventRepository.events[1]).toEqual(
      expect.objectContaining({
        id: "evt_matched_secret",
        secret_verification_status: "matched",
        matched_secret_id: "sec_ingest",
      }),
    );
    expect(envelope.headers).not.toHaveProperty("x-barestash-secret");

    const listSecretsResponse = await app.request(
      "https://api.example.com/v1/endpoints/ep_private/secrets",
      { headers: authHeaders },
    );
    expect(await listSecretsResponse.json()).toEqual({
      endpoint_secrets: [
        expect.objectContaining({
          id: "sec_ingest",
          last_used_at: "2026-07-05T12:00:00.000Z",
        }),
      ],
    });
  });

  it("rejects a matched private ingest secret that is revoked before D1 event insertion", async () => {
    const endpointRepository = makeTemporaryEndpointRepository({
      id: "ep_private" as EndpointId,
      mode: "private",
      public_read: false,
      event_limit: null,
      expires_at: "2026-07-12T12:00:00.000Z",
    });
    const bodyStore = new RecordingRequestBodyStore();
    const app = createTestApiApp({
      endpointRepository,
      endpointSecretRepository: {
        async createEndpointSecret() {
          throw new Error("not used");
        },
        async listEndpointSecrets() {
          return [];
        },
        async listActiveEndpointSecrets() {
          return [
            {
              id: "sec_revoked_before_insert",
              endpoint_id: "ep_private" as EndpointId,
              secret_hash: await hashCredentialForTest("endpoint-secret"),
              status: "active",
              created_at: "2026-07-05T12:00:00.000Z",
              last_used_at: null,
              revoked_at: null,
            },
          ];
        },
        async updateEndpointSecretLastUsed() {},
        async revokeEndpointSecret() {
          return null;
        },
        async deleteEndpointSecrets() {},
      } satisfies EndpointSecretRepository,
      eventRepository: {
        async countEventsForEndpoint() {
          return 0;
        },
        async createEvent() {
          return { status: "matched_secret_inactive" as const };
        },
        async listEventsForEndpoint() {
          return [];
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
      },
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: () => "evt_stale_secret",
    });

    const response = await app.request(
      "https://ingest.example.com/ep_private/webhook",
      {
        method: "POST",
        headers: {
          "x-barestash-secret": "endpoint-secret",
        },
        body: "stale secret",
      },
    );
    const bodyR2Key = "events/ep_private/2026/07/05/evt_stale_secret/body.raw";
    const requestR2Key =
      "events/ep_private/2026/07/05/evt_stale_secret/request.json";

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_ingest_secret",
        message: "Webhook rejected: invalid x-barestash-secret.",
      },
    });
    expect(bodyStore.deletes).toHaveLength(2);
    expect(bodyStore.deletes).toEqual(
      expect.arrayContaining([bodyR2Key, requestR2Key]),
    );
    await expect(
      endpointRepository.findEndpoint("ep_private" as EndpointId),
    ).resolves.toEqual(expect.objectContaining({ event_count: 0 }));
  });

  it("rejects no-secret private ingest when a secret becomes active before D1 event insertion", async () => {
    const endpointRepository = makeTemporaryEndpointRepository({
      id: "ep_private" as EndpointId,
      mode: "private",
      public_read: false,
      event_limit: null,
      expires_at: "2026-07-12T12:00:00.000Z",
    });
    const bodyStore = new RecordingRequestBodyStore();
    const app = createTestApiApp({
      endpointRepository,
      endpointSecretRepository: {
        async createEndpointSecret() {
          throw new Error("not used");
        },
        async listEndpointSecrets() {
          return [];
        },
        async listActiveEndpointSecrets() {
          return [];
        },
        async updateEndpointSecretLastUsed() {},
        async revokeEndpointSecret() {
          return null;
        },
        async deleteEndpointSecrets() {},
      } satisfies EndpointSecretRepository,
      eventRepository: {
        async countEventsForEndpoint() {
          return 0;
        },
        async createEvent() {
          return { status: "active_secret_required" as const };
        },
        async listEventsForEndpoint() {
          return [];
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
      },
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: () => "evt_secret_required",
    });

    const response = await app.request(
      "https://ingest.example.com/ep_private/webhook",
      {
        method: "POST",
        body: "secret created concurrently",
      },
    );
    const bodyR2Key =
      "events/ep_private/2026/07/05/evt_secret_required/body.raw";
    const requestR2Key =
      "events/ep_private/2026/07/05/evt_secret_required/request.json";

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "missing_ingest_secret",
        message: "Webhook rejected: missing x-barestash-secret.",
      },
    });
    expect(bodyStore.deletes).toHaveLength(2);
    expect(bodyStore.deletes).toEqual(
      expect.arrayContaining([bodyR2Key, requestR2Key]),
    );
    await expect(
      endpointRepository.findEndpoint("ep_private" as EndpointId),
    ).resolves.toEqual(expect.objectContaining({ event_count: 0 }));
  });

  it("returns a structured error when matched secret last-used update fails", async () => {
    const endpointRepository = makeTemporaryEndpointRepository({
      id: "ep_private" as EndpointId,
      mode: "private",
      public_read: false,
      event_limit: null,
      expires_at: "2026-07-12T12:00:00.000Z",
    });
    const eventRepository = new RecordingEventRepository();
    const bodyStore = new RecordingRequestBodyStore();
    const app = createTestApiApp({
      endpointRepository,
      endpointSecretRepository: {
        async createEndpointSecret() {
          throw new Error("not used");
        },
        async listEndpointSecrets() {
          return [];
        },
        async listActiveEndpointSecrets() {
          return [
            {
              id: "sec_last_used_failed",
              endpoint_id: "ep_private" as EndpointId,
              secret_hash: await hashCredentialForTest("endpoint-secret"),
              status: "active",
              created_at: "2026-07-05T12:00:00.000Z",
              last_used_at: null,
              revoked_at: null,
            },
          ];
        },
        async updateEndpointSecretLastUsed() {
          throw new Error("D1 last-used update failed");
        },
        async revokeEndpointSecret() {
          return null;
        },
        async deleteEndpointSecrets() {},
      } satisfies EndpointSecretRepository,
      eventRepository,
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: () => "evt_last_used_failed",
    });

    const response = await app.request(
      "https://ingest.example.com/ep_private/webhook",
      {
        method: "POST",
        headers: {
          "x-barestash-secret": "endpoint-secret",
        },
        body: "last used failure",
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "d1_write_failed",
        message: "Failed to update endpoint secret last-used metadata.",
      },
    });
    expect(bodyStore.puts).toEqual([]);
    expect(eventRepository.events).toEqual([]);
    await expect(
      endpointRepository.findEndpoint("ep_private" as EndpointId),
    ).resolves.toEqual(expect.objectContaining({ event_count: 0 }));
  });

  it("relies on guarded insertion when a private endpoint is disabled before D1 event insertion", async () => {
    const endpoint = {
      id: "ep_private" as EndpointId,
      name: null,
      mode: "private" as const,
      status: "active" as const,
      public_read: false,
      event_count: 0,
      event_limit: null,
      expires_at: "2026-07-12T12:00:00.000Z",
      created_at: "2026-07-05T12:00:00.000Z",
      updated_at: "2026-07-05T12:00:00.000Z",
    };
    let findCalls = 0;
    const endpointRepository = {
      ...unusedEndpointEventSlots,
      async createTemporaryEndpoint() {
        throw new Error("not used");
      },
      async listActiveTemporaryEndpoints() {
        return [];
      },
      async findEndpoint(id: EndpointId) {
        findCalls += 1;

        if (findCalls > 1) {
          throw new Error("endpoint metadata must not be read again");
        }

        return { ...endpoint, id };
      },
      async incrementPrivateEndpointEventCount() {
        endpoint.event_count += 1;
        return true;
      },
      async reservePrivateEventSlot() {
        endpoint.event_count += 1;
        return true;
      },
      async releasePrivateEndpointEventCount() {
        endpoint.event_count = Math.max(endpoint.event_count - 1, 0);
      },
    } satisfies EndpointRepository;
    const eventRepository = new RecordingEventRepository();
    eventRepository.createEvent = async () => ({
      status: "endpoint_inactive",
    });
    const bodyStore = new RecordingRequestBodyStore();
    const app = createTestApiApp({
      endpointRepository,
      eventRepository,
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: () => "evt_disabled_before_insert",
    });

    const response = await app.request(
      "https://ingest.example.com/ep_private/webhook",
      {
        method: "POST",
        body: "cleanup race",
      },
    );
    const bodyR2Key =
      "events/ep_private/2026/07/05/evt_disabled_before_insert/body.raw";
    const requestR2Key =
      "events/ep_private/2026/07/05/evt_disabled_before_insert/request.json";

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "endpoint_not_found",
        message: "Endpoint not found: ep_private",
      },
    });
    expect(bodyStore.puts).toEqual([bodyR2Key, requestR2Key]);
    expect(bodyStore.deletes).toHaveLength(2);
    expect(bodyStore.deletes).toEqual(
      expect.arrayContaining([bodyR2Key, requestR2Key]),
    );
    expect(eventRepository.events).toEqual([]);
    expect(endpoint.event_count).toBe(0);
    expect(findCalls).toBe(1);
  });

  it("cleans up R2 objects when conditional D1 event insertion is skipped", async () => {
    const endpointRepository = makeTemporaryEndpointRepository({
      id: "ep_private" as EndpointId,
      mode: "private",
      public_read: false,
      event_limit: null,
      expires_at: "2026-07-12T12:00:00.000Z",
    });
    const bodyStore = new RecordingRequestBodyStore();
    const app = createTestApiApp({
      endpointRepository,
      eventRepository: {
        async countEventsForEndpoint() {
          return 0;
        },
        async createEvent() {
          return { status: "endpoint_inactive" as const };
        },
        async listEventsForEndpoint() {
          return [];
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
      },
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: () => "evt_conditional_skip",
    });

    const response = await app.request(
      "https://ingest.example.com/ep_private/webhook",
      {
        method: "POST",
        body: "conditional cleanup",
      },
    );
    const bodyR2Key =
      "events/ep_private/2026/07/05/evt_conditional_skip/body.raw";
    const requestR2Key =
      "events/ep_private/2026/07/05/evt_conditional_skip/request.json";

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "endpoint_not_found",
        message: "Endpoint not found: ep_private",
      },
    });
    expect(bodyStore.puts).toEqual([bodyR2Key, requestR2Key]);
    expect(bodyStore.deletes).toHaveLength(2);
    expect(bodyStore.deletes).toEqual(
      expect.arrayContaining([bodyR2Key, requestR2Key]),
    );
    await expect(
      endpointRepository.findEndpoint("ep_private" as EndpointId),
    ).resolves.toEqual(expect.objectContaining({ event_count: 0 }));
  });
});
