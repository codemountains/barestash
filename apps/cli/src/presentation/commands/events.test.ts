import { REDACTED_HEADER_VALUE } from "@barestash/shared/headers";
import { describe, expect, it } from "vitest";
import { runCli } from "../../cli.js";
import {
  eventDetail,
  eventMetadata,
  makeIo,
  rawSensitiveEventDetail,
} from "../../testing/helpers.js";

describe("event commands", () => {
  it("lists events using --endpoint and prints metadata only", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];

    const exitCode = await runCli(
      ["events", "list", "--endpoint", "ep_01JDEF", "--limit", "2"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);

          return Response.json({
            events: [eventMetadata],
          });
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toBe(
      "https://api.example.com/v1/endpoints/ep_01JDEF/events?limit=2",
    );
    expect(stdout.join("\n")).toContain("evt_01JDEF");
    expect(stdout.join("\n")).toContain("POST");
    expect(stdout.join("\n")).toContain("/webhook/stripe");
    expect(stdout.join("\n")).not.toContain("stripe-signature");
  });

  it("uses BARESTASH_ENDPOINT when --endpoint is omitted", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];

    const exitCode = await runCli(["events", "list"], io, {
      env: {
        BARESTASH_API_URL: "https://api.example.com",
        BARESTASH_ENDPOINT: "ep_from_env",
      },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        requests.push(new Request(input, init));

        return Response.json({
          events: [],
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests[0].url).toBe(
      "https://api.example.com/v1/endpoints/ep_from_env/events",
    );
    expect(stdout.join("\n")).toContain("No events received yet.");
  });

  it("shows the latest event with a transformed JSON body for --json", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];

    const exitCode = await runCli(
      ["events", "latest", "--endpoint", "ep_01JDEF", "--json"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        maxStreamReconnects: 0,
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);

          if (request.url.endsWith("/v1/endpoints/ep_01JDEF/events?limit=1")) {
            return Response.json({
              events: [eventMetadata],
            });
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF")) {
            return Response.json(eventDetail);
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF/body")) {
            return new Response(JSON.stringify({ ok: true }), {
              headers: {
                "content-type": "application/json",
              },
            });
          }

          throw new Error(`unexpected request: ${request.url}`);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.example.com/v1/endpoints/ep_01JDEF/events?limit=1",
      "https://api.example.com/v1/events/evt_01JDEF",
      "https://api.example.com/v1/events/evt_01JDEF/body",
    ]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      event: eventDetail,
      body: {
        ok: true,
      },
    });
  });

  it("returns JSON for empty latest results when --json is requested", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(
      ["events", "latest", "--endpoint", "ep_01JDEF", "--json"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);

          if (request.url.endsWith("/v1/endpoints/ep_01JDEF/events?limit=1")) {
            return Response.json({
              events: [],
            });
          }

          throw new Error(`unexpected request: ${request.url}`);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      event: null,
      body: null,
    });
  });

  it("preserves JSON null event bodies for --json", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(
      ["events", "latest", "--endpoint", "ep_01JDEF", "--json"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);

          if (request.url.endsWith("/v1/endpoints/ep_01JDEF/events?limit=1")) {
            return Response.json({
              events: [eventMetadata],
            });
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF")) {
            return Response.json(eventDetail);
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF/body")) {
            return new Response("null", {
              headers: {
                "content-type": "application/json",
              },
            });
          }

          throw new Error(`unexpected request: ${request.url}`);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      event: eventDetail,
      body: null,
    });
  });

  it("reports event body API errors from the first failed response without retrying", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];

    const exitCode = await runCli(["events", "show", "evt_01JDEF"], io, {
      env: {
        BARESTASH_API_URL: "https://api.example.com",
      },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);

        if (request.url.endsWith("/v1/events/evt_01JDEF")) {
          return Response.json(eventDetail);
        }

        if (request.url.endsWith("/v1/events/evt_01JDEF/body")) {
          return Response.json(
            {
              error: {
                code: "body_not_found",
                message: "Event body not found: evt_01JDEF",
              },
            },
            {
              status: 404,
            },
          );
        }

        throw new Error(`unexpected request: ${request.url}`);
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(
      requests.filter((request) =>
        request.url.endsWith("/v1/events/evt_01JDEF/body"),
      ),
    ).toHaveLength(1);
    expect(stderr.join("\n")).toContain("Event body not found: evt_01JDEF");
  });

  it("redacts raw sensitive headers client-side for events show human output", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["events", "show", "evt_01JDEF"], io, {
      env: {
        BARESTASH_API_URL: "https://api.example.com",
      },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);

        if (request.url.endsWith("/v1/events/evt_01JDEF")) {
          return Response.json(rawSensitiveEventDetail);
        }

        if (request.url.endsWith("/v1/events/evt_01JDEF/body")) {
          return new Response(JSON.stringify({ ok: true }), {
            headers: {
              "content-type": "application/json",
            },
          });
        }

        throw new Error(`unexpected request: ${request.url}`);
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("authorization: [REDACTED]");
    expect(stdout.join("\n")).toContain("stripe-signature: [REDACTED]");
    expect(stdout.join("\n")).not.toContain("Bearer raw-token");
    expect(stdout.join("\n")).not.toContain("x-barestash-secret");
  });

  it("redacts raw sensitive headers client-side for events show --json output", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(
      ["events", "show", "evt_01JDEF", "--json"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);

          if (request.url.endsWith("/v1/events/evt_01JDEF")) {
            return Response.json(rawSensitiveEventDetail);
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF/body")) {
            return new Response(JSON.stringify({ ok: true }), {
              headers: {
                "content-type": "application/json",
              },
            });
          }

          throw new Error(`unexpected request: ${request.url}`);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      event: {
        ...rawSensitiveEventDetail,
        request: {
          ...rawSensitiveEventDetail.request,
          headers: {
            "content-type": "application/json",
            authorization: REDACTED_HEADER_VALUE,
            "stripe-signature": REDACTED_HEADER_VALUE,
          },
        },
      },
      body: {
        ok: true,
      },
    });
  });

  it("redacts raw sensitive headers client-side for events latest human output", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(
      ["events", "latest", "--endpoint", "ep_01JDEF"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);

          if (request.url.endsWith("/v1/endpoints/ep_01JDEF/events?limit=1")) {
            return Response.json({
              events: [eventMetadata],
            });
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF")) {
            return Response.json(rawSensitiveEventDetail);
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF/body")) {
            return new Response(JSON.stringify({ ok: true }), {
              headers: {
                "content-type": "application/json",
              },
            });
          }

          throw new Error(`unexpected request: ${request.url}`);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("authorization: [REDACTED]");
    expect(stdout.join("\n")).toContain("stripe-signature: [REDACTED]");
    expect(stdout.join("\n")).not.toContain("Bearer raw-token");
    expect(stdout.join("\n")).not.toContain("x-barestash-secret");
  });

  it("redacts raw sensitive headers client-side for events latest --json output", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(
      ["events", "latest", "--endpoint", "ep_01JDEF", "--json"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);

          if (request.url.endsWith("/v1/endpoints/ep_01JDEF/events?limit=1")) {
            return Response.json({
              events: [eventMetadata],
            });
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF")) {
            return Response.json(rawSensitiveEventDetail);
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF/body")) {
            return new Response(JSON.stringify({ ok: true }), {
              headers: {
                "content-type": "application/json",
              },
            });
          }

          throw new Error(`unexpected request: ${request.url}`);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      event: {
        ...rawSensitiveEventDetail,
        request: {
          ...rawSensitiveEventDetail.request,
          headers: {
            "content-type": "application/json",
            authorization: REDACTED_HEADER_VALUE,
            "stripe-signature": REDACTED_HEADER_VALUE,
          },
        },
      },
      body: {
        ok: true,
      },
    });
  });

  it("redacts raw sensitive headers client-side for events tail --headers", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(
      [
        "events",
        "tail",
        "--endpoint",
        "ep_01JDEF",
        "--last",
        "1",
        "--headers",
        "--poll-interval",
        "10ms",
      ],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        maxTailPolls: 0,
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);

          if (request.url.endsWith("/v1/endpoints/ep_01JDEF/events?limit=1")) {
            return Response.json({
              events: [eventMetadata],
            });
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF")) {
            return Response.json(rawSensitiveEventDetail);
          }

          throw new Error(`unexpected request: ${request.url}`);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("authorization: [REDACTED]");
    expect(stdout.join("\n")).toContain("stripe-signature: [REDACTED]");
    expect(stdout.join("\n")).not.toContain("Bearer raw-token");
    expect(stdout.join("\n")).not.toContain("x-barestash-secret");
  });

  it("shows event details with redacted headers and safe binary body output", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["events", "show", "evt_01JDEF"], io, {
      env: {
        BARESTASH_API_URL: "https://api.example.com",
      },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);

        if (request.url.endsWith("/v1/events/evt_01JDEF")) {
          return Response.json({
            ...eventDetail,
            request: {
              ...eventDetail.request,
              headers: {
                "content-type": "application/octet-stream",
                authorization: REDACTED_HEADER_VALUE,
              },
              body: {
                ...eventDetail.request.body,
                size: 4,
              },
            },
          });
        }

        if (request.url.endsWith("/v1/events/evt_01JDEF/body")) {
          return new Response(new Uint8Array([0, 1, 2, 255]), {
            headers: {
              "content-type": "application/octet-stream",
            },
          });
        }

        throw new Error(`unexpected request: ${request.url}`);
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Event: evt_01JDEF");
    expect(stdout.join("\n")).toContain("authorization: [REDACTED]");
    expect(stdout.join("\n")).toContain("Body:");
    expect(stdout.join("\n")).toContain("application/octet-stream (4 B)");
    expect(stdout.join("\n")).not.toContain("\u0000");
  });

  it("preserves JSON object bodies that look like body metadata in human output", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["events", "show", "evt_01JDEF"], io, {
      env: {
        BARESTASH_API_URL: "https://api.example.com",
      },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);

        if (request.url.endsWith("/v1/events/evt_01JDEF")) {
          return Response.json(eventDetail);
        }

        if (request.url.endsWith("/v1/events/evt_01JDEF/body")) {
          return new Response(
            JSON.stringify({ content_type: "application/json", size: 123 }),
            {
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        throw new Error(`unexpected request: ${request.url}`);
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain('"content_type": "application/json"');
    expect(stdout.join("\n")).toContain('"size": 123');
    expect(stdout.join("\n")).not.toContain("application/json (123 B)");
  });

  it("prints synthetic binary body metadata without internal markers for --json", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(
      ["events", "show", "evt_01JDEF", "--json"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);

          if (request.url.endsWith("/v1/events/evt_01JDEF")) {
            return Response.json({
              ...eventDetail,
              request: {
                ...eventDetail.request,
                headers: {
                  "content-type": "application/octet-stream",
                },
                body: {
                  ...eventDetail.request.body,
                  size: 4,
                },
              },
            });
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF/body")) {
            return new Response(new Uint8Array([0, 1, 2, 255]), {
              headers: {
                "content-type": "application/octet-stream",
              },
            });
          }

          throw new Error(`unexpected request: ${request.url}`);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      event: {
        ...eventDetail,
        request: {
          ...eventDetail.request,
          headers: {
            "content-type": "application/octet-stream",
          },
          body: {
            ...eventDetail.request.body,
            size: 4,
          },
        },
      },
      body: {
        content_type: "application/octet-stream",
        size: 4,
      },
    });
  });

  it("preserves malformed JSON bodies as text in human output", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["events", "show", "evt_01JDEF"], io, {
      env: {
        BARESTASH_API_URL: "https://api.example.com",
      },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);

        if (request.url.endsWith("/v1/events/evt_01JDEF")) {
          return Response.json(eventDetail);
        }

        if (request.url.endsWith("/v1/events/evt_01JDEF/body")) {
          return new Response('{"event": "created",', {
            headers: {
              "content-type": "application/json",
            },
          });
        }

        throw new Error(`unexpected request: ${request.url}`);
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain('{"event": "created",');
    expect(stdout.join("\n")).not.toContain("application/json (20 B)");
  });

  it("preserves malformed JSON bodies as strings for --json", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(
      ["events", "show", "evt_01JDEF", "--json"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);

          if (request.url.endsWith("/v1/events/evt_01JDEF")) {
            return Response.json(eventDetail);
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF/body")) {
            return new Response('{"event": "created",', {
              headers: {
                "content-type": "application/json",
              },
            });
          }

          throw new Error(`unexpected request: ${request.url}`);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      event: eventDetail,
      body: '{"event": "created",',
    });
  });

  it("tails events with --last, headers, body, and polling cursor", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];

    const exitCode = await runCli(
      [
        "events",
        "tail",
        "--endpoint",
        "ep_01JDEF",
        "--last",
        "1",
        "--headers",
        "--body",
        "--poll-interval",
        "10ms",
      ],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        maxTailPolls: 1,
        sleep: async () => {},
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);

          if (request.url.endsWith("/v1/endpoints/ep_01JDEF/events?limit=1")) {
            return Response.json({
              events: [eventMetadata],
            });
          }

          if (
            request.url.endsWith(
              "/v1/endpoints/ep_01JDEF/events?after=evt_01JDEF",
            )
          ) {
            return Response.json({
              events: [
                {
                  ...eventMetadata,
                  id: "evt_01JXYZ",
                  request_path: "/webhook/github",
                  body: {
                    size: 5,
                    sha256: "hash2",
                    available: true,
                  },
                },
              ],
            });
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF")) {
            return Response.json(eventDetail);
          }

          if (request.url.endsWith("/v1/events/evt_01JXYZ")) {
            return Response.json({
              ...eventDetail,
              id: "evt_01JXYZ",
              request: {
                ...eventDetail.request,
                request_path: "/webhook/github",
                body: {
                  size: 5,
                  sha256: "hash2",
                  available: true,
                  url: "/v1/events/evt_01JXYZ/body",
                },
              },
            });
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF/body")) {
            return new Response(JSON.stringify({ ok: true }), {
              headers: {
                "content-type": "application/json",
              },
            });
          }

          if (request.url.endsWith("/v1/events/evt_01JXYZ/body")) {
            return new Response("hello", {
              headers: {
                "content-type": "text/plain",
              },
            });
          }

          throw new Error(`unexpected request: ${request.url}`);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests.map((request) => request.url)).toContain(
      "https://api.example.com/v1/endpoints/ep_01JDEF/events?after=evt_01JDEF",
    );
    expect(stdout.join("\n")).toContain("Watching endpoint: ep_01JDEF");
    expect(stdout.join("\n")).toContain(
      "RECEIVED                   METHOD PATH            SIZE CONTENT-TYPE     EVENT",
    );
    expect(
      stdout.indexOf(
        "RECEIVED                   METHOD PATH            SIZE CONTENT-TYPE     EVENT",
      ),
    ).toBeLessThan(stdout.findIndex((line) => line.includes("evt_01JDEF")));
    expect(stdout.join("\n")).toContain("evt_01JDEF");
    expect(stdout.join("\n")).toContain("evt_01JXYZ");
    expect(stdout.join("\n")).toContain("stripe-signature: [REDACTED]");
    expect(stdout.join("\n")).toContain("hello");
  });

  it("preserves JSON null event bodies when tailing with --body", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(
      ["events", "tail", "--endpoint", "ep_01JDEF", "--last", "1", "--body"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        maxTailPolls: 0,
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);

          if (request.url.endsWith("/v1/endpoints/ep_01JDEF/events?limit=1")) {
            return Response.json({
              events: [eventMetadata],
            });
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF")) {
            return Response.json(eventDetail);
          }

          if (request.url.endsWith("/v1/events/evt_01JDEF/body")) {
            return new Response("null", {
              headers: {
                "content-type": "application/json",
              },
            });
          }

          throw new Error(`unexpected request: ${request.url}`);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Body:");
    expect(stdout.join("\n")).toContain("null");
  });

  it("rejects invalid tail --last before printing the watch header", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(
      ["events", "tail", "--endpoint", "ep_01JDEF", "--last", "nope"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async () => {
          throw new Error("fetch should not be called");
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["--last must be a non-negative integer."]);
  });

  it("does not print existing events when tail starts without --last", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(
      ["events", "tail", "--endpoint", "ep_01JDEF", "--poll-interval", "10ms"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        maxTailPolls: 1,
        sleep: async () => {},
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);

          if (request.url.endsWith("/v1/endpoints/ep_01JDEF/events?limit=1")) {
            return Response.json({
              events: [eventMetadata],
            });
          }

          if (
            request.url.endsWith(
              "/v1/endpoints/ep_01JDEF/events?after=evt_01JDEF",
            )
          ) {
            return Response.json({
              events: [
                {
                  ...eventMetadata,
                  id: "evt_01JXYZ",
                  request_path: "/webhook/new",
                },
              ],
            });
          }

          throw new Error(`unexpected request: ${request.url}`);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).not.toContain("/webhook/stripe");
    expect(stdout.join("\n")).toContain(
      "RECEIVED                   METHOD PATH            SIZE CONTENT-TYPE     EVENT",
    );
    expect(
      stdout.indexOf(
        "RECEIVED                   METHOD PATH            SIZE CONTENT-TYPE     EVENT",
      ),
    ).toBeLessThan(stdout.findIndex((line) => line.includes("evt_01JXYZ")));
    expect(stdout.join("\n")).toContain("evt_01JXYZ");
    expect(stdout.join("\n")).toContain("/webhook/new");
  });

  it("rejects events commands without an endpoint selection", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["events", "list"], io, {
      env: {
        BARESTASH_API_URL: "https://api.example.com",
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("No endpoint selected.");
    expect(stderr.join("\n")).toContain("--endpoint ep_abc123");
  });

  it("maps event limit API errors to a new endpoint suggestion", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(
      ["events", "list", "--endpoint", "ep_01JDEF"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch: async () =>
          Response.json(
            {
              error: {
                code: "event_limit_exceeded",
                message: "Endpoint has reached the 1000-event limit.",
              },
            },
            { status: 429 },
          ),
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "Endpoint has reached the 1000-event limit.",
    );
    expect(stderr.join("\n")).toContain("barestash endpoints create");
  });
});
