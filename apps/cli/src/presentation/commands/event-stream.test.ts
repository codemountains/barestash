import type { EventStreamPayload } from "@barestash/shared/events";
import { describe, expect, it } from "vitest";
import { runCli } from "../../cli.js";
import { makeIo, sseResponse, streamPayload } from "../../testing/helpers.js";

describe("event stream commands", () => {
  it("streams SSE payloads as JSONL only with decoded bodies and redacted headers", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];
    const payloads = [
      streamPayload({
        id: "evt_json",
        request: {
          method: "POST",
          path: "/json",
          query: {},
          headers: {
            "content-type": "application/json",
            "stripe-signature": "t=raw,v1=raw",
          },
          body_size: 11,
          body_sha256: "json-hash",
        },
        body: {
          encoding: "base64",
          data: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
        },
      }),
      streamPayload({
        id: "evt_text",
        request: {
          method: "POST",
          path: "/text",
          query: {},
          headers: {
            "content-type": "text/plain",
          },
          body_size: 5,
          body_sha256: "text-hash",
        },
        body: {
          encoding: "base64",
          data: Buffer.from("hello").toString("base64"),
        },
      }),
      streamPayload({
        id: "evt_binary",
        request: {
          method: "POST",
          path: "/binary",
          query: {},
          headers: {
            "content-type": "application/octet-stream",
          },
          body_size: 4,
          body_sha256: "binary-hash",
        },
        body: {
          encoding: "base64",
          data: Buffer.from([0, 1, 2, 255]).toString("base64"),
        },
      }),
      streamPayload({
        id: "evt_multipart",
        request: {
          method: "POST",
          path: "/multipart",
          query: {},
          headers: {
            "content-type": "multipart/form-data; boundary=abc",
          },
          body_size: 7,
          body_sha256: "multipart-hash",
        },
        body: {
          encoding: "base64",
          data: Buffer.from("--abc--").toString("base64"),
        },
      }),
      streamPayload({
        id: "evt_empty",
        request: {
          method: "POST",
          path: "/empty",
          query: {},
          headers: {
            "content-type": "text/plain",
          },
          body_size: 0,
          body_sha256: "empty-hash",
        },
        body: {
          encoding: "base64",
          data: "",
        },
      }),
      streamPayload({
        id: "evt_invalid_text",
        request: {
          method: "POST",
          path: "/invalid-text",
          query: {},
          headers: {
            "content-type": "text/plain",
          },
          body_size: 2,
          body_sha256: "invalid-text-hash",
        },
        body: {
          encoding: "base64",
          data: Buffer.from([0xff, 0xfe]).toString("base64"),
        },
      }),
    ] satisfies EventStreamPayload[];

    const exitCode = await runCli(
      ["events", "stream", "--endpoint", "ep_01JDEF"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        maxStreamReconnects: 0,
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);

          return sseResponse(payloads);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toBe(
      "https://api.example.com/v1/endpoints/ep_01JDEF/events/stream",
    );
    expect(requests[0].headers.get("accept")).toBe("text/event-stream");
    expect(stdout).toHaveLength(payloads.length);
    expect(stdout.join("\n")).not.toContain("Watching endpoint");

    const lines = stdout.map((line) => JSON.parse(line));

    expect(lines).toEqual([
      {
        ...payloads[0],
        request: {
          ...payloads[0].request,
          headers: {
            "content-type": "application/json",
            "stripe-signature": "[REDACTED]",
          },
        },
        body: {
          ok: true,
        },
      },
      {
        ...payloads[1],
        body: "hello",
      },
      {
        ...payloads[2],
        body: {
          content_type: "application/octet-stream",
          size: 4,
        },
      },
      {
        ...payloads[3],
        body: {
          content_type: "multipart/form-data; boundary=abc",
          size: 7,
        },
      },
      {
        ...payloads[4],
        body: {
          content_type: "text/plain",
          size: 0,
        },
      },
      {
        ...payloads[5],
        body: "//4=",
      },
    ]);
  });

  it("reconnects event streams with Last-Event-ID after a stream read failure", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];
    const sleeps: number[] = [];
    const firstPayload = streamPayload({
      id: "evt_reconnect_01",
      body: {
        encoding: "base64",
        data: Buffer.from(JSON.stringify({ first: true })).toString("base64"),
      },
    });
    const secondPayload = streamPayload({
      id: "evt_reconnect_02",
      body: {
        encoding: "base64",
        data: Buffer.from(JSON.stringify({ second: true })).toString("base64"),
      },
    });

    const exitCode = await runCli(
      ["events", "stream", "--endpoint", "ep_01JDEF"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        maxStreamReconnects: 1,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);

          if (requests.length === 1) {
            const encoder = new TextEncoder();

            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    encoder.encode(
                      `id: ${firstPayload.id}\ndata: ${JSON.stringify(firstPayload)}\n\n`,
                    ),
                  );
                },
                pull(controller) {
                  controller.error(new Error("connection interrupted"));
                },
              }),
              {
                headers: {
                  "content-type": "text/event-stream",
                },
              },
            );
          }

          return sseResponse([secondPayload]);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
    expect(requests[0].headers.get("last-event-id")).toBeNull();
    expect(requests[1].headers.get("last-event-id")).toBe("evt_reconnect_01");
    expect(stdout.map((line) => JSON.parse(line))).toEqual([
      {
        ...firstPayload,
        body: {
          first: true,
        },
      },
      {
        ...secondPayload,
        body: {
          second: true,
        },
      },
    ]);
  });

  it("reconnects event streams with Last-Event-ID after a clean EOF", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];
    const sleeps: number[] = [];
    const firstPayload = streamPayload({
      id: "evt_eof_01",
      body: {
        encoding: "base64",
        data: Buffer.from(JSON.stringify({ first: true })).toString("base64"),
      },
    });
    const secondPayload = streamPayload({
      id: "evt_eof_02",
      body: {
        encoding: "base64",
        data: Buffer.from(JSON.stringify({ second: true })).toString("base64"),
      },
    });

    const exitCode = await runCli(
      ["events", "stream", "--endpoint", "ep_01JDEF"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        maxStreamReconnects: 1,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);

          return requests.length === 1
            ? sseResponse([firstPayload])
            : sseResponse([secondPayload]);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
    expect(requests[1].headers.get("last-event-id")).toBe("evt_eof_01");
    expect(stdout.map((line) => JSON.parse(line))).toEqual([
      {
        ...firstPayload,
        body: {
          first: true,
        },
      },
      {
        ...secondPayload,
        body: {
          second: true,
        },
      },
    ]);
  });

  it("parses CRLF-terminated event stream frames", async () => {
    const { io, stderr, stdout } = makeIo();
    const payload = streamPayload({
      id: "evt_crlf_01",
      body: {
        encoding: "base64",
        data: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
      },
    });

    const exitCode = await runCli(
      ["events", "stream", "--endpoint", "ep_01JDEF"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        maxStreamReconnects: 0,
        fetch: async () => {
          const encoder = new TextEncoder();

          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `id: ${payload.id}\r\nevent: event\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`,
                  ),
                );
                controller.close();
              },
            }),
            {
              headers: {
                "content-type": "text/event-stream",
              },
            },
          );
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.map((line) => JSON.parse(line))).toEqual([
      {
        ...payload,
        body: {
          ok: true,
        },
      },
    ]);
  });

  it("reconnects event streams without parsing incomplete SSE tails", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];
    const sleeps: number[] = [];
    const firstPayload = streamPayload({
      id: "evt_complete_before_tail",
      body: {
        encoding: "base64",
        data: Buffer.from(JSON.stringify({ first: true })).toString("base64"),
      },
    });
    const secondPayload = streamPayload({
      id: "evt_after_partial_tail",
      body: {
        encoding: "base64",
        data: Buffer.from(JSON.stringify({ second: true })).toString("base64"),
      },
    });

    const exitCode = await runCli(
      ["events", "stream", "--endpoint", "ep_01JDEF"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        maxStreamReconnects: 1,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);

          if (requests.length === 1) {
            const encoder = new TextEncoder();

            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    encoder.encode(
                      `id: ${firstPayload.id}\ndata: ${JSON.stringify(firstPayload)}\n\n`,
                    ),
                  );
                  controller.enqueue(
                    encoder.encode(
                      `id: evt_partial_tail\ndata: ${JSON.stringify(secondPayload).slice(0, 16)}`,
                    ),
                  );
                  controller.close();
                },
              }),
              {
                headers: {
                  "content-type": "text/event-stream",
                },
              },
            );
          }

          return sseResponse([secondPayload]);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
    expect(requests[1].headers.get("last-event-id")).toBe(
      "evt_complete_before_tail",
    );
    expect(stdout.map((line) => JSON.parse(line))).toEqual([
      {
        ...firstPayload,
        body: {
          first: true,
        },
      },
      {
        ...secondPayload,
        body: {
          second: true,
        },
      },
    ]);
  });

  it("backs off before retrying event stream fetch failures", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];
    const sleeps: number[] = [];
    const payload = streamPayload({
      id: "evt_after_fetch_retry",
      body: {
        encoding: "base64",
        data: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
      },
    });

    const exitCode = await runCli(
      ["events", "stream", "--endpoint", "ep_01JDEF"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        maxStreamReconnects: 1,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);

          if (requests.length === 1) {
            throw new Error("connect reset");
          }

          return sseResponse([payload]);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
    expect(stdout.map((line) => JSON.parse(line))).toEqual([
      {
        ...payload,
        body: {
          ok: true,
        },
      },
    ]);
  });

  it("does not reconnect when stored session refresh authentication fails", async () => {
    const { io, stderr, stdout } = makeIo();
    const sleeps: number[] = [];
    let refreshCalls = 0;

    const exitCode = await runCli(
      ["events", "stream", "--endpoint", "ep_01JDEF"],
      io,
      {
        env: { BARESTASH_API_URL: "https://api.example.com" },
        now: () => new Date("2026-07-14T00:00:00.000Z"),
        maxStreamReconnects: 1,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        readCredential: async () => ({
          type: "cli_session",
          session_id: "cls_test",
          access_token: "expired-access",
          refresh_token: "expired-refresh",
          access_token_expires_at: "2026-07-14T00:04:00.000Z",
          refresh_token_expires_at: "2026-07-14T00:04:00.000Z",
          scopes: ["events:read"],
        }),
        fetch: async () => {
          refreshCalls += 1;
          return Response.json(
            {
              error: {
                code: "refresh_token_expired",
                message: "The refresh token has expired.",
              },
            },
            { status: 401 },
          );
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(refreshCalls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("The refresh token has expired.");
    expect(stderr.join("\n")).toContain("barestash auth login");
    expect(stderr.join("\n")).not.toContain("Failed to reach Barestash API.");
  });

  it("reports stream API errors from the first failed response without retrying", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];

    const exitCode = await runCli(
      ["events", "stream", "--endpoint", "ep_01JDEF"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        maxStreamReconnects: 0,
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);

          return Response.json(
            {
              error: {
                code: "endpoint_not_found",
                message: "Endpoint not found: ep_01JDEF",
              },
            },
            {
              status: 404,
            },
          );
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(stderr.join("\n")).toContain("Endpoint not found: ep_01JDEF");
  });
});
