import { BARESTASH_SECRET_HEADER } from "@barestash/shared/headers";
import type { EndpointId } from "@barestash/shared/ids";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  EndpointRepository,
  EndpointSecretRepository,
  EventRepository,
  EventStreamCoordinator,
} from "../domain/ports.js";
import {
  fixedNow,
  hashCredentialForTest,
  makeTemporaryEndpointRepository,
  RecordingEventRepository,
  RecordingRequestBodyStore,
} from "../testing/helpers.js";
import * as credentialHash from "./credential-hash.js";
import { ingestRequest } from "./ingest.js";

type IngestDeps = Parameters<typeof ingestRequest>[0];

afterEach(() => {
  vi.restoreAllMocks();
});

const unusedEndpointSecretRepository = {
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
} satisfies EndpointSecretRepository;

function makeDeps(overrides: Partial<IngestDeps> = {}): IngestDeps {
  return {
    endpointRepository: makeTemporaryEndpointRepository(),
    endpointSecretRepository: unusedEndpointSecretRepository,
    eventRepository: new RecordingEventRepository(),
    requestBodyStore: new RecordingRequestBodyStore(),
    streamCoordinator: {
      async subscribe() {
        throw new Error("not used");
      },
      async getSubscriberPresence() {
        return { hasSubscribers: true, maxSubscriberSequence: 1 };
      },
      async publish() {},
    },
    getNow: () => fixedNow,
    makeEventId: () => "evt_application",
    endpointId: "ep_01JDEF" as EndpointId,
    request: new Request("https://ingest.example.com/ep_01JDEF/hook", {
      method: "POST",
      body: "payload",
    }),
    ...overrides,
  };
}

