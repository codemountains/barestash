import { formatBearerTokenString } from "@barestash/shared/bearer-tokens";
import type { EventId } from "@barestash/shared/ids";
import { describe, expect, it, vi } from "vitest";
import { hashCredential } from "../../application/credential-hash.js";
import type {
  StoredAccount,
  StoredPersonalAccessToken,
} from "../../domain/auth-domain.js";
import { InMemoryAuthDomainRepository } from "../../infrastructure/in-memory/auth-domain-repository.js";
import { createTestApiApp } from "../../testing/api-app.js";
import {
  BlockingCatchUpBodyStore,
  fixedNow,
  makeTemporaryEndpointRepository,
  parseFirstSsePayload,
  RecordingEventRepository,
  RecordingRequestBodyStore,
  readStreamTextUntil,
  sha256Hex,
  testTokenId,
} from "../../testing/helpers.js";

describe("event stream API routes", () => {
  it("streams catch-up events after Last-Event-ID as SSE payloads with base64 body data", async () => {
    const bodyStore = new RecordingRequestBodyStore();
    const eventRepository = new RecordingEventRepository();
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository,
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: (() => {
        const ids: EventId[] = ["evt_stream_01", "evt_stream_02"];

        return () => ids.shift() ?? "evt_stream_extra";
      })(),
    });

    await app.request("https://ingest.example.com/ep_01JDEF/old", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
      },
      body: "old body",
    });
    await app.request(
      "https://ingest.example.com/ep_01JDEF/webhook/stripe?debug=true",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "t=raw,v1=raw",
        },
        body: JSON.stringify({ ok: true }),
      },
    );

    const response = await app.request(
      "https://api.example.com/v1/endpoints/ep_01JDEF/events/stream",
      {
        headers: {
          "last-event-id": "evt_stream_01",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");

    const streamText = await readStreamTextUntil(response, "evt_stream_02");

    expect(streamText).toContain("id: evt_stream_02");
    expect(streamText).toContain("event: event");

    const payload = parseFirstSsePayload(streamText);

    expect(payload).toEqual({
      id: "evt_stream_02",
      endpoint_id: "ep_01JDEF",
      received_at: "2026-07-05T12:00:00.000Z",
      request: {
        method: "POST",
        path: "/webhook/stripe",
        query: {
          debug: "true",
        },
        headers: {
          "content-type": "application/json",
          "stripe-signature": "[REDACTED]",
        },
        body_size: JSON.stringify({ ok: true }).length,
        body_sha256: await sha256Hex(
          new TextEncoder().encode(JSON.stringify({ ok: true })),
        ),
      },
      body: {
        encoding: "base64",
        data: "eyJvayI6dHJ1ZX0=",
      },
    });
  });
  it("fans out newly captured events to multiple SSE subscribers", async () => {
    const bodyStore = new RecordingRequestBodyStore();
    const eventRepository = new RecordingEventRepository();
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository,
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: () => "evt_live_fanout",
    });

    const firstSubscriber = await app.request(
      "https://api.example.com/v1/endpoints/ep_01JDEF/events/stream",
    );
    const secondSubscriber = await app.request(
      "https://api.example.com/v1/endpoints/ep_01JDEF/events/stream",
    );

    expect(firstSubscriber.status).toBe(200);
    expect(secondSubscriber.status).toBe(200);

    const firstMessage = readStreamTextUntil(
      firstSubscriber,
      "evt_live_fanout",
    );
    const secondMessage = readStreamTextUntil(
      secondSubscriber,
      "evt_live_fanout",
    );

    const ingestResponse = await app.request(
      "https://ingest.example.com/ep_01JDEF/live",
      {
        method: "POST",
        headers: {
          "content-type": "text/plain",
        },
        body: "hello subscribers",
      },
    );

    expect(ingestResponse.status).toBe(204);
    expect(await firstMessage).toContain("id: evt_live_fanout");
    expect(await secondMessage).toContain("id: evt_live_fanout");
  });
  it("does not miss live events captured while reconnect catch-up payloads are being built", async () => {
    const bodyStore = new BlockingCatchUpBodyStore();
    const eventRepository = new RecordingEventRepository();
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository,
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: (() => {
        const ids: EventId[] = [
          "evt_before_cursor",
          "evt_catchup",
          "evt_during_catchup",
        ];

        return () => ids.shift() ?? "evt_extra";
      })(),
    });

    await app.request("https://ingest.example.com/ep_01JDEF/before", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
      },
      body: "before",
    });
    await app.request("https://ingest.example.com/ep_01JDEF/catch-up", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
      },
      body: "catch-up",
    });

    bodyStore.blockCatchUpBodyReads = true;

    const streamResponsePromise = app.request(
      "https://api.example.com/v1/endpoints/ep_01JDEF/events/stream",
      {
        headers: {
          "last-event-id": "evt_before_cursor",
        },
      },
    );

    await bodyStore.catchUpBodyReadStarted;

    const liveIngestResponse = await app.request(
      "https://ingest.example.com/ep_01JDEF/during-catch-up",
      {
        method: "POST",
        headers: {
          "content-type": "text/plain",
        },
        body: "during catch-up",
      },
    );

    bodyStore.releaseCatchUpBodyRead();

    const streamResponse = await streamResponsePromise;
    const streamText = await readStreamTextUntil(
      streamResponse,
      "evt_during_catchup",
    );

    expect(liveIngestResponse.status).toBe(204);
    expect(streamResponse.status).toBe(200);
    expect(streamText).toContain("id: evt_during_catchup");
    expect(streamText).toContain("id: evt_catchup");
    expect(streamText.indexOf("id: evt_catchup")).toBeLessThan(
      streamText.indexOf("id: evt_during_catchup"),
    );
  });

  it("requires authentication before rejecting invalid Last-Event-ID on private endpoints", async () => {
    const response = await createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository({
        mode: "private",
        public_read: false,
        event_limit: null,
        expires_at: "2026-07-12T12:00:00.000Z",
      }),
      eventRepository: new RecordingEventRepository(),
      requestBodyStore: new RecordingRequestBodyStore(),
      now: () => fixedNow,
    }).request(
      "https://api.example.com/v1/endpoints/ep_private/events/stream",
      {
        headers: {
          "last-event-id": "bad",
        },
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "not_authenticated",
        message: "Authentication is required.",
      },
    });
  });

  it("rejects invalid Last-Event-ID after endpoint readability is established", async () => {
    const response = await createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository: new RecordingEventRepository(),
      requestBodyStore: new RecordingRequestBodyStore(),
      now: () => fixedNow,
    }).request("https://api.example.com/v1/endpoints/ep_01JDEF/events/stream", {
      headers: {
        "last-event-id": "bad",
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Invalid Last-Event-ID cursor.",
      },
    });
  });

  it("authorizes an owned private stream before subscribing and closes it after one hour", async () => {
    vi.useFakeTimers();

    try {
      const account: StoredAccount = {
        id: "acc_stream_owner",
        primary_email: null,
        display_name: null,
        avatar_url: null,
        status: "active",
        created_at: fixedNow.toISOString(),
        updated_at: fixedNow.toISOString(),
      };
      const tokenId = testTokenId("stream-duration");
      const secret = "s".repeat(32);
      const authDomainRepository = new InMemoryAuthDomainRepository();
      await authDomainRepository.createAccount(account);
      await authDomainRepository.createPersonalAccessToken({
        id: tokenId,
        account_id: account.id,
        name: "stream reader",
        token_hash: await hashCredential(secret, { pepper: "" }),
        status: "active",
        scopes: ["events:read"],
        created_at: fixedNow.toISOString(),
        expires_at: null,
        last_used_at: null,
        revoked_at: null,
      } satisfies StoredPersonalAccessToken);
      const app = createTestApiApp({
        authDomainRepository,
        endpointRepository: makeTemporaryEndpointRepository({
          mode: "private",
          account_id: account.id,
          public_read: false,
          event_limit: null,
          expires_at: "2026-07-12T12:00:00.000Z",
        }),
        eventRepository: new RecordingEventRepository(),
        requestBodyStore: new RecordingRequestBodyStore(),
        now: () => fixedNow,
      });

      const response = await app.request(
        "https://api.example.com/v1/endpoints/ep_private/events/stream",
        {
          headers: {
            authorization: `Bearer ${formatBearerTokenString({
              type: "pat",
              tokenIdSuffix: tokenId.slice("tok_".length),
              secret,
            })}`,
          },
        },
      );

      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      let streamClosed = false;
      void reader?.read().then(({ done }) => {
        streamClosed = done;
      });

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(streamClosed).toBe(true);
      await reader?.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
