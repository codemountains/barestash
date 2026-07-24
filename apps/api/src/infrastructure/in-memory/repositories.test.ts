import type { EndpointId, SecretId } from "@barestash/shared/ids";
import { describe, expect, it } from "vitest";

import { MVP_ACCOUNT_ID } from "../../domain/endpoint.js";
import type { EventMetadataInsert } from "../../domain/event.js";
import { InMemoryEndpointRepository } from "./endpoint-repository.js";
import { InMemoryEndpointSecretRepository } from "./endpoint-secret-repository.js";
import { InMemoryEventRepository } from "./event-repository.js";

describe("InMemoryEndpointRepository", () => {
  it("does not reserve private event slots for expired endpoints", async () => {
    const repository = new InMemoryEndpointRepository();
    const createdAt = new Date("2026-06-28T12:00:00.000Z");

    await repository.createPrivateEndpoint({
      id: "ep_private" as EndpointId,
      accountId: MVP_ACCOUNT_ID,
      name: null,
      now: createdAt,
    });

    await expect(
      repository.reservePrivateEventSlot(
        "ep_private" as EndpointId,
        1000,
        new Date("2026-07-05T12:00:00.000Z"),
      ),
    ).resolves.toBe(false);
    await expect(
      repository.findEndpoint("ep_private" as EndpointId),
    ).resolves.toEqual(expect.objectContaining({ event_count: 0 }));
  });

  it("reserves private event slots before the TTL boundary", async () => {
    const repository = new InMemoryEndpointRepository();
    const createdAt = new Date("2026-06-28T12:00:00.000Z");

    await repository.createPrivateEndpoint({
      id: "ep_private" as EndpointId,
      accountId: MVP_ACCOUNT_ID,
      name: null,
      now: createdAt,
    });

    await expect(
      repository.reservePrivateEventSlot(
        "ep_private" as EndpointId,
        1000,
        new Date("2026-07-05T11:59:59.999Z"),
      ),
    ).resolves.toBe(true);
    await expect(
      repository.findEndpoint("ep_private" as EndpointId),
    ).resolves.toEqual(expect.objectContaining({ event_count: 1 }));
  });

  it("reserves private event slots with millisecond precision at the TTL boundary", async () => {
    const repository = new InMemoryEndpointRepository();
    const createdAt = new Date("2026-06-28T12:00:00.999Z");

    await repository.createPrivateEndpoint({
      id: "ep_private" as EndpointId,
      accountId: MVP_ACCOUNT_ID,
      name: null,
      now: createdAt,
    });

    await expect(
      repository.reservePrivateEventSlot(
        "ep_private" as EndpointId,
        1000,
        new Date("2026-07-05T12:00:00.000Z"),
      ),
    ).resolves.toBe(true);
    await expect(
      repository.findEndpoint("ep_private" as EndpointId),
    ).resolves.toEqual(expect.objectContaining({ event_count: 1 }));
  });
});

describe("InMemoryEventRepository", () => {
  const makeEvent = (
    overrides: Partial<EventMetadataInsert> = {},
  ): EventMetadataInsert => ({
    id: "evt_memory_guard",
    endpoint_id: "ep_private" as EndpointId,
    received_at: "2026-07-05T12:00:00.000Z",
    method: "POST",
    ingest_path: "/ep_private/webhook",
    request_path: "/webhook",
    query_json: "{}",
    allowlist_headers_json: "{}",
    sensitive_header_names_json: "[]",
    content_type: null,
    content_length: null,
    user_agent: null,
    body_size: 7,
    body_sha256: "sha256",
    body_r2_key: "events/ep_private/body.raw",
    request_r2_key: "events/ep_private/request.json",
    secret_verification_status: "matched",
    matched_secret_id: "sec_active" as SecretId,
    created_at: "2026-07-05T12:00:00.000Z",
    ...overrides,
  });

  it("rejects events when the matched ingest secret is inactive", async () => {
    const endpointRepository = new InMemoryEndpointRepository();
    const endpointSecretRepository = new InMemoryEndpointSecretRepository();
    const eventRepository = new InMemoryEventRepository({
      endpointRepository,
      endpointSecretRepository,
    });
    const now = new Date("2026-07-05T12:00:00.000Z");

    await endpointRepository.createPrivateEndpoint({
      id: "ep_private" as EndpointId,
      accountId: MVP_ACCOUNT_ID,
      name: null,
      now,
    });
    await endpointSecretRepository.createEndpointSecret({
      id: "sec_active" as SecretId,
      endpointId: "ep_private" as EndpointId,
      secretHash: "hash",
      now,
    });
    await endpointSecretRepository.revokeEndpointSecret(
      "ep_private" as EndpointId,
      "sec_active" as SecretId,
      "2026-07-05T12:01:00.000Z",
    );

    await expect(eventRepository.createEvent(makeEvent())).resolves.toEqual({
      status: "matched_secret_inactive",
    });
    await expect(
      eventRepository.countEventsForEndpoint("ep_private" as EndpointId),
    ).resolves.toBe(0);
  });

  it("requires a matched secret when active endpoint secrets exist", async () => {
    const endpointRepository = new InMemoryEndpointRepository();
    const endpointSecretRepository = new InMemoryEndpointSecretRepository();
    const eventRepository = new InMemoryEventRepository({
      endpointRepository,
      endpointSecretRepository,
    });
    const now = new Date("2026-07-05T12:00:00.000Z");

    await endpointRepository.createPrivateEndpoint({
      id: "ep_private" as EndpointId,
      accountId: MVP_ACCOUNT_ID,
      name: null,
      now,
    });
    await endpointSecretRepository.createEndpointSecret({
      id: "sec_active" as SecretId,
      endpointId: "ep_private" as EndpointId,
      secretHash: "hash",
      now,
    });

    await expect(
      eventRepository.createEvent(
        makeEvent({
          secret_verification_status: "not_configured",
          matched_secret_id: null,
        }),
      ),
    ).resolves.toEqual({
      status: "active_secret_required",
    });
  });
});
