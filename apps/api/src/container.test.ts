import { describe, expect, it } from "vitest";

import { createTestApiApp } from "./testing/api-app.js";
import {
  fixedNow,
  makeTemporaryEndpointRepository,
  RecordingRequestBodyStore,
} from "./testing/helpers.js";

describe("createTestApiApp override wiring", () => {
  it("uses overridden endpoint repositories for default event guard checks", async () => {
    const app = createTestApiApp({
      endpointRepository: makeTemporaryEndpointRepository(),
      requestBodyStore: new RecordingRequestBodyStore(),
      now: () => fixedNow,
      generateEventId: () => "evt_container_guard",
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
      "evt_container_guard",
    );
    expect(response.headers.get("x-barestash-endpoint-id")).toBe("ep_01JDEF");
  });
});
