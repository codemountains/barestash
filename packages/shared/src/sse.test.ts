import { describe, expect, it } from "vitest";
import type { EventStreamPayload } from "./events.js";
import {
  enqueueDedupedSseMessage,
  findSseMessageSeparator,
  parseSseMessage,
  sseMessage,
  sseMessageId,
} from "./sse.js";

const payload = (id = "evt_sse_1"): EventStreamPayload => ({
  id: id as EventStreamPayload["id"],
  endpoint_id: "ep_sse" as EventStreamPayload["endpoint_id"],
  received_at: "2026-07-05T12:04:32.000Z",
  request: {
    method: "POST",
    path: "/webhook",
    query: { attempt: "1" },
    headers: { "content-type": "application/json" },
    body_size: 11,
    body_sha256: "sha256",
  },
  body: {
    encoding: "base64",
    data: "eyJvayI6dHJ1ZX0=",
  },
});

describe("sseMessage", () => {
  it("formats event stream payloads as SSE event messages", () => {
    const message = sseMessage(payload());

    expect(message).toBe(
      `id: evt_sse_1\nevent: event\ndata: ${JSON.stringify(payload())}\n\n`,
    );
  });
});

describe("sseMessageId", () => {
  it("extracts valid ids and tolerates CRLF line endings", () => {
    expect(
      sseMessageId("event: event\r\nid: evt_crlf\r\ndata: {}\r\n\r\n"),
    ).toBe("evt_crlf");
  });

  it("returns null for missing or invalid event ids", () => {
    expect(sseMessageId("event: event\ndata: {}\n\n")).toBeNull();
    expect(sseMessageId("id: not-an-event-id\ndata: {}\n\n")).toBeNull();
  });
});

describe("parseSseMessage", () => {
  it("parses LF and CRLF framed SSE messages", () => {
    expect(parseSseMessage('id: evt_1\ndata: {"ok":true}\n\n')).toEqual({
      id: "evt_1",
      data: '{"ok":true}',
    });
    expect(
      parseSseMessage('id: evt_crlf\r\ndata: {"ok":true}\r\n\r\n'),
    ).toEqual({
      id: "evt_crlf",
      data: '{"ok":true}',
    });
  });
});

describe("findSseMessageSeparator", () => {
  it("finds LF and CRLF message boundaries", () => {
    expect(findSseMessageSeparator("id: 1\ndata: {}\n\nrest")).toEqual({
      index: 14,
      length: 2,
    });
    expect(findSseMessageSeparator("id: 1\r\ndata: {}\r\n\r\nrest")).toEqual({
      index: 15,
      length: 4,
    });
  });

  it("returns null when no complete message is buffered", () => {
    expect(findSseMessageSeparator("id: 1\ndata: {}\n")).toBeNull();
  });
});

describe("enqueueDedupedSseMessage", () => {
  it("enqueues id-less messages but suppresses duplicate event ids", async () => {
    const encoder = new TextEncoder();
    const deliveredIds = new Set<EventStreamPayload["id"]>();
    const chunks: string[] = [];
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });

    enqueueDedupedSseMessage(
      streamController,
      encoder,
      deliveredIds,
      sseMessage(payload("evt_dup")),
    );
    enqueueDedupedSseMessage(
      streamController,
      encoder,
      deliveredIds,
      sseMessage(payload("evt_dup")),
    );
    enqueueDedupedSseMessage(
      streamController,
      encoder,
      deliveredIds,
      ": keepalive\n\n",
    );
    streamController.close();

    const reader = stream.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    expect(chunks).toEqual([sseMessage(payload("evt_dup")), ": keepalive\n\n"]);
    expect(deliveredIds).toEqual(new Set(["evt_dup"]));
  });
});
