import { describe, expect, it } from "vitest";

import { runCli } from "../../cli.js";
import { makeIo } from "../../testing/helpers.js";

describe("endpoint commands", () => {
  it("creates temporary endpoints through the API and prints webhook details", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);

      return Response.json(
        {
          endpoint: {
            id: "ep_01JDEF",
            name: "stripe-test",
            mode: "temporary",
            status: "active",
            public_read: true,
            event_count: 0,
            event_limit: 100,
            expires_at: "2026-07-06T12:00:00.000Z",
            created_at: "2026-07-05T12:00:00.000Z",
            updated_at: "2026-07-05T12:00:00.000Z",
            ingest_url: "https://ingest.example.com/ep_01JDEF",
          },
        },
        {
          status: 201,
        },
      );
    };

    const exitCode = await runCli(
      ["endpoints", "create", "--temporary", "--name", "stripe-test"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
        },
        fetch,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("https://api.example.com/v1/endpoints");
    expect(await requests[0].json()).toEqual({
      mode: "temporary",
      name: "stripe-test",
    });
    expect(stdout.join("\n")).toContain("Created endpoint: ep_01JDEF");
    expect(stdout.join("\n")).toContain("https://ingest.example.com/ep_01JDEF");
    expect(stdout.join("\n")).toContain("Expires: 2026-07-06T12:00:00.000Z");
    expect(stdout.join("\n")).toContain("Events: 0 / 100");
  });

  it("creates private endpoints by default with resolved Bearer auth", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];

    const exitCode = await runCli(
      ["endpoints", "create", "--name", "github-dev"],
      io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
          BARESTASH_TOKEN: "bst_private_secret",
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);

          return Response.json(
            {
              endpoint: {
                id: "ep_private",
                name: "github-dev",
                mode: "private",
                status: "active",
                public_read: false,
                event_count: 0,
                event_limit: 1000,
                expires_at: "2026-07-12T12:00:00.000Z",
                created_at: "2026-07-05T12:00:00.000Z",
                updated_at: "2026-07-05T12:00:00.000Z",
                ingest_url: "https://ingest.example.com/ep_private",
              },
            },
            {
              status: 201,
            },
          );
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("authorization")).toBe(
      "Bearer bst_private_secret",
    );
    expect(await requests[0].json()).toEqual({
      mode: "private",
      name: "github-dev",
    });
    expect(stdout.join("\n")).toContain("Created endpoint: ep_private");
    expect(stdout.join("\n")).toContain("Mode: private");
    expect(stdout.join("\n")).toContain("Expires: 2026-07-12T12:00:00.000Z");
    expect(stdout.join("\n")).toContain("Events: 0 / 1000");
  });

  it("rejects conflicting endpoint mode flags before creating a public endpoint", async () => {
    const { io, stderr, stdout } = makeIo();
    const requests: Request[] = [];

    const exitCode = await runCli(
      ["endpoints", "create", "--private", "--temporary"],
      io,
      {
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          requests.push(new Request(input, init));
          return Response.json({});
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(requests).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "Choose either --private or --temporary, not both.",
    );
  });

  it("registers documented set-default flag and reports local config as deferred", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(
      ["endpoints", "create", "--temporary", "--set-default"],
      io,
    );

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "Setting a default endpoint is not implemented yet.",
    );
    expect(stderr.join("\n")).not.toContain("unknown option");
  });

  it("maps list authentication errors without human output", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["endpoints", "list", "--json"], io, {
      env: {
        BARESTASH_API_URL: "https://api.example.com",
      },
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "not_authenticated",
              message: "Authentication is required to list endpoints.",
            },
          },
          {
            status: 401,
          },
        ),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(
      "Authentication is required to list endpoints.",
    );
    expect(stderr.join("\n")).toContain("barestash auth login");
  });

  it("shows endpoint details and maps endpoint errors", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["endpoints", "show", "ep_01JDEF"], io, {
      env: {
        BARESTASH_API_URL: "https://api.example.com",
      },
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "endpoint_expired",
              message: "Endpoint expired: ep_01JDEF",
            },
          },
          {
            status: 410,
          },
        ),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Endpoint expired: ep_01JDEF");
    expect(stderr.join("\n")).toContain("barestash endpoints create");
  });

  it("reports API connectivity failures without treating the command as unknown", async () => {
    const { io, stderr, stdout } = makeIo();

    const exitCode = await runCli(["endpoints", "show", "ep_01JDEF"], io, {
      env: {
        BARESTASH_API_URL: "https://api.example.com",
      },
      fetch: async () => {
        throw new Error("connection refused");
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("Failed to reach Barestash API.");
    expect(stderr.join("\n")).not.toContain("Unknown command");
  });

  it("creates and lists endpoint secrets through the API without exposing raw secrets in list output", async () => {
    const createIo = makeIo();
    const createRequests: Request[] = [];

    const createExitCode = await runCli(
      ["endpoints", "secrets", "create", "--endpoint", "ep_private"],
      createIo.io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
          BARESTASH_TOKEN: "bst_owner_secret",
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          createRequests.push(request);

          return Response.json(
            {
              endpoint_secret: {
                id: "sec_created",
                endpoint_id: "ep_private",
                status: "active",
                created_at: "2026-07-05T12:00:00.000Z",
                last_used_at: null,
                revoked_at: null,
              },
              secret: "endpoint-secret",
            },
            { status: 201 },
          );
        },
      },
    );

    expect(createExitCode).toBe(0);
    expect(createIo.stderr).toEqual([]);
    expect(createRequests).toHaveLength(1);
    expect(createRequests[0].method).toBe("POST");
    expect(createRequests[0].url).toBe(
      "https://api.example.com/v1/endpoints/ep_private/secrets",
    );
    expect(createRequests[0].headers.get("authorization")).toBe(
      "Bearer bst_owner_secret",
    );
    expect(createIo.stdout.join("\n")).toContain("Created secret: sec_created");
    expect(createIo.stdout.join("\n")).toContain("endpoint-secret");

    const listIo = makeIo();
    const listExitCode = await runCli(
      ["endpoints", "secrets", "list", "--endpoint", "ep_private"],
      listIo.io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
          BARESTASH_TOKEN: "bst_owner_secret",
        },
        fetch: async () =>
          Response.json({
            endpoint_secrets: [
              {
                id: "sec_created",
                endpoint_id: "ep_private",
                status: "active",
                created_at: "2026-07-05T12:00:00.000Z",
                last_used_at: null,
                revoked_at: null,
              },
            ],
          }),
      },
    );

    expect(listExitCode).toBe(0);
    expect(listIo.stderr).toEqual([]);
    expect(listIo.stdout.join("\n")).toContain("sec_created");
    expect(listIo.stdout.join("\n")).not.toContain("endpoint-secret");
  });

  it("revokes endpoint secrets and deletes private endpoints with confirmation controls", async () => {
    const revokeIo = makeIo();
    const revokeRequests: Request[] = [];

    const revokeExitCode = await runCli(
      [
        "endpoints",
        "secrets",
        "revoke",
        "sec_old",
        "--endpoint",
        "ep_private",
        "--yes",
      ],
      revokeIo.io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
          BARESTASH_TOKEN: "bst_owner_secret",
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          revokeRequests.push(request);

          return Response.json({
            endpoint_secret: {
              id: "sec_old",
              endpoint_id: "ep_private",
              status: "revoked",
              created_at: "2026-07-05T12:00:00.000Z",
              last_used_at: null,
              revoked_at: "2026-07-05T12:00:00.000Z",
            },
          });
        },
      },
    );

    expect(revokeExitCode).toBe(0);
    expect(revokeRequests).toHaveLength(1);
    expect(revokeRequests[0].method).toBe("DELETE");
    expect(revokeRequests[0].url).toBe(
      "https://api.example.com/v1/endpoints/ep_private/secrets/sec_old",
    );
    expect(revokeIo.stdout.join("\n")).toContain("Revoked secret: sec_old");

    const deleteIo = makeIo();
    const deleteRequests: Request[] = [];
    const deleteExitCode = await runCli(
      ["endpoints", "delete", "ep_private"],
      deleteIo.io,
      {
        env: {
          BARESTASH_API_URL: "https://api.example.com",
          BARESTASH_TOKEN: "bst_owner_secret",
        },
        confirm: async (message) => {
          expect(message).toBe("Delete endpoint ep_private and all events?");
          return true;
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          deleteRequests.push(request);

          return Response.json({
            endpoint: {
              id: "ep_private",
              name: null,
              mode: "private",
              status: "active",
              public_read: false,
              event_count: 1,
              event_limit: null,
              expires_at: "2026-07-12T12:00:00.000Z",
              created_at: "2026-07-05T12:00:00.000Z",
              updated_at: "2026-07-05T12:00:00.000Z",
              ingest_url: "https://ingest.example.com/ep_private",
            },
            deleted_events: 1,
            deleted_body_objects: 2,
          });
        },
      },
    );

    expect(deleteExitCode).toBe(0);
    expect(deleteRequests).toHaveLength(1);
    expect(deleteRequests[0].method).toBe("DELETE");
    expect(deleteRequests[0].url).toBe(
      "https://api.example.com/v1/endpoints/ep_private",
    );
    expect(deleteIo.stdout.join("\n")).toContain(
      "Deleted endpoint: ep_private",
    );
  });
});
