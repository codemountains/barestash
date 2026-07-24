import { describe, expect, it } from "vitest";
import { createTestApiApp } from "./api-app.js";
import {
  fixedNow,
  makeTemporaryEndpointRepository,
  RecordingRequestBodyStore,
} from "./helpers.js";

describe("createTestApiApp", () => {
  it("composes shared in-memory adapters for application tests", async () => {
    const app = createTestApiApp({
      generateEndpointId: () => "ep_test_factory",
      generateEventId: () => "evt_test_factory",
    });

    const createResponse = await app.request("http://localhost/v1/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "temporary" }),
    });
    const ingestResponse = await app.request(
      "http://localhost/ep_test_factory/webhook",
      {
        method: "POST",
        body: "factory event",
      },
    );
    const listResponse = await app.request(
      "http://localhost/v1/endpoints/ep_test_factory/events",
    );

    expect(createResponse.status).toBe(201);
    expect(ingestResponse.status).toBe(204);
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      events: [{ id: "evt_test_factory" }],
    });
  });

  it("preserves individual dependency overrides", async () => {
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      requestBodyStore: new RecordingRequestBodyStore(),
      now: () => fixedNow,
      generateEventId: () => "evt_test_override",
    });

    const response = await app.request(
      "https://ingest.example.com/ep_01JDEF/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "text/plain",
        },
        body: "hello",
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("x-barestash-event-id")).toBe(
      "evt_test_override",
    );
  });
});
