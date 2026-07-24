import type { EventId } from "@barestash/shared/ids";
import { describe, expect, it } from "vitest";
import { createApiApp } from "../../app.js";
import { createTestApiApp } from "../../testing/api-app.js";
import {
  FailingRequestBodyStore,
  fixedNow,
  makeTemporaryEndpointRepository,
  RecordingEventRepository,
  RecordingRequestBodyStore,
  sha256Hex,
} from "../../testing/helpers.js";

describe("event API routes", () => {
  it("lists temporary endpoint events as metadata only with recent-first default ordering", async () => {
    const bodyStore = new RecordingRequestBodyStore();
    const eventRepository = new RecordingEventRepository();
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository,
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: (() => {
        const ids: EventId[] = ["evt_01JA", "evt_01JB"];

        return () => ids.shift() ?? "evt_extra";
      })(),
    });

    const jsonBody = JSON.stringify({ secret: "body remains in R2" });

    await app.request(
      "https://ingest.example.com/ep_01JDEF/webhook/github?delivery=1",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "GitHub-Hookshot/1.0",
          authorization: "Bearer raw-token",
        },
        body: jsonBody,
      },
    );
    await app.request("https://ingest.example.com/ep_01JDEF/webhook/stripe", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
      },
      body: "second body",
    });

    const response = await app.request(
      "https://api.example.com/v1/endpoints/ep_01JDEF/events",
    );

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toEqual({
      events: [
        {
          id: "evt_01JB",
          endpoint_id: "ep_01JDEF",
          received_at: "2026-07-05T12:00:00.000Z",
          method: "POST",
          request_path: "/webhook/stripe",
          query: {},
          headers: {
            "content-type": "text/plain",
          },
          body: {
            size: 11,
            sha256: await sha256Hex(new TextEncoder().encode("second body")),
            available: true,
          },
        },
        {
          id: "evt_01JA",
          endpoint_id: "ep_01JDEF",
          received_at: "2026-07-05T12:00:00.000Z",
          method: "POST",
          request_path: "/webhook/github",
          query: {
            delivery: "1",
          },
          headers: {
            "content-type": "application/json",
            "user-agent": "GitHub-Hookshot/1.0",
          },
          body: {
            size: jsonBody.length,
            sha256: await sha256Hex(new TextEncoder().encode(jsonBody)),
            available: true,
          },
        },
      ],
    });
    expect(JSON.stringify(responseBody).includes("body remains in R2")).toBe(
      false,
    );
  });

  it("supports after cursors for tail polling with ascending results", async () => {
    const eventRepository = new RecordingEventRepository();
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository,
      requestBodyStore: new RecordingRequestBodyStore(),
      now: () => fixedNow,
      generateEventId: (() => {
        const ids: EventId[] = ["evt_01JA", "evt_01JB", "evt_01JC"];

        return () => ids.shift() ?? "evt_extra";
      })(),
    });

    await app.request("https://ingest.example.com/ep_01JDEF/one", {
      method: "POST",
      body: "one",
    });
    await app.request("https://ingest.example.com/ep_01JDEF/two", {
      method: "POST",
      body: "two",
    });
    await app.request("https://ingest.example.com/ep_01JDEF/three", {
      method: "POST",
      body: "three",
    });

    const response = await app.request(
      "https://api.example.com/v1/endpoints/ep_01JDEF/events?after=evt_01JA&limit=1",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      events: [
        expect.objectContaining({
          id: "evt_01JB",
          request_path: "/two",
        }),
      ],
    });
  });

  it("uses capture order for after cursors when later event IDs sort lower", async () => {
    const eventRepository = new RecordingEventRepository();
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository,
      requestBodyStore: new RecordingRequestBodyStore(),
      now: () => fixedNow,
      generateEventId: (() => {
        const ids: EventId[] = ["evt_01JZ", "evt_01JA"];

        return () => ids.shift() ?? "evt_extra";
      })(),
    });

    await app.request("https://ingest.example.com/ep_01JDEF/first", {
      method: "POST",
      body: "first",
    });
    await app.request("https://ingest.example.com/ep_01JDEF/second", {
      method: "POST",
      body: "second",
    });

    const response = await app.request(
      "https://api.example.com/v1/endpoints/ep_01JDEF/events?after=evt_01JZ",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      events: [
        expect.objectContaining({
          id: "evt_01JA",
          request_path: "/second",
        }),
      ],
    });
  });

  it("shows event metadata with redacted headers and no body content", async () => {
    const bodyStore = new RecordingRequestBodyStore();
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository: new RecordingEventRepository(),
      requestBodyStore: bodyStore,
      now: () => fixedNow,
      generateEventId: () => "evt_01JXYZ",
    });

    const jsonBody = JSON.stringify({ id: "evt_provider" });

    await app.request(
      "https://ingest.example.com/ep_01JDEF/webhook/stripe?debug=true",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "t=raw,v1=raw",
        },
        body: jsonBody,
      },
    );

    const response = await app.request(
      "https://api.example.com/v1/events/evt_01JXYZ",
    );

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toEqual({
      id: "evt_01JXYZ",
      endpoint_id: "ep_01JDEF",
      received_at: "2026-07-05T12:00:00.000Z",
      request: {
        method: "POST",
        ingest_path: "/ep_01JDEF/webhook/stripe",
        request_path: "/webhook/stripe",
        query: {
          debug: "true",
        },
        headers: {
          "content-type": "application/json",
          "stripe-signature": "[REDACTED]",
        },
        body: {
          size: jsonBody.length,
          sha256: await sha256Hex(new TextEncoder().encode(jsonBody)),
          available: true,
          url: "/v1/events/evt_01JXYZ/body",
        },
      },
    });
    expect(JSON.stringify(responseBody).includes("evt_provider")).toBe(false);
  });

  it("returns raw body bytes with stored content type", async () => {
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository: new RecordingEventRepository(),
      requestBodyStore: new RecordingRequestBodyStore(),
      now: () => fixedNow,
      generateEventId: () => "evt_01JXYZ",
    });
    const bodyBytes = new Uint8Array([0, 1, 2, 255]);

    await app.request("https://ingest.example.com/ep_01JDEF/binary", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
      },
      body: bodyBytes,
    });

    const response = await app.request(
      "https://api.example.com/v1/events/evt_01JXYZ/body",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bodyBytes);
  });

  it("maps failed event envelope reads to internal_error", async () => {
    const eventRepository = new RecordingEventRepository();
    await eventRepository.createEvent({
      id: "evt_storage_down",
      endpoint_id: "ep_01JDEF",
      received_at: "2026-07-05T12:00:00.000Z",
      method: "POST",
      ingest_path: "/ep_01JDEF/webhook",
      request_path: "/webhook",
      query_json: "{}",
      allowlist_headers_json: "{}",
      sensitive_header_names_json: "[]",
      content_type: "application/json",
      content_length: 4,
      user_agent: null,
      body_size: 4,
      body_sha256: "hash",
      body_r2_key: "events/ep_01JDEF/2026/07/05/evt_storage_down/body.raw",
      request_r2_key:
        "events/ep_01JDEF/2026/07/05/evt_storage_down/request.json",
      secret_verification_status: "not_configured",
      matched_secret_id: null,
      created_at: "2026-07-05T12:00:00.000Z",
    });

    const response = await createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository,
      requestBodyStore: new FailingRequestBodyStore(),
      now: () => fixedNow,
    }).request("https://api.example.com/v1/events/evt_storage_down");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to read event request envelope.",
      },
    });
  });

  it("maps missing R2 bindings on event reads to internal_error", async () => {
    const eventRepository = new RecordingEventRepository();
    await eventRepository.createEvent({
      id: "evt_missing_r2_binding",
      endpoint_id: "ep_01JDEF",
      received_at: "2026-07-05T12:00:00.000Z",
      method: "POST",
      ingest_path: "/ep_01JDEF/webhook",
      request_path: "/webhook",
      query_json: "{}",
      allowlist_headers_json: "{}",
      sensitive_header_names_json: "[]",
      content_type: "application/json",
      content_length: 4,
      user_agent: null,
      body_size: 4,
      body_sha256: "hash",
      body_r2_key:
        "events/ep_01JDEF/2026/07/05/evt_missing_r2_binding/body.raw",
      request_r2_key:
        "events/ep_01JDEF/2026/07/05/evt_missing_r2_binding/request.json",
      secret_verification_status: "not_configured",
      matched_secret_id: null,
      created_at: "2026-07-05T12:00:00.000Z",
    });
    const app = createApiApp(
      {
        endpointRepository: makeTemporaryEndpointRepository(),
        eventRepository,
        now: () => fixedNow,
      },
      { validateRuntimeBindings: false },
    );
    const env = {
      DB: {} as D1Database,
    };

    const detailResponse = await app.request(
      "https://api.example.com/v1/events/evt_missing_r2_binding",
      undefined,
      env,
    );
    const bodyResponse = await app.request(
      "https://api.example.com/v1/events/evt_missing_r2_binding/body",
      undefined,
      env,
    );

    expect(detailResponse.status).toBe(500);
    expect(await detailResponse.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to read event request envelope.",
      },
    });
    expect(bodyResponse.status).toBe(500);
    expect(await bodyResponse.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to read event body.",
      },
    });
  });

  it("requires authentication before rejecting invalid after cursors on private endpoints", async () => {
    const privateResponse = await createTestApiApp({
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
      "https://api.example.com/v1/endpoints/ep_private/events?after=bad",
    );

    expect(privateResponse.status).toBe(401);
    expect(await privateResponse.json()).toEqual({
      error: {
        code: "not_authenticated",
        message: "Authentication is required.",
      },
    });
  });

  it("rejects invalid after cursors after endpoint readability is established", async () => {
    const response = await createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository: new RecordingEventRepository(),
      requestBodyStore: new RecordingRequestBodyStore(),
      now: () => fixedNow,
    }).request(
      "https://api.example.com/v1/endpoints/ep_01JDEF/events?after=bad",
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Invalid after cursor.",
      },
    });
  });

  it("returns structured errors for expired temporary and private endpoint event reads", async () => {
    const expiredResponse = await createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository({
        expires_at: "2026-07-05T11:59:59.999Z",
      }),
      eventRepository: new RecordingEventRepository(),
      requestBodyStore: new RecordingRequestBodyStore(),
      now: () => fixedNow,
    }).request("https://api.example.com/v1/endpoints/ep_01JDEF/events");

    const privateResponse = await createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository({
        mode: "private",
        public_read: false,
        event_limit: null,
        expires_at: "2026-07-12T12:00:00.000Z",
      }),
      eventRepository: new RecordingEventRepository(),
      requestBodyStore: new RecordingRequestBodyStore(),
      now: () => fixedNow,
    }).request("https://api.example.com/v1/endpoints/ep_private/events");

    expect(expiredResponse.status).toBe(410);
    expect(await expiredResponse.json()).toEqual({
      error: {
        code: "endpoint_expired",
        message: "Endpoint expired: ep_01JDEF",
      },
    });
    expect(privateResponse.status).toBe(401);
    expect(await privateResponse.json()).toEqual({
      error: {
        code: "not_authenticated",
        message: "Authentication is required.",
      },
    });
  });

  it("maps missing event bodies to body_not_found", async () => {
    const eventRepository = new RecordingEventRepository();
    await eventRepository.createEvent({
      id: "evt_missing_body",
      endpoint_id: "ep_01JDEF",
      received_at: "2026-07-05T12:00:00.000Z",
      method: "POST",
      ingest_path: "/ep_01JDEF/webhook",
      request_path: "/webhook",
      query_json: "{}",
      allowlist_headers_json: "{}",
      sensitive_header_names_json: "[]",
      content_type: null,
      content_length: null,
      user_agent: null,
      body_size: 4,
      body_sha256: "hash",
      body_r2_key: "events/ep_01JDEF/2026/07/05/evt_missing_body/body.raw",
      request_r2_key:
        "events/ep_01JDEF/2026/07/05/evt_missing_body/request.json",
      secret_verification_status: "not_configured",
      matched_secret_id: null,
      created_at: "2026-07-05T12:00:00.000Z",
    });

    const response = await createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository,
      requestBodyStore: new RecordingRequestBodyStore(),
      now: () => fixedNow,
    }).request("https://api.example.com/v1/events/evt_missing_body/body");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "body_not_found",
        message: "Event body not found: evt_missing_body",
      },
    });
  });

  it("maps failed event body reads to internal_error", async () => {
    const eventRepository = new RecordingEventRepository();
    await eventRepository.createEvent({
      id: "evt_body_storage_down",
      endpoint_id: "ep_01JDEF",
      received_at: "2026-07-05T12:00:00.000Z",
      method: "POST",
      ingest_path: "/ep_01JDEF/webhook",
      request_path: "/webhook",
      query_json: "{}",
      allowlist_headers_json: "{}",
      sensitive_header_names_json: "[]",
      content_type: "application/json",
      content_length: 4,
      user_agent: null,
      body_size: 4,
      body_sha256: "hash",
      body_r2_key: "events/ep_01JDEF/2026/07/05/evt_body_storage_down/body.raw",
      request_r2_key:
        "events/ep_01JDEF/2026/07/05/evt_body_storage_down/request.json",
      secret_verification_status: "not_configured",
      matched_secret_id: null,
      created_at: "2026-07-05T12:00:00.000Z",
    });

    const response = await createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      eventRepository,
      requestBodyStore: new FailingRequestBodyStore(),
      now: () => fixedNow,
    }).request("https://api.example.com/v1/events/evt_body_storage_down/body");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to read event body.",
      },
    });
  });
});
