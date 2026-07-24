import type { EventStreamPayload } from "@barestash/shared/events";
import { describe, expect, it } from "vitest";

import {
  isBodyMetadata,
  transformBody,
  transformStreamBody,
  transformStreamPayload,
} from "./body.js";

function encodeBase64(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function streamPayload(
  contentType: string,
  data: string,
  headers: EventStreamPayload["request"]["headers"] = {},
): EventStreamPayload {
  return {
    id: "evt_body" as EventStreamPayload["id"],
    endpoint_id: "ep_body" as EventStreamPayload["endpoint_id"],
    received_at: "2026-07-12T12:00:00.000Z",
    request: {
      method: "POST",
      path: "/webhook",
      query: {},
      headers: {
        "content-type": contentType,
        ...headers,
      },
      body_size: Buffer.from(data, "base64").byteLength,
      body_sha256: "test-sha256",
    },
    body: {
      encoding: "base64",
      data,
    },
  };
}

function expectBodyMetadata(
  value: unknown,
  contentType: string,
  size: number,
): void {
  expect(isBodyMetadata(value)).toBe(true);

  if (!isBodyMetadata(value)) {
    throw new Error("Expected synthetic body metadata.");
  }

  expect(value.content_type).toBe(contentType);
  expect(value.size).toBe(size);
}

describe("transformBody", () => {
  it.each([
    "application/json",
    "application/problem+json",
  ])("parses %s bodies as JSON", (contentType) => {
    expect(
      transformBody(
        Buffer.from(JSON.stringify({ accepted: true })),
        `${contentType}; charset=utf-8`,
      ),
    ).toEqual({ accepted: true });
  });

  it("falls back to text for malformed JSON", () => {
    expect(transformBody(Buffer.from('{"event":'), "application/json")).toBe(
      '{"event":',
    );
  });

  it.each([
    "text/plain",
    "application/x-www-form-urlencoded",
  ])("decodes %s bodies as text", (contentType) => {
    expect(transformBody(Buffer.from("hello=world"), contentType)).toBe(
      "hello=world",
    );
  });

  it.each([
    "application/json",
    "text/plain",
  ])("returns metadata for invalid UTF-8 in direct %s bodies", (contentType) => {
    expectBodyMetadata(
      transformBody(new Uint8Array([0xff, 0xfe]), contentType),
      contentType,
      2,
    );
  });

  it("returns metadata for empty bodies", () => {
    expectBodyMetadata(
      transformBody(new Uint8Array(), "text/plain"),
      "text/plain",
      0,
    );
  });

  it("returns metadata for multipart bodies", () => {
    const contentType = "multipart/form-data; boundary=barestash";

    expectBodyMetadata(
      transformBody(Buffer.from("--barestash--"), contentType),
      contentType,
      13,
    );
  });

  it("returns metadata for binary bodies", () => {
    expectBodyMetadata(
      transformBody(new Uint8Array([0, 1, 2, 255]), "application/octet-stream"),
      "application/octet-stream",
      4,
    );
  });
});

describe("stream body transformation", () => {
  it("decodes and parses base64 JSON bodies", () => {
    const payload = streamPayload(
      "application/json",
      encodeBase64(JSON.stringify({ streamed: true })),
    );

    expect(transformStreamBody(payload)).toEqual({ streamed: true });
  });

  it("falls back to the original base64 for invalid UTF-8 text", () => {
    const data = encodeBase64(new Uint8Array([0xff, 0xfe]));
    const payload = streamPayload("text/plain", data);

    expect(transformStreamBody(payload)).toBe(data);
  });

  it("returns metadata for empty, multipart, and binary stream bodies", () => {
    const cases = [
      streamPayload("text/plain", ""),
      streamPayload(
        "multipart/form-data; boundary=barestash",
        encodeBase64("--barestash--"),
      ),
      streamPayload(
        "application/octet-stream",
        encodeBase64(new Uint8Array([0, 1, 2, 255])),
      ),
    ];

    expectBodyMetadata(transformStreamBody(cases[0]), "text/plain", 0);
    expectBodyMetadata(
      transformStreamBody(cases[1]),
      "multipart/form-data; boundary=barestash",
      13,
    );
    expectBodyMetadata(
      transformStreamBody(cases[2]),
      "application/octet-stream",
      4,
    );
  });

  it("redacts sensitive headers while preserving safe headers", () => {
    const payload = streamPayload(
      "application/json",
      encodeBase64(JSON.stringify({ ok: true })),
      {
        authorization: "Bearer test-secret",
        "stripe-signature": "test-signature",
        "x-barestash-secret": "test-endpoint-secret",
        "x-request-id": "req_test",
      },
    );

    expect(transformStreamPayload(payload)).toEqual({
      ...payload,
      request: {
        ...payload.request,
        headers: {
          authorization: "[REDACTED]",
          "content-type": "application/json",
          "stripe-signature": "[REDACTED]",
          "x-request-id": "req_test",
        },
      },
      body: { ok: true },
    });
  });
});