describe("ingestRequest", () => {
  it("stops after endpoint validation fails", async () => {
    let reserveCalls = 0;
    const endpointRepository = {
      ...makeTemporaryEndpointRepository(),
      async findEndpoint() {
        return null;
      },
      async reserveTemporaryEventSlot() {
        reserveCalls += 1;
        return true;
      },
    } satisfies EndpointRepository;

    await expect(
      ingestRequest(makeDeps({ endpointRepository })),
    ).resolves.toEqual({
      kind: "error",
      code: "endpoint_not_found",
      message: "Endpoint not found: ep_01JDEF",
      status: 404,
    });
    expect(reserveCalls).toBe(0);
  });

  it("reads endpoint metadata only once on successful ingest", async () => {
    let endpointReadCalls = 0;
    const baseEndpointRepository = makeTemporaryEndpointRepository();
    const endpointRepository = {
      ...baseEndpointRepository,
      async findEndpoint(id: EndpointId) {
        endpointReadCalls += 1;
        return baseEndpointRepository.findEndpoint(id);
      },
    } satisfies EndpointRepository;

    await expect(
      ingestRequest(makeDeps({ endpointRepository })),
    ).resolves.toEqual({
      kind: "ok",
      value: { eventId: "evt_application", endpointId: "ep_01JDEF" },
    });
    expect(endpointReadCalls).toBe(1);
  });

  it("rejects an endpoint that expires while raw request objects are persisted", async () => {
    const expiredAt = new Date("2026-07-05T12:00:00.001Z");
    let currentNow = fixedNow;
    let releaseCalls = 0;
    let createEventCalls = 0;
    const baseEndpointRepository = makeTemporaryEndpointRepository({
      expires_at: expiredAt.toISOString(),
    });
    const endpointRepository = {
      ...baseEndpointRepository,
      async releaseTemporaryEventSlot(_id: EndpointId) {
        releaseCalls += 1;
        await baseEndpointRepository.releaseTemporaryEventSlot();
      },
    } satisfies EndpointRepository;
    const bodyStore = new RecordingRequestBodyStore();
    const originalPut = bodyStore.put.bind(bodyStore);
    bodyStore.put = async (key, value) => {
      await originalPut(key, value);
      currentNow = expiredAt;
    };
    const eventRepository = new RecordingEventRepository();
    const originalCreateEvent =
      eventRepository.createEvent.bind(eventRepository);
    eventRepository.createEvent = async (input) => {
      createEventCalls += 1;
      return originalCreateEvent(input);
    };

    await expect(
      ingestRequest(
        makeDeps({
          endpointRepository,
          eventRepository,
          requestBodyStore: bodyStore,
          getNow: () => currentNow,
        }),
      ),
    ).resolves.toEqual({
      kind: "error",
      code: "endpoint_expired",
      message: "Endpoint expired: ep_01JDEF",
      status: 410,
    });
    expect(createEventCalls).toBe(0);
    expect(bodyStore.objects.size).toBe(0);
    expect(bodyStore.deletes).toHaveLength(2);
    expect(releaseCalls).toBe(1);
  });

  it("rejects exhausted capacity before persisting the request", async () => {
    const bodyStore = new RecordingRequestBodyStore();
    const endpointRepository = {
      ...makeTemporaryEndpointRepository(),
      async reserveTemporaryEventSlot() {
        return false;
      },
    } satisfies EndpointRepository;

    await expect(
      ingestRequest(
        makeDeps({ endpointRepository, requestBodyStore: bodyStore }),
      ),
    ).resolves.toEqual({
      kind: "error",
      code: "event_limit_exceeded",
      message: "Endpoint has reached the 100-event limit.",
      status: 429,
    });
    expect(bodyStore.puts).toEqual([]);
  });

  it("requires configured private ingest secrets and releases capacity", async () => {
    let releaseCalls = 0;
    const endpointRepository = {
      ...makeTemporaryEndpointRepository({
        mode: "private",
        public_read: false,
        event_limit: null,
        expires_at: "2026-07-12T12:00:00.000Z",
      }),
      async releasePrivateEndpointEventCount() {
        releaseCalls += 1;
      },
    } satisfies EndpointRepository;
    const endpointSecretRepository = {
      ...unusedEndpointSecretRepository,
      async listActiveEndpointSecrets() {
        return [
          {
            id: "sec_application",
            endpoint_id: "ep_01JDEF" as EndpointId,
            secret_hash: "configured-hash",
            status: "active" as const,
            created_at: fixedNow.toISOString(),
            last_used_at: null,
            revoked_at: null,
          },
        ];
      },
    } satisfies EndpointSecretRepository;

    await expect(
      ingestRequest(makeDeps({ endpointRepository, endpointSecretRepository })),
    ).resolves.toEqual({
      kind: "error",
      code: "missing_ingest_secret",
      message: "Webhook rejected: missing x-barestash-secret.",
      status: 401,
    });
    expect(releaseCalls).toBe(1);
  });

  it("verifies but never persists Barestash credential headers", async () => {
    const rawSecret = "application-secret";
    const bodyStore = new RecordingRequestBodyStore();
    const endpointRepository = makeTemporaryEndpointRepository({
      mode: "private",
      public_read: false,
      event_limit: null,
      expires_at: "2026-07-12T12:00:00.000Z",
    });
    const endpointSecretRepository = {
      ...unusedEndpointSecretRepository,
      async listActiveEndpointSecrets() {
        return [
          {
            id: "sec_application",
            endpoint_id: "ep_01JDEF" as EndpointId,
            secret_hash: await hashCredentialForTest(rawSecret),
            status: "active" as const,
            created_at: fixedNow.toISOString(),
            last_used_at: null,
            revoked_at: null,
          },
        ];
      },
    } satisfies EndpointSecretRepository;
    const request = new Request(
      "https://ingest.example.com/ep_01JDEF/private-hook",
      {
        method: "POST",
        headers: {
          [BARESTASH_SECRET_HEADER]: rawSecret,
          "x-barestash-bootstrap-token":
            "bootstrap-secret-for-local-staging-tests-ok",
          authorization: "Bearer provider-token",
        },
        body: "private payload",
      },
    );

    await expect(
      ingestRequest(
        makeDeps({
          endpointRepository,
          endpointSecretRepository,
          requestBodyStore: bodyStore,
          request,
        }),
      ),
    ).resolves.toEqual({
      kind: "ok",
      value: { eventId: "evt_application", endpointId: "ep_01JDEF" },
    });
    const requestKey = bodyStore.puts.find((key) =>
      key.endsWith("request.json"),
    );
    expect(requestKey).toBeDefined();
    const envelope = JSON.parse(bodyStore.text(requestKey ?? "")) as {
      headers: Record<string, string>;
    };
    expect(envelope.headers).toEqual(
      expect.objectContaining({
        authorization: "Bearer provider-token",
      }),
    );
    expect(envelope.headers).not.toHaveProperty(BARESTASH_SECRET_HEADER);
    expect(envelope.headers).not.toHaveProperty("x-barestash-bootstrap-token");
  });

  it("performs constant work across active ingest secrets", async () => {
    const matchingHash = await hashCredentialForTest("matching-secret");
    const otherHash = await hashCredentialForTest("other-secret");
    const updatedSecretIds: string[] = [];
    const verifyCredential = vi.spyOn(credentialHash, "verifyCredential");
    const endpointRepository = makeTemporaryEndpointRepository({
      mode: "private",
      public_read: false,
      event_limit: null,
      expires_at: "2026-07-12T12:00:00.000Z",
    });
    const endpointSecretRepository = {
      ...unusedEndpointSecretRepository,
      async listActiveEndpointSecrets() {
        return [
          {
            id: "sec_matching",
            endpoint_id: "ep_01JDEF" as EndpointId,
            secret_hash: matchingHash,
            status: "active" as const,
            created_at: "2026-07-05T12:00:00.000Z",
            last_used_at: null,
            revoked_at: null,
          },
          {
            id: "sec_other",
            endpoint_id: "ep_01JDEF" as EndpointId,
            secret_hash: otherHash,
            status: "active" as const,
            created_at: "2026-07-04T12:00:00.000Z",
            last_used_at: null,
            revoked_at: null,
          },
        ];
      },
      async updateEndpointSecretLastUsed(id) {
        updatedSecretIds.push(id);
      },
    } satisfies EndpointSecretRepository;
    const ingestWithSecret = (secret: string) =>
      ingestRequest(
        makeDeps({
          endpointRepository,
          endpointSecretRepository,
          request: new Request("https://ingest.example.com/ep_01JDEF/webhook", {
            method: "POST",
            headers: {
              [BARESTASH_SECRET_HEADER]: secret,
            },
            body: "payload",
          }),
        }),
      );

    await expect(ingestWithSecret("matching-secret")).resolves.toEqual({
      kind: "ok",
      value: { eventId: "evt_application", endpointId: "ep_01JDEF" },
    });
    expect(verifyCredential).toHaveBeenCalledTimes(2);
    expect(verifyCredential).toHaveBeenNthCalledWith(
      1,
      "matching-secret",
      matchingHash,
      { pepper: "" },
    );
    expect(verifyCredential).toHaveBeenNthCalledWith(
      2,
      "matching-secret",
      otherHash,
      { pepper: "" },
    );
    expect(updatedSecretIds).toEqual(["sec_matching"]);

    await expect(ingestWithSecret("other-secret")).resolves.toEqual({
      kind: "ok",
      value: { eventId: "evt_application", endpointId: "ep_01JDEF" },
    });
    expect(verifyCredential).toHaveBeenCalledTimes(4);
    expect(updatedSecretIds).toEqual(["sec_matching", "sec_other"]);

    await expect(ingestWithSecret("invalid-secret")).resolves.toEqual({
      kind: "error",
      code: "invalid_ingest_secret",
      message: "Webhook rejected: invalid x-barestash-secret.",
      status: 401,
    });
    expect(verifyCredential).toHaveBeenCalledTimes(6);
    expect(updatedSecretIds).toEqual(["sec_matching", "sec_other"]);
  });

  it("compensates body storage when request envelope persistence fails", async () => {
    const bodyStore = new RecordingRequestBodyStore();
    const originalPut = bodyStore.put.bind(bodyStore);
    let putCalls = 0;
    bodyStore.put = async (key, value) => {
      putCalls += 1;

      if (putCalls === 2) {
        throw new Error("R2 unavailable");
      }

      await originalPut(key, value);
    };

    await expect(
      ingestRequest(makeDeps({ requestBodyStore: bodyStore })),
    ).resolves.toEqual({
      kind: "error",
      code: "r2_write_failed",
      message: "Failed to store request body.",
      status: 500,
    });
    expect(bodyStore.objects.size).toBe(0);
    expect(bodyStore.deletes).toHaveLength(1);
    expect(bodyStore.deletes[0]).toMatch(/body\.raw$/);
  });

  it("starts body and request envelope persistence concurrently", async () => {
    const bodyStore = new RecordingRequestBodyStore();
    const eventRepository = new RecordingEventRepository();
    const originalCreateEvent =
      eventRepository.createEvent.bind(eventRepository);
    const originalPut = bodyStore.put.bind(bodyStore);
    let releaseBodyWrite: (() => void) | undefined;
    let markBodyWriteStarted: (() => void) | undefined;
    let envelopeWriteStarted = false;
    let metadataWriteStarted = false;
    const bodyWriteStarted = new Promise<void>((resolve) => {
      markBodyWriteStarted = resolve;
    });
    const bodyWriteReleased = new Promise<void>((resolve) => {
      releaseBodyWrite = resolve;
    });
    bodyStore.put = async (key, value) => {
      if (key.endsWith("body.raw")) {
        markBodyWriteStarted?.();
        await bodyWriteReleased;
      } else {
        envelopeWriteStarted = true;
      }

      await originalPut(key, value);
    };
    eventRepository.createEvent = async (input) => {
      metadataWriteStarted = true;
      return originalCreateEvent(input);
    };

    const ingest = ingestRequest(
      makeDeps({ eventRepository, requestBodyStore: bodyStore }),
    );
    await bodyWriteStarted;
    const writesStartedConcurrently = envelopeWriteStarted;
    expect(metadataWriteStarted).toBe(false);
    releaseBodyWrite?.();

    await expect(ingest).resolves.toEqual({
      kind: "ok",
      value: { eventId: "evt_application", endpointId: "ep_01JDEF" },
    });
    expect(writesStartedConcurrently).toBe(true);
    expect(metadataWriteStarted).toBe(true);
  });

  it("compensates a delayed successful write after its sibling fails", async () => {
    const bodyStore = new RecordingRequestBodyStore();
    const originalPut = bodyStore.put.bind(bodyStore);
    let releaseBodyWrite: (() => void) | undefined;
    let markBodyWriteStarted: (() => void) | undefined;
    let markBodyWriteFinished: (() => void) | undefined;
    const bodyWriteStarted = new Promise<void>((resolve) => {
      markBodyWriteStarted = resolve;
    });
    const bodyWriteReleased = new Promise<void>((resolve) => {
      releaseBodyWrite = resolve;
    });
    const bodyWriteFinished = new Promise<void>((resolve) => {
      markBodyWriteFinished = resolve;
    });
    bodyStore.put = async (key, value) => {
      if (key.endsWith("request.json")) {
        throw new Error("request envelope write failed");
      }

      markBodyWriteStarted?.();
      await bodyWriteReleased;
      await originalPut(key, value);
      markBodyWriteFinished?.();
    };

    const ingest = ingestRequest(makeDeps({ requestBodyStore: bodyStore }));
    await bodyWriteStarted;
    expect(bodyStore.deletes).toEqual([]);
    releaseBodyWrite?.();
    await bodyWriteFinished;

    await expect(ingest).resolves.toEqual({
      kind: "error",
      code: "r2_write_failed",
      message: "Failed to store request body.",
      status: 500,
    });
    expect(bodyStore.objects.size).toBe(0);
    expect(bodyStore.deletes).toHaveLength(1);
    expect(bodyStore.deletes[0]).toMatch(/body\.raw$/);
  });

  it("persists raw objects and metadata before publishing the live event", async () => {
    const calls: string[] = [];
    const baseEndpointRepository = makeTemporaryEndpointRepository();
    const endpointRepository = {
      ...baseEndpointRepository,
      async findEndpoint(id: EndpointId) {
        calls.push("validate endpoint");
        return baseEndpointRepository.findEndpoint(id);
      },
      async reserveTemporaryEventSlot(id: EndpointId, limit: number) {
        calls.push("reserve capacity");
        return baseEndpointRepository.reserveTemporaryEventSlot(id, limit);
      },
    } satisfies EndpointRepository;
    const bodyStore = new RecordingRequestBodyStore();
    const baseEventRepository = new RecordingEventRepository();
    const eventRepository = {
      countEventsForEndpoint:
        baseEventRepository.countEventsForEndpoint.bind(baseEventRepository),
      listEventsForEndpoint:
        baseEventRepository.listEventsForEndpoint.bind(baseEventRepository),
      findEvent: baseEventRepository.findEvent.bind(baseEventRepository),
      listEventObjectKeysForEndpoint:
        baseEventRepository.listEventObjectKeysForEndpoint.bind(
          baseEventRepository,
        ),
      deleteEventsForEndpoint:
        baseEventRepository.deleteEventsForEndpoint.bind(baseEventRepository),
      async createEvent(_input: Parameters<EventRepository["createEvent"]>[0]) {
        calls.push("record metadata");
        return { status: "created" as const };
      },
    } satisfies EventRepository;
    const streamCoordinator = {
      async subscribe() {
        throw new Error("not used");
      },
      async getSubscriberPresence() {
        calls.push("probe subscribers");
        return { hasSubscribers: true, maxSubscriberSequence: 1 };
      },
      async publish() {
        calls.push("publish live");
      },
    } satisfies EventStreamCoordinator;
    const originalPut = bodyStore.put.bind(bodyStore);
    bodyStore.put = async (key, value) => {
      calls.push(
        key.endsWith("body.raw") ? "persist body" : "persist envelope",
      );
      await originalPut(key, value);
    };

    await expect(
      ingestRequest(
        makeDeps({
          endpointRepository,
          eventRepository,
          requestBodyStore: bodyStore,
          streamCoordinator,
        }),
      ),
    ).resolves.toEqual({
      kind: "ok",
      value: { eventId: "evt_application", endpointId: "ep_01JDEF" },
    });
    expect(calls).toEqual([
      "validate endpoint",
      "reserve capacity",
      "persist body",
      "persist envelope",
      "record metadata",
      "probe subscribers",
      "publish live",
    ]);
  });

  it("does not construct or publish a live payload without subscribers", async () => {
    const getSubscriberPresence = vi.fn(async () => ({
      hasSubscribers: false,
      maxSubscriberSequence: 0,
    }));
    const publish = vi.fn(async () => {});
    const base64Encode = vi.spyOn(globalThis, "btoa");
    const streamCoordinator = {
      async subscribe() {
        throw new Error("not used");
      },
      getSubscriberPresence,
      publish,
    } satisfies EventStreamCoordinator;

    await expect(
      ingestRequest(makeDeps({ streamCoordinator })),
    ).resolves.toEqual({
      kind: "ok",
      value: { eventId: "evt_application", endpointId: "ep_01JDEF" },
    });
    expect(getSubscriberPresence).toHaveBeenCalledWith("ep_01JDEF");
    expect(base64Encode).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    base64Encode.mockRestore();
  });

  it("optimistically publishes while keeping ingest successful when the subscriber probe fails", async () => {
    const publish = vi.fn(async () => {});
    const streamCoordinator = {
      async subscribe() {
        throw new Error("not used");
      },
      async getSubscriberPresence() {
        throw new Error("Durable Object unavailable");
      },
      publish,
    } satisfies EventStreamCoordinator;

    await expect(
      ingestRequest(makeDeps({ streamCoordinator })),
    ).resolves.toEqual({
      kind: "ok",
      value: { eventId: "evt_application", endpointId: "ep_01JDEF" },
    });
    expect(publish).toHaveBeenCalledWith(
      "ep_01JDEF",
      expect.objectContaining({ id: "evt_application" }),
    );
  });

  it("keeps a successful ingest when live publish fails", async () => {
    const streamCoordinator = {
      async subscribe() {
        throw new Error("not used");
      },
      async getSubscriberPresence() {
        return { hasSubscribers: true, maxSubscriberSequence: 1 };
      },
      async publish() {
        throw new Error("Durable Object unavailable");
      },
    } satisfies EventStreamCoordinator;

    await expect(
      ingestRequest(makeDeps({ streamCoordinator })),
    ).resolves.toEqual({
      kind: "ok",
      value: { eventId: "evt_application", endpointId: "ep_01JDEF" },
    });
  });

  it("compensates stored objects and reserved capacity when metadata recording fails", async () => {
    let releaseCalls = 0;
    const baseEndpointRepository = makeTemporaryEndpointRepository();
    const endpointRepository = {
      ...baseEndpointRepository,
      async releaseTemporaryEventSlot(_id: EndpointId) {
        releaseCalls += 1;
        await baseEndpointRepository.releaseTemporaryEventSlot();
      },
    } satisfies EndpointRepository;
    const bodyStore = new RecordingRequestBodyStore();
    const baseEventRepository = new RecordingEventRepository();
    const eventRepository = {
      countEventsForEndpoint:
        baseEventRepository.countEventsForEndpoint.bind(baseEventRepository),
      listEventsForEndpoint:
        baseEventRepository.listEventsForEndpoint.bind(baseEventRepository),
      findEvent: baseEventRepository.findEvent.bind(baseEventRepository),
      listEventObjectKeysForEndpoint:
        baseEventRepository.listEventObjectKeysForEndpoint.bind(
          baseEventRepository,
        ),
      deleteEventsForEndpoint:
        baseEventRepository.deleteEventsForEndpoint.bind(baseEventRepository),
      async createEvent() {
        throw new Error("D1 unavailable");
      },
    } satisfies EventRepository;

    await expect(
      ingestRequest(
        makeDeps({
          endpointRepository,
          eventRepository,
          requestBodyStore: bodyStore,
        }),
      ),
    ).resolves.toEqual({
      kind: "error",
      code: "d1_write_failed",
      message: "Failed to store event metadata.",
      status: 500,
    });
    expect(bodyStore.objects.size).toBe(0);
    expect(bodyStore.deletes).toHaveLength(2);
    expect(releaseCalls).toBe(1);
  });
});
