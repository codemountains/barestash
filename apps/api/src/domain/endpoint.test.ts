import { describe, expect, it } from "vitest";
import type { StoredEndpoint } from "./endpoint.js";
import {
  addIngestUrl,
  endpointEventLimit,
  isEndpointExpired,
} from "./endpoint.js";

describe("endpoint domain helpers", () => {
  const privateEndpoint = {
    id: "ep_private",
    account_id: "acct_mvp",
    name: null,
    mode: "private",
    status: "active",
    public_read: false,
    event_count: 0,
    event_limit: null,
    expires_at: "2026-07-12T12:00:00.000Z",
    created_at: "2026-07-05T12:00:00.000Z",
    updated_at: "2026-07-05T12:00:00.000Z",
  } satisfies StoredEndpoint;

  it("derives private endpoint event limit from mode", () => {
    expect(endpointEventLimit(privateEndpoint)).toBe(1000);
    expect(
      isEndpointExpired(privateEndpoint, new Date("2026-07-12T12:00:00.000Z")),
    ).toBe(true);
    expect(
      isEndpointExpired(privateEndpoint, new Date("2026-07-12T11:59:59.999Z")),
    ).toBe(false);
  });

  it("uses stored expires_at as the endpoint expiry", () => {
    const endpoint = {
      ...privateEndpoint,
      expires_at: "2026-07-10T11:00:00.000Z",
    } satisfies StoredEndpoint;

    expect(
      isEndpointExpired(endpoint, new Date("2026-07-10T12:00:00.000Z")),
    ).toBe(true);
    expect(
      isEndpointExpired(endpoint, new Date("2026-07-10T10:00:00.000Z")),
    ).toBe(false);
  });

  it("normalizes private endpoint metadata in API responses", () => {
    expect(
      addIngestUrl(
        privateEndpoint,
        "https://api.example.com/v1/endpoints/ep_private",
      ),
    ).toEqual(
      expect.objectContaining({
        event_limit: 1000,
        expires_at: "2026-07-12T12:00:00.000Z",
        ingest_url: "https://ingest.example.com/ep_private",
      }),
    );
  });
});
